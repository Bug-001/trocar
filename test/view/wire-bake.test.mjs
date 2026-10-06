// test/view/wire-bake.test.mjs — the server bakes the canonical wire facts on every assembly path (3.2:131-133,
// invariant 3: the page only reads them) and lists the request keys that are not blocks (4.6 R2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSession } from '../../src/view/assemble.mjs';
import { parseTextRef } from '../../src/etl/orchestrator.mjs';

const stream = (r) => (Object.defineProperty(r, '_stream', { value: 'c.ndjson', enumerable: false }), r);
// what the collector writes for a dsh call (proc.agent = its descriptor name, host = api.deepseek.com)
const dsh = stream({ id: 'a1', ts_request: '2026-10-06T00:00:00Z', is_llm_call: true, endpoint: '/anthropic/v1/messages', capture: 'transparent',
  host: 'api.deepseek.com', proc: { pid: 1, exe: '/x', agent: 'deepseek-dsh' }, req_headers: { 'x-deepseek-harness-session-id': 'D' },
  req_body: '{"model":"deepseek-chat","system":[{"type":"text","text":"s"}],"messages":[{"role":"user","content":"q"}],"dsh_session_log":{"a":1}}',
  resp: { status: 200, kind: 'sse', usage: { input_tokens: 1, output_tokens: 1 } } });

test('Anthropic-wire calls carry wire facts and their non-block keys', () => {
  const c = assembleSession([dsh]).steps[0];
  const { observerEffect, ...rest } = c.wire;
  assert.deepEqual(rest, { format: 'anthropic', vendor: 'deepseek', transport: 'http', contextState: 'complete', labels: [] });
  assert.deepEqual(observerEffect.map((e) => e.id), ['dsh-plugin'], 'a transparent dsh capture carries the trust-plugin observer effect (3.1 table)');
  assert.deepEqual(c.nonBlockKeys.map((k) => k.key), ['model', 'dsh_session_log']);
  const { start, end } = parseTextRef(c.nonBlockKeys[1].ref);
  assert.equal(dsh.req_body.slice(start, end), '{"a":1}');
  assert.equal(c.nonBlockKeys[1].chars, 7);
});

test('flat-lane calls carry the same facts; a legacy capture has no observer effect (R5)', () => {
  const z = stream({ id: 'z1', ts_request: '2026-10-06T00:00:00Z', is_llm_call: true, endpoint: '/api/paas/v4/chat/completions',
    req_headers: { 'x-session-id': 'Z', host: 'open.bigmodel.cn' }, req_body: '{"model":"glm","messages":[{"role":"user","content":"q"}],"stream":true}',
    resp: { status: 200, kind: 'sse', raw_sse: [] } });
  const c = assembleSession([z]).steps[0];
  assert.deepEqual(c.wire, { format: 'openai-chat', vendor: 'zai', transport: 'http', contextState: 'complete', observerEffect: null, labels: [] });
  assert.deepEqual(c.nonBlockKeys.map((k) => k.key), ['model', 'stream']);
});

test('a server-edited Anthropic response is contextState server_edited', () => {
  const r = stream({ ...dsh, id: 'a2', resp: { status: 200, kind: 'json', body: { context_management: { applied_edits: [{ type: 'clear_tool_uses' }] }, usage: {} } } });
  assert.equal(assembleSession([r]).steps[0].wire.contextState, 'server_edited');
});

test('incompleteness labels: each is baked on the call; only an incomplete request changes context_state (3.1, G17)', () => {
  const wireOfRec = (extra) => assembleSession([stream({ ...dsh, id: 'a3', ...extra })]).steps[0].wire;
  const cut = wireOfRec({ resp: { ...dsh.resp, truncated: true, body_bytes: 67108864 } });
  assert.deepEqual([cut.contextState, cut.labels.map((l) => l.id)], ['complete', ['resp-truncated']]);
  assert.match(cut.labels[0].text, /first 67108864 bytes/);
  const unfinished = wireOfRec({ error: true, resp: { status: 200, kind: 'error', partial: { kind: 'sse', raw: 'event: x' } } });
  assert.deepEqual(unfinished.labels.map((l) => l.id), ['resp-partial']);
  const undecoded = wireOfRec({ resp: { status: 200, kind: 'sse', encoding_error: 'zstd', raw_b64: 'AA==' } });
  assert.deepEqual(undecoded.labels.map((l) => l.id), ['resp-undecoded']);
  const ws = wireOfRec({ ws_truncated: true });
  assert.deepEqual([ws.contextState, ws.labels.map((l) => l.id)], ['complete', ['ws-truncated']]);
  const enc = wireOfRec({ req_encoding_error: 'zstd unsupported', req_content_encoding: 'zstd' });
  assert.deepEqual([enc.contextState, enc.labels.map((l) => l.id)], ['complete', ['req-undecoded']]);
  assert.match(enc.labels[0].text, /\(zstd\)/);
  assert.equal(wireOfRec({ req_partial: 'aborted' }).contextState, 'partial', 'G17: the stored request is not the whole context');
  assert.equal(wireOfRec({}).labels.length, 0);
});

test('a paged-out call keeps its wire facts (cheap meta) but ships no non-block keys', () => {
  const later = stream({ ...dsh, id: 'a9', ts_request: '2026-10-06T00:00:09Z' });
  const A = assembleSession([dsh, later], { keepFlat: (gi) => gi === 1 });
  assert.equal(A.steps[0].paged_out, true);
  assert.equal(A.steps[0].wire.vendor, 'deepseek');
  assert.deepEqual(A.steps[0].nonBlockKeys, []);
  assert.equal(A.steps[1].nonBlockKeys.length, 2);
});

test('a Chat request stored cut is still a Chat call that says why, not unrecognized traffic', () => {
  const cut = stream({ id: 'k1', ts_request: '2026-10-06T00:00:00Z', is_llm_call: true, endpoint: '/coding/v1/chat/completions',
    host: 'api.kimi.com', req_headers: {}, req_body: '{"model":"kimi","messages":[{"role":"user","content":"a very lo',
    req_truncated: true, req_body_bytes: 40, resp: { status: 200, kind: 'sse', raw_sse: [] } });
  const A = assembleSession([cut]);
  assert.equal(A.unknown, undefined);
  assert.equal(A.steps.length, 1);
  assert.deepEqual([A.steps[0].wire.format, A.steps[0].wire.contextState, A.steps[0].reqIncomplete.truncated], ['openai-chat', 'partial', true]);
});

test('a harness-marked warm-up sits in a probe lane that says what it is (the page shows lane.note)', () => {
  const x = (id, sec, kind) => stream({ id, ts_request: `2026-10-06T00:00:0${sec}Z`, is_llm_call: true, endpoint: '/backend-api/codex/responses',
    host: 'chatgpt.com', proc: { pid: 2, exe: '/x/codex', agent: 'codex' },
    req_headers: { 'session-id': 'X', ...(kind ? { 'x-codex-turn-metadata': JSON.stringify({ request_kind: kind }) } : {}) },
    req_body: '{"model":"gpt-5","input":[]}', resp: { status: 200, kind: 'sse', raw_sse: [] } });
  const A = assembleSession([x('x1', 1, 'prewarm'), x('x2', 2)]);
  const probe = A.lanes.find((l) => l.kind === 'probe');
  assert.deepEqual(probe.calls.map((c) => c.id), ['x1']);
  assert.match(probe.note, /not a conversation turn/);
  assert.deepEqual(A.lanes.find((l) => l.kind === 'main').calls.map((c) => c.id), ['x2']);
});
