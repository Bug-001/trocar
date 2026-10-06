// test/etl/lineage-hints.test.mjs — RFC 3.4 #2b / #3 / #4 and the seven-key grouping, written into DuckDB
// through the harness table (src/dissect/harnesses.mjs): parents, compaction and session keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runEtl, rebuild } from '../../src/etl/orchestrator.mjs';
import { freshConn, dumpAll } from './helpers.mjs';

const rows = async (conn, sql) => (await conn.runAndReadAll(sql)).getRowObjects();
const msgs = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: 'm' + i }] }));
const anth = ({ id, agent, headers, n = 1, body = {}, pid = 1, sec }) => ({
  id, ts_request: `2026-10-06T00:00:${String(sec).padStart(2, '0')}Z`, endpoint: '/anthropic/v1/messages', method: 'POST', is_llm_call: true,
  capture: 'transparent', host: 'api.deepseek.com', proc: { pid, exe: '/x/' + agent, agent }, req_headers: headers,
  req_body: JSON.stringify({ model: 'm', system: [{ type: 'text', text: 's' }], messages: msgs(n), ...body }),
  resp: { kind: 'sse', status: 200, usage: { input_tokens: 1, output_tokens: 1 } },
});
const D = (sid, extra = {}) => ({ 'x-deepseek-harness-session-id': sid, ...extra });

test('compaction lands in calls.compaction from a header hint and from a message-count drop', async () => {
  const conn = await freshConn();
  await runEtl([
    anth({ id: 'a1', agent: 'dsh', headers: D('S'), n: 3, sec: 1 }),
    anth({ id: 'a2', agent: 'dsh', headers: D('S', { 'x-deepseek-harness-compact': '1' }), n: 5, sec: 2 }), // header, no drop
    anth({ id: 'a3', agent: 'dsh', headers: D('S'), n: 2, sec: 3 }),                                       // drop 5 → 2, no header
  ], conn);
  const r = await rows(conn, 'SELECT call_id, compaction, compaction_from, compaction_to FROM calls ORDER BY call_id');
  assert.deepEqual(r.map((x) => [x.call_id, x.compaction]), [['a1', false], ['a2', true], ['a3', true]]);
  assert.deepEqual([r[1].compaction_from, r[1].compaction_to], [3, 5], 'a hinted compaction says from → to as well');
  assert.deepEqual([r[2].compaction_from, r[2].compaction_to], [5, 2]);
});

test('a text compaction marker counts on its rising edge only (it stays in the history afterwards)', async () => {
  const conn = await freshConn();
  const H = (id, sec, text, n) => ({ ...anth({ id, agent: 'hermes', headers: {}, n, sec, body: { session_id: 'HS' } }),
    req_body: JSON.stringify({ model: 'm', session_id: 'HS', messages: [...msgs(n - 1), { role: 'user', content: text }] }) });
  const M = '[CONTEXT COMPACTION — REFERENCE ONLY] summary';
  await runEtl([H('h1', 1, 'q', 4), H('h2', 2, M, 5), H('h3', 3, M + ' more', 6)], conn);
  const r = await rows(conn, 'SELECT call_id, compaction FROM calls ORDER BY call_id');
  assert.deepEqual(r.map((x) => [x.call_id, x.compaction]), [['h1', false], ['h2', true], ['h3', false]]);
});

test('a compaction never sets sessions.fork_of_session_id', async () => {
  const conn = await freshConn();
  await runEtl([anth({ id: 'a1', agent: 'dsh', headers: D('S'), n: 6, sec: 1 }), anth({ id: 'a2', agent: 'dsh', headers: D('S'), n: 2, sec: 2 })], conn);
  assert.equal((await rows(conn, "SELECT compaction FROM calls WHERE call_id='a2'"))[0].compaction, true, 'precondition: a compaction happened');
  assert.equal((await rows(conn, "SELECT fork_of_session_id FROM sessions WHERE session_id='S'"))[0].fork_of_session_id, null);
});

test('harness-declared parents are written: dsh body parentSession, OpenCode header', async () => {
  const conn = await freshConn();
  await runEtl([
    anth({ id: 'p1', agent: 'dsh', headers: D('PARENT'), sec: 1 }),
    anth({ id: 'c1', agent: 'dsh', headers: D('CHILD'), body: { dsh_session_log: { session: { parentSession: 'PARENT', origin: 'subagent' } } }, sec: 2 }),
    anth({ id: 'o1', agent: 'opencode', headers: { 'x-opencode-session-id': 'OC2', 'x-opencode-parent-session-id': 'OC1' }, sec: 3 }),
  ], conn);
  const s = await rows(conn, 'SELECT session_id, parent_session_id FROM sessions ORDER BY session_id');
  assert.deepEqual(s.map((x) => [x.session_id, x.parent_session_id]), [['CHILD', 'PARENT'], ['OC2', 'OC1'], ['PARENT', null]]);
  assert.equal((await rows(conn, "SELECT lane FROM calls WHERE call_id='c1'"))[0].lane, 'subagent');
});

test('a parent named by an alias key resolves to that session (gate G4); an unknown one is kept raw', async () => {
  const conn = await freshConn();
  // OpenCode's parent header names the parent's x-opencode-session-id; the parent here is keyed by it,
  // but a second key (session-id) differs and is an alias. A parent seen only by its alias resolves.
  await runEtl([
    anth({ id: 'p', agent: 'opencode', headers: { 'x-opencode-session-id': 'P-MAIN', 'session-id': 'P-ALIAS' }, sec: 1 }),
    anth({ id: 'c', agent: 'opencode', headers: { 'x-opencode-session-id': 'C', 'x-opencode-parent-session-id': 'P-ALIAS' }, sec: 2 }),
    anth({ id: 'o', agent: 'opencode', headers: { 'x-opencode-session-id': 'O', 'x-opencode-parent-session-id': 'NOT-CAPTURED' }, sec: 3 }),
  ], conn);
  const s = Object.fromEntries((await rows(conn, 'SELECT session_id, parent_session_id FROM sessions')).map((x) => [x.session_id, x.parent_session_id]));
  assert.equal(s.C, 'P-MAIN');
  assert.equal(s.O, 'NOT-CAPTURED', 'no alias matches: the harness\'s own parent id is stored (G4 default)');
});

test('ETL writes the CC 认亲 parent into sessions.parent_session_id', async () => {
  const conn = await freshConn();
  const cc = (id, sid, system, messages, sec) => ({ id, ts_request: `2026-10-06T00:01:0${sec}Z`, endpoint: '/v1/messages', is_llm_call: true,
    req_headers: { 'x-claude-code-session-id': sid, 'user-agent': 'claude-cli/2' },
    req_body: JSON.stringify({ model: 'claude-opus', system: [{ type: 'text', text: system }], messages }), resp: { kind: 'sse', status: 200, usage: {} } });
  const PROMPT = 'Investigate the failing parser test and report back';
  await runEtl([
    cc('m1', 'MAIN', 'You are Claude Code', [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Task', input: { prompt: PROMPT } }] }], 1),
    cc('s1', 'SUB', 'cc_is_subagent=true', [{ role: 'user', content: [{ type: 'text', text: PROMPT + '\n<system-reminder>env</system-reminder>' }] }], 2),
  ], conn);
  assert.equal((await rows(conn, "SELECT parent_session_id FROM sessions WHERE session_id='SUB'"))[0].parent_session_id, 'MAIN');
});

test('ETL: one pid serving two sessions writes two sessions (never split or joined by pid)', async () => {
  const conn = await freshConn();
  await runEtl([anth({ id: 'x1', agent: 'dsh', headers: D('A'), pid: 77, sec: 1 }), anth({ id: 'x2', agent: 'dsh', headers: D('B'), pid: 77, sec: 2 }),
    anth({ id: 'x3', agent: 'dsh', headers: D('A'), pid: 78, sec: 3 })], conn);
  assert.deepEqual((await rows(conn, 'SELECT session_id FROM sessions ORDER BY 1')).map((x) => x.session_id), ['A', 'B']);
  assert.deepEqual((await rows(conn, "SELECT call_id FROM calls WHERE session_id='A' ORDER BY 1")).map((x) => x.call_id), ['x1', 'x3']);
});

test('lineage and hinted compaction: incremental == full', async () => {
  const recs = [
    anth({ id: 'p1', agent: 'dsh', headers: D('PARENT'), n: 3, sec: 1 }),
    anth({ id: 'c1', agent: 'dsh', headers: D('CHILD'), body: { dsh_session_log: { session: { parentSession: 'PARENT', origin: 'subagent' } } }, sec: 2 }),
    anth({ id: 'p2', agent: 'dsh', headers: D('PARENT', { 'x-deepseek-harness-compact': '1' }), n: 4, sec: 3 }),
  ];
  const inc = await freshConn();
  await runEtl(recs.slice(0, 2), inc);
  await runEtl(recs, inc);
  const full = await freshConn();
  await rebuild(recs, full);
  assert.deepEqual(await dumpAll(inc), await dumpAll(full));
});
