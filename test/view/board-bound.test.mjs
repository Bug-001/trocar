import test from 'node:test';
import assert from 'node:assert/strict';
import { tailBound, sessionView } from '../../src/view/board.mjs';

// 4.4:90 + invariant 4 — a large session MUST NOT be assembled/shipped whole. Unbounded, the view
// overruns V8's max string on JSON.stringify (HTTP 500 "Invalid string length") and can OOM the
// server, after which the board renders its EMPTY state and falsely reports "No LLM calls traced
// yet" for a session that has hundreds. Bounded, we keep the most-recent COMPLETE calls that fit and
// disclose the omission via `truncated` (which the board renders as the 非完整视图 banner).

const rec = (i, bytes, llm = true) => ({
  id: `r${i}`, ts_request: `2026-07-18T00:00:${String(i).padStart(2, '0')}.000Z`,
  is_llm_call: llm, endpoint: '/v1/messages',
  req_headers: { 'x-claude-code-session-id': 'S' },
  req_body: 'x'.repeat(bytes),
  resp: { kind: 'json', status: 200 },
});

test('under budget: nothing is dropped and the view is NOT marked truncated', () => {
  const recs = [rec(1, 100), rec(2, 100)];
  const { recs: out, bound } = tailBound(recs, 10_000);
  assert.equal(out.length, 2);
  assert.equal(bound, null, 'full fidelity → no truncation marker');
});

test('over budget: keeps the MOST RECENT calls and discloses what was omitted', () => {
  const recs = [rec(1, 1000), rec(2, 1000), rec(3, 1000), rec(4, 1000)];
  const { recs: out, bound } = tailBound(recs, 2200); // fits 2 records
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.id), ['r3', 'r4'], 'the TAIL (most recent) is kept');
  assert.equal(bound.shown, 2);
  assert.equal(bound.total, 4, 'total reports every call, not just the shipped ones');
  assert.ok(bound.file_mb >= bound.kept_mb);
});

test('a single oversized call is still shipped (never an empty view)', () => {
  const recs = [rec(1, 100), rec(2, 5_000_000)];
  const { recs: out, bound } = tailBound(recs, 1000); // even one record blows the budget
  assert.equal(out.length, 1, 'always keep at least one call');
  assert.equal(out[0].id, 'r2');
  assert.equal(bound.shown, 1);
});

test('shown/total count LLM calls only (telemetry noise is not miscounted as calls)', () => {
  const recs = [rec(1, 10, false), rec(2, 10, false), rec(3, 1000), rec(4, 1000)];
  const { bound } = tailBound(recs, 1100);
  assert.equal(bound.total, 2, 'only the two is_llm_call records count');
});

test('sessionView(maxBytes) bounds the assembled view and sets truncated', () => {
  const recs = [rec(1, 2000), rec(2, 2000), rec(3, 2000)];
  const full = sessionView(recs, 'S', {});
  assert.equal(full.truncated, null, 'no budget → untouched');
  const bounded = sessionView(recs, 'S', { maxBytes: 2100 });
  assert.ok(bounded.truncated, 'budget exceeded → view is MARKED non-complete');
  assert.equal(bounded.truncated.total, 3);
  assert.ok(bounded.truncated.shown < 3);
});
