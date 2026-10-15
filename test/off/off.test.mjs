// test/off/off.test.mjs — what `asight off` does to the user's machine. V15 · V25: a real install of all seven harnesses, undone through undoHarnesses with
// the process table handed in. V1 · V5 · V8 · V21 · V24 · V27 · V34 (T07): the orchestration — runOff over a sandbox HOME in which the real `on` has run, with
// the daemon, systemd, the process table and the clock injected. Nothing in this file runs a real OS tool or touches a real process.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { installCollector } from '../../src/collector/install.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import { readManifest, saveManifest, PHASES } from '../../src/off/manifest.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { undoSide, offWorld, runOff } from '../../src/off/orchestrate.mjs'
import { formatOffReceipt } from '../../src/off/receipt.mjs'
import { certBlocks, SYSTEM_BUNDLES } from '../../src/off/pem.mjs'
import { HARNESS_IDS } from '../../src/cli/harness-names.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { sevenHomes, USER_CA } from './fixtures/seven-homes.mjs'
import { readStateFile } from '../../src/off/state.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { installedHome, writeDaemonLock, flowEvents, ALL_HARNESSES, ROOTS, procTable, fakeClock, DAEMON_ROWS, hangsOnStatus } from './fixtures/off-ctx.mjs'

const ROOT = createCa({ commonName: 'off root' })
const roots = { node: [ROOT.certPem], osText: '' }
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [])
// every file under `home` (skipping `skip`, relative) → sha256; directories count by their files, so a directory asight made and left is a difference too
const snapshot = (home, skip = []) => Object.fromEntries(walk(home).map((f) => [path.relative(home, f), crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]).filter(([rel]) => !skip.some((s) => rel === s || rel.startsWith(s + path.sep))))
const dirsOf = (home, skip = []) => walk(home).map((f) => path.relative(home, path.dirname(f))).filter((d) => !skip.some((s) => d === s || d.startsWith(s + path.sep)))
const proc = (pid, exe, argv, { startedAt = Date.now() + 5000, env = {} } = {}) => ({ pid, exe, argv, startedAt, env: () => new Map(Object.entries(env)) })

async function sevenInstalled() {
  const home = tmpDir('asight-off-')
  const sh = sevenHomes(home)
  const before = snapshot(home)
  const beforeDirs = new Set(dirsOf(home))
  await installCollector({ home, env: sh.env, osName: 'linux', harnesses: await loadHarnesses(), freePort: async () => 47011, scan: async () => [], roots })
  const dir = path.join(home, '.asight', 'collector')
  const ca = (n) => path.join(dir, 'ca', n)
  // install wrote every item here (phase install), which off spares (D55①): V15 / V25 drive the undo rules over both phases, as uninstall runs them
  const run = (o = {}) => undoHarnesses({ dir, home, manifest: readManifest(dir), ids: null, procs: async () => [], roots, phases: PHASES, ...o })
  return { home, sh, before, beforeDirs, dir, ca, run }
}

test('V15: seven harnesses have an entry after install, and the undo (uninstall\'s, both phases) takes each by 4.6: the user files byte for byte; a bundle a live process loaded is kept without the CA, a missing one a rereading process uses is rebuilt, an unused one is removed; extra files; plugins, shims and rc lines are gone', async () => {
  const s = await sevenInstalled()
  const m = readManifest(s.dir)
  assert.deepEqual([...new Set([...m.entries, ...m.files].map((e) => e.harness).filter(Boolean))].sort(), [...HARNESS_IDS].sort(), 'every harness has an entry — OpenCode\'s is its plugin file, a file asight owns')
  assert.deepEqual(Object.keys(m.liveness).sort(), [...HARNESS_IDS].sort(), 'and a liveness record')
  assert.deepEqual(m.files.filter((f) => f.role === 'bundle').map((f) => path.basename(f.path)).sort(), ['combined-codex.pem', 'combined-hermes.pem', 'combined-z-code.pem'])
  assert.deepEqual(m.files.filter((f) => f.role === 'trust-file').map((f) => path.basename(f.path)).sort(), ['extra-cc.pem', 'extra-kimi.pem'])
  const plugin = path.join(s.home, '.config', 'opencode', 'plugins', 'asight-ca.js')
  assert.ok(fs.existsSync(plugin) && fs.existsSync(path.join(s.dir, 'bin', 'kimi')) && fs.existsSync(path.join(s.dir, 'plugins', 'dsh', 'index.js')), 'plugins and the shim are in')
  assert.match(fs.readFileSync(path.join(s.home, '.bashrc'), 'utf8'), /asight collector/, 'the rc line is in')
  // a codex that started after install may have loaded combined-codex.pem; z-code's bundle was deleted by hand while a Z-Code that re-reads is running;
  // nothing holds combined-hermes.pem; a child of Claude Code inherited extra-cc.pem
  fs.rmSync(s.ca('combined-z-code.pem'))
  const live = [
    proc(4242, '/home/u/.local/bin/codex', ['codex']),
    proc(4343, '/opt/ZCode/zcode', ['/opt/ZCode/zcode', '/opt/ZCode/resources/glm/zcode.cjs', 'app-server', '--stdio'], { startedAt: 0, env: { ELECTRON_RUN_AS_NODE: '1' } }),
    proc(4444, '/usr/bin/node', ['node', '/x/tool.js'], { env: { NODE_EXTRA_CA_CERTS: s.ca('extra-cc.pem') } }),
    proc(4545, '/home/u/.kimi-code/bin/kimi', ['kimi-code'], { env: { NODE_EXTRA_CA_CERTS: s.ca('extra-kimi.pem') } }), // started through asight's shim
    proc(4546, '/home/u/.kimi-code/bin/kimi', ['kimi-code']), // by its absolute path: it never read asight's file
  ]
  const r = await s.run({ procs: async () => live })
  assert.deepEqual(r.left, [])
  assert.deepEqual(snapshot(s.home, ['.asight']), s.before, 'every user file byte for byte as before — the files asight created are gone')
  assert.deepEqual(new Set(dirsOf(s.home, ['.asight'])), s.beforeDirs, 'and so are the directories it made (.config/opencode/plugins, …)')
  const kept = Object.fromEntries(r.kept_bundles.map((k) => [path.basename(k.path), k]))
  assert.deepEqual(Object.keys(kept).sort(), ['combined-codex.pem', 'combined-z-code.pem', 'extra-cc.pem', 'extra-kimi.pem'], 'every file a live process holds; combined-hermes.pem is the one nobody does')
  const asightFp = certBlocks(fs.readFileSync(s.ca('asight-ca.pem'), 'utf8'))[0].fp
  const fps = (n) => certBlocks(fs.readFileSync(s.ca(n), 'utf8')).map((c) => c.fp)
  assert.deepEqual([kept['combined-codex.pem'].pids, fps('combined-codex.pem').includes(asightFp), fps('combined-codex.pem').length > 0], [[4242], false, true], 'kept for the codex that may have loaded it, the same file without the asight CA')
  assert.deepEqual([kept['combined-z-code.pem'].pids, kept['combined-z-code.pem'].rebuilt, fps('combined-z-code.pem').includes(asightFp), fps('combined-z-code.pem').includes(certBlocks(USER_CA.certPem)[0].fp)], [[4343], true, false, true], 'gone while a rereading Z-Code runs: rebuilt without the CA, with the user CA from the recorded source')
  assert.deepEqual([kept['extra-cc.pem'].pids, fps('extra-cc.pem').includes(asightFp), fps('extra-cc.pem').includes(certBlocks(USER_CA.certPem)[0].fp)], [[4444], false, true], 'a child inherited extra-cc.pem: kept without the asight CA, the user CA stays')
  assert.ok(!fs.existsSync(s.ca('combined-hermes.pem')), 'nobody holds combined-hermes.pem, so it is removed')
  assert.deepEqual([kept['extra-kimi.pem'].pids, fps('extra-kimi.pem').includes(asightFp)], [[4545], false], 'a kimi the shim started holds extra-kimi.pem')
  for (const p of [plugin, path.join(s.dir, 'bin'), path.join(s.dir, 'plugins')]) assert.ok(!fs.existsSync(p), `${p} is gone`)
  assert.ok(!/asight collector/.test(fs.readFileSync(path.join(s.home, '.bashrc'), 'utf8')) && !fs.readFileSync(path.join(s.home, '.dsh', 'cordis.patch.yml'), 'utf8').includes('asight'))
  assert.deepEqual(r.results.map((x) => x.result).filter((x) => x !== 'restored'), [], 'every entry came back byte for byte')
  assert.ok(fs.existsSync(s.ca('asight-ca.pem')) && fs.existsSync(s.ca('ca.key')), 'without dropCa the CA stays')
  assert.deepEqual(r.still_trusting.map((x) => [x.pid, x.harness, x.until]).sort(), [[4242, 'codex', 'next-connection'], [4343, 'z-code', 'session-end'], [4545, 'kimi-code', 'restart']], 'a kimi by its absolute path (4546) never trusted asight: not reported')
})

test('V25: the undo of codex alone (both phases) takes ~/.codex/.env and its bundle and nothing else — asight-ca.pem, every other entry and bundle byte for byte; a live codex keeps combined-codex.pem, without the CA', async () => {
  const s = await sevenInstalled()
  const everything = () => snapshot(s.home, ['.asight/collector/install-manifest.json', '.asight/collector/flows']) // the manifest is rewritten by design
  const before = everything()
  const r = await s.run({ ids: ['codex'] })
  assert.deepEqual(r.results.map((x) => [x.harness, path.relative(s.home, x.path), x.result]), [['codex', '.codex/.env', 'restored']])
  assert.equal(fs.readFileSync(s.sh.files.codex[0], 'utf8'), 'OPENAI_API_KEY=sk-test\n')
  const after = everything()
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k])
  assert.deepEqual(changed.map((k) => k.replace(/^\.asight\/backup\/.*$/, '.asight/backup/<codex .env>')).sort(), ['.asight/backup/<codex .env>', '.asight/collector/ca/combined-codex.pem', '.codex/.env'], 'its .env, its bundle and the backup of its .env — asight-ca.pem, the key, the other bundles and the other six harnesses\' files are byte for byte')
  assert.deepEqual(changed.filter((k) => after[k] === undefined).length, 2, 'the bundle and the backup are gone, not changed')
  assert.deepEqual([...new Set(readManifest(s.dir).entries.map((e) => e.harness))].sort(), HARNESS_IDS.filter((h) => h !== 'codex' && h !== 'opencode').sort(), 'the other harnesses are still installed (opencode has no entry, only a plugin file)')
  // with a live codex: the bundle stays, without the CA, and the other bundles still do not move
  const t = await sevenInstalled()
  const others = (n) => fs.readFileSync(t.ca(n), 'utf8')
  const hermesBefore = others('combined-hermes.pem')
  const k = await t.run({ ids: ['codex'], procs: async () => [proc(4242, '/home/u/.local/bin/codex', ['codex'])] })
  assert.deepEqual(k.kept_bundles.map((x) => [path.basename(x.path), x.pids]), [['combined-codex.pem', [4242]]])
  assert.deepEqual([others('combined-hermes.pem') === hermesBefore, certBlocks(others('combined-codex.pem')).length > 0], [true, true])
  assert.ok(!certBlocks(others('combined-codex.pem')).some((c) => c.fp === certBlocks(others('asight-ca.pem'))[0].fp))
  assert.deepEqual(k.still_trusting, [{ pid: 4242, harness: 'codex', until: 'next-connection' }])
})

// ── T07: the orchestration ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const shaOf = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const execFrom = (s, from) => s.sys.exec.calls.slice(from)

test('V1: off with the daemon gone (its lock left, its helper dead): every certificate item install wrote for all seven harnesses stays byte for byte (D55①), exit 0, and nothing starts a daemon', async () => {
  const s = await installedHome({ names: ALL_HARNESSES })
  const entries = s.manifest().entries, installed = s.installItems()
  assert.ok(entries.length >= 5, 'seven harnesses have install entries off must spare')
  s.sys.daemon.state.up = false // killed: nothing answers
  writeDaemonLock(s) // and its lock is left behind, naming a pid that is gone
  const calls = s.sys.exec.calls.length, asked = s.sys.daemon.calls.length
  const { receipt, exit } = await s.off({ deps: { alive: () => false } })
  assert.equal(exit, 0, JSON.stringify(receipt.problems))
  assert.deepEqual(validateReceipt(receipt), [])
  assert.deepEqual(s.installItems(), installed, 'every phase-install item: still in the manifest, its file byte for byte')
  assert.deepEqual(receipt.routing, { confirmed: true, state: 'stale', how: 'no-daemon' })
  assert.deepEqual([receipt.daemon, receipt.relayed], [{ pid: null, state: 'none' }, { closing: 0, waiting: 0, cut: 0 }], 'no daemon: nothing is relayed, said as a fact')
  assert.deepEqual(execFrom(s, calls), ['systemctl --user is-active asight-collector.service', 'systemctl --user disable asight-collector.service'], 'the only OS tools run are the question whether systemd is about to restart the daemon (it says inactive here) and the autostart disable: no start, no stop, no restart')
  assert.deepEqual(s.sys.daemon.calls.slice(asked).filter((c) => c.startsWith('POST')), [], 'and no daemon was asked for anything, let alone started')
  assert.deepEqual(Object.values(s.state().harnesses).map((h) => h.desired), ALL_HARNESSES.map(() => 'off'), 'every harness is off in state.json')
  assert.deepEqual(readManifest(s.dir).entries, entries, 'and the manifest keeps them for uninstall')
})

// a systemd that answers like the real one for a daemon that was killed: `activating` (auto-restart) until `stop` is run, then `inactive`; `stubborn` keeps it activating
function restartingSystemd(s, { stubborn = false } = {}) {
  const state = { unit: 'activating' }
  const run = (file, args, o) => {
    const cmd = [file, ...args].join(' ')
    if (/ is-active /.test(cmd)) { s.sys.exec.calls.push(cmd); return { status: state.unit === 'inactive' ? 3 : 0, stdout: `${state.unit}\n`, stderr: '' } }
    if (/ stop /.test(cmd) && !stubborn) state.unit = 'inactive'
    return s.sys.exec.run(file, args, o)
  }
  return { run, state }
}

test('semantics 4 / 1.6 §1.4: a killed daemon that systemd is about to restart (Restart=on-failure) is stopped by an off with no names — stop, reset-failed, is-active, so no daemon comes back; nothing is relayed, exit 0', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] }), installed = s.installItems()
  s.sys.daemon.state.up = false
  writeDaemonLock(s)
  const sd = restartingSystemd(s)
  const from = s.sys.exec.calls.length
  const { receipt, exit } = await s.off({ deps: { alive: () => false, exec: sd.run } })
  assert.equal(exit, 0, JSON.stringify(receipt.problems))
  const cmds = execFrom(s, from)
  assert.deepEqual(cmds.filter((c) => !/ is-active /.test(c)), ['systemctl --user stop asight-collector.service', 'systemctl --user reset-failed asight-collector.service', 'systemctl --user disable asight-collector.service'], 'the unit is stopped and its failed state cleared, then the autostart is disabled')
  assert.ok(cmds.indexOf('systemctl --user stop asight-collector.service') < cmds.indexOf('systemctl --user disable asight-collector.service'), 'the restart is cancelled before the autostart goes')
  assert.deepEqual(receipt.relayed, { closing: 0, waiting: 0, cut: 0 }, 'there was no engine: nothing was relayed')
  assert.deepEqual(receipt.daemon, { pid: null, state: 'none' })
  assert.equal(receipt.routing.confirmed, true)
  assert.deepEqual(validateReceipt(receipt), [])
  assert.deepEqual(s.installItems(), installed, 'and every certificate item stays (D55①)')
  const events = flowEvents(s.dir)
  assert.ok(events.some((e) => e.kind === 'daemon-stop' && e.stopped === true && /about to restart/.test(e.reason)), 'the stop is on the record')
})

test('semantics 4: a unit systemd keeps up after the stop is not "off": exit 1 with the command to run, and the certificate items stay all the same', async () => {
  const s = await installedHome({ names: ['claude-code'] }), installed = s.installItems()
  s.sys.daemon.state.up = false
  const sd = restartingSystemd(s, { stubborn: true })
  const { receipt, exit } = await s.off({ deps: { alive: () => false, exec: sd.run } })
  assert.equal(exit, 1)
  assert.match(receipt.problems.join('\n'), /systemctl --user stop asight-collector\.service/)
  assert.deepEqual(s.installItems(), installed, 'off never touches a certificate item (D55①); desired is off, so a daemon that comes back attaches nothing')
})

test('semantics 4: off with names does not touch the unit — only an off with no names takes the daemon away', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  s.sys.daemon.state.up = false
  const sd = restartingSystemd(s)
  const from = s.sys.exec.calls.length
  const { exit } = await s.off({ ids: ['codex'], deps: { alive: () => false, exec: sd.run } })
  assert.equal(exit, 0)
  assert.deepEqual(execFrom(s, from).filter((c) => / (stop|disable|reset-failed|is-active) /.test(c)), [], 'no systemctl question or command for a named off')
})

test('semantics 5: with no autostart unit managing it the way out names the pid to kill (the daemon\'s own reply, else the lock\'s); with none on record, how to find it', async () => {
  const s = await installedHome({ names: ['claude-code'], daemon: { pid: 4242 } })
  fs.rmSync(path.join(s.home, '.config', 'systemd', 'user', 'asight-collector.service'))
  const r = await s.off({ deps: { request: async (q) => (q.path === '/off' ? { actual: 'on', confirmed: false, relayed: { closing: 0, waiting: 0, cut: 0 }, pid: 5151 } : s.sys.daemon.request(q)) } })
  assert.equal(r.exit, 1)
  assert.match(r.receipt.problems[0], /To go on, stop the daemon \(kill 5151\), which takes its links off with it/)
  const t = await installedHome({ names: ['claude-code'] })
  fs.rmSync(path.join(t.home, '.config', 'systemd', 'user', 'asight-collector.service'))
  const none = await t.off({ deps: { request: async (q) => (q.path === '/off' ? { actual: 'on', confirmed: false, relayed: { closing: 0, waiting: 0, cut: 0 } } : t.sys.daemon.request(q)) } })
  assert.match(none.receipt.problems[0], /no pid is on record: find it with pgrep -f 'asight\.\* \(daemon\|collector start\)'/)
})

// a manifest that names a file asight never made (damaged, hand-edited, or from a bug) must not take the user's data with it: what `off` / `uninstall` remove, rewrite or
// rebuild at a path the manifest gives has to be inside ~/.asight (audit semantics 6)
function victims(s) {
  const dirV = path.join(s.home, 'Documents', 'precious'), fileV = path.join(s.home, 'Documents', 'notes.txt'), keyV = path.join(s.home, '.ssh', 'id_test')
  fs.mkdirSync(dirV, { recursive: true }); fs.writeFileSync(path.join(dirV, 'thesis.txt'), 'years of work\n')
  fs.writeFileSync(fileV, 'my notes\n'); fs.mkdirSync(path.dirname(keyV), { recursive: true }); fs.writeFileSync(keyV, 'PRIVATE\n')
  return { dirV, fileV, keyV, intact: () => [fs.readFileSync(path.join(dirV, 'thesis.txt'), 'utf8'), fs.readFileSync(fileV, 'utf8'), fs.readFileSync(keyV, 'utf8')] }
}

test('semantics 6: a manifest that names a path outside ~/.asight as a bundle, the CA certificate or the CA key is not followed — off never reads those items, uninstall leaves that path alone, says why, exit 1', async () => {
  const s = await installedHome({ names: ['codex'] })
  const v = victims(s), before = v.intact()
  const m = s.manifest()
  m.files.find((f) => f.role === 'bundle').path = v.dirV // a directory: `rm -r` would take everything in it
  m.files.find((f) => f.role === 'ca-cert').path = v.fileV
  m.files.find((f) => f.role === 'ca-key').path = v.keyV
  saveManifest(s.dir, m)
  const off = await s.off()
  assert.equal(off.exit, 0, JSON.stringify(off.receipt.problems))
  assert.deepEqual(v.intact(), before, 'off takes no bundle and no CA (D55①), so it follows none of those paths')
  assert.ok(fs.existsSync(path.join(v.dirV, 'thesis.txt')))
  const un = await s.uninstall({ yes: true })
  assert.equal(un.exit, 1)
  assert.deepEqual(v.intact(), before, 'uninstall too: the CA certificate and the CA key it was told to remove are not those files')
  assert.match(un.receipt.left.concat(un.receipt.problems.map((reason) => ({ reason }))).map((l) => l.reason).join('\n'), /is not inside .*\.asight/s)
})

test('semantics 6: a path inside ~/.asight is still removed — the fence is for what is outside it', async () => {
  const s = await installedHome({ names: ['codex'] })
  const un = await s.uninstall({ yes: true })
  assert.equal(un.exit, 0, JSON.stringify(un.receipt.problems))
  assert.equal(fs.existsSync(path.join(s.dir, 'ca')), false)
})

test('semantics 7: off on a machine asight was never installed on says so first — nothing to close, not 「asight 已关闭采集」 — touches nothing, points at no log, and names no autostart it did not disable', async () => {
  const home = tmpDir('asight-pristine-')
  const calls = []
  const run = (file, args) => { calls.push([file, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' } }
  const { receipt, exit } = await runOff({ home, env: { HOME: home }, deps: { exec: run, platform: 'linux', procs: async () => [], sleep: async () => {} } })
  assert.equal(exit, 0)
  assert.equal(receipt.nothing_installed, true)
  assert.equal(receipt.log, null, 'nothing was written, so there is no log to point at (R1)')
  assert.deepEqual(validateReceipt(receipt), [])
  const text = formatOffReceipt(receipt, { home })
  assert.match(text, /这台机器上没有 asight 的安装\(没装过,或已经 uninstall\),没有东西要关/)
  assert.doesNotMatch(text, /已关闭|自启已停用|引流/)
  assert.deepEqual(fs.readdirSync(home), [], 'and nothing was made in HOME')
  assert.deepEqual(calls, [], 'no OS tool was run: there is no unit to disable')
  const dry = await runOff({ home, env: { HOME: home }, dryRun: true, deps: { exec: run, platform: 'linux' } })
  assert.equal(dry.receipt.nothing_installed, true); assert.equal(dry.exit, 0)
  // an off of an installed asight is not that
  const s = await installedHome({ names: ['claude-code'] })
  const real = await s.off()
  assert.equal(real.receipt.nothing_installed, undefined)
  assert.match(formatOffReceipt(real.receipt, { home: s.home }), /asight 已关闭/)
  const again = await s.off() // the collector directory is still there: asight was installed, and is off
  assert.equal(again.receipt.nothing_installed, undefined)
})

test('V5: off claude-code takes only Claude Code\'s routing: no certificate item of either harness moves (D55①), it stays on in state.json and attached in the daemon, /off was posted with the name only and no exit', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  const codexEnv = path.join(s.home, '.codex', '.env'), settings = path.join(s.home, '.claude', 'settings.json')
  const codexBefore = shaOf(codexEnv), settingsBefore = shaOf(settings)
  assert.deepEqual([...s.sys.daemon.state.on].sort(), ['claude-code', 'codex'])
  const { receipt, exit } = await s.off({ ids: ['claude-code'] })
  assert.equal(exit, 0, JSON.stringify(receipt.problems))
  assert.deepEqual(validateReceipt(receipt), [])
  assert.equal(shaOf(codexEnv), codexBefore, 'codex\'s .env byte for byte')
  assert.equal(shaOf(settings), settingsBefore, 'claude-code\'s certificate entry, written by install, is byte for byte too')
  assert.deepEqual(s.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), ['POST /off {"harnesses":["claude-code"]}'], 'by name; no exit: the daemon stays for codex')
  assert.deepEqual([s.state().harnesses['claude-code'].desired, s.state().harnesses.codex.desired], ['off', 'on'])
  assert.deepEqual([s.sys.daemon.isRecording('claude-code'), s.sys.daemon.isRecording('codex')], [false, true], 'the daemon still has codex attached')
  assert.deepEqual([receipt.harnesses, receipt.all, receipt.daemon.state], [['claude-code'], false, 'running'])
  assert.deepEqual(receipt.changed, [], 'off changed no file of the user')
  assert.ok(s.sys.exec.calls.every((c) => !/disable/.test(c)), 'a named off leaves the autostart alone')
  assert.ok(['codex', 'claude-code'].every((h) => readManifest(s.dir).entries.some((e) => e.harness === h)), 'both are still installed')
})

test('V21: off,off changes nothing — the second run leaves state.json, the manifest and every user file as they were; per-harness: the bundle install wrote stays, CA and all, and so does the .env naming it', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  const bundle = path.join(s.dir, 'ca', 'combined-codex.pem')
  const caFp = certBlocks(fs.readFileSync(path.join(s.dir, 'ca', 'asight-ca.pem'), 'utf8'))[0].fp
  let seen = null
  const beforeBundle = fs.readFileSync(bundle, 'utf8')
  const first = await s.off({ ids: ['codex'], deps: { request: (q) => (q.path === '/off' ? (seen = { bundle: fs.readFileSync(bundle, 'utf8'), env: fs.readFileSync(path.join(s.home, '.codex', '.env'), 'utf8') }, s.sys.daemon.request(q)) : s.sys.daemon.request(q)) } })
  assert.equal(first.exit, 0, JSON.stringify(first.receipt.problems))
  assert.equal(seen.bundle, beforeBundle, 'when the daemon was asked to unwatch codex, its bundle still held the CA and its .env still named it')
  assert.ok(certBlocks(seen.bundle).some((c) => c.fp === caFp) && /asight collector/.test(seen.env))
  assert.equal(fs.readFileSync(bundle, 'utf8'), beforeBundle, 'afterwards too: off never rewrites a bundle (D55①)')
  const after = () => ({ user: s.userFiles(), manifest: fs.readFileSync(path.join(s.dir, 'install-manifest.json'), 'utf8'), state: fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8') })
  const all = await s.off()
  assert.equal(all.exit, 0, JSON.stringify(all.receipt.problems))
  const snap = after()
  const again = await s.off()
  assert.equal(again.exit, 0, JSON.stringify(again.receipt.problems))
  assert.deepEqual(after(), snap, 'a second off: not one byte of state.json, the manifest or a user file moves')
  assert.deepEqual([again.receipt.changed, again.receipt.removed], [[], []])
  const second = await s.off({ ids: ['codex'] })
  assert.deepEqual([second.exit, second.receipt.changed, second.receipt.removed], [0, [], []], 'off codex again: nothing to do (its certificate items are install\'s, D55①)')
})

test('1.6 §1.5: the routing is confirmed BEFORE one entry is touched — a daemon that does not confirm leaves every entry and bundle as it is, exit 1, and a state.json that already says off', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  const before = s.userFiles(), bundle = shaOf(path.join(s.dir, 'ca', 'combined-codex.pem'))
  const r = await s.off({ deps: { request: async (q) => (q.path === '/off' ? { actual: 'on', confirmed: false, relayed: { closing: 0, waiting: 0, cut: 0 }, pid: 4242 } : s.sys.daemon.request(q)) } })
  assert.equal(r.exit, 1)
  assert.deepEqual(r.receipt.routing, { confirmed: false, state: 'running', how: 'daemon-reply' })
  assert.match(r.receipt.problems[0], /did not confirm that the kernel's watch table and links are off/)
  assert.match(r.receipt.problems[0], /To go on, stop the daemon \(systemctl --user stop asight-collector\.service\), which takes its links off with it, then run the command again/, 'semantics 5: the way out is said, not only the refusal')
  assert.deepEqual(s.userFiles(), before, 'no user file moved')
  assert.equal(shaOf(path.join(s.dir, 'ca', 'combined-codex.pem')), bundle)
  assert.ok(readManifest(s.dir).entries.length >= 2, 'and the manifest still lists the entries')
  assert.deepEqual(Object.values(s.state().harnesses).map((h) => h.desired), ['off', 'off'], 'desired off was written first: the daemon\'s next heartbeat reads it')
  const failure = flowEvents(s.dir).find((e) => e.event === 'failure')
  assert.deepEqual([failure.where, failure.code], ['off', 'state-mismatch'])
  assert.deepEqual(flowEvents(s.dir).at(-1).kind, 'result')
})

test('1.6 §1.4 第 2 步: an off with no names asks the daemon to exit once drained and reports what is left of the connections; --now is passed on; an error answer (a 400) is a failure, not a stuck daemon', async () => {
  const s = await installedHome({ names: ['claude-code'], daemon: { relayed: { closing: 2, waiting: 1, cut: 0 }, exitOnOff: false } })
  const r = await s.off({ now: false })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.deepEqual(s.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), ['POST /off {"exit":true}'])
  assert.deepEqual([r.receipt.relayed, r.receipt.daemon], [{ closing: 2, waiting: 1, cut: 0 }, { pid: 4242, state: 'draining' }])
  const t = await installedHome({ names: ['claude-code'], daemon: { relayed: { closing: 0, waiting: 0, cut: 3 }, exitOnOff: false } })
  const cut = await t.off({ now: true })
  assert.deepEqual(t.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), ['POST /off {"now":true,"exit":true}'])
  assert.equal(cut.receipt.relayed.cut, 3)
  const u = await installedHome({ names: ['claude-code'] }); const before = u.userFiles()
  const bad = await u.off({ deps: { request: async (q) => { if (q.path === '/off') throw Object.assign(new Error('400: unknown harness: nope'), { status: 400 }); return u.sys.daemon.request(q) } } })
  assert.equal(bad.exit, 1); assert.match(bad.receipt.problems[0], /refused the off request/)
  assert.match(bad.receipt.problems[0], /To go on, stop the daemon \(systemctl --user stop asight-collector\.service\)/, 'semantics 5: and what to do about it')
  assert.deepEqual(u.userFiles(), before)
  assert.ok(u.sys.exec.calls.every((c) => !/stop|kill/.test(c)), 'an answering daemon is never stopped')
})

// a fake process table: pid → identity; `ignore`: signals a pid survives (a stopped or wedged process); every signal is recorded
test('1.6 §1.4 第 2 / 5 步 · 「守护进程卡死」: a stuck daemon is stopped FIRST (systemctl stop, then SIGTERM), its helper with it, and the certificate entry stays throughout; the receipt says so', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  writeDaemonLock(s)
  const t = procTable(DAEMON_ROWS, { survives: { 4242: ['SIGTERM'] } }); const c = fakeClock()
  const settings = path.join(s.home, '.claude', 'settings.json'); const seen = []
  const exec = (file, args) => { const cmd = [file, ...args].join(' '); seen.push([cmd, fs.readFileSync(settings, 'utf8').includes('NODE_EXTRA_CA_CERTS')]); return s.sys.exec.run(file, args) }
  const r = await s.off({ deps: { exec, request: hangsOnStatus(s), alive: t.alive, identity: t.identity, kill: t.kill, isHelper: t.isHelper, ...c } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.equal(seen.find(([cmd]) => / stop /.test(cmd))[1], true, 'when systemd was told to stop the daemon, the entry was still in place')
  assert.deepEqual(t.sent, [[4242, 'SIGTERM'], [4242, 'SIGKILL'], [4243, 'SIGTERM']], 'SIGTERM, then SIGKILL after the wait; the helper after the daemon; nothing else is signalled')
  assert.deepEqual([r.receipt.routing.state, r.receipt.routing.how, r.receipt.daemon.state, r.receipt.relayed], ['unresponsive', 'signal', 'stopped', 'unknown'])
  assert.match(r.receipt.relayed_reason, /could not say how many connections/)
  assert.ok(fs.readFileSync(settings, 'utf8').includes('NODE_EXTRA_CA_CERTS'), 'and after it: off never takes what install wrote (D55①)')
  const stop = flowEvents(s.dir).find((e) => e.kind === 'daemon-stop')
  assert.deepEqual([stop.event, stop.where, stop.signals], ['off-note', 'off', ['systemctl-stop', 'SIGTERM', 'SIGKILL', 'SIGTERM']], 'the stop is on record (V30\'s stop event)')
})

test('a stuck daemon and `off codex`: it is stopped all the same (the others were not being captured by a stuck daemon), codex is undone, claude-code stays installed, exit 0 (V30 unit half, named form)', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  writeDaemonLock(s)
  const t = procTable(DAEMON_ROWS); const c = fakeClock(); const claudeBefore = shaOf(path.join(s.home, '.claude', 'settings.json'))
  const r = await s.off({ ids: ['codex'], deps: { request: hangsOnStatus(s), alive: t.alive, identity: t.identity, kill: t.kill, isHelper: t.isHelper, ...c } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.equal(r.receipt.daemon.state, 'stopped')
  assert.equal(shaOf(path.join(s.home, '.claude', 'settings.json')), claudeBefore)
  assert.deepEqual([s.state().harnesses.codex.desired, s.state().harnesses['claude-code'].desired], ['off', 'on'])
  assert.ok(s.sys.exec.calls.every((c2) => !/disable/.test(c2)), 'a named off never disables the autostart')
})

test('a daemon that cannot be stopped: the certificate items stay as they are, exit 1, and the receipt gives the pid and kill -9; one that is only starting is stopped like a stuck one', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  writeDaemonLock(s)
  const t = procTable(DAEMON_ROWS, { survives: { 4242: ['SIGTERM', 'SIGKILL'] } }); const c = fakeClock()
  const r = await s.off({ deps: { request: hangsOnStatus(s), alive: t.alive, identity: t.identity, kill: t.kill, isHelper: t.isHelper, ...c } })
  assert.equal(r.exit, 1)
  assert.match(r.receipt.problems.join('\n'), /pid 4242.*could not be stopped.*kill -9 4242/)
  assert.deepEqual([r.receipt.daemon.state, r.receipt.routing.confirmed], ['unresponsive', false])
  assert.ok(fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8').includes('NODE_EXTRA_CA_CERTS'), 'the certificate entry stays (D55①)')
  assert.deepEqual(flowEvents(s.dir).filter((e) => e.event === 'failure').map((e) => [e.where, e.code]), [['off', 'stop-failed']])
  const starting = await installedHome({ names: ['claude-code'] }); writeDaemonLock(starting)
  const t2 = procTable(DAEMON_ROWS); const c2 = fakeClock()
  const refuses = async (q) => { if (q.path === '/status') throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }); return starting.sys.daemon.request(q) }
  const r2 = await starting.off({ deps: { request: refuses, alive: t2.alive, identity: t2.identity, kill: t2.kill, isHelper: t2.isHelper, ...c2 } })
  assert.deepEqual([r2.exit, r2.receipt.routing.state, r2.receipt.daemon.state], [0, 'starting', 'stopped'])
})

test('a lock cut short (empty or garbage) and nothing listening on the control socket is the last lock of a daemon that is gone: off goes on, takes the routing off, says so, and a second off does too; a stale lock with a live helper has the helper stopped', async () => {
  const refusing = (s) => async (q) => { if (q.path === '/status') throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }); return s.sys.daemon.request(q) }
  for (const body of ['', '{"pid":']) { // empty is what a power loss leaves; the other is a write cut off half way
    const s = await installedHome({ names: ['claude-code'] }); fs.writeFileSync(path.join(s.dir, 'lock'), body)
    const t = procTable({}); const world = { request: refusing(s), alive: t.alive, identity: t.identity, kill: t.kill, ...fakeClock() }
    const r = await s.off({ deps: world })
    assert.equal(r.exit, 0, `${JSON.stringify(body)}: ${JSON.stringify(r.receipt.problems)}`)
    assert.deepEqual(validateReceipt(r.receipt), [])
    assert.deepEqual([r.receipt.routing, t.sent], [{ confirmed: true, state: 'stale', how: 'no-daemon' }, []], 'nothing is stopped, nobody is signalled')
    assert.ok(fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8').includes('NODE_EXTRA_CA_CERTS'), 'the certificate entry stays (D55①)')
    assert.match(r.receipt.notes.join('\n'), /nothing listens on \/x\/collector\.sock either.*ended without a clean stop/, 'and the receipt says how the lock was read')
    assert.ok(flowEvents(s.dir).some((e) => e.where === 'off' && e.kind === 'note' && /ended without a clean stop/.test(e.reason)), 'and so does flows/')
    const again = await s.off({ deps: world })
    assert.equal(again.exit, 0, `a second off (${JSON.stringify(body)}): ${JSON.stringify(again.receipt.problems)}`)
  }
  const h = await installedHome({ names: ['claude-code'] }); writeDaemonLock(h)
  const live = procTable({ 4243: { start_time: '112', boot_id: 'boot-1' } }) // the daemon is dead, its helper lingers
  const r2 = await h.off({ deps: { request: refusing(h), alive: live.alive, identity: live.identity, kill: live.kill, isHelper: live.isHelper, ...fakeClock() } })
  assert.deepEqual([r2.exit, live.sent, r2.receipt.daemon.state], [0, [[4243, 'SIGTERM']], 'stopped'])
})

test('a lock cut short and NO control socket to ask (XDG_RUNTIME_DIR unset) is not known: nothing is stopped, no entry touched, exit 1, the receipt names the file and the way out — and the way out works when followed (R11: not known is said, not read as none)', async () => {
  const s = await installedHome({ names: ['claude-code'] }); const before = s.userFiles()
  const lockFile = path.join(s.dir, 'lock'); fs.writeFileSync(lockFile, '')
  const asked = []; const t = procTable({})
  const world = { socketPath: null, request: async (q) => { asked.push(q.path); return s.sys.daemon.request(q) }, alive: t.alive, identity: t.identity, kill: t.kill, ...fakeClock() }
  const r = await s.off({ deps: world })
  assert.equal(r.exit, 1)
  assert.match(r.receipt.problems[0], /not valid JSON.*whether a daemon runs is not known \(no control socket path is known to ask: XDG_RUNTIME_DIR is not set\)/)
  assert.ok(r.receipt.problems[0].includes(`delete ${lockFile} and run asight off again`), 'it names the file, and what to do once no daemon runs')
  assert.deepEqual([s.userFiles(), t.sent, asked], [before, [], []], 'no entry touched, nobody signalled, nobody asked')
  fs.rmSync(lockFile) // as it says
  const followed = await s.off({ deps: world })
  assert.equal(followed.exit, 0, JSON.stringify(followed.receipt.problems))
  assert.deepEqual(s.userFiles(), before, 'followed: the off goes through, and the certificate entry still stays (D55①)')
})

test('R12: an off that cannot get the op lock in time has written desired off first and says which command holds it; nothing else is touched, exit 1', async () => {
  const s = await installedHome({ names: ['claude-code'] }); const before = s.userFiles()
  fs.writeFileSync(path.join(s.dir, 'op.lock'), JSON.stringify({ pid: 5555, start_time: '9', boot_id: 'boot-1' }))
  const r = await s.off({ deps: { lockWaitMs: 40, alive: (pid) => pid === 5555, identity: (pid) => (pid === 5555 ? { start_time: '9', boot_id: 'boot-1' } : { start_time: null, boot_id: null }) } })
  assert.equal(r.exit, 1); assert.match(r.receipt.problems[0], /another asight command \(pid 5555\) holds .*already off for every harness/)
  assert.equal(s.state().harnesses['claude-code'].desired, 'off', 'desired off was written before the wait')
  assert.deepEqual(s.userFiles(), before)
  assert.deepEqual(s.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), [])
  assert.equal(flowEvents(s.dir).at(-1).outcome, 'failed')
  assert.equal(fs.readFileSync(path.join(s.dir, 'op.lock'), 'utf8').includes('5555'), true, 'the holder\'s lock is not ours to remove')
})

test('V27: over on, off and a daemon that has to be stopped, nothing restarts an agent — no signal goes to a pid that is not the daemon or its helper, no systemctl restart; off takes no certificate, so it lists no one as still trusting it', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] }); writeDaemonLock(s)
  const t = procTable({ ...DAEMON_ROWS, 5000: { start_time: '5', boot_id: 'boot-1' }, 5001: { start_time: '6', boot_id: 'boot-1' } }, { survives: { 4242: ['SIGTERM'] } })
  const agents = [
    { pid: 5000, ppid: 1, uid: 1000, startedAt: Date.now() + 5000, exe: '/home/u/.local/share/claude/versions/2.1.289', argv: ['claude'], env: () => new Map() },
    { pid: 5001, ppid: 1, uid: 1000, startedAt: Date.now() + 5000, exe: '/home/u/.local/bin/codex', argv: ['codex'], env: () => new Map() },
    { pid: 7001, ppid: 1, uid: 1000, startedAt: 1, exe: '/usr/bin/node', argv: ['node', '/repo/bin/asight.mjs', 'serve', '--port', '9000'], env: () => new Map() },
    { pid: 7002, ppid: 1, uid: 1000, startedAt: 1, exe: '/usr/bin/node', argv: ['node', '/repo/bin/asight.mjs', 'capture'], env: () => new Map() },
    { pid: 7003, ppid: 1, uid: 1000, startedAt: 1, exe: '/usr/bin/node', argv: ['node', '/repo/bin/asight.mjs', 'etl'], env: () => new Map() },
  ]
  const procs = async () => agents
  const calls = s.sys.exec.calls.length
  // the `on` leg (installedHome has run it): all the OS tools it ran are the unit's `enable --now` — no restart, no stop, no signal — and all it asked of the daemon is its status and to attach the harnesses
  assert.deepEqual(s.sys.exec.calls.slice(0, calls), ['systemctl --user enable --now asight-collector.service'], 'on starts the daemon (a start is not a restart) and touches no agent')
  assert.deepEqual(s.sys.daemon.calls.map((c) => c.split(' {')[0]), ['GET /status', 'GET /status', 'POST /on'], 'on asks the daemon for its status and attaches the harnesses: nothing else')
  const r = await s.off({ deps: { procs, request: hangsOnStatus(s), alive: (pid) => t.alive(pid) || agents.some((a) => a.pid === pid), identity: t.identity, kill: t.kill, isHelper: t.isHelper, ...fakeClock() } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.ok(t.sent.every(([pid]) => pid === 4242 || pid === 4243), `signals went to the daemon and its helper only: ${JSON.stringify(t.sent)}`)
  assert.ok(execFrom(s, calls).every((c) => !/restart/.test(c)), 'no systemctl restart')
  assert.deepEqual(r.receipt.still_trusting, [], 'off took no certificate item, so it has no one to report as still trusting what it took (D55①: trust stays until uninstall)')
  assert.deepEqual(r.receipt.restart, [], 'and off never lists anything to restart as a to-do of its own')
  assert.deepEqual(r.receipt.user_processes, [{ pid: 7001, command: 'asight serve', note: '只读看板,不在 agent 路径上' }, { pid: 7002, command: 'asight capture', note: '前台采集,可能正中转 agent 的流量' }], 'what the user started themselves is listed, never killed')
})

test('D38: every line off writes to flows/ is in the closed sets, every run of off ends with a result line, and a clean off writes the desired state, the routing and the autostart — and no line about a certificate item, which uninstall writes', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  fs.appendFileSync(path.join(s.home, '.codex', '.env'), 'EXTRA=1\n') // an edit after install: a note with a code
  const procs = async () => [{ pid: 5001, ppid: 1, uid: 1000, startedAt: Date.now() + 5000, exe: '/home/u/.local/bin/codex', argv: ['codex'], env: () => new Map() }]
  const r = await s.off({ deps: { procs } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  const mine = flowEvents(s.dir).filter((e) => e.where === 'off')
  assert.ok(mine.length >= 3)
  for (const e of flowEvents(s.dir)) assert.deepEqual(checkRecord(e), [], JSON.stringify(e))
  assert.deepEqual(new Set(mine.map((e) => e.run)).size, 1, 'one run, one `run`')
  assert.deepEqual(mine.map((e) => e.kind).filter(Boolean).slice(0, 2), ['desired-off', 'routing'])
  assert.ok(mine.some((e) => e.kind === 'autostart'))
  assert.ok(!mine.some((e) => e.code === 'reverted-not-identical' || e.code === 'backup-kept'), 'off took no certificate item, so it wrote no line about one (D55①)')
  const last = mine.at(-1)
  assert.deepEqual([last.event, last.kind, last.outcome], ['off-note', 'result', 'off'])
  // the lines about undoing the user's edited file are uninstall's now, in the same closed sets
  await s.uninstall({ yes: true, deps: { procs } })
  for (const e of flowEvents(s.dir)) assert.deepEqual(checkRecord(e), [], JSON.stringify(e))
  const un = flowEvents(s.dir).filter((e) => e.run !== mine[0].run && e.where !== 'off')
  assert.ok(un.some((e) => e.code === 'reverted-not-identical') && un.some((e) => e.code === 'still-trusting'), JSON.stringify(un.map((e) => [e.where, e.kind, e.code])))
})

test('V24: with the install manifest gone and no terminal, off takes the routing off, stops the daemon and leaves the files alone, lists what it found by asight\'s marks, exits 1 with outcome partial; with --yes it undoes them by those marks (undone-by-marker): the commented user line is back, the JSON value comes back from the backup', async () => {
  const codexOriginal = 'SSL_CERT_FILE=/corp/ca.pem\nOPENAI_API_KEY=sk-test\n'
  const s = await installedHome({ names: ['claude-code', 'codex'], seed: (home, sh) => {
    fs.writeFileSync(path.join(home, '.codex', '.env'), codexOriginal)
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `{\n  "env": { "NODE_EXTRA_CA_CERTS": "${sh.corp}" }\n}\n`)
  } })
  const settings = path.join(s.home, '.claude', 'settings.json'), codexEnv = path.join(s.home, '.codex', '.env')
  const settingsOriginal = `{\n  "env": { "NODE_EXTRA_CA_CERTS": "${s.sh.corp}" }\n}\n`
  assert.match(fs.readFileSync(codexEnv, 'utf8'), /#asight-collector-off# SSL_CERT_FILE=\/corp\/ca\.pem/, 'install put the user line out of effect with the sentinel prefix')
  fs.rmSync(path.join(s.dir, 'install-manifest.json'))
  const installed = s.userFiles()
  const first = await s.off({ yes: false, interactive: false })
  assert.equal(first.exit, 1)
  assert.deepEqual(validateReceipt(first.receipt), [])
  assert.deepEqual(s.userFiles(), installed, 'the files are byte for byte what they were: nothing is changed without a yes')
  assert.deepEqual(first.receipt.pending.map((p) => [path.relative(s.home, p.path), p.how]).sort(), [['.claude/settings.json', 'json-value'], ['.codex/.env', 'block']])
  assert.match(first.receipt.problems.join('\n'), /manifest is missing.*asight off --yes/)
  assert.deepEqual(Object.values(s.state().harnesses).map((h) => h.desired), ['off', 'off'], 'desired off for every harness')
  assert.deepEqual([first.receipt.routing.confirmed, s.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), first.receipt.autostart.disabled], [true, ['POST /off {"exit":true}'], true], 'the routing is off, the daemon was asked to exit, the autostart is disabled — none of it needs the manifest')
  assert.deepEqual([flowEvents(s.dir).at(-1).kind, flowEvents(s.dir).at(-1).outcome], ['result', 'partial'])
  const second = await s.off({ yes: true })
  assert.equal(second.exit, 0, JSON.stringify(second.receipt.problems))
  assert.equal(second.receipt.undone_by_marker, true)
  assert.equal(fs.readFileSync(codexEnv, 'utf8'), codexOriginal, 'the block is out and the commented user line is back')
  assert.equal(fs.readFileSync(settings, 'utf8'), settingsOriginal, 'the JSON value is back, taken from the backup, this key only')
  assert.deepEqual(flowEvents(s.dir).filter((e) => e.code === 'undone-by-marker').length, 2, 'one note per file, each with the code')
  assert.equal(flowEvents(s.dir).at(-1).outcome, 'undone-by-marker')
  const asked = fakeAsk(); const third = await s.off({ interactive: true, io: asked.io, say: asked.say }) // nothing left to find: no question
  assert.deepEqual([third.exit, asked.said.length], [0, 0])
})

// a terminal that types `answer` to the one question (src/off/io.mjs confirm reads a line from stdin and prints the question to io.prompt || io.stdout)
function fakeAsk(answer = 'y') {
  const said = [], printed = []
  const listeners = {}
  const stdin = { isTTY: true, on: (e, f) => { listeners[e] = f }, removeListener: () => {}, pause: () => {}, resume: () => {} }
  const stdout = { isTTY: true, write: (t) => { printed.push(t); if (/\[y\/N\] $/.test(t)) setImmediate(() => listeners.data && listeners.data(`${answer}\n`)) } }
  return { io: { stdin, stdout, out: (t) => said.push(t), err: (t) => said.push(t) }, said, printed, say: (t) => said.push(t) }
}

test('V24 (terminal): the list is printed and ONE question asked; yes undoes by the marks, no leaves every file as it is (exit 1, partial)', async () => {
  const make = async () => { const s = await installedHome({ names: ['codex'] }); fs.rmSync(path.join(s.dir, 'install-manifest.json')); return s }
  const no = await make(); const before = no.userFiles(); const asked = fakeAsk('n')
  const declined = await no.off({ interactive: true, io: asked.io, say: asked.say })
  assert.deepEqual([declined.exit, no.userFiles(), asked.printed.filter((t) => /\[y\/N\]/.test(t)).length], [1, before, 1])
  assert.match(asked.said.join('\n'), /\.codex\/\.env|\.codex[\\/]\.env/)
  const yes = await make(); const asked2 = fakeAsk('y')
  const done = await yes.off({ interactive: true, io: asked2.io, say: asked2.say })
  assert.deepEqual([done.exit, done.receipt.undone_by_marker, /asight collector/.test(fs.readFileSync(path.join(yes.home, '.codex', '.env'), 'utf8'))], [0, true, false])
})

test('R3: a manifest this build does not read (a newer version) leaves every entry alone, says so, exits 1 — the routing is still taken off; an unreadable manifest falls back to the marks', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  const manifestFile = path.join(s.dir, 'install-manifest.json')
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); m.version = 99
  fs.writeFileSync(manifestFile, JSON.stringify(m)); const before = s.userFiles()
  const r = await s.off()
  assert.equal(r.exit, 1); assert.match(r.receipt.problems.join('\n'), /version 99.*no entry was touched/)
  assert.deepEqual([s.userFiles(), r.receipt.routing.confirmed], [before, true])
  assert.equal(flowEvents(s.dir).at(-1).outcome, 'left')
  fs.writeFileSync(manifestFile, '{ not json')
  const garbled = await s.off({ yes: true })
  assert.equal(garbled.exit, 0, JSON.stringify(garbled.receipt.problems)); assert.match(garbled.receipt.notes.join('\n'), /manifest cannot be read/)
  assert.ok(!fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8').includes('asight'), 'undone by the marks')
})

test('V34: an off that lands while `on` is writing wins — `on` exits 1, saying it was turned off; at the end desired is off, only the items install wrote are left, the files are as they were, and the daemon is told to switch off', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  await s.off() // off spares what install wrote (D55①): the on below is a re-on with no install between, and it is the race
  const before = s.userFiles(), installed = s.installItems()
  let offRun = null
  const racing = { ...fs, renameSync: (a, b) => { if (!offRun) offRun = s.off(); return fs.renameSync(a, b) } } // `off` starts when `on` is about to make its first write
  const on = await s.on({ fs: racing })
  const off = await offRun
  // on's one write is state.json now (D55: install wrote the entries); whether on sees the off depends on whether off's desired-off lands before on's
  // last guard — R12 below pins the case where it does. Either way the end is off's, and an on that saw it says so and exits 1.
  if (on.exit !== 0) { assert.equal(on.exit, 1, JSON.stringify(on.receipt.notes)); assert.match(on.receipt.notes.join('\n'), /turned off while this on ran.*the off wins/) }
  assert.equal(off.exit, 0, JSON.stringify(off.receipt.problems))
  assert.deepEqual(Object.values(s.state().harnesses).map((h) => h.desired), ['off', 'off'], 'the final desired state is off')
  assert.deepEqual(s.installItems(), installed, 'only install\'s items are left, each byte for byte')
  assert.deepEqual(s.userFiles(), before, 'and the user\'s files are as they were')
  assert.deepEqual([...s.sys.daemon.state.on], [], 'nothing is attached')
  assert.ok(!fs.existsSync(path.join(s.dir, 'op.lock')), 'both released the lock')
})

test('V34: whichever write of `on` the off lands in, the end is the same — off wins: desired off, the items install wrote as they were, user files as before, no lock left', async () => {
  const count = await installedHome({ names: ['claude-code', 'codex'] })
  await count.off()
  let writes = 0
  await count.on({ fs: { ...fs, renameSync: (a, b) => { writes++; return fs.renameSync(a, b) } } })
  assert.ok(writes >= 1, `an on has ${writes} writes: the loop below has something to cut`)
  for (let k = 1; k <= writes; k++) {
    const s = await installedHome({ names: ['claude-code', 'codex'] })
    await s.off()
    const before = s.userFiles(), installed = s.installItems(); let n = 0, offRun = null
    const on = await s.on({ fs: { ...fs, renameSync: (a, b) => { if (++n === k && !offRun) offRun = s.off(); return fs.renameSync(a, b) } } })
    const off = await offRun
    assert.ok([0, 1].includes(on.exit), `write ${k}: ${JSON.stringify(on.receipt.notes)}`)
    assert.equal(off.exit, 0, `write ${k}: ${JSON.stringify(off.receipt.problems)}`)
    assert.deepEqual(Object.values(s.state().harnesses).map((h) => h.desired), ['off', 'off'], `write ${k}: the final desired state is off`)
    assert.deepEqual([s.installItems(), s.userFiles(), fs.existsSync(path.join(s.dir, 'op.lock')), [...s.sys.daemon.state.on]], [installed, before, false, []], `write ${k}`)
  }
})

test('V8: backups — 0700 / 0600; off leaves every entry and its backup as they are (D55①: the entries are install\'s), whatever the user edited; uninstall takes asight\'s part out of the edited file and keeps the user\'s line (the kept / dropped rule itself: undo.test.mjs「backups (R2)」)', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  const backupDir = path.join(s.home, '.asight', 'backup')
  assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700)
  const entries = s.manifest().entries; const by = Object.fromEntries(entries.map((e) => [e.harness, e]))
  for (const e of entries) { assert.ok(fs.existsSync(e.backup), `${e.harness} has a backup`); assert.equal(fs.statSync(e.backup).mode & 0o777, 0o600) }
  fs.appendFileSync(by.codex.path, 'EXTRA=1\n') // edited after asight changed it
  const backups = () => entries.map((e) => [e.backup, shaOf(e.backup)]), kept = backups(), edited = fs.readFileSync(by.codex.path, 'utf8'), installed = s.installItems()
  const r = await s.off()
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.deepEqual([r.receipt.changed, r.receipt.kept_backups ?? [], backups(), fs.readFileSync(by.codex.path, 'utf8'), s.installItems()], [[], [], kept, edited, installed], 'off: no entry, no backup, no byte of the edited file')
  assert.ok(!flowEvents(s.dir).some((e) => e.code === 'backup-kept'), 'and no backup-kept line')
  const on = await s.on() // and on again needs no install
  assert.equal(on.exit, 0, JSON.stringify(on.receipt.notes))
  await s.off()
  const un = await s.uninstall({ yes: true })
  assert.deepEqual(un.receipt.changed.filter((c) => c.path === by.codex.path).map((c) => c.result), ['reverted-not-identical'])
  assert.equal(fs.readFileSync(by.codex.path, 'utf8'), 'OPENAI_API_KEY=sk-test\nEXTRA=1\n', 'only asight\'s part went; the user\'s line stays')
})

test('R12: while `on` holds the op lock (it waits for its daemon to come up) an off writes desired off at once and waits for `on` to let go — and `on` sees the off within a poll instead of after fifteen seconds', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  await s.off() // everything off, the certificate items still in (D55①); the next on is a re-on, which waits for a daemon that never comes
  const never = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }
  const settings = path.join(s.home, '.claude', 'settings.json')
  let offRun = null, pauses = 0, meanwhile = null
  const sleep = async () => {
    if (++pauses !== 2) return
    offRun = s.off({ deps: { request: never } })
    await new Promise((resolve) => setTimeout(resolve, 60)) // off's turn: it can only wait
    meanwhile = { entry: fs.readFileSync(settings, 'utf8').includes('NODE_EXTRA_CA_CERTS'), desired: s.state().harnesses['claude-code'].desired, lock: fs.existsSync(path.join(s.dir, 'op.lock')) }
  }
  const on = await s.on({ request: never, sleep })
  assert.deepEqual(meanwhile, { entry: true, desired: 'off', lock: true }, 'the entry install wrote is there and on holds the lock; off had already written desired off')
  assert.equal(on.exit, 1); assert.match(on.receipt.notes.join('\n'), /turned off while this on ran/)
  assert.ok(pauses < 8, `on stopped at its next poll (${pauses} pauses), not after 60`)
  const off = await offRun
  assert.equal(off.exit, 0, JSON.stringify(off.receipt.problems))
  assert.ok(fs.readFileSync(settings, 'utf8').includes('NODE_EXTRA_CA_CERTS'), 'and after it the entry install wrote still stands (D55①)')
})

// The audit's HIGH finding (semantics 1), through the real `on` and the real `off`: Codex and Hermes read ONE trust bundle through their .env (4.6 §身份与信任, "replace"
// semantics). A .env that still names `combined-<h>.pem` when the file is gone leaves the agent with no CA at all — it cannot reach its real upstream either.
for (const [harness, rel] of [['codex', '.codex/.env'], ['hermes', '.hermes/.env']]) {
  test(`V15 (semantics 1): on, then the user's editor makes ${rel} CRLF, then uninstall (off spares it, D55①) — the entry is undone, the bundle is removed with it, exit 0; an entry that survives (a form the removal cannot read) keeps the bundle, exit 1, nothing dangles`, async () => {
    const s = await installedHome({ names: ['claude-code', harness] })
    s.sys.daemon.state.up = false
    const env = path.join(s.home, rel), bundle = path.join(s.dir, 'ca', `combined-${harness}.pem`)
    assert.ok(fs.readFileSync(env, 'utf8').includes(bundle) && fs.existsSync(bundle), 'install wrote the entry and the bundle')
    fs.writeFileSync(env, fs.readFileSync(env, 'utf8').replace(/\n/g, '\r\n'))
    const r = await s.uninstall({ yes: true })
    assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
    assert.deepEqual([fs.readFileSync(env, 'utf8').includes(`combined-${harness}.pem`), fs.existsSync(bundle)], [false, false], 'no entry names the bundle and the bundle is gone')
    assert.deepEqual(r.receipt.changed.filter((c) => c.path === env).map((c) => c.result), ['reverted-not-identical'])
    assert.ok(!r.receipt.skipped.some((x) => x.what === env), 'not "asight\'s text is no longer in this file"')
    // the same on a form the removal does not read: the file is left as it is, the bundle is kept (stripped of the CA), the entry stays for the next run
    const t = await installedHome({ names: ['claude-code', harness] })
    t.sys.daemon.state.up = false
    const env2 = path.join(t.home, rel), bundle2 = path.join(t.dir, 'ca', `combined-${harness}.pem`)
    const odd = fs.readFileSync(env2, 'utf8').replace(/^(SSL_CERT_FILE=.*)$/m, '$1;')
    fs.writeFileSync(env2, odd)
    const q = await t.uninstall({ yes: true })
    assert.equal(q.exit, 1, 'an entry that is not undone is a not-done uninstall (R3)')
    assert.equal(fs.readFileSync(env2, 'utf8'), odd, 'the file is as the user left it')
    assert.ok(fs.existsSync(bundle2), 'and the bundle it names is still there')
    assert.deepEqual(q.receipt.left.filter((l) => l.result === 'left-text').map((l) => l.path), [env2])
    assert.ok(q.receipt.left.find((l) => l.path === env2).restore.startsWith('cp '), 'with the command that puts the file back from the backup')
    assert.deepEqual(t.manifest().entries.filter((e) => e.harness === harness).map((e) => e.path), [env2], 'the entry stays in the manifest')
    assert.ok(flowEvents(t.dir).some((e) => e.event === 'failure' && e.code === 'entry-not-undone' && e.path === env2), 'and a failure event names it, in the closed set')
    for (const line of flowEvents(t.dir)) assert.deepEqual(checkRecord(line), [], JSON.stringify(line))
  })
}

// The audit's MEDIUM finding (semantics 2): a manifest that parses but has another shape used to crash `off` before it did anything (routing still on, nothing undone) or half-way
// (routing off, no receipt). Now it is as unreadable as one that does not parse: the routing is taken off, the entries are found by asight's marks after a yes (R3), and a receipt is printed.
for (const [what, doc] of [['{"version":3}', () => ({ version: 3 })], ['entries is an object', (m) => ({ ...m, entries: { a: 1 } })], ['entries holds null', (m) => ({ ...m, entries: [...m.entries, null] })], ['files is null', (m) => ({ ...m, files: null })]]) {
  test(`R3 / semantics 2: an install manifest of the wrong shape (${what}) — off takes the routing off, touches no file without a yes, says why and exits 1; with --yes it undoes by the marks; a receipt either way`, async () => {
    const s = await installedHome({ names: ['claude-code', 'codex'] })
    s.sys.daemon.state.up = false
    const manifestFile = path.join(s.dir, 'install-manifest.json')
    fs.writeFileSync(manifestFile, JSON.stringify(doc(JSON.parse(fs.readFileSync(manifestFile, 'utf8')))))
    const installed = s.userFiles()
    const first = await s.off()
    assert.equal(first.exit, 1)
    assert.deepEqual(validateReceipt(first.receipt), [])
    assert.deepEqual(s.userFiles(), installed, 'no file is touched without a yes')
    assert.match(first.receipt.notes.join('\n'), /the install manifest cannot be read .*not an install manifest this build can use/)
    assert.match(first.receipt.problems.join('\n'), /unreadable.*asight off --yes/)
    assert.deepEqual([first.receipt.routing.confirmed, Object.values(s.state().harnesses).map((h) => h.desired)], [true, ['off', 'off']], 'the routing is off and desired is off, with no manifest to say what is installed')
    assert.deepEqual(first.receipt.pending.map((p) => path.relative(s.home, p.path)).sort(), ['.claude/settings.json', '.codex/.env'])
    assert.equal(flowEvents(s.dir).at(-1).kind, 'result')
    const second = await s.off({ yes: true })
    assert.equal(second.exit, 0, JSON.stringify(second.receipt.problems))
    assert.equal(second.receipt.undone_by_marker, true)
    assert.ok(!/asight/.test(fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8')) && !/asight collector/.test(fs.readFileSync(path.join(s.home, '.codex', '.env'), 'utf8')))
  })
}

test('semantics 2: whatever throws while the entries are undone costs no receipt — undoSide hands back what it had, marked stopped, with a problem and a failure in the closed set, and the routing is not undone by it', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  const w = offWorld({ home: s.home, env: s.sh.env, deps: s.offDeps() })
  // a manifest object of a shape the reader would have refused, handed straight in: the undo must not throw
  const u = await undoSide(w, { ids: null, manifest: { version: 2, entries: null, files: [] } })
  assert.deepEqual([u.stopped, u.mode, u.failures.map((f) => f.code)], [true, 'manifest', ['entry-not-undone']])
  assert.match(u.problems.join('\n'), /undoing the entries stopped: .*run asight off again/)
  assert.deepEqual(u.failures.map((f) => checkRecord({ ts: new Date().toISOString(), event: 'failure', where: 'off', run: 'r', ...f })), [[]])
  // and through runOff, with a throw AFTER the files were written (the check of whether a file is still there, EIO): the receipt lists what was done, says what stopped, and a result line ends the run
  const t = await installedHome({ names: ['claude-code'] })
  t.sys.daemon.state.up = false
  const settings = path.join(t.home, '.claude', 'settings.json')
  const real = await import('node:fs')
  const fsx = new Proxy(real.default, { get: (o, k) => (k === 'existsSync' ? (f) => { if (String(f) === settings) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); return o.existsSync(f) } : o[k]) })
  const r = await t.uninstall({ yes: true, deps: { fs: fsx } }) // the certificate entry is uninstall's to undo (off spares it, D55①)
  assert.ok(!fs.readFileSync(settings, 'utf8').includes('asight'), 'the entry had been undone before it threw')
  assert.equal(r.exit, 1)
  assert.deepEqual(validateReceipt(r.receipt), [])
  assert.deepEqual(r.receipt.changed.map((c) => c.path), [settings], 'and the receipt says so: it lists what was written')
  assert.match(r.receipt.problems.join('\n'), /undoing the entries stopped: EIO: i\/o error/)
  assert.deepEqual([r.receipt.routing.confirmed, flowEvents(t.dir).at(-1).kind, flowEvents(t.dir).at(-1).outcome], [true, 'result', 'failed'])
})

// 4.6 撤销顺序 第 2 步 with the one list of OS bundles (pem.mjs SYSTEM_BUNDLES, the collector's too — off once had three of its six paths): a gone bundle a live
// codex may use is rebuilt from Node's roots and the first OS bundle this machine has. None here: the bundle is still made (no bundle, no network), and its note
// says it carries Node's roots only (D38), never a bundle quietly without the OS roots.
test('uninstall: a gone bundle rebuilt on a machine with no OS bundle says it carries Node\'s roots only (4.6 撤销顺序 第 2 步, D38)', async () => {
  const s = await installedHome({ names: ['codex'] })
  const bundle = path.join(s.dir, 'ca', 'combined-codex.pem')
  fs.rmSync(bundle)
  const noEtc = { ...fs, readFileSync: (f, ...a) => { if (SYSTEM_BUNDLES.includes(f)) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${f}'`), { code: 'ENOENT' }); return fs.readFileSync(f, ...a) } }
  const { receipt } = await s.uninstall({ yes: true, deps: { alive: () => false, roots: undefined, fs: noEtc, procs: async () => [proc(4242, '/home/u/.local/bin/codex', ['codex'])] } })
  assert.deepEqual(receipt.kept_bundles.map((k) => [path.basename(k.path), k.rebuilt]), [['combined-codex.pem', true]])
  assert.equal(receipt.kept_bundles[0].os_roots_missing, `no OS trust bundle holds a certificate (looked at ${SYSTEM_BUNDLES.join(', ')})`, 'the Linux reader\'s own words: every path looked at (os-roots.mjs osBundleRoots, the collector\'s too)')
  assert.ok(certBlocks(fs.readFileSync(bundle, 'utf8')).length > 0, 'rebuilt: Node\'s roots are in it')
  const said = flowEvents(s.dir).filter((e) => e.path === bundle && /rebuilt without the asight CA/.test(e.reason))
  assert.equal(said.length, 1, JSON.stringify(flowEvents(s.dir).map((e) => e.reason)))
  assert.match(said[0].reason, /with Node's roots only \(no OS trust bundle holds a certificate \(looked at \/etc\/ssl\/certs\/ca-certificates\.crt, /)
})

// 4.9 §6.2 「绝不用固定的 /etc/ssl/cert.pem 当 OS 根」, for `off`'s rebuild too (4.6 撤销顺序 第 2 步): a gone bundle a live codex may use, rebuilt on a Mac,
// must not take its OS roots from a static PEM file — the keychain's added anchors (a corporate proxy's CA) are in none of them. The /etc here is a stock
// Mac's, whatever this machine's is (a nix-darwin Mac also has the Debian path): /etc/ssl/cert.pem holds a marker root, every other file under /etc is absent.
// The rebuild reads what the install composed from instead (src/off/os-roots.mjs darwinRoots, through the one table): Node's set, the keychain's anchors, the
// SystemRootCertificates export.
// macOS uninstall refuses while a harness is on (CM24): off first (it spares the bundle, D55①), the daemon gone, then uninstall undoes it
const darwinUninstall = async (s, o) => { await s.off(); s.sys.daemon.state.up = false; return s.uninstall({ yes: true, ...o }) }
const enoentOf = (f) => Object.assign(new Error(`ENOENT: no such file or directory, open '${f}'`), { code: 'ENOENT' })
const stockMacFs = (marker, opened) => ({ ...fs, readFileSync: (f, ...a) => { if (!String(f).startsWith('/etc/')) return fs.readFileSync(f, ...a); opened.push(f); if (f === '/etc/ssl/cert.pem') return marker.certPem; throw enoentOf(f) } })
const macRoots = { bundled: createCa({ commonName: 'node bundled root' }), anchor: createCa({ commonName: 'corporate proxy CA (keychain anchor)' }), apple: createCa({ commonName: 'apple system root' }) }
const securityOf = (s, pems, calls = []) => (file, args, opts) => { if (file !== 'security') return s.sys.exec.run(file, args, opts); calls.push(args); return pems ? { status: 0, stdout: pems.join('\n'), stderr: '' } : { status: 1, stdout: '', stderr: 'SecKeychainOpen: I/O error' } }
test('uninstall on darwin: a gone bundle is rebuilt without opening a static OS bundle file such as /etc/ssl/cert.pem — from the keychain\'s anchors, Node\'s set and Apple\'s export, the install\'s own reader (4.9 §6.2, 4.6 撤销顺序 第 2 步)', async () => {
  const s = await installedHome({ names: ['codex'] })
  const bundle = path.join(s.dir, 'ca', 'combined-codex.pem')
  const asightFp = certBlocks(fs.readFileSync(path.join(s.dir, 'ca', 'asight-ca.pem'), 'utf8'))[0].fp
  fs.rmSync(bundle)
  const marker = createCa({ commonName: 'static OS bundle root' })
  const opened = []
  const tls = { getCACertificates: (k) => (k === 'bundled' ? [macRoots.bundled.certPem] : [macRoots.anchor.certPem]) }
  const { receipt } = await darwinUninstall(s, { deps: { platform: 'darwin', alive: () => false, roots: undefined, tls, exec: securityOf(s, [macRoots.apple.certPem]), fs: stockMacFs(marker, opened), procs: async () => [proc(4242, '/opt/homebrew/bin/codex', ['codex'])] } })
  assert.deepEqual(receipt.kept_bundles.map((k) => [path.basename(k.path), k.rebuilt, k.os_roots_missing, k.os_roots_partial]), [['combined-codex.pem', true, undefined, undefined]])
  const fps = certBlocks(fs.readFileSync(bundle, 'utf8')).map((c) => c.fp)
  assert.deepEqual([opened, fps.includes(certBlocks(marker.certPem)[0].fp)], [[], false], 'no static OS bundle is opened, and cert.pem\'s roots are not in the rebuilt bundle')
  assert.deepEqual(Object.values(macRoots).map((c) => fps.includes(certBlocks(c.certPem)[0].fp)), [true, true, true], 'the three darwin sources are in it — the corporate anchor among them, so codex keeps its relay')
  assert.equal(fps.includes(asightFp), false, 'and the asight CA is not')
  assert.match(formatOffReceipt(receipt), /重建了 \S*combined-codex\.pem(\(不含 asight CA\))/, 'the human receipt says it was rebuilt (4.6 第 2 步「回执写已重建」)')
})

// D38 on a Mac: a source that could not be read is said, the rebuild still made from the rest (no bundle = no network). Node 20 has no getCACertificates —
// the keychain's anchors, where a corporate proxy's CA lives, are then missing; the security export alone still gives Apple's standard roots.
test('uninstall on darwin: a gone bundle rebuilt while a source cannot be read says which (Node < 22.15: the keychain\'s anchors), in flows/ and on the receipt (D38)', async () => {
  const s = await installedHome({ names: ['codex'] })
  const bundle = path.join(s.dir, 'ca', 'combined-codex.pem')
  fs.rmSync(bundle)
  const { receipt } = await darwinUninstall(s, { deps: { platform: 'darwin', alive: () => false, roots: undefined, tls: {}, exec: securityOf(s, [macRoots.apple.certPem]), procs: async () => [proc(4242, '/opt/homebrew/bin/codex', ['codex'])] } })
  const k = receipt.kept_bundles[0]
  assert.deepEqual([k.rebuilt, k.os_roots_missing, k.os_roots_partial], [true, undefined, 'getCACertificates: not available (Node ≥ 22.15 has it)'])
  assert.ok(certBlocks(fs.readFileSync(bundle, 'utf8')).some((c) => c.fp === certBlocks(macRoots.apple.certPem)[0].fp), 'what could be read is in it')
  const said = flowEvents(s.dir).filter((e) => e.path === bundle && /rebuilt without the asight CA/.test(e.reason))
  assert.equal(said.length, 1)
  assert.match(said[0].reason, /with the OS roots short of what could not be read \(getCACertificates: not available \(Node ≥ 22\.15 has it\)\)/)
  assert.match(formatOffReceipt(receipt), /重建了 \S*combined-codex\.pem(\(不含 asight CA;OS 根缺读不到的那部分:getCACertificates: not available)/)
  // and with no source at all: Node's roots only, said as such
  const t = await installedHome({ names: ['codex'] })
  fs.rmSync(path.join(t.dir, 'ca', 'combined-codex.pem'))
  const none = await darwinUninstall(t, { deps: { platform: 'darwin', alive: () => false, roots: undefined, tls: {}, exec: securityOf(t, null), procs: async () => [proc(4242, '/opt/homebrew/bin/codex', ['codex'])] } })
  assert.match(none.receipt.kept_bundles[0].os_roots_missing, /^the macOS root certificates could not be read \(getCACertificates: not available .*; security: SecKeychainOpen: I\/O error\)$/)
  assert.ok(certBlocks(fs.readFileSync(path.join(t.dir, 'ca', 'combined-codex.pem'), 'utf8')).length > 0, 'still rebuilt: Node\'s roots are in it')
})

// 4.8 §6.2 in `off`: the system store through Node's own read; no helper here (the standalone undo starts none, the daemon may be gone), so a Node without
// getCACertificates rebuilds with Node's roots and says why. Driven through undoSide: the Windows half of runOff (task kill, the run key) is not this test's.
test('the bundle undo on win32: a gone bundle is rebuilt from the Windows system store; with no getCACertificates (Node < 22.15) and no helper, from Node\'s roots, said (4.8 §6.2, D38)', async () => {
  const winRoot = createCa({ commonName: 'windows store root' })
  for (const [tls, want] of [[{ getCACertificates: (k) => (k === 'system' ? [winRoot.certPem] : []) }, null], [{}, /^the Windows root certificates could not be read \(getCACertificates: not available \(Node ≥ 22\.15 has it\)\)$/]]) {
    const s = await installedHome({ names: ['codex'] })
    const bundle = path.join(s.dir, 'ca', 'combined-codex.pem')
    fs.rmSync(bundle)
    const opened = []
    const w = offWorld({ home: s.home, env: s.sh.env, deps: s.offDeps({ platform: 'win32', roots: undefined, tls, fs: stockMacFs(createCa({ commonName: 'not a windows root' }), opened), procs: async () => [proc(4242, '/home/u/.local/bin/codex', ['codex'])] }) }) // the sandbox install is a Linux user's (its liveness signature); the platform picks the reader
    const u = await undoSide(w, { manifest: readManifest(s.dir), phases: PHASES })
    const k = u.kept_bundles.find((x) => x.path === bundle)
    assert.equal(k.rebuilt, true, JSON.stringify(u.problems))
    assert.deepEqual(opened, [], 'no static PEM file on Windows either')
    const fps = certBlocks(fs.readFileSync(bundle, 'utf8')).map((c) => c.fp)
    if (!want) assert.deepEqual([k.os_roots_missing, fps.includes(certBlocks(winRoot.certPem)[0].fp)], [undefined, true], 'the store\'s root is in it')
    else {
      assert.match(k.os_roots_missing, want)
      assert.match(u.events.find((e) => e.path === bundle).reason, /with Node's roots only \(the Windows root certificates could not be read/)
      assert.ok(fps.length > 0, 'Node\'s roots are in it')
    }
  }
})

// Read only for a bundle that is rebuilt: the darwin read runs `security` (up to 10 s). A bundle in place is stripped, a gone one nobody uses is removed —
// neither needs roots; two rebuilt bundles share one read.
test('the bundle undo reads the OS roots only for a bundle it rebuilds, once: in place → stripped, gone and unused → removed, neither reads; two rebuilt share one read', async () => {
  const run = async (names, { gone = [], procs = [] }) => {
    const s = await installedHome({ names })
    for (const n of gone) fs.rmSync(path.join(s.dir, 'ca', `combined-${n}.pem`))
    const asked = [], ran = []
    const tls = { getCACertificates: (k) => { asked.push(k); return [macRoots.bundled.certPem] } }
    const w = offWorld({ home: s.home, env: s.sh.env, deps: s.offDeps({ platform: 'darwin', roots: undefined, tls, exec: securityOf(s, [macRoots.apple.certPem], ran), procs: async () => procs }) })
    const u = await undoSide(w, { manifest: readManifest(s.dir), phases: PHASES })
    return { kept: u.kept_bundles.map((k) => [path.basename(k.path), k.rebuilt]).sort(), removed: u.removed.map((p) => path.basename(typeof p === 'string' ? p : p.path)).filter((n) => /^combined-/.test(n)), asked, ran: ran.length }
  }
  const codex = proc(4242, '/home/u/.local/bin/codex', ['codex']), zcode = proc(4343, '/opt/ZCode/zcode', ['/opt/ZCode/zcode', '/opt/ZCode/resources/glm/zcode.cjs', 'app-server', '--stdio'], { startedAt: 0, env: { ELECTRON_RUN_AS_NODE: '1' } }) // V15's shapes
  assert.deepEqual(await run(['codex'], { procs: [codex] }), { kept: [['combined-codex.pem', undefined]], removed: [], asked: [], ran: 0 }, 'kept (a live codex), stripped in place: no root read')
  assert.deepEqual(await run(['codex'], { gone: ['codex'] }), { kept: [], removed: [], asked: [], ran: 0 }, 'gone, and no process uses it: dropped from the manifest, nothing rebuilt, no root read')
  const two = await run(['codex', 'z-code'], { gone: ['codex', 'z-code'], procs: [codex, zcode] })
  assert.deepEqual([two.kept, two.asked, two.ran], [[['combined-codex.pem', true], ['combined-z-code.pem', true]], ['bundled', 'system'], 1], 'two rebuilt bundles, one read of the roots')
})

// The Linux reader's own rule in `off` too (4.6 「合并包」: an OS bundle there but unreadable before the one found is not guessed about): the rebuild is
// made from Node's roots and says why, as `on` stops and the daemon keeps its bundles — never a bundle quietly built from a later file.
test('uninstall on Linux: an OS bundle that is there but unreadable ahead of a good one → the gone bundle is rebuilt from Node\'s roots, and the reason names the errno', async () => {
  const s = await installedHome({ names: ['codex'] })
  const bundle = path.join(s.dir, 'ca', 'combined-codex.pem')
  fs.rmSync(bundle)
  const later = createCa({ commonName: 'a later OS bundle root' })
  const etc = { ...fs, readFileSync: (f, ...a) => { if (f === SYSTEM_BUNDLES[0]) throw Object.assign(new Error(`EACCES: permission denied, open '${f}'`), { code: 'EACCES' }); if (f === SYSTEM_BUNDLES[1]) return later.certPem; if (SYSTEM_BUNDLES.includes(f)) throw enoentOf(f); return fs.readFileSync(f, ...a) } }
  const { receipt } = await s.uninstall({ yes: true, deps: { alive: () => false, roots: undefined, fs: etc, procs: async () => [proc(4242, '/home/u/.local/bin/codex', ['codex'])] } })
  const k = receipt.kept_bundles[0]
  assert.equal(k.rebuilt, true)
  assert.match(k.os_roots_missing, /^the OS trust bundle cannot be read \(\/etc\/ssl\/certs\/ca-certificates\.crt: EACCES/)
  assert.equal(certBlocks(fs.readFileSync(bundle, 'utf8')).some((c) => c.fp === certBlocks(later.certPem)[0].fp), false, 'not built from the later file')
})

// an off of an older build over a manifest a newer build wrote. The 10-12 main-Mac off half-failed (bootout EIO, then unknown-kind at the launcher):
// a kind this build does not know refuses the WHOLE off before step 2 / 3 — exit 1, the receipt names the kind and says a newer asight-off must undo it —
// with no routing change, no daemon asked, no OS tool run (no bootout), no file of the agents' touched, state.json as it was.
for (const where of ['entries', 'files']) {
 test(`an unknown kind in ${where}: the whole off is refused before the routing — nothing asked of the daemon, no OS tool, no file touched`, async () => {
    const s = await installedHome({ names: ['claude-code', 'codex'] })
    const file = path.join(s.dir, 'install-manifest.json')
    const m = JSON.parse(fs.readFileSync(file, 'utf8'))
    m[where].push({ kind: 'from-the-future', phase: 'on', harness: 'codex', path: path.join(s.home, '.codex', 'future.toml') })
    fs.writeFileSync(file, JSON.stringify(m, null, 2))
    const files = s.userFiles(), state = fs.readFileSync(path.join(s.dir, 'state.json')), manifest = fs.readFileSync(file)
    const asked = [], ran = []
    const r = await s.off({ deps: { request: (...a) => { asked.push(a); return s.sys.daemon.request(...a) }, exec: (...a) => { ran.push(a); return s.sys.exec.run(...a) } } })
    assert.equal(r.exit, 1)
    assert.deepEqual([asked, ran], [[], []], 'no routing change, no daemon stop, no bootout')
    assert.deepEqual([s.userFiles(), fs.readFileSync(path.join(s.dir, 'state.json')), fs.readFileSync(file)], [files, state, manifest], 'nothing undone, nothing written')
    assert.match(r.receipt.problems.join('\n'), /from-the-future.*newer asight-off/s)
    assert.deepEqual(r.receipt.left.map((l) => [l.result, l.path]), [['unknown-kind', path.join(s.home, '.codex', 'future.toml')]])
    assert.deepEqual(validateReceipt(r.receipt), [])
    assert.ok(s.sys.daemon.isRecording('claude-code'), 'the daemon still records')
  })
}

// 4.11 uninstall「撤根证书……最后删根的密钥」: the root's key goes after the trust store's root (the opt-in undo), never before it
test('P13 uninstall: the root key is removed after the trust store\'s root; off removes neither the key nor calls custody', async () => {
  for (const dropCa of [false, true]) {
    const home = tmpDir('asight-off-key-'), dir = path.join(home, '.asight', 'collector'), order = []
    const m = { version: 3, created_at: new Date(0).toISOString(), liveness: {}, kept_backups: [], files: [], entries: [
      { kind: 'root-key', phase: 'install', harness: null, path: 'keychain:asight-root', custody: { kind: 'keychain', id: 'asight-root' }, fp256: 'AB' },
      { kind: 'system-root', phase: 'install', harness: null, scope: 'user', path: 'login:root', store: 'login', fp256: 'AB' }] }
    fs.mkdirSync(dir, { recursive: true }); saveManifest(dir, m)
    const w = offWorld({ home, env: { HOME: home }, deps: { platform: 'darwin', socketPath: null, procs: async () => [],
      undoOptIns: async () => { order.push('root'); return { results: [{ result: 'undone', path: 'login:root', kind: 'system-root', scope: 'user' }], unknown: [] } },
      custody: { remove: async () => { order.push('key'); return { removed: true } } } } })
    const u = await undoSide(w, { manifest: readManifest(dir), dropCa, yes: true })
    assert.deepEqual([order, u.left], [dropCa ? ['root', 'key'] : ['root'], []], `dropCa ${dropCa}`)
    assert.equal(readManifest(dir).entries.some((e) => e.kind === 'root-key'), !dropCa)
  }
})

// the review of T20, item 1 (D55①, 1.6 §1.1 「证书一项不碰」): over every way off is run — all, --now, and each harness by name — every item install wrote
// is still on record and byte for byte after it, the user's files with it, and the next on turns capture back on with no install between (exit 0)
for (const [what, o] of [['off', () => ({})], ['off --now', () => ({ now: true })], ...ALL_HARNESSES.map((h) => [`off ${h}`, () => ({ ids: [h] })])]) {
  test(`D55① · Linux: install → on → ${what} → on — every phase-install item and every user file is as install left it, and the second on needs no install`, async () => {
    const s = await installedHome({ names: ALL_HARNESSES })
    const installed = s.installItems(), files = s.userFiles()
    assert.ok(installed.length >= 10, 'install wrote the certificate items of seven harnesses')
    const off = await s.off(o())
    assert.equal(off.exit, 0, JSON.stringify(off.receipt.problems))
    assert.deepEqual([s.installItems(), s.userFiles(), off.receipt.changed], [installed, files, []])
    const on = await s.on()
    assert.equal(on.exit, 0, JSON.stringify(on.receipt.notes))
    assert.deepEqual([s.installItems(), s.userFiles()], [installed, files], 'and on wrote no certificate either')
  })
}
