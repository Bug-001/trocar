import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionView, pageView } from '../../src/view/board.mjs';
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, '..', '..', 'samples', 'demo-session.ndjson');
const records = readFileSync(SAMPLE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const SID = 'demo-0000-4a1b-9c2d-000000000001';

test('a paged-out call is marked paged_out and carries no blocks', () => {
  const full = sessionView(records, SID);
  const paged = pageView(full, { cursor: 4, limit: 2 });
  const calls = paged.analyzed.steps || paged.analyzed.lanes?.[0]?.calls || [];
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
  const calls = paged.analyzed.lanes[0].calls || [];
  assert.equal(calls.length, 8,
    'with a cursor window the server must assemble the WHOLE session and slim what is out of '
    + 'window — tail-bounding first is what makes a 578-call session render 5 steps');
  assert.equal(paged.page.total, 8, 'page.total must count the real session, not the bounded view');
  assert.equal(paged.truncated, null, 'a paged view is not truncated — nothing was discarded');
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
test('paging slims EVERY array that holds calls, including `streams`', () => {
  const full = sessionView(records, SID);
  const paged = pageView(full, { cursor: 0, limit: 2 });
  const arrays = {
    steps: paged.analyzed.steps || [],
    lanes: (paged.analyzed.lanes || []).flatMap((l) => l.calls || []),
    streams: (paged.analyzed.streams || []).flatMap((s) => s.calls || []),
  };
  for (const [name, calls] of Object.entries(arrays)) {
    assert.ok(calls.length, `precondition: ${name} carries calls`);
    const fat = calls.filter((c) => !c.paged_out && c.flat && c.flat.length);
    assert.ok(fat.length <= 3, `${name} shipped ${fat.length} fat calls for a 2-wide window `
      + '(window + diff baseline = 3 max) — an unslimmed array leaks the whole session');
  }
});
