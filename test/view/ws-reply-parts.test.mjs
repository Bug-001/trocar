// test/view/ws-reply-parts.test.mjs — 3.1 回复块也回源 (D69 · D70) and 4.3 §3 (a block's id is its bytes) on the Responses wire, over
// WebSocket and over HTTP SSE, read the way the board reads it: records in a raw segment → `session` and `lane` documents → the desk → stepOf.
//   (a) each reply block ships its own ref, and the ref resolves to exactly that block's JSON in the server message or closing
//       event's data: one block per
//       content part of an output message (a one-part message's ref is the part, not the whole item), the item for a tool call
//   (b) a later call that carries the reply in its input splits it the same way, part for part, so the same bytes are the same blocks
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeWith, query, SEGMENT } from '../helpers/session-doc.mjs';
import { createDesk, applySession, applyLane, stepOf } from '../../web/legacy/replay/model.mjs';
import { parseTextRef } from '../../src/raw/refs.mjs';
import { fieldTextOf } from '../../src/dissect/record-fields.mjs';
import { shapeResponse } from '../../src/collector/core/record/body.mjs';

const user = (t) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] });
// one call as the collector writes it: on WebSocket (connection F) the client's response.create, then the server messages; over
// HTTP the request body, then the SSE stream. Each output item is opened by output_item.added and closed by an output_item.done (`closed`), or only listed in
// response.completed (then a block is its node in that message's or event's output).
function call(n, { input, prev = null, id, output, closed = true, wire }) {
  const items = output.flatMap((item, k) => [{ type: 'response.output_item.added', output_index: k, item: { ...item, ...(item.content ? { content: [] } : {}) } },
    ...(closed ? [{ type: 'response.output_item.done', output_index: k, item }] : [])]);
  const events = [{ type: 'response.created', response: { id } }, ...items,
    { type: 'response.completed', response: { id, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 2 } } }];
  const body = { model: 'm', instructions: 'You are Codex.', tools: [], input, ...(prev ? { previous_response_id: prev } : {}) };
  const base = { id: `w${n}`, ts_request: `2026-10-06T00:00:0${n}Z`, endpoint: '/v1/responses', host: 'chatgpt.com', proc: { pid: 2, exe: '/x/codex', agent: 'codex' }, req_headers: { 'session-id': 'CX' } };
  if (wire === 'sse') return { ...base, req_body: JSON.stringify(body), resp: shapeResponse({ status: 200, headers: [['content-type', 'text/event-stream']],
    body: Buffer.from(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')) }) };
  return { ...base, transport: 'ws', flow_id: 'F', seq: n, ws_ext: '', req_body: JSON.stringify({ type: 'response.create', ...body }),
    resp: { kind: 'ws', messages: events.map((e) => JSON.stringify(e)) } };
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

test('a Responses reply (WebSocket, HTTP SSE): one ref per content part, exactly that part\'s bytes; a later call carrying it splits it the same way', async () => {
  for (const [wire, closed] of [['ws', true], ['ws', false], ['sse', true], ['sse', false]]) {
    const twoPart = { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'first 你好' }, { type: 'output_text', text: 'second — ok' }] };
    const fc = { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' };
    const onePart = { type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: 'only part' }] };
    const fco = { type: 'function_call_output', call_id: 'c1', output: 'a.txt' };
    // B resends the whole input (no previous_response_id): A's reply is in its request bytes
    const records = [call(1, { input: [user('q1')], id: 'r1', output: [twoPart, fc], closed, wire }),
      call(2, { input: [user('q1'), twoPart, fc, fco, user('q2')], id: 'r2', output: [onePart], closed, wire })];
    const desk = await board(records);
    const A = stepOf(desk, `${SEGMENT}:1`), B = stepOf(desk, `${SEGMENT}:2`);
    assert.ok(A.held && B.held, `${wire} ${closed}: both steps are held`);
    // (a)
    for (const [st, nodes] of [[A, [...twoPart.content, fc]], [B, onePart.content]]) {
      assert.equal(st.reply.length, nodes.length, `${wire} ${closed}: one reply block per content part / tool call`);
      st.reply.forEach((d, k) => {
        assert.ok(d.ref, `${wire} ${closed}: reply block #${k} has a ref`);
        assert.equal(bytesOf(records, d.ref), JSON.stringify(nodes[k]), `${wire} ${closed}: reply block #${k} resolves to exactly its own JSON`);
      });
    }
    // (b) A's reply blocks are the blocks B's request carries at the place of A's output items, in order
    const bids = B.flat.map((d) => d.bid), at = runAt(bids, A.reply.map((d) => d.bid));
    assert.ok(at >= 0, `${wire} ${closed}: B's request holds A's reply blocks, part for part`);
    assert.equal(B.flat[at - 1] && bytesOf(records, B.flat[at - 1].text_ref), JSON.stringify(user('q1').content[0]), `${wire} ${closed}: right after q1`);
  }
});
