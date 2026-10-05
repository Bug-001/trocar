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
import { createRecordStore } from '../../src/collector/core/record/store.mjs';

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
    fs.symlinkSync(path.join(elsewhere, 'gone.ndjson'), path.join(dir, 'dangling.ndjson')); // points nowhere: not a capture
    fs.writeFileSync(path.join(dir, 'capture-2026-10-05.ndjson'), line('a1', 'S', '2026-10-05T00:00:00Z', 'one') + '\n');
    const out = await etlFile(dir, { dbPath: path.join(elsewhere, 'x.duckdb') });
    assert.deepEqual(out.files.map((f) => path.basename(f)), ['capture-2026-10-05.ndjson', 'codex-capture.ndjson']);
    assert.equal(out.records, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

// 4.2:49-50 across midnight, driven through the collector's REAL record store. A request that starts
// before midnight UTC and ends after it is written after a later call of the same session. Dated by
// request start it was appended to the previous day's file behind the watermark and skipped by the
// next incremental run; dated by write time (4.6 §记录) no earlier file grows once a later one exists.
test('a call that starts before midnight and ends after it: incremental == full', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-col-'));
  const dbs = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-db-'));
  let clock = '2026-10-05T23:59:01Z';
  const store = createRecordStore({ root: dir, now: () => new Date(clock) });
  const put = (id, ts, at) => { clock = at; store.envelope(JSON.parse(line(id, 'S', ts, id))); };
  try {
    put('a1', '2026-10-05T23:59:00Z', '2026-10-05T23:59:01Z');
    put('b1', '2026-10-06T00:00:05Z', '2026-10-06T00:00:06Z');
    await etlFile(dir, { dbPath: path.join(dbs, 'inc.duckdb') });
    put('a2', '2026-10-05T23:59:50Z', '2026-10-06T00:00:20Z'); // started before midnight, written after b1
    await etlFile(dir, { dbPath: path.join(dbs, 'inc.duckdb') });
    await etlFile(dir, { dbPath: path.join(dbs, 'full.duckdb'), rebuild: true });
    const ids = async (n) => (await dumpOf(path.join(dbs, n))).calls.map((c) => `${c.call_id}@${c.seq}`);
    assert.deepEqual(await ids('inc.duckdb'), ['a1@0', 'a2@2', 'b1@1']);
    assert.deepEqual(await ids('inc.duckdb'), await ids('full.duckdb'));
    // the whole dump, too: compared only once the call lists agree, because on Node 20 a failed
    // deepEqual over two whole-table dumps takes minutes to render its diff
    assert.deepEqual(await dumpOf(path.join(dbs, 'inc.duckdb')), await dumpOf(path.join(dbs, 'full.duckdb')));
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dbs, { recursive: true, force: true });
  }
});

// 4.2:50 when the precondition does NOT hold: a directory whose earlier file grows after a later one
// was ingested (e.g. `asight etl ~/.asight`, where several captures grow at once). Session-less
// records share one watermark key across files, so the new record shifts the history under the
// watermark. The run must refuse rather than skip it silently; --rebuild recomputes it exactly.
test('an earlier file growing after a later one was ingested: incremental refuses instead of skipping', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-col-'));
  const dbs = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-db-'));
  const ctl = (id) => JSON.stringify({ ts: '2026-10-06T00:00:00Z', endpoint: '/api/event_logging/batch', method: 'POST',
    req_headers: { 'user-agent': 'claude-cli/2.1.0' }, req_body: '{}', resp: { status: 200, kind: 'json', body: {} },
    id, ts_request: '2026-10-06T00:00:00Z', is_llm_call: false }) + '\n';
  try {
    fs.writeFileSync(path.join(dir, 'claude-capture.ndjson'), ctl('c1'));
    fs.writeFileSync(path.join(dir, 'codex-capture.ndjson'), ctl('d1'));
    const inc = path.join(dbs, 'inc.duckdb');
    await etlFile(dir, { dbPath: inc });
    fs.appendFileSync(path.join(dir, 'claude-capture.ndjson'), ctl('c2'));
    await assert.rejects(etlFile(dir, { dbPath: inc }), /source changed under the watermark for session-less records.*--rebuild/);
    assert.deepEqual((await dumpOf(inc)).calls.map((c) => c.call_id), ['c1', 'd1'], 'the refused run wrote nothing');
    await etlFile(dir, { dbPath: inc, rebuild: true });
    await etlFile(dir, { dbPath: path.join(dbs, 'full.duckdb') });
    assert.deepEqual((await dumpOf(inc)).calls.map((c) => `${c.call_id}@${c.seq}`), ['c1@0', 'c2@1', 'd1@2']);
    assert.deepEqual(await dumpOf(inc), await dumpOf(path.join(dbs, 'full.duckdb')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dbs, { recursive: true, force: true });
  }
});
