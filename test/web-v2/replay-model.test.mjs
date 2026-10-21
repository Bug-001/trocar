// test/web-v2/replay-model.test.mjs — the desk model (replay/model.mjs) against the session-read contract (RFC 3.5 §会话读,
// 2.3 #22): lane pages materialise to their lists, deltas rebuild the full document, and 3.5:67's from-rule keeps held lanes
// whole. Expected values come from the contract fixture and from the generated world's own draws (test/web-v2/desk-world.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createDesk, applySession, applyLane, laneAsk, listOf, stepOf } from '../../src/web/v2/replay/model.mjs'
import { world, readLane, deskFrom } from './desk-world.mjs'

const fx = JSON.parse(fs.readFileSync(new URL('../fixtures/session-read-contract.json', import.meta.url), 'utf8'))
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1)

test('A1 (2.3 #22): lane pages materialise to lists whose every bid is defined and whose copies stay in the parent', async () => {
  const desk = createDesk()
  applySession(desk, fx.session_full)
  for (const page of [fx.lane_keyframe, fx.lane_ops, fx.lane_reset]) applyLane(desk, page)
  for (const page of [fx.lane_keyframe, fx.lane_ops, fx.lane_reset]) for (const s of page.steps) {
    const list = listOf(desk, s.rid)
    // a copy inside its parent yields exactly `len` ids, so the list is as long as the ops say
    assert.equal(list.length, s.ops.reduce((n, [op, ...a]) => n + (op === 0 ? a[1] : a.length), 0), s.rid)
    for (const b of [...list, ...s.reply]) assert.ok(desk.defs.has(b), `${s.rid}: ${b} is defined`)
    const st = stepOf(desk, s.rid)
    assert.deepEqual(st.flat.map((f) => f.bid), list)
    assert.deepEqual(st.reply.map((d) => d.bid), s.reply)
  }
  // long worlds: lanes read from their first step on chain past the 32-step keyframe cache
  for (const w of [...SEEDS.map((s) => world(s)), ...[1, 2, 3, 4].map((s) => world(s, { calls: 160 }))]) {
    const { seed } = w, get = w.get(), lanes = w.laneRidsAt()
    const whole = await deskFrom(get, 'S')
    for (const [key, rids] of lanes) {
      assert.deepEqual(whole.held.get(key).rids, rids, `seed ${seed} lane ${key}: every step held`)
      for (const rid of rids) assert.deepEqual(listOf(whole, rid), w.list(rid), `seed ${seed} ${rid}`)
      if (rids.length < 2) continue
      // two pages: the one ending before a step (`to`), then on from its `next`
      const mid = rids[seed % 2 ? 1 : rids.length >> 1], two = createDesk()
      applySession(two, w.full())
      const first = await get('lane', { lane: key, to: mid })
      applyLane(two, first)
      if (first.next) await readLane(get, 'S', two, { lane: key, from: first.next })
      for (const rid of [...two.held.get(key).rids].reverse()) assert.deepEqual(listOf(two, rid), w.list(rid), `seed ${seed} ${rid} (two pages)`)
      assert.equal(two.held.get(key).rids.at(-1), rids.at(-1), `seed ${seed} lane ${key}: the second page reaches the tip`)
    }
  }
})

const VIEW = (d) => ({ rows: d.rows, order: d.order, lanes: d.lanes, laneRids: d.laneRids, events: d.events })

test('A2: full(M0) plus the since deltas equals full(now); an unknown mark (base:null) replaces everything', () => {
  const seen = { late: 0, gone: 0, relane: 0, lanesGone: 0 }
  for (const seed of SEEDS) {
    const w = world(seed), m = w.marks
    let M = m[Math.floor(m.length / 4)]
    const desk = createDesk()
    applySession(desk, w.full(M))
    for (let i = m.indexOf(M) + 1; i < m.length; i += 1 + (seed + i) % 3) {
      const next = m[Math.min(i, m.length - 1)], d = w.since(M, next)
      const tip = desk.order.at(-1), tipTs = desk.rows.get(tip).ts
      seen.late += d.calls.some((c) => !desk.rows.has(c.rid) && c.ts < tipTs)
      seen.gone += d.gone.length > 0
      seen.relane += d.calls.some((c) => desk.rows.has(c.rid) && desk.rows.get(c.rid).lane !== c.lane)
      seen.lanesGone += d.lanes_gone.length > 0
      assert.equal(d.base, M)
      applySession(desk, d)
      M = next
    }
    if (M !== w.now) applySession(desk, w.since(M, w.now))
    const ref = createDesk()
    applySession(ref, w.full(w.now))
    assert.deepEqual(VIEW(desk), VIEW(ref), `seed ${seed}`)
    assert.equal(desk.mark, w.now)
    const stale = createDesk()
    applySession(stale, w.full(m[2]))
    const out = applySession(stale, w.since('20261021T101500Z:not-a-member'))
    assert.equal(out.reset, true)
    assert.deepEqual(VIEW(stale), VIEW(ref), `seed ${seed}: unknown mark`)
  }
  for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, `the worlds' deltas include ${k}`)
})

// Hold every lane through the deltas, re-reading each touched lane by the ask rule; returns the first mismatch or null.
async function follow(seed, ask) {
  const w = world(seed), m = w.marks
  let M = m[Math.floor(m.length / 3)]
  const desk = createDesk()
  applySession(desk, w.full(M))
  for (const key of desk.lanes.keys()) await readLane(w.get(M), 'S', desk, { lane: key })
  for (let i = m.indexOf(M) + 1; i < m.length; i += 1 + (seed + i) % 2) {
    const next = m[i], { touched } = applySession(desk, w.since(M, next))
    for (const key of touched.keys()) await readLane(w.get(next), 'S', desk, ask(desk, key, touched))
    for (const key of desk.lanes.keys()) if (!desk.held.has(key)) await readLane(w.get(next), 'S', desk, { lane: key })
    M = next
    for (const [key, rids] of w.laneRidsAt(M)) {
      const h = desk.held.get(key)
      if (JSON.stringify(h.rids) !== JSON.stringify(rids)) return `seed ${seed} at ${M} lane ${key}: held ${h.rids} vs ${rids}`
      for (const rid of rids) if (JSON.stringify(listOf(desk, rid)) !== JSON.stringify(w.list(rid))) return `seed ${seed} ${rid}: list`
    }
  }
  return null
}

test('A3 (3.5:67): lanes held through deltas and laneAsk reads equal the lanes read whole; asking from the tip does not', async () => {
  for (const seed of SEEDS) assert.equal(await follow(seed, laneAsk), null)
  const tipOnly = (desk, key) => { const h = desk.held.get(key); return h?.rids.length ? { lane: key, from: h.rids.at(-1) } : { lane: key } }
  const misses = []
  for (const seed of SEEDS) misses.push(await follow(seed, tipOnly))
  assert.ok(misses.some(Boolean), 'a from=tip rule misses late rows and relanes')
})

test('the world answers with the fixture\'s key sets, both ways', async () => {
  const keys = (o) => Object.keys(o).sort()
  const closed = (name, fxItems, items) => {
    const all = new Set(fxItems.flatMap(Object.keys)), must = Object.keys(fxItems[0]).filter((k) => fxItems.every((x) => k in x))
    for (const it of items) {
      for (const k of Object.keys(it)) assert.ok(all.has(k), `${name}: ${k} is not in the fixture`)
      for (const k of must) assert.ok(k in it, `${name}: ${k} is missing`)
    }
  }
  for (const seed of SEEDS.slice(0, 10)) {
    const w = world(seed), full = w.full(), since = w.since(w.marks[3]), lanes = [...w.laneRidsAt().keys()]
    assert.deepEqual(keys(full), keys(fx.session_full))
    assert.deepEqual(keys(since), keys(fx.session_since))
    closed('row', [...fx.session_full.calls, ...fx.session_since.calls], [...full.calls, ...since.calls])
    closed('lane header', fx.session_full.lanes, full.lanes)
    closed('event', fx.session_full.events, full.events)
    closed('record', fx.session_full.records, full.records)
    for (const key of lanes) {
      const tail = w.lane(key), mid = w.lane(key, { from: w.laneRidsAt().get(key)[0] })
      for (const a of [tail, mid]) {
        assert.deepEqual(keys(a), keys(fx.lane_keyframe))
        closed('step', fx.lane_keyframe.steps, a.steps)
        closed('def', [...fx.lane_keyframe.defs, ...fx.lane_ops.defs, ...fx.lane_reset.defs], a.defs)
        closed('resource', [...fx.lane_keyframe.resources, ...fx.lane_reset.resources], a.resources)
        closed('seen', fx.lane_keyframe.seen, a.seen)
      }
    }
  }
})
