// test/view/board-blind-prefix.test.mjs — 3.2:124 on the board's Anthropic-wire path: a partial or server-edited
// call gets no prefix_sha256 and no ground-truth flag, exactly as in DuckDB (the flat-lane path already blinds them).
// Without it the board printed "provider-contradiction" on the very call where the server said it edited the context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSession } from '../../src/view/assemble.mjs';
import { runEtl } from '../../src/etl/orchestrator.mjs';
import { freshConn } from '../etl/helpers.mjs';

const stream = (r) => (Object.defineProperty(r, '_stream', { value: 'c.ndjson', enumerable: false }), r);
const msgs = (n) => {
  const m = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
  for (let i = 0; i < n; i++) m.push({ role: 'assistant', content: [{ type: 'text', text: 'a' + i }] }, { role: 'user', content: [{ type: 'text', text: 'q' + i }] });
  return m;
};
const body = (n) => JSON.stringify({ model: 'claude-x', system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }], messages: msgs(n) });
const U = { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 };
const cc = (id, n, extra = {}) => stream({ id, ts_request: `2026-10-06T00:00:0${n}Z`, endpoint: '/v1/messages', method: 'POST', is_llm_call: true,
  capture: 'transparent', host: 'api.anthropic.com', proc: { pid: 1, exe: '/x/claude', agent: 'claude-code' },
  req_headers: { 'x-claude-code-session-id': 'S', 'user-agent': 'claude-cli/2' }, req_body: body(n),
  resp: { kind: 'sse', status: 200, usage: U }, ...extra });
const records = () => [
  cc('c1', 1),
  // the server reports it applied a context edit (an SSE message_delta) → server_edited
  cc('c2', 2, { resp: { kind: 'sse', status: 200, usage: U, raw_sse: [{ type: 'message_delta', context_management: { applied_edits: [{ type: 'clear_tool_uses_20250919' }] }, usage: U }] } }),
  // a request the collector says it stored incomplete (gate G17), though what is stored parses → partial
  cc('c3', 3, { req_partial: 'aborted' }),
  cc('c4', 4),
];

test('3.2:124: a server-edited or partial Anthropic-wire call has no prefix hash and no ground truth on the board', () => {
  const A = assembleSession(records());
  const by = Object.fromEntries(A.steps.map((s) => [s.id, s]));
  assert.deepEqual(A.steps.map((s) => [s.id, s.streamId === A.steps[0].streamId, s.wire.contextState]),
    [['c1', true, 'complete'], ['c2', true, 'server_edited'], ['c3', true, 'partial'], ['c4', true, 'complete']], 'one lane, the states the test is about');
  for (const id of ['c2', 'c3']) {
    assert.equal(by[id].prefixSha256, null, `${id}: no byte-identity claim over a context the model did not see as shown`);
    assert.equal(by[id].cacheBreak.prefixSha256, null);
    assert.equal(by[id].gt, null, `${id}: no ground-truth flag (it accused the provider before)`);
    assert.equal(by[id].cacheBreak.prefixByteIdentical, false);
  }
  assert.notEqual(by.c4.prefixSha256, null, 'a complete call after them is hashed as before');
});

test('board and DuckDB agree on prefix_sha256 presence and ground_truth_flag per call', async () => {
  const A = assembleSession(records());
  const conn = await freshConn();
  await runEtl(records(), conn);
  const rows = (await conn.runAndReadAll('SELECT c.call_id, c.context_state, e.prefix_sha256, e.ground_truth_flag FROM calls c LEFT JOIN cache_events e USING (call_id) ORDER BY c.call_id')).getRowObjects();
  const db = Object.fromEntries(rows.map((r) => [r.call_id, r]));
  for (const s of A.steps) {
    assert.equal(s.wire.contextState, db[s.id].context_state, `${s.id}: context_state`);
    assert.equal(s.prefixSha256 == null, db[s.id].prefix_sha256 == null, `${s.id}: prefix hash present on both or neither`);
    assert.equal(s.gt ?? null, db[s.id].ground_truth_flag ?? null, `${s.id}: ground_truth_flag`);
  }
});
