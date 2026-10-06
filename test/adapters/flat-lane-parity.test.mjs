// test/adapters/flat-lane-parity.test.mjs — on the OpenAI wires the ETL and the board put a call in the SAME lane:
// the dissector's own lane, else the harness table's hint, else main (3.4 lane rule; gate G15: no hint → main).
// Claude Code's heuristics (a haiku model with ≤ 2 messages → aux, the security-monitor / cc_is_subagent system
// markers) are Anthropic-wire rules and are not applied to these wires.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runEtl } from '../../src/etl/orchestrator.mjs';
import { assembleSession } from '../../src/view/assemble.mjs';
import { freshConn } from '../etl/helpers.mjs';

const rec = (id, agent, endpoint, body, headers, sec) => ({ id, ts_request: `2026-10-06T00:00:0${sec}Z`, endpoint, method: 'POST', is_llm_call: true,
  capture: 'transparent', host: 'openrouter.ai', proc: { pid: 1, exe: '/x', agent }, req_headers: headers, req_body: JSON.stringify(body),
  resp: { status: 200, kind: 'sse', raw: '' } });
const RECORDS = [
  // OpenCode on a small Anthropic model through OpenRouter: Responses (no `messages` key) and Chat (one message)
  rec('r1', 'opencode', '/api/v1/responses', { model: 'anthropic/claude-haiku-4.5', input: [{ role: 'user', content: 'hi' }] }, { 'x-opencode-session-id': 'S' }, 1),
  rec('c1', 'opencode', '/api/v1/chat/completions', { model: 'anthropic/claude-haiku-4.5', messages: [{ role: 'user', content: 'hi' }] }, { 'x-opencode-session-id': 'S' }, 2),
  // two messages, still a small model: not an "aux util call" on this wire
  rec('c2', 'opencode', '/api/v1/chat/completions', { model: 'anthropic/claude-haiku-4.5', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'x' }] }, { 'x-opencode-session-id': 'S' }, 3),
  // a harness hint still decides (Codex marks its subagents with a header)
  rec('x1', 'codex', '/v1/responses', { model: 'gpt-5', input: [{ role: 'user', content: 'go' }] }, { 'session-id': 'X', 'x-openai-subagent': 'review' }, 4),
];

test('ETL lanes on the OpenAI wires equal the board\'s', async () => {
  const conn = await freshConn();
  await runEtl(RECORDS, conn);
  const etl = Object.fromEntries((await conn.runAndReadAll('SELECT call_id, lane FROM calls')).getRowObjects().map((r) => [r.call_id, r.lane]));
  assert.deepEqual(etl, { r1: 'main', c1: 'main', c2: 'main', x1: 'subagent' });
  for (const sid of ['S', 'X']) {
    const steps = assembleSession(RECORDS.filter((r) => (r.req_headers['x-opencode-session-id'] || r.req_headers['session-id']) === sid)).steps;
    for (const s of steps) assert.equal(s.streamId, etl[s.id], `${s.id}: board lane == ETL lane`);
  }
});
