// replay/outline.mjs — the entry table of ONE step's context (2.5) the sidebar Overview reads (overview-model.mjs): 工具定义 /
// 系统提示 / 提问, plus 「跳到变化处」 when the window draws the 变化线; the jumps the desk runs; and navGroup, the group shell
// the resource list (resources.mjs) draws. `s` is the replay desk's state object.
import { esc } from '../core/fmt.mjs'
import { KIDS } from '../core/units.mjs'
import { humanTurns, hasChangeLine, QUIET_CAUSES } from './analysis.mjs'
import { stepOf, carriesRes } from './model.mjs'
import { blockJump } from './jump.mjs'
import * as W from '../labels/replay.mjs'

// a collapsible group of the outline / resource lists (2.4 shares this shell), as units: the head ('h:' + key) and, when open,
// the kids box (key) holding `kids` (units) — a head that changes is redrawn alone, its kids stay. Words only, no pictographs.
// role="button" + tabindex: the head is keyboard-focusable and Enter/Space toggle it.
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

// 「跳到变化处」 on a step whose lane is not held: still judged by the SAME cause list as the window (never a byte-diff guess
// of our own — 2.5), because the click queues the jump and waits for the lane (jump.mjs). A body that can never arrive
// (unparsed / no request) draws a control that cannot work, so the row stays off for those.
const unheldChange = (call) => {
  const b = call && call.cacheBreak
  return !!(call && call.rec && !call.unparsed && b && !b.firstCall && b.cause && !QUIET_CAUSES.has(b.cause))
}

// the one entry table the Overview's rows draw from (2.5): same names, same order, same jump.
// `kids` is null for a group the step cannot list yet (its lane is not held); `tools` then carries the row's count.
export function outlineEntries(s, at = s.playhead) {
  const call = s.anchor && s.anchor.calls[at]
  if (!call) return { head: '', groups: [], changeLine: false, off: null, held: false }
  const off = bodyState(call)
  const flat = off ? [] : flatOf(s, call)
  const held = !!flat
  const rowsOf = (sec) => flat.map((b, i) => ({ b, i })).filter((x) => x.b.sec === sec)
  const turns = held ? humanTurns(flat) : []
  const groups = [
    // no counts on the group heads (2.5 §只做导航): the sizes are the middle column's section rows; an off step says why
    { key: 'tools', label: W.GRP_TOOLS, tools: !held && !off && typeof call.tools === 'number' ? call.tools : null,
      kids: off ? '' : held ? rowsOf('tools').map((x) => ({ label: x.b.name || '', mcp: !!x.b.mcp, jump: x.i })) : null },
    { key: 'sys', label: W.GRP_SYS,
      kids: off ? '' : held ? rowsOf('system').map((x) => ({ label: x.b.label || '', ccMark: !!x.b.cc, volatile: !!x.b.volatile, chars: x.b.chars, jump: x.i })) : null },
    { key: 'msg', label: W.GRP_ASK,
      kids: off ? '' : held ? turns.map((t) => ({ label: t.label, guess: t.basis === 'guess', jump: t.fi })) : null },
  ]
  return { head: W.OUTLINE_HEAD, groups, changeLine: held ? hasChangeLine(call, flat) : unheldChange(call), off, held }
}

// ── jumps ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// through the desk's view (s.reveal, replay.mjs): the element drawn, opened and brought into view, then flashed
export const jumpToAnchor = (s, id) => { s.reveal({ anchor: id, flash: 1600 }) }
export const jumpToBlockIndex = (s, fi) => { s.reveal({ fi, open: true, flash: 2000 }) }
// open and highlight the block that carries a resource, in the step the playhead is on. Found in the step's list, not the DOM:
// its row may sit in a folded turn or a group not drawn yet, which the jump draws first. → whether the step carries that block.
export function jumpToResourceBlock(s, resKey) {
  const fi = (s.curFlat || []).findIndex((b) => carriesRes(b, resKey))
  if (fi >= 0) jumpToBlockIndex(s, fi)
  return fi >= 0
}
// open and highlight the step's last prompt block (2.5: a prompt row's jump)
export function jumpToLastPrompt(s) {
  const t = humanTurns(s.curFlat || []).at(-1)
  if (t) jumpToBlockIndex(s, t.fi)
}
// move to a step and land on a block of it. When that step's lane is not held the landing waits for the lane (jump.mjs).
export function jumpToStepAndBlock(s, step, resKey) { s.jumpTo(step, resKey ? blockJump(resKey) : null) }
