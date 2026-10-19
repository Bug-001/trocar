// 3.4 关键区分 / 4.6 R3 (read half): board sessions by the harness's session key, never by pid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSessions } from '../../src/view/board.mjs';

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
