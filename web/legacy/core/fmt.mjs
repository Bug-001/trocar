// core/fmt.mjs — pure formatting helpers, shared by every screen (no DOM, no window access at import time).
// Ported from the first board's inline script; neutral wording only.
import { L } from './labels.mjs'

// own-key lookup for the closed word tables of the screens (a code such as "constructor" is not in a table)
export const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const kf = (n) => n == null ? '?' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : '' + n
export const base = (p) => String(p).replace(/\/+$/, '').split('/').pop() || p
// Times (1.5 §审美维度 第 8 条): one formatter per kind, English whatever the browser's locale (D58), a 24 h clock (`h23`, so
// midnight is 00:…, never 24:…). The time of day is "08:00:52"; a date is "Oct 18" ("Oct 18, 2025" when not this year); a full
// time is the two together. Nothing outside this file formats a date.
const CLOCK = { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }
// one formatter each, made on first use (toLocale*String builds a new one per call: a rail's hundreds of tick titles paid that each)
let timeFmt = null, mdFmt = null, ymdFmt = null
const dateOf = (ts) => { if (ts == null || ts === '') return null; const d = ts instanceof Date ? ts : new Date(ts); return isNaN(d) ? undefined : d }
const sameDay = (a, b) => a.toDateString() === b.toDateString()
const time = (d) => (timeFmt ||= new Intl.DateTimeFormat('en-US', CLOCK)).format(d)
const date = (d, now) => d.getFullYear() === new Date(now).getFullYear()
  ? (mdFmt ||= new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })).format(d)
  : (ymdFmt ||= new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })).format(d)
// the time of day of an ISO string, epoch ms or Date; '' for an empty or unparseable value (never the words "Invalid Date")
export const fmtTime = (ts) => { const d = dateOf(ts); return d ? time(d) : '' }
// a calendar date ("Oct 18"); '—' for an empty or unparseable value
export const fmtDate = (ts, now = Date.now()) => { const d = dateOf(ts); return d ? date(d, now) : '—' }
// date and time ("Oct 18, 08:00:52"); '—' for an empty value, an unparseable one as it came
export const fmtStamp = (ts, now = Date.now()) => { const d = dateOf(ts); return d === null ? '—' : d === undefined ? String(ts) : `${date(d, now)}, ${time(d)}` }
// time when the day is today, the full time otherwise; '—' for an empty value. `now` is injectable so a test can pin "today".
export const fmtWhen = (ts, now = Date.now()) => {
  const d = dateOf(ts)
  if (d === null) return '—'
  if (d === undefined) return String(ts)
  return sameDay(d, new Date(now)) ? time(d) : `${date(d, now)}, ${time(d)}`
}
// how long a process has run, for a person; null / NaN / negative is unknown (invariant 4), never "1 分钟" or "NaN 天".
// A process that has only just started (under a second) is 'under 1 min', not a minute it has not run. A longer run under a minute
// still rounds up to "1 min" — the smallest whole unit shown (the restart confirmation's test pins that wording).
export function fmtUp(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return L.NOT_KNOWN
  if (ms < 1000) return 'under 1 min'
  const m = Math.max(1, Math.round(ms / 60e3))
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`
}
// a day, said by its distance from today: 'Today', 'Yesterday', '3 d ago' within the week, else its date; '—' when empty
export function fmtDay(ts, now = Date.now()) {
  const d = dateOf(ts)
  if (!d) return '—'
  const n = new Date(now)
  const back = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400e3) // round: DST days
  return back === 0 ? 'Today' : back === 1 ? 'Yesterday' : back > 1 && back < 7 ? `${back} d ago` : date(d, now)
}
export const fmtDur = (ms) => ms == null ? '?' : ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'
// NULL (and anything that is not a non-negative amount) stays unknown ('?'); only a real zero is '$0'; a real cost too small
// for four decimals is '<$0.0001', never '$0.0000' (invariant 4)
export const usd = (n) => n == null || !Number.isFinite(n) || n < 0 ? '?' : n >= 1 ? '$' + n.toFixed(2) : n >= 0.01 ? '$' + n.toFixed(3) : n >= 0.0001 ? '$' + n.toFixed(4) : n > 0 ? '<$0.0001' : '$0'
export const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + ' …' : s }
export const preview = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 90)
// UTF-8 byte length of a string (the char count of a CJK string is not its byte count)
export const enc = (s) => { try { return new TextEncoder().encode(String(s ?? '')).length } catch { return String(s ?? '').length } }

// byte counts, 1024 base. null / undefined / NaN / Infinity / a negative number stay "unknown" ('—'), never 0 (invariant 4).
export function bytes(n) {
  if (n == null || !Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return n + ' B'
  const u = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024, i = 0
  while (Number(v.toFixed(1)) >= 1024 && i < u.length - 1) { v /= 1024; i++ } // 1048575 B is 1.0 MB, never "1024.0 KB"
  return v.toFixed(1) + ' ' + u[i]
}

// "how long ago", in the board's vocabulary. `ts` is an ISO string or epoch ms; `now` is epoch ms (mock clock or real).
export function relTime(ts, now) {
  if (ts == null || ts === '') return '—'
  const t = typeof ts === 'number' ? ts : Date.parse(ts)
  if (isNaN(t)) return String(ts)
  const d = now - t
  if (d < 60e3) return 'just now'
  if (d < 3600e3) return Math.floor(d / 60e3) + ' min ago'
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' h ago'
  if (d < 30 * 86400e3) return Math.floor(d / 86400e3) + ' d ago'
  return date(new Date(t), now)
}
