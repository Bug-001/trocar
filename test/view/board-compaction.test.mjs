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

// 3.4: CC's "continued from a previous conversation" preamble stays in the first
// messages of every call after a compaction, so it is evidence on its rising edge only. A D10 (req_body) CC lane whose
// compaction is too small to be a sharp drop (8 → 3: not below 8 − 5) is a compaction only through the preamble; the
// one-message dip that follows (8 → 7, the preamble carried) is not. DuckDB and the board give the same answer, and the
// board says the preamble was the evidence only where it was.
const PREAMBLE = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\nearlier work.';
const cc = (id, n, sec, preamble) => stream({ id, ts_request: ts(sec), endpoint: '/v1/messages', method: 'POST', is_llm_call: true, capture: 'transparent',
  host: 'api.anthropic.com', proc: { pid: 1, exe: '/x/claude', agent: 'claude-code' }, req_headers: { 'x-claude-code-session-id': 'CCS', 'user-agent': 'claude-cli/2' },
  req_body: JSON.stringify({ model: 'claude-opus-4-8', system: [{ type: 'text', text: 's' }],
    messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: i === 0 && preamble ? PREAMBLE : 'm' + i }] })) }),
  resp: { kind: 'sse', status: 200, usage: { input_tokens: 1, output_tokens: 1 } } });

test('a CC lane that carries the preamble after its compaction: the preamble is evidence once, on DuckDB and on the board', async () => {
  const make = () => [cc('p1', 3, 1, false), cc('p2', 8, 2, false), cc('p3', 3, 3, true), cc('p4', 8, 4, true), cc('p5', 7, 5, true)];
  const conn = await freshConn();
  await runEtl(make(), conn);
  const db = (await conn.runAndReadAll('SELECT call_id, compaction, compaction_from, compaction_to FROM calls ORDER BY call_id')).getRowObjects();
  assert.deepEqual(db.filter((r) => r.compaction).map((r) => [r.call_id, Number(r.compaction_from), Number(r.compaction_to)]), [['p3', 8, 3]], 'DuckDB: 8 → 3 brings the preamble in; 8 → 7 carries it');
  const A = assembleSession(make());
  assert.deepEqual(A.steps.filter((s) => s.compaction).map((s) => [s.id, s.evictedFrom, s.evictedTo, s.compactionBasis]), [['p3', 8, 3, 'preamble+msg-count-drop']], 'the board agrees, and names the preamble where it was the evidence');
  assert.equal(A.stats.compactions, 1);
  // a second, sharp compaction on the same lane needs no preamble: it is a bare drop, and the board does not credit the carried preamble
  const more = () => [...make(), cc('p6', 30, 6, true), cc('p7', 4, 7, true)];
  const conn2 = await freshConn();
  await runEtl(more(), conn2);
  const db2 = (await conn2.runAndReadAll('SELECT call_id, compaction_from, compaction_to FROM calls WHERE compaction ORDER BY call_id')).getRowObjects();
  assert.deepEqual(db2.map((r) => [r.call_id, Number(r.compaction_from), Number(r.compaction_to)]), [['p3', 8, 3], ['p7', 30, 4]]);
  assert.deepEqual(assembleSession(more()).steps.filter((s) => s.compaction).map((s) => [s.id, s.compactionBasis]), [['p3', 'preamble+msg-count-drop'], ['p7', 'msg-count-drop']]);
});
