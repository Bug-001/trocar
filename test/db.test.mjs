import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb, DEFAULT_DB_PATH } from '../src/db.mjs';

test('openDb opens a duckdb file and runs SQL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-db-'));
  const dbPath = path.join(dir, 'asight.duckdb');
  const db = await openDb(dbPath);
  try {
    const reader = await db.connection.runAndReadAll('SELECT 42 AS answer');
    const rows = reader.getRowObjects();
    assert.equal(Number(rows[0].answer), 42);
    assert.ok(fs.existsSync(dbPath), 'db file created on disk');
  } finally {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb({readOnly}) opens an existing store without write, and refuses a missing one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-db-ro-'));
  const dbPath = path.join(dir, 'asight.duckdb');
  // create it first (write mode), then reopen read-only
  const w = await openDb(dbPath);
  await w.connection.run('CREATE TABLE t(x INT)');
  await w.close();
  const r = await openDb(dbPath, { readOnly: true });
  try {
    assert.equal(r.readOnly, true);
    const reader = await r.connection.runAndReadAll('SELECT count(*) AS n FROM t');
    assert.equal(Number(reader.getRowObjects()[0].n), 0);
  } finally {
    await r.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DEFAULT_DB_PATH points at db/asight.duckdb', () => {
  assert.equal(path.basename(DEFAULT_DB_PATH), 'asight.duckdb');
  assert.equal(path.basename(path.dirname(DEFAULT_DB_PATH)), 'db');
});
