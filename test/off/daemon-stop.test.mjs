// test/off/daemon-stop.test.mjs — telling a stuck daemon from an absent one and stopping it safely (RFC 1.6 §1.4 第 2 / 5 步, 「asight 自己坏了时」).
// Every process is a row of a fake table, every signal goes to a recorder, the OS tool is a recording runner, time is a fake clock: nothing signals a
// real process (stopDaemon refuses a default `kill` under npm test).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { daemonState, stopDaemon, helperGone, readDaemonLock, DAEMON_LOCK_FRESH_MS } from '../../src/off/daemon-stop.mjs'
import { lockState, LOCK_FRESH_MS } from '../../src/health/read.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const BOOT = 'boot-1'
const clock = () => { let t = 10_000_000; return { now: () => t, sleep: async (ms) => { t += ms }, advance: (ms) => { t += ms } } }
function lockAt(body, { ageMs = 0, now = 10_000_000 } = {}) {
  const file = path.join(tmpDir('asight-dstop-'), 'lock')
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body))
  const when = new Date(now - ageMs); fs.utimesSync(file, when, when)
  return file
}
const DAEMON = { pid: 4242, start_time: '111', boot_id: BOOT, helper_pid: 4243, socket: '/run/user/1000/asight/collector.sock', engine_port: 47123 }
// the fake process table: pid → identity; `ignoreTerm`: pids that survive SIGTERM (a stopped or wedged process)
function table(rows, { ignoreTerm = [], dieOn = {} } = {}) {
  const live = new Map(Object.entries(rows).map(([pid, id]) => [Number(pid), id]))
  const sent = []
  return {
    live, sent,
    alive: (pid) => live.has(pid), identity: (pid) => live.get(pid) || { start_time: null, boot_id: null },
    isHelper: (pid) => pid === 4243,
    kill: (pid, signal) => { sent.push([pid, signal]); if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !ignoreTerm.includes(pid))) live.delete(pid); if (dieOn[`${pid}:${signal}`]) dieOn[`${pid}:${signal}`]() },
  }
}
const UP = { 4242: { start_time: '111', boot_id: BOOT }, 4243: { start_time: '112', boot_id: BOOT } }
const refused = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }
const absent = async () => { throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }) }
const answers = async () => ({ desired: 'on' })
const hangs = async () => { throw Object.assign(new Error('control request timed out'), { code: 'ETIMEDOUT' }) }
const systemd = ({ active = 'inactive', stopTimesOut = false, onStop = () => {} } = {}) => {
  const calls = []
  return { calls, run: (file, args) => { const cmd = [file, ...args].join(' '); calls.push(cmd); if (/ stop /.test(cmd)) { onStop(); return stopTimesOut ? { status: null, stdout: '', stderr: '', error: new Error('ETIMEDOUT') } : { status: 0, stdout: '', stderr: '' } } if (/is-active/.test(cmd)) return { status: active === 'active' ? 0 : 3, stdout: `${active}\n`, stderr: '' }; return { status: 0, stdout: '', stderr: '' } } }
}

test('the lock is read the way src/health lockState reads it: the same answer for every shape of lock, and the same 5 s', () => {
  assert.equal(DAEMON_LOCK_FRESH_MS, LOCK_FRESH_MS)
  const t = table(UP)
  const shapes = [['none', null], ['cut short', '{"pid":'], ['no pid', '{}'], ['fresh', DAEMON], ['old', DAEMON, 30_000], ['dead pid', { ...DAEMON, pid: 9 }], ['reused', { ...DAEMON, start_time: '999' }], ['rebooted', { ...DAEMON, boot_id: 'other' }], ['older lock without identity', { pid: 4242, helper_pid: 4243 }]]
  for (const [name, body, ageMs] of shapes) {
    const file = body === null ? path.join(tmpDir('asight-dstop-'), 'lock') : lockAt(body, { ageMs })
    const mine = readDaemonLock({ file, now: 10_000_000, alive: t.alive, identity: t.identity })
    assert.deepEqual(mine, lockState({ file, now: 10_000_000, alive: t.alive, identity: t.identity }), name)
  }
})

test('daemonState: none, stale, running, starting, unresponsive and unknown — each from the lock and the socket, and never "none" for a lock that cannot be read', async () => {
  const t = table(UP)
  const ask = (body, request, { ageMs = 0, socketPath = '/run/user/1000/asight/collector.sock' } = {}) => daemonState({ lockFile: body === null ? path.join(tmpDir('asight-dstop-'), 'lock') : lockAt(body, { ageMs }), socketPath, request, alive: t.alive, identity: t.identity, now: () => 10_000_000 })
  assert.equal((await ask(null, absent)).state, 'none', 'no lock, nothing listens')
  assert.equal((await ask({ ...DAEMON, pid: 9 }, refused)).state, 'stale', 'the lock names a dead pid')
  assert.equal((await ask({ ...DAEMON, start_time: '999' }, refused)).state, 'stale', 'or a reused one: never judged running by the pid alone (D-25)')
  assert.equal((await ask(DAEMON, answers)).state, 'running')
  assert.equal((await ask(DAEMON, async () => { throw Object.assign(new Error('500: boom'), { status: 500 }) })).state, 'running', 'an answer that is an error is still an answer')
  assert.equal((await ask(null, answers)).state, 'running', 'it answers although the lock is gone')
  const starting = await ask(DAEMON, refused)
  assert.deepEqual([starting.state, starting.lock.pid], ['starting', 4242])
  const stuck = await ask(DAEMON, hangs)
  assert.equal(stuck.state, 'unresponsive'); assert.match(stuck.reason, /does not answer/)
  const old = await ask(DAEMON, answers, { ageMs: 6000 })
  assert.equal(old.state, 'unresponsive', 'the lock was not refreshed for 5 s: the spec says unresponsive, an answer or not'); assert.match(old.reason, /not refreshed for 6 s/)
  const unknown = await ask('{"pid":', refused, { socketPath: null })
  assert.equal(unknown.state, 'unknown', 'a lock cut short and no socket to ask: not known'); assert.match(unknown.reason, /not valid JSON.*whether a daemon runs is not known \(no control socket path is known to ask: XDG_RUNTIME_DIR is not set\)/)
  assert.equal((await ask('{"pid":', answers)).state, 'running', 'an unreadable lock but an answering daemon')
})

test('a lock cut short (empty, garbage, no pid) while the control socket refuses is the lock of a daemon that is gone — stale, lock null, the reason says why; every other doubt stays unknown or unresponsive', async () => {
  const t = table(UP); const sock = '/run/user/1000/asight/collector.sock'
  const ask = (file, request, o = {}) => daemonState({ lockFile: file, socketPath: sock, request, alive: t.alive, identity: t.identity, now: () => 10_000_000, ...o })
  for (const [name, body] of [['empty (a power loss keeps the rename and loses the data)', ''], ['cut short', '{"pid":'], ['garbage', 'x\u0000\u0000\u0000'], ['no pid', '{}']]) {
    for (const refusal of [refused, absent]) {
      const s = await ask(lockAt(body), refusal)
      assert.deepEqual([s.state, s.lock, s.socket], ['stale', null, null], name)
      assert.match(s.reason, /nothing listens on \/run\/user\/1000\/asight\/collector\.sock either.*ended without a clean stop/, name)
    }
  }
  assert.equal((await ask(lockAt(''), hangs)).state, 'unresponsive', 'a socket that is there and does not answer is a stuck daemon, whatever the lock holds')
  assert.equal((await ask(lockAt(''), answers)).state, 'running', 'and one that answers is running')
  const dir = path.join(tmpDir('asight-dstop-'), 'lock'); fs.mkdirSync(dir) // a lock that cannot be READ (EISDIR here; EACCES, EIO in life) is no cut-short lock: nobody knows what it held
  const io = await ask(dir, refused)
  assert.equal(io.state, 'unknown'); assert.match(io.reason, /EISDIR.*whether a daemon runs is not known/)
  const asked = []
  const none = await ask(lockAt(''), async (q) => { asked.push(q.socketPath); throw Object.assign(new Error('x'), { code: 'ENOENT' }) }, { socketPath: null })
  assert.deepEqual([none.state, asked], ['unknown', []], 'with no socket path there is nothing to ask, so nothing is concluded from not asking')
})

test('daemonState tries the socket the lock names when the runtime directory has none (XDG_RUNTIME_DIR unset or gone)', async () => {
  const t = table(UP); const asked = []
  const s = await daemonState({ lockFile: lockAt(DAEMON), socketPath: null, request: async (q) => { asked.push(q.socketPath); return {} }, alive: t.alive, identity: t.identity, now: () => 10_000_000 })
  assert.deepEqual([s.state, asked], ['running', [DAEMON.socket]])
})

test('stopDaemon with a unit: systemctl stop first, which stops it; then reset-failed and is-active; no signal is sent', async () => {
  const t = table(UP); const c = clock()
  const sd = systemd({ onStop: () => { t.live.delete(4242); t.live.delete(4243) } })
  const r = await stopDaemon({ lockFile: lockAt(DAEMON), exec: sd.run, kill: t.kill, alive: t.alive, identity: t.identity, isHelper: t.isHelper, unitManaged: true, now: c.now, sleep: c.sleep })
  assert.deepEqual(sd.calls, ['systemctl --user stop asight-collector.service', 'systemctl --user reset-failed asight-collector.service', 'systemctl --user is-active asight-collector.service'])
  assert.deepEqual([r.stopped, r.how, r.pid, r.signals, t.sent], [true, 'systemctl', 4242, ['systemctl-stop'], []])
})

test('stopDaemon with no unit: SIGTERM, and when it ignores it SIGKILL after termWaitMs; the helper that outlived the daemon gets its own SIGTERM; every signal after an identity check', async () => {
  const t = table(UP, { ignoreTerm: [4242] }); const c = clock()
  const r = await stopDaemon({ lockFile: lockAt(DAEMON), kill: t.kill, alive: t.alive, identity: t.identity, isHelper: t.isHelper, termWaitMs: 10_000, now: c.now, sleep: c.sleep })
  assert.deepEqual(t.sent, [[4242, 'SIGTERM'], [4242, 'SIGKILL'], [4243, 'SIGTERM']])
  assert.deepEqual([r.stopped, r.how, r.signals], [true, 'signal', ['SIGTERM', 'SIGKILL', 'SIGTERM']])
  assert.ok(c.now() - 10_000_000 >= 10_000, 'it gave the daemon the whole 10 s to exit on SIGTERM before it killed it')
  const polite = table(UP); const c2 = clock()
  const r2 = await stopDaemon({ lockFile: lockAt(DAEMON), kill: polite.kill, alive: polite.alive, identity: polite.identity, isHelper: polite.isHelper, now: c2.now, sleep: c2.sleep })
  assert.deepEqual([r2.stopped, polite.sent.map((s) => s[1])], [true, ['SIGTERM', 'SIGTERM']], 'a daemon that exits on SIGTERM is not killed; each live pid got one SIGTERM')
})

test('a unit that cannot stop a stuck daemon (systemctl stop times out): the signals follow; the lock\'s pid is stopped by SIGTERM and SIGKILL after the wait (V30\'s stopped daemon)', async () => {
  const t = table(UP, { ignoreTerm: [4242] }); const c = clock()
  const sd = systemd({ stopTimesOut: true })
  const r = await stopDaemon({ lockFile: lockAt(DAEMON), exec: sd.run, kill: t.kill, alive: t.alive, identity: t.identity, isHelper: t.isHelper, unitManaged: true, now: c.now, sleep: c.sleep })
  assert.deepEqual(r.signals, ['systemctl-stop', 'SIGTERM', 'SIGKILL', 'SIGTERM'])
  assert.deepEqual([r.stopped, r.how], [true, 'signal'])
  assert.equal(sd.calls.at(-1), 'systemctl --user is-active asight-collector.service')
})

test('a lock that names a reused pid kills nothing; the identity is checked again between SIGTERM and SIGKILL; a helper pid that is some other process is not signalled (D-25)', async () => {
  const reused = table({ 4242: { start_time: '999', boot_id: BOOT } }); const c = clock()
  const r = await stopDaemon({ lockFile: lockAt(DAEMON), kill: reused.kill, alive: reused.alive, identity: reused.identity, isHelper: reused.isHelper, now: c.now, sleep: c.sleep })
  assert.deepEqual([r.stopped, r.signals, reused.sent], [true, [], []], 'stale lock: nothing to stop, nobody signalled')
  // the daemon ignores SIGTERM and its pid is reused by another process right after: no SIGKILL goes to the stranger
  const t = table(UP, { ignoreTerm: [4242], dieOn: { '4242:SIGTERM': () => {} } }); const c2 = clock()
  let stranger = false
  const identity = (pid) => (pid === 4242 && stranger ? { start_time: '777', boot_id: BOOT } : t.identity(pid))
  const r2 = await stopDaemon({ lockFile: lockAt(DAEMON), kill: (pid, sig) => { t.kill(pid, sig); if (pid === 4242 && sig === 'SIGTERM') stranger = true }, alive: t.alive, identity, isHelper: t.isHelper, now: c2.now, sleep: c2.sleep })
  assert.deepEqual(t.sent.filter(([pid]) => pid === 4242), [[4242, 'SIGTERM']], 'SIGKILL not sent to a process that is not the daemon any more')
  assert.equal(r2.stopped, true)
  const other = table({ ...UP, 4243: { start_time: '5', boot_id: BOOT } }); const c3 = clock()
  const r3 = await stopDaemon({ lockFile: lockAt({ ...DAEMON, pid: 9 }), kill: other.kill, alive: other.alive, identity: other.identity, isHelper: () => false, now: c3.now, sleep: c3.sleep })
  assert.deepEqual([r3.stopped, other.sent], [true, []], 'pid 4243 is alive but is not the helper: it is not ours to signal, and it is not "the link" either')
})

test('a daemon that cannot be told from another process (the lock has no start time) is not signalled and is said; nothing is "stopped"', async () => {
  const t = table(UP); const c = clock()
  const r = await stopDaemon({ lockFile: lockAt({ pid: 4242, helper_pid: 4243 }), kill: t.kill, alive: t.alive, identity: t.identity, isHelper: t.isHelper, now: c.now, sleep: c.sleep })
  assert.equal(r.stopped, false); assert.match(r.error, /pid 4242 cannot be told from another process/)
  assert.deepEqual(t.sent.filter(([pid]) => pid === 4242), [], 'not the daemon pid')
})

test('a unit systemd still reports active or activating is not "stopped", and a daemon that survives SIGKILL is said with the signals tried', async () => {
  const t = table(UP); const c = clock()
  const sd = systemd({ active: 'activating', onStop: () => { t.live.delete(4242); t.live.delete(4243) } })
  const r = await stopDaemon({ lockFile: lockAt(DAEMON), exec: sd.run, kill: t.kill, alive: t.alive, identity: t.identity, isHelper: t.isHelper, unitManaged: true, now: c.now, sleep: c.sleep })
  assert.equal(r.stopped, false); assert.match(r.error, /is-active asight-collector\.service says activating/)
  const wedged = { ...table(UP), kill: (pid, sig) => wedged.sent.push([pid, sig]) } // survives everything (D state)
  wedged.sent = []; const c2 = clock()
  const r2 = await stopDaemon({ lockFile: lockAt(DAEMON), kill: wedged.kill, alive: wedged.alive, identity: wedged.identity, isHelper: wedged.isHelper, now: c2.now, sleep: c2.sleep })
  assert.equal(r2.stopped, false); assert.match(r2.error, /pid 4242 is still running after SIGTERM, SIGKILL/)
})

test('helperGone: no lock or no helper pid, a dead helper, and a pid that is not the helper any more all mean no link; a live helper does not', () => {
  const t = table(UP)
  assert.equal(helperGone(null, t), true)
  assert.equal(helperGone({ pid: 1 }, t), true)
  assert.equal(helperGone({ pid: 1, helper_pid: 4243 }, t), false)
  assert.equal(helperGone({ pid: 1, helper_pid: 8 }, t), true)
  assert.equal(helperGone({ pid: 1, helper_pid: 4243 }, { ...t, isHelper: () => false }), true)
})

test('0.1 §3: stopDaemon without an injected `kill` refuses to signal under npm test (ESANDBOX), and is not swallowed', async () => {
  const t = table(UP); const c = clock()
  await assert.rejects(stopDaemon({ lockFile: lockAt(DAEMON), alive: t.alive, identity: t.identity, isHelper: t.isHelper, now: c.now, sleep: c.sleep }), (e) => e.code === 'ESANDBOX')
})
