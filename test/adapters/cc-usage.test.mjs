import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, ccUsage } from '../../src/adapters/cc.mjs';
import { mapUsage } from '../../src/model/schema.mjs'; // canonical mapping lives in 3.2, imported (not reimplemented in cc.mjs)
import { ccLlmRecord, ccControlRecord, nonCcRecord } from '../fixtures/cc-record.mjs';

test('detect claims Anthropic-wire inference only; control and non-Anthropic records are not CC adapter work', () => {
  assert.equal(detect(ccLlmRecord()), true); // /v1/messages, is_llm_call
  assert.equal(detect(ccControlRecord()), false); // the control plane belongs to the envelope adapter (src/adapters/envelope.mjs)
  assert.equal(detect(nonCcRecord()), false); // /v1/chat/completions is the OpenAI Chat wire
});

test('detect claims a header-less, UA-less Anthropic record by its endpoint (never by UA, 3.1:23)', () => {
  const headerless = ccLlmRecord({ env: { req_headers: { 'user-agent': 'some-proxy/1.0' } } });
  assert.equal(detect(headerless), true);
  assert.equal(detect({ ...headerless, endpoint: '/v1/messages/count_tokens', is_llm_call: false }), false);
  const chat = { ...ccLlmRecord(), endpoint: '/v1/chat/completions', req_body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }) };
  assert.equal(detect(chat), false, 'a Claude UA + session header on Chat bytes is not the Anthropic wire');
});

test('ccUsage reads SSE terminal usage and JSON body usage', () => {
  assert.equal(ccUsage({ kind: 'sse', usage: { input_tokens: 7 } }).input_tokens, 7);
  assert.equal(ccUsage({ kind: 'json', body: { usage: { input_tokens: 9 } } }).input_tokens, 9);
});

test('AC-2: mapUsage(cc, ccUsage(resp)) maps Anthropic usage to canonical columns, numeric-equal', () => {
  const u = mapUsage('cc', ccUsage(ccLlmRecord().resp));
  assert.equal(u.input_uncached, 100);
  assert.equal(u.cache_read, 2000);
  assert.equal(u.cache_write, 50);
  assert.equal(u.output, 30);
  assert.equal(u.reasoning, 12);
  assert.equal(u.total_input, 2150); // 100 + 2000 + 50
});

test('mapUsage dumps unknown usage keys into extra (never dropped)', () => {
  const u = mapUsage('cc', { input_tokens: 1, service_tier: 'standard' });
  assert.deepEqual(u.extra, { service_tier: 'standard' });
});
