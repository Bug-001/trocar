// test/view/anthropic-lane-hints.test.mjs — 3.4 lane precedence on the board's Anthropic-wire path (analyze()): inside
// each tier the harness table's hint decides first, as in the ETL (session-identity.mjs::lane). Z-Code and dsh default
// to the Anthropic wire (3.1:35, D37), so splitting there must not depend on Claude Code's cc_is_subagent marker alone.
// 1.3:5: board lanes come from calls.lane — checked per call against DuckDB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSession } from '../../src/view/assemble.mjs';
import { runEtl } from '../../src/etl/orchestrator.mjs';
import { freshConn } from '../etl/helpers.mjs';

const stream = (r) => (Object.defineProperty(r, '_stream', { value: 'c.ndjson', enumerable: false }), r);
const msgs = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: 'm' + i }] }));
const rec = (id, agent, headers, n, sec, { body = {}, host = 'open.bigmodel.cn', endpoint = '/api/anthropic/v1/messages', model = 'glm-4.6' } = {}) => stream({
  id, ts_request: `2026-10-06T00:00:${String(sec).padStart(2, '0')}Z`, endpoint, method: 'POST', is_llm_call: true,
  capture: 'transparent', host, proc: { pid: 1, exe: '/x/' + agent, agent }, req_headers: headers,
  req_body: JSON.stringify({ model, system: [{ type: 'text', text: 'You are an agent.' }], tools: [{ name: 't', input_schema: { type: 'object' } }], messages: msgs(n), ...body }),
  resp: { kind: 'sse', status: 200, usage: { input_tokens: 10, output_tokens: 1 } } });

const Z = (id, type, n, sec) => rec(id, 'z-code', { 'x-session-id': 'Z', 'x-zcode-session-type': type }, n, sec);
const zcode = () => [Z('z1', 'main', 3, 1), Z('z2', 'subagent', 5, 2), Z('z3', 'main', 5, 3)];
const cc = () => [
  rec('c1', 'claude-code', { 'x-claude-code-session-id': 'C' }, 3, 4, { host: 'api.anthropic.com', endpoint: '/v1/messages', model: 'claude-x' }),
  // the agent-id header, no cc_is_subagent marker in the system prompt
  rec('c2', 'claude-code', { 'x-claude-code-session-id': 'C', 'x-claude-code-agent-id': 'agent-7' }, 5, 5, { host: 'api.anthropic.com', endpoint: '/v1/messages', model: 'claude-x' }),
];
const D = (id, n, sec, body = {}) => rec(id, 'dsh', { 'x-deepseek-harness-session-id': 'D' }, n, sec, { host: 'api.deepseek.com', endpoint: '/anthropic/v1/messages', model: 'deepseek-chat', body });
const dsh = () => [D('d1', 3, 6), D('d2', 3, 7, { dsh_session_log: { session: { origin: 'subagent' } } })];
// a request-kind warm-up (the probe tier's hint) reaching the Anthropic wire
const warm = () => [rec('w1', 'codex', { 'session-id': 'W', 'x-codex-turn-metadata': JSON.stringify({ request_kind: 'prewarm' }) }, 3, 8,
  { host: 'api.anthropic.com', endpoint: '/v1/messages', model: 'claude-x' })];

const boardLanes = (recs) => {
  const A = assembleSession(recs);
  const kind = new Map(A.lanes.map((l) => [l.streamId, l.kind]));
  return { A, by: Object.fromEntries(A.steps.map((s) => [s.id, kind.get(s.streamId)])) };
};

test('a harness lane hint splits Anthropic-wire calls on the board: Z-Code session type, CC agent-id, dsh origin, a warm-up', () => {
  assert.deepEqual(boardLanes(zcode()).by, { z1: 'main', z2: 'subagent', z3: 'main' });
  assert.deepEqual(boardLanes(cc()).by, { c1: 'main', c2: 'subagent' });
  assert.deepEqual(boardLanes(dsh()).by, { d1: 'main', d2: 'subagent' });
  const { A, by } = boardLanes(warm());
  assert.deepEqual(by, { w1: 'probe' });
  assert.match(A.lanes[0].note, /warm-up or probe/, 'the lane says what it is (the page shows lane.note)');
});

test('board lane == calls.lane for every call (1.3:5)', async () => {
  const all = [...zcode(), ...cc(), ...dsh(), ...warm()];
  const conn = await freshConn();
  await runEtl(all.map((r) => stream({ ...r })), conn);
  const db = Object.fromEntries((await conn.runAndReadAll('SELECT call_id, lane FROM calls')).getRowObjects().map((r) => [r.call_id, r.lane]));
  for (const group of [zcode(), cc(), dsh(), warm()]) {
    for (const [id, lane] of Object.entries(boardLanes(group).by)) assert.equal(lane, db[id], `${id}: board ${lane}, DuckDB ${db[id]}`);
  }
});

test("the cache baseline follows the lane: z3 is diffed against z1, not against the subagent's z2", () => {
  const steps = assembleSession(zcode()).steps;
  const alone = assembleSession([Z('z1', 'main', 3, 1), Z('z3', 'main', 5, 3)]).steps[1];
  assert.equal(steps[2].cacheBreak.idx, alone.cacheBreak.idx);
  assert.equal(steps[2].prefixSha256, alone.prefixSha256);
});
