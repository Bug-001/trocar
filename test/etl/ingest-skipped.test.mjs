// test/etl/ingest-skipped.test.mjs — BUG 2 (invariant 4: a loss MUST NOT be invisible).
//
// A capture is an APPEND-ONLY file being written while a session runs, so a torn FINAL line is the
// NORMAL mid-session state, not an exception. readRecords' bare `catch {}` dropped such a line
// silently: the user's record count came back quietly short with no signal anywhere — and for a
// tool whose whole claim is "what you see IS what went over the wire", an unreported omission is
// worse than a visible failure.
//
// The return value MUST stay a plain Array (every caller — bin/asight.mjs:171, src/server.mjs:140,
// src/etl/cli.mjs:13, and the capture/adapters/query/view suites — consumes it as one, iterating,
// .length-ing and re-pushing it), so the loss is reported ALONGSIDE the array, never instead of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRecords } from '../../src/etl/ingest.mjs';

const rec = (id) => JSON.stringify({
  id, ts_request: '2026-07-15T00:00:00.000Z', endpoint: '/v1/messages', method: 'POST',
  is_llm_call: true, req_headers: { 'user-agent': 'claude-cli/1.0' },
  req_body: '{"model":"m","messages":[]}', resp: { kind: 'sse', status: 200 },
});

function tmp(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-ingest-'));
  const file = path.join(dir, 'cap.ndjson');
  fs.writeFileSync(file, text);
  return file;
}

test('BUG2: a torn FINAL line (live append in flight) is counted and reported, not swallowed', async () => {
  // exactly the live state: two whole records, then a half-flushed third.
  const file = tmp(rec('req-1') + '\n' + rec('req-2') + '\n' + '{"id":"req-3","req_bo');
  const recs = await readRecords(file);

  assert.equal(recs.length, 2, 'the two intact records still come back');
  assert.ok(Array.isArray(recs), 'return shape stays a plain Array (every caller depends on it)');

  const scan = recs.scan;
  assert.ok(scan, 'readRecords MUST report what it skipped — a silent drop is the bug');
  assert.equal(scan.skippedLines, 1, 'one unparseable line');
  assert.equal(scan.file, file);
  assert.equal(scan.parsedLines, 2);
  // enough detail to actually DIAGNOSE: which line, and what the bytes looked like.
  assert.equal(scan.skipped.length, 1);
  assert.equal(scan.skipped[0].line, 3, '1-based line number of the torn record');
  assert.ok(/req_bo/.test(scan.skipped[0].excerpt), 'an excerpt of the offending bytes');
  assert.ok(scan.skipped[0].error, 'the parse error');
});

test('BUG2: a torn line in the MIDDLE is reported with its true line number', async () => {
  const file = tmp(rec('req-1') + '\n' + '{"id":"req-2",BROKEN}' + '\n' + rec('req-3') + '\n');
  const recs = await readRecords(file);
  assert.equal(recs.length, 2);
  assert.equal(recs.scan.skippedLines, 1);
  assert.equal(recs.scan.skipped[0].line, 2);
});

test('BUG2: blank lines are NOT reported as corruption (they are not a loss)', async () => {
  const file = tmp(rec('req-1') + '\n\n   \n' + rec('req-2') + '\n');
  const recs = await readRecords(file);
  assert.equal(recs.length, 2);
  assert.equal(recs.scan.skippedLines, 0, 'whitespace carries no record — nothing was lost');
  assert.equal(recs.scan.blankLines, 2);
});

test('BUG2: a clean capture reports zero skipped (no false alarm)', async () => {
  const file = tmp(rec('req-1') + '\n' + rec('req-2') + '\n');
  const recs = await readRecords(file);
  assert.equal(recs.length, 2);
  assert.equal(recs.scan.skippedLines, 0);
  assert.equal(recs.scan.skipped.length, 0);
});

test('BUG2: the REAL in-repo capture reads clean — the counter does not cry wolf', async () => {
  const file = path.resolve('samples/demo-session.ndjson');
  const recs = await readRecords(file);
  assert.ok(recs.length >= 8, `expected the sample's records, got ${recs.length}`);
  assert.equal(recs.scan.skippedLines, 0);
  assert.equal(recs.scan.parsedLines, recs.length);
});

test('BUG2: an onSkip callback lets a MULTI-FILE caller aggregate (server.mjs concats arrays, ' +
     'which would otherwise drop the per-array scan)', async () => {
  const a = tmp(rec('req-1') + '\n' + '{oops' + '\n');
  const b = tmp(rec('req-2') + '\n' + '{also-oops' + '\n');
  const seen = [];
  const all = [];
  for (const f of [a, b]) for (const r of await readRecords(f, { onSkip: (info) => seen.push(info) })) all.push(r);
  assert.equal(all.length, 2);
  assert.equal(seen.length, 2, 'both files reported their loss to the caller');
  assert.deepEqual(seen.map((s) => s.file), [a, b]);
  assert.deepEqual(seen.map((s) => s.line), [2, 2]);
});

test('BUG2: the limit path still returns exactly `limit` records and a scan', async () => {
  const file = tmp([1, 2, 3, 4, 5].map((i) => rec('req-' + i)).join('\n') + '\n');
  const recs = await readRecords(file, { limit: 3 });
  assert.equal(recs.length, 3);
  assert.equal(recs.scan.parsedLines, 3);
  assert.equal(recs.scan.skippedLines, 0);
});
