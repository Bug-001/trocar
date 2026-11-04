// test/query/overview-cost.test.mjs — overview's cost, hit and models without a price (RFC 3.5 acceptance #47; 1.7 §估价规则; 1.6 C.5 `overview`).
// Each world is its calls' usage sidecar: real records index the segment, then the call lines carry the facts a case needs, in the
// sidecar's own format. Prices come from a temporary pricing.json, and every expected value below is worked out by hand from them.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rawHome, writeSegment } from './raw-home.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { runQuery, OVERVIEW_USAGE_BYTES } from '../../src/query/named/index.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'
import { fillUsage, usageFile } from '../../src/query/usage.mjs'

const SEG = '20261018T100000Z', LATER = '20261018T110000Z'
const at = (s) => new Date(Date.parse('2026-10-18T10:00:00.000Z') + s * 1000).toISOString()
const NOBODY = 'zz-nobody-prices-this'
const SEED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/old-capture-resp-shapes.ndjson'), 'utf8').split('\n')[0])
const SID_HEADER = Object.keys(SEED.req_headers).find((k) => /session-id$/.test(k))
/** A captured model call, restamped: its time, id, session and harness (`harness: null` = no process identified it). */
const wire = (s, session, harness, over = {}) => JSON.stringify({ ...SEED, ts: at(s), ts_request: at(s), id: `r-${s}`, req_headers: { ...SEED.req_headers, [SID_HEADER]: session, 'x-session-id': session },
  proc: harness ? { pid: 7, exe: '/x', agent: harness } : undefined, ...over })
// $/Mtok: [input, output, cache_write, cache_read]
const PRICES = { 'm-a': [1, 2, 3, 4], 'fam-b': [10, 20, 30, 40] }

/** A call of session `s`: its sidecar facts, with `u` = [input, output, cache_read, cache_write]. */
const call = (s, model, lane, u, o = {}) => ({ s, model, lane, usage: u, failed: false, cache_known: true, harness: 'claude-code', ...o })

async function homeWith(calls) {
  const home = rawHome()
  writeSegment(home, SEG, calls.map((c, i) => wire(i, c.s, c.harness)))
  await segmentIndex({ home, segment: SEG, owner: true })
  await fillUsage({ home, segments: [SEG] })
  const file = usageFile(home, SEG)
  const mark = fs.readFileSync(file, 'utf8').trim().split('\n').at(-1)
  const lines = calls.map(({ model, lane, failed, cache_known, usage }, i) => JSON.stringify({ line: i + 1, lane, model, failed, cache_known, usage }))
  fs.writeFileSync(file, `${[...lines, mark].join('\n')}\n`)
  return home
}
function overview(home, prices = PRICES) {
  const file = path.join(tmpDir('trocar-cost-'), 'pricing.json')
  fs.writeFileSync(file, JSON.stringify(prices))
  return runQuery('overview', {}, { home, env: { TROCAR_PRICING: file } }).then((doc) => ({ ...doc, file }))
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`)

test('3.5 #47 cost: two models, main and subagent, by hand; a key match says exact:false', async () => {
  const home = await homeWith([
    call('s', 'm-a', 'main', [1000, 200, 3000, 400]),
    call('s', 'm-a', 'main', [500, 0, 1000, 100]),
    call('s', 'm-a', 'subagent', [100, 50, 0, 0]),
    call('s', 'vendor-fam-b-v2', 'main', [2000, 100, 0, 0]),
  ])
  const { usage, file } = await overview(home)
  const row = (model, lane) => usage.rows.find((r) => r.model === model && r.lane === lane)
  // 1500·1 + 200·2 + 500·3 + 4000·4 = 19400
  near(row('m-a', 'main').usd, 0.0194)
  assert.deepEqual(row('m-a', 'main').price, { key: 'm-a', exact: true })
  // 100·1 + 50·2 = 200
  near(row('m-a', 'subagent').usd, 0.0002)
  // 2000·10 + 100·20 = 22000
  near(row('vendor-fam-b-v2', 'main').usd, 0.022)
  assert.deepEqual(row('vendor-fam-b-v2', 'main').price, { key: 'fam-b', exact: false })
  near(usage.cost.usd, 0.0416)
  assert.deepEqual({ ...usage.cost, usd: 0 }, { usd: 0, floor: false, no_usage: 0, unpriced: 0, partial: false })
  assert.deepEqual(usage.unpriced, [])
  assert.deepEqual(usage.pricing, { source: file })
})

test('3.5 #47 unknown: a call with no usage makes the sum a floor and is counted', async () => {
  const home = await homeWith([call('s', 'm-a', 'main', [1000, 0, 0, 0]), call('s', 'm-a', 'main', null), call('s', 'm-a', 'subagent', null)])
  const { cost } = (await overview(home)).usage
  near(cost.usd, 0.001)
  assert.equal(cost.floor, true)
  assert.equal(cost.no_usage, 2)
})

test('3.5 #47 unknown: rows with no price → usd null, never 0, and the models are named with their sessions', async () => {
  const home = await homeWith([
    call('s1', NOBODY, 'main', [1000, 0, 0, 0]),
    call('s2', NOBODY, 'main', [1000, 0, 0, 0]),
    call('s1', NOBODY, 'subagent', [1000, 0, 0, 0]),
    call('s3', null, 'main', [1000, 0, 0, 0]),
  ])
  const { usage } = await overview(home)
  assert.equal(usage.cost.usd, null)
  assert.equal(usage.cost.floor, true)
  assert.equal(usage.cost.unpriced, 3)
  for (const r of usage.rows) { assert.equal(r.usd, null); assert.equal(r.price, null) }
  assert.deepEqual(usage.unpriced, [{ model: NOBODY, sessions: 2 }, { model: null, sessions: 1 }])
})

test('3.5 #47 unknown: only failed calls → usd null and not a floor, whether or not the model has a price', async () => {
  const home = await homeWith([call('s', 'm-a', 'main', null, { failed: true }), call('s', NOBODY, 'main', null, { failed: true })])
  const { usage } = await overview(home)
  assert.equal(usage.cost.usd, null)
  assert.equal(usage.cost.floor, false)
  assert.equal(usage.cost.unpriced, 0)
  assert.deepEqual(usage.unpriced, [])
  assert.deepEqual(usage.rows.find((r) => r.model === 'm-a').price, { key: 'm-a', exact: true })
})

test('3.5 #47 coverage: a call the byte budget stopped makes every cost partial and a floor', async () => {
  const home = await homeWith([call('s', 'm-a', 'main', [1000, 0, 0, 0])])
  writeSegment(home, LATER, [wire(60, 'big', 'claude-code', { req_body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(OVERVIEW_USAGE_BYTES) }] }) })])
  await segmentIndex({ home, segment: LATER, owner: true })
  const { usage } = await overview(home)
  assert.equal(usage.coverage.reason, 'byte-budget')
  near(usage.cost.usd, 0.001)
  assert.equal(usage.cost.partial, true)
  assert.equal(usage.cost.floor, true)
  for (const h of usage.harnesses) { assert.equal(h.cost.partial, true); assert.equal(h.cost.floor, true) }
})

test('3.5 #47 hit: the main rows by hand; a subagent row does not count', async () => {
  const home = await homeWith([
    call('s', 'm-a', 'main', [100, 0, 600, 100]),
    call('s', 'fam-b', 'main', [50, 0, 150, 0]),
    call('s', 'm-a', 'subagent', [9000, 0, 9000, 9000]),
  ])
  const { hit } = (await overview(home)).usage
  // 750 ÷ (750 + 100 + 150)
  near(hit.ratio, 0.75)
  assert.equal(hit.uncertain, false)
  assert.equal(hit.main_rows, 2)
})

test('3.5 #47 hit: a null cache_write stays out of the denominator and is uncertain; so is cache_known:false', async () => {
  const noWrite = (await overview(await homeWith([call('s', 'm-a', 'main', [100, 0, 300, null])]))).usage.hit
  near(noWrite.ratio, 0.75)
  assert.equal(noWrite.uncertain, true)
  const unknown = (await overview(await homeWith([call('s', 'm-a', 'main', [100, 0, 300, 0], { cache_known: false })]))).usage.hit
  assert.equal(unknown.uncertain, true)
})

test('3.5 #47 hit: only subagent rows, or nothing measured → ratio null, never 0', async () => {
  const sub = (await overview(await homeWith([call('s', 'm-a', 'subagent', [100, 0, 300, 0])]))).usage.hit
  assert.deepEqual(sub, { ratio: null, uncertain: false, main_rows: 0 })
  const empty = (await overview(await homeWith([call('s', 'm-a', 'main', [0, 0, 0, 0])]))).usage.hit
  assert.equal(empty.ratio, null)
  assert.equal(empty.main_rows, 1)
})

test('1.6 C.5 usage.harnesses: the same cost and hit per harness, in row order, the unknown harness a group of its own', async () => {
  const home = await homeWith([
    call('a', 'm-a', 'main', [100, 0, 300, 0], { harness: 'opencode' }),
    call('b', 'fam-b', 'main', [1000, 0, 0, 0], { harness: 'claude-code' }),
    call('b', NOBODY, 'subagent', [1000, 0, 0, 0], { harness: 'claude-code' }),
    call('c', 'vendor-m-a', 'main', [2000, 0, 0, 0], { harness: null }),
  ])
  const { usage } = await overview(home)
  assert.deepEqual(usage.harnesses.map((h) => h.harness), [...new Set(usage.rows.map((r) => r.harness))])
  const of = (model) => usage.harnesses.find((h) => h.harness === usage.rows.find((r) => r.model === model).harness)
  near(of('m-a').cost.usd, 0.0013)
  assert.equal(of('m-a').cost.floor, false)
  near(of('m-a').hit.ratio, 0.75)
  near(of('fam-b').cost.usd, 0.01)
  assert.equal(of('fam-b').cost.floor, true)
  assert.equal(of('fam-b').cost.unpriced, 1)
  assert.equal(of('fam-b').hit.ratio, 0)
  assert.equal(of('fam-b').hit.main_rows, 1)
  assert.equal(of('vendor-m-a').harness, null)
  near(of('vendor-m-a').cost.usd, 0.002)
})

test('1.6 C.5 no price file → the document names the default table as its source', async () => {
  const home = await homeWith([call('s', 'm-a', 'main', [1000, 0, 0, 0])])
  const doc = await runQuery('overview', {}, { home, env: {} })
  assert.equal(doc.usage.pricing.source, (await runQuery('pricing', {}, { home, env: {} })).source)
})
