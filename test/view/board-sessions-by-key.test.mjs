// 3.4 关键区分 / 4.6 R3 (read half): board sessions by the harness's session key, never by pid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSessions, sessionView } from '../../src/view/board.mjs';
import { buildTransparentEnvelope } from '../../src/collector/core/record/envelope.mjs';

const codex = (id, sid, pid) => ({
  id, ts_request: `2026-10-06T00:00:0${id.slice(-1)}.000Z`, endpoint: '/v1/responses', method: 'POST',
  is_llm_call: true, capture: 'transparent', proc: { pid, exe: '/usr/bin/codex', agent: 'codex' },
  req_headers: { 'session-id': sid }, req_body: JSON.stringify({ model: 'gpt-x', input: [] }),
  resp: { kind: 'sse', status: 200 },
});

test('one pid, two Codex sessions → two board sessions; one session across two pids → one', () => {
  const g = groupSessions([codex('r1', 'A', 7), codex('r2', 'B', 7), codex('r3', 'A', 8)]);
  assert.deepEqual([...g.keys()].sort(), ['A', 'B']);
  assert.deepEqual(g.get('A').map((r) => r.id), ['r1', 'r3']);
});

// the harness / provider facts of one session, through the product path (session.meta)
const metaFor = (recs, sid) => sessionView(recs, sid).meta;

test('a record with proc decides the harness even when an earlier record had only a UA', () => {
  const ua = { ...codex('r1', 'S', 1), req_headers: { 'session-id': 'S', 'user-agent': 'codex_cli_rs/0.20' } };
  delete ua.proc;
  const m = metaFor([ua, codex('r2', 'S', 2)], 'S');
  assert.deepEqual([m.harness, m.harness_inferred, m.provider], ['codex', false, 'openai']);
  const legacy = metaFor([ua], 'S');
  assert.deepEqual([legacy.harness, legacy.harness_inferred], ['codex', true]);
});

test("the provider is read from the wire, and an unknown wire gives null, never a guess", () => {
  const oc = (endpoint) => ({ ...codex('r1', 'O', 1), endpoint, proc: { pid: 1, exe: '/x/opencode', agent: 'opencode' } });
  for (const [endpoint, provider] of [['/v1/messages', 'anthropic'], ['/v1/responses', 'openai'], ['/some/unknown/route', null]]) {
    const m = metaFor([oc(endpoint)], 'O');
    assert.deepEqual([m.harness, m.provider], ['opencode', provider], endpoint);
  }
});

test("the collector's own envelope lists as cc, not inferred (gate G2)", () => {
  const head = (raw, extra) => ({ raw: Buffer.from(raw, 'latin1'), startLine: raw.split('\r\n')[0], ...extra });
  const env = buildTransparentEnvelope({ id: 'c1', seq: 0, error: null,
    flow: { id: 'f1', host: 'api.anthropic.com', scheme: 'https', dst: { address: '10.0.0.9', port: 443 }, proc: { pid: 9, exe: '/usr/bin/x', agent: 'claude-code' } },
    req: { head: head('POST /v1/messages?beta=true HTTP/1.1\r\n\r\n', { method: 'POST', target: '/v1/messages?beta=true',
      headers: [['X-Claude-Code-Session-Id', 'S9'], ['User-Agent', 'claude-cli/2.1 (external, cli)']] }), body: Buffer.from('{"model":"m","messages":[]}'), truncated: false, tsStart: '2026-10-06T00:00:00.000Z' },
    resp: { head: head('HTTP/1.1 200 OK\r\n\r\n', { status: 200, headers: [['Content-Type', 'application/json']] }), body: Buffer.from('{}'), truncated: false, tsStart: '2026-10-06T00:00:01.000Z', tsEnd: '2026-10-06T00:00:02.000Z' } });
  const m = metaFor([env], 'S9');
  assert.deepEqual([m.harness, m.harness_inferred, m.provider], ['cc', false, 'anthropic']);
});
