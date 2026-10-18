// test/cli/doctor.test.mjs — `asight doctor` (RFC 1.6 §2, R4, R11; 4.1 §凭据处置): the four questions and ④b, the old `verify` folded in, and what it says besides (the collector, the VPN software,
// the standalone undo copy, backups no manifest names). The two verdicts this file exists for: 零条记录 = 「无法判定」(exit 3, never 0 — a check that reads nothing and passes is no check, 0.1 §3), and
// 「采集文件可被他人读取」(exit 1). Sandbox HOMEs, injected `has` / `verify` / control socket / process table / VPN probe: nothing here reaches the machine (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runDoctor, onPath } from '../../src/cli/doctor.mjs'
import { writeBackup } from '../../src/off/backup.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { HARNESS_IDS } from '../../src/cli/harness-names.mjs'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { fakeIo, recordingExec, snapshot, changedFiles } from './fixtures/on-ctx.mjs'
import { down, reply, asDaemon, SOCK } from './fixtures/status-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'
import { captureHealth } from '../../src/health/read.mjs'
import { closure } from '../helpers/imports.mjs'
import { modelWorld } from '../helpers/model-world.mjs'

// a record the four questions are content with: an LLM call with its verbatim request and a reconstructed response
const REC = { id: 'req_1', is_llm_call: true, endpoint: 'https://api.anthropic.com/v1/messages', ts_request: '2026-01-01T00:00:00.000Z',
  req_headers: { 'anthropic-version': '2023-06-01', authorization: 'Bearer sk-ant-api03-live', 'x-claude-code-session-id': 's1' },
  req_body: JSON.stringify({ model: 'm', system: [], tools: [], messages: [{ role: 'user', content: 'hi' }] }),
  resp: { status: 200, body: JSON.stringify({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }) } }
function capture(dir, { n = 1, mode = 0o600, name = 'capture.ndjson' } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, name)
  fs.writeFileSync(f, Array.from({ length: n }, (_, i) => JSON.stringify({ ...REC, id: `${name}-${i + 1}` })).join('\n') + (n ? '\n' : ''), { mode })
  fs.chmodSync(f, mode)
  return f
}
/** A HOME where asight has not been turned on: a doctor with nothing of its own to look at. */
const plain = () => { const home = tmpDir('asight-doc-'); return { home, sh: { env: { HOME: home } }, sys: { exec: recordingExec() } } }
const DEPS = { spawn: absentSpawn, has: () => true, request: down(), procs: async () => [], lingerRead: () => ({ state: true }), socketPath: SOCK, user: 'alice' }
async function doctor(s, argv = [], { deps = {}, io = fakeIo(), platform = 'linux', source = '' } = {}) {
  // `doctor` has no --source any more (1.6 §2): the capture it reads is the default location, and a test points it elsewhere with the internal seam ASIGHT_SOURCE (§1.8)
  const exit = await runDoctor(argv, { io, home: s.home, platform, env: { ...s.sh.env, XDG_RUNTIME_DIR: path.join(s.home, 'run'), ASIGHT_SOURCE: source }, deps: { ...DEPS, exec: s.sys.exec.run, ...deps } })
  return { exit, io, out: io.stdoutText(), err: io.stderrText(), text: io.text() }
}

test('no record read = cannot judge: an empty capture file, or none at all, is exit 3 with the words; one record makes the same capture exit 0', async () => {
  const s = plain()
  const src = path.join(s.home, 'src')
  capture(src, { n: 0 })
  let r = await doctor(s, [], { source: src })
  assert.equal(r.exit, 3, r.text)
  assert.match(r.out, /^Could not judge the captured records: 1 capture file\(s\) are there and no record could be read from them$/m, 'and says what was not examined')
  assert.ok(!/no problems\.$/.test(r.out.trim()), `an all-clear alone is not what exit 3 prints: ${r.out}`)
  r = await doctor(s, [], { source: path.join(s.home, 'nowhere') })
  assert.equal(r.exit, 3, 'a source that does not exist is not a pass either')
  r = await doctor(plain()) // the defaults: ~/.asight does not exist
  assert.equal(r.exit, 0, `§3.7: having no captured data at all is not 「cannot judge」\n${r.text}`)
  assert.match(r.out, /^File permissions: no captured data yet$/m, 'and it is said, not passed over in silence')
  capture(src, { n: 1 })
  r = await doctor(s, [], { source: src })
  assert.equal(r.exit, 0, r.text)
  assert.match(r.out, /^asight doctor: no problems\.$/m)
  assert.doesNotMatch(r.out, /Could not judge/, 'a capture it could read leaves nothing undetermined')
  assert.equal(r.err, '', 'nothing on stderr for a clean capture')
})

test('a capture file others can read (0644, 0640) is exit 1 with the words, the file and its mode and the chmod line filled in; owner-only again is exit 0', async () => {
  const s = plain()
  const src = path.join(s.home, 'src')
  const f = capture(src, { mode: 0o644 })
  let r = await doctor(s, [], { source: src })
  assert.equal(r.exit, 1, r.text)
  assert.match(r.out, /^asight doctor: 1 problem\.$/m)
  assert.ok(r.out.includes(f) && r.out.includes('(mode 0644) can be read by someone else'), r.out)
  assert.ok(r.out.includes(`chmod 600`) && r.out.includes(f), `the command, with the path filled in:\n${r.out}`)
  assert.ok(!/credential leak|redact firewall/.test(r.text), 'the old wording (the credential is stored verbatim on purpose) is gone')
  fs.chmodSync(f, 0o640)
  r = await doctor(s, [], { source: src })
  assert.equal(r.exit, 1); assert.match(r.out, /\(mode 0640\) can be read by someone else/)
  fs.chmodSync(f, 0o600)
  r = await doctor(s, [], { source: src })
  assert.equal(r.exit, 0, r.text)
  // a problem found outranks not knowing: zero records in a file others can read is still exit 1
  const g = capture(path.join(s.home, 'src2'), { n: 0, mode: 0o644 })
  r = await doctor(s, [], { source: path.dirname(g) })
  assert.equal(r.exit, 1, r.text)
})

test('a capture file that could not be read in full is not a pass (exit 3, the file in a read error on stderr); the records that were read still count', async () => {
  const s = plain()
  const src = path.join(s.home, 'src')
  capture(src, { name: 'a.ndjson' }); const b = capture(src, { name: 'b.ndjson' })
  const { readRecords } = await import('../../src/etl/ingest.mjs')
  const r = await doctor(s, [], { source: src, deps: { readRecords: async (f, o) => { if (f === b) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); return readRecords(f, o) } } })
  assert.equal(r.exit, 3, r.text)
  assert.ok(r.out.includes(`Could not judge a captured file: ${b}: EIO`), r.out)
})

test('④b covers ~/.asight/backup/: a backup of a user\'s file that others can read is exit 1; asight made it 0600, and then it is a pass', async () => {
  const s = plain()
  const src = path.join(s.home, 'src'); capture(src)
  const b = writeBackup({ home: s.home, file: path.join(s.home, '.claude', 'settings.json'), data: '{"env":{"ANTHROPIC_AUTH_TOKEN":"tok"}}' })
  assert.equal(fs.statSync(b).mode & 0o777, 0o600)
  let r = await doctor(s, [], { source: src })
  assert.equal(r.exit, 0, r.text)
  fs.chmodSync(b, 0o644)
  r = await doctor(s, [], { source: src })
  assert.equal(r.exit, 1, r.text)
  assert.ok(r.out.includes(b) && r.out.includes('(mode 0644) can be read by someone else'), r.out)
})

// the network reads of the topology (1.6 §9.7, V50): `ss` and `ip` only read; the tests below are about what doctor starts, stops or changes, so these are set aside
const NET_READ = /^(ss -ltnpH|ip -j (route get 1\.1\.1\.1|-d link show dev \S+))$/
const ranBesides = (s, from = 0) => s.sys.exec.calls.slice(from).filter((c) => !NET_READ.test(c))

// P7 (Windows test machine 2026-10-18): there is ONE check for 「is asight's root trusted」 — the collector's root store, the one `status` and `install` use.
// doctor used to run a second, half-built one of its own and printed its exception at the reader: "win32 TrustStoreInstaller not implemented
// (D22 reserved — CurrentUser Root store; ship with the Windows onboard sub-unit)" — a class name, a decision id and a plan item, on a machine
// where install had just written the root. Over both model platforms: a store that answers is judged (exit ≠ 3), one that cannot be read is
// 「could not judge」 with its own reason and no internal label.
for (const platform of ['darwin', 'win32']) {
  test(`P7 · ${platform}: doctor judges the trust store by the one check status uses — a store that cannot be read is exit 3 with an English reason, never an internal label`, async () => {
    const w = await modelWorld()
    await w.install()
    const src = path.join(w.home, 'src'); capture(src)
    const run = (rootStore) => doctor({ home: w.home, sh: { env: w.env }, sys: { exec: recordingExec() } }, [], { platform, source: src, deps: { rootStore, netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: null }) } })
    const judged = await run(w.store)
    assert.notEqual(judged.exit, 3, judged.text)
    assert.doesNotMatch(judged.out, /trust store/i, 'a store it could read is not \u300ccould not judge\u300d')
    const blind = await run({ has: () => { throw new Error('certutil -user -store Root failed (exit 1)') } })
    assert.equal(blind.exit, 3, blind.text)
    assert.match(blind.out, /Could not judge the user trust store: the root store could not be read \(certutil -user -store Root failed \(exit 1\)\)/)
    for (const leak of [/TrustStoreInstaller/, /not implemented/, /D22/, /sub-unit/]) assert.doesNotMatch(blind.text, leak, `an internal label reached the text: ${leak}`)
  })
}

test('what doctor runs: no VPN query at all (D49), only the read of the network facts and nothing else — no `which`, no systemctl / launchctl / loginctl, nothing that starts, stops or changes a thing (the trust-store check and the process table are the other two queries; both are replaced here)', async () => {
  const s = await installedHome()
  const src = path.join(s.home, 'src'); capture(src)
  const before = s.sys.exec.calls.length
  const r = await doctor(s, [], { source: src, deps: { request: asDaemon(reply()) } })
  assert.equal(r.exit, 0, r.text)
  assert.deepEqual(ranBesides(s, before), [])
  assert.deepEqual(s.sys.exec.calls.slice(before).filter((c) => NET_READ.test(c)), ['ss -ltnpH'], 'and the one read of the network facts, which only reads')
})

test('dependencies are looked up in the files, never with `which` (§3.7 prints no dependency line any more)', async () => {
  const dir = tmpDir('asight-path-')
  fs.writeFileSync(path.join(dir, 'openssl'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'certutil'), '#!/bin/sh\n', { mode: 0o644 }) // there, but not executable
  assert.equal(onPath('openssl', { env: { PATH: `/nonexistent:${dir}` }, platform: 'linux' }), true)
  assert.equal(onPath('certutil', { env: { PATH: dir }, platform: 'linux' }), false)
  assert.equal(onPath('openssl', { env: { PATH: '' }, platform: 'linux' }), false)
  const s = plain(); const src = path.join(s.home, 'src'); capture(src)
  const r = await doctor(s, [], { source: src, deps: { has: (b) => b === 'openssl' } })
  assert.equal(r.exit, 0, 'a missing tool is no problem of the capture\'s')
  assert.deepEqual(s.sys.exec.calls.filter((c) => /which|where/.test(c)), [], 'nothing was started to find them')
})

test('doctor explains the same harnesses `status` judges (the daemon\'s answer, every agent captured or why not), and its exit is the capture\'s alone (B-7)', async () => {
  const s = await installedHome()
  const src = path.join(s.home, 'src'); capture(src)
  const agents = [{ pid: 4388, agent: 'claude-code', trusted: false, reason: 'config-after-start', hint: 'the trust entry was written after this process started; restart it once' }]
  const before = s.sys.exec.calls.length
  const r = await doctor(s, [], { source: src, deps: { request: asDaemon(reply({ agents })) } })
  assert.equal(r.exit, 0, `status would say 1 here (an agent is not captured); doctor's exit is the capture's:\n${r.text}`)
  assert.match(r.out, /claude-code is not captured: pid 4388 started before capture was on\./, 'the finding says the harness, the pid and the reason')
  assert.ok(!/VPN/.test(r.out), 'no VPN software line: doctor probes none (D49)')
  assert.doesNotMatch(r.out, /is not the current version/, 'on wrote the standalone copy and it is the version this asight writes')
  assert.deepEqual(ranBesides(s, before), [], 'doctor ran no OS tool but the reads of the network facts: it reads, and it asks the daemon over its socket (R8)')
  // names restrict the harness table, as in status
  const one = await doctor(s, ['claude', '--json'], { source: src, deps: { request: asDaemon(reply({ agents })) } })
  const doc = one.io.json()
  assert.deepEqual([...new Set((doc.findings || []).filter((x) => x.harness).map((x) => x.harness))], ['claude-code'], JSON.stringify(doc.findings))
})

test('a stale standalone copy is a problem with its reason (exit 1); where nothing was installed there is nothing to check (exit 0)', async () => {
  const s = await installedHome()
  const src = path.join(s.home, 'src'); capture(src)
  fs.appendFileSync(path.join(s.home, '.asight', 'bin', 'asight-off'), '\n// edited\n')
  let r = await doctor(s, [], { source: src })
  assert.match(r.out, /is not the current version, so it may not undo everything\./); assert.equal(r.exit, 1, r.out)
  assert.ok(r.out.includes(path.join(s.home, '.asight', 'bin', 'asight-off')), 'the copy is named')
  const n = plain(); const nsrc = path.join(n.home, 'src'); capture(nsrc)
  r = await doctor(n, [], { source: nsrc })
  assert.doesNotMatch(r.out, /asight-off/, 'nothing installed: no undo copy to check (§3.7)')
  assert.equal(r.exit, 0, r.out)
})

test('backups no manifest names are a note with their paths; the ones the manifest names are not; with no manifest all of them are', async () => {
  const s = await installedHome({ seed: (home) => { fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"model":"x"}\n') } })
  const src = path.join(s.home, 'src'); capture(src)
  const named = new Set((s.manifest().entries || []).map((e) => e.backup).filter(Boolean))
  assert.ok(named.size > 0, 'the fixture\'s on backed up a file the manifest names')
  let r = await doctor(s, [], { source: src })
  assert.ok(!/belong to no install record/.test(r.out), `every backup is named:\n${r.out}`)
  const stray = writeBackup({ home: s.home, file: path.join(s.home, '.zshrc'), data: 'export A=1\n' })
  r = await doctor(s, [], { source: src })
  assert.match(r.out, /^Note: 1 backup file\(s\) belong to no install record\.$/m)
  assert.ok(r.out.includes(stray)); for (const b of named) assert.ok(!r.out.includes(b), `${b} is named by an entry`)
  const j = await doctor(s, ['--json'], { source: src, io: fakeIo() })
  assert.deepEqual(j.io.json().findings.filter((x) => x.code === 'backup-unclaimed').map((x) => x.class), ['note'], 'a backup nobody claims is a note, never a problem of its own')
  const n = plain(); const nsrc = path.join(n.home, 'src'); capture(nsrc)
  const lone = writeBackup({ home: n.home, file: path.join(n.home, '.zshrc'), data: 'x\n' })
  r = await doctor(n, [], { source: nsrc })
  assert.ok(r.out.includes(lone), 'no manifest: all of them')
  fs.mkdirSync(path.join(n.home, '.asight', 'collector'), { recursive: true })
  fs.writeFileSync(path.join(n.home, '.asight', 'collector', 'install-manifest.json'), '{ not json')
  r = await doctor(n, [], { source: nsrc })
  assert.match(r.out, /Whether any backup belongs to no install record is unknown$/m, 'a manifest that cannot be read: unknown, not "none are orphans"')
  assert.ok(r.out.includes(path.join(n.home, '.asight', 'collector', 'install-manifest.json')), `with the file:\n${r.out}`)
})

test('doctor writes nothing in the HOME (§3.7); usage errors (unknown option, unknown harness) exit 2 and touch nothing', async () => {
  const s = await installedHome()
  const src = path.join(s.home, 'src'); capture(src)
  const before = snapshot(s.home)
  const r = await doctor(s, [], { source: src, deps: { request: asDaemon(reply()) } })
  assert.equal(r.exit, 0, r.text)
  assert.deepEqual(changedFiles(before, snapshot(s.home)), [], 'read-only: not one file')
  const mid = snapshot(s.home)
  for (const argv of [['--bogus'], ['nosuchharness']]) {
    const u = await doctor(s, argv)
    assert.equal(u.exit, 2, `${argv.join(' ')}: ${u.text}`)
    assert.match(u.err, /asight doctor: (unknown option '--bogus'|unknown harness 'nosuchharness')/)
  }
  assert.match((await doctor(s, ['--bogus'])).err, /usage: asight doctor \[<harness>\.\.\.\]/)
  assert.match((await doctor(s, ['nosuchharness'])).err, /unknown harness 'nosuchharness'\. Known:/)
  assert.deepEqual(snapshot(s.home), mid, 'usage errors touch nothing')
})

test('--json: one document that validates, the verdict and its reasons, the files that failed, the status block and the code ids; the exit code is the same as the text run\'s', async () => {
  const s = plain()
  const src = path.join(s.home, 'src')
  const f = capture(src, { mode: 0o644 })
  let io = fakeIo()
  let r = await doctor(s, ['--json'], { source: src, io })
  assert.equal(r.exit, 1)
  let v = io.json()
  assert.deepEqual(validateReceipt(v), [])
  assert.deepEqual([v.command, v.ok, 'exit' in v], ['doctor', false, false], 'the exit code is the process\'s, not a key of the document')
  assert.deepEqual(v.summary, { problem: 1, expected: 0, note: 0 })
  const perm = v.findings.filter((x) => x.code === 'file-readable-by-others')
  assert.deepEqual(perm.map((x) => [x.class, x.what.includes(f), x.what.includes('0644')]), [['problem', true, true]])
  assert.deepEqual(v.undetermined, [])
  assert.equal(v.status.command, 'status', 'the status block is the status receipt')
  assert.deepEqual(Object.keys(v.status.harnesses).filter((h) => !HARNESS_IDS.includes(h)), [], 'harness ids, never aliases')
  fs.chmodSync(f, 0o600)
  io = fakeIo(); r = await doctor(s, ['--json'], { source: src, io })
  v = io.json(); assert.equal(r.exit, 0); assert.deepEqual([v.ok, v.summary], [true, { problem: 0, expected: 0, note: 0 }])
  fs.writeFileSync(f, '')
  io = fakeIo(); r = await doctor(s, ['--json'], { source: src, io })
  v = io.json(); assert.equal(r.exit, 3); assert.equal(v.ok, false)
  assert.ok(v.undetermined.some((u) => u.what === 'the captured records'), JSON.stringify(v.undetermined))
  assert.deepEqual(validateReceipt(v), [])
})


// D57: no named items, so doctor names no `--opt-in` (the codex WebSocket and Claude Desktop launcher hints went with them; the Windows
// opt-in-needed / not-via-entry / needs-admin rows and their codes left the closed sets with them).
test('D57 / V72: doctor prints no --opt-in line on darwin, linux or win32, for every harness and none', async () => {
  const s = plain()
  for (const platform of ['darwin', 'linux', 'win32']) for (const names of [[], ['codex'], ['claude-code']]) {
    const r = await doctor(s, names, { platform })
    assert.ok(!/--opt-in/.test(r.out), `${platform} ${names.join(' ')}: ${r.out}`)
  }
})

// ── V66 wired (1.6 §9.6, D51③⑤): from the flows/ a daemon wrote to the line doctor prints — no facts injected ─────────────────────────────────────────────────────
const NIGHTLY = { harness: 'claude-code', name: 'claude-nightly' }
function unknownOnDisk(home) { // what the door wrote on the macOS and Windows test machines (the D51 cells' mac-6 / win-13): a daemon life, then one process-unknown for a renamed claude
  const dir = path.join(home, '.asight', 'collector', 'flows')
  fs.mkdirSync(dir, { recursive: true })
  const ts = new Date().toISOString()
  fs.appendFileSync(path.join(dir, `${ts.slice(0, 10)}.ndjson`), [{ event: 'daemon-start', pid: 1 }, { event: 'process-unknown', where: 'engine', harness: 'claude-code', door: 'claude-code.settings', name: 'claude-nightly', wide: false, pid: 8622, reason: 'claude-nightly (pid 8622) used the claude-code.settings door but is on no name list' }].map((r) => JSON.stringify({ ts, ...r }) + '\n').join(''))
}

test('V66 wired: a process-unknown in ~/.asight\'s flows/ reaches `doctor claude-code` — the filled-in agents.json line in the text and in --json findings, daemon or not, on every platform\'s doctor', async () => {
  const s = await installedHome()
  unknownOnDisk(s.home)
  const line = JSON.stringify(NIGHTLY)
  const daemon = asDaemon(reply({ health: captureHealth({ home: path.join(s.home, '.asight') }) })) // what the daemon serves: the same fold of the same flows/
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const [label, request] of [['no daemon', down()], ['daemon', daemon]]) {
      const what = `${platform}, ${label}`
      const text = await doctor(s, ['claude-code'], { platform, deps: { request } })
      assert.ok(text.out.includes(line), `${what}: the text gives ${line}\n${text.out}`)
      assert.match(text.out, /used claude-code's proxy but is/, what)
      const j = await doctor(s, ['claude-code', '--json'], { platform, deps: { request } })
      const doc = JSON.parse(j.out)
      const f = (doc.findings || []).filter((x) => x.code === 'process-unknown')
      assert.equal(f.length, 1, `${what}: one process-unknown finding (${doc.findings_error || ''})`)
      assert.deepEqual([f[0].harness, f[0].class, f[0].commands.some((c) => c.run.includes(line))], ['claude-code', 'note', true], `${what}: a note whose command is the line`)
    }
  }
})

test('doctor and status need no package: their import closure is node builtins and this repository\'s own files — a tree with no node_modules (a test machine\'s, a broken native DuckDB) still self-checks', () => {
  // 2026-10-14: doctor reached @duckdb/node-api through server.mjs just to list the capture files, and on the macOS and Windows test machines printed only ERR_MODULE_NOT_FOUND
  assert.deepEqual(closure(['src/cli/doctor.mjs', 'src/cli/status.mjs']).problems, [])
})
