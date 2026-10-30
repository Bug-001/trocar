// test/query/warm-budget.test.mjs — the read side's ONE heap budget (RFC 3.5 §内存有界): every cache of a process shares it, room
// is made BEFORE a value is computed, and what is past the whole budget is answered once and never kept.
import test from 'node:test'
import assert from 'node:assert/strict'
import { warmCache, heapBudget, hold } from '../../src/query/warm.mjs'

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
