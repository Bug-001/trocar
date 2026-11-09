// replay/lanes.mjs — lane objects over the desk model and the shared time axis. Pure: the anchor lane's call times (`anchorTs`,
// epoch ms, one per anchor call) and the brush window (`view = {lo, hi}`, step indices) are arguments, never module state.
import { indexOf } from './model.mjs'

// A lane object for the renderers: the lane header (3.5 §会话读) + its skeleton rows in step order (`calls`), `ridLocal`
// (rid → index in `calls`), `base` (rows of this lane older than the loaded ones: the header's `count` is the full truth) and
// the session events on its rows. Built from the desk model (replay/model.mjs); `prev` / `changed` reuse the objects of lanes
// no answer touched, so an unchanged lane is never rebuilt per poll.
// `no(i)` = the 0-based step number of calls[i]: its step's own `i` when files feed the desk (the held rows may have gaps), else base + i
function laneObject(desk, h) {
  const calls = (desk.laneRids.get(h.lane) || []).map((rid) => desk.rows.get(rid)), base = Math.max(0, (h.count ?? calls.length) - calls.length)
  return { ...h, id: h.lane, calls, ridLocal: new Map(calls.map((c, i) => [c.rid, i])), base,
    no: (i) => { const x = calls[i] ? indexOf(desk, h.lane, calls[i].rid) : -1; return x >= 0 ? x : base + i },
    events: calls.flatMap((c) => desk.events.get(c.rid) || []) }
}
export function buildLanes(desk, probes, { prev = null, changed = null } = {}) {
  const old = new Map((prev || []).map((l) => [l.id, l]))
  const ls = [...desk.lanes.values()].map((h) => (changed && !changed.has(h.lane) && old.get(h.lane)) || laneObject(desk, h))
  // a count with no time has no place on the time axis: it is in `count`, never a bar (windowCalls searches the row by time)
  const sized = ((probes && probes.series) || []).length, series = ((probes && probes.series) || []).filter((p) => p.ts != null)
  if (series.length) {
    // a count_tokens measurement is a ruler, not a conversation and not a lane of the server's: its own row key
    // 'token-count' (2.1's table) never collides with the server's `probe` lane (a warm-up request) — 1.3 #16.
    const count = (probes && probes.count) || series.length // the full truth: series only holds the ones with a size
    // a bar is known by its time (2.1:17), the n-th of a tie by its place: a count that gets its size later moves no other bar's id.
    // shortcut: within one millisecond a late-sized count can still renumber the tie after it; name bars by record id if ties show up
    const tie = new Map()
    const calls = series.map((p) => { const k = tie.get(p.ts) || 0; tie.set(p.ts, k + 1)
      return { rid: `token-count:${p.ts}${k ? `#${k}` : ''}`, ts: p.ts, ctx: p.tokens || 0, probe: true, usage: null, retention: p.retention } })
    ls.push({ id: 'token-count', kind: 'token-count', label: 'token count', calls, count, sized, base: 0, events: [],
      ridLocal: new Map(calls.map((c, i) => [c.rid, i])), peakCtx: calls.reduce((m, c) => Math.max(m, c.ctx), 1), flagged: false })
  }
  return ls
}

// A drawn mark names its call by rid (2.3 §播放头是调用): the lanes can move on before the mark is drawn again (a redraw waiting for the
// followed step's bodies, a pack's older rows), so what it stands for is looked up when it is used. → {lane, i} now, null when no lane holds it
export function placeOf(lanes, rid) {
  for (const lane of lanes || []) { const i = lane.ridLocal.get(rid); if (i !== undefined) return { lane, i } }
  return null
}
// the anchor step a mark stands for now: its call's step, the step nearest in time when the call left the anchor lane, -1 when no lane holds it
export function stepOfMark(s, rid) {
  const p = placeOf(s.lanes, rid)
  return !p ? -1 : p.lane === s.anchor ? p.i : nearestByTs(s.anchor, p.lane.calls[p.i].ts, s.playhead)
}

// the steps: the main lane's calls; a session without a main lane anchors on its first lane (K-04)
// (the token-count row is no lane, 2.1:17: never the anchor; a session of token counts alone keeps its K-04 empty state)
export const anchorLane = (lanes) => (lanes || []).find((l) => l.kind === 'main') || (lanes || []).find((l) => l.kind !== 'token-count') || null
export const stepsOf = (lanes) => { const a = anchorLane(lanes); return a ? a.calls : [] }

// ── numbering (1.2 §编号): the ONE conversion from a record id to the words the board shows ──────────────────────────
// 「第 N 步」 names ONLY a call of the main lane (N = its place in step order + 1, M = the main lane header's count). Any
// other lane's call is 「<lane 词> · 第 k 次调用」, never a step number; the lane object rides along so the caller can open
// its drawer or word it. → { step:true, n, m } | { step:false, lane, k, m } | null (a rid in no loaded lane: the words are
// the caller's business — nothing here invents a step for it).
export function stepRef(lanes, rid) {
  if (rid == null) return null
  const ls = lanes || []
  const at = (l) => { const i = l.ridLocal && l.ridLocal.get(rid); return i == null ? null : (l.no ? l.no(i) : (l.base || 0) + i) + 1 }
  const main = ls.find((l) => l.kind === 'main')
  if (main) { const n = at(main); if (n != null) return { step: true, n, m: main.count ?? main.calls.length } }
  for (const l of ls) { const k = at(l); if (k != null) return { step: false, lane: l, k, m: l.count ?? l.calls.length } }
  return null
}

const toMs = (ts) => (typeof ts === 'number' ? ts : Date.parse(ts))

// fractional step position in [0, n): which anchor call a wall-clock time falls at, plus how far toward the next one.
// An anchor call itself sits at its own index i (so on the full window it lands at i/N, the last call included); a time after
// the last call sits at the right edge of the last column. `anchorTs` is in step order, so `i` (the first index whose next time is
// not before t) is a binary search: a render places every tick of a long session in O(log N) each, not O(N).
export function stepPos(anchorTs, ts) {
  const t = toMs(ts), n = anchorTs.length
  if (!n) return 0
  if (t <= anchorTs[0]) return 0
  if (t === anchorTs[n - 1]) return n - 1
  if (t > anchorTs[n - 1]) return n - 1 + 0.999
  let i = 0, hi = n - 1
  while (i < hi) { const m = (i + hi) >> 1; if (anchorTs[m + 1] < t) i = m + 1; else hi = m }
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
// the lane's calls in the brush window as [{c, i}] (i = the index in the lane): a lane's calls are in step order, so only the run
// whose times lie in [anchorTs[lo], anchorTs[hi]] is looked at (two binary searches), and inWindow decides each of those. What a render
// costs follows the window it draws, not the length of the lane.
export function windowCalls(lane, anchorTs, view) {
  if (view.none) return [] // a window with steps not held yet: the ticks wait for their rows
  const calls = lane.calls, n = anchorTs.length, lo = view.lo | 0, hi = Math.max(lo + 1, view.hi || n)
  const first = (pred) => { let a = 0, b = calls.length; while (a < b) { const m = (a + b) >> 1; if (pred(toMs(calls[m].ts))) b = m; else a = m + 1 } return a }
  const from = lo > 0 && lo < n ? first((t) => t >= anchorTs[lo]) : 0
  const to = hi < n ? first((t) => t > anchorTs[hi]) : calls.length
  // a window past step 0, or before the lane's last step with no held step after it, has no place for a call outside its held rows:
  // stepPos would pile it at the edge (2.1 ③). The last column ends at the next step's time when the view knows it (`cutTs`), else
  // its tail waits for that step's row
  const t0 = view.cutBefore ? anchorTs[lo] : -Infinity, tail = view.cutAfter && hi >= n
  const kept = (t) => t >= t0 && (!tail || (view.cutTs != null ? t < view.cutTs : t <= anchorTs[n - 1]))
  const out = []
  for (let i = from; i < to; i++) if (kept(toMs(calls[i].ts)) && inWindow(anchorTs, view, calls[i].ts)) out.push({ c: calls[i], i })
  return out
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
// edge and would hijack edge clicks); the whole lane when none is in the window and it holds every step there, else -1 (a call the window
// culls is not drawn and is not picked). A real index otherwise, drawn tick or not.
export function nearestByX(lane, anchorTs, view, f) {
  let b = -1, bd = Infinity
  for (const { c, i } of windowCalls(lane, anchorTs, view)) {
    const d = Math.abs(xOf(anchorTs, view, c.ts) - f)
    if (d < bd) { bd = d; b = i }
  }
  if (b < 0 && !view.cutBefore && !view.cutAfter) lane.calls.forEach((c, i) => { const d = Math.abs(xOf(anchorTs, view, c.ts) - f); if (d < bd) { bd = d; b = i } })
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
