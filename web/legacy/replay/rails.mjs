// replay/rails.mjs — the overlay rows under the main track (1.3 §叠加轨; the track parts themselves are 2.1's): the
// 子 agent group, the 后台调用 group (both collapsed by default — a collapsed group draws only the failed × and, since
// S13, the flagged marks) and the token 计数 row (mini bars, open by default, at most 300 drawn). Words come from the
// lane kind table (labels/replay.mjs) — never the server's icon or note (the note rides into the drawer's 技术细节).
// Every count the rows name is the full truth; only what is drawn is windowed and sampled.
// `el` is #rails; `s` is the replay desk's state object.
import { esc, kf, usd } from '../core/fmt.mjs'
import { attrSel } from '../core/dom.mjs'
import { when } from './analysis.mjs'
import { xOf, windowCalls, nearestByX, nearestByTs, turnsReviewed } from './lanes.mjs'
import { usageOf, priceMatch, costOf, isFailed as failOf } from '../core/metrics.mjs'
import { laneKind, laneWord, SUBAGENT_ROW, BG_ROW, TC_ROW, laneTimes, callsWord, TC_SAMPLED_TIP, TC_NO_SIZE, FLAGGED_WORD, ONLY_MAIN } from '../labels/replay.mjs'
import { L } from '../core/labels.mjs'

// only the lanes that read the conversation get the review bracket (2.1 ⑤)
export const reviewing = (lane) => lane.kind === 'monitor' || lane.kind === 'token-count'

// ── ticks ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// a call a monitor verdict flagged: the verdict lives in its held lane's `events` (type monitor, 3.5 §会话读); a lane that is
// not held says nothing per call (its header's `flagged` marks the row name)
const flaggedOf = (s, lane, c) => { const h = s.desk && s.desk.held.get(lane.id), e = h && (h.events.get(c.rid) || []).find((x) => x.type === 'monitor'); return !!(e && e.flagged === true) }

// ticks outside the brush window are culled, not piled at the edges; data-i stays the index inside the lane.
// A failed call draws ×; a monitor verdict flagged true carries the mark.
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
      return `<span class="pbar" data-lane="token-count" data-i="${i}" style="left:${x(c)}%;height:${h}px" title="${esc(tip(c, i))}"></span>`
    }).join('')
  }
  return win.map(({ c, i }) =>
    `<span class="tick ${flaggedOf(s, lane, c) ? 'flag' : ''} ${failOf(c) ? 'errtick' : ''}" data-lane="${esc(lane.id)}" data-i="${i}" style="left:${x(c)}%" title="${esc(tip(c, i))}"></span>`).join('')
}

// the marks a collapsed group still draws: the failed × of every member lane, and its flagged monitor calls —
// each one clickable, opening that call in the drawer
function collapsedMarks(lanes, s) {
  const x = (c) => (xOf(s.anchorTs, s.view, c.ts) * 100).toFixed(2)
  return lanes.flatMap((l) => windowCalls(l, s.anchorTs, s.view).filter((o) => failOf(o.c) || flaggedOf(s, l, o.c)).map((o) => ({ ...o, l })))
    .map(({ c, i, l }) => {
      const head = `${laneWord(l.kind)} · call ${i + 1} · ${when(c.ts)}`
      return failOf(c)
        ? `<span class="tick errtick" data-lane="${esc(l.id)}" data-i="${i}" style="left:${x(c)}%" title="${esc(head + ' · call failed')}"></span>`
        : `<span class="tick flag" data-lane="${esc(l.id)}" data-i="${i}" style="left:${x(c)}%" title="${esc(head + ' · ' + FLAGGED_WORD)}"></span>`
    }).join('')
}

// one lane's own row. Background kinds are named by their word + the full call count; a subagent is named by its task
// (S4) or the server's label as-is, with the call count and the ≈ cost of the whole lane.
function railHtml(l, s, { sub = false } = {}) {
  const col = s.collapsedRails.has(l.id)
  const hint = laneKind(l.kind).hint
  let name
  if (sub) {
    const model = (c) => (c.rec && c.rec.request && c.rec.request.model) || ''
    let sum = 0, from = false
    for (const c of l.calls) {
      if (failOf(c)) continue // a failed call is not billed
      const u = usageOf(c), m = u && s.pricing ? priceMatch(s.pricing, model(c)) : null
      const v = m ? costOf(m.row, u) : null
      if (v == null) { if (u) from = true; continue }
      sum += v; if (m.exact === false) from = true
    }
    const task = String(l.task != null && l.task !== '' ? l.task : l.label || '')
    name = `${task} · ${callsWord(l.count ?? l.calls.length)}` + (sum > 0 || from ? ` · ≈ ${from ? 'from ' : ''}${usd(sum)}` : '')
  } else name = laneTimes(laneWord(l.kind), l.count ?? l.calls.length)
  // the row name ellipsizes in the gutter; its hover carries the whole of it, the lane's own label and the kind's hint
  const lab = String(l.label || '')
  const tip = [name, lab && !name.includes(lab) ? lab : '', l.flagged === true ? FLAGGED_WORD : '', hint].filter(Boolean).join(' · ')
  return `<div class="rail k-${esc(l.kind)} tkrow">` +
    `<div class="tgut railname ${col ? 'col' : ''}" data-toggle="${esc(l.id)}" title="${esc(tip)}"><span class="tw">${col ? '▸' : '▾'}</span> <span class="tn">${esc(name)}</span></div>` +
    (col ? '<div class="tlane"></div>' : `<div class="tlane railbody" data-lane="${esc(l.id)}">${renderTicks(l, s)}</div>`) + `</div>`
}

// the token 计数 row: mini bars stand for the measured context size; 「采样显示」 only when fewer were drawn than exist
function tcRailHtml(l, s) {
  const col = s.collapsedRails.has(l.id)
  const noSize = Math.max(0, (l.count || l.calls.length) - l.calls.length)
  const hint = laneKind('token-count').hint + (noSize ? ` · ${TC_NO_SIZE(noSize)}` : '')
  const body = col ? '' : `<div class="tlane railbody" data-lane="token-count">${renderTicks(l, s)}${l.drawn != null && l.drawn < l.calls.length ? `<span class="tcsample" title="${esc(TC_SAMPLED_TIP(l.drawn, l.count || l.calls.length))}">${esc(L.SAMPLED)}</span>` : ''}</div>`
  return `<div class="rail k-token-count tkrow"><div class="tgut railname ${col ? 'col' : ''}" data-toggle="token-count" title="${esc(hint)}"><span class="tw">${col ? '▸' : '▾'}</span> <span class="tn">${esc(TC_ROW(l.count || l.calls.length))}</span></div>${col ? '<div class="tlane"></div>' : body}</div>`
}

// < 900 px the subagent / 后台调用 / 全程 rows fold into one 「▸」 row (1.2 §窄屏); the fold state is a viewport fact,
// not session data, so it is never reset with a session switch
const narrowScreen = () => typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches
const foldRowHtml = (folded) => `<div class="railunfold tkrow" data-railunfold="1" role="button" tabindex="0" aria-label="Overlay rows"><div class="tgut railname"><span class="tw">${folded ? '▸' : '▾'}</span> <span class="tn">Overlay rows</span></div><div class="tlane"></div></div>`

export function renderRails(el, s) {
  const narrow = narrowScreen()
  if (s.railsFolded) { el.innerHTML = foldRowHtml(true); return }
  const rl = s.lanes.filter((l) => l !== s.anchor)
  const subs = rl.filter((l) => laneKind(l.kind).row === 'sub')
  const bgs = rl.filter((l) => laneKind(l.kind).row === 'bg')
  const tcs = rl.filter((l) => laneKind(l.kind).row === 'tc')
  subs.forEach((l) => { if (!s.subSeeded.has(l.id)) { s.subSeeded.add(l.id); s.collapsedRails.add(l.id) } }) // a fan-out never buries the main track
  let html = ''
  if (subs.length > 1) {
    const open = s.subgroupOpen
    html += `<div class="rail k-subagent tkrow">` +
      `<div class="tgut railname group ${open ? '' : 'col'}" data-grouptoggle="sub" title="${esc(laneKind('subagent').hint)}"><span class="tw">${open ? '▾' : '▸'}</span> <span class="tn">${esc(SUBAGENT_ROW(subs.length))}</span></div>` +
      `<div class="tlane">${open ? '' : `<div class="railbody groupbody">${collapsedMarks(subs, s)}</div>`}</div></div>` +
      (open ? `<div class="subkids">${subs.map((l) => railHtml(l, s, { sub: true })).join('')}</div>` : '')
  } else if (subs.length === 1) html += railHtml(subs[0], s, { sub: true })
  if (bgs.length) {
    const open = s.bgOpen
    html += `<div class="rail tkrow">` +
      `<div class="tgut railname group ${open ? '' : 'col'}" data-grouptoggle="bg" title="${esc(laneKind('aux').hint)}"><span class="tw">${open ? '▾' : '▸'}</span> <span class="tn">${esc(BG_ROW(bgs.reduce((n, l) => n + (l.count ?? l.calls.length), 0)))}</span></div>` +
      `<div class="tlane">${open ? '' : `<div class="railbody groupbody">${collapsedMarks(bgs, s)}</div>`}</div></div>` +
      (open ? `<div class="bgkids">${bgs.map((l) => railHtml(l, s)).join('')}</div>` : '')
  }
  for (const l of tcs) html += tcRailHtml(l, s)
  if (narrow) html = foldRowHtml(false) + html
  el.innerHTML = html || `<div class="railsonly">${esc(ONLY_MAIN)}</div>`
  if (s.selTick) { const t = el.querySelector(`[data-lane="${attrSel(s.selTick.laneId)}"][data-i="${s.selTick.i}"]`); if (t) t.classList.add('sel') }
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
  s.selTick = { laneId: lane.id, i }
  for (const e of s.root.querySelectorAll('#rails .tick.sel, #rails .pbar.sel')) e.classList.remove('sel')
  const el = s.root.querySelector(`#rails [data-lane="${attrSel(lane.id)}"][data-i="${i}"]`); if (el) el.classList.add('sel')
  if (reviewing(lane)) highlightRange(s, lane, i); else clearRange(s)
  const c = lane.calls[i]
  if (c && s.anchor.calls.length) { s.follow = false; s.setPlayhead(nearestByTs(s.anchor, c.ts, s.playhead), false) } // the conversation jumps to the same moment
  s.openDetail(lane, i) // its lane not held yet: the drawer draws the row first and fills in when the lane lands (2.3 §读与画)
}

export function wireRails(el, s) {
  const laneOf = (id) => s.lanes.find((l) => l.id === id)
  const fracOf = (body, e) => { const r = body.getBoundingClientRect(); return (e.clientX - r.left) / Math.max(1, r.width) }
  const onClick = (e) => {
    const uf = e.target.closest('[data-railunfold]')
    if (uf) {
      s.railsFolded = !s.railsFolded
      s.paintFrame() // the desk's view opens or folds the rows around the rails
      renderRails(el, s); return
    }
    const gt = e.target.closest('[data-grouptoggle]')
    if (gt) { if (gt.dataset.grouptoggle === 'sub') s.subgroupOpen = !s.subgroupOpen; else s.bgOpen = !s.bgOpen; renderRails(el, s); return }
    const tg = e.target.closest('[data-toggle]')
    if (tg) { const id = tg.dataset.toggle; if (s.collapsedRails.has(id)) s.collapsedRails.delete(id); else s.collapsedRails.add(id); renderRails(el, s); return }
    const t = e.target.closest('.tick, .pbar')
    if (t) { const lane = laneOf(t.dataset.lane); if (lane) selectTick(s, lane, +t.dataset.i); return }
    // anywhere on an open rail picks the nearest call IN the window, so every call is reachable, not just the drawn ticks
    const body = e.target.closest('.railbody[data-lane]')
    if (body) { const lane = laneOf(body.dataset.lane); if (lane && lane.calls.length) selectTick(s, lane, nearestByX(lane, s.anchorTs, s.view, fracOf(body, e))) }
  }
  const onMove = (e) => {
    const body = e.target.closest && e.target.closest('.railbody[data-lane]')
    if (!body) return
    const lane = laneOf(body.dataset.lane)
    if (!lane || !lane.calls.length || !reviewing(lane)) return
    const t = e.target.closest('.tick, .pbar')
    highlightRange(s, lane, t ? +t.dataset.i : nearestByX(lane, s.anchorTs, s.view, fracOf(body, e)))
  }
  const onLeave = () => { if (!s.selTick) clearRange(s) }
  el.addEventListener('click', onClick)
  el.addEventListener('mousemove', onMove)
  el.addEventListener('mouseleave', onLeave)
  return () => { el.removeEventListener('click', onClick); el.removeEventListener('mousemove', onMove); el.removeEventListener('mouseleave', onLeave) }
}
