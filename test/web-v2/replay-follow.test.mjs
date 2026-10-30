// test/web-v2/replay-follow.test.mjs — a step's own reads (replay/follow.mjs createStepReads, cell.mjs loadBodies; 2.3 §读与画
// 快速拖动, 4.4 live-poll C3) over a fake clock, and the desk model under late rows, resets and following (2.3 #23). The worlds
// and the reference server are test/web-v2/desk-world.mjs; expected values come from the world's own draws.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createStepReads } from '../../src/web/v2/replay/follow.mjs'
import { loadBodies, bodyCache } from '../../src/web/v2/replay/cell.mjs'
import { createDesk, applySession, applyLane, laneAsk, readTouched, stepOf, listOf, indexOf, ridAt } from '../../src/web/v2/replay/model.mjs'
import { ctxWindowUnits } from '../../src/web/v2/replay/ctxwin.mjs'
import { buildLanes, anchorLane } from '../../src/web/v2/replay/lanes.mjs'
import { world, readLane } from './desk-world.mjs'

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1)
const fx = JSON.parse(fs.readFileSync(new URL('../fixtures/session-read-contract.json', import.meta.url), 'utf8'))

function rng(seed) { let a = seed >>> 0 || 1; return () => { a = (Math.imul(a ^ (a >>> 15), 0x2c1b3c6d) + 0x6D2B79F5) >>> 0; return a / 4294967296 } }

function clock() {
  let t = 0, seq = 0
  const q = []
  const settle = () => new Promise((r) => setImmediate(r))
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; q.push({ id, at: t + ms, fn }); return id },
    clearTimer: (id) => { const i = q.findIndex((x) => x.id === id); if (i >= 0) q.splice(i, 1) },
    async advance(ms) {
      const end = t + ms
      for (;;) {
        await settle()
        q.sort((a, b) => a.at - b.at || a.id - b.id)
        if (!q.length || q[0].at > end) break
        const x = q.shift(); t = x.at; x.fn()
      }
      t = end; await settle()
    },
  }
}

const laneOf = (desk, rid) => desk.rows.get(rid).lane
const refsOf = (desk, rid) => { const st = stepOf(desk, rid); return st.held ? [...st.reply, ...st.flat.slice(-2)].map((d) => d.ref).filter(Boolean) : [] }

test('A6 (2.3 #25): scrubbing keeps ≤ 1 lane and ≤ 1 block read in flight, asks only for a step rested 100 ms, aborts the left step\'s reads', async () => {
  const seen = { lane: 0, block: 0, aborted: 0, slot: 0 }
  for (const seed of SEEDS) {
    bodyCache.clear()
    const w = world(seed), r = rng(seed), clk = clock(), desk = createDesk()
    applySession(desk, w.full())
    const keys = [...desk.lanes.keys()]
    for (const key of keys.filter((_, i) => i % 2)) await readLane(w.get(), 'S', desk, { lane: key }) // held and unheld lanes
    let target = null, since = -Infinity, prefetching = false, inSlot = false
    const recs = [], slots = []
    const get = (name, p, { signal }) => {
      const kind = name, rec = { kind, p, rid: prefetching ? null : target, signal, end: null }
      const open = recs.filter((x) => x.kind === kind && x.end === null)
      assert.equal(open.length, 0, `seed ${seed}: a second ${kind} read while one is in flight`)
      assert.ok(kind !== 'lane' || !inSlot, `seed ${seed}: a step's lane read while the poll holds the lane slot`)
      if (!prefetching) {
        assert.ok(clk.now() - since >= 100, `seed ${seed}: a ${kind} read ${clk.now() - since} ms after the target moved`)
        if (kind === 'lane') assert.equal(p.lane, laneOf(desk, target), `seed ${seed}: the lane read names the target's lane`)
        else { const mine = new Set(refsOf(desk, target)); for (const ref of p.ref) assert.ok(mine.has(ref), `seed ${seed}: ${ref} is the target step's`) }
      }
      recs.push(rec); seen[kind]++
      return new Promise((res) => {
        const id = clk.setTimer(() => {
          rec.end = clk.now()
          res(kind === 'lane' ? { ok: true, data: w.lane(p.lane, { from: p.from, to: p.to }) }
            : { ok: true, data: { blocks: p.ref.map((ref) => ({ ref, bytes: 'b', encoding: 'utf8', fidelity: 'verbatim', truncated: false })), errors: [] } })
        }, 20 + Math.floor(r() * 280))
        signal.addEventListener('abort', () => { clk.clearTimer(id); rec.end = clk.now(); rec.aborted = true; seen.aborted++; res({ ok: false, status: 0, error: 'cancelled' }) }, { once: true })
      })
    }
    const need = (rid) => {
      if (!stepOf(desk, rid).held) {
        const key = laneOf(desk, rid), rids = desk.laneRids.get(key), i = rids.indexOf(rid)
        return { lane: i < rids.length - 1 ? { lane: key, to: rids[i + 1] } : { lane: key }, refs: [] }
      }
      return { lane: null, refs: refsOf(desk, rid).filter((ref) => !bodyCache.has(ref)) }
    }
    const sr = createStepReads({ get, setTimer: clk.setTimer, clearTimer: clk.clearTimer, need,
      onLane: (rid, a) => { if (a.ok && a.data) applyLane(desk, a.data) }, onBodies: () => {} })
    for (let i = 0; i < 60; i++) {
      if (r() < 0.1) {
        // the poll's own lane reads take the one lane slot: they start only when no step lane read is out, and hold it off
        const hold = 20 + Math.floor(r() * 200)
        slots.push(sr.laneSlot(async () => {
          assert.ok(!recs.some((x) => x.kind === 'lane' && x.end === null), `seed ${seed}: the slot opened over a lane read in flight`)
          inSlot = true; seen.slot++
          await new Promise((res) => clk.setTimer(res, hold))
          inSlot = false
        }))
      } else if (r() < 0.15) { prefetching = true; sr.prefetch(keys[Math.floor(r() * keys.length)]); prefetching = false }
      else {
        const rid = desk.order[Math.floor(r() * desk.order.length)]
        if (rid !== target) since = clk.now()
        target = rid
        sr.target(rid)
        for (const x of recs) if (x.end === null && x.rid !== rid) assert.ok(x.signal.aborted, `seed ${seed}: a read for a left step is aborted`)
      }
      await clk.advance([5, 16, 40, 90, 120, 300][Math.floor(r() * 6)])
    }
    await clk.advance(5000)
    await Promise.all(slots)
    assert.ok(recs.every((x) => x.end !== null), `seed ${seed}: every read ended`)
  }
  for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, `the scrubs include ${k} reads`)
})

test('loadBodies (3.5 block): one read for the refs not held; each item fills by its ref; bytes:null takes its errors entry', async () => {
  bodyCache.clear()
  const [okItem, nullItem] = fx.block_multi.blocks
  const asked = []
  const api = { get: async (name, p) => { asked.push(p.ref); return { ok: true, data: fx.block_multi } } }
  const [a, b, again] = await Promise.all([loadBodies(api, [okItem.ref, nullItem.ref]), loadBodies(api, [nullItem.ref]), loadBodies(api, [okItem.ref])])
  assert.deepEqual(asked, [[okItem.ref, nullItem.ref]], 'one read; needs that meet while it is out share it')
  assert.equal(a[0].status, 'ok'); assert.equal(a[0].text, okItem.bytes)
  assert.notEqual(a[1].status, 'ok')
  assert.equal(a[1].error, fx.block_multi.errors.find((e) => e.where === nullItem.ref).reason)
  assert.deepEqual(b, [a[1]]); assert.deepEqual(again, [a[0]])
  await loadBodies(api, [okItem.ref]); assert.equal(asked.length, 1, 'a held body is not asked again')
})

// Hold every lane of `w` at mark M (session, then each lane whole).
async function heldDesk(w, M) {
  const desk = createDesk()
  applySession(desk, w.full(M))
  for (const key of desk.lanes.keys()) await readLane(w.get(M), 'S', desk, { lane: key })
  return desk
}
const flatOf = (desk, rid) => stepOf(desk, rid).flat?.map((f) => f.bid) ?? null
const snapshot = (desk) => new Map([...desk.held.values()].flatMap((h) => h.rids).map((rid) => [rid, flatOf(desk, rid)]))
function samePlayheads(desk, before, why) {
  for (const [rid, flat] of before) {
    if (!desk.rows.has(rid)) continue // a gone row
    const lane = laneOf(desk, rid)
    assert.equal(ridAt(desk, lane, indexOf(desk, lane, rid)), rid, `${why}: the playhead rid ${rid} still resolves`)
    assert.deepEqual(flatOf(desk, rid), flat, `${why}: ${rid} shows the same blocks`)
  }
}

test('A4/A5 (2.3 #23): a late row before the playhead, and a reset of its lane once the lane lands, leave the playhead and its blocks', async () => {
  let late = 0
  for (const seed of SEEDS) {
    const w = world(seed), m = w.marks
    let M = m[Math.floor(m.length / 3)]
    const desk = await heldDesk(w, M)
    for (let i = m.indexOf(M) + 1; i < m.length; i++) {
      const next = m[i], d = w.since(M, next), before = snapshot(desk)
      late += d.calls.some((c) => !desk.rows.has(c.rid) && [...before.keys()].some((rid) => desk.rows.get(rid)?.lane === c.lane && c.ts < desk.rows.get(rid).ts))
      const { touched } = applySession(desk, d)
      for (const key of touched.keys()) await readLane(w.get(next), 'S', desk, laneAsk(desk, key, touched))
      for (const key of desk.lanes.keys()) if (!desk.held.has(key)) await readLane(w.get(next), 'S', desk, { lane: key })
      samePlayheads(desk, before, `seed ${seed} at ${next}`)
      M = next
    }
    const before = snapshot(desk), { reset, touched } = applySession(desk, w.since('20261021T101500Z:not-a-member'))
    assert.equal(reset, true)
    for (const key of touched.keys()) await readLane(w.get(), 'S', desk, laneAsk(desk, key, touched))
    samePlayheads(desk, before, `seed ${seed} after a reset`)
  }
  assert.ok(late > 0, 'the worlds include late rows before a held step')
})

test('A4/A5 (2.3 #23): following, after a delta and its laneAsk read the newest call holds its reply definitions', async () => {
  for (const seed of SEEDS) {
    const w = world(seed), m = w.marks
    let M = m[Math.floor(m.length / 2)]
    const desk = await heldDesk(w, M)
    for (let i = m.indexOf(M) + 1; i < m.length; i++) {
      const next = m[i], { touched } = applySession(desk, w.since(M, next))
      for (const key of touched.keys()) await readLane(w.get(next), 'S', desk, laneAsk(desk, key, touched))
      for (const key of desk.lanes.keys()) if (!desk.held.has(key)) await readLane(w.get(next), 'S', desk, { lane: key })
      M = next
      const newest = desk.order.at(-1), want = w.lane(laneOf(desk, newest), {}, next).steps.find((s) => s.rid === newest).reply
      const reply = stepOf(desk, newest).reply
      assert.deepEqual(reply.map((d) => d.bid), want, `seed ${seed} ${newest}`)
      for (const d of reply) assert.ok(d.ref, `seed ${seed} ${newest}: ${d.bid} has its definition`)
    }
  }
})

const env = (data) => ({ ok: true, status: 200, data }) // the board api's envelope around a world answer

// the window's units for each anchor step that `rids` names (2.3 §车道未到手: 'frames' = the empty aria-busy boxes)
function unitKeys(desk, rids) {
  const lanes = buildLanes(desk), anchor = anchorLane(lanes), out = new Map()
  anchor.calls.forEach((c, i) => {
    if (!rids.has(c.rid)) return
    const s = { desk, lanes, anchor, playhead: i, diffRef: null, navOpen: new Set(), openBlocks: new Set(), turnFold: new Map(), turnLanded: new Set(), ctx: {}, laneErr: new Map() }
    out.set(c.rid, ctxWindowUnits(s).map((u) => u.key))
  })
  return out
}

test('2.3 §读失败: a lane read that fails after a full or a late-row answer keeps every drawn step; the lane is read on the next call', async () => {
  const seen = { full: 0, delta: 0, partial: 0 }
  for (const seed of SEEDS) {
    const w = world(seed), m = w.marks, r = rng(seed), M = m[Math.floor(m.length / 2)]
    // full: the worker restarted, so `since` answers in full at the same mark (rows unchanged); delta: the next member's rows
    for (const kind of ['full', 'delta']) {
      const at = kind === 'full' ? M : m[m.indexOf(M) + 1], desk = await heldDesk(w, M)
      const before = snapshot(desk), laneWas = new Map([...desk.rows].map(([rid, row]) => [rid, row.lane]))
      const { touched } = applySession(desk, kind === 'full' ? w.since('20261021T101500Z:not-a-member', M) : w.since(M, at))
      if (!touched.size) continue
      seen[kind]++
      // the failure comes after 0-2 good pages when the rows did not change (a partial read then redraws the same steps)
      let good = kind === 'full' ? Math.floor(r() * Math.min(3, touched.size)) : 0 // a whole-lane ask is one tail page: fewer good reads than lanes
      seen.partial += good > 0
      const read = new Set() // lanes a good page answered: those are redrawn from it (a tail page replaces the lane, 3.5)
      const res = await readTouched(desk, touched, async (name, p) => (good-- > 0 ? (read.add(p.lane), env(await w.get(at)(name, p))) : { ok: false, status: 500, error: 'the worker exited' }))
      assert.equal(res.ok, false, `seed ${seed} ${kind}`)
      assert.equal(res.error, 'the worker exited', `seed ${seed} ${kind}: the reason travels`)
      for (const k of touched.keys()) assert.ok(desk.lagging.has(k) || res.done.includes(k), `seed ${seed} ${kind}: ${k} is read again or done`)
      const kept = new Set([...before.keys()].filter((rid) => desk.rows.get(rid)?.lane === laneWas.get(rid) && !read.has(laneWas.get(rid))))
      assert.ok(kept.size, `seed ${seed} ${kind}: some drawn steps are on lanes the failure left`)
      for (const rid of kept) assert.deepEqual(flatOf(desk, rid), before.get(rid), `seed ${seed} ${kind}: ${rid} still shows its blocks`)
      for (const [rid, keys] of unitKeys(desk, kept)) assert.ok(!keys.includes('frames'), `seed ${seed} ${kind}: ${rid} is not empty frames`)
      // the next poll (nothing new) reads the lanes that waited, and they hold the world's lists
      const next = await readTouched(desk, new Map(), async (name, p) => env(await w.get(at)(name, p)))
      assert.equal(next.ok, true); assert.equal(desk.lagging.size, 0, `seed ${seed} ${kind}: nothing waits`)
      for (const k of next.done) for (const rid of desk.held.get(k).rids) assert.deepEqual(listOf(desk, rid), w.list(rid), `seed ${seed} ${kind}: ${rid}`)
    }
  }
  for (const [k, v] of Object.entries(seen)) assert.ok(v > 0, `the worlds include ${k} cases`)
})
