// store.mjs — the collector's append-only record store (RFC 4.6 §记录). Envelopes go to the
// top-level capture-<date>.ndjson the board reads; transparent/spliced flows, audit and replays go
// to subdirectories so the board never mistakes them for envelopes. Directories are 0700, files
// 0600 (they hold verbatim credentials). Recording MUST NEVER throw into the forwarding path: every
// write is wrapped, failures are counted and reported via onError, never rethrown.
import fs from 'node:fs'
import path from 'node:path'
import { markClosed, closedMarkerPath } from '../../../raw/closed.mjs'

// D35 close marker at rollover: files only this store writes. flows/ also has the event writer (events.mjs, its own
// descriptor), so this store cannot declare it closed (whether flows/ is sealed at all is a 4.6 OPEN).
const SEALABLE = (file) => !file.split(path.sep).includes('flows')

export function createRecordStore({ root, onError = () => {}, now = () => new Date() }) {
  const fds = new Map() // filePath → open fd (only the current day's files)
  let errors = 0, openDay = null
  let lastError = null // the reason of the last failed write, for the caller's failure record (RFC 4.6 §记录 采集失败不静默)
  const closeAll = () => { for (const fd of fds.values()) { try { fs.closeSync(fd) } catch { /* already closed */ } } fds.clear() }
  // A day that has ended (D-35): every file is fsync'd and closed, then the ones only this store writes get their
  // close marker, so the sealer may take them (4.6 §日志体积预算「已关闭」). A marker that cannot be made is a failure
  // record (the file stays unsealable, never silently).
  function closeDay() {
    const files = [...fds.keys()]
    for (const [f, fd] of fds) { try { fs.fsyncSync(fd) } catch (e) { report(e, f) } try { fs.closeSync(fd) } catch { /* already closed */ } }
    fds.clear()
    for (const f of files.filter(SEALABLE)) { try { markClosed(f) } catch (e) { report(Object.assign(new Error(`${f}: the close marker could not be written (${e.message}); the sealer will refuse this file`), { code: e.code }), f) } }
  }
  const report = (e, file) => { errors++; lastError = e; if (file && e && typeof e === 'object' && !e.file) e.file = file; onError(e) }
  // When the store is created (the daemon starts): an earlier day's capture / audit / replays file still without its
  // marker was left by a daemon that stopped before midnight and never rolled over — nobody holds it now (one daemon
  // per user), so it is fsync'd and marked closed here, else it could never be sealed (4.6 §记录).
  function closeEarlierDays(day) {
    const DAY_FILE = /^(?:capture-)?(\d{4}-\d{2}-\d{2})\.ndjson$/
    for (const [dir, prefix] of [[root, 'capture-'], [path.join(root, 'audit'), ''], [path.join(root, 'replays'), '']]) {
      let names
      try { names = fs.readdirSync(dir) } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') report(e, dir); continue }
      for (const n of names) {
        const m = DAY_FILE.exec(n)
        if (!m || !n.startsWith(prefix) || m[1] >= day) continue
        const f = path.join(dir, n)
        if (fs.existsSync(closedMarkerPath(f))) continue
        try { const fd = fs.openSync(f, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } markClosed(f) } catch (e) {
          report(Object.assign(new Error(`${f}: the close marker could not be written (${e.message}); the sealer will refuse this file`), { code: e.code }), f)
        }
      }
    }
  }

  // The daily file is the UTC date at WRITE time, not rec.ts (the request start, which stays in the
  // record). An envelope is written when its exchange ends, so a call that starts before midnight and
  // ends after it goes into the new day's file. Dating by rec.ts appended it to the previous day's file
  // after the next day's file already held later calls of the same session, and the ETL's
  // per-session record-count watermark (RFC 4.2:49) then skipped it. Dated by write time, an earlier
  // file is never appended to after a later one exists. `now` is injectable for tests only.
  const today = () => now().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
  closeEarlierDays(today())

  // a file renamed or deleted while open is reopened before the next write (never written into an orphan inode),
  // and that is a failure record (`file-replaced`).
  function fdFor(filePath) {
    let fd = fds.get(filePath)
    if (fd !== undefined) {
      let now = null
      try { now = fs.statSync(filePath) } catch { /* gone */ }
      const was = fs.fstatSync(fd)
      if (now && now.ino === was.ino && now.dev === was.dev) return fd
      try { fs.closeSync(fd) } catch { /* already closed */ }
      fds.delete(filePath)
      report(Object.assign(new Error(`${filePath} was ${now ? 'replaced' : 'renamed or deleted'} while the collector had it open; a new file is opened at that path`), { code: 'file-replaced' }), filePath)
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    fd = fs.openSync(filePath, 'a', 0o600)
    try { fs.fchmodSync(fd, 0o600) } catch { /* some filesystems refuse chmod */ }
    fds.set(filePath, fd)
    return fd
  }

  // true once the line is written; false (counted, reported) when it is not. The WebSocket recorder
  // marks the calls after a lost envelope partial (RFC 4.6 §传输与帧级记录, write-failed).
  function write(resolve, rec) {
    try {
      // A new day: the previous day's files get no more lines, so their fds are closed and marked closed. A daemon
      // that runs for months holds one day's files open, not one set per day it has run. The day never goes back
      // (4.6 §记录): a clock set back keeps writing today's file, never appends to an earlier, maybe sealed, one.
      const d = openDay && today() < openDay ? openDay : today()
      if (d !== openDay) { if (openDay) closeDay(); openDay = d }
      fs.writeSync(fdFor(resolve(d)), JSON.stringify(rec) + '\n')
      return true
    } catch (e) {
      report(e)
      return false
    }
  }

  return {
    envelope(env) { return write((d) => path.join(root, `capture-${d}.ndjson`), env) },
    flow(rec) { return write((d) => path.join(root, 'flows', `${d}.ndjson`), rec) }, // false = not written (D38: the engine records that)
    audit(rec) { write((d) => path.join(root, 'audit', `${d}.ndjson`), rec) },
    replay(env) { write((d) => path.join(root, 'replays', `${d}.ndjson`), env) },
    get lastError() { return lastError },
    get errors() { return errors },
    get openFiles() { return fds.size },
    close() { closeAll(); openDay = null },
  }
}
