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

const BASE = new Date('2026-10-07T00:00:00Z')
/** `asight uninstall <argv>` over a sandbox: the exit code, and what it printed. */
async function cli(s, argv, { io = fakeIo(), deps = {}, platform = 'linux' } = {}) {
  const exit = await runUninstallCli(argv, { io, env: s.sh.env, home: s.home, platform, deps: s.offDeps({ getuid: () => 1000, ...deps }) })
  return { exit, io }
}
const keep = (s) => { for (const k of ['capture-2026-10-06.ndjson', 'audit/a.ndjson', 'replays/r.ndjson']) { fs.mkdirSync(path.dirname(path.join(s.dir, k)), { recursive: true }); fs.writeFileSync(path.join(s.dir, k), '{"keep":true}\n') } }
const kept = (s) => ['capture-2026-10-06.ndjson', 'audit/a.ndjson', 'replays/r.ndjson'].map((k) => fs.existsSync(path.join(s.dir, k)))
const asightFiles = (s) => ['ca', 'run', 'state.json', 'install-manifest.json', 'op.lock', 'lock'].filter((n) => fs.existsSync(path.join(s.dir, n)))

test('uninstall: every entry is back as it was, asight\'s own files are gone, the captures and the records stay, and the receipt says so in the past tense (exit 0, --json validates)', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] }); keep(s)
  const entries = s.manifest().entries
  const before = s.userFiles()
  const { exit, io } = await cli(s, ['--json'])
  assert.equal(exit, 0, io.text())
  const r = io.json()
  assert.deepEqual(validateReceipt(r), [])
  assert.deepEqual([r.command, r.ok, r.all, r.kept_captures, r.purge_data, r.routing.confirmed], ['uninstall', true, true, true, false, true])
  assert.deepEqual([r.daemon.state, r.autostart.disabled], ['stopped', true])
  for (const e of entries) assert.equal(fs.existsSync(e.path) && fs.readFileSync(e.path).length > 0 ? true : !e.existed_before, true)
  assert.notDeepEqual(s.userFiles(), before, 'on had changed them')
  assert.deepEqual(asightFiles(s), [])
  assert.deepEqual(kept(s), [true, true, true])
  assert.ok(r.changed.length > 0 && r.entries.length === entries.length, 'what was taken out, row by row')
  assert.ok(r.removed.includes(path.join(s.dir, 'install-manifest.json')), 'the manifest is in the list of what asight removed')
  const text = await cli(await installedHome({ names: ['claude-code'] }), [])
  assert.equal(text.exit, 0)
  assert.match(text.io.stdoutText(), /^asight 已卸载\(本用户\)。/)
  assert.match(text.io.stdoutText(), /采集数据保留在 .*collector\/ \(flows\/、audit\/、capture-\*\.ndjson\);--purge-data 才删。/)
  assert.match(text.io.stdoutText(), /再装  asight on/)
})

test('uninstall --dry-run writes nothing and asks the daemon nothing: the same receipt in the future tense, exit 0 (R6)', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  const snap = snapshot(s.home), asked = s.sys.daemon.calls.length, ran = s.sys.exec.calls.length
  const { exit, io } = await cli(s, ['--dry-run'])
  assert.equal(exit, 0)
  assert.deepEqual([snapshot(s.home), s.sys.daemon.calls.length, s.sys.exec.calls.length], [snap, asked, ran])
  assert.match(io.stdoutText(), /^asight 将卸载\(本用户\)/)
  assert.match(io.stdoutText(), /将撤掉:[\s\S]*改前副本/)
  assert.match(io.stdoutText(), /去掉 --dry-run 才会真的做。/)
  const json = (await cli(s, ['--dry-run', '--json'])).io.json()
  assert.deepEqual([json.dry_run, json.ok, validateReceipt(json)], [true, true, []])
  assert.ok(json.removed.includes(standalonePath(s.home)) && json.removed.includes(path.join(s.dir, 'install-manifest.json')))
})

test('R6: --purge-data deletes what nothing brings back, so a yes is asked for — no terminal and no --yes prints the plan and exits 2 with nothing done; a terminal asks once (n: nothing, exit 1); --yes goes; a plain uninstall never asks', async () => {
  const s = await installedHome({ names: ['claude-code'] }); keep(s)
  const snap = snapshot(s.home), ran = s.sys.exec.calls.length
  const noTty = await cli(s, ['--purge-data'])
  assert.equal(noTty.exit, 2)
  assert.deepEqual([snapshot(s.home), s.sys.exec.calls.length], [snap, ran], 'nothing was done')
  assert.match(noTty.io.stdoutText(), /^asight 将卸载\(本用户\)/, 'the plan is printed')
  assert.match(noTty.io.stdoutText(), /采集数据\(capture-\*\.ndjson、flows\/、audit\/、replays\/\)将删/)
  assert.match(noTty.io.stderrText(), /不在终端里,没有 --yes:只打印了计划,什么都没动/)
  const json = await cli(s, ['--purge-data', '--json'])
  assert.deepEqual([json.exit, json.io.json().needs_yes, json.io.json().ok], [2, true, false])
  const no = await cli(s, ['--purge-data'], { io: fakeIo({ tty: true, answers: ['n'] }) })
  assert.deepEqual([no.exit, no.io.asked.length, snapshot(s.home)], [1, 1, snap])
  assert.match(no.io.asked[0], /--purge-data 会删掉全部采集数据/)
  const yes = await cli(s, ['--purge-data', '--yes'])
  assert.equal(yes.exit, 0, yes.io.text())
  assert.deepEqual([fs.existsSync(path.join(s.home, '.asight')), kept(s)], [false, [false, false, false]], 'everything of asight\'s is gone, the captures too')
  const plain = await installedHome({ names: ['claude-code'] }); keep(plain)
  const t = fakeIo({ tty: true })
  assert.equal((await cli(plain, [], { io: t })).exit, 0)
  assert.deepEqual([t.asked.length, kept(plain)], [0, [true, true, true]], 'a plain uninstall asks nothing and keeps the captures')
  const terminal = await installedHome({ names: ['claude-code'] }); keep(terminal)
  const y = fakeIo({ tty: true, answers: ['y'] })
  assert.equal((await cli(terminal, ['--purge-data'], { io: y })).exit, 0)
  assert.deepEqual([y.asked.length, fs.existsSync(path.join(terminal.home, '.asight'))], [1, false])
})

test('uninstall --purge-data after a plain uninstall still drops the captures it kept; a second uninstall of nothing says so and exits 0', async () => {
  const s = await installedHome({ names: ['claude-code'] }); keep(s)
  assert.equal((await cli(s, [])).exit, 0)
  const again = await cli(s, [])
  assert.equal(again.exit, 0)
  assert.match(again.io.stdoutText(), /说明: nothing is installed for this user/)
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
  assert.match(formatUninstallReceipt(r.receipt, { home: s.home }), /守护进程\(pid 4242\)已停掉: 已切断 1 条连接/)
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

test('1.6 §1.5: a daemon that does not confirm the routing off leaves every entry and every file as it is, exit 1 (the same rule as off)', async () => {
  const s = await installedHome({ names: ['claude-code'], daemon: { onOff: async () => ({ desired: 'off', actual: 'on', confirmed: false, relayed: { closing: 0, waiting: 0, cut: 0 }, pid: 4242, unwatched: [], agents: [], helper: { ok: true } }) } })
  const before = s.userFiles()
  const r = await s.uninstall({ yes: true })
  assert.equal(r.exit, 1)
  assert.match(r.receipt.problems[0], /did not confirm/)
  assert.deepEqual([s.userFiles(), asightFiles(s).includes('install-manifest.json')], [before, true])
  assert.deepEqual(flowEvents(s.dir).filter((e) => e.event === 'failure').map((e) => e.code), ['state-mismatch'])
  assert.deepEqual([flowEvents(s.dir).at(-1).kind, flowEvents(s.dir).at(-1).outcome], ['result', 'failed'])
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
  const first = await s.uninstall({ yes: false, interactive: false })
  assert.equal(first.exit, 1)
  assert.deepEqual(s.userFiles(), installed, 'nothing is changed without a yes')
  assert.deepEqual(first.receipt.pending.map((p) => path.relative(s.home, p.path)).sort(), ['.claude/settings.json', '.codex/.env'])
  assert.match(first.receipt.problems.join('\n'), /manifest is missing.*asight off --yes/)
  assert.match(first.receipt.problems.join('\n'), /asight's own files were left in place \(the entries above are not all undone\)/)
  assert.deepEqual(['ca', 'state.json'].map((n) => fs.existsSync(path.join(s.dir, n))), [true, true], 'the CA and the state are still there')
  assert.deepEqual([first.receipt.routing.confirmed, first.receipt.daemon.state, s.sys.exec.calls.filter((c) => /stop /.test(c)).length], [true, 'stopped', 1], 'the routing is off and the daemon stopped: none of it needs the manifest')
  assert.deepEqual([flowEvents(s.dir).at(-1).kind, flowEvents(s.dir).at(-1).outcome], ['result', 'failed'])
  const second = await s.uninstall({ yes: true })
  assert.equal(second.exit, 0, JSON.stringify(second.receipt.problems))
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
  const off = await s.off() // `off` keeps it and lists it
  assert.ok(off.receipt.kept_backups.some((k) => k.backup === backup), 'off kept the backup of the edited file')
  const r = await s.uninstall({ yes: true })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.ok(!fs.existsSync(path.join(s.home, '.asight', 'backup')), '~/.asight/backup/ is gone')
  assert.ok(r.receipt.dropped_backups.includes(backup))
  assert.deepEqual(r.receipt.non_identical.map((n) => [n.path, n.backup]), [[codexEnv, backup]], 'the receipt names the one that is not byte for byte')
  assert.match(formatUninstallReceipt(r.receipt, { home: s.home }), /不逐字节相同的[^\n]*~\/\.codex\/\.env\(备份 ~\/\.asight\/backup\//)
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

test('uninstall: the arguments — a harness name, an unknown option, root and a platform without the new collector (R4, R7, 1.6 §4)', async () => {
  const s = await installedHome({ names: ['claude-code'] }); const snap = snapshot(s.home)
  const name = await cli(s, ['claude-code'])
  assert.deepEqual([name.exit, snapshot(s.home)], [2, snap])
  assert.match(name.io.stderrText(), /takes no harness name \(claude-code\): uninstall removes asight for every harness/)
  const flag = await cli(s, ['--now'])
  assert.deepEqual([flag.exit, snapshot(s.home)], [2, snap]); assert.match(flag.io.stderrText(), /unknown option --now/)
  const root = await cli(s, [], { deps: { getuid: () => 0 } })
  assert.deepEqual([root.exit, snapshot(s.home)], [1, snap]); assert.match(root.io.stderrText(), /不要用 root \/ sudo/)
  const hooked = []
  const mac = await cli(s, ['--yes'], { platform: 'darwin', deps: { legacyUninstall: async (argv) => { hooked.push(argv); return 4 } } })
  assert.deepEqual([mac.exit, hooked, snapshot(s.home)], [4, [['--yes']], snap])
  const none = await cli(s, [], { platform: 'darwin' })
  assert.deepEqual([none.exit, snapshot(s.home)], [1, snap]); assert.match(none.io.stderrText(), /本平台\(darwin\)没有新采集器/)
})

test('formatUninstallReceipt: not done says so and what to do; the entries left and the problems are named; a kept bundle is said', () => {
  const home = '/home/u'
  const r = {
    schema: 1, command: 'uninstall', ok: false, all: true, changed: [], created: [], removed: [], skipped: [], restart: [], relayed: { closing: 0, waiting: 0, cut: 0 }, undo: ['asight on'], log: '/home/u/.asight/collector/flows',
    left: [{ path: '/home/u/.codex/.env', result: 'left-unparsable', reason: 'no longer valid' }], problems: ['1 item(s) could not be undone; the install manifest is kept'], notes: [], kept_captures: true, purge_data: false,
    routing: { confirmed: true, state: 'none', how: 'no-daemon' }, daemon: { pid: null, state: 'none' }, autostart: { disabled: true }, dropped_backups: [], non_identical: [],
    kept_bundles: [{ path: '/home/u/.asight/collector/ca/combined-codex.pem', pids: [5], holds_ca: false }],
  }
  const text = formatUninstallReceipt(r, { home })
  assert.match(text, /^asight 没有卸完/)
  assert.match(text, /没撤掉: ~\/\.codex\/\.env\(no longer valid\)/)
  assert.match(text, /保留了 ~\/\.asight\/collector\/ca\/combined-codex\.pem\(已去掉 asight CA\):pid 5 可能加载过它/)
  assert.match(text, /问题: 1 item\(s\) could not be undone/)
  assert.match(text, /修好上面的问题后再跑  asight uninstall$/)
  assert.doesNotMatch(text, /再装  asight on/)
  const purged = formatUninstallReceipt({ ...r, ok: true, left: [], problems: [], kept_bundles: [], purge_data: true, kept_captures: false }, { home })
  assert.match(purged, /^asight 已卸载/); assert.match(purged, /采集数据已删\(--purge-data\)。/); assert.doesNotMatch(purged, /保留在/)
})
