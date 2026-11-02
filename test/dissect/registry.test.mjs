// test/dissect/registry.test.mjs — D37 ①: the wire format is read from the endpoint and the body, never
// from the UA. The board and the ETL both dispatch through this registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wireFormatOf, isWsHandshake } from '../../src/dissect/registry.mjs';
import { detect as ccDetect } from '../../src/dissect/cc.mjs';
import { wireShape } from '../../src/dissect/openai.mjs';

const R = (endpoint, body, extra = {}) => ({ endpoint, is_llm_call: true, req_headers: {}, req_body: body == null ? '' : JSON.stringify(body), ...extra });
const ANTH = { model: 'm', max_tokens: 9, system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: 'x' }] };
const RESP = { model: 'm', instructions: 'i', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }] };
const CHAT = { model: 'm', max_tokens: 9, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'x' }] };

test('wire format by endpoint (relay prefixes and querystrings included)', () => {
  assert.equal(wireFormatOf(R('/v1/messages?beta=true', ANTH)), 'anthropic');      // CC
  assert.equal(wireFormatOf(R('/anthropic/v1/messages', ANTH)), 'anthropic');      // dsh
  assert.equal(wireFormatOf(R('/coding/v1/messages?beta=true', ANTH)), 'anthropic'); // Kimi
  assert.equal(wireFormatOf(R('/api/anthropic/v1/messages', ANTH)), 'anthropic');  // Z-Code
  assert.equal(wireFormatOf(R('/backend-api/codex/responses', RESP)), 'openai-responses');
  assert.equal(wireFormatOf(R('/api/paas/v4/chat/completions', CHAT)), 'openai-chat');
  assert.equal(wireFormatOf(R('/v1/chat/completions', ANTH)), 'anthropic', 'bytes beat path: an Anthropic body behind a Chat gateway path');
});

test('the UA never decides the wire', () => {
  const ua = { req_headers: { 'user-agent': 'claude-cli/2.1', 'x-claude-code-session-id': 'S' } };
  assert.equal(wireFormatOf(R('/v1/responses', RESP, ua)), 'openai-responses');
  assert.equal(wireFormatOf(R('/unknown', {}, ua)), null);
  assert.equal(ccDetect(R('/unknown', {}, ua)), false, 'a Claude UA and session header do not make bytes Anthropic');
});

test('without an endpoint, body shape decides, and the shape detectors are disjoint', () => {
  for (const [body, want] of [[ANTH, 'anthropic'], [RESP, 'openai-responses'], [{ ...CHAT, max_tokens: undefined }, 'openai-chat']]) {
    const r = R('', body);
    assert.equal(wireFormatOf(r), want);
    const claims = [ccDetect(r), wireShape(r) === 'responses', wireShape(r) === 'chat'].filter(Boolean).length;
    assert.equal(claims, 1, `exactly one shape detector claims ${want}`);
  }
});

test('wire formats are disjoint: no record is two formats', () => {
  const corpus = [R('/v1/messages', ANTH), R('/v1/responses', RESP), R('/v1/chat/completions', CHAT), R('', ANTH), R('', RESP)];
  for (const r of corpus) assert.equal(typeof wireFormatOf(r), 'string');
  assert.equal(ccDetect(R('/v1/chat/completions', CHAT)), false, 'max_tokens on a Chat body must not make it Anthropic');
  assert.equal(ccDetect(R('/v1/responses', { ...RESP, system: 'x', messages: [] })), false, 'an input[] body is never Anthropic');
  for (const r of [...corpus, R('/v1/chat/completions', ANTH)]) {
    const claims = [ccDetect(r), wireShape(r) != null].filter(Boolean).length;
    assert.equal(claims, 1, `one dissector claims ${r.endpoint || '(no endpoint)'}`);
  }
});

test('count_tokens is a probe, not inference; Gemini/Bedrock/Vertex are unsupported', () => {
  assert.equal(wireFormatOf(R('/v1/messages/count_tokens', ANTH)), null);
  assert.equal(wireFormatOf(R('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', {})), null);
  assert.equal(wireFormatOf(R('/model/anthropic.claude-3/invoke-with-response-stream', ANTH)), null);
  assert.equal(wireFormatOf(R('/v1/projects/p/locations/us/publishers/anthropic/models/claude:streamRawPredict', ANTH)), null);
  assert.equal(wireFormatOf(R('/model/anthropic.claude-3/invoke', ANTH)), null, 'an unsupported wire is never claimed as Anthropic');
});

test('a WebSocket upgrade (101, or refused with 426) is a handshake, never an inference call', () => {
  const hs = (status) => ({ ...R('/v1/responses', null), method: 'GET', req_headers: { upgrade: 'websocket' }, resp: { status } });
  assert.equal(isWsHandshake(hs(101)), true);
  assert.equal(wireFormatOf(hs(426)), 'ws-handshake');
  assert.equal(wireFormatOf({ ...R('/v1/responses', { type: 'response.create', input: [] }), transport: 'ws' }), 'openai-responses-ws');
  assert.equal(wireFormatOf({ ...R('/v1/realtime', null), transport: 'ws', is_llm_call: false }), null, 'a non-inference WebSocket is no wire format');
});
