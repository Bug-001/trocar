// design §7.3 P · spec 4.2:61 (text_ref field segment resp.raw / resp.messages.<j>): every reply block of a call is
// addressable. For each part with a span, the field text sliced at [a, b] and run through the SAME wire's reconstruction
// gives the part's block; the expected blocks come from that reconstruction of the whole reply, as the collector stores it
// (shapeResponse / buildWsEnvelope). Axes: wire × block kinds × multibyte text × line ending; blocks whose events
// interleave get no span and say why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeResponse } from '../../src/collector/core/record/body.mjs';
import { buildWsEnvelope } from '../../src/collector/core/record/envelope.mjs';
import { makeSseReconstructor } from '../../src/capture/sse-reconstruct.mjs';
import { fieldTextOf } from '../../src/dissect/record-fields.mjs';
import { RESPONSES, CHAT, itemToBlocks, normRespChat } from '../../src/dissect/openai.mjs';
import { RESPONSES_WS } from '../../src/dissect/openai-ws.mjs';
import { replyPartsAnthropic } from '../../src/view/analyze.mjs';

const TEXTS = ['plain ascii', 'multibyte 你好 — 😀 é'];
const EOLS = ['\n', '\r\n'];
const sseOf = (events, eol) => events.map((e) => `event: ${e.type}${eol}data: ${JSON.stringify(e)}${eol}${eol}`).join('');
const stored = (text) => shapeResponse({ status: 200, headers: [['content-type', 'text/event-stream']], body: Buffer.from(text) });
const rec = (resp) => ({ id: 'r1', req_body: '{}', resp });
const halves = (s) => [s.slice(0, Math.ceil(s.length / 2)), s.slice(Math.ceil(s.length / 2))];

// ── wire builders: each returns the event list for one block, given its wire key ──
const anth = {
  text: (i, t) => [{ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
    ...halves(t).map((x) => ({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: x } })), { type: 'content_block_stop', index: i }],
  thinking: (i, t) => [{ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } },
    ...halves(t).map((x) => ({ type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: x } })),
    { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: 'sig' } }, { type: 'content_block_stop', index: i }],
  tool: (type) => (i, t) => [{ type: 'content_block_start', index: i, content_block: { type, id: `tu${i}`, name: 'Read', input: {} } },
    ...halves(JSON.stringify({ file_path: t, n: [1, 2] })).map((x) => ({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: x } })),
    { type: 'content_block_stop', index: i }],
  result: (i) => [{ type: 'content_block_start', index: i, content_block: { type: 'web_search_tool_result', tool_use_id: 'tu1', content: [] } }, { type: 'content_block_stop', index: i }],
};
const anthStream = (groups) => [{ type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage: { input_tokens: 1 } } },
  ...groups.flat(), { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
const anthRecon = (text) => { const r = makeSseReconstructor(); r.push(Buffer.from(text)); return r.finish().content_blocks; };

const respItems = (t) => [
  { type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: t }], encrypted_content: 'enc' },
  { type: 'message', id: 'msg', role: 'assistant', content: [{ type: 'output_text', text: t }] },
  { type: 'function_call', id: 'fc', call_id: 'call1', name: 'shell', arguments: JSON.stringify({ cmd: t }) },
];
const respEvents = (item, k) => {
  const ev = [{ type: 'response.output_item.added', output_index: k, item: { ...item, ...(item.content ? { content: [] } : {}) } }];
  if (item.type === 'message') for (const x of halves(item.content[0].text)) ev.push({ type: 'response.output_text.delta', output_index: k, content_index: 0, delta: x });
  if (item.type === 'function_call') for (const x of halves(item.arguments)) ev.push({ type: 'response.function_call_arguments.delta', output_index: k, delta: x });
  ev.push({ type: 'response.output_item.done', output_index: k, item });
  return ev;
};
const completed = (items) => ({ type: 'response.completed', response: { id: 'resp1', status: 'completed', output: items, usage: { input_tokens: 3, output_tokens: 2 } } });
const respBlocks = (items) => items.flatMap((it) => itemToBlocks(it)).map((b) => b.block);
// a slice of Responses events → its block: the item the wire closes it with
const respSlice = (text) => respBlocks(sliceEvents(text).filter((e) => e.type === 'response.output_item.done').map((e) => e.item));
function sliceEvents(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) { const d = line.slice(5).trim(); if (d && d !== '[DONE]') out.push(JSON.parse(d)); }
  return out;
}

const chatChunk = (delta) => ({ id: 'c', model: 'm', choices: [{ index: 0, delta }] });
const chatGroups = (t) => [
  halves(t).map((x) => chatChunk({ reasoning_content: x })),
  halves(t).map((x) => chatChunk({ content: x })),
  ...[0, 1].map((k) => [chatChunk({ tool_calls: [{ index: k, id: `call${k}`, type: 'function', function: { name: 'read', arguments: '' } }] }),
    ...halves(JSON.stringify({ path: t, k })).map((x) => chatChunk({ tool_calls: [{ index: k, function: { arguments: x } }] }))]),
];
// Chat's reconstruction (normRespChat) → blocks in the board vocabulary
const chatBlocks = (events) => {
  const n = normRespChat({ resp: { raw_sse: events } });
  return [...(n.thinking ? [{ type: 'thinking', thinking: n.thinking }] : []), ...(n.text ? [{ type: 'text', text: n.text }] : []),
    ...n.tools.map((x) => ({ type: 'tool_use', id: x.id, name: x.name, input: x.input }))];
};
const chatSse = (chunks, eol) => [{ role: 'assistant', content: '' }].map(chatChunk).concat(chunks, [{ id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }])
  .map((e) => `data: ${JSON.stringify(e)}${eol}${eol}`).join('') + `data: [DONE]${eol}${eol}`;

// field text [a, b] through `recon` gives exactly the part's block; the parts' blocks are the whole reply's blocks
function assertParts(r, parts, expected, recon) {
  assert.deepEqual(parts.map((p) => p.block), expected);
  for (const p of parts) {
    assert.equal(p.role, 'assistant');
    assert.equal(p.kind, p.block.type);
    assert.ok(p.span, `${p.kind} has a span`);
    const f = fieldTextOf(r, p.field);
    assert.deepEqual(recon(f.text.slice(p.span[0], p.span[1])), [p.block]);
  }
}

test('every reply span, resolved, reassembles to the normalised reply block (Anthropic, Responses, Chat SSE; WebSocket)', () => {
  for (const t of TEXTS) {
    for (const eol of EOLS) {
      // Anthropic: text, thinking, tool_use, server_tool_use, a *_tool_result
      const ab = [anth.thinking(0, t), anth.text(1, t), anth.tool('tool_use')(2, t), anth.tool('server_tool_use')(3, t), anth.result(4)];
      const ar = rec(stored(sseOf(anthStream(ab), eol)));
      assertParts(ar, replyPartsAnthropic(ar), ar.resp.content_blocks, anthRecon);
      assert.ok(ar.resp.content_blocks.length === ab.length);
      // Responses SSE
      const items = respItems(t);
      const rr = rec(stored(sseOf([{ type: 'response.created', response: { id: 'resp1' } }, ...items.flatMap(respEvents), completed(items)], eol)));
      assertParts(rr, RESPONSES.replyParts(rr), respBlocks(completed(items).response.output), respSlice);
      // Chat SSE
      const cr = rec(stored(chatSse(chatGroups(t).flat(), eol)));
      assertParts(cr, CHAT.replyParts(cr), chatBlocks(cr.resp.raw_sse), (s) => chatBlocks(sliceEvents(s)));
    }
    // WebSocket: one server message per event; the part is the item of the message that closes it
    const items = respItems(t);
    const server = [{ type: 'response.created', response: { id: 'resp1' } }, ...items.flatMap(respEvents), completed(items)].map((e) => JSON.stringify(e));
    const wr = buildWsEnvelope({ id: 'w1', seq: 1, wsRaw: [], flow: { id: 'F', host: 'h', scheme: 'https', dst: {}, proc: {} },
      upgrade: { req: { head: { raw: Buffer.from(''), method: 'GET', target: '/v1/responses', headers: [] } }, resp: { head: { raw: Buffer.from(''), headers: [] } } },
      call: { client: ['{"type":"response.create"}'], server, tsStart: 't', tsRespStart: 't', tsEnd: 't', partial: [], truncated: false } });
    assertParts(wr, RESPONSES_WS.replyParts(wr), respBlocks(completed(items).response.output), (s) => respBlocks([JSON.parse(s)]));
  }
});

test('a reply block whose events interleave with another block has no span, and says why', () => {
  const zip = (a, b) => { const out = []; for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...(a[i] ? [a[i]] : []), ...(b[i] ? [b[i]] : [])); return out; };
  const a = stored(sseOf(anthStream([zip(anth.text(0, 'left side'), anth.tool('tool_use')(1, 'right'))]), '\n'));
  const items = respItems('x').slice(1);
  const r = stored(sseOf([...zip(respEvents(items[0], 0), respEvents(items[1], 1)), completed(items)], '\n'));
  const c = stored(chatSse(zip(chatGroups('ab')[2], chatGroups('ab')[3]), '\n'));
  for (const parts of [replyPartsAnthropic(rec(a)), RESPONSES.replyParts(rec(r)), CHAT.replyParts(rec(c))]) {
    assert.ok(parts.length >= 2);
    for (const p of parts) {
      assert.equal(p.span, null);
      assert.ok(typeof p.why === 'string' && p.why.length > 0);
      assert.ok(p.block && p.block.type);
    }
  }
});
