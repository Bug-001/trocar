// test/web-v2/strip-layout.test.mjs — 1.3 acceptance 21: the strip's one coordinate source, over generated chapter tables
// (part lengths 1..600, part counts 1..300, W 20..3000, uniform and skewed) with a real session's shape as a regression seed.
// Every expected value comes from the layout rules; asserted on numbers only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { stripLayout, PART_MIN, PART_GAP, PART_HIT } from '../../web/src/screens/replay/strip.mjs'

const EPS = 1e-6
const REAL = [184, 249, 261, 411, 435, 382, 399, 522, 480, 414, 291, 319, 401, 281, 254, 227, 434, 420, 207, 352, 171, 222, 135, 139, 161, 82, 271, 43]

let seed = 11
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 2147483648 * n) }
const uniform = () => 1 + rnd(600)
const skewed = () => (rnd(3) ? 1 + rnd(3) : 300 + rnd(301))
const chaptersOf = (lens, first = 0) => { let s = first; return lens.map((l) => ({ s0: s, s1: (s += l) })) }
const fits = (n) => n * PART_MIN + (n - 1) * PART_GAP

function cases() {
  const out = [[[1], 20], [[1], 3000], [[600], 37.5], [[1, 1], 20], [[1, 600, 1], 120], [[600, 1, 600], 300], [[600, 2, 3, 600], 300]]
  for (const W of [800, 1000, 1280]) out.push([REAL, W])
  for (let t = 0; t < 60; t++) {
    const n = 1 + rnd(300), lens = Array.from({ length: n }, t % 2 ? uniform : skewed)
    out.push([lens, 20 + rnd(2981)])
    if (fits(n) >= 20 && fits(n) <= 3000) out.push([lens, fits(n)])                 // the last width blocks fit
    if (fits(n) > 20 && fits(n) <= 3001) out.push([lens, fits(n) - 1])              // the first width they do not
  }
  return out.map(([lens, W]) => {
    const chapters = chaptersOf(lens, rnd(2) ? 0 : rnd(5000))
    return { lens, W, chapters, first: chapters[0].s0, end: chapters.at(-1).s1, L: stripLayout(chapters, W), why: `${lens.length} parts over ${W}px` }
  })
}
const CASES = cases()
const width = (p) => p.x1 - p.x0
const centre = (p) => (p.x0 + p.x1) / 2
const near = (a, b, why) => assert.ok(Math.abs(a - b) < EPS, `${a} vs ${b}: ${why}`)

test('1.3 · 21: ticks exactly when blocks do not fit; blocks are at least the minimum, one gap apart, proportional, and fill W', () => {
  let blocks = 0, ticks = 0
  for (const { lens, W, chapters, L, why } of CASES) {
    const n = lens.length
    assert.equal(L.ticks, fits(n) > W, why)
    assert.equal(L.W, W, why)
    assert.deepEqual(L.parts.map((p) => [p.s0, p.s1]), chapters.map((c) => [c.s0, c.s1]), why)
    near(L.parts[0].x0, 0, why)
    near(L.parts.at(-1).x1, W, why)
    if (L.ticks) { ticks++; continue }
    blocks++
    L.parts.forEach((p, i) => {
      assert.ok(width(p) >= PART_MIN - EPS, why)
      if (i) near(p.x0 - L.parts[i - 1].x1, PART_GAP, why)
    })
    near(L.parts.reduce((sum, p) => sum + width(p), 0) + (n - 1) * PART_GAP, W, why)
    // above the minimum every part has the same px per step, and that rate would have left each minimum part under the minimum
    const free = L.parts.map((p, i) => [width(p), lens[i]]).filter(([w]) => w > PART_MIN + EPS)
    if (!free.length) continue
    const rate = free[0][0] / free[0][1]
    for (const [w, len] of free) near(w / len, rate, why)
    L.parts.forEach((p, i) => { if (width(p) <= PART_MIN + EPS) assert.ok(lens[i] * rate <= PART_MIN + EPS, why) })
  }
  assert.ok(blocks && ticks)
})

test('1.3 · 21: xOf and stepOf invert each other; gaps go to the next part\'s first step; both clamp outside', () => {
  for (const { W, first, end, L, why } of CASES) {
    near(L.xOf(first), 0, why)
    assert.equal(L.xOf(end), W, why)
    assert.equal(L.xOf(first - 3), 0, why)
    assert.equal(L.xOf(end + 3), W, why)
    assert.equal(L.stepOf(-5), first, why)
    assert.equal(L.stepOf(W + 5), end, why)
    L.parts.forEach((p, i) => {
      for (const g of [p.s0, p.s1 - 1, p.s0 + rnd(p.s1 - p.s0), p.s0 + (p.s1 - p.s0) * (rnd(1000) / 1000)]) near(L.stepOf(L.xOf(g)), g, `step ${g}: ${why}`)
      for (const x of [p.x0, centre(p), p.x0 + width(p) * (rnd(1000) / 1000)]) near(L.xOf(L.stepOf(x)), x, `x ${x}: ${why}`)
      if (i && !L.ticks) near(L.stepOf((L.parts[i - 1].x1 + p.x0) / 2), p.s0, why)
    })
  }
})

test('1.3 · 21: xOf rises strictly with the step, and a longer part is never narrower than a shorter one', () => {
  for (const { first, end, L, why } of CASES) {
    const steps = [first, end]
    for (const p of L.parts) steps.push(p.s0, p.s0 + 0.25, p.s1 - 0.25, p.s1 - 1, p.s0 + rnd(p.s1 - p.s0))
    const sorted = [...new Set(steps)].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i++) assert.ok(L.xOf(sorted[i]) > L.xOf(sorted[i - 1]), `${sorted[i - 1]} to ${sorted[i]}: ${why}`)
    const bySteps = [...L.parts].sort((a, b) => (a.s1 - a.s0) - (b.s1 - b.s0))
    for (let i = 1; i < bySteps.length; i++) assert.ok(width(bySteps[i]) >= width(bySteps[i - 1]) - EPS, why)
  }
})

test('1.3 · 21: in ticks mode x is linear in steps', () => {
  let seen = 0
  for (const { W, first, end, L, why } of CASES) {
    if (!L.ticks) continue
    seen++
    for (let t = 0; t < 200; t++) {
      const g = first + (end - first) * (rnd(10000) / 10000)
      near(L.xOf(g) / W, (g - first) / (end - first), why)
    }
    for (const p of L.parts) near(L.xOf(p.s0) / W, (p.s0 - first) / (end - first), why)
  }
  assert.ok(seen)
})

test('1.3 · 21: hit lands on the part that owns x, on a step of that part; a narrow part owns its 8 px', () => {
  let owned = 0
  for (const { W, L, why } of CASES) {
    L.parts.forEach((p, k) => assert.equal(L.hit(centre(p)).k, k, `centre of ${k}: ${why}`))
    for (let t = 0; t < 400; t++) {
      const x = -10 + (W + 20) * (rnd(100000) / 100000), { k, g } = L.hit(x), p = L.parts[k]
      assert.ok(Number.isInteger(g) && g >= p.s0 && g < p.s1, `${g} in ${k}: ${why}`)
      if (x >= p.x0 && x < p.x1) assert.equal(g, Math.floor(L.stepOf(x)), why)
    }
    L.parts.forEach((p, k) => {
      const q = L.parts[k + 1]
      if (!q) return
      const pn = width(p) < PART_HIT, qn = width(q) < PART_HIT
      const edge = pn && qn ? (centre(p) + centre(q)) / 2 : pn ? centre(p) + PART_HIT / 2 : qn ? centre(q) - PART_HIT / 2 : null
      assert.equal(L.hit((edge ?? p.x1) - 1e-5).k, k, why)       // two wide parts meet somewhere in their gap
      assert.equal(L.hit((edge ?? q.x0) + 1e-5).k, k + 1, why)
    })
    L.parts.forEach((p, k) => {
      const a = L.parts[k - 1], b = L.parts[k + 1]
      if (!a || !b || width(p) >= PART_HIT || width(a) < PART_HIT || width(b) < PART_HIT) return
      owned++
      let hits = 0
      const step = 1 / 16
      for (let x = centre(p) - PART_HIT; x < centre(p) + PART_HIT; x += step) if (L.hit(x).k === k) hits++
      assert.ok(Math.abs(hits * step - PART_HIT) <= step, why)
    })
  }
  assert.ok(owned)
})
