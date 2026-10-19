import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionView } from '../../src/view/board.mjs';

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

test('sessionView(maxBytes) bounds the assembled view and sets truncated', () => {
  const recs = [rec(1, 2000), rec(2, 2000), rec(3, 2000)];
  const full = sessionView(recs, 'S', {});
  assert.equal(full.truncated, null, 'no budget → untouched');
  const bounded = sessionView(recs, 'S', { maxBytes: 2100 });
  assert.ok(bounded.truncated, 'budget exceeded → view is MARKED non-complete');
  assert.equal(bounded.truncated.total, 3);
  assert.ok(bounded.truncated.shown < 3);
});
