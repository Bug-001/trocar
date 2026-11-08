// lanes.test.mjs — the shared time axis of the trace (replay/lanes.mjs, 1.3 · 1.5 K-06): a time's step position and the calls a brush
// window draws. Generated axes: anchor times with ties and gaps, lanes whose calls fall before, among and after them, every window.
// The reference is the definition written out here: a step position walks the anchor times; a window keeps the calls whose position
// lies in [lo, hi).
import test from 'node:test'
import assert from 'node:assert/strict'
import { stepPos, windowCalls, buildLanes, anchorLane, turnsReviewed, nearestByTs, stepOfMark } from '../../web/legacy/replay/lanes.mjs'
import { renderTicks, renderRails, wireRails } from '../../web/legacy/replay/rails.mjs'
import { wireTimeline } from '../../web/legacy/replay/timeline.mjs'
import { wireDetail } from '../../web/legacy/replay/detail.mjs'
import { deskOf } from './desk-world.mjs'
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

// ── a drawn mark names its call by rid (2.3 §播放头是调用): rows land in the lanes before the mark is drawn again ─────────────────────────
// main steps at 2, 4, 6, 8 and a monitor's calls at 3, 5, 7; with `late`, a main step and a monitor call older than all of them
const marked = (late) => deskOf([
  { kind: 'main', rows: [...(late ? [{ rid: 'm0', ts: iso(T0) }] : []), ...[2, 4, 6, 8].map((t) => ({ rid: `m${t}`, ts: iso(T0 + t * 1000) }))] },
  { kind: 'monitor', rows: [...(late ? [{ rid: 'w1', ts: iso(T0 + 1000) }] : []), ...[3, 5, 7].map((t) => ({ rid: `w${t}`, ts: iso(T0 + t * 1000) }))] },
])
function markedDesk(desk) {
  const lanes = buildLanes(desk), anchor = anchorLane(lanes), rec = { opened: [], steps: [] }
  return { rec, lanes, anchor, anchorTs: anchor.calls.map((c) => Date.parse(c.ts)), view: { lo: 0, hi: anchor.calls.length }, playhead: 0, follow: true, reviewRange: null,
    root: { querySelectorAll: () => [], querySelector: () => null }, paintReview() {}, setPlayhead: (i) => rec.steps.push(i), openDetailNext: (lane, i) => rec.opened.push(lane.calls[i].rid) }
}
const moveOn = (s, desk) => { const n = markedDesk(desk); Object.assign(s, { lanes: n.lanes, anchor: n.anchor, anchorTs: n.anchorTs }) } // what a redraw does before it draws
// the ticks as a click reads them: the attributes renderTicks wrote
const drawnMarks = (lane, s) => [...renderTicks(lane, s).matchAll(/<span ([^>]*)>/g)].map(([, a]) => Object.fromEntries([...a.matchAll(/data-(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]])))
function wiredRails(s) {
  const on = {}
  wireRails({ addEventListener: (k, f) => { on[k] = f }, removeEventListener() {} }, s)
  const event = (dataset) => ({ target: { closest: (sel) => (sel === '.tick, .pbar' ? { dataset } : sel === '.railbody[data-lane]' ? { dataset: { lane: dataset.lane } } : null) } })
  return { click: (d) => on.click(event(d)), move: (d) => on.mousemove(event(d)) }
}

test('2.1 #16: a tick clicked after older rows landed selects the call it was drawn for, and its hover brackets that call', () => {
  const s = markedDesk(marked(false)), monitor = s.lanes.find((l) => l.kind === 'monitor'), ticks = drawnMarks(monitor, s), rails = wiredRails(s)
  assert.equal(ticks.length, 3)
  moveOn(s, marked(true))
  const now = s.lanes.find((l) => l.kind === 'monitor')
  for (const [j, rid] of ['w3', 'w5', 'w7'].entries()) {
    rails.move(ticks[j])
    assert.equal(s.reviewRange.k, turnsReviewed(s.anchorTs, now.calls[now.ridLocal.get(rid)].ts), `hover of ${rid}`)
    rails.click(ticks[j])
    assert.equal(s.rec.opened.at(-1), rid)
    assert.equal(s.rec.steps.at(-1), nearestByTs(s.anchor, now.calls[now.ridLocal.get(rid)].ts), `the step of ${rid}`)
  }
})

test('2.1 #16: a tick whose call moved to another lane opens it there; one whose call is gone opens nothing', () => {
  const s = markedDesk(marked(false)), ticks = drawnMarks(s.lanes.find((l) => l.kind === 'monitor'), s), rails = wiredRails(s)
  const [a, b] = ticks
  moveOn(s, deskOf([{ kind: 'main', rows: [2, 4, 6, 8].map((t) => ({ rid: `m${t}`, ts: iso(T0 + t * 1000) })) }, { kind: 'monitor', rows: [{ rid: 'w7', ts: iso(T0 + 7000) }] }, { kind: 'aux', rows: [{ rid: 'w3', ts: iso(T0 + 3000) }] }]))
  rails.click(a); assert.deepEqual(s.rec.opened, ['w3'])
  rails.click(b); assert.deepEqual(s.rec.opened, ['w3'], 'w5 is no more')
})

// the clicks of the legacy view's bars and of the drawer's back button, read off what was drawn before the lanes moved on
function wiredClick(wire, s) {
  let click = null
  const el = { addEventListener: (k, f) => { if (k === 'click') click = f }, removeEventListener() {}, querySelector: () => ({ addEventListener() {} }) }
  wire(el, s)
  return (hit) => click({ target: { closest: (sel) => hit(sel) } })
}

test('2.1 #16: a bar clicked after older rows landed moves the playhead to the call it was drawn for', () => {
  const s = markedDesk(marked(false)), click = wiredClick(wireTimeline, s)
  moveOn(s, marked(true))
  click((sel) => (sel === '#sawrow .bar' ? { dataset: { i: '1', rid: 'm4' } } : null))
  assert.deepEqual(s.rec.steps, [2])
})

test('2.6 §B: the drawer\'s back button goes to the step it was drawn for after older rows landed', () => {
  const s = markedDesk(marked(false)), steps = []
  Object.assign(s, { jumpTo: (i) => steps.push(i), cellRoots: () => [] })
  const click = wiredClick(wireDetail, s)
  moveOn(s, marked(true))
  click((sel) => (sel === '[data-back]' ? { dataset: { back: 'm6' } } : null))
  assert.deepEqual(steps, [3])
})

test('2.1 #16: stepOfMark finds the step of a call now: its place in the anchor lane, the nearest step in time once it left that lane, -1 when no lane holds it', () => {
  const s = markedDesk(marked(true))
  assert.equal(stepOfMark(s, 'm4'), 2)
  assert.equal(stepOfMark(s, 'w5'), nearestByTs(s.anchor, iso(T0 + 5000)))
  assert.equal(stepOfMark(s, 'nope'), -1)
})

// 2.1 §边界情况 安全审查的结论: until the server reads its verdicts right, a verdict flagged true draws no mark and no count anywhere
test('2.1 #12: a review call flagged true draws no mark, folded or open, and the row names no flag; a failed call still draws ×', () => {
  const desk = deskOf([{ kind: 'main', rows: [{}, {}] }, { kind: 'monitor', rows: [{}, {}, { status: 500, error: 'overloaded_error' }], blocks: [[], [], []], head: { flagged: 3 } }])
  const mon = [...desk.lanes.values()].find((h) => h.kind === 'monitor').lane
  for (const rid of desk.laneRids.get(mon)) desk.held.get(mon).events.set(rid, [{ type: 'monitor', rid, lane: mon, verdict: '<block>yes</block>', flagged: true }])
  const s = { ...markedDesk(desk), desk, railsFolded: false, subSeeded: new Set(), collapsedRails: new Set(), subgroupOpen: false, bgOpen: false, selTick: null }
  const flag = /class="tick[^"]*\bflag\b/, el = { innerHTML: '', querySelector: () => null }
  const lane = s.lanes.find((l) => l.kind === 'monitor')
  assert.doesNotMatch(renderTicks(lane, s), flag)
  assert.equal(renderTicks(lane, s).match(/errtick/g)?.length, 1)
  renderRails(el, s)
  assert.doesNotMatch(el.innerHTML, flag)
  assert.deepEqual([...el.innerHTML.matchAll(/<span class="tick ([^"]*)"/g)].map((m) => m[1].trim()), ['errtick'], 'the folded row draws only the ×')
  s.bgOpen = true
  renderRails(el, s)
  assert.doesNotMatch(el.innerHTML, flag)
  assert.doesNotMatch(el.innerHTML, /flagged/i)
})
