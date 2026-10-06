// test/etl/d40-columns.test.mjs — the D40 projection (RFC 3.2 §D40 + 验收 #5, 4.2 验收 #8, 4.1 #9): the six new `calls` columns,
// the three body_retention states, a `log`-level inference call that must not crash or invent a context, the stored size
// (record_bytes) read off the real file, the migration of an older store, and the source files left alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DuckDBInstance } from '@duckdb/node-api'
import { runEtl, rebuild, PROJECTION_VERSION } from '../../src/etl/orchestrator.mjs'
import { etlFile } from '../../src/etl/cli.mjs'
import { applyDDL } from '../../src/model/schema.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { freshConn, dumpAll } from './helpers.mjs'
import { preD40, full, logged, inference, line, HOST } from '../fixtures/d40-records.mjs'

const rows = async (conn, sql) => (await conn.runAndReadAll(sql)).getRowObjects()
const num = (v) => (v == null ? null : Number(v))
const calls = async (conn) => Object.fromEntries((await rows(conn, 'SELECT * FROM calls')).map((r) => [r.call_id, r]))

test('3.2 #5 — the six D40 columns hold the expected values for a D40 record, a log record, a pre-D40 record and a pre-D40 inference call', async () => {
  const conn = await freshConn()
  const old = preD40({ id: 'old', rawChars: 4321 })
  const oldInference = { ...inference({ id: 'oldllm', at: 5 }), host: undefined, proc: undefined, traffic_class: undefined, body_wire_bytes: undefined, capture: 'mitm' }
  const body = '{"events":[{"name":"tengu_start"},{"name":"tengu_exit"}]}'
  await runEtl([old, full({ id: 'new', at: 2, reqBody: body, wire: [Buffer.byteLength(body), 77] }),
    logged({ id: 'log', at: 3, wire: [9000, 21], endpoint: '/api/oauth/file_upload', cls: 'files' }), oldInference], conn)
  const c = await calls(conn)

  // a record from before D40: harness by UA (inferred), host from the Host header, class from the same table the capture uses,
  // the request size is raw_chars, the response size and the stored size were never recorded → NULL, not 0
  assert.deepEqual([c.old.harness, c.old.host, c.old.traffic_class, c.old.body_retention, num(c.old.request_bytes), num(c.old.response_bytes), num(c.old.record_bytes)],
    ['cc', HOST, 'telemetry', 'legacy-meta', 4321, null, null])

  // a D40 record: the envelope's own host / class, the exact wire sizes (response too), harness from proc
  assert.deepEqual([c.new.harness, c.new.host, c.new.traffic_class, c.new.body_retention, num(c.new.request_bytes), num(c.new.response_bytes)],
    ['cc', HOST, 'telemetry', 'full', Buffer.byteLength(body), 77])

  // a `log` record: a call row like any other; the sizes are the wire sizes the envelope counted
  assert.deepEqual([c.log.traffic_class, c.log.body_retention, num(c.log.request_bytes), num(c.log.response_bytes)], ['files', 'log', 9000, 21])

  // an inference call from before D40: always verbatim → full; class from the endpoint; the request size is its text's length; no response count
  assert.deepEqual([c.oldllm.traffic_class, c.oldllm.body_retention, num(c.oldllm.response_bytes)], ['llm', 'full', null])
  assert.ok(num(c.oldllm.request_bytes) > 0)
})

test('the columns are not invented where nothing says them: no host → NULL, an unknown agent is harness NULL, no stored size → NULL', async () => {
  const conn = await freshConn()
  await runEtl([full({ id: 'x', host: null, proc: { pid: 1, exe: '/x/mystery', agent: 'mystery' }, headers: { 'user-agent': 'curl/8' } })], conn)
  const [r] = await rows(conn, "SELECT harness, host, traffic_class, record_bytes FROM calls WHERE call_id = 'x'")
  assert.deepEqual([r.harness, r.host, r.traffic_class, r.record_bytes], [null, null, 'telemetry', null])
})

test('K7 — an inference call at the log level is one calls row: no blocks, no usage, no cache_events, no quarantine, no crash; the calls around it are unaffected', async () => {
  const conn = await freshConn()
  const recs = [inference({ id: 'a1', at: 1, text: 'one' }), inference({ id: 'a2', at: 2, retention: 'log' }), inference({ id: 'a3', at: 3, text: 'three' })]
  const stats = await runEtl(recs, conn)
  assert.equal(stats.quarantined, 0, 'a log-level call is claimed, not quarantined')
  const c = await calls(conn)
  assert.deepEqual([c.a2.class, c.a2.body_retention, c.a2.traffic_class, c.a2.session_id, c.a2.lane, c.a2.stream, c.a2.compaction, c.a2.wire_format, c.a2.context_state],
    ['llm', 'log', 'llm', 'S-d40', null, false, false, null, null], 'attributed to its session by the headers it kept; lane and wire unknown without a body')
  for (const t of ['call_blocks', 'usage', 'cache_events']) assert.equal(num((await rows(conn, `SELECT count(*) AS n FROM ${t} WHERE call_id = 'a2'`))[0].n), 0, `${t}: nothing is invented for it`)
  assert.equal(num((await rows(conn, "SELECT count(*) AS n FROM usage WHERE call_id IN ('a1','a3')"))[0].n), 2, 'its neighbours keep their usage rows')
  // the log call is not the baseline of the next call's cache facts or compaction verdict
  const ce = await rows(conn, "SELECT call_id, break_kind FROM cache_events WHERE call_id IN ('a1','a3') ORDER BY call_id")
  const alone = await freshConn(); await runEtl([recs[0], recs[2]], alone)
  assert.deepEqual(ce, await rows(alone, "SELECT call_id, break_kind FROM cache_events ORDER BY call_id"), 'a3 is judged against a1, as if the log call were not there')
  assert.equal(c.a3.compaction, false)
})

test('a keyless logged inference call stays keyless and goes to the session-less rows, however its harness synthesizes keys', async () => {
  const conn = await freshConn()
  const kimi = { proc: { pid: 9, exe: '/x/kimi', agent: 'kimi-code' }, headers: { 'user-agent': 'kimi/2' } }
  const k = logged({ id: 'k1', endpoint: '/coding/v1/messages', cls: 'llm', llm: true, ...kimi })
  await runEtl([k], conn)
  const [r] = await rows(conn, "SELECT session_id, class, body_retention, harness FROM calls WHERE call_id = 'k1'")
  assert.deepEqual([r.session_id, r.class, r.body_retention, r.harness], [null, 'llm', 'log', 'kimi'])
})

test('non-inference calls keep their old compaction / lane facts although count_tokens now stores a context copy (no verdict from a non-inference body)', async () => {
  const conn = await freshConn()
  const ctx = (n) => JSON.stringify({ model: 'm', system: [{ type: 'text', text: 's' }], messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i })) })
  const probe = (id, at, n) => full({ id, at, endpoint: '/v1/messages/count_tokens', cls: 'token-count', headers: { 'user-agent': 'claude-cli/2', host: HOST, 'x-claude-code-session-id': 'S-d40' }, reqBody: ctx(n) })
  await runEtl([probe('p1', 1, 60), probe('p2', 2, 5)], conn) // a "sharp drop" in a probe lane's copies is not a compaction
  const c = await calls(conn)
  assert.deepEqual([c.p1.lane, c.p1.compaction, c.p2.compaction, c.p2.traffic_class, c.p2.body_retention], ['probe', false, false, 'token-count', 'full'])
})

test('rebuild == incremental with D40 records in the stream (3.2 验收 D40 列)', async () => {
  const recs = [inference({ id: 'a1', at: 1 }), full({ id: 't1', at: 2 }), logged({ id: 'l1', at: 3 }), preD40({ id: 'o1', at: 4 }), inference({ id: 'a2', at: 5, retention: 'log' }), inference({ id: 'a3', at: 6, text: 'x' })]
  const inc = await freshConn()
  await runEtl(recs.slice(0, 3), inc); await runEtl(recs, inc)
  const all = await freshConn()
  await rebuild(recs, all)
  assert.deepEqual(await dumpAll(inc), await dumpAll(all))
})

test('record_bytes is the size of the record\'s line on disk, newline included — read off the real file, the same after a rebuild', async () => {
  const dir = tmpDir('asight-d40-etl-')
  const recs = [inference({ id: 'a1', at: 1, text: 'héllo wörld · 你好' }), full({ id: 't1', at: 2 }), preD40({ id: 'o1', at: 3 }), logged({ id: 'l1', at: 4 })]
  const file = path.join(dir, 'capture-2026-10-06.ndjson')
  fs.writeFileSync(file, recs.map(line).join(''))
  const want = Object.fromEntries(recs.map((r) => [r.id, Buffer.byteLength(line(r))])) // hand-computed from the bytes written
  assert.equal(Object.values(want).reduce((a, b) => a + b, 0), fs.statSync(file).size, 'the lines add up to the file')
  const dbPath = path.join(dir, 'a.duckdb')
  await etlFile(file, { dbPath })
  const db = await DuckDBInstance.create(dbPath); const conn = await db.connect()
  const got = Object.fromEntries((await rows(conn, 'SELECT call_id, record_bytes FROM calls')).map((r) => [r.call_id, num(r.record_bytes)]))
  assert.deepEqual(got, want)
  conn.closeSync?.(); db.closeSync?.()
  await etlFile(file, { dbPath, rebuild: true })
  const db2 = await DuckDBInstance.create(dbPath); const c2 = await db2.connect()
  assert.deepEqual(Object.fromEntries((await rows(c2, 'SELECT call_id, record_bytes FROM calls')).map((r) => [r.call_id, num(r.record_bytes)])), want)
  c2.closeSync?.(); db2.closeSync?.()
})

test('4.2 #8 — the ETL leaves the source files alone (sha256, inode, mtime, size) and a D40 record is never rewritten', async () => {
  const dir = tmpDir('asight-d40-src-')
  const file = path.join(dir, 'capture.ndjson')
  fs.writeFileSync(file, [preD40({ id: 'o1' }), full({ id: 't1', at: 2 }), logged({ id: 'l1', at: 3 })].map(line).join(''))
  const snap = () => { const st = fs.statSync(file); return { sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), ino: st.ino, mtime: st.mtimeMs, size: st.size } }
  const before = snap()
  await etlFile(file, { dbPath: path.join(dir, 'a.duckdb') })
  assert.deepEqual(snap(), before)
})

test('a store written before D40 gets the columns by ALTER, keeps its rows with NULLs, and is refused for an incremental run until --rebuild', async () => {
  const cols = async (c) => (await rows(c, "SELECT column_name FROM information_schema.columns WHERE table_name = 'calls' ORDER BY ordinal_position")).map((r) => r.column_name)
  const fresh = await freshConn()
  const old = await (await DuckDBInstance.create(':memory:')).connect()
  // the D37-era calls table (what a store built before this change holds), then the current DDL over it
  await old.run('CREATE TABLE calls (call_id TEXT PRIMARY KEY, session_id TEXT, seq INT, ts TIMESTAMP, endpoint TEXT, model TEXT, stream BOOL, class TEXT, control_kind TEXT, lane TEXT, request_bytes INT, raw_ref TEXT, stop_reason TEXT, duration_ms INT, error TEXT, compaction BOOL, compaction_from INT, compaction_to INT, unmapped_count INT, extra JSON, wire_format TEXT, vendor TEXT, transport TEXT, context_state TEXT, observer_effect JSON)')
  await old.run("INSERT INTO calls (call_id, class) VALUES ('old-1', 'control')")
  await applyDDL(old)
  assert.deepEqual(await cols(old), await cols(fresh), 'the same columns in the same order as a fresh store')
  const [r] = await rows(old, "SELECT harness, host, traffic_class, body_retention, response_bytes, record_bytes FROM calls WHERE call_id = 'old-1'")
  assert.deepEqual(Object.values(r), [null, null, null, null, null, null], 'the old row stays, the new columns are NULL')
  await old.run('CREATE TABLE IF NOT EXISTS etl_meta (key VARCHAR PRIMARY KEY, value VARCHAR)')
  await old.run("INSERT INTO etl_meta VALUES ('projection_version', '3')")
  await assert.rejects(runEtl([full({ id: 'n1' })], old), /projection version 3, and this code writes version 4.*--rebuild/)
  assert.equal(PROJECTION_VERSION, 4)
  await rebuild([full({ id: 'n1' })], old)
  assert.equal((await calls(old)).n1.traffic_class, 'telemetry')
})

test('a 2 MiB non-inference body is neither parsed for a session key nor held by the lineage pass; an inference body of that size still is', async () => {
  const conn = await freshConn()
  const big = JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) })
  const upload = full({ id: 'up', at: 1, endpoint: '/api/oauth/file_upload', cls: 'files', reqBody: big, headers: { 'user-agent': 'claude-cli/2', host: HOST } })
  await runEtl([upload, inference({ id: 'a1', at: 2 })], conn)
  const c = await calls(conn)
  assert.deepEqual([c.up.traffic_class, num(c.up.request_bytes), c.up.body_retention], ['files', Buffer.byteLength(big), 'full'])
  const { bodyOf } = await import('../../src/dissect/harnesses.mjs')
  assert.equal(bodyOf(upload), null, 'not parsed for identity')
  assert.ok(bodyOf({ ...upload, is_llm_call: true }), 'an inference body of the same size is parsed as before')
})
