// test/query/warm-budget.test.mjs — the read side's ONE heap budget (RFC 3.5 §内存有界): every cache of a process shares it, room
// is made BEFORE a value is computed, and what is past the whole budget is answered once and never kept.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { warmCache, heapBudget, hold, heapFlags, workerEnv, WORKER_MEMORY_MB } from '../../src/query/warm.mjs'

const cost = (v) => v.cost

test('3.5 §内存有界: two caches share one budget, and room is made before the compute runs, least recently used first', () => {
  const B = heapBudget()
  const a = warmCache({ cost }), b = warmCache({ cost })
  a.get('old', 1, () => ({ cost: B * 0.4 }))
  a.get('used', 1, () => ({ cost: B * 0.4 }))
  a.peek('used', 1) // more recently used than `old`
  let seenInCompute
  b.get('new', 1, () => { seenInCompute = [a.peek('old', 1), a.peek('used', 1)].map(Boolean); return { cost: B * 0.4 } }, B * 0.4)
  assert.deepEqual(seenInCompute, [false, true], 'the least recently used entry of ANOTHER cache gave way before the compute ran')
  assert.ok(b.peek('new', 1) && a.peek('used', 1), 'what fits is kept')
})

test('3.5 §内存有界: a value past the whole budget is answered once and never kept; a held working set pushes the caches out', () => {
  const B = heapBudget()
  const c = warmCache({ cost })
  let runs = 0
  const big = () => (runs++, { cost: B * 2 })
  assert.equal(c.get('big', 1, big, B * 2).cost, B * 2, 'answered')
  c.get('big', 1, big, B * 2)
  assert.equal(runs, 2, 'never remembered, so computed again')
  c.get('kept', 1, () => ({ cost: B * 0.5 }))
  const release = hold(B * 0.6)
  assert.equal(c.peek('kept', 1), undefined, 'a query in flight made room for itself before it was built')
  c.get('during', 1, () => ({ cost: B * 0.5 }))
  assert.equal(c.peek('during', 1), undefined, 'and nothing kept while it is held grows into its room')
  release()
  c.get('after', 1, () => ({ cost: B * 0.5 }))
  assert.ok(c.peek('after', 1), 'released, the room is the caches\' again')
})

// The budget and the ceiling are shares of the heap the process can use, both generations (heapFlags: V8's heap_size_limit is then
// the whole heap). A process of the heap the service gives its worker, at two sizes, holds live data past its ceiling without dying:
// started with --max-old-space-size instead, its limit counts a 48 MB young generation on top of its old space, and at these sizes
// the ceiling (three quarters of that) is past the old space, so it dies of the heap before the ceiling stops anything.
const FILL = `
const { heapCeiling, heapBudget, liveHeap } = await import(${JSON.stringify(new URL('../../src/query/warm.mjs', import.meta.url).href)})
const keep = []
while (liveHeap() <= heapCeiling()) for (let i = 0; i < 2; i++) keep.push(new Array(1 << 17).fill(i + 0.5)) // 1 MB each
console.log(JSON.stringify({ live: liveHeap(), ceiling: heapCeiling(), budget: heapBudget() }))`
for (const mb of [96, 128]) {
  test(`3.5 §内存有界: a ${mb} MB heap as the worker is given one holds live data past its ceiling without dying`, () => {
    const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
    let out
    try {
      out = JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, ...heapFlags(mb), '--input-type=module', '-e', FILL], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    } catch (e) {
      assert.fail(`a ${mb} MB heap died before its ceiling (exit ${e.status}): ${String(e.stderr).split('\n').find((l) => /FATAL/.test(l)) || ''}`)
    }
    assert.ok(out.budget < out.ceiling && out.ceiling <= mb * 1048576, JSON.stringify(out))
  })
}

// The worker inherits the daemon's environment (the Windows login task carries the user's NODE_OPTIONS into it), and V8 lets an
// inherited --max-old-space-size override --max-heap-size: the worker forked as the service forks it keeps its own heap anyway.
for (const opts of ['--max-old-space-size=8192', '--max-old-space-size=64 --max-semi-space-size=64', '--max_old_space_size=8192 --no-warnings',
  '--max-old-space-size-percentage=50', '--max-old-space-size="8192"']) {
  test(`3.5 §内存有界: a worker forked under NODE_OPTIONS=${opts} has the heap the service gives it`, () => {
    const limit = execFileSync(process.execPath, [...heapFlags(), '-e', 'console.log(require("v8").getHeapStatistics().heap_size_limit)'],
      { encoding: 'utf8', env: workerEnv({ ...process.env, NODE_OPTIONS: opts }) })
    assert.equal(Number(limit), WORKER_MEMORY_MB * 1048576)
  })
}

test('3.5 §内存有界 · ⑤: the worker\'s environment has no NODE_OPTIONS key in any case, keeps every other key and turns the allocator\'s large-block cache off', () => {
  assert.deepEqual(workerEnv({ Node_Options: 'x', NODE_OPTIONS: 'y', A: '1', MallocLargeCache: '1' }), { A: '1', MallocLargeCache: '0' })
})
