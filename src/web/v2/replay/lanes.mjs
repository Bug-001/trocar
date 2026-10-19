// replay/lanes.mjs — lane building and the shared time axis. Pure: the anchor lane's call times (`anchorTs`, epoch ms, one per
// anchor call) and the brush window (`view = {lo, hi}`, step indices) are arguments, never module state.

// A lane names its calls by `gi`; the call objects arrive once, in `steps`. Re-hydrate by gi (a Map, so a gap in the numbering
// cannot shift anything). `giLocal` (gi → index inside the lane) arrives as {} over JSON, so it is rebuilt here as a Map.
export function buildLanes(analyzed, probes) {
  const steps = (analyzed && analyzed.steps) || []
  const byGi = new Map(steps.map((c) => [c.gi, c]))
  const ls = ((analyzed && analyzed.lanes) || []).map((l) => {
    const calls = (l.calls || []).map((c) => (typeof c === 'number' ? byGi.get(c) : c)).filter(Boolean)
    return { ...l, calls, giLocal: new Map(calls.map((c, i) => [c.gi, i])) }
  })
  const series = (probes && probes.series) || []
  if (series.length) {
    // a count_tokens measurement is a ruler, not a conversation and not a lane of the server's: its own row key
    // 'token-count' (2.1's table) never collides with the server's `probe` lane (a warm-up request) — 1.3 #16.
    const count = (probes && probes.count) || series.length // the full truth: series only holds the ones with a size
    const calls = series.map((p, i) => ({ gi: i, ts: p.ts, ctx: p.tokens || 0, probe: true, usage: null }))
    ls.push({ id: 'token-count', kind: 'token-count', label: 'token count', calls, count, events: [], resources: null,
      giLocal: new Map(calls.map((c, i) => [c.gi, i])), peakCtx: calls.reduce((m, c) => Math.max(m, c.ctx), 1), flagged: 0 })
  }
  return ls
}

// ── numbering (1.2 §编号): the ONE conversion from a global gi to the words the board shows ─────────────────────────
// 「第 N 步」 names ONLY a call of the main lane (N = its index there + 1, M = the main lane's call count). Any other
// lane's call is 「<lane 词> · 第 k 次调用」, never a step number; the lane object rides along so the caller can open its
// drawer or word it. → { step:true, n, m } | { step:false, lane, k, m } | null (a gi in no lane: the words are the
// caller's business — nothing here invents a step for it).
export function stepRef(lanes, gi) {
  if (gi == null) return null
  const ls = lanes || []
  const main = ls.find((l) => l.kind === 'main')
  if (main) { const n = main.giLocal && main.giLocal.get(gi); if (n != null) return { step: true, n: n + 1, m: main.calls.length } }
  for (const l of ls) { const k = l.giLocal && l.giLocal.get(gi); if (k != null) return { step: false, lane: l, k: k + 1, m: l.calls.length } }
  return null
}

const toMs = (ts) => (typeof ts === 'number' ? ts : Date.parse(ts))

// fractional step position in [0, n): which anchor call a wall-clock time falls at, plus how far toward the next one.
// An anchor call itself sits at its own index i (so on the full window it lands at i/N, the last call included); a time after
// the last call sits at the right edge of the last column.
export function stepPos(anchorTs, ts) {
  const t = toMs(ts), n = anchorTs.length
  if (!n) return 0
  if (t <= anchorTs[0]) return 0
  if (t === anchorTs[n - 1]) return n - 1
  if (t > anchorTs[n - 1]) return n - 1 + 0.999
  let i = 0
  while (i < n - 1 && anchorTs[i + 1] < t) i++
  return i + (t - anchorTs[i]) / Math.max(1, anchorTs[i + 1] - anchorTs[i])
}
// project a time into the brush window [lo, hi) → [0, 1). The full window is (i+frac)/n; a narrowed window rescales every
// track (bars, ticks, probe bars, cache band) through this one function, so they stay in lockstep.
export function xOf(anchorTs, view, ts) {
  const n = anchorTs.length
  if (!n) return 0
  const lo = (view.lo | 0), hi = Math.max(lo + 1, view.hi || n)
  const x = (stepPos(anchorTs, ts) - lo) / (hi - lo)
  return x <= 0 ? 0 : x >= 1 ? 0.999 : x
}
// ticks outside the window are CULLED, not piled at the edges (that would desync the rails from the bars)
export function inWindow(anchorTs, view, ts) {
  const lo = view.lo | 0, hi = Math.max(lo + 1, view.hi || anchorTs.length), p = stepPos(anchorTs, ts)
  return p >= lo && p < hi
}
// index of the lane call nearest in time (over EVERY call, not just the drawn ticks); `fallback` is kept when ts is unparsable
export function nearestByTs(lane, ts, fallback = 0) {
  const n = lane.calls.length
  if (!n) return 0
  const t = toMs(ts)
  if (Number.isNaN(t)) return Math.max(0, Math.min(fallback, n - 1))
  let best = 0, bd = Infinity
  lane.calls.forEach((c, i) => { const d = Math.abs(toMs(c.ts) - t); if (d < bd) { bd = d; best = i } })
  return best
}
// the lane call nearest a click at fraction f of the rail, among the calls IN the window (out-of-window calls all clamp to an
// edge and would hijack edge clicks); the whole lane when none is in the window. Always a real index, drawn tick or not.
export function nearestByX(lane, anchorTs, view, f) {
  let b = -1, bd = Infinity
  lane.calls.forEach((c, i) => {
    if (!inWindow(anchorTs, view, c.ts)) return
    const d = Math.abs(xOf(anchorTs, view, c.ts) - f)
    if (d < bd) { bd = d; b = i }
  })
  if (b < 0) lane.calls.forEach((c, i) => { const d = Math.abs(xOf(anchorTs, view, c.ts) - f); if (d < bd) { bd = d; b = i } })
  return b
}
export const turnsReviewed = (anchorTs, ts) => { const t = toMs(ts); return anchorTs.filter((x) => x <= t).length }

// where a resource stands at the playhead: 'pend' (not yet entered) · 'live' (in a segment that holds the playhead) · 'evicted'.
// `giLocal` maps a gi to its index in the anchor lane; a gi outside it sits past the end (N).
export function resState(playhead, segments, giLocal, N) {
  const L = (gi) => { const v = giLocal.get(gi); return v == null ? N : v }
  const segs = segments || []
  if (!segs.length) return 'pend'
  if (L(segs[0].enter) > playhead) return 'pend'
  const live = segs.some((s) => L(s.enter) <= playhead && (s.evict == null ? N : L(s.evict)) > playhead)
  return live ? 'live' : 'evicted'
}
