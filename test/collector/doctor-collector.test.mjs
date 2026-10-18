// test/collector/doctor-collector.test.mjs — RFC 4.6 §确认信任 and §合并包 (review B-7): `asight doctor` MUST report every
// running-but-untrusted agent with its reason, and every CA block that was not carried into a bundle with its type and file.
// Until now doctor read the old capture only and never looked at the collector. Driven end to end: the real bin, a sandbox
// HOME, a real install (Codex with a user CA file that also holds a private key), and the daemon's own event lines.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { osStubs } from '../helpers/os-stubs.mjs'
import { fileURLToPath } from 'node:url'
import { installCollector } from '../../src/collector/install.mjs'
import { appendEvent } from '../../src/collector/core/events.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import { formatInstallNotes } from '../../src/cli/status-text.mjs'
import { writeStandalone } from '../../src/off/standalone.mjs'
import { runDoctor } from '../../src/cli/doctor.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import codex from '../../src/collector/harness/codex.mjs'

const CLI = fileURLToPath(new URL('../../bin/asight.mjs', import.meta.url))
const OS_PATH = osStubs().path // on a Mac `doctor`'s status block asks launchd and the keychain (read-only): stubs answer, the real tools are never run (0.1 §3)
const KEY = '-----BEGIN PRIVATE KEY-----\nU0VDUkVULUtFWQ==\n-----END PRIVATE KEY-----\n'
// a clean, owner-only capture: doctor's own verdicts (a vacuous scan is 无法判定, exit 3) are not what this file is about
const CLEAN = { id: 'req_1', is_llm_call: true, endpoint: 'https://api.anthropic.com/v1/messages', ts_request: '2026-01-01T00:00:00.000Z',
  req_headers: { 'anthropic-version': '2023-06-01', authorization: '<redacted>', 'x-claude-code-session-id': 's1' },
  req_body: JSON.stringify({ model: 'm', system: [], tools: [], messages: [{ role: 'user', content: 'hi' }] }),
  resp: { status: 200, body: JSON.stringify({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }) } }
const cleanSource = (home) => { const d = path.join(home, 'src'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'capture.ndjson'), JSON.stringify(CLEAN) + '\n', { mode: 0o600 }); return d }
const doctor = (home, source, args = []) => {
  let status = 0, out = ''
  try { out = execFileSync(process.execPath, [CLI, 'doctor', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home, PATH: OS_PATH, XDG_RUNTIME_DIR: '', ASIGHT_SOURCE: source } }) } catch (e) { status = e.status; out = String(e.stdout || '') + String(e.stderr || '') }
  return { status, out }
}

test('doctor reports the collector: a running-but-untrusted agent with its reason, and a CA block that was not carried into a bundle with its type and file; the exit code is the old one (B-7)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-doc-'))
  try {
    const corp = path.join(home, 'corp.pem'); fs.writeFileSync(corp, KEY + createCa({ commonName: 'corp relay CA' }).certPem)
    fs.mkdirSync(path.join(home, '.codex')); fs.writeFileSync(path.join(home, '.codex', '.env'), `SSL_CERT_FILE=${corp}\n`)
    await installCollector({ home, env: { HOME: home }, osName: 'none', harnesses: [codex], freePort: async () => 0, roots: { node: [], osText: '' } })
    const dir = path.join(home, '.asight', 'collector')
    // a daemon that ran, found a Claude Code that does not trust the collector CA, and stopped
    appendEvent(dir, { event: 'daemon-start', pid: 9, version: 'x', reason: 'started' })
    appendEvent(dir, { event: 'agent-untrusted', pid: 4242, agent: 'claude-code', code: 'var-missing', reason: 'no asight trust entry is in effect for this process' })
    writeStandalone({ home }) // what `asight on` writes next to the install record: without it `doctor` has a problem of its own (standalone-stale), and this test is about the collector's own report
    const source = cleanSource(home)
    const { status, out } = doctor(home, source)
    assert.equal(status, 0, `doctor still exits 0 when the capture is clean:\n${out}`)
    assert.match(out, /Notes of the last install/)
    assert.match(out, /codex: .*corp\.pem: block 1 \(PRIVATE KEY\) is not carried over/, `the block that was not merged: its type and its file:\n${out}`)
    assert.ok(!out.includes('U0VDUkVULUtFWQ'), 'never the key itself')
    // the running-but-untrusted agent is a problem of the capture health the document carries, never silence (D38); its code and reason are what `asight status --failures` prints
    const j = doctor(home, source, ['--json'])
    assert.equal(j.status, 0, j.out)
    assert.equal(JSON.parse(j.out).status.failures.problem, 1, `the untrusted agent is counted in the status document:\n${j.out}`)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('doctor with nothing installed says the collector is not installed, and does not fail (B-7)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-doc-'))
  try {
    const { status, out } = doctor(home, cleanSource(home))
    assert.equal(status, 0, out)
    // §3.7 / D58: nothing installed has nothing of the collector's to report — `doctor` says so plainly and claims nothing about a capture
    assert.equal(out, 'asight doctor: no problems.\n')
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

// D38 (§3.7 「只读」, 附录 C.4 `undetermined`): the trust-store check is a system query that can throw (a locked keychain, a tool that is not there).
// `doctor` must say so — an `undetermined` item with the reason, in the document and in the text — and never pass over it in silence.
test('D38 a trust check that throws is an undetermined item with its reason, in the document and in the text', async () => {
  const home = tmpDir('asight-doc-')
  const env = { ...process.env, HOME: home, PATH: OS_PATH, XDG_RUNTIME_DIR: '', ASIGHT_SOURCE: cleanSource(home) }
  const run = async (argv, deps) => { const lines = []; const exit = await runDoctor(argv, { io: { out: (s) => lines.push(s), err: (s) => lines.push(s) }, home, env, deps }); return { exit, text: lines.join('\n') } }
  const threw = { verify: () => { throw new Error('the keychain is locked') } }
  const j = await run(['--json'], threw)
  assert.deepEqual(JSON.parse(j.text).undetermined.filter((u) => u.what === 'the user trust store'), [{ what: 'the user trust store', reason: 'the keychain is locked' }])
  assert.equal(j.exit, 3, 'it could not judge, so it is not a pass')
  const t = await run([], threw)
  assert.equal(t.exit, 3)
  assert.match(t.text, /^Could not judge the user trust store: the keychain is locked$/m)
  // and a check that answers says nothing of the kind
  assert.deepEqual(JSON.parse((await run(['--json'], { verify: () => true })).text).undetermined.filter((u) => u.what === 'the user trust store'), [])
})
