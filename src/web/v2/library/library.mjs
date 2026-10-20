// library/library.mjs — the session library (1.8) · #/sessions: 「我要看哪一次运行?」 One row per run, one
// click into the replay desk. Every filter lives in the URL hash (q h project window sort sel — 1.2 §路由): the
// hash is the single source of truth, the tool row writes it, update(route) repaints from it. No statistic lives
// here (D24: this is the source-data list; cross-session numbers are the 总览 page's named SQL).
// Contract: mount(el, ctx) → {update(route), unmount()}; ctx = {api, store, router, toast}.
import { esc, fmtTime } from '../core/fmt.mjs'
import { createVList } from '../core/vlist.mjs'
import { delegate } from '../core/dom.mjs'
import { ensureHarnessIcons, harnessName, harnessIcon, harnessRaw } from '../core/chips.mjs'
import { setScreenKeys } from '../core/keys.mjs'
import { mark, techDetailsHtml } from '../core/ui.mjs'
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { formatHash } from '../core/router.mjs'
import * as W from '../labels/library.mjs'
import { parseFilters, filtersToParams, hasFilters, flattenSessions, applyFilters, listEntries, selectedKey, sessionKey, rowModel, listSignature, filterSignature, scrollDecision, agentMenuModel, agentMenuSignature, projectOptions, captionFacts, readFailWording, loadSessions, capShotMaker, emptyBoardState, filteredAgentLine, agentLabel, WINDOWS } from './logic.mjs'

const ROW_H = 50, POLL_MS = 3000
const hidden = () => typeof document !== 'undefined' && document.hidden

// the screen's fixed DOM: page head, then the tool row, the caption row, the header, the list. No bare text node
// sits between the head and the table (1.2 §页头), and the words live in labels — the shape is pinned by the tests.
export const SKELETON =
  `<div class="page">` +
  `<header class="pagehead" id="libhead"></header>` +
  `<div class="lib">` +
  `<div class="libtools" role="search">` +
  `<input id="libq" type="search" placeholder="${esc(W.SEARCH_PLAIN)}" aria-label="Search sessions" autocomplete="off" spellcheck="false">` +
  `<span class="menuwrap" id="mw-agent"></span><span class="menuwrap" id="mw-project"></span><span class="menuwrap" id="mw-sort"></span>` +
  `<span class="fchips" id="libfchips"></span>` +
  `<button type="button" id="libclear" class="ghostbtn">${esc(W.CLEAR_FILTERS)}</button>` +
  `</div>` +
  `<div class="libcap" id="libcap"></div>` +
  `<div class="libhead">` +
  `<span class="lhs">${esc(W.COL_SESSION)}<button type="button" class="popbtn" data-pop="lib-title-i" aria-label="Where the title comes from" aria-expanded="false" aria-controls="lib-title-i">ⓘ</button>` +
  `<div class="pop" id="lib-title-i" role="dialog" aria-labelledby="lib-title-i-t" hidden><div class="ph" id="lib-title-i-t">Where the title comes from</div><div class="pb">${esc(W.COL_SESSION_TIP)}</div></div></span>` +
  `<span class="ln">${esc(W.COL_CALLS)}</span><span class="lw">${esc(W.COL_LAST)}</span>` +
  `</div>` +
  `<div class="liblist" id="liblist" aria-label="Sessions"></div>` +
  `</div></div>`

// a menu trigger + layer following core/ui.mjs's [data-menu] contract (the kit's menuButton cannot carry icons)
const popMenu = (id, label, labelId, itemsHtml) =>
  `<button type="button" class="popbtn" data-menu="${id}" aria-label="${esc(label)}" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}">` +
  (labelId ? `<span id="${labelId}">${esc(label)}</span>` : esc(label)) + ` <span class="chev" aria-hidden="true">▾</span></button>` +
  `<div class="pop menu" id="${id}" role="menu" hidden>${itemsHtml}</div>`
// one agent item: the chip table's icon + name (an unknown id rides along verbatim), no count (1.2 §页头)
const agentItemsHtml = (model) => model.map((c) =>
  `<button type="button" role="menuitemcheckbox" aria-checked="${c.on}" data-agent="${esc(c.id)}">` +
  `<span class="mchk" aria-hidden="true">${c.on ? '✓' : ''}</span>${harnessIcon(c.id)}` +
  `<span class="miname">${esc(harnessName(c.id === '-' ? null : c.id))}</span>` +
  (c.id !== '-' && harnessRaw(c.id) ? `<span class="miraw">${esc(harnessRaw(c.id))}</span>` : '') + `</button>`).join('')
const sortItemsHtml = (sort) => Object.entries(W.SORTS).map(([k, v]) =>
  `<button type="button" role="menuitem" data-sort="${k}"${sort === k ? ' class="on"' : ''}>${esc(v)}</button>`).join('')

// one session row: two lines — the title (with its hover), and the agent + its marks (only when true / > 0)
// each mark names its kind (data-mark), so what a row says is checkable without its words
const lmark = (kind, inner, tip) => `<span class="lmark" data-mark="${kind}"${tip ? ` title="${esc(tip)}"` : ''}>${inner}</span>`
export function rowHtml(s, sel, now) {
  const m = rowModel(s, now), on = m.key === sel
  const marks = [
    m.entry ? lmark('entry', esc(m.entry)) : '',
    m.project ? lmark('project', esc(m.project.name), m.project.path || m.project.name) : '',
    m.inferred ? lmark('inferred', mark('inf', W.INFERRED_TIP)) : '',
    m.synthesized ? lmark('synthesized', esc(W.SYNTHESIZED), W.SYNTHESIZED_TIP) : '',
    m.multi ? lmark('multi', esc(W.MULTI), W.multiTip(m.multiNames)) : '',
    m.subagent ? lmark('subagent', esc(W.SUBAGENT), W.SUBAGENT_TIP) : '',
    m.logged > 0 ? lmark('logged', esc(W.markLogged(m.logged)), W.loggedTip(m.logged)) : '',
  ].filter(Boolean).join('')
  return `<a class="lrow${on ? ' sel' : ''}${m.dim ? ' dim' : ''}" href="${esc(m.href)}" data-key="${esc(m.key)}"${on ? ' aria-current="true"' : ''}>` +
    `<span class="lmain">` +
    `<span class="lt" title="${esc(m.titleTip)}">${esc(m.titleText)}</span>` +
    `<span class="lsub">${m.harnessIcon}<span class="lhn" title="${esc(m.harnessRaw ? `${m.harnessName} · ${m.harnessRaw}` : m.harnessName)}">${esc(m.harnessName)}</span>${marks ? marks : ''}</span>` +
    `</span>` +
    `<span class="ln"${m.dim ? ' data-mark="probe-only"' : ''} title="${esc(m.dim ? W.PROBE_ONLY_TIP : W.COL_CALLS)}">${m.dim ? esc(W.PROBE_ONLY) : m.calls}</span>` +
    `<span class="lw" title="${esc(m.whenTip)}">${esc(m.when)}</span>` +
    `</a>`
}

// ── the caption row's html (pure — the wording is testable without a DOM): only what changes how far the list can
// be trusted, joined by ·; bookkeeping rides in 技术细节. A failed read WITH an older list on screen says so here,
// without one the failure replaces the table (readFailHtml below).
export function captionHtml(errors, errR, readAt) {
  if (errR && readAt == null) return '' // the failure replaces the table (readFailHtml) — its details are not drawn twice
  const cf = captionFacts(errors)
  const parts = cf.facts.map((x) =>
    `<a href="${esc(formatHash({ area: 'settings', screen: 'settings-storage' }))}" title="${esc(W.CAP_NOT_ALL_TIP)}">${esc(W.capNotAllRead(x.n))} ›</a>`)
  if (errR && readAt != null) parts.push(`${esc(readFailWording(errR).line)} · <button type="button" class="linkbtn" data-act="retry">${esc(W.RETRY)}</button> · ${esc(W.capOldList(fmtTime(readAt)))}`)
  const tech = cf.tech.slice()
  if (errR) tech.push(String((errR.error || '') || 'HTTP ' + errR.status))
  if (!parts.length && !tech.length) return ''
  return parts.join('<span class="capsep" aria-hidden="true">·</span>') + (tech.length ? techDetailsHtml(tech.map((t, i) => [String(i + 1), t])) : '')
}

// ── the states that stand in for the table (pure html, so the words are pinned without a DOM) ────────────────────────
// the read failed and there is no older list: the failure IS the content, never worded as 「还没有会话」
export function readFailHtml(errR) {
  const w = readFailWording(errR)
  return `${esc(w.line)}<br><button type="button" class="linkbtn" data-act="retry">${esc(W.RETRY)}</button>` +
    techDetailsHtml([['Error', String((errR && errR.error) || '')]])
}
// the empty board: 还没有会话, then the capture service's own sentence (read once) with 「截至」, then the way out
export function emptyBoardHtml(shot) {
  const c = emptyBoardState(shot)
  const line2 = c.line ? `${esc(c.line)}${c.asOf != null ? ` · ${esc(W.AS_OF)} ${esc(fmtTime(c.asOf))}` : ''}` : ''
  return `${esc(W.NO_SESSIONS)}<br><span class="dimline">${line2}</span> <a href="${esc(formatHash({ area: 'capture', screen: 'capture', params: {} }))}">${esc(W.GO_CAPTURE)} ›</a>`
}
// filters emptied a non-empty board. When exactly one agent was picked, the line asks whether it is even captured.
export function filteredEmptyHtml(shot, f) {
  let extra = ''
  if (f.h.length === 1) {
    const a = filteredAgentLine(shot, f.h[0])
    if (a && a.service) extra = `<span class="dimline">${esc(a.line)}${a.asOf != null ? ` · ${esc(W.AS_OF)} ${esc(fmtTime(a.asOf))}` : ''}</span><br>`
    else if (a) extra = `<span class="dimline">${esc(a.line)} · <a href="${esc(a.href)}">${esc(W.GO_CAPTURE)} ›</a></span><br>`
  }
  return `${extra}${esc(W.FILTERED_EMPTY)}<br><button type="button" class="linkbtn" data-act="clear">${esc(W.CLEAR_FILTERS)}</button>`
}

export function mount(el, ctx) {
  const { api, store, router, toast } = ctx
  let data = null, errR = null, sig = null, loaded = false, dead = false, vl = null, timer = 0
  let rows = [], entries = [], total = 0, lastFilterSig = null, prevSelKey = null
  let agentSig = null, projSig = null, sortSig = null, headHtml = '', readAt = null
  const cap = capShotMaker(() => api.get('status'), () => api.now()) // the one-shot capture-health read (空态 · the filtered agent)
  let f = parseFilters(router.current().params)
  // a one-time line another screen may have left (1.8: it is a toast, never a banner): take it, so it shows once
  const notice = store.get().libraryNotice || null
  if (notice) { store.set({ libraryNotice: null }); if (toast) toast(notice) }

  el.innerHTML = SKELETON
  const $ = (id) => el.querySelector('#' + id)
  const qEl = $('libq'), listEl = $('liblist'), capEl = $('libcap'), headEl = $('libhead'), clearEl = $('libclear'), fchipsEl = $('libfchips')

  const set = (patch) => router.setParams(patch) // a filter is not a navigation: the hash is replaced

  // ── the page head: 屏名 · 时间窗 · 数据读于 (nothing else — 1.2 §页头) ─────────────────────────────────────────────
  function paintHead() {
    const params = filtersToParams(f)
    const html = pageHeadHtml({
      name: 'Sessions',
      scope: {
        label: 'Time window', value: f.window,
        options: Object.entries(W.WINDOWS).map(([k, v]) => ({ value: k, label: v, href: formatHash({ area: 'sessions', screen: 'library', params: { ...params, ...(k === 'all' ? { window: null } : { window: k }) } }) })),
      },
      readAt,
    })
    if (html !== headHtml) { headHtml = html; headEl.innerHTML = html }
  }

  // ── the tool row: every part syncs in place, so an open menu or a box being typed in is never rebuilt ──────────────
  function paintTools() {
    const all = flattenSessions(data)
    const am = agentMenuModel(all, f), as = agentMenuSignature(am)
    if (as !== agentSig) {
      if (agentSig == null) $('mw-agent').innerHTML = popMenu('lib-agent', W.AGENT_MENU, null, agentItemsHtml(am))
      else { $('lib-agent').innerHTML = agentItemsHtml(am); ensureHarnessIcons($('lib-agent')) }
      agentSig = as
    }
    const po = projectOptions(all, f.project)
    if (po.sig !== projSig) {
      if (projSig == null) $('mw-project').innerHTML = popMenu('lib-project', W.PROJECT_MENU, null, po.html)
      else $('lib-project').innerHTML = po.html
      projSig = po.sig
    }
    if (f.sort !== sortSig) {
      if (sortSig == null) $('mw-sort').innerHTML = popMenu('lib-sort', `${W.SORT_MENU}: ${W.SORTS[f.sort]}`, 'lib-sort-label', sortItemsHtml(f.sort))
      else { $('lib-sort-label').textContent = `${W.SORT_MENU}: ${W.SORTS[f.sort]}`; $('lib-sort').innerHTML = sortItemsHtml(f.sort) }
      sortSig = f.sort
    }
    if (document.activeElement !== qEl && qEl.value !== f.q) qEl.value = f.q // never rewrite the box someone is typing in
    // the active filters, each removable on its own
    const chips = f.h.map((id) => `<button type="button" class="fchip" data-unh="${esc(id)}">${esc(W.activeAgentChip(agentLabel(id)))} ×</button>`).join('')
      + (f.project ? `<button type="button" class="fchip" data-unproj="1">${esc(W.activeProjectChip((all.find((s) => s.project_slug === f.project) || {}).project_name || f.project))} ×</button>` : '')
    if (fchipsEl.innerHTML !== chips) fchipsEl.innerHTML = chips
    clearEl.disabled = !hasFilters(f)
  }

  // ── the caption row and the standing-in states all render through the pure builders above ──────────────────────────
  function paintCaption() {
    const html = captionHtml(data && data.errors, errR, errR ? readAt : null)
    if (capEl.innerHTML !== html) capEl.innerHTML = html
    capEl.style.display = html ? '' : 'none'
  }

  // ── the list area: the table, or the state that stands in for it ────────────────────────────────────────────────────
  function message(html) {
    if (vl) { vl.destroy(); vl = null }
    lastFilterSig = null; prevSelKey = null // the next list is a new one: its first paint scrolls to the highlighted row
    listEl.style.overflow = 'auto'; listEl.innerHTML = `<div class="libempty">${html}</div>`
  }
  function paintList() {
    const sel = selectedKey(rows, f.sel), now = api.now()
    if (!loaded) return message(esc(W.LOADING))
    if (errR && !data) return message(readFailHtml(errR)) // no old list: the failure IS the content, never 「还没有会话」
    const shot = cap.settled
    const wantsShot = !total || (!rows.length && f.h.length === 1) // the 空态, or one agent picked and nothing matched
    if (wantsShot && !shot) cap.read().then(() => { if (!dead) paintList() }) // fires once; the sentence shows when it lands
    if (!total) return message(emptyBoardHtml(shot)) // 还没有会话: the capture service's own sentence, read once, with 「截至」
    if (!rows.length) return message(filteredEmptyHtml(shot, f)) // filters emptied a non-empty board
    // the table: group rows only in the 最近 order (local dates), interleaved as rows of the same fixed-height list
    entries = listEntries(rows, f.sort, now)
    const render = (i) => 'g' in entries[i] ? `<div class="lgroup">${esc(W.GROUPS[entries[i].g])}</div>` : rowHtml(entries[i].s, sel, now)
    const hadFocus = listEl.contains(document.activeElement) // a repaint replaces the row elements: focus follows the highlight
    const fill = () => ensureHarnessIcons(listEl)
    if (!vl) vl = createVList(listEl, { rowHeight: ROW_H, count: entries.length, render, after: fill })
    else vl.update({ count: entries.length, render })
    fill()
    const fsig = filterSignature(f), selIndex = rows.findIndex((s) => sessionKey(s) === sel), d = scrollDecision({ prevSig: lastFilterSig, sig: fsig, selKey: sel, selIndex, prevSelKey })
    lastFilterSig = fsig; prevSelKey = sel
    if (d.kind === 'top') { listEl.scrollTop = 0; vl.update({}) }
    else if (d.kind === 'index') vl.scrollToIndex(d.index)
    if (hadFocus) { const a = listEl.querySelector('.lrow.sel'); if (a) a.focus({ preventScroll: true }) }
  }
  function refresh() {
    const all = flattenSessions(data); total = all.length
    rows = applyFilters(all, f, api.now())
    paintTools(); paintCaption(); paintList()
  }

  // ── data: every 3 s while the page is visible; repaint only when what the list shows changed ───────────────────────
  async function poll() {
    let r
    try { r = await loadSessions(api) } catch (e) { r = { ok: false, error: String((e && e.message) || e) } }
    if (dead) return
    const nextErr = r.ok ? null : r, next = r.ok ? r.data : data
    const s = listSignature(next, nextErr)
    const first = !loaded; loaded = true
    if (r.ok) readAt = api.now()
    if (s === sig && !first) { paintHead(); return } // nothing the list shows changed: no repaint (the head's 数据读于 still moves)
    sig = s; data = next; errR = nextErr
    paintHead(); refresh()
  }

  // ── opening a row and moving the highlight ─────────────────────────────────────────────────────────────────────────
  function open(s) {
    if (!s) return
    set({ sel: sessionKey(s) }) // the way back lands on the same row
    router.go({ area: 'replay', screen: 'replay', project: s.project_slug, id: s.session_id, params: {} })
  }
  const current = () => selectedKey(rows, f.sel)
  function move(to) {
    if (!rows.length) return
    const i = rows.findIndex((s) => sessionKey(s) === current()), j = Math.max(0, Math.min(rows.length - 1, typeof to === 'function' ? to(i) : to))
    set({ sel: sessionKey(rows[j]) })
  }
  setScreenKeys((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target
    if (e.key === '/') { e.preventDefault(); qEl.focus(); return } // never while typing: isTyping() keeps the key in the box
    if (e.key === 'Enter') { if (t && (t.tagName === 'BUTTON' || t.tagName === 'A')) return; e.preventDefault(); return open(rows.find((s) => sessionKey(s) === current())) }
    const step = { ArrowDown: (i) => i + 1, ArrowUp: (i) => i - 1, PageDown: (i) => i + 10, PageUp: (i) => i - 10, Home: () => 0, End: () => rows.length - 1 }[e.key]
    if (step) { e.preventDefault(); move(step) }
  })

  // ── events ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const offs = [
    // a plain click opens the replay here; a modified one (cmd / ctrl / shift / alt) is left to the browser
    delegate(listEl, 'click', '.vrow', (e, row) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return
      const ent = entries[Number(row.dataset.i)]
      e.preventDefault(); if (ent && ent.s) open(ent.s)
    }),
    delegate(listEl, 'click', '[data-act="clear"]', () => set({ q: null, h: null, project: null, window: null })),
    delegate(listEl, 'click', '[data-act="retry"]', () => poll()),
    delegate(el, 'click', '[data-agent]', (e, b) => {
      const id = b.dataset.agent, h = f.h.includes(id) ? f.h.filter((x) => x !== id) : [...f.h, id]
      set({ h: h.length ? h.join(',') : null })
    }),
    delegate(el, 'click', '[data-project]', (e, b) => set({ project: b.dataset.project || null })),
    delegate(el, 'click', '[data-sort]', (e, b) => set({ sort: b.dataset.sort === 'calls' ? 'calls' : null })),
    delegate(el, 'click', '[data-unh]', (e, b) => set({ h: f.h.filter((x) => x !== b.dataset.unh).join(',') || null })),
    delegate(el, 'click', '[data-unproj]', () => set({ project: null })),
  ]
  qEl.addEventListener('input', () => set({ q: qEl.value }))
  clearEl.addEventListener('click', () => set({ q: null, h: null, project: null, window: null }))
  const onVis = () => { if (!document.hidden) poll() }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
  qEl.value = f.q
  paintHead(); paintTools(); paintList()
  poll(); timer = setInterval(() => { if (!hidden()) poll() }, POLL_MS)
  return {
    update(route) { f = parseFilters(route.params); if (loaded) refresh(); else paintTools(); paintHead() },
    unmount() {
      dead = true; clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
      offs.forEach((off) => off())
      if (vl) { vl.destroy(); vl = null }
      setScreenKeys(null)
    },
  }
}
