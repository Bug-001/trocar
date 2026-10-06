// test/helpers/seven-shapes.mjs — one representative request per v1 harness (RFC 4.6 R2 / R3 read half). SYNTHETIC:
// the header names and body keys follow RFC 3.4's table and 4.6's notes (the same rows src/dissect/harnesses.mjs
// reads), not a capture of the real program. The real harnesses run on the test machines (plan (e)); until then a shape here
// is a claim about the wire, not evidence of it. What makes the envelopes real is the path they take: client →
// the collector's exchange tee and record store (test/helpers/tee-proxy.mjs) → the mock upstream.
// Exports only (node --test loads every .mjs under test/).
const turns = (sid, turn) => {
  const out = [];
  for (let i = 0; i <= turn; i++) {
    out.push({ role: 'user', content: `q${i} for ${sid} — ünïcode` });
    if (i < turn) out.push({ role: 'assistant', content: `a${i}` }); // a stateless client resends the history
  }
  return out;
};
const TOOL_A = { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } };
const TOOL_C = { type: 'function', function: { name: 'bash', parameters: { type: 'object' } } };
const anth = (sys, sid, turn, extra = {}) => JSON.stringify({ model: 'mock-model', max_tokens: 64, stream: true, system: sys, tools: [TOOL_A], messages: turns(sid, turn), ...extra });
const chat = (sys, sid, turn, extra = {}) => JSON.stringify({ model: 'mock-model', stream: true, stream_options: { include_usage: true },
  messages: [{ role: 'system', content: sys }, ...turns(sid, turn)], tools: [TOOL_C], ...extra });
const AV = { 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
const JSON_CT = { 'content-type': 'application/json' };

export const CODEX_WS_TERMINAL = [{ pathSuffix: '/responses', patterns: ['^\\{"type":"(response\\.(completed|failed|incomplete)|error)"'] }];

// Shape = { harness (3.2 id), agent (proc.agent), host (SNI), path, wire (wire format), ws?, synthesized?,
//           headers(sid) → object, body(sid, turn) → the exact request text }
export const SEVEN = Object.freeze([
  { harness: 'cc', agent: 'claude-code', host: 'api.anthropic.com', path: '/v1/messages?beta=true', wire: 'anthropic',
    headers: (sid) => ({ ...AV, 'x-claude-code-session-id': sid, 'user-agent': 'claude-cli/2.1.0 (external, cli)' }),
    body: (sid, turn) => anth([{ type: 'text', text: 'You are Claude Code.' }, { type: 'text', text: 'cwd: /repo', cache_control: { type: 'ephemeral' } }], sid, turn, { metadata: { user_id: 'acct-opaque' } }) },
  { harness: 'codex', agent: 'codex', host: 'chatgpt.com', path: '/backend-api/codex/responses', wire: 'openai-responses-ws', ws: true,
    headers: (sid) => ({ 'session-id': sid, 'thread-id': 'T-' + sid, originator: 'codex_cli_rs' }),
    body: null }, // WebSocket: messages are built in the test from previous_response_id
  { harness: 'opencode', agent: 'opencode', host: 'openrouter.ai', path: '/api/v1/chat/completions', wire: 'openai-chat',
    headers: (sid) => ({ ...JSON_CT, 'x-opencode-session-id': sid, 'session-id': sid }),
    body: (sid, turn) => chat('You are opencode.', sid, turn) },
  { harness: 'kimi', agent: 'kimi-code', host: 'api.kimi.com', path: '/coding/v1/messages?beta=true', wire: 'anthropic',
    headers: () => ({ ...AV }),
    body: (sid, turn) => anth('You are Kimi Code.', sid, turn, { metadata: { user_id: sid } }) },
  { harness: 'dsh', agent: 'dsh', host: 'api.deepseek.com', path: '/anthropic/v1/messages', wire: 'anthropic',
    headers: (sid) => ({ ...AV, 'x-deepseek-harness-session-id': sid, 'x-deepseek-harness-user-id': 'u1' }),
    body: (sid, turn) => anth([{ type: 'text', text: 'You are dsh.' }], sid, turn, { dsh_session_log: { session: { id: sid, origin: 'user', delegationDepth: 0 } }, dsh_plugin_packages: [] }) },
  { harness: 'hermes', agent: 'hermes', host: 'llm.internal.test', path: '/v1/chat/completions', wire: 'openai-chat', synthesized: true,
    headers: () => ({ ...JSON_CT }), // a custom endpoint: no session key anywhere → synthesized (3.4 合成键, gate G11)
    body: (sid, turn) => chat(`You are Hermes. Task ${sid}.`, sid, turn) },
  { harness: 'zcode', agent: 'z-code', host: 'open.bigmodel.cn', path: '/api/anthropic/v1/messages', wire: 'anthropic',
    headers: (sid) => ({ ...AV, 'x-session-id': sid, 'x-zcode-session-type': 'main' }),
    body: (sid, turn) => anth('You are Z-Code.', sid, turn) },
]);
