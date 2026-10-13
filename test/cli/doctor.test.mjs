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
const DEPS = { has: () => true, verify: () => true, request: down(), procs: async () => [], lingerRead: () => ({ state: true }), socketPath: SOCK, user: 'alice' }
async function doctor(s, argv = [], { deps = {}, io = fakeIo(), platform = 'linux' } = {}) {
  const exit = await runDoctor(argv, { io, home: s.home, platform, env: { ...s.sh.env, XDG_RUNTIME_DIR: path.join(s.home, 'run'), ASIGHT_SOURCE: '' }, deps: { ...DEPS, exec: s.sys.exec.run, ...deps } })
  return { exit, io, out: io.stdoutText(), err: io.stderrText(), text: io.text() }
}

test('零条记录 = 无法判定: an empty capture file, or none at all, is exit 3 with the words and no ✓ for the permissions; one record makes the same capture exit 0', async () => {
  const s = plain()
  const src = path.join(s.home, 'src')
  capture(src, { n: 0 })
  let r = await doctor(s, ['--source', src])
  assert.equal(r.exit, 3, r.text)
  assert.match(r.err, /无法判定/)
  assert.match(r.err, /没有核到任何记录/, 'and says what was not examined')
  assert.ok(!r.out.includes('✓ 采集文件仅属主可读'), `no all-clear: ${r.out}`)
  assert.match(r.out, /\? ③ 凭据没漏[^\n]*没有检查任何记录/, '③ is a question mark, not a tick')
  r = await doctor(s, ['--source', path.join(s.home, 'nowhere')])
  assert.equal(r.exit, 3, 'a source that does not exist is not a pass either')
  r = await doctor(plain()) // the defaults: ~/.asight does not exist
  assert.equal(r.exit, 3, r.text)
  capture(src, { n: 1 })
  r = await doctor(s, ['--source', src])
  assert.equal(r.exit, 0, r.text)
  assert.match(r.out, /1 record\(s\) captured/); assert.match(r.out, /owner-only/); assert.match(r.out, /✓ 采集文件仅属主可读/)
  assert.equal(r.err, '', 'nothing on stderr for a clean capture')
})

test('采集文件可被他人读取: a capture file others can read (0644, 0640) is exit 1 with the words, the file and its mode and the chmod line filled in; owner-only again is exit 0', async () => {
  const s = plain()
  const src = path.join(s.home, 'src')
  const f = capture(src, { mode: 0o644 })
  let r = await doctor(s, ['--source', src])
  assert.equal(r.exit, 1, r.text)
  assert.match(r.err, /采集文件可被他人读取/)
  assert.match(r.out, /✗ 采集文件可被他人读取: 1 个 \[capture\.ndjson 0644\]/)
  assert.ok(r.out.includes(`chmod 600 '${f}'`), `the command, with the path filled in:\n${r.out}`)
  assert.ok(!/credential leak|redact firewall/.test(r.text), 'the old wording (the credential is stored verbatim on purpose) is gone')
  fs.chmodSync(f, 0o640)
  r = await doctor(s, ['--source', src])
  assert.equal(r.exit, 1); assert.match(r.out, /capture\.ndjson 0640/)
  fs.chmodSync(f, 0o600)
  r = await doctor(s, ['--source', src])
  assert.equal(r.exit, 0, r.text)
  // a problem found outranks not knowing: zero records in a file others can read is still exit 1
  const g = capture(path.join(s.home, 'src2'), { n: 0, mode: 0o644 })
  r = await doctor(s, ['--source', path.dirname(g)])
  assert.equal(r.exit, 1, r.text)
})

test('a capture file that could not be read in full is not a pass (exit 3, the file in a read error on stderr); the records that were read still count', async () => {
  const s = plain()
  const src = path.join(s.home, 'src')
  capture(src, { name: 'a.ndjson' }); const b = capture(src, { name: 'b.ndjson' })
  const { readRecords } = await import('../../src/etl/ingest.mjs')
  const r = await doctor(s, ['--source', src], { deps: { readRecords: async (f, o) => { if (f === b) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); return readRecords(f, o) } } })
  assert.equal(r.exit, 3, r.text)
  assert.ok(r.err.includes(`read error: ${b}: EIO`), r.err)
  assert.match(r.out, /1 record\(s\) captured/, 'what could be read is still reported')
  assert.match(r.err, /没读完整/)
})

test('④b covers ~/.asight/backup/: a backup of a user\'s file that others can read is exit 1; asight made it 0600, and then it is a pass', async () => {
  const s = plain()
  const src = path.join(s.home, 'src'); capture(src)
  const b = writeBackup({ home: s.home, file: path.join(s.home, '.claude', 'settings.json'), data: '{"env":{"ANTHROPIC_AUTH_TOKEN":"tok"}}' })
  assert.equal(fs.statSync(b).mode & 0o777, 0o600)
  let r = await doctor(s, ['--source', src])
  assert.equal(r.exit, 0, r.text)
  fs.chmodSync(b, 0o644)
  r = await doctor(s, ['--source', src])
  assert.equal(r.exit, 1, r.text)
  assert.ok(r.out.includes(`${path.basename(b)} 0644`), r.out)
})

// R11 / 0.1 §3: a directory that exists and cannot be listed is not "no files" — reading nothing and certifying is what this command once did. Real permissions: a mode-000 directory, restored afterwards
const rootCanList = typeof process.getuid === 'function' && process.getuid() === 0 ? 'root lists a directory with no mode bits' : false
test('④b: the export directory, a session directory in it, and the sessions directory — one that exists and cannot be listed is a read error (exit 3, the directory and the errno named), never a pass; listable again, the 0644 file in it is exit 1', { skip: rootCanList }, async () => {
  const s = plain()
  const src = path.join(s.home, 'src'); capture(src)
  const ah = path.join(s.home, '.asight')
  const leak = capture(path.join(ah, 'export', 'S1'), { mode: 0o644, name: 'leak.ndjson' }) // a capture others can read, where nobody can look
  fs.mkdirSync(path.join(ah, 'sessions', 'S2'), { recursive: true })
  const dirs = { 'the export directory': path.join(ah, 'export'), 'a session directory in the export directory': path.join(ah, 'export', 'S1'), 'the sessions directory': path.join(ah, 'sessions'), 'a session directory in the sessions directory': path.join(ah, 'sessions', 'S2') }
  for (const [what, dir] of Object.entries(dirs)) {
    fs.chmodSync(leak, dir.includes('export') ? 0o644 : 0o600) // hidden by the directory under test, or visible and clean (a problem that is found outranks not knowing: that is exit 1)
    fs.chmodSync(dir, 0)
    try {
      const r = await doctor(s, ['--source', src])
      assert.equal(r.exit, 3, `${what}: ${r.text}`)
      assert.ok(r.err.includes(`read error: ${dir}: EACCES`), `${what}: ${r.err}`)
      assert.ok(!r.out.includes('✓ 采集文件仅属主可读'), `${what}: no all-clear\n${r.out}`)
      assert.match(r.err, /无法判定/)
      if (what === 'the export directory') {
        const j = await doctor(s, ['--source', src, '--json'], { io: fakeIo() })
        assert.equal(j.exit, 3); assert.ok(j.io.json().read_errors.some((e) => e.startsWith(`${dir}: EACCES`)), JSON.stringify(j.io.json().read_errors))
      }
    } finally { fs.chmodSync(dir, 0o700) }
  }
  fs.chmodSync(leak, 0o644)
  const r = await doctor(s, ['--source', src])
  assert.equal(r.exit, 1, `listable: what was hidden is found\n${r.text}`); assert.match(r.out, /leak\.ndjson 0644/)
  fs.chmodSync(leak, 0o600)
  assert.equal((await doctor(s, ['--source', src])).exit, 0)
  // a directory that is not there is no files, as before
  fs.rmSync(path.join(ah, 'export'), { recursive: true }); fs.rmSync(path.join(ah, 'sessions'), { recursive: true })
  assert.equal((await doctor(s, ['--source', src])).exit, 0)
})

// the network reads of the topology (1.6 §9.7, V50): `ss` and `ip` only read; the tests below are about what doctor starts, stops or changes, so these are set aside
const NET_READ = /^(ss -ltnpH|ip -j (route get 1\.1\.1\.1|-d link show dev \S+))$/
const ranBesides = (s, from = 0) => s.sys.exec.calls.slice(from).filter((c) => !NET_READ.test(c))

test('the old `verify` is ④: the CA is in the user trust store (✓), is not (⚠ not onboarded), could not be checked (⚠ with the reason) — and none of them changes the exit', async () => {
  const s = plain()
  const src = path.join(s.home, 'src'); capture(src)
  let r = await doctor(s, ['--source', src], { deps: { verify: () => true } })
  assert.match(r.out, /✓ ④ 没弱化全机 TLS[^\n]*CA present in the USER trust store/); assert.equal(r.exit, 0)
  r = await doctor(s, ['--source', src], { deps: { verify: () => false } })
  assert.match(r.out, /⚠ ④ 没弱化全机 TLS[^\n]*not found in the user trust store[^\n]*监测 toggle[^\n]*collector's own CA \(`asight on`\) is in no trust store/); assert.doesNotMatch(r.out, /run: asight on/); assert.equal(r.exit, 0)
  r = await doctor(s, ['--source', src], { deps: { verify: () => { throw new Error('security: the keychain could not be opened') } } })
  assert.match(r.out, /⚠ ④ 没弱化全机 TLS[^\n]*trust check errored: security: the keychain could not be opened/); assert.equal(r.exit, 0)
  assert.deepEqual(ranBesides(s), [], 'with the trust-store check, and the process table injected, no OS tool ran at all')
})

test('what doctor runs: no VPN query at all (D49), only the read of the network facts and nothing else — no `which`, no systemctl / launchctl / loginctl, nothing that starts, stops or changes a thing (the trust-store check and the process table are the other two queries; both are replaced here)', async () => {
  const s = await installedHome()
  const src = path.join(s.home, 'src'); capture(src)
  const before = s.sys.exec.calls.length
  const r = await doctor(s, ['--source', src], { deps: {} })
  assert.equal(r.exit, 0, r.text)
  assert.deepEqual(ranBesides(s, before), [])
  assert.deepEqual(s.sys.exec.calls.slice(before).filter((c) => NET_READ.test(c)), ['ss -ltnpH'], 'and the one read of the network facts, which only reads')
})

test('dependencies: found on PATH, or MISSING with the one line that installs it — looked up in the files, no `which`', async () => {
  const dir = tmpDir('asight-path-')
  fs.writeFileSync(path.join(dir, 'openssl'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'certutil'), '#!/bin/sh\n', { mode: 0o644 }) // there, but not executable
  assert.equal(onPath('openssl', { env: { PATH: `/nonexistent:${dir}` }, platform: 'linux' }), true)
  assert.equal(onPath('certutil', { env: { PATH: dir }, platform: 'linux' }), false)
  assert.equal(onPath('openssl', { env: { PATH: '' }, platform: 'linux' }), false)
  const s = plain(); const src = path.join(s.home, 'src'); capture(src)
  const r = await doctor(s, ['--source', src], { deps: { has: (b) => b === 'openssl' } })
  assert.match(r.out, /✓ openssl — found/); assert.match(r.out, /⚠ certutil — MISSING · apt install libnss3-tools/)
  assert.equal(r.exit, 0, 'a missing tool is a warning: the four questions decide')
})

test('the collector section is `asight status` for the same harnesses (the daemon\'s answer, every agent captured or why not), then the topology, the standalone copy; the exit is the four questions\' alone (B-7)', async () => {
  const s = await installedHome()
  const src = path.join(s.home, 'src'); capture(src)
  const agents = [{ pid: 4388, agent: 'claude-code', trusted: false, reason: 'config-after-start', hint: 'the trust entry was written after this process started; restart it once' }]
  const before = s.sys.exec.calls.length
  const r = await doctor(s, ['--source', src], { deps: { request: asDaemon(reply({ agents })) } })
  assert.equal(r.exit, 0, `status would say 1 here (an agent is not captured); doctor's exit is the capture's:\n${r.text}`)
  assert.match(r.out, /按进程采集器[\s\S]*没采\s+claude-code\([^)]*重启后才会被采集\)/, 'the embedded status is the digest: the verdict row with its reason')
  assert.ok(!/路径\s+\S/.test(r.out) && !/本机网络环境/.test(r.out), 'no VPN software line: doctor probes none (D49)')
  assert.match(r.out, /✓ asight-off\(不依赖源码的撤销副本\):/, 'on wrote the standalone copy and it is the version this asight writes')
  assert.deepEqual(ranBesides(s, before), [], 'doctor ran no OS tool but the reads of the network facts: it reads, and it asks the daemon over its socket (R8)')
  // names restrict the harness table, as in status
  const one = await doctor(s, ['--source', src, 'claude'], { deps: { request: asDaemon(reply()) } })
  const table = one.out.split('按进程采集器')[1].split('\n').filter((l) => /^ {4}\w/.test(l)).join('\n')
  assert.match(table, /claude-code/); assert.ok(!/codex/.test(table), table)
})

test('a stale standalone copy is a ⚠ line with its reason, and an install that was never made says nothing is installed — neither is an exit code', async () => {
  const s = await installedHome()
  const src = path.join(s.home, 'src'); capture(src)
  fs.appendFileSync(path.join(s.home, '.asight', 'bin', 'asight-off'), '\n// edited\n')
  let r = await doctor(s, ['--source', src])
  assert.match(r.out, /⚠ asight-off\(不依赖源码的撤销副本\)不是当前版本/); assert.equal(r.exit, 0)
  const n = plain(); const nsrc = path.join(n.home, 'src'); capture(nsrc)
  r = await doctor(n, ['--source', nsrc])
  assert.match(r.out, /按进程采集器[\s\S]*采集健康 – 没装/, 'the digest says nothing is installed')
  assert.match(r.out, /⚠ asight-off[^\n]*is not there/)
  assert.equal(r.exit, 0)
})

test('backups no manifest names are listed (⚠, with the paths); the ones the manifest names are not; with no manifest all of them are', async () => {
  const s = await installedHome({ seed: (home) => { fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"model":"x"}\n') } })
  const src = path.join(s.home, 'src'); capture(src)
  const named = new Set((s.manifest().entries || []).map((e) => e.backup).filter(Boolean))
  assert.ok(named.size > 0, 'the fixture\'s on backed up a file the manifest names')
  let r = await doctor(s, ['--source', src])
  assert.ok(!/没有任何清单条目认领/.test(r.out), `every backup is named:\n${r.out}`)
  const stray = writeBackup({ home: s.home, file: path.join(s.home, '.zshrc'), data: 'export A=1\n' })
  r = await doctor(s, ['--source', src])
  assert.match(r.out, /⚠ 1 个备份没有任何清单条目认领/)
  assert.ok(r.out.includes(stray)); for (const b of named) assert.ok(!r.out.includes(b), `${b} is named by an entry`)
  assert.equal(r.exit, 0)
  const n = plain(); const nsrc = path.join(n.home, 'src'); capture(nsrc)
  const lone = writeBackup({ home: n.home, file: path.join(n.home, '.zshrc'), data: 'x\n' })
  r = await doctor(n, ['--source', nsrc])
  assert.ok(r.out.includes(lone), 'no manifest: all of them')
  fs.mkdirSync(path.join(n.home, '.asight', 'collector'), { recursive: true })
  fs.writeFileSync(path.join(n.home, '.asight', 'collector', 'install-manifest.json'), '{ not json')
  r = await doctor(n, ['--source', nsrc])
  assert.match(r.out, /备份: 不知道\([^)]*install-manifest\.json/, 'a manifest that cannot be read: 不知道 with the file, not "none are orphans"')
})

test('doctor changes nothing in the HOME but ~/.asight/netenv.json (the board\'s copy of the topology); usage errors (unknown option, unknown harness, --source with no value) exit 2 and touch nothing', async () => {
  const s = await installedHome()
  const src = path.join(s.home, 'src'); capture(src)
  const before = snapshot(s.home)
  const r = await doctor(s, ['--source', src], { deps: { request: asDaemon(reply()) } })
  assert.equal(r.exit, 0, r.text)
  assert.deepEqual(changedFiles(before, snapshot(s.home)), [path.join('.asight', 'netenv.json')])
  const mid = snapshot(s.home)
  for (const argv of [['--bogus'], ['nosuchharness'], ['--source']]) {
    const u = await doctor(s, argv)
    assert.equal(u.exit, 2, `${argv.join(' ')}: ${u.text}`)
    assert.match(u.err, /asight doctor: (unknown option --bogus|unknown harness nosuchharness|--source needs a file or a directory)/)
  }
  assert.match((await doctor(s, ['--bogus'])).err, /usage: asight doctor \[harness…\]/)
  assert.match((await doctor(s, ['nosuchharness'])).err, /unknown harness nosuchharness; the names are:/)
  assert.deepEqual(snapshot(s.home), mid, 'usage errors touch nothing')
})

test('--json: one document that validates, the verdict and its reasons, the files that failed, the status block and the code ids; the exit code is the same as the text run\'s', async () => {
  const s = plain()
  const src = path.join(s.home, 'src')
  const f = capture(src, { mode: 0o644 })
  let io = fakeIo()
  let r = await doctor(s, ['--source', src, '--json'], { io })
  assert.equal(r.exit, 1)
  let v = io.json()
  assert.deepEqual(validateReceipt(v), [])
  assert.deepEqual([v.command, v.ok, v.exit, v.verdict], ['doctor', false, 1, 'failed'])
  assert.deepEqual(v.readable_by_others, [{ file: f, mode: '0644' }])
  assert.equal(v.records_examined, 1)
  assert.equal(v.questions.file_permissions.ok, false)
  assert.ok(Array.isArray(v.deps) && v.deps.every((d) => typeof d.bin === 'string'))
  assert.equal(v.status.command, 'status', 'the status block is the status receipt')
  assert.deepEqual(v.status.harnesses.map((h) => h.harness).filter((h) => !HARNESS_IDS.includes(h)), [], 'harness ids, never aliases')
  assert.ok(!r.out.includes('四问'), 'no prose on stdout')
  fs.chmodSync(f, 0o600)
  io = fakeIo(); r = await doctor(s, ['--source', src, '--json'], { io })
  v = io.json(); assert.equal(r.exit, 0); assert.deepEqual([v.ok, v.verdict], [true, 'ok'])
  fs.writeFileSync(f, '')
  io = fakeIo(); r = await doctor(s, ['--source', src, '--json'], { io })
  v = io.json(); assert.equal(r.exit, 3); assert.deepEqual([v.ok, v.verdict], [false, 'undetermined'])
  assert.match(v.undetermined_why.join(' '), /没有核到任何记录/)
  assert.deepEqual(validateReceipt(v), [])
})


// the codex WebSocket cert hint (measured on a Windows test machine): on win32, doctor says — for codex, when the named cert-store opt-in is not recorded — that capturing Codex's WebSocket needs it. Never an install, and nothing to say on other platforms or once the item is in the ledger.
const CODEX_WS_HINT = 'Windows 上采 Codex 的 WebSocket 需要点名装证书: asight on codex --opt-in cert-store-current-user(会弹 Windows 自己的确认框,不弹不装)'
const manifestWith = (entries) => { const dir = (h) => path.join(h, '.asight', 'collector'); return (h) => { const d = dir(h); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'install-manifest.json'), JSON.stringify({ version: 2, entries, files: [], liveness: {}, kept_backups: [], dirs: [], confirmed_paths: [], complete: true })) } }
test('the codex WebSocket cert hint on win32: said for codex when the cert-store opt-in is not recorded, silent once it is, silent on other platforms', async () => {
  const noRecord = plain(); manifestWith([])(noRecord.home)
  let r = await doctor(noRecord, ['codex'], { platform: 'win32' })
  assert.ok(r.out.includes(CODEX_WS_HINT), `the hint is there: ${r.out}`)
  r = await doctor(noRecord, [], { platform: 'win32' }) // no harness named: every harness is the question
  assert.ok(r.out.includes(CODEX_WS_HINT), 'and when nothing is named')
  r = await doctor(noRecord, ['claude-code'], { platform: 'win32' })
  assert.ok(!r.out.includes(CODEX_WS_HINT), 'not for another harness alone')
  r = await doctor(noRecord, ['codex'], { platform: 'darwin' })
  assert.ok(!r.out.includes(CODEX_WS_HINT), 'not on another platform')
  const done = plain(); manifestWith([{ kind: 'optin-cert-user', harness: 'claude-code', form: 'claude-code.desktop', item: 'cert-store-current-user', scope: 'user', path: 'claude-code.desktop:cert-store-current-user', installed_at: '2026-10-12T00:00:00Z' }])(done.home)
  r = await doctor(done, ['codex'], { platform: 'win32' })
  assert.ok(!r.out.includes(CODEX_WS_HINT), 'the item in the ledger: the hint has done its job and goes')
})

// the Claude Desktop steering hint (4.9 §6.4): on darwin, doctor says — for claude-code, when the named desktop-launcher
// opt-in is not recorded — that capturing Desktop needs the launcher, with the needs_restart honesty riding in the line. Never an install, and nothing
// to say on other platforms or once the item is in the ledger (the codex hint's darwin twin).
const DESKTOP_HINT = 'macOS 上采 Claude Desktop 需要点名建启动器: asight on claude-code --opt-in claude-code.desktop(写 ~/.asight/collector/bin/claude-desktop-asight;只有经它启动的 Desktop 才被引流,已在跑的 Desktop 不受影响——先退出再用它启动)'
test('the Claude Desktop steering hint on darwin: said for claude-code when the desktop-launcher opt-in is not recorded, silent once it is, silent on other platforms', async () => {
  const noRecord = plain(); manifestWith([])(noRecord.home)
  let r = await doctor(noRecord, ['claude-code'], { platform: 'darwin' })
  assert.ok(r.out.includes(DESKTOP_HINT), `the hint is there: ${r.out}`)
  r = await doctor(noRecord, [], { platform: 'darwin' })
  assert.ok(r.out.includes(DESKTOP_HINT), 'and when nothing is named')
  r = await doctor(noRecord, ['codex'], { platform: 'darwin' })
  assert.ok(!r.out.includes(DESKTOP_HINT), 'not for another harness alone')
  r = await doctor(noRecord, ['claude-code'], { platform: 'win32' })
  assert.ok(!r.out.includes(DESKTOP_HINT), 'not on another platform')
  const done = plain(); manifestWith([{ kind: 'optin-desktop-launcher', harness: 'claude-code', form: 'claude-code.desktop', item: 'desktop-launcher', scope: 'user', path: '/x/bin/claude-desktop-asight', confirmed: true, installed_at: '2026-10-12T00:00:00Z' }])(done.home)
  r = await doctor(done, ['claude-code'], { platform: 'darwin' })
  assert.ok(!r.out.includes(DESKTOP_HINT), 'the item in the ledger: the hint has done its job and goes')
})
