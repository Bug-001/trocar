import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  ensureWatermarkTable,
  getConsumed,
  setConsumed,
  resetWatermark,
  CONTROL_KEY,
} from '../../src/etl/watermark.mjs';

const conn = async () => await (await DuckDBInstance.create(':memory:')).connect();

test('missing session watermark defaults to 0', async () => {
  const c = await conn();
  await ensureWatermarkTable(c);
  assert.equal(await getConsumed(c, 'sess-abc'), 0);
});

test('setConsumed persists, getConsumed reads back, keys are independent', async () => {
  const c = await conn();
  await ensureWatermarkTable(c);
  await setConsumed(c, 'sess-abc', 3, '2026-07-15T00:00:00Z');
  assert.equal(await getConsumed(c, 'sess-abc'), 3);
  await setConsumed(c, 'sess-abc', 7); // advance same key
  assert.equal(await getConsumed(c, 'sess-abc'), 7);
  assert.equal(await getConsumed(c, 'sess-other'), 0); // other keys unaffected
});

test('resetWatermark clears all checkpoints (rebuild path)', async () => {
  const c = await conn();
  await ensureWatermarkTable(c);
  await setConsumed(c, 'sess-abc', 5);
  await setConsumed(c, CONTROL_KEY, 2);
  await resetWatermark(c);
  assert.equal(await getConsumed(c, 'sess-abc'), 0);
  assert.equal(await getConsumed(c, CONTROL_KEY), 0);
});

test('CONTROL_KEY is a NUL-free sentinel (safe DuckDB TEXT key)', async () => {
  assert.ok(!CONTROL_KEY.includes('\x00'));
  const c = await conn();
  await ensureWatermarkTable(c);
  await setConsumed(c, CONTROL_KEY, 4);
  assert.equal(await getConsumed(c, CONTROL_KEY), 4);
});
