// screens/traffic/model.mjs — the traffic table (1.10 §流量表) as data: every host an agent sent to in the window, grouped by agent
// (the agent only on a group's first row), the 合计 row, the caption facts (截至, coverage, the agent-source note), the filter menus
// and the window links. The numbers come from ONE C.5 `traffic` document; both filters are client-side over its rows. Everything the
// store did not record reads 未记录, never 0. Framework-free (D75②): no DOM, no timers; TrafficScreen.tsx only renders what this returns.
import { bytes, fmtDay, fmtWhen } from '../../../legacy/core/fmt.mjs'
import { CLASS_IDS } from '../../../legacy/core/classes.mjs'
import { harnessKey, harnessName, HARNESS_ORDER } from '../../../legacy/core/chips.mjs'
import { formatHash } from '../../../legacy/core/router.mjs'
import { READ_FAIL } from '../../../legacy/labels/common.mjs'
import * as W from '../../../legacy/labels/traffic.mjs'

const DAY_MS = 86400e3
const list = (x) => (Array.isArray(x) ? x : [])

/** The route's params → {window, h, cls}: junk windows fall back to the default; `h` folds through harnessKey; `class` must be a class id. */
export function queryOf(params = {}) {
  const window = W.WINDOW_LABEL.some((o) => o.value === params.window) ? params.window : W.DEFAULT_WINDOW
  const h = params.h ? [...new Set(String(params.h).split(',').filter(Boolean).map(harnessKey))] : []
  const cls = params.class && CLASS_IDS.includes(params.class) ? params.class : null
  return { window, h, cls }
}
/** The window → `--since` ('all' is no bound). */
export const sinceOf = (window) => (window === 'all' ? undefined : window)

/** One row's 收回: unrecorded is never 0; a partial sum is a floor with the count it leaves out. */
export function recvParts(row) {
  const n = (row && row.requests) || 0, un = (row && row.received_unrecorded) || 0, got = row && row.received_bytes
  if (got == null || un >= n) return { value: null, main: W.UNRECORDED, note: '', un }
  if (un === 0) return { value: got, main: bytes(got), note: '', un: 0 }
  return { value: got, main: `≥ ${bytes(got)}`, note: W.UNRECORDED_N(un), un }
}
export const sentText = (row) => (row && row.sent_bytes != null ? bytes(row.sent_bytes) : W.UNRECORDED)

// the same rule over several rows (a filtered 合计): a floor when anything is unrecorded, 未记录 when all is. A side with its own
// unrecorded count (收回) takes it from every row; one without (发出) counts an unrecorded row's requests.
function sumSide(rows, pickValue, pickUnrecorded) {
  let known = 0, un = 0, knownRows = 0
  for (const r of rows) {
    const v = pickValue(r)
    if (v != null) { known += v; knownRows++ }
    if (pickUnrecorded) un += pickUnrecorded(r) || 0
    else if (v == null) un += r.requests || 0
  }
  if (!knownRows) return { main: W.UNRECORDED, note: '' }
  if (un > 0) return { main: `≥ ${bytes(known)}`, note: W.UNRECORDED_N(un) }
  return { main: bytes(known), note: '' }
}

/** 「新」: first contact inside the 24 h before `now`, and the agent was seen before those 24 h (a fresh store has none); window-free. */
export function isNewHost(row, harnessSince, now) {
  if (!row || !row.first_seen) return false
  const first = Date.parse(row.first_seen)
  const since = harnessSince ? Date.parse(harnessSince[row.harness]) : NaN
  if (!Number.isFinite(first) || !Number.isFinite(since)) return false
  return first > now - DAY_MS && first <= now && since < now - DAY_MS
}

/** 「截至」: the clock today, the date and the clock before (core/fmt.mjs fmtWhen, 1.5 §审美维度 第 8 条); '' when there is none. */
export const asOfText = (ts, now = Date.now()) => (ts == null || ts === '' || isNaN(new Date(ts).getTime()) ? '' : fmtWhen(ts, now))
/** The route segment of an agent: the read-side id; an unidentified one is 'unknown' (1.10 §Edge cases). */
export const routeHarness = (id) => harnessKey(id) || 'unknown'

// group order: the chip table's order first, then any other id (sorted), the no-harness bucket last
function groupOrder(ids) {
  const rank = (id) => { const i = HARNESS_ORDER.indexOf(harnessKey(id)); return i >= 0 ? i : HARNESS_ORDER.length + (id === 'unknown' ? 1 : 0) }
  return [...ids].sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b)))
}
const bySent = (a, b) => (b.sent_bytes != null ? b.sent_bytes : -1) - (a.sent_bytes != null ? a.sent_bytes : -1)
  || (b.requests || 0) - (a.requests || 0) || String(a.host ?? '').localeCompare(String(b.host ?? ''))

// 主要类别: by count, at most three shown, the whole list for the hover; class_unrecorded sorts in under its own word
function classesOf(r) {
  const all = [...Object.entries(r.classes || {}), ...(r.class_unrecorded > 0 ? [[null, r.class_unrecorded]] : [])]
    .sort((a, b) => (b[1] || 0) - (a[1] || 0)).map(([id, n]) => ({ word: W.classWord(id), n }))
  return { shown: all.slice(0, 3), more: all.length > 3, all: all.map((c) => `${c.word} ${c.n}`).join(' · ') }
}

function rowOf(r, { first, window, cls, harnessSince, now }) {
  const hkey = routeHarness(r.harness)
  const host = r.host != null && String(r.host) !== '' ? String(r.host) : null
  const params = cls ? { window, class: cls } : { window }
  return {
    key: `${hkey}|${r.host ?? ''}`, harness: r.harness, hkey, first, inferred: !!r.harness_inferred,
    host, href: host ? formatHash({ screen: 'traffic-host', harness: hkey, host, params }) : null,
    firstText: r.first_seen ? fmtDay(r.first_seen, now) : W.UNKNOWN_DAY,
    firstTip: r.first_seen ? `${W.FIRST_SEEN_TIP} · ${r.first_seen}` : null,
    isNew: isNewHost(r, harnessSince, now),
    requests: r.requests ?? 0, sent: sentText(r), recv: (({ main, note }) => ({ main, note }))(recvParts(r)),
    classes: classesOf(r),
  }
}

/** The `traffic` document + the filters → the table: {state:'none'} for a document without hosts, else the grouped rows and the total. */
export function tableModel(answer, { h = [], cls = null, now = Date.now(), window = W.DEFAULT_WINDOW } = {}) {
  if (!answer || !Array.isArray(answer.hosts)) return { state: 'none' }
  const harnessSince = answer.harness_since || {}
  const kept = answer.hosts.filter((r) => (!h.length || h.includes(harnessKey(r.harness))) && (!cls || (r.classes && r.classes[cls] > 0)))
  const sorted = groupOrder([...new Set(kept.map((r) => r.harness))]).map((id) => ({ harness: id, rows: kept.filter((r) => r.harness === id).sort(bySent) }))
  const groups = sorted.map((g) => ({ harness: g.harness, rows: g.rows.map((r, i) => rowOf(r, { first: i === 0, window, cls, harnessSince, now })) }))
  const raw = sorted.flatMap((g) => g.rows)
  const floor = !!(answer.totals && answer.totals.is_floor)
  // unfiltered: the document's totals (the whole window, past the page); filtered: the sum of the drawn rows
  const t = !h.length && !cls && answer.totals
  const un = raw.reduce((a, r) => a + (r.received_unrecorded || 0), 0)
  const floorOf = (v, note = '') => (v == null ? { main: W.UNRECORDED, note: '' } : { main: `${floor ? '≥ ' : ''}${bytes(v)}`, note })
  const total = t
    ? { requests: t.requests || 0, sent: floorOf(t.sent_bytes), recv: floorOf(t.received_bytes, un ? W.UNRECORDED_N(un) : ''), filtered: false }
    : {
      requests: raw.reduce((a, r) => a + (r.requests || 0), 0),
      sent: sumSide(raw, (r) => r.sent_bytes, null),
      recv: sumSide(raw, (r) => r.received_bytes, (r) => r.received_unrecorded || 0),
      filtered: true,
    }
  return {
    state: 'table', groups, flat: groups.flatMap((g) => g.rows), total, floor,
    asOf: answer.as_of, asOfText: asOfText(answer.as_of, now),
    // the agent-source note, while the rows carry no harness_inferred field at all (1.10 §OPEN: by field presence, not version)
    sourceNote: answer.hosts.length > 0 && !answer.hosts.some((r) => 'harness_inferred' in r),
  }
}

/** The coverage note: agents a fresh `sessions` answer has that the `traffic` rows do not (both through harnessKey). */
export function coverOf(hosts, sessionsAnswer) {
  const a = sessionsAnswer
  if (!a || !a.ok || !a.data || a.data.stored) return []
  const inTraffic = new Set(list(hosts).map((r) => harnessKey(r.harness)))
  return [...new Set(list(a.data.sessions).map((s) => harnessKey(s.harness)).filter(Boolean))].filter((k) => !inTraffic.has(k))
}

/** The agent / class menus, the 「what this class keeps」 item, the active-filter chips and the class-filter note. */
export function filterLinks({ window, h = [], cls = null, agents = [] }) {
  const hrefOf = (patch) => {
    /** @type {Record<string, string>} */
    const params = { window }
    if (h.length) params.h = h.join(',')
    if (cls) params.class = cls
    for (const [k, v] of Object.entries(patch)) if (v == null || v === '') delete params[k]; else params[k] = v
    return formatHash({ screen: 'traffic', params })
  }
  return {
    agents: [...new Set(list(agents).map(harnessKey))].map((id) => ({ id, label: harnessName(id), href: hrefOf({ h: id }) })),
    classes: CLASS_IDS.map((id) => ({ id, label: W.classWord(id), href: hrefOf({ class: id }) })),
    kept: cls ? formatHash({ screen: 'settings-storage', params: h.length ? { h: h.join(','), class: cls } : { class: cls } }) : null,
    chips: [
      ...h.map((id) => ({ label: `${W.FILTER_AGENT}:${harnessName(id)}`, href: hrefOf({ h: null }) })),
      ...(cls ? [{ label: `${W.FILTER_CLASS}:${W.classWord(cls)}`, href: hrefOf({ class: null }) }] : []),
    ],
    note: cls ? W.CLASS_FILTER_NOTE(W.classWord(cls)) : null,
  }
}

/** The window control: one link per window, `on` for the current one. */
export const windowLinks = (value, hrefOf) => W.WINDOW_LABEL.map((o) => ({ value: o.value, label: o.label, href: hrefOf(o.value), on: o.value === value }))

/** A failed read (1.5 K-29): `line` names what and the cause class, never the reason; the status and the reason sit only in `pairs`. */
export function failOf(what, r) {
  const obj = r != null && typeof r === 'object'
  const status = obj && typeof r.status === 'number' ? r.status : null
  const why = obj ? r.error : r
  /** @type {[string, {text: string}][]} */
  const pairs = [...(status != null ? [['status', { text: String(status) }]] : []), ['error', { text: why == null || why === '' ? '—' : String(why) }]]
  return { line: READ_FAIL(what, status), pairs, copy: pairs.map(([k, v]) => `${k}: ${v.text}`).join('\n') }
}
