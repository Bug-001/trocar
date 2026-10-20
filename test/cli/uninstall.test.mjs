// test/cli/uninstall.test.mjs — `asight uninstall` (src/cli/uninstall.mjs, RFC 1.6 §1.1, R3, R4, R6, R7, R8, R12; V8 and V27 for uninstall, V24 for a lost manifest): off for every
// harness, then asight's own files, the captures kept. The sandbox HOME has had a real `asight on` (test/off/fixtures/off-ctx.mjs: the real turnOn, a fake systemd, a fake daemon
// behind the control socket); nothing here reaches the machine the tests run on (0.1 §3). The ORDER of the steps is test/collector/install.test.mjs "V13".
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runUninstallCli } from '../../src/cli/uninstall.mjs'
import { formatUninstallReceipt } from '../../src/cli/receipt.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { standalonePath } from '../../src/off/paths.mjs'
import { installedHome, writeDaemonLock, flowEvents, procTable, fakeClock, DAEMON_ROWS, hangsOnStatus, snapshot } from '../off/fixtures/off-ctx.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { assertEnglish } from '../helpers/english.mjs'
import { writeNetenv, netenvFile } from '../../src/netenv/index.mjs'

const BASE = new Date('2026-10-07T00:00:00Z')
/** `asight uninstall <argv>` over a sandbox: the exit code, and what it printed. §3.6 — uninstall always asks, so a case that is not about
 *  the question is answered with `--yes` (the plan-and-refusal cases pass `ask: true`). */
async function cli(s, argv, { io = fakeIo(), deps = {}, platform = 'linux', ask = false } = {}) {
  const args = ask || argv.includes('--yes') || argv.includes('--dry-run') ? argv : [...argv, '--yes']
  const exit = await runUninstallCli(args, { io, env: s.sh.env, home: s.home, platform, deps: s.offDeps({ getuid: () => 1000, ...deps }) })
  return { exit, io }
}
const keep = (s) => { for (const k of ['capture-2026-10-06.ndjson', 'audit/a.ndjson', 'replays/r.ndjson']) { fs.mkdirSync(path.dirname(path.join(s.dir, k)), { recursive: true }); fs.writeFileSync(path.join(s.dir, k), '{"keep":true}\n') } }
// D60: the records are segments under ~/.asight/raw (plain and sealed), the index asight builds from them under ~/.asight/index
const SEGMENTS = { 'raw/20261018T000000Z.ndjson': '{"id":"r1"}\n', 'raw/20261018T000000Z.sealed': 'sealed-bytes\n', 'raw/journal.jsonl': '{"seal":1}\n', 'index/20261018T000000Z.json': '{"idx":1}\n' }
const seedRecords = (s) => { const h = path.dirname(s.dir); for (const [k, v] of Object.entries(SEGMENTS)) { fs.mkdirSync(path.dirname(path.join(h, k)), { recursive: true }); fs.writeFileSync(path.join(h, k), v) } }
const records = (s) => { const h = path.dirname(s.dir); return Object.fromEntries(Object.keys(SEGMENTS).map((k) => [k, fs.existsSync(path.join(h, k)) ? fs.readFileSync(path.join(h, k), 'utf8') : null])) }
const kept = (s) => ['capture-2026-10-06.ndjson', 'audit/a.ndjson', 'replays/r.ndjson'].map((k) => fs.existsSync(path.join(s.dir, k)))
const CLASSES = '{"version":1,"classes":[]}\n', CLASSES_LOG = '{"ts":"2026-10-18T00:00:00.000Z","op":"reset"}\n'
/** the class table and its change log, seeded in ~/.asight (above the collector dir) and read back */
const seedClasses = (s) => { const h = path.dirname(s.dir); fs.mkdirSync(path.join(h, 'logs'), { recursive: true }); fs.writeFileSync(path.join(h, 'classes.json'), CLASSES); fs.writeFileSync(path.join(h, 'logs', 'classes.ndjson'), CLASSES_LOG) }
const classTable = (s) => { const h = path.dirname(s.dir); return [path.join(h, 'classes.json'), path.join(h, 'logs', 'classes.ndjson')].map((f) => { try { return fs.readFileSync(f, 'utf8') } catch (e) { return `MISSING (${e.code})` } }) }
const asightFiles = (s) => ['ca', 'run', 'state.json', 'install-manifest.json', 'op.lock', 'lock'].filter((n) => fs.existsSync(path.join(s.dir, n)))

test('uninstall: every entry is back as it was, asight\'s own files are gone, the captures and the records stay, and the receipt says so in the past tense (exit 0, --json validates)', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] }); keep(s)
  const entries = s.manifest().entries
  const before = s.userFiles()
  const { exit, io } = await cli(s, ['--json'])
  assert.equal(exit, 0, io.text())
  const r = io.json()
  assert.deepEqual(validateReceipt(r), [])
  assert.deepEqual([r.command, r.ok, r.all, r.purge_data, r.routing.confirmed], ['uninstall', true, true, false, true])
  assert.deepEqual([r.daemon.state, r.autostart.disabled], ['stopped', true])
  for (const e of entries) assert.equal(fs.existsSync(e.path) && fs.readFileSync(e.path).length > 0 ? true : !e.existed_before, true)
  assert.notDeepEqual(s.userFiles(), before, 'on had changed them')
  assert.deepEqual(asightFiles(s), [])
  assert.deepEqual(kept(s), [true, true, true])
  assert.ok(r.changed.length > 0 && r.entries.length === entries.length, 'what was taken out, row by row')
  assert.ok(r.removed.includes(path.join(s.dir, 'install-manifest.json')), 'the manifest is in the list of what asight removed')
  const twin = await installedHome({ names: ['claude-code'] }); seedRecords(twin)
  const text = await cli(twin, [])
  assert.equal(text.exit, 0)
  assert.match(text.io.stdoutText(), /^Uninstalled\. asight is no longer on your agents' path/)
  assert.match(text.io.stdoutText(), /Delete the captured records: asight uninstall --purge-data/)
  // no assertEnglish here: the `change` words of each row come from `off` (src/off/orchestrate.mjs), whose output is not this task's (1.6 §3.4)
})

test('uninstall --dry-run writes nothing and asks the daemon nothing: the same receipt in the future tense, exit 0 (R6)', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  const snap = snapshot(s.home), asked = s.sys.daemon.calls.length, ran = s.sys.exec.calls.length
  const { exit, io } = await cli(s, ['--dry-run'])
  assert.equal(exit, 0)
  assert.deepEqual([snapshot(s.home), s.sys.daemon.calls.length, s.sys.exec.calls.length], [snap, asked, ran])
  assert.match(io.stdoutText(), /^asight uninstall will take out everything install put on this machine/)
  assert.match(io.stdoutText(), /Will remove[\s\S]*backup/)
  assert.match(io.stdoutText(), /Nothing was changed\. Run it with --yes to do it\./)
  assertEnglish(io.stdoutText(), 'the dry-run plan of uninstall')
  const json = (await cli(s, ['--dry-run', '--json'])).io.json()
  assert.deepEqual([json.dry_run, json.ok, validateReceipt(json)], [true, true, []])
  assert.ok(json.removed.includes(standalonePath(s.home)) && json.removed.includes(path.join(s.dir, 'install-manifest.json')))
})

test('R6: --purge-data takes the collector machine with the data — kernel/, kernel-archive/, forwarder/ and control.json / ingress.json (the pinned kernel copy and cache, the kernel config with its secret, the daemon control endpoint) — while a plain uninstall leaves them for the next on, except ingress.json (uninstall deletes it, so the next install chooses its ports again)', async () => {
  const leftovers = (s) => { for (const k of ['kernel/asight-forwarder.exe', 'kernel-archive/mihomo.zip', 'forwarder/config.json', 'forwarder/home/db.sql', 'control.json', 'ingress.json']) { const f = path.join(s.dir, k); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '{"left":true}\n') } }
  const names = ['kernel', 'kernel-archive', 'forwarder', 'control.json', 'ingress.json']
  const there = (s) => names.map((n) => fs.existsSync(path.join(s.dir, n)))
  const purged = await installedHome({ names: ['claude-code'] }); keep(purged); leftovers(purged); seedClasses(purged)
  const r = await cli(purged, ['--purge-data', '--yes'])
  assert.equal(r.exit, 0, r.io.text())
  assert.deepEqual(there(purged), [false, false, false, false, false], 'the kernel, its cache, the forwarder state and the two endpoint files go with the data')
  // §3.6「流量类别表不删」(V82): the class table says what to keep of FUTURE calls, so not even --purge-data deletes it; its change log is data, and goes
  assert.deepEqual(classTable(purged), [CLASSES, 'MISSING (ENOENT)'])
  const plain = await installedHome({ names: ['claude-code'] }); keep(plain); leftovers(plain)
  const p = await cli(plain, ['--yes'])
  assert.equal(p.exit, 0, p.io.text())
  assert.deepEqual(there(plain), [true, true, true, false, false], 'a plain uninstall keeps the kernel, its cache and the forwarder state (the kernel may be draining; the next on reuses the cache), but neither endpoint file: ingress.json nor control.json (P12: daemon state, and the daemon has stopped)')
})

test('§3.6: the class-change log is data — a plain uninstall keeps it byte for byte and names it in `kept`; after --purge-data ~/.asight does not exist', async () => {
  const seedLog = (s) => { const f = path.join(path.dirname(s.dir), 'logs', 'classes.ndjson'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, CLASSES_LOG); return f }
  const plain = await installedHome({ names: ['claude-code'] }), log = seedLog(plain)
  const p = await cli(plain, ['--yes', '--json'])
  assert.equal(p.exit, 0, p.io.text())
  assert.equal(fs.readFileSync(log, 'utf8'), CLASSES_LOG)
  assert.ok(p.io.json().kept.some((k) => k.path === log && k.bytes === Buffer.byteLength(CLASSES_LOG)), JSON.stringify(p.io.json().kept))
  const purged = await installedHome({ names: ['claude-code'] }); seedLog(purged)
  const r = await cli(purged, ['--purge-data', '--yes'])
  assert.equal(r.exit, 0, r.io.text())
  assert.equal(fs.existsSync(path.dirname(purged.dir)), false, 'no ~/.asight after a full purge')
})

test('R6 · §3.6: uninstall always asks — no terminal and no --yes prints the plan and exits 2 with nothing done; a terminal asks once (n: nothing, exit 1); --yes goes; --purge-data says the records go for good', async () => {
  const s = await installedHome({ names: ['claude-code'] }); keep(s)
  const snap = snapshot(s.home), ran = s.sys.exec.calls.length
  const noTty = await cli(s, ['--purge-data'], { ask: true })
  assert.equal(noTty.exit, 2)
  assert.deepEqual([snapshot(s.home), s.sys.exec.calls.length], [snap, ran], 'nothing was done')
  assert.match(noTty.io.stdoutText(), /^asight uninstall will take out everything install put on this machine/, 'the plan is printed')
  assert.match(noTty.io.stdoutText(), /your captured records \(--purge-data\)/)
  assert.match(noTty.io.stderrText(), /Nothing was changed\. Read the plan above, then run it again with --yes/)
  assertEnglish(noTty.io.text(), 'the plan and refusal of uninstall')
  const json = await cli(s, ['--purge-data', '--json'], { ask: true })
  assert.deepEqual([json.exit, json.io.json().needs_yes, json.io.json().ok], [2, true, false])
  assert.equal(json.io.stderrText(), '', 'nothing on stderr under --json')
  const no = await cli(s, ['--purge-data'], { io: fakeIo({ tty: true, answers: ['n'] }), ask: true })
  assert.deepEqual([no.exit, no.io.asked.length, snapshot(s.home)], [1, 1, snap])
  assert.match(no.io.asked[0], /This also deletes every captured record, for good\. Proceed\?/)
  const yes = await cli(s, ['--purge-data', '--yes'])
  assert.equal(yes.exit, 0, yes.io.text())
  assert.deepEqual([fs.existsSync(path.join(s.home, '.asight')), kept(s)], [false, [false, false, false]], 'everything of asight\'s is gone, the captures too')
  const plain = await installedHome({ names: ['claude-code'] }); keep(plain)
  const t = fakeIo({ tty: true, answers: ['y'] })
  assert.equal((await cli(plain, [], { io: t, ask: true })).exit, 0)
  assert.deepEqual([t.asked.length, t.asked[0].trim(), kept(plain)], [1, 'Proceed? [y/N]', [true, true, true]], 'a plain uninstall asks too, without the data question, and keeps the captures')
  const terminal = await installedHome({ names: ['claude-code'] }); keep(terminal)
  const y = fakeIo({ tty: true, answers: ['y'] })
  assert.equal((await cli(terminal, ['--purge-data'], { io: y, ask: true })).exit, 0)
  assert.deepEqual([y.asked.length, fs.existsSync(path.join(terminal.home, '.asight'))], [1, false])
})

test('uninstall --purge-data after a plain uninstall still drops the captures it kept; a second uninstall of nothing says so and exits 0', async () => {
  const s = await installedHome({ names: ['claude-code'] }); keep(s)
  assert.equal((await cli(s, [])).exit, 0)
  const again = await cli(s, [])
  assert.equal(again.exit, 0)
  assert.match(again.io.stdoutText(), /Note: nothing is installed for this user/)
  assert.deepEqual(kept(s), [true, true, true])
  assert.equal((await cli(s, ['--purge-data', '--yes'])).exit, 0)
  assert.deepEqual([fs.existsSync(path.join(s.home, '.asight')), kept(s)], [false, [false, false, false]])
})

test('1.6 §1.1: the daemon is asked to exit and is waited for while it closes the connections it can see the end of; what never ends by itself is cut when it stops, and counted', async () => {
  let polls = 0
  const s = await installedHome({ names: ['claude-code'], daemon: { relayed: { closing: 2, waiting: 1, cut: 0 }, exitOnOff: false } })
  const c = fakeClock()
  const request = async (q) => {
    if (q.method === 'GET' && q.path === '/status' && s.sys.daemon.calls.some((x) => x.startsWith('POST /off'))) { polls++; return { ...(await s.sys.daemon.request(q)), relayed: { closing: polls < 3 ? 2 : 0, waiting: 1, cut: 0 } } }
    return s.sys.daemon.request(q)
  }
  const stopped = []
  const r = await s.uninstall({ yes: true, deps: { request, ...c, stopDaemon: async () => { stopped.push(polls); return { stopped: true, how: 'systemctl', pid: 4242, signals: ['systemctl-stop'], helper_pid: null } } } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.deepEqual([polls, stopped], [3, [3]], 'it looked until nothing was closing, and only then stopped the daemon')
  assert.deepEqual([r.receipt.relayed, r.receipt.daemon], [{ closing: 0, waiting: 0, cut: 1 }, { pid: 4242, state: 'stopped' }], 'the one connection that waits for itself was cut and counted')
  assert.match(formatUninstallReceipt(r.receipt, { home: s.home }), /The collector \(pid 4242\) was stopped\.\n1 connection that would not end by itself was cut\./)
  assert.doesNotMatch(formatUninstallReceipt(r.receipt, { home: s.home }), /--now/, 'uninstall has no --now: it cuts them as a matter of course')
})

test('1.6 §1.1: a connection that does not close within 30 s is cut too — the wait is bounded, and the cut is counted', async () => {
  const s = await installedHome({ names: ['claude-code'], daemon: { relayed: { closing: 2, waiting: 1, cut: 0 }, exitOnOff: false } })
  const c = fakeClock(); const t0 = c.ms()
  const request = async (q) => (q.path === '/status' && s.sys.daemon.calls.some((x) => x.startsWith('POST /off')) ? { ...(await s.sys.daemon.request(q)), relayed: { closing: 2, waiting: 1, cut: 0 } } : s.sys.daemon.request(q))
  let at = null
  const r = await s.uninstall({ yes: true, deps: { request, ...c, stopDaemon: async () => { at = c.ms() - t0; return { stopped: true, how: 'systemctl', pid: 4242, signals: ['systemctl-stop'], helper_pid: null } } } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.ok(at >= 30_000 && at < 31_000, `the daemon was stopped after the 30 s bound, not before and not much later: ${at} ms`)
  assert.deepEqual(r.receipt.relayed, { closing: 0, waiting: 0, cut: 3 })
})

test('a daemon that exits by itself while it drains is not cut: no connection was left (cut 0)', async () => {
  const s = await installedHome({ names: ['claude-code'], daemon: { relayed: { closing: 1, waiting: 0, cut: 0 } } }) // exitOnOff: the fake goes away after the /off
  const r = await s.uninstall({ yes: true, deps: { ...fakeClock() } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.deepEqual(r.receipt.relayed, { closing: 0, waiting: 0, cut: 0 })
})

test('1.6 「守护进程卡死」: a stuck daemon is stopped first, then the entries; one that cannot be stopped leaves every file of asight\'s in place — the entries are undone all the same, exit 1, the pid and kill -9 are given — and the next uninstall finishes', async () => {
  const s = await installedHome({ names: ['claude-code'] }); writeDaemonLock(s)
  const stuck = procTable(DAEMON_ROWS, { survives: { 4242: ['SIGTERM', 'SIGKILL'] } }); const c = fakeClock()
  const r = await s.uninstall({ yes: true, deps: { request: hangsOnStatus(s), alive: stuck.alive, identity: stuck.identity, kill: stuck.kill, isHelper: stuck.isHelper, ...c } })
  assert.equal(r.exit, 1)
  assert.match(r.receipt.problems.join('\n'), /pid 4242.*could not be stopped.*kill -9 4242/)
  assert.match(r.receipt.problems.join('\n'), /asight's own files were left in place: the daemon is still running/)
  assert.ok(!fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8').includes('asight'), 'the entry is out all the same')
  assert.deepEqual(['ca', 'state.json', 'install-manifest.json'].map((n) => fs.existsSync(path.join(s.dir, n))), [true, true, true], 'the CA, the state and the manifest stay: the daemon still runs')
  assert.deepEqual(flowEvents(s.dir).filter((e) => e.event === 'failure').map((e) => [e.where, e.code]), [['uninstall', 'stop-failed']])
  assert.equal(flowEvents(s.dir).at(-1).outcome, 'failed')
  const again = await s.uninstall({ yes: true, deps: { procs: async () => [] } }) // the operator stopped it by hand; nothing answers any more
  assert.equal(again.exit, 0, JSON.stringify(again.receipt.problems))
  assert.deepEqual(asightFiles(s), [])
})

test('uninstall: when the install manifest cannot be saved after the entries were undone the run is blocked, not "uninstalled" — exit 1, outcome failed, the receipt lists the files that changed, the CA, the state and the manifest stay, and the next uninstall finishes', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  const manifestFile = path.join(s.dir, 'install-manifest.json')
  const state = { broken: true }
  const full = { ...fs, renameSync: (a, b) => { if (state.broken && b === manifestFile) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); return fs.renameSync(a, b) } }
  const r = await s.uninstall({ yes: true, deps: { fs: full } })
  assert.equal(r.exit, 1)
  assert.match(r.receipt.problems[0], /undoing the entries stopped: ENOSPC/)
  assert.match(r.receipt.problems.join('\n'), /asight's own files were left in place \(the entries above are not all undone\)/)
  assert.deepEqual(r.receipt.changed.map((c) => path.relative(s.home, c.path)).sort(), ['.claude/settings.json', '.codex/.env'], 'what was undone is in the receipt, although the manifest could not say so')
  assert.ok(!fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8').includes('asight'), 'and it really was undone')
  assert.deepEqual(['ca', 'state.json', 'install-manifest.json'].map((n) => fs.existsSync(path.join(s.dir, n))), [true, true, true], 'the CA, the state and the manifest stay: the manifest on disk is not what the files now are')
  const last = flowEvents(s.dir).at(-1)
  assert.deepEqual([last.kind, last.outcome], ['result', 'failed'], 'a failed run ends with outcome failed, never uninstalled')
  assert.ok(flowEvents(s.dir).some((e) => e.event === 'failure' && e.code === 'entry-not-undone' && /ENOSPC/.test(e.reason)))
  assert.doesNotMatch(formatUninstallReceipt(r.receipt, { home: s.home }), /没有改任何用户文件/)
  state.broken = false
  const again = await s.uninstall({ yes: true, deps: { fs: full } })
  assert.equal(again.exit, 0, JSON.stringify(again.receipt.problems))
  assert.deepEqual(asightFiles(s), [], 'the next run finishes: an entry that is back as it was reads as already restored')
})

test('uninstall: the result line follows the exit code — a state.json that cannot be written, or an old capture that could not be undone, is outcome failed, not uninstalled; clean stays uninstalled', async () => {
  const stateFile = (s) => path.join(s.dir, 'state.json')
  const a = await installedHome({ names: ['claude-code'] })
  const nofull = { ...fs, renameSync: (x, y) => { if (y === stateFile(a)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return fs.renameSync(x, y) } }
  const ra = await a.uninstall({ yes: true, deps: { fs: nofull } })
  assert.equal(ra.exit, 1); assert.match(ra.receipt.problems[0], /state\.json could not be written \(EACCES/)
  const lastA = flowEvents(a.dir).at(-1)
  assert.deepEqual([lastA.kind, lastA.outcome], ['result', 'failed'])
  assert.match(lastA.reason, /uninstall did not finish: state\.json could not be written/)
  const c = await installedHome({ names: ['claude-code'] })
  assert.equal((await c.uninstall({ yes: true })).exit, 0)
  assert.equal(flowEvents(c.dir).at(-1).outcome, 'uninstalled')
})

test('uninstall: the drain is polled on the socket that answered — with XDG_RUNTIME_DIR unset the lock names it; the daemon is asked on it until nothing is closing, and what never ends is counted as cut', async () => {
  const s = await installedHome({ names: ['claude-code'], daemon: { relayed: { closing: 2, waiting: 1, cut: 0 }, exitOnOff: false } })
  writeDaemonLock(s) // names the socket (SOCK) and a live daemon
  const up = procTable(DAEMON_ROWS); const c = fakeClock()
  const sockets = []; let polls = 0
  const request = async (q) => {
    sockets.push(q.socketPath)
    if (!q.socketPath) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:80'), { code: 'ECONNREFUSED' }) // what node does with no socket path: an HTTP request to localhost
    if (q.method === 'GET' && q.path === '/status' && s.sys.daemon.calls.some((x) => x.startsWith('POST /off'))) { polls++; return { ...(await s.sys.daemon.request(q)), relayed: { closing: polls < 3 ? 2 : 0, waiting: 1, cut: 0 } } }
    return s.sys.daemon.request(q)
  }
  const stoppedAt = []
  const r = await s.uninstall({ yes: true, deps: { socketPath: null, request, alive: up.alive, identity: up.identity, isHelper: up.isHelper, ...c, stopDaemon: async () => { stoppedAt.push(polls); return { stopped: true, how: 'systemctl', pid: 4242, signals: ['systemctl-stop'], helper_pid: null } } } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.ok(sockets.length > 0 && sockets.every((x) => x === '/x/collector.sock'), `every question went to the socket the lock names: ${JSON.stringify([...new Set(sockets)])}`)
  assert.deepEqual([polls, stoppedAt], [3, [3]], 'it polled until nothing was closing, then stopped the daemon')
  assert.deepEqual(r.receipt.relayed, { closing: 0, waiting: 0, cut: 1 }, 'the one connection that waits for itself was cut and counted')
})

test('1.6 §1.5: a daemon that does not confirm the routing off leaves every entry and every file as it is, exit 1 (the same rule as off)', async () => {
  const s = await installedHome({ names: ['claude-code'], daemon: { onOff: async () => ({ desired: 'off', actual: 'on', confirmed: false, relayed: { closing: 0, waiting: 0, cut: 0 }, pid: 4242, unwatched: [], agents: [], helper: { ok: true } }) } })
  const before = s.userFiles()
  const r = await s.uninstall({ yes: true })
  assert.equal(r.exit, 1)
  assert.match(r.receipt.problems[0], /did not confirm/)
  assert.match(r.receipt.problems[0], /To go on, stop the daemon \(systemctl --user stop asight-collector\.service\).*then run the command again/, 'semantics 5: an uninstall that stops here says how to get past it')
  assert.deepEqual([s.userFiles(), asightFiles(s).includes('install-manifest.json')], [before, true])
  assert.deepEqual(flowEvents(s.dir).filter((e) => e.event === 'failure').map((e) => e.code), ['state-mismatch'])
  assert.deepEqual([flowEvents(s.dir).at(-1).kind, flowEvents(s.dir).at(-1).outcome], ['result', 'failed'])
})

test('semantics 4: an uninstall over a killed daemon that systemd is about to restart stops the unit once (stop, reset-failed) before the unit file goes — exit 0, no daemon, and nothing is stopped twice', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  s.sys.daemon.state.up = false
  writeDaemonLock(s)
  let unit = 'activating'
  const run = (file, args, o) => {
    const cmd = [file, ...args].join(' ')
    if (/ is-active /.test(cmd)) { s.sys.exec.calls.push(cmd); return { status: unit === 'inactive' ? 3 : 0, stdout: `${unit}\n`, stderr: '' } }
    if (/ stop /.test(cmd)) unit = 'inactive'
    return s.sys.exec.run(file, args, o)
  }
  const from = s.sys.exec.calls.length
  const r = await s.uninstall({ yes: true, deps: { alive: () => false, exec: run } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  const stops = s.sys.exec.calls.slice(from).filter((c) => / stop /.test(c))
  assert.deepEqual(stops, ['systemctl --user stop asight-collector.service'], 'the unit is stopped once, by the routing step, and not again by the daemon step')
  assert.deepEqual(r.receipt.daemon, { pid: null, state: 'none' })
  assert.equal(fs.existsSync(path.join(s.home, '.config', 'systemd', 'user', 'asight-collector.service')), false, 'and the unit file is gone')
})

test('R12: an uninstall that cannot get the op lock has written desired off first and says which command holds it; nothing else is touched, exit 1', async () => {
  const s = await installedHome({ names: ['claude-code'] }); const before = snapshot(s.home)
  fs.writeFileSync(path.join(s.dir, 'op.lock'), JSON.stringify({ pid: 5555, start_time: '9', boot_id: 'boot-1' }))
  const r = await s.uninstall({ yes: true, deps: { lockWaitMs: 40, alive: (pid) => pid === 5555, identity: (pid) => (pid === 5555 ? { start_time: '9', boot_id: 'boot-1' } : { start_time: null, boot_id: null }) } })
  assert.equal(r.exit, 1); assert.match(r.receipt.problems[0], /another asight command \(pid 5555\) holds .*already off for every harness/)
  assert.equal(s.state().harnesses['claude-code'].desired, 'off', 'desired off was written before the wait')
  assert.deepEqual(s.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), [])
  const after = snapshot(s.home)
  assert.deepEqual(Object.keys(after).filter((k) => after[k] !== before[k] && !k.includes('flows') && !k.endsWith('state.json') && !k.endsWith('op.lock')), [], 'every other file is as it was')
  assert.equal(flowEvents(s.dir).at(-1).outcome, 'failed')
})

test('V24 (uninstall): with the install manifest gone and no terminal, uninstall takes the routing off, stops the daemon, undoes nothing, removes nothing of asight\'s and exits 1; with --yes it undoes the entries by their marks and removes asight\'s own files by name — the CA, the unit, the state, every backup', async () => {
  const codexOriginal = 'SSL_CERT_FILE=/corp/ca.pem\nOPENAI_API_KEY=sk-test\n'
  const s = await installedHome({ names: ['claude-code', 'codex'], seed: (home, sh) => {
    fs.writeFileSync(path.join(home, '.codex', '.env'), codexOriginal)
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `{\n  "env": { "NODE_EXTRA_CA_CERTS": "${sh.corp}" }\n}\n`)
  } })
  const settingsOriginal = `{\n  "env": { "NODE_EXTRA_CA_CERTS": "${s.sh.corp}" }\n}\n`
  fs.rmSync(path.join(s.dir, 'install-manifest.json'))
  const installed = s.userFiles()
  // §3.6: no terminal and no --yes is the plan and nothing else now — not even the routing is touched, and the exit is 2 (§1.4)
  const first = await s.uninstall({ yes: false, interactive: false })
  assert.deepEqual([first.exit, first.receipt.needs_yes], [2, true])
  assert.deepEqual(s.userFiles(), installed, 'nothing is changed without a yes')
  assert.deepEqual(['ca', 'state.json'].map((n) => fs.existsSync(path.join(s.dir, n))), [true, true], 'the CA and the state are still there')
  assert.deepEqual([first.receipt.daemon ? first.receipt.daemon.state : 'none', s.sys.exec.calls.filter((c) => /stop /.test(c)).length], ['none', 0], 'the daemon was not stopped either: nothing was done')
  const second = await s.uninstall({ yes: true })
  assert.equal(second.exit, 0, JSON.stringify(second.receipt.problems))
  assert.match(second.receipt.notes.join('\n'), /found by asight's mark; there is no manifest to say what it was before/, 'the entries went by asight\'s own marks')
  assert.deepEqual([second.receipt.routing.confirmed, second.receipt.daemon.state], [true, 'stopped'], 'the routing is off and the daemon stopped')
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', '.env'), 'utf8'), codexOriginal, 'the block is out and the commented user line is back')
  assert.equal(fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8'), settingsOriginal, 'the JSON value is back, taken from the backup')
  assert.deepEqual(asightFiles(s), [], 'and asight\'s own files are gone by name')
  assert.ok(!fs.existsSync(path.join(s.home, '.asight', 'backup')) && !fs.existsSync(path.join(s.home, '.config', 'systemd', 'user', 'asight-collector.service')), 'with the backups and the unit file (no manifest says which directories asight made, so empty ones stay)')
})

test('R3: a manifest this build does not read leaves every entry and every file alone but still takes the routing off, stops the daemon and exits 1; a manifest that cannot be parsed falls back to the marks', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  const m = JSON.parse(fs.readFileSync(path.join(s.dir, 'install-manifest.json'), 'utf8')); m.version = 99
  fs.writeFileSync(path.join(s.dir, 'install-manifest.json'), JSON.stringify(m))
  const before = s.userFiles()
  const r = await s.uninstall({ yes: true })
  assert.equal(r.exit, 1)
  assert.match(r.receipt.problems.join('\n'), /manifest is version 99, which this build does not read; no entry was touched/)
  assert.deepEqual([s.userFiles(), asightFiles(s).includes('install-manifest.json'), r.receipt.daemon.state], [before, true, 'stopped'])
  const t = await installedHome({ names: ['claude-code'] })
  fs.writeFileSync(path.join(t.dir, 'install-manifest.json'), '{ not json')
  const u = await t.uninstall({ yes: true })
  assert.equal(u.exit, 0, JSON.stringify(u.receipt.problems))
  assert.match(u.receipt.notes.join('\n'), /the install manifest cannot be read .*asight's own marks are used instead/)
  assert.ok(!fs.readFileSync(path.join(t.home, '.claude', 'settings.json'), 'utf8').includes('asight'), 'the entry went by its mark')
})

test('V8 (uninstall): every backup goes, the ones of files the user edited after asight too — each named in the receipt as not byte for byte; the directory is gone; a backup that cannot be removed is said', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  const codexEnv = path.join(s.home, '.codex', '.env')
  fs.appendFileSync(codexEnv, 'EXTRA=1\n') // after install: undone but not identical
  const backup = s.manifest().entries.find((e) => e.path === codexEnv).backup
  assert.ok(fs.existsSync(backup))
  const off = await s.off() // the entry is install's: off leaves it and its backup (D55①)
  assert.ok(fs.existsSync(backup) && !(off.receipt.kept_backups || []).length, 'off left the backup of the edited file as it was')
  const r = await s.uninstall({ yes: true })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.ok(!fs.existsSync(path.join(s.home, '.asight', 'backup')), '~/.asight/backup/ is gone')
  assert.ok(r.receipt.dropped_backups.includes(backup))
  assert.deepEqual(r.receipt.non_identical.map((n) => [n.path, n.backup]), [[codexEnv, backup]], 'the receipt names the one that is not byte for byte')
  assert.match(formatUninstallReceipt(r.receipt, { home: s.home }), /Not byte for byte what it was[\s\S]*~\/\.codex\/\.env \(backup[\s\S]*~\/\.asight\/backup\//)
  assert.equal(fs.readFileSync(codexEnv, 'utf8').includes('EXTRA=1'), true, 'and the user\'s own edit is untouched')
  // a backup that cannot be removed is a note, never silence, and its directory stays
  const t = await installedHome({ names: ['claude-code'] })
  const bk = t.manifest().entries.find((e) => e.backup).backup
  const stubborn = { ...fs, unlinkSync: (f) => { if (f === bk) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return fs.unlinkSync(f) } }
  const u = await t.uninstall({ yes: true, deps: { fs: stubborn } })
  assert.ok(u.receipt.notes.some((n) => n.includes(bk) && /could not be removed \(EPERM\); remove it by hand/.test(n)), JSON.stringify(u.receipt.notes))
  assert.ok(fs.existsSync(bk), 'it is still there')
})

test('V27 (uninstall): over a stuck daemon, an uninstall signals the daemon and its helper only, never restarts or starts anything, and lists — never stops — the agents and the foreground asight processes', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] }); writeDaemonLock(s)
  const t = procTable({ ...DAEMON_ROWS, 5000: { start_time: '5', boot_id: 'boot-1' } }, { survives: { 4242: ['SIGTERM'] } })
  const agents = [
    { pid: 5000, ppid: 1, uid: 1000, startedAt: Date.now() + 5000, exe: '/home/u/.local/share/claude/versions/2.1.289', argv: ['claude'], env: () => new Map() },
    { pid: 7002, ppid: 1, uid: 1000, startedAt: 1, exe: '/usr/bin/node', argv: ['node', '/repo/bin/asight.mjs', 'capture'], env: () => new Map() },
  ]
  const calls = s.sys.exec.calls.length
  const r = await s.uninstall({ yes: true, deps: { procs: async () => agents, request: hangsOnStatus(s), alive: (pid) => t.alive(pid) || agents.some((a) => a.pid === pid), identity: t.identity, kill: t.kill, isHelper: t.isHelper, ...fakeClock() } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.ok(t.sent.every(([pid]) => pid === 4242 || pid === 4243), `signals went to the daemon and its helper only: ${JSON.stringify(t.sent)}`)
  assert.deepEqual(s.sys.exec.calls.slice(calls).filter((c) => /restart|start|enable|kill/.test(c)), [], 'no restart, no start')
  assert.deepEqual(r.receipt.still_trusting.map((p) => p.pid), [5000], 'the agent that may still trust asight is listed')
  assert.deepEqual(r.receipt.restart, [], 'and uninstall never lists anything to restart as a to-do of its own')
  assert.deepEqual(r.receipt.user_processes.map((p) => p.pid), [7002], 'what the user started themselves is listed, never killed')
})

test('D38: every line uninstall writes is in the closed sets, one run has one `run`, and it ends with a result line', async () => {
  const { checkRecord } = await import('../../src/health/codes.mjs')
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  fs.appendFileSync(path.join(s.home, '.codex', '.env'), 'EXTRA=1\n')
  const r = await s.uninstall({ yes: true, deps: { procs: async () => [{ pid: 5001, ppid: 1, uid: 1000, startedAt: Date.now() + 5000, exe: '/home/u/.local/bin/codex', argv: ['codex'], env: () => new Map() }] } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  const mine = flowEvents(s.dir).filter((e) => e.where === 'uninstall')
  assert.ok(mine.length >= 4)
  for (const e of flowEvents(s.dir)) assert.deepEqual(checkRecord(e), [], JSON.stringify(e))
  assert.equal(new Set(mine.map((e) => e.run)).size, 1)
  assert.ok(mine.some((e) => e.kind === 'desired-off') && mine.some((e) => e.kind === 'autostart') && mine.some((e) => e.code === 'reverted-not-identical') && mine.some((e) => e.code === 'still-trusting'))
  assert.ok(!mine.some((e) => e.code === 'backup-kept'), 'a backup that is dropped is not "kept"')
  const last = mine.at(-1)
  assert.deepEqual([last.event, last.kind, last.outcome], ['uninstall-note', 'result', 'uninstalled'])
})

test('uninstall: the arguments — a harness name, an unknown option, root and a platform without the new collector (freebsd now) hands over to the hook (R4, R7, 1.6 §4); win32 and darwin (the flips, plan 9(b) / 4.9 §4) run the NEW uninstall instead', async () => {
  const s = await installedHome({ names: ['claude-code'] }); const snap = snapshot(s.home)
  const name = await cli(s, ['claude-code'])
  assert.deepEqual([name.exit, snapshot(s.home)], [2, snap])
  assert.match(name.io.stderrText(), /takes no harness name \(claude-code\): uninstall removes asight for every harness/)
  const flag = await cli(s, ['--now'])
  assert.deepEqual([flag.exit, snapshot(s.home)], [2, snap]); assert.match(flag.io.stderrText(), /unknown option --now/)
  const root = await cli(s, [], { deps: { getuid: () => 0 } })
  assert.deepEqual([root.exit, snapshot(s.home)], [2, snap], '§1.5: root is refused before anything is read, exit 2')
  assert.match(root.io.stderrText(), /^asight uninstall: run this as your own user, not as root\.$/m)
  // D39⑥ executed 2026-10-11: the old capture's own uninstall went with it — every platform (win32 and darwin included, and a
  // platform with no collector at all) runs the NEW uninstall; there is no legacy hook any more.
  for (const platform of ['win32', 'darwin', 'freebsd']) {
    const w = await installedHome({ names: ['claude-code'] })
    const r = await cli(w, ['--yes'], { platform })
    assert.equal(r.exit, 0, `${platform}: ${r.io.text()}`)
    assert.match(r.io.stdoutText(), /^Uninstalled\. asight is no longer on your agents' path/, `${platform}: the NEW uninstall ran`)
    assert.equal(fs.existsSync(path.join(w.dir, 'install-manifest.json')), false, `${platform}: and finished: asight\'s own files are gone`)
  }
})

test('formatUninstallReceipt: not done says so and what to do; the entries left and the problems are named; a kept bundle is said', () => {
  const home = '/home/u'
  const r = {
    schema: 2, command: 'uninstall', ok: false, all: true, changed: [], created: [], removed: [], skipped: [], restart: [], relayed: { closing: 0, waiting: 0, cut: 0 }, undo: ['asight on'], log: '/home/u/.asight/collector/flows',
    left: [{ path: '/home/u/.codex/.env', result: 'left-unparsable', reason: 'no longer valid' }], problems: ['1 item(s) could not be undone; the install manifest is kept'], notes: [], kept: [{ what: 'your captured records', path: '/home/u/.asight/raw', bytes: 2048 }], purge_data: false,
    routing: { confirmed: true, state: 'none', how: 'no-daemon' }, daemon: { pid: null, state: 'none' }, autostart: { disabled: true }, dropped_backups: [], non_identical: [],
    kept_bundles: [{ path: '/home/u/.asight/collector/ca/combined-codex.pem', pids: [5], holds_ca: false }],
  }
  const text = formatUninstallReceipt(r, { home })
  assert.match(text, /^asight uninstall did not finish\. What is left is below\./)
  assert.match(text, /Left in place: ~\/\.codex\/\.env: no longer valid/)
  assert.match(text, /~\/\.asight\/collector\/ca\/combined-codex\.pem \(asight's certificate[\s\S]*taken out\):[\s\S]*pid 5 may have loaded it/)
  assert.match(text, /Problem: 1 item\(s\) could not be undone/)
  assert.match(text, /Fix what is above, then run: asight uninstall$/)
  assert.doesNotMatch(text, /Install it again/)
  assertEnglish(text, 'the receipt of an uninstall that did not finish')
  const purged = formatUninstallReceipt({ ...r, ok: true, left: [], problems: [], kept_bundles: [], purge_data: true, kept: [] }, { home })
  assert.match(purged, /^Uninstalled\./); assert.match(purged, /your captured records \(--purge-data\)/); assert.doesNotMatch(purged, /Kept/)
  assertEnglish(purged, 'the receipt of uninstall --purge-data')
})

test('semantics 2: an install manifest of the wrong shape is treated as unreadable by uninstall too — the entries go by their marks (after a yes), a receipt is printed, and the way on is named when asight on then refuses', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  s.sys.daemon.state.up = false
  const file = path.join(s.dir, 'install-manifest.json')
  fs.writeFileSync(file, '{"version":3}')
  const before = s.userFiles()
  const no = await s.uninstall({}) // not a terminal, no yes
  assert.deepEqual([no.exit, no.receipt.needs_yes], [2, true], '§3.6: the plan only, exit 2')
  assert.deepEqual(s.userFiles(), before, 'no file is touched without a yes')
  const r = await s.uninstall({ yes: true })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.match(r.receipt.notes.join('\n'), /the install manifest cannot be read .*not an install manifest this build can use/)
  assert.ok(!fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8').includes('asight') && !fs.readFileSync(path.join(s.home, '.codex', '.env'), 'utf8').includes('asight collector'), 'the entries went by their marks')
  // `on` does not write over a manifest it cannot read, and says what to do
  const t = await installedHome({ names: ['claude-code'] })
  fs.writeFileSync(path.join(t.dir, 'install-manifest.json'), '{"version":3,"entries":null,"files":[]}')
  const snap = t.userFiles()
  await assert.rejects(() => t.on(), /the install manifest cannot be read .*asight on does not write over it.*asight off.*mv '.*install-manifest\.json'/)
  assert.deepEqual(t.userFiles(), snap, 'and wrote nothing')
})

// audit rule-b 8 (4.5 零残留): `~/.asight/netenv.json` — what status / doctor / on last read of the VPN software, for the board — is asight's own file and was never removed (mac and Linux);
// with no daemon the receipt said 「守护进程(pid null)已停掉」 about a daemon that was not there.
test('uninstall removes ~/.asight/netenv.json with the rest of asight\'s own files — the plan lists it, nothing but the kept captures is left in ~/.asight — and with no daemon the receipt does not say one was stopped', async () => {
  const s = await installedHome({ names: ['claude-code'] }); keep(s)
  s.sys.daemon.state.up = false
  const nf = netenvFile(s.home)
  writeNetenv(s.home, { adopted: {} }) // the daemon's copy for the board (§3.5: `status` writes nothing of its own)
  assert.ok(fs.existsSync(nf), 'the board\'s copy is on disk')
  const dry = await cli(s, ['--dry-run', '--json'])
  assert.ok(dry.io.json().removed.includes(nf), 'the plan lists it')
  assert.ok(fs.existsSync(nf), 'and a dry run removed nothing')
  const { exit, io } = await cli(s, ['--json'])
  assert.equal(exit, 0, io.text())
  const r = io.json()
  assert.ok(r.removed.includes(nf) && !fs.existsSync(nf), 'removed, and in the receipt')
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [])
  assert.deepEqual(walk(path.join(s.home, '.asight')).map((f) => path.relative(path.join(s.home, '.asight'), f)).filter((f) => !/^collector[\\/](capture-|audit|replays|flows)/.test(f)), [], 'nothing of asight\'s own is left: only the captures and the records')
  assert.deepEqual([r.daemon.state, r.daemon.pid], ['none', null], 'there was no daemon: none is the state, not "stopped" with no pid')
  assert.ok(!/pid null/.test(formatUninstallReceipt(r, { home: s.home })) && !/pid null/.test(io.text()), 'and the text does not say it')
  assert.match(formatUninstallReceipt({ ...r, daemon: { pid: null, state: 'stopped' } }, { home: s.home }), /^The collector was stopped\.$/m, 'a stopped daemon whose pid is not known is said without one, never "(pid null)"')
  // a daemon that was running is still said to be stopped, with its pid
  const t = await installedHome({ names: ['claude-code'] })
  const run = await cli(t, ['--json'])
  assert.deepEqual([run.io.json().daemon.state, Number.isInteger(run.io.json().daemon.pid)], ['stopped', true])
})

// D60 · 附录 C.2 `kept`: the records are segments under ~/.asight/raw and the index built from them under ~/.asight/index — a plain uninstall
// keeps every byte of them and says where they are, `--purge-data` leaves neither. (Windows test machine 2026-10-18 P11 / macOS test machine: the purge deleted
// collector/ only, so every record stayed on disk while the receipt said they were gone.)
test('D60: a plain uninstall keeps every byte under raw/ and names it with its size; --purge-data leaves no raw/ and no index/', async () => {
  const plain = await installedHome({ names: ['claude-code'] }); seedRecords(plain)
  const r = await cli(plain, ['--json'])
  assert.equal(r.exit, 0, r.io.text())
  assert.deepEqual(records(plain), SEGMENTS, 'every record and the index are byte for byte what they were')
  const raw = path.join(path.dirname(plain.dir), 'raw'), bytes = Object.entries(SEGMENTS).filter(([k]) => k.startsWith('raw/')).reduce((n, [, v]) => n + v.length, 0)
  assert.deepEqual(r.io.json().kept.find((k) => k.path === raw), { what: 'your captured records', path: raw, bytes }, JSON.stringify(r.io.json().kept))
  const purged = await installedHome({ names: ['claude-code'] }); seedRecords(purged)
  const p = await cli(purged, ['--purge-data', '--json'])
  assert.equal(p.exit, 0, p.io.text())
  assert.deepEqual(records(purged), Object.fromEntries(Object.keys(SEGMENTS).map((k) => [k, null])), 'nothing of the records or the index is left')
  assert.deepEqual(p.io.json().kept, [], 'and the receipt claims nothing is kept')
})
