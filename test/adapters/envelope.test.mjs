// test/adapters/envelope.test.mjs — the generic non-inference adapter and the wire-based Anthropic claim,
// at DB level (3.1:23, 3.1:58, 3.2:134, 3.4 control plane).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runEtl, rebuildContext, parseTextRef } from '../../src/etl/orchestrator.mjs';
import { envelopeAdapter, ENVELOPE_CONSUMED, quarantineReason } from '../../src/adapters/envelope.mjs';
import { freshConn, countOf } from '../etl/helpers.mjs';
import { createRegistry } from '../../src/adapters/contract.mjs';
import { ccAdapter } from '../../src/adapters/cc.mjs';

const rows = async (conn, sql) => (await conn.runAndReadAll(sql)).getRowObjects();
const resolverOf = (records) => { const by = new Map(records.map((r) => [String(r.id), r.req_body])); return (ref) => { const p = parseTextRef(ref); return by.get(p.recordId).slice(p.start, p.end); }; };

// dsh speaks the Anthropic wire to a relay prefix and adds top-level keys of its own (D37 harness check).
const DSH_BODY = '{"model":"deepseek-chat","max_tokens":8192,"system":[{"type":"text","text":"You are dsh."}],' +
  '"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],"tools":[{"name":"bash","input_schema":{"type":"object"}}],' +
  '"dsh_session_log":{"session":{"id":"D1","origin":"main"}},"dsh_plugin_packages":[]}';
const dsh = {
  id: 'd1', ts: '2026-10-06T00:00:00Z', ts_request: '2026-10-06T00:00:00Z', endpoint: '/anthropic/v1/messages', method: 'POST',
  is_llm_call: true, capture: 'transparent', host: 'api.deepseek.com', proc: { pid: 5, exe: '/x/dsh', agent: 'deepseek-dsh' },
  req_headers: { 'x-deepseek-harness-session-id': 'D1', 'user-agent': 'node' }, req_body: DSH_BODY,
  resp: { kind: 'sse', status: 200, usage: { input_tokens: 7, output_tokens: 2 } },
};

test('dsh /anthropic/v1/messages envelope ingests through the Anthropic wire adapter: AC-1 diff=0, dsh_session_log in extra', async () => {
  const conn = await freshConn();
  const stats = await runEtl([dsh], conn);
  assert.equal(stats.quarantined, 0, 'a "node" UA no longer keeps an Anthropic-wire call out of DuckDB');
  const call = (await rows(conn, "SELECT wire_format, vendor, extra FROM calls WHERE call_id='d1'"))[0];
  assert.deepEqual([call.wire_format, call.vendor], ['anthropic', 'deepseek']);
  assert.ok('req_body.dsh_session_log' in JSON.parse(call.extra), 'non-block top-level keys stay in extra, never dropped');
  const rebuilt = await rebuildContext(conn, 'd1', resolverOf([dsh]));
  const body = JSON.parse(DSH_BODY);
  assert.deepEqual(rebuilt.map((b) => b.section), ['tools', 'system', 'messages']);
  for (const b of rebuilt) assert.ok(DSH_BODY.includes(b.text), 'every block is a verbatim slice of the wire string');
  assert.equal(rebuilt.find((b) => b.section === 'tools').text, JSON.stringify(body.tools[0]));
  const ce = (await rows(conn, "SELECT break_kind, extra FROM cache_events WHERE call_id='d1'"))[0];
  assert.notEqual(ce.break_kind, 'explicit-breakpoint', 'cache labels follow the vendor (DeepSeek), never the Anthropic wire');
  assert.equal(JSON.parse(ce.extra).vendor_cache_semantics, 'unknown', 'DeepSeek via its Anthropic endpoint is unverified (3.3:89 OPEN)');
});

test('Gemini, Bedrock and Vertex inference envelopes quarantine as unsupported-wire-format:<name>', async () => {
  const conn = await freshConn();
  const mk = (id, endpoint) => ({ id, ts_request: '2026-10-06T00:00:00Z', endpoint, is_llm_call: true, req_headers: {}, req_body: '{}', resp: { status: 200 } });
  const stats = await runEtl([mk('g', '/v1beta/models/x:generateContent'), mk('b', '/model/m/converse'), mk('v', '/v1/projects/p/locations/l/publishers/google/models/g:generateContent')], conn);
  assert.equal(stats.quarantined, 3);
  const r = await rows(conn, 'SELECT id, reason FROM etl_quarantine ORDER BY id');
  assert.deepEqual(r.map((x) => [x.id, x.reason]), [['b', 'unsupported-wire-format:bedrock'], ['g', 'unsupported-wire-format:gemini'], ['v', 'unsupported-wire-format:vertex']]);
});

test('inference on a wire with no ETL adapter yet is quarantined with that wire named, never dropped', async () => {
  const conn = await freshConn();
  const codex = { id: 'x1', ts_request: '2026-10-06T00:00:00Z', endpoint: '/backend-api/codex/responses', is_llm_call: true,
    req_headers: { 'session-id': 'S' }, req_body: '{"model":"m","input":[]}', resp: { status: 200 } };
  // a registry without the Responses adapter (the default one has it): the reason names the wire
  await runEtl([codex], conn, { registry: createRegistry().register(ccAdapter).register(envelopeAdapter) });
  assert.deepEqual((await rows(conn, 'SELECT id, reason FROM etl_quarantine')).map((x) => [x.id, x.reason]), [['x1', 'no-adapter:openai-responses']]);
});

test('a WS 101 handshake envelope is quarantined as ws-handshake, never ingested as a call (gate G6)', async () => {
  const conn = await freshConn();
  const hs = { id: 'h1', ts_request: '2026-10-06T00:00:00Z', endpoint: '/v1/responses', method: 'GET', is_llm_call: true,
    req_headers: { upgrade: 'websocket', 'session-id': 'S' }, req_body: '', resp: { status: 101, kind: 'empty' } };
  const stats = await runEtl([hs], conn);
  assert.equal(quarantineReason(hs), 'ws-handshake');
  assert.equal(stats.quarantined, 1);
  assert.equal((await rows(conn, "SELECT reason FROM etl_quarantine WHERE id='h1'"))[0].reason, 'ws-handshake');
  assert.equal(await countOf(conn, "SELECT count(*) n FROM calls WHERE call_id='h1'"), 0);
});

test('count_tokens: lane probe, class from the session key, no usage or cache_events row', async () => {
  const conn = await freshConn();
  const probe = { id: 'p1', ts_request: '2026-10-06T00:00:00Z', endpoint: '/v1/messages/count_tokens', is_llm_call: false,
    req_headers: { 'x-claude-code-session-id': 'S' }, req_body: { raw_chars: 4000, verbatim: false }, resp: { status: 200, kind: 'json', body: { input_tokens: 9 } } };
  await runEtl([probe], conn);
  const c = (await rows(conn, "SELECT class, lane, session_id, wire_format, request_bytes FROM calls WHERE call_id='p1'"))[0];
  assert.deepEqual([c.class, c.lane, c.session_id, c.wire_format, Number(c.request_bytes)], ['llm', 'probe', 'S', null, 4000]);
  assert.equal(await countOf(conn, "SELECT count(*) n FROM usage WHERE call_id='p1'"), 0, 'a probe is not inference: no fake zero usage');
  assert.equal(await countOf(conn, "SELECT count(*) n FROM cache_events WHERE call_id='p1'"), 0);
});

test("a body_retention:'verbatim' upload keeps its body, joins its session by key, and is control without one", async () => {
  const conn = await freshConn();
  const up = (id, headers) => ({ id, ts_request: '2026-10-06T00:00:00Z', endpoint: '/v1/files', method: 'POST', is_llm_call: false,
    body_retention: 'verbatim', req_headers: headers, req_body: '{"purpose":"user_data","file":"…"}', resp: { status: 200, kind: 'json', body: { id: 'file_1' } } });
  await runEtl([up('u1', { 'x-claude-code-session-id': 'S' }), up('u2', {})], conn);
  const r = await rows(conn, 'SELECT call_id, class, session_id, lane, request_bytes, unmapped_count FROM calls ORDER BY call_id');
  assert.deepEqual(r.map((x) => [x.call_id, x.class, x.session_id, x.lane]), [['u1', 'llm', 'S', 'aux'], ['u2', 'control', null, null]]);
  assert.equal(Number(r[0].request_bytes), Buffer.byteLength('{"purpose":"user_data","file":"…"}'));
  assert.equal(Number(r[0].unmapped_count), 0, 'body_retention is a known envelope field');
});

test('a header-less control record of any harness is class=control with NULL session', async () => {
  const conn = await freshConn();
  await runEtl([{ id: 'c1', ts_request: '2026-10-06T00:00:00Z', endpoint: '/backend-api/wham/usage', method: 'GET', is_llm_call: false,
    capture: 'transparent', proc: { pid: 2, exe: '/x/codex', agent: 'codex' }, req_headers: {}, req_body: { raw_chars: 0, verbatim: false },
    resp: { status: 200, kind: 'json', body: {} } }], conn);
  const c = (await rows(conn, "SELECT class, session_id, control_kind, lane FROM calls WHERE call_id='c1'"))[0];
  assert.deepEqual([c.class, c.session_id, c.control_kind, c.lane], ['control', null, 'other', null]);
  assert.equal(await countOf(conn, 'SELECT count(*) n FROM sessions'), 0);
});

test('envelope adapter: keys ∪ extra == record keys; WebSocket structure is consumed, incompleteness labels reach calls.extra', () => {
  const rec = { id: 'x', ts: 't', endpoint: '/e', method: 'GET', req_headers: {}, req_body: { raw_chars: 0, verbatim: false }, resp: {},
    is_llm_call: false, capture: 'transparent', transport: 'ws', ws_frames: [0, 1], ws_ext: null, ws_raw: [], partial: true,
    partial_reasons: ['off-window'], req_body_b64: 'AA==', req_extra_messages: [], ws_truncated: true, body_retention: 'verbatim',
    req_truncated: true, req_body_bytes: 4, req_partial: 'aborted', req_encoding_error: 'zstd', novel_x: 1 };
  const c = envelopeAdapter.parseCall(rec);
  // Invariant 4 (as #21 decided for req_*): a label that says "this record is incomplete" has no calls column,
  // so consuming it would erase it from the DuckDB row. It stays in extra.
  assert.deepEqual(Object.keys(c.extra).sort(), ['novel_x', 'partial', 'partial_reasons', 'req_body_bytes', 'req_encoding_error', 'req_partial', 'req_truncated', 'ws_truncated']);
  assert.equal(c.unmapped_count, 8);
  for (const k of Object.keys(rec)) assert.ok(ENVELOPE_CONSUMED.has(k) !== (k in c.extra), `${k}: consumed xor extra`);
});
