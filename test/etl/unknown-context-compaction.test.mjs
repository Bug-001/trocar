// test/etl/unknown-context-compaction.test.mjs — 3.4: a call whose context is
// unknown has no observed message count, so it is judged no compaction and is no baseline for the next call; DuckDB
// and the board say the same (review RV-1, RV-6; invariant 4). Without it a message-count "drop" between a known call
// and one that only shows part of its context — a Codex continuation whose predecessor is not in the capture, a call
// whose own request was not stored, a request body that did not parse — became a compaction nobody observed
// (compaction=true, from=30, to=1, or to=0), on both sides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runEtl } from '../../src/etl/orchestrator.mjs';
import { assembleSession } from '../../src/view/assemble.mjs';
import { bodyUnparsedOf, contextStateOfRequest } from '../../src/dissect/capture-labels.mjs';
import { freshConn } from './helpers.mjs';

const stream = (r) => (Object.defineProperty(r, '_stream', { value: 'c.ndjson', enumerable: false }), r);
const compRows = async (conn) => (await conn.runAndReadAll(
  'SELECT call_id, context_state, compaction, compaction_from, compaction_to FROM calls ORDER BY call_id')).getRowObjects()
  .map((r) => [r.call_id, r.context_state, r.compaction, r.compaction_from == null ? null : Number(r.compaction_from), r.compaction_to == null ? null : Number(r.compaction_to)]);

// ── Codex over WebSocket: one lane, a chain of previous_response_id ──────────────────────────────────────────
const done = (id, input = 100) => JSON.stringify({ type: 'response.completed', response: { id, status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: input, output_tokens: 3 } } });
const TEXT_FRAME = 'gQ==';
const wsBase = { endpoint: '/backend-api/codex/responses', is_llm_call: true, transport: 'ws', flow_id: 'f', host: 'chatgpt.com',
  capture: 'transparent', req_headers: { 'session-id': 'S', 'sec-websocket-key': 'k' }, proc: { pid: 1, exe: '/x/codex', agent: 'codex' } };
const user = (t) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] });
const full = () => stream({ ...wsBase, id: 'w0', seq: 0, ts_request: '2026-10-06T00:00:00Z',
  req_body: JSON.stringify({ type: 'response.create', model: 'gpt-5', instructions: 'You are Codex.', input: Array.from({ length: 30 }, (_, i) => user('m' + i)) }),
  ws_raw: [{ i: 1, d: 'c', h: TEXT_FRAME, m: [0, 0] }], resp: { kind: 'ws', messages: [done('r0')] } });
const unstored = () => stream({ ...wsBase, id: 'w1', seq: 1, ts_request: '2026-10-06T00:00:01Z', req_body: null, ws_truncated: true,
  ws_raw: [{ i: 1, d: 'c', h: TEXT_FRAME }], resp: { kind: 'ws', messages: ['{"type":"response.created"}', done('r1')] } });
const continuation = (id, prev, input) => stream({ ...wsBase, id, seq: 2, ts_request: '2026-10-06T00:00:02Z',
  req_body: JSON.stringify({ type: 'response.create', model: 'gpt-5', instructions: 'You are Codex.', input, previous_response_id: prev }),
  ws_raw: [{ i: 3, d: 'c', h: TEXT_FRAME, m: [0, 0] }], resp: { kind: 'ws', messages: [done('r2', 50)] } });

const boardOf = (recs) => assembleSession(recs).steps.map((s) => [s.id, s.wire.contextState, !!s.compaction, s.evictedFrom ?? null, s.evictedTo ?? null]);

test('a continuation after a call whose request was not stored is no compaction: 30 → 2 messages is a partial context, not a drop', async () => {
  const recs = () => [full(), unstored(), continuation('w2', 'r1', [user('q2'), user('q3')])];
  const conn = await freshConn();
  await runEtl(recs(), conn);
  assert.deepEqual(await compRows(conn), [['w0', 'complete', false, null, null], ['w1', 'partial', false, null, null], ['w2', 'partial', false, null, null]]);
  assert.deepEqual(boardOf(recs()), [['w0', 'complete', false, null, null], ['w1', 'partial', false, null, null], ['w2', 'partial', false, null, null]],
    'the board agrees with DuckDB');
});

test('a continuation whose predecessor is not in the capture (capture off and on, a daemon restart) is no compaction', async () => {
  const recs = () => [full(), continuation('w2', 'r-never-captured', [user('q2')])];
  const conn = await freshConn();
  await runEtl(recs(), conn);
  assert.deepEqual(await compRows(conn), [['w0', 'complete', false, null, null], ['w2', 'partial', false, null, null]]);
  assert.deepEqual(boardOf(recs()), [['w0', 'complete', false, null, null], ['w2', 'partial', false, null, null]]);
});

test('the lane keeps its last KNOWN count across a partial call: a real drop after it is still found, from the known count', async () => {
  // w0 is 30 items, w1 is not stored, then a FULL request of 3 items (no previous_response_id): that is a real
  // 30 → 3 drop against the last call whose count was observed, in both the ETL and the board
  const fresh = () => stream({ ...wsBase, id: 'w3', seq: 3, ts_request: '2026-10-06T00:00:03Z',
    req_body: JSON.stringify({ type: 'response.create', model: 'gpt-5', instructions: 'You are Codex.', input: [user('a'), user('b'), user('c')] }),
    ws_raw: [{ i: 5, d: 'c', h: TEXT_FRAME, m: [0, 0] }], resp: { kind: 'ws', messages: [done('r3', 40)] } });
  const recs = () => [full(), unstored(), fresh()];
  const conn = await freshConn();
  await runEtl(recs(), conn);
  assert.deepEqual(await compRows(conn), [['w0', 'complete', false, null, null], ['w1', 'partial', false, null, null], ['w3', 'complete', true, 30, 3]]);
  assert.deepEqual(boardOf(recs()).map((r) => r[0] + ':' + r[2] + ':' + r[3] + ':' + r[4]), ['w0:false:null:null', 'w1:false:null:null', 'w3:true:30:3']);
});

// ── Anthropic wire: a request body that did not parse, or that was stored in part ───────────────────────────
const cut = '{"model":"c","messages":[{"role":"us';
const body = (n) => JSON.stringify({ model: 'c', system: [{ type: 'text', text: 'You are X. '.repeat(50) }],
  messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: 'm' + i }] })) });
const usage = (read, write) => ({ input_tokens: 5, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 1 });
const mk = (id, sec, bodyText, u, extra = {}) => stream({ id, ts_request: `2026-10-06T00:00:0${sec}Z`, endpoint: '/v1/messages', method: 'POST',
  is_llm_call: true, capture: 'transparent', host: 'api.anthropic.com', proc: { pid: 1, exe: '/x/claude', agent: 'claude-code' },
  req_headers: { 'x-claude-code-session-id': 'S', 'user-agent': 'claude-cli/2', ...(extra.headers || {}) }, req_body: bodyText,
  resp: { kind: 'sse', status: 200, usage: u }, ...(extra.envelope || {}) });

test('a request body that does not parse is a partial call: no compaction (it was true, 1 → 0), and the next call is judged against the last known count', async () => {
  const recs = () => [mk('a', 1, body(1), usage(0, 100)), mk('b', 2, cut, usage(100, 0)), mk('c', 3, body(3), usage(100, 10))];
  const conn = await freshConn();
  await runEtl(recs(), conn);
  assert.deepEqual(await compRows(conn), [['a', 'complete', false, null, null], ['b', 'partial', false, null, null], ['c', 'complete', false, null, null]]);
  // its cache row says it is blind: no prefix hash, no ground truth, and the reason (3.2:124)
  const ce = (await conn.runAndReadAll("SELECT prefix_sha256, ground_truth_flag, extra FROM cache_events WHERE call_id = 'b'")).getRowObjects()[0];
  assert.equal(ce.prefix_sha256, null);
  assert.equal(ce.ground_truth_flag, null);
  assert.equal(JSON.parse(ce.extra).context_state, 'partial');
  // and the board: the same, the step says it is unparsed and the call is no compaction
  const steps = assembleSession(recs()).steps;
  assert.deepEqual(steps.map((s) => [s.id, s.unparsed, s.wire.contextState, !!s.compaction]), [['a', false, 'complete', false], ['b', true, 'partial', false], ['c', false, 'complete', false]]);
});

test('a harness compaction hint on a call whose context is unknown is not judged either (compaction_to would be an invented 0)', async () => {
  const recs = () => [mk('a', 1, body(4), usage(0, 100)), mk('b', 2, cut, usage(100, 0), { headers: { 'x-cc-compaction-request': '1' } })];
  const conn = await freshConn();
  await runEtl(recs(), conn);
  assert.deepEqual(await compRows(conn), [['a', 'complete', false, null, null], ['b', 'partial', false, null, null]]);
  assert.deepEqual(assembleSession(recs()).steps.map((s) => !!s.compaction), [false, false]);
});

test('a request stored only in part but whose prefix still parses (req_partial) shows its blocks, with no compaction on either side', async () => {
  // 10 messages, then 4 with req_partial: the collector did not receive the whole body (4.6 §记录). The drop 10 → 4 is
  // large enough for both rules (ETL: any drop; board: over 5 and under 70%), and 4 messages keep the call in the main
  // lane on both sides (a call of 2 or fewer without tools is a quota stream on the board only, RV-7), so only the
  // rule under test stops it
  const recs = () => [mk('a', 1, body(10), usage(0, 100)), mk('b', 2, body(4), usage(100, 0), { envelope: { req_partial: 'aborted' } }), mk('c', 3, body(12), usage(100, 10))];
  const conn = await freshConn();
  await runEtl(recs(), conn);
  assert.deepEqual(await compRows(conn), [['a', 'complete', false, null, null], ['b', 'partial', false, null, null], ['c', 'complete', false, null, null]]);
  assert.deepEqual(assembleSession(recs()).steps.map((s) => [s.id, !!s.compaction]), [['a', false], ['b', false], ['c', false]]);
});

test('a complete call that really drops is still a compaction on both sides (the rule did not turn compaction off)', async () => {
  const recs = () => [mk('a', 1, body(10), usage(0, 100)), mk('b', 2, body(4), usage(0, 100))];
  const conn = await freshConn();
  await runEtl(recs(), conn);
  assert.deepEqual(await compRows(conn), [['a', 'complete', false, null, null], ['b', 'complete', true, 10, 4]]);
  assert.deepEqual(assembleSession(recs()).steps.map((s) => [s.id, !!s.compaction]), [['a', false], ['b', true]]);
});

test('bodyUnparsedOf: only a string body that is not a JSON object; no body, an object, a v0 envelope are not this case', () => {
  assert.equal(bodyUnparsedOf({ req_body: cut }), true);
  assert.equal(bodyUnparsedOf({ req_body: '' }), true);
  assert.equal(bodyUnparsedOf({ req_body: 'null' }), true, 'a JSON null has no messages either: the board calls it unparsed');
  assert.equal(bodyUnparsedOf({ req_body: '7' }), true);
  assert.equal(bodyUnparsedOf({ req_body: body(1) }), false);
  assert.equal(bodyUnparsedOf({ req_body: '[]' }), false);
  assert.equal(bodyUnparsedOf({ req_body: null }), false);
  assert.equal(bodyUnparsedOf({ request: { messages: [] } }), false);
  assert.equal(bodyUnparsedOf(null), false);
  assert.equal(contextStateOfRequest({ req_body: cut }), 'partial');
  assert.equal(contextStateOfRequest({ req_body: body(1) }), null);
});
