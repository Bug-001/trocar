import test from 'node:test';
import assert from 'node:assert/strict';
import { boardFlat, canonUsage, normResp, detect, itemToBlocks, OPENAI_SECTIONS } from '../../src/dissect/openai.mjs';
import { assembleSession, sessionIdOf } from '../../src/view/assemble.mjs';

// D25 · Phase 4 — the OpenAI/Codex dissector maps the Responses API into the ONE cross-provider block
// vocabulary (tools/system/messages + text/tool_use/tool_result/thinking) so the board renders Codex
// with zero board changes. First group: synthetic request exercising every block kind. Second group:
// the REAL captured /codex/responses envelope (AC-1 — the board shows the verbatim captured context).

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

test('canonUsage maps OpenAI usage → neutral {read,create,fresh,out}', () => {
  const u = canonUsage({ input_tokens: 13959, input_tokens_details: { cached_tokens: 9088, cache_write_tokens: 0 }, output_tokens: 9 });
  assert.deepEqual(u, { read: 9088, create: 0, fresh: 4871, out: 9 }); // fresh = input - cached
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
  assert.deepEqual(n.canonUsage, { read: 40, create: 0, fresh: 60, out: 2 });
});

test('detect: codex UA / originator / /responses endpoint → openai; CC → not', () => {
  assert.equal(detect({ req_headers: { 'user-agent': 'codex_exec/0.1' }, endpoint: '/codex/responses' }), true);
  assert.equal(detect({ req_headers: { originator: 'codex_exec' }, endpoint: '/x' }), true);
  assert.equal(detect({ req_headers: { 'user-agent': 'claude-cli/1.2' }, endpoint: '/v1/messages' }), false);
});

// ── board path against a D10 envelope (the shape `asight capture --raw-sse` writes for Codex) ───────
// Verbatim capture data is gitignored (**/*.ndjson); this builds the same envelope shape synthetically
// so the test is self-contained while still exercising detect → assembleOpenai → boardFlat + the
// byte-preservation of the captured context (AC-1: the system block equals the wire instructions).
function d10Envelope(req, { sessionId = 'sess-abc', usage } = {}) {
  return {
    id: 'req_1', ts_request: '2026-07-16T00:00:00Z', is_llm_call: true,
    endpoint: '/codex/responses', method: 'POST',
    req_headers: { 'user-agent': 'codex_exec/0.144.0', 'session-id': sessionId, 'thread-id': sessionId },
    req_body: JSON.stringify(req),
    resp: { status: 200, kind: 'sse', raw_sse: [
      { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.5', status: 'completed',
        usage: usage || { input_tokens: 200, input_tokens_details: { cached_tokens: 120 }, output_tokens: 4 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] } },
    ] },
  };
}

test('assembleSession detects Codex and renders a main lane with verbatim context (AC-1)', () => {
  const rec = d10Envelope(REQ);
  assert.equal(sessionIdOf(rec), 'sess-abc', 'codex record groups by its session-id header');
  const A = assembleSession([rec]);
  assert.equal(A.lanes.length, 1);
  assert.equal(A.lanes[0].kind, 'main');
  const call = A.lanes[0].calls[0];
  // AC-1: the system (instructions) block is byte-identical to the captured wire bytes
  const sys = call.flat.find((b) => b.sec === 'system');
  assert.equal(sys.text, REQ.instructions, 'system block equals the captured instructions verbatim');
  // usage mapped to NEUTRAL canonical names (no OpenAI-native names surface on the call)
  assert.deepEqual(call.usage, { read: 120, create: 0, fresh: 80, out: 4 });
  assert.equal(call.ctx, 200, 'ctx = real input tokens from usage');
  assert.equal(call.tools, REQ.tools.length);
});
