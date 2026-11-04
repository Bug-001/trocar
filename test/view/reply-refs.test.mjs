// test/view/reply-refs.test.mjs — 3.2 回复块回源 / 4.6 R2 / gate G1: every reply is addressable by a field-qualified ref the call ships
// (the `lane` document's step detail `respRefs`), or says why it is not (invariant 4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeWith, query } from '../helpers/session-doc.mjs';

const tail = (ref) => ref && ref.split('::').slice(-2).join('::');
// the one call's respRefs, read as the board reads it
async function respRefs(rec, id) {
  const home = homeWith([rec]), { calls: [call] } = await query(home, 'session', { id });
  const { steps } = await query(home, 'lane', { id, lane: call.lane });
  return steps.find((s) => s.rid === call.rid).detail.respRefs;
}
const wsRec = (messages, extra = {}) => ({ id: 'w1', ts_request: '2026-10-06T00:00:00Z', endpoint: '/v1/responses', transport: 'ws',
  flow_id: 'F', seq: 1, ws_ext: '', host: 'chatgpt.com', proc: { pid: 2, exe: '/x/codex', agent: 'codex' },
  req_headers: { 'session-id': 'CX' }, req_body: '{"type":"response.create","model":"m","input":[]}', resp: { kind: 'ws', messages }, ...extra });
const why = (r) => r.ref == null && typeof r.why === 'string' && r.why.length > 0;

test('a WebSocket reply ships one ref per server message; a base64 or omitted message has no ref and says why', async () => {
  const done = '{"type":"response.completed","response":{"id":"r1","status":"completed","output":[]}}';
  const refs = await respRefs(wsRec(['{"type":"response.created"}', { b64: 'AAEC' }, { omitted_bytes: 70000000 }, done]), 'CX');
  assert.deepEqual(refs.map((r) => tail(r.ref)), ['resp.messages.0::0-27', null, null, `resp.messages.3::0-${done.length}`]);
  assert.ok(why(refs[1]) && why(refs[2]));
});

test('an error envelope lists what arrived before the failure', async () => {
  const refs = await respRefs(wsRec([], { resp: { kind: 'error', status: null, error: { type: 'ECONNRESET', message: 'x' }, partial: { kind: 'ws', messages: ['{"type":"response.created"}'] } } }), 'CX');
  assert.deepEqual(refs.map((r) => tail(r.ref)), ['resp.messages.0::0-27']);
});

const jsonRec = { id: 'j1', ts_request: '2026-10-06T00:00:00Z', endpoint: '/v1/messages', host: 'api.anthropic.com', req_headers: { 'x-claude-code-session-id': 'S' },
  req_body: '{"model":"m","messages":[{"role":"user","content":"q"}]}', resp: { status: 200, kind: 'json', body: { content: [], usage: {} } } };

test('a JSON reply stored parsed ships one ref, and the block query reads it back as the written-out body (4.2 §回源指针)', async () => {
  const home = homeWith([jsonRec]), { calls: [call] } = await query(home, 'session', { id: 'S' });
  const { steps } = await query(home, 'lane', { id: 'S', lane: call.lane });
  const { detail: { respRefs: [{ ref }] } } = steps.find((s) => s.rid === call.rid);
  assert.equal((await query(home, 'block', { ref })).blocks[0].bytes, JSON.stringify(jsonRec.resp.body));
});

test('no response at all has no ref and says why', async () => {
  const refs = await respRefs({ ...jsonRec, resp: { kind: 'error', status: null, error: { type: 'ECONNRESET' } } }, 'S');
  assert.equal(refs.length, 1);
  assert.ok(why(refs[0]));
});

test('a call whose request could not be parsed still lists its reply', async () => {
  const refs = await respRefs({ ...jsonRec, id: 'u1', req_body: '{"model":"m","messages":[{"role":"us', req_truncated: true, req_body_bytes: 36,
    resp: { status: 200, kind: 'text', raw: 'ok' } }, 'S');
  assert.deepEqual(refs.map((x) => tail(x.ref)), ['resp.raw::0-2']);
});
