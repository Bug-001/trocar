// test/off/win32.test.mjs — the Windows seams under `off` (plan Task 9(b), W54; RFC 4.8 §4.2, §7; 1.6 §1.4 第 2 / 5 步): the process table
// and the lock identity from one fixed powershell question each, and the stop order — the supervisor parent goes FIRST (a daemon killed
// first would be re-spawned by it), then the daemon, both through taskkill. Every OS tool is a recording runner answering a fixed shape;
// no real powershell or taskkill ever runs (0.1 §3). The control-pipe seam has its own file, test/off/win32-control.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import path from 'node:path'
import { listProcs, identityFor, procIdentity } from '../../src/off/proc.mjs'
import { daemonState, stopDaemon, readDaemonLock, supervisorHolderAlive, SUPERVISOR_LOCK, SUPERVISOR_START_TOLERANCE_MS } from '../../src/off/daemon-stop.mjs'
import { SUPERVISOR_LOCK as ARCH_SUPERVISOR_LOCK, LOCK_START_TOLERANCE_MS as ARCH_LOCK_START_TOLERANCE_MS, lockHolderAlive } from '../../src/collector/arch/win32/autostart.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

// ── the fake powershell: one answer per fixed question, and every call recorded ───────────────────────────────────────────────
const CREATED = 1_740_000_123_456 // the daemon's creation time, Unix ms
const BOOTED = 1_740_000_000_000 // the machine's boot time, Unix ms (4.8 §7: boot_id is the system start time)
/** A recording runner: `table` maps pid → creation ms (its processes); a pid not in it answers 'gone'; `fail` substrings make a question die. */
function powershell({ table = {}, fail = [] } = {}) {
  const calls = []
  const run = (file, args) => {
    const cmd = [file, ...args].join(' ')
    calls.push(cmd)
    if (file !== 'powershell') return { status: 1, stdout: '', stderr: `not powershell: ${file}` }
    if (fail.some((f) => cmd.includes(f))) return { status: null, stdout: '', stderr: 'did not run' }
    let m = /Get-Process -Id (\d+) /.exec(cmd) // the supervisor's one fixed question (arch lockHolderAlive's, held equal below)
    if (m) return Number(m[1]) in table ? { status: 0, stdout: String(table[Number(m[1])]), stderr: '' } : { status: 0, stdout: 'gone', stderr: '' }
    m = /Win32_Process -Filter "ProcessId=(\d+)"/.exec(cmd) // the identity question: creation time and the machine's boot time
    if (m) return Number(m[1]) in table ? { status: 0, stdout: JSON.stringify({ s: table[Number(m[1])], b: BOOTED }), stderr: '' } : { status: 0, stdout: 'gone', stderr: '' }
    if (/Win32_Process \| ForEach-Object/.test(cmd)) return { status: 0, stdout: runner.tableJson, stderr: '' } // the whole table, once
    return { status: 1, stdout: '', stderr: `the fake powershell does not know this question: ${cmd.slice(0, 80)}` }
  }
  const runner = { run, calls, tableJson: '[]', answer: (j) => { runner.tableJson = j } }
  return runner
}

// ── the process table and the identity: one fixed powershell question each ────────────────────────────────────────────────────
const TABLE_JSON = JSON.stringify([
  { p: 100, pp: 1, n: 'node.exe', x: 'C:\\Program Files\\nodejs\\node.exe', s: CREATED, c: '"C:\\Program Files\\nodejs\\node.exe" C:\\x\\asight.mjs daemon' },
  { p: 101, pp: 100, n: 'claude.exe', x: null, s: CREATED + 5000, c: null },
])
test('listProcs on win32: one fixed Get-CimInstance question through the injected runner, the whole table as JSON — pid, parent, start, exe, argv; uid unknown, environment unreadable', async () => {
  const ps = powershell()
  ps.answer(TABLE_JSON)
  const got = await listProcs({ platform: 'win32', exec: ps.run })
  assert.deepEqual(got.map((r) => [r.pid, r.ppid, r.uid, r.startedAt]), [[100, 1, null, CREATED], [101, 100, null, CREATED + 5000]])
  assert.equal(got[0].exe, 'C:\\Program Files\\nodejs\\node.exe')
  assert.deepEqual(got[0].argv, ['"C:\\Program', 'Files\\nodejs\\node.exe"', 'C:\\x\\asight.mjs', 'daemon'], 'the command line, split like macOS\'s ps (its argument boundaries are lost)')
  assert.equal(got[1].exe, 'claude.exe', 'a process without a path is named by its name')
  assert.equal(got[1].env(), null, 'another process\'s environment cannot be read on Windows')
  assert.equal(ps.calls.length, 1, 'one question for the whole table, not one per process')
  ps.answer(JSON.stringify({ p: 100, pp: 1, n: 'node.exe', x: 'C:\\n.exe', s: CREATED, c: 'node x' }))
  assert.equal((await listProcs({ platform: 'win32', exec: ps.run })).length, 1, 'one process on the machine: PowerShell\'s JSON is an object, not a list')
  ps.answer('')
  assert.deepEqual(await listProcs({ platform: 'win32', exec: ps.run }), [], 'a table that printed nothing is an empty table')
  await assert.rejects(listProcs({ platform: 'win32', exec: powershell({ fail: ['ForEach-Object'] }).run }), /is not known/, 'the question died: an error, never an empty table (D38)')
  const garbage = powershell(); garbage.answer('not json at all')
  await assert.rejects(listProcs({ platform: 'win32', exec: garbage.run }), /is not known/, 'an answer that is not JSON is an error too')
})

test('the win32 identity: the pid\'s creation time and the machine\'s boot time as the lock\'s start_time and boot_id (4.8 §7); a gone pid, a dead powershell and a bad answer are nulls, never a throw', () => {
  const ps = powershell({ table: { 4242: CREATED } })
  const id = identityFor({ platform: 'win32', exec: ps.run })
  assert.deepEqual(id(4242), { start_time: String(CREATED), boot_id: String(BOOTED) })
  assert.deepEqual(id(9999), { start_time: null, boot_id: null }, 'a pid that is not there')
  const broken = identityFor({ platform: 'win32', exec: powershell({ fail: ['Win32_Process -Filter'] }).run })
  assert.deepEqual(broken(4242), { start_time: null, boot_id: null }, 'powershell did not run: not known, not a crash')
  const weird = identityFor({ platform: 'win32', exec: () => ({ status: 0, stdout: 'neither gone nor json', stderr: '' }) })
  assert.deepEqual(weird(4242), { start_time: null, boot_id: null })
  assert.deepEqual(procIdentity(4242, { platform: 'win32', run: ps.run }), { start_time: String(CREATED), boot_id: String(BOOTED) }, 'procIdentity itself takes the win32 arm: the daemon\'s default identity flows through it without a daemon.mjs change')
})

test('a lock written with the win32 identity is verified: a reused pid and a reboot read stale — the cases that read "running" (and then "starting") when the identity was /proc-shaped', () => {
  const dir = tmpDir('asight-w32-lock-')
  const lockFile = path.join(dir, 'lock')
  const write = (over = {}) => {
    nodeFs.writeFileSync(lockFile, JSON.stringify({ pid: 4242, start_time: String(CREATED), boot_id: String(BOOTED), socket: path.join(dir, 's'), engine_port: 47123, ...over }) + '\n')
    const when = new Date(); nodeFs.utimesSync(lockFile, when, when)
  }
  const ps = powershell({ table: { 4242: CREATED } })
  const id = identityFor({ platform: 'win32', exec: ps.run })
  write()
  assert.equal(readDaemonLock({ file: lockFile, alive: () => true, identity: id }).state, 'running')
  assert.equal(readDaemonLock({ file: lockFile, alive: () => true, identity: id }).verified, undefined, 'the creation time and the boot time were both checked')
  write({ start_time: String(CREATED + 60_000) })
  assert.equal(readDaemonLock({ file: lockFile, alive: () => true, identity: id }).state, 'stale', 'another process took the pid')
  write({ boot_id: String(BOOTED + 86400_000) })
  assert.equal(readDaemonLock({ file: lockFile, alive: () => true, identity: id }).state, 'stale', 'the machine rebooted')
})

// ── the stop order: the supervisor parent first, then the daemon, both through taskkill ────────────────────────────────────────
const SUPER_AT = CREATED - 90_000 // the supervisor started before the daemon it watches
/** The world of a stop: a daemon lock and a supervisor.lock beside it, and a fake machine whose pids die on taskkill. `at` names
 *  what each pid's creation time IS now (the fake machine's answer); the locks always say what it was when they were written. */
function winWorld({ superAt = SUPER_AT, daemonAt = CREATED, superNowAt = superAt, daemonNowAt = daemonAt, fail = [] } = {}) {
  const dir = tmpDir('asight-w32-stop-')
  const lockFile = path.join(dir, 'lock')
  nodeFs.writeFileSync(lockFile, JSON.stringify({ pid: 4242, start_time: String(daemonAt), boot_id: String(BOOTED), engine_port: 47123 }) + '\n')
  nodeFs.writeFileSync(path.join(dir, SUPERVISOR_LOCK), JSON.stringify({ pid: 5000, startedAt: superAt }) + '\n')
  const live = new Set([4242, 5000])
  const ps = powershell({ table: { 4242: daemonNowAt, 5000: superNowAt }, fail })
  ps.answer('[]')
  const exec = (file, args) => {
    const cmd = [file, ...args].join(' ')
    ps.calls.push(cmd)
    if (file === 'taskkill') { if (args[0] === '/PID') live.delete(Number(args[1])); return { status: 0, stdout: '', stderr: '' } }
    return ps.run(file, args)
  }
  return { dir, lockFile, ps, exec, alive: (pid) => live.has(pid), calls: ps.calls }
}

test('stopDaemon on win32 kills the supervisor FIRST (its start time asked and matched first), then the daemon (identity checked): the order a recording runner sees, both through taskkill /PID <pid> /F', async () => {
  const w = winWorld()
  const r = await stopDaemon({ lockFile: w.lockFile, platform: 'win32', exec: w.exec, alive: w.alive, identity: identityFor({ platform: 'win32', exec: w.exec }), now: () => Date.now(), fs: nodeFs })
  assert.ok(r.stopped, `both gone${r.error ? ` (${r.error})` : ''}`)
  assert.equal(r.how, 'taskkill')
  const kills = w.calls.filter((c) => c.startsWith('taskkill'))
  assert.deepEqual(kills, ['taskkill /PID 5000 /F', 'taskkill /PID 4242 /F'], 'the supervisor first: a daemon killed first is re-spawned by it (4.8 §4.2)')
  assert.ok(w.calls.findIndex((c) => c.includes('Get-Process -Id 5000')) < w.calls.findIndex((c) => c.startsWith('taskkill') && c.includes('5000')), 'the supervisor\'s start time was asked before it was killed')
})

test('a supervisor.lock that names a reused pid (its start time no longer matches) is skipped silently — its supervisor is dead; one that cannot be read kills nothing on a guess and says so', async () => {
  const reused = winWorld({ superNowAt: SUPER_AT + 999_000 }) // pid 5000 lives, but it is another process now
  const r = await stopDaemon({ lockFile: reused.lockFile, platform: 'win32', exec: reused.exec, alive: reused.alive, identity: identityFor({ platform: 'win32', exec: reused.exec }), now: () => Date.now(), fs: nodeFs })
  assert.ok(r.stopped, `the daemon still goes${r.error ? ` (${r.error})` : ''}`)
  assert.ok(reused.calls.some((c) => c === 'taskkill /PID 4242 /F'), 'the daemon still goes')
  assert.ok(!reused.calls.some((c) => c.startsWith('taskkill') && c.includes('5000')), 'a reused pid is never signalled (only asked)')
  assert.equal(r.error, undefined, 'the original supervisor is dead: nothing left that could re-spawn the daemon, nothing to report')
  const unreadable = winWorld({ fail: ['Get-Process -Id 5000'] })
  const r2 = await stopDaemon({ lockFile: unreadable.lockFile, platform: 'win32', exec: unreadable.exec, alive: unreadable.alive, identity: identityFor({ platform: 'win32', exec: unreadable.exec }), now: () => Date.now(), fs: nodeFs })
  assert.ok(!unreadable.calls.some((c) => c.startsWith('taskkill') && c.includes('5000')), 'powershell could not tell: nothing is killed on a guess')
  assert.ok(r2.error && /supervisor|5000/.test(r2.error))
})

test('no supervisor.lock: straight to the daemon. A daemon whose identity no longer matches is not signalled (the same rule as the other platforms)', async () => {
  const w = winWorld()
  nodeFs.rmSync(path.join(w.dir, SUPERVISOR_LOCK))
  const r = await stopDaemon({ lockFile: w.lockFile, platform: 'win32', exec: w.exec, alive: w.alive, identity: identityFor({ platform: 'win32', exec: w.exec }), now: () => Date.now(), fs: nodeFs })
  assert.ok(r.stopped)
  assert.deepEqual(w.calls.filter((c) => c.startsWith('taskkill')), ['taskkill /PID 4242 /F'])
  const reused = winWorld({ daemonNowAt: CREATED + 60_000 }) // the lock names a pid that is another process now
  const r2 = await stopDaemon({ lockFile: reused.lockFile, platform: 'win32', exec: reused.exec, alive: reused.alive, identity: identityFor({ platform: 'win32', exec: reused.exec }), now: () => Date.now(), fs: nodeFs })
  assert.ok(!reused.calls.some((c) => c.startsWith('taskkill') && c.includes('4242')), 'a reused daemon pid kills nothing (the supervisor still goes: its lock was healthy)')
  assert.ok(reused.calls.some((c) => c === 'taskkill /PID 5000 /F'), 'the healthy supervisor goes first, as always')
  assert.ok(r2.stopped, 'nothing left to stop: the same clean answer the Linux arm gives a stale lock')
})

test('the supervisor question and its tolerance are the arch module\'s own (lockHolderAlive): the same fixed powershell question, the same 2 s, the same answers — src/off cannot import it, so the test holds them equal', () => {
  assert.equal(SUPERVISOR_LOCK, ARCH_SUPERVISOR_LOCK)
  assert.equal(SUPERVISOR_START_TOLERANCE_MS, ARCH_LOCK_START_TOLERANCE_MS)
  const table = { 5000: SUPER_AT }
  for (const holder of [{ pid: 5000, startedAt: SUPER_AT }, { pid: 5000, startedAt: SUPER_AT + SUPERVISOR_START_TOLERANCE_MS - 1 }, { pid: 5000, startedAt: SUPER_AT + SUPERVISOR_START_TOLERANCE_MS + 1 }, { pid: 5001, startedAt: SUPER_AT }]) {
    const mine = (() => { try { return JSON.stringify(supervisorHolderAlive(holder, { run: powershell({ table }).run })) } catch (e) { return `throw:${e.message}` } })()
    const arch = (() => { try { return JSON.stringify(lockHolderAlive(holder, { run: powershell({ table }).run })) } catch (e) { return `throw:${e.message}` } })()
    assert.equal(mine, arch, `the same answer for ${JSON.stringify(holder)}`)
  }
  assert.throws(() => supervisorHolderAlive({ pid: 5000, startedAt: SUPER_AT }, { run: powershell({ fail: ['Get-Process'] }).run }), /could not be asked/)
})
