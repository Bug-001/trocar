// test/dissect/asight-added.test.mjs — a call whose response head asight added a line to (1.6 §1.3 `Connection: close`, 4.6 §记录
// asight_added; invariant 4) is labelled in place on every read path: the dissect label, the board's baked wire facts, and the
// data layer (DuckDB keeps the field in calls.extra, it is not a consumed envelope key).
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLabelsOf } from '../../src/dissect/capture-labels.mjs';
import { assembleSession } from '../../src/view/assemble.mjs';
import { ENVELOPE_CONSUMED } from '../../src/adapters/envelope.mjs';
import { runEtl } from '../../src/etl/orchestrator.mjs';
import { freshConn } from '../etl/helpers.mjs';

const stream = (r) => (Object.defineProperty(r, '_stream', { value: 'c.ndjson', enumerable: false }), r);
const call = (extra = {}) => stream({ id: 'ca1', ts_request: '2026-10-07T00:00:00Z', is_llm_call: true, endpoint: '/v1/messages', capture: 'transparent', host: 'api.anthropic.com',
  proc: { pid: 1, exe: '/x', agent: 'claude-code' }, req_headers: { 'x-claude-code-session-id': 'S1' }, req_body: '{"model":"m","messages":[{"role":"user","content":"q"}]}',
  req_head_raw: 'POST /v1/messages HTTP/1.1\r\n\r\n', resp_head_raw: 'HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n', body_wire_bytes: { req: 60, resp: 40 }, resp: { status: 200, kind: 'json', body: { usage: { input_tokens: 1, output_tokens: 1 } } }, ...extra });
// body_wire_bytes: what a record from D40 on carries; without it (and without resp.raw) a JSON reply reads as the pre-D40 re-serialized kind and gets its own label (4.1 保真边界 ⑤), which this file's fixture is not about

test('captureLabelsOf: asight_added connection-close is labelled 「asight 加的」, naming the line and saying the body and resp_head_raw are the upstream\'s', () => {
  const l = captureLabelsOf(call({ asight_added: ['connection-close'] })).filter((x) => x.id === 'asight-added');
  assert.equal(l.length, 1);
  assert.equal(l[0].label, 'asight 加的 · Connection: close');
  assert.equal(l[0].text, 'asight added the hop-by-hop header Connection: close to this response when capture was turned off; the response body is byte for byte what the upstream sent, and resp_head_raw is the upstream head');
})

test('captureLabelsOf: no label without asight_added, for an empty list, or for a thing it does not know; it says each thing once', () => {
  for (const r of [call(), call({ asight_added: [] }), call({ asight_added: ['something-else'] }), null, {}]) assert.deepEqual(captureLabelsOf(r).filter((x) => x.id === 'asight-added'), [], JSON.stringify(r && r.asight_added));
  assert.equal(captureLabelsOf(call({ asight_added: ['connection-close', 'connection-close'] })).filter((x) => x.id === 'asight-added').length, 1);
})

test('the board bakes the label on the call (wire.labels), beside the others; the call is otherwise complete', () => {
  const c = assembleSession([call({ asight_added: ['connection-close'], resp: { status: 200, kind: 'json', truncated: true, body_bytes: 40, body: {} } })]).steps[0];
  assert.deepEqual(c.wire.labels.map((l) => l.id).sort(), ['asight-added', 'resp-truncated']);
  assert.equal(c.wire.contextState, 'complete', 'a header line added to the response says nothing about the context');
  assert.deepEqual(assembleSession([call()]).steps[0].wire.labels, []);
})

test('the data layer keeps it: asight_added is not a consumed envelope key, so DuckDB lands it in calls.extra (invariant 4)', async () => {
  assert.equal(ENVELOPE_CONSUMED.has('asight_added'), false);
  const conn = await freshConn();
  await runEtl([call({ asight_added: ['connection-close'] })], conn);
  const row = (await conn.runAndReadAll('SELECT extra FROM calls')).getRowObjects()[0];
  assert.deepEqual(JSON.parse(row.extra).asight_added, ['connection-close']);
})
