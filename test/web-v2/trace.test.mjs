// test/web-v2/trace.test.mjs — 1.3's scope as data: web/src/screens/replay/models.mjs : scopeModel() over hand-made desks
// (desk-world.mjs deskOf), a head built here, and the seven harnesses' sessions on the real server. Expected values come from
// core/metrics.mjs (cacheState, isBreak, breakCost, hitRatio), the rows, the head and lanes.mjs; words are the label constants.
import test from 'node:test'
import assert from 'node:assert/strict'
import { scopeModel } from '../../web/src/screens/replay/models.mjs'
import { deskOf, deskFrom } from './desk-world.mjs'
import { boardHome, serveBoard } from './real-face.mjs'
import { buildLanes, anchorLane, turnsReviewed } from '../../web/legacy/replay/lanes.mjs'
import { problemSteps } from '../../web/legacy/replay/timeline.mjs'
import { isBreak, isFailed, breakCost, hitRatio, refOf } from '../../web/legacy/core/metrics.mjs'
import { FLAG } from '../../src/view/head-cols.mjs'
import { L } from '../../web/legacy/core/labels.mjs'
import * as W from '../../web/legacy/labels/replay.mjs'

const U = (read, create, fresh, out = 10) => ({ read, create, fresh, out })
const PRICES = { m: [3, 15, 3.75, 0.3] }
function stateOf(desk, { at = 0, ...extra } = {}) {
  const lanes = buildLanes(desk), anchor = anchorLane(lanes)
  return { desk, meta: desk.meta, lanes, anchor, anchorTs: anchor.calls.map((c) => Date.parse(c.ts)), playhead: at, playRid: anchor.calls[at].rid,
    sawView: 'ctx', problems: problemSteps(anchor), pricing: PRICES, diffRef: null, ...extra }
}
const scope = (rows, o = {}, more = []) => scopeModel(stateOf(deskOf([{ kind: 'main', rows }, ...more], o.answer), o), 60)
// a varied main lane: breaks with and without a cost, failures, no usage, uncertain cache numbers, compactions
const ROWS = [
  { usage: U(0, 100, 10), cacheBreak: { firstCall: true }, comp: { system: 3, user: 7 } },
  { usage: U(90, 20, 5), cacheBreak: { cause: 'append' }, comp: { system: 3, user: 9 } },
  { usage: U(0, 120, 5), cacheBreak: { cause: 'tool-array-reorder' } },
  { usage: null, error: 'rate limited', gt: 'provider-contradiction', cacheBreak: { cause: 'append' } },
  { usage: U(10, 100, 5), cacheBreak: { cause: 'append' }, gt: 'ttl-rebuild' },
  { usage: null, cacheBreak: { cause: 'append' } },
  { usage: U(50, 10, 40), wire: { cacheSemanticsKnown: false }, cacheBreak: { cause: 'append' } },
  { usage: U(0, 200, 5), compaction: true, compactionInferred: true, cacheBreak: { cause: 'compaction' } },
  { usage: U(5, 0, 300), cacheBreak: { cause: 'append' }, rec: { request: { model: 'unpriced' } } },
  { usage: U(200, 10, 5), cacheBreak: { cause: 'append' } },
]
const tierOf = (u) => { const r = u.read / (u.read + (u.create || 0) + u.fresh); return r >= 0.7 ? 'high' : r >= 0.3 ? 'mid' : 'low' }

test('1.3 #2 · /N: bars = hi − lo on the full and a narrowed window; a problem mark sits on its own step\'s column', () => {
  for (const span of [{ lo: 0, hi: ROWS.length }, { lo: 2, hi: 7 }]) {
    const m = scope(ROWS, { span })
    assert.equal(m.bars.length, span.hi - span.lo)
    assert.deepEqual(m.bars.map((b) => b.i), Array.from({ length: span.hi - span.lo }, (_, j) => span.lo + j))
    for (const p of m.problems.items) assert.equal(m.bars[p.col].rid, p.rid)
  }
})

test('1.3 #3 · the cache trace is cacheState(): fail · none · uncertain · three tiers by read / (read + create + fresh)', () => {
  const m = scope(ROWS)
  ROWS.forEach((r, i) => {
    const t = m.trace[i]
    const want = r.error ? 'fail' : !r.usage ? 'none' : r.wire ? 'unk' : tierOf(r.usage)
    assert.equal(t.state, want, `step ${i}`)
    assert.equal(t.pct, r.error || !r.usage ? null : Math.round(hitRatio(r.usage) * 100), `step ${i}`)
  })
})

test('1.3 #4 · the composition is an estimate: the legend says so in the context view; a step without comp is hatched; no share is called tokens', () => {
  const m = scope(ROWS)
  assert.equal(m.legend.estimate, W.COMP_LEGEND)
  ROWS.forEach((r, i) => { if (!r.error) assert.equal(m.bars[i].hatched, !r.comp, `step ${i}`) })
  for (const g of scope(ROWS, { at: 1 }).gutter) assert.ok(!g.share.includes(W.TOKENS_WORD))
})

test('1.3 #5 · a compaction is a neutral mark on its step (inferred says so), never a flag, never in n; no new row or axis', () => {
  const m = scope(ROWS), plain = scope(ROWS.map(({ compaction, compactionInferred, ...r }) => r))
  const c = m.problems.items.find((p) => p.i === 7)
  assert.equal(c.kind, 'compact')
  assert.ok(c.aria.includes(W.COMPACT_WORD) && c.aria.includes(W.GUESS))
  assert.equal(m.problems.n, ROWS.filter((r, i) => !r.compaction && (isFailed(r) || isBreak(r))).length)
  assert.equal(m.bars.length, plain.bars.length)
  assert.equal(m.trace.length, plain.trace.length)
})

test('1.3 #5 · the step a marked compaction lands on draws nothing on the problem row and is no problem', () => {
  const rows = [{ usage: U(0, 100, 10), cacheBreak: { firstCall: true } }, { usage: U(90, 20, 5), compaction: true, cacheBreak: { cause: 'append' } },
    { usage: U(0, 200, 5), cacheBreak: { cause: 'compaction' } }, { usage: U(100, 10, 5), cacheBreak: { cause: 'append' } }]
  const m = scope(rows)
  assert.deepEqual(m.problems.items.map((p) => [p.i, p.kind]), [[1, 'compact']])
  assert.equal(m.problems.n, 0)
  assert.deepEqual(problemSteps(anchorLane(buildLanes(deskOf([{ kind: 'main', rows }])))), [])
})

test('1.3 #8 · brush left / width = lo / N, (hi − lo) / N; the pin at (playhead + 0.5) / N; sampled only past 240 steps', () => {
  for (const N of [12, 240, 241]) {
    const rows = Array.from({ length: N }, () => ({ usage: U(1, 1, 1) }))
    const lo = Math.floor(N / 3), hi = lo + 5, at = lo + 2
    const m = scope(rows, { span: { lo, hi }, at })
    assert.equal(m.overview.brush.left, lo / N)
    assert.equal(m.overview.brush.width, (hi - lo) / N)
    assert.equal(m.overview.pin, (at + 0.5) / N)
    assert.equal(m.overview.sampled, N > 240)
    assert.equal(m.legend.sampled, N > 240)
    assert.ok(m.overview.marks.length <= 240)
  }
})

test('1.3 #9 · flags = isBreak steps, × = failed steps, n = both; flag height follows √ breakCost, fixed when it is null; 结构估计 on a changed prefix', () => {
  const m = scope(ROWS), calls = m.bars.map((b) => ROWS[b.i])
  const flags = m.problems.items.filter((p) => p.kind === 'flag'), xs = m.problems.items.filter((p) => p.kind === 'x')
  const breaks = ROWS.map((r, i) => i).filter((i) => !ROWS[i].error && !ROWS[i].compaction && isBreak(ROWS[i], refOf(ROWS, i)))
  assert.deepEqual(flags.map((f) => f.i), breaks)
  assert.deepEqual(xs.map((f) => f.i), ROWS.map((r, i) => i).filter((i) => isFailed(ROWS[i])))
  assert.equal(m.problems.n, flags.length + xs.length)
  const costs = breaks.map((i) => breakCost(calls[i], refOf(ROWS, i), PRICES[(calls[i].rec || {}).request?.model || 'm'] || null).usd)
  const max = Math.max(...costs.filter((x) => x != null))
  flags.forEach((f, j) => { if (costs[j] != null) assert.equal(f.h, Math.sqrt(costs[j] / max)) })
  assert.equal(new Set(flags.filter((f, j) => costs[j] == null).map((f) => f.h)).size <= 1, true, 'one fixed height for an unknown cost')
  assert.ok(flags.find((f) => f.i === 2).aria.includes(L.STRUCT_EST), 'a changed prefix is a structural estimate')
  const none = scope([{ usage: U(1, 1, 1), cacheBreak: { firstCall: true } }])
  assert.equal(none.problems.n, 0)
  assert.equal(none.problems.name, W.problemPager(null, 0))
})

test('1.3 #10 · a failed step: × with its errMsg, a fixed low bar without segments, no cache tier, never a flag (provider-contradiction too)', () => {
  const m = scope(ROWS), b = m.bars[3], x = m.problems.items.find((p) => p.i === 3)
  assert.equal(x.kind, 'x')
  assert.equal(x.aria, W.failTip(4, 'rate limited'))
  assert.ok(b.fail && !b.segs)
  assert.equal(b.h, m.bars.find((y, j) => j !== 3 && y.fail)?.h ?? b.h)
  assert.equal(m.trace[3].state, 'fail')
})

test('1.3 #11 · no usage: the trace cell is the dashed none with 缓存 —, not a flag, no 0% anywhere', () => {
  const m = scope(ROWS)
  assert.equal(m.trace[5].state, 'none')
  assert.ok(m.trace[5].tip.startsWith(W.CACHE_CELL_NONE))
  assert.ok(!m.problems.items.some((p) => p.i === 5))
  assert.equal(m.trace[5].pct, null)
})

test('1.3 #12 · uncertain cache numbers: their own style, 缓存 N%?, and the legend item', () => {
  const m = scope(ROWS), u = ROWS[6].usage
  assert.equal(m.trace[6].state, 'unk')
  assert.ok(m.trace[6].tip.startsWith(W.cacheCellUnknown(Math.round(hitRatio(u) * 100))))
  assert.ok(m.legend.cache.includes(W.CACHE_LEGEND_UNK))
})

test('1.3 #13 · prompt ticks: one per user event on its stepRef column; no events, no row and no name', () => {
  const desk = deskOf([{ kind: 'main', rows: ROWS.slice(0, 6) }], { events: [{ type: 'user', rid: 'R0-1', lane: 'R0-0' }, { type: 'user', rid: 'R0-4', lane: 'R0-0' }, { type: 'tool', rid: 'R0-2', lane: 'R0-0' }] })
  const m = scopeModel(stateOf(desk), 60)
  assert.deepEqual(m.asks.ticks.map((t) => [t.rid, t.col]), [['R0-1', 1], ['R0-4', 4]])
  assert.equal(scope(ROWS.slice(0, 6)).asks, null)
})

test('1.3 #14 · cost view: ≈ on the peak and hovers; no price or no usage is hatched, never a 0-tall bar or $0; back to context, height is ctx', () => {
  const rows = ROWS.map((r, i) => ({ ...r, ctx: 100 * (i + 1) }))
  const s = stateOf(deskOf([{ kind: 'main', rows }]), { sawView: 'cost' }), m = scopeModel(s, 60)
  assert.ok(m.peak.text.startsWith('≈'))
  rows.forEach((r, i) => {
    const b = m.bars[i]
    if (r.error) return assert.ok(b.fail)
    const unknown = !r.usage || !PRICES[r.rec ? r.rec.request.model : 'm']
    assert.equal(b.hatched, unknown, `step ${i}`)
    if (!b.hatched) assert.ok(b.h > 0 && b.tip.includes('≈'))
    assert.doesNotMatch(b.tip, /\$0(?![.\d])/)
  })
  s.sawView = 'ctx'
  const c = scopeModel(s, 60), pk = s.anchor.peakCtx
  rows.forEach((r, i) => { if (!r.error && r.ctx / pk >= 3 / 72) assert.equal(c.bars[i].h, Math.min(1, r.ctx / pk)) })
})

test('1.3 #15 · safety review calls never enter the problem row', () => {
  const monitor = { kind: 'monitor', rows: [{ error: 'x', usage: null }, { usage: U(0, 90, 1), cacheBreak: { cause: 'content-changed' } }] }
  const m = scope(ROWS, {}, [monitor]), main = scope(ROWS)
  assert.equal(m.problems.n, main.problems.n)
  assert.ok(m.problems.items.every((p) => p.rid.startsWith('R0-')))
})

// a head (3.5 §会话读 session --head) over N main steps: per-step cells [height, bucket, flags], chapters starting at `starts`
const b64 = (cells) => Buffer.from(cells.flat()).toString('base64')
const headOf = (axis, N, { starts = [], inferred = [], flags = {} } = {}) => ({ tier: 1, axis, steps: N, peak: 1000, bucket: 1,
  cols: b64(Array.from({ length: N }, (_, i) => [(i * 37) % 256, 0x20, flags[i] || 0])),
  chapters: [0, ...starts].map((s0, k, a) => ({ k, s0, s1: a[k + 1] ?? N, ts0: null, inferred: inferred.includes(s0) })) })

test('1.3 #18 · chapters: k / n, a–b, inferred; ‹ › null at the ends; overview ticks at chapter starts; rough bars keep count and place once rows are held', () => {
  const N = 12, rows = Array.from({ length: N }, () => ({ usage: U(1, 1, 1) })), starts = [4, 9]
  for (const [at, k] of [[0, 1], [5, 2], [11, 3]]) {
    const desk = deskOf([{ kind: 'main', rows }])
    desk.head = headOf('R0-0', N, { starts, inferred: [9] })
    const m = scopeModel(stateOf(desk, { at }), 60), c = desk.head.chapters[k - 1]
    assert.deepEqual([m.chapters.k, m.chapters.n, m.chapters.a, m.chapters.b, m.chapters.inferred], [k, 3, c.s0 + 1, c.s1, c.inferred])
    assert.equal(m.chapters.prev, k > 1 ? desk.head.chapters[k - 2].s1 - 1 : null)
    assert.equal(m.chapters.next, k < 3 ? desk.head.chapters[k].s0 : null)
    assert.deepEqual(m.overview.chapterTicks.map((t) => t.left), [0, ...starts].map((s0) => s0 / N))
  }
  const rough = (desk) => { desk.head = headOf('R0-0', N, { starts }); return scopeModel({ desk, anchor: null, playRid: null, lanes: [], initialStep: 7 }, 3) }
  const before = rough(deskOf([])), after = rough(deskOf([{ kind: 'main', rows }]))
  assert.ok(before.rough && after.rough)
  assert.deepEqual(after.bars.map((b) => [b.g, b.col]), before.bars.map((b) => [b.g, b.col]))
  assert.ok(before.bars.every((b) => b.rid === undefined), 'a cell drawn from cols carries no rid')
  assert.ok(after.bars.every((b) => typeof b.rid === 'string'), 'a held row carries its rid')
})

// the same session three ways: nothing held, the steps from `from` on held, all held
function threeDesks(N, from, head) {
  const rows = (n) => Array.from({ length: n }, () => ({ usage: U(1, 1, 1) })), withHead = (desk) => { desk.head = head; return desk }
  return { rough: withHead(deskOf([])), part: withHead(deskOf([{ kind: 'main', rows: rows(N - from), head: { count: N } }])), all: withHead(deskOf([{ kind: 'main', rows: rows(N) }])) }
}
const roughState = (desk, initialStep) => ({ desk, anchor: null, playRid: null, lanes: [], initialStep })

test('1.3 #23 · one window: rough, part-held and all-held desks give the same bars, step for step; only rows differ', () => {
  const N = 14, from = 6, starts = [4, 9], head = headOf('R0-0', N, { starts }), d = threeDesks(N, from, head)
  for (const g of [7, 11, 13]) for (const K of [3, 60]) {
    const ms = [scopeModel(roughState(d.rough, g + 1), K), scopeModel(stateOf(d.part, { at: g - from }), K), scopeModel(stateOf(d.all, { at: g }), K)]
    for (const m of ms) {
      assert.deepEqual(m.bars.map((b) => [b.g, b.col]), ms[0].bars.map((b) => [b.g, b.col]))
      assert.deepEqual(m.view, ms[0].view)
      assert.equal(m.trace.length, m.bars.length)
      assert.equal(m.bars[m.cursor.col].g, g)
    }
  }
})

test('1.3 #23 · a span in a part with no row held: bars from the cells, the rows\' tracks empty, the cost view empty columns', () => {
  const N = 14, from = 6, flags = { 1: FLAG.failed, 2: FLAG.compaction }, head = headOf('R0-0', N, { starts: [4, 9], flags }), span = { lo: 0, hi: 4 }
  const { part } = threeDesks(N, from, head), m = scopeModel(stateOf(part, { at: 3, span }), 60)
  assert.deepEqual(m.bars.map((b) => b.g), [0, 1, 2, 3])
  assert.ok(m.bars.every((b) => b.rid === undefined && b.i === undefined && !b.cur))
  assert.equal(m.cursor.col, null)
  assert.deepEqual(m.bars.map((b) => [b.fail, b.compact]), [[false, false], [true, false], [false, true], [false, false]])
  assert.ok(m.bars[3].h > 0 && m.bars[3].segs.length)
  assert.deepEqual(m.trace.map((c) => c.state), ['gap', 'gap', 'gap', 'gap'])
  assert.deepEqual([m.problems.items, m.chapters.k], [[], 1], 'no marks yet; the label says the part the bars show')
  const c = scopeModel(stateOf(part, { at: 3, span, sawView: 'cost' }), 60)
  assert.ok(c.bars.every((b) => b.h === 0 && !b.hatched && !b.segs))
})

test('1.3 #23 · bucket > 1: every step of the window draws, from the cell that holds it', () => {
  const N = 12, per = 4, cols = b64([[10, 0x10, 0], [200, 0x20, FLAG.failed], [100, 0x30, 0]])
  const head = { tier: 1, axis: 'R0-0', steps: N, peak: 1000, bucket: per, cols, chapters: [{ k: 0, s0: 0, s1: N, ts0: null, inferred: false }] }
  const m = scopeModel({ ...roughState(deskOf([]), 2), desk: Object.assign(deskOf([]), { head }) }, 60)
  assert.equal(m.bars.length, N)
  m.bars.forEach((b) => assert.equal(b.fail, Math.floor(b.g / per) === 1, `step ${b.g}`))
  assert.equal(new Set(m.bars.slice(8).map((b) => b.h)).size, 1)
})

test('1.3 #20 · the prompts row name: K / P known or not (four combinations); P does not move when more of the lane is held', () => {
  const N = 6, rows = Array.from({ length: N }, () => ({ usage: U(1, 1, 1) })), blocks = rows.map(() => [{ sec: 'system', role: 'system', kind: 'text', bytes: 1 }])
  const user = [[1, 1], [4, 2]] // [step, k]
  const deskWith = (heldEvents, steps = N, flagAt = 4) => {
    const desk = deskOf([{ kind: 'main', rows, blocks, events: heldEvents.map(([i, k]) => ({ type: 'user', rid: `R0-${i}`, lane: 'R0-0', k })) }],
      { events: user.map(([i]) => ({ type: 'user', rid: `R0-${i}`, lane: 'R0-0' })) })
    desk.head = headOf('R0-0', steps, { flags: { 1: FLAG.user, [flagAt]: FLAG.user } })
    return desk
  }
  const asks = (desk, at) => scopeModel(stateOf(desk, { at }), 60).asks
  const cases = [[deskWith(user), 2, 1, 2], [deskWith(user), 0, null, 2], [deskWith(user, N + 1, N), 2, 1, null], [deskWith(user, N + 1, N), 0, null, null]]
  for (const [desk, at, k, p] of cases) {
    const a = asks(desk, at)
    assert.deepEqual([a.k, a.p], [k, p])
    assert.equal(a.name, W.askRowName(k, p))
  }
  assert.equal(asks(deskWith([[4, 2]]), 5).p, asks(deskWith(user), 5).p)
})

test('2.1 #5 · the review bracket: width = clamp((k − lo) / (hi − lo)); a bar is reviewed iff its i < k, k from turnsReviewed()', () => {
  const desk = deskOf([{ kind: 'main', rows: ROWS }, { kind: 'monitor', rows: [{ usage: U(1, 1, 1), ts: '2026-10-07T00:00:22.000Z' }] }]) // sent between main steps 5 and 6
  const lanes = buildLanes(desk), mon = lanes.find((l) => l.kind === 'monitor'), main = anchorLane(lanes)
  const k = turnsReviewed(main.calls.map((c) => Date.parse(c.ts)), mon.calls[0].ts)
  assert.ok(k > 3 && k < 9, 'the reviewed range ends inside the narrowed window')
  for (const span of [{ lo: 0, hi: ROWS.length }, { lo: 3, hi: 9 }]) {
    const m = scopeModel(stateOf(desk, { span, reviewRange: { k } }), 60)
    assert.equal(m.review.width, Math.max(0, Math.min(1, (k - span.lo) / (span.hi - span.lo))))
    for (const b of m.bars) assert.equal(b.reviewed, b.i < k)
  }
})

test('keys · every bar, trace cell, problem and tick carries its rid; a row inserted before the window leaves the window\'s rids as they were', () => {
  const rows = ROWS.map((r, i) => ({ ...r, rid: `X${i}` })), ev = [{ type: 'user', rid: 'X6', lane: 'R0-0' }]
  const a = scopeModel(stateOf(deskOf([{ kind: 'main', rows }], { events: ev }), { span: { lo: 5, hi: 10 }, at: 6 }), 60)
  const b = scopeModel(stateOf(deskOf([{ kind: 'main', rows: [{ usage: U(1, 1, 1), rid: 'X-new' }, ...rows] }], { events: ev }), { span: { lo: 6, hi: 11 }, at: 7 }), 60)
  for (const m of [a, b]) for (const it of [...m.bars, ...m.trace, ...m.problems.items, ...m.asks.ticks]) assert.equal(typeof it.rid, 'string')
  assert.deepEqual(b.bars.map((x) => x.rid), a.bars.map((x) => x.rid))
  assert.deepEqual(b.trace.map((x) => x.rid), a.trace.map((x) => x.rid))
})

test('1.3 #7 · #12 · #13 on the real server: every harness dir\'s session lights the scope, bars = trace = window steps; uncertain steps draw so; ticks only with prompt events', { timeout: 180_000 }, async () => {
  const face = await serveBoard(boardHome({ bytes: 4e5 }))
  try {
    const get = async (name, p) => (await face.get(name, p)).doc
    const sessions = (await get('sessions')).sessions
    assert.ok(new Set(sessions.map((x) => x.harness)).size >= 7, 'the set covers the seven harnesses')
    for (const { session_id: id } of sessions) {
      const desk = await deskFrom(get, id), lanes = buildLanes(desk), anchor = anchorLane(lanes)
      if (!anchor) continue
      const N = anchor.calls.length, s = { desk, meta: desk.meta, lanes, anchor, playhead: 0, playRid: anchor.calls[0].rid, span: { lo: 0, hi: N }, sawView: 'ctx', problems: problemSteps(anchor), pricing: null }
      const m = scopeModel(s, 60)
      assert.equal(m.bars.length, N, id)
      assert.equal(m.trace.length, N, id)
      anchor.calls.forEach((c, i) => { if (!isFailed(c) && c.usage && c.wire && c.wire.cacheSemanticsKnown === false && hitRatio(c.usage) != null) assert.equal(m.trace[i].state, 'unk', `${id} #12`) })
      const users = anchor.kind === 'main' ? anchor.events.filter((e) => e.type === 'user') : []
      assert.equal(m.asks ? m.asks.ticks.length : 0, new Set(users.map((e) => e.rid)).size, `${id} #13`)
      if (!users.length) assert.equal(m.asks, null, `${id} #13: no prompt events, no row`)
    }
  } finally { await face.close() }
})
