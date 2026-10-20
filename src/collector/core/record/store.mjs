// store.mjs — the collector's append-only record store (RFC 4.6 §记录). Envelopes go to the raw layer's current
// segment, `<raw>/<segment>.ndjson` (D60①: a new segment at every start, closed at 128 MB and at stop, sealed from
// there by the daemon); transparent/spliced flows, audit and replays go to the collector's own dated subdirectories so
// the raw layer only ever holds envelopes. Directories are 0700, files 0600 (they hold verbatim credentials).
// Recording MUST NEVER throw into the forwarding path: every write is wrapped, failures are counted and reported via
// onError, never rethrown.
import fs from 'node:fs'
import path from 'node:path'
import { rawHome } from '../../../paths.mjs'
import { SEGMENT_BYTES, segmentName, parseSegment, recordId } from './segments.mjs'

export function createRecordStore({ root, raw = rawHome(path.dirname(root)), segmentBytes = SEGMENT_BYTES, onError = () => {}, now = () => new Date() }) {
  const fds = new Map() // filePath → open fd (only the current day's files, and the current segment)
  let errors = 0, openDay = null
  let lastError = null // the reason of the last failed write, for the caller's failure record (RFC 4.6 §记录 采集失败不静默)
  let segment = null, segFile = null, segBytes = 0, segLines = 0
  const onClosed = [] // the seal queue hangs here (4.6 §记录 自动封存)
  const onWrote = [] // the index keeper hangs here (D62): told the segment a line was just appended to
  const onChange = [] // the live segment changed: the daemon writes it into the lock there (see openSegment, closeSegment)
  const report = (e, file) => { errors++; lastError = e; if (file && e && typeof e === 'object' && !e.file) e.file = file; onError(e) }
  const closeAll = () => { for (const fd of fds.values()) { try { fs.closeSync(fd) } catch { /* already closed */ } } fds.clear() }
  // A day that has ended: the previous day's files get no more lines, so their fds are fsync'd and closed. A daemon
  // that runs for months holds one day's files open, not one set per day it has run.
  function closeDay() {
    for (const [f, fd] of fds) { if (f === segFile) continue; try { fs.fsyncSync(fd) } catch (e) { report(e, f) } try { fs.closeSync(fd) } catch { /* already closed */ } fds.delete(f) }
  }

  // The daily file is the UTC date at WRITE time, not rec.ts (the request start, which stays in the
  // record). An envelope is written when its exchange ends, so a call that starts before midnight and
  // ends after it goes into the new day's file. Dated by write time, an earlier file is never appended
  // to after a later one exists. `now` is injectable for tests only.
  const today = () => now().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)

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

  // A new segment, never an existing one: a segment on disk is closed for good, so a crash's half line stays as it is
  // and a reader's line numbers (the record ids) never shift under it. The name is announced to onChange BEFORE the
  // file exists (invariant 2: a sealer that believed the live segment closed would delete its plaintext, so the lock
  // must name the new segment no later than its first byte — not on the next timer tick), and the file is created with
  // 'ax', so two writers on one home can never share a name and a restart never appends to an old file.
  function openSegment() {
    fs.mkdirSync(raw, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(raw, 0o700) } catch { /* a raw/ from an older version, or one we do not own */ }
    const taken = fs.readdirSync(raw).map(parseSegment).filter(Boolean).map((s) => s.segment)
    const at = now()
    for (;;) {
      segment = segmentName(at, taken)
      segFile = path.join(raw, `${segment}.ndjson`)
      announce(segment, segFile)
      let fd
      try { fd = fs.openSync(segFile, 'ax', 0o600) } catch (e) {
        if (e.code !== 'EEXIST') throw e // reported by the caller; the next envelope tries again
        taken.push(segment) // a name the directory scan missed (another writer, a scan race): take the next suffix
        continue
      }
      try { fs.fchmodSync(fd, 0o600) } catch { /* some filesystems refuse chmod */ }
      fds.set(segFile, fd)
      segBytes = 0; segLines = 0
      return
    }
  }
  const announce = (seg, file) => { for (const cb of onChange) { try { cb(seg) } catch (e) { report(e, file) } } } // never breaks the capture
  /** fsync, close, and hand the path to the seal queue. The next envelope opens the next segment. The lock is told
   *  BEFORE the queue (invariant 2, D60): the queue forks a sealer at once, and a lock left naming the closed segment
   *  until the next timer tick made it refuse that segment until the next start (a macOS machine, 2026-10-20). */
  function closeSegment() {
    if (!segFile) return
    const file = segFile, fd = fds.get(file)
    if (fd !== undefined) { try { fs.fsyncSync(fd) } catch (e) { report(e, file) } try { fs.closeSync(fd) } catch { /* already closed */ } fds.delete(file) }
    segment = null; segFile = null; segBytes = 0; segLines = 0
    announce(null, file)
    for (const cb of onClosed) { try { cb(file) } catch (e) { report(e, file) } }
  }

  // true once the line is written; false (counted, reported) when it is not.
  function write(resolve, rec) {
    try {
      // The day never goes back (4.6 §记录): a clock set back keeps writing today's file, never appends to an earlier one.
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
    // { ok: true, id: '<segment>:<line>' } once the line is in the segment; { ok: false } when it is not (counted,
    // reported). The WebSocket recorder marks the calls after a lost envelope partial (4.6 §传输与帧级记录, write-failed).
    envelope(env) {
      try {
        // ONE utf-8 encode: `Buffer.byteLength` on the string used to scan it a second time only to count it, and
        // writeSync encodes it a third (D62: ~0.3 ms per MB of record, a macOS machine).
        const line = Buffer.from(`${JSON.stringify(env)}\n`, 'utf8')
        if (!segFile) openSegment()
        const offset = segBytes
        fs.writeSync(fdFor(segFile), line)
        segBytes += line.length; segLines++
        const id = recordId(segment, segLines)
        // before the rollover below, so the name is the segment this line went into, never null (D62)
        // the keeper hangs here (D62) and never throws (index-keeper.mjs `wrote`): a listener that did would be
        // counted below as a `record-error`, which this line is not — the record is already in the segment.
        // The facts are what the keeper needs to index this line WITHOUT reading it back: where it starts, its line
        // number, its bytes without the newline (the index's `stored_bytes`), and the envelope itself.
        for (const cb of onWrote) { try { cb(segment, { lineNo: segLines, offset, storedBytes: line.length - 1, env }) } catch (e) { report(e, segFile) } }
        if (segBytes >= segmentBytes) closeSegment()
        return { ok: true, id }
      } catch (e) {
        report(e, segFile)
        // the next envelope opens a fresh segment, not this broken one; closeSegment releases the fd and hands the
        // segment to the seal queue (its half line stays as it is, 4.6 §记录)
        closeSegment()
        return { ok: false }
      }
    },
    flow(rec) { return write((d) => path.join(root, 'flows', `${d}.ndjson`), rec) }, // false = not written (D38: the engine records that)
    audit(rec) { write((d) => path.join(root, 'audit', `${d}.ndjson`), rec) },
    replay(env) { write((d) => path.join(root, 'replays', `${d}.ndjson`), env) },
    onSegmentClosed(cb) { onClosed.push(cb) },
    /** cb(segment) right before a segment's file is created, and cb(null) once it is closed, before onSegmentClosed
     *  hears of it — the daemon rewrites the lock there, so a sealer never sees a stale live segment (D60, invariant 2). */
    onSegmentChange(cb) { onChange.push(cb) },
    /** cb(segment, facts) once a line is in that segment — the index keeper's trigger (D62). facts = { lineNo,
     *  offset, storedBytes, env }: everything needed to index that line without reading it back. */
    onRecord(cb) { onWrote.push(cb) },
    get currentSegment() { return segment },
    get lastError() { return lastError },
    get errors() { return errors },
    get openFiles() { return fds.size },
    close() { closeSegment(); closeAll(); openDay = null },
  }
}
