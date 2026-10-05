// 3.4 关键区分 / 4.6 R3 (read half): board sessions by the harness's session key, never by pid; the
// board's harness comes from proc.agent (D37 ①), not the UA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSessions, projectsView } from '../../src/view/board.mjs';
import { observerEffectsOf } from '../../src/dissect/harnesses.mjs';
import { buildTransparentEnvelope } from '../../src/collector/core/record/envelope.mjs';

const codex = (id, sid, pid) => ({
  id, ts_request: `2026-10-06T00:00:0${id.slice(-1)}.000Z`, endpoint: '/v1/responses', method: 'POST',
  is_llm_call: true, capture: 'transparent', proc: { pid, exe: '/usr/bin/codex', agent: 'codex' },
  req_headers: { 'session-id': sid }, req_body: JSON.stringify({ model: 'gpt-x', input: [] }),
  resp: { kind: 'sse', status: 200 },
});
const only = (recs) => projectsView(recs).projects.flatMap((p) => p.sessions);

test('one pid, two Codex sessions → two board sessions; one session across two pids → one', () => {
  const g = groupSessions([codex('r1', 'A', 7), codex('r2', 'B', 7), codex('r3', 'A', 8)]);
  assert.deepEqual([...g.keys()].sort(), ['A', 'B']);
  assert.deepEqual(g.get('A').map((r) => r.id), ['r1', 'r3']);
});

test('a proc-identified dsh session lists with harness dsh, not inferred', () => {
  const r = { ...codex('r1', 'x', 1), proc: { pid: 1, exe: '/x/dsh', agent: 'dsh' }, endpoint: '/anthropic/v1/messages',
    req_headers: { 'x-deepseek-harness-session-id': 'D1' }, req_body: JSON.stringify({ model: 'deepseek-chat', messages: [] }) };
  const [s] = only([r]);
  assert.deepEqual([s.session_id, s.harness, s.harness_inferred], ['D1', 'dsh', false]);
});

test('a record with proc decides the harness even when an earlier record had only a UA', () => {
  const ua = { ...codex('r1', 'S', 1), req_headers: { 'session-id': 'S', 'user-agent': 'codex_cli_rs/0.20' } };
  delete ua.proc;
  const [s] = only([ua, codex('r2', 'S', 2)]);
  assert.deepEqual([s.harness, s.harness_inferred, s.provider], ['codex', false, 'openai']);
  const [legacy] = only([ua]);
  assert.deepEqual([legacy.harness, legacy.harness_inferred], ['codex', true]);
});

test("the collector's own envelope (proc.agent spelled as it writes it) lists as cc, not inferred (gate G2)", () => {
  const head = (raw, extra) => ({ raw: Buffer.from(raw, 'latin1'), startLine: raw.split('\r\n')[0], ...extra });
  const env = buildTransparentEnvelope({ id: 'c1', seq: 0, error: null,
    flow: { id: 'f1', host: 'api.anthropic.com', scheme: 'https', dst: { address: '10.0.0.9', port: 443 }, proc: { pid: 9, exe: '/usr/bin/claude', agent: 'claude-code' } },
    req: { head: head('POST /v1/messages?beta=true HTTP/1.1\r\n\r\n', { method: 'POST', target: '/v1/messages?beta=true',
      headers: [['X-Claude-Code-Session-Id', 'S9'], ['User-Agent', 'claude-cli/2.1 (external, cli)']] }), body: Buffer.from('{"model":"m","messages":[]}'), truncated: false, tsStart: '2026-10-06T00:00:00.000Z' },
    resp: { head: head('HTTP/1.1 200 OK\r\n\r\n', { status: 200, headers: [['Content-Type', 'application/json']] }), body: Buffer.from('{}'), truncated: false, tsStart: '2026-10-06T00:00:01.000Z', tsEnd: '2026-10-06T00:00:02.000Z' } });
  const [s] = only([env]);
  assert.deepEqual([s.session_id, s.harness, s.harness_inferred, s.provider], ['S9', 'cc', false, 'anthropic']);
  assert.deepEqual(observerEffectsOf(env).map((e) => e.id), ['cc-gzip-off'], 'D37 ⑤: a transparent CC call carries its observer effect');
});
