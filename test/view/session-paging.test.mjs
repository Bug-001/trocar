import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { readRecords } from '../../src/etl/ingest.mjs';
import { sessionView, pageView } from '../../src/view/board.mjs';
import { createServer } from '../../src/server.mjs';

// RFC 4.4:88② / 3.5 游标契约 (D25 轻路) — /api/session returns only the VIEW PAGE. Cursor unit = the
// global call index `gi`; the body-bearing payload (rec request meta / flat blocks / norm.text) rides
// ONLY on in-window calls, while every call keeps its cheap meta (ctx/usage/gi/cacheBreak) so the
// overview strip + brush still render the whole session. Out-of-window calls are marked `paged_out`
// (invariant 4 — not shipped on THIS page, not silently dropped).
//
// NEW WIRE CONTRACT (payload-weight refactor). analyze() puts the SAME call objects in `steps`,
// `lanes[].calls` and `streams[].calls`; JSON.stringify has no references, so it wrote every call
// three times. Now `analyzed.steps` is THE array of call objects (gi order), `analyzed.lanes[].calls`
// names its calls by `gi` NUMBER, and `analyzed.streams` is dropped. So this file reads the call
// objects out of `steps`, and separately pins that every lane's gi reference still resolves — because
// a lane whose references cannot be resolved is a board that renders no calls at all.
// Blocks themselves are metadata + a `text_ref` locator (or, for records with no verbatim wire bytes,
// an inlined body marked `unaddressable`); "a call ships its bodies" therefore means `flat[]` is
// populated and `rec.request` carries the body-derived counters, not that the text rides along.
const FIXTURE = path.resolve('test/fixtures/cc-session-real.ndjson');
const MAIN = '3e03c998-f70d-4843-8639-40f2d8b2cdc7';

// The one array of call objects. (Pre-refactor this flattened `lanes[].calls`, which held the same
// objects; lanes now hold gi numbers, and `laneRefs` below guards that side.)
const allCalls = (v) => v.analyzed.steps || [];
// Every gi a lane names, in ascending order. On the wire these are numbers; a view that has not been
// through the wire transform may hold the call objects themselves — accept either, so this helper
// pins the REFERENCE SET rather than the encoding.
const laneRefs = (v) => (v.analyzed.lanes || [])
  .flatMap((l) => (l.calls || []).map((c) => (typeof c === 'number' ? c : c.gi)))
  .sort((a, b) => a - b);

let RECORDS, FULL;
test.before(async () => {
  RECORDS = await readRecords(FIXTURE, { normalize: false });
  FULL = sessionView(RECORDS, MAIN, { enrich: null });
});

test('no paging params → full send (no page field, every call keeps its bodies)', () => {
  assert.equal(FULL.page, undefined, 'full send carries no page metadata');
  const calls = allCalls(FULL);
  // 35, not 33: analyze() no longer silently drops the session's non-200 calls (req_00002/502,
  // req_00003/401). See test/view/analyze-admission.test.mjs — the old constant encoded that bug.
  assert.equal(calls.length, 35);
  assert.ok(calls.every((c) => !c.paged_out), 'no call is marked paged_out in a full send');
  // Bodies present. Post-refactor a block carries metadata + a locator instead of its text, so the
  // proof that a call was shipped WITH its body is (a) it has blocks and (b) rec.request still carries
  // the counters computed from that body — both of which slimCall() strips.
  const withFlat = calls.filter((c) => (c.flat || []).length > 0);
  assert.ok(withFlat.length > 0, 'blocks present in a full send');
  for (const c of withFlat) {
    assert.equal(typeof c.rec.request.context_chars, 'number', 'full send keeps the request meta');
    for (const b of c.flat) {
      assert.ok(b.text_ref || b.unaddressable,
        `block ${b.key} must carry a locator or be marked inlined (invariant 4)`);
    }
  }
});

// The lanes are what the board renders (buildLanes). Post-refactor they name their calls by gi, so
// the payload is only renderable if every reference resolves into `steps` — a dangling reference is
// an empty timeline, which is exactly the failure mode paging exists to prevent.
test('full send: every lane reference resolves to a call in steps, and covers the session exactly', () => {
  const byGi = new Map(allCalls(FULL).map((c) => [c.gi, c]));
  const refs = laneRefs(FULL);
  assert.equal(refs.length, 35, 'lanes name every call exactly once');
  assert.deepEqual(refs, allCalls(FULL).map((c) => c.gi).sort((a, b) => a - b));
  for (const gi of refs) assert.ok(byGi.get(gi), `lane reference gi=${gi} resolves to a call object`);
});

test('pageView window [0,5): only in-window calls keep bodies; page metadata correct', () => {
  const v = pageView(FULL, { cursor: 0, limit: 5 });
  assert.deepEqual(v.page, { cursor: 0, limit: 5, total: 35, returned: 5, baseline: null, nextCursor: 5, hasMore: true });
  for (const c of allCalls(v)) {
    if (c.gi < 5) {
      assert.ok(!c.paged_out, `gi ${c.gi} in window is not paged_out`);
      assert.equal(typeof c.rec.request.context_chars, 'number', `gi ${c.gi} keeps its request meta`);
    } else {
      assert.equal(c.paged_out, true, `gi ${c.gi} outside window is paged_out`);
      assert.equal((c.flat || []).length, 0, 'paged-out call ships no blocks');
      // These are the body-derived fields an IN-WINDOW call carries (see above). Asserting the old
      // `rec.request.messages === undefined` would now pass even with slimCall() deleted, since the
      // raw body no longer crosses the wire for anyone — so pin the fields that still differ.
      assert.equal(c.rec.request.context_chars, undefined, 'paged-out call ships no request-body meta');
      assert.equal(c.rec.request.message_count, undefined, 'paged-out call ships no message count');
      assert.equal(c.rec.request.tool_count, undefined, 'paged-out call ships no tool count');
      assert.equal(c.norm && c.norm.text, undefined, 'paged-out call ships no response text');
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

// Paging must not break the lane→call reference: the overview strip renders the WHOLE session from
// the lanes, so a paged response still has to name all 35 calls, in-window or not.
test('a paged view still names every call from its lanes', () => {
  const v = pageView(FULL, { cursor: 10, limit: 5 });
  const byGi = new Map(allCalls(v).map((c) => [c.gi, c]));
  const refs = laneRefs(v);
  assert.deepEqual(refs, [...Array(35).keys()], 'paging drops no call from the lanes');
  for (const gi of refs) assert.ok(byGi.get(gi), `paged lane reference gi=${gi} still resolves`);
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

test('pageView is non-mutating — the source full view still holds every call body', () => {
  const before = allCalls(FULL).map((c) => (c.flat || []).length);
  const recBefore = allCalls(FULL).map((c) => c.rec.request.context_chars);
  pageView(FULL, { cursor: 0, limit: 1 });
  assert.deepEqual(allCalls(FULL).map((c) => (c.flat || []).length), before,
    'the shared full view was not stripped by paging');
  assert.deepEqual(allCalls(FULL).map((c) => c.rec.request.context_chars), recBefore,
    'the shared full view kept its request meta');
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

// The wire payload has to be RENDERABLE, not merely present: the board resolves each lane's gi
// against `analyzed.steps` (buildLanes). Asserting only `d.analyzed.lanes` truthy — as this test used
// to — passes on a payload whose lanes resolve to nothing and whose timeline is empty.
test('HTTP full send: the payload re-hydrates — lane gi refs resolve against analyzed.steps', async () => {
  const r = await get(port, `/api/session?id=${MAIN}`);
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.page, undefined, 'back-compat: no paging params → no page field');
  assert.ok(d.analyzed && d.analyzed.lanes, 'lanes present');
  assert.equal(d.analyzed.streams, undefined, 'streams no longer crosses the wire');
  const steps = d.analyzed.steps || [];
  assert.equal(steps.length, 35, 'the call objects cross the wire once, in analyzed.steps');
  const byGi = new Map(steps.map((c) => [c.gi, c]));
  const refs = laneRefs(d);
  assert.equal(refs.length, 35, 'every call is named by a lane');
  for (const gi of refs) assert.ok(byGi.get(gi), `lane reference gi=${gi} resolves on the wire`);
});

// The full view is MEMOIZED and backs every later request for the same session, so the wire transform
// has to be a PROJECTION. If it rewrites the memoized object in place, the first request is correct
// and every one after it gets lanes whose gi refs were already replaced — the board then renders an
// empty timeline for a session it had just shown, and only on a reload.
test('HTTP full send is repeatable — the wire transform does not consume the memoized view', async () => {
  const first = JSON.parse((await get(port, `/api/session?id=${MAIN}`)).body);
  const second = JSON.parse((await get(port, `/api/session?id=${MAIN}`)).body);
  assert.deepEqual(laneRefs(second), laneRefs(first), 'the second request gets the same lane refs');
  const byGi = new Map((second.analyzed.steps || []).map((c) => [c.gi, c]));
  for (const gi of laneRefs(second)) assert.ok(byGi.get(gi), `gi=${gi} still resolves on a re-fetch`);
});

test('HTTP paged send: the whole session is still on the timeline, only the window carries bodies', async () => {
  const r = await get(port, `/api/session?id=${MAIN}&cursor=10&limit=5`);
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  const steps = d.analyzed.steps || [];
  assert.equal(steps.length, 35, 'every call is on the wire (cheap meta) so the strip renders whole');
  const byGi = new Map(steps.map((c) => [c.gi, c]));
  assert.deepEqual(laneRefs(d), [...Array(35).keys()], 'lanes name every call');
  for (const gi of laneRefs(d)) assert.ok(byGi.get(gi), `paged lane reference gi=${gi} resolves`);
  const heavy = steps.filter((c) => !c.paged_out).map((c) => c.gi).sort((a, b) => a - b);
  assert.deepEqual(heavy, [9, 10, 11, 12, 13, 14], 'window + diff baseline, and nothing else');
});

test('HTTP malformed paging params → 400 (never a silent mis-window)', async () => {
  for (const q of ['cursor=-1', 'cursor=abc', 'cursor=1.5', 'limit=0', 'limit=99999', 'limit=x']) {
    const r = await get(port, `/api/session?id=${MAIN}&${q}`);
    assert.equal(r.status, 400, `${q} → 400`);
  }
});
