// test/dissect/rule-blocks.test.mjs — the one block description rule code reads (5.1 §动作「按块改跨 provider」).
// Requests are generated along the wire's own axes (content shape × text encoding); every marked string must come
// out as exactly one block whose paths lead back to it. The fixtures' request bodies are the regression seeds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleBlocksOf, ruleBlocksFor } from '../../src/dissect/registry.mjs';
import { ccLlmRecord, ccControlRecord } from '../fixtures/cc-record.mjs';
import { inference, preD40 } from '../fixtures/d40-records.mjs';

const SECTIONS = ['tools', 'system', 'messages'];
const KINDS = new Set(['tool', 'system', 'text', 'tool_use', 'server_tool_use', 'tool_result', 'thinking', 'image', 'json']);
const MARK = 'T§';
const ENCODINGS = [(s) => s, (s) => `中文 ${s}`, (s) => `🎉 ${s} "q"\n\\`];

const walk = (root, path) => path.reduce((n, k) => (n == null ? undefined : n[k]), root);
const reaches = (root, path) => {
  let n = root;
  for (const k of path) { if (n === null || typeof n !== 'object' || !Object.hasOwn(n, k)) return false; n = n[k]; }
  return true;
};
const isPrefix = (a, b) => a.length <= b.length && a.every((k, i) => k === b[i]);
const marked = (v) => (typeof v === 'string' ? (v.includes(MARK) ? [v] : []) : v && typeof v === 'object' ? Object.values(v).flatMap(marked) : []);

function assertContract(req, blocks) {
  let last = 0;
  for (const b of blocks) {
    assert.ok(SECTIONS.includes(b.section), `section ${b.section}`);
    assert.ok(KINDS.has(b.kind), `kind ${b.kind}`);
    assert.equal(typeof b.role, 'string');
    assert.equal(typeof b.name, 'string');
    const rank = SECTIONS.indexOf(b.section);
    assert.ok(rank >= last, 'tools, then system, then messages');
    last = rank;
    assert.equal(b.text === null, b.text_path === null, 'text and text_path are null together');
    if (b.text_path) { assert.ok(reaches(req, b.text_path)); assert.equal(walk(req, b.text_path), b.text); }
    assert.ok(Array.isArray(b.remove_path) && b.remove_path.length > 0 && reaches(req, b.remove_path), JSON.stringify(b));
  }
  // removing one block never takes another with it
  blocks.forEach((a, i) => blocks.forEach((b, j) => {
    if (i !== j) assert.ok(!isPrefix(a.remove_path, b.remove_path), `${a.remove_path} also removes ${b.remove_path}`);
  }));
  // every readable string of the request is one block's text: no block silently missing
  assert.deepEqual(blocks.map((b) => b.text).filter((t) => t && t.includes(MARK)).sort(), marked(req).sort());
}

const png = { type: 'base64', media_type: 'image/png', data: 'AAAA' };
const ANTHROPIC = (t) => {
  const tool = { name: 'Read', description: t('tool'), input_schema: { type: 'object' } };
  const use = { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: '/a' } };
  return [
    { system: t('sys'), messages: [{ role: 'user', content: t('str') }] },
    { tools: [tool, { type: 'web_search_20250305', name: 'web_search' }], system: [{ type: 'text', text: t('s1') }, { type: 'text', text: t('s2') }], messages: [] },
    { messages: [{ role: 'user', content: [{ type: 'text', text: t('a') }, t('bare'), { type: 'image', source: png }, { type: 'document', source: png }] }] },
    { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: t('think'), signature: 'sig' }, { type: 'redacted_thinking', data: 'x' }, use] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: t('res') }] }] },
    { messages: [{ role: 'assistant', content: [use] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1',
      content: [{ type: 'text', text: t('r1') }, { type: 'image', source: png }, { type: 'text', text: t('r2') }] }] }] },
    { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1' }, { type: 'tool_result', tool_use_id: 'u1', content: [] }] }] },
    { messages: [{ role: 'assistant', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }, { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'u' }] }] }] },
    { messages: [null, { role: 'user' }, { role: 'user', content: [null] }] },
    {},
  ];
};
const RESPONSES = (t) => {
  const tools = [{ type: 'function', name: 'shell', description: t('tool'), parameters: {} }, { type: 'web_search' }];
  return [
    { instructions: t('sys'), input: t('bare input') },
    { tools, instructions: t('sys'), input: [] },
    { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: t('a') }, { type: 'input_image', image_url: 'data:x' }, { type: 'refusal', refusal: t('no') }] },
      { role: 'developer', content: t('str') }, t('bare item')] },
    { input: [{ type: 'reasoning', summary: [], encrypted_content: 'cipher' },
      { type: 'function_call', name: 'shell', arguments: '{"cmd":"not text"}', call_id: 'c1' },
      { type: 'function_call_output', call_id: 'c1', output: t('res') }] },
    { input: [{ type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' },
      { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: t('r1') }, { type: 'input_image', image_url: 'data:x' }] }] },
    { input: [{ type: 'web_search_call', id: 'w1', status: 'completed' }, { type: 'x_note', note: 1 }, null] },
    {},
  ];
};
const CHAT = (t) => {
  const tools = [{ type: 'function', function: { name: 'shell', description: t('tool'), parameters: {} } }];
  const call = { id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"not text"}' } };
  return [
    { tools, messages: [{ role: 'system', content: t('sys') }, { role: 'developer', content: [{ type: 'text', text: t('dev') }] }, { role: 'user', content: t('str') }] },
    { messages: [{ role: 'user', content: t('u') }, { role: 'system', content: t('late') }, { role: 'user', content: [{ type: 'text', text: t('a') }, { type: 'image_url', image_url: { url: 'data:x' } }, t('bare')] }] },
    { messages: [{ role: 'assistant', reasoning_content: t('think'), content: t('said'), tool_calls: [call] }, { role: 'tool', tool_call_id: 'c1', content: t('res') }] },
    { messages: [{ role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: t('r1') }, { type: 'text', text: t('r2') }] }] },
    { messages: [{ role: 'assistant', content: null }, { role: 'assistant', content: [{ type: 'refusal', refusal: t('no') }] }, null] },
    { messages: [] },
    {},
  ];
};
const WIRES = { anthropic: ANTHROPIC, 'openai-responses': RESPONSES, 'openai-chat': CHAT };
const requests = (wire) => ENCODINGS.flatMap((enc) => WIRES[wire]((s) => enc(MARK + s)));

for (const wire of Object.keys(WIRES)) {
  test(`${wire}: every generated request keeps the block contract`, () => {
    const f = ruleBlocksOf(wire);
    for (const req of requests(wire)) assertContract(req, f(req));
  });
}

test('a tool_result carries its tool\'s name through the id, \'\' with no such call in the request', () => {
  const results = (wire, req) => ruleBlocksOf(wire)(req).filter((b) => b.kind === 'tool_result').map((b) => b.name);
  assert.deepEqual(results('anthropic', { messages: [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'early' }, { type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'lost' }] }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] }] }), ['Read', '']);
  assert.deepEqual(results('openai-responses', { input: [{ type: 'function_call', name: 'shell', arguments: '{}', call_id: 'a' },
    { type: 'function_call_output', call_id: 'a', output: 'r' }, { type: 'function_call_output', call_id: 'x', output: 'r' }] }), ['shell', '']);
  assert.deepEqual(results('openai-chat', { messages: [{ role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'shell', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'r' }, { role: 'tool', tool_call_id: 'x', content: 'r' }] }), ['shell', '']);
});

test('a call\'s arguments are its text where the wire holds them as one string; encrypted reasoning and structured input have none', () => {
  for (const wire of ['openai-responses', 'openai-chat']) for (const req of requests(wire)) for (const b of ruleBlocksOf(wire)(req)) {
    assert.ok(!/cipher/.test(b.text ?? ''));
    if (b.kind === 'tool_use') { assert.doesNotThrow(() => JSON.parse(b.text)); assert.equal(b.text_path.at(-1), 'arguments'); }
  }
  for (const req of requests('anthropic')) for (const b of ruleBlocksOf('anthropic')(req)) if (b.kind === 'tool_use') assert.equal(b.text_path, null);
  const object = { input: [{ type: 'function_call', name: 'f', arguments: { q: 1 }, call_id: 'c' }] };
  assert.equal(ruleBlocksOf('openai-responses')(object)[0].text_path, null);
});

test('Chat: a system or developer message is in the system section wherever it stands', () => {
  const req = { messages: [{ role: 'user', content: 'u' }, { role: 'developer', content: 'd' }, { role: 'system', content: [{ type: 'text', text: 's' }] }] };
  const blocks = ruleBlocksOf('openai-chat')(req);
  assert.deepEqual(blocks.map((b) => [b.section, b.kind, b.text]), [['system', 'system', 'd'], ['system', 'system', 's'], ['messages', 'text', 'u']]);
});

test('the fixtures\' request bodies are read through ruleBlocksFor', () => {
  for (const rec of [ccLlmRecord(), inference({ id: 'i', text: `${MARK}hello` })]) {
    const req = JSON.parse(rec.req_body), blocks = ruleBlocksFor({ endpoint: rec.endpoint, req_body: rec.req_body });
    assert.ok(blocks.length > 0);
    for (const b of blocks) if (b.text_path) assert.equal(walk(req, b.text_path), b.text);
    assert.deepEqual(blocks.map((b) => b.section), [...blocks.map((b) => b.section)].sort((x, y) => SECTIONS.indexOf(x) - SECTIONS.indexOf(y)));
  }
  const cc = ruleBlocksFor(ccLlmRecord());
  assert.equal(cc.find((b) => b.kind === 'tool_result').name, 'Read');
});

test('a WebSocket response.create reads as the Responses request of the same shape', () => {
  for (const req of requests('openai-responses')) {
    const body = { type: 'response.create', ...req, input: req.input ?? [] };
    const ws = ruleBlocksFor({ endpoint: '/v1/responses', transport: 'ws', req_body: JSON.stringify(body) });
    assert.deepEqual(ws, ruleBlocksOf('openai-responses')(body));
  }
});

test('anything but a model call has no blocks', () => {
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'x' }] });
  for (const rec of [
    { endpoint: '/v1/messages/count_tokens', req_body: body },
    { endpoint: '/v1beta/models/gemini-2.5-pro:generateContent', req_body: JSON.stringify({ contents: [{ parts: [{ text: 'x' }] }] }) },
    { endpoint: '/v1/chat/completions', req_body: '{"messages":[{"role":"user","cont' },
    { endpoint: '/v1/messages', req_body: null },
    ccControlRecord(), preD40({ id: 'p' }), null,
  ]) assert.equal(ruleBlocksFor(rec), null, JSON.stringify(rec?.endpoint));
  for (const format of ['ws-handshake', 'gemini', 'constructor', null, undefined]) assert.equal(ruleBlocksOf(format), null);
});
