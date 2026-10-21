// test/web-v2/ctxwin-patch.test.mjs — the window patched by bid (2.3 §读与画 · 2.3 #22 · 1.4:114 D64 line): a window patched
// from one step to the next equals the window drawn fresh, and a unit whose key survives with the same html is never re-created.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchUnits, applyOps } from '../../src/web/v2/replay/ctxwin.mjs'

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1)
function rng(seed) { let a = seed >>> 0 || 1; return () => ((a = Math.imul(a ^ (a >>> 13), 0x5bd1e995) + 0x9e3779b9 >>> 0) / 4294967296) }

test('the op algebra: unit lists whose survivors are reordered, re-drawn, re-set and nested patch to the next list', () => {
  for (const seed of SEEDS) {
    const r = rng(seed * 7919), pick = (xs) => xs.filter(() => r() < 0.7).sort(() => r() - 0.5)
    const tree = (depth) => pick(['a', 'b', 'c', 'd', 'e', 'f']).map((key) => ({ key, html: r() < 0.3 ? '<i>x</i>' : '<i>y</i>',
      ...(r() < 0.5 ? { set: { 'data-bi': Math.floor(r() * 3) } } : {}), ...(depth && r() < 0.4 ? { kids: tree(depth - 1) } : {}) }))
    for (let k = 0; k < 40; k++) { const prev = tree(2), next = tree(2); assert.deepEqual(applyOps(prev, patchUnits(prev, next)), next, `seed ${seed}`) }
  }
})
