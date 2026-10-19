// replay/replay.mjs — the replay desk (回放台): one session, step by step. It owns the state object every area renders from,
// fetches the session (cursor-paged), keeps it live (1.5 s poll), and schedules the repaint of each area:
//   scrubbing    → only what depends on the playhead (bar .cur marks, context window, outline, resources, raw panel)
//   brush window → bars, cache band and rails        a new fetch → everything
// The URL carries the step (`?step=N`, 1-based): scrubbing replaces it (no history pile-up), a different session is a new entry.
// Contract: mount(el, ctx) → {update(route), unmount()}; ctx = {api, store, router}; the start route is ctx.router.current().
import { esc } from '../core/fmt.mjs'
import { L } from '../core/labels.mjs' // the saw legend's estimate note (1.3) — the only L left in this file
import { ensureHarnessIcons } from '../core/chips.mjs'
import { setScreenKeys } from '../core/keys.mjs'
import { buildLanes } from './lanes.mjs'
import { breakSteps } from './analysis.mjs'
import { loadFold, saveFold } from './fold.mjs'
import { landPlayhead } from './follow.mjs'
import { renderSaw, renderOverview, repositionBrush, markCurrent, renderProblemNav, problemSteps, wireTimeline, barsThatFit, fitWindow, capWindow } from './timeline.mjs'
import { renderRails, wireRails, highlightRange, reviewing } from './rails.mjs'
import { renderContextWindow, wireCtxWin } from './ctxwin.mjs'
import { renderOutline, wireOutline, jumpToAnchor, jumpToResourceBlock } from './outline.mjs'
import { createJumpQueue } from './jump.mjs'
import { createPricingLoader } from './pricing.mjs'
import { renderResources, wireResources } from './resources.mjs'
import { renderRawPanel, wireRawPanel } from './rawpanel.mjs'
import { openDetail, closeDetail, wireDetail } from './detail.mjs'
import { initLayout } from './layout.mjs'
import { renderSessionHead, wireSessionHead, captureGap } from './header.mjs'
import { stepBarHtml, wireStepBar } from './stepbar.mjs'
import { SESSION_NOT_LISTED, BACK_TO_SESSIONS } from '../labels/shell.mjs'
import { LOADING, CACHE_LEGEND, CACHE_LEGEND_UNK } from '../labels/replay.mjs'

const PAGE_LIMIT = 60 // calls whose verbatim body rides on one page; the timeline itself is never limited by it
const POLL_MS = 1500

// the desk's own head: the session head (title · chip · 项目 · 跟随最新 · ⓘ) and the quiet 会话保真行 under it (1.2 §会话头).
// No statistic and no banner ever lives here: the numbers are behind ⓘ, a failed read says so in the content area.
const DESKHEAD = `<div id="deskhead"></div>`

// exported for the string-level tests (the trace's legend row): the desk's static shape lives here and nowhere else
export const SKELETON = `<div id="pages">
<div id="leftpage">
<div id="saw">
  <div class="trow trow-problem"><div class="tgut tgut-prob" id="probnav">问题</div><div class="tlane"><div class="probrow" id="probrow"></div></div></div>
  <div class="trow trow-bars"><div class="tgut tgut-ctx" id="sawgut">上下文</div><div class="tlane"><div class="sawrow" id="sawrow"><div id="reviewbracket"><span class="rbend" aria-hidden="true">推测</span></div></div></div></div>
  <div class="trow"><div class="tgut">缓存</div><div class="tlane"><div class="cacherow" id="cacherow"></div></div></div>
  <div class="trow trow-asks" id="askrow" style="display:none"><div class="tgut">提问</div><div class="tlane"><div class="askrow" id="askscale"></div></div></div>
  <div class="trow trow-ovw"><div class="tgut" title="整个会话一览 —— 拖括号平移,拖边缘缩放上面的柱">全程</div><div class="tlane"><div class="ovstrip" id="ovstrip"></div></div></div>
  <div class="trow"><div class="tgut"></div><div class="tlane"><div class="sawaxis"><span id="sawstart"></span><span id="sawend"></span></div></div></div>
  <div class="sawlegend">
    <span id="viewswitch"></span>
    <span id="complegend"></span>
    <span class="cachelegend" title="每格按缓存判定画:高 = 命中复用 ≥70%,中 = 部分 ≥30%,低 = 冷 / 断 <30%;虚线 = 没有用量;四档之外单独样式 = 这个服务商的缓存数字含义不确定;失败步不画档位">${esc(CACHE_LEGEND)} · ${esc(CACHE_LEGEND_UNK)}</span>
    <span id="viewrange"></span>
    <span id="nomain" style="display:none"></span>
    <span class="spacer"></span>
    <div class="navbtns"><kbd>←</kbd><kbd>→</kbd> 换步 <button type="button" class="pgbtn" id="prev" aria-label="上一步">‹</button><span class="mono" id="phlabel"></span><button type="button" class="pgbtn" id="next" aria-label="下一步">›</button><button type="button" class="pgbtn" id="endBtn" title="跳到最新一步">最新</button></div>
  </div>
</div>
<div id="rails"></div>
<main>
  <div id="ctxnav"></div>
  <div id="maindiv" title="拖动调整大纲宽度 · 双击复位"></div>
  <div id="midcol"><div id="stepbar"></div><div id="ctxwin"><div class="cwload">载入中…</div></div></div>
</main>
</div>
<div id="divider" title="拖动调整右页宽度 · 双击复位"></div>
<div id="rightpage"><div id="rpbar" role="button" tabindex="0" aria-expanded="false" title="展开右页"></div><div id="rpbody"><div id="resexp"></div><div id="rawpanel"></div></div></div>
</div>`

const storage = () => { try { return window.localStorage } catch { return null } }
const stepOf = (route) => { const n = parseInt(route && route.params && route.params.step, 10); return Number.isFinite(n) && n >= 1 ? n : null }

export function mount(el, ctx) {
  const { api, store, router } = ctx
  el.innerHTML = `<div class="desk">${DESKHEAD}${SKELETON}</div>`
  const $ = (sel) => el.querySelector(sel)
  const E = { saw: $('#saw'), rails: $('#rails'), deskhead: $('#deskhead'), stepbar: $('#stepbar'), ctxwin: $('#ctxwin'), ctxnav: $('#ctxnav'), resexp: $('#resexp'), rawpanel: $('#rawpanel'), detail: document.getElementById('detail') }
  const route0 = router.current()

  // ── the state every area renders from ────────────────────────────────────────────────────────────────────────────
  const s = {
    ctx, root: el, dead: false,
    project: route0.project, id: route0.id, initialStep: stepOf(route0),
    meta: null, A: null, raw: [], probes: { count: 0, series: [] }, projectsFlat: [], health: null,
    trunc: null, logged: null, sourceE: null, gap: null, totals: null, errNote: null,
    lanes: [], anchor: null, anchorTs: [], breaks: [], problems: [], playhead: 0, follow: true, prevN: 0, sawView: 'ctx',
    view: { lo: 0, hi: 0 }, viewSig: null, brushDragging: false,
    pageLimit: PAGE_LIMIT, pageCur: 0, pageInfo: null, pageSig: null, pageReaimed: false,
    selTick: null, viewPin: null, diffRef: null, curFlat: [], drawerFlat: [], curRemoved: [],
    landedFor: -1, turnLanded: new Set(), // the window's landing ran for that step; turns opened for the AUTOMATIC landing only (a reader's own jump writes the D12 fold memory, 2.5)
    openBlocks: new Set(), navOpen: new Set(['sys', 'life-file', 'life-load']), navSeenExpanded: false,
    collapsedRails: new Set(), subSeeded: new Set(), subgroupOpen: false, bgOpen: false,
    railsFolded: typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches, rpOpen: false,
    lastCheapSig: null, lastRenderSig: null, pricing: store.get().pricing || null, pricingErr: null,
    turnFold: loadFold(storage()),
  }
  const sessionKey = () => s.project + '::' + s.id

  // ── actions the areas call back into ─────────────────────────────────────────────────────────────────────────────
  s.persistFold = () => saveFold(storage(), s.turnFold)
  s.renderRaw = () => renderRawPanel(E.rawpanel, s)
  s.renderNav = () => { renderOutline(E.ctxnav, s); renderResources(E.resexp, s) }
  // a jump (the problem pager, a drawer call link, a resource card) aimed at a step whose body is not on the loaded page waits for the page and runs
  // once after the window has repainted; the next user move clears it (jump.mjs)
  const jumps = createJumpQueue({
    getPlayhead: () => s.playhead, getCall: () => s.anchor && s.anchor.calls[s.playhead],
    perform: (j) => (j.kind === 'anchor' ? jumpToAnchor(s, j.id) : jumpToResourceBlock(s, j.resKey)),
  })
  s.jumpTo = (step, jump) => { setPlayhead(step, true); jumps.queue(s.playhead, jump) }
  s.queueJump = (jump) => jumps.queue(s.playhead, jump)
  s.openDetail = (lane, i) => openDetail(E.detail, s, lane, i)
  s.setPlayhead = setPlayhead
  s.setView = setView
  s.ensurePage = ensurePage
  // the 内容对比步 (2.3): the compare menu's choice survives scrubbing, clears on a session switch; a change repaints the
  // middle column (the 「新」 marks and the 组成 growth read it)
  s.setDiff = (idx) => { s.diffRef = idx; renderMid() }
  s.renderStep = () => { E.stepbar.innerHTML = stepBarHtml(s) }

  // ── header: the session head + the 会话保真行 (1.2 §会话头 · §会话保真行); every number is behind ⓘ ───────────────
  function renderHeader() {
    renderSessionHead(E.deskhead, s)
    if (s.meta) ensureHarnessIcons(E.deskhead)
  }

  // ── empty and failed states: every widget that carries per-session data is neutralised, nothing of the last session stays ──
  function renderEmpty(msg) {
    s.brushDragging = false; s.anchor = null; s.lanes = []; s.curFlat = []; s.curRemoved = []; s.breaks = []; jumps.clear()
    s.landedFor = -1; s.turnLanded.clear()
    E.stepbar.innerHTML = ''
    // the desk's failure state keeps its honest error text; the window's own ⑧ (载入中) is the same quiet shape
    E.ctxwin.innerHTML = `<div class="${msg === LOADING ? 'cwload' : 'empty'}">${esc(msg)}${s.errNote && msg !== LOADING ? `<div class="emptywhy">${s.errNote}</div>` : ''}</div>`
    E.ctxnav.innerHTML = ''; E.rails.innerHTML = ''; E.resexp.innerHTML = ''; E.rawpanel.innerHTML = ''
    $('#sawrow').innerHTML = '<div id="reviewbracket"><span class="rbend" aria-hidden="true">推测</span></div>'; $('#cacherow').innerHTML = ''; $('#ovstrip').innerHTML = ''
    $('#probrow').innerHTML = ''; $('#askscale').innerHTML = ''; $('#askrow').style.display = 'none'
    for (const id of ['#sawstart', '#sawend', '#phlabel', '#viewrange']) $(id).textContent = ''
    $('#sawgut').textContent = '上下文'; $('#viewswitch').innerHTML = ''; $('#complegend').innerHTML = ''; $('#nomain').style.display = 'none'
    renderProblemNav(E.saw, s) // no problems: the row name stops quoting the last session's count and ‹ › disappear
    closeDetail(E.detail, s)
  }
  function resetSession() {
    jumps.clear()
    // a different session: nothing of the last one may survive (the first board left diffRef / navOpen / expanded behind)
    Object.assign(s, { meta: null, A: null, raw: [], probes: { count: 0, series: [] }, lanes: [], anchor: null, anchorTs: [], breaks: [], problems: [], playhead: 0, follow: true, prevN: 0, sawView: 'ctx',
      view: { lo: 0, hi: 0 }, viewSig: null, pageCur: 0, pageInfo: null, pageSig: null, pageReaimed: false, selTick: null, viewPin: null, diffRef: null,
      curFlat: [], drawerFlat: [], curRemoved: [], landedFor: -1,
      navOpen: new Set(['sys', 'life-file', 'life-load']), navSeenExpanded: false, collapsedRails: new Set(), subSeeded: new Set(), subgroupOpen: false, bgOpen: false,
    railsFolded: typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches, rpOpen: false,
      trunc: null, logged: null, sourceE: null, gap: null, totals: null, errNote: null,
      lastCheapSig: null, lastRenderSig: null })
    s.openBlocks.clear()
    s.turnLanded.clear()
    E.stepbar.innerHTML = ''
  }

  // ── repaint ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const restoreSelection = () => {
    if (!s.selTick) return
    const l = s.lanes.find((x) => x.id === s.selTick.laneId)
    if (l && reviewing(l)) highlightRange(s, l, s.selTick.i)
  }
  function renderPlayheadAreas() { s.renderStep(); renderContextWindow(E.ctxwin, s); s.renderNav(); s.renderRaw() }
  function renderMid() { renderPlayheadAreas() }
  function renderAll() {
    renderHeader()
    if (!s.anchor) return
    renderSaw(E.saw, s); renderRails(E.rails, s); renderOverview(E.saw, s)
    renderPlayheadAreas()
    restoreSelection()
  }

  // the drawer was built from the call objects of an earlier fetch: after a new page arrives, repaint it for the selected tick
  function refreshDrawer() {
    if (!s.selTick || !E.detail.classList.contains('open')) return
    const l = s.lanes.find((x) => x.id === s.selTick.laneId)
    if (l && l.calls[s.selTick.i]) openDetail(E.detail, s, l, s.selTick.i)
  }

  // ── navigation ───────────────────────────────────────────────────────────────────────────────────────────────────
  function syncUrl() { router.setParams({ step: String(s.playhead + 1) }, { replace: true }) } // scrubbing is not a navigation
  function setPlayhead(i, manual) {
    if (!s.anchor || !s.anchor.calls.length) return // a zero-call session: "⇥ latest" is a no-op, not a TypeError
    s.viewPin = null // scrubbing returns the panel to the call raw
    jumps.clear() // a move by the reader ends any jump still waiting for its page (jumpTo queues its own after this)
    const N = s.anchor.calls.length, np = Math.max(0, Math.min(N - 1, i))
    if (np !== s.playhead) { s.openBlocks.clear(); s.turnLanded.clear() } // a different call: its blocks start collapsed, no landing turn lingers
    s.playhead = np
    if (manual) s.follow = np === N - 1
    // keep the scrub target inside the brush window: pan it, keep its width
    if (np < s.view.lo || np >= s.view.hi) {
      const w = Math.max(1, s.view.hi - s.view.lo)
      const lo = Math.min(Math.max(0, np - ((w / 2) | 0)), Math.max(0, N - w))
      s.view.lo = lo; s.view.hi = Math.min(N, lo + w)
      renderSaw(E.saw, s); renderRails(E.rails, s)
    } else markCurrent(E.saw, s) // the common case: only the current marks move
    repositionBrush(E.saw, s)
    renderPlayheadAreas()
    restoreSelection()
    ensurePage(s.anchor.calls[s.playhead], false, selectedCall())
    syncUrl()
  }
  // how many bars #sawrow can draw (timeline.mjs barsThatFit). A lane that has no width yet (not laid out) cannot judge: no limit.
  const sawCapacity = () => { const w = $('#sawrow').clientWidth; return w > 0 ? barsThatFit(w) : Infinity }
  // a window wider than the lane draws is clipped, and the steps it clips are the latest ones: shrink it, keeping the playhead in it
  function fitView() {
    const w = fitWindow({ lo: s.view.lo, hi: s.view.hi, K: sawCapacity(), playhead: s.playhead })
    if (w.lo === s.view.lo && w.hi === s.view.hi) return false
    s.view.lo = w.lo; s.view.hi = w.hi; return true
  }
  function setView(lo, hi, redraw) {
    const N = s.anchor ? s.anchor.calls.length : 0
    if (!N) return
    lo = Math.max(0, Math.min(N - 1, Math.round(lo))); hi = Math.max(lo + 1, Math.min(N, Math.round(hi)))
    ;({ lo, hi } = capWindow({ lo, hi, prev: s.view, K: sawCapacity(), playhead: s.playhead })) // never wider than the lane can draw
    if (lo === s.view.lo && hi === s.view.hi && redraw !== true) return
    s.view.lo = lo; s.view.hi = hi
    renderSaw(E.saw, s); renderRails(E.rails, s)
    if (redraw) renderOverview(E.saw, s); else repositionBrush(E.saw, s)
  }
  // the playhead landed on a call whose body was not on the loaded page: re-aim the window around it (centred, so a few steps either
  // way stay inside) and fetch. The call keeps rendering meanwhile — its cheap meta is real — marked "not on this page", never blank.
  // `also` is a second call that should ride the same page when it fits (the lane call whose drawer is open next to the playhead).
  // Only the playhead and a user's tick selection ever re-aim: repainting the drawer after a fetch does not, so two calls that cannot
  // share a window cannot pull the window back and forth.
  function ensurePage(call, force, also) {
    if (!call || !call.paged_out) return false
    let c = Math.max(0, (call.gi | 0) - ((PAGE_LIMIT / 2) | 0))
    if (also && also.gi != null) {
      const lo = Math.min(call.gi, also.gi), hi = Math.max(call.gi, also.gi)
      if (hi - lo < PAGE_LIMIT - 2) c = Math.max(0, lo - (((PAGE_LIMIT - (hi - lo)) / 2) | 0))
    }
    const held = (x) => x.gi >= s.pageCur - 1 && x.gi < s.pageCur + PAGE_LIMIT // the requested window already holds it: a re-poll would loop
    // (the "载入这一页" button forces it anyway)
    if (!force && (c === (s.pageCur | 0) || (held(call) && (!also || held(also))))) return false
    s.pageCur = c; s.follow = false; s.pageReaimed = false
    s.lastCheapSig = null; s.lastRenderSig = null
    poll()
    return true
  }
  const selectedCall = () => {
    if (!s.selTick) return null
    const l = s.lanes.find((x) => x.id === s.selTick.laneId)
    return (l && l.calls[s.selTick.i]) || null
  }

  // ── fetching ─────────────────────────────────────────────────────────────────────────────────────────────────────
  // a failed read is said IN the content area (no banner, no dot): the reason, and that the raw capture is untouched
  const fail = (title, msg) => { s.errNote = `<b>${esc(title)}</b> · ${esc(msg)} —— 盘上的原始采集是完整的(源真相不受影响)。` }

  // the price table: a failed read keeps its reason (the header, raw panel and drawer say 价表读不出 · why) and every poll retries it
  const prices = createPricingLoader(() => api.get('pricing'), s.pricing)
  async function loadPricing() {
    if (!(await prices.load()) || s.dead) return
    s.pricing = prices.table(); s.pricingErr = prices.err()
    if (s.pricing) store.set({ pricing: s.pricing })
    renderHeader(); if (s.anchor) { s.renderRaw(); refreshDrawer() }
  }

  let polling = false, again = false
  async function poll() {
    if (s.dead) return
    loadPricing().catch((e) => console.error(e))
    if (polling) { again = true; return }
    polling = true
    try { do { again = false; await pollOnce() } while (again && !s.dead) } catch (e) { console.error(e) } finally { polling = false }
  }
  s.poll = poll
  async function pollOnce() {
    const key = sessionKey()
    const stale = () => s.dead || key !== sessionKey() // the session was switched while a request was in flight
    // a failed listing is NOT an empty one: say why
    const pj = await api.get('sessions')
    if (stale()) return
    if (!pj.ok) { fail('无法列出会话', pj.error + ' —— 修好来源或重启服务。'); renderEmpty('无法列出会话。'); s.lastCheapSig = null; s.lastRenderSig = null; return }
    const projects = pj.data.projects || []
    s.projectsFlat = projects.flatMap((p) => p.sessions || [])
    const cur = s.projectsFlat.find((x) => x.project_slug === s.project && x.session_id === s.id)
    // pick the window BEFORE the fetch: /api/projects already carries the true call count, so the tail is known without a round trip.
    // On a session switch — and while following — the window parks on the tail. A manual scrub off the live end clears `follow`.
    const srvTotal = s.pageSig === key && s.pageInfo && typeof s.pageInfo.total === 'number' ? s.pageInfo.total : null
    const tailCur = Math.max(0, (srvTotal != null ? srvTotal : ((cur && cur.calls) || 0)) - PAGE_LIMIT)
    if (s.pageSig !== key) { s.pageSig = key; s.pageCur = tailCur; s.pageInfo = null; s.pageReaimed = false } else if (s.follow) s.pageCur = tailCur
    if (cur) {
      const cs = key + '|' + cur.calls + '|' + cur.last_ts + '|' + s.pageCur // the window is part of the signature: moving it must refetch
      if (cs === s.lastCheapSig) return
      s.lastCheapSig = cs
    }
    const res = await api.get('session', { id: s.id, after: s.pageCur || null, limit: PAGE_LIMIT })
    if (stale()) return
    if (!res.ok) {
      s.lastCheapSig = null; s.lastRenderSig = null // so the next poll retries; a stuck signature would keep the board wedged after recovery
      // the hash names a session the library does not have: say so HERE (1.2 §Edge cases — 就地显示,不跳走), with a way back
      if (res.status === 404) { s.errNote = null; renderEmpty(`${SESSION_NOT_LISTED} · <a href="#/sessions">${BACK_TO_SESSIONS}</a>`); renderHeader(); return }
      // any other failure stays on this screen, says why, and the next poll retries
      fail('加载失败', `${res.error || '不知道原因'}。服务挂了就重启;会话太大会按尾部截取提供。`); renderEmpty('这个会话加载失败。')
      renderHeader()
      return
    }
    s.errNote = null
    const d = res.data
    s.pageInfo = d.page || null
    s.trunc = d.truncated || null
    s.logged = d.logged || null
    s.sourceE = d.source || null
    // the server may assemble FEWER calls than /api/projects counted: if our window landed past what it has, every call would be paged
    // out and the board blank. Re-aim once at the tail the server really has. `follow` stays: that tail IS the live end.
    if (s.pageInfo && s.pageInfo.returned === 0 && s.pageInfo.total > 0) {
      const c2 = Math.max(0, s.pageInfo.total - PAGE_LIMIT)
      if (c2 !== (s.pageCur | 0) && !s.pageReaimed) { s.pageReaimed = true; s.pageCur = c2; s.lastCheapSig = null; s.lastRenderSig = null; again = true; return }
    } else s.pageReaimed = false
    s.raw = d.records || []; s.probes = d.probes || { count: 0, series: [] }; s.meta = d.meta || null
    const sig = key + '|' + (s.pageCur | 0) + '|' + s.raw.length + '|' + (s.raw.length ? String((s.raw[s.raw.length - 1] || {}).ts_request || (s.raw[s.raw.length - 1] || {}).id || '') : '')
    if (sig === s.lastRenderSig) return
    s.lastRenderSig = sig
    s.A = d.analyzed || { lanes: [], steps: [] }
    s.lanes = buildLanes(s.A, s.probes)
    s.anchor = s.lanes.find((l) => l.kind === 'main') || s.lanes[0] || null
    // the 采集缺口 is judged against the whole session's time (the once-per-open capture-health answer, 1.2 §会话保真行)
    judgeGap()
    if (!s.anchor || !s.anchor.calls.length) {
      renderEmpty(s.probes.count ? `这个会话只有 token 计数(${s.probes.count} 次),没有可回放的模型调用。` : '这个会话里还没有追踪到模型调用。')
      renderHeader(); return
    }
    s.anchorTs = s.anchor.calls.map((c) => Date.parse(c.ts))
    s.breaks = breakSteps(s.anchor.calls)
    s.problems = problemSteps(s.anchor.calls) // 1.3 问题道: cache breaks + failed calls, one list for the pager
    const N = s.anchor.calls.length, prevPh = s.playhead
    // the URL named a step: start there (out of range is clamped); else follow the live end, or clamp. Whenever the playhead moved
    // by itself the URL's step is made truthful too (replace, so growth leaves no history entry per call).
    const land = landPlayhead({ N, playhead: s.playhead, follow: s.follow, initialStep: s.initialStep })
    s.playhead = land.playhead; s.follow = land.follow; s.initialStep = null
    if (s.playhead !== prevPh) s.openBlocks.clear() // live-follow moved to a new call
    // brush window: a new session starts on the whole of it when that fits the lane, else on the last steps that fit — or, when the URL
    // named an earlier step, on the ones around it (fitView below; the playhead was landed above). On live growth keep the reader's
    // window but clamp it, and extend it when parked at the end.
    if (s.viewSig !== key) { s.viewSig = key; s.view = { lo: 0, hi: N } } else {
      if (s.view.hi >= (s.prevN || N)) s.view.hi = N
      s.view.hi = Math.min(N, s.view.hi || N); s.view.lo = Math.max(0, Math.min(s.view.lo, N - 1)); if (s.view.hi <= s.view.lo) s.view.hi = Math.min(N, s.view.lo + 1)
    }
    s.prevN = N
    // a view that does not contain the playhead (a window from before it moved) is panned to it
    if (s.playhead < s.view.lo || s.playhead >= s.view.hi) { const w = Math.max(1, s.view.hi - s.view.lo); s.view.lo = Math.min(Math.max(0, s.playhead - ((w / 2) | 0)), Math.max(0, N - w)); s.view.hi = Math.min(N, s.view.lo + w) }
    fitView() // a new long session, or a parked window that grew past what the lane draws
    renderAll()
    refreshDrawer()
    jumps.settle() // a jump that was waiting for this page lands now that the window shows the step
    if (land.syncUrl) syncUrl()
    ensurePage(s.anchor.calls[s.playhead], false, selectedCall()) // a step named by the URL may sit outside the tail window
  }

  // ── capture health: read once per desk open, only to judge the 采集缺口 (1.2 §会话保真行); unreadable → no judgement
  function judgeGap() {
    const steps = (s.A && s.A.steps) || []
    if (!steps.length || !s.meta) { s.gap = null; return }
    const t0 = Date.parse(steps[0].ts), t1 = Date.parse(steps[steps.length - 1].ts)
    s.gap = captureGap(s.health, { start: t0, end: t1 }, s.meta.harness)
  }
  api.get('status').then((r) => { if (!s.dead && r.ok) { s.health = r.data; judgeGap(); if (s.A) renderHeader() } }).catch((e) => console.error(e))

  const onRp = () => { s.rpOpen = !s.rpOpen; const rp = el.querySelector('#rightpage'); if (rp) { rp.classList.toggle('open', s.rpOpen); const b = el.querySelector('#rpbar'); if (b) b.setAttribute('aria-expanded', String(s.rpOpen)) } }
  const rpbar = el.querySelector('#rpbar')
  if (rpbar) { rpbar.addEventListener('click', onRp); rpbar.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRp() } }) }
  const offs = [() => { if (rpbar) { rpbar.removeEventListener('click', onRp) } }, wireTimeline(E.saw, s), wireRails(E.rails, s), wireCtxWin(E.ctxwin, s), wireOutline(E.ctxnav, s), wireResources(E.resexp, s),
    wireRawPanel(E.rawpanel, s), wireDetail(E.detail, s), wireSessionHead(E.deskhead, s), wireStepBar(E.stepbar, s), initLayout(el)]
  const onKey = (e) => {
    if (e.key === 'Escape' || !s.anchor) return
    const N = s.anchor.calls.length
    if (e.key === 'ArrowLeft') setPlayhead(s.playhead - 1, true)
    else if (e.key === 'ArrowRight') setPlayhead(s.playhead + 1, true)
    else if (e.key === 'Home') setPlayhead(0, true)
    else if (e.key === 'End') setPlayhead(N - 1, true)
    else return
    e.preventDefault()
  }
  setScreenKeys(onKey)
  const onEscape = () => closeDetail(E.detail, s)
  document.addEventListener('v2:escape', onEscape)
  const timer = setInterval(poll, POLL_MS) // the desk keeps reading; 「跟随最新」 only decides whether the playhead follows growth
  // the lane's width changes with the window and with the right-page divider: watch both. Only a window that no longer fits is touched.
  const refit = () => { if (s.anchor && fitView()) { renderSaw(E.saw, s); renderRails(E.rails, s); renderOverview(E.saw, s) } }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : null
  if (ro) ro.observe($('#sawrow'))
  window.addEventListener('resize', refit)

  renderEmpty('载入中…')
  poll()

  return {
    update(route) {
      if (route.project !== s.project || route.id !== s.id) { // another session
        resetSession(); renderEmpty('载入中…')
        s.project = route.project; s.id = route.id; s.initialStep = stepOf(route)
        poll(); return
      }
      const st = stepOf(route) // the same session, only the step moved (our own scrubbing lands here too, and is a no-op)
      if (st != null && s.anchor && st - 1 !== s.playhead) setPlayhead(st - 1, true)
      else if (st != null && !s.anchor) s.initialStep = st
    },
    unmount() {
      s.dead = true
      clearInterval(timer); if (ro) ro.disconnect(); window.removeEventListener('resize', refit)
      for (const f of offs) { try { f() } catch (e) { console.error(e) } }
      setScreenKeys(null)
      document.removeEventListener('v2:escape', onEscape)
      closeDetail(E.detail, s); E.detail.innerHTML = ''
      E.deskhead.innerHTML = ''; E.stepbar.innerHTML = ''
    },
  }
}
