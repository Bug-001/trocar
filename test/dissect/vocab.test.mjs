// test/dissect/vocab.test.mjs — the neutral block vocabulary (3.1 adapter contract): a Responses input item
// is classed by the wire's own naming, never by a tool or product name, and every block still slices its own bytes (AC-1);
// a `*_tool_result` block is a tool result on the board.
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeWith, query } from '../helpers/session-doc.mjs';
import { parseTextRef } from '../../src/raw/refs.mjs';
import { compBucket, slimBlock } from '../../src/view/blockmeta.mjs';
import { reqCountsFor, RESPONSES } from '../../src/dissect/openai.mjs';

const mk = (body) => ({ id: 'r1', ts_request: '2026-10-21T00:00:00Z', endpoint: '/v1/responses', host: 'api.openai.com',
  req_headers: { 'x-claude-code-session-id': 'S' }, req_body: body, resp: { status: 200, kind: 'sse', raw_sse: [] } });
// the message definitions of the one call, as the `lane` document ships them
async function messageDefs(body) {
  const home = homeWith([mk(body)]), { calls: [call] } = await query(home, 'session', { id: 'S' });
  const { defs } = await query(home, 'lane', { id: 'S', lane: call.lane });
  return Object.values(defs).filter((d) => d.sec === 'messages');
}

// axes: call_id present / absent × type suffix × arguments string / object / none
const SUFFIX = { call: 'x_call', output: 'x_call_output', other: 'x_note' };
const cases = [];
for (const cid of [true, false]) for (const suf of Object.keys(SUFFIX)) for (const args of ['string', 'object', 'none']) {
  const item = { type: SUFFIX[suf], id: 'i1', status: 'completed', ...(cid ? { call_id: 'c1' } : {}) };
  if (args === 'string') item.arguments = '{"q": 1}';
  if (args === 'object') item.arguments = { q: 1 };
  if (suf === 'output') item.output = 'done';
  const want = suf === 'output' ? ['tool_result', 'tool'] : suf === 'call' ? [cid ? 'tool_use' : 'server_tool_use', 'assistant'] : ['json', 'assistant'];
  cases.push({ item, want });
}
cases.push({ item: { type: 'x_note', role: 'user', note: 'n' }, want: ['json', 'user'] });
// a reasoning item is one assistant thinking block whose bytes are the whole item, whatever keys it carries (3.1 Responses)
const REASONING = [];
for (const content of ['absent', 'empty', 'text']) for (const summary of [[], [{ type: 'summary_text', text: 'weighing the plan' }]]) for (const enc of [true, false]) {
  REASONING.push({ type: 'reasoning', id: 'rs_1', summary, ...(content === 'absent' ? {} : { content: content === 'empty' ? [] : [{ type: 'reasoning_text', text: 'step one, then step two' }] }),
    ...(enc ? { encrypted_content: 'gAAAAB-ciphertext' } : {}) });
}
for (const item of REASONING) cases.push({ item, want: ['thinking', 'assistant'] });

test('Responses items: kind / role by the type suffix and call_id, each block a verbatim sub-value of req_body', async () => {
  for (const { item, want } of cases) {
    const raw = JSON.stringify(item).replace(/,/g, ' ,  '); // odd spacing: only the wire's own bytes match
    const body = `{"model":"m","input":[ ${raw} ]}`;
    const flat = await messageDefs(body);
    assert.equal(flat.length, 1, raw);
    assert.deepEqual([flat[0].kind, flat[0].role], want, raw);
    const { start, end } = parseTextRef(flat[0].ref);
    assert.equal(body.slice(start, end), raw, raw);
    if (want[0] === 'json') { const h = flat[0].head; assert.notEqual(h.tag, 'say', raw); assert.ok(h.label, raw); }
  }
});

// Codex's tool offer in input[]: one `additional_tools` item, first, of namespaces of function / custom tools (real shape, 89 requests)
const FN = (name) => ({ type: 'function', name, description: `run ${name}`, parameters: { type: 'object', properties: { q: {} } } });
const OFFER = { type: 'additional_tools', id: 'at_1', role: 'developer', tools: [
  { type: 'namespace', name: 'functions', description: 'the shell', tools: [FN('exec'), { type: 'custom', name: 'apply_patch', format: { type: 'text' } }] },
  { type: 'namespace', name: 'clock', description: 'time', tools: [{ ...FN('exec'), description: 'exec again' }] }] };
const SAY = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] };
const toolDefs = async (home) => { const { calls: [call] } = await query(home, 'session', { id: 'S' }), { defs } = await query(home, 'lane', { id: 'S', lane: call.lane }); return { call, defs: Object.values(defs) }; };

test('additional_tools: tool definitions of the tools section, each its own bytes; no conversation item; nothing lost', async () => {
  const raw = (x) => JSON.stringify(x).replace(/,/g, ' ,  '), say = raw(SAY);
  const body = `{"model":"m","input":[ ${raw(OFFER)} , ${say} ]}`;
  const { defs } = await toolDefs(homeWith([mk(body)]));
  const tools = defs.filter((d) => d.sec === 'tools');
  assert.deepEqual(tools.map((d) => d.name), ['functions', 'exec', 'apply_patch', 'clock', 'exec']);
  assert.ok(tools.every((d) => d.kind === 'tool'));
  const entries = [OFFER.tools[0].description, OFFER.tools[0].tools[0], OFFER.tools[0].tools[1], OFFER.tools[1].description, OFFER.tools[1].tools[0]];
  tools.forEach((d, i) => { const { start, end } = parseTextRef(d.ref); assert.deepEqual(JSON.parse(body.slice(start, end).replace(/ ,  /g, ',')), entries[i], d.name); });
  const msgs = defs.filter((d) => d.sec === 'messages');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].kind, 'text');
  const { start, end } = parseTextRef(msgs[0].ref);
  assert.ok(say.includes(body.slice(start, end)), 'the message still slices its own bytes');
});

test('additional_tools: a tool list of no known shape stays a json block, never dropped', async () => {
  for (const tools of ['x', [1], null, []]) {
    const flat = await messageDefs(JSON.stringify({ model: 'm', input: [{ ...OFFER, tools }, SAY] }));
    assert.deepEqual(flat.map((d) => d.kind), ['json', 'text'], JSON.stringify(tools));
  }
});

test('additional_tools: not a message; every entry is a tool', () => {
  const req = { model: 'm', input: [OFFER, SAY], tools: [FN('own')] };
  assert.deepEqual(reqCountsFor('responses', req).message_count, 1);
  assert.equal(reqCountsFor('responses', req).tool_count, 6);
  assert.equal(RESPONSES.messageCount(req), 1);
  assert.deepEqual(reqCountsFor('responses', { input: [SAY], tools: [FN('own')] }).tool_count, 1);
});

test('a *_tool_result block is in the tool_result bucket and heads as an observation', () => {
  const b = { sec: 'messages', kind: 'x_tool_result', role: 'user', block: { type: 'x_tool_result', tool_use_id: 't', content: 'abc' } };
  assert.equal(compBucket(b), 'tool_result');
  assert.ok(slimBlock(b, null).head.tag.startsWith('observation'));
});
