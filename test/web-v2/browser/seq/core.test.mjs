// core.test.mjs — the sequence harness's pure parts, no browser (runs in `npm test`): ddmin shrinks to a 1-minimal failing list
// and never hands back a list that did not fail; generate() is a pure function of its seed and the default seeds draw every action
// kind; a violation's key tells two bugs of one `<id>:<screen>` apart but not two runs of one bug; a saved regression's replay
// counts by its status; a timing invariant is saved whole (status `timing`), never shrunk.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ddmin } from './shrink.mjs'
import fs from 'node:fs'
import { generate, keyOf, replayTodo, replayFailure, findOne, DEFAULT_SEEDS, DEFAULT_STEPS } from './runner.mjs'
import { ACTIONS } from './actions.mjs'
import { fingerprint, TIMING } from './invariants.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

// fails iff the list holds an 'x' somewhere before a 'y'
const xBeforeY = async (list) => { const i = list.indexOf('x'); return i >= 0 && list.indexOf('y', i + 1) > i }
const noisy = ['a', 'b', 'x', 'c', 'd', 'e', 'f', 'y', 'g', 'h', 'i']

test('ddmin on a synthetic predicate returns exactly the two steps that matter', async () => {
  assert.deepEqual(await ddmin(noisy, xBeforeY), ['x', 'y'])
})

test('with no trial budget ddmin returns the full failing list, never a passing one', async () => {
  let calls = 0
  const out = await ddmin(noisy, async (l) => { calls++; return xBeforeY(l) }, { maxTrials: 0 })
  assert.deepEqual(out, noisy)
  assert.equal(calls, 0)
  const timed = await ddmin(noisy, xBeforeY, { budgetMs: 0 })
  assert.ok(await xBeforeY(timed))
})

test('generate(seed) is equal across two calls and differs for another seed', () => {
  const n = 40, a = generate(5, n, null), b = generate(5, n, null)
  assert.equal(a.length, n)
  assert.deepEqual(a, b)
  assert.notDeepEqual(generate(6, n, null), a)
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a) // a sequence is plain JSON: it saves, replays and shrinks
})

test('two runs of one bug share a key; another bug of the same invariant and screen does not', () => {
  const v = (detail) => ({ sig: 'I-pageerror:replay', fp: fingerprint(detail) })
  const a = "TypeError: Cannot read properties of null (reading 'x') at 1712 ms | TypeError: second"
  assert.equal(keyOf(v(a)), keyOf(v(a.replace('1712', '33').replace('second', 'other'))), 'numbers and later items are not identity')
  assert.notEqual(keyOf(v(a)), keyOf(v('RangeError: Maximum call stack size exceeded')))
  assert.notEqual(keyOf(v(a)), keyOf({ sig: 'I-console:replay', fp: fingerprint(a) }))
})

test('every action kind occurs in generate(seed) over the default seeds (a weight table that never draws a row tests nothing with it)', () => {
  const drawn = new Set(DEFAULT_SEEDS.flatMap((seed) => generate(seed, DEFAULT_STEPS, null).map((s) => s.a)))
  assert.deepEqual(ACTIONS.map((x) => x.a).filter((a) => !drawn.has(a)), [])
})

test('a fixed regression whose replay meets its own key fails; open and flaky ones are todo, never red', () => {
  const reg = { name: 'I-url-replay-4', sig: 'I-url:replay', fp: fingerprint('step=# while step # is shown'), status: 'fixed' }
  const met = { violation: { sig: reg.sig, fp: reg.fp, step: 3, detail: 'step=2 while step 1 is shown', screenshot: 'x.png' } }
  assert.equal(replayTodo(reg), false)
  assert.ok(replayFailure(reg, met))
  assert.equal(replayFailure(reg, {}), null)
  for (const status of ['open', 'flaky']) assert.ok(replayTodo({ ...reg, status }))
  assert.equal(replayTodo({ ...reg, status: 'new' }), false)
})

test('findOne shrinks a reproduced I-url or I-mem (an element count) to its one cause but saves a reproduced timing one (I-longtask, I-follow, I-heap) whole, after one trial', async () => {
  const steps = ['a', 'b', 'x', 'c', 'd', 'e'].map((a) => ({ a, p: {} }))
  for (const id of ['I-longtask', 'I-follow', 'I-heap']) assert.ok(TIMING.has(id), `${id} is judged against a time line`)
  for (const [id, want] of [['I-url', [steps[2]]], ['I-mem', [steps[2]]], ...[...TIMING].map((id) => [id, steps.slice(0, 5)])]) {
    const v = { id, sig: `${id}:replay`, fp: fingerprint('d'), step: 4, detail: 'd', screenshot: 'x.png' }
    // a trial fails with v's key exactly when its list still holds step 'x'
    const run = async ({ steps: sub }) => (sub.some((s) => s.a === 'x') ? { violation: { sig: v.sig, fp: v.fp } } : {})
    const dir = tmpDir()
    const reg = await findOne(v, steps, { seed: 9, viewport: 1280, theme: 'light' }, { run, dir })
    const saved = JSON.parse(fs.readFileSync(reg.file, 'utf8'))
    assert.deepEqual(saved.steps, want, id)
    assert.equal(saved.status, TIMING.has(id) ? 'timing' : 'new')
    if (TIMING.has(id)) assert.equal(reg.trials, 1)
    assert.equal(keyOf(saved), keyOf(v))
  }
})
