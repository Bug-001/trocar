import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionView, forWire } from '../../src/view/board.mjs';

// EVERY /api/session RESPONSE CARRIED EACH CALL THREE TIMES.
//
// analyze() puts each call object into three arrays — `steps`, `lanes[].calls`, `streams[].calls` —
// which is free in memory (one object, three references) and *not* free on the wire: JSON has no
// references, so `JSON.stringify` writes the object out once per array. Measured on a 6-call session
// with 1.2 MB contexts: 20.5 MB shipped for 6.4 MB of distinct content.
//
// The browser reads NEITHER of the redundant two. `grep -n '\.steps\|\.streams' src/web/index.html`
// returns nothing at all; buildLanes() (index.html:823) consumes `A.lanes`, and the only other use is
// `A.stats`. So two thirds of every session response was inert bytes — parsed, held, and discarded.
//
// This compounded with paging rather than being fixed by it: a window that correctly slimmed the
// out-of-window calls still shipped the in-window ones three times, which is how a 10-call window on
// a large session still overran V8's max string and 500'd. Paging bounds WHICH calls ship; this
// bounds how many times each one does.
//
// Spec self-check: 4.4:46 specifies the endpoint returns
// `records` + `probes` + `meta` and fixes no sub-shape of `analyzed`; no MUST covers the redundant
// arrays. Not a spec conflict — merged, decision table untouched.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, '..', '..', 'samples', 'demo-session.ndjson');
const records = fs.readFileSync(SAMPLE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const SID = 'demo-0000-4a1b-9c2d-000000000001';

test('the wire payload carries each call ONCE', () => {
  const view = sessionView(records, SID);
  const wire = forWire(view);
  const json = JSON.stringify(wire);
  // Count the CALL OBJECTS, not the ids: an id legitimately recurs in the slim `records` list and in
  // the call's own `rec`. `"gi":` is emitted once per serialized call object and nowhere else, so it
  // counts copies of the call itself.
  const calls = view.analyzed.lanes[0].calls.length;
  const serialized = (json.match(/"gi":/g) || []).length;
  assert.equal(serialized, calls,
    `${calls} calls were serialized ${serialized} times. Each appears in steps, lanes[].calls AND `
    + 'streams[].calls, and JSON has no references — so the response carried every context three '
    + 'times while the board read only one of them');
});

test('the redundant arrays are gone from the wire, and the used ones remain', () => {
  const wire = forWire(sessionView(records, SID));
  assert.equal(wire.analyzed.steps, undefined, '`steps` is never read by the board (grep: 0 hits)');
  assert.equal(wire.analyzed.streams, undefined, '`streams` is never read by the board (grep: 0 hits)');
  assert.ok(Array.isArray(wire.analyzed.lanes) && wire.analyzed.lanes[0].calls.length,
    'lanes is what buildLanes() consumes — dropping it would blank the board');
  assert.ok(wire.analyzed.stats, 'stats is read by the header');
  for (const k of ['records', 'probes', 'meta']) {
    assert.ok(k in wire, `spec 4.4:46 fixes \`${k}\` as part of this response`);
  }
});

test('it is a projection, not a mutation — the source view keeps every array', () => {
  const view = sessionView(records, SID);
  forWire(view);
  assert.ok(view.analyzed.steps.length, 'forWire must not strip the memoized view it was given: the '
    + 'same object backs later page requests, and server-side callers (ETL, tests) read steps');
  assert.ok(view.analyzed.streams.length, 'streams likewise survives on the server side');
});

test('the saving is real, not a rounding error', () => {
  const view = sessionView(records, SID);
  const before = JSON.stringify(view).length;
  const after = JSON.stringify(forWire(view)).length;
  assert.ok(after < before * 0.55,
    `wire payload is ${(after / 1024).toFixed(0)} KB vs ${(before / 1024).toFixed(0)} KB — dropping `
    + 'two of three copies should roughly third it; a small delta means a copy is still going out');
});
