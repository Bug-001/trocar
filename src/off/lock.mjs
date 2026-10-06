// lock.mjs (src/off) — the one lock of the commands that change state (RFC 1.6 R12): ~/.asight/collector/op.lock, written O_EXCL as
// `{pid, start_time, boot_id}` (start_time and boot_id are what src/off/proc.mjs procIdentity reads; null where /proc is not there). Only one
// of `on` / `off` / `uninstall` runs at a time. A lock whose pid is dead, or is another process now (its start time or the boot differs), is
// stale: it is taken over, never waited for. `off` has priority: when the lock is held its `offFirst` runs once, before the wait — it writes
// `desired:'off'` for the harnesses asked for — so an `on` that is mid-way sees the off at its next guard and stops (R12), and the lock is
// free soon after. Nothing here knows what a command does with it. Imports only node:* and src/off (0.1 §2).
import nodeFs from 'node:fs'
import path from 'node:path'
import { procIdentity, pidAlive } from './proc.mjs'

/** The `code` of the error `acquireOpLock` throws when the wait ran out (an Error's code, not a `flows/` record's). */
export const LOCK_BUSY = 'locked'

const LOCK_POLL_MS = 25
const LOCK_WRITE_GRACE_MS = 2000 // a lock file with no pid in it that is younger than this is a holder still writing it, not a crash

const lockSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The lock file as it is now → null (there is none) | { holder, stale, why }. `holder` is what it names (null when it names no pid).
function readLockHolder({ file, fs, alive, identity, now }) {
  let text, mtimeMs
  try { text = fs.readFileSync(file, 'utf8'); mtimeMs = fs.statSync(file).mtimeMs } catch (e) { if (e && e.code === 'ENOENT') return null; throw e }
  let holder = null
  try { holder = JSON.parse(text) } catch { /* below */ }
  if (!holder || !Number.isInteger(holder.pid)) return { holder: null, stale: now() - mtimeMs > LOCK_WRITE_GRACE_MS, why: `${file} names no pid` }
  if (!alive(holder.pid)) return { holder, stale: true, why: `pid ${holder.pid} is not running` }
  const id = identity(holder.pid) || {}
  if (holder.boot_id != null && id.boot_id != null && String(holder.boot_id) !== id.boot_id) return { holder, stale: true, why: 'the machine has rebooted since (boot id differs)' }
  if (holder.start_time != null && id.start_time != null && String(holder.start_time) !== id.start_time) return { holder, stale: true, why: `pid ${holder.pid} is another process now (start time differs)` }
  return { holder, stale: false }
}

/** One try, no wait → `{ lock: { release() }, holder: null }` when it is ours, or `{ lock: null, holder }` when someone else's live command holds it
 *  (`holder`: what the file names, or null when it is being written). A stale lock is removed and taken. Throws what the filesystem throws. */
export function tryOpLock({ file, identity = procIdentity, alive = pidAlive, fs = nodeFs, now = Date.now, pid = process.pid } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const me = identity(pid) || {}
  const mine = { pid, start_time: me.start_time ?? null, boot_id: me.boot_id ?? null }
  for (let tries = 0; tries < 5; tries++) {
    let fd
    try { fd = fs.openSync(file, 'wx', 0o600) } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e
      const seen = readLockHolder({ file, fs, alive, identity, now })
      if (seen === null) continue // released between the two calls
      if (!seen.stale) return { lock: null, holder: seen.holder }
      const again = readLockHolder({ file, fs, alive, identity, now }) // judged again right before removing: a fresh lock someone just took is not ours to remove
      if (again && again.stale) fs.rmSync(file, { force: true })
      continue
    }
    try { fs.writeSync(fd, JSON.stringify(mine) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    let released = false
    return { lock: { release() {
      if (released) return
      released = true
      try { const h = JSON.parse(fs.readFileSync(file, 'utf8')); if (h && h.pid === mine.pid && (h.start_time ?? null) === mine.start_time) fs.rmSync(file, { force: true }) } catch { /* gone, or not ours any more */ }
    } }, holder: null }
  }
  return { lock: null, holder: null }
}

/** The lock, waiting up to `waitMs` for the command that holds it. `offFirst(holder)` runs once, before the first wait, when the lock is held (off
 *  priority, R12). → `{ release() }`. Timeout → throws `code: LOCK_BUSY` (`'locked'`) with `holder` (what the file names). */
export async function acquireOpLock({ file, identity = procIdentity, alive = pidAlive, waitMs = 0, offFirst = null, fs = nodeFs, now = Date.now, sleep = lockSleep, pid = process.pid } = {}) {
  const end = now() + waitMs
  let asked = false
  for (;;) {
    const got = tryOpLock({ file, identity, alive, fs, now, pid })
    if (got.lock) return got.lock
    if (offFirst && !asked) { asked = true; await offFirst(got.holder) }
    if (now() >= end) {
      const who = got.holder ? `pid ${got.holder.pid}` : 'another process'
      throw Object.assign(new Error(`another asight command (${who}) holds ${file}; wait for it to finish, or look at what it is (a stale lock of a dead process is taken over by itself)`), { code: LOCK_BUSY, holder: got.holder })
    }
    await sleep(Math.max(1, Math.min(LOCK_POLL_MS, end - now())))
  }
}
