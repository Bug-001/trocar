import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../../src/server.mjs';
import { fixtureGate, hasFixture } from '../helpers/fixture.mjs';
import { tmpDir } from '../helpers/tmp.mjs';

const FIXTURE = path.resolve('test/fixtures/cc-session-real.ndjson');
const MAIN = '3e03c998-f70d-4843-8639-40f2d8b2cdc7';
const get = (port, p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
  req.on('error', reject); req.end();
});

let srv, port, srcPath;
test.before(async () => {
  if (!hasFixture()) return; // every test below is fixtureGate()d — no source to copy or serve
  // a WRITABLE copy of the source so the concurrent-append test can grow it
  srcPath = path.join(tmpDir('asight-boardhttp-'), 'src.ndjson');
  fs.copyFileSync(FIXTURE, srcPath);
  const made = await createServer({ dbPath: '/nonexistent-db-xyz', sourcePath: srcPath });
  srv = made.server; srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); port = srv.address().port;
});
test.after(() => srv?.close());

test('BOARD /api/projects + /api/session: canonical, baked neutral usage, one copy per call, no-store', fixtureGate(), async () => {
  const pj = JSON.parse((await get(port, '/api/projects')).body);
  assert.ok(pj.projects.length >= 1);
  const s = await get(port, `/api/session?id=${MAIN}`);
  assert.equal(s.status, 200);
  assert.equal(s.headers['cache-control'], 'no-store');
  const d = JSON.parse(s.body);
  assert.ok(d.analyzed && d.analyzed.lanes && d.meta && Array.isArray(d.records));

  // ONE COPY PER CALL ON THE WIRE (src/view/board.mjs::onWire). analyze() puts the same call object
  // in `steps`, `lanes[].calls` and `streams[].calls`; JSON has no references, so it used to write
  // each call three times. On the wire now: `steps` is THE array of call objects, a lane names its
  // calls by `gi`, and `streams` is dropped. (In-process sessionView() still shares references — a
  // test that calls it directly sees objects in lanes; this one reads HTTP, so it sees numbers.)
  assert.ok(Array.isArray(d.analyzed.steps) && d.analyzed.steps.length > 0);
  assert.equal(d.analyzed.streams, undefined, '`streams` is dropped on the wire (nothing reads it)');
  const main = d.analyzed.lanes.find((l) => l.kind === 'main');
  assert.ok(main.calls.length > 0);
  assert.ok(main.calls.every((c) => typeof c === 'number'), 'a lane names its calls by gi, not by value');
  // …and the gi index really addresses the call it claims to (this is what buildLanes() re-hydrates
  // through; an off-by-one here would silently repaint the whole timeline with the wrong calls).
  const byGi = new Map(d.analyzed.steps.map((c) => [c.gi, c]));
  const mainCalls = main.calls.map((gi) => {
    const c = byGi.get(gi);
    assert.ok(c, `lane gi ${gi} re-hydrates to a call in steps`);
    return c;
  });
  // no call object is duplicated across the lanes — each crosses the wire exactly once
  const laneGis = d.analyzed.lanes.flatMap((l) => l.calls);
  assert.equal(new Set(laneGis).size, laneGis.length, 'each call is named by exactly one lane');

  // ORIGINAL GUARD, unchanged in strength: the re-hydrated calls carry BAKED NEUTRAL usage
  // (read/create/fresh/out), so the browser never has to know a provider's native usage names.
  assert.ok(mainCalls.some((c) => c.usage && 'read' in c.usage), 'calls carry baked neutral usage');
  for (const c of mainCalls) {
    if (!c.usage) continue;
    for (const k of Object.keys(c.usage)) {
      assert.ok(['read', 'create', 'fresh', 'out'].includes(k), `neutral usage key, got ${k}`);
    }
  }

  // `call.rec` IS SLIMMED (no raw request body on the wire — ~120 MB of a measured 142.8 MB payload
  // was request bodies re-sent every turn). Only the fields the frontend actually reads survive.
  const withRec = d.analyzed.steps.filter((c) => c.rec);
  assert.ok(withRec.length > 0);
  for (const c of withRec) {
    assert.deepEqual(Object.keys(c.rec).sort(), ['id', 'request']);
    for (const k of Object.keys(c.rec.request)) {
      assert.ok(['model', 'context_chars', 'message_count', 'tool_count', 'system_chars'].includes(k),
        `rec.request carries only counts, got ${k}`);
    }
    assert.ok(!('messages' in c.rec.request) && !('system' in c.rec.request), 'no request body on the wire');
  }

  // A BLOCK IS NEVER BOTH BODYLESS AND LOCATOR-LESS (invariant 4). Either it ships a `text_ref`
  // locator into the raw capture (「看全文=回源」, RFC 4.2:55) with the heavy fields removed, or —
  // for records like this fixture, whose original wire bytes are genuinely gone (parsed `request`
  // was stored, so no span is computable) — it keeps its body AND says so via `unaddressable`.
  const blocks = d.analyzed.steps.flatMap((c) => c.flat || []);
  assert.ok(blocks.length > 0);
  for (const b of blocks) {
    const hasBody = b.text != null || b.block != null || b.desc != null || b.schema != null || b.props != null;
    assert.ok(b.text_ref || hasBody, 'a block is never both bodyless and locator-less');
    if (!b.text_ref) assert.ok(b.unaddressable, 'an inlined block is labelled as not resolved from the capture');
    if (b.text_ref) assert.match(b.text_ref, /^[^/]+\/[^#]+#.+::\d+-\d+$/, 'locator is <session>/<stream>#<recordId>::<start>-<end>');
    // metadata the row renders from is present either way
    assert.equal(typeof b.kind, 'string');
    assert.equal(typeof b.chars, 'number');
  }
});

test('D14 /api/pricing: editable config served (defaults present)', fixtureGate(), async () => {
  const r = await get(port, '/api/pricing');
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.ok(d.editable === true && d.pricing && Array.isArray(d.pricing.opus) && d.pricing.opus.length === 4);
});

test('4.4 §验收#5 — concurrent poll during ETL append reads a self-consistent snapshot', fixtureGate(), async () => {
  // simulate ETL appending: a COMPLETE record then a HALF-written line (no newline), racing a poll.
  const complete = JSON.stringify({ id: 'req_appended', ts_request: '2026-07-16T00:00:00Z', is_llm_call: false, endpoint: '/x', request_headers: {}, response: { status: 200 } }) + '\n';
  const halfLine = '{"id":"req_partial","request":{"model":"claude-';
  const results = await Promise.all([
    (async () => { fs.appendFileSync(srcPath, complete); fs.appendFileSync(srcPath, halfLine); })(),
    get(port, '/api/projects'),
    get(port, `/api/session?id=${MAIN}`),
  ]);
  const [, projects, session] = results;
  assert.equal(projects.status, 200);
  assert.doesNotThrow(() => JSON.parse(projects.body), 'projects JSON is well-formed mid-append');
  assert.equal(session.status, 200);
  assert.doesNotThrow(() => JSON.parse(session.body), 'session JSON is well-formed mid-append (half-line dropped, no corruption)');
  // finalize the partial line and confirm the reader now stays valid too
  fs.appendFileSync(srcPath, 'opus"}}\n');
  const after = await get(port, '/api/projects');
  assert.doesNotThrow(() => JSON.parse(after.body));
});
