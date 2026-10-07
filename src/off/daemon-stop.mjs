// daemon-stop.mjs (src/off) — is this user's collector daemon there, and how to stop it when it has to go (RFC 1.6 §1.4 第 2 / 5 步, 「asight 自己坏了时」;
// 4.6 §控制面 `lock`). `asight off`, `asight uninstall` and the standalone `asight-off` ask first and stop only a daemon that does not answer
// (off) or has to go (uninstall); a daemon that answers is asked to switch off through its control socket instead (orchestrate.mjs).
//   daemonState   judges from the `lock` file (written at start, its mtime refreshed every second) and the control socket
//   stopDaemon    `systemctl --user stop asight-collector` when the autostart unit manages it, else SIGTERM, then SIGKILL after `termWaitMs`; the pid's
//                 identity (the lock's start_time and boot_id) is checked before EVERY signal, so a lock that names a reused pid kills nothing; the
//                 helper (lock.helper_pid) goes with it when it is still there and is the helper; then `reset-failed` and `is-active`
//   helperGone    the link of this instance is the helper's (unpinned when it exits): "the helper is gone" is "no link"
// The lock reader is src/health/read.mjs lockState, written here too (src/off imports nothing outside itself, 0.1 §2); test/off/daemon-stop.test.mjs
// holds the two to the same answers. Imports only node:* and src/off.
import nodeFs from 'node:fs'
import path from 'node:path'
import { execTool } from './exec.mjs'
import { controlRequest } from './control-client.mjs'
import { procIdentity, pidAlive, readArgv, readExe } from './proc.mjs'
import { UNIT_FILE_NAME } from './autostart.mjs'

/** A lock not refreshed for this long belongs to a daemon that does not run its timers: unresponsive (4.6 §Linux 机制, same as src/health LOCK_FRESH_MS). */
export const DAEMON_LOCK_FRESH_MS = 5000

// What readDaemonLock says (the words are src/health/read.mjs lockState's, which test/off/daemon-stop.test.mjs holds it to) of a lock whose content is no lock.
const CUT_LOCK = /is not valid JSON|names no pid/

const stopSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The lock read as src/health/read.mjs lockState does → `{ state: 'none' | 'unknown' | 'stale' | 'running' | 'unresponsive', lock?, why?, error?, age_ms?, verified? }`.
 *  stale: the pid is not running, or is another process now (start_time / boot_id differ: D-25); unknown: the file is there and cannot be read. */
export function readDaemonLock({ file, now = Date.now(), alive = pidAlive, identity = procIdentity, fs = nodeFs } = {}) {
  let text, mtimeMs
  try { text = fs.readFileSync(file, 'utf8'); mtimeMs = fs.statSync(file).mtimeMs } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'none' }
    return { state: 'unknown', error: `${file}: ${String((e && e.message) || e)}` }
  }
  let lock
  try { lock = JSON.parse(text) } catch (e) { return { state: 'unknown', error: `${file} is not valid JSON (${e.message}): cut short by a crash or power loss?` } }
  if (!lock || !Number.isInteger(lock.pid)) return { state: 'unknown', error: `${file} names no pid` }
  const age_ms = Math.max(0, Math.round(now - mtimeMs))
  if (!alive(lock.pid)) return { state: 'stale', lock, why: `pid ${lock.pid} is not running`, age_ms }
  const id = identity(lock.pid) || {}
  const verified = id.start_time != null && id.boot_id != null && lock.start_time != null && lock.boot_id != null // an older lock has neither
  if (verified && String(lock.boot_id) !== id.boot_id) return { state: 'stale', lock, why: 'the machine has rebooted since (boot id differs)', age_ms }
  if (verified && String(lock.start_time) !== id.start_time) return { state: 'stale', lock, why: `pid ${lock.pid} is another process now (start time differs)`, age_ms }
  return { state: age_ms > DAEMON_LOCK_FRESH_MS ? 'unresponsive' : 'running', lock, age_ms, ...(verified ? {} : { verified: false }) }
}

/** What there is to deal with → `{ state, lock, socket, reason?, age_ms? }` (`socket`: the one that answered, or null):
 *    none          no lock and nothing answers: no daemon
 *    stale         the lock names a process that is gone or is another one now, and nothing answers: no daemon (its helper may linger); or the lock was cut short
 *                  (empty or garbage: a crash or a power loss) and the control socket that was asked refuses: no daemon either, `lock` is null then
 *    running       it answers (GET /status)
 *    starting      a fresh lock, a live pid, and the control socket is not there yet
 *    unresponsive  the lock was not refreshed for 5 s, or the socket is there and does not answer in `timeoutMs`: stuck (1.6 §1.4 第 2 步)
 *    unknown       the lock cannot be read (an I/O error), or is cut short and there is no control socket to ask, and nothing answers: whether a daemon runs is
 *                  not known (never read as "none") */
export async function daemonState({ lockFile, socketPath = null, request = controlRequest, identity = procIdentity, alive = pidAlive, now = Date.now, fs = nodeFs, timeoutMs = 5000 } = {}) {
  const L = readDaemonLock({ file: lockFile, now: now(), alive, identity, fs })
  const lock = L.lock || null
  let answered = false, hung = null, answeredOn = null
  const sockets = [...new Set([socketPath, lock && lock.socket].filter(Boolean))]
  let refused = 0
  for (const sock of sockets) {
    try { await request({ socketPath: sock, method: 'GET', path: '/status', timeoutMs }); answered = true; answeredOn = sock; break } catch (e) {
      if (e && e.status) { answered = true; answeredOn = sock; break } // it answered, with an error: it is there
      if (e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED')) { refused++; continue } // nobody listens on it
      hung = String((e && e.message) || e)
    }
  }
  const out = (state, reason) => ({ state, lock, socket: answeredOn, ...(reason ? { reason } : {}), ...(L.age_ms != null ? { age_ms: L.age_ms } : {}) })
  if (L.state === 'unresponsive') return out('unresponsive', `${lockFile} was not refreshed for ${Math.round(L.age_ms / 1000)} s`)
  if (answered) return out('running')
  if (hung) return out('unresponsive', `the control socket does not answer (${hung})`)
  if (L.state === 'unknown') {
    // A lock whose content is garbage or empty was cut short (a crash or a power loss: ext4 keeps the rename and loses the data). A daemon writes it whole, by rename,
    // AFTER its control socket is listening, so with the socket known and refusing there is no daemon serving: the same reading the daemon itself gives such a lock at
    // its next start (an unclean stop). Without a socket to ask, or with a lock that cannot be read for another reason (EACCES, EIO), it stays not known (R11).
    if (CUT_LOCK.test(L.error) && sockets.length && refused === sockets.length) return out('stale', `${L.error}; nothing listens on ${sockets.join(' or ')} either, so it is read as the lock of a daemon that ended without a clean stop (the next daemon start overwrites it)`)
    return out('unknown', `${L.error}, so whether a daemon runs is not known${sockets.length ? '' : ' (no control socket path is known to ask: XDG_RUNTIME_DIR is not set)'}`)
  }
  if (L.state === 'running') return out('starting', `pid ${lock.pid} holds a fresh lock, but its control socket is not there yet`)
  return out(L.state, L.why)
}

/** Is the process the capability helper? (its executable or its first argument is `asight-redirector`; a pid that is some other process now is not.) */
export function isRedirectorHelper(pid) {
  const names = [readExe(pid), (readArgv(pid) || [])[0]].filter(Boolean).map((x) => path.basename(x))
  return names.some((n) => n.startsWith('asight-redirector'))
}

/** True when the lock's helper is not running (or is some other process now): no link of this instance is left, the link being the helper's. A
 *  daemon that never ran (no lock) has no helper. `alive` / `isHelper` are the world's, injectable. */
export function helperGone(lock, { alive = pidAlive, isHelper = isRedirectorHelper } = {}) {
  const pid = lock && lock.helper_pid
  return !Number.isInteger(pid) || !alive(pid) || !isHelper(pid, lock)
}

const refuseRealKill = () => {
  throw Object.assign(new Error('refusing to signal a real process under npm test (0.1 §3): inject `kill`'), { code: 'ESANDBOX' })
}
const defaultKill = (pid, signal) => { if (process.env.ASIGHT_TEST_SANDBOX === '1') refuseRealKill(); process.kill(pid, signal) }

/** Stops the daemon of this user and its helper → `{ stopped, how: 'systemctl' | 'signal' | 'none', pid, helper_pid, signals: [...], error? }`.
 *  `stopped` is true when the daemon and its helper are gone and the unit is neither active nor activating. A pid the lock names is signalled only
 *  after its identity matched the lock (a lock without start_time, or an unreadable /proc, is "cannot tell": nothing is signalled, `error` says so). */
export async function stopDaemon({ lockFile, socketPath = null, exec = null, kill = defaultKill, alive = pidAlive, identity = procIdentity, isHelper = isRedirectorHelper, unitManaged = false, termWaitMs = 10000, sleep = stopSleep, now = Date.now, fs = nodeFs, env = process.env } = {}) {
  const L = readDaemonLock({ file: lockFile, now: now(), alive, identity, fs })
  const lock = L.lock || null
  const signals = []
  const problems = []
  let how = 'none'
  if (L.state === 'unknown') problems.push(`${L.error}, so which process to stop is not known`)
  const same = (pid) => { // the lock's pid is still the process the lock was written for?
    const id = identity(pid) || {}
    if (lock.start_time == null || lock.boot_id == null || id.start_time == null || id.boot_id == null) return 'unknown'
    return String(lock.boot_id) === id.boot_id && String(lock.start_time) === id.start_time ? 'same' : 'other'
  }
  const waitGone = async (test, ms) => { for (const end = now() + ms; test() && now() < end;) await sleep(25) }
  const send = (pid, signal) => { try { kill(pid, signal) } catch (e) { if (e && e.code === 'ESANDBOX') throw e; if (!e || e.code !== 'ESRCH') problems.push(`${signal} to pid ${pid} failed (${String((e && e.code) || (e && e.message) || e)})`) } signals.push(signal) }
  const daemonUp = () => !!lock && Number.isInteger(lock.pid) && alive(lock.pid) && same(lock.pid) !== 'other'

  if (unitManaged) { // systemd then knows it is meant to be down and does not bring it back (Restart=on-failure)
    execTool('systemctl', ['--user', 'stop', UNIT_FILE_NAME], { run: exec, env, timeoutMs: termWaitMs })
    signals.push('systemctl-stop'); how = 'systemctl'
  }
  if (daemonUp()) {
    if (same(lock.pid) === 'unknown') problems.push(`pid ${lock.pid} cannot be told from another process (the lock has no start time, or /proc cannot be read), so it is not signalled`)
    else {
      how = 'signal'
      send(lock.pid, 'SIGTERM')
      await waitGone(daemonUp, termWaitMs)
      if (daemonUp() && same(lock.pid) === 'same') { send(lock.pid, 'SIGKILL'); await waitGone(daemonUp, 2000) }
    }
  }
  if (lock && Number.isInteger(lock.helper_pid) && alive(lock.helper_pid) && isHelper(lock.helper_pid, lock)) { // it exits with the daemon; this is for the one that outlived it
    if (how === 'none') how = 'signal'
    const up = () => alive(lock.helper_pid) && isHelper(lock.helper_pid, lock)
    send(lock.helper_pid, 'SIGTERM')
    await waitGone(up, Math.min(termWaitMs, 3000))
    if (up()) { send(lock.helper_pid, 'SIGKILL'); await waitGone(up, 2000) }
  }
  let unitUp = false
  if (unitManaged) {
    execTool('systemctl', ['--user', 'reset-failed', UNIT_FILE_NAME], { run: exec, env })
    const a = execTool('systemctl', ['--user', 'is-active', UNIT_FILE_NAME], { run: exec, env })
    unitUp = a.out === 'active' || a.out === 'activating'
    if (unitUp) problems.push(`systemctl --user is-active ${UNIT_FILE_NAME} says ${a.out}`)
  }
  const daemonStill = daemonUp()
  if (daemonStill && same(lock.pid) === 'same') problems.push(`pid ${lock.pid} is still running after ${signals.join(', ')}`)
  const helperStill = !!lock && !helperGone(lock, { alive, isHelper })
  if (helperStill) problems.push(`the helper (pid ${lock.helper_pid}) is still running`)
  const stopped = !daemonStill && !helperStill && !unitUp
  return { stopped, how, pid: lock ? lock.pid : null, helper_pid: lock && Number.isInteger(lock.helper_pid) ? lock.helper_pid : null, signals, ...(problems.length ? { error: problems.join('; ') } : {}) }
}
