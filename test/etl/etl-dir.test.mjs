// test/etl/etl-dir.test.mjs — `asight etl <dir>` over the collector layout (4.4:129; 4.2 #2 with
// daily files; 4.2:39 `<stream_file>` = the file each record was read from).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { etlFile } from '../../src/etl/cli.mjs';
import { openDb } from '../../src/db.mjs';
import { dumpAll } from './helpers.mjs';

const line = (id, sid, ts, text) => JSON.stringify({
  ts, endpoint: '/v1/messages', method: 'POST', req_headers: { 'x-claude-code-session-id': sid, 'user-agent': 'claude-cli/2.1.0' },
  req_body: JSON.stringify({ model: 'claude-x', system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: [{ type: 'text', text }] }] }),
  resp: { status: 200, kind: 'sse', usage: { input_tokens: 3, output_tokens: 1 } },
  id, ts_request: ts, is_llm_call: true, capture: 'transparent', proc: { pid: 1, exe: '/x', agent: 'claude-code' },
});
const dumpOf = async (dbPath) => { const db = await openDb(dbPath, { readOnly: true }); try { return await dumpAll(db.connection); } finally { await db.close(); } };

test('a session spanning two daily capture files: incremental == full', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-col-'));
  const dbs = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-db-'));
  try {
    fs.mkdirSync(path.join(dir, 'flows'));
    fs.writeFileSync(path.join(dir, 'flows', '2026-10-05.ndjson'), line('f1', 'FLOWS', '2026-10-05T00:00:00Z', 'not an envelope') + '\n');
    fs.writeFileSync(path.join(dir, 'capture-2026-10-05.ndjson'), line('a1', 'S', '2026-10-05T23:59:00Z', 'one') + '\n');
    const inc = path.join(dbs, 'inc.duckdb'), full = path.join(dbs, 'full.duckdb');
    const first = await etlFile(dir, { dbPath: inc });
    assert.deepEqual(first.files.map((f) => path.basename(f)), ['capture-2026-10-05.ndjson'], 'flows/ is never read');
    assert.equal(first.records, 1);
    fs.writeFileSync(path.join(dir, 'capture-2026-10-06.ndjson'), line('a2', 'S', '2026-10-06T00:00:30Z', 'two') + '\n');
    await etlFile(dir, { dbPath: inc });
    await etlFile(dir, { dbPath: full, rebuild: true });
    const a = await dumpOf(inc), b = await dumpOf(full);
    assert.deepEqual(a, b);
    assert.deepEqual(a.sessions.map((s) => s.session_id), ['S'], 'one session across two files; FLOWS never ingested');
    assert.deepEqual(a.calls.map((c) => c.raw_ref), ['S/capture-2026-10-05.ndjson#a1', 'S/capture-2026-10-06.ndjson#a2'],
      'raw_ref names the file each record came from (4.2:39), not the directory or the first file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dbs, { recursive: true, force: true });
  }
});

test('a symlinked capture file in the directory is read like any other', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-col-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-real-'));
  try {
    fs.writeFileSync(path.join(elsewhere, 'real.ndjson'), line('l1', 'L', '2026-10-04T00:00:00Z', 'linked') + '\n');
    fs.symlinkSync(path.join(elsewhere, 'real.ndjson'), path.join(dir, 'codex-capture.ndjson'));
    fs.writeFileSync(path.join(dir, 'capture-2026-10-05.ndjson'), line('a1', 'S', '2026-10-05T00:00:00Z', 'one') + '\n');
    const out = await etlFile(dir, { dbPath: path.join(elsewhere, 'x.duckdb') });
    assert.deepEqual(out.files.map((f) => path.basename(f)), ['capture-2026-10-05.ndjson', 'codex-capture.ndjson']);
    assert.equal(out.records, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

// KNOWN GAP, pending a spec decision (4.2:49-50): the watermark counts records per session ACROSS the
// directory's files, and an earlier day's file can still grow. A request that starts before midnight
// UTC is filed under that day but written after a later call of the same session; an incremental run
// in between leaves it below the watermark, so it is skipped. `todo` runs the case without failing
// the suite; make it a plain test once the watermark is fixed.
test('a late append to an earlier day file: incremental == full', { todo: 'per-session watermark across files skips it (4.2:49)' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-col-'));
  const dbs = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-db-'));
  try {
    fs.writeFileSync(path.join(dir, 'capture-2026-10-05.ndjson'), line('a1', 'S', '2026-10-05T23:59:00Z', 'one') + '\n');
    fs.writeFileSync(path.join(dir, 'capture-2026-10-06.ndjson'), line('b1', 'S', '2026-10-06T00:00:05Z', 'after midnight') + '\n');
    await etlFile(dir, { dbPath: path.join(dbs, 'inc.duckdb') });
    fs.appendFileSync(path.join(dir, 'capture-2026-10-05.ndjson'), line('a2', 'S', '2026-10-05T23:59:50Z', 'finished late') + '\n');
    await etlFile(dir, { dbPath: path.join(dbs, 'inc.duckdb') });
    await etlFile(dir, { dbPath: path.join(dbs, 'full.duckdb'), rebuild: true });
    // compact projection: on Node 20 a failed deepEqual over two whole-table dumps renders its diff for minutes
    const ids = async (n) => (await dumpOf(path.join(dbs, n))).calls.map((c) => `${c.call_id}@${c.seq}`);
    assert.deepEqual(await ids('inc.duckdb'), await ids('full.duckdb'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dbs, { recursive: true, force: true });
  }
});
