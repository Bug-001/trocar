// test/view/mixed-session.test.mjs — one session, several wires (D37 ①: the wire format is per call), and
// unrecognized records inside a known session (3.1:58).
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSession } from '../../src/view/assemble.mjs';
import { pageView, forWire } from '../../src/view/board.mjs';

const hermes = (id, sec, endpoint, body) => ({ id, ts_request: `2026-10-06T00:00:0${sec}Z`, is_llm_call: true, endpoint,
  capture: 'transparent', proc: { pid: 1, exe: '/x/hermes', agent: 'hermes' }, req_headers: {},
  req_body: JSON.stringify({ session_id: 'H1', ...body }), resp: { status: 200, kind: 'sse', raw_sse: [], usage: {} } });
const CHAT = { model: 'nous', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }] };
const ANTH = { model: 'claude-haiku', system: [{ type: 'text', text: 'title this' }], messages: [{ role: 'user', content: 'q' }] };

test('a session mixing the Chat and Anthropic wires renders both, with one global step index', () => {
  const A = assembleSession([hermes('h3', 3, '/v1/chat/completions', CHAT), hermes('h1', 1, '/v1/chat/completions', CHAT), hermes('h2', 2, '/v1/messages', ANTH)]);
  assert.deepEqual(A.steps.map((s) => s.id), ['h1', 'h2', 'h3']);
  A.steps.forEach((s, i) => assert.equal(s.gi, i, 'steps[gi] is the call with that gi (the browser rehydrates by it)'));
  const laneIds = A.lanes.flatMap((l) => l.calls.map((c) => c.id)).sort();
  assert.deepEqual(laneIds, ['h1', 'h2', 'h3'], 'every call sits in exactly one lane');
  for (const l of A.lanes) l.calls.forEach((c, i) => assert.equal(l.giLocal.get(c.gi), i));
  assert.equal(A.provider, 'mixed');
  assert.deepEqual([A.stats.calls, A.unknown], [3, undefined]);
  // what the browser receives: lanes name their calls by gi, and every gi rehydrates to the right call
  const W = forWire({ analyzed: A }).analyzed;
  for (const l of W.lanes) for (const gi of l.calls) assert.equal(W.steps[gi].gi, gi);
});

test('the retention window pages a mixed session by the global index', () => {
  const recs = [1, 2, 3, 4].map((k) => (k % 2 ? hermes('h' + k, k, '/v1/chat/completions', CHAT) : hermes('h' + k, k, '/v1/messages', ANTH)));
  // what sessionView asks for page {cursor:2, limit:2}: the window plus the one call before it (board.mjs inPage)
  const A = assembleSession(recs, { keepFlat: (gi) => gi >= 1 && gi < 4 });
  assert.deepEqual(A.steps.map((s) => [s.id, !!s.paged_out]), [['h1', true], ['h2', false], ['h3', false], ['h4', false]]);
  assert.equal(A.steps[0].flat.length, 0, 'an out-of-window call ships no blocks, whichever wire it is');
  const P = pageView({ analyzed: A }, { cursor: 2, limit: 2 });
  assert.deepEqual([P.page.total, P.page.returned], [4, 3], 'two in the window plus the one diff baseline before it');
});

test('an unrecognized record inside a known session is counted in analyzed.unknown and never rendered', () => {
  const g = hermes('g1', 4, '/v1beta/models/x:generateContent', { contents: [] });
  const A = assembleSession([hermes('h1', 1, '/v1/chat/completions', CHAT), g]);
  assert.deepEqual(A.steps.map((s) => s.id), ['h1']);
  assert.equal(A.unknown.partial, true);
  assert.equal(A.unknown.records, 1);
  assert.deepEqual(A.unknown.endpoints, ['/v1beta/models/x:generateContent']);
  assert.match(A.unknown.reason, /NOT rendered/);
  const whole = assembleSession([g]);
  assert.deepEqual([whole.provider, whole.unknown.partial, whole.unknown.records, whole.steps.length], ['unknown', false, 1, 0]);
});

test('harness lane hints split a flat-lane session (Z-Code subagent)', () => {
  const z = (id, sec, type) => ({ id, ts_request: `2026-10-06T00:00:0${sec}Z`, is_llm_call: true, endpoint: '/v1/chat/completions',
    proc: { pid: 1, exe: '/x', agent: 'z-code' }, req_headers: { 'x-session-id': 'Z', ...(type ? { 'x-zcode-session-type': type } : {}) },
    req_body: JSON.stringify(type === 'subagent' ? { ...CHAT, messages: [{ role: 'system', content: 'a subagent prompt' }, CHAT.messages[1]] } : CHAT),
    resp: { status: 200, kind: 'sse', raw_sse: [] } });
  const A = assembleSession([z('z1', 1), z('z2', 2, 'subagent'), z('z3', 3, 'main')]);
  assert.deepEqual(A.lanes.map((l) => [l.kind, l.calls.map((c) => c.id)]), [['main', ['z1', 'z3']], ['subagent', ['z2']]]);
  const z3 = A.steps.find((s) => s.id === 'z3').cacheBreak;
  assert.deepEqual([z3.firstCall, z3.idx], [false, 2], 'the cache baseline is per lane: z3 reuses all of z1, it is not diffed against the subagent z2');
  assert.equal(A.stats.subagents, 1);
});
