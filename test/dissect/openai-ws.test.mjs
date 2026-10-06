// test/dissect/openai-ws.test.mjs — the Responses-over-WebSocket dissector (RFC 3.1:37 / 3.1:60, D37 ②, 4.6 W3/W5/W6/W7
// at unit level). Every envelope is built by the collector's own buildWsEnvelope, so the field layout (req_body,
// resp.messages / resp.partial.messages, partial / partial_reasons, req_extra_messages) is exactly what it writes.
// The mock-driven checks are the end-to-end suite (W5/W7) and test/view/ws-board.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWsEnvelope } from '../../src/collector/core/record/envelope.mjs';
import { roleOf, chainPlan, stitchedRequest, locate, normRespWs, RESPONSES_WS } from '../../src/dissect/openai-ws.mjs';

const user = (t) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] });
const out = (t) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] });
const upgrade = (key) => ({
  req: { head: { raw: Buffer.from(`GET /v1/responses HTTP/1.1\r\nsession-id: S\r\nsec-websocket-key: ${key}\r\n\r\n`, 'latin1'), method: 'GET', target: '/v1/responses',
    headers: [['Host', 'api.openai.com'], ['Upgrade', 'websocket'], ['session-id', 'S'], ['Sec-WebSocket-Key', key]] } },
  resp: { head: { raw: Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n', 'latin1'), headers: [['Upgrade', 'websocket']] } },
});
let n = 0;
// One logical call as the collector writes it: the client's response.create, then the server messages up to the terminal.
function ws({ flow = 'F1', key = 'k1', input = [], prev, generate, terminal = 'response.completed', id, output = [], partial = [], extra = [], error = null }) {
  const body = { type: 'response.create', model: 'gpt-x', instructions: 'You are Codex.', tools: [], input,
    ...(prev ? { previous_response_id: prev } : {}), ...(generate === false ? { generate: false } : {}) };
  const done = !terminal ? null : terminal === 'error' ? { type: 'error', status: 500, error: { message: 'x' } }
    : { type: terminal, response: { id, status: terminal.split('.')[1], output, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 2 } } };
  const server = [JSON.stringify({ type: 'response.created', response: { id } }), ...(terminal ? [JSON.stringify(done)] : [])];
  n++;
  const ts = `2026-10-06T00:00:${String(n).padStart(2, '0')}.000Z`;
  return buildWsEnvelope({ id: `w${n}`, seq: n, wsRaw: [], error,
    flow: { id: flow, host: 'api.openai.com', scheme: 'https', dst: { address: '127.0.0.1', port: 443 }, proc: { pid: 7, exe: '/x/codex', agent: 'codex' } },
    upgrade: upgrade(key), call: { client: [JSON.stringify(body), ...extra], server, tsStart: ts, tsRespStart: ts, tsEnd: ts, partial, truncated: false } });
}
const items = (plan) => plan.segments.map((s) => s.item);

test('W7: context(N) = stitched input(N-1) + output(N-1) + input(N), each segment located in its own record and field', () => {
  const a = ws({ input: [user('q1')], id: 'r1', output: [out('a1')] });
  const b = ws({ input: [user('q2')], prev: 'r1', id: 'r2', output: [out('a2')] });
  const c = ws({ input: [{ type: 'function_call_output', call_id: 'k', output: 'ok' }], prev: 'r2', id: 'r3' });
  const plan = chainPlan([c, a, b]); // array order does not matter: seq orders a connection
  assert.deepEqual(items(plan.get(c)), [user('q1'), out('a1'), user('q2'), out('a2'), { type: 'function_call_output', call_id: 'k', output: 'ok' }]);
  assert.deepEqual(plan.get(c).segments.map((s) => [s.rec.id, s.field]), [
    [a.id, 'req_body'], [a.id, 'resp.messages.1'], [b.id, 'req_body'], [b.id, 'resp.messages.1'], [c.id, 'req_body']]);
  assert.deepEqual([plan.get(a).contextState, plan.get(b).contextState, plan.get(c).contextState], ['complete', 'reconstructed', 'reconstructed']);
  assert.equal(stitchedRequest(c, plan.get(c)).instructions, 'You are Codex.', 'instructions come from the call itself (resent every time)');
});

test('W3: a generate:false warmup is in the chain, its role says so, and the turn after it inherits its prompt', () => {
  const w = ws({ input: [user('ctx'), user('q1')], generate: false, id: 'rW' });
  const c = ws({ input: [], prev: 'rW', id: 'r1', output: [out('a1')] });
  const plan = chainPlan([w, c]);
  assert.deepEqual([roleOf(w), roleOf(c)], ['warmup', 'call']);
  assert.deepEqual([plan.get(w).contextState, plan.get(c).contextState], ['complete', 'reconstructed']);
  assert.deepEqual(items(plan.get(c)), [user('ctx'), user('q1')], 'the warmup carried the prompt; the turn sent nothing new');
  assert.equal(RESPONSES_WS.laneOf(w), 'probe');
  assert.equal(RESPONSES_WS.laneOf(c), null);
});

test('W5: a missing predecessor makes that call and every later call on the chain partial, and says what is missing', () => {
  const b = ws({ input: [user('q2')], prev: 'r-gone', id: 'r2', output: [out('a2')] });
  const c = ws({ input: [user('q3')], prev: 'r2', id: 'r3' });
  const plan = chainPlan([b, c]);
  assert.deepEqual([plan.get(b).contextState, plan.get(c).contextState], ['partial', 'partial']);
  assert.match(plan.get(c).missing, /r-gone/);
  assert.deepEqual(items(plan.get(c)), [user('q2'), out('a2'), user('q3')], 'a partial call still carries what it has');
});

test('W6: the collector\'s partial flag forces partial on a continuation even when the chain resolves', () => {
  const a = ws({ input: [user('q1')], id: 'r1' });
  const b = ws({ input: [user('q2')], prev: 'r1', id: 'r2', partial: ['off-window'] });
  const plan = chainPlan([a, b]);
  assert.equal(plan.get(b).contextState, 'partial');
  assert.match(plan.get(b).missing, /off-window/);
});

test('3.1:60 narrowing: a call without previous_response_id carries its whole input, so the collector flag does not make it partial', () => {
  const full = ws({ input: [user('ctx'), user('q1')], id: 'r9', partial: ['decode-failed'] });
  assert.equal(chainPlan([full]).get(full).contextState, 'complete');
});

test('only response.completed can be continued: failed, incomplete, error and cut calls are no chain head', () => {
  for (const [terminal, error] of [['response.failed', null], ['response.incomplete', null], ['error', null], [null, { type: 'ECONNRESET', message: 'cut' }]]) {
    const a = ws({ input: [user('q1')], id: 'r1', terminal, error });
    const b = ws({ input: [user('q2')], prev: 'r1', id: 'r2' });
    const plan = chainPlan([a, b]);
    assert.equal(plan.get(a).responseId, null, String(terminal));
    assert.equal(plan.get(b).contextState, 'partial', String(terminal));
  }
});

test('stitching follows previous_response_id only, never position: an OpenCode-style connection resends the full input each time', () => {
  const a = ws({ input: [user('q1')], id: 'r1', output: [out('a1')] });
  const b = ws({ input: [user('q1'), out('a1'), user('q2')], id: 'r2' }); // no previous_response_id: complete, not stitched
  const plan = chainPlan([a, b]);
  assert.equal(plan.get(b).contextState, 'complete');
  assert.deepEqual(items(plan.get(b)), [user('q1'), out('a1'), user('q2')], 'no context counted twice');
});

test('chains never cross connections — not even when two connections reuse a flow id (a restarted collector counts from 1 again)', () => {
  const a = ws({ flow: 'F1', key: 'k1', input: [user('q1')], id: 'r1' });
  const b = ws({ flow: 'F2', key: 'k2', input: [user('q2')], prev: 'r1', id: 'r2' });
  assert.equal(chainPlan([a, b]).get(b).contextState, 'partial');
  const c = ws({ flow: 'F1', key: 'k9', input: [user('q2')], prev: 'r1', id: 'r3' });
  assert.equal(chainPlan([a, c]).get(c).contextState, 'partial', 'same flow id, another upgrade (Sec-WebSocket-Key)');
});

test('a string input is one user message; locate() maps each stitched block back to its source record, field and path', () => {
  const a = ws({ input: 'hello', id: 'r1', output: [out('a1')] });
  const b = ws({ input: [user('q2')], prev: 'r1', id: 'r2' });
  const plan = chainPlan([a, b]);
  const flat = RESPONSES_WS.boardFlat(stitchedRequest(b, plan.get(b)));
  const msgs = flat.filter((x) => x.sec === 'messages');
  assert.deepEqual(locate(msgs[0], b, plan.get(b)), { rec: a, field: 'req_body', path: ['input'] }, 'the whole string');
  assert.deepEqual(locate(msgs[1], b, plan.get(b)), { rec: a, field: 'resp.messages.1', path: ['response', 'output', 0, 'content', 0] });
  assert.deepEqual(locate(msgs[2], b, plan.get(b)), { rec: b, field: 'req_body', path: ['input', 0, 'content', 0] });
  assert.deepEqual(locate(flat.find((x) => x.sec === 'system'), b, plan.get(b)), { rec: b, field: 'req_body', path: ['instructions'] });
});

test('roles: a non-create client message and a server message with no call open are other; a legacy 101 is a handshake', () => {
  assert.equal(roleOf({ endpoint: '/v1/responses', method: 'GET', req_headers: { upgrade: 'websocket' }, req_body: '', resp: { status: 101 } }), 'handshake');
  assert.equal(roleOf({ ...ws({ input: [] }), req_body: '{"type":"response.interrupt"}' }), 'other');
  const pushed = buildWsEnvelope({ id: 'p', seq: 99, wsRaw: [], flow: { id: 'F1', proc: { agent: 'codex' } }, upgrade: upgrade('k1'),
    call: { client: [], server: ['{"type":"rate_limits.updated"}'], tsStart: 't', tsRespStart: 't', tsEnd: 't', partial: [], truncated: false } });
  assert.equal(pushed.req_body, null);
  assert.equal(roleOf(pushed), 'other');
});

test('normRespWs reads the terminal message: text, usage, stop; an error terminal and a cut call say so', () => {
  const r = normRespWs(ws({ input: [user('q')], id: 'r9', output: [out('done')] }));
  assert.deepEqual([r.text, r.id, r.canonUsage.read, r.canonUsage.fresh, r.stop_reason], ['done', 'r9', 4, 6, 'completed']);
  assert.equal(normRespWs(ws({ input: [user('q')], terminal: 'error' })).stop_reason, 'error');
  assert.equal(normRespWs(ws({ input: [user('q')], terminal: 'response.failed', id: 'rf' })).stop_reason, 'failed');
  const cut = normRespWs(ws({ input: [user('q')], terminal: null, error: { type: 'ECONNRESET', message: 'cut' }, id: 'rc' }));
  assert.equal(cut.stop_reason, null, 'no terminal arrived (resp.partial): no stop reason is invented');
  assert.equal(RESPONSES_WS.failed(cut, { error: true }), true);
});

test('server messages that are not JSON text are counted, not silently skipped', () => {
  const rec = ws({ input: [user('q')], id: 'r1', output: [out('ok')] });
  rec.resp.messages.splice(1, 0, { b64: 'AAE=' }, 'not json', { omitted_bytes: 70000000 });
  const r = normRespWs(rec);
  assert.equal(r.text, 'ok');
  assert.equal(r.unread, 3);
});
