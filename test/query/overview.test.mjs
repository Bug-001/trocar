// test/query/overview.test.mjs — `trocar query overview` (RFC 1.6 §4.1 · 附录 C.5 `overview`; 3.5 §访问模式; 1.7 统计卡).
// The usage-bearing records are the captured bytes of test/fixtures/old-capture-resp-shapes.ndjson (regression seeds):
// only their time, session id, host and retention are restamped, the reply bytes are as captured.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rawHome, writeSegment, envLine } from './raw-home.mjs'
import { runQuery, OVERVIEW_USAGE_BYTES } from '../../src/query/named/index.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'

const SEG = '20261018T100000Z'
const T0 = Date.parse('2026-10-18T10:00:00.000Z')
const at = (s) => new Date(T0 + s * 1000).toISOString()
const SEED = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/old-capture-resp-shapes.ndjson'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l))
const SID_HEADER = Object.keys(SEED[0].req_headers).find((k) => /session-id$/.test(k))

/** Seed line `i`, restamped: own time, session, id, and whatever `over` sets. */
const seed = (i, { s, session, id, ...over }) => JSON.stringify({ ...SEED[i], ts: at(s), ts_request: at(s), id: id ?? `r-${session}-${s}`,
  req_headers: { ...SEED[i].req_headers, [SID_HEADER]: session }, ...over })
const logged = (o) => { const r = JSON.parse(seed(0, o)); return JSON.stringify({ ...r, body_retention: 'log', req_body: { raw_chars: 116, verbatim: false } }) }

const homeWith = async (lines) => {
  const home = rawHome()
  writeSegment(home, SEG, lines)
  await segmentIndex({ home, segment: SEG, owner: true }) // the index the daemon keeps (4.2 §段索引)
  return home
}
const rowCalls = (doc) => doc.usage.rows.reduce((n, r) => n + r.calls, 0)

test('3.5 除 usage 外只读段索引: a session past the byte budget is not read, and coverage says so', async () => {
  const home = await homeWith([
    seed(0, { s: 1, session: 'old' }),
    envLine({ ts: at(2), id: 'telemetry', class: 'telemetry', is_llm: false }),
    // the newest session, bigger than the budget on its own
    seed(0, { s: 3, session: 'big', req_body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(OVERVIEW_USAGE_BYTES) }] }) }),
  ])
  let opened = 0
  const body = (p) => (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p)) && /[\\/]raw[\\/][^\\/]+\.(ndjson|sealed)$/.test(String(p))
  const count = (fn) => function (p, ...a) { if (body(p)) opened++; return fn.call(this, p, ...a) }
  const f = { ...fs, openSync: count(fs.openSync), readFileSync: count(fs.readFileSync), createReadStream: count(fs.createReadStream),
    open: count(fs.open), readFile: count(fs.readFile), promises: { ...fs.promises, open: count(fs.promises.open), readFile: count(fs.promises.readFile) } }
  const doc = await runQuery('overview', {}, { home, fs: f })
  assert.deepEqual(doc.usage.coverage, { sessions_read: 0, sessions_in_window: 2, capped_at: OVERVIEW_USAGE_BYTES, reason: 'byte-budget' })
  assert.deepEqual(doc.usage.rows, [])
  assert.equal(opened, 0)
  assert.equal(doc.sessions.total, 2)
  assert.deepEqual(doc.calls, { total: 3, llm: 2, logged: 0, failed: 0 })
  assert.equal(doc.harnesses.reduce((n, h) => n + h.sessions, 0), 2)
  assert.equal(doc.harnesses.reduce((n, h) => n + h.calls, 0), 2)
  assert.equal(doc.as_of, at(3))
})

test('3.5 影响面: with budget enough, every in-window session is read and nothing is capped', async () => {
  const home = await homeWith([seed(0, { s: 1, session: 'a' }), seed(4, { s: 2, session: 'b' })])
  const { usage } = await runQuery('overview', {}, { home })
  assert.deepEqual(usage.coverage, { sessions_read: 2, sessions_in_window: 2, capped_at: null, reason: null })
})

test('1.7:145 usage.rows[].calls of a session equals that session\'s calls in `sessions`', async () => {
  const home = await homeWith([
    // json / sse / failed / empty replies on the Messages wire (one session speaks one wire)
    ...SEED.slice(0, 5).map((r, i) => seed(i, { s: i + 1, session: 'mix' })),
    // a count_tokens probe as the collector writes it: not an inference call (src/capture/envelope.mjs)
    seed(0, { s: 10, session: 'mix', id: 'probe', endpoint: '/v1/messages/count_tokens', is_llm_call: false, traffic_class: 'token-count' }),
    logged({ s: 11, session: 'mix' }),
    seed(0, { s: 12, session: 'mix', id: 'telemetry', is_llm_call: false, traffic_class: 'telemetry', endpoint: '/api/event_logging/batch' }),
  ])
  const doc = await runQuery('overview', {}, { home })
  const s = (await runQuery('sessions', {}, { home })).sessions.find((x) => x.session_id === 'mix')
  assert.equal(doc.usage.coverage.sessions_read, 1)
  assert.equal(rowCalls(doc), s.calls)
  assert.equal(doc.calls.llm, s.calls)
  assert.equal(doc.calls.logged, s.logged)
})

test('3.2 NULL write: a vendor that reports no write counter → cache_write null; a reply with no usage → no_usage, never 0 tokens', async () => {
  const home = await homeWith([
    seed(0, { s: 1, session: 'ds', host: 'api.deepseek.com' }), // anthropic wire, usage without cache_creation
    seed(3, { s: 2, session: 'ds', host: 'api.deepseek.com' }), // status 200, empty reply: no usage
  ])
  const { usage } = await runQuery('overview', {}, { home })
  assert.equal(usage.rows.length, 1)
  const [row] = usage.rows
  assert.equal(row.cache_write, null)
  assert.equal(row.calls, 2)
  assert.equal(row.failed, 0)
  assert.equal(row.no_usage, 1)
  assert.equal(row.input, SEED[0].resp.body.usage.input_tokens)
  assert.equal(row.output, SEED[0].resp.body.usage.output_tokens)
})

test('C.5 window: a session whose last call is in the window counts whole; one that ended before it does not', async () => {
  const home = await homeWith([
    seed(0, { s: 1, session: 'ended' }),
    seed(0, { s: 2, session: 'spans' }), // before --since …
    seed(0, { s: 20, session: 'spans' }), // … and its last call inside
    envLine({ ts: at(3), id: 'early', class: 'telemetry', is_llm: false }),
    envLine({ ts: at(21), id: 'late', class: 'telemetry', is_llm: false }),
  ])
  const doc = await runQuery('overview', { since: at(10) }, { home })
  assert.equal(doc.sessions.total, 1)
  assert.deepEqual(doc.calls, { total: 3, llm: 2, logged: 0, failed: 0 })
  assert.equal(rowCalls(doc), 2)
  assert.equal(doc.usage.coverage.sessions_in_window, 1)
})

test('3.5 Edge 空数据: an empty home answers zeros and null, not an error', async () => {
  const doc = await runQuery('overview', {}, { home: rawHome() })
  assert.equal(doc.sessions.total, 0)
  assert.deepEqual(doc.usage.rows, [])
  assert.equal(doc.usage.coverage.sessions_in_window, 0)
  assert.equal(doc.as_of, null)
  assert.deepEqual(doc.errors, [])
})

test('D38: a record of a read session that cannot be read back is named in errors, and the document is produced', async () => {
  const home = await homeWith([seed(0, { s: 1, session: 'a', id: 'good' }), seed(0, { s: 2, session: 'a', id: 'bad' })])
  const file = path.join(home, 'raw', `${SEG}.ndjson`)
  const second = fs.readFileSync(file, 'utf8').indexOf('\n') + 1
  // the bytes on disk turn unreadable after they were indexed: the read-back lands on a record that does not parse
  const fds = new Set()
  const f = { ...fs,
    openSync: (p, ...a) => { const fd = fs.openSync(p, ...a); if (String(p) === file) fds.add(fd); return fd },
    readSync: (fd, buf, off, len, pos) => { const n = fs.readSync(fd, buf, off, len, pos); if (fds.has(fd) && pos === second - 1) buf[off + 2] = 0x23; return n } }
  const doc = await runQuery('overview', {}, { home, fs: f })
  assert.equal(doc.ok, false)
  assert.ok(doc.errors.some((e) => e.where.endsWith(':2')), JSON.stringify(doc.errors))
  assert.equal(doc.sessions.total, 1)
  assert.equal(doc.usage.coverage.sessions_read, 1)
})
