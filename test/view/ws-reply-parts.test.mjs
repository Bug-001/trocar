// test/view/ws-reply-parts.test.mjs — 3.1 回复块也回源 (D69 · D70) and 4.3 §3 (a block's id is its bytes) on the Responses-over-WebSocket
// wire, read the way the board reads it: records in a raw segment → `session` and `lane` documents → the desk → stepOf.
//   (a) each reply block ships its own ref, and the ref resolves to exactly that block's JSON in the server message: one block per
//       content part of an output message (a one-part message's ref is the part, not the whole item), the item for a tool call
//   (b) a later call that carries the reply in its input splits it the same way, part for part, so the same bytes are the same blocks
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeWith, query, SEGMENT } from '../helpers/session-doc.mjs';
import { createDesk, applySession, applyLane, stepOf } from '../../src/web/v2/replay/model.mjs';
import { parseTextRef } from '../../src/raw/refs.mjs';
import { fieldTextOf } from '../../src/dissect/record-fields.mjs';

const user = (t) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] });
// one call on connection F as the collector writes it: the client's response.create, then the server messages; each output item
// is closed by an output_item.done (`closed`), or only listed in response.completed
function call(n, { input, prev = null, id, output, closed = true }) {
  const done = output.map((item, k) => JSON.stringify({ type: 'response.output_item.done', output_index: k, item }));
  const messages = [JSON.stringify({ type: 'response.created', response: { id } }), ...(closed ? done : []),
    JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 2 } } })];
  return { id: `w${n}`, ts_request: `2026-10-06T00:00:0${n}Z`, endpoint: '/v1/responses', transport: 'ws', flow_id: 'F', seq: n, ws_ext: '',
    host: 'chatgpt.com', proc: { pid: 2, exe: '/x/codex', agent: 'codex' }, req_headers: { 'session-id': 'CX' },
    req_body: JSON.stringify({ type: 'response.create', model: 'm', instructions: 'You are Codex.', tools: [], input, ...(prev ? { previous_response_id: prev } : {}) }),
    resp: { kind: 'ws', messages } };
}
async function board(records) {
  const home = homeWith(records), desk = createDesk(), s = await query(home, 'session', { id: 'CX' });
  applySession(desk, s);
  for (const lane of new Set(s.calls.map((c) => c.lane))) applyLane(desk, await query(home, 'lane', { id: 'CX', lane }));
  return desk;
}
const bytesOf = (records, ref) => {
  const { recordId, field, start, end } = parseTextRef(ref);
  const rec = records[Number(recordId.slice(SEGMENT.length + 1)) - 1]; // the segment's records are ids <segment>:<line>
  return (field ? fieldTextOf(rec, field).text : rec.req_body).slice(start, end);
};
// where `sub` (a run of bids) stands in `list`, or -1
const runAt = (list, sub) => list.findIndex((_, i) => sub.every((b, k) => list[i + k] === b));

test('a WebSocket reply: one ref per content part, exactly that part\'s bytes; a later call carrying it splits it the same way', async () => {
  for (const closed of [true, false]) {
    const twoPart = { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'first 你好' }, { type: 'output_text', text: 'second — ok' }] };
    const fc = { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' };
    const onePart = { type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: 'only part' }] };
    const fco = { type: 'function_call_output', call_id: 'c1', output: 'a.txt' };
    // B resends the whole input (no previous_response_id): A's reply is in its request bytes
    const records = [call(1, { input: [user('q1')], id: 'r1', output: [twoPart, fc], closed }),
      call(2, { input: [user('q1'), twoPart, fc, fco, user('q2')], id: 'r2', output: [onePart], closed })];
    const desk = await board(records);
    const A = stepOf(desk, `${SEGMENT}:1`), B = stepOf(desk, `${SEGMENT}:2`);
    assert.ok(A.held && B.held, `${closed}: both steps are held`);
    // (a)
    for (const [st, nodes] of [[A, [...twoPart.content, fc]], [B, onePart.content]]) {
      assert.equal(st.reply.length, nodes.length, `${closed}: one reply block per content part / tool call`);
      st.reply.forEach((d, k) => {
        assert.ok(d.ref, `${closed}: reply block #${k} has a ref`);
        assert.equal(bytesOf(records, d.ref), JSON.stringify(nodes[k]), `${closed}: reply block #${k} resolves to exactly its own JSON`);
      });
    }
    // (b) A's reply blocks are the blocks B's request carries at the place of A's output items, in order
    const bids = B.flat.map((d) => d.bid), at = runAt(bids, A.reply.map((d) => d.bid));
    assert.ok(at >= 0, `${closed}: B's request holds A's reply blocks, part for part`);
    assert.equal(B.flat[at - 1] && bytesOf(records, B.flat[at - 1].text_ref), JSON.stringify(user('q1').content[0]), `${closed}: right after q1`);
  }
});
