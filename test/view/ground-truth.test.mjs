import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSession } from '../../src/view/assemble.mjs';

// RFC 3.3:65 / D17④ — the independent byte-truth moat. The board's ground-truth flag MUST come from a
// REAL full SHA-256 over the verbatim prefix bytes (not the demo's 32-bit structural proxy). This builds a
// 2-call session whose call #2 re-sends call #1's context verbatim + an appended turn, so the shared
// prefix is byte-identical; we then vary call #2's usage to exercise each verdict.
const TOOLS = [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { p: { type: 'string' } } } }];
const SYS = [{ type: 'text', text: 'You are a coding assistant.' }];

function twoCallSession(call2Usage) {
  const mk = (id, messages, usage) => ({
    id, is_llm_call: true, ts_request: `2026-07-16T00:00:0${id.slice(-1)}Z`,
    request_headers: { 'x-claude-code-session-id': 's-gt', 'user-agent': 'claude-cli/1.2' },
    request: { model: 'claude-opus-4', system: SYS, tools: TOOLS, messages, message_count: messages.length, tool_count: 1, context_chars: 100 },
    response: { status: 200, usage },
  });
  return [
    mk('req_1', [{ role: 'user', content: 'first question' }], { input_tokens: 100, output_tokens: 10 }),
    // call #2 = call #1's context (verbatim) + an appended assistant turn + a new user turn
    mk('req_2', [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ], call2Usage),
  ];
}
function call2Of(session) {
  const A = assembleSession(session);
  return (A.lanes || []).flatMap((l) => l.calls || []).find((c) => c.rec && c.rec.id === 'req_2');
}

test('D17④: byte-identical prefix + read=0 & write=0 → provider-contradiction (real prefix SHA-256)', () => {
  const c2 = call2Of(twoCallSession({ input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 }));
  assert.ok(c2, 'call #2 present');
  assert.equal(c2.cacheBreak.prefixByteIdentical, true, 'the re-sent prefix is proven byte-identical');
  assert.equal(c2.gt, 'provider-contradiction');
  assert.equal(c2.cacheBreak.gtReal, true, 'flag is byte-truth-backed, not the structural proxy');
  assert.match(c2.prefixSha256 || '', /^[0-9a-f]{64}$/, 'prefixSha256 is a full SHA-256 hex (independently recomputable)');
});

test('D17④: byte-identical prefix + read=0 & write>0 → ttl-rebuild (not a contradiction)', () => {
  const c2 = call2Of(twoCallSession({ input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 90, output_tokens: 5 }));
  assert.equal(c2.gt, 'ttl-rebuild');
});

test('D17④: byte-identical prefix + read>0 → null (genuinely reused, no anomaly)', () => {
  const c2 = call2Of(twoCallSession({ input_tokens: 30, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 5 }));
  assert.equal(c2.gt, null);
});

test('D17④: first call has no reusable prefix → gt null, prefixSha256 null', () => {
  const A = assembleSession(twoCallSession({ input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 }));
  const c1 = (A.lanes || []).flatMap((l) => l.calls || []).find((c) => c.rec && c.rec.id === 'req_1');
  assert.equal(c1.gt, null);
  assert.equal(c1.prefixSha256, null);
});

test('D17④: two calls with a truly-identical prefix hash to the SAME prefix_sha256 (recomputable)', () => {
  // prev-vs-cur prefix equality is what backs the flag; assert the hash is stable/deterministic
  const a = call2Of(twoCallSession({ input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 }));
  const b = call2Of(twoCallSession({ input_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 }));
  assert.equal(a.prefixSha256, b.prefixSha256, 'same inputs → same hash (deterministic, independently recomputable)');
});
