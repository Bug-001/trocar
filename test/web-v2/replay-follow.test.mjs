// test/web-v2/replay-follow.test.mjs — a step's own reads (replay/follow.mjs createStepReads, cell.mjs loadBodies; 2.3 §读与画
// 快速拖动, 4.4 live-poll C3) over a fake clock, and the desk model under late rows, resets and following (2.3 #23). The worlds
// and the reference server are test/web-v2/desk-world.mjs; expected values come from the world's own draws.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createStepReads } from '../../src/web/v2/replay/follow.mjs'
import { loadBodies, bodyCache } from '../../src/web/v2/replay/cell.mjs'
import { createDesk, applySession, applyLane, stepOf, indexOf } from '../../src/web/v2/replay/model.mjs'
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

test('2.3 #25: scrubbing keeps ≤ 1 lane and ≤ 1 block read in flight, asks only for a step rested 100 ms, aborts the left step\'s reads', async () => {
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
