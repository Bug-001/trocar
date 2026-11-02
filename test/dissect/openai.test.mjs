import test from 'node:test';
import assert from 'node:assert/strict';
import { boardFlat, normResp, detect, itemToBlocks, OPENAI_SECTIONS } from '../../src/dissect/openai.mjs';

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
