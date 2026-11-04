// web/src/screens/replay/strip.mjs — the strip's one coordinate source (1.3 acceptance 21): chapters and a pixel width in, the
// parts' spans and the step <-> x maps out, framework-free. Blocks when every chapter can show one; otherwise ticks, x linear in steps.
// The bars' one window lives here too (1.3 acceptance 23): s.span in global steps, in any part, rows held or not; s.view is its image in
// the anchor lane, which only the rails read.
import { chapterAt, placeView } from '../../../legacy/replay/timeline.mjs'
import { ridAt } from '../../../legacy/replay/model.mjs'

export const PART_MIN = 3, PART_GAP = 1, PART_HIT = 8

// how many leading indices below n pass `before`, which holds for a prefix and then never again
function prefix(n, before) {
  let lo = 0, hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (before(mid)) lo = mid + 1
    else hi = mid
  }
  return lo
}
const centre = (p) => (p.x0 + p.x1) / 2
const narrow = (p) => p.x1 - p.x0 < PART_HIT

// where the hit ranges of two neighbours meet
function hitEdge(a, b) {
  if (narrow(a) && narrow(b)) return (centre(a) + centre(b)) / 2
  if (narrow(a)) return centre(a) + PART_HIT / 2
  if (narrow(b)) return centre(b) - PART_HIT / 2
  return (a.x1 + b.x0) / 2
}

export function stripLayout(chapters, W) {
  const n = chapters.length, first = chapters[0].s0, end = chapters[n - 1].s1
  const ticks = n * PART_MIN + (n - 1) * PART_GAP > W
  const min = ticks ? 0 : PART_MIN, gap = ticks ? 0 : PART_GAP
  const steps = (c) => c.s1 - c.s0
  // Fixing a part at the minimum lowers the px per step for the rest, so the fixed parts are always the shortest ones.
  const fixed = new Set()
  let room = W - (n - 1) * gap, left = end - first
  for (const c of [...chapters].sort((a, b) => steps(a) - steps(b))) {
    if (steps(c) * room / left >= min) break
    fixed.add(c)
    room -= min
    left -= steps(c)
  }
  let x = 0
  const parts = chapters.map((c) => {
    const x0 = x, x1 = x0 + (fixed.has(c) ? min : steps(c) * room / left)
    x = x1 + gap
    return { s0: c.s0, s1: c.s1, x0, x1 }
  })
  parts[n - 1].x1 = W
  const edges = parts.slice(1).map((p, i) => hitEdge(parts[i], p))

  function xOf(g) {
    if (g <= first) return 0
    if (g >= end) return W
    const p = parts[prefix(n, (i) => parts[i].s1 <= g)]
    return p.x0 + (g - p.s0) / (p.s1 - p.s0) * (p.x1 - p.x0)
  }
  function stepOf(x) {
    if (x <= 0) return first
    if (x >= W) return end
    const p = parts[prefix(n, (i) => parts[i].x1 <= x)]
    return x <= p.x0 ? p.s0 : p.s0 + (x - p.x0) / (p.x1 - p.x0) * (p.s1 - p.s0)
  }
  function hit(x) {
    const k = prefix(n - 1, (i) => edges[i] <= x), p = parts[k]
    return { k, g: Math.min(Math.max(Math.floor(stepOf(x)), p.s0), p.s1 - 1) }
  }
  return { ticks, W, parts, xOf, stepOf, hit }
}

// the steps there are: the head's count may lag the lane's, and the lane's rows may be fewer than either
export function stepCount(s) {
  const h = s.desk && s.desk.head, a = s.anchor
  return Math.max((h && h.steps) || 0, (a && a.count) || 0, a ? a.calls.length : 0)
}
// the parts in global steps: the head's chapters, the last one holding every step written since; one part when they are another lane's
export function partsOf(s) {
  const N = stepCount(s), a = s.anchor, h = s.desk && s.desk.head, chs = h && h.chapters
  if (!chs || !chs.length || (a && a.id !== h.axis)) return [{ s0: 0, s1: N, inferred: false }]
  const last = chs[chs.length - 1]
  return last.s1 >= N ? chs : [...chs.slice(0, -1), { ...last, s1: N }]
}
// the step the playhead means (0-based): a named step still on its way, the row under it, else the last one
export function stepAt(s) {
  const N = stepCount(s), a = s.anchor
  if (s.initialStep != null) return Math.max(0, Math.min(N, s.initialStep) - 1)
  if (a && s.playRid != null && a.calls[s.playhead]) return a.no ? a.no(s.playhead) : s.playhead
  return N - 1
}
// the window for step g: a window parked at the old end (`prevEnd`) reaches g's part's end first, so it grows with a live session;
// then timeline.mjs : placeView() over g's part
export function placeSpan(prev, g, parts, K, prevEnd) {
  const c = parts[chapterAt(parts, g)]
  const from = !prev ? { lo: 0, hi: 0 } : prev.hi === prevEnd ? { lo: prev.lo, hi: Math.max(prev.hi, c.s1) } : prev
  return placeView(from, g, c.s0, c.s1, K)
}
// the span in the anchor lane's local indexes; `none` while a step of it is not held or the rows are not contiguous there
export function anchorSpan(s, { lo, hi }) {
  const a = s.anchor, none = { lo: 0, hi: 0, none: true }
  if (!a || hi <= lo) return none
  const first = a.ridLocal.get(ridAt(s.desk, a.id, lo))
  if (first == null) return none
  for (let g = lo + 1; g < hi; g++) if (a.ridLocal.get(ridAt(s.desk, a.id, g)) !== first + g - lo) return none
  return { lo: first, hi: first + hi - lo }
}
