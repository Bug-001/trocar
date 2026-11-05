// replay/outline.mjs — the left column's outline of THIS step's context (2.5): 工具定义 / 系统提示 / 提问, three jumpable
// groups, plus 「跳到变化处」 when the window draws the 变化线. Scope is the playhead's own call — it is rebuilt on every
// scrub, and a step with no call clears it. The resource lifecycle lives on the right page (resources.mjs) and MUST NOT
// appear here (B-split). `el` is #ctxnav; `s` is the replay desk's state object.
import { esc, kf } from '../core/fmt.mjs'
import { KIDS, serialize, keyed, patchInto } from '../core/units.mjs'
import { humanTurns, hasChangeLine, foldWs, QUIET_CAUSES } from './analysis.mjs'
import { stepOf, laneEvents } from './model.mjs'
import { anchorJump, blockJump } from './jump.mjs'
import { stepRef } from './lanes.mjs'
import * as W from '../labels/replay.mjs'

// a collapsible group of the outline / resource lists (2.4 shares this shell), as units: the head ('h:' + key) and, when open,
// the kids box (key) holding `kids` (units) — a head that changes is redrawn alone, its kids stay. Words only, no pictographs.
// role="button" + tabindex: the head is keyboard-focusable and Enter/Space toggle it (wireOutline's keydown).
// `count`: '' = the group has no count; null = a count not known yet — an empty aria-busy box, no digit, no word (2.4:67)
export function navGroup(s, key, label, count, kids, { hint = '' } = {}) {
  const open = s.navOpen.has(key)
  const ct = count === '' ? '' : count == null ? '<span class="navct" aria-busy="true"></span>' : `<span class="navct">${count}</span>`
  const head = { key: 'h:' + key, html: `<div class="navrow head ${open ? 'open' : ''}" role="button" tabindex="0" data-navtoggle="${esc(key)}"${hint ? ` title="${esc(hint)}"` : ''}><span class="navlbl">${esc(label)}</span>${ct}</div>` }
  return open ? [head, { key, html: `<div class="navkids" data-kids>${KIDS}</div>`, kids }] : [head]
}

// What the outline can honestly say about a step. A call that did not parse (`unparsed`) or was never captured (`rec` null) has
// NO block list — its section counts are unknown, not 0 (invariant 4), and a line says why. A call whose lane is not held yet
// (`stepOf(desk, rid).flat` is null) says nothing about its blocks: the tool count is the skeleton row's `tools`, the other
// groups are sized empty rows until the lane lands (2.5 #9).
const bodyState = (call) => call.unparsed ? { why: W.UNPARSED_LINE } : !call.rec ? { why: W.NO_REQUEST } : null
// the playhead step's blocks: null while its lane is not held
const flatOf = (s, call) => (s.desk && call ? stepOf(s.desk, call.rid).flat : null)

// 「第 N 步起」: pair the query rows with the held main lane's user events (the `lane` answer's, which carry `preview`; 2.5:16)
// from the LAST one backwards — a pair matches only when the shorter folded text is a prefix of the other; the first pair
// that fails kills its number and every earlier row's (a shifted pairing would misname them). An event whose page is not
// held is not there to pair, so its row has no number. Only on the main lane, only through stepRef(); never a guess.
export function queryStepLabels(s, turns) {
  const anchor = s.anchor
  if (!anchor || anchor.kind !== 'main' || !turns.length) return []
  const at = (rid) => { const i = anchor.ridLocal && anchor.ridLocal.get(rid); return i == null ? Infinity : i }
  const evs = (s.desk ? laneEvents(s.desk, anchor.id) : []).filter((e) => e && e.type === 'user' && e.rid != null && at(e.rid) <= s.playhead)
  if (!evs.length) return []
  const out = new Array(turns.length).fill(null)
  for (let k = 0; k < Math.min(evs.length, turns.length); k++) {
    const ev = evs[evs.length - 1 - k], turn = turns[turns.length - 1 - k]
    const a = foldWs(ev.preview || ''), b = foldWs(turn.text || '')
    if (!a || !b) break
    const lo = a.length <= b.length ? a : b, hi = a.length <= b.length ? b : a
    if (!hi.startsWith(lo)) break
    const ref = stepRef(s.lanes, ev.rid)
    if (!ref || !ref.step) break
    out[turns.length - 1 - k] = { n: ref.n, rid: ev.rid }
  }
  return out
}

// 「跳到变化处」 on a step whose lane is not held: still judged by the SAME cause list as the window (never a byte-diff guess
// of our own — 2.5), because the click queues the jump and waits for the lane (jump.mjs). A body that can never arrive
// (unparsed / no request) draws a control that cannot work, so the row stays off for those.
const unheldChange = (call) => {
  const b = call && call.cacheBreak
  return !!(call && call.rec && !call.unparsed && b && !b.firstCall && b.cause && !QUIET_CAUSES.has(b.cause))
}

// the one entry table both the column and any narrow-screen dropdown draw from (2.5 #10): same names, same order, same jump.
// `kids` is null for a group the step cannot list yet (its lane is not held); `tools` then carries the row's count.
export function outlineEntries(s) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call) return { head: '', groups: [], changeLine: false, off: null, held: false }
  const off = bodyState(call)
  const flat = off ? [] : flatOf(s, call)
  const held = !!flat
  const rowsOf = (sec) => flat.map((b, i) => ({ b, i })).filter((x) => x.b.sec === sec)
  const turns = held ? humanTurns(flat) : []
  const since = queryStepLabels(s, turns)
  const groups = [
    // no counts on the group heads (2.5 §只做导航): the sizes are the middle column's section rows; an off step says why
    { key: 'tools', label: W.GRP_TOOLS, tools: !held && !off && typeof call.tools === 'number' ? call.tools : null,
      kids: off ? '' : held ? rowsOf('tools').map((x) => ({ label: x.b.name || '', mcp: !!x.b.mcp, jump: x.i })) : null },
    { key: 'sys', label: W.GRP_SYS,
      kids: off ? '' : held ? rowsOf('system').map((x) => ({ label: x.b.label || '', ccMark: !!x.b.cc, volatile: !!x.b.volatile, chars: x.b.chars, jump: x.i })) : null },
    { key: 'msg', label: W.GRP_ASK,
      kids: off ? '' : held ? turns.map((t, k) => ({ label: t.label, guess: t.basis === 'guess', since: since[k], jump: t.fi })) : null },
  ]
  return { head: W.OUTLINE_HEAD, groups, changeLine: held ? hasChangeLine(call, flat) : unheldChange(call), off, held }
}

// 2.5 前置定义: every sub-entry is a jumpable, keyboard-reachable row — role="button" + tabindex (the msg row holds the
// 「第 N 步起」 control inside it, so it cannot be a real nested <button>; Enter/Space ride wireOutline's keydown).
const kidHtml = {
  tools: (k) => `<div class="navsub" role="button" tabindex="0" data-jumpfi="${k.jump}"><span class="nsl">${esc(k.label)}</span>${k.mcp ? `<span class="nsx">${esc(W.MCP_WORD)}</span>` : ''}</div>`,
  sys: (k) => `<div class="navsub" role="button" tabindex="0" data-jumpfi="${k.jump}"><span class="nsl">${esc(k.label)}</span>${k.ccMark ? `<span class="bpbadge" title="${esc(W.CACHE_MARK_TIP)}">${esc(W.CACHE_MARK)}</span>` : ''}${k.volatile ? `<span class="volbadge" title="${esc(W.VOLATILE_MARK_TIP)}">${esc(W.VOLATILE_MARK)}</span>` : ''}<span class="nsx">${k.chars != null ? kf(k.chars) + ' ' + W.CHARS_WORD : ''}</span></div>`,
  msg: (k) => `<div class="navsub" role="button" tabindex="0" data-jumpfi="${k.jump}"><span class="nsl">${esc(k.label)}</span>${k.guess ? `<span class="nsx" title="${esc(W.QUERY_GUESS_TIP)}">${esc(W.GUESS)}</span>` : ''}${k.since ? `<span class="nsx navsince" data-jumprid="${esc(k.since.rid)}" role="button" tabindex="0" title="Move the playhead to step ${k.since.n}">${esc(W.askSince(k.since.n))}</span>` : ''}</div>`,
}

// the outline as keyed units (2.3 三个面板按键打补丁): a group's rows are keyed by the block they jump to
export function outlineUnits(s) {
  const e = outlineEntries(s)
  if (!e.head) return []
  const out = [{ key: 'head', html: `<div class="navz">${esc(e.head)}</div>` }]
  if (e.off) out.push({ key: 'why', html: `<div class="navwhy">${esc(e.off.why)}</div>` })
  for (const g of e.groups) {
    // a group of an unheld step: the tools group names the row's count, the others hold a sized empty row (no words, no 0)
    const kids = g.kids === null ? [{ key: 'unheld', html: g.tools > 0 ? `<div class="navsub" data-tools="${g.tools}"><span class="nsl mono">${g.tools} tool definitions</span></div>` : g.tools === 0 ? `<div class="navsub empty">${esc(W.NO_TOOLS)}</div>` : BUSY_ROW }]
      : !g.kids ? [] : g.kids.length ? keyed(g.kids.map((k) => ({ key: String(k.jump), html: kidHtml[g.key](k) })))
        : [{ key: 'none', html: `<div class="navsub empty">${esc(g.key === 'tools' ? W.NO_TOOLS : g.key === 'sys' ? W.NO_SYS : W.NO_ASK)}</div>` }]
    out.push(...navGroup(s, g.key, g.label, '', kids))
  }
  if (e.changeLine) out.push({ key: 'change', html: `<div class="navrow" data-jump="cachebrk" role="button" tabindex="0"><span class="navlbl">${esc(W.JUMP_TO_CHANGE)}</span></div>` })
  return out
}
export const outlineHtml = (s) => serialize(outlineUnits(s))
// a sized empty row while the step's lane is on its way: no words, no count, no control (2.5 #9)
const BUSY_ROW = '<div class="navsub busy" aria-busy="true"></div>'
export function renderOutline(el, s) { patchInto(el, outlineUnits(s)) }

// ── jumps ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// through the desk's view (s.reveal, replay.mjs): the element drawn, opened and brought into view, then flashed
export const jumpToAnchor = (s, id) => { s.reveal({ anchor: id, flash: 1600 }) }
export const jumpToBlockIndex = (s, fi) => { s.reveal({ fi, open: true, flash: 2000 }) }
// open and highlight the block that carries a resource, in the step the playhead is on. Found in the step's list, not the DOM:
// its row may sit in a folded turn or a group not drawn yet, which the jump draws first.
export function jumpToResourceBlock(s, resKey) {
  const fi = (s.curFlat || []).findIndex((b) => b.resKey === resKey)
  if (fi >= 0) jumpToBlockIndex(s, fi)
}
// move to a step and land on a block of it. When that step's lane is not held the landing waits for the lane (jump.mjs).
export function jumpToStepAndBlock(s, step, resKey) { s.jumpTo(step, resKey ? blockJump(resKey) : null) }

export function wireOutline(el, s) {
  // the one dispatch both a click and a keyboard activation route through (2.5 前置定义: the rows are role="button"
  // divs — the msg row contains the 「第 N 步起」 control, so a real nested <button> is not legal HTML)
  const dispatch = (e) => {
    const tg = e.target.closest('[data-navtoggle]')
    if (tg) { const k = tg.dataset.navtoggle; if (s.navOpen.has(k)) s.navOpen.delete(k); else s.navOpen.add(k); s.renderNav(); return }
    const sg = e.target.closest('[data-jumprid]')
    if (sg) { const i = s.anchor && s.anchor.ridLocal.get(sg.dataset.jumprid); if (i != null) s.jumpTo(i, null); return }
    const j = e.target.closest('[data-jump]')
    if (j) { s.queueJump(anchorJump(j.dataset.jump)); return }
    const f = e.target.closest('[data-jumpfi]')
    if (f) jumpToBlockIndex(s, +f.dataset.jumpfi)
  }
  const onKey = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    if (e.preventDefault) e.preventDefault() // Space would scroll the page
    dispatch(e)
  }
  el.addEventListener('click', dispatch)
  el.addEventListener('keydown', onKey)
  return () => { el.removeEventListener('click', dispatch); el.removeEventListener('keydown', onKey) }
}
