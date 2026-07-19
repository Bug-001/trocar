import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { readRecords } from '../../src/etl/ingest.mjs';
import { sessionView, pageView } from '../../src/view/board.mjs';
import { createServer } from '../../src/server.mjs';

// RFC 4.4:88② / 3.5 游标契约 (D25 轻路) — /api/session returns only the VIEW PAGE. Cursor unit = the
// global call index `gi`; the heavy payload (rec body / flat verbatim blocks / norm.text) rides ONLY on
// in-window calls, while every call keeps its cheap meta (ctx/usage/gi/cacheBreak) so the overview strip
// + brush still render the whole session. Out-of-window calls are marked `paged_out` (invariant 4).
const FIXTURE = path.resolve('test/fixtures/cc-session-real.ndjson');
const MAIN = '3e03c998-f70d-4843-8639-40f2d8b2cdc7';

const allCalls = (v) => v.analyzed.lanes.flatMap((l) => l.calls || []);
let RECORDS, FULL;
test.before(async () => {
  RECORDS = await readRecords(FIXTURE, { normalize: false });
  FULL = sessionView(RECORDS, MAIN, { enrich: null });
});

test('no paging params → full send (no page field, every call keeps its heavy flat)', () => {
  assert.equal(FULL.page, undefined, 'full send carries no page metadata');
  const calls = allCalls(FULL);
  // 35, not 33: analyze() no longer silently drops the session's non-200 calls (req_00002/502,
  // req_00003/401). See test/view/analyze-admission.test.mjs — the old constant encoded that bug.
  assert.equal(calls.length, 35);
  assert.ok(calls.every((c) => !c.paged_out), 'no call is marked paged_out in a full send');
  assert.ok(calls.some((c) => (c.flat || []).length > 0), 'heavy flat blocks present in a full send');
});

test('pageView window [0,5): only in-window calls keep heavy payload; page metadata correct', () => {
  const v = pageView(FULL, { cursor: 0, limit: 5 });
  assert.deepEqual(v.page, { cursor: 0, limit: 5, total: 35, returned: 5, baseline: null, nextCursor: 5, hasMore: true });
  for (const c of allCalls(v)) {
    if (c.gi < 5) {
      assert.ok(!c.paged_out, `gi ${c.gi} in window is not paged_out`);
    } else {
      assert.equal(c.paged_out, true, `gi ${c.gi} outside window is paged_out`);
      assert.equal((c.flat || []).length, 0, 'paged-out call ships no verbatim blocks');
      assert.equal(c.rec.request.messages, undefined, 'paged-out call ships no request messages');
      assert.equal(c.rec.request.tools, undefined, 'paged-out call ships no request tools');
    }
  }
});

test('paged-out calls keep the cheap meta the timeline needs (ctx/usage/gi/cacheBreak/model)', () => {
  const v = pageView(FULL, { cursor: 0, limit: 1 });
  const out = allCalls(v).filter((c) => c.paged_out);
  assert.ok(out.length >= 30);
  for (const c of out) {
    assert.equal(typeof c.gi, 'number');
    assert.equal(typeof c.ctx, 'number', 'ctx (bar height) survives paging');
    assert.ok(c.usage && 'read' in c.usage, 'neutral usage (cache bar) survives paging');
    assert.ok('cacheBreak' in c, 'cacheBreak marker survives paging');
    assert.ok(c.rec && c.rec.request && 'model' in c.rec.request, 'model (cost/label) survives paging');
  }
});

// A page ships the window PLUS the call immediately before it. That call is the diff baseline for the
// first call on the page; without it the board can say nothing about what changed at every page
// boundary, which is a hole in the answer at a place the user did not choose. `returned` counts bodies
// actually shipped, and `baseline` names the extra one so the +1 is explicit on the wire.
test('window in the middle [10,15): ships the window plus its diff baseline', () => {
  const v = pageView(FULL, { cursor: 10, limit: 5 });
  assert.deepEqual(v.page,
    { cursor: 10, limit: 5, total: 35, returned: 6, baseline: 9, nextCursor: 15, hasMore: true });
  const heavy = allCalls(v).filter((c) => !c.paged_out).map((c) => c.gi).sort((a, b) => a - b);
  assert.deepEqual(heavy, [9, 10, 11, 12, 13, 14], 'call #9 rides along solely as the diff baseline');
});

test('last page [30,40): clamps to end, nextCursor null, hasMore false', () => {
  const v = pageView(FULL, { cursor: 30, limit: 10 });
  assert.deepEqual(v.page,
    { cursor: 30, limit: 10, total: 35, returned: 6, baseline: 29, nextCursor: null, hasMore: false });
});

test('cursor past the end → empty window, hasMore false (no throw)', () => {
  const v = pageView(FULL, { cursor: 100, limit: 5 });
  assert.equal(v.page.returned, 0);
  assert.equal(v.page.hasMore, false);
  assert.ok(allCalls(v).every((c) => c.paged_out), 'everything is paged out past the end');
});

test('pageView is non-mutating — the source full view still holds every heavy flat', () => {
  const before = allCalls(FULL).map((c) => (c.flat || []).length);
  pageView(FULL, { cursor: 0, limit: 1 });
  const after = allCalls(FULL).map((c) => (c.flat || []).length);
  assert.deepEqual(after, before, 'the shared full view was not stripped by paging');
});

// ── HTTP contract (validation + back-compat) ────────────────────────────────────────────────
const get = (port, p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject); req.end();
});
let srv, port;
test.before(async () => {
  const made = await createServer({ dbPath: '/nonexistent-db-xyz', sourcePath: FIXTURE });
  srv = made.server; srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); port = srv.address().port;
});
test.after(() => srv?.close());

test('HTTP /api/session?cursor&limit → paged payload with page metadata', async () => {
  const r = await get(port, `/api/session?id=${MAIN}&cursor=0&limit=3`);
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.deepEqual(d.page,
    { cursor: 0, limit: 3, total: 35, returned: 3, baseline: null, nextCursor: 3, hasMore: true });
});

test('HTTP /api/session with NO paging params → full (back-compat, no page field)', async () => {
  const r = await get(port, `/api/session?id=${MAIN}`);
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.page, undefined);
  assert.ok(d.analyzed && d.analyzed.lanes);
});

test('HTTP malformed paging params → 400 (never a silent mis-window)', async () => {
  for (const q of ['cursor=-1', 'cursor=abc', 'cursor=1.5', 'limit=0', 'limit=99999', 'limit=x']) {
    const r = await get(port, `/api/session?id=${MAIN}&${q}`);
    assert.equal(r.status, 400, `${q} → 400`);
  }
});
