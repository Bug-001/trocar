// test/collector/doctor-collector.test.mjs — RFC 4.6 §确认信任 and §合并包 (review B-7): `trocar doctor` MUST report every
// running-but-untrusted agent with its reason, and every CA block that was not carried into a bundle with its type and file.
// Until now doctor read the old capture only and never looked at the collector. Driven end to end: the real bin, a sandbox
// HOME, a real install (Codex with a user CA file that also holds a private key), and the daemon's own event lines.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { cliOnEmptyMachine } from '../helpers/board-world.mjs'
import { installCollector } from '../../src/collector/install.mjs'
import { appendEvent } from '../../src/collector/core/events.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import { formatInstallNotes } from '../../src/cli/status-text.mjs'
import { writeStandalone } from '../../src/off/standalone.mjs'
import { runDoctor } from '../../src/cli/doctor.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import codex from '../../src/collector/harness/codex.mjs'

const KEY = '-----BEGIN PRIVATE KEY-----\nU0VDUkVULUtFWQ==\n-----END PRIVATE KEY-----\n'
// a clean, owner-only capture: doctor's own verdicts (a vacuous scan is 无法判定, exit 3) are not what this file is about
const CLEAN = { id: 'req_1', is_llm_call: true, endpoint: 'https://api.anthropic.com/v1/messages', ts_request: '2026-01-01T00:00:00.000Z',
  req_headers: { 'anthropic-version': '2023-06-01', authorization: '<redacted>', 'x-claude-code-session-id': 's1' },
  req_body: JSON.stringify({ model: 'm', system: [], tools: [], messages: [{ role: 'user', content: 'hi' }] }),
  resp: { status: 200, body: JSON.stringify({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }) } }
const cleanSource = (home) => { const d = path.join(home, 'src'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'capture.ndjson'), JSON.stringify(CLEAN) + '\n', { mode: 0o600 }); return d }
const doctor = (home, source, args = []) => {
  let status = 0, out = ''
  const c = cliOnEmptyMachine(home, ['doctor', ...args], { XDG_RUNTIME_DIR: '', TROCAR_SOURCE: source })
  try { out = execFileSync(process.execPath, c.args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: c.env }) } catch (e) { status = e.status; out = String(e.stdout || '') + String(e.stderr || '') }
  return { status, out }
}

test('doctor reports the collector: a running-but-untrusted agent with its reason, and a CA block that was not carried into a bundle with its type and file; the exit code is the old one (B-7)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-doc-'))
  try {
    const corp = path.join(home, 'corp.pem'); fs.writeFileSync(corp, KEY + createCa({ commonName: 'corp relay CA' }).certPem)
    fs.mkdirSync(path.join(home, '.codex')); fs.writeFileSync(path.join(home, '.codex', '.env'), `SSL_CERT_FILE=${corp}\n`)
    await installCollector({ home, env: { HOME: home }, osName: 'none', harnesses: [codex], freePort: async () => 0, roots: { node: [], osText: '' } })
    const dir = path.join(home, '.trocar', 'collector')
    // a daemon that ran, found a Claude Code that does not trust the collector CA, and stopped
    appendEvent(dir, { event: 'daemon-start', pid: 9, version: 'x', reason: 'started' })
    appendEvent(dir, { event: 'agent-untrusted', pid: 4242, agent: 'claude-code', code: 'var-missing', reason: 'no trocar trust entry is in effect for this process' })
    writeStandalone({ home }) // what `trocar on` writes next to the install record: without it `doctor` has a problem of its own (standalone-stale), and this test is about the collector's own report
    const source = cleanSource(home)
    const { status, out } = doctor(home, source)
    assert.equal(status, 0, `doctor still exits 0 when the capture is clean:\n${out}`)
    assert.match(out, /Notes of the last install/)
    assert.match(out, /codex: .*corp\.pem: block 1 \(PRIVATE KEY\) is not carried over/, `the block that was not merged: its type and its file:\n${out}`)
    assert.ok(!out.includes('U0VDUkVULUtFWQ'), 'never the key itself')
    // the running-but-untrusted agent is a problem of the capture health the document carries, never silence (D38); its code and reason are what `trocar status --failures` prints
    const j = doctor(home, source, ['--json'])
    assert.equal(j.status, 0, j.out)
    assert.equal(JSON.parse(j.out).status.failures.problem, 1, `the untrusted agent is counted in the status document:\n${j.out}`)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('doctor with nothing installed says the collector is not installed, and does not fail (B-7)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-doc-'))
  try {
    const { status, out } = doctor(home, cleanSource(home))
    assert.equal(status, 0, out)
    // §3.7 / D58: nothing installed has nothing of the collector's to report — `doctor` says so plainly and claims nothing about a capture
    assert.equal(out, 'trocar doctor: no problems.\n')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('formatInstallNotes: the notes of the last install without its result line; "no notes" when there are none; nothing when nothing is installed', () => {
  const h = (install, installed = true) => ({ collector: { installed, install: { install, uninstall: [] } } })
  // the reason is the sentence; the code (cert-not-merged) stays in the record and in `--json`, never in the text (§1.1, D58)
  assert.deepEqual(formatInstallNotes(h([{ kind: 'skipped-block', code: 'cert-not-merged', reason: 'a.pem: block 1 (PRIVATE KEY) is not carried over' }, { kind: 'result', reason: 'installed' }])), ['Notes of the last install (1):', '  a.pem: block 1 (PRIVATE KEY) is not carried over'])
  assert.deepEqual(formatInstallNotes(h([{ kind: 'result', reason: 'installed' }])), [], 'no note is no line')
  assert.deepEqual(formatInstallNotes(h([], false)), [])
  assert.deepEqual(formatInstallNotes(null), [])
})
