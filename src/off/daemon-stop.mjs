// daemon-stop.mjs (src/off) — is this user's collector daemon there, and how to stop it when it has to go (RFC 1.6 §1.4 第 2 / 5 步, 「asight 自己坏了时」;
// 4.6 §控制面 `lock`). `asight off`, `asight uninstall` and the standalone `asight-off` ask first and stop only a daemon that does not answer
// (off) or has to go (uninstall); a daemon that answers is asked to switch off through its control socket instead (orchestrate.mjs).
//   daemonState   judges from the `lock` file (written at start, its mtime refreshed every second) and the control socket
//   stopDaemon    `systemctl --user stop asight-collector` when the autostart unit manages it (Linux), else SIGTERM, then SIGKILL after `termWaitMs`; on darwin the LaunchAgent is
//                 booted out FIRST when the plist manages it (launchd's KeepAlive would pull a stopped daemon right back, 4.9 §4), then the signals; on win32 the supervisor
//                 parent first, then the daemon, through taskkill. The pid's identity (the lock's start_time and boot_id) is checked before EVERY signal, so a lock that names a
//                 reused pid kills nothing; the helper (lock.helper_pid) goes with it when it is still there and is the helper; then `reset-failed` and `is-active` (Linux)
//   helperGone    the link of this instance is the helper's (unpinned when it exits): "the helper is gone" is "no link"
// The lock reader is src/health/read.mjs lockState, written here too (src/off imports nothing outside itself, 0.1 §2); test/off/daemon-stop.test.mjs
// holds the two to the same answers. Imports only node:* and src/off.
import nodeFs from 'node:fs'
import path from 'node:path'
import { execTool } from './exec.mjs'
import { controlRequest, isPipePath } from './control-client.mjs'
import { procIdentity, pidAlive, readArgv, readExe, winStartedAtOfTable } from './proc.mjs'
import { UNIT_FILE_NAME } from './autostart.mjs'
import { AGENT_LABEL, agentState, launchctl } from './darwin.mjs'

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
  const id = identity(lock.pid) || {} // on Windows this is answered out of the one process table the command already read (src/off/proc.mjs winIdentity)
  const verified = id.start_time != null && id.boot_id != null && lock.start_time != null && lock.boot_id != null // an older lock has neither
  if (verified && String(lock.boot_id) !== id.boot_id) return { state: 'stale', lock, why: 'the machine has rebooted since (boot id differs)', age_ms }
  if (verified && String(lock.start_time) !== id.start_time) return { state: 'stale', lock, why: `pid ${lock.pid} is another process now (start time differs)`, age_ms }
  return { state: age_ms > DAEMON_LOCK_FRESH_MS ? 'unresponsive' : 'running', lock, age_ms, ...(verified ? {} : { verified: false }) }
}

/** What there is to deal with → `{ state, lock, socket, reply?, reason?, age_ms? }` (`socket`: the one that answered, or null; `reply`: what its
 *  `GET /status` answered, for a caller that wants it — the probe below IS that question, so `status` does not ask it a second time, D62):
 *    none          no lock and nothing answers: no daemon
 *    stale         the lock names a process that is gone or is another one now, and nothing answers: no daemon (its helper may linger); or the lock was cut short
 *                  (empty or garbage: a crash or a power loss) and the control socket that was asked refuses: no daemon either, `lock` is null then
 *    running       it answers (GET /status)
 *    starting      a fresh lock, a live pid, and the control socket is not there yet
 *    unresponsive  the lock was not refreshed for 5 s, or the socket is there and does not answer in `timeoutMs`: stuck (1.6 §1.4 第 2 步)
 *    unknown       the lock cannot be read (an I/O error), or is cut short and there is no control socket to ask, and nothing answers: whether a daemon runs is
 *                  not known (never read as "none") */
export async function daemonState({ lockFile, socketPath = null, request = controlRequest, identity = procIdentity, alive = pidAlive, now = Date.now, fs = nodeFs, timeoutMs = 5000, platform = process.platform } = {}) {
  const L = readDaemonLock({ file: lockFile, now: now(), alive, identity, fs })
  const lock = L.lock || null
  let answered = false, hung = null, answeredOn = null, reply
  const sockets = [...new Set([socketPath, lock && lock.socket].filter(Boolean))].filter((sock) => platform !== 'win32' || isPipePath(sock)) // on win32 only a pipe is asked: a lock naming a unix path is not connected to
  let refused = 0
  for (const sock of sockets) {
    try { reply = await request({ socketPath: sock, method: 'GET', path: '/status', timeoutMs }); answered = true; answeredOn = sock; break } catch (e) {
      if (e && e.status) { answered = true; answeredOn = sock; break } // it answered, with an error: it is there
      if (e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED')) { refused++; continue } // nobody listens on it
      hung = String((e && e.message) || e)
    }
  }
  const out = (state, reason) => ({ state, lock, socket: answeredOn, ...(reply !== undefined ? { reply } : {}), ...(reason ? { reason } : {}), ...(L.age_ms != null ? { age_ms: L.age_ms } : {}) })
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

// ── the Windows stop (RFC 4.8 §4.2, §7; plan Task 9(b)) ──────────────────────────────────────────────────────────────────────
// `process.kill` on Windows is a hard kill with no drain and no kernel switch, and the supervised daemon would be re-spawned by its parent,
// so: the supervisor goes FIRST (supervisor.lock names its pid and start time, both checked before anything is signalled), then the daemon
// (from `lock`, identity checked as on the other platforms), each through `taskkill /PID <pid> /F` — this is the stuck-daemon path of 1.6
// §1.4 第 5 步, the hard kill is the point (a daemon that answers is asked through its control pipe by the caller, never by this).

/** The supervisor's lock, beside the daemon's (`<collector>/supervisor.lock`, written by arch/win32/autostart.mjs superviseChild).
 *  The test holds the name equal to the arch module's, which cannot be imported here (src/off imports only node:* and src/off, 0.1 §2). */
export const SUPERVISOR_LOCK = 'supervisor.lock'
/** The same 2 s as the arch module's LOCK_START_TOLERANCE_MS (the lock's start time is "now minus uptime", the OS's is the creation
 *  time: the same process agrees to within this). The test holds the two equal. */
export const SUPERVISOR_START_TOLERANCE_MS = 2000

/** Does the process a supervisor.lock names still run (4.8 §7)? The same fixed question, the same tolerance and the same answers as the arch
 *  module's `lockHolderAlive` (the test runs both against the same fake answers): `Get-Process -Id <pid>` → the start time as Unix ms, 'gone'
 *  for a pid that is not there. → true · false (gone, or another process now); throws when it cannot be told — and a caller that catches a
 *  throw kills nothing on a guess. A pid that is not a positive integer is a TypeError: it never reaches a command. */
export function supervisorHolderAlive({ pid, startedAt } = {}, { run = null, env = process.env, toleranceMs = SUPERVISOR_START_TOLERANCE_MS } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError(`supervisorHolderAlive needs a positive integer pid, got ${JSON.stringify(pid)}`)
  // The process table this command already read answers the same question (the same Win32_Process creation time): a pid it does not list is gone,
  // and one it lists carries its creation time. One `Get-Process` start less for every `off` on Windows (~306 ms measured, D62 / 1.6 §3.1).
  const seen = winStartedAtOfTable(pid)
  if (seen === null) return false
  if (seen !== undefined) return Math.abs(seen - startedAt) <= toleranceMs
  const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { 'gone' } else { try { [DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() } catch { 'unreadable' } }`
  const r = execTool('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { run, env })
  if (r.code !== 0) throw new Error(`the start time of pid ${pid} could not be asked: powershell ${r.code === null ? 'did not run' : `exited ${r.code}`}${r.err ? ` (${r.err.slice(0, 200)})` : ''}`)
  if (r.out === 'gone') return false
  if (!/^\d{10,}$/.test(r.out)) throw new Error(`the start time of pid ${pid} could not be read: powershell answered ${JSON.stringify(r.out.slice(0, 60))}`)
  return Math.abs(Number(r.out) - startedAt) <= toleranceMs
}

/** supervisor.lock read as superviseChild wrote it: `{ pid, startedAt }`, or null when it is not there or names nothing usable (a lock cut
 *  short by a crash reads as absent; the caller says so and kills nothing on a guess). */
function readSupervisorLock({ file, fs = nodeFs } = {}) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Number.isSafeInteger(o.pid) && o.pid > 0 && Number.isFinite(o.startedAt) ? { pid: o.pid, startedAt: o.startedAt } : null
  } catch { return null }
}

/** Invariant 5: a supervisor.lock whose holder is proven gone (`supervisorHolderAlive` false: the pid is dead, or another process now) is removed —
 *  a supervisor killed by taskkill /F never runs its own removeLock. A holder that still runs, or one that cannot be told, keeps its lock (nothing on a
 *  guess). `lockFile` is the daemon's lock; the supervisor's is beside it. → { removed: boolean, why? }. */
export function clearStaleSupervisorLock({ lockFile, exec = null, env = process.env, fs = nodeFs } = {}) {
  const file = path.join(path.dirname(lockFile), SUPERVISOR_LOCK)
  const sup = readSupervisorLock({ file, fs })
  if (!sup) return { removed: false }
  let alive
  try { alive = supervisorHolderAlive(sup, { run: exec, env }) } catch (e) { return { removed: false, why: String((e && e.message) || e) } }
  if (alive) return { removed: false, why: `the supervisor (pid ${sup.pid}) still runs` }
  try { const now = readSupervisorLock({ file, fs }); if (now && now.pid === sup.pid && now.startedAt === sup.startedAt) fs.rmSync(file, { force: true }) } catch (e) { return { removed: false, why: `${file} could not be removed (${(e && e.code) || e})` } }
  return { removed: true }
}

/** The Windows half of stopping: the supervisor parent first, then the daemon, both through taskkill (see the block comment above).
 *  `exec` runs taskkill and the powershell questions (a test injects it; execTool refuses the real ones under npm test). → the same shape
 *  stopDaemon gives: `{ stopped, how: 'taskkill' | 'none', pid, helper_pid, signals, error? }`. */
async function stopDaemonWin32({ lockFile, exec = null, alive = pidAlive, identity = procIdentity, fs = nodeFs, env = process.env, sleep = stopSleep, now = Date.now, termWaitMs = 10000 }) {
  const L = readDaemonLock({ file: lockFile, now: now(), alive, identity, fs })
  const lock = L.lock || null
  const problems = []
  const signals = []
  let how = 'none'
  const waitGone = async (test, ms) => { for (const end = now() + ms; test() && now() < end;) await sleep(25) }
  const taskkill = (pid, what) => { // one process, never a tree: the kernel draining under the daemon is not the stuck daemon's to lose
    execTool('taskkill', ['/PID', String(pid), '/F'], { run: exec, env })
    signals.push(`taskkill-${what}`); how = 'taskkill'
  }

  const supFile = path.join(path.dirname(lockFile), SUPERVISOR_LOCK)
  const sup = readSupervisorLock({ file: supFile, fs })
  if (sup) {
    let holder
    try { holder = supervisorHolderAlive(sup, { run: exec, env }) } catch (e) { problems.push(`the supervisor (pid ${sup.pid}) could not be told from another process (${String((e && e.message) || e)}), so it is not killed: it may re-spawn the daemon; stop it by hand`) }
    if (holder === true) taskkill(sup.pid, 'supervisor')
    else if (holder === false) { /* a stale lock, or a reused pid: nothing to kill, the daemon goes next */ }
  } else if (fs.existsSync(supFile)) problems.push(`${supFile} cannot be read as a supervisor lock, so the supervisor is not killed: it may re-spawn the daemon; stop it by hand`)

  const same = (pid) => {
    const id = identity(pid) || {}
    if (lock.start_time == null || lock.boot_id == null || id.start_time == null || id.boot_id == null) return 'unknown'
    return String(lock.boot_id) === id.boot_id && String(lock.start_time) === id.start_time ? 'same' : 'other'
  }
  const daemonUp = () => !!lock && Number.isInteger(lock.pid) && alive(lock.pid) && same(lock.pid) !== 'other'
  if (daemonUp()) {
    if (same(lock.pid) === 'unknown') problems.push(`pid ${lock.pid} cannot be told from another process (the lock has no start time, or the identity could not be read), so it is not signalled`)
    else { taskkill(lock.pid, 'daemon'); await waitGone(daemonUp, Math.min(termWaitMs, 3000)) }
  }
  const daemonStill = lock != null && alive(lock.pid) && same(lock.pid) !== 'other'
  if (daemonStill) problems.push(`pid ${lock && lock.pid} is still running after ${signals.join(', ') || 'nothing was signalled'}`)
  if (sup) { const c = clearStaleSupervisorLock({ lockFile, exec, env, fs }); if (c.removed) signals.push('supervisor-lock-removed') } // a supervisor taskkill /F ended never removes its own lock
  if (L.state === 'unknown') problems.push(`${L.error}, so which process to stop is not known`)
  const stopped = !daemonStill
  return { stopped, how, pid: lock ? lock.pid : null, helper_pid: lock && Number.isInteger(lock.helper_pid) ? lock.helper_pid : null, signals, ...(problems.length ? { error: problems.join('; ') } : {}) }
}

/** Stops the daemon of this user and its helper → `{ stopped, how: 'systemctl' | 'signal' | 'taskkill' | 'none', pid, helper_pid, signals: [...], error? }`.
 *  `stopped` is true when the daemon and its helper are gone and the unit is neither active nor activating. A pid the lock names is signalled only
 *  after its identity matched the lock (a lock without start_time, or an unreadable /proc, is "cannot tell": nothing is signalled, `error` says so).
 *  On win32 (`platform: 'win32'`): the supervisor parent first, then the daemon, through taskkill — see stopDaemonWin32. */
export async function stopDaemon({ lockFile, socketPath = null, exec = null, kill = defaultKill, alive = pidAlive, identity = procIdentity, isHelper = isRedirectorHelper, unitManaged = false, termWaitMs = 10000, sleep = stopSleep, now = Date.now, fs = nodeFs, env = process.env, platform = process.platform } = {}) {
  if (platform === 'win32') return stopDaemonWin32({ lockFile, exec, alive, identity, fs, env, sleep, now, termWaitMs })
  const L = readDaemonLock({ file: lockFile, now: now(), alive, identity, fs })
  const lock = L.lock || null
  const signals = []
  const problems = []
  let how = 'none'
  let agentStillManaged = false // darwin: the bootout did not happen or failed, so launchd's KeepAlive may still restart the daemon
  if (L.state === 'unknown') problems.push(`${L.error}, so which process to stop is not known`)
  const same = (pid) => { // the lock's pid is still the process the lock was written for?
    const id = identity(pid) || {}
    if (lock.start_time == null || lock.boot_id == null || id.start_time == null || id.boot_id == null) return 'unknown'
    return String(lock.boot_id) === id.boot_id && String(lock.start_time) === id.start_time ? 'same' : 'other'
  }
  const waitGone = async (test, ms) => { for (const end = now() + ms; test() && now() < end;) await sleep(25) }
  const send = (pid, signal) => { try { kill(pid, signal) } catch (e) { if (e && e.code === 'ESANDBOX') throw e; if (!e || e.code !== 'ESRCH') problems.push(`${signal} to pid ${pid} failed (${String((e && e.code) || (e && e.message) || e)})`) } signals.push(signal) }
  const daemonUp = () => !!lock && Number.isInteger(lock.pid) && alive(lock.pid) && same(lock.pid) !== 'other'

  if (unitManaged && platform === 'darwin') { // launchd owns the restart (KeepAlive really does pull a killed daemon back, 4.9 §4): the agent is booted out of the session
    // BEFORE any signal, so what is stopped stays stopped. The plist stays in ~/Library/LaunchAgents — the next login brings the job back, the same temporary
    // stop `systemctl --user stop` is on Linux; the full undo (bootout AND the plist) is a no-names off's step 5 (src/off/darwin.mjs undoAutostart).
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1
    // no `launchctl disable` anywhere in an off (D61): a bootout is for THIS session only (the plist stays, the next login loads it again), while
    // `disable` persists and would leave a rebooted machine without the daemon the agents' rewritten configs point at. A draining daemon never
    // reaches this path: it exits itself.
    const q = agentState({ exec, env, uid })
    if (q.state === 'present') {
      // the SLASH form (`gui/<uid>/<label>`, one argument — the rule `launchctl` in darwin.mjs carries): the two-argument
      // form answered I/O error 5 on every job (measured on a macOS test machine, 2026-10-11) and KeepAlive pulled the drained daemon back —
      // an `off` that said it stopped it while a fresh pid came up seconds later
      const r = launchctl(['bootout', `gui/${uid}/${AGENT_LABEL}`], { run: exec, env })
      if (r.code === 0) { signals.push('launchctl-bootout'); how = 'launchctl' }
      else { agentStillManaged = true; problems.push(`launchctl bootout of ${AGENT_LABEL} failed (${r.code === null ? r.err || 'it did not run' : `exit ${r.code}${r.err ? `: ${r.err.slice(0, 200)}` : ''}`}); launchd's KeepAlive may bring the daemon back`) }
    } else if (q.state === 'unknown') { agentStillManaged = true; problems.push(`whether the LaunchAgent is loaded is not known (${q.err}); nothing was booted out on a guess, and launchd's KeepAlive may bring the daemon back`) }
    // absent: nothing to boot out — the daemon was not started by the agent (a direct start by `on`, or the session ended)
  } else if (unitManaged) { // systemd then knows it is meant to be down and does not bring it back (Restart=on-failure)
    execTool('systemctl', ['--user', 'stop', UNIT_FILE_NAME], { run: exec, env, timeoutMs: termWaitMs })
    signals.push('systemctl-stop'); how = 'systemctl'
  }
  if (daemonUp()) {
    if (same(lock.pid) === 'unknown') problems.push(`pid ${lock.pid} cannot be told from another process (the lock has no start time${platform === 'linux' ? ', or /proc cannot be read' : ''}), so it is not signalled`)
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
  if (unitManaged && platform === 'darwin') unitUp = agentStillManaged
  else if (unitManaged) {
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
