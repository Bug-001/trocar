// test/view/provider-unknown.test.mjs — D25 · `providerOf()` MUST have an explicit unknown state.
//
// Audit 2026-07-19 (spec 00-overview D25 row, defect (b)): `providerOf()` returned 'cc' for ANY
// record the OpenAI dissector did not claim, so foreign bytes (Gemini / DeepSeek / anything we have
// no dissector for) were run through the CLAUDE CODE dissector and rendered under Claude Code's
// vocabulary with NO label. Observed before the fix, on the Gemini record below:
//   steps: 2 · flat blocks: 1 (a spurious block the CC walker found in Gemini's tools[])
//   usage {read:0,create:0,fresh:0,out:0} · ctx 0
//   step 1 gt: 'provider-contradiction'   ← a FALSE accusation against the provider, invented from
//                                            bytes we never parsed.
// That violates invariant 4 (anything not faithfully represented MUST be labelled IN PLACE) and is
// the exact "plausible but wrong" outcome the project ranks as worse than a visible failure.
// Contract (3.1:44): a record no adapter claims MUST land in a labelled "unrecognized" state and be
// COUNTED — MUST NOT be silently dropped, and MUST NOT borrow a known harness's identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSession } from '../../src/view/assemble.mjs';

// Real-shaped Gemini generateContent traffic: `contents[]` + `systemInstruction`, google-genai UA.
// Nothing here is Anthropic and nothing is OpenAI — we have no dissector for it.
const gemini = (id, ts) => ({
  id, is_llm_call: true, ts_request: ts, method: 'POST',
  endpoint: '/v1beta/models/gemini-3-pro:streamGenerateContent',
  req_headers: { 'x-session-id': 'sess-gem', 'user-agent': 'google-genai-sdk/1.2.0 gl-python/3.12' },
  req_body: JSON.stringify({
    systemInstruction: { parts: [{ text: 'You are a helpful assistant.' }] },
    contents: [{ role: 'user', parts: [{ text: 'hello world' }] }],
    tools: [{ functionDeclarations: [{ name: 'read_file', parameters: { type: 'object' } }] }],
  }),
  resp: { kind: 'sse', status: 200, usageMetadata: { promptTokenCount: 812, candidatesTokenCount: 44 } },
});

test('foreign traffic is labelled unknown, NOT rendered through the CC dissector', () => {
  const A = assembleSession([gemini('g1', '2026-07-19T00:00:00Z'), gemini('g2', '2026-07-19T00:00:01Z')]);
  assert.equal(A.provider, 'unknown', 'an unrecognized harness MUST report provider=unknown');
  assert.ok(A.unknown, 'MUST carry an `unknown` descriptor the frontend can render a banner from');
  // counted, not dropped (3.1:44)
  assert.equal(A.unknown.records, 2, 'unrecognized records MUST be COUNTED, not silently dropped');
  // the evidence a human needs to see WHAT it was, without us pretending to have parsed it
  assert.deepEqual(A.unknown.endpoints, ['/v1beta/models/gemini-3-pro:streamGenerateContent']);
  assert.deepEqual(A.unknown.userAgents, ['google-genai-sdk/1.2.0 gl-python/3.12']);
  assert.equal(typeof A.unknown.reason, 'string');
  assert.match(A.unknown.reason, /dissector/i, 'the reason MUST say we have no dissector for it');
});

test('unknown traffic fabricates NO blocks, NO usage and NO ground-truth accusation', () => {
  const A = assembleSession([gemini('g1', '2026-07-19T00:00:00Z'), gemini('g2', '2026-07-19T00:00:01Z')]);
  // The regression that made this urgent: the CC walker found 1 bogus block in Gemini's tools[] and
  // then accused the provider of contradicting its own cache accounting.
  const gts = (A.steps || []).map((s) => s.gt);
  assert.ok(!gts.includes('provider-contradiction'),
    'MUST NOT accuse a provider of contradiction from bytes we never dissected');
  assert.equal((A.steps || []).length, 0, 'MUST NOT emit CC-shaped steps for undissected bytes');
  assert.equal((A.lanes || []).length, 0, 'MUST NOT emit a CC conversation lane for undissected bytes');
  assert.equal(A.stats.calls, 0, 'MUST NOT report parsed-call stats it did not parse');
});

test('a real Claude Code session is still detected as cc (no regression)', () => {
  // Same shape as the frozen CC fixtures: claude-cli UA, Anthropic system[]/messages[] body.
  const cc = {
    id: 'c1', is_llm_call: true, ts_request: '2026-07-19T00:00:00Z', endpoint: '/v1/messages?beta=true',
    req_headers: { 'x-claude-code-session-id': 's1', 'user-agent': 'claude-cli/2.1.209', 'anthropic-version': '2023-06-01' },
    req_body: JSON.stringify({
      model: 'claude-opus-4-8', max_tokens: 32000,
      system: [{ type: 'text', text: 'You are Claude Code' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }],
    }),
    resp: { kind: 'sse', status: 200, usage: { input_tokens: 10, output_tokens: 5 } },
  };
  const A = assembleSession([cc]);
  assert.equal(A.provider, 'cc');
  assert.ok(!A.unknown, 'a recognized CC session carries no unknown banner');
  assert.equal((A.steps || []).length, 1, 'CC still renders its call');
  assert.ok((A.steps[0].flat || []).length > 0, 'CC still renders verbatim blocks');
});
