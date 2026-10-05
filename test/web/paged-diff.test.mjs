import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionView, pageView, forWire } from '../../src/view/board.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// REGRESSION GUARD (collateral-damage audit, 2026-07-20).
// Wiring the browser half of cursor paging made the step-diff LIE at every window boundary. A
// paged-out call is slimmed to `flat: []` — and `[]` is TRUTHY, so three pre-existing "does this
// call have blocks?" guards all failed OPEN and treated an empty array as a real, zero-block
// context. Measured on a real capture, the same call reported:
//     re-sent Δ  +42 B   →  +689k B      (16,000×)
//     ◆new       1/376   →  375/376
//     ⊖ removed  present →  silently gone
// i.e. "this step re-sent 42 bytes, 1 block is new" inverted into "689 KB, everything is new", in
// the exact view asight exists to provide, with nothing marking it unreliable.
//
// The guards were correct; they had simply never been exercised, because the board never sent
// cursor/limit, so no call was ever slimmed. Paging is what made a dormant bug reachable.
//
// The contract this pins: a paged-out call must be treated as UNKNOWN (no comparison possible),
// never as EMPTY (everything changed). `paged_out` is the signal — not the shape of `flat`.
//
// UPDATED for the one-copy-per-call wire contract (2026-07-20). Each call now crosses the wire
// exactly once: `analyzed.steps` is THE array of call objects, `analyzed.lanes[].calls` names them by
// `gi` NUMBER, and `analyzed.streams` is dropped outright (onWire, src/view/board.mjs:162). So the
// old "slim all three arrays" assertion is re-aimed at the property it existed to protect — the
// payload must not carry any call's body more than once — which the new shape enforces structurally.
// Blocks are also bodyless now (metadata + `text_ref`), except for v0/demo-converted records like
// this fixture, whose original wire bytes are gone and whose blocks are therefore inlined + flagged
// `unaddressable`. Neither change touches what THIS file pins: paged_out vs `flat: []`.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, '..', '..', 'samples', 'demo-session.ndjson');
const records = readFileSync(SAMPLE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const SID = 'demo-0000-4a1b-9c2d-000000000001';

// `steps` is now the ONLY array of call objects on the wire (lanes hold gi numbers), so every test
// below reads calls from there.
test('a paged-out call is marked paged_out and carries no blocks', () => {
  const full = sessionView(records, SID);
  const paged = pageView(full, { cursor: 4, limit: 2 });
  const calls = paged.analyzed.steps || [];
  const out = calls.filter((c) => c.paged_out);
  assert.ok(out.length > 0, 'the fixture must actually produce paged-out calls');
  for (const c of out) {
    assert.ok(!c.flat || c.flat.length === 0, 'a paged-out call ships no blocks');
  }
});

test('a paged-out call keeps its CHEAP meta so the timeline can still draw it', () => {
  const full = sessionView(records, SID);
  const paged = pageView(full, { cursor: 4, limit: 2 });
  const calls = paged.analyzed.steps || [];
  const out = calls.find((c) => c.paged_out);
  assert.ok(out, 'sanity: a paged-out call exists');
  assert.ok(out.ctx != null, 'ctx must survive — the bar height comes from it');
  assert.ok(out.cacheBreak != null, 'cacheBreak must survive — the cache band needs it');
  assert.ok(out.gi != null, 'gi must survive — it is the cursor unit');
});

// The browser-side contract, asserted directly on the shape the browser receives: any code deciding
// "can I diff against this call?" MUST consult paged_out, because `flat: []` is truthy and
// `(c.flat || null)` therefore yields `[]`, not null.
test('`flat: []` is truthy — so truthiness alone cannot gate a diff', () => {
  const full = sessionView(records, SID);
  const paged = pageView(full, { cursor: 4, limit: 2 });
  const out = (paged.analyzed.steps || []).find((c) => c.paged_out);
  assert.equal(!!(out.flat || null), true,
    'this is the trap: `[]` is truthy, so `prevCall.flat || null` returns an empty array and the '
    + 'diff proceeds against a zero-block baseline, marking every block new');
  assert.equal(out.paged_out, true, 'paged_out is the signal that must be used instead');
});

test('a paged-out call still keeps `rec`, so `prevCall.rec` cannot gate it either', () => {
  const full = sessionView(records, SID);
  const paged = pageView(full, { cursor: 4, limit: 2 });
  const out = (paged.analyzed.steps || []).find((c) => c.paged_out);
  assert.ok(out.rec, 'slimCall preserves a stub rec — so the `prevCall.rec` guard also fails open');
});

// ── the three stacked defects that made a long session unviewable ────────────────────────────
// (1) sessionView() tail-bounds records BEFORE pageView() windows them, so on a real 578-call
//     session only ~5 calls exist to page through at all — the browser pages through a session the
//     server already discarded 99% of.
// (2) pageView() slims `analyzed.lanes[].calls` but leaves the parallel `analyzed.steps` array fat,
//     so the response barely shrinks (measured 366 KB → 286 KB on an 8-call sample; on a real
//     session `steps` alone would carry every verbatim body and blow the same V8 string limit
//     tail-bounding existed to avoid).
// (3) covered above: `flat: []` is truthy.

test('paging DISABLES the tail-bound: every call of a long session is present', () => {
  // 8 calls, but a budget that would tail-bound to a couple — with a page requested, the whole
  // session must still be assembled so the timeline can show all of it.
  const tiny = 20 * 1024;
  const bounded = sessionView(records, SID, { maxBytes: tiny });
  assert.ok(bounded.truncated, 'precondition: this budget really does tail-bound');
  assert.ok((bounded.analyzed.lanes[0].calls || []).length < 8, 'precondition: calls were dropped');

  const paged = sessionView(records, SID, { maxBytes: tiny, page: { cursor: 0, limit: 2 } });
  // Under the new wire shape the call OBJECTS live in `steps` (lanes name them by gi), so the
  // "was the whole session assembled?" question is asked of `steps`.
  const steps = paged.analyzed.steps || [];
  assert.equal(steps.length, 8,
    'with a cursor window the server must assemble the WHOLE session and slim what is out of '
    + 'window — tail-bounding first is what makes a 578-call session render 5 steps');
  assert.deepEqual(steps.map((c) => c.gi), [0, 1, 2, 3, 4, 5, 6, 7],
    'every call of the session must be present, in gi order, bodies or not — gi is the cursor unit '
    + 'and the browser rehydrates lanes by indexing steps with it');
  assert.equal(steps.filter((c) => !c.paged_out).length, 2,
    'and only the requested window may carry bodies, or the bound was traded for an unbounded send');
  assert.equal(paged.truncated, null, 'a paged view is not truncated — nothing was discarded');
});

// PAGING × THE WIRE TRANSFORM, composed in the order the server composes them (server.mjs:306/313:
// sessionView(page) → forWire). Order matters and has bitten before: while onWire ran INSIDE
// sessionView, pageView received lanes that were already gi NUMBERS, read `c.gi` off a number
// (undefined → "out of window") and slimCall()d each one into a `{paged_out:true, flat:[]}` stub with
// no gi, no ts, no ctx. The browser's buildLanes (index.html:832) only rehydrates entries that are
// `typeof === 'number'`, so it kept those stubs and the timeline drew a lane of gi-less, ctx-less
// bars; and pageView's `total`, counted over the deduped union of steps + lane entries, saw the stubs
// as distinct objects and reported an 8-call session as 16 — walking the cursor a whole window past
// the end. Paging must slim CALL OBJECTS, and the gi-number projection must happen after it.
test('a paged view survives forWire: lanes stay gi numbers, total counts the session once', () => {
  const paged = sessionView(records, SID, { page: { cursor: 0, limit: 2 } });
  assert.equal(paged.page.total, 8,
    'page.total must count the real session once — double-counting steps + lanes walks the cursor '
    + 'past the end');
  assert.equal(paged.page.nextCursor, 2, 'and the cursor advances by the window, not by the miscount');

  const wire = forWire(paged);
  assert.deepEqual(wire.analyzed.lanes[0].calls, [0, 1, 2, 3, 4, 5, 6, 7],
    'a lane names its calls by gi NUMBER after paging too — an object stub here is unrehydratable');
  const steps = wire.analyzed.steps || [];
  for (const gi of wire.analyzed.lanes[0].calls) {
    const c = steps[gi];
    assert.ok(c && c.gi === gi, `lane entry ${gi} must index the matching call in steps`);
    assert.ok(c.ctx != null && c.ts != null,
      `call ${gi} must keep the cheap meta the timeline draws with, paged out or not`);
  }
});

test('paging slims `steps` too, or the payload never actually shrinks', () => {
  const full = sessionView(records, SID);
  const paged = sessionView(records, SID, { page: { cursor: 0, limit: 2 } });
  const size = (o) => JSON.stringify(o).length;
  assert.ok(size(paged) < size(full) * 0.5,
    `a 2-of-8 window must be far smaller than the whole session, got ${(size(paged) / 1024).toFixed(0)}KB `
    + `vs ${(size(full) / 1024).toFixed(0)}KB — \`analyzed.steps\` is almost certainly still fat`);
  const fatSteps = (paged.analyzed.steps || []).filter((s) => !s.paged_out && s.flat && s.flat.length);
  assert.ok(fatSteps.length <= 2, `only the window may carry blocks in steps; ${fatSteps.length} do`);
});

// analyze() puts each call object in THREE places, not two: `steps`, `lanes[].calls`, AND
// `streams[].calls`. Slimming the first two still shipped every verbatim body through the third, so a
// deep window on a real session returned HTTP 500 "Invalid string length" — the response overran
// V8's max string on the way out, which the board renders as its empty state, i.e. it reports that a
// session with hundreds of calls has none. Paging that does not shrink the payload is not paging.
//
// The wire contract now settles this structurally instead of by slimming three arrays: onWire()
// drops `streams` outright and reduces `lanes[].calls` to gi numbers, leaving `steps` as the one
// carrier of call objects. So the assertion is aimed at the invariant itself — NO call's body may
// appear in the payload more than once, whichever array it came through.
test('every call crosses the wire exactly once — no array duplicates a body', () => {
  // The wire is what 500'd, so measure the wire: sessionView(page) → forWire, as server.mjs does.
  const view = forWire(sessionView(records, SID, { page: { cursor: 0, limit: 2 } }));
  const wire = JSON.stringify(view.analyzed);
  const steps = view.analyzed.steps || [];
  assert.ok(steps.length, 'precondition: steps carries the call objects');
  assert.equal(((view.analyzed.streams || []).flatMap((s) => s.calls || [])).length, 0,
    '`streams` was a third full copy of every call and nothing ever read it — it must not be on the wire');

  // Each call's record id is unique in the fixture, and `rec` is serialized once per copy of the
  // call object, so this count IS the number of times that call was written out. Three copies —
  // steps + lanes + streams — is what 500'd a real session.
  for (const c of steps) {
    const marker = `"rec":{"id":${JSON.stringify(String(c.rec.id))}`;
    const n = wire.split(marker).length - 1;
    assert.equal(n, 1, `call ${c.rec.id} was serialized ${n}× into analyzed — one copy per call, or `
      + 'the window overruns V8\'s max string and /api/session 500s');
  }

  // …and only the window (plus the one diff baseline) may carry blocks at all.
  const fat = steps.filter((c) => !c.paged_out && c.flat && c.flat.length);
  assert.ok(fat.length && fat.length <= 3,
    `steps shipped ${fat.length} fat calls for a 2-wide window (window + diff baseline = 3 max)`);
});
