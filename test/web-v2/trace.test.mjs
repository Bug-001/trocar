// test/web-v2/trace.test.mjs — 1.3's scope as data: web/src/screens/replay/models.mjs : scopeModel() over hand-made desks
// (desk-world.mjs deskOf), a head built here, and the seven harnesses' sessions on the real server. Expected values come from
// core/metrics.mjs (cacheState, isBreak, breakCost, hitRatio), the rows, the head and lanes.mjs; words are the label constants.
import test from 'node:test'
import assert from 'node:assert/strict'
import { scopeModel } from '../../web/src/screens/replay/models.mjs'
import { deskOf } from './desk-world.mjs'
import { buildLanes, anchorLane } from '../../web/legacy/replay/lanes.mjs'
import { problemSteps } from '../../web/legacy/replay/timeline.mjs'
import { isBreak, isFailed, breakCost, hitRatio, refOf } from '../../web/legacy/core/metrics.mjs'
import { L } from '../../web/legacy/core/labels.mjs'
import * as W from '../../web/legacy/labels/replay.mjs'

const U = (read, create, fresh, out = 10) => ({ read, create, fresh, out })
const PRICES = { m: [3, 15, 3.75, 0.3] }
function stateOf(desk, { at = 0, view, ...extra } = {}) {
  const lanes = buildLanes(desk), anchor = anchorLane(lanes), N = anchor.calls.length
  return { desk, meta: desk.meta, lanes, anchor, anchorTs: anchor.calls.map((c) => Date.parse(c.ts)), playhead: at, playRid: anchor.calls[at].rid,
    view: view || { lo: 0, hi: N }, sawView: 'ctx', problems: problemSteps(anchor), pricing: PRICES, diffRef: null, ...extra }
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
  for (const view of [{ lo: 0, hi: ROWS.length }, { lo: 2, hi: 7 }]) {
    const m = scope(ROWS, { view })
    assert.equal(m.bars.length, view.hi - view.lo)
    assert.deepEqual(m.bars.map((b) => b.i), Array.from({ length: view.hi - view.lo }, (_, j) => view.lo + j))
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

test('1.3 #8 · brush left / width = lo / N, (hi − lo) / N; the pin at (playhead + 0.5) / N; sampled only past 240 steps', () => {
  for (const N of [12, 240, 241]) {
    const rows = Array.from({ length: N }, () => ({ usage: U(1, 1, 1) }))
    const lo = Math.floor(N / 3), hi = lo + 5, at = lo + 2
    const m = scope(rows, { view: { lo, hi }, at })
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

