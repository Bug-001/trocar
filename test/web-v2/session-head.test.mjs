// test/web-v2/session-head.test.mjs — the session head as data (web/src/screens/replay/models.mjs : sessionHeadModel): 1.2 #16's
// numbering (stepRef on rids), the 会话保真行's facts and their technical details, the title, the chip, the info rows. The rendered
// head is DeskHead.test.tsx's and the step head StepHead.test.tsx's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { world, deskFrom, deskOf } from './desk-world.mjs'
import { buildLanes, stepRef } from '../../web/legacy/replay/lanes.mjs'
import { sessionHeadModel } from '../../web/src/screens/replay/models.mjs'
import { sessionTotals, priceMatch } from '../../web/legacy/core/metrics.mjs'
import { L } from '../../web/legacy/core/labels.mjs'
import * as W from '../../web/legacy/labels/replay.mjs'

const SEEDS = [1, 7, 19, 42]
const worldDesk = (seed) => { const w = world(seed); return deskFrom(w.get(), 'S').then((desk) => ({ w, desk })) }
// the 会话保真行 of a desk answer: its facts and technical-detail pairs
const factsOf = (d) => sessionHeadModel({ meta: { session_id: 'S' }, desk: d, lanes: [] }).facts

// 1.2 #16: 「第 N 步」 names only a main-lane call (N = its place in the main lane's step order + 1, M = the header's count);
// any other lane's call is that lane + its own k. Expected positions from the reference server's lanes, not the model's.
test('1.2 #16 numbering: stepRef on a main-lane rid is step n of M; on another lane\'s rid it is that lane and k', async () => {
  for (const seed of SEEDS) {
    const { w, desk } = await worldDesk(seed)
    const lanes = buildLanes(desk), byLane = w.laneRidsAt()
    const mainKey = [...desk.lanes.values()].find((h) => h.kind === 'main')?.lane
    for (const [key, rids] of byLane) rids.forEach((rid, i) => {
      const r = stepRef(lanes, rid)
      if (key === mainKey) assert.deepEqual(r, { step: true, n: i + 1, m: rids.length }, rid)
      else { assert.equal(r.step, false, rid); assert.equal(r.lane.id, key); assert.equal(r.k, i + 1); assert.equal(r.m, rids.length) }
    })
    assert.equal(stepRef(lanes, 'no-such-rid'), null, 'a rid in no lane is not numbered')
  }
})

// a slow read (an index-cold note) is not a loss — the 'files not read in full' fact counts only non-note errors;
// every entry, notes included, still lands in the tech pairs
test('only non-note read errors make the files fact; all of them reach the tech pairs', () => {
  for (let k1 = 0; k1 <= 3; k1++) for (let k2 = 0; k2 <= 3; k2++) {
    const errors = [
      ...Array.from({ length: k1 }, (_, i) => ({ where: `f${i}.ndjson`, code: 'index-cold', level: 'note', reason: 'slow' })),
      ...Array.from({ length: k2 }, (_, i) => ({ where: `g${i}.ndjson`, reason: 'EIO' })),
    ]
    const { items, tech } = factsOf({ errors })
    assert.equal(items.filter((f) => f.kind === 'files').length, k2 > 0 ? 1 : 0, `k1=${k1} k2=${k2}`)
    assert.equal(tech.length, k1 + k2)
  }
})

// 1.5 K-20 / 1.2 §会话保真行: the fact is there iff `unknown.records > 0`; the reason and the endpoints only in 技术细节
test('K-20: the unreadable-records fact appears iff unknown.records > 0; reason and endpoints only in the tech details', () => {
  const reason = 'REASON_' + Math.random().toString(36).slice(2), ep = 'EP_' + Math.random().toString(36).slice(2)
  for (const unknown of [null, undefined, { records: 0 }, { records: 0, reason, endpoints: [ep] }, { records: 1, reason, endpoints: [ep] }, { records: 37, reason, endpoints: [ep, ep + 'b'] }, { records: 2 }]) {
    const on = !!unknown && unknown.records > 0
    const { items, tech } = factsOf({ unknown })
    assert.equal(items.length, on ? 1 : 0, JSON.stringify(unknown))
    if (!on) { assert.equal(tech.length, 0, 'no fact: no tech pairs'); continue }
    const words = JSON.stringify(items), pairs = JSON.stringify(tech)
    for (const t of [unknown.reason, ...(unknown.endpoints || [])].filter(Boolean)) {
      assert.ok(pairs.includes(t), `${t} in the tech details`)
      assert.ok(!words.includes(t), `${t} not in the fact's words`)
    }
  }
})

// ── the desk's session head as data (web/src/screens/replay/models.mjs : sessionHeadModel) ─────────────────────────

const PRICES = { m: [3, 15, 3.75, 0.3] }
const U = (read, create, fresh, out = 10) => ({ read, create, fresh, out })
// a desk of hand-made lanes and its state object as the controller holds it
const headState = (lanes, answer = {}, extra = {}) => {
  const desk = deskOf(lanes, answer)
  return { desk, meta: desk.meta, lanes: buildLanes(desk, desk.probes), pricing: PRICES, follow: false, ...extra }
}
const mainRows = () => [{ usage: U(0, 100, 10), cacheBreak: { firstCall: true } }, { usage: U(0, 120, 10), cacheBreak: { cause: 'content-changed' } }, { error: 'boom', usage: null }, { usage: U(100, 30, 5), cacheBreak: { cause: 'append' } }]
const HEAD_PARTS = ['back', 'title', 'chip', 'entry', 'project', 'start', 'follow', 'read', 'stale', 'facts', 'info'] // 1.2 §会话头's table + the 保真行 + ⓘ
const INFO_KEYS = new Set(['truncated', 'cost', 'hit', 'breaks', 'failed', 'compactions', 'counts', 'duration', 'parent', 'fork', 'lineage', 'id', 'project', 'calls']) // 1.2 §信息弹出层

test('1.2 #17 · model: the title falls back to 未命名会话 only; the start is chapters[0].ts0 and absent at tier 0; a title always comes from the wire (4.4 §人类标题的来源)', () => {
  const chapters = [{ k: 0, s0: 0, s1: 4, ts0: '2026-10-07T00:00:00.000Z', inferred: false }]
  for (const [meta, tier, want] of [[{ session_id: 'S-1' }, 1, W.TITLE_UNTITLED_NEXT_TIP], [{ session_id: 'S-1', title: 'T', title_source: 'wire' }, 1, W.TITLE_FROM_WIRE], [{ session_id: 'S-1', title: 'T', title_source: null }, 0, W.TITLE_FROM_WIRE]]) {
    const s = headState([{ kind: 'main', rows: mainRows() }], { meta })
    s.desk.head = { tier, steps: 4, chapters: tier ? chapters : [] }
    const m = sessionHeadModel(s)
    assert.equal(m.title.text, meta.title ?? null)
    assert.equal(m.title.fallback, meta.title == null ? W.UNTITLED : null, 'the fallback is the fixed word alone')
    assert.ok(!String(m.title.text ?? m.title.fallback).includes(meta.session_id), 'no title is made from the id')
    assert.equal(m.title.sourceTip, want)
    assert.equal(m.start ? m.start.ts : null, tier ? chapters[0].ts0 : null, tier ? 'the start is the first chapter\'s ts0' : 'no start at tier 0')
  }
})

test('1.2 #15 · model: 多个 agent iff the sessions multi-harness field has more than one entry; provider mixed never says it', () => {
  for (const hs of [undefined, [], [{ harness: 'claude-code' }], [{ harness: 'claude-code' }, { harness: 'codex', inferred: true }]]) {
    const s = headState([{ kind: 'main', rows: mainRows() }], { meta: { session_id: 'S', harness: 'claude-code', provider: 'mixed', ...(hs ? { harnesses: hs } : {}) } })
    const m = sessionHeadModel(s)
    assert.equal(!!m.chip.multi, !!hs && hs.length > 1, JSON.stringify(hs))
    if (m.chip.multi) assert.equal(m.chip.multi.text, W.MULTIPLE_AGENTS)
  }
})

test('1.2 #3 · model: two sessions with one title carry no same-name word; the head is only its parts; a sub-agent is only a count', () => {
  for (const id of ['S-a', 'S-b']) {
    const s = headState([{ kind: 'main', rows: mainRows() }, { kind: 'subagent', rows: [{ usage: U(0, 50, 5) }] }], { meta: { session_id: id, title: 'Same title', title_source: 'wire' } })
    const m = sessionHeadModel(s)
    assert.deepEqual(Object.keys(m), HEAD_PARTS)
    const rows = m.info()
    for (const r of rows) assert.ok(INFO_KEYS.has(r.key), r.key)
    assert.equal(rows.find((r) => r.key === 'counts').sub, 1, 'the sub-agent is counted, not named')
  }
})

test('1.2 #7 · model: every info number is core/metrics.mjs\'s on the same answer; estimates carry ≈; no field name in any word', () => {
  const s = headState([{ kind: 'main', rows: mainRows() }, { kind: 'monitor', rows: [{ usage: U(0, 20, 5) }, { error: 'x', usage: null }] }], { meta: { session_id: 'S', calls: 6 }, truncated: { shown: 6, total: 9, file_mb: 1 } })
  const t = sessionTotals(s.lanes, (m) => priceMatch(PRICES, m)), rows = sessionHeadModel(s).info()
  const by = Object.fromEntries(rows.map((r) => [r.key, r]))
  assert.equal(rows[0].key, 'truncated', 'a truncated view says so first')
  assert.equal(by.cost.usd, t.cost.total.usd)
  assert.deepEqual(by.cost.buckets.map((b) => b.usd), ['main', 'sub', 'bg'].map((k) => (t.cost[k].priced ? t.cost[k].usd : null)))
  assert.equal(by.hit.pct, Math.round(t.hit * 100))
  assert.equal(by.breaks.n, t.breaks.length)
  assert.equal(by.breaks.usd, t.breakCost.counted ? t.breakCost.usd : null)
  assert.equal(by.failed.n, t.failed)
  for (const k of ['cost', 'breaks']) assert.ok(by[k].approx && by[k].text.includes('≈') || by[k].notes.some((x) => x.includes('≈')), `${k} carries ≈`)
  assert.ok(by.breaks.text.includes(L.STRUCT_EST), 'a break count carries its structural mark')
  const words = JSON.stringify(rows.map((r) => [r.text, r.notes || []]))
  assert.doesNotMatch(words, /\b(usage|cacheBreak|session_id|title_source|harness|ctx|cache_read|rid)\b/)
})

test('1.2 #18 · model: background calls = the server lanes outside main and sub-agents; token counts = probes.count, never a background call', () => {
  const probes = { count: 7, series: [{ ts: '2026-10-07T00:00:01.000Z', tokens: 10 }, { ts: '2026-10-07T00:00:02.000Z', tokens: 12 }] }
  const lanes = [{ kind: 'main', rows: mainRows() }, { kind: 'monitor', rows: [{}, {}], head: { count: 5 } }, { kind: 'probe', rows: [{}] }, { kind: 'subagent', rows: [{}] }]
  const s = headState(lanes, { meta: { session_id: 'S' }, probes })
  s.lanes = buildLanes(s.desk, probes)
  assert.ok(s.lanes.some((l) => l.kind === 'token-count'), 'the front end built its token-count lane')
  const c = sessionHeadModel(s).info().find((r) => r.key === 'counts')
  assert.equal(c.bg, 5 + 1, 'the server lanes\' full counts')
  assert.equal(c.probe, probes.count)
  assert.equal(c.sub, 1)
})

// 1.2 §信息弹出层 row 8 · 3.4 §血缘: a line per declared id, linked through #/session/<id>; a null never reads as "no parent";
// no-keys and unread say so in words; an answer without lineage_source draws nothing
test('1.2 #7 · model: the declared parent and fork, each its own line linked by id; null, absent and other sources never draw an id', () => {
  const ids = [null, 'P-1', 'a/b c']
  const rowsOf = (meta) => sessionHeadModel({ meta: { session_id: 'S', ...meta }, desk: {}, lanes: [] }).info().filter((r) => ['parent', 'fork', 'lineage'].includes(r.key))
  for (const parent of ids) for (const fork of ids) {
    const rows = rowsOf({ lineage_source: 'wire', parent_session_id: parent, fork_of_session_id: fork })
    const want = [parent && ['parent', parent], fork && ['fork', fork]].filter(Boolean)
    assert.deepEqual(rows.map((r) => [r.key, r.id]), want, `${parent} / ${fork}`)
    for (const r of rows) assert.equal(r.href, `#/session/${encodeURIComponent(r.id)}`)
  }
  for (const src of ['no-keys', 'unread']) {
    const rows = rowsOf({ lineage_source: src, parent_session_id: 'P-1', fork_of_session_id: 'F-1' }) // keys the server never sends there
    assert.deepEqual(rows.map((r) => [r.key, r.id, r.href]), [['lineage', undefined, undefined]], src)
    assert.equal(rows[0].text, W.LINEAGE_LINE[src])
  }
  assert.deepEqual(rowsOf({}), [], 'no lineage_source: nothing')
  assert.deepEqual(rowsOf({ lineage_source: 'wire' }), [], 'wire without the keys: nothing')
  for (const src of ['other', 'toString', 'constructor']) assert.deepEqual(rowsOf({ lineage_source: src, parent_session_id: 'P-1' }), [], `${src}: not in the closed set, nothing`)
})

