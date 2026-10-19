// core/fmt.mjs — pure formatting helpers, shared by every screen (no DOM, no window access at import time).
// Ported from the first board's inline script; neutral wording only.
import { L } from './labels.mjs'

// own-key lookup for the closed word tables of the screens (a code such as "constructor" is not in a table)
export const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const kf = (n) => n == null ? '?' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : '' + n
export const base = (p) => String(p).replace(/\/+$/, '').split('/').pop() || p
// Times are zh-CN with a 24 h clock ("15:59:48"), whatever the browser's own locale is: the page's words are Chinese, and the browser
// default would print "3:59:48 PM" in the middle of them. `h23` (not hour12:false) so midnight is 00:…, never 24:….
const LOCALE = 'zh-CN', CLOCK = { hourCycle: 'h23' }
// the time of day of an ISO string or epoch ms; '' for an empty or unparseable value (never the words "Invalid Date")
export const fmtTime = (ts) => {
  if (ts == null || ts === '') return ''
  const d = new Date(ts)
  return isNaN(d) ? '' : d.toLocaleTimeString(LOCALE, CLOCK)
}
// date and time ("2026/10/7 15:59:48"); '—' for an empty value, an unparseable one as it came
export const fmtStamp = (ts) => {
  if (ts == null || ts === '') return '—'
  const d = new Date(ts)
  return isNaN(d) ? String(ts) : d.toLocaleString(LOCALE, CLOCK)
}
// time when the day is today, date-time otherwise; '—' for an empty value. `now` is injectable so mock mode can
// pin "today" to the mock clock.
export const fmtWhen = (ts, now = Date.now()) => {
  if (!ts) return '—'
  const d = new Date(ts)
  if (isNaN(d)) return String(ts)
  return d.toDateString() === new Date(now).toDateString() ? fmtTime(d) : fmtStamp(d)
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
// a calendar day, the way the first-seen column words it: 'today', '7/17', with the year only when it is not this year; '—' when empty
export function fmtDay(ts, now = Date.now()) {
  if (ts == null || ts === '') return '—'
  const d = new Date(ts)
  if (isNaN(d)) return '—'
  const n = new Date(now)
  if (d.toDateString() === n.toDateString()) return 'today'
  return `${d.getFullYear() === n.getFullYear() ? '' : d.getFullYear() + '/'}${d.getMonth() + 1}/${d.getDate()}`
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
  return new Date(t).toLocaleDateString(LOCALE)
}
