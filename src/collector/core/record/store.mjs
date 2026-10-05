// store.mjs — the collector's append-only record store (RFC 4.6 §记录). Envelopes go to the
// top-level capture-<date>.ndjson the board reads; transparent/spliced flows, audit and replays go
// to subdirectories so the board never mistakes them for envelopes. Directories are 0700, files
// 0600 (they hold verbatim credentials). Recording MUST NEVER throw into the forwarding path: every
// write is wrapped, failures are counted and reported via onError, never rethrown.
import fs from 'node:fs'
import path from 'node:path'

export function createRecordStore({ root, onError = () => {}, now = () => new Date() }) {
  const fds = new Map() // filePath → open fd (only the current day's files)
  let errors = 0, openDay = null
  let lastError = null // the reason of the last failed write, for the caller's failure record (RFC 4.6 §记录 采集失败不静默)
  const closeAll = () => { for (const fd of fds.values()) { try { fs.closeSync(fd) } catch { /* already closed */ } } fds.clear() }

  // The daily file is the UTC date at WRITE time, not rec.ts (the request start, which stays in the
  // record). An envelope is written when its exchange ends, so a call that starts before midnight and
  // ends after it goes into the new day's file. Dating by rec.ts appended it to the previous day's file
  // after the next day's file already held later calls of the same session, and the ETL's
  // per-session record-count watermark (RFC 4.2:49) then skipped it. Dated by write time, an earlier
  // file is never appended to after a later one exists. `now` is injectable for tests only.
  const today = () => now().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)

  function fdFor(filePath) {
    let fd = fds.get(filePath)
    if (fd !== undefined) return fd
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
      const d = today()
      // A new day: the previous day's files get no more lines, so their fds are closed. A daemon that
      // runs for months holds one day's files open, not one set per day it has run.
      if (d !== openDay) { closeAll(); openDay = d }
      fs.writeSync(fdFor(resolve(d)), JSON.stringify(rec) + '\n')
      return true
    } catch (e) {
      errors++
      lastError = e
      onError(e)
      return false
    }
  }

  return {
    envelope(env) { return write((d) => path.join(root, `capture-${d}.ndjson`), env) },
    flow(rec) { return write((d) => path.join(root, 'flows', `${d}.ndjson`), rec) }, // false = not written (D38: the engine records that)
    audit(rec) { write((d) => path.join(root, 'audit', `${d}.ndjson`), rec) },
    replay(env) { write((d) => path.join(root, 'replays', `${d}.ndjson`), env) },
    failure(rec) { return write((d) => path.join(root, 'failures', `${d}.ndjson`), rec) }, // capture failures, never silent (RFC 4.6 §记录)
    get lastError() { return lastError },
    get errors() { return errors },
    get openFiles() { return fds.size },
    close() { closeAll(); openDay = null },
  }
}
