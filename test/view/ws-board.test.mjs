// test/view/ws-board.test.mjs — Codex over WebSocket on the board (RFC 4.6 W3 / W5 / W7 / W13, 3.1:37 / 3.1:60, R2),
// driven by real traffic: a WebSocket client → the collector's REAL exchange tee, WebSocket recorder and record store
// (test/helpers/tee-proxy.mjs) → the lab mock's Responses WebSocket. Read back through the product's sessionView and
// resolver, and once end to end through `asight serve` (createServer → /api/projects → /api/session → /api/block).
// Every expectation comes from the mock's byte log, never from asight's parse.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startMockUpstream } from '../lab/mock-upstream/server.mjs';
import { waitFor } from '../lab/helpers.mjs';
import { wsConnect } from '../lab/ws-client.mjs';
import { startTeeProxy } from '../helpers/tee-proxy.mjs';
import { readMockLog, wsConnIds, wsMessagesOf, expectedWsContexts, verifyWsCall } from '../lab/verbatim-check.mjs';
import { readRecords } from '../../src/etl/ingest.mjs';
import { sessionView, forWire } from '../../src/view/board.mjs';
import { buildResolver } from '../../src/query/source.mjs';
import { createServer } from '../../src/server.mjs';
import { parseTextRef } from '../../src/etl/orchestrator.mjs';

const T = { timeout: 20000 };
const CODEX_TERMINAL = [{ pathSuffix: '/responses', patterns: ['^\\{"type":"(response\\.(completed|failed|incomplete)|error)"'] }];
const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const create = (f) => JSON.stringify({ type: 'response.create', model: 'gpt-test-1', store: false, stream: true, instructions: 'You are Codex.',
  tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }], ...f });
const INTERRUPT = '{"type":"response.interrupt"}';

// A warmup (generate:false) → a turn that sends nothing new → a turn with new input, interrupted while open (the
// mock holds its reply 300 ms, so the interrupt lands inside the call: req_extra_messages, W13).
async function codexWs(t) {
  const up = await startMockUpstream({ delays: { stallMs: 300 } }); t.after(() => up.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-wsb-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const px = await startTeeProxy({ upstreamPort: up.port, dir, wsTerminal: CODEX_TERMINAL, flow: { host: 'chatgpt.com', proc: { pid: 31, exe: '/x/codex', agent: 'codex' } } });
  t.after(() => px.close());
  const c = await wsConnect(px.port, { path: '/backend-api/codex/responses', extensions: 'permessage-deflate; client_max_window_bits', headers: { 'session-id': 'CX' } });
  assert.equal(c.status, 101);
  await c.sendText(create({ input: [user('ctx'), user('q1 héllo')], generate: false }));
  const w = (await c.events()).at(-1).response;
  await c.sendText(create({ input: [], previous_response_id: w.id }));
  const r1 = (await c.events()).at(-1).response;
  await c.sendText(create({ input: [user('q2 [[mock:slow-headers]]')], previous_response_id: r1.id }));
  await c.sendText(INTERRUPT);
  await c.events();
  await waitFor(() => px.envelopes.filter((e) => e.transport === 'ws').length === 3);
  assert.deepEqual(px.failures, [], 'the recorder reported no capture failure');
  const records = (await Promise.all(px.files().map((f) => readRecords(f)))).flat();
  const log = await readMockLog(up);
  return { records, log, dir, conn: wsConnIds(log)[0] };
}
const wsOf = (records) => records.filter((r) => r.transport === 'ws').sort((a, b) => a.seq - b.seq);

test('W3: the warmup sits in a probe lane that says what it is; the two turns are the main lane', T, async (t) => {
  const { records } = await codexWs(t);
  const v = sessionView(records, 'CX');
  const lanes = Object.fromEntries(v.analyzed.lanes.map((l) => [l.id, l]));
  assert.deepEqual(Object.keys(lanes).sort(), ['main', 'probe']);
  assert.equal(lanes.main.calls.length, 2, 'two turns');
  assert.equal(lanes.probe.kind, 'probe');
  assert.deepEqual(lanes.probe.calls.map((c) => c.id), [wsOf(records)[0].id]);
  assert.match(lanes.probe.note, /not a conversation turn/);
  v.analyzed.steps.forEach((s, i) => assert.equal(s.gi, i));
  assert.equal(v.analyzed.unknown, undefined, 'nothing on the socket went unread');
});

test('W7: every call\'s stitched blocks resolve, through refs into earlier records, to the context the mock kept', T, async (t) => {
  const { records, log, dir, conn } = await codexWs(t);
  const ws = wsOf(records);
  const contexts = expectedWsContexts(wsMessagesOf(log, conn, ws[0].ws_ext));
  const resolve = await buildResolver([dir]); t.after(() => resolve.dispose());
  const check = (v) => {
    for (const call of v.analyzed.steps) {
      const index = contexts.contexts.findIndex((c) => c.text === ws.find((r) => r.id === call.id).req_body);
      const res = verifyWsCall({ call, resolve, contexts, index });
      assert.deepEqual(res.problems, [], call.id);
      assert.ok(res.checked.units >= 3 && res.checked.nonBlockKeys.includes('type'), `${call.id}: units and keys were checked`);
      assert.equal(call.wire.transport, 'ws');
    }
    return v.analyzed.steps.map((s) => s.wire.contextState);
  };
  assert.deepEqual(check(sessionView(records, 'CX')), ['complete', 'reconstructed', 'reconstructed']);
  const last = sessionView(records, 'CX').analyzed.steps[2];
  const inherited = last.flat.filter((b) => /^resp\.messages\.\d+$/.test(parseTextRef(b.text_ref).field || ''));
  assert.ok(inherited.length > 0 && inherited.every((b) => parseTextRef(b.text_ref).recordId === ws[1].id),
    'the inherited assistant output is addressed in the earlier record\'s reply');
  assert.ok(last.flat.some((b) => parseTextRef(b.text_ref).recordId === ws[0].id), 'and the warmup\'s prompt in the warmup\'s own request');
  // a tail bound that keeps only the last call must not make it look partial: the chain sees the whole session
  const bounded = sessionView(records, 'CX', { maxBytes: 1 });
  assert.ok(bounded.truncated, 'precondition: the view really was bounded');
  assert.deepEqual(bounded.analyzed.steps.map((s) => s.wire.contextState), ['reconstructed']);
  assert.deepEqual(check(bounded), ['reconstructed']);
});

test('W5: removing the first envelope at read time marks the later calls partial, says what is missing, and blinds their cache claims', T, async (t) => {
  const { records } = await codexWs(t);
  const first = wsOf(records)[0];
  const v = sessionView(records.filter((r) => r !== first), 'CX');
  assert.deepEqual(v.analyzed.steps.map((s) => s.wire.contextState), ['partial', 'partial']);
  for (const s of v.analyzed.steps) {
    assert.ok(s.flat.length > 0, 'a partial call still shows what it has');
    assert.match(s.wire.contextMissing, /previous_response_id/);
    assert.equal(s.gt, null);
    assert.equal(s.prefixSha256, null, '3.2:124: no byte-identity claim over a context we do not have');
  }
});

test('W13 (3.1:37): the interrupt sent while the call was open is listed on that call and resolves to its bytes', T, async (t) => {
  const { records, dir } = await codexWs(t);
  const last = wsOf(records)[2];
  assert.deepEqual(last.req_extra_messages, [INTERRUPT], 'precondition: the recorder put the interrupt in the call');
  const call = sessionView(records, 'CX').analyzed.steps.find((s) => s.id === last.id);
  assert.equal(call.extraMessages.length, 1);
  const resolve = await buildResolver([dir]); t.after(() => resolve.dispose());
  assert.equal(resolve.detail(call.extraMessages[0].ref).text, INTERRUPT);
  assert.equal(sessionView(records, 'CX').analyzed.steps[1].extraMessages, undefined, 'calls without one carry no list');
});

test('a server message pushed with no call open, and a binary opener, are counted as unrendered records, not dropped', () => {
  const base = { transport: 'ws', is_llm_call: true, endpoint: '/v1/responses', ts_request: '2026-10-06T00:00:00Z', flow_id: 'F', proc: { pid: 1, agent: 'codex' }, req_headers: { 'session-id': 'CX' } };
  const call = { ...base, id: 'c1', seq: 0, req_body: create({ input: [user('q')] }), resp: { kind: 'ws', messages: ['{"type":"response.completed","response":{"id":"r1","output":[]}}'] } };
  const push = { ...base, id: 'p1', seq: 1, req_body: null, resp: { kind: 'ws', messages: ['{"type":"codex.rate_limits"}'] } };
  const bin = { ...base, id: 'b1', seq: 2, req_body: null, req_body_b64: 'AAE=', resp: { kind: 'ws', messages: [] } };
  const v = sessionView([call, push, bin], 'CX');
  assert.deepEqual(v.analyzed.steps.map((s) => s.id), ['c1']);
  assert.deepEqual([v.analyzed.unknown.partial, v.analyzed.unknown.records], [true, 2]);
  const only = sessionView([push, bin], 'CX').analyzed.unknown; // no call at all: the whole session is unrendered
  assert.deepEqual([only.partial, only.records], [false, 2]);
  assert.match(only.reason, /records of a known wire that are no call/, 'not "no dissector claims these bytes": one does');
});

test('a call that ends in an error is an error step and never the next call\'s cache baseline; unread reply messages are labelled', () => {
  const base = { transport: 'ws', is_llm_call: true, endpoint: '/v1/responses', flow_id: 'F', proc: { pid: 1, agent: 'codex' }, req_headers: { 'session-id': 'CX', 'sec-websocket-key': 'k' } };
  const done = (id, text) => JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 5, output_tokens: 1 } } });
  const at = (seq) => `2026-10-06T00:00:0${seq}Z`;
  const a = { ...base, id: 'a', seq: 0, ts_request: at(0), req_body: create({ input: [user('q1')] }), resp: { kind: 'ws', messages: [done('r1', 'a1')] } };
  const b = { ...base, id: 'b', seq: 1, ts_request: at(1), req_body: create({ input: [user('q2')], previous_response_id: 'r1' }),
    resp: { kind: 'ws', messages: ['{"type":"error","status":500,"error":{"message":"boom"}}'] } };
  const c = { ...base, id: 'c', seq: 2, ts_request: at(2), req_body: create({ input: [user('q3')], previous_response_id: 'r1' }),
    resp: { kind: 'ws', messages: [{ b64: 'AAE=' }, done('r3', 'a3')] } };
  const steps = sessionView([a, b, c], 'CX').analyzed.steps;
  assert.deepEqual(steps.map((s) => s.error), [false, true, false]);
  assert.equal(steps[2].cacheBreak.cause, 'append', 'c extends a\'s cached prefix; b (failed) never became the baseline');
  assert.deepEqual(steps[2].wire.labels.map((l) => l.id), ['reply-unread']);
  assert.match(steps[2].wire.labels[0].label, /1 reply message not read/);
  assert.deepEqual(steps[1].wire.labels, []);
  // these hand-built records were read from no stream: each stitched block says so where it is shown (invariant 4)
  for (const blk of steps[2].flat.filter((x) => x.sec === 'messages')) assert.match(blk.unaddressable, /record [ac] carries no id or stream to address/);
});

test('end to end through `asight serve`: the session lists under codex, and every block of every call opens over /api/block', T, async (t) => {
  const { records, log, dir, conn } = await codexWs(t);
  const { server } = await createServer({ dbPath: '/nonexistent-db-xyz', sourcePath: [dir] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const port = server.address().port;
  const get = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b) })); }).on('error', rej));
  const listed = (await get('/api/projects')).body.projects.flatMap((p) => p.sessions).find((x) => x.session_id === 'CX');
  assert.deepEqual([listed && listed.harness, listed && listed.calls], ['codex', 3], 'the session is listed under codex with its three calls');
  const s = (await get('/api/session?id=CX')).body;
  assert.deepEqual(s.analyzed.steps.map((x) => x.wire.contextState), ['complete', 'reconstructed', 'reconstructed']);
  const ws = wsOf(records);
  const contexts = expectedWsContexts(wsMessagesOf(log, conn, ws[0].ws_ext));
  // the resolver the checker uses is the HTTP endpoint itself
  const blocks = new Map();
  for (const call of s.analyzed.steps) for (const b of [...call.flat, ...call.nonBlockKeys, ...(call.extraMessages || [])]) if (b.text_ref || b.ref) blocks.set(b.text_ref || b.ref, null);
  for (const ref of blocks.keys()) {
    const r = await get('/api/block?ref=' + encodeURIComponent(ref));
    assert.equal(r.status, 200, `${ref}: ${JSON.stringify(r.body)}`);
    blocks.set(ref, r.body);
  }
  const wholes = new Map();
  for (const ref of blocks.keys()) {
    const { rawRef, field } = parseTextRef(ref);
    const key = `${rawRef}::${field}`;
    if (!wholes.has(key)) wholes.set(key, (await get('/api/block?ref=' + encodeURIComponent(`${rawRef}::${field ? field + '::' : ''}0-999999999`))).body);
  }
  const overHttp = { detail: (ref) => {
    if (blocks.has(ref)) return { ...blocks.get(ref) };
    const { rawRef, field } = parseTextRef(ref);
    return { ...wholes.get(`${rawRef}::${field}`) };
  } };
  for (const call of s.analyzed.steps) {
    const index = contexts.contexts.findIndex((c) => c.text === ws.find((r) => r.id === call.id).req_body);
    assert.deepEqual(verifyWsCall({ call, resolve: overHttp, contexts, index }).problems, [], call.id);
  }
  assert.ok([...blocks.values()].every((b) => b.fidelity === 'verbatim'));
});

test('assemble.mjs still names no wire: the WebSocket path is reached only through the dissector object', () => {
  const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'view', 'assemble.mjs'), 'utf8');
  assert.doesNotMatch(SRC, /previous_response_id|response\.create|response\.completed|generate\s*:|openai-ws|RESPONSES_WS/);
});
