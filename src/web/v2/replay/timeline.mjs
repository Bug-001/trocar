// replay/timeline.mjs — the trace's own rows (1.3): the 问题道 above the main track (a flag per cache break, × per failed
// call, 「压缩」 per compaction — its row name is the 「问题 k/n」 pager), the main track itself (context bars, or cost bars
// behind the 上下文大小 / 花费 switch), the cache band (cacheState's four shapes, one cell per bar), the 提问刻度 (one tick
// per user event, only where the server ships them), the whole-session overview strip with its brush, the axis captions and
// the legend row. Every row is the same grid (.tkrow: one gutter, one plotting lane) so the columns cannot drift.
//   renderSaw(el, s)       all rows for the brush window — rebuilt when the window or the data changes
//   markCurrent(el, s)     scrubbing: only the .cur marks, the pager's k and the position label move
//   renderOverview(el, s)  the whole-session strip and its brush
// `el` is #saw; `s` is the replay desk's state object (replay.mjs owns it).
import { esc, kf, usd } from '../core/fmt.mjs'
import { L } from '../core/labels.mjs'
import { cacheState, isBreak, breakCost, usageOf, hitRatio, refOf, priceMatch, costOf, isFailed } from '../core/metrics.mjs'
import { CT_ORDER, callComp, hitTier } from './analysis.mjs'
import { anchorJump } from './jump.mjs'
import { laneWord } from '../labels/replay.mjs'
import * as W from '../labels/replay.mjs'

export const OVW_BARCAP = 60
const q = (el, sel) => el.querySelector(sel)
const modelOf = (c) => (c && c.rec && c.rec.request && c.rec.request.model) || ''

// ── how many steps the saw row can draw ─────────────────────────────────────────────────────────────────────────────
export const SAW_BAR_PX = 3
export const barsThatFit = (width) => Math.max(1, Math.floor(width / SAW_BAR_PX))
export function fitWindow({ lo, hi, K, playhead }) {
  if (hi - lo <= K) return { lo, hi }
  if (playhead >= hi - K) return { lo: hi - K, hi }
  const start = Math.max(lo, Math.min(hi - K, playhead - Math.floor(K / 2)))
  return { lo: start, hi: start + K }
}
export function capWindow({ lo, hi, prev, K, playhead }) {
  if (hi - lo <= K) return { lo, hi }
  if (hi === prev.hi && lo !== prev.lo) return { lo: hi - K, hi }
  if (lo === prev.lo && hi !== prev.hi) return { lo, hi: lo + K }
  return fitWindow({ lo, hi, K, playhead })
}

export const windowOf = (s) => {
  const N = s.anchor ? s.anchor.calls.length : 0
  const lo = Math.max(0, Math.min(Math.max(0, N - 1), s.view.lo | 0))
  return { lo, hi: Math.max(lo + 1, Math.min(N, s.view.hi || N)), N }
}

// the 缓存对比步 of calls[i]: the server names it (S12 cacheBreak.refGi); until it does, the same walk the predicate uses
const refCallOf = (s, i) => {
  const gi = s.anchor.calls[i] && s.anchor.calls[i].cacheBreak && s.anchor.calls[i].cacheBreak.refGi
  if (gi != null && s.anchor.giLocal) { const k = s.anchor.giLocal.get(gi); if (k != null) return s.anchor.calls[k] }
  return refOf(s.anchor.calls, i)
}
const priceRowOf = (s, c) => (s.pricing ? priceMatch(s.pricing, modelOf(c)) : null)

// the problem steps of the whole main lane (window-independent): every cache break and every failed call, in order.
// A compaction step is NOT one (1.3): it draws the neutral 「压缩」 word — a rewrite is not a problem, and it never counts in n.
export function problemSteps(calls) {
  const out = []
  ;(calls || []).forEach((c, i) => { if (isFailed(c) || (isBreak(c, refOf(calls, i)) && !c.compaction)) out.push(i) })
  return out
}

// composition of one call as stacked segments. "Not computed" (hatched) is not "body not on this page": the nine numbers ride
// on every call, only the bodies are lazy.
export function barSegsHtml(c, h) {
  const comp = callComp(c)
  if (!comp) return `<span class="ct-unloaded" title="The breakdown has not been computed yet" style="height:${h}px"></span>`
  const tot = CT_ORDER.reduce((a, k) => a + (comp[k] || 0), 0) || 1
  return CT_ORDER.map((k) => { const sh = ((comp[k] || 0) / tot) * h; return sh < 0.4 ? '' : `<span class="ct-${k}" style="height:${sh.toFixed(2)}px"></span>` }).join('')
}

// ── the 问题道 ──────────────────────────────────────────────────────────────────────────────────────────────────────
// A flag per break (height ∝ √(≈ 多花), fixed when it cannot be computed), × per failed call, 「压缩」 per compaction step
// (neutral — not a flag, not counted in n). The row name is the pager 「问题 k/n」: k is the problem the playhead is on.
// One cell per windowed step — an empty .pcell where the step has nothing to say — on the SAME 1/(hi−lo) flex axis as the
// bars (1.3 §/N 收敛): k marks must never split the row into k equal shares, each lands on its own step's column.
const FLAG_H = 14
function problemRowHtml(s, { lo, hi }) {
  const cells = new Array(hi - lo).fill('')
  const breaks = [] // flag heights scale against the window's max ≈ 多花, known only after the pass
  for (let i = lo; i < hi; i++) {
    const c = s.anchor.calls[i]
    const n = i + 1
    if (isFailed(c)) {
      const msg = typeof c.error === 'string' ? c.error : (c.errMsg || (c.error && c.error.message) || '')
      cells[i - lo] = `<span class="pxmark" data-i="${i}" role="button" tabindex="0" title="${esc(W.failTip(n, msg))}">×</span>`
      continue
    }
    // neutral, not a flag: a small mark with no text of its own; the word rides the hover and the screen-reader name
    if (c.compaction) { const tip = `${W.COMPACT_WORD}${c.compactionInferred ? ' · ' + W.GUESS : ''} — ${W.compactTip(n, c.compactionInferred)}`; cells[i - lo] = `<span class="pcompact${c.compactionInferred ? ' inf' : ''}" data-i="${i}" role="button" tabindex="0" title="${esc(tip)}" aria-label="${esc(tip)}"></span>`; continue }
    const st = cacheState(c, refCallOf(s, i))
    if (st.isBreak) breaks.push({ i, n, usd: breakCost(c, refCallOf(s, i), priceRowOf(s, c)).usd, struct: st.state === 'changed' })
  }
  let maxUsd = 0
  for (const b of breaks) if (b.usd != null && b.usd > maxUsd) maxUsd = b.usd
  for (const b of breaks) {
    const h = b.usd == null ? Math.round(FLAG_H * 0.55) : Math.max(4, Math.round(Math.sqrt(b.usd / Math.max(1e-9, maxUsd)) * FLAG_H))
    const costW = b.usd == null ? W.BREAK_COST_NONE : `≈ extra cost ${usd(b.usd)}`
    cells[b.i - lo] = `<span class="pflag" data-i="${b.i}" role="button" tabindex="0" style="height:${h}px" title="${esc(W.breakFlagTip(b.n, costW, b.struct))}" aria-label="${esc(W.breakFlagTip(b.n, costW, b.struct))}"></span>`
  }
  return cells.map((c) => c || '<span class="pcell"></span>').join('')
}
// the pager's own row: 「问题 k/n」 + ‹ › (only when there is anything to page to); off a problem step it reads 「N 个问题」
export function renderProblemNav(el, s) {
  const nav = q(el, '#probnav')
  if (!nav) return
  const probs = s.problems || []
  const n = probs.length
  const k = probs.includes(s.playhead) ? String(probs.indexOf(s.playhead) + 1) : null
  nav.innerHTML = n ? `${esc(W.problemPager(k, n))} <button type="button" class="pgbtn" id="probPrev" aria-label="${esc(W.PROBLEM_PREV)}" title="${esc(W.PROBLEM_PREV)}">‹</button><button type="button" class="pgbtn" id="probNext" aria-label="${esc(W.PROBLEM_NEXT)}" title="${esc(W.PROBLEM_NEXT)}">›</button>` : esc(W.problemPager(null, 0))
}
// the next / previous problem step from the playhead (dir > 0 / < 0); null at the ends
export const problemTarget = (probs, playhead, dir) => {
  if (dir > 0) { const n = probs.find((b) => b > playhead); return n === undefined ? null : n }
  for (let i = probs.length - 1; i >= 0; i--) if (probs[i] < playhead) return probs[i]
  return null
}
// where ‹ › land (1.3 §问题道 · 翻页): the next/previous problem step, and the landing per 1.4 — a break step opens on
// its 变化线, a failed step just moves the playhead. null at the ends. Pure, so the pager's decision is testable.
export function problemJump(calls, probs, playhead, dir) {
  const t = problemTarget(probs, playhead, dir)
  if (t == null || !calls || !calls[t]) return null
  return { t, jump: isFailed(calls[t]) ? null : anchorJump('cachebrk') }
}

// ── the cache band: one cell per bar, drawn by cacheState's own order ───────────────────────────────────────────────
function cacheCell(c, i, s) {
  const st = cacheState(c, refCallOf(s, i))
  const n = i + 1
  if (st.state === 'failed') return `<div class="cbar failed" data-i="${i}" title="${esc(W.CACHE_CELL_FAILED)}"></div>` // no tier: failed is not "missed"
  if (st.state === 'no-usage') return `<div class="cbar na" data-i="${i}" title="${esc(W.CACHE_CELL_NONE + ' · ' + W.CACHE_CELL_NONE_TIP)}"></div>`
  const pct = st.hit != null ? Math.round(st.hit * 100) : null
  const unk = c.wire && c.wire.cacheSemanticsKnown === false
  if (unk) return `<div class="cbar unk" data-i="${i}" title="${esc(W.cacheCellUnknown(pct) + ' · ' + W.CACHE_SEMANTICS_UNKNOWN)}"></div>`
  const cls = pct == null ? 'na' : hitTier(pct / 100)
  return `<div class="cbar ${cls}" data-i="${i}" title="${esc(W.cacheCellPct(pct))}"></div>`
}

// ── the main track ────────────────────────────────────────────────────────────────────────────────────────────────
// one bar of the 花费 view: height ∝ the step's ≈ estimate; uncomputable steps are hatched, never $0-tall
function costBarHtml(c, i, s, maxCost) {
  if (isFailed(c)) return { h: 20, html: '', tip: W.failTip(i + 1, typeof c.error === 'string' ? c.error : (c.errMsg || '')) }
  const u = usageOf(c), m = u ? priceRowOf(s, c) : null
  if (!u) return { h: 0, html: `<span class="ct-unloaded" style="height:6px"></span>`, tip: W.CACHE_CELL_NONE_TIP }
  if (!m) return { h: 0, html: `<span class="ct-unloaded" style="height:6px"></span>`, tip: W.COST_WHY['no-price'] }
  const v = costOf(m.row, u)
  return { h: Math.max(3, Math.round((v / Math.max(1e-9, maxCost)) * 72)), html: '', tip: `≈ ${usd(v)}` + (m.exact ? '' : ` · ${W.PRICE_BY_KEY(m.key)}`) }
}

export function renderSaw(el, s) {
  if (!s.anchor) return
  const { lo, hi, N } = windowOf(s)
  const isMain = s.anchor.kind === 'main'
  const win = []
  for (let i = lo; i < hi; i++) win.push([s.anchor.calls[i], i])
  // 1.3 §窗内步少时收窄: the detail rows' lanes cap their width at this many bars (css/replay.css), together, left-aligned
  const page = el.closest ? el.closest('#leftpage') : null
  if (page) page.style.setProperty('--nbars', String(hi - lo))
  // the problem lane
  q(el, '#probrow').innerHTML = problemRowHtml(s, { lo, hi })
  // the main track: 上下文大小 (default) or 花费
  const costView = s.sawView === 'cost'
  let peak = '', peakTip = ''
  if (costView) {
    let maxCost = 0, any = false
    for (const [c] of win) { const u = usageOf(c), m = u ? priceRowOf(s, c) : null; const v = m ? costOf(m.row, u) : null; if (v != null) { any = true; if (v > maxCost) maxCost = v } }
    peak = any ? `≈ ${usd(maxCost)}` : '≈ —'
    q(el, '#sawrow').innerHTML = '<div id="reviewbracket"><span class="rbend" aria-hidden="true">' + esc(W.GUESS) + '</span></div>' + win.map(([c, i]) => {
      const b = costBarHtml(c, i, s, maxCost)
      return `<div class="bar cost ${isFailed(c) ? 'err' : ''} ${i === s.playhead ? 'cur' : ''}" data-i="${i}" style="height:${b.h}px" title="step ${i + 1} · ${esc(b.tip)}">${b.html}</div>`
    }).join('')
  } else {
    const pk = Math.max(1, s.anchor.peakCtx)
    peak = `${kf(pk)} tok`
    peakTip = 'The largest real input total of a main thread step (input + cache read + cache write)'
    q(el, '#sawrow').innerHTML = '<div id="reviewbracket"><span class="rbend" aria-hidden="true">' + esc(W.GUESS) + '</span></div>' + win.map(([c, i]) => {
      const h = isFailed(c) ? 20 : Math.max(3, Math.round(((c.ctx || 0) / pk) * 72))
      // a paged-out step still draws its bar (its cheap meta is real); whether the body is on this page is the context
      // window's own sentence (2.3 ⑤) — the 砍掉的 table keeps it out of the bar's hover
      return `<div class="bar ${isFailed(c) ? 'err' : ''} ${c.compaction ? 'compact' : ''} ${i === s.playhead ? 'cur' : ''}" data-i="${i}" style="height:${h}px" title="step ${i + 1} · ${isFailed(c) ? 'call failed' : kf(c.ctx) + ' tok'}">${isFailed(c) ? '' : barSegsHtml(c, h)}</div>`
    }).join('')
  }
  // the cache band
  q(el, '#cacherow').innerHTML = win.map(([c, i]) => cacheCell(c, i, s)).join('')
  // the 提问刻度: only where the server ships user events (1.3 §提问刻度); step is a global gi → giLocal first
  const asks = (s.anchor.events || []).map((e, k) => ({ e, k })).filter(({ e }) => e && e.type === 'user' && e.step != null)
    .map(({ e, k }) => ({ k: k + 1, i: s.anchor.giLocal ? s.anchor.giLocal.get(e.step) : null, preview: e.preview || '' }))
    .filter((a) => a.i != null && a.i >= lo && a.i < hi)
  const askrow = q(el, '#askrow')
  if (askrow) {
    askrow.style.display = asks.length ? '' : 'none'
    // one cell per windowed step (an empty .acell where no ask begins) on the bars' own /N axis: a tick lands on ITS
    // step's column, never on k equal shares of the row. Two events on one step share the column; their tips join.
    const byStep = new Map()
    for (const a of asks) { if (!byStep.has(a.i)) byStep.set(a.i, []); byStep.get(a.i).push(a) }
    let h = ''
    for (let i = lo; i < hi; i++) {
      const arr = byStep.get(i)
      h += arr ? `<span class="atick" data-i="${i}" title="${esc(arr.map((a) => W.askScaleTip(a.k, a.preview)).join('\n'))}"></span>` : '<span class="acell"></span>'
    }
    q(el, '#askscale').innerHTML = h
  }
  // the axis: step numbers (call counts when the anchor is not the main lane)
  const unit = (v) => (isMain ? `step ${v}` : `call ${v}`)
  q(el, '#sawstart').textContent = unit(lo + 1)
  q(el, '#sawend').textContent = unit(hi) // the total is the step bar's (one fact, one place)
  // the main track's own corner: the view word + this session's peak
  q(el, '#sawgut').innerHTML = `${esc(costView ? W.VIEW_COST : (isMain ? 'Context' : laneWord(s.anchor.kind)))} <b title="${esc(peakTip)}">${esc(peak)}</b>`
  // the legend row
  q(el, '#viewswitch').innerHTML = `<button type="button" class="segbtn${costView ? '' : ' on'}" data-view="ctx" aria-pressed="${!costView}">${esc(W.VIEW_CTX)}</button><button type="button" class="segbtn${costView ? ' on' : ''}" data-view="cost" aria-pressed="${costView}">${esc(W.VIEW_COST)}</button>`
  q(el, '#complegend').title = costView ? W.COST_LEGEND : W.COMP_LEGEND // the legend row stays one line; a cut part keeps its words here
  q(el, '#complegend').innerHTML = costView ? `<span>${esc(W.COST_LEGEND)}</span>` :
    `<span>${esc(W.COMP_LEGEND)}</span><span class="barlegend"><i class="ct-tools"></i>tools<i class="ct-system"></i>system<i class="ct-user"></i>messages<i class="ct-assistant"></i>reply<i class="ct-thinking"></i>thinking<i class="ct-tool_use"></i>tool call<i class="ct-tool_result"></i>tool result</span>`
  q(el, '#viewrange').textContent = W.showSteps(lo + 1, hi)
  q(el, '#nomain').style.display = isMain ? 'none' : ''
  if (!isMain) q(el, '#nomain').textContent = q(el, '#nomain').title = W.noMainLane(laneWord(s.anchor.kind))
  markCurrent(el, s)
}

// scrubbing touches only the current marks and the pager's k; the bars themselves are not rebuilt
export function markCurrent(el, s) {
  if (!s.anchor) return
  const N = s.anchor.calls.length
  for (const b of el.querySelectorAll('#sawrow .bar')) b.classList.toggle('cur', +b.dataset.i === s.playhead)
  for (const b of el.querySelectorAll('#cacherow .cbar')) b.classList.toggle('cur', +b.dataset.i === s.playhead)
  const pin = q(el, '#ovpin'); if (pin) pin.style.left = (((s.playhead + 0.5) / N) * 100).toFixed(3) + '%'
  renderProblemNav(el, s) // which problem the playhead is on — and whether ‹ › have anywhere to go
}

// ── overview strip + brush ─────────────────────────────────────────────────────────────────────────────────────────
export function renderOverview(el, s) {
  const strip = q(el, '#ovstrip')
  if (!strip) return
  const N = s.anchor ? s.anchor.calls.length : 0
  if (!N) { strip.innerHTML = ''; return }
  // do not destroy the brush (and its pointer capture) mid-drag: just reposition; rebuild when the drag ends
  if (s.brushDragging) { repositionBrush(el, s); return }
  const peak = Math.max(1, s.anchor.peakCtx)
  let bg = '', sampled = false
  if (N <= OVW_BARCAP) {
    bg = '<div class="ovbars">' + s.anchor.calls.map((c, i) => {
      const h = Math.max(1, Math.round(((c.ctx || 0) / peak) * 20))
      return `<div class="ovbar ${isFailed(c) ? 'err' : ''}" style="height:${h}px" title="step ${i + 1}"></div>`
    }).join('') + '</div>'
  } else {
    // many steps: one point per bucket on the SAME /N axis as the brush and the pin. Only labelled "sampled" when buckets
    // really merge steps (N > 240); for 60 < N <= 240 it is per step and a label would be false.
    const B = Math.min(N, 240); sampled = N > B
    const pts = []
    for (let k = 0; k < B; k++) {
      const a = Math.floor((k * N) / B), b = Math.max(a + 1, Math.floor(((k + 1) * N) / B))
      let mx = 0
      for (let j = a; j < b && j < N; j++) { const cv = s.anchor.calls[j].ctx || 0; if (cv > mx) mx = cv }
      pts.push((((a + b) / 2 / N) * 100).toFixed(2) + ',' + (22 - Math.max(0.5, (mx / peak) * 20)).toFixed(2))
    }
    bg = `<svg class="ovsvg" viewBox="0 0 100 22" preserveAspectRatio="none"><polyline points="${pts.join(' ')}"/></svg>`
  }
  strip.innerHTML = bg +
    (sampled ? `<span class="ovsample" title="Sampled: one point per bucket, not one per step (the strip is a map, not verbatim data)">${esc(L.SAMPLED)}</span>` : '') +
    '<div class="ovpin" id="ovpin"></div>' +
    `<div class="ovbrush" id="ovbrush" tabindex="0" aria-label="${esc(W.BRUSH_LABEL)}" title="Drag = pan · drag an edge = zoom · double-click = all (in a long session that does not fit the row above, the largest range that fits)"><span class="ovh ovh-l"></span><span class="ovh ovh-r"></span></div>`
  repositionBrush(el, s)
}
export function repositionBrush(el, s) {
  const N = s.anchor ? s.anchor.calls.length : 1
  const b = q(el, '#ovbrush')
  if (b) { b.style.left = ((s.view.lo / N) * 100).toFixed(3) + '%'; b.style.width = (((s.view.hi - s.view.lo) / N) * 100).toFixed(3) + '%' }
  const p = q(el, '#ovpin'); if (p) p.style.left = (((s.playhead + 0.5) / N) * 100).toFixed(3) + '%'
}

// One set of listeners for the life of the screen. The brush is rebuilt on redraw, so its pointer events are delegated from the
// strip: a captured pointer keeps targeting the captured element, and its events bubble up to the strip.
export function wireTimeline(el, s) {
  const strip = q(el, '#ovstrip')
  const N = () => (s.anchor ? s.anchor.calls.length : 1)
  const stripW = () => Math.max(1, strip.getBoundingClientRect().width)
  let mode = null, startX = 0, startLo = 0, startHi = 0
  const down = (e, m) => {
    mode = m; s.brushDragging = true; startX = e.clientX; startLo = s.view.lo; startHi = s.view.hi
    try { e.target.setPointerCapture(e.pointerId) } catch { /* no capture: the drag still works while the pointer stays over the strip */ }
    e.stopPropagation(); e.preventDefault()
  }
  const move = (e) => {
    if (!mode) return
    const n = N(), d = Math.round(((e.clientX - startX) / stripW()) * n)
    if (mode === 'pan') { const dd = Math.max(-startLo, Math.min(n - startHi, d)); s.setView(startLo + dd, startHi + dd, false) }
    else if (mode === 'l') s.setView(Math.min(startHi - 1, startLo + d), startHi, false)
    else s.setView(startLo, Math.max(startLo + 1, startHi + d), false)
  }
  const up = () => { if (!mode) return; mode = null; s.brushDragging = false; renderOverview(el, s) } // the backdrop may be stale from a poll during the drag
  strip.addEventListener('pointerdown', (e) => {
    const t = e.target
    if (t.classList.contains('ovh-l')) down(e, 'l')
    else if (t.classList.contains('ovh-r')) down(e, 'r')
    else if (t.closest('.ovbrush')) down(e, 'pan')
  })
  strip.addEventListener('pointermove', move)
  strip.addEventListener('pointerup', up)
  strip.addEventListener('pointercancel', up)
  strip.addEventListener('dblclick', (e) => { if (e.target.closest('.ovbrush')) { e.preventDefault(); s.setView(0, N(), true) } })

  const onClick = (e) => {
    const vs = e.target.closest('[data-view]')
    if (vs && vs.closest('#viewswitch')) { s.sawView = vs.dataset.view === 'cost' ? 'cost' : 'ctx'; renderSaw(el, s); return }
    const bar = e.target.closest('#sawrow .bar')
    if (bar) { s.setPlayhead(+bar.dataset.i, true); return }
    const btn = e.target.closest('button')
    if (!btn || !s.anchor) return
    if (btn.id === 'probPrev' || btn.id === 'probNext') {
      const j = problemJump(s.anchor.calls, s.problems || [], s.playhead, btn.id === 'probNext' ? 1 : -1)
      if (j) s.jumpTo(j.t, j.jump) // lands on the 变化线 when that problem step has one; a failed step just moves the playhead
    }
  }
  el.addEventListener('click', onClick)
  return () => el.removeEventListener('click', onClick)
}
