// core.test.mjs — the sequence harness's two pure parts, no browser (runs in `npm test`): ddmin shrinks to a 1-minimal failing list
// and never hands back a list that did not fail; generate() is a pure function of its seed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ddmin } from './shrink.mjs'
import { generate } from './runner.mjs'

// fails iff the list holds an 'x' somewhere before a 'y'
const xBeforeY = async (list) => { const i = list.indexOf('x'); return i >= 0 && list.indexOf('y', i + 1) > i }
const noisy = ['a', 'b', 'x', 'c', 'd', 'e', 'f', 'y', 'g', 'h', 'i']

test('R1 ddmin on a synthetic predicate returns exactly the two steps that matter', async () => {
  assert.deepEqual(await ddmin(noisy, xBeforeY), ['x', 'y'])
})

test('R2 with no trial budget ddmin returns the full failing list, never a passing one', async () => {
  let calls = 0
  const out = await ddmin(noisy, async (l) => { calls++; return xBeforeY(l) }, { maxTrials: 0 })
  assert.deepEqual(out, noisy)
  assert.equal(calls, 0)
  const timed = await ddmin(noisy, xBeforeY, { budgetMs: 0 })
  assert.ok(await xBeforeY(timed))
})

test('R3 generate(seed) is equal across two calls and differs for another seed', () => {
  const a = generate(5, 40, null), b = generate(5, 40, null)
  assert.equal(a.length, 40)
  assert.deepEqual(a, b)
  assert.notDeepEqual(generate(6, 40, null), a)
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a) // a sequence is plain JSON: it saves, replays and shrinks
})
