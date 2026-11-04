// lanes.test.mjs — the shared time axis of the trace (replay/lanes.mjs, 1.3 · 1.5 K-06): a time's step position and the calls a brush
// window draws. Generated axes: anchor times with ties and gaps, lanes whose calls fall before, among and after them, every window.
// The reference is the definition written out here: a step position walks the anchor times; a window keeps the calls whose position
// lies in [lo, hi).
import test from 'node:test'
import assert from 'node:assert/strict'
import { stepPos, windowCalls } from '../../web/legacy/replay/lanes.mjs'
import { LANE_KIND } from '../../web/legacy/labels/replay.mjs'
import { laneMeta, eventOnly } from '../../src/view/analyze.mjs'
import { HARNESSES } from '../../src/dissect/harnesses.mjs'

function rng(seed) {
  let a = seed >>> 0 || 1
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const T0 = Date.parse('2026-10-23T00:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

// the definition: i = the last anchor index whose successor is not before t, walked one by one
function refPos(a, t) {
  const n = a.length
  if (!n) return 0
  if (t <= a[0]) return 0
  if (t === a[n - 1]) return n - 1
  if (t > a[n - 1]) return n - 1 + 0.999
  let i = 0
  while (i < n - 1 && a[i + 1] < t) i++
  return i + (t - a[i]) / Math.max(1, a[i + 1] - a[i])
}

test('stepPos is the walked step position, and windowCalls is exactly the calls whose position lies in the window', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed), int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1))
    const n = int(1, 40)
    let t = T0
    const anchorTs = Array.from({ length: n }, () => (t += r() < 0.2 ? 0 : int(1, 5000)))
    const span = t - T0 + 20000
    const calls = Array.from({ length: int(0, 80) }, () => T0 - 10000 + Math.floor(r() * span)).sort((x, y) => x - y)
      .map((ms, i) => ({ rid: `r${i}`, ts: iso(r() < 0.1 ? anchorTs[int(0, n - 1)] : ms) }))
      .sort((x, y) => x.ts.localeCompare(y.ts) || x.rid.localeCompare(y.rid))
    const lane = { calls }
    for (const c of calls) assert.equal(stepPos(anchorTs, c.ts), refPos(anchorTs, Date.parse(c.ts)), `seed ${seed} ts ${c.ts}`)
    for (let lo = 0; lo < n; lo++) for (let hi = lo + 1; hi <= n; hi++) {
      const want = calls.map((c, i) => ({ c, i })).filter(({ c }) => { const p = refPos(anchorTs, Date.parse(c.ts)); return p >= lo && p < hi })
      assert.deepEqual(windowCalls(lane, anchorTs, { lo, hi }).map((x) => x.i), want.map((x) => x.i), `seed ${seed} window [${lo}, ${hi})`)
    }
  }
})

test('2.1 #11 · the lane kind table covers the server\'s kinds: every harness aux kind is event-only and named; token-count alone is no lane; no word holds an emoji', () => {
  const { 'token-count': tc, ...lanes } = LANE_KIND
  assert.ok(tc && !laneMeta('token-count'))
  for (const kind of Object.keys(lanes)) assert.ok(laneMeta(kind), kind)
  for (const kind of new Set(['aux', ...HARNESSES.flatMap((h) => h.aux.map((e) => e.kind))])) {
    assert.ok(LANE_KIND[kind] && laneMeta(kind), kind)
    assert.ok(eventOnly(kind), kind)
  }
  for (const { word } of Object.values(LANE_KIND)) assert.doesNotMatch(word, /\p{Extended_Pictographic}/u)
})
