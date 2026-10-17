// events.mjs — durable failure records (D38: a capture failure is never silent).
// Every failure the collector owns becomes one JSON line `{ts, event, reason, …}` in <collector>/flows/<UTC date>.ndjson
// (RFC 4.6 §记录: the board never reads flows/, so these are never mistaken for envelopes). appendEvent writes with its
// own descriptor, so a record store whose files broke can still report that it broke. `asight collector status` and
// the board read them back through src/health/ (captureHealth), also when no daemon is running.
import { appendFlowEvent } from '../../off/events.mjs'
import { isFailure, UNFOLDED_CODES } from '../../health/codes.mjs'
import { readFlows } from '../../health/flows.mjs'

// The closed sets and the failure / expected split live in src/health/codes.mjs (D38: writers and readers share them).
export { isFailure }

// The line writer is src/off/events.mjs (`asight off` writes the same lines without this directory, 1.6 R3). `day` (YYYY-MM-DD): the file to write,
// when the caller keeps a day that never goes back (the daemon's recorder)
export const appendEvent = appendFlowEvent

// The failure records in flows/, read the way `asight collector status` and the board read them (src/health/flows.mjs:
// sealed day files too; an unreadable flows/ throws, never "no failures"), oldest first.
export const recentFailures = (dir) => readFlows({ dir }).records.filter(isFailure)

const errText = (e) => String((e && e.message) || e)

// The daemon's failure recorder: record(where, error, extra) writes one failure line per place and error code per
// window; repeats inside the window are counted, and the count is written when the window closes (an unref'd
// timer) or at flush() (the daemon's stop) — never lost (4.6 §记录). Every record carries `reason` and `code`
// (asight's name or the errno: the fold key, D-3).
// record.event(rec) takes a failure already shaped {where, code, reason, …} — the engine's and the WebSocket
// recorder's (they go to flows/ like every other failure, folded the same way, except the codes in
// UNFOLDED_CODES: a negative-cache write is a condition per (pid, host), one line each, D1-1) — and does not log
// it: the engine tells stderr itself, through its onError. record.write(rec) writes any other event line unfolded.
// When a line cannot be written (D-1): stderr gets it, health() counts it for status, and the next line that can be
// written is preceded by one `log-gap` {from, to, lost, error}, so the gap itself is on disk.
export function createFailureRecorder(dir, { log = () => {}, windowMs = 10_000, setTimer = setTimeout, clearTimer = clearTimeout, append = appendEvent, now = () => new Date() } = {}) {
  const open = new Map() // where + code → { suppressed, last, timer }
  let gap = null // { from, lost, error } while lines are being lost
  let lostTotal = 0
  let lastDay = null // the day file never goes back when the clock does (4.6 §记录)
  const write = (rec) => {
    const t = now().toISOString()
    const d = t.slice(0, 10)
    if (!lastDay || d > lastDay) lastDay = d
    try {
      if (gap) {
        append(dir, { event: 'log-gap', from: gap.from, to: t, lost: gap.lost, error: gap.error, reason: `${gap.lost} event line(s) could not be written (${gap.error})` }, { day: lastDay })
        gap = null
      }
      append(dir, rec, { day: lastDay })
    } catch (w) {
      if (!gap) gap = { from: t, lost: 0, error: null }
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
  const unfolded = new Set(UNFOLDED_CODES)
  function event(shaped) {
    const rec = { event: 'failure', ...shaped }
    // a critical failure (D51④) is also one stderr line — launchd / the scheduled task / systemd keep it — with its code, harness, pid and host
    if (rec.level === 'critical') log('critical', new Error(`${rec.code} harness=${rec.harness ?? '-'} pid=${rec.pid ?? '-'} host=${rec.host ?? '-'}: ${rec.reason ?? ''}`))
    if (unfolded.has(rec.code)) { write(rec); return }
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
