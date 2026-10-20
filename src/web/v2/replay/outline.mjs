// replay/outline.mjs — the left column's outline of THIS step's context (2.5): 工具定义 / 系统提示 / 提问, three jumpable
// groups, plus 「跳到变化处」 when the window draws the 变化线. Scope is the playhead's own call — it is rebuilt on every
// scrub, and a step with no call clears it. The resource lifecycle lives on the right page (resources.mjs) and MUST NOT
// appear here (B-split). `el` is #ctxnav; `s` is the replay desk's state object.
import { esc, kf } from '../core/fmt.mjs'
import { attrSel } from '../core/dom.mjs'
import { humanTurns, hasChangeLine, foldWs, QUIET_CAUSES } from './analysis.mjs'
import { toggleCtxBlock, openTurnFor, openTurnOfNode } from './ctxwin.mjs'
import { anchorJump, blockJump } from './jump.mjs'
import { stepRef } from './lanes.mjs'
import * as W from '../labels/replay.mjs'

// a collapsible group of the outline / resource lists (2.4 shares this shell); words only — no pictographs.
// role="button" + tabindex: the head is keyboard-focusable and Enter/Space toggle it (wireOutline's keydown).
export function navGroupHtml(s, key, label, count, kidsHtml, { hint = '' } = {}) {
  const open = s.navOpen.has(key)
  return `<div class="navrow head ${open ? 'open' : ''}" role="button" tabindex="0" data-navtoggle="${esc(key)}"${hint ? ` title="${esc(hint)}"` : ''}><span class="navlbl">${esc(label)}</span>${count !== '' && count != null ? `<span class="navct">${count}</span>` : ''}</div>` +
    (open ? `<div class="navkids">${kidsHtml}</div>` : '')
}

// What the outline can honestly say about a step. A call whose body is not on the loaded page (`paged_out`), did not parse
// (`unparsed`) or was never captured (`rec` null) has NO block list here — its section counts are unknown, not 0 (invariant 4).
// A paged-out call still carries the cheap tool count as real metadata; for the other two the server has nothing either.
const bodyState = (call) => call.unparsed ? { why: W.UNPARSED_LINE, meta: false }
  : !call.rec ? { why: W.NO_REQUEST, meta: false }
  : call.paged_out ? { why: W.PAGED_TITLE, meta: true } : null

// 「第 N 步起」: pair the query rows with the main lane's user events from the LAST one backwards — a pair matches only
// when the shorter folded text is a prefix of the other; the first pair that fails kills its number and every earlier
// row's (a shifted pairing would misname them). Only on the main lane, only through stepRef(); never a guess.
export function queryStepLabels(s, turns) {
  const anchor = s.anchor
  if (!anchor || anchor.kind !== 'main' || !turns.length) return []
  const cur = anchor.calls[s.playhead]
  const evs = (anchor.events || []).filter((e) => e && e.type === 'user' && e.step != null && cur && e.step <= cur.gi)
  if (!evs.length) return []
  const out = new Array(turns.length).fill(null)
  for (let k = 0; k < Math.min(evs.length, turns.length); k++) {
    const ev = evs[evs.length - 1 - k], turn = turns[turns.length - 1 - k]
    const a = foldWs(ev.preview || ''), b = foldWs(turn.text || '')
    if (!a || !b) break
    const lo = a.length <= b.length ? a : b, hi = a.length <= b.length ? b : a
    if (!hi.startsWith(lo)) break
    const ref = stepRef(s.lanes, ev.step)
    if (!ref || !ref.step) break
    out[turns.length - 1 - k] = { n: ref.n, gi: ev.step }
  }
  return out
}

// 「跳到变化处」 on a step whose body is not on this page: still judged by the SAME cause list as the window (never a
// byte-diff guess of our own — 2.5), because the click queues the jump and waits for the page (jump.mjs). A body that can
// never arrive (unparsed / no request) draws a control that cannot work, so the row stays off for those.
const offPageChange = (call) => {
  const b = call && call.cacheBreak
  return !!(call && call.paged_out && call.rec && !call.unparsed && b && !b.firstCall && b.cause && !QUIET_CAUSES.has(b.cause))
}

// the one entry table both the column and any narrow-screen dropdown draw from (2.5 #10): same names, same order, same jump
export function outlineEntries(s) {
  const call = s.anchor && s.anchor.calls[s.playhead]
  if (!call) return { head: '', groups: [], changeLine: false, off: null }
  const off = bodyState(call)
  const flat = off ? [] : (s.curFlat.length ? s.curFlat : (call.flat || []))
  const rowsOf = (sec) => flat.map((b, i) => ({ b, i })).filter((x) => x.b.sec === sec)
  const turns = off ? [] : humanTurns(flat)
  const since = queryStepLabels(s, turns)
  const groups = [
    // no counts on the group heads (2.5 §只做导航): the sizes are the middle column's section rows; an off-page step says why
    { key: 'tools', label: W.GRP_TOOLS,
      kids: off ? '' : rowsOf('tools').map((x) => ({ label: x.b.name || '', mcp: !!x.b.mcp, jump: x.i })) },
    { key: 'sys', label: W.GRP_SYS,
      kids: off ? '' : rowsOf('system').map((x) => ({ label: x.b.label || '', ccMark: !!x.b.cc, volatile: !!x.b.volatile, chars: x.b.chars, jump: x.i })) },
    { key: 'msg', label: W.GRP_ASK,
      kids: off ? '' : turns.map((t, k) => ({ label: t.label, guess: t.basis === 'guess', since: since[k], jump: t.fi })) },
  ]
  return { head: W.OUTLINE_HEAD, groups, changeLine: hasChangeLine(call) || offPageChange(call), off }
}

// 2.5 前置定义: every sub-entry is a jumpable, keyboard-reachable row — role="button" + tabindex (the msg row holds the
// 「第 N 步起」 control inside it, so it cannot be a real nested <button>; Enter/Space ride wireOutline's keydown).
const kidHtml = {
  tools: (k) => `<div class="navsub" role="button" tabindex="0" data-jumpfi="${k.jump}"><span class="nsl">${esc(k.label)}</span>${k.mcp ? `<span class="nsx">${esc(W.MCP_WORD)}</span>` : ''}</div>`,
  sys: (k) => `<div class="navsub" role="button" tabindex="0" data-jumpfi="${k.jump}"><span class="nsl">${esc(k.label)}</span>${k.ccMark ? `<span class="bpbadge" title="${esc(W.CACHE_MARK_TIP)}">${esc(W.CACHE_MARK)}</span>` : ''}${k.volatile ? `<span class="volbadge" title="${esc(W.VOLATILE_MARK_TIP)}">${esc(W.VOLATILE_MARK)}</span>` : ''}<span class="nsx">${k.chars != null ? kf(k.chars) + ' ' + W.CHARS_WORD : ''}</span></div>`,
  msg: (k) => `<div class="navsub" role="button" tabindex="0" data-jumpfi="${k.jump}"><span class="nsl">${esc(k.label)}</span>${k.guess ? `<span class="nsx" title="${esc(W.QUERY_GUESS_TIP)}">${esc(W.GUESS)}</span>` : ''}${k.since ? `<span class="nsx navsince" data-jumpgi="${k.since.gi}" role="button" tabindex="0" title="Move the playhead to step ${k.since.n}">${esc(W.askSince(k.since.n))}</span>` : ''}</div>`,
}

export function outlineHtml(s) {
  const e = outlineEntries(s)
  if (!e.head) return ''
  let h = `<div class="navz">${esc(e.head)}</div>`
  if (e.off) h += `<div class="navwhy">${esc(e.off.why)}${e.off.meta && typeof (s.anchor.calls[s.playhead] || {}).tools === 'number' ? ` · <span class="mono">${s.anchor.calls[s.playhead].tools} tool definitions</span>` : ''}</div>`
  for (const g of e.groups) {
    const kids = !g.kids ? '' : g.kids.length ? g.kids.map(kidHtml[g.key]).join('') : `<div class="navsub empty">${esc(g.key === 'tools' ? W.NO_TOOLS : g.key === 'sys' ? W.NO_SYS : W.NO_ASK)}</div>`
    h += navGroupHtml(s, g.key, g.label, '', kids)
  }
  if (e.changeLine) h += `<div class="navrow" data-jump="cachebrk" role="button" tabindex="0"><span class="navlbl">${esc(W.JUMP_TO_CHANGE)}</span></div>`
  return h
}
export function renderOutline(el, s) { el.innerHTML = outlineHtml(s) }

// ── jumps ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// a jump scrolls instantly when the viewer asked the system for less motion (1.5)
const motion = () => (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth')
const flash = (el, ms) => { el.classList.add('hl'); setTimeout(() => el.classList.remove('hl'), ms) }
export function jumpToAnchor(s, id) {
  let el = s.root.querySelector('#' + id)
  if (!el) return
  const win = s.root.querySelector('#ctxwin')
  if (win && openTurnOfNode(win, s, el)) { el = s.root.querySelector('#' + id); if (!el) return } // a marker in a folded turn is hidden: unfold it first
  el.scrollIntoView({ block: 'start', behavior: motion() }); flash(el, 1600)
}
export function jumpToBlockIndex(s, fi) {
  const win = s.root.querySelector('#ctxwin')
  openTurnFor(win, s, fi) // a block in a collapsed turn: open the turn first (this repaints the window)
  const blk = win.querySelector(`.cblk[data-bi="${fi}"]`)
  if (!blk) return
  if (blk.classList.contains('collapsed')) toggleCtxBlock(s, blk)
  blk.scrollIntoView({ block: 'center', behavior: motion() }); flash(blk, 2000)
}
// open and highlight the block that carries a resource, in the step the playhead is on. Goes through the block's index so a block inside a
// folded turn gets its turn opened first (a hidden element cannot be scrolled to).
export function jumpToResourceBlock(s, resKey) {
  const blk = s.root.querySelector(`#ctxwin .cblk[data-rk="${attrSel(resKey)}"]`)
  if (blk) jumpToBlockIndex(s, +blk.dataset.bi)
}
// move to a step and land on a block of it. When that step's body is not on the loaded page the landing waits for the page (jump.mjs).
export function jumpToStepAndBlock(s, step, resKey) { s.jumpTo(step, resKey ? blockJump(resKey) : null) }

export function wireOutline(el, s) {
  // the one dispatch both a click and a keyboard activation route through (2.5 前置定义: the rows are role="button"
  // divs — the msg row contains the 「第 N 步起」 control, so a real nested <button> is not legal HTML)
  const dispatch = (e) => {
    const tg = e.target.closest('[data-navtoggle]')
    if (tg) { const k = tg.dataset.navtoggle; if (s.navOpen.has(k)) s.navOpen.delete(k); else s.navOpen.add(k); s.renderNav(); return }
    const sg = e.target.closest('[data-jumpgi]')
    if (sg) { const ref = stepRef(s.lanes, +sg.dataset.jumpgi); if (ref && ref.step) s.jumpTo(ref.n - 1, null); return }
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
