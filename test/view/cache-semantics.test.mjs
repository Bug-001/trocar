import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSession } from '../../src/view/assemble.mjs';

// RFC 3.3:89 (D37): cache semantics are read by VENDOR (the upstream host), and a vendor row vouches only
// for the wire it was established on. DeepSeek's row comes from its Chat Completions API, so DeepSeek
// through its Anthropic endpoint (dsh) is unknown; an unknown host is unknown, never Anthropic's.

const CASES = [
  // [endpoint, host, cacheSemanticsKnown]
  ['/v1/messages', 'api.anthropic.com', true],
  ['/v1/messages', 'api.deepseek.com', false],
  ['/chat/completions', 'api.deepseek.com', true],
  ['/v1/messages', 'llm.example.invalid', false],
];

const anthropicBody = { model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };
const chatBody = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const anthropicResp = { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
const chatResp = { choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };

test('3.3:89: a call knows its vendor cache semantics only on the wire the vendor row was established on', () => {
  for (const [endpoint, host, known] of CASES) {
    const chat = endpoint === '/chat/completions';
    const rec = {
      id: `r-${host}-${endpoint}`, ts_request: '2026-07-16T00:00:00Z', is_llm_call: true, endpoint, host,
      req_body: JSON.stringify(chat ? chatBody : anthropicBody),
      resp: { kind: 'json', status: 200, body: JSON.stringify(chat ? chatResp : anthropicResp) },
    };
    const s = assembleSession([rec]);
    const calls = [...(s.steps || []), ...(s.streams || []).flatMap((st) => st.calls || []),
      ...(s.lanes || []).flatMap((l) => l.calls || [])].filter((c) => c && c.wire);
    assert.ok(calls.length > 0, `${host}${endpoint}: the board shows the call`);
    for (const c of calls) assert.equal(c.wire.cacheSemanticsKnown, known, `${host}${endpoint}`);
  }
});
