import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect, ccUsage } from '../../src/adapters/cc.mjs';
import { mapUsage } from '../../src/model/schema.mjs'; // canonical mapping lives in 3.2, imported (not reimplemented in cc.mjs)
import { ccLlmRecord, ccControlRecord, nonCcRecord } from '../fixtures/cc-record.mjs';

test('detect claims CC llm + control records, rejects non-CC', () => {
  assert.equal(detect(ccLlmRecord()), true); // x-claude-code-session-id header
  assert.equal(detect(ccControlRecord()), true); // claude-cli UA on the control plane
  assert.equal(detect(nonCcRecord()), false); // python-requests UA, no CC marker
});

test('detect also claims a header-less CC record via a system-prompt marker', () => {
  const headerless = ccLlmRecord({
    env: { req_headers: { 'user-agent': 'some-proxy/1.0' } },
    req: { system: [{ type: 'text', text: 'cc_is_subagent=true' }] },
  });
  assert.equal(detect(headerless), true);
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
