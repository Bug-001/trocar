// test/web-v2/ctxwin-patch.test.mjs — the window patched by bid (2.3 §读与画 · 2.3 #22 · 1.4:114 D64 line): over generated
// session worlds (desk-world.mjs), a window patched from one step to the next equals the window drawn fresh, a row whose bid
// survives with the same html is never re-created (its DOM and a selection in it stay), and a desk held through deltas draws
// the same window as a desk read whole.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLanes, anchorLane } from '../../src/web/v2/replay/lanes.mjs'
import { ctxWindowUnits, swapGroup } from '../../src/web/v2/replay/ctxwin.mjs'
import { patchUnits, applyOps } from '../../src/web/v2/core/units.mjs'
import { world, deskFrom } from './desk-world.mjs'

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1)
function rng(seed) { let a = seed >>> 0 || 1; return () => ((a = Math.imul(a ^ (a >>> 13), 0x5bd1e995) + 0x9e3779b9 >>> 0) / 4294967296) }

const stateOf = (desk, extra = {}) => {
  const lanes = buildLanes(desk)
  return { desk, lanes, anchor: anchorLane(lanes), playhead: 0, diffRef: null, navOpen: new Set(), openBlocks: new Set(),
    turnFold: new Map(), turnLanded: new Set(), ctx: {}, ...extra }
}
// every op names a key; collect, per level path, which keys an op re-creates
function recreated(ops, path = '', out = new Set()) {
  for (const [op, key, a] of ops) {
    if (op === 'del' || op === 'put') out.add(path + '/' + key)
    if (op === 'kids') recreated(a, path + '/' + key, out)
  }
  return out
}
function untouched(prev, next, path = '', out = []) {
  const P = new Map(prev.map((u) => [u.key, u]))
  for (const u of next) {
    const p = P.get(u.key)
    if (!p) continue
    if (!u.kids && p.html === u.html) out.push(path + '/' + u.key)
    if (u.kids && p.kids) untouched(p.kids, u.kids, path + '/' + u.key, out)
  }
  return out
}

test('A11 (2.3 #22 · 1.4:114): a window patched across random steps equals the fresh window; a surviving row with the same html is never re-created', async () => {
  let kept = 0, moved = 0
  for (const seed of SEEDS) {
    const w = world(seed), desk = await deskFrom(w.get(), 'S'), r = rng(seed)
    for (const lane of buildLanes(desk)) {
      const s = stateOf(desk, { anchor: lane })
      const n = lane.calls.length
      s.playhead = Math.floor(r() * n)
      let prev = ctxWindowUnits(s)
      for (let k = 0; k < 30; k++) {
        // a neighbour most of the time (a scrub), a jump otherwise; the reader opens rows and pins a compare step now and then
        s.playhead = r() < 0.7 ? Math.max(0, Math.min(n - 1, s.playhead + (r() < 0.5 ? -1 : 1))) : Math.floor(r() * n)
        if (r() < 0.3 && s.curKeys && s.curKeys.length) s.openBlocks.add(s.curKeys[Math.floor(r() * s.curKeys.length)])
        if (r() < 0.1) s.diffRef = r() < 0.5 ? null : Math.floor(r() * n)
        const next = ctxWindowUnits(s), ops = patchUnits(prev, next)
        assert.deepEqual(applyOps(prev, ops), next, `seed ${seed} lane ${lane.id} step ${s.playhead}`)
        const re = recreated(ops)
        for (const k of untouched(prev, next)) { assert.ok(!re.has(k), `seed ${seed}: ${k} kept its html but was re-created`); kept++ }
        moved += ops.filter((o) => o[0] === 'set').length
        prev = next
      }
    }
  }
  assert.ok(kept > 0 && moved > 0, 'the walks cover surviving rows, some of them at a new position')
  // the op algebra on its own axis: unit lists whose survivors are reordered, re-drawn, re-set and nested
  for (const seed of SEEDS) {
    const r = rng(seed * 7919), pick = (xs) => xs.filter(() => r() < 0.7).sort(() => r() - 0.5)
    const tree = (depth) => pick(['a', 'b', 'c', 'd', 'e', 'f']).map((key) => ({ key, html: r() < 0.3 ? '<i>x</i>' : '<i>y</i>',
      ...(r() < 0.5 ? { set: { 'data-bi': Math.floor(r() * 3) } } : {}), ...(depth && r() < 0.4 ? { kids: tree(depth - 1) } : {}) }))
    for (let k = 0; k < 40; k++) { const prev = tree(2), next = tree(2); assert.deepEqual(applyOps(prev, patchUnits(prev, next)), next, `seed ${seed}`) }
  }
})

// 2.3 #28 (§读与画「长对话的窗口」): long lists that form several groups per card, cards folded and opened by the reader, groups
// drawn a few at a time — a patch from any step to any step equals the direct paint, and a partly drawn window patched to the
// full draw equals it (the fill's end state)
test('2.3 #28: with groups — patched from step to step and from partly drawn to fully drawn, the window equals the direct paint', async () => {
  let multi = 0
  for (const seed of SEEDS.slice(0, 6)) {
    const w = world(seed, { calls: 240, page: 240, talk: { pre: 12, len: 520, every: seed % 2 ? 40 : 160, tail: seed % 3 ? 0 : 300 } })
    const desk = await deskFrom(w.get(), 'S'), r = rng(seed)
    const lane = buildLanes(desk).find((l) => l.calls.length > 20), n = lane.calls.length
    const s = stateOf(desk, { anchor: lane, playhead: n - 1 })
    let prev = ctxWindowUnits(s, { all: true })
    for (let k = 0; k < 40; k++) {
      s.playhead = r() < 0.6 ? Math.max(0, Math.min(n - 1, s.playhead + (r() < 0.5 ? -1 : 1))) : Math.floor(r() * n)
      const part = ctxWindowUnits(s, { focus: Math.floor(r() * 600) }) // the step's own paint: some groups are placeholders
      if (r() < 0.3) for (const u of part.filter((x) => x.key.startsWith('q:'))) s.turnFold.set(u.html.match(/data-anchor="([^"]*)"/)[1], r() < 0.5)
      if (r() < 0.3 && s.curKeys.length) s.openBlocks.add(s.curKeys[Math.floor(r() * s.curKeys.length)])
      const next = ctxWindowUnits(s, { all: true })
      assert.deepEqual(applyOps(prev, patchUnits(prev, next)), next, `seed ${seed} step ${s.playhead}: step to step`)
      const mid = ctxWindowUnits(s, { focus: Math.floor(r() * 600) })
      assert.deepEqual(applyOps(mid, patchUnits(mid, next)), next, `seed ${seed} step ${s.playhead}: partly drawn to full`)
      for (const u of next) if (u.kids && u.kids.filter((g) => g.html.startsWith('<div class="cwgroup"')).length > 1) multi++
      prev = next
    }
  }
  assert.ok(multi > 0, 'the walks cover cards whose rows form several groups')
})

// 2.3 §读与画「长对话的窗口」 rule 4: a task draws one group or puts one back to its placeholder — its ops re-create that group
// alone, they turn the window into the one swapGroup returns, and once every placeholder is filled the window equals the full draw
test('2.3 #28: each fill or drop changes one group with ops on that group alone; filled to the end, the window equals the full draw', async () => {
  let filled = 0
  for (const seed of SEEDS.slice(0, 4)) {
    const w = world(seed, { calls: 240, page: 240, talk: { pre: 12, len: 520, every: seed % 2 ? 40 : 160, tail: seed % 3 ? 0 : 300 } })
    const desk = await deskFrom(w.get(), 'S'), r = rng(seed)
    const lane = buildLanes(desk).find((l) => l.calls.length > 20), n = lane.calls.length
    for (let k = 0; k < 6; k++) {
      const s = stateOf(desk, { anchor: lane, playhead: n - 1 - Math.floor(r() * 40) })
      for (const u of ctxWindowUnits(s).filter((x) => x.key.startsWith('q:'))) s.turnFold.set(u.html.match(/data-anchor="([^"]*)"/)[1], r() < 0.7)
      let units = ctxWindowUnits(s, { focus: Math.floor(r() * 600) })
      const holders = (us) => us.flatMap((u) => (u.html.includes('aria-busy') ? [u.key] : u.kids ? holders(u.kids) : []))
      const drawn = (us) => us.flatMap((u) => (u.html.startsWith('<div class="cwgroup"') && u.kids ? [u.key] : u.kids ? drawn(u.kids) : []))
      for (let left = holders(units), drops = 8; left.length; left = holders(units)) {
        const back = drops > 0 && r() < 0.3 && drawn(units).length, pool = back ? drawn(units) : left, key = pool[Math.floor(r() * pool.length)]
        if (back) drops--
        const [next, ops] = swapGroup(units, s, key, !back)
        assert.deepEqual([...recreated(ops)].map((x) => x.split('/').at(-1)), [key], `seed ${seed}: the ops touch group ${key} alone`)
        assert.deepEqual(applyOps(units, ops), next, `seed ${seed}: the ops make the returned window`)
        units = next; filled++
      }
      assert.deepEqual(units, ctxWindowUnits(s, { all: true }), `seed ${seed} step ${s.playhead}: filled to the end = the full draw`)
    }
  }
  assert.ok(filled > 0, 'the walks fill placeholders')
})
