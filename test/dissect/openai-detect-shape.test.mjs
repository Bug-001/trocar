// test/dissect/openai-detect-shape.test.mjs — D25: `detect()` MUST key on the WIRE SHAPE, not the UA.
//
// Audit 2026-07-19 (spec 0.0-overview D25 row, defect (a)): `detect()` matched /codex|openai/ against
// the User-Agent, with an endpoint fallback. That is unreliable in BOTH directions:
//   · false negative — OpenCode's real UA is `opencode/1.17.12 (darwin …) ai-sdk/…`, which contains
//     NO "openai". Only the endpoint fallback saved it; a non-standard path would have dropped it.
//   · false positive — any client whose UA merely CONTAINS "openai" was claimed outright, regardless
//     of what it actually speaks. An Anthropic-wire client behind an "openai-proxy" UA got dissected
//     as OpenAI → guaranteed blank/garbage board.
// Fix direction (D25): detect on payload shape, keep the endpoint as corroboration.
//   · `input[]`    → Responses API
//   · `messages[]` → Chat Completions
//
// ⚠ REAL-BYTES CORRECTION to the spec's recorded rule. D25 writes the Responses test as
// "`input[]` + `instructions`". Measured against the real captures, that CONJUNCTION is false:
//     ~/.atrace/trocar/codex-capture.ndjson     13/13 calls: input[] AND instructions  (UA matches)
//     ~/.atrace/trocar/opencode-capture.ndjson  17/17 calls: input[] and NO instructions (UA does not match)
// Requiring `instructions` would fail to claim 100% of real OpenCode traffic — the exact regression
// this audit exists to prevent. `input[]` alone is the discriminator (Anthropic has no top-level
// `input[]`); `instructions` is optional corroboration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detect, wireShape } from '../../src/dissect/openai.mjs';
import { assembleSession } from '../../src/view/assemble.mjs';

// ── real shapes, transcribed from the on-disk captures ────────────────────────────────────────
const opencodeRec = {
  id: 'oc1', is_llm_call: true, ts_request: '2026-07-18T09:29:37Z', endpoint: '/models-proxy/responses',
  req_headers: { 'session-id': 'oc-sess', 'user-agent': 'opencode/1.17.12 (darwin 25.5.0; arm64) ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13' },
  // real OpenCode body keys: model, input, store, prompt_cache_key, tools, tool_choice, stream — NO instructions
  req_body: JSON.stringify({
    model: 'gpt-5.5', store: false, stream: true, prompt_cache_key: 'oc-sess',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the test' }] }],
    tools: [{ type: 'function', name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  }),
  resp: { kind: 'sse', status: 200, raw_sse: [] },
};

const codexRec = {
  id: 'cx1', is_llm_call: true, ts_request: '2026-07-16T00:00:00Z', endpoint: '/codex/responses',
  req_headers: { 'session-id': 'cx-sess', 'user-agent': 'codex_exec/0.5.0' },
  req_body: JSON.stringify({
    model: 'gpt-5.5', instructions: 'You are Codex.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  }),
  resp: { kind: 'sse', status: 200, raw_sse: [] },
};

const anthropicRec = {
  id: 'cc1', is_llm_call: true, ts_request: '2026-07-19T00:00:00Z', endpoint: '/v1/messages?beta=true',
  req_headers: { 'x-claude-code-session-id': 's1', 'user-agent': 'claude-cli/2.1.209', 'anthropic-version': '2023-06-01' },
  req_body: JSON.stringify({
    model: 'claude-opus-4-8', max_tokens: 32000,
    system: [{ type: 'text', text: 'You are Claude Code' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }],
  }),
  resp: { kind: 'sse', status: 200, usage: { input_tokens: 10, output_tokens: 5 } },
};

// OpenAI-compatible Chat Completions (DeepSeek / OpenAI / any ai-sdk openai-compatible client).
const chatRec = {
  id: 'ch1', is_llm_call: true, ts_request: '2026-07-19T00:00:00Z', endpoint: '/v1/chat/completions',
  req_headers: { 'session-id': 'ch-sess', 'user-agent': 'deepseek-cli/0.3.1' },
  req_body: JSON.stringify({
    model: 'deepseek-chat', stream: true,
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'read main.py' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"main.py"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'print(1)' },
      { role: 'assistant', content: 'done' },
    ],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
  }),
  resp: {
    kind: 'sse', status: 200,
    raw_sse: [
      { choices: [{ delta: { content: 'do' } }] },
      { choices: [{ delta: { content: 'ne' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 1024 } } },
    ],
  },
};

// ── detection by shape ─────────────────────────────────────────────────────────────────────────
test('OpenCode Responses traffic is claimed by SHAPE (input[]), with no "openai" in the UA', () => {
  assert.equal(wireShape(opencodeRec), 'responses');
  assert.equal(detect(opencodeRec), true);
  // guard the premise: the UA genuinely does not contain the old substring
  assert.ok(!/openai|codex/i.test(opencodeRec.req_headers['user-agent']));
  // and the body genuinely lacks `instructions` — so the D25 conjunction would have missed it
  assert.equal(JSON.parse(opencodeRec.req_body).instructions, undefined);
});

test('Responses traffic is claimed even on a NON-standard endpoint (shape, not path)', () => {
  const odd = { ...opencodeRec, endpoint: '/some/vendor/v1/proxy-route' };
  assert.equal(wireShape(odd), 'responses', 'shape MUST carry detection when the endpoint fallback cannot');
});

test('Codex Responses traffic still detected (no regression)', () => {
  assert.equal(wireShape(codexRec), 'responses');
  assert.equal(detect(codexRec), true);
});

test('an "openai"-flavoured UA does NOT claim Anthropic-wire traffic', () => {
  const impostor = { ...anthropicRec, req_headers: { ...anthropicRec.req_headers, 'user-agent': 'openai-proxy/2.0 (relay)' } };
  assert.equal(wireShape(impostor), null, 'UA must not override the wire shape');
  assert.equal(detect(impostor), false);
});

test('plain Anthropic traffic is never claimed by the OpenAI dissector', () => {
  assert.equal(wireShape(anthropicRec), null);
  assert.equal(detect(anthropicRec), false);
});

// Mutation-verify caught the two tests above passing with the Anthropic guard REMOVED: they reject
// Anthropic through the ABSENCE of OpenAI signals, never exercising the guard itself. This case does
// exercise it. Aggregator gateways (the very /models listing in the opencode capture advertises models
// serving BOTH `chat` /v1/chat/completions and `claude_native` /v1/messages) can route Anthropic-format
// bodies through a /chat/completions path. The path says "chat"; the BYTES say Anthropic — top-level
// `system`, `input_schema` tools, tool_use/tool_result content blocks. Bytes MUST win. Without the
// guard this body is claimed as chat and its tool_use blocks render as raw JSON text: plausible, wrong.
test('an ANTHROPIC body posted to a /chat/completions path is not claimed (bytes beat path)', () => {
  const rec = {
    id: 'gw1', is_llm_call: true, ts_request: '2026-07-19T00:00:00Z', endpoint: '/v1/chat/completions',
    req_headers: { 'session-id': 'gw', 'user-agent': 'some-gateway/1.0' }, // no anthropic-version header
    req_body: JSON.stringify({
      model: 'claude-opus-4-8', max_tokens: 4096,
      system: [{ type: 'text', text: 'You are Claude.' }],
      tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read a.py' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.py' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'print(1)' }] },
      ],
    }),
    resp: { kind: 'sse', status: 200, usage: { input_tokens: 10, output_tokens: 5 } },
  };
  assert.equal(wireShape(rec), null, 'an Anthropic body MUST NOT be claimed as OpenAI chat');
  assert.equal(detect(rec), false);
  // and it must still reach the CC dissector, fully rendered — not the unknown banner
  const A = assembleSession([rec]);
  assert.equal(A.provider, 'cc');
  assert.ok((A.steps[0].flat || []).some((b) => b.kind === 'tool_use'), 'CC renders its tool_use blocks');
});

test('Chat Completions traffic is recognized as the chat wire shape', () => {
  assert.equal(wireShape(chatRec), 'chat');
  assert.equal(detect(chatRec), true);
});

// ── the combination D25 explicitly warns about: claimed by detect(), dropped by the assembler ──
test('Chat Completions traffic is ASSEMBLED, not silently dropped into a blank board', () => {
  const A = assembleSession([chatRec]);
  assert.equal(A.provider, 'openai');
  assert.equal((A.steps || []).length, 1, 'a claimed chat call MUST produce a step, not a blank board');
  const step = A.steps[0];
  assert.ok((step.flat || []).length > 0, 'chat blocks MUST be extracted');
  // tools → system → messages, in the same cross-provider vocabulary as Responses/CC
  const bySec = step.flat.reduce((a, b) => ((a[b.sec] = (a[b.sec] || 0) + 1), a), {});
  assert.equal(bySec.tools, 1, 'the function tool is a tool block');
  assert.equal(bySec.system, 1, 'the system message becomes the system section');
  assert.equal(bySec.messages, 4, 'user + tool_use + tool_result + assistant text');
  assert.deepEqual(step.flat.filter((b) => b.sec === 'messages').map((b) => b.kind),
    ['text', 'tool_use', 'tool_result', 'text']);
  // verbatim tool schema (AC-1) — unwrapped from the chat `function` envelope
  const tool = step.flat.find((b) => b.sec === 'tools');
  assert.equal(tool.name, 'read_file');
  assert.ok(tool.schema.properties.path, 'tool schema is verbatim, not metadata');
  // usage mapped into the NEUTRAL canonical names (zero provider-native names reach the board)
  assert.deepEqual(step.usage, { read: 1024, create: 0, fresh: 176, out: 8 });
  assert.equal(step.norm.text, 'done', 'assistant text rebuilt from the SSE deltas');
});
