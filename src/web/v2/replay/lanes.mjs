// replay/lanes.mjs — lane objects over the desk model and the shared time axis. Pure: the anchor lane's call times (`anchorTs`,
// epoch ms, one per anchor call) and the brush window (`view = {lo, hi}`, step indices) are arguments, never module state.

// A lane object for the renderers: the lane header (3.5 §会话读) + its skeleton rows in step order (`calls`), `ridLocal`
// (rid → index in `calls`), `base` (rows of this lane older than the loaded ones: the header's `count` is the full truth) and
// the session events on its rows. Built from the desk model (replay/model.mjs); `prev` / `changed` reuse the objects of lanes
// no answer touched, so an unchanged lane is never rebuilt per poll.
function laneObject(desk, h) {
  const calls = (desk.laneRids.get(h.lane) || []).map((rid) => desk.rows.get(rid))
  return { ...h, id: h.lane, calls, ridLocal: new Map(calls.map((c, i) => [c.rid, i])), base: Math.max(0, (h.count ?? calls.length) - calls.length),
    events: calls.flatMap((c) => desk.events.get(c.rid) || []) }
}
export function buildLanes(desk, probes, { prev = null, changed = null } = {}) {
  const old = new Map((prev || []).map((l) => [l.id, l]))
  const ls = [...desk.lanes.values()].map((h) => (changed && !changed.has(h.lane) && old.get(h.lane)) || laneObject(desk, h))
  const series = (probes && probes.series) || []
  if (series.length) {
    // a count_tokens measurement is a ruler, not a conversation and not a lane of the server's: its own row key
    // 'token-count' (2.1's table) never collides with the server's `probe` lane (a warm-up request) — 1.3 #16.
    const count = (probes && probes.count) || series.length // the full truth: series only holds the ones with a size
    const calls = series.map((p, i) => ({ rid: `token-count:${i}`, ts: p.ts, ctx: p.tokens || 0, probe: true, usage: null }))
    ls.push({ id: 'token-count', kind: 'token-count', label: 'token count', calls, count, base: 0, events: [],
      ridLocal: new Map(calls.map((c, i) => [c.rid, i])), peakCtx: calls.reduce((m, c) => Math.max(m, c.ctx), 1), flagged: false })
  }
  return ls
}

// the steps: the main lane's calls; a session without a main lane anchors on its first lane (K-04)
export const anchorLane = (lanes) => (lanes || []).find((l) => l.kind === 'main') || (lanes || [])[0] || null
export const stepsOf = (lanes) => { const a = anchorLane(lanes); return a ? a.calls : [] }

// ── numbering (1.2 §编号): the ONE conversion from a record id to the words the board shows ──────────────────────────
// 「第 N 步」 names ONLY a call of the main lane (N = its place in step order + 1, M = the main lane header's count). Any
// other lane's call is 「<lane 词> · 第 k 次调用」, never a step number; the lane object rides along so the caller can open
// its drawer or word it. → { step:true, n, m } | { step:false, lane, k, m } | null (a rid in no loaded lane: the words are
// the caller's business — nothing here invents a step for it).
export function stepRef(lanes, rid) {
  if (rid == null) return null
  const ls = lanes || []
  const at = (l) => { const i = l.ridLocal && l.ridLocal.get(rid); return i == null ? null : (l.base || 0) + i + 1 }
  const main = ls.find((l) => l.kind === 'main')
  if (main) { const n = at(main); if (n != null) return { step: true, n, m: main.count ?? main.calls.length } }
  for (const l of ls) { const k = at(l); if (k != null) return { step: false, lane: l, k, m: l.count ?? l.calls.length } }
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
// `ridLocal` maps a rid to its index in the anchor lane; a rid outside it sits past the end (N).
export function resState(playhead, segments, ridLocal, N) {
  const L = (rid) => { const v = ridLocal.get(rid); return v == null ? N : v }
  const segs = segments || []
  if (!segs.length) return 'pend'
  if (L(segs[0].enter) > playhead) return 'pend'
  const live = segs.some((s) => L(s.enter) <= playhead && (s.evict == null ? N : L(s.evict)) > playhead)
  return live ? 'live' : 'evicted'
}
