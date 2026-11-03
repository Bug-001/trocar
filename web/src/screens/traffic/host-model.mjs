// screens/traffic/host-model.mjs — the host page (1.10 §host 页) as data: what one agent sent to one host, from `calls {harness, host}`
// paged by `next` (newest first, keyed by ref), the breadcrumb, and each list row's cells and marks. Everything the store did not
// record reads 未记录, never 0. Framework-free (D75②): no DOM, no timers; HostScreen.tsx only renders what this returns.
import { bytes, fmtTime, fmtStamp } from '../../../legacy/core/fmt.mjs'
import { harnessKey, harnessName } from '../../../legacy/core/chips.mjs'
import { formatHash } from '../../../legacy/core/router.mjs'
import * as W from '../../../legacy/labels/traffic.mjs'
import { sinceOf, routeHarness } from './model.mjs'

export const ROW_H = 34
export const DETAIL_BREAK = 1440 // the detail is a column at/above this width, a drawer below (1.2 §窄屏)

/** The params of one `calls {harness, host}` page: the window as `since`, the class filter as `class`; absent keys are dropped. */
export function callsParams({ harness, host, cls = null, window = null, after = null, limit = null }) {
  const p = { harness, host, class: cls, since: window ? sinceOf(window) : null, after, limit }
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v != null))
}

/** The pages read so far → the list: S7's order, a repeated ref drawn once; total / as_of / next from the last good page. */
export function mergePages(answers) {
  const ok = (a) => a != null && Array.isArray(a.records)
  if (!Array.isArray(answers) || !ok(answers[0])) return { state: 'none' }
  const seen = new Set(), rows = []
  let last = answers[0]
  for (const a of answers) {
    if (!ok(a)) continue
    last = a
    for (const r of a.records) if (!seen.has(r.ref)) { seen.add(r.ref); rows.push(r) }
  }
  return { state: 'table', rows, total: last.total, asOf: last.as_of, next: last.next ?? null }
}

const kept = (window, cls) => (cls ? { window, class: cls } : { window })

/** The host page's own link (a row's carries its ref). */
export const hostHref = ({ harness, host, window, cls = null, ref = null }) =>
  formatHash({ screen: 'traffic-host', harness: routeHarness(harness), host, params: { ...kept(window, cls), ...(ref ? { ref } : {}) } })

/** 流量 › agent › host: the first two link back with the window and the class kept; the host is this page. */
export function crumbsOf({ harness, host, window, cls = null }) {
  const h = routeHarness(harness)
  return [
    { label: W.TRAFFIC, href: formatHash({ screen: 'traffic', params: kept(window, cls) }) },
    { label: harnessName(h), harness: h, href: formatHash({ screen: 'traffic', params: { ...kept(window, cls), h } }) },
    { label: host },
  ]
}

// the time cell: the clock when it is today, date and clock otherwise; the ISO time on hover
function whenOf(ts, now) {
  if (!ts) return { text: W.UNKNOWN_DAY, iso: null }
  const d = new Date(ts)
  return { text: isNaN(d.getTime()) ? String(ts) : (d.toDateString() === new Date(now).toDateString() ? fmtTime(d) : fmtStamp(d)), iso: String(ts) }
}

// the retention mark: 只记日志 links to its storage cell; 只存了长度 carries the legacy sentence; full has none
function retentionOf(row, harness) {
  if (row.retention === 'log') {
    return { kind: 'log', label: W.RETENTION_MARK.log.label, href: formatHash({ screen: 'settings-storage', params: { h: harnessKey(harness), class: row.class || '' } }) }
  }
  if (row.retention === 'legacy-meta') return { kind: 'legacy-meta', label: W.RETENTION_MARK['legacy-meta'].label, tip: W.RETENTION_MARK['legacy-meta'].tip }
  return null
}

/** One list row's cells; its link selects it (the route carries ref). */
export function hostRowView(row, { harness, host, window, cls = null, now = Date.now() }) {
  const num = (n) => (n != null ? bytes(n) : W.UNRECORDED)
  return {
    key: row.ref, ref: row.ref,
    href: hostHref({ harness, host, window, cls, ref: row.ref }),
    when: whenOf(row.ts, now),
    endpoint: row.endpoint || '',
    cls: W.classWord(row.class),
    sent: num(row.sent_bytes), recv: num(row.received_bytes),
    retention: retentionOf(row, harness),
    failed: !!row.error,
  }
}

/** The empty list: names the class when the list is filtered by one. */
export const emptyText = (cls) => (cls ? W.EMPTY_HOST_CLASS(W.classWord(cls)) : W.EMPTY_HOST)
