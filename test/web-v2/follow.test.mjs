// test/web-v2/follow.test.mjs — the replay desk's live-follow policy (replay/follow.mjs): where the playhead lands after a fetch.
// 1.2 §路由: a URL naming a step pins that step (clamped) and opens with 跟随最新 off, even when it is the newest; without one the
// desk follows. The controller (replay.mjs) is covered in the browser (desk-url.test.mjs); this is its pure part.
import test from 'node:test'
import assert from 'node:assert/strict'
import { landPlayhead, packOrder } from '../../src/web/v2/replay/follow.mjs'

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

test('1.2 #13 landPlayhead: a named step pins the clamped step with follow off; without one a follower goes to the last call', () => {
  for (const N of [1, 2, 7, 60]) {
    for (const initialStep of [-3, 0, 1, Math.ceil(N / 2), N - 1, N, N + 1, 999]) {
      for (const follow of [true, false]) {
        const got = landPlayhead({ N, playhead: 0, follow, initialStep })
        assert.equal(got.follow, false, `N=${N} step=${initialStep}`)
        assert.equal(got.playhead, clamp(initialStep - 1, 0, N - 1), `N=${N} step=${initialStep}`)
      }
    }
    for (const playhead of [0, N - 1, N + 5]) {
      for (const follow of [true, false]) {
        const got = landPlayhead({ N, playhead, follow, initialStep: null })
        assert.equal(got.follow, follow)
        assert.equal(got.playhead, follow ? N - 1 : Math.min(playhead, N - 1))
      }
    }
  }
})

// a head over `n` sealed packs of `w` steps each, chapters cut at `cuts`, the open tail after them (3.5 session --head: packs, open, chapters)
function headOf(n, w, cuts, tail = 3) {
  const steps = n * w + tail, packs = Array.from({ length: n }, (_, k) => ({ n: k, s0: k * w, s1: (k + 1) * w, tag: `t${k}` }))
  const ends = [0, ...cuts.filter((c) => c > 0 && c < steps), steps]
  return { steps, packs, open: { n, s0: n * w }, chapters: ends.slice(1).map((s1, k) => ({ k, s0: ends[k], s1 })) }
}

test('2.3 加载器: a head with no sealed pack (with or without an open tail, or no head yet) has nothing for the loader', () => {
  for (const head of [null, { steps: 0, packs: [] }, { steps: 3, packs: [], open: { n: 0, s0: 0 } }, { steps: 0 }])
    for (const at of [null, 0, 2]) assert.deepEqual(packOrder(head, at), [], JSON.stringify({ head, at }))
})

test('2.3 加载器: the playhead\'s pack first, then its neighbours, then its chapter\'s other packs, then the rest newest first; held packs are left out', () => {
  for (const [n, w, cuts] of [[1, 5, []], [6, 4, [9]], [12, 3, [5, 17, 30]], [9, 7, [0, 63]]]) {
    const head = headOf(n, w, cuts)
    for (const at of [null, 0, w - 1, Math.floor(n / 2) * w + 1, n * w - 1, n * w, head.steps - 1]) {
      const order = packOrder(head, at), ns = order.map((x) => x.n)
      assert.deepEqual([...ns].sort((a, b) => a - b), head.packs.map((p) => p.n), `every sealed pack once (n=${n} at=${at})`)
      const tail = at == null || at >= head.open.s0, home = tail ? n : Math.floor(at / w), step = tail ? head.steps - 1 : at
      const ch = head.chapters.find((c) => step >= c.s0 && step < c.s1)
      const cls = (k) => (k === home ? 1 : Math.abs(k - home) === 1 ? 2 : head.packs[k].s0 < ch.s1 && head.packs[k].s1 > ch.s0 ? 3 : 4)
      assert.deepEqual(order.map((x) => x.pri), ns.map(cls), `classes (n=${n} at=${at})`)
      for (let i = 1; i < order.length; i++) {
        assert.ok(order[i - 1].pri <= order[i].pri, `class order (n=${n} at=${at})`)
        if (order[i].pri === order[i - 1].pri && order[i].pri >= 3) assert.ok(order[i - 1].n > order[i].n, `newest first within a class (n=${n} at=${at})`)
      }
      if (!tail) assert.equal(ns[0], home, 'a step in a sealed pack: that pack is the first read (no walk)')
      const held = new Set(ns.filter((_, i) => i % 2))
      assert.deepEqual(packOrder(head, at, (p) => held.has(p.n)).map((x) => x.n), ns.filter((k) => !held.has(k)), 'held packs drop out, the rest keep their order')
    }
  }
})
