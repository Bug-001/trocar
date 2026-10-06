// test/view/reply-refs.test.mjs — 4.6 R2 / gate G1: every reply is addressable by a field-qualified ref the board
// ships with the call (call.respRefs), or says why it is not (invariant 4).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockUpstream } from '../lab/mock-upstream/server.mjs';
import { request, waitFor } from '../lab/helpers.mjs';
import { startTeeProxy } from '../helpers/tee-proxy.mjs';
import { readRecords } from '../../src/etl/ingest.mjs';
import { sessionView } from '../../src/view/board.mjs';
import { assembleSession } from '../../src/view/assemble.mjs';
import { buildResolver } from '../../src/query/source.mjs';

const T = { timeout: 15000 };
const stream = (r) => (Object.defineProperty(r, '_stream', { value: 'capture-2026-10-06.ndjson', enumerable: false }), r);
const tail = (ref) => ref && ref.split('::').slice(-2).join('::');

test('an SSE reply ships one resp.raw ref that resolves to the whole decoded stream', T, async (t) => {
  const up = await startMockUpstream(); t.after(() => up.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-rr-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const px = await startTeeProxy({ upstreamPort: up.port, dir, flow: { host: 'api.anthropic.com', proc: { pid: 1, exe: '/x/claude', agent: 'claude-code' } } });
  t.after(() => px.close());
  await request(`http://127.0.0.1:${px.port}`, '/v1/messages', '{"model":"m","stream":true,"max_tokens":8,"messages":[{"role":"user","content":"hi"}]}', { headers: { 'x-claude-code-session-id': 'S' } });
  await waitFor(() => px.envelopes.length === 1, 5000);
  const records = (await Promise.all(px.files().map((f) => readRecords(f)))).flat();
  const call = sessionView(records, 'S').analyzed.steps[0];
  assert.equal(call.respRefs.length, 1);
  assert.equal(call.respRefs[0].label, 'stream');
  const resolve = await buildResolver([dir]); t.after(() => resolve.dispose());
  const d = resolve.detail(call.respRefs[0].ref);
  assert.deepEqual([d.status, d.fidelity], ['ok', 'verbatim']);
  assert.equal(d.text, records[0].resp.raw);
  assert.equal(call.respRefs[0].chars, d.text.length);
  assert.match(d.text, /event: message_start/);
});

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
