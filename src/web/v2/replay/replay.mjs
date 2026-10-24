// replay/replay.mjs — the replay desk (回放台): one session, step by step, over the desk model (model.mjs) fed by the answer files
// (4.4 §答案文件; packs.mjs; 2.3 §读与画 加载器). It owns the state object every area renders from, opens from the head, fills from the
// sealed packs by the loader's priority, keeps the session live (each poll round: the head If-None-Match, a Range read on each open
// tail; the anchor lane's ledger by `lane`; the followed step's open reply bodies), and schedules the repaint of each area:
//   scrubbing    → only what depends on the playhead (bar .cur marks, context window, outline, resources, raw panel), at most once
//                  per animation frame; a step whose lane is not held keeps what is drawn for 150 ms, then draws its row's parts
//                  with empty frames for the rows (frameFor)
//   brush window → bars, cache band and rails        an answer → the lanes it touched, then the playhead's panels when their
//                  signature moved (playheadSig, spec 1.4 D64), so a selection in them survives a live session's growth
// The playhead, the selected tick, the compare step and the brush edges are held as rids; step numbers are derived. The URL
// carries the step (`?step=N`, 1-based): scrubbing replaces it (no history pile-up), a different session is a new entry.
// Contract: mount(el, ctx) → {update(route), unmount()}; ctx = {api, store, router}; the start route is ctx.router.current().
// Each session has its own desk instance (openDesk): its state, root and nodes, its reads under its own AbortController. Leaving it (another
// screen, another session) detaches it into the session cache (session-cache.mjs, D71③): its poll stops, its root leaves the page, its
// reads in flight finish. Coming back attaches the same instance — the step it showed — and polls once: a conditional head, a Range per tail.
import { esc } from '../core/fmt.mjs'
import { api as rootApi, scoped } from '../core/api.mjs'
import { sessionCache } from './session-cache.mjs'
import { setScreenKeys } from '../core/keys.mjs'
import { openModal } from '../core/dom.mjs'
import { keyAction } from './keymap.mjs'
import { buildLanes, anchorLane, stepsOf, nearestByTs } from './lanes.mjs'
import { createDesk, readLedger, applyLedger, indexOf, ridAt, stepOf as deskStep } from './model.mjs'
import { parseLines, applyFile, applyHead } from './packs.mjs'
import { get, getText } from '../core/http.mjs'
import { breakSteps } from './analysis.mjs'
import { loadFold, saveFold } from './fold.mjs'
import { landPlayhead, createStepReads, packOrder } from './follow.mjs'
import { createLoader } from './loader.mjs'
import { createPoller, INTERVAL } from '../core/poll.mjs'
import { renderSaw, renderOverview, repositionBrush, markCurrent, renderProblemNav, problemSteps, wireTimeline, barsThatFit, fitWindow, capWindow, renderRough as roughRows, chapterHere, placeView } from './timeline.mjs'
import { renderRails, wireRails, highlightRange, reviewing } from './rails.mjs'
import { renderContextWindow, wireCtxWin, emptyFrameHtml, rowKeys } from './ctxwin.mjs'
import { renderOutline, wireOutline, jumpToAnchor, jumpToResourceBlock } from './outline.mjs'
import { createJumpQueue } from './jump.mjs'
import { createPricingLoader } from './pricing.mjs'
import { renderResources, wireResources } from './resources.mjs'
import { renderRawPanel, wireRawPanel } from './rawpanel.mjs'
import { openDetail, closeDetail, wireDetail } from './detail.mjs'
import { initLayout } from './layout.mjs'
import { renderSessionHead, wireSessionHead, captureGap, behindOf } from './header.mjs'
import { stepBarHtml, roughStepHtml, wireStepBar } from './stepbar.mjs'
import { loadBodies, bodyCache, clearOverrides, overrideScope, isRetryable } from './cell.mjs'
import { SESSION_NOT_LISTED, BACK_TO_SESSIONS } from '../labels/shell.mjs'
import { CACHE_LEGEND, CACHE_LEGEND_UNK, KEYS_TITLE, KEY_LIST, RETRY, THIS_SESSION, moreLanes } from '../labels/replay.mjs'
import { readFailure } from '../core/ui.mjs'

const POLL_MS = INTERVAL.session
const BUSY_MS = 150 // 2.3 §车道未到手: how long a step whose lane is not held leaves the desk as it is

// the desk's own head: the session head (title · chip · 项目 · 跟随最新 · ⓘ) and the quiet 会话保真行 under it (1.2 §会话头).
// No statistic and no banner ever lives here: the numbers are behind ⓘ, a failed read says so in the content area.
const DESKHEAD = `<div id="deskhead"></div>`

// exported for the string-level tests (the trace's legend row): the desk's static shape lives here and nowhere else
export const SKELETON = `<div id="pages">
<div id="leftpage">
<div id="saw">
  <div class="chaprow"><div class="tgut"></div><div class="chapnav" id="chapnav"></div></div>
  <div class="tkrow tkrow-problem"><div class="tgut tgut-prob" id="probnav">Problems</div><div class="tlane"><div class="probrow" id="probrow"></div></div></div>
  <div class="tkrow tkrow-bars"><div class="tgut tgut-ctx" id="sawgut">Context</div><div class="tlane"><div class="sawrow" id="sawrow"><div id="reviewbracket"><span class="rbend" aria-hidden="true">inferred</span></div></div></div></div>
  <div class="tkrow"><div class="tgut">Cache</div><div class="tlane"><div class="cacherow" id="cacherow"></div></div></div>
  <div class="tkrow tkrow-asks" id="askrow" style="display:none"><div class="tgut">Prompts</div><div class="tlane"><div class="askrow" id="askscale"></div></div></div>
  <div class="tkrow tkrow-ovw"><div class="tgut" title="The whole session at a glance — drag the bracket to pan, drag its edges to zoom the bars above">Whole session</div><div class="tlane"><div class="ovstrip" id="ovstrip"></div></div></div>
  <div class="tkrow"><div class="tgut"></div><div class="tlane"><div class="sawaxis"><span id="sawstart"></span><span id="sawend"></span></div></div></div>
  <div class="sawlegend">
    <span id="viewswitch"></span>
    <span id="complegend"></span>
    <span class="cachelegend" title="Each cell is drawn from the cache verdict: high = cache hit ≥70%, middle = partial ≥30%, low = cold or broken <30%; dashed = no usage; a separate style outside the four levels = what this provider's cache numbers mean is not certain; failed steps draw no level">${esc(CACHE_LEGEND)} · ${esc(CACHE_LEGEND_UNK)}</span>
    <span id="viewrange"></span>
    <span id="nomain" style="display:none"></span>
  </div>
</div>
<div id="rails"></div>
<main>
  <div id="ctxnav"></div>
  <div id="maindiv" title="Drag to resize the outline · double-click to reset"></div>
  <div id="midcol"><div id="stepbar"></div><div id="ctxwin">${emptyFrameHtml()}</div></div>
</main>
</div>
<div id="divider" title="Drag to resize the right page · double-click to reset"></div>
<div id="rightpage"><div id="rpbar" role="button" tabindex="0" aria-expanded="false" title="Expand the right page"></div><div id="rpbody"><div id="resexp"></div><div id="rawpanel"></div></div></div>
</div>`

// what the playhead's panels (window, outline, resources, raw panel) draw from: equal → not repainted (spec 1.4 D64). The anchor
// lane's row at the playhead, its held list (by bid) and reply definitions, the frame (frameFor) and the reader's choices; another lane's
// growth never repaints the window.
export function playheadSig(s, frame = 'rows') {
  const a = s.anchor, c = (a && a.calls[s.playhead]) || null
  const st = c && s.desk ? deskStep(s.desk, c.rid) : null
  const ref = a && s.diffRef != null ? a.calls[s.diffRef] : null
  return JSON.stringify([a && a.id, c, frame, st && st.held ? [st.flat.map((b) => b.bid), st.reply, st.detail] : null,
    ref ? ref.rid : null, [...(s.openBlocks || [])].sort(), [...(s.navOpen || [])].sort(), s.viewPin ? s.viewPin.resKey : null,
    !!s.pricing, s.pricingErr || null, s.bodyFail ? s.bodyFail.size : 0])
}

// 2.3 §车道未到手: a step whose lane is held draws its rows; one that is not keeps the desk as it is for BUSY_MS from `since`
// (when the playhead reached it), then draws its row's parts with empty frames for the rows
export const frameFor = ({ held, since, now }) => (held ? 'rows' : now - since < BUSY_MS ? 'keep' : 'busy')

// The URL's `step` (1.2 §路由: 1-based, out of range clamps to the ends). `raw` is the parameter as written, `M` the lane's step
// count (0 = not known yet: only the lower end clamps). → {step, rewrite}: `rewrite` = the URL must be written back as `step`.
export function stepParam(raw, M = 0) {
  const n = Number(String(raw ?? '').trim())
  let step = Number.isFinite(n) ? Math.trunc(n) : 1
  if (step < 1) step = 1
  if (M > 0 && step > M) step = M
  return { step, rewrite: String(step) !== String(raw) }
}

// the hash names a session the server does not know (1.2 §Edge cases — 就地显示,不跳走): said in the window, with a way back
export const notListedHtml = () => `<div class="empty" id="notlisted">${esc(SESSION_NOT_LISTED)} · <a href="#/sessions">${esc(BACK_TO_SESSIONS)}</a></div>`

const storage = () => { try { return window.localStorage } catch { return null } }
const hasStep = (route) => !!(route && route.params && route.params.step != null && route.params.step !== '')
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
const yieldNow = () => (globalThis.scheduler && typeof globalThis.scheduler.yield === 'function' ? globalThis.scheduler.yield()
  : typeof MessageChannel === 'function' ? new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r() }; c.port2.postMessage(0) })
    : new Promise((r) => setTimeout(r, 0)))
const frame = (f) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(f) : setTimeout(f, 16))

const SCROLLED = ['#ctxwin', '#ctxnav', '#resexp', '#rawpanel', '#rails'] // scroll positions a detached node loses
const keyOf = (route) => route.project + '::' + route.id

// one session's desk, detached until attach(el, ctx, route); → {key, attach, detach, update, dispose, bytes}
function openDesk(ctx, route0) {
  // its own reads: the screen's ctx.api is aborted when the screen unmounts, and this desk outlives that in the session cache
  const reads = new AbortController()
  const api = scoped(rootApi, reads.signal)
  const root = document.createElement('div')
  root.className = 'desk'
  root.innerHTML = DESKHEAD + SKELETON
  // every query runs inside the desk's own root: a detached desk keeps working on its own nodes, never on null
  const $ = (sel) => root.querySelector(sel)
  const E = { saw: $('#saw'), rails: $('#rails'), deskhead: $('#deskhead'), stepbar: $('#stepbar'), ctxwin: $('#ctxwin'), ctxnav: $('#ctxnav'), resexp: $('#resexp'), rawpanel: $('#rawpanel'), detail: document.getElementById('detail') }
  let host = null // the element the desk hangs in while attached
  let size = 0 // the session and lane answers it applied, in decoded characters (bytes(): the session cache's measure)
  let missed = false // an answer applied while detached was not drawn: attach() repaints every area
  // the areas' own reads (an opened row's bodies in the window, the drawer, the raw panel) go through the desk's loader too (2.3 加载器)
  const areaApi = { ...api, get: (n, p, o) => (n === 'block' || n === 'lane' ? via(n === 'block' ? 0 : 1, n, p, o) : api.get(n, p, o)) }

  // ── the state every area renders from ────────────────────────────────────────────────────────────────────────────
  const fresh = () => ({
    desk: createDesk(), meta: null, lanes: [], anchor: null, anchorTs: [], breaks: [], problems: [], playhead: 0, playRid: null, follow: true, sawView: 'ctx',
    view: { lo: 0, hi: 0 }, viewSig: null, selTick: null, viewPin: null, diffRef: null, curFlat: [], drawerFlat: [], curRemoved: [],
    followLanding: false, // the playhead was last moved by 跟随最新, not by the reader: the window lands on the reply (1.4 §打开一步时落在哪)
    landedFor: null, replyFor: null, // the window's landing ran for that rid; the reply rows' open state belongs to that rid
    navOpen: new Set(['sys', 'life-file', 'life-load']), navSeenExpanded: false, collapsedRails: new Set(), subSeeded: new Set(), subgroupOpen: false, bgOpen: false,
    railsFolded: typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches, rpOpen: false,
    gap: null, totals: null, errNote: null, lastPhSig: null, unheld: null, notListed: false, goodKey: null, goodAt: null, staleErr: null,
    bodyFail: new Map(), // a body read that failed: ref → its failed body (2.3 §读失败)
  })
  const s = {
    ctx: { ...ctx, api: areaApi }, root, dead: false, project: route0.project, id: route0.id, initialStep: hasStep(route0) ? stepParam(route0.params.step).step : null,
    ...fresh(), headFollow: null, health: null,
    openBlocks: new Set(), turnLanded: new Set(), // open rows by key (bid#n, rp:bid): they survive a step change while the bid stays
    reads, // aborted when the desk is disposed (evicted from the session cache)
    pricing: ctx.store.get().pricing || null, pricingErr: null,
    turnFold: loadFold(storage()),
  }
  const sessionKey = () => s.project + '::' + s.id
  const alive = () => !s.dead && host != null && root.isConnected

  // ── actions the areas call back into ─────────────────────────────────────────────────────────────────────────────
  s.persistFold = () => saveFold(storage(), s.turnFold)
  s.renderRaw = () => renderRawPanel(E.rawpanel, s)
  s.renderNav = () => { renderOutline(E.ctxnav, s); renderResources(E.resexp, s) }
  const curCall = () => (s.anchor && s.anchor.calls[s.playhead]) || null
  const heldAt = (c) => !!(c && deskStep(s.desk, c.rid).held)
  // a jump (the problem pager, a drawer call link, a resource card) aimed at a step whose lane is not held waits for the lane and
  // runs once after the window has repainted; the next reader move clears it (jump.mjs)
  const jumps = createJumpQueue({
    getPlayhead: () => s.playhead, getCall: curCall, getHeld: () => heldAt(curCall()),
    perform: (j) => (j.kind === 'anchor' ? jumpToAnchor(s, j.id) : jumpToResourceBlock(s, j.resKey)),
  })
  s.jumpTo = (step, jump) => { setPlayhead(step, true); jumps.queue(s.playhead, jump) }
  s.queueJump = (jump) => jumps.queue(s.playhead, jump)
  s.openDetail = (lane, i) => openDetail(E.detail, s, lane, i)
  s.setPlayhead = setPlayhead
  // ‹ › and [ ] (1.3 §章): to global step g — at once when its row is here, else as a named step whose bars come from the head's cols
  s.chapterGo = (g) => {
    const rid = s.anchor ? ridAt(s.desk, s.anchor.id, g) : null, i = rid != null ? s.anchor.ridLocal.get(rid) : undefined
    if (i != null) setPlayhead(i, true); else nameStep(g + 1)
  }
  s.setView = setView
  // the 内容对比步 (2.3): the compare menu's choice survives scrubbing, clears on a session switch
  s.setDiff = (idx) => { s.diffRef = idx; drawPlayhead() }
  s.renderStep = () => { E.stepbar.innerHTML = stepBarHtml(s) }

  function renderHeader() { s.headFollow = s.follow; renderSessionHead(E.deskhead, s); syncUrl() }

  // ── empty and failed states: every widget that carries per-session data is neutralised, nothing of the last session stays ──
  // `msg` empty → ⑧, the empty frame (1.4: no text, no control); else the honest failure sentence, Retry, and the reason in details
  function renderEmpty(msg) {
    s.brushDragging = false; s.anchor = null; s.lanes = []; s.curFlat = []; s.curRemoved = []; s.breaks = []; jumps.clear()
    s.landedFor = null; s.turnLanded.clear(); s.lastPhSig = null
    E.stepbar.innerHTML = ''
    E.ctxwin.__units = null
    E.ctxwin.innerHTML = msg ? `<div class="empty">${esc(msg)}${s.errNote ? `<div class="emptywhy">${s.errNote}</div>` : ''}</div>` : emptyFrameHtml()
    E.ctxnav.innerHTML = ''; E.rails.innerHTML = ''; E.resexp.innerHTML = ''; E.rawpanel.innerHTML = ''
    $('#sawrow').innerHTML = '<div id="reviewbracket"><span class="rbend" aria-hidden="true">inferred</span></div>'; $('#cacherow').innerHTML = ''; $('#ovstrip').innerHTML = ''
    $('#probrow').innerHTML = ''; $('#chapnav').innerHTML = ''; $('#askscale').innerHTML = ''; $('#askrow').style.display = 'none'
    for (const id of ['#sawstart', '#sawend', '#viewrange']) $(id).textContent = ''
    $('#sawgut').textContent = 'Context'; $('#viewswitch').innerHTML = ''; $('#complegend').innerHTML = ''; $('#nomain').style.display = 'none'
    renderProblemNav(E.saw, s) // no problems: the row name stops quoting the last session's count and ‹ › disappear
    if (host) closeDetail(E.detail, s) // the drawer is shared by every screen: a detached desk closed it when it left
  }
  // ── rids: what the reader holds survives an answer that moves step numbers (a late row, an older page, a relane) ─────────
  function pin() {
    const a = s.anchor, at = (i) => (a && a.calls[i] ? a.calls[i].rid : null)
    const sl = s.selTick && s.lanes.find((l) => l.id === s.selTick.laneId)
    return { diff: s.diffRef != null ? at(s.diffRef) : null, lo: at(s.view.lo), hi: at(s.view.hi - 1), atEnd: !!a && s.view.hi >= a.calls.length,
      sel: sl && sl.calls[s.selTick.i] ? { laneId: sl.id, rid: sl.calls[s.selTick.i].rid } : null }
  }
  function unpin(p) {
    const a = s.anchor, idx = (rid) => (rid != null && a ? a.ridLocal.get(rid) : undefined)
    const d = idx(p.diff); s.diffRef = d ?? null
    const lo = idx(p.lo), hi = idx(p.hi)
    if (lo != null && hi != null && hi >= lo) s.view = { lo, hi: hi + 1 }
    if (p.sel) { const l = s.lanes.find((x) => x.id === p.sel.laneId), i = l && l.ridLocal.get(p.sel.rid); s.selTick = i != null ? { laneId: l.id, i } : null }
  }
  // a named step (the URL's `step=`, Home) → its index in the anchor lane once its skeleton row and its lane are here, else -1
  // (2.3 §点名的一步不在手里). A lane read that failed lands it too: the step then says so (2.3 §读失败)
  function namedAt() {
    const a = s.anchor, M = (s.desk.head && s.desk.head.steps) || a.count || a.calls.length
    const rid = ridAt(s.desk, a.id, Math.max(1, Math.min(M, s.initialStep)) - 1), i = rid == null ? undefined : a.ridLocal.get(rid)
    return i ?? -1
  }
  // the playhead from its rid: its call's place in the anchor lane; a call that left the lane → the anchor call nearest in time. A named
  // step lands directly once it is here; until then a drawn desk keeps its step and a desk that never drew stays ⑧ (no playhead)
  function placePlayhead(prevRow) {
    const a = s.anchor, N = a.calls.length
    if (s.initialStep != null) {
      const i = namedAt()
      if (i >= 0) {
        const land = landPlayhead({ N, playhead: s.playhead, follow: s.follow, initialStep: i + 1 })
        s.playhead = land.playhead; s.follow = land.follow; s.initialStep = null; s.followLanding = false
        s.playRid = a.calls[s.playhead].rid
        return true
      }
      if (s.playRid == null) return false
      s.follow = false
    }
    const was = s.playRid
    if (s.follow) s.playhead = N - 1
    else {
      const i = was != null ? a.ridLocal.get(was) : undefined
      s.playhead = i != null ? i : prevRow ? nearestByTs(a, prevRow.ts, Math.min(s.playhead, N - 1)) : Math.min(s.playhead, N - 1)
    }
    s.playRid = a.calls[s.playhead].rid
    if (s.playRid !== was) s.followLanding = s.follow // follow brought a new call in: the window lands on its reply (1.4:72)
    return s.playRid !== was
  }

  // ── repaint ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const restoreSelection = () => {
    if (!s.selTick) return
    const l = s.lanes.find((x) => x.id === s.selTick.laneId)
    if (l && reviewing(l)) highlightRange(s, l, s.selTick.i)
  }
  // the playhead's panels, at most once per animation frame: a call inside a frame that already drew waits for the next one
  let inFrame = false, queued = false, busyTimer = null
  // the outline, the explorer and the raw panel follow the window in a task of their own (2.3 归约前沿: no task over 50 ms): a step of a
  // long session is the window's thousands of nodes plus the ledger's lists, and one task drew both. Several paints before it runs
  // draw these once, for the playhead then.
  let sideDue = false
  const drawSides = () => { if (sideDue) return; sideDue = true; yieldNow().then(() => { sideDue = false; if (!s.dead && s.anchor) { s.renderNav(); s.renderRaw() } }) }
  function drawPlayhead() {
    if (inFrame) { if (!queued) { queued = true; frame(() => { queued = false; if (!s.dead) paintPlayhead() }) } return }
    inFrame = true; frame(() => { inFrame = false })
    paintPlayhead()
  }
  function paintPlayhead() {
    if (!host) { missed = true; return } // a detached desk draws nothing: attach() repaints
    const c = curCall()
    if (!c || s.playRid == null) return // a named step not here yet on a desk that never drew: ⑧ stays
    const held = heldAt(c), t = nowMs()
    if (held) s.unheld = null
    else if (!s.unheld || s.unheld.rid !== c.rid) s.unheld = { rid: c.rid, at: t }
    const f = frameFor({ held, since: s.unheld ? s.unheld.at : 0, now: t })
    if (busyTimer != null) { clearTimeout(busyTimer); busyTimer = null }
    if (f === 'keep') { busyTimer = setTimeout(() => { busyTimer = null; if (!s.dead) paintPlayhead() }, BUSY_MS - (t - s.unheld.at)); aim(); return }
    const sig = playheadSig(s, f)
    s.renderStep() // 'Step N / M' moves with every new call
    if (sig !== s.lastPhSig) {
      // drawn from what is here: the open rows' bodies are read by the step's own reads once the playhead rests (aim)
      renderContextWindow(E.ctxwin, s, { busy: f === 'busy' }); drawSides(); s.lastPhSig = sig
    }
    if (s.follow !== s.headFollow) renderHeader() // the follow chip (a scrub onto or off the live end, a tick selection)
    syncUrl() // the one write point for the drawn step: every path that draws a step reaches it
    jumps.settle() // a jump that was waiting for this step's lane lands now that the window shows it
    aim()
  }
  function renderAll() {
    if (!host) { missed = true; return }
    if (!s.anchor || s.playRid == null) { renderRough(); return }
    renderHeader()
    if (!namedRows()) { renderSaw(E.saw, s); renderOverview(E.saw, s) }
    renderRails(E.rails, s); watchRails()
    paintPlayhead()
    restoreSelection()
  }
  // 2.3 §大致页面 (D71①): until the playhead stands on a row, the session head alone draws the page — the header, the whole-session
  // overview, the playhead chapter's bars, the step label, the lane names, a context frame sized from head.last (no text, no control);
  // the first such paint is marked 'desk-rough'. A tier-0 head draws the calls by time and no bars (1.5 K-31).
  let roughMarked = false
  function renderRough() {
    renderHeader()
    const head = s.desk.head
    if (!host || !head || !head.steps) return
    const at = Math.max(0, Math.min(head.steps, s.initialStep ?? head.steps) - 1)
    roughRows(E.saw, s, at, sawCapacity())
    E.stepbar.innerHTML = head.tier ? roughStepHtml(at + 1, head.steps) : ''
    renderRails(E.rails, s); watchRails()
    if (head.lanesMore) E.rails.insertAdjacentHTML('beforeend', `<div class="railsmore" data-more="${head.lanesMore}">${esc(moreLanes(head.lanesMore))}</div>`)
    E.ctxwin.__units = null; E.ctxwin.innerHTML = emptyFrameHtml(head.last ? head.last.n : 0)
    if (!roughMarked && typeof performance !== 'undefined') { roughMarked = true; performance.mark('desk-rough') }
  }
  // a named step not here yet (a chapter jump, Home) on a desk that has drawn: its chapter's bars from the head, the rest as it was
  function namedRows() {
    const head = s.desk.head
    if (s.initialStep == null || !head || !head.tier || !head.steps) return false
    roughRows(E.saw, s, Math.min(head.steps, s.initialStep) - 1, sawCapacity()); return true
  }
  // the drawer was built from the rows of an earlier answer: repaint it for the selected tick
  function refreshDrawer() {
    if (!s.selTick || !E.detail || !E.detail.classList.contains('open')) return
    const l = s.lanes.find((x) => x.id === s.selTick.laneId)
    if (l && l.calls[s.selTick.i]) openDetail(E.detail, s, l, s.selTick.i)
  }

  // ── navigation ───────────────────────────────────────────────────────────────────────────────────────────────────
  const shownStep = () => (s.anchor ? s.anchor.no(s.playhead) + 1 : null) // by the step's own `i` (a desk fed by files may hold gaps)
  // the URL says what the reader sees (1.2 §路由): following → no step and no call; otherwise the drawn step. Written only on a
  // difference (every write counts toward WebKit's limit; our own write comes back through update() as a no-op), replacing history
  function syncUrl() {
    const n = shownStep(), r = s.ctx.router.current()
    if (n == null || s.initialStep != null || !alive() || r.screen !== 'replay' || r.id !== s.id || r.project !== s.project) return // a named step not landed yet keeps its URL
    const want = s.follow ? { step: null, call: null } : { step: String(n) }, have = r.params
    if (Object.entries(want).some(([k, v]) => (have[k] ?? null) !== v)) s.ctx.router.setParams(want, { replace: true })
  }
  // `followLanding`: 跟随最新 brought the playhead here (followOn) → this step lands on the reply; any other move lands by the change
  // line. Set BEFORE the repaint below, because the landing runs once per step, inside that repaint (1.4 §打开一步时落在哪).
  function setPlayhead(i, manual, followLanding = false) {
    if (!s.anchor || !s.anchor.calls.length) return // a zero-call session: "⇥ latest" is a no-op, not a TypeError
    s.viewPin = null // scrubbing returns the panel to the call raw
    s.followLanding = followLanding
    jumps.clear() // a move by the reader ends any jump still waiting for its lane (jumpTo queues its own after this)
    s.initialStep = null // and any named step still waiting to land
    const N = s.anchor.calls.length, np = Math.max(0, Math.min(N - 1, i | 0))
    if (np !== s.playhead) s.turnLanded.clear() // a different call: no landing turn lingers; open rows stay by bid (1.4:114)
    s.playhead = np; s.playRid = s.anchor.calls[np].rid
    if (manual) s.follow = np === N - 1 // the reader's move: on the newest call it follows, anywhere else it does not
      // keep the scrub target inside the brush window, which stays inside its chapter (1.3 §章): pan it, keeping its width; another
    // chapter's window becomes this chapter's
    const ch = chapterHere(s), v = placeView(s.view, np, ch.c0, ch.c1, sawCapacity())
    if (v.lo !== s.view.lo || v.hi !== s.view.hi) {
      s.view.lo = v.lo; s.view.hi = v.hi
      renderSaw(E.saw, s); renderRails(E.rails, s); watchRails()
    } else markCurrent(E.saw, s) // the common case: only the current marks move
    repositionBrush(E.saw, s)
    drawPlayhead()
    restoreSelection()
  }
  // how many bars #sawrow can draw (timeline.mjs barsThatFit). A lane that has no width yet (not laid out, or not in the document) cannot
  // judge: no limit. Measured on the bars row's grid column, not on #sawrow: the detail lanes narrow to the window's bar count (1.3)
  const sawCapacity = () => {
    const saw = $('#sawrow'), row = saw && saw.closest('.tkrow')
    if (!row) return Infinity
    const cols = typeof getComputedStyle === 'function' ? getComputedStyle(row).gridTemplateColumns.split(' ') : []
    const w = parseFloat(cols[cols.length - 1]) || saw.clientWidth
    return w > 0 ? barsThatFit(w) : Infinity
  }
  // a window wider than the lane draws is clipped, and the steps it clips are the latest ones: shrink it, keeping the playhead in it
  function fitView() {
    if (!s.anchor || !s.anchor.calls.length) return false
    const { c0, c1 } = chapterHere(s), inside = s.view.lo >= c0 && s.view.hi <= c1 && s.view.lo < s.view.hi // 1.3 §章: never across a chapter's edge
    const w = fitWindow({ lo: inside ? s.view.lo : c0, hi: inside ? s.view.hi : c1, K: sawCapacity(), playhead: s.playhead })
    if (w.lo === s.view.lo && w.hi === s.view.hi) return false
    s.view.lo = w.lo; s.view.hi = w.hi; return true
  }
  function setView(lo, hi, redraw) {
    const N = s.anchor ? s.anchor.calls.length : 0
    if (!N) return
    const { c0, c1 } = chapterHere(s) // the brush pans and zooms inside the playhead's chapter (1.3 §章)
    lo = Math.max(c0, Math.min(c1 - 1, Math.round(lo))); hi = Math.max(lo + 1, Math.min(c1, Math.round(hi)))
    ;({ lo, hi } = capWindow({ lo, hi, prev: s.view, K: sawCapacity(), playhead: s.playhead })) // never wider than the lane can draw
    if (lo === s.view.lo && hi === s.view.hi && redraw !== true) return
    s.view.lo = lo; s.view.hi = hi
    renderSaw(E.saw, s); renderRails(E.rails, s); watchRails()
    if (redraw) renderOverview(E.saw, s); else repositionBrush(E.saw, s)
  }
  // 跟随最新 turned on (f, the chip): the playhead goes to the newest call and its window lands on the reply; the poll reads now
  function followOn() {
    const N = s.anchor ? s.anchor.calls.length : 0
    if (N) setPlayhead(N - 1, true, true); else { s.follow = true; s.followLanding = true }
    s.follow = true
    renderHeader()
    poll(true)
  }
  s.followOn = followOn
  // the reader turns following off (f, the chip): the head and the URL (which now names the drawn step) follow at once
  function followOff() { s.follow = false; renderHeader() }
  s.followOff = followOff

  // ── the desk's reads (2.3 §读与画 加载器; 4.4 §答案文件 · live-poll): the head, the sealed packs, the two open tails ─────────
  // the session's own reads name it; a `block` read names only its refs (3.5: `block` takes --ref alone, any other parameter is refused)
  const read = (name, p, opts) => api.get(name, name === 'block' ? p : { id: s.id, ...p }, opts)
  // every read but the poll's own round (head + the two tails) goes through the desk's loader (2.3 加载器): at most 3 in flight, the next one at once
  const loader = createLoader({ max: 3 })
  const join = (a, b) => (a && b ? AbortSignal.any([a, b]) : a || b)
  const via = (pri, name, p, o = {}) => loader.run(pri, (sig) => read(name, p, { ...o, signal: join(o.signal, sig) }))
    .catch((e) => ({ ok: false, status: 0, error: String((e && e.message) || e) }))
  const LEDGER_PRI = 3.5 // after the playhead's chapter, before the rest of the packs (2.3 加载器)
  // the refs of a held step's bodies on show and not cached: its reply parts (the window's default-open kind, 2.3:195, and the raw panel) and the rows the reader opened
  function openRefs(rid) {
    const st = deskStep(s.desk, rid)
    if (!st.held) return []
    // every reply part (the raw panel shows each one) and the request rows the reader opened
    const keys = rowKeys(st.flat)
    const rows = [...st.reply, ...st.flat.filter((b, i) => s.openBlocks.has(keys[i]))]
    return [...new Set(rows.map((d) => d.ref).filter((r) => r && !bodyCache.has(r)))]
  }
  // the reply parts' refs of the held steps up to NEAR on either side of `rid` on the anchor lane, not cached: read with the rest's
  // own bodies so a step within reach draws its reply at once (2.3 §正文预取)
  const NEAR = 8
  function nearRefs(rid) {
    const calls = s.anchor ? s.anchor.calls : [], i = calls[s.playhead] && calls[s.playhead].rid === rid ? s.playhead : calls.findIndex((c) => c.rid === rid)
    if (i < 0) return []
    return calls.slice(Math.max(0, i - NEAR), i + NEAR + 1).flatMap((c) => {
      const st = deskStep(s.desk, c.rid)
      return st.held ? st.reply.map((d) => d.ref).filter((r) => r && !bodyCache.has(r)) : []
    })
  }
  // what a resting playhead still lacks: its open bodies (a step's row and its step come in one file: there is no lane to read)
  const need = (rid) => (s.desk.rows.has(rid) ? { lane: null, refs: [...new Set([...openRefs(rid), ...nearRefs(rid)])] } : null)
  let targeted = null
  function makeStepReads() {
    const key = sessionKey(), mine = () => !s.dead && key === sessionKey()
    return createStepReads({
      get: read, need, loader, onLane: () => {},
      onBodies: (rid, got, refs) => {
        if (!mine()) return
        refs.forEach((ref, i) => { if (isRetryable(got[i])) s.bodyFail.set(ref, got[i]); else s.bodyFail.delete(ref) })
        if (rid !== s.playRid || !s.anchor) return
        if (host) { renderContextWindow(E.ctxwin, s); s.renderRaw() } else { s.lastPhSig = null; missed = true }
      },
    })
  }
  const steps = makeStepReads()

  // ── files: what the desk holds of each answer file, applied one at a time (packs.mjs) ────────────────────────────────
  const fileBytes = new Map() // file key → the bytes held of it (bytes(): the session cache's measure)
  const keep = (k, n) => { size += n - (fileBytes.get(k) || 0); fileBytes.set(k, n) }
  let applying = Promise.resolve()
  const serial = (fn) => { const p = applying.then(fn); applying = p.catch(() => {}); return p }
  // the lanes a file's lines change: the lanes its rows and heads name, before and after, and those of the rids it held before
  function lanesOf(file, lines) {
    const out = new Set(), d = s.desk, was = (rid) => { const r = d.rows.get(rid); if (r) out.add(r.lane) }
    for (const line of lines) {
      const [k] = Object.keys(line), x = line[k]
      if (k === 'c' || k === 's') { out.add(x.lane); was(x.rid) } else if (k === 'l') out.add(x.lane); else if (k === 'g') was(x)
    }
    const e = d.files.get(`${file.kind === 'tail' ? 't' : 'p'}${file.n}.${file.part}`)
    if (e && (file.kind === 'pack' || file.whole)) for (const rid of e.rids) was(rid)
    if (file.kind === 'pack') { const t = d.files.get(`t${file.n}.${file.part}`); if (t) for (const rid of t.rids) was(rid) }
    return out
  }
  // → the lanes it changed (a Set), or null when it did not apply
  function applyParsed(file, parsed) {
    const changed = lanesOf(file, parsed.lines)
    return applyFile(s.desk, file, parsed) ? changed : false
  }

  // ── the sealed packs (2.3 加载器): each read `main` then `rest` by the loader, in packOrder's order at the moment its slot opens,
  // so a reader's move (a step, a deep link, Home) puts the pack it needs first. A pack held at the head's tag is not read again.
  const packTag = new Map(), packing = new Set() // pack n → the tag held; the packs on their way
  let jobs = 0, packFailed = false
  const playStep = () => {
    if (s.initialStep != null) return s.initialStep - 1
    if (s.follow || s.playRid == null || !s.anchor) return null
    const i = indexOf(s.desk, s.anchor.id, s.playRid)
    return i < 0 ? null : i
  }
  const packsDue = () => packOrder(s.desk.head, playStep(), (p) => packTag.get(p.n) === p.tag || packing.has(p.n))
  function fill(byPoll = false) {
    if (s.dead || !host || !s.desk.head || (packFailed && !byPoll)) return
    packFailed = false
    const due = packsDue()
    for (; jobs < Math.min(3, due.length); jobs++) loader.run(due[jobs].pri, packJob).catch(() => {}).finally(() => { jobs--; if (!s.dead) fill() })
  }
  async function packJob(signal) {
    const p = host && !packFailed ? packsDue()[0] : null // a detached desk sends no next read: attach() goes on
    if (!p) return
    const sk = sessionKey(), tag = s.desk.head.packs.find((x) => x.n === p.n).tag, gone = () => s.dead || sk !== sessionKey() || signal.aborted
    packing.add(p.n)
    try {
      for (const part of ['main', 'rest']) {
        const r = await getText(`/api/d/p${p.n}.${part}`, { id: s.id }, { signal: join(signal, s.reads.signal) })
        if (gone()) return
        let parsed = null
        try { parsed = r.ok && r.status === 200 ? parseLines(r.text) : null } catch { /* not the file's lines: a failure like any other */ }
        if (!parsed) { packFailed = true; if (s.playRid == null && s.initialStep != null) readFailed(r.ok ? { status: r.status, error: 'not the file\'s lines' } : r); return }
        await serial(() => { if (gone()) return; keep(`p${p.n}.${part}`, r.text.length); return redraw(applyParsed({ kind: 'pack', n: p.n, part }, parsed)) })
      }
      packTag.set(p.n, tag)
    } finally { packing.delete(p.n) }
  }

  // ── the anchor lane's ledger (3.5 §手里车道的页, `resources` 与 `seen`): a `lane --to <its first step>` page (no step, the whole ledger
  // at mark in its room), then `ledger_next` to the end, in the loader; after it, a poll that brought new anchor-lane steps asks one
  // `lane --from <the tip the ledger stands at>` whose ledger part is applied (its steps came from the tail). A failed read waits for the next poll.
  let ledgerFailed = false, chaining = false, ledgerTip = null
  function chainLedger(byPoll = false, grew = false) {
    const key = s.anchor && s.anchor.id, desk = s.desk, sk = sessionKey(), signal = s.reads.signal
    if (!key || !host || chaining || (ledgerFailed && !byPoll) || !desk.held.has(key)) return
    const h = desk.held.get(key), head = desk.lanes.get(key)
    if (h.ledgered && !h.cursors.size && !(grew && ledgerTip !== head.last)) return
    chaining = true
    const gone = () => s.dead || sk !== sessionKey() || desk !== s.desk || signal.aborted
    const lr = (name, q) => via(LEDGER_PRI, name, q, { signal, hold: false })
    const run = async () => {
      if (!h.ledgered || (grew && !h.cursors.size)) {
        const tip = head.last, q = h.ledgered && ledgerTip ? { lane: key, from: ledgerTip } : { lane: key, to: head.first }
        const r = await lr('lane', q)
        if (gone()) return null
        if (!r.ok || !r.data) return { ok: false }
        applyLedger(desk, key, null, r.data); ledgerTip = tip
      }
      return readLedger(desk, key, lr, gone, () => host != null)
    }
    run().then((r) => {
      chaining = false
      if (!r || gone()) return
      ledgerFailed = !r.ok
      if (s.playRid != null) { if (host) renderResources(E.resexp, s); else missed = true }
      if (s.anchor && s.anchor.id !== key) chainLedger()
    }, (e) => { chaining = false; console.error(e) })
  }
  // name step `n` (1-based): lands at once when it is here; otherwise the desk stays as it is and its pack is read first
  function nameStep(n) {
    s.initialStep = n; s.follow = false
    const i = namedAt()
    if (i >= 0) { setPlayhead(i, false); return }
    renderHeader(); if (s.playRid != null) namedRows(); fill()
  }
  // the playhead's rid changed: its reads go out once it rests (createStepReads)
  function aim() { if (s.playRid != null && s.playRid !== targeted) { targeted = s.playRid; steps.target(s.playRid); fill() } }
  s.wantLane = () => fill() // a lane not in hand comes with its pack
  // a rail hovered or scrolled into view: its pack is on its way already (the loader reads every pack); the observer keeps the loader going
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) s.wantLane() }) : null
  function watchRails() { if (!io) return; io.disconnect(); for (const n of E.rails.querySelectorAll('.railbody[data-lane]')) io.observe(n) }
  const onRailHover = (e) => { if (e.target.closest && e.target.closest('[data-lane]')) s.wantLane() }
  E.rails.addEventListener('mouseover', onRailHover)

  // ── reading the session ──────────────────────────────────────────────────────────────────────────────────────────
  // a failed read is said IN the content area (no banner, no dot): one plain sentence, Retry, and the reason — a worker's crash,
  // say — in the collapsed 技术细节, never in the body (1.5 K-29)
  // `r` is the failed answer {status, error}: the visible words are readFailure's, the reason only in the details
  const fail = (r) => { const f = readFailure(THIS_SESSION, r, { id: 'readtech' }); s.errNote = `<button type="button" class="linkbtn" data-retry="1">${esc(RETRY)}</button>${f.tech}`; return f.line }
  // a desk that has drawn this session keeps every area as it is and says quietly, in the 会话保真行, since when it is not refreshed
  // and why; only a session that never drew shows the failure in the content area
  function readFailed(r) {
    if (s.goodKey === sessionKey()) s.staleErr = { r, since: s.goodAt }
    else renderEmpty(fail(r))
    renderHeader()
    return { ok: false }
  }

  // the price table: a failed read keeps its reason (the header, raw panel and drawer say 价表读不出 · why); its own back-off
  const prices = createPricingLoader(() => api.get('pricing'), s.pricing)
  async function loadPricing() {
    if (!(await prices.load()) || s.dead) return
    s.pricing = prices.table(); s.pricingErr = prices.err()
    if (s.pricing) s.ctx.store.set({ pricing: s.pricing })
    renderHeader(); if (s.anchor) { s.renderRaw(); refreshDrawer() }
  }

  // one round in flight; a failed round backs off; the reader's own actions read at once (core/poll.mjs createPoller). A hidden tab and a
  // session the server does not know read nothing by themselves. One poller per session: its loop stops as soon as the session changes.
  const idle = () => (typeof document !== 'undefined' && document.hidden) || s.notListed
  const makePoller = () => { const key = sessionKey()
    return createPoller({ base: POLL_MS, now: () => api.now(), alive: () => !s.dead && host != null && key === sessionKey(), idle,
      run: async () => { try { return await pollOnce() } catch (e) { if (s.dead || key !== sessionKey() || (e && e.name === 'AbortError')) return; console.error(e); return { ok: false } } } }) }
  const poller = makePoller()
  function poll(byReader = true) {
    if (s.dead || (!byReader && idle())) return
    loadPricing().catch((e) => console.error(e))
    return poller.poll(byReader)
  }
  s.poll = () => poll(true)
  // a body read that failed is asked again on the poll's schedule (2.3 §读失败)
  const reask = () => { if (s.bodyFail.size && s.playRid != null) { targeted = s.playRid; steps.target(s.playRid) } }

  // the open tails (4.4 live-poll): `Range: bytes=<held>-` on the tail the head names; the whole file when none is held of that n, when it
  // is shorter than what is held (416 naming a smaller size: rewritten) or when what came is not its lines. → {ok, anchor} | a failed answer
  const tails = new Map() // part → {n, used}
  async function readTail(part, n, signal, whole = false) {
    const t = tails.get(part), from = whole || !t || t.n !== n ? null : t.used
    const r = await getText(`/api/d/open.${part}`, { id: s.id }, { range: from, signal })
    if (!r.ok) return r
    if (r.status === 416) { const size = Number((/\/(\d+)/.exec(r.range || '') || [])[1]); return size === from ? { ok: true } : readTail(part, n, signal, true) }
    let parsed
    try { parsed = parseLines(r.text, { head: r.status !== 206 }) } catch { return from == null ? { ok: false, status: r.status, error: 'not the file\'s lines' } : readTail(part, n, signal, true) }
    if (r.status !== 206 && parsed.head && parsed.head.tail && parsed.head.tail.n !== n) n = parsed.head.tail.n
    const used = (r.status === 206 ? from : 0) + parsed.used
    return serial(() => {
      tails.set(part, { n, used }); keep(`t.${part}`, used)
      const ch = applyParsed({ kind: 'tail', n, part, whole: r.status !== 206 }, parsed)
      const anchor = !!ch && !!s.anchor && parsed.lines.some((l) => l.s && l.s.lane === s.anchor.id)
      return redraw(ch).then((x) => ({ ok: true, anchor, x }))
    })
  }

  // a poll round: the head (If-None-Match), then each open tail by Range; a newly sealed or changed pack is read by the loader (fill)
  async function pollOnce() {
    const key = sessionKey(), signal = s.reads.signal, desk = s.desk
    // the session was switched (its reads aborted) while a request was in flight: no record, no stale line
    const stale = () => s.dead || key !== sessionKey() || signal.aborted
    const h = await get('/api/d/head', { id: s.id }, { signal, hold: false, cond: !!desk.head })
    if (stale()) return
    if (!h.ok || (!h.data && !desk.head)) return readFailed(h.ok ? { status: h.status, error: 'no head' } : h)
    const lastGood = s.goodAt
    s.errNote = null; s.goodKey = key; s.goodAt = api.now()
    const hadStale = !!s.staleErr; s.staleErr = null
    if (h.data) { keep('head', h.bytes || 0); applyHead(desk, h.data) }
    const head = desk.head, wasBehind = JSON.stringify(desk.behind ?? null)
    desk.behind = behindOf(h.tip, head.mark) // 1.5 K-32: the tip ids after the head's mark, from every head answer (a 304 too)
    // the server knows no such session (meta null, nothing captured): said HERE, with a way back; the timer stops reading it
    if (head.meta == null && !head.steps) {
      s.goodKey = null; s.notListed = true; renderEmpty(''); E.ctxwin.innerHTML = notListedHtml(); E.ctxwin.__units = null; root.classList.add('notlisted'); renderHeader(); return { ok: true }
    }
    if (s.notListed) { s.notListed = false; root.classList.remove('notlisted') }
    // left while the head was on its way: the head is the round's last read (a detached desk sends no next read); attach's round reads the tails
    if (!host) { if (h.data) await serial(() => redraw(null)); return { ok: true } }
    if (h.data && s.playRid == null) await serial(() => redraw(null)) // the rough page from the head, before any file (2.3 §大致页面)
    else if (JSON.stringify(desk.behind) !== wasBehind) renderHeader()
    if (stale()) return
    const rs = head.open ? await Promise.all(['main', 'rest'].map((part) => readTail(part, head.open.n, signal))) : []
    if (stale()) return
    const bad = rs.find((r) => !r.ok)
    if (bad) { s.staleErr = { r: bad, since: lastGood }; s.goodAt = lastGood }
    if (h.data || hadStale || bad) { await serial(() => redraw(h.data ? null : new Set())); renderHeader() }
    fill(true); reask()
    chainLedger(true, rs.some((r) => r.anchor))
    return bad ? { ok: false } : { ok: true, pending: head.pending || undefined }
  }

  // after a file or a head: the lanes it changed (null = every lane, false = nothing applied) rebuilt, the playhead found again by its rid (or a named step landed), the redraw
  async function redraw(changed) {
    if (changed === false || s.dead) return
    const desk = s.desk, keepPins = pin(), prevRow = curCall()
    s.meta = desk.meta
    s.lanes = buildLanes(desk, { count: desk.probes || 0, series: [] }, { prev: s.lanes, changed })
    const prevAnchor = s.anchor
    s.anchor = anchorLane(s.lanes)
    judgeGap()
    if (!s.anchor || !s.anchor.calls.length) {
      if (desk.head && !desk.head.steps) {
        renderEmpty('')
        E.ctxwin.innerHTML = `<div class="empty">${esc(desk.probes ? `This session has only token counts (${desk.probes}), no model calls to replay.` : 'No model calls have been captured in this session yet.')}</div>`
        renderHeader(); return
      }
      renderRough(); return
    }
    if (s.anchor !== prevAnchor) { s.anchorTs = s.anchor.calls.map((c) => Date.parse(c.ts)); s.breaks = breakSteps(s.anchor.calls); s.problems = problemSteps(s.anchor) }
    return settle(keepPins, prevRow)
  }
  async function settle(keepPins, prevRow) {
    const desk = s.desk, key = sessionKey(), first = s.viewSig !== key, signal = s.reads.signal
    unpin(keepPins)
    const moved = placePlayhead(prevRow)
    if (s.playRid == null) { renderRough(); chainLedger(); fill(); return } // the rough page until the named step is here
    // the followed step's open reply bodies in one read before it is drawn (C3), so its newest reply shows with its bytes; the same
    // read carries the ±NEAR prefetch (2.3 §正文预取), so the rest after it finds nothing left and a delta stays one `block` (4.4:52)
    if (s.follow && moved && !first && host) {
      const refs = openRefs(s.playRid)
      if (refs.length) { await loadBodies({ get: (n, p, o) => via(0, n, p, o) }, [...refs, ...nearRefs(s.playRid)], { signal }); if (s.dead || key !== sessionKey()) return }
    }
    // brush window: a new session starts on the whole of it when that fits the lane, else on the last steps that fit — or, when the
    // URL named an earlier step, on the ones around it. On live growth keep the reader's window, extending it when parked at the end.
    const N = s.anchor.calls.length
    if (first) { s.viewSig = key; s.view = { lo: 0, hi: N } } else {
      if (keepPins.atEnd) s.view.hi = N // a window parked at the live end grows with it
      s.view.hi = Math.min(N, s.view.hi || N); s.view.lo = Math.max(0, Math.min(s.view.lo, N - 1)); if (s.view.hi <= s.view.lo) s.view.hi = Math.min(N, s.view.lo + 1)
    }
    const ch = chapterHere(s); s.view = placeView(s.view, s.playhead, ch.c0, ch.c1, sawCapacity())
    renderAll()
    refreshDrawer()
    chainLedger()
    fill()
  }

  // ── capture health: read once per desk open, only to judge the 采集缺口 (1.2 §会话保真行); unreadable → no judgement
  function judgeGap() {
    const st = stepsOf(s.lanes)
    if (!st.length || !s.meta) { s.gap = null; return }
    s.gap = captureGap(s.health, { start: Date.parse(st[0].ts), end: Date.parse(st[st.length - 1].ts) }, s.meta.harness, api.now())
  }
  api.get('status').then((r) => { if (!s.dead && r.ok) { s.health = r.data; judgeGap(); if (s.anchor) renderHeader() } }).catch((e) => console.error(e))

  // ── the desk's own listeners (inside its root): wired once, kept while it is detached, dropped by dispose() ──────────────
  const onRp = () => { s.rpOpen = !s.rpOpen; const rp = $('#rightpage'); if (rp) { rp.classList.toggle('open', s.rpOpen); const b = $('#rpbar'); if (b) b.setAttribute('aria-expanded', String(s.rpOpen)) } }
  const rpbar = $('#rpbar')
  const onRpKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRp() } }
  rpbar.addEventListener('click', onRp); rpbar.addEventListener('keydown', onRpKey)
  const onRetry = (e) => { if (e.target.closest && e.target.closest('[data-retry]')) poll(true) } // the failure state's Retry
  E.ctxwin.addEventListener('click', onRetry)
  const offs = [() => { rpbar.removeEventListener('click', onRp); rpbar.removeEventListener('keydown', onRpKey); E.ctxwin.removeEventListener('click', onRetry); E.rails.removeEventListener('mouseover', onRailHover) },
    wireTimeline(E.saw, s), wireRails(E.rails, s), wireCtxWin(E.ctxwin, s), wireOutline(E.ctxnav, s), wireResources(E.resexp, s),
    wireRawPanel(E.rawpanel, s), wireSessionHead(E.deskhead, s), wireStepBar(E.stepbar, s), initLayout(root)]

  // ── what lives outside the root (the page's keys and events, the shared drawer, timers, observers): only while attached ─────
  // 1.2 §键盘: a held key moves the target at once and paints at most once per frame
  let keyTarget = null
  const paintKey = () => { const t = keyTarget; keyTarget = null; if (!s.dead && t != null) setPlayhead(t, true) }
  const onKey = (e) => {
    if (e.key === 'Escape' || !s.anchor || e.ctrlKey || e.metaKey || e.altKey) return
    const at = keyTarget ?? s.playhead, ch = chapterHere(s)
    const a = keyAction(e, { at, n: s.anchor.calls.length, problems: s.problems, chapters: ch.chs, step: s.anchor.no ? s.anchor.no(at) : at })
    if (!a) return
    e.preventDefault()
    if (a.keys) openModal({ title: KEYS_TITLE, bodyHtml: `<dl class="keylist">${KEY_LIST.map(([k, w]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(w)}</dd>`).join('')}</dl>` })
    else if (a.follow) { if (s.follow) followOff(); else followOn() }
    else if (s.playRid == null) return // a named step is still on its way to a desk that never drew
    else if (a.chapter != null) { keyTarget = null; s.chapterGo(a.chapter) }
    else if (e.key === 'Home') { keyTarget = null; nameStep(1) } // step 1 may be older than the held part: it lands when it is here
    else { if (keyTarget == null) frame(paintKey); keyTarget = a.to }
  }
  // popovers and menus close themselves first and stop the key (core/keys.mjs); here: the call drawer, then the bottom row
  const onEscape = () => { if (E.detail.classList.contains('open')) closeDetail(E.detail, s); else if (s.rpOpen) onRp() }
  const onVis = () => { if (!document.hidden) poll(true) } // back in view: read now, not a tick later
  // the lane's width changes with the window and with the right-page divider: watch both. Only a window that no longer fits is touched.
  const refit = () => { if (s.anchor && alive() && fitView()) { renderSaw(E.saw, s); renderRails(E.rails, s); watchRails(); renderOverview(E.saw, s) } }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : null
  let timer = null, unwireDetail = null, scrolls = []

  renderEmpty('')

  // hang the desk in `el` as it was left; the URL decides the view only when it names a step (1.2 §路由「离开再回来」)
  function attach(el, ctx, route) {
    host = el
    s.ctx = { ...ctx, api: areaApi }
    overrideScope(sessionKey())
    el.replaceChildren(root)
    for (const [sel, top] of scrolls) { const n = $(sel); if (n) n.scrollTop = top }
    unwireDetail = wireDetail(E.detail, s)
    setScreenKeys(onKey)
    document.addEventListener('v2:escape', onEscape)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('resize', refit)
    if (ro) ro.observe($('#sawrow').closest('.tkrow'))
    watchRails()
    timer = setInterval(() => poll(false), POLL_MS) // the desk keeps reading; 「跟随最新」 only decides whether the playhead follows growth
    if (hasStep(route)) update(route)
    // a step left mid-wait draws now; the URL names the drawn step at once (syncUrl). Answers applied while away were not drawn: all areas then
    if (s.anchor) { if (missed) { missed = false; renderAll() } else paintPlayhead() }
    chainLedger(); fill() // what a leave paused goes on (a desk that holds every pack reads nothing here)
    poll(true) // the first open, or one round: the head If-None-Match, a Range on each tail
  }
  // leave the page: the poll stops, every listener outside the root goes, the reads in flight finish into the desk's state (drawn on
  // return); no chain sends its next read while detached (1.2 §路由「离开再回来」)
  function detach() {
    if (!host) return
    scrolls = SCROLLED.map((sel) => [sel, $(sel) ? $(sel).scrollTop : 0])
    clearInterval(timer); timer = null
    if (busyTimer != null) { clearTimeout(busyTimer); busyTimer = null }
    jumps.clear()
    setScreenKeys(null)
    document.removeEventListener('v2:escape', onEscape)
    document.removeEventListener('visibilitychange', onVis)
    window.removeEventListener('resize', refit)
    if (ro) ro.disconnect()
    if (io) io.disconnect()
    closeDetail(E.detail, s); E.detail.innerHTML = ''
    unwireDetail(); unwireDetail = null
    root.remove()
    host = null
  }
  // out of the session cache: its reads are aborted and nothing of it writes again
  function dispose() {
    detach()
    s.dead = true
    reads.abort()
    loader.clear()
    for (const f of offs) { try { f() } catch (e) { console.error(e) } }
    clearOverrides(sessionKey())
  }
  // the same session's route moved (our own URL writes land here too, and are no-ops). No step and no call = follow the newest (1.2:91)
  function update(route) {
    if (host && !root.isConnected) host.replaceChildren(root) // something wrote over the screen: hang the desk back
    if (!hasStep(route)) { if (route.params.call == null && !s.follow) followOn(); return }
    if (!s.anchor) { s.initialStep = stepParam(route.params.step).step; return }
    // a named step pins it with follow off; the move is not the reader's, so landing on the newest call does not turn follow on
    const p = stepParam(route.params.step, s.anchor.count ?? s.anchor.calls.length)
    if (s.playRid != null && p.step === shownStep() && !p.rewrite && !s.follow) return
    nameStep(p.step)
  }
  return { key: sessionKey(), attach, detach, update, dispose, bytes: () => size }
}

// The screen: the route's session from the session cache, or a new desk; another session or another screen detaches it back into the cache
export function mount(el, ctx) {
  let d = null
  const show = (route) => {
    const key = keyOf(route)
    d = sessionCache.take(key) || sessionCache.put(key, openDesk(ctx, route))
    d.attach(el, ctx, route)
  }
  const leave = () => { d.detach(); sessionCache.release(d.key) }
  show(ctx.router.current())
  return {
    update(route) { if (keyOf(route) !== d.key) { leave(); show(route) } else d.update(route) },
    unmount: leave,
  }
}
