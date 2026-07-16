import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { applyDDL } from '../../src/model/schema.mjs';

async function freshDb() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  // freshDb runs applyDDL on the REAL ddl.sql, whose comments contain ';' —
  // so every test here is also the regression fixture for the applyDDL blocker.
  await applyDDL(connection);
  return connection;
}

test('DDL applies clean (semicolon-bearing comments survive) and exposes sessions + calls', async () => {
  const db = await freshDb();
  await db.run('SELECT * FROM sessions LIMIT 0');
  await db.run('SELECT * FROM calls LIMIT 0');
  // D9: a control call is session-less (session_id NULL)
  await db.run(
    "INSERT INTO calls (call_id, session_id, class, control_kind, endpoint) " +
    "VALUES ('c-ctl', NULL, 'control', 'telemetry', '/v1/telemetry')",
  );
  const rows = (await db.runAndReadAll(
    "SELECT session_id, class FROM calls WHERE call_id = 'c-ctl'",
  )).getRowObjects();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, null);
  assert.equal(rows[0].class, 'control');
});

test('block dedup: distinct block_contents rows < total call_blocks refs', async () => {
  const db = await freshDb();
  await db.run("INSERT INTO block_contents (content_hash, section, kind, chars, faithfulness) VALUES ('h-sys', 'system', 'text', 10, 'verbatim')");
  await db.run("INSERT INTO block_contents (content_hash, section, kind, chars, faithfulness) VALUES ('h-a', 'messages', 'text', 5, 'verbatim')");
  await db.run("INSERT INTO block_contents (content_hash, section, kind, chars, faithfulness) VALUES ('h-b', 'messages', 'text', 7, 'verbatim')");
  // call A = [h-sys, h-a]; call B = [h-sys, h-b] -> h-sys stored once, referenced twice
  await db.run(
    "INSERT INTO call_blocks (call_id, seq, content_hash) VALUES " +
    "('A', 0, 'h-sys'), ('A', 1, 'h-a'), ('B', 0, 'h-sys'), ('B', 1, 'h-b')",
  );
  const [row] = (await db.runAndReadAll(
    'SELECT (SELECT count(*) FROM block_contents) AS n_contents, ' +
    '(SELECT count(*) FROM call_blocks) AS n_blocks',
  )).getRowObjects();
  assert.equal(Number(row.n_contents), 3);
  assert.equal(Number(row.n_blocks), 4);
  assert.ok(Number(row.n_contents) < Number(row.n_blocks), 'dedup must store fewer contents than refs');
});

test('usage cache_write NULL is preserved, never coerced to 0', async () => {
  const db = await freshDb();
  // A provider with no cache-write concept (e.g. DeepSeek) -> cache_write NULL
  await db.run(
    "INSERT INTO usage (call_id, input_uncached, cache_read, cache_write, output, total_input) " +
    "VALUES ('u1', 100, 20, NULL, 50, 120)",
  );
  const [row] = (await db.runAndReadAll(
    "SELECT cache_write, cache_read FROM usage WHERE call_id = 'u1'",
  )).getRowObjects();
  assert.equal(row.cache_write, null); // MUST NOT be 0
  assert.equal(Number(row.cache_read), 20);
});

test('D14 §验收#3: cost/price never a normalized-model column (cost is derived-only, not source truth)', async () => {
  const db = await freshDb();
  // Spec 2.2:43/2.2:89 + D14: unit price is an editable view-layer config; cost = usage × price is a
  // LOCAL estimate. It MUST NOT enter the normalized store (that would fake a wire fact as source truth,
  // 不变式2/4). Assert the real applied schema exposes no cost/price/usd column on ANY table or view.
  const hits = (await db.runAndReadAll(
    "SELECT table_name, column_name FROM information_schema.columns " +
    "WHERE lower(column_name) LIKE '%cost%' OR lower(column_name) LIKE '%price%' " +
    "OR lower(column_name) IN ('usd','dollars','amount','billing')",
  )).getRowObjects();
  assert.deepEqual(hits, [], 'no cost/price column may exist in the normalized model: ' + JSON.stringify(hits));
});

test('extra JSON round-trips losslessly via cast + json_extract_string', async () => {
  const db = await freshDb();
  const extra = { prompt_cache_key: 'k1', prompt_cache_options: { ttl: '1h' }, n: 3 };
  await db.run(
    `INSERT INTO cache_events (call_id, break_kind, extra) ` +
    `VALUES ('c1', 'automatic-prefix', '${JSON.stringify(extra)}')`,
  );
  const [row] = (await db.runAndReadAll(
    "SELECT CAST(extra AS VARCHAR) AS extra, " +
    "json_extract_string(extra, '$.prompt_cache_key') AS k FROM cache_events WHERE call_id = 'c1'",
  )).getRowObjects();
  assert.deepEqual(JSON.parse(row.extra), extra);
  assert.equal(row.k, 'k1');
});

test('control_calls shows only class=control; unmapped_fields aggregates extra keys', async () => {
  const db = await freshDb();
  await db.run("INSERT INTO sessions (session_id, harness, provider) VALUES ('s1', 'cc', 'anthropic')");
  await db.run(
    `INSERT INTO calls (call_id, session_id, class, endpoint, extra) ` +
    `VALUES ('L1', 's1', 'llm', '/v1/messages', '{"service_tier":"standard"}')`,
  );
  await db.run(
    "INSERT INTO calls (call_id, session_id, class, control_kind, endpoint) " +
    "VALUES ('K1', NULL, 'control', 'telemetry', '/telemetry')",
  );
  const ctl = (await db.runAndReadAll('SELECT call_id FROM control_calls')).getRowObjects();
  assert.deepEqual(ctl.map((r) => r.call_id), ['K1']);
  const um = (await db.runAndReadAll(
    'SELECT provider, harness, path, n FROM unmapped_fields',
  )).getRowObjects();
  assert.equal(um.length, 1);
  assert.equal(um[0].path, 'service_tier');
  assert.equal(um[0].provider, 'anthropic');
  assert.equal(um[0].harness, 'cc');
  assert.equal(Number(um[0].n), 1);
});
