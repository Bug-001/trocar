// traffic/host.mjs — the host page (1.10) · #/traffic/host/<agent>/<host>: what this one agent sent to this one host.
// A request list (`calls {harness, host}`, newest first, paged by `next` as the reader scrolls) and, for the selected row,
// its request detail (`calls {ref}`) — a column beside the list at ≥ 1440 px, a drawer over it below. The lead line 「这是一次模型调用…」 belongs to
// the row that has a replay link; the detail itself is the 2.6 §C widget (request-view.mjs). Read-only, no polling.
// Contract: mount(el, ctx) → {update(route), unmount()}; ctx = {api, store, router}.
import { esc, bytes, fmtTime, fmtStamp } from '../core/fmt.mjs'
import { CLASS_IDS } from '../core/classes.mjs'
import { harnessKey, harnessName } from '../core/chips.mjs'
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { menuButton, readFailure } from '../core/ui.mjs'
import { setScreenKeys } from '../core/keys.mjs'
import { delegate } from '../core/dom.mjs'
import { revealHeader } from '../core/sensitive.mjs'
import { createVList } from '../core/vlist.mjs'
import { formatHash } from '../core/router.mjs'
import { requestDetailHtml, detailModel } from './request-view.mjs'
import { queryOf, sinceOf, asOfText, asOfHtml, agentSourceNote, routeHarness, classWord, stateHtml } from './traffic.mjs'
import * as W from '../labels/traffic.mjs'

export const ROW_H = 34
export const DETAIL_BREAK = 1440 // the detail is a column at/above this width, a drawer below (1.2 §窄屏)

// the detail's placement, from the media query (pure: a stub matchMedia is enough for a test)
export function detailModeOf(matchMedia) {
  if (typeof matchMedia !== 'function') return 'column' // no media query at all (a test page): the static column form
  try { return matchMedia(`(min-width: ${DETAIL_BREAK}px)`).matches ? 'column' : 'drawer' }
  catch { return 'column' }
}

// one page of `calls {harness, host, class?, since?, after?}` (the screen's first read and every page after it)
export const readPage = (api, { harness, host, cls = null, window = null, after = null, limit } = {}) =>
  api.get('calls', { harness, host, class: cls, since: window ? sinceOf(window) : undefined, after, limit })

// the `calls` document → the list's model. Pure: it eats the server's answer only.
export function listModel(answer) {
  if (!answer || !Array.isArray(answer.records)) return { state: 'none', answer }
  return { state: 'table', rows: answer.records, total: answer.total, asOf: answer.as_of, next: answer.next }
}
// one page more: the rows keep S7's order, a repeated ref never draws twice, `next` empty is the end
export function appendPage(list, page) {
  const next = listModel(page)
  if (next.state !== 'table') return list
  const seen = new Set(list.rows.map((r) => r.ref))
  return { ...list, rows: [...list.rows, ...next.rows.filter((r) => !seen.has(r.ref))], total: next.total, asOf: next.asOf, next: next.next }
}
// does a scroll position ask for the next page? (a screenful of rows before the end)
export function wantMore({ scrollTop = 0, viewHeight = 0, count = 0, rowHeight = ROW_H }) {
  return count > 0 && scrollTop + viewHeight >= (count - 6) * rowHeight
}

// the replay link, by field presence: a `calls` row carries no session key yet, so on C.5 it is never drawn (PR 5 C8).
// Once it does, only a stored model call with a session lands on a replay step.
export function replayLinkOf(row) {
  if (!row || row.class !== 'llm' || row.retention === 'log' || !row.session_id) return null
  return `#/session/${encodeURIComponent(row.session_id)}?call=${encodeURIComponent(row.call_id)}`
}

// the retention mark of a list row: 只记日志 links to its storage cell; 只存了长度 carries the legacy sentence
export function retentionHtml(row, harness) {
  if (!row || !row.retention) return ''
  if (row.retention === 'log') {
    const href = formatHash({ screen: 'settings-storage', params: { h: harnessKey(harness), class: row.class || '' } })
    return `<a class="rmark" data-mark="log" href="${esc(href)}" title="See what this class keeps in the storage settings">${esc(W.RETENTION_MARK.log.label)} ›</a>`
  }
  if (row.retention === 'legacy-meta') return `<span class="rmark" data-mark="legacy-meta" title="${esc(W.RETENTION_MARK['legacy-meta'].tip)}">${esc(W.RETENTION_MARK['legacy-meta'].label)}</span>`
  return ''
}

// the time column: the clock when it is today, date and clock otherwise; the ISO time on hover
export const whenHtml = (ts, now) => {
  if (!ts) return '<span class="c2">—</span>'
  const d = new Date(ts)
  const text = isNaN(d) ? String(ts) : (d.toDateString() === new Date(now).toDateString() ? fmtTime(d) : fmtStamp(d))
  return `<span class="tcell" title="${esc(ts)}">${esc(text)}</span>`
}

// one list row (a link that selects it: the route carries ref)
export function rowHtml(r, { selected = false, unmatched = null, harness, window, cls = null, now = Date.now() } = {}) {
  const params = { window }
  if (cls) params.class = cls
  if (r.ref) params.ref = r.ref
  const href = formatHash({ screen: 'traffic-host', harness: routeHarness(harness), host: r._host, params })
  const w = classWord(r.class, harness, unmatched)
  const replay = replayLinkOf(r)
  return `<a class="hrow${selected ? ' sel' : ''}" href="${esc(href)}" data-ref="${esc(r.ref || '')}"${selected ? ' aria-current="true"' : ''}>` +
    `${whenHtml(r.ts, now)}` +
    `<span class="cell-endpoint mono" title="${esc(r.endpoint || '')}">${esc(r.endpoint || '')}</span>` +
    `<span class="cell class">${esc(w.word)}</span>` +
    `<span class="cell num">${r.sent_bytes != null ? esc(bytes(r.sent_bytes)) : esc(W.UNRECORDED)}</span>` +
    `<span class="cell num">${r.received_bytes != null ? esc(bytes(r.received_bytes)) : esc(W.UNRECORDED)}</span>` +
    `<span class="cell marks">${retentionHtml(r, harness)}${r.error ? `<span class="rmark fail" data-mark="failed" title="The exact status is in the request details">${esc(W.FAILED)}</span>` : ''}</span>` +
    `<span class="cell go">${replay ? `<a class="replay" href="${esc(replay)}" title="Go to this step">${esc(W.OPEN_IN_REPLAY)}</a>` : ''}</span>` +
    `</a>`
}

// the lead line of a model call's detail — only where a replay link exists; its raw request folds closed
export function detailLeadHtml(row) {
  const replay = replayLinkOf(row)
  if (!replay) return null
  return `<div class="rqd-lead"><a href="${esc(replay)}">${esc(W.MODEL_CALL_LEAD)}</a></div>`
}

// the caption row: 截至 + the count, the agent-source note, the class filter
export function captionHtml(list, { harness, window, cls = null } = {}) {
  const asOf = asOfText(list.asOf)
  const parts = [`${asOf ? asOfHtml(list.asOf, asOf) : ''}<span class="cap-item">${esc(W.TOTAL_N(list.total))}</span>`, agentSourceNote(list.rows)]
  const hrefOf = (patch) => {
    const params = { window }
    if (cls) params.class = cls
    for (const [k, v] of Object.entries(patch)) if (v == null || v === '') delete params[k]; else params[k] = v
    return formatHash({ screen: 'traffic-host', harness: routeHarness(harness), host: list.host, params })
  }
  const classMenu = menuButton({
    label: W.FILTER_CLASS, title: W.FILTER_CLASS,
    items: CLASS_IDS.map((id) => ({ label: W.classWord(id), href: hrefOf({ class: id }) })),
  })
  const chips = cls
    ? [`<a class="fchip" href="${esc(hrefOf({ class: null }))}" title="Remove this filter">${esc(W.FILTER_CLASS)}:${esc(W.classWord(cls))} <span class="x" aria-hidden="true">×</span></a>`,
      `<span class="cap-item cap-note">${esc(W.CLASS_FILTER_NOTE(W.classWord(cls)))}</span>`]
    : []
  return `<div class="tcap">${parts.join('')}<div class="tfilters">${classMenu}${chips.join('')}</div></div>`
}

// ── the screen ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export function mount(el, ctx) {
  const { api, router } = ctx
  const route0 = router.current()
  const harness = routeHarness(route0.harness), host = route0.host || ''
  let dead = false, q = queryOf(route0.params), ref = route0.params.ref || null, revealed = null
  let list = null, err = null, readAt = null, unmatched = null, detail = null, detailErr = null, mode = 'column'

  // a window change keeps class and drops ref (1.10 host-page head); the crumbs' links carry the window too
  const winHref = (w) => formatHash({ screen: 'traffic-host', harness, host, params: { window: w, ...(q.cls ? { class: q.cls } : {}) } })
  const kept = () => (q.cls ? { window: q.window, class: q.cls } : { window: q.window })
  const crumbs = () => ([
    { label: 'Traffic', href: formatHash({ screen: 'traffic', params: kept() }) },
    { label: harnessName(harness), href: formatHash({ screen: 'traffic', params: { ...kept(), h: harness } }) },
    { label: host },
  ])
  const scope = () => ({ label: 'window', value: q.window, options: W.WINDOW_LABEL.map((o) => ({ ...o, href: winHref(o.value) })) })
  const listEl = () => el.querySelector('#hlist')

  function paint() {
    if (dead) return // a late answer or a media change after unmount never paints over the next screen
    const savedScroll = listEl() ? listEl().scrollTop : 0
    const head = pageHeadHtml({ crumbs: crumbs(), scope: scope(), readAt })
    let body = ''
    if (err && (!list || list.state !== 'table')) body = stateHtml('error', { r: err })
    else if (!list) body = stateHtml('loading')
    else if (list.state === 'none') {
      const a = list.answer || {}
      body = stateHtml('error', { r: { status: null, error: a.error } })
    } else if (!list.rows.length) body = `<div class="tstate" data-empty${q.cls ? ` data-class="${esc(q.cls)}"` : ''}>${esc(q.cls ? W.EMPTY_HOST_CLASS(W.classWord(q.cls)) : W.EMPTY_HOST)}</div>`
    else body = captionHtml({ ...list, host }, { harness, window: q.window, cls: q.cls }) +
      `<div class="hhead" aria-hidden="true"><span class="cell">time</span><span class="cell-endpoint">endpoint</span><span class="cell class">class</span>` +
      `<span class="cell num">${esc(W.COL.sent)}</span><span class="cell num">${esc(W.COL.recv)}</span><span class="cell marks"></span><span class="cell go"></span></div>` +
      `<div class="hlist" id="hlist" role="list" aria-label="Requests"></div>`
    // the detail: a column beside the list at the breakpoint, a drawer over it below; without a selection the column
    // says what it waits for and the drawer stays closed
    const detailBody = !ref
      ? (mode === 'column' ? `<div class="d-empty">${esc(W.PICK_ONE)}</div>` : '')
      : detailHtml()
    el.innerHTML = `<div class="thost ${mode}">${head}<div class="tbody">` +
      `<div class="tlist">${body}</div>` +
      `<aside class="hdetail${ref ? ' open' : ''}" id="hdetail" aria-label="Request details">${detailBody}</aside>` +
      `</div></div>`
    paintRows()
    const le = listEl()
    if (le && savedScroll) le.scrollTop = savedScroll
  }

  function paintRows() {
    const le = listEl()
    if (!le || !list || list.state !== 'table') return
    if (!le._wired && typeof le.addEventListener === 'function') { le._wired = true; le.addEventListener('scroll', onScroll, { passive: true }) }
    const rowAt = (i) => rowHtml({ ...list.rows[i], _host: host }, { selected: !!(list.rows[i] && list.rows[i].ref === ref), unmatched, harness, window: q.window, cls: q.cls, now: api.now() })
    if (typeof document !== 'undefined' && typeof le.replaceChildren === 'function') {
      if (!le._vl) le._vl = createVList(le, { rowHeight: ROW_H, count: list.rows.length, render: rowAt })
      else le._vl.update({ count: list.rows.length, render: rowAt })
    } else {
      le.innerHTML = list.rows.map((_, i) => `<div class="vrow" style="height:${ROW_H}px">${rowAt(i)}</div>`).join('')
    }
  }
  let fetching = false
  async function onScroll() {
    const le = listEl()
    if (!le || fetching || !list || list.state !== 'table' || !list.next) return
    if (!wantMore({ scrollTop: le.scrollTop || 0, viewHeight: le.clientHeight || 0, count: list.rows.length })) return
    fetching = true
    const r = await readPage(api, { harness, host, cls: q.cls, window: q.window, after: list.next })
    fetching = false
    if (dead || !r.ok) return
    list = appendPage(list, r.data)
    paintRows()
  }

  function detailHtml() {
    if (detailErr) {
      const f = readFailure(W.THIS_REQUEST, detailErr, { id: 'rqd-fail' })
      return `<div class="d-err"><p>${esc(f.line)}</p><button type="button" class="tbtn" data-act="retry-detail">${esc(W.RETRY)}</button>${f.tech}</div>`
    }
    if (!detail) return `<div class="d-empty">${esc(W.LOADING)}</div>`
    const row = list && list.state === 'table' ? list.rows.find((r) => r.ref === ref) : null
    const lead = row ? detailLeadHtml(row) : null // a deep-linked ref the list has not loaded still opens its detail
    return `<div class="d-head"><button type="button" class="iconbtn dclose" data-act="close-detail" aria-label="${esc(W.CLOSE_DETAIL)}" title="${esc(W.CLOSE_DETAIL)}">×</button></div>` +
      (lead || '') + requestDetailHtml(detail, { revealed, foldRequest: !!lead })
  }

  async function readDetail() {
    detail = null; detailErr = null
    paint()
    const at = ref
    const r = await api.get('calls', { ref: at })
    if (dead || ref !== at) return // a slower earlier answer never paints over the newer selection (invariant 4)
    const m = r.ok ? detailModel(r.data) : null
    if (m && m.rec) detail = m
    else detailErr = { status: r.ok ? null : r.status, error: (m && m.error) || r.error } // an unknown ref is an errors[] entry, never an empty body
    paint()
  }
  async function readList() {
    const asked = q
    const r = await readPage(api, { harness, host, cls: asked.cls, window: asked.window })
    if (dead || q !== asked) return
    if (r.ok) { readAt = api.now(); err = null; list = listModel(r.data) }
    else { err = r; if (!list || list.state !== 'table') list = null }
    paint()
  }

  api.get('classes').then((r) => {
    // `unmatched` is not a C.5 field yet: while it is absent (or unreadable), 其他 stays 其他 (PR 5 C8)
    if (dead || !r.ok || !r.data || !r.data.unmatched) return
    unmatched = r.data.unmatched
    paint()
  }, () => {})
  paint()
  readList()
  if (ref) readDetail()

  const offs = [
    delegate(el, 'click', '[data-act="retry"]', () => { err = null; paint(); readList() }),
    delegate(el, 'click', '[data-act="retry-detail"]', () => readDetail()),
    delegate(el, 'click', '[data-act="close-detail"]', () => router.setParams({ ref: null })),
    // one credential header value at a time: the server blanks them, so「Show」re-reads the record with that one value
    // (2.6 §C); a failed or empty read keeps the detail as it is, the value still masked
    delegate(el, 'click', '[data-reveal]', async (e, b) => {
      const name = b.dataset.reveal, at = ref
      const r = await revealHeader(api, at, name)
      if (dead || ref !== at) return
      const m = r.ok ? detailModel(r.data) : null
      if (!m || !m.rec) return
      detail = m; revealed = name
      paint()
    }),
    // a plain click selects the row here (a replace, not a new history entry); a modified click is the browser's
    delegate(el, 'click', 'a.hrow', (e, a) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return
      if (e.target.closest && e.target.closest('a.replay')) return // the row's replay link is its own destination
      e.preventDefault()
      router.setParams({ ref: a.dataset.ref || null })
    }),
  ]
  // the detail's placement follows the media query; Esc closes the drawer (the route loses ref)
  const mm = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia : null
  if (mm) {
    mode = detailModeOf(mm)
    const mq = mm(`(min-width: ${DETAIL_BREAK}px)`)
    const onMedia = (e) => { mode = e.matches ? 'column' : 'drawer'; paint() }
    if (mq && mq.addEventListener) { mq.addEventListener('change', onMedia); offs.push(() => mq.removeEventListener('change', onMedia)) }
  }
  const inControl = (t) => !!(t && t.closest && t.closest('[data-menu],[data-pop],.pop,button,input,select,textarea,a.replay'))
  setScreenKeys((e) => {
    if (e.key === 'Escape') { if (ref) { e.preventDefault(); router.setParams({ ref: null }) } return }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (!list || list.state !== 'table' || !list.rows.length || inControl(e.target)) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const i = list.rows.findIndex((r) => r.ref === ref)
      const next = e.key === 'ArrowDown' ? Math.min(list.rows.length - 1, i + 1) : Math.max(0, i - 1)
      const row = list.rows[next]
      if (row && row.ref && row.ref !== ref) { revealed = null; router.setParams({ ref: row.ref }) }
    }
  })

  return {
    update(route) {
      const next = queryOf(route.params)
      const nextRef = route.params.ref || null
      if (next.window !== q.window || next.cls !== q.cls) {
        q = next; ref = nextRef; revealed = null; detail = null; list = null
        paint(); readList()
        if (ref) readDetail()
        return
      }
      if (nextRef !== ref) {
        ref = nextRef; revealed = null
        paintRows()
        if (ref) readDetail()
        else { detail = null; detailErr = null; paint() }
      }
    },
    unmount() {
      dead = true; offs.forEach((off) => off())
      const le = listEl(); if (le && le._vl) le._vl.destroy()
      setScreenKeys(null); el.replaceChildren()
    },
  }
}
