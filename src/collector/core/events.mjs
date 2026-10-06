// events.mjs — durable failure records (D38: a capture failure is never silent).
// Every failure the collector owns becomes one JSON line `{ts, event, reason, …}` in <collector>/flows/<UTC date>.ndjson
// (RFC 4.6 §记录: the board never reads flows/, so these are never mistaken for envelopes). appendEvent writes with its
// own descriptor, so a record store whose files broke can still report that it broke. recentFailures reads them
// back for `asight collector status`, also when no daemon is running.
import nodeFs from 'node:fs'
import path from 'node:path'
import { isFailure } from '../../health/codes.mjs'

// The closed sets and the failure / expected split live in src/health/codes.mjs (D38: writers and readers share them).
export { isFailure }

export function appendEvent(dir, rec, { now = new Date(), fs = nodeFs } = {}) {
  const file = path.join(dir, 'flows', `${now.toISOString().slice(0, 10)}.ndjson`)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.appendFileSync(file, JSON.stringify({ ts: now.toISOString(), ...rec }) + '\n', { mode: 0o600 })
}

// The failure records of the last `files` day files, newest last (at most `limit`), for `asight collector status`
// — also when no daemon runs. Only a missing flows/ means "nothing recorded yet": any other error reading the
// directory or one of its files is returned in `errors` and printed, never read as "no failures" (D38, 4.6 §记录,
// 0.1 §0 #5). Each file is read from its last `maxBytes` only; `truncated` says when a file's head or older
// failures past `limit` were left out.
export function readRecentFailures(dir, { limit = 10, files = 2, maxBytes = 1 << 20, fs = nodeFs } = {}) {
  const d = path.join(dir, 'flows')
  const out = { list: [], errors: [], truncated: false, last_ts: null } // last_ts: the newest line of any kind ("last record at")
  let names
  try { names = fs.readdirSync(d).filter((n) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(n)).sort().slice(-files) } catch (e) {
    if (e.code !== 'ENOENT') out.errors.push(`${d}: ${errText(e)}`)
    return out
  }
  for (const n of names) {
    const file = path.join(d, n)
    let text
    try {
      const fd = fs.openSync(file, 'r')
      try {
        const size = fs.fstatSync(fd).size
        const len = Math.min(size, maxBytes)
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, size - len)
        if (size > len) out.truncated = true
        text = buf.toString('utf8')
      } finally { fs.closeSync(fd) }
    } catch (e) { out.errors.push(`${file}: ${errText(e)}`); continue }
    for (const line of text.split('\n')) {
      let r = null
      try { r = JSON.parse(line) } catch { continue } // the first line of a tail may be cut
      if (r && typeof r.ts === 'string') out.last_ts = r.ts
      if (isFailure(r)) out.list.push(r)
    }
  }
  if (out.list.length > limit) { out.truncated = true; out.list = out.list.slice(-limit) }
  return out
}
export const recentFailures = (dir, opts) => readRecentFailures(dir, opts).list

const errText = (e) => String((e && e.message) || e)

// The daemon's failure recorder: record(where, error, extra) writes one failure line per place and error code per
// window; repeats inside the window are counted, and the count is written when the window closes (an unref'd
// timer) or at flush() (the daemon's stop) — never lost (4.6 §记录). Every record carries `reason` and `code`
// (asight's name or the errno: the fold key, D-3).
// record.event(rec) takes a failure already shaped {where, code, reason, …} — the engine's and the WebSocket
// recorder's (they go to flows/ like every other failure, folded the same way) — and does not log it: the
// engine tells stderr itself, through its onError. record.write(rec) writes any other event line unfolded.
// When a line cannot be written (D-1): stderr gets it, health() counts it for status, and the next line that can be
// written is preceded by one `log-gap` {from, to, lost, error}, so the gap itself is on disk.
export function createFailureRecorder(dir, { log = () => {}, windowMs = 10_000, setTimer = setTimeout, clearTimer = clearTimeout, append = appendEvent, now = () => new Date() } = {}) {
  const open = new Map() // where + code → { suppressed, last, timer }
  let gap = null // { from, lost, error } while lines are being lost
  let lostTotal = 0
  const write = (rec) => {
    try {
      if (gap) {
        append(dir, { event: 'log-gap', from: gap.from, to: now().toISOString(), lost: gap.lost, error: gap.error, reason: `${gap.lost} event line(s) could not be written (${gap.error})` })
        gap = null
      }
      append(dir, rec)
    } catch (w) {
      if (!gap) gap = { from: now().toISOString(), lost: 0, error: null }
      gap.lost++; lostTotal++; gap.error = errText(w)
      log('events', w) // stderr is all that is left until a write succeeds
    }
  }
  function close(key) {
    const w = open.get(key)
    if (!w) return
    open.delete(key)
    clearTimer(w.timer)
    if (w.suppressed) write({ ...w.last, suppressed: w.suppressed, folded: true })
  }
  function event(shaped) {
    const rec = { event: 'failure', ...shaped }
    const key = `${rec.where}\u0000${rec.code || ''}`
    const w = open.get(key)
    if (w) { w.suppressed++; w.last = rec; return }
    write(rec)
    const timer = setTimer(() => close(key), windowMs)
    if (timer && timer.unref) timer.unref()
    open.set(key, { suppressed: 0, last: rec, timer })
  }
  function record(where, e, extra = {}) {
    log(where, e)
    const code = (e && e.code) || ''
    event({ where, ...(code ? { code } : {}), reason: errText(e), ...extra })
  }
  return Object.assign(record, {
    event, write,
    flush() { for (const k of [...open.keys()]) close(k) },
    health: () => ({ lost: lostTotal, ...(gap ? { losing_since: gap.from, lost_now: gap.lost, last_error: gap.error } : {}) }),
  })
}
