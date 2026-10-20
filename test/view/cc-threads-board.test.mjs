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
import { buildResolver } from '../../src/query/source.mjs';
import { tmpDir } from '../helpers/tmp.mjs';
import { threadSession } from '../helpers/cc-threads.mjs';

async function board(recs) {
  const file = path.join(tmpDir('asight-threads-'), 'cap.ndjson');
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
  assert.notEqual(laneOf('A'), laneOf('S0'));
  // the lane's view of a continuation is its stitched context, not its two-message delta
  assert.equal(calls.get('M2').msgCount, calls.get('M1').msgCount + 2);
});

test('a reconstructed continuation: state on the call, every request block resolves verbatim to the record it came from', async () => {
  const s = threadSession();
  const { calls, file } = await board(s.fileOrder);
  const call = calls.get('M2');
  assert.equal(call.wire.contextState, 'reconstructed');
  const resolve = await buildResolver(file);
  const srcOf = new Map([s.M0, s.M1, s.M2].map((r) => [r.id, r.req_body]));
  let located = 0;
  for (const b of call.flat) {
    if (!b.text_ref) { assert.ok(b.unaddressable, `${b.sec} block without a locator says why`); assert.equal(b.role, 'assistant'); continue; }
    const got = resolve.detail(b.text_ref);
    assert.equal(got.status, 'ok', got.reason || '');
    const recId = b.text_ref.split('::')[0].split('#').pop();
    const [st, en] = b.text_ref.split('::').pop().split('-').map(Number);
    assert.equal(got.text, srcOf.get(recId).slice(st, en));
    located++;
  }
  assert.ok(located > 0);
  assert.deepEqual([...new Set(call.flat.filter((b) => b.text_ref).map((b) => b.text_ref.split('::')[0].split('#').pop()))].sort(), ['M0', 'M1', 'M2']);
  resolve.dispose && resolve.dispose();
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
