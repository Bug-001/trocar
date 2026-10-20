// traffic/traffic.mjs — 流量 (1.10) · #/traffic. One table: every host an agent sent to in the window, grouped by agent
// (the chip only on a group's first row), a caption row that carries 截至 / coverage / the filters (the head zone stays
// free of sentences), and a 合计 row. The numbers come from the C.5 `traffic` document — read once per window or filter
// change, never polled; the rows link to the host page. Everything the store did not record says 未记录, never 0.
// Contract: mount(el, ctx) → {update(route), unmount()}; ctx = {api, store, router}.
import { esc, bytes, fmtDay, fmtTime } from '../core/fmt.mjs'
import { CLASS_IDS, UNCLASSIFIED } from '../core/classes.mjs'
import { harnessKey, harnessName, harnessIcon, HARNESS_ORDER } from '../core/chips.mjs'
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { menuButton, infoButton, mark } from '../core/ui.mjs'
import { setScreenKeys } from '../core/keys.mjs'
import { delegate } from '../core/dom.mjs'
import { formatHash, parseHash } from '../core/router.mjs'
import { loadSessions } from '../library/logic.mjs'
import * as W from '../labels/traffic.mjs'

const PATTERN_ONLY = ['session-sync', 'files', 'account'] // the three classes only a pattern can name (D40⑥)
const DAY_MS = 86400e3

// the route's params → the query the screen works with: the window (junk falls back to the default), an agent filter,
// a class filter. Both filters are client-side over `traffic`'s rows (the document takes only the window).
export function queryOf(params = {}) {
  const window = W.WINDOW_LABEL.some((o) => o.value === params.window) ? params.window : W.DEFAULT_WINDOW
  const h = params.h ? [...new Set(String(params.h).split(',').filter(Boolean).map(harnessKey))] : []
  const cls = params.class && CLASS_IDS.includes(params.class) ? params.class : null
  return { window, h, cls }
}
// the window → `--since` (a relative time the query layer reads; 'all' is no bound)
export const sinceOf = (window) => (window === 'all' ? undefined : window)

// one row's 收回, as words: unrecorded is never 0; a partial sum is a floor with the count of what it leaves out.
export function recvParts(row) {
  const n = (row && row.requests) || 0, un = (row && row.received_unrecorded) || 0, got = row && row.received_bytes
  if (got == null || un >= n) return { value: null, main: W.UNRECORDED, note: '', un }
  if (un === 0) return { value: got, main: bytes(got), note: '', un: 0 }
  return { value: got, main: `≥ ${bytes(got)}`, note: W.UNRECORDED_N(un), un }
}
export const recvText = (row) => { const p = recvParts(row); return p.note ? `${p.main} · ${p.note}` : p.main }
export const sentText = (row) => (row && row.sent_bytes != null ? bytes(row.sent_bytes) : W.UNRECORDED)

// the same rule over several rows (the 合计 row): a floor when anything is unrecorded, 未记录 when all is. For a side
// with its own unrecorded count (收回) the count comes from EVERY row; for one without (发出) an unrecorded row counts
// its requests.
export function sumSide(rows, pickValue, pickUnrecorded) {
  let known = 0, un = 0, knownRows = 0, requests = 0
  for (const r of rows) {
    const v = pickValue(r)
    requests += r.requests || 0
    if (v != null) { known += v; knownRows++ }
    if (pickUnrecorded) un += pickUnrecorded(r) || 0
    else if (v == null) un += r.requests || 0
  }
  if (!knownRows) return { main: W.UNRECORDED, note: '' } // nothing this side recorded (or nothing to sum)
  if (un > 0) return { main: `≥ ${bytes(known)}`, note: W.UNRECORDED_N(un) }
  return { main: bytes(known), note: '' }
}

// 未分类 vs 其他: only where an answer's `unmatched` (C.5 has no such field yet — PR 5 C8) holds ALL THREE pattern-only classes for that agent (a missing
// or unread answer reads 其他, never 未分类 — 1.10 §Edge cases).
export function unclassifiedOf(unmatched, harness) {
  const u = unmatched && unmatched[harness]
  return Array.isArray(u) && PATTERN_ONLY.every((c) => u.includes(c))
}
export function classWord(id, harness, unmatched) {
  if (id === 'other' && unclassifiedOf(unmatched, harness)) return { word: UNCLASSIFIED, unclassified: true }
  return { word: W.classWord(id), unclassified: false }
}

// 「新」: the agent's first-ever contact with this host falls inside the last 24 h of the read AND the agent itself was
// seen before that window (a fresh store has none) — whatever the route's window is, and always as a 推测.
export function isNewHost(row, harnessSince, now) {
  if (!row || !row.first_seen) return false
  const first = Date.parse(row.first_seen)
  const since = harnessSince ? Date.parse(harnessSince[row.harness]) : NaN
  if (!Number.isFinite(first) || !Number.isFinite(since)) return false
  return first > now - DAY_MS && first <= now && since < now - DAY_MS
}

// 「as of 10/6 14:02」 — the year only when it is not this one (2025/10/6 14:02)
export function asOfText(ts, now = Date.now()) {
  if (ts == null || ts === '') return ''
  const d = new Date(ts)
  if (isNaN(d)) return ''
  const n = new Date(now), p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear() === n.getFullYear() ? '' : d.getFullYear() + '/'}${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}
export const readAtText = fmtTime
// the caption's 截至: the words, with the document's as_of as the machine-readable time
export const asOfHtml = (iso, text) => `<time class="cap-item" datetime="${esc(iso)}">${W.AS_OF} ${esc(text)}</time>`
// the agent-source note, while the rows carry no harness_inferred field at all (1.10 §OPEN: by field presence, not version)
export const agentSourceNote = (rows) => (rows.length && !rows.some((r) => 'harness_inferred' in r) ? `<span class="cap-item" data-note="agent-source">${esc(W.AGENT_SOURCE_NOTE)}</span>` : '')
// the route segment of an agent: the read-side id; an unidentified one is 'unknown' (1.10 §Edge cases)
export const routeHarness = (id) => harnessKey(id) || 'unknown'

// group order: the chip table's order first, then any other id (sorted), the no-harness bucket last
function groupOrder(ids) {
  const rank = (id) => { const i = HARNESS_ORDER.indexOf(harnessKey(id)); return i >= 0 ? i : HARNESS_ORDER.length + (id === 'unknown' ? 1 : 0) }
  return [...ids].sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b)))
}

// the `traffic` document + the filters → the rows the table draws (one per hosts[] entry). Pure: it eats the answer only.
export function tableModel(answer, { h = [], cls = null, now = Date.now(), unmatched = null, window = W.DEFAULT_WINDOW } = {}) {
  if (!answer || !Array.isArray(answer.hosts)) return { state: 'none', answer, now }
  const kept = answer.hosts.map((r) => ({ ...r, recv: recvParts(r) })).filter((r) => (!h.length || h.includes(harnessKey(r.harness))) && (!cls || (r.classes && r.classes[cls] > 0)))
  const groups = []
  for (const id of groupOrder([...new Set(kept.map((r) => r.harness))])) {
    const rows = kept.filter((r) => r.harness === id)
      .sort((a, b) => (b.sent_bytes != null ? b.sent_bytes : -1) - (a.sent_bytes != null ? a.sent_bytes : -1) || (b.requests || 0) - (a.requests || 0) || String(a.host ?? '').localeCompare(String(b.host ?? '')))
    groups.push({ harness: id, rows })
  }
  const flat = groups.flatMap((g) => g.rows)
  const floor = !!(answer.totals && answer.totals.is_floor)
  // unfiltered: the document's totals (the whole window, past the page); filtered: the sum of the drawn rows
  const t = !h.length && !cls && answer.totals
  const un = flat.reduce((a, r) => a + (r.received_unrecorded || 0), 0)
  const floorOf = (v, note = '') => (v == null ? { main: W.UNRECORDED, note: '' } : { main: `${floor ? '≥ ' : ''}${bytes(v)}`, note })
  const total = t
    ? { requests: t.requests || 0, sent: floorOf(t.sent_bytes), recv: floorOf(t.received_bytes, un ? W.UNRECORDED_N(un) : ''), filtered: false }
    : {
      requests: flat.reduce((a, r) => a + (r.requests || 0), 0),
      sent: sumSide(flat, (r) => r.sent_bytes, null),
      recv: sumSide(flat, (r) => r.received_bytes, (r) => r.received_unrecorded || 0),
      filtered: true,
    }
  return { state: 'table', groups, flat, total, floor, answer, asOf: answer.as_of, harnessSince: answer.harness_since || {}, unmatched, now, cls, window }
}

// one row of the table (a link to its host page; a row that recorded no host is text, not a link)
export function rowHtml(r, model, first) {
  const params = { window: model.window }
  if (model.cls) params.class = model.cls
  const host = r.host && String(r.host) !== '' ? r.host : null
  const key = routeHarness(r.harness)
  const link = host ? formatHash({ screen: 'traffic-host', harness: key, host, params }) : null
  const isNew = isNewHost(r, model.harnessSince, model.now)
  const firstText = r.first_seen ? fmtDay(r.first_seen, model.now) : W.UNKNOWN_DAY
  const classes = [...Object.entries(r.classes || {}), ...(r.class_unrecorded > 0 ? [[null, r.class_unrecorded]] : [])].sort((a, b) => (b[1] || 0) - (a[1] || 0))
  const clsHtml = classes.slice(0, 3).map(([id, n]) => {
    const w = classWord(id, r.harness, model.unmatched)
    return w.unclassified
      ? `${esc(w.word)} ${n} ${infoButton({ label: 'Why unclassified', title: w.word, body: esc(W.UNCLASSIFIED_TIP) })}`
      : `${esc(w.word)} ${n}`
  }).join('<span class="sep-dot" aria-hidden="true"> · </span>') + (classes.length > 3 ? '<span class="more-classes"> …</span>' : '')
  const clsAll = classes.map(([id, n]) => `${classWord(id, r.harness, model.unmatched).word} ${n}`).join(' · ') // the cell may cut: the whole list on hover
  const recv = r.recv
  const inferred = r.harness_inferred ? ` <span data-mark="inferred">${mark('inf', W.AGENT_AGENT_TIP)}</span>` : '' // every inferred row, once the rows carry the flag (1.10 §OPEN)
  const agentCell = `<span class="nm">${first ? `${harnessIcon(r.harness)}<span class="nmname">${esc(harnessName(r.harness))}</span>` : ''}${inferred}</span>`
  const hostCell = host ? `<span class="host mono" title="${esc(host)}">${esc(host)}</span>` : `<span class="host nohost">${esc(W.NO_HOST)}</span>`
  const firstCell = `${esc(firstText)}${isNew ? ` <span class="newmark" data-mark="new">${esc(W.NEW)} ${mark('inf', W.NEW_TIP)}</span>` : ''}`
  const title = r.first_seen ? ` title="${esc(W.FIRST_SEEN_TIP)} · ${esc(r.first_seen)}"` : ''
  const inner = `<span class="gut"></span>${agentCell}` +
    `<span class="cell-host">${hostCell}</span>` +
    `<span class="cell-first"${title}>${firstCell}</span>` +
    `<span class="cell num">${r.requests ?? 0}</span>` +
    `<span class="cell num">${esc(sentText(r))}</span>` +
    `<span class="cell num">${esc(recv.main)}${recv.note ? ` <span class="c2">${esc(recv.note)}</span>` : ''}</span>` +
    `<span class="cell classes" title="${esc(clsAll)}">${clsHtml}</span>`
  return link
    ? `<a class="trow" href="${esc(link)}" data-href="${esc(link)}" data-h="${esc(key)}">${inner}</a>`
    : `<div class="trow nolink" data-h="${esc(key)}">${inner}</div>`
}

export function totalRowHtml(model) {
  const t = model.total
  const cell = (p) => esc(p.main) + (p.note ? ` <span class="c2">${esc(p.note)}</span>` : '')
  return `<div class="trow ttotal"><span class="gut"></span><span class="nm"></span>` +
    `<span class="cell-host">${esc(W.COL.total)}${t.filtered ? ` <span class="c2">${esc(W.ONLY_THESE)}</span>` : ''}</span><span class="cell-first"></span>` +
    `<span class="cell num">${t.requests}</span><span class="cell num">${cell(t.sent)}</span>` +
    `<span class="cell num">${cell(t.recv)}</span><span class="cell"></span></div>`
}

// the caption row's facts: 截至, the coverage note, the agent-source note. Only what qualifies this table.
export function captionHtml(model, { cover = [] } = {}) {
  const parts = []
  const asOf = asOfText(model.asOf, model.now)
  if (asOf) parts.push(asOfHtml(model.asOf, asOf))
  if (cover.length) parts.push(`<span class="cap-item">${esc(W.COVERS_PREFIX)}${cover.map((id) => `<span class="cap-agent" data-h="${esc(id)}">${harnessIcon(id)}${esc(harnessName(id))}</span>`).join('')}</span>`)
  const rows = (model.answer && model.answer.hosts) || []
  if (agentSourceNote(rows)) parts.push(agentSourceNote(rows))
  return parts.join('')
}

// the agent / class menus and the active-filter chips (a chip's × clears only its own filter)
export function filterBarHtml(model, { h = [], cls = null } = {}) {
  const win = model.window
  const hrefOf = (patch) => {
    const params = { window: win }
    if (h.length) params.h = h.join(',')
    if (cls) params.class = cls
    for (const [k, v] of Object.entries(patch)) if (v == null || v === '') delete params[k]; else params[k] = v
    return formatHash({ screen: 'traffic', params })
  }
  const agents = [...new Set(((model.answer && model.answer.hosts) || []).map((r) => harnessKey(r.harness)))]
  const agentMenu = menuButton({
    label: W.FILTER_AGENT, title: W.FILTER_AGENT,
    items: agents.map((id) => ({ label: harnessName(id), href: hrefOf({ h: id }) })),
  })
  const classMenu = menuButton({
    label: W.FILTER_CLASS, title: W.FILTER_CLASS,
    items: [
      ...CLASS_IDS.map((id) => ({ label: W.classWord(id), href: hrefOf({ class: id }) })),
      ...(cls ? [{ label: W.WHAT_IS_KEPT, href: formatHash({ screen: 'settings-storage', params: h.length ? { h: h.join(','), class: cls } : { class: cls } }) }] : []),
    ],
  })
  const chips = [
    ...h.map((id) => `<a class="fchip" href="${esc(hrefOf({ h: null }))}" title="Remove this filter">${esc(W.FILTER_AGENT)}:${esc(harnessName(id))} <span class="x" aria-hidden="true">×</span></a>`),
  ]
  if (cls) {
    chips.push(`<a class="fchip" href="${esc(hrefOf({ class: null }))}" title="Remove this filter">${esc(W.FILTER_CLASS)}:${esc(W.classWord(cls))} <span class="x" aria-hidden="true">×</span></a>`)
    chips.push(`<span class="cap-item cap-note">${esc(W.CLASS_FILTER_NOTE(W.classWord(cls)))}</span>`)
  }
  return `<div class="tfilters">${agentMenu}${classMenu}${chips.join('')}</div>`
}

// the whole table: caption row, header, the grouped rows, the total (the caller paints states around it)
export function tableHtml(model, { h = [], cls = null, cover = [] } = {}) {
  const head = `<div class="trow thead" aria-hidden="true"><span class="gut"></span><span class="nm">${esc(W.COL.agent)}</span>` +
    `<span class="cell-host">${esc(W.COL.host)}</span><span class="cell-first">${esc(W.COL.first)}</span>` +
    `<span class="cell num">${esc(W.COL.requests)}</span>` +
    `<span class="cell num">${esc(W.COL.sent)}${infoButton({ label: 'What sent counts', title: W.COL.sent, body: esc(W.BYTES_TIP) })}</span>` +
    `<span class="cell num">${esc(W.COL.recv)}${infoButton({ label: 'What received counts', title: W.COL.recv, body: esc(W.BYTES_TIP) })}</span>` +
    `<span class="cell classes">${esc(W.COL.classes)}</span></div>`
  const groups = model.groups.map((g) => g.rows.map((r, i) => rowHtml(r, model, i === 0)).join('')).join('')
  return `<div class="tcap">${captionHtml(model, { cover })}${filterBarHtml(model, { h, cls })}</div>` + head + groups + totalRowHtml(model)
}

// the states around the table: loading, no rows in the window, a failed read
export function stateHtml(kind, payload = {}) {
  if (kind === 'loading') return `<div class="tstate">${esc(W.LOADING)}</div>`
  if (kind === 'empty') return `<div class="tstate" data-empty${payload.cls ? ` data-class="${esc(payload.cls)}"` : ''}>${esc(payload.cls ? W.EMPTY_WINDOW_CLASS(W.classWord(payload.cls)) : W.EMPTY_WINDOW)}</div>`
  if (kind === 'error') return `<div class="tstate"><p>${esc(W.READ_FAILED(payload.error || 'reason not known'))}</p><button type="button" class="tbtn" data-act="retry">${esc(W.RETRY)}</button></div>`
  return ''
}

// ── the screen ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export function mount(el, ctx) {
  const { api, router } = ctx
  let dead = false, model = null, agentsInSessions = null, unmatched = null, readAt = null, err = null
  let q = queryOf(router.current().params)
  const scope = () => ({
    label: 'window', value: q.window,
    options: W.WINDOW_LABEL.map((o) => ({
      ...o,
      href: formatHash({ screen: 'traffic', params: { window: o.value, ...(q.h.length ? { h: q.h.join(',') } : {}), ...(q.cls ? { class: q.cls } : {}) } }),
    })),
  })
  // the coverage note: agents `sessions` has that this window's `traffic` rows do not (both through harnessKey)
  const coverOf = () => {
    if (!agentsInSessions || !model || model.state !== 'table') return []
    const inTraffic = new Set(model.answer.hosts.map((r) => harnessKey(r.harness)))
    return [...agentsInSessions].filter((k) => !inTraffic.has(k))
  }
  const remodel = (doc) => tableModel(doc, { h: q.h, cls: q.cls, now: api.now(), unmatched, window: q.window })
  const paint = () => {
    const head = pageHeadHtml({ name: 'Traffic', scope: scope(), readAt })
    const cover = coverOf()
    let body = ''
    if (err && (!model || model.state !== 'table')) body = stateHtml('error', { error: err })
    else if (!model) body = stateHtml('loading')
    else if (model.state === 'none') body = stateHtml('error', { error: (model.answer && model.answer.error) || null })
    else if (!model.flat.length) body = stateHtml('empty', { cls: q.cls }) + `<div class="tcap">${captionHtml(model, { cover })}</div>`
    else body = tableHtml(model, { h: q.h, cls: q.cls, cover })
    el.innerHTML = `<div class="page traf">${head}${body}</div>`
  }
  async function read() {
    const r = await api.get('traffic', { since: sinceOf(q.window), limit: 500 })
    if (dead) return
    if (r.ok) { readAt = api.now(); err = null; model = remodel(r.data) }
    else if (!model || model.state !== 'table') { err = r.error || `HTTP ${r.status}`; model = null }
    paint()
    if (!unmatched) api.get('classes').then((c) => {
      // `unmatched` is not a C.5 field yet: while it is absent, 其他 stays 其他 (1.10 §前置定义, PR 5 C8)
      if (dead || !c.ok || !c.data || !c.data.unmatched) return
      unmatched = c.data.unmatched
      if (model && model.state === 'table') { model = remodel(model.answer); paint() }
    }, () => {})
  }
  // when `sessions` cannot be read the coverage note simply does not appear
  loadSessions(api).then((r) => {
    if (dead || !r.ok) return
    agentsInSessions = new Set(r.data.sessions.map((s) => harnessKey(s.harness)).filter(Boolean))
    paint()
  }, () => {})
  paint()
  read()

  const offs = [
    delegate(el, 'click', '[data-act="retry"]', () => { err = null; paint(); read() }),
    // a plain click opens the host page here (the row is already a link); a modified click is the browser's to follow
    delegate(el, 'click', 'a.trow', (e, a) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return
      e.preventDefault()
      router.go(parseHash(a.getAttribute('href')))
    }),
  ]
  const inControl = (t) => !!(t && t.closest && t.closest('[data-menu],[data-pop],.pop,button,input,select,textarea,a'))
  setScreenKeys((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.key === 'Escape') return
    if (!model || model.state !== 'table' || !model.flat.length || inControl(e.target)) return // the keyboard rule stops inside a control (1.2 §键盘)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const rows = [...el.querySelectorAll('.trow')]
      const cur = rows.findIndex((r) => r.classList.contains('hi'))
      const next = e.key === 'ArrowDown' ? Math.min(model.flat.length - 1, cur + 1) : Math.max(0, cur - 1)
      if (cur !== next) { rows.forEach((r) => r.classList.remove('hi')); if (rows[next]) rows[next].classList.add('hi') }
    } else if (e.key === 'Enter') {
      const row = el.querySelector('.trow.hi[data-href]')
      if (row) { e.preventDefault(); router.go(parseHash(row.dataset.href)) }
    }
  })
  return {
    update(route) {
      const next = queryOf(route.params)
      if (next.window === q.window && next.h.join() === q.h.join() && next.cls === q.cls) return
      q = next; model = null; paint(); read()
    },
    unmount() { dead = true; offs.forEach((off) => off()); setScreenKeys(null); el.replaceChildren() },
  }
}
