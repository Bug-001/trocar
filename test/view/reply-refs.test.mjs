// test/view/reply-refs.test.mjs — 4.6 R2 / gate G1: every reply is addressable by a field-qualified ref the board
// ships with the call (call.respRefs), or says why it is not (invariant 4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionView } from '../../src/view/board.mjs';
import { assembleSession } from '../../src/view/assemble.mjs';

const stream = (r) => (Object.defineProperty(r, '_stream', { value: 'capture-2026-10-06.ndjson', enumerable: false }), r);
const tail = (ref) => ref && ref.split('::').slice(-2).join('::');

const wsRec = (messages, extra = {}) => stream({ id: 'w1', ts_request: '2026-10-06T00:00:00Z', is_llm_call: true, endpoint: '/v1/responses', transport: 'ws',
  flow_id: 'F', seq: 1, ws_ext: '', capture: 'transparent', host: 'chatgpt.com', proc: { pid: 2, exe: '/x/codex', agent: 'codex' },
  req_headers: { 'session-id': 'CX' }, req_body: '{"type":"response.create","model":"m","input":[]}', resp: { kind: 'ws', messages }, ...extra });

test('a WebSocket reply ships one ref per server message; a base64 or omitted message is listed with its reason', () => {
  const done = '{"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}';
  const call = assembleSession([wsRec(['{"type":"response.created"}', { b64: 'AAEC' }, { omitted_bytes: 70000000 }, done])]).steps[0];
  assert.deepEqual(call.respRefs.map((r) => [r.label, tail(r.ref)]), [
    ['message 1', 'resp.messages.0::0-27'], ['message 2', null], ['message 3', null], ['message 4', `resp.messages.3::0-${done.length}`]]);
  assert.match(call.respRefs[1].why, /base64/);
  assert.match(call.respRefs[2].why, /omitted/);
});

test('an error envelope lists what arrived before the failure, marked as such', () => {
  const partial = wsRec([], { resp: { kind: 'error', status: null, error: { type: 'ECONNRESET', message: 'x' }, partial: { kind: 'ws', messages: ['{"type":"response.created"}'] } } });
  const call = assembleSession([partial]).steps[0];
  assert.deepEqual(call.respRefs.map((r) => [r.label, tail(r.ref)]), [['message 1 (what arrived before the exchange failed)', 'resp.messages.0::0-27']]);
});

test('a JSON reply is listed as not byte-verbatim, with no ref (gate G16); no response says so', () => {
  const r = stream({ id: 'j1', ts_request: '2026-10-06T00:00:00Z', is_llm_call: true, endpoint: '/v1/messages', req_headers: { 'x-claude-code-session-id': 'S' },
    req_body: '{"model":"m","messages":[{"role":"user","content":"q"}]}', resp: { status: 200, kind: 'json', body: { content: [], usage: {} } } });
  const call = assembleSession([r]).steps[0];
  assert.deepEqual(call.respRefs.map((x) => x.ref), [null]);
  assert.match(call.respRefs[0].why, /parsed/);
  const none = assembleSession([stream({ ...r, id: 'j2', resp: { kind: 'error', status: null, error: { type: 'ECONNRESET' } } })]).steps[0];
  assert.match(none.respRefs[0].why, /no reply bytes arrived/);
});

test('a call whose request could not be parsed still lists its reply', () => {
  const r = stream({ id: 'u1', ts_request: '2026-10-06T00:00:00Z', is_llm_call: true, endpoint: '/v1/messages', req_headers: { 'x-claude-code-session-id': 'S' },
    req_body: '{"model":"m","messages":[{"role":"us', req_truncated: true, req_body_bytes: 36, resp: { status: 200, kind: 'text', raw: 'ok' } });
  const call = assembleSession([r]).steps[0];
  assert.deepEqual(call.respRefs.map((x) => [x.label, tail(x.ref)]), [['body', 'resp.raw::0-2']]);
});
