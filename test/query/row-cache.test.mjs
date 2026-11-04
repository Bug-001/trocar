// test/query/row-cache.test.mjs — a row's `cache` (RFC 3.5 §会话读, #45; 2.2 §缓存判定): its state, hit and missed tokens by the table, the
// comparison step's usage from the columns, one value for a rid wherever the row is served, and those columns through the fold log's
// sidecar (3.5 #15). Sessions are hand-written envelopes in temp homes; every expected number is worked out from their usage.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { extendSession, saveIndexes } from '../../src/query/named/session.mjs'
import { columns, loadColumns, modelAt, stateAt, sync, usageAt, wireRow } from '../../src/query/session-doc.mjs'
import { openProjection } from '../../src/query/projection.mjs'
import { foldLogFile, openFoldLog } from '../../src/query/fold-log.mjs'
import { loadSidecar, saveSidecar } from '../../src/query/line-file.mjs'
import { CACHE_STATES } from '../../src/view/metrics.mjs'

const homeOf = () => path.join(tmpDir('trocar-rowcache-'), '.trocar')
const session = (home, params, ctx = {}) => runQuery('session', params, { home, fs, ...ctx })

const tool = (name) => ({ name, description: `${name} a file.`, input_schema: { type: 'object', properties: { path: { type: 'string' } } } })
const TOOLS = [tool('Read'), tool('Grep')]
const SWAPPED = [...TOOLS].reverse()
const usage = (read, create, fresh = 10) => ({ input_tokens: fresh, output_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: create })
// the conversation at its n-th question
const talk = (n) => Array.from({ length: 2 * n - 1 }, (_, i) => (i % 2 ? { role: 'assistant', content: [{ type: 'text', text: `a${(i + 1) / 2}` }] } : { role: 'user', content: [{ type: 'text', text: `q${i / 2 + 1}` }] }))
/** One Anthropic session from its steps {n: question, messages?, tools?, usage?, status?, model?, host?} (no `usage`: the reply has none). */
function writeSession(home, id, steps) {
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  const lines = steps.map(({ n, messages = talk(n), tools = TOOLS, usage: u, status = 200, model = 'claude-opus-4-8', host = 'api.anthropic.com' }, i) => {
    const ts = `2026-10-22T10:00:${String(i).padStart(2, '0')}.000Z`
    const body = status === 200 ? { id: `msg_${i}`, model, stop_reason: 'end_turn', content: [{ type: 'text', text: `a${n}` }], ...(u ? { usage: u } : null) } : { type: 'error', error: { type: 'api_error', message: 'boom' } }
    return JSON.stringify({ ts, endpoint: '/v1/messages', method: 'POST', id: `req_${i}`, ts_request: ts, is_llm_call: true, capture: 'transparent', host, traffic_class: 'llm',
      req_headers: { host, 'content-type': 'application/json', 'user-agent': 'claude-cli/2.0.0 (external, cli)', 'x-claude-code-session-id': id },
      req_body: JSON.stringify({ model, max_tokens: 1024, tools, system: [{ type: 'text', text: 'You are a coding assistant.' }], messages }),
      resp: { status, kind: 'json', body }, proc: { pid: 1, exe: '/x/claude', agent: 'claude-code' } })
  })
  fs.writeFileSync(path.join(home, 'raw', '20261022T100000Z.ndjson'), `${lines.join('\n')}\n`)
}
const ID = 'rowcache-0000-4a1b-9c2d-000000000001'
async function rowsOf(steps) {
  const home = homeOf()
  writeSession(home, ID, steps)
  const { calls } = await session(home, { id: ID })
  assert.equal(calls.length, steps.length)
  return calls
}

test('3.5 #45 states: first, reused, failed, no-usage and a reordered tool list each read as 2.2 says', async () => {
  const calls = await rowsOf([
    { n: 1, usage: usage(0, 900) },
    { n: 2, usage: usage(900, 50) },
    { n: 3, status: 500 },
    { n: 3 },
    { n: 4, tools: SWAPPED, usage: usage(100, 800) },
  ])
  const [first, reused, failed, noUsage, changed] = calls.map((r) => r.cache)
  assert.equal(first.state, 'first')
  assert.equal(first.hit, 0, '0 read of 910')
  assert.equal(first.break, undefined)
  assert.equal(reused.state, 'reused')
  assert.equal(reused.hit, 900 / 960)
  assert.equal(reused.quiet, 'append')
  assert.equal(reused.break, undefined)
  assert.equal(failed.state, 'failed')
  assert.ok(!('hit' in failed), 'a failed step has no hit')
  assert.equal(noUsage.state, 'no-usage')
  assert.ok(!('hit' in noUsage), 'no usage has no hit, not a zero one')
  assert.equal(changed.state, 'changed')
  assert.equal(changed.break, true)
  assert.equal(changed.hit, 100 / 910)
})

test('3.5 #45 warm: a first step that read from the cache is warm', async () => {
  const [row] = await rowsOf([{ n: 1, usage: usage(300, 0) }])
  assert.equal(row.cache.state, 'first')
  assert.equal(row.cache.warm, true)
})

test('3.5 #45 missed: max(0, ref.read + ref.create − read) against the step refRid names, a failed step between them', async () => {
  for (const [read, missed] of [[100, 850], [950, 0], [5000, 0]]) {
    const calls = await rowsOf([
      { n: 1, usage: usage(0, 900) },
      { n: 2, usage: usage(900, 50) },
      { n: 3, status: 500 },
      { n: 3, tools: SWAPPED, usage: usage(read, 40) },
    ])
    const row = calls[3]
    assert.equal(row.cacheBreak.refRid, calls[1].rid, 'the comparison step is the last one that chained a prefix, not the failed one')
    assert.equal(row.cache.missed, missed, `read ${read}`)
    assert.ok(!('why' in row.cache))
  }
})

test('3.5 #45 rewrite: the step that replaces the history with a summary says so in its cache, and no other row has the key', async () => {
  const summary = [{ role: 'user', content: [{ type: 'text', text: 'Summary of the conversation so far.' }] }]
  const calls = await rowsOf([...[1, 2, 3, 4, 5, 6].map((n) => ({ n, usage: usage(100 * n, 100) })), { n: 1, messages: summary, usage: usage(0, 800) }])
  assert.ok(calls[6].compaction, 'the seventh step is a compaction')
  assert.equal(calls[6].cache.rewrite, true)
  assert.deepEqual(calls.slice(0, 6).filter((r) => 'rewrite' in r.cache).map((r) => r.rid), [])
})

test('3.5 #45 one value: a rid\'s cache is the same in session, session --since, lane --pack and lane --tail', { timeout: 120_000 }, async () => {
  const home = homeOf()
  const s = bigSession({ home, growth: 300, subEvery: 4, compactAt: 3_000 })
  s.append(560)
  const before = await session(home, { id: s.id })
  s.append(40)
  const delta = await session(home, { id: s.id, since: before.mark })
  while (await extendSession({ home, writer: true }, s.id, Infinity));
  const whole = await session(home, { id: s.id })
  const byRid = new Map(whole.calls.map((r) => [r.rid, r.cache]))
  for (const r of whole.calls) assert.ok(CACHE_STATES.includes(r.cache?.state), `${r.rid}: every row has a state of the closed set`)
  assert.ok(delta.calls.length > 0)
  for (const r of delta.calls) assert.deepEqual(r.cache, byRid.get(r.rid), `--since ${r.rid}`)
  const linesOf = async (params) => (await runQuery('lane', { id: s.id, ...params }, { home, fs })).$text.trim().split('\n').map((l) => JSON.parse(l)).filter((o) => o.c).map((o) => o.c)
  const packed = [...await linesOf({ pack: '0.main' }), ...await linesOf({ pack: '0.rest' })], tail = [...await linesOf({ tail: 'main' }), ...await linesOf({ tail: 'rest' })]
  for (const [name, rows] of [['pack', packed], ['tail', tail]]) {
    assert.ok(rows.length > 0, `${name}: holds rows`)
    assert.ok(rows.some((r) => r.cache.break), `${name}: a break among them`)
    for (const r of rows) assert.deepEqual(r.cache, byRid.get(r.rid), `${name} ${r.rid}`)
  }
})

test('3.5 #45 #48 the columns read no row of the projection: a build over rows that cannot be read gives the same usage, NULL write counters and all', async () => {
  const home = homeOf(), key = ID
  writeSession(home, key, [
    { n: 1, usage: usage(0, 900) },
    { n: 2, usage: usage(900, 0) },
    { n: 3, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 } }, // no write counter at all
  ].map((s) => ({ ...s, host: 'api.deepseek.com' })))
  while (await extendSession({ home, writer: true }, key, Infinity));
  const doc = await session(home, { id: key })
  assert.deepEqual(doc.calls.map((r) => r.usage.create), [900, 0, null], 'a reported 0 stays 0, an unreported counter is NULL')
  const p = openProjection({ home, fs, key, write: false }), log = openFoldLog({ home, fs, key, write: false, projection: { id: p.id, bytes: p.bytes } })
  const unread = { slotOf: p.rows.slotOf, get() { throw new Error('a read of a projection row') } }
  const cols = sync(columns(unread), log)
  for (const r of doc.calls) assert.deepEqual(usageAt(cols, p.rows.slotOf(r.rid)), r.usage, r.rid)
  log.close()
})

test('3.5 #15: columns from the sidecar read as a sync from scratch; a sidecar without them is no sidecar, and the answer stays the same bytes', async () => {
  const home = homeOf(), key = ID
  writeSession(home, key, [
    { n: 1, usage: usage(0, 900) },
    { n: 2, usage: usage(900, 50), model: 'claude-haiku-4-5' },
    { n: 3, status: 500 },
    { n: 3 },
    { n: 4, tools: SWAPPED, usage: usage(100, 800) },
  ])
  while (await extendSession({ home, writer: true }, key, Infinity));
  saveIndexes()
  const doc = await session(home, { id: key })
  const p = openProjection({ home, fs, key, write: false }), log = openFoldLog({ home, fs, key, write: false, projection: { id: p.id, bytes: p.bytes } })
  assert.ok(log.saved, 'the worker saved a sidecar')
  const loaded = loadColumns(p.rows, log.saved.parts), scratch = sync(columns(p.rows), log)
  assert.ok(loaded, 'the sidecar loads')
  for (const r of doc.calls) {
    const k = p.rows.slotOf(r.rid)
    for (const cols of [loaded, scratch]) {
      assert.deepEqual(usageAt(cols, k), r.usage ?? null, `${r.rid}: usage`)
      assert.equal(modelAt(cols, k), r.rec.request.model, `${r.rid}: model`)
      assert.equal(stateAt(cols, k), r.cache.state, `${r.rid}: state`)
    }
  }
  const { 's.ur': _ur, ...older } = log.saved.parts
  assert.equal(loadColumns(p.rows, older), null, 'a sidecar without the new columns is not loaded')
  log.close()
  const before = JSON.stringify(await session(home, { id: key }, { fs: { ...fs } }))
  const file = foldLogFile(home, key), sc = loadSidecar({ file }), { 's.ur': _gone, ...rest } = sc.parts
  saveSidecar({ file, head: sc.head, parts: Object.entries(rest) })
  assert.equal(JSON.stringify(await session(home, { id: key }, { fs: { ...fs } })), before, 'the answer over the older sidecar')
})
