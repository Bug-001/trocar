// test/web-v2/pricing-load.test.mjs — A-M1: a price table that could not be READ is not a table without the model's price.
// The desk used to ignore a failed /api/pricing; the cell then said 「没有这个模型的单价」 — a claim about the table's
// contents made without ever seeing it (invariant 4). Now the failure is named with its reason and the next poll retries.
// The cost cell moved to replay/stepbar.mjs (2.2: the estimate is shown in ONE place, the ≈ $ button); its words are the RFC's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPricingLoader, PRICING_MS } from '../../src/web/v2/replay/pricing.mjs'
import { backoffMs } from '../../src/web/v2/core/poll.mjs'
import { costCellHtml, priceStateNote } from '../../src/web/v2/replay/stepbar.mjs'
import { costRowHtml } from '../../src/web/v2/replay/detail.mjs'
import { costOf, priceMatch } from '../../src/web/v2/core/metrics.mjs'
import { run as pricingDoc } from '../../src/query/named/pricing.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

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

test('loader: an answer that is ok but not a table is a failure, not an empty table; a table handed in is used as is', async () => {
  for (const data of [null, {}, { pricing: 'x' }, { pricing: null }]) {
    const L = createPricingLoader(async () => ({ ok: true, data })); await L.load()
    assert.equal(L.table(), null, JSON.stringify(data))
  }
  let calls = 0; const L = createPricingLoader(async () => { calls++ }, TABLE)
  assert.equal(await L.load(), false); assert.equal(calls, 0); assert.equal(L.table(), TABLE)
})

test('loader (V01): the server\'s models[] document becomes a table that prices a call; a loaded table is not fetched again', async () => {
  const doc = await pricingDoc({ home: tmpDir(), env: {} }); let calls = 0
  const L = createPricingLoader(async () => { calls++; return { ok: true, status: 200, data: doc } })
  await L.load()
  assert.ok(L.table()); assert.equal(L.err(), null)
  const m = priceMatch(L.table(), doc.models[0].model)
  const usd = costOf(m && m.row, { read: 1e6, create: 0, fresh: 0, out: 0 })
  assert.ok(Number.isFinite(usd) && usd > 0, String(usd))
  await L.load(); assert.equal(calls, 1)
})

test('A8 (4.4 其余 · K-29): a failed price read is retried on the back-off schedule, not on each session poll; a table ends the reads', async () => {
  const fails = [async () => ({ ok: false, status: 500, error: 'HTTP 500' }), async () => { throw new Error('socket hang up') }, async () => ({ ok: true, data: { source: 'x' } })]
  for (const fail of fails) {
    let t = 0, ok = false
    const reads = []
    const L = createPricingLoader(async () => { reads.push(t); return ok ? { ok: true, data: { models: [{ model: 'opus', input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 }] } } : fail() }, null, { now: () => t })
    for (; t <= 200000; t += 1500) await L.load() // the session's 1.5 s ticks
    assert.ok(reads.length > 1, 'a failed read is retried')
    for (let k = 1; k < reads.length; k++) {
      const gap = reads[k] - reads[k - 1], due = backoffMs(k, PRICING_MS)
      assert.ok(gap >= due && gap < due + 1500, `read ${k}: ${gap} ms after the last, due ${due}`)
    }
    assert.ok(L.err())
    ok = true
    await L.load(true); assert.ok(L.table(), 'a reader\'s own action reads at once')
    const n = reads.length
    for (let i = 0; i < 40; i++, t += 1500) await L.load()
    assert.equal(reads.length, n, 'a loaded table is not asked again')
  }
})
