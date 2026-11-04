// web/src/screens/replay/strip.mjs — the strip's one coordinate source (1.3 acceptance 21): chapters and a pixel width in, the
// parts' spans and the step <-> x maps out, framework-free. Blocks when every chapter can show one; otherwise ticks, x linear in steps.
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
