// replay/timeline.mjs — the scope's pure parts the React desk (web/src/screens/replay/) and the controller (replay.mjs) read:
// the bars a lane width holds and the brush window (fitWindow / capWindow), the chapters between compactions (1.3 §章), the
// problem steps and the pager's landing (1.3 §问题道), the rough page's window, and the composition colours' keys.
import { isBreak, isFailed } from '../core/metrics.mjs'
import { refRowOf } from './analysis.mjs'
import { anchorJump } from './jump.mjs'
// the composition colours' keys, in the bars' stacking order: [class suffix, word]
export const BAR_KEYS = [['tools', 'tools'], ['system', 'system'], ['user', 'messages'], ['assistant', 'reply'], ['thinking', 'thinking'], ['tool_use', 'tool call'], ['tool_result', 'tool result']]

export const OVW_BARCAP = 60

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

// ── chapters (1.3 §章): the axis between compactions, from the head's `chapters` ─────────────────────────────────────────
// a chapter table is the head's ([{s0, s1, ts0, inferred}], global step numbers, s1 exclusive); the last chapter also holds the steps
// that came after the head was written. chapterAt → the index of the chapter holding step g (0 before the first).
export function chapterAt(chs, g) {
  let lo = 0, hi = chs.length - 1
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (chs[m].s0 <= g) lo = m; else hi = m - 1 }
  return lo
}
// where ‹ (dir < 0) / › (dir > 0) land from step g: the previous chapter's last step / the next chapter's first (that compaction); null at the ends
export function chapterJump(chs, g, dir) {
  const k = chapterAt(chs, g), c = chs[k + (dir < 0 ? -1 : 1)]
  return c ? (dir < 0 ? c.s1 - 1 : c.s0) : null
}
// the window for playhead `at` inside the chapter span [c0, c1) (local indexes): a window from elsewhere becomes the chapter's; one in it
// pans to hold the playhead, keeping its width; then at most K bars around the playhead
export function placeView({ lo, hi }, at, c0, c1, K) {
  if (lo < c0 || hi > c1 || hi <= lo) { lo = c0; hi = c1 } else if (at < lo || at >= hi) { const w = hi - lo; lo = Math.min(Math.max(c0, at - (w >> 1)), c1 - w); hi = lo + w }
  return fitWindow({ lo, hi, K, playhead: at })
}
// the first local index whose global step is ≥ g (the anchor lane may hold gaps while its packs are read)
function firstAt(no, N, g, lo = 0) { let hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (no(m) < g) lo = m + 1; else hi = m } return lo }
// every chapter start's position in one walk: from the last start, the steps between them are guessed contiguous and the guess checked by
// two reads of `no`; where it fails (a gap), a binary search above the last start
function startsOf(no, N, chs) {
  const at = new Map()
  let p = 0, g0 = null
  for (const { s0: g } of chs) {
    let i = g0 == null ? -1 : p + (g - g0)
    if (!(i >= p && i <= N && (i === N || no(i) >= g) && (i === 0 || no(i - 1) < g))) i = firstAt(no, N, g, g0 != null && g >= g0 ? p : 0)
    at.set(g, i); p = i; g0 = g
  }
  return at
}
// the desk's chapters around its playhead: the head's table when the anchor is the head's axis lane, else one chapter; `c0` / `c1` are
// the playhead chapter's span in the anchor's local indexes, `pos` maps a global step onto them
// the positions found, per anchor lane object and chapter table: a lane object is rebuilt when its calls change (lanes.mjs), so each
// chapter's position is searched once per answer that changed the lane, not per paint
const POS = new WeakMap()
// the anchor is the head's axis lane with a chapter table: only then does the desk (and the Overview's chapter heads) cut chapters
export const onChapterAxis = (s) => { const head = s.desk && s.desk.head; return !!(head && head.chapters && head.chapters.length && s.anchor && s.anchor.id === head.axis) }
export function chapterHere(s) {
  const a = s.anchor, N = a ? a.calls.length : 0, head = s.desk && s.desk.head, no = a && a.no ? (i) => a.no(i) : (i) => i
  const end = N ? no(N - 1) + 1 : 0
  const table = onChapterAxis(s)
  const chs = table ? head.chapters : [{ s0: 0, s1: end, ts0: null, inferred: false }]
  let at = null
  if (table && N) { const m = POS.get(a); if (m && m.chs === chs) at = m.at; else POS.set(a, { chs, at: at = startsOf(no, N, chs) }) }
  const pos = at ? (x) => { let v = at.get(x); if (v === undefined) at.set(x, v = firstAt(no, N, x)); return v } : (x) => firstAt(no, N, x)
  const g = N ? no(s.playhead) : 0, k = chapterAt(chs, g)
  if (!N) return { chs, g, end, pos, c0: 0, c1: 0 }
  const ph = Math.max(0, Math.min(N - 1, s.playhead)) // the span always holds the playhead, even where the lane's numbers are not in order
  const c0 = Math.min(ph, pos(chs[k].s0)), c1 = Math.max(ph + 1, k === chs.length - 1 ? N : pos(chs[k].s1))
  return { chs, g, end, pos, c0, c1 }
}

// the problem steps of the whole main lane (window-independent): every cache break and every failed call, in order.
// A compaction step is NOT one (1.3): it draws the neutral 「压缩」 word — a rewrite is not a problem, and it never counts in n. The step
// a marked compaction lands on is the same rewrite (3.4): no compaction of its own, so it draws nothing at all.
export const landing = (c) => !c.compaction && !!c.cacheBreak && c.cacheBreak.cause === 'compaction'
export function problemSteps(lane) {
  const out = []
  ;((lane && lane.calls) || []).forEach((c, i) => { if (isFailed(c) || (isBreak(c, refRowOf(lane, i)) && !c.compaction && !landing(c))) out.push(i) })
  return out
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
// one step of the pager, from the scope's buttons and the Tracks menu's
export function problemGo(s, dir) {
  if (!s.anchor) return
  const j = problemJump(s.anchor.calls, s.problems || [], s.playhead, dir)
  if (j) s.jumpTo(j.t, j.jump) // lands on the 变化线 when that problem step has one; a failed step just moves the playhead
}

// ── the rough page (2.3 §大致页面, 1.3 §章): the session head alone ─────────────────────────────────────────────────────
// roughWindow(head, at, K) → {lo, hi}: the window of at most K bars around step `at` inside the chapter that holds it (the whole axis
// when the head names no chapter)
export function roughWindow(head, at, K) {
  const chs = head.chapters && head.chapters.length ? head.chapters : [{ s0: 0, s1: head.steps }], k = chapterAt(chs, at)
  return fitWindow({ lo: chs[k].s0, hi: k === chs.length - 1 ? Math.max(chs[k].s1, at + 1) : chs[k].s1, K, playhead: at })
}
