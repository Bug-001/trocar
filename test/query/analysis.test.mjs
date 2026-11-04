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
import { ANALYSIS_PAGE_BYTES } from '../../src/query/named/analysis.mjs'
import { extendSession, sessionState } from '../../src/query/named/session.mjs'
import { FLAG, cellsOf } from '../../src/view/head-cols.mjs'

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
/** One session from its steps {n: question, messages?: instead of the talk up to n, tools?, u?: usage, status?, model?, agent?: a subagent's id, system?, endpoint?} (no `u`: the reply has
 *  none); a step's record id is `<segment>:<its line>`. */
function writeSession(home, steps, id = ID) {
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  const lines = steps.map(({ n = 1, messages = talk(n), tools = TOOLS, u, status = 200, model = 'm-a', agent, system = SYSTEM, endpoint = '/v1/messages' }, i) => {
    const ts = `2026-10-22T10:00:${String(i).padStart(2, '0')}.000Z`, usage = u ? { usage: wireUsage(u) } : null
    const body = status === 200 ? { id: `msg_${i}`, model, stop_reason: 'end_turn', content: [{ type: 'text', text: `a${n}` }], ...usage } : { type: 'error', error: { type: 'api_error', message: 'boom' }, ...usage }
    return JSON.stringify({ ts, endpoint, method: 'POST', id: `req_${i}`, ts_request: ts, is_llm_call: true, capture: 'transparent', host: 'api.anthropic.com', traffic_class: 'llm',
      req_headers: { host: 'api.anthropic.com', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.0.0 (external, cli)', 'x-claude-code-session-id': id, ...(agent ? { 'x-claude-code-agent-id': agent } : null) },
      req_body: JSON.stringify({ model, max_tokens: 1024, tools, system: [{ type: 'text', text: system }], messages }),
      resp: { status, kind: 'json', body }, proc: { pid: 1, exe: '/x/claude', agent: 'claude-code' } })
  })
  fs.writeFileSync(path.join(home, 'raw', '20261022T100000Z.ndjson'), `${lines.join('\n')}\n`)
}
const analysis = (home, env, ctx = {}, id = ID) => runQuery('analysis', { id }, { home, fs, env, ...ctx })
const windowOf = (home, env, p, id = ID, ctx = {}) => runQuery('analysis', { id, ...p }, { home, fs, env, ...ctx })
const NOT_A_STEP = 'not-a-step'
/** The session's windows from the tail back along `prev`, first page first, and what they hold together. */
async function walked(home, env, id = ID) {
  const pages = []
  for (let w = await windowOf(home, env, { from: NOT_A_STEP }, id); ; w = await windowOf(home, env, { to: w.prev }, id)) {
    assert.deepEqual(w.errors, [])
    pages.unshift(w)
    if (w.prev == null) break
  }
  return { pages, rids: pages.flatMap((w) => Object.keys(w.usd)), usd: Object.assign({}, ...pages.map((w) => w.usd)), breaks: pages.flatMap((w) => w.breaks) }
}
const session = (home, params, ctx = {}) => runQuery('session', params, { home, fs, ...ctx })
async function worldOf(steps, prices) {
  const home = homeOf(), env = envOf(prices)
  writeSession(home, steps)
  const doc = await analysis(home, env), { calls, lanes } = await session(home, { id: ID })
  assert.deepEqual(doc.errors, [])
  return { home, env, doc, win: await walked(home, env), rid: calls.map((r) => r.rid), calls, lanes }
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

test('3.5 #48 totals: main, subagent, background and a token count by hand; the three buckets sum to the total; the windows say each step', async () => {
  const { doc, win, rid, calls } = await worldOf(MIXED)
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
  assert.deepEqual(rid.map((r) => win.usd[r]), [5050, 1900, null, 4100, 580, 1200])
  assert.deepEqual(win.rids, rid, 'one entry per row, in step order')
  assert.equal(hit, 1100 / 3500, 'the main lane, token-weighted')
  assert.equal(hitSteps, 3)
  assert.equal(cacheUnknown, false)
  assert.equal(failed, 1)
  assert.equal(unpricedSteps, 0)
  assert.deepEqual(doc.pricing.models, [{ model: 'fam-2', key: 'fam', exact: false }, { model: 'm-a', key: 'm-a', exact: true }])
  assert.equal(win.breaks.length, 1)
  assert.equal(win.breaks[0].rid, rid[3])
  near(win.breaks[0].usd, (1000 + 200 - 100) * (4 - 0.5) / 1e6, 'the break')
  assert.equal(win.breaks[0].why, null)
  near(doc.totals.breakCost.usd, win.breaks[0].usd)
  assert.deepEqual([doc.totals.breakCost.counted, doc.totals.breakCost.uncomputable, doc.totals.breakCost.worst.rid], [1, 0, rid[3]])
})

test('3.5 #48 pages: the totals are the sum over every --before page and over the windows, and no --limit moves them', async () => {
  const home = homeOf(), env = envOf({ 'claude-opus-4-8': [1, 2, 3, 4] })
  const s = bigSession({ home, growth: 300, subEvery: 3, failEvery: 5 })
  const CALLS = 60
  s.append(CALLS)
  const rows = []
  for (let page = await session(home, { id: s.id, limit: '7' }); ; page = await session(home, { id: s.id, limit: '7', before: page.calls[0].rid })) {
    rows.unshift(...page.calls)
    assert.ok(page.calls.length < CALLS)
    if (!page.more) break
  }
  assert.equal(rows.length, CALLS)
  const { lanes } = await session(home, { id: s.id }), kind = new Map(lanes.map((l) => [l.lane, l.kind]))
  const sum = (bucket) => rows.filter((r) => !r.error && kind.get(r.lane) === bucket).reduce((n, { usage: u }) => n + u.fresh + 2 * u.out + 3 * u.create + 4 * u.read, 0)
  const doc = await analysis(home, env, {}, s.id)
  near(doc.totals.cost.main.usd, sum('main') / 1e6, 'main')
  near(doc.totals.cost.sub.usd, sum('subagent') / 1e6, 'sub')
  assert.equal(doc.totals.cost.total.priced + doc.totals.cost.total.failed, CALLS)
  assert.ok(doc.totals.failed > 0)
  const win = await walked(home, env, s.id), micro = Object.values(win.usd).reduce((n, v) => n + (v ?? 0), 0)
  assert.deepEqual(win.rids, rows.map((r) => r.rid))
  assert.ok(Math.abs(micro / 1e6 - doc.totals.cost.total.usd) <= CALLS * 0.5e-6, 'the table rounds each step to a microdollar')
  assert.deepEqual(await runQuery('analysis', { id: s.id }, { home, fs: { ...fs }, env }), doc, 'a process that read no page answers the same')
})

test('3.5 #48 at the mark: an answer with pending counts the members at or below the mark, and says pending', async () => {
  const home = homeOf(), env = envOf({ 'claude-opus-4-8': [1, 2, 3, 4] })
  const s = bigSession({ home, growth: 4_000, subEvery: 3, compactAt: 40_000, subLanes: 3, late: 2 })
  const CALLS = 160
  s.append(CALLS)
  const own = { ...fs }
  let doc, partial = 0
  for (let i = 0; i < 400; i++) {
    doc = await runQuery('analysis', { id: s.id }, { home, fs: own, env, writer: true })
    if (!doc.pending) break
    partial++
    assert.equal(doc.ok, true, 'pending is no error')
    assert.deepEqual(doc.errors, [])
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
  assert.equal(doc.totals.cost.total.priced + doc.totals.cost.total.failed + doc.totals.cost.total.unpriced, CALLS)
})

test('3.5 #48 unknown: no usage and no price are null in the table and count as unpriced, never $0', async () => {
  const { doc, win, rid } = await worldOf([
    { n: 1, u: [100, 0, 0, 0] },
    { n: 2 },
    { n: 3, u: [100, 0, 0, 0], model: 'zz-nobody' },
  ])
  assert.deepEqual(rid.map((r) => win.usd[r]), [300, null, null])
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
  assert.deepEqual(noPrice.win.breaks, [{ rid: noPrice.rid[2], usd: null, why: 'no-price' }])
  assert.deepEqual(noPrice.doc.totals.breakCost, { usd: null, counted: 0, uncomputable: 1, worst: null })
  const noUsage = await worldOf([{ n: 1, u: [0, 0, 0, 900] }, { n: 2 }, swap])
  assert.deepEqual(noUsage.win.breaks, [{ rid: noUsage.rid[2], usd: null, why: 'no-usage' }])
  assert.deepEqual(noUsage.doc.totals.breakCost, { usd: null, counted: 0, uncomputable: 1, worst: null })
})

// The three steps on each wire: a first, a reused one and a reordered tool list against it, written as the wire writes them.
const fn = (t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })
const chatTalk = (n) => talk(n).map((m) => ({ role: m.role, content: m.content[0].text }))
const chat = (usage) => ({ host: 'api.deepseek.com', endpoint: '/chat/completions', agent: 'dsh', hdr: { 'x-deepseek-harness-session-id': ID },
  req: (n, tools) => ({ model: 'm-a', tools: tools.map(fn), messages: [{ role: 'system', content: SYSTEM }, ...chatTalk(n)] }),
  reply: (i, n, read, fresh) => ({ id: `c${i}`, model: 'm-a', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `a${n}` } }], usage: { completion_tokens: 5, ...usage(read, fresh) } }) })
const responses = (write) => ({ host: 'chatgpt.com', endpoint: '/backend-api/codex/responses', agent: 'codex', hdr: { 'session-id': ID, originator: 'codex_cli_rs' },
  req: (n, tools) => ({ model: 'm-a', instructions: SYSTEM, tools: tools.map((t) => ({ type: 'function', name: t.name, parameters: t.input_schema })),
    input: chatTalk(n).map((m) => ({ type: 'message', role: m.role, content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.content }] })) }),
  resp: (i, n, read, fresh) => ({ status: 200, kind: 'sse', raw_sse: [{ type: 'response.completed', response: { id: `r${i}`, model: 'm-a', status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `a${n}` }] }],
    usage: { input_tokens: read + fresh + (write(i) ?? 0), output_tokens: 5, input_tokens_details: { cached_tokens: read, ...(write(i) == null ? null : { cache_write_tokens: write(i) }) } } } }] }) })
const anthropic = (host, write) => ({ host, endpoint: '/v1/messages', agent: 'claude-code', hdr: { 'x-claude-code-session-id': ID, 'user-agent': 'claude-cli/2.0.0 (external, cli)' },
  req: (n, tools) => ({ model: 'm-a', max_tokens: 9, tools, system: [{ type: 'text', text: SYSTEM }], messages: talk(n) }),
  reply: (i, n, read, fresh) => ({ id: `msg_${i}`, model: 'm-a', stop_reason: 'end_turn', content: [{ type: 'text', text: `a${n}` }],
    usage: { input_tokens: fresh, output_tokens: 5, cache_read_input_tokens: read, ...(write(i) == null ? null : { cache_creation_input_tokens: write(i) }) } }) })
async function wireWorld(w) {
  const home = homeOf(), env = envOf()
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  const lines = [[1, TOOLS, 0, 900], [2, TOOLS, 900, 50], [3, SWAPPED, 100, 900]].map(([n, tools, read, fresh], i) => {
    const ts = `2026-10-22T10:00:0${i}.000Z`
    return JSON.stringify({ ts, endpoint: w.endpoint, method: 'POST', id: `req_${i}`, ts_request: ts, is_llm_call: true, capture: 'transparent', host: w.host, traffic_class: 'llm',
      req_headers: { host: w.host, 'content-type': 'application/json', ...w.hdr }, req_body: JSON.stringify(w.req(n, tools)),
      resp: w.resp ? w.resp(i, n, read, fresh) : { status: 200, kind: 'json', body: w.reply(i, n, read, fresh) }, proc: { pid: 1, exe: `/x/${w.agent}`, agent: w.agent } })
  })
  fs.writeFileSync(path.join(home, 'raw', '20261022T100000Z.ndjson'), `${lines.join('\n')}\n`)
  const [doc, { calls }] = [await analysis(home, env), await session(home, { id: ID })]
  assert.deepEqual(doc.errors, [])
  assert.equal(calls[2].cache.break, true)
  return { doc, win: await walked(home, env), calls }
}

const none = () => null
for (const [name, w] of Object.entries({
  'chat, hit and miss counters': chat((read, fresh) => ({ prompt_tokens: read + fresh, prompt_cache_hit_tokens: read, prompt_cache_miss_tokens: fresh })),
  'chat, cached_tokens': chat((read, fresh) => ({ prompt_tokens: read + fresh, prompt_tokens_details: { cached_tokens: read } })),
  responses: responses(none),
  'anthropic wire, another vendor': anthropic('api.deepseek.com', none),
})) test(`3.5 #45 #48 no write counter (${name}): create is null, a break has no missed and no dollars, and says why`, async () => {
  const { doc, win, calls } = await wireWorld(w)
  for (const r of calls) assert.equal(r.usage.create, null, `${r.rid}: NULL, not 0`)
  assert.deepEqual(calls[2].cache, { state: 'changed', hit: 100 / 1000, break: true, why: 'no-write-counter' })
  assert.deepEqual(win.breaks, [{ rid: calls[2].rid, usd: null, why: 'no-write-counter' }])
  assert.deepEqual(doc.totals.breakCost, { usd: null, counted: 0, uncomputable: 1, worst: null })
})

for (const [name, w] of Object.entries({
  anthropic: anthropic('api.anthropic.com', () => 0),
  'responses relay': responses(() => 0),
})) test(`3.5 #45 #48 a reported zero (${name}): create stays 0 and the break is priced at the write price`, async () => {
  const { win, calls } = await wireWorld(w)
  for (const r of calls) assert.equal(r.usage.create, 0)
  assert.equal(calls[2].cache.missed, 800, '900 + 0 − 100')
  assert.ok(!('why' in calls[2].cache))
  near(win.breaks[0].usd, (800 * (4 - 0.5)) / 1e6)
})

test('3.5 #45 #48 a step with no write counter against a comparison step that has one: priced at the uncached input', async () => {
  const { win, calls } = await wireWorld(responses((i) => (i === 2 ? null : 50)))
  assert.equal(calls[2].usage.create, null)
  assert.equal(calls[2].cache.missed, 850, '900 + 50 − 100')
  near(win.breaks[0].usd, (850 * (3 - 0.5)) / 1e6)
})

test('3.5 #48 verdicts: a failed step stays out of the hit even when its reply has usage', async () => {
  const { doc } = await worldOf([{ n: 1, u: [100, 0, 300, 0] }, { n: 2, status: 500, u: [900, 0, 0, 0] }])
  assert.equal(doc.totals.hit, 300 / 400)
  assert.equal(doc.totals.hitSteps, 1)
})

test('3.5 #48 verdicts: a compaction counts as a break, and only the main lane\'s breaks and hit are the totals\'', async () => {
  const { doc, win, rid, calls } = await worldOf([
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ n, u: [10, 0, 100 * n, 100] })),
    { n: 1, u: [10, 0, 0, 800] },
    { n: 1, agent: 'agent-1', u: [10, 0, 0, 100] },
    { n: 2, agent: 'agent-1', tools: SWAPPED, u: [10, 0, 0, 100] },
  ])
  assert.ok(calls[6].compaction, 'the step that drops the history is a compaction')
  assert.deepEqual(win.breaks.map((b) => b.rid), [rid[6]])
  near(win.breaks[0].usd, (600 + 100 - 0) * (4 - 0.5) / 1e6, 'the compaction')
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

test('3.5 #50 closed sets: the default document has only the listed keys, no usd and no breaks; the fixture\'s two analysis entries have every one', async () => {
  const { doc, win } = await worldOf(MIXED)
  const TOP = ['schema', 'command', 'ok', 'errors', 'mark', 'pending', 'truncated', 'pricing', 'totals']
  const TOTALS = ['cost', 'hit', 'hitSteps', 'cacheUnknown', 'breakCost', 'failed', 'firstFailed', 'unpricedSteps', 'problems']
  const BUCKET = ['usd', 'priced', 'unpriced', 'failed', 'approx', 'approxKeys']
  for (const [got, closed] of [[doc, TOP], [doc.totals, TOTALS], [doc.totals.cost.total, BUCKET]]) assert.deepEqual(Object.keys(got).filter((k) => !closed.includes(k)), [])
  assert.ok(!('usd' in doc) && !('breaks' in doc.totals))
  assert.ok('breakCost' in doc.totals)
  const sample = CONTRACT.analysis
  assert.deepEqual(Object.keys(sample).sort(), Object.keys(doc).sort())
  assert.deepEqual(Object.keys(sample.totals).sort(), Object.keys(doc.totals).sort())
  for (const b of ['main', 'sub', 'bg', 'total']) assert.deepEqual(Object.keys(sample.totals.cost[b]).sort(), Object.keys(doc.totals.cost[b]).sort())
  assert.deepEqual(Object.keys(CONTRACT.analysis_window).sort(), Object.keys(win.pages[0]).sort())
})

// The steps a head's `cols` marks as problems: the problem-break bit or the failed bit, by the step's place on the axis.
const headProblems = (head) => {
  const cells = cellsOf(head.cols)
  return Array.from({ length: head.steps }, (_, s) => s).filter((s) => cells[3 * s + 2] & (FLAG.cacheBreak | FLAG.failed))
}
const SUMMARY = [{ role: 'user', content: [{ type: 'text', text: 'Summary of the conversation so far.' }] }]

test('3.5 #56 problems: every kind of step by hand: totals.problems and the head\'s bits name the same main-lane steps, a rewrite and a subagent\'s failure not among them', async () => {
  const { home, doc, calls } = await worldOf([
    { n: 1, u: [100, 50, 0, 1000] }, // 0 first
    { n: 2, u: [100, 20, 1000, 200] }, // 1 reused
    { n: 3, u: [100, 0, 100, 900] }, // 2 low-hit
    { n: 4, tools: SWAPPED, u: [100, 10, 100, 900] }, // 3 changed
    { n: 5, tools: SWAPPED, u: [100, 10, 0, 1000] }, // 4 ttl-rebuild
    { n: 6, tools: SWAPPED, u: [1000, 10, 0, 0] }, // 5 provider-contradiction
    { n: 7, tools: SWAPPED, status: 500 }, // 6 failed
    { n: 8, tools: SWAPPED, u: [100, 10, 1000, 100] }, // 7
    { n: 1, tools: SWAPPED, messages: SUMMARY, u: [10, 10, 0, 800] }, // 8 the compaction
    { n: 1, status: 500, agent: 'agent-1' }, // 9 a subagent's failure
  ])
  assert.deepEqual(calls.map((r) => r.cache.state).slice(0, 7), ['first', 'reused', 'low-hit', 'changed', 'ttl-rebuild', 'provider-contradiction', 'failed'])
  assert.equal(calls[8].cache.rewrite, true)
  assert.equal(calls[8].cache.break, true, 'the rewrite is a break that is no problem')
  assert.equal(calls[9].cache.state, 'failed')
  assert.equal(doc.totals.problems, 5)
  const head = await session(home, { id: ID, head: true }), cells = cellsOf(head.cols)
  assert.deepEqual(headProblems(head), [2, 3, 4, 5, 6])
  assert.equal(cells[3 * 8 + 2] & FLAG.cacheBreak, 0)
  assert.notEqual(cells[3 * 8 + 2] & FLAG.compaction, 0)
})

for (const wire of ['http', 'threads', 'ws', 'chat']) test(`3.5 #56 problems along the wires (${wire}): the total, the head's bits and the axis rows' cache count the same steps`, async () => {
  const home = homeOf(), env = envOf({ 'claude-opus-4-8': [1, 2, 3, 4] })
  const s = bigSession({ home, wire, growth: 300, subEvery: 3, failEvery: 5, compactAt: 3_000 })
  s.append(100)
  const rows = []
  for (let page = await session(home, { id: s.id }); ; page = await session(home, { id: s.id, before: page.calls[0].rid })) {
    rows.unshift(...page.calls)
    if (!page.more) break
  }
  const head = await session(home, { id: s.id, head: true }), { totals } = await analysis(home, env, {}, s.id)
  assert.equal(head.bucket, 1)
  const axis = rows.filter((r) => r.lane === head.axis), problems = axis.filter(({ cache: c }) => (c.break && !c.rewrite) || c.state === 'failed')
  assert.equal(axis.length, head.steps)
  assert.ok(axis.some(({ cache: c }) => c.break || c.state === 'failed'), 'the walk meets steps to judge')
  assert.deepEqual(headProblems(head), axis.flatMap((r, i) => (problems.includes(r) ? [i] : [])))
  assert.equal(totals.problems, problems.length)
})

test('3.5 #56 problems with no main lane: they are counted on the lane the axis is on', async () => {
  const { home, doc, lanes } = await worldOf([{ n: 1, u: [10, 0, 0, 100], agent: 'agent-1' }, { n: 2, status: 500, agent: 'agent-1' }])
  assert.ok(!lanes.some((l) => l.kind === 'main'))
  assert.equal(doc.totals.problems, 1)
  assert.deepEqual(headProblems(await session(home, { id: ID, head: true })), [1])
})

// One long session for the three tests below: past a window page and past a slice, with compactions for breaks.
let long = null
const longSession = () => (long ??= (async () => {
  const home = homeOf(), env = envOf({ 'claude-opus-4-8': [1, 2, 3, 4] })
  const s = bigSession({ home, growth: 200, subEvery: 7, compactAt: 8_000 })
  s.append(3)
  const early = (await analysis(home, env, {}, s.id)).mark
  s.append(2_600)
  const steps = []
  for (let page = await session(home, { id: s.id }); ; page = await session(home, { id: s.id, before: page.calls[0].rid })) {
    steps.unshift(...page.calls.map((r) => r.rid))
    if (!page.more) break
  }
  return { home, env, id: s.id, doc: await analysis(home, env, {}, s.id), steps, early }
})())

test('3.5 #50 size: the default document of a long session with many breaks stays small', async () => {
  const { doc, home, env, id } = await longSession()
  assert.deepEqual(doc.errors, [])
  const { breaks } = await walked(home, env, id)
  assert.ok(doc.totals.breakCost.counted > 1 && breaks.length === doc.totals.breakCost.counted + doc.totals.breakCost.uncomputable)
  assert.ok(Buffer.byteLength(JSON.stringify(doc)) <= 2048)
})

test('3.5 #55 columns only: the totals of a folded session with breaks read no row of the fold log', async () => {
  const home = homeOf(), ctx = { home, fs, env: envOf({ claude: PRICES['m-a'] }), writer: true }
  const s = bigSession({ home, growth: 200, subEvery: 7, compactAt: 1_500 })
  s.append(60)
  while (await extendSession(ctx, s.id, Infinity));
  const { V } = await sessionState(ctx, s.id)
  let rows = 0
  for (const m of ['read', 'peek']) {
    const was = V.log[m]
    V.log[m] = (...a) => { const o = was(...a); if (o?.c != null) rows++; return o }
  }
  const { totals } = await runQuery('analysis', { id: s.id }, ctx)
  assert.ok(totals.breakCost.counted > 0, 'the session has breaks to price')
  assert.equal(rows, 0)
})

test('3.5 #51 windows: prev from the tail and next from the first page each give every step once, in step order, every page within the bound', async () => {
  const { home, env, id, doc, steps } = await longSession()
  const back = await walked(home, env, id)
  assert.ok(back.pages.length > 1, 'the session is longer than a page')
  assert.equal(back.pages.at(-1).base, null)
  assert.deepEqual(back.rids, steps)
  for (const w of back.pages) {
    assert.ok(Object.keys(w.usd).length > 0)
    assert.ok(Buffer.byteLength(JSON.stringify({ usd: w.usd, breaks: w.breaks })) <= ANALYSIS_PAGE_BYTES)
    assert.equal(w.mark, doc.mark)
    assert.ok(!('totals' in w))
  }
  const forth = [back.pages[0]]
  while (forth.at(-1).next != null) {
    const from = forth.at(-1).next, w = await windowOf(home, env, { from }, id)
    assert.equal(w.base, from)
    forth.push(w)
  }
  assert.deepEqual(forth.flatMap((w) => Object.keys(w.usd)), steps)
  assert.deepEqual(forth.flatMap((w) => w.breaks), back.breaks)
  assert.deepEqual(Object.assign({}, ...forth.map((w) => w.usd)), back.usd)
})

test('3.5 #51 windows: a page lists only the models it walks', async () => {
  const { win, rid, doc, home, env } = await worldOf(MIXED)
  assert.deepEqual(win.pages[0].pricing, doc.pricing, 'the whole session on a page')
  const first = await windowOf(home, env, { to: rid[5] })
  assert.deepEqual(first.pricing.models, [{ model: 'm-a', key: 'm-a', exact: true }])
  assert.deepEqual(Object.keys(first.usd), rid.slice(0, 5))
  assert.equal(first.prev, null)
})

test('3.5 #51 --since: after an append only the new steps and base M; a mark not known is the tail with base null', async () => {
  const home = homeOf(), env = envOf(), steps = MIXED.slice(0, 3)
  writeSession(home, steps)
  const { mark } = await analysis(home, env)
  assert.deepEqual(Object.keys((await windowOf(home, env, { since: mark })).usd), [], 'nothing since the mark itself')
  writeSession(home, [...steps, { n: 3, u: [100, 10, 100, 900] }, { n: 4, u: [100, 10, 100, 900] }])
  const rids = (await session(home, { id: ID })).calls.map((r) => r.rid), w = await windowOf(home, env, { since: mark })
  assert.equal(w.base, mark)
  assert.deepEqual(Object.keys(w.usd), rids.slice(steps.length))
  assert.deepEqual([w.prev, w.next], [null, null])
  const unknown = await windowOf(home, env, { since: NOT_A_STEP })
  assert.equal(unknown.base, null)
  assert.deepEqual(Object.keys(unknown.usd), rids)
})

test('3.5 #51 --since past a page: next goes on with --from, and prev is null', async () => {
  const { home, env, id, steps, early } = await longSession()
  const w = await windowOf(home, env, { since: early }, id), first = steps.indexOf(early) + 1
  assert.equal(w.base, early)
  assert.equal(w.prev, null)
  assert.ok(w.next != null)
  assert.deepEqual(Object.keys(w.usd), steps.slice(first, first + Object.keys(w.usd).length))
  assert.equal(Object.keys((await windowOf(home, env, { from: w.next }, id)).usd)[0], steps[steps.indexOf(w.next) + 1])
})

test('3.5 #51 refused: more than one of --from, --to and --since', async () => {
  const { home, env, rid } = await worldOf(MIXED)
  for (const p of [{ from: rid[0], to: rid[1] }, { from: rid[0], since: rid[1] }, { to: rid[0], since: rid[1] }]) {
    await assert.rejects(windowOf(home, env, p), QueryArgError, JSON.stringify(p))
  }
})

test('3.5 #52 slices: past the slice size an answer gives way and says progress, and the document is the same', async () => {
  const { home, env, id, doc } = await longSession()
  let eased = false, said = false
  const got = await analysis(home, env, { ease: async () => { eased = true }, progress: () => { said = true } }, id)
  assert.deepEqual(got, doc)
  assert.ok(eased && said)
})

test('3.5 §会话读: a session nobody captured is said in errors with an empty document; no --id is refused', async () => {
  const home = homeOf()
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  const doc = await analysis(home, envOf(), {}, 'no-such-session')
  assert.deepEqual(doc.errors.map((e) => [e.where, e.code]), [['session/no-such-session', 'session-unknown']])
  const { schema, command, ok, errors, ...rest } = doc
  assert.deepEqual(rest, { mark: null, truncated: null, pricing: { source: doc.pricing.source, models: [] }, totals: null })
  const window = await windowOf(home, envOf(), { from: NOT_A_STEP }, 'no-such-session')
  assert.deepEqual(window.errors.map((e) => e.code), ['session-unknown'])
  const { schema: _s, command: _c, ok: _o, errors: _e, ...empty } = window
  assert.deepEqual(empty, { base: null, mark: null, truncated: null, pricing: { source: window.pricing.source, models: [] }, usd: {}, breaks: [], prev: null, next: null })
  await assert.rejects(runQuery('analysis', {}, { home, fs }), QueryArgError)
})
