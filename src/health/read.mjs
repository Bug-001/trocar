// read.mjs — capture health read from disk (D38; RFC 4.6 §控制面 `lock`, §记录「看得到」). Whether the collector daemon
// runs is judged from ~/.asight/collector/lock alone — `asight collector status`, uninstall and (stage D2) the board
// never ask the daemon's socket for it, so a dead or stuck daemon is still reported.
//   lock = {pid, start_time, boot_id, helper_pid, engine_port, socket}: start_time is /proc/<pid>/stat field 22
// (clock ticks since boot), boot_id /proc/sys/kernel/random/boot_id; the daemon refreshes the file's mtime every
// 1 s. A pid is reused and a lock survives a reboot, so "running" needs all three to match and a fresh mtime.
// Node built-ins only (0.1 §2).
import nodeFs from 'node:fs'
import path from 'node:path'

export const LOCK_FRESH_MS = 5000

/** {start_time, boot_id} of a live process (strings), each null when it cannot be read (no /proc, gone, EACCES). */
export function procIdentity(pid, { root = '/proc', fs = nodeFs } = {}) {
  let start_time = null, boot_id = null
  try {
    const stat = fs.readFileSync(path.join(root, String(pid), 'stat'), 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/) // field 3 onward: comm may hold ')' or spaces
    if (/^\d+$/.test(f[19] || '')) start_time = f[19]
  } catch { /* gone or no /proc: start_time stays null, and the judge below says so */ }
  try { boot_id = fs.readFileSync(path.join(root, 'sys', 'kernel', 'random', 'boot_id'), 'utf8').trim() || null } catch { /* no /proc */ }
  return { start_time, boot_id }
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

/**
 * lockState({file}) → {state, …}:
 *   'none'          no lock: the daemon stopped cleanly, or never ran
 *   'unknown'       the lock is unreadable ({error}): whether a daemon runs cannot be said
 *   'stale'         a lock whose daemon is gone ({why}: pid dead, or its start time / boot id is another process's)
 *   'unresponsive'  that daemon's process is there but has not refreshed the lock for over 5 s ({age_ms}): stuck
 *   'running'       pid, start time and boot id match and the lock is fresh ({age_ms})
 * Every state but 'none' carries `lock` when it could be read; `verified:false` when this OS has no /proc to check
 * the start time and boot id against (then only the pid and the freshness were judged).
 */
export function lockState({ file, now = Date.now(), alive = pidAlive, identity = procIdentity, fs = nodeFs } = {}) {
  let text, mtimeMs
  try { text = fs.readFileSync(file, 'utf8'); mtimeMs = fs.statSync(file).mtimeMs } catch (e) {
    if (e.code === 'ENOENT') return { state: 'none' }
    return { state: 'unknown', error: `${file}: ${String(e.message || e)}` }
  }
  let lock
  try { lock = JSON.parse(text) } catch (e) { return { state: 'unknown', error: `${file} is not valid JSON (${e.message}): cut short by a crash or power loss?` } }
  if (!lock || !Number.isInteger(lock.pid)) return { state: 'unknown', error: `${file} names no pid` }
  const age_ms = Math.max(0, Math.round(now - mtimeMs))
  if (!alive(lock.pid)) return { state: 'stale', lock, why: `pid ${lock.pid} is not running`, age_ms }
  const id = identity(lock.pid)
  const verified = id.start_time != null && id.boot_id != null && lock.start_time != null && lock.boot_id != null // an older lock has neither
  if (verified && String(lock.boot_id) !== id.boot_id) return { state: 'stale', lock, why: 'the machine has rebooted since (boot id differs)', age_ms }
  if (verified && String(lock.start_time) !== id.start_time) return { state: 'stale', lock, why: `pid ${lock.pid} is another process now (start time differs)`, age_ms }
  return { state: age_ms > LOCK_FRESH_MS ? 'unresponsive' : 'running', lock, age_ms, ...(verified ? {} : { verified: false }) }
}
