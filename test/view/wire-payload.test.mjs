import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionView, forWire } from '../../src/view/board.mjs';
import { assembleSession, recordsForSession } from '../../src/view/assemble.mjs';

// EVERY /api/session RESPONSE CARRIED EACH CALL THREE TIMES.
//
// analyze() puts each call object into three arrays — `steps` (global order), `lanes[].calls`
// (partitioned) and `streams[].calls` — which is free in memory (one object, three references) and
// *not* free on the wire: JSON has no references, so `JSON.stringify` writes the object out once per
// array. Measured on a 6-call session with 1.2 MB contexts: 20.5 MB shipped for 6.4 MB of distinct
// content; on the 8-call sample here, 316 KB of `analyzed` for 107 KB of distinct content.
//
// This compounded with paging rather than being fixed by it: a window that correctly slimmed the
// out-of-window calls still shipped the in-window ones three times, which is how a 10-call window on
// a large session still overran V8's max string and 500'd. Paging bounds WHICH calls ship; this
// bounds how many times each one does.
//
// WHAT THE FIX SETTLED ON (contract as of the block-metadata change). The original version of this
// test pinned "the wire drops `steps` and keeps `lanes[].calls` as objects", because that was the
// board's reader at the time. The board now re-hydrates instead — buildLanes() (index.html:830-833)
// does `const steps=A.steps||[]` and maps each lane entry `typeof c==='number'?steps[c]:c` — so the
// direction inverted:
//   `analyzed.steps`        = THE one array of call objects, in gi order.
//   `analyzed.lanes[].calls` = gi NUMBERS pointing into it.
//   `analyzed.streams`       = dropped outright; nothing has ever read it.
// The invariant this file guards is unchanged and is not about which array wins: EACH CALL CROSSES
// THE WIRE EXACTLY ONCE, and the arrays the board actually reads survive. Dropping a copy that the
// renderer needs is the same bug as shipping a copy it doesn't — both blank the board.
//
// The tests below therefore assert against the EXACT payload /api/session sends,
// `forWire(sessionView(...))` (src/server.mjs:313), not against either transform in isolation.
//
// Spec self-check: 4.4:46 specifies the endpoint returns
// `records` + `probes` + `meta` and fixes no sub-shape of `analyzed`; no MUST covers the redundant
// arrays. Not a spec conflict — merged, decision table untouched.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, '..', '..', 'samples', 'demo-session.ndjson');
const records = fs.readFileSync(SAMPLE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const SID = 'demo-0000-4a1b-9c2d-000000000001';

// The payload the server actually sends. Both transforms are in this path on purpose: the contract
// is a property of the response, not of whichever function currently performs the reshape.
const wireOf = (opts) => forWire(sessionView(records, SID, opts));

const CALLS = assembleSession(
  recordsForSession(records, SID).filter((r) => r.is_llm_call),
).steps.length;

test('the wire payload carries each call ONCE — and carries it', () => {
  const wire = wireOf();
  const steps = wire.analyzed.steps;
  // Present: `steps` is the ONLY copy of the call objects now, so an over-eager slim that removes it
  // leaves buildLanes() mapping every lane entry through an empty array and .filter(Boolean)-ing the
  // lot away — a 200 response that renders a session with zero calls.
  assert.ok(Array.isArray(steps), '`analyzed.steps` is the one array of call objects the board '
    + 're-hydrates lanes from (index.html:830); without it every lane renders empty');
  assert.equal(steps.length, CALLS, 'every assembled call must reach the wire');
  assert.deepEqual(steps.map((c) => c.gi), [...Array(CALLS).keys()],
    'buildLanes indexes steps BY POSITION (`steps[c]`), so gi must equal the array index');

  // Once: `"gi":` is emitted once per serialized call object and nowhere else (an id would recur in
  // the slim `records` list and in the call's own `rec`, so counting ids would over-count), which
  // makes it an exact census of call copies on the wire.
  const serialized = (JSON.stringify(wire).match(/"gi":/g) || []).length;
  assert.equal(serialized, CALLS,
    `${CALLS} calls were serialized ${serialized} times. Each appears in steps, lanes[].calls AND `
    + 'streams[].calls in-process, and JSON has no references — so the response used to carry every '
    + 'context three times while the board read only one of them');
});

test('the redundant array is gone, the read ones remain, and lanes still resolve', () => {
  const wire = wireOf();
  const { steps, lanes, stats, streams } = wire.analyzed;
  assert.equal(streams, undefined, '`streams` is never read by the board (grep: 0 hits)');
  assert.ok(Array.isArray(lanes) && lanes.length,
    'lanes is what buildLanes() consumes — dropping it would blank the board');
  assert.ok(stats, 'stats is read by the header');

  // A lane names its calls by gi rather than embedding them. That is only free if EVERY name
  // resolves: buildLanes does `.filter(Boolean)`, so a gi with no matching step disappears silently
  // — the board would draw a shorter lane with no error anywhere.
  let named = 0;
  for (const lane of lanes) {
    assert.ok(lane.calls.length, `lane ${lane.id} must still name its calls`);
    for (const c of lane.calls) {
      assert.equal(typeof c, 'number',
        `lane ${lane.id} embeds a call object; a lane must name calls by gi so each crosses once`);
      assert.ok(steps[c] && steps[c].gi === c,
        `lane ${lane.id} names gi ${c}, which resolves to nothing in steps — buildLanes filters it `
        + 'out silently and the lane renders short');
      named++;
    }
  }
  assert.equal(named, CALLS, 'the lanes together must still account for every call');

  for (const k of ['records', 'probes', 'meta']) {
    assert.ok(k in wire, `spec 4.4:46 fixes \`${k}\` as part of this response`);
  }
});

test('a PAGED response obeys the same contract', () => {
  // Paging and de-duplication are orthogonal and compound: paging bounds WHICH calls carry bodies,
  // this bounds how many times each is written out. They also share a spine, and getting the order
  // wrong breaks both — pageView walks `lanes[].calls` reading `c.gi`, so if a lane had already been
  // reduced to gi NUMBERS before paging ran, every entry became a gi-less `{paged_out:true}` stub and
  // `total` counted the same call twice (8 calls reported as 16).
  const wire = wireOf({ page: { cursor: 0, limit: 3 } });
  const { steps, lanes } = wire.analyzed;
  assert.equal(wire.page.total, CALLS, 'a page must report the WHOLE session length, counted once');
  assert.equal(wire.page.returned, 3, 'and ship bodies for exactly the window');
  assert.equal(steps.length, CALLS, 'the timeline still needs every call, slimmed or not');
  for (const lane of lanes) {
    for (const c of lane.calls) {
      assert.equal(typeof c, 'number', 'lanes name calls by gi under paging too');
      assert.ok(steps[c] && steps[c].gi === c, `paged lane names gi ${c}, which resolves to nothing`);
    }
  }
  assert.deepEqual(steps.map((c) => !c.paged_out), [true, true, true, false, false, false, false, false],
    'the window keeps its bodies; everything outside it is slimmed but still named');
  const serialized = (JSON.stringify(wire).match(/"gi":/g) || []).length;
  assert.equal(serialized, CALLS, 'a paged response must not re-multiply the calls it just slimmed');
});

test('it is a projection, not a mutation — the view survives being sent', () => {
  const view = sessionView(records, SID);
  const before = JSON.stringify(view);
  const wire = forWire(view);
  assert.notEqual(wire, view, 'forWire must return a new object, not the memoized view');
  assert.equal(JSON.stringify(view), before,
    'forWire must not strip or rewrite the memoized view it was given: the SAME object backs later '
    + 'page requests, so a mutating projection makes the second request to a cached session serve a '
    + 'payload the first request already ate');
  // …and projecting twice must give the same wire payload, which is exactly what the memo does.
  assert.equal(JSON.stringify(forWire(view)), JSON.stringify(wire),
    'a second projection of the memoized view must be identical');
});

test('the assembler is untouched — the reshape lives at the wire, not in analyze()', () => {
  // The three arrays exist because in-process they are shared references and cost nothing; server-side
  // consumers (paging, ETL, the test suite) read them. Pushing the wire reshape down into the
  // assembler would be cheap and wrong: pageView walks `lanes[].calls` expecting CALL OBJECTS
  // (it reads `c.gi` and swaps in a slimmed clone), so gi numbers arriving there silently produce
  // gi-less `{paged_out:true}` stubs and a `total` that counts the same call twice.
  const an = assembleSession(recordsForSession(records, SID).filter((r) => r.is_llm_call));
  assert.ok(an.steps.length && an.lanes.length && an.streams.length,
    'analyze() keeps all three arrays in-process');
  assert.equal(an.lanes[0].calls[0], an.steps[0],
    'in-process the arrays SHARE call objects — that is why the duplication was invisible until '
    + 'JSON.stringify, and why the fix belongs on the wire');
  assert.equal(an.streams[0].calls[0], an.steps[0], 'streams shares the same objects');
});

test('the saving is real, not a rounding error', () => {
  const an = assembleSession(recordsForSession(records, SID).filter((r) => r.is_llm_call));
  const three = JSON.stringify(an).length;          // what analyze() serializes: three copies
  const one = JSON.stringify(wireOf().analyzed).length; // what /api/session sends
  assert.ok(one < three * 0.45,
    `wire \`analyzed\` is ${(one / 1024).toFixed(0)} KB vs ${(three / 1024).toFixed(0)} KB — dropping `
    + 'two of three copies should roughly third it; a small delta means a copy is still going out');
});
