// test/etl/d37-columns.test.mjs — the D37 call columns at DB level (3.2:28-29, 3.2:49-53, 3.2:124) and
// 4.6 R5 (observer effects only on transparent captures).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runEtl } from '../../src/etl/orchestrator.mjs';
import { freshConn } from './helpers.mjs';

const body = (text) => JSON.stringify({ model: 'claude-x', system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
const cc = (id, extra = {}) => ({
  id, ts_request: `2026-10-06T00:00:0${id.slice(-1)}.000Z`, endpoint: '/v1/messages', method: 'POST', is_llm_call: true,
  req_headers: { 'x-claude-code-session-id': 'S', 'user-agent': 'claude-cli/2.1' }, req_body: body(id),
  resp: { kind: 'sse', status: 200, usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } },
  ...extra,
});
// what the collector appends to a transparent capture (4.6 §记录)
const transparent = { capture: 'transparent', host: 'api.anthropic.com', proc: { pid: 3, exe: '/x/claude', agent: 'claude-code' } };
const rows = async (conn, sql) => (await conn.runAndReadAll(sql)).getRowObjects();

test('calls carry wire_format, vendor, transport, context_state, observer_effect', async () => {
  const conn = await freshConn();
  await runEtl([cc('t1', transparent), cc('t2', { ...transparent, host: 'relay.example.com' })], conn);
  const r = await rows(conn, 'SELECT call_id, wire_format, vendor, transport, context_state FROM calls ORDER BY call_id');
  assert.deepEqual(r.map((x) => [x.call_id, x.wire_format, x.vendor, x.transport, x.context_state]),
    [['t1', 'anthropic', 'anthropic', 'http', 'complete'], ['t2', 'anthropic', null, 'http', 'complete']]);
  const ce = await rows(conn, 'SELECT call_id, break_kind, cache_write_billing, extra FROM cache_events ORDER BY call_id');
  assert.deepEqual([ce[0].break_kind, ce[0].cache_write_billing], ['explicit-breakpoint', 'charged']);
  assert.deepEqual([ce[1].break_kind, ce[1].cache_write_billing], [null, null], 'a relay host is not a vendor: no borrowed labels');
  assert.equal(JSON.parse(ce[1].extra).vendor_cache_semantics, 'unknown');
  assert.ok(!('vendor' in JSON.parse((await rows(conn, "SELECT extra FROM calls WHERE call_id='t1'"))[0].extra)), 'vendor is a column, never extra (3.2:131)');
});

test('a request stored incomplete is context_state=partial with NULL cache facts; its labels stay in calls.extra (G17)', async () => {
  const conn = await freshConn();
  await runEtl([cc('t1', transparent), cc('t2', { ...transparent, req_truncated: true, req_body_bytes: 64, req_partial: 'aborted' })], conn);
  const r = await rows(conn, 'SELECT c.call_id, c.context_state, c.extra, e.prefix_sha256, e.ground_truth_flag FROM calls c LEFT JOIN cache_events e USING (call_id) ORDER BY c.call_id');
  assert.equal(r[0].context_state, 'complete');
  assert.deepEqual([r[1].context_state, r[1].prefix_sha256 ?? null, r[1].ground_truth_flag ?? null], ['partial', null, null]);
  const ex = JSON.parse(r[1].extra);
  assert.deepEqual([ex.req_truncated, ex.req_body_bytes, ex.req_partial], [true, 64, 'aborted'], 'the why stays with the row (#21)');
});

test('a server-edited response is context_state=server_edited with a NULL prefix hash (3.2:52, 3.2:124)', async () => {
  const conn = await freshConn();
  const edited = { kind: 'json', status: 200, body: { context_management: { applied_edits: [{ type: 'clear_tool_uses_20250919' }] }, usage: { input_tokens: 5, output_tokens: 1 } } };
  await runEtl([cc('t1', transparent), cc('t2', { ...transparent, resp: edited })], conn);
  const r = await rows(conn, "SELECT c.context_state, e.prefix_sha256 FROM calls c JOIN cache_events e USING (call_id) WHERE call_id='t2'");
  assert.deepEqual([r[0].context_state, r[0].prefix_sha256], ['server_edited', null]);
});

test('observer_effect: transparent CC calls carry it; a legacy capture of the same harness does not (R5)', async () => {
  const conn = await freshConn();
  await runEtl([cc('t1', transparent), cc('l2', { capture: 'mitm', req_headers: { 'x-claude-code-session-id': 'S', 'user-agent': 'claude-cli/2.1', host: 'api.anthropic.com' } })], conn);
  const r = await rows(conn, 'SELECT call_id, vendor, observer_effect FROM calls ORDER BY call_id');
  assert.equal(r.find((x) => x.call_id === 'l2').observer_effect, null);
  assert.equal(r.find((x) => x.call_id === 'l2').vendor, 'anthropic', 'a legacy MITM envelope keeps its real Host header');
  assert.deepEqual(JSON.parse(r.find((x) => x.call_id === 't1').observer_effect).map((e) => e.id), ['cc-gzip-off']);
});

test('sessions.harness is the proc identity; legacy rows say harness_inferred; provider is the main-lane wire summary', async () => {
  const conn = await freshConn();
  await runEtl([cc('t1', { ...transparent, proc: { pid: 3, exe: '/x/dsh', agent: 'deepseek-dsh' }, req_headers: { 'x-claude-code-session-id': 'S', 'user-agent': 'claude-cli/2.1' } })], conn);
  let s = (await rows(conn, 'SELECT harness, provider, extra FROM sessions'))[0];
  assert.deepEqual([s.harness, s.provider, JSON.parse(s.extra).harness_inferred], ['dsh', 'anthropic', undefined], 'proc wins over a Claude UA');
  const conn2 = await freshConn();
  await runEtl([cc('l1')], conn2);
  s = (await rows(conn2, 'SELECT harness, extra FROM sessions'))[0];
  assert.deepEqual([s.harness, JSON.parse(s.extra).harness_inferred], ['cc', true]);
});

test('request_bytes of a metadata-only body is its raw_chars, not the size of the metadata JSON', async () => {
  const conn = await freshConn();
  await runEtl([{ id: 'p1', ts_request: '2026-10-06T00:00:01Z', endpoint: '/v1/messages/count_tokens', is_llm_call: false,
    req_headers: { 'x-claude-code-session-id': 'S', 'user-agent': 'claude-cli/2' }, req_body: { raw_chars: 12345, verbatim: false },
    resp: { kind: 'json', status: 200, body: { input_tokens: 9 } } }], conn);
  const [c] = await rows(conn, "SELECT request_bytes, wire_format, context_state, transport FROM calls WHERE call_id='p1'");
  assert.deepEqual([Number(c.request_bytes), c.wire_format, c.context_state, c.transport], [12345, null, null, 'http'], 'a probe is not an inference call: no wire, no context');
});
