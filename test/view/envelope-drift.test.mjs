import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionDoc } from '../helpers/session-doc.mjs';

// R1 · ENVELOPE DRIFT — the D10 capture writes `resp` / `req_headers`
// (src/capture/envelope.mjs:52), but the board still read the v0 names `response` /
// `request_headers`. Measured on the live capture: `.response` was present on 0 of 25,817 records.
// Everything downstream of those reads was therefore dead on EVERY real capture while looking fine
// on the pre-D10 fixture: the probe rail rendered empty while the picker advertised its count, and
// no HTTP status could ever reach the board (so a 401/502 could never render).
//
// These tests pin the D10 shape specifically, read through the `session` document (test/helpers/session-doc.mjs). The v0 shape is pinned alongside, because the board
// must keep reading BOTH — old captures on disk are still the user's data (invariant 2).

const d10Probe = (i, tokens) => ({
  id: `p${i}`, ts_request: `2026-07-19T00:00:0${i}.000Z`,
  endpoint: '/v1/messages/count_tokens', is_llm_call: false,
  req_headers: { 'x-claude-code-session-id': 'S' },
  req_body: '{}',
  resp: { status: 200, kind: 'json', body: { input_tokens: tokens } }, // D10: `resp`, not `response`
});

const d10Call = (i, status) => ({
  id: `c${i}`, ts_request: `2026-07-19T00:01:0${i}.000Z`,
  endpoint: '/v1/messages', is_llm_call: true,
  req_headers: { 'x-claude-code-session-id': 'S' },
  req_body: JSON.stringify({ model: 'claude-opus-4-8', system: [], messages: [], tools: [] }),
  resp: { status, kind: 'json', body: {} },
});

const v0Probe = (i, tokens) => ({
  id: `vp${i}`, ts_request: `2026-07-19T00:02:0${i}.000Z`,
  endpoint: '/v1/messages/count_tokens', is_llm_call: false,
  request_headers: { 'x-claude-code-session-id': 'S' },
  response: { status: 200, body: { input_tokens: tokens } }, // v0 shape
});

test('D10: the probe series is populated from `resp` (not silently empty)', async () => {
  const v = await sessionDoc([d10Probe(1, 1200), d10Probe(2, 3400), d10Call(1, 200)], 'S');
  assert.equal(v.probes.count, 2, 'both probes counted');
  assert.deepEqual(v.probes.series.map((p) => p.tokens), [1200, 3400], 'D10 probe token counts reach the board');
});

test('D10: HTTP status reaches the rows and the records (so an error call can render)', async () => {
  const v = await sessionDoc([d10Call(1, 200), d10Call(2, 401), d10Call(3, 502)], 'S');
  assert.deepEqual(v.calls.map((c) => c.status), [200, 401, 502]);
  assert.deepEqual(v.records.map((r) => r.response.status), [200, 401, 502]);
});

test('v0 captures keep working (invariant 2: old data on disk is still the user data)', async () => {
  const v = await sessionDoc([v0Probe(1, 999)], 'S');
  assert.equal(v.probes.count, 1);
  assert.deepEqual(v.probes.series.map((p) => p.tokens), [999]);
});

test('a record with no response yields a null status, not a crash', async () => {
  const bare = {
    id: 'x', ts_request: '2026-07-19T00:03:00.000Z', endpoint: '/v1/messages',
    req_headers: { 'x-claude-code-session-id': 'S' }, req_body: '{}',
  };
  const v = await sessionDoc([bare], 'S');
  assert.equal(v.records[0].response.status, null);
});
