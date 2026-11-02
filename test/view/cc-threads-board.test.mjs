// test/view/cc-threads-board.test.mjs — 3.1 #7: the lanes of a Message Threads session (RFC 3.1:60, 3.2:52, invariant 4 / D38) are judged
// on the stitched context: one main lane, one subagent lane per agent, auxiliary calls apart; a missing anchor reads partial. Records are
// synthetic (test/helpers/cc-threads.mjs), written in step order and read through the `session` document (test/helpers/session-doc.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeWith, query, SEGMENT } from '../helpers/session-doc.mjs';
import { threadSession, record, replyOf, user } from '../helpers/cc-threads.mjs';

// record id → { row, lane: the lane head with `calls`, the record ids of its rows in document order }
async function board(recs) {
  const inOrder = [...recs].sort((a, b) => a.ts_request.localeCompare(b.ts_request));
  const idOf = new Map(inOrder.map((r, i) => [`${SEGMENT}:${i + 1}`, r.id]));
  const doc = await query(homeWith(inOrder), 'session', { id: inOrder[0].req_headers['x-claude-code-session-id'] });
  const lanes = new Map(doc.lanes.map((l) => [l.lane, { ...l, calls: doc.calls.filter((c) => c.lane === l.lane).map((c) => idOf.get(c.rid)) }]));
  return new Map(doc.calls.map((c) => [idOf.get(c.rid), { row: c, lane: lanes.get(c.lane) }]));
}

test('continuations land in their thread\'s lane: one main lane, one subagent lane per thread, aux calls apart', async () => {
  const s = threadSession();
  const calls = await board(s.fileOrder);
  const laneOf = (id) => calls.get(id).lane;
  assert.equal(laneOf('M0').kind, 'main');
  assert.deepEqual(laneOf('M0').calls, ['M0', 'M1', 'M2']);
  assert.equal(laneOf('S0').kind, 'subagent');
  assert.deepEqual(laneOf('S0').calls, ['S0', 'S1'], 'the subagent thread is one lane, not split by the interleaved main calls');
  // request-class auxiliary (3.4): a background call, never a turn of the main or a subagent lane
  assert.equal(laneOf('A').kind, 'aux');
  for (const id of ['M1', 'M2', 'S1']) assert.notEqual(calls.get(id).row.wire.contextState, 'partial', `${id} is stitched`);
});

test('an auxiliary call carrying its subagent\'s agent-id is aux, not a turn of that subagent lane', async () => {
  const s = threadSession();
  const sub = { 'x-claude-code-agent-id': 'agent-s' };
  const S0 = { ...s.S0, req_headers: { ...s.S0.req_headers, ...sub } };
  const S1 = { ...s.S1, req_headers: { ...s.S1.req_headers, ...sub } };
  // a progress summary that copies the subagent's whole history, as Claude Code sends one
  const P = record('P', '2026-10-20T00:00:04.500Z', {
    model: 'claude-opus-x', max_tokens: 200, system: JSON.parse(s.S0.req_body).system,
    messages: [user('subagent task: count files'), { role: 'assistant', content: [{ type: 'text', text: 'counting' }] }, user('summarise progress')],
  }, replyOf('msg_p', [{ type: 'text', text: 'counting files' }]), { ...sub, 'x-claude-code-request-class': 'auxiliary' });
  const calls = await board([s.M0, S0, S1, P]);
  assert.equal(calls.get('P').lane.kind, 'aux');
  assert.deepEqual(calls.get('S0').lane.calls, ['S0', 'S1']);
});

test('a missing anchor shows on the call and its successors as partial (never as complete)', async () => {
  const s = threadSession();
  const calls = await board([s.M1, s.M2]);
  for (const id of ['M1', 'M2']) {
    assert.equal(calls.get(id).row.wire.contextState, 'partial');
    assert.equal(typeof calls.get(id).row.wire.contextMissing, 'string', 'it says what is missing');
  }
});

test('an agent that starts a new thread midway stays one subagent lane; another agent id is another lane', async () => {
  const s = threadSession();
  const sub = (id) => (r) => ({ ...r, req_headers: { ...r.req_headers, 'x-claude-code-agent-id': id } });
  const S0 = sub('agent-s')(s.S0), S1 = sub('agent-s')(s.S1);
  // the same agent opens a fresh thread carrying its whole history so far
  const S2 = sub('agent-s')(record('S2', '2026-10-20T00:00:07.000Z', {
    model: 'claude-opus-x', thread: { type: 'create' }, max_tokens: 1000, stream: true, system: JSON.parse(s.S0.req_body).system,
    tools: JSON.parse(s.S0.req_body).tools,
    messages: [user('subagent task: count files'), { role: 'assistant', content: [{ type: 'text', text: '2 files' }] }, user('and dirs?')],
  }, replyOf('msg_s2', [{ type: 'text', text: '1 dir' }])));
  const T0 = sub('agent-t')(record('T0', '2026-10-20T00:00:08.000Z', {
    model: 'claude-opus-x', thread: { type: 'create' }, max_tokens: 1000, stream: true, system: JSON.parse(s.S0.req_body).system,
    tools: JSON.parse(s.S0.req_body).tools, messages: [user('another task')],
  }, replyOf('msg_t0', [{ type: 'text', text: 'ok' }])));
  const calls = await board([s.M0, S0, s.M1, S1, S2, T0]);
  assert.deepEqual(calls.get('S0').lane.calls, ['S0', 'S1', 'S2']);
  assert.equal(calls.get('T0').lane.kind, 'subagent');
  assert.notEqual(calls.get('T0').lane, calls.get('S0').lane);
});
