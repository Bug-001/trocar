// test/query/retention-sizes.test.mjs — 「保存什么」 sizes (RFC 4.6 验收 K6, 3.5 「保存什么」行): per (harness, class, retention), over 24 h / 7 d /
// all, the number of calls, the wire bytes, the stored bytes — against values worked out by hand from the fixture below. Windows are
// counted back from an injected `now`, so the numbers do not move with the clock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runEtl } from '../../src/etl/orchestrator.mjs'
import { retentionSizes } from '../../src/query/queries.mjs'
import { NAMED_QUERIES, runNamed } from '../../src/query/index.mjs'
import { freshConn } from '../etl/helpers.mjs'
import { DuckDBInstance } from '@duckdb/node-api'
import fs from 'node:fs'
import path from 'node:path'
import { etlFile } from '../../src/etl/cli.mjs'
import { retentionReport } from '../../src/query/retention.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { line } from '../fixtures/d40-records.mjs'
import { preD40, full, logged, inference, sized } from '../fixtures/d40-records.mjs'

const NOW = Date.parse('2026-10-07T12:00:00.000Z') // 24 h back = 10-06 12:00, 7 d back = 09-30 12:00
const CODEX = { pid: 7, exe: '/x/codex', agent: 'codex' }
const MYSTERY = { pid: 8, exe: '/x/z', agent: 'mystery' }

// the fixture, with the sums worked out by hand next to each record
const records = () => [
  sized(full({ id: 'r1', at: '2026-10-07T11:00:00.000Z', cls: 'telemetry', reqBody: 'x', wire: [1000, 50] }), 1500),   // in all three windows
  sized(full({ id: 'r2', at: '2026-10-05T12:00:00.000Z', cls: 'telemetry', reqBody: 'x', wire: [2000, 70] }), 2500),   // 7 d and all
  sized(full({ id: 'r3', at: '2026-09-01T12:00:00.000Z', cls: 'telemetry', reqBody: 'x', wire: [4000, 90] }), 4500),   // all only
  sized(logged({ id: 'r4', at: '2026-10-07T10:00:00.000Z', cls: 'telemetry', wire: [9000, 21] }), 700),                 // log, all three
  sized(preD40({ id: 'r5', at: '2026-10-07T09:00:00.000Z', rawChars: 321 }), 400),                                      // legacy-meta telemetry (by table), all three
  sized(inference({ id: 'r6', at: '2026-10-07T08:00:00.000Z', wire: [5000, 3000] }), 5600),                             // cc · llm
  sized(full({ id: 'r7', at: '2026-10-07T07:00:00.000Z', cls: 'files', proc: CODEX, host: 'chatgpt.com', reqBody: 'x', wire: [100, 4000], headers: { 'user-agent': 'codex_cli_rs/0.1' } }), 4300),
  sized(full({ id: 'r8', at: '2026-10-07T06:00:00.000Z', cls: 'other', proc: MYSTERY, host: 'x.test', reqBody: 'x', wire: [1, 2], headers: { 'user-agent': 'z' } }), 3),
  full({ id: 'r9', at: '2026-10-07T05:00:00.000Z', cls: 'telemetry', reqBody: 'x', wire: [10, 20] }),                       // a record whose stored size is not known (fed as an object)
]

async function store() { const conn = await freshConn(); await runEtl(records(), conn); return conn }
const cell = (sizes, harness, cls, retention, win) => sizes.rows.find((r) => r.harness === harness && r.class === cls && r.retention === retention).windows[win]

test('K6 — sizes per (harness, class, retention) over 24 h / 7 d / all match the hand-computed values', async () => {
  const s = await retentionSizes(await store(), { now: NOW })
  assert.equal(s.as_of, '2026-10-07 11:00:00', 'as of the newest call the projection holds')
  assert.equal(s.windows_end, '2026-10-07T12:00:00.000Z')
  // cc · telemetry · full = r1 r2 r3 r9
  assert.deepEqual(cell(s, 'cc', 'telemetry', 'full', '24h'), { calls: 2, request_bytes: 1010, response_bytes: 70, response_unrecorded: 0, stored_bytes: 1500, stored_unrecorded: 1 })
  assert.deepEqual(cell(s, 'cc', 'telemetry', 'full', '7d'), { calls: 3, request_bytes: 3010, response_bytes: 140, response_unrecorded: 0, stored_bytes: 4000, stored_unrecorded: 1 })
  assert.deepEqual(cell(s, 'cc', 'telemetry', 'full', 'all'), { calls: 4, request_bytes: 7010, response_bytes: 230, response_unrecorded: 0, stored_bytes: 8500, stored_unrecorded: 1 })
  // cc · telemetry · log = r4: the wire sizes the envelope counted, the stored size of the one line
  assert.deepEqual(cell(s, 'cc', 'telemetry', 'log', '24h'), { calls: 1, request_bytes: 9000, response_bytes: 21, response_unrecorded: 0, stored_bytes: 700, stored_unrecorded: 0 })
  // the pre-D40 record is its own row: its request size is the length it kept, its response size was never recorded (counted apart, not added as 0)
  assert.deepEqual(cell(s, 'cc', 'telemetry', 'legacy-meta', 'all'), { calls: 1, request_bytes: 321, response_bytes: 0, response_unrecorded: 1, stored_bytes: 400, stored_unrecorded: 0 })
  assert.deepEqual(cell(s, 'cc', 'llm', 'full', '24h'), { calls: 1, request_bytes: 5000, response_bytes: 3000, response_unrecorded: 0, stored_bytes: 5600, stored_unrecorded: 0 })
  assert.deepEqual(cell(s, 'codex', 'files', 'full', 'all'), { calls: 1, request_bytes: 100, response_bytes: 4000, response_unrecorded: 0, stored_bytes: 4300, stored_unrecorded: 0 })
  assert.deepEqual(cell(s, 'unknown', 'other', 'full', '7d'), { calls: 1, request_bytes: 1, response_bytes: 2, response_unrecorded: 0, stored_bytes: 3, stored_unrecorded: 0 }, 'an agent no row claims is `unknown`, as in the settings')
  // the calls of every row add up to the calls table
  const all = s.rows.reduce((n, r) => n + r.windows.all.calls, 0)
  assert.equal(all, records().length)
  // rows come out in a stable order: harness, then the class order, then full · log · legacy-meta
  assert.deepEqual(s.rows.filter((r) => r.harness === 'cc').map((r) => `${r.class}/${r.retention}`), ['llm/full', 'telemetry/full', 'telemetry/log', 'telemetry/legacy-meta'])
})

test('a window is counted back from `now`: the same store read three days later shows fewer calls in 24 h and 7 d and the same in all', async () => {
  const conn = await store()
  // now = 10-10 12:00: 24 h back = 10-09 12:00 (none), 7 d back = 10-03 12:00 (r1, r2, r9 — r3 of 09-01 has left it)
  const later = await retentionSizes(conn, { now: NOW + 3 * 24 * 3600e3 })
  assert.deepEqual([cell(later, 'cc', 'telemetry', 'full', '24h').calls, cell(later, 'cc', 'telemetry', 'full', '7d').calls, cell(later, 'cc', 'telemetry', 'full', 'all').calls], [0, 3, 4])
})

test('no row is invented for an empty store: no rows, no as_of — and an empty answer is not a 0 that stands for something', async () => {
  const s = await retentionSizes(await freshConn(), { now: NOW })
  assert.deepEqual([s.rows, s.as_of], [[], null])
})

test('a store from before D40 is not read as zeros: the query names the missing columns and the command that fixes it', async () => {
  const old = await (await DuckDBInstance.create(':memory:')).connect()
  await old.run('CREATE TABLE calls (call_id TEXT, ts TIMESTAMP, request_bytes INT)')
  await assert.rejects(retentionSizes(old, { now: NOW }), (e) => e.code === 'predates-d40' && /harness.*record_bytes|run asight etl .* --rebuild/.test(e.message))
})

test('the named-query contract carries it (3.5: the frontend and the server ask by name)', async () => {
  assert.ok(NAMED_QUERIES.retentionSizes)
  const s = await runNamed(await store(), 'retentionSizes')
  assert.ok(s.rows.length > 0)
})

// review (F2): `asight etl` runs applyDDL — which ADDS the six columns, NULL in every old row — and only then refuses the incremental run
// of a version-3 store. The columns are there, so "no such column" no longer tells; the store's projection version does. Without it the
// report said every old telemetry / session-sync row was 「保存全部」 · `other` — a claim about bytes nobody checked (invariant 4).
test('a version-3 store that `asight etl` has already ALTERed (the six columns there, NULL) is refused, not read as full / other', async () => {
  const dir = tmpDir('asight-v3-')
  const file = path.join(dir, 'capture.ndjson')
  fs.writeFileSync(file, [full({ id: 't1', at: 1 }), full({ id: 't2', at: 2, endpoint: '/v1/code/sessions/cse_1/worker/events', cls: 'session-sync' })].map(line).join(''))
  const dbPath = path.join(dir, 'a.duckdb')
  await etlFile(file, { dbPath })
  // make it what a version-3 store looks like after the real `asight etl` of this code: version 3, the D40 columns NULL
  const db = await DuckDBInstance.create(dbPath); const conn = await db.connect()
  await conn.run("UPDATE etl_meta SET value = '3' WHERE key = 'projection_version'")
  await conn.run('UPDATE calls SET harness = NULL, host = NULL, traffic_class = NULL, body_retention = NULL, response_bytes = NULL, record_bytes = NULL')
  conn.closeSync?.(); db.closeSync?.()
  // the real etlFile: applyDDL runs first (columns present), then runEtl refuses the incremental run
  await assert.rejects(etlFile(file, { dbPath }), /incremental ETL refused.*projection version 3.*--rebuild/)
  const db2 = await DuckDBInstance.create(dbPath); const c2 = await db2.connect()
  try {
    await assert.rejects(retentionSizes(c2, { now: NOW }), (e) => e.code === 'predates-d40' && /projection version 3/.test(e.message) && /--rebuild/.test(e.message))
    const rep = await retentionReport({ home: dir, conn: c2, now: NOW })
    assert.equal(rep.sizes, null, 'no sizes: not a table of `unknown · other · full` rows')
    assert.match(rep.sizes_reason, /需要重建.*projection version 3/)
    // after the rebuild the same store reads again, with the real values
    await etlFile(file, { dbPath, rebuild: true })
  } finally { c2.closeSync?.(); db2.closeSync?.() }
  const db3 = await DuckDBInstance.create(dbPath); const c3 = await db3.connect()
  try {
    const s = await retentionSizes(c3, { now: NOW })
    assert.deepEqual(s.rows.map((r) => `${r.harness}/${r.class}/${r.retention}`), ['cc/session-sync/full', 'cc/telemetry/full'])
  } finally { c3.closeSync?.(); db3.closeSync?.() }
})

test('a current-version store with a row that has no body_retention / traffic_class is refused too, never coalesced into 「保存全部」 · other', async () => {
  const conn = await store()
  await conn.run("UPDATE calls SET body_retention = NULL WHERE call_id = 'r1'")
  await assert.rejects(retentionSizes(conn, { now: NOW }), (e) => e.code === 'predates-d40' && /1 row\(s\) have no body_retention/.test(e.message))
})
