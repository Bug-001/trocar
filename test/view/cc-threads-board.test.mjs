// test/view/cc-threads-board.test.mjs — the board over a Message Threads session (RFC 3.1:60, 3.2:52, invariant 4 / D38):
// lanes are judged on the stitched context, every request block resolves to its source bytes, a missing anchor shows
// as partial. Records are synthetic (test/helpers/cc-threads.mjs) and go through a real capture file, so blocks carry
// text_refs exactly as on the product path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assembleSession } from '../../src/view/assemble.mjs';
import { readRecords } from '../../src/raw/ingest.mjs';
import { tmpDir } from '../helpers/tmp.mjs';
import { threadSession, record, replyOf, user } from '../helpers/cc-threads.mjs';

async function board(recs) {
  const file = path.join(tmpDir('trocar-threads-'), 'cap.ndjson');
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const A = assembleSession(await readRecords(file));
  const calls = new Map(A.lanes.flatMap((l) => l.calls.map((c) => [c.id, { ...c, lane: l }])));
  return { A, file, calls };
}

test('continuations land in their thread\'s lane: one main lane, one subagent lane per thread, aux calls apart', async () => {
  const s = threadSession();
  const { calls } = await board(s.fileOrder);
  const laneOf = (id) => calls.get(id).lane;
  assert.equal(laneOf('M0').kind, 'main');
  assert.equal(laneOf('M1'), laneOf('M0'));
  assert.equal(laneOf('M2'), laneOf('M0'));
  assert.equal(laneOf('S0').kind, 'subagent');
  assert.equal(laneOf('S1'), laneOf('S0'), 'the subagent thread is one stream, not split by the interleaved main calls');
  // request-class auxiliary (3.4): a background call, never a turn of the main or a subagent lane
  assert.equal(laneOf('A').kind, 'aux');
  assert.deepEqual(laneOf('M0').calls.map((c) => c.id), ['M0', 'M1', 'M2']);
  // the lane's view of a continuation is its stitched context, not its two-message delta
  assert.equal(calls.get('M2').msgCount, calls.get('M1').msgCount + 2);
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
  const { calls } = await board([s.M0, S0, S1, P]);
  assert.equal(calls.get('P').lane.kind, 'aux');
  assert.deepEqual(calls.get('S0').lane.calls.map((c) => c.id), ['S0', 'S1']);
});

test('a missing anchor shows on the call as partial with what is missing (never as complete)', async () => {
  const s = threadSession();
  const { calls } = await board([s.M1, s.M2]);
  for (const id of ['M1', 'M2']) {
    assert.equal(calls.get(id).wire.contextState, 'partial');
    assert.match(calls.get(id).wire.contextMissing, /msg_m0/);
    assert.equal(calls.get(id).prefixSha256, null, 'no byte-identity claim over a partial context (3.2:130)');
  }
});

test('system-role messages and tool_addition blocks are blocks of the context; an added definition is a tool', async () => {
  const s = threadSession();
  const { calls } = await board(s.fileOrder);
  const flat = calls.get('M1').flat;
  const add = flat.find((b) => b.kind === 'tool_addition');
  assert.ok(add && add.text_ref, 'the tool_addition block is in the context and addressable');
  assert.equal(add.role, 'system');
  assert.equal(add.head.label, 'Grep');
  assert.ok(flat.some((b) => b.sec === 'messages' && b.role === 'system' && b.kind === 'text'));
  assert.equal(calls.get('M1').rec.request.tool_count, JSON.parse(s.M0.req_body).tools.length + 1);
  assert.ok(calls.get('M1').comp.tools > 0);
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
  const { calls } = await board([s.M0, S0, s.M1, S1, S2, T0]);
  assert.deepEqual(calls.get('S0').lane.calls.map((c) => c.id), ['S0', 'S1', 'S2']);
  assert.equal(calls.get('T0').lane.kind, 'subagent');
  assert.notEqual(calls.get('T0').lane, calls.get('S0').lane);
});
