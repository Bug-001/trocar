// test/query/analysis.test.mjs — `analysis`: a session's cost and totals at the current prices (RFC 3.5 §会话读「`analysis`」, #48; 2.2 §花费 ·
// §多花怎么算; 1.6 C.5). Sessions are hand-written envelopes or big-session.mjs in temp homes, prices a temporary pricing.json, and every
// expected number is worked out by hand from the two.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery, QueryArgError } from '../../src/query/named/index.mjs'
import { sessionState } from '../../src/query/named/session.mjs'

const CONTRACT = JSON.parse(fs.readFileSync(new URL('../fixtures/session-read-contract.json', import.meta.url), 'utf8'))
const homeOf = () => path.join(tmpDir('trocar-analysis-'), '.trocar')
// $/Mtok: [input, output, cache_write, cache_read]
const PRICES = { 'm-a': [3, 15, 4, 0.5], fam: [1, 2, 3, 0.25] }
const envOf = (prices = PRICES) => {
  const file = path.join(tmpDir('trocar-analysis-p-'), 'pricing.json')
  fs.writeFileSync(file, JSON.stringify(prices))
  return { TROCAR_PRICING: file }
}
const near = (a, b, what = '') => assert.ok(Math.abs(a - b) < 1e-12, `${what} ${a} ≈ ${b}`)

const tool = (name) => ({ name, description: `${name} a file.`, input_schema: { type: 'object', properties: { path: { type: 'string' } } } })
const TOOLS = [tool('Read'), tool('Grep')], SWAPPED = [...TOOLS].reverse()
const SYSTEM = 'You are a coding assistant.', MONITOR = 'You are a security monitor.'
/** usage = [fresh, out, read, create] on the wire. */
const wireUsage = ([fresh, out, read, create]) => ({ input_tokens: fresh, output_tokens: out, cache_read_input_tokens: read, cache_creation_input_tokens: create })
const talk = (n) => Array.from({ length: 2 * n - 1 }, (_, i) => (i % 2 ? { role: 'assistant', content: [{ type: 'text', text: `a${(i + 1) / 2}` }] } : { role: 'user', content: [{ type: 'text', text: `q${i / 2 + 1}` }] }))
const ID = 'analysis-000-4a1b-9c2d-000000000001'
/** One session from its steps {n: question, tools?, u?: usage, status?, model?, agent?: a subagent's id, system?, endpoint?} (no `u`: the reply has
 *  none); a step's record id is `<segment>:<its line>`. */
function writeSession(home, steps, id = ID) {
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  const lines = steps.map(({ n = 1, tools = TOOLS, u, status = 200, model = 'm-a', agent, system = SYSTEM, endpoint = '/v1/messages' }, i) => {
    const ts = `2026-10-22T10:00:${String(i).padStart(2, '0')}.000Z`, usage = u ? { usage: wireUsage(u) } : null
    const body = status === 200 ? { id: `msg_${i}`, model, stop_reason: 'end_turn', content: [{ type: 'text', text: `a${n}` }], ...usage } : { type: 'error', error: { type: 'api_error', message: 'boom' }, ...usage }
    return JSON.stringify({ ts, endpoint, method: 'POST', id: `req_${i}`, ts_request: ts, is_llm_call: true, capture: 'transparent', host: 'api.anthropic.com', traffic_class: 'llm',
      req_headers: { host: 'api.anthropic.com', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.0.0 (external, cli)', 'x-claude-code-session-id': id, ...(agent ? { 'x-claude-code-agent-id': agent } : null) },
      req_body: JSON.stringify({ model, max_tokens: 1024, tools, system: [{ type: 'text', text: system }], messages: talk(n) }),
      resp: { status, kind: 'json', body }, proc: { pid: 1, exe: '/x/claude', agent: 'claude-code' } })
  })
  fs.writeFileSync(path.join(home, 'raw', '20261022T100000Z.ndjson'), `${lines.join('\n')}\n`)
}
const analysis = (home, env, ctx = {}, id = ID) => runQuery('analysis', { id }, { home, fs, env, ...ctx })
const session = (home, params, ctx = {}) => runQuery('session', params, { home, fs, ...ctx })
async function worldOf(steps, prices) {
  const home = homeOf(), env = envOf(prices)
  writeSession(home, steps)
  const doc = await analysis(home, env), { calls, lanes } = await session(home, { id: ID })
  assert.deepEqual(doc.errors, [])
  return { home, env, doc, rid: calls.map((r) => r.rid), calls, lanes }
}

// Main: 0 first, 1 reused, 2 failed, 3 a reordered tool list against 1. Subagent: 4. Background: 5, by a family key. Token count: 6.
const MIXED = [
  { n: 1, u: [100, 50, 0, 1000] }, // 300 + 750 + 4000 + 0
  { n: 2, u: [100, 20, 1000, 200] }, // 300 + 300 + 800 + 500
  { n: 3, status: 500 },
  { n: 3, tools: SWAPPED, u: [100, 10, 100, 900] }, // 300 + 150 + 3600 + 50
  { n: 1, u: [10, 10, 0, 100], agent: 'agent-1' }, // 30 + 150 + 400 + 0
  { n: 1, u: [1000, 100, 0, 0], system: MONITOR, model: 'fam-2' }, // 1000 + 200, of fam
  { n: 1, endpoint: '/v1/messages/count_tokens' },
]

test('3.5 #48 totals: main, subagent, background and a token count by hand; the three buckets sum to the total; the usd table says each step', async () => {
  const { doc, rid, calls } = await worldOf(MIXED)
  const { cost, hit, hitSteps, cacheUnknown, failed, unpricedSteps } = doc.totals
  near(cost.main.usd, (5050 + 1900 + 4100) / 1e6, 'main')
  assert.deepEqual([cost.main.priced, cost.main.unpriced, cost.main.failed, cost.main.approx], [3, 0, 1, 0])
  near(cost.sub.usd, 580 / 1e6, 'sub')
  assert.deepEqual([cost.sub.priced, cost.sub.failed], [1, 0])
  near(cost.bg.usd, 1200 / 1e6, 'bg')
  assert.deepEqual([cost.bg.priced, cost.bg.approx, cost.bg.approxKeys], [1, 1, ['fam']])
  near(cost.total.usd, cost.main.usd + cost.sub.usd + cost.bg.usd, 'total')
  assert.deepEqual([cost.total.priced, cost.total.unpriced, cost.total.failed, cost.total.approx, cost.total.approxKeys], [5, 0, 1, 1, ['fam']])
  assert.equal(calls.length, 6, 'a token count is no call')
  assert.deepEqual(rid.map((r) => doc.usd[r]), [5050, 1900, null, 4100, 580, 1200])
  assert.deepEqual(Object.keys(doc.usd), rid, 'one entry per row, in step order')
  assert.equal(hit, 1100 / 3500, 'the main lane, token-weighted')
  assert.equal(hitSteps, 3)
  assert.equal(cacheUnknown, false)
  assert.equal(failed, 1)
  assert.equal(unpricedSteps, 0)
  assert.deepEqual(doc.pricing.models, [{ model: 'fam-2', key: 'fam', exact: false }, { model: 'm-a', key: 'm-a', exact: true }])
  assert.equal(doc.totals.breaks.length, 1)
  assert.equal(doc.totals.breaks[0].rid, rid[3])
  near(doc.totals.breaks[0].usd, (1000 + 200 - 100) * (4 - 0.5) / 1e6, 'the break')
  assert.equal(doc.totals.breaks[0].why, null)
  near(doc.totals.breakCost.usd, doc.totals.breaks[0].usd)
  assert.deepEqual([doc.totals.breakCost.counted, doc.totals.breakCost.uncomputable, doc.totals.breakCost.worst.rid], [1, 0, rid[3]])
})

test('3.5 #48 pages: the totals are the sum over every --before page, and no --limit moves them', async () => {
  const home = homeOf(), env = envOf({ 'claude-opus-4-8': [1, 2, 3, 4] })
  const s = bigSession({ home, growth: 300, subEvery: 3, failEvery: 5 })
  s.append(60)
  const rows = []
  for (let page = await session(home, { id: s.id, limit: '7' }); ; page = await session(home, { id: s.id, limit: '7', before: page.calls[0].rid })) {
    rows.unshift(...page.calls)
    assert.ok(page.calls.length < 60)
    if (!page.more) break
  }
  assert.equal(rows.length, 60)
  const { lanes } = await session(home, { id: s.id }), kind = new Map(lanes.map((l) => [l.lane, l.kind]))
  const sum = (bucket) => rows.filter((r) => !r.error && kind.get(r.lane) === bucket).reduce((n, { usage: u }) => n + u.fresh + 2 * u.out + 3 * u.create + 4 * u.read, 0)
  const doc = await analysis(home, env, {}, s.id)
  near(doc.totals.cost.main.usd, sum('main') / 1e6, 'main')
  near(doc.totals.cost.sub.usd, sum('subagent') / 1e6, 'sub')
  assert.equal(doc.totals.cost.total.priced + doc.totals.cost.total.failed, 60)
  assert.ok(doc.totals.failed > 0)
  assert.deepEqual(Object.keys(doc.usd), rows.map((r) => r.rid))
  assert.deepEqual(await runQuery('analysis', { id: s.id }, { home, fs: { ...fs }, env }), doc, 'a process that read no page answers the same')
})

test('3.5 #48 at the mark: an answer with pending counts the members at or below the mark, and says pending', async () => {
  const home = homeOf(), env = envOf({ 'claude-opus-4-8': [1, 2, 3, 4] })
  const s = bigSession({ home, growth: 4_000, subEvery: 3, compactAt: 40_000, subLanes: 3, late: 2 })
  s.append(160)
  const own = { ...fs }
  let doc, partial = 0
  for (let i = 0; i < 400; i++) {
    doc = await runQuery('analysis', { id: s.id }, { home, fs: own, env, writer: true })
    if (!doc.pending) break
    partial++
    if (partial > 6) continue // each compared answer reads a home of its own
    const at = homeOf()
    fs.mkdirSync(path.join(at, 'raw'), { recursive: true })
    const lines = fs.readFileSync(s.file, 'utf8').split('\n'), upTo = Number(doc.mark.split(':')[1])
    fs.writeFileSync(path.join(at, 'raw', path.basename(s.file)), lines.slice(0, upTo).join('\n') + '\n')
    const { pending, ...got } = doc
    assert.ok(pending.done < pending.total)
    assert.deepEqual(got, await analysis(at, env, {}, s.id), `answer ${i}: the sums over the members ≤ ${doc.mark}`)
  }
  assert.ok(partial > 0, 'the worker\'s slices left members above the frontier at least once')
  assert.equal(doc.pending, undefined)
  assert.equal(Object.keys(doc.usd).length, 160)
})

test('3.5 #48 unknown: no usage and no price are null in the table and count as unpriced, never $0', async () => {
  const { doc, rid } = await worldOf([
    { n: 1, u: [100, 0, 0, 0] },
    { n: 2 },
    { n: 3, u: [100, 0, 0, 0], model: 'zz-nobody' },
  ])
  assert.deepEqual(rid.map((r) => doc.usd[r]), [300, null, null])
  assert.deepEqual([doc.totals.cost.total.priced, doc.totals.cost.total.unpriced, doc.totals.unpricedSteps], [1, 2, 2])
  assert.deepEqual(doc.pricing.models.find((m) => m.model === 'zz-nobody'), { model: 'zz-nobody', key: null, exact: false })
  assert.equal(doc.totals.cost.sub.usd, null, 'an empty bucket has no sum')
})

test('3.5 #48 unknown: when nothing can be priced the total is null, not 0, and the hit still stands', async () => {
  const { doc } = await worldOf([{ n: 1, u: [100, 0, 300, 0], model: 'zz-nobody' }, { n: 2 }])
  assert.equal(doc.totals.cost.total.usd, null)
  assert.equal(doc.totals.cost.main.usd, null)
  assert.equal(doc.totals.hit, 300 / 400)
})

test('3.5 #48 unknown: a break with no price or no usage on its comparison step says why, and breakCost counts it', async () => {
  const swap = { n: 3, tools: SWAPPED, u: [100, 0, 10, 900] }
  const noPrice = await worldOf([{ n: 1, u: [0, 0, 0, 900], model: 'zz-nobody' }, { n: 2, u: [0, 0, 900, 50], model: 'zz-nobody' }, { ...swap, model: 'zz-nobody' }])
  assert.deepEqual(noPrice.doc.totals.breaks, [{ rid: noPrice.rid[2], usd: null, why: 'no-price' }])
  assert.deepEqual(noPrice.doc.totals.breakCost, { usd: null, counted: 0, uncomputable: 1, worst: null })
  const noUsage = await worldOf([{ n: 1, u: [0, 0, 0, 900] }, { n: 2 }, swap])
  assert.deepEqual(noUsage.doc.totals.breaks, [{ rid: noUsage.rid[2], usd: null, why: 'no-usage' }])
  assert.deepEqual(noUsage.doc.totals.breakCost, { usd: null, counted: 0, uncomputable: 1, worst: null })
})

// boardUsage reports an absent write counter as 0 and the fold names a comparison step for every break, so these two reasons have no
// record that reaches them; the case puts the fact into the warm state the answer reads: the columns' NaN, a row with no refRid.
test('3.5 #48 unknown: a comparison step with no write counter and a break that names none say why', async () => {
  const W = await worldOf([{ n: 1, u: [0, 0, 0, 900] }, { n: 2, u: [0, 0, 900, 50] }, { n: 3, tools: SWAPPED, u: [100, 0, 10, 900] }])
  const { V: { cols, log } } = await sessionState({ home: W.home, fs, env: W.env, params: { id: ID }, errors: [] }, ID)
  const slot = cols.slotOf(W.rid[1]), counter = cols.uw[slot]
  cols.uw[slot] = NaN
  const noCounter = await analysis(W.home, W.env)
  cols.uw[slot] = counter
  assert.deepEqual(noCounter.totals.breaks, [{ rid: W.rid[2], usd: null, why: 'no-write-counter' }])
  const read = log.read
  log.read = (...at) => { const o = read.apply(log, at); return o.r?.cacheBreak ? { ...o, r: { ...o.r, cacheBreak: { ...o.r.cacheBreak, refRid: undefined } } } : o }
  const noRef = await analysis(W.home, W.env)
  log.read = read
  assert.deepEqual(noRef.totals.breaks, [{ rid: W.rid[2], usd: null, why: 'no-ref' }])
  assert.deepEqual(noRef.totals.breakCost, { usd: null, counted: 0, uncomputable: 1, worst: null })
})

test('3.5 #48 verdicts: a failed step stays out of the hit even when its reply has usage', async () => {
  const { doc } = await worldOf([{ n: 1, u: [100, 0, 300, 0] }, { n: 2, status: 500, u: [900, 0, 0, 0] }])
  assert.equal(doc.totals.hit, 300 / 400)
  assert.equal(doc.totals.hitSteps, 1)
})

test('3.5 #48 verdicts: a compaction counts as a break, and only the main lane\'s breaks and hit are the totals\'', async () => {
  const { doc, rid, calls } = await worldOf([
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ n, u: [10, 0, 100 * n, 100] })),
    { n: 1, u: [10, 0, 0, 800] },
    { n: 1, agent: 'agent-1', u: [10, 0, 0, 100] },
    { n: 2, agent: 'agent-1', tools: SWAPPED, u: [10, 0, 0, 100] },
  ])
  assert.ok(calls[6].compaction, 'the step that drops the history is a compaction')
  assert.deepEqual(doc.totals.breaks.map((b) => b.rid), [rid[6]])
  near(doc.totals.breaks[0].usd, (600 + 100 - 0) * (4 - 0.5) / 1e6, 'the compaction')
  assert.equal(doc.totals.hitSteps, 7)
})

test('3.5 #48 verdicts: firstFailed goes by the lanes\' order, then step order, and names the subagent\'s lane when the failure is there', async () => {
  const sub = await worldOf([{ n: 1, u: [10, 0, 0, 100] }, { n: 1, status: 500, agent: 'agent-1' }, { n: 2, status: 500, agent: 'agent-1' }])
  assert.deepEqual(sub.doc.totals.firstFailed, { rid: sub.rid[1], lane: sub.calls[1].lane })
  assert.notEqual(sub.calls[1].lane, sub.calls[0].lane)
  const both = await worldOf([{ n: 1, u: [10, 0, 0, 100] }, { n: 1, status: 500, agent: 'agent-1' }, { n: 2, status: 500 }])
  assert.deepEqual(both.doc.totals.firstFailed, { rid: both.rid[2], lane: both.calls[0].lane }, 'the main lane comes first')
  assert.equal(both.doc.totals.failed, 2)
})

test('3.5 §会话读 closed sets: the top level and totals have only the listed keys; the fixture\'s analysis entry has every one', async () => {
  const { doc } = await worldOf(MIXED)
  const TOP = ['schema', 'command', 'ok', 'errors', 'mark', 'pending', 'truncated', 'pricing', 'totals', 'usd']
  const TOTALS = ['cost', 'hit', 'hitSteps', 'cacheUnknown', 'breaks', 'breakCost', 'failed', 'firstFailed', 'unpricedSteps']
  const BUCKET = ['usd', 'priced', 'unpriced', 'failed', 'approx', 'approxKeys']
  for (const [got, closed] of [[doc, TOP], [doc.totals, TOTALS], [doc.totals.cost.total, BUCKET]]) assert.deepEqual(Object.keys(got).filter((k) => !closed.includes(k)), [])
  const sample = CONTRACT.analysis
  assert.deepEqual(Object.keys(sample).sort(), Object.keys(doc).sort())
  assert.deepEqual(Object.keys(sample.totals).sort(), Object.keys(doc.totals).sort())
  for (const b of ['main', 'sub', 'bg', 'total']) assert.deepEqual(Object.keys(sample.totals.cost[b]).sort(), Object.keys(doc.totals.cost[b]).sort())
})

test('3.5 §会话读: a session nobody captured is said in errors with an empty document; no --id is refused', async () => {
  const home = homeOf()
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  const doc = await analysis(home, envOf(), {}, 'no-such-session')
  assert.deepEqual(doc.errors.map((e) => [e.where, e.code]), [['session/no-such-session', 'session-unknown']])
  const { schema, command, ok, errors, ...rest } = doc
  assert.deepEqual(rest, { mark: null, truncated: null, pricing: { source: doc.pricing.source, models: [] }, totals: null, usd: {} })
  await assert.rejects(runQuery('analysis', {}, { home, fs }), QueryArgError)
})
