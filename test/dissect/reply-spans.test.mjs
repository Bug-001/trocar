// spec 4.2:61 (text_ref field segment resp.raw / resp.messages.<j>): every reply block of a call is
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
// a block's start event is its base: what the collector rebuilt lies over it (RFC 3.1)
const anthRecon = (text) => {
  const r = makeSseReconstructor(); r.push(Buffer.from(text));
  const starts = sliceEvents(text).filter((e) => e.type === 'content_block_start');
  return r.finish().content_blocks.map((b, i) => ({ ...starts[i].content_block, ...b }));
};

const respItems = (t) => [
  { type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: t }], encrypted_content: 'enc' },
  { type: 'message', id: 'msg', role: 'assistant', content: [{ type: 'output_text', text: t }] },
  { type: 'function_call', id: 'fc', call_id: 'call1', name: 'shell', arguments: JSON.stringify({ cmd: t }) },
];
const respEvents = (item, k) => {
  const ev = [{ type: 'response.output_item.added', output_index: k, item: { ...item, ...(item.content ? { content: [] } : {}) } }];
  if (item.type === 'message') (item.content || []).forEach((c, ci) => { for (const x of halves(c.text || '')) ev.push({ type: 'response.output_text.delta', output_index: k, content_index: ci, delta: x }); });
  if (item.type === 'function_call') for (const x of halves(item.arguments)) ev.push({ type: 'response.function_call_arguments.delta', output_index: k, delta: x });
  ev.push({ type: 'response.output_item.done', output_index: k, item });
  return ev;
};
const completed = (items) => ({ type: 'response.completed', response: { id: 'resp1', status: 'completed', output: items, usage: { input_tokens: 3, output_tokens: 2 } } });
const respBlocks = (items) => items.flatMap((it) => itemToBlocks(it)).map((b) => b.block);
// an SSE slice's closing events (data lines of one event joined, as SSE does) → their items' blocks
const respSlice = (text) => respBlocks(text.split(/\r?\n\r?\n/).map((ev) => ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'))
  .filter(Boolean).map((d) => JSON.parse(d)).filter((e) => e.type === 'response.output_item.done').map((e) => e.item));
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

test('every reply span, resolved, reassembles to the normalised reply block (Anthropic, Chat SSE)', () => {
  for (const t of TEXTS) {
    for (const eol of EOLS) {
      // Anthropic: text, thinking, tool_use, server_tool_use, a *_tool_result
      const ab = [anth.thinking(0, t), anth.text(1, t), anth.tool('tool_use')(2, t), anth.tool('server_tool_use')(3, t), anth.result(4)];
      const ar = rec(stored(sseOf(anthStream(ab), eol)));
      assertParts(ar, replyPartsAnthropic(ar), anthRecon(fieldTextOf(ar, 'resp.raw').text), anthRecon);
      assert.ok(ar.resp.content_blocks.length === ab.length);
      // Chat SSE
      const cr = rec(stored(chatSse(chatGroups(t).flat(), eol)));
      assertParts(cr, CHAT.replyParts(cr), chatBlocks(cr.resp.raw_sse), (s) => chatBlocks(sliceEvents(s)));
    }
  }
});

test('a reply block whose events interleave with another block has no event-range span, and says why (Anthropic, Chat SSE)', () => {
  const zip = (a, b) => { const out = []; for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...(a[i] ? [a[i]] : []), ...(b[i] ? [b[i]] : [])); return out; };
  const a = stored(sseOf(anthStream([zip(anth.text(0, 'left side'), anth.tool('tool_use')(1, 'right'))]), '\n'));
  const c = stored(chatSse(zip(chatGroups('ab')[2], chatGroups('ab')[3]), '\n'));
  for (const parts of [replyPartsAnthropic(rec(a)), CHAT.replyParts(rec(c))]) {
    assert.ok(parts.length >= 2);
    for (const p of parts) {
      assert.equal(p.span, null);
      assert.ok(typeof p.why === 'string' && p.why.length > 0);
      assert.ok(p.block && p.block.type);
    }
  }
});

// RFC 3.1: a rebuilt reply block keeps what the wire carried. Sentinels go into the bytes; each must be in the part's block and
// in the bytes its span cuts, whether the stream is read from resp.raw or from raw_sse, and in the same block a JSON reply gives.
test('a streamed Anthropic block keeps its start block, its citations and any streamed input', () => {
  const start = (index, content_block) => ({ type: 'content_block_start', index, content_block });
  const delta = (index, d) => ({ type: 'content_block_delta', index, delta: d });
  const stop = (index) => ({ type: 'content_block_stop', index });
  const groups = [
    [start(0, { type: 'text', text: '' }), delta(0, { type: 'text_delta', text: 'S_text' }), delta(0, { type: 'citations_delta', citation: { type: 'web_search_result_location', cited_text: 'S_cite_1' } }),
      delta(0, { type: 'citations_delta', citation: { type: 'web_search_result_location', cited_text: 'S_cite_2' } }), stop(0)],
    [start(1, { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', title: 'S_srv_title', encrypted_content: 'S_srv_enc' }] }), stop(1)],
    [start(2, { type: 'mcp_tool_use', id: 'm1', name: 'S_mcp_name', server_name: 'S_mcp_server', input: { a: 'S_mcp_start_input' } }), stop(2)],
    [start(3, { type: 'mcp_tool_use', id: 'm2', name: 'S_mcp_name', server_name: 'x', input: {} }), ...['{"a":', '"S_mcp_streamed"}'].map((partial_json) => delta(3, { type: 'input_json_delta', partial_json })), stop(3)],
    [start(4, { type: 'mcp_tool_use', id: 'm3', name: 'n', server_name: 'x', input: {} }), delta(4, { type: 'input_json_delta', partial_json: '{"a":"S_mcp_cut' }), stop(4)],
    [start(5, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }), delta(5, { type: 'input_json_delta', partial_json: '{"command":"S_tool_input"}' }), stop(5)],
  ];
  const want = [
    { type: 'text', text: 'S_text', citations: [{ type: 'web_search_result_location', cited_text: 'S_cite_1' }, { type: 'web_search_result_location', cited_text: 'S_cite_2' }] },
    groups[1][0].content_block,
    groups[2][0].content_block,
    { ...groups[3][0].content_block, input: { a: 'S_mcp_streamed' } },
    { ...groups[4][0].content_block, input: { _unparsed: '{"a":"S_mcp_cut' } },
    { ...groups[5][0].content_block, input: { command: 'S_tool_input' } },
  ];
  for (const eol of EOLS) {
    const r = rec(stored(sseOf(anthStream(groups), eol)));
    const parts = replyPartsAnthropic(r);
    assert.deepEqual(parts.map((p) => p.block), want);
    parts.forEach((p, i) => {
      assert.ok(p.span, `${p.kind} has a span`);
      const bytes = fieldTextOf(r, p.field).text.slice(p.span[0], p.span[1]);
      for (const [s] of JSON.stringify(p.block).matchAll(/S_[a-z_0-9]+/g)) assert.ok(bytes.includes(s), `block ${i}: ${s} is in its span`);
    });
    // the same reply kept as raw_sse, without resp.raw: the events are still this key's own
    const kept = makeSseReconstructor(true); kept.push(Buffer.from(sseOf(anthStream(groups), eol)));
    assert.deepEqual(replyPartsAnthropic(rec({ kind: 'sse', status: 200, ...kept.finish() })).map((p) => p.block), want);
  }
});

const chatJson = (message) => shapeResponse({ status: 200, headers: [['content-type', 'application/json']], body: Buffer.from(JSON.stringify({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message }] })) });
test('a Chat reply that only refuses is one text block holding the refusal, in JSON and in SSE', () => {
  const only = CHAT.replyParts(rec(chatJson({ role: 'assistant', content: null, refusal: 'S_refusal' })));
  assert.deepEqual(only.map((p) => p.block), [{ type: 'text', text: 'S_refusal' }]);
  for (const eol of EOLS) {
    const r = rec(stored(chatSse(halves('S_refusal').map((refusal) => chatChunk({ refusal })), eol)));
    const parts = CHAT.replyParts(r);
    assert.deepEqual(parts.map((p) => p.block), [{ type: 'text', text: 'S_refusal' }]);
    const bytes = fieldTextOf(r, parts[0].field).text.slice(parts[0].span[0], parts[0].span[1]);
    assert.equal(sliceEvents(bytes).map((e) => e.choices[0].delta.refusal).join(''), 'S_refusal');
  }
  // beside text, it stays its own block with its own span
  const r = rec(stored(chatSse([chatChunk({ content: 'S_text' }), chatChunk({ refusal: 'S_refusal' })], '\n')));
  assert.deepEqual(CHAT.replyParts(r).map((p) => [p.block.text, !!p.span]), [['S_text', true], ['S_refusal', true]]);
});

// Responses, WebSocket and HTTP SSE: the message or event that closes an output item carries it whole as one JSON value, so a
// reply block is addressed as the JSON node it is: the item's path plus the block's own path within the item (itemToBlocks'
// `sub`, the path the request side addresses the same item by). Every content part of a message is its own block with its own
// span; a one-part message's span is that part; interleaved items still have theirs. An item no event closed is its node in the
// terminal's output, item by item (other items of the reply may be closed). Where the data that delivers the item is not one JSON
// value on one data line, an SSE block falls back to its item's event range: one block alone in it parses back to that block; a
// block that shares it with another has no span and says why.
const ZIP = (lists) => { const out = []; for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]); return out; };
const sseSplit = (events, eol) => events.map((e) => { // a closing event's data over two data: lines (valid SSE, one value)
  const d = JSON.stringify(e), cut = e.type === 'response.output_item.done' ? d.indexOf(',') + 1 : d.length;
  return `event: ${e.type}${eol}data: ${d.slice(0, cut)}${eol}${cut < d.length ? `data: ${d.slice(cut)}${eol}` : ''}${eol}`;
}).join('');
test('a Responses reply block\'s span is exactly its own JSON node, one per content part (WebSocket and HTTP SSE)', () => {
  for (const t of TEXTS) {
    const items = [...respItems(t), { type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: t }, { type: 'refusal', refusal: `no ${t}` }, { type: 'output_text', text: 'tail' }] },
      { type: 'message', id: 'm3', role: 'assistant' }, { type: 'message', id: 'm4', role: 'assistant', content: null }, // no content: no block
      // a reasoning item is one thinking block, its node the whole item, whatever keys it carries
      { type: 'reasoning', id: 'rs2', summary: [{ type: 'summary_text', text: t }], content: [{ type: 'reasoning_text', text: t }, { type: 'reasoning_text', text: 'more' }], encrypted_content: 'enc' },
      { type: 'reasoning', id: 'rs3', summary: [], content: [] }];
    const nodesOf = (it) => (it.type === 'message' ? it.content || [] : [it]);
    const nodes = items.flatMap(nodesOf);
    const units = items.flatMap((it, u) => nodesOf(it).map(() => u));
    for (const closed of ['all', 'none', 'some']) { // closed by output_item.done, or only listed in response.completed, or each other one
      const shut = (k) => closed === 'all' || (closed === 'some' && k % 2 === 0);
      const perItem = items.map((it, k) => respEvents(it, k).filter((e) => shut(k) || e.type !== 'response.output_item.done'));
      const created = { type: 'response.created', response: { id: 'resp1' } };
      // WebSocket: one server message per event
      const server = [created, ...perItem.flat(), completed(items)].map((e) => JSON.stringify(e));
      const wr = buildWsEnvelope({ id: 'w1', seq: 1, wsRaw: [], flow: { id: 'F', host: 'h', scheme: 'https', dst: {}, proc: {} },
        upgrade: { req: { head: { raw: Buffer.from(''), method: 'GET', target: '/v1/responses', headers: [] } }, resp: { head: { raw: Buffer.from(''), headers: [] } } },
        call: { client: ['{"type":"response.create"}'], server, tsStart: 't', tsRespStart: 't', tsEnd: 't', partial: [], truncated: false } });
      const runs = [['ws', wr, RESPONSES_WS, () => true]];
      // HTTP SSE: in order or interleaved, each line ending, the closing data on one line or split over two
      for (const order of ['seq', 'zip']) for (const eol of EOLS) for (const split of [false, true]) {
        const evs = [created, ...(order === 'zip' ? ZIP(perItem) : perItem.flat()), completed(items)];
        runs.push([`sse ${order} ${JSON.stringify(eol)} split=${split}`, rec(stored((split ? sseSplit : sseOf)(evs, eol))), RESPONSES, (k) => !(split && shut(k)), order === 'seq']);
      }
      for (const [name, r, d, nodal, inOrder] of runs) {
        const parts = d.replyParts(r), at = `${name} closed=${closed}`;
        assert.deepEqual(parts.map((p) => p.block), respBlocks(items), at);
        assert.equal(parts.length, nodes.length, at);
        if (d === RESPONSES_WS) assert.deepEqual(parts.map((p) => p.unit), units, `${at}: unit = the output item`);
        parts.forEach((p, k) => { if (items[units[k]].type === 'reasoning') assert.deepEqual([p.kind, p.role], ['thinking', 'assistant'], `${at} #${k}`); });
        parts.forEach((p, k) => {
          if (nodal(units[k])) {
            assert.ok(p.span, `${at} #${k} ${p.kind} has a span (${p.why})`);
            const text = fieldTextOf(r, p.field).text;
            assert.deepEqual(JSON.parse(text.slice(p.span[0], p.span[1])), nodes[k], `${at} #${k}: exactly its own node`);
          } else {
            if (nodesOf(items[units[k]]).length > 1) assert.ok(p.span === null && typeof p.why === 'string' && p.why.length > 0, `${at} #${k}: one event range, several blocks: no span, a why`);
            else {
              // one block alone in its item's events: its range is exact unless another block's events fall inside it
              if (inOrder) assert.ok(p.span, `${at} #${k}: one block, its event range is exact (${p.why})`);
              else assert.ok(p.span || (typeof p.why === 'string' && p.why.length > 0), `${at} #${k}: interleaved, a span or a why`);
              if (p.span) assert.deepEqual(respSlice(fieldTextOf(r, p.field).text.slice(p.span[0], p.span[1])), [p.block], `${at} #${k}: its event range parses back to it`);
            }
          }
        });
      }
    }
  }
});
