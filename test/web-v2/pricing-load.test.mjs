// test/web-v2/pricing-load.test.mjs — A-M1: a price table that could not be READ is not a table without the model's price.
// The desk used to ignore a failed /api/pricing; the cell then said 「没有这个模型的单价」 — a claim about the table's
// contents made without ever seeing it (invariant 4). Now the failure is named with its reason and the next poll retries.
// The cost cell moved to replay/stepbar.mjs (2.2: the estimate is shown in ONE place, the ≈ $ button); its words are the RFC's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPricingLoader } from '../../src/web/v2/replay/pricing.mjs'
import { costCellHtml, priceStateNote } from '../../src/web/v2/replay/stepbar.mjs'
import { costRowHtml } from '../../src/web/v2/replay/detail.mjs'

const U = { read: 1e6, create: 0, fresh: 0, out: 0 }, TABLE = { opus: [15, 75, 18.75, 1.5] }

test('cost cell: a failed price read passes its reason through, escaped; the cost is unknown, never $0', () => {
  const h = costCellHtml('claude-opus-4-5', U, null, 'HTTP 500 <b>x</b>')
  assert.match(h, /HTTP 500 &lt;b&gt;x&lt;\/b&gt;/); assert.ok(!/<b>x<\/b>/.test(h))
  assert.ok(!/\$0/.test(h), 'the cost itself is unknown, never $0'); assert.ok(!/n\/a/.test(h))
})
test('cost cell: a table that did load wins over an old error', () => {
  assert.match(costCellHtml('opus', U, TABLE, 'stale error'), /\$1\.50/, 'a table that did load wins over an old error')
})
test('drawer cost row passes the read failure through', () => {
  const c = { usage: { read: 1, create: 1, fresh: 1, out: 1 }, rec: { request: { model: 'm' } } }
  assert.match(costRowHtml(c, null, 'HTTP 502'), /HTTP 502/)
})
test('priceStateNote: empty when the table is loaded; the reason when the read failed', () => {
  assert.equal(priceStateNote(TABLE, null), ''); assert.equal(priceStateNote(TABLE, 'old'), '')
  assert.match(priceStateNote(null, 'HTTP 500'), /HTTP 500/)
})

test('loader: a failed read keeps the reason and the NEXT load retries; a table that arrives clears the reason; a loaded table is never fetched again', async () => {
  const answers = [{ ok: false, status: 503, error: 'HTTP 503' }, { ok: true, data: { pricing: TABLE } }]; let calls = 0
  const L = createPricingLoader(async () => answers[calls++])
  assert.equal(L.table(), null); assert.equal(L.err(), null)
  assert.equal(await L.load(), true); assert.equal(L.table(), null); assert.equal(L.err(), 'HTTP 503')
  assert.equal(await L.load(), true); assert.deepEqual(L.table(), TABLE); assert.equal(L.err(), null); assert.equal(calls, 2)
  assert.equal(await L.load(), false); assert.equal(calls, 2, 'loaded: no more requests')
})
test('loader: the same failure again is not a change (the raw panel is not repainted every poll); a throw is a failure with its message; overlap does not double-fetch', async () => {
  let calls = 0
  const L = createPricingLoader(async () => { calls++; return { ok: false, error: 'HTTP 500' } })
  assert.equal(await L.load(), true); assert.equal(await L.load(), false); assert.equal(L.err(), 'HTTP 500'); assert.equal(calls, 2)
  const T = createPricingLoader(async () => { throw new Error('socket hang up') })
  assert.equal(await T.load(), true); assert.equal(T.err(), 'socket hang up')
  let n = 0, release; const gate = new Promise((r) => { release = r })
  const B = createPricingLoader(async () => { n++; await gate; return { ok: true, data: { pricing: TABLE } } })
  const a = B.load(), b = B.load(); release(); assert.deepEqual(await Promise.all([a, b]), [true, false]); assert.equal(n, 1)
})
test('loader: an answer that is ok but not a table is a failure, not an empty table; a table handed in is used as is', async () => {
  for (const data of [null, {}, { pricing: 'x' }, { pricing: null }]) {
    const L = createPricingLoader(async () => ({ ok: true, data })); await L.load()
    assert.equal(L.table(), null, JSON.stringify(data))
  }
  let calls = 0; const L = createPricingLoader(async () => { calls++ }, TABLE)
  assert.equal(await L.load(), false); assert.equal(calls, 0); assert.equal(L.table(), TABLE)
})
