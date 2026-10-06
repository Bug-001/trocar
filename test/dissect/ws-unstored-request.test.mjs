// test/dissect/ws-unstored-request.test.mjs — 4.6 §传输与帧级记录: a WebSocket call whose first client message the
// collector did not store (over the per-call cap, or not decompressible) has req_body:null, told apart from an
// envelope with no client message by a client data frame in ws_raw plus ws_truncated / partial_reasons decode-failed.
// It is a call: it ran, its reply and usage are real (4.6 acceptance #5: never rendered as complete, never lost).
// Before, it was quarantined as not-a-call and its usage was missing from DuckDB; the board showed 0 steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roleOf, unstoredRequestOf } from '../../src/dissect/openai-ws.mjs';
import { quarantineReason } from '../../src/adapters/envelope.mjs';
import { assembleSession } from '../../src/view/assemble.mjs';
import { runEtl } from '../../src/etl/orchestrator.mjs';
import { freshConn } from '../etl/helpers.mjs';

const stream = (r) => (Object.defineProperty(r, '_stream', { value: 'c.ndjson', enumerable: false }), r);
const done = (id, input = 9000000) => JSON.stringify({ type: 'response.completed', response: { id, status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: input, output_tokens: 3 } } });
const TEXT_FRAME = 'gQ==';  // 0x81: FIN + text — a client data frame (its payload omitted: header only)
const PING_FRAME = 'iQ==';  // 0x89: FIN + ping — a control frame, rides with any envelope
const base = { endpoint: '/backend-api/codex/responses', is_llm_call: true, transport: 'ws', flow_id: 'f', host: 'chatgpt.com',
  capture: 'transparent', req_headers: { 'session-id': 'S', 'sec-websocket-key': 'k' }, proc: { pid: 1, exe: '/x/codex', agent: 'codex' } };
const overCap = () => stream({ ...base, id: 'w1', seq: 1, ts_request: '2026-10-06T00:00:01Z', req_body: null, ws_truncated: true,
  ws_raw: [{ i: 1, d: 'c', h: TEXT_FRAME }], resp: { kind: 'ws', messages: ['{"type":"response.created"}', done('r1')] } });
const undecoded = () => stream({ ...base, id: 'w1', seq: 1, ts_request: '2026-10-06T00:00:01Z', req_body: null, partial: true, partial_reasons: ['decode-failed'],
  ws_raw: [{ i: 1, d: 'c', h: 'wQ==', p: 'AAAA' }], resp: { kind: 'ws', messages: [done('r1')] } });
const next = () => stream({ ...base, id: 'w2', seq: 2, ts_request: '2026-10-06T00:00:02Z',
  req_body: JSON.stringify({ type: 'response.create', model: 'gpt-5', instructions: 'You are Codex.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q2' }] }], previous_response_id: 'r1' }),
  ws_raw: [{ i: 3, d: 'c', h: TEXT_FRAME, m: [0, 0] }], resp: { kind: 'ws', messages: [done('r2', 50)] } });

test('the spec-shaped envelopes are calls whose request was not stored; a push is still no call', () => {
  assert.equal(roleOf(overCap()), 'unstored');
  assert.match(unstoredRequestOf(overCap()), /over the per-call size cap/);
  assert.equal(roleOf(undecoded()), 'unstored');
  assert.match(unstoredRequestOf(undecoded()), /could not be decompressed/);
  // no client data frame: a server push with no call open (W14), even when it carries a client ping
  const push = stream({ ...base, id: 'p1', seq: 1, ts_request: '2026-10-06T00:00:01Z', req_body: null, ws_truncated: true,
    ws_raw: [{ i: 1, d: 'c', h: PING_FRAME, p: '' }, { i: 2, d: 's', h: TEXT_FRAME }], resp: { kind: 'ws', messages: ['{"type":"codex.rate_limits"}'] } });
  assert.equal(roleOf(push), 'other');
  assert.equal(quarantineReason(push), 'not-a-call:openai-responses-ws');
  // a binary opener keeps its bytes in req_body_b64: not this case
  assert.equal(unstoredRequestOf({ ...overCap(), req_body_b64: 'AAAA' }), null);
});

for (const [name, make] of [['over the cap', overCap], ['not decompressible', undecoded]]) {
  test(`ETL (${name}): ingested as a partial call with its usage, the reason on the row, no blocks, no compaction`, async () => {
    const conn = await freshConn();
    const stats = await runEtl([make(), next()], conn);
    assert.equal(stats.quarantined, 0);
    const rows = (await conn.runAndReadAll('SELECT c.call_id, c.context_state, c.compaction, c.extra, u.input_uncached, u.total_input FROM calls c LEFT JOIN usage u USING (call_id) ORDER BY c.call_id')).getRowObjects();
    assert.deepEqual(rows.map((r) => [r.call_id, r.context_state, r.compaction]), [['w1', 'partial', false], ['w2', 'partial', false]],
      'and a continuation of its response is partial too: its stitched context lacks this call\'s input');
    assert.equal(Number(rows[0].total_input), 9000000, 'the usage is not lost');
    assert.match(JSON.parse(rows[0].extra).request_not_stored, /not stored/);
    const blocks = (await conn.runAndReadAll("SELECT count(*) n FROM call_blocks WHERE call_id = 'w1'")).getRowObjects()[0];
    assert.equal(Number(blocks.n), 0);
  });

  test(`board (${name}): one step that says why it shows no context, partial, not an error`, () => {
    const A = assembleSession([make(), next()]);
    assert.equal(A.unknown, undefined);
    const [s1, s2] = A.steps;
    assert.equal(s1.unparsed, true, 'the page shows "nothing to render" with the reason');
    assert.match(s1.errMsg, /request message of this call was not stored/);
    assert.equal(s1.error, false, 'the call ran; its reply is real');
    assert.equal(s1.wire.contextState, 'partial');
    assert.equal(s1.usage.fresh + s1.usage.read, 9000000);
    assert.equal(s2.wire.contextState, 'partial');
    assert.equal(s2.compaction, false);
  });
}

test('board: the over-cap call carries the 已截断 label', () => {
  const s = assembleSession([overCap()]).steps[0];
  assert.deepEqual(s.wire.labels.map((l) => l.id), ['ws-truncated']);
});
