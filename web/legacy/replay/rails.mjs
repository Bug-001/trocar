// replay/rails.mjs — the overlay rows under the main track (1.3 §叠加轨; the track parts themselves are 2.1's): the
// 子 agent group, the 后台调用 group (both collapsed by default — a collapsed group draws only the failed ×) and the token
// 计数 row (mini bars, open by default, at most 300 drawn). Words come from the lane kind table (labels/replay.mjs) — never
// the server's icon or note (the note rides into the drawer's 技术细节).
// Every count the rows name is the full truth; only what is drawn is windowed and sampled.
// `el` is #rails; `s` is the replay desk's state object.
import { esc, kf, usd } from '../core/fmt.mjs'
import { discChev } from '../core/icons.mjs'
import { attrSel } from '../core/dom.mjs'
import { when } from './analysis.mjs'
import { xOf, windowCalls, nearestByX, nearestByTs, turnsReviewed, placeOf } from './lanes.mjs'
import { usageOf, priceMatch, costOf, isFailed as failOf } from '../core/metrics.mjs'
import { laneKind, laneWord, SUBAGENT_ROW, BG_ROW, BG_ROW_HINT, TC_ROW, laneTimes, callsWord, TC_SAMPLED_TIP, TC_NO_SIZE, ONLY_MAIN } from '../labels/replay.mjs'
import { L } from '../core/labels.mjs'

// only the lanes that read the conversation get the review bracket (2.1 ⑤)
export const reviewing = (lane) => lane.kind === 'monitor' || lane.kind === 'token-count'

// ── ticks ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// ticks outside the brush window are culled, not piled at the edges; a tick names its call by data-rid, never by a place in the lane:
// the lanes can move on before the tick is drawn again (2.3 §播放头是调用).
// A failed call draws ×. No safety-review mark until the server reads its verdicts right (2.1 §边界情况 安全审查的结论).
export function renderTicks(lane, s) {
  const win = windowCalls(lane, s.anchorTs, s.view)
  const x = (c) => (xOf(s.anchorTs, s.view, c.ts) * 100).toFixed(2)
  const w = laneWord(lane.kind)
  const tip = (c, i) => `${w} · call ${i + 1} · ${when(c.ts)} · ${failOf(c) ? 'call failed' : kf(c.ctx) + ' tok'}`
  if (lane.kind === 'token-count') {
    const MAX = 300, step = Math.max(1, Math.ceil(win.length / MAX)) // drawn bars are capped; every probe stays reachable
    const peak = Math.max(1, lane.peakCtx)
    const drawn = win.filter((_, j) => j % step === 0)
    lane.drawn = drawn.length
    return drawn.map(({ c, i }) => {
      const h = Math.max(1, Math.round((c.ctx / peak) * 24))
      return `<span class="pbar" data-lane="token-count" data-rid="${esc(c.rid)}" style="left:${x(c)}%;height:${h}px" title="${esc(tip(c, i))}"></span>`
    }).join('')
  }
  return win.map(({ c, i }) =>
    `<span class="tick ${failOf(c) ? 'errtick' : ''}" data-lane="${esc(lane.id)}" data-rid="${esc(c.rid)}" style="left:${x(c)}%" title="${esc(tip(c, i))}"></span>`).join('')
}

// the marks a collapsed group still draws: the failed × of every member lane, each one clickable, opening that call in the drawer
function collapsedMarks(lanes, s) {
  const x = (c) => (xOf(s.anchorTs, s.view, c.ts) * 100).toFixed(2)
  return lanes.flatMap((l) => windowCalls(l, s.anchorTs, s.view).filter((o) => failOf(o.c)).map((o) => ({ ...o, l })))
    .map(({ c, i, l }) => `<span class="tick errtick" data-lane="${esc(l.id)}" data-rid="${esc(c.rid)}" style="left:${x(c)}%" title="${esc(`${laneWord(l.kind)} · call ${i + 1} · ${when(c.ts)} · call failed`)}"></span>`).join('')
}

// one lane's name. Background kinds are named by their word + the full call count; a subagent is named by its task
// (S4) or the server's label as-is, with the call count and the ≈ cost of the whole lane.
function railName(l, s, sub) {
  if (!sub) return laneTimes(laneWord(l.kind), l.count ?? l.calls.length)
  const model = (c) => (c.rec && c.rec.request && c.rec.request.model) || ''
  let sum = 0, priced = 0, from = false
  for (const c of l.calls) {
    if (failOf(c)) continue // a failed call is not billed
    const u = usageOf(c), m = u && s.pricing ? priceMatch(s.pricing, model(c)) : null
    const v = m ? costOf(m.row, u) : null
    if (v == null) { if (u) from = true; continue }
    sum += v; priced++; if (m.exact === false) from = true
  }
  const task = String(l.task != null && l.task !== '' ? l.task : l.label || '')
  // no call priced (or no table yet): no ≈ $ at all, never a $0 (1.3 子 agent 行名)
  return `${task} · ${callsWord(l.count ?? l.calls.length)}` + (priced ? ` · ≈ ${from ? 'from ' : ''}${usd(sum)}` : '')
}

// one lane's own row
function railHtml(l, s, { sub = false } = {}) {
  const col = s.collapsedRails.has(l.id)
  const hint = laneKind(l.kind).hint
  const name = railName(l, s, sub)
  // the row name ellipsizes in the gutter; its hover carries the whole of it, the lane's own label and the kind's hint
  const lab = String(l.label || '')
  const tip = [name, lab && !name.includes(lab) ? lab : '', hint].filter(Boolean).join(' · ')
  return `<div class="rail k-${esc(l.kind)} tkrow">` +
    `<div class="tgut railname ${col ? 'col' : ''}" data-toggle="${esc(l.id)}" title="${esc(tip)}"><span class="tw">${discChev(!col)}</span> <span class="tn">${esc(name)}</span></div>` +
    (col ? '<div class="tlane"></div>' : `<div class="tlane railbody" data-lane="${esc(l.id)}">${renderTicks(l, s)}</div>`) + `</div>`
}

// the token 计数 row: mini bars stand for the measured context size; 「采样显示」 only when fewer were drawn than exist
function tcRailHtml(l, s) {
  const col = s.collapsedRails.has(l.id)
  const noSize = Math.max(0, (l.count || l.calls.length) - l.calls.length)
  const hint = laneKind('token-count').hint + (noSize ? ` · ${TC_NO_SIZE(noSize)}` : '')
  const body = col ? '' : `<div class="tlane railbody" data-lane="token-count">${renderTicks(l, s)}${l.drawn != null && l.drawn < l.calls.length ? `<span class="tcsample" title="${esc(TC_SAMPLED_TIP(l.drawn, l.count || l.calls.length))}">${esc(L.SAMPLED)}</span>` : ''}</div>`
  return `<div class="rail k-token-count tkrow"><div class="tgut railname ${col ? 'col' : ''}" data-toggle="token-count" title="${esc(hint)}"><span class="tw">${discChev(!col)}</span> <span class="tn">${esc(TC_ROW(l.count || l.calls.length))}</span></div>${col ? '<div class="tlane"></div>' : body}</div>`
}

// the overlay lanes by the row they sit in
function rowsOf(s) {
  const rl = s.lanes.filter((l) => l !== s.anchor)
  const of = (row) => rl.filter((l) => laneKind(l.kind).row === row)
  return { subs: of('sub'), bgs: of('bg'), tcs: of('tc') }
}
// whether the gutter has any row to open or close (the Tracks menu shows only then): one pass, no rows built
export const hasRails = (s) => s.lanes.some((l) => l !== s.anchor && ['sub', 'bg', 'tc'].includes(laneKind(l.kind).row))
const bgCalls = (bgs) => bgs.reduce((n, l) => n + (l.count ?? l.calls.length), 0)

// what can be opened and closed, in the order renderRails draws it: the gutter draws these rows, the Tracks menu lists them
export function railToggles(s) {
  const { subs, bgs, tcs } = rowsOf(s)
  const lane = (l, name) => ({ id: l.id, name, open: !s.collapsedRails.has(l.id) })
  const out = []
  if (subs.length > 1) out.push({ id: 'group:sub', name: SUBAGENT_ROW(subs.length), open: s.subgroupOpen })
  if (subs.length === 1 || s.subgroupOpen) for (const l of subs) out.push(lane(l, railName(l, s, true)))
  if (bgs.length) out.push({ id: 'group:bg', name: BG_ROW(bgCalls(bgs)), open: s.bgOpen })
  if (s.bgOpen) for (const l of bgs) out.push(lane(l, railName(l, s, false)))
  for (const l of tcs) out.push(lane(l, TC_ROW(l.count || l.calls.length)))
  return out
}

// one row of railToggles opened or closed; the caller draws
export function flipRail(s, id) {
  if (id === 'group:sub') s.subgroupOpen = !s.subgroupOpen
  else if (id === 'group:bg') s.bgOpen = !s.bgOpen
  else if (!s.collapsedRails.delete(id)) s.collapsedRails.add(id)
}

export function renderRails(el, s) {
  const { subs, bgs, tcs } = rowsOf(s)
  subs.forEach((l) => { if (!s.subSeeded.has(l.id)) { s.subSeeded.add(l.id); s.collapsedRails.add(l.id) } }) // a fan-out never buries the main track
  let html = ''
  if (subs.length > 1) {
    const open = s.subgroupOpen
    html += `<div class="rail k-subagent tkrow">` +
      `<div class="tgut railname group ${open ? '' : 'col'}" data-grouptoggle="sub" title="${esc(laneKind('subagent').hint)}"><span class="tw">${discChev(open)}</span> <span class="tn">${esc(SUBAGENT_ROW(subs.length))}</span></div>` +
      `<div class="tlane">${open ? '' : `<div class="railbody groupbody">${collapsedMarks(subs, s)}</div>`}</div></div>` +
      (open ? `<div class="subkids">${subs.map((l) => railHtml(l, s, { sub: true })).join('')}</div>` : '')
  } else if (subs.length === 1) html += railHtml(subs[0], s, { sub: true })
  if (bgs.length) {
    const open = s.bgOpen
    html += `<div class="rail tkrow">` +
      `<div class="tgut railname group ${open ? '' : 'col'}" data-grouptoggle="bg" title="${esc(BG_ROW_HINT)}"><span class="tw">${discChev(open)}</span> <span class="tn">${esc(BG_ROW(bgCalls(bgs)))}</span></div>` +
      `<div class="tlane">${open ? '' : `<div class="railbody groupbody">${collapsedMarks(bgs, s)}</div>`}</div></div>` +
      (open ? `<div class="bgkids">${bgs.map((l) => railHtml(l, s)).join('')}</div>` : '')
  }
  for (const l of tcs) html += tcRailHtml(l, s)
  el.innerHTML = html || `<div class="railsonly">${esc(ONLY_MAIN)}</div>`
  if (s.selTick) { const t = el.querySelector(`[data-rid="${attrSel(s.selTick)}"]`); if (t) t.classList.add('sel') }
}

// ── the review bracket: how much of the conversation a monitor / token-count call looked at (s.reviewRange = {k}: the first k
// steps; the desk's view draws it on the bars) ──────────────────────────────────────────────────────────────────────────
export function highlightRange(s, lane, i) {
  const c = lane.calls[i]
  if (!c) return
  s.reviewRange = { k: turnsReviewed(s.anchorTs, c.ts) }
  s.paintReview()
}
export function clearRange(s) { s.reviewRange = null; s.paintReview() }

export function selectTick(s, lane, i) {
  if (i == null || i < 0 || !lane.calls[i]) return // an empty-window click must never open the drawer on -1
  const c = lane.calls[i]
  s.selTick = c.rid
  for (const e of s.root.querySelectorAll('#rails .tick.sel, #rails .pbar.sel')) e.classList.remove('sel')
  const el = s.root.querySelector(`#rails [data-rid="${attrSel(c.rid)}"]`); if (el) el.classList.add('sel')
  if (reviewing(lane)) highlightRange(s, lane, i); else clearRange(s)
  if (s.anchor.calls.length) { s.follow = false; s.setPlayhead(nearestByTs(s.anchor, c.ts, s.playhead), false) } // the conversation jumps to the same moment
  // in the task after the step's paint (2.3 §归约前沿); its lane not held yet: the drawer draws the row first and fills in when the lane lands (2.3 §读与画)
  s.openDetailNext(lane, i)
}

export function wireRails(el, s) {
  const laneOf = (id) => s.lanes.find((l) => l.id === id)
  const fracOf = (body, e) => { const r = body.getBoundingClientRect(); return (e.clientX - r.left) / Math.max(1, r.width) }
  const onClick = (e) => {
    const gt = e.target.closest('[data-grouptoggle]')
    if (gt) { flipRail(s, 'group:' + gt.dataset.grouptoggle); renderRails(el, s); return }
    const tg = e.target.closest('[data-toggle]')
    if (tg) { flipRail(s, tg.dataset.toggle); renderRails(el, s); return }
    const t = e.target.closest('.tick, .pbar')
    if (t) { const p = placeOf(s.lanes, t.dataset.rid); if (p) selectTick(s, p.lane, p.i); return }
    // anywhere on an open rail picks the nearest call IN the window, so every call is reachable, not just the drawn ticks
    const body = e.target.closest('.railbody[data-lane]')
    if (body) { const lane = laneOf(body.dataset.lane), i = lane && lane.calls.length ? nearestByX(lane, s.anchorTs, s.view, fracOf(body, e)) : -1; if (i >= 0) selectTick(s, lane, i) }
  }
  const onMove = (e) => {
    const body = e.target.closest && e.target.closest('.railbody[data-lane]')
    if (!body) return
    const lane = laneOf(body.dataset.lane)
    if (!lane || !lane.calls.length || !reviewing(lane)) return
    const t = e.target.closest('.tick, .pbar')
    highlightRange(s, lane, t ? lane.ridLocal.get(t.dataset.rid) : nearestByX(lane, s.anchorTs, s.view, fracOf(body, e)))
  }
  const onLeave = () => { if (!s.selTick) clearRange(s) }
  el.addEventListener('click', onClick)
  el.addEventListener('mousemove', onMove)
  el.addEventListener('mouseleave', onLeave)
  return () => { el.removeEventListener('click', onClick); el.removeEventListener('mousemove', onMove); el.removeEventListener('mouseleave', onLeave) }
}
