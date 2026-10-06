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

export function recentFailures(dir, { limit = 10, files = 2, maxBytes = 1 << 20, fs = nodeFs } = {}) {
  const d = path.join(dir, 'flows')
  let names
  try { names = fs.readdirSync(d).filter((n) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(n)).sort().slice(-files) } catch { return [] }
  const out = []
  for (const n of names) {
    const buf = fs.readFileSync(path.join(d, n))
    const text = buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8')
    for (const line of text.split('\n')) {
      let r = null
      try { r = JSON.parse(line) } catch { continue } // the first line of a tail may be cut
      if (isFailure(r)) out.push(r)
    }
  }
  return out.slice(-limit)
}

const errText = (e) => String((e && e.message) || e)

// The daemon's failure recorder: record(where, error, extra) writes one failure line per place and error code per
// window; repeats inside the window are counted, and the count is written when the window closes (an unref'd
// timer) or at flush() (the daemon's stop) — never lost (4.6 §记录). Every record carries `reason`.
// record.event(rec) takes a failure already shaped {where, code, reason, …} — the engine's and the WebSocket
// recorder's (they go to flows/ like every other failure, folded the same way) — and does not log it: the
// engine tells stderr itself, through its onError.
export function createFailureRecorder(dir, { log = () => {}, windowMs = 10_000, setTimer = setTimeout, clearTimer = clearTimeout, append = appendEvent } = {}) {
  const open = new Map() // where + code → { suppressed, last, timer }
  const write = (rec) => { try { append(dir, rec) } catch (w) { log('events', w) } } // then stderr is all that is left
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
  return Object.assign(record, { event, flush() { for (const k of [...open.keys()]) close(k) } })
}
