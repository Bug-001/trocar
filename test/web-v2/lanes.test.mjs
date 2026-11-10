// lanes.test.mjs — the shared time axis of the trace (replay/lanes.mjs, 1.3 · 1.5 K-06): a time's step position and the calls a brush
// window draws. Generated axes: anchor times with ties and gaps, lanes whose calls fall before, among and after them, every window.
// The reference is the definition written out here: a step position walks the anchor times; a window keeps the calls whose position
// lies in [lo, hi).
import test from 'node:test'
import assert from 'node:assert/strict'
import { stepPos, windowCalls, buildLanes, anchorLane, turnsReviewed, nearestByTs, stepOfMark } from '../../web/legacy/replay/lanes.mjs'
import { renderTicks, renderRails, railToggles, flipRail, wireRails, hasRails } from '../../web/legacy/replay/rails.mjs'
import { wireDetail } from '../../web/legacy/replay/detail.mjs'
import { deskOf } from './desk-world.mjs'
import { applySession } from '../../web/legacy/replay/model.mjs'
import { LANE_KIND, TC_NO_SIZE, ONLY_MAIN } from '../../web/legacy/labels/replay.mjs'
import { esc } from '../../web/legacy/core/fmt.mjs'
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

// 2.1 ③: a window over held rows that do not reach the lane's first or last step draws exactly the calls whose place over the WHOLE lane
// lies in it: none piled at an edge for a step whose row is not here. The oracle is the full anchor; the desk holds a slice [k, m) of it.
// When the next step's time is unknown, the last column's tail waits for its row (dropped, never misplaced)
test('2.1 ③ · windowCalls over a held slice draws exactly the calls whose place over the whole lane is in the window', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = rng(seed), int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1))
    const N = int(2, 30)
    let t = T0
    const full = Array.from({ length: N }, () => (t += int(1, 5000))) // strictly increasing: one place per time
    const calls = Array.from({ length: int(1, 60) }, () => T0 - 20000 + Math.floor(r() * (t - T0 + 40000))).sort((x, y) => x - y).map((ms, i) => ({ rid: `r${i}`, ts: iso(ms) }))
    const k = int(0, N - 1), m = int(k + 1, N), held = full.slice(k, m)
    for (let g0 = k; g0 < m; g0++) for (let g1 = g0 + 1; g1 <= m; g1++) for (const known of [true, false]) {
      const view = { lo: g0 - k, hi: g1 - k, cutBefore: g0 > 0, cutAfter: g1 < N, ...(known && g1 < N ? { cutTs: full[g1] } : null) }
      const got = windowCalls({ calls }, held, view).map(({ c }) => c.rid)
      const place = (c) => refPos(full, Date.parse(c.ts)), unsure = (c) => !known && g1 < N && g1 === m && Date.parse(c.ts) > full[m - 1]
      const want = calls.filter((c) => place(c) >= g0 && place(c) < g1 && !unsure(c)).map((c) => c.rid)
      assert.deepEqual(got, want, `seed ${seed} N ${N} held [${k}, ${m}) window [${g0}, ${g1}) next time ${known ? 'known' : 'unknown'}`)
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
  const event = (dataset) => ({ target: { closest: (sel) => {
    if (sel === '[data-toggle]') return dataset.toggle != null ? { dataset } : null
    if (sel === '[data-grouptoggle]') return dataset.grouptoggle != null ? { dataset } : null
    return sel === '.tick, .pbar' ? { dataset } : sel === '.railbody[data-lane]' ? { dataset: { lane: dataset.lane } } : null
  } } })
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

// the clicks of the drawer's back button, read off what was drawn before the lanes moved on
function wiredClick(wire, s) {
  let click = null
  const el = { addEventListener: (k, f) => { if (k === 'click') click = f }, removeEventListener() {}, querySelector: () => ({ addEventListener() {} }) }
  wire(el, s)
  return (hit) => click({ target: { closest: (sel) => hit(sel) } })
}

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

// ── what can fold: the gutter and the Tracks menu read one list (2.1 ⑥) ─────────────────────────────────────────────────────────────────────
const lane = (id, kind, n) => ({ id, kind, calls: Array.from({ length: n }, (_, i) => ({ rid: `${id}-${i}`, ts: iso(T0 + (i + 1) * 1000), ctx: 10 })), peakCtx: 10 })
function railDesk({ subs, bgs, tc, subgroupOpen = false, bgOpen = false }) {
  const main = lane('main', 'main', 3)
  const lanes = [main, ...Array.from({ length: subs }, (_, i) => lane(`sub${i}`, 'subagent', i + 1)), ...Array.from({ length: bgs }, (_, i) => lane(`bg${i}`, i % 2 ? 'notify' : 'monitor', i + 2)), ...(tc ? [lane('token-count', 'token-count', 2)] : [])]
  return { lanes, anchor: main, anchorTs: main.calls.map((c) => Date.parse(c.ts)), view: { lo: 0, hi: 3 }, selTick: null, collapsedRails: new Set(), subSeeded: new Set(), subgroupOpen, bgOpen }
}
const railWorlds = function* () {
  for (const subs of [0, 1, 2, 3]) for (const bgs of [0, 1, 2]) for (const tc of [false, true]) for (const subgroupOpen of [false, true]) for (const bgOpen of [false, true]) {
    const axes = { subs, bgs, tc, subgroupOpen, bgOpen }, s = railDesk(axes)
    renderRails({}, s) // the first draw seeds the subagent lanes closed
    yield { s, axes, where: JSON.stringify(axes) }
  }
}
// the gutter as a click reads it: the attributes renderRails wrote, in document order
function gutterRows(s) {
  const el = {}
  renderRails(el, s)
  return [...el.innerHTML.matchAll(/<div ([^>]*data-(?:group)?toggle="[^>]*)>/g)].map(([, a]) => {
    const at = Object.fromEntries([...a.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
    const group = at['data-grouptoggle']
    return { id: group != null ? `group:${group}` : at['data-toggle'], dataset: group != null ? { grouptoggle: group } : { toggle: at['data-toggle'] }, open: !at.class.split(/\s+/).includes('col') }
  })
}
const foldState = (s) => ({ collapsed: [...s.collapsedRails].sort(), sub: s.subgroupOpen, bg: s.bgOpen })

test('2.1 #17: railToggles lists what the gutter draws, in its order and with its open state', () => {
  for (const { s, where } of railWorlds()) {
    for (const opened of [null, s.lanes.find((l) => l.kind === 'subagent')]) {
      if (opened) s.collapsedRails.delete(opened.id)
      assert.deepEqual(railToggles(s).map(({ id, open }) => ({ id, open })), gutterRows(s).map(({ id, open }) => ({ id, open })), where)
    }
  }
})

test('1.3 子 agent 行名: the ≈ $ only when a call of the lane was priced; no table, an unknown model or no usage is no ≈ $, never $0', () => {
  const s = railDesk({ subs: 1, bgs: 0, tc: false }), sub = s.lanes.find((l) => l.kind === 'subagent')
  sub.calls[0].usage = { read: 0, create: 0, fresh: 1000, out: 100 }; sub.calls[0].rec = { request: { model: 'known' } }
  const name = (pricing) => railToggles({ ...s, pricing }).find((r) => r.id === sub.id).name
  for (const pricing of [null, { other: [3, 15, 3.75, 0.3] }]) assert.ok(!name(pricing).includes('≈'), JSON.stringify(pricing))
  assert.match(name({ known: [3, 15, 3.75, 0.3] }), /≈ \$/, 'a priced call gives the lane its ≈ $')
  sub.calls[0].usage = null
  assert.ok(!name({ known: [3, 15, 3.75, 0.3] }).includes('≈'), 'no usage: nothing priced')
})

test('2.1 #17: hasRails is true exactly when the gutter has a row to open or close', () => {
  for (const { s, where } of railWorlds()) {
    assert.equal(hasRails(s), railToggles(s).length > 0, where)
    const only = { ...s, lanes: s.lanes.filter((l) => l === s.anchor || l.kind === 'main') }
    assert.equal(hasRails(only), false, `${where}, main lanes only`)
  }
})

test('2.1 #17: flipRail flips that row and no other, and the gutter click leaves the same state', () => {
  for (const { s: seen, axes, where } of railWorlds()) {
    for (const { id, dataset } of gutterRows(seen)) {
      const s = railDesk(axes), g = railDesk(axes)
      renderRails({}, s); renderRails({}, g)
      const was = new Map(railToggles(s).map((t) => [t.id, t.open]))
      flipRail(s, id)
      for (const t of railToggles(s)) if (was.has(t.id)) assert.equal(t.open, t.id === id ? !was.get(t.id) : was.get(t.id), `${where} flip ${id}: ${t.id}`)
      wiredRails(g).click(dataset)
      assert.deepEqual(foldState(g), foldState(s), `${where} click ${id}`)
    }
  }
})

test('2.1 #17: renderRails writes no fold row, at any width', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')
  try {
    for (const narrow of [false, true]) {
      globalThis.matchMedia = () => ({ matches: narrow })
      for (const { axes, where } of railWorlds()) {
        const el = {}
        renderRails(el, railDesk(axes))
        assert.doesNotMatch(el.innerHTML, /data-railunfold/, `${where} narrow=${narrow}`)
      }
    }
  } finally {
    if (had) Object.defineProperty(globalThis, 'matchMedia', had); else delete globalThis.matchMedia
  }
})

test('1.3 §叠加轨: a lane that arrives late lands in step order of its first call; the server\'s order and the anchor stay', () => {
  // the server lists four lanes by first step; a fifth whose first call is between the first two arrives in a delta
  const desk = deskOf([{ kind: 'subagent', rows: [{}, {}] }, { kind: 'subagent', rows: [{}] }, { kind: 'monitor', rows: [{}] }])
  const before = buildLanes(desk, null).map((l) => l.id), anchor = anchorLane(buildLanes(desk, null)).id
  const ts = (rid) => desk.rows.get(rid).ts, mid = new Date((Date.parse(ts('R0-0')) + Date.parse(ts('R1-0'))) / 2).toISOString()
  applySession(desk, { base: desk.mark, mark: 'L-0', calls: [{ rid: 'L-0', lane: 'L-0', ts: mid, ctx: 1, rec: { request: { model: 'm' } } }], gone: [], events: [],
    lanes: [{ lane: 'L-0', kind: 'subagent', first: 'L-0', last: 'L-0', count: 1 }] })
  const after = buildLanes(desk, null).map((l) => l.id)
  assert.deepEqual(after, [before[0], 'L-0', ...before.slice(1)], 'placed by its first call among the held lanes')
  assert.equal(anchorLane(buildLanes(desk, null)).id, anchor, 'a session with no main lane keeps its anchor')
  // a header for a lane whose first call is not held (an unread page) goes last, and a header already held keeps its place
  applySession(desk, { base: desk.mark, mark: desk.mark, calls: [], gone: [], events: [], lanes: [{ lane: 'R9-0', kind: 'monitor', first: 'R9-0', count: 4 }, { lane: before[0], kind: 'subagent', first: before[0], count: 3 }] })
  assert.deepEqual(buildLanes(desk, null).map((l) => l.id), [...after, 'R9-0'])
})

test('1.5 K-04 · 2.1:17: the token-count row is never the anchor (it is no lane); its bars keep the retention each count was stored with', () => {
  const series = [{ ts: '2026-10-07T00:00:01.000Z', tokens: 10, retention: 'log' }, { ts: '2026-10-07T00:00:02.000Z', tokens: 20, retention: 'full' }]
  const only = buildLanes(deskOf([]), { count: 3, series })
  assert.ok(only.some((l) => l.kind === 'token-count'), 'the row is built')
  assert.equal(anchorLane(only), null, 'a session of token counts alone has no step to anchor on (K-04: its own empty state)')
  const tc = buildLanes(deskOf([{ kind: 'main', rows: [{}] }]), { count: 3, series })
  assert.equal(anchorLane(tc).kind, 'main')
  assert.deepEqual(tc.find((l) => l.kind === 'token-count').calls.map((c) => c.retention), ['log', 'full'], 'the drawer says how each was kept (invariant 4)')
})

test('2.1 #20 · a token-count bar is known by its time: a count that gets its size later moves no other bar; timeless counts draw none', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed), n = 1 + Math.floor(r() * 30)
    // times with ties, and some counts with no time at all
    const full = Array.from({ length: n }, (_, i) => ({ ts: r() < 0.15 ? null : new Date(T0 + Math.floor(r() * 8) * 1000).toISOString(), tokens: 100 + i, retention: 'full' }))
      .sort((a, b) => (a.ts ?? '~').localeCompare(b.ts ?? '~')) // the server's order: by time, the timeless last
    const sized = full.filter(() => r() < 0.7) // the ones measured so far: the others get their size later
    const row = (series) => buildLanes(deskOf([]), { count: n, series }).find((l) => l.kind === 'token-count')
    const before = row(sized), after = row(full)
    const want = full.filter((p) => p.ts != null)
    if (!want.length) { assert.equal(after, undefined, `seed ${seed}: no count has a time, so no bar`); continue }
    assert.deepEqual(after.calls.map((c) => c.ctx), want.map((p) => p.tokens), `seed ${seed}: the row holds exactly the counts with a time, in order`)
    assert.equal(new Set(after.calls.map((c) => c.rid)).size, after.calls.length, `seed ${seed}: ids are distinct`)
    assert.equal(after.count, n, `seed ${seed}: the row's number is every count`)
    if (!before) continue
    const now = new Map(after.calls.map((c) => [c.rid, c]))
    for (const c of before.calls) {
      const same = full.filter((p) => p.ts === c.ts).length === sized.filter((p) => p.ts === c.ts).length // no new count at its time
      if (same) assert.equal(now.get(c.rid)?.ctx, c.ctx, `seed ${seed}: ${c.rid} still names the same count`)
    }
  }
})

test('2.1 §token 计数行: the row\'s "no size" number is probes.count − probes.series.length; a count with a size but no time is not one of them', () => {
  const series = [{ ts: iso(T0 + 1000), tokens: 10, retention: 'full' }, { ts: null, tokens: 20, retention: 'full' }, { ts: iso(T0 + 2000), tokens: 30, retention: 'full' }]
  const lanes = buildLanes(deskOf([{ kind: 'main', rows: [{}, {}] }]), { count: 5, series }), main = anchorLane(lanes)
  const s = { lanes, anchor: main, anchorTs: main.calls.map((c) => Date.parse(c.ts)), view: { lo: 0, hi: main.calls.length }, selTick: null, collapsedRails: new Set(), subSeeded: new Set(), subgroupOpen: false, bgOpen: false }
  const el = { innerHTML: '', querySelector: () => null }
  renderRails(el, s)
  assert.ok(el.innerHTML.includes(esc(TC_NO_SIZE(2))), 'two of five came back without a size')
})

// 1.3 无叠加轨 · 1.5 K-31: a tier-0 head has read no lane yet: the overlay area says nothing about the session's lanes, and still
// takes its row, so a tier-1 head draws its rows without moving what is above and below; past tier 0, a main-only session says so
test('1.3 无叠加轨: a tier-0 head draws no "only the main thread" line, but keeps the row; tier 1 draws it', () => {
  for (const tier of [0, 1]) {
    const s = { ...railDesk({ subs: 0, bgs: 0, tc: false }), desk: { head: { tier } } }, el = { innerHTML: '', querySelector: () => null }
    renderRails(el, s)
    assert.match(el.innerHTML, /class="railsonly"/)
    assert.equal(el.innerHTML.includes(ONLY_MAIN), tier > 0)
  }
})
