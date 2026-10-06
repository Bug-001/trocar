// test/view/board-compaction.test.mjs — 3.4 compaction on the board, by the ETL's verdict (compactionVerdict): a harness
// hint first (high), a text marker on its rising edge (medium), then a drop. 1.3:5 / 1.3:37: the board shows
// calls.compaction. Before, the Anthropic path ignored the hint and the OpenAI-wire lanes never showed a compaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSession } from '../../src/view/assemble.mjs';
import { runEtl } from '../../src/etl/orchestrator.mjs';
import { freshConn } from '../etl/helpers.mjs';

const stream = (r) => (Object.defineProperty(r, '_stream', { value: 'c.ndjson', enumerable: false }), r);
const ts = (sec) => `2026-10-06T00:00:${String(sec).padStart(2, '0')}Z`;
const msgs = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: 'm' + i }] }));
const dsh = (id, n, sec, h = {}) => stream({ id, ts_request: ts(sec), endpoint: '/anthropic/v1/messages', method: 'POST', is_llm_call: true,
  capture: 'transparent', host: 'api.deepseek.com', proc: { pid: 1, exe: '/x/dsh', agent: 'dsh' }, req_headers: { 'x-deepseek-harness-session-id': 'S', ...h },
  req_body: JSON.stringify({ model: 'deepseek-v4', system: [{ type: 'text', text: 's' }], messages: msgs(n) }),
  resp: { kind: 'sse', status: 200, usage: { input_tokens: 1, output_tokens: 1 } } });
const cx = (id, n, sec, kind, text = 'u') => stream({ id, ts_request: ts(sec), endpoint: '/v1/responses', method: 'POST', is_llm_call: true,
  capture: 'transparent', host: 'api.openai.com', proc: { pid: 1, exe: '/x/codex', agent: 'codex' },
  req_headers: { 'session-id': 'X', ...(kind ? { 'x-codex-turn-metadata': JSON.stringify({ request_kind: kind }) } : {}) },
  req_body: JSON.stringify({ model: 'gpt-5', input: Array.from({ length: n }, (_, i) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: text + i }] })) }),
  resp: { kind: 'sse', status: 200, raw_sse: [{ type: 'response.completed', response: { id: 'r' + id, status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1 } } }] } });
const M = '[CONTEXT COMPACTION — REFERENCE ONLY] summary';
const hermes = (id, sec, first, n) => stream({ id, ts_request: ts(sec), endpoint: '/v1/chat/completions', method: 'POST', is_llm_call: true, capture: 'transparent',
  host: 'openrouter.ai', proc: { pid: 1, exe: '/x/hermes', agent: 'hermes' }, req_headers: {},
  req_body: JSON.stringify({ model: 'm', session_id: 'HS', messages: [{ role: 'system', content: 's' }, { role: 'user', content: first }, ...Array.from({ length: n }, (_, i) => ({ role: 'user', content: 'q' + i }))] }),
  resp: { kind: 'sse', status: 200, raw_sse: [] } });

const sessions = {
  dsh: () => [dsh('d1', 3, 1), dsh('d2', 5, 2, { 'x-deepseek-harness-compact': '1' }), dsh('d3', 7, 3)],
  codex: () => [cx('x1', 9, 1), cx('x2', 9, 2, 'compaction'), cx('x3', 11, 3), cx('x4', 2, 4, null, 'summary')], // x4: a big drop 11 → 2, history rewritten
  hermes: () => [hermes('h1', 1, 'q', 1), hermes('h2', 2, M, 1), hermes('h3', 3, M, 2)],
  // a hinted compaction on a lane's first call has no predecessor to have come from
  first: () => [dsh('f1', 3, 1, { 'x-deepseek-harness-compact': '1' })],
};

test('the board shows the compactions DuckDB writes: hint, rising marker, big drop, on both assembly paths', async () => {
  for (const [name, make] of Object.entries(sessions)) {
    const conn = await freshConn();
    await runEtl(make(), conn);
    const db = (await conn.runAndReadAll('SELECT call_id, compaction, compaction_from, compaction_to FROM calls ORDER BY call_id')).getRowObjects();
    const A = assembleSession(make());
    const by = Object.fromEntries(A.steps.map((s) => [s.id, s]));
    for (const r of db) {
      const s = by[r.call_id];
      assert.equal(s.compaction, r.compaction, `${name} ${r.call_id}: compaction`);
      if (r.compaction) assert.deepEqual([s.evictedFrom ?? null, s.evictedTo], [r.compaction_from, r.compaction_to], `${name} ${r.call_id}: from → to`);
    }
    assert.equal(A.stats.compactions, db.filter((r) => r.compaction).length, `${name}: stats.compactions`);
  }
});

test('a header hint is confirmed (high); a marker or a drop is inferred (medium); events carry the same marker', () => {
  const d2 = assembleSession(sessions.dsh()).steps[1];
  assert.deepEqual([d2.compactionInferred, d2.compactionConfidence, d2.compactionBasis], [false, 'high', 'harness-header']);
  const cA = assembleSession(sessions.codex());
  const [x2, x4] = [cA.steps[1], cA.steps[3]];
  assert.deepEqual([x2.compactionInferred, x2.compactionConfidence, x2.compactionBasis], [false, 'high', 'harness-header']);
  assert.deepEqual([x4.compactionInferred, x4.compactionConfidence, x4.compactionBasis], [true, 'medium', 'msg-count-drop']);
  const ev = cA.lanes[0].events.filter((e) => e.type === 'compaction');
  assert.deepEqual(ev.map((e) => [e.step, e.from, e.to, e.inferred]), [[1, 9, 9, false], [3, 11, 2, true]]);
  const h2 = assembleSession(sessions.hermes()).steps[1];
  assert.deepEqual([h2.compactionInferred, h2.compactionConfidence, h2.compactionBasis], [true, 'medium', 'harness-marker']);
  const f1 = assembleSession(sessions.first()).steps[0];
  assert.deepEqual([f1.compaction, f1.evictedFrom, f1.evictedTo], [true, null, 3], 'no invented "from 0"');
});

test('a compaction call names compaction as its cache-break cause on a flat lane', () => {
  const x4 = assembleSession(sessions.codex()).steps[3];
  assert.equal(x4.cacheBreak.cause, 'compaction');
});
