import test from 'node:test';
import assert from 'node:assert/strict';
import { boardFlat, boardFlatChat, chatMessageToBlocks, normResp, detect, itemToBlocks, OPENAI_SECTIONS } from '../../src/dissect/openai.mjs';

// D25 · Phase 4 — the OpenAI/Codex dissector maps the Responses API into the ONE cross-provider block
// vocabulary (tools/system/messages + text/tool_use/tool_result/thinking) so the board renders Codex
// with zero board changes: a synthetic request exercising every block kind. Codex through the served board (AC-1) is
// test/web-v2/ac1-real-server.test.mjs.

const REQ = {
  model: 'gpt-5.5',
  instructions: 'You are Codex, a coding agent based on GPT-5.',
  tools: [
    { type: 'function', name: 'exec_command', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
    { type: 'function', name: 'apply_patch', description: 'Edit files', parameters: { type: 'object', properties: { input: { type: 'string' } } } },
    { type: 'web_search', external_web_access: false }, // built-in tool: no name, identified by type
  ],
  input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions>read-only</permissions>' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build a thing' }] },
    { type: 'reasoning', summary: [], encrypted_content: 'gAAAA...ciphertext...' }, // encrypted → opaque
    { type: 'function_call', name: 'apply_patch', call_id: 'c1', arguments: '{"file_path":"/tmp/a.py","input":"print(1)"}' },
    { type: 'function_call_output', call_id: 'c1', output: 'ok, wrote 1 file' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
  ],
  prompt_cache_key: 'sess-abc',
};

test('OPENAI_SECTIONS declares tools → system → messages layout', () => {
  assert.deepEqual(OPENAI_SECTIONS.map((s) => s.id), ['tools', 'system', 'messages']);
});

test('boardFlat maps Responses request into the cross-provider block vocabulary', () => {
  const flat = boardFlat(REQ);
  const bySec = flat.reduce((a, b) => ((a[b.sec] = (a[b.sec] || 0) + 1), a), {});
  assert.deepEqual(bySec, { tools: 3, system: 1, messages: 6 }); // 6 input items → 6 message blocks
  // tools: function names + the built-in tool named by its type
  assert.deepEqual(flat.filter((b) => b.sec === 'tools').map((b) => b.name), ['exec_command', 'apply_patch', 'web_search']);
  assert.ok(flat.find((b) => b.name === 'exec_command').schema.properties.cmd, 'tool schema is verbatim');
  // system = the instructions block, verbatim length
  const sys = flat.find((b) => b.sec === 'system');
  assert.equal(sys.chars, REQ.instructions.length);
  // message block kinds in assembly order
  assert.deepEqual(flat.filter((b) => b.sec === 'messages').map((b) => b.kind),
    ['text', 'text', 'thinking', 'tool_use', 'tool_result', 'text']);
});

test('a message with no content (absent or null) is no block, as content: [] is; the next item keeps its own index (RFC 3.1)', () => {
  const q = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] };
  const flat = boardFlat({ input: [{ type: 'message', role: 'assistant' }, { type: 'message', role: 'assistant', content: null }, q] });
  assert.deepEqual(flat.filter((b) => b.sec === 'messages').map((b) => [b.mi, b.path, b.block]), [[2, ['input', 2, 'content', 0], { type: 'text', text: 'q' }]]);
});

test('encrypted reasoning → opaque (invariant 4); file tool_use → resource ref', () => {
  const flat = boardFlat(REQ);
  const think = flat.find((b) => b.kind === 'thinking');
  assert.equal(think.faithfulness, 'opaque', 'encrypted reasoning is opaque, not verbatim');
  const patch = flat.find((b) => b.kind === 'tool_use');
  assert.equal(patch.toolName, 'apply_patch');
  assert.equal(patch.resKey, 'file::/tmp/a.py', 'a file-writing tool_use links to the file');
  const result = flat.find((b) => b.kind === 'tool_result');
  assert.equal(result.block.content, 'ok, wrote 1 file');
});

test('normResp reconstructs text + usage from raw_sse response.completed', () => {
  const rec = { resp: { kind: 'sse', status: 200, raw_sse: [
    { type: 'response.output_text.delta', delta: 'hel' },
    { type: 'response.output_text.delta', delta: 'lo' },
    { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.5', status: 'completed',
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 2 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] } },
  ] } };
  const n = normResp(rec);
  assert.equal(n.text, 'hello');
  assert.equal(n.model, 'gpt-5.5');
});

// UPDATED 2026-07-19 (audit) — this test ENCODED THE BUG. Its middle assertion required
//     detect({ req_headers: { originator: 'codex_exec' }, endpoint: '/x' }) === true
// i.e. a record with NO BODY and a meaningless endpoint claimed purely on a header string. That is
// exactly the UA/header-keyed detection D25 names as the defect: it claims traffic for the OpenAI
// dissector regardless of what the bytes actually are, and an impostor UA then renders a foreign body
// under OpenAI's vocabulary. Detection is now by WIRE SHAPE, so a header alone no longer claims.
// Checked against the real captures before changing it: every record carrying an `originator` header
// (17/17 opencode, 13/13 codex) ALSO carries `input[]`, so 0 real records lose detection — the
// originator rule was dead weight on real traffic, and only ever load-bearing for this synthetic case.
test('detect: claims by wire shape, not by a header alone; CC → not', () => {
  assert.equal(detect({ req_headers: { 'user-agent': 'codex_exec/0.1' }, endpoint: '/codex/responses' }), true);
  // a header alone, with no wire evidence, MUST NOT claim the record (was: expected true)
  assert.equal(detect({ req_headers: { originator: 'codex_exec' }, endpoint: '/x' }), false);
  // ...but the same originator WITH real Responses bytes is claimed, on the strength of the bytes
  assert.equal(detect({
    req_headers: { originator: 'codex_exec' }, endpoint: '/x',
    req_body: JSON.stringify({ model: 'gpt-5.5', input: [{ type: 'message', role: 'user', content: [] }] }),
  }), true);
  assert.equal(detect({ req_headers: { 'user-agent': 'claude-cli/1.2' }, endpoint: '/v1/messages' }), false);
});

// 3.1 Responses: a reasoning item is read as reasoning whatever keys it carries: one assistant thinking block holding every
// summary and content text, each part apart, opaque when there is no text (invariant 4)
test('a reasoning item is one assistant thinking block with its summary and content text, whatever keys it carries', () => {
  const S = 'weighing the plan 你好', C = 'step one, then step two';
  for (const summary of [[], [{ type: 'summary_text', text: S }], [{ type: 'summary_text', text: S }, { type: 'summary_text', text: 'second thought' }]]) for (const content of [undefined, [], [{ type: 'reasoning_text', text: C }]]) for (const enc of [true, false]) {
    const item = { type: 'reasoning', id: 'rs_1', summary, ...(content ? { content } : {}), ...(enc ? { encrypted_content: 'gAAAAB-ciphertext' } : {}) };
    const at = JSON.stringify(item);
    const flat = boardFlat({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }, item] }).filter((b) => b.mi === 1);
    assert.equal(flat.length, 1, at);
    const [b] = flat;
    assert.deepEqual([b.kind, b.role, b.path], ['thinking', 'assistant', ['input', 1]], at);
    const texts = [...summary.map((x) => x.text), ...(content || []).map((x) => x.text)];
    for (const t of texts) assert.ok(b.block.thinking.includes(t), `${at}: holds ${t}`);
    for (let i = 1; i < texts.length; i++) assert.ok(!b.block.thinking.includes(texts[i - 1] + texts[i]), `${at}: parts ${i - 1} and ${i} stay apart`);
    assert.equal(b.faithfulness, texts.length ? 'verbatim' : 'opaque', at);
  }
});

// 3.1: a content part keeps what it carried, on both OpenAI wires and inside a tool's result. The wire's image shapes on one axis,
// the place the part stands in on the other; a data URL is its data, any other URL stays a URL, media_type never holds a URL.
const IMAGES = [
  ['data:image/png;base64,S_data', { type: 'base64', media_type: 'image/png', data: 'S_data' }],
  ['data:image/jpeg;name=a.jpg;base64,S_data', { type: 'base64', media_type: 'image/jpeg', data: 'S_data' }],
  ['https://x.test/S_url.png?a=1,2', { type: 'url', url: 'https://x.test/S_url.png?a=1,2' }],
  ['data:text/plain,S_not_base64', { type: 'url', url: 'data:text/plain,S_not_base64' }],
];
const chatPart = (url) => ({ type: 'image_url', image_url: { url, detail: 'high' } });
const respPart = (url) => ({ type: 'input_image', image_url: url });
const blocksOf = (rows) => rows.map((x) => x.block);
test('an image part is split into its data or kept as its URL, wherever the part stands', () => {
  for (const [url, source] of IMAGES) {
    const image = { type: 'image', source }, text = { type: 'text', text: 'S_text' };
    assert.deepEqual(blocksOf(chatMessageToBlocks({ role: 'user', content: [chatPart(url)] })), [image]);
    assert.deepEqual(blocksOf(itemToBlocks({ type: 'message', role: 'user', content: [respPart(url)] })), [image]);
    assert.deepEqual(blocksOf(chatMessageToBlocks({ role: 'tool', tool_call_id: 'c', content: [{ type: 'text', text: 'S_text' }, chatPart(url)] })),
      [{ type: 'tool_result', tool_use_id: 'c', content: [text, image] }]);
    for (const type of ['function_call_output', 'custom_tool_call_output']) {
      assert.deepEqual(blocksOf(itemToBlocks({ type, call_id: 'c', output: [{ type: 'input_text', text: 'S_text' }, respPart(url)] })),
        [{ type: 'tool_result', tool_use_id: 'c', content: [text, image] }]);
    }
  }
});

test('a part with no image URL and a part of no known kind stay in the block as the JSON they are', () => {
  for (const part of [{ type: 'input_image', file_id: 'S_file' }, { type: 'input_file', filename: 'S_name', file_data: 'S_data' }]) {
    assert.deepEqual(blocksOf(itemToBlocks({ type: 'message', role: 'user', content: [part] })), [{ type: 'text', text: JSON.stringify(part) }]);
    assert.deepEqual(blocksOf(chatMessageToBlocks({ role: 'user', content: [part] })), [{ type: 'text', text: JSON.stringify(part) }]);
  }
});

test('two different images have different block keys, one image sent twice has one key (Chat and Responses)', () => {
  const key = (url) => boardFlat({ input: [{ type: 'message', role: 'user', content: [respPart(url)] }] }).find((b) => b.kind === 'image').key;
  const chatKey = (url) => boardFlatChat({ messages: [{ role: 'user', content: [chatPart(url)] }] }).find((b) => b.kind === 'image').key;
  for (const k of [key, chatKey]) {
    assert.equal(k(IMAGES[0][0]), k(IMAGES[0][0]));
    assert.notEqual(k('data:image/png;base64,AAAA'), k('data:image/png;base64,BBBB'));
    assert.notEqual(k('https://x.test/a.png'), k('https://x.test/b.png'));
  }
});

test('an assistant refusal in a request is its own text block at its own path', () => {
  const flat = boardFlatChat({ messages: [{ role: 'assistant', content: 'S_text', refusal: 'S_refusal' }, { role: 'assistant', content: null, refusal: 'S_only' }] });
  assert.deepEqual(flat.map((b) => [b.block.text, b.path]), [['S_text', ['messages', 0, 'content']], ['S_refusal', ['messages', 0, 'refusal']], ['S_only', ['messages', 1, 'refusal']]]);
});
