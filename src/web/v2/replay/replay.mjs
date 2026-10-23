// replay/replay.mjs — the replay desk (回放台): one session, step by step, over the desk model (model.mjs) and the three session
// reads (3.5 §会话读; 2.3 §读与画). It owns the state object every area renders from, keeps the session live (one `session
// --since <mark>` per poll, then `lane` for each held lane the delta touched, then the followed step's open reply bodies), and
// schedules the repaint of each area:
//   scrubbing    → only what depends on the playhead (bar .cur marks, context window, outline, resources, raw panel), at most once
//                  per animation frame; a step whose lane is not held keeps what is drawn for 150 ms, then draws its row's parts
//                  with empty frames for the rows (frameFor)
//   brush window → bars, cache band and rails        an answer → the lanes it touched, then the playhead's panels when their
//                  signature moved (playheadSig, spec 1.4 D64), so a selection in them survives a live session's growth
// The playhead, the selected tick, the compare step and the brush edges are held as rids; step numbers are derived. The URL
// carries the step (`?step=N`, 1-based): scrubbing replaces it (no history pile-up), a different session is a new entry.
// Contract: mount(el, ctx) → {update(route), unmount()}; ctx = {api, store, router}; the start route is ctx.router.current().
import { esc } from '../core/fmt.mjs'
import { setScreenKeys } from '../core/keys.mjs'
import { openModal } from '../core/dom.mjs'
import { keyAction } from './keymap.mjs'
import { buildLanes, anchorLane, stepsOf, nearestByTs } from './lanes.mjs'
import { createDesk, applySession, applyLane, readTouched, mergeTouch, readLedger, ledgerDone, stepOf as deskStep } from './model.mjs'
import { breakSteps } from './analysis.mjs'
import { loadFold, saveFold } from './fold.mjs'
import { landPlayhead, createStepReads } from './follow.mjs'
import { createPoller, INTERVAL } from '../core/poll.mjs'
import { renderSaw, renderOverview, repositionBrush, markCurrent, renderProblemNav, problemSteps, wireTimeline, barsThatFit, fitWindow, capWindow } from './timeline.mjs'
import { renderRails, wireRails, highlightRange, reviewing } from './rails.mjs'
import { renderContextWindow, wireCtxWin, emptyFrameHtml, rowKeys } from './ctxwin.mjs'
import { renderOutline, wireOutline, jumpToAnchor, jumpToResourceBlock } from './outline.mjs'
import { createJumpQueue } from './jump.mjs'
import { createPricingLoader } from './pricing.mjs'
import { renderResources, wireResources } from './resources.mjs'
import { renderRawPanel, wireRawPanel } from './rawpanel.mjs'
import { openDetail, closeDetail, wireDetail } from './detail.mjs'
import { initLayout } from './layout.mjs'
import { renderSessionHead, wireSessionHead, captureGap } from './header.mjs'
import { stepBarHtml, wireStepBar } from './stepbar.mjs'
import { loadBodies, bodyCache, clearOverrides, isRetryable } from './cell.mjs'
import { SESSION_NOT_LISTED, BACK_TO_SESSIONS } from '../labels/shell.mjs'
import { CACHE_LEGEND, CACHE_LEGEND_UNK, KEYS_TITLE, KEY_LIST, RETRY, THIS_SESSION } from '../labels/replay.mjs'
import { readFailure } from '../core/ui.mjs'

const POLL_MS = INTERVAL.session
const BUSY_MS = 150 // 2.3 §车道未到手: how long a step whose lane is not held leaves the desk as it is
const SLICE_MS = 8 // 2.3 §读与画: an answer is applied in slices of at most this long, yielding between them
const SLICE_ROWS = 100

// the desk's own head: the session head (title · chip · 项目 · 跟随最新 · ⓘ) and the quiet 会话保真行 under it (1.2 §会话头).
// No statistic and no banner ever lives here: the numbers are behind ⓘ, a failed read says so in the content area.
const DESKHEAD = `<div id="deskhead"></div>`

// exported for the string-level tests (the trace's legend row): the desk's static shape lives here and nowhere else
export const SKELETON = `<div id="pages">
<div id="leftpage">
<div id="saw">
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
    !!s.pricing, s.pricingErr || null, (st && s.laneErr && s.laneErr.get(st.lane)) || null, s.bodyFail ? s.bodyFail.size : 0])
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

// a session answer as slices whose application in order equals applying it whole (2.3 §读与画: ≤ SLICE_MS of main-thread work each).
// The first slice is the answer itself with its first rows (a delta's `gone` and `lanes_gone` go with it: they never name a lane or row
// another slice brings); the rest are deltas on its mark. An older (--before) page slices into older pages. A delta while a big
// session is read for the first time brings a thousand rows and more (2.3 归约前沿), so it is sliced like a full answer.
export function slicesOf(a, before) {
  const calls = a.calls || []
  if (calls.length <= SLICE_ROWS) return [a]
  const out = []
  for (let i = 0; i < calls.length; i += SLICE_ROWS) {
    const part = calls.slice(i, i + SLICE_ROWS), rids = new Set(part.map((r) => r.rid))
    const events = (a.events || []).filter((e) => rids.has(e.rid))
    out.push(i === 0 || before ? { ...a, calls: part, events } : { ...a, base: a.mark, calls: part, events, gone: [], lanes_gone: [] })
  }
  return out
}

function mountDesk(el, ctx) {
  const { api, store, router } = ctx
  el.innerHTML = `<div class="desk">${DESKHEAD}${SKELETON}</div>`
  // every query runs inside the desk's own root: a desk whose DOM was replaced keeps working on its detached nodes, never on null
  const root = el.querySelector('.desk')
  const $ = (sel) => root.querySelector(sel)
  const E = { saw: $('#saw'), rails: $('#rails'), deskhead: $('#deskhead'), stepbar: $('#stepbar'), ctxwin: $('#ctxwin'), ctxnav: $('#ctxnav'), resexp: $('#resexp'), rawpanel: $('#rawpanel'), detail: document.getElementById('detail') }
  const route0 = router.current()

  // ── the state every area renders from ────────────────────────────────────────────────────────────────────────────
  const fresh = () => ({
    desk: createDesk(), meta: null, lanes: [], anchor: null, anchorTs: [], breaks: [], problems: [], playhead: 0, playRid: null, follow: true, sawView: 'ctx',
    view: { lo: 0, hi: 0 }, viewSig: null, selTick: null, viewPin: null, diffRef: null, curFlat: [], drawerFlat: [], curRemoved: [],
    followLanding: false, // the playhead was last moved by 跟随最新, not by the reader: the window lands on the reply (1.4 §打开一步时落在哪)
    landedFor: null, replyFor: null, // the window's landing ran for that rid; the reply rows' open state belongs to that rid
    navOpen: new Set(['sys', 'life-file', 'life-load']), navSeenExpanded: false, collapsedRails: new Set(), subSeeded: new Set(), subgroupOpen: false, bgOpen: false,
    railsFolded: typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches, rpOpen: false,
    gap: null, totals: null, errNote: null, lastPhSig: null, unheld: null, notListed: false, goodKey: null, goodAt: null, staleErr: null,
    laneErr: new Map(), bodyFail: new Map(), // a step read that failed: lane key → reason, ref → its failed body (2.3 §读失败)
  })
  const s = {
    ctx, root, dead: false, project: route0.project, id: route0.id, initialStep: hasStep(route0) ? stepParam(route0.params.step).step : null,
    ...fresh(), headFollow: null, health: null,
    openBlocks: new Set(), turnLanded: new Set(), // open rows by key (bid#n, rp:bid): they survive a step change while the bid stays
    reads: typeof AbortController === 'function' ? new AbortController() : null, // aborted when the session changes or the desk closes
    pricing: store.get().pricing || null, pricingErr: null,
    turnFold: loadFold(storage()),
  }
  const sessionKey = () => s.project + '::' + s.id
  const alive = () => !s.dead && E.ctxwin.isConnected && el.contains(E.ctxwin)

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
  s.setView = setView
  // the 内容对比步 (2.3): the compare menu's choice survives scrubbing, clears on a session switch
  s.setDiff = (idx) => { s.diffRef = idx; drawPlayhead() }
  s.renderStep = () => { E.stepbar.innerHTML = stepBarHtml(s) }

  function renderHeader() { s.headFollow = s.follow; renderSessionHead(E.deskhead, s) }

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
    $('#probrow').innerHTML = ''; $('#askscale').innerHTML = ''; $('#askrow').style.display = 'none'
    for (const id of ['#sawstart', '#sawend', '#viewrange']) $(id).textContent = ''
    $('#sawgut').textContent = 'Context'; $('#viewswitch').innerHTML = ''; $('#complegend').innerHTML = ''; $('#nomain').style.display = 'none'
    renderProblemNav(E.saw, s) // no problems: the row name stops quoting the last session's count and ‹ › disappear
    closeDetail(E.detail, s)
  }
  function resetSession() {
    jumps.clear()
    // a different session: nothing of the last one may survive — the model, the reader's choices, each cell's own mode (D70 §4.4)
    Object.assign(s, fresh())
    clearOverrides()
    root.classList.remove('notlisted')
    // the last session's reads in flight are cancelled, and its loops cannot hold this one
    if (s.reads) { s.reads.abort(); s.reads = new AbortController() }
    poller = makePoller(); steps = makeStepReads(); targeted = null; openLane = null; quiet = false; wanted.clear(); ledgerFailed = false; chaining = false
    s.openBlocks.clear(); s.turnLanded.clear()
    E.stepbar.innerHTML = ''
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
  // the playhead from its rid: its call's place in the anchor lane; a call that left the lane → the anchor call nearest in time
  function placePlayhead(prevRow) {
    const a = s.anchor, N = a.calls.length
    if (s.initialStep != null) {
      const local = s.initialStep - (a.base || 0)
      if (local < 1 && s.desk.more) { s.playhead = 0; s.playRid = a.calls[0].rid; return false } // its row is older than the held part: wait
      const land = landPlayhead({ N, playhead: s.playhead, follow: s.follow, initialStep: Math.max(1, local) })
      s.playhead = land.playhead; s.follow = land.follow; s.initialStep = null; s.followLanding = false
      s.playRid = a.calls[s.playhead].rid
      return true
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
    const c = curCall()
    if (!c) return
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
    jumps.settle() // a jump that was waiting for this step's lane lands now that the window shows it
    aim()
  }
  function renderAll() {
    renderHeader()
    if (!s.anchor) return
    renderSaw(E.saw, s); renderRails(E.rails, s); watchRails(); renderOverview(E.saw, s)
    paintPlayhead()
    restoreSelection()
  }
  // the drawer was built from the rows of an earlier answer: repaint it for the selected tick
  function refreshDrawer() {
    if (!s.selTick || !E.detail || !E.detail.classList.contains('open')) return
    const l = s.lanes.find((x) => x.id === s.selTick.laneId)
    if (l && l.calls[s.selTick.i]) openDetail(E.detail, s, l, s.selTick.i)
  }

  // ── navigation ───────────────────────────────────────────────────────────────────────────────────────────────────
  const shownStep = () => (s.anchor ? (s.anchor.base || 0) + s.playhead + 1 : null)
  function syncUrl() { const n = shownStep(); if (n != null) router.setParams({ step: String(n) }, { replace: true }) } // scrubbing is not a navigation
  // `followLanding`: 跟随最新 brought the playhead here (followOn) → this step lands on the reply; any other move lands by the change
  // line. Set BEFORE the repaint below, because the landing runs once per step, inside that repaint (1.4 §打开一步时落在哪).
  function setPlayhead(i, manual, followLanding = false) {
    if (!s.anchor || !s.anchor.calls.length) return // a zero-call session: "⇥ latest" is a no-op, not a TypeError
    s.viewPin = null // scrubbing returns the panel to the call raw
    s.followLanding = followLanding
    jumps.clear() // a move by the reader ends any jump still waiting for its lane (jumpTo queues its own after this)
    const N = s.anchor.calls.length, np = Math.max(0, Math.min(N - 1, i | 0))
    if (np !== s.playhead) s.turnLanded.clear() // a different call: no landing turn lingers; open rows stay by bid (1.4:114)
    s.playhead = np; s.playRid = s.anchor.calls[np].rid
    if (manual) s.follow = np === N - 1 // the reader's move: on the newest call it follows, anywhere else it does not
    // keep the scrub target inside the brush window: pan it, keep its width
    if (np < s.view.lo || np >= s.view.hi) {
      const w = Math.max(1, s.view.hi - s.view.lo)
      const lo = Math.min(Math.max(0, np - ((w / 2) | 0)), Math.max(0, N - w))
      s.view.lo = lo; s.view.hi = Math.min(N, lo + w)
      renderSaw(E.saw, s); renderRails(E.rails, s); watchRails()
    } else markCurrent(E.saw, s) // the common case: only the current marks move
    repositionBrush(E.saw, s)
    drawPlayhead()
    restoreSelection()
    syncUrl()
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

  // ── a step's own reads: its lane, its open rows' bodies, the lane's older pages (2.3 §读与画; 3.5:69) ─────────────────
  // the session's own reads name it; a `block` read names only its refs (3.5: `block` takes --ref alone, any other parameter is refused)
  const read = (name, p, opts) => api.get(name, name === 'block' ? p : { id: s.id, ...p }, opts)
  const laneIndex = (key, rid) => { const r = s.desk.laneRids.get(key); return r ? r.indexOf(rid) : -1 }
  // the refs of a held step's bodies on show and not cached: its reply parts (the window's default-open kind, 2.3:195, and the raw panel) and the rows the reader opened
  function openRefs(rid) {
    const st = deskStep(s.desk, rid)
    if (!st.held) return []
    // every reply part (the raw panel shows each one) and the request rows the reader opened
    const keys = rowKeys(st.flat)
    const rows = [...st.reply, ...st.flat.filter((b, i) => s.openBlocks.has(keys[i]))]
    return [...new Set(rows.map((d) => d.ref).filter((r) => r && !bodyCache.has(r)))]
  }
  // what a resting playhead still lacks: its lane (or the older page that holds it), its open bodies; then the lane's next older
  // page, one per resting rid while the playhead is fewer than 32 steps from the held edge (3.5:69, in time for a scrub), and one
  // per quiet poll (`olderOk`): the remaining pages come newest first, each after a reader's move or a `session` read (4.4:52)
  let olderOk = false, olderFor = null
  // the anchor lane's ledger chain comes before any older page (3.5 §手里车道的页): while it is pending (and not failed) no `to` read
  let ledgerFailed = false, chaining = false
  const ledgerFirst = () => { const k = s.anchor && s.anchor.id; return !!k && s.desk.held.has(k) && !ledgerDone(s.desk, k) && !ledgerFailed }
  function need(rid) {
    const row = s.desk.rows.get(rid)
    if (!row) return null
    const key = row.lane, h = s.desk.held.get(key)
    if (!h || !h.steps.has(rid)) {
      const older = h && h.prev != null && h.rids.length && laneIndex(key, rid) < laneIndex(key, h.rids[0])
      if (older && ledgerFirst()) return null
      return { lane: older ? { lane: key, to: h.prev } : { lane: key }, refs: [] }
    }
    const older = h.prev != null && !ledgerFirst() && (olderOk || (olderFor !== rid && laneIndex(key, rid) - laneIndex(key, h.rids[0]) < 32))
    if (older) { olderOk = false; olderFor = rid }
    return { lane: older ? { lane: key, to: h.prev } : null, refs: openRefs(rid) }
  }
  const wanted = new Set() // lanes asked for by the drawer or a rail while another read was out
  let targeted = null, openLane = null
  function makeStepReads() {
    const key = sessionKey(), mine = () => !s.dead && key === sessionKey()
    return createStepReads({
      get: read, need,
      onLane: (rid, r, q) => {
        if (!mine()) return
        const a = r && r.ok ? r.data : null
        if (a) { applyLane(s.desk, a); s.laneErr.delete(a.lane); if (s.anchor && a.lane === s.anchor.id) chainLedger() } else if (q) s.laneErr.set(q.lane, (r && r.error) || 'cause not known')
        const was = openLane
        if ((a && a.lane === openLane) || (!a && rid == null)) openLane = null
        if (a) { wanted.delete(a.lane); if (s.anchor && a.lane !== s.anchor.id) { renderRails(E.rails, s); watchRails() } }
        if (s.anchor) { paintPlayhead(); refreshDrawer() }
        if (was && !openLane) aim()
        for (const k of wanted) if (!s.desk.held.has(k)) { steps.prefetch(k); break }
      },
      onBodies: (rid, got, refs) => {
        if (!mine()) return
        refs.forEach((ref, i) => { if (isRetryable(got[i])) s.bodyFail.set(ref, got[i]); else s.bodyFail.delete(ref) })
        if (rid === s.playRid && s.anchor) { renderContextWindow(E.ctxwin, s); s.renderRaw() }
      },
    })
  }
  let steps = makeStepReads()
  // the anchor lane's pending ledger cursors, read to the end in the one lane slot after any answer of that lane (2.4's counts are
  // exact once it ends). A failed read leaves its cursor pending for the next poll (`byPoll`), never an immediate retry. Its answers
  // redraw only the explorer; when the chain ends the resting playhead asks again for what the gate held back.
  function chainLedger(byPoll = false) {
    const key = s.anchor && s.anchor.id, desk = s.desk, sk = sessionKey(), signal = s.reads ? s.reads.signal : undefined
    if (!key || chaining || (ledgerFailed && !byPoll) || !desk.held.has(key) || ledgerDone(desk, key)) return
    chaining = true
    const gone = () => s.dead || sk !== sessionKey() || desk !== s.desk || !!(signal && signal.aborted)
    steps.laneSlot(() => readLedger(desk, key, (name, q) => read(name, q, { signal, hold: false }), gone)).then((r) => {
      chaining = false
      if (!r || gone()) return
      ledgerFailed = !r.ok
      renderResources(E.resexp, s)
      if (r.ok && s.playRid != null && openLane == null) { targeted = s.playRid; steps.target(s.playRid) }
      if (s.anchor && s.anchor.id !== key) chainLedger()
    }, (e) => { chaining = false; console.error(e) })
  }
  // the playhead's rid changed: its reads go out once it rests (createStepReads); the open's own lane read is not cut short
  function aim() { if (s.playRid != null && s.playRid !== targeted && openLane == null) { targeted = s.playRid; steps.target(s.playRid) } }
  s.wantLane = (key) => { if (s.desk.held.has(key)) return; wanted.add(key); steps.prefetch(key) }
  // a rail hovered or scrolled into view reads its lane at idle
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) s.wantLane(e.target.dataset.lane) }) : null
  function watchRails() { if (!io) return; io.disconnect(); for (const n of E.rails.querySelectorAll('.railbody[data-lane]')) io.observe(n) }
  const onRailHover = (e) => { const n = e.target.closest && e.target.closest('[data-lane]'); if (n && n.dataset.lane) s.wantLane(n.dataset.lane) }
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
    if (s.pricing) store.set({ pricing: s.pricing })
    renderHeader(); if (s.anchor) { s.renderRaw(); refreshDrawer() }
  }

  // one read in flight; a failed read backs off; the reader's own actions read at once (core/poll.mjs createPoller). A hidden tab and a
  // session the server does not know read nothing by themselves. One poller per session: its loop stops as soon as the session changes.
  const idle = () => (typeof document !== 'undefined' && document.hidden) || s.notListed
  const makePoller = () => { const key = sessionKey()
    return createPoller({ base: POLL_MS, now: () => api.now(), alive: () => !s.dead && key === sessionKey(), idle,
      run: async () => { try { return await pollOnce() } catch (e) { if (s.dead || key !== sessionKey() || (e && e.name === 'AbortError')) return; console.error(e); return { ok: false } } } }) }
  let poller = makePoller()
  function poll(byReader = true) {
    if (s.dead || (!byReader && idle())) return
    loadPricing().catch((e) => console.error(e))
    return poller.poll(byReader)
  }
  s.poll = () => poll(true)
  let quiet = false // the last delta brought nothing: the next tick backfills older rows instead (one `session` read per tick)
  // a quiet poll lets the resting playhead's lane read its next older page (need)
  // a step read that failed is asked again on the poll's schedule (2.3 §读失败)
  const reask = () => { if ((s.laneErr.size || s.bodyFail.size) && s.playRid != null && openLane == null) { targeted = s.playRid; steps.target(s.playRid) } }
  const olderPage = () => { if (ledgerFirst()) return; const h = s.playRid != null && s.desk.held.get((s.desk.rows.get(s.playRid) || {}).lane); if (h && h.prev != null && openLane == null) { olderOk = true; targeted = s.playRid; steps.target(s.playRid) } }

  async function pollOnce() {
    const key = sessionKey(), reads = s.reads, signal = reads ? reads.signal : undefined, desk = s.desk
    // the session was switched (its reads aborted) while a request was in flight: no record, no stale line
    const stale = () => s.dead || key !== sessionKey() || !!(signal && signal.aborted)
    const before = desk.mark != null && desk.more && quiet && desk.order.length > 0
    const res = before ? await read('session', { before: desk.order[0] }, { signal })
      : desk.mark != null ? await read('session', { since: desk.mark }, { signal, hold: false }) : await read('session', {}, { signal })
    if (stale()) return
    if (!res.ok) return readFailed(res)
    const lastGood = s.goodAt
    s.errNote = null; s.goodKey = key; s.goodAt = api.now()
    const hadStale = !!s.staleErr; s.staleErr = null
    const same = res.status === 304 || !res.data
    if (same && !desk.lagging.size) { quiet = true; if (hadStale) renderHeader(); reask(); chainLedger(true); olderPage(); return { ok: true } }
    // nothing new, but a lane an earlier read failed on is read now: an empty delta carries it through the same path
    const a = same ? { base: desk.mark, mark: desk.mark } : res.data
    // the server knows no such session (meta null, nothing captured): said HERE, with a way back; the timer stops reading it
    if (a.base == null && !before && a.meta == null && !(a.calls || []).length) {
      s.goodKey = null; s.notListed = true; renderEmpty(''); E.ctxwin.innerHTML = notListedHtml(); E.ctxwin.__units = null; root.classList.add('notlisted'); renderHeader(); return { ok: true }
    }
    if (s.notListed) { s.notListed = false; root.classList.remove('notlisted') }
    quiet = a.base != null && !(a.calls || []).length && !(a.gone || []).length
    // the lanes this answer changes: its rows' lanes, before and after (a relane), and its headers
    const changed = a.base == null && !before ? null : new Set([...(a.lanes || []).map((h) => h.lane), ...(a.lanes_gone || [])])
    if (changed) for (const rid of [...(a.calls || []).map((r) => r.rid), ...(a.gone || [])]) { const o = desk.rows.get(rid); if (o) changed.add(o.lane) }
    if (changed) for (const r of a.calls || []) changed.add(r.lane)
    const keep = pin(), prevRow = curCall()
    // applied in slices that yield (2.3 §读与画), checking between them that the session is still this one
    const touched = new Map()
    let t0 = nowMs()
    for (const part of same ? [] : slicesOf(a, before)) {
      const r = applySession(desk, part, { before })
      for (const [k, v] of r.touched) mergeTouch(touched, k, v)
      if (nowMs() - t0 > SLICE_MS) { await yieldNow(); if (stale()) return; t0 = nowMs() }
    }
    // each held lane the delta touched (and one an earlier read failed on) reads on by 3.5's from-rule, in the step reads' one
    // lane slot; a failed read keeps that lane's drawn steps, leaves it for the next poll and says so in the header (K-29)
    const lt = await steps.laneSlot(() => readTouched(desk, touched, (name, q) => read(name, q, { signal, hold: false }), stale))
    if (!lt || stale()) return
    for (const k of [...touched.keys(), ...lt.done]) changed?.add(k)
    for (const k of lt.done) s.laneErr.delete(k)
    if (!lt.ok) { s.staleErr = { r: lt, since: lastGood }; s.goodAt = lastGood }
    const result = (ok) => (lt.ok ? ok : { ok: false })
    s.meta = desk.meta
    s.lanes = buildLanes(desk, { count: desk.probes || 0, series: [] }, { prev: s.lanes, changed })
    const prevAnchor = s.anchor
    s.anchor = anchorLane(s.lanes)
    judgeGap()
    if (!s.anchor || !s.anchor.calls.length) {
      renderEmpty('')
      E.ctxwin.innerHTML = `<div class="empty">${esc(desk.probes ? `This session has only token counts (${desk.probes}), no model calls to replay.` : 'No model calls have been captured in this session yet.')}</div>`
      renderHeader(); return result({ ok: true, pending: desk.pending || undefined })
    }
    if (s.anchor !== prevAnchor) { s.anchorTs = s.anchor.calls.map((c) => Date.parse(c.ts)); s.breaks = breakSteps(s.anchor.calls); s.problems = problemSteps(s.anchor) }
    const first = s.viewSig !== key
    unpin(keep)
    const moved = placePlayhead(prevRow)
    // the followed step's open reply bodies in one read before it is drawn (C3), so its newest reply shows with its bytes
    if (s.follow && moved && !first) {
      const refs = openRefs(s.playRid)
      if (refs.length) { await loadBodies(api, refs, { signal }); if (stale()) return }
    }
    // brush window: a new session starts on the whole of it when that fits the lane, else on the last steps that fit — or, when the
    // URL named an earlier step, on the ones around it. On live growth keep the reader's window, extending it when parked at the end.
    const N = s.anchor.calls.length
    if (first) { s.viewSig = key; s.view = { lo: 0, hi: N } } else {
      if (keep.atEnd) s.view.hi = N // a window parked at the live end grows with it
      s.view.hi = Math.min(N, s.view.hi || N); s.view.lo = Math.max(0, Math.min(s.view.lo, N - 1)); if (s.view.hi <= s.view.lo) s.view.hi = Math.min(N, s.view.lo + 1)
    }
    if (s.playhead < s.view.lo || s.playhead >= s.view.hi) { const w = Math.max(1, s.view.hi - s.view.lo); s.view.lo = Math.min(Math.max(0, s.playhead - ((w / 2) | 0)), Math.max(0, N - w)); s.view.hi = Math.min(N, s.view.lo + w) }
    fitView()
    // the open: the playhead's lane is read in the same turn, not after the 100 ms rest
    if (first && !deskStep(desk, s.playRid).held) { openLane = desk.rows.get(s.playRid).lane; steps.prefetch(openLane) }
    renderAll()
    refreshDrawer()
    if (s.initialStep == null && (first || moved || String(router.current().params.step ?? '') !== String(shownStep()))) syncUrl()
    reask()
    chainLedger(true)
    if (quiet) olderPage()
    return result({ ok: true, pending: desk.pending || undefined })
  }

  // ── capture health: read once per desk open, only to judge the 采集缺口 (1.2 §会话保真行); unreadable → no judgement
  function judgeGap() {
    const st = stepsOf(s.lanes)
    if (!st.length || !s.meta) { s.gap = null; return }
    s.gap = captureGap(s.health, { start: Date.parse(st[0].ts), end: Date.parse(st[st.length - 1].ts) }, s.meta.harness, api.now())
  }
  api.get('status').then((r) => { if (!s.dead && r.ok) { s.health = r.data; judgeGap(); if (s.anchor) renderHeader() } }).catch((e) => console.error(e))

  const onRp = () => { s.rpOpen = !s.rpOpen; const rp = $('#rightpage'); if (rp) { rp.classList.toggle('open', s.rpOpen); const b = $('#rpbar'); if (b) b.setAttribute('aria-expanded', String(s.rpOpen)) } }
  const rpbar = $('#rpbar')
  const onRpKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRp() } }
  rpbar.addEventListener('click', onRp); rpbar.addEventListener('keydown', onRpKey)
  const onRetry = (e) => { if (e.target.closest && e.target.closest('[data-retry]')) poll(true) } // the failure state's Retry
  E.ctxwin.addEventListener('click', onRetry)
  const offs = [() => { rpbar.removeEventListener('click', onRp); rpbar.removeEventListener('keydown', onRpKey); E.ctxwin.removeEventListener('click', onRetry); E.rails.removeEventListener('mouseover', onRailHover) },
    wireTimeline(E.saw, s), wireRails(E.rails, s), wireCtxWin(E.ctxwin, s), wireOutline(E.ctxnav, s), wireResources(E.resexp, s),
    wireRawPanel(E.rawpanel, s), wireDetail(E.detail, s), wireSessionHead(E.deskhead, s), wireStepBar(E.stepbar, s), initLayout(root)]
  // 1.2 §键盘: a held key moves the target at once and paints at most once per frame
  let keyTarget = null
  const paintKey = () => { const t = keyTarget; keyTarget = null; if (!s.dead && t != null) setPlayhead(t, true) }
  const onKey = (e) => {
    if (e.key === 'Escape' || !s.anchor || e.ctrlKey || e.metaKey || e.altKey) return
    const a = keyAction(e, { at: keyTarget ?? s.playhead, n: s.anchor.calls.length, problems: s.problems })
    if (!a) return
    e.preventDefault()
    if (a.keys) openModal({ title: KEYS_TITLE, bodyHtml: `<dl class="keylist">${KEY_LIST.map(([k, w]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(w)}</dd>`).join('')}</dl>` })
    else if (a.follow) { if (s.follow) { s.follow = false; renderHeader() } else followOn() }
    else { if (keyTarget == null) frame(paintKey); keyTarget = a.to }
  }
  setScreenKeys(onKey)
  // popovers and menus close themselves first and stop the key (core/keys.mjs); here: the call drawer, then the bottom row
  const onEscape = () => { if (E.detail.classList.contains('open')) closeDetail(E.detail, s); else if (s.rpOpen) onRp() }
  document.addEventListener('v2:escape', onEscape)
  const onVis = () => { if (!document.hidden) poll(true) } // back in view: read now, not a tick later
  document.addEventListener('visibilitychange', onVis)
  const timer = setInterval(() => poll(false), POLL_MS) // the desk keeps reading; 「跟随最新」 only decides whether the playhead follows growth
  // the lane's width changes with the window and with the right-page divider: watch both. Only a window that no longer fits is touched.
  const refit = () => { if (s.anchor && alive() && fitView()) { renderSaw(E.saw, s); renderRails(E.rails, s); watchRails(); renderOverview(E.saw, s) } }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : null
  if (ro) ro.observe($('#sawrow').closest('.tkrow'))
  window.addEventListener('resize', refit)

  renderEmpty('')
  poll()

  return {
    alive,
    update(route) {
      if (route.project !== s.project || route.id !== s.id) { // another session
        s.project = route.project; s.id = route.id; resetSession()
        s.initialStep = hasStep(route) ? stepParam(route.params.step).step : null
        renderEmpty('')
        poll(); return
      }
      if (!hasStep(route)) return
      // the same session, only the step moved (our own scrubbing lands here too, and is a no-op): clamp and rewrite (1.2:91)
      if (!s.anchor) { s.initialStep = stepParam(route.params.step).step; return }
      const p = stepParam(route.params.step, s.anchor.count ?? s.anchor.calls.length)
      if (p.step === shownStep() && !p.rewrite) return
      setPlayhead(p.step - 1 - (s.anchor.base || 0), true)
    },
    unmount() {
      s.dead = true
      if (s.reads) s.reads.abort()
      if (busyTimer != null) clearTimeout(busyTimer)
      document.removeEventListener('visibilitychange', onVis)
      clearInterval(timer); if (ro) ro.disconnect(); if (io) io.disconnect(); window.removeEventListener('resize', refit)
      for (const f of offs) { try { f() } catch (e) { console.error(e) } }
      setScreenKeys(null)
      document.removeEventListener('v2:escape', onEscape)
      closeDetail(E.detail, s); E.detail.innerHTML = ''
      E.deskhead.innerHTML = ''; E.stepbar.innerHTML = ''
    },
  }
}

// The screen: a desk whose DOM was replaced under it (another screen wrote into the shared element) is mounted afresh on the next
// route instead of drawing into detached nodes; it never throws for want of its own elements.
export function mount(el, ctx) {
  let d = mountDesk(el, ctx)
  return {
    update(route) { if (!d.alive()) { d.unmount(); d = mountDesk(el, ctx); return } d.update(route) },
    unmount() { d.unmount() },
  }
}
