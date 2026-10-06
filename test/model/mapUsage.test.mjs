import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapUsage } from '../../src/model/schema.mjs';

test('mapUsage maps Anthropic usage into canonical roles', () => {
  const raw = {
    input_tokens: 100,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 300,
    output_tokens: 42,
    output_tokens_details: { thinking_tokens: 12 },
    service_tier: 'standard',
    cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
  };
  const u = mapUsage('anthropic', raw);
  assert.equal(u.input_uncached, 100);
  assert.equal(u.cache_read, 2000);
  assert.equal(u.cache_write, 300);
  assert.equal(u.output, 42);
  assert.equal(u.reasoning, 12);
  assert.equal(u.total_input, 2400); // 100 + 2000 + 300
  // invariant 2: every unconsumed provider field survives in extra
  assert.deepEqual(u.extra, {
    service_tier: 'standard',
    cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
  });
});

test('mapUsage: reasoning null when no thinking detail; Anthropic write concept => 0 not null', () => {
  const u = mapUsage('cc', {
    input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5,
  });
  assert.equal(u.reasoning, null);
  assert.equal(u.cache_write, 0); // Anthropic HAS write concept -> 0
  assert.equal(u.total_input, 10);
  assert.deepEqual(u.extra, {});
});

test('mapUsage: unknown provider fails loud (never silently mis-maps)', () => {
  assert.throws(() => mapUsage('openai', {}), /no canonical mapping for provider/);
});

test('openai-responses: input_tokens is total; cached → cache_read; write NULL unless reported', () => {
  const u = mapUsage('openai-responses', { input_tokens: 1000, input_tokens_details: { cached_tokens: 768 }, output_tokens: 40,
    output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 1040 });
  assert.deepEqual([u.input_uncached, u.cache_read, u.cache_write, u.output, u.reasoning, u.total_input], [232, 768, null, 40, 12, 1000]);
  assert.deepEqual(u.extra, { total_tokens: 1040 }, 'unmapped keys survive in extra (invariant 2)');
  const w = mapUsage('openai-responses', { input_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 6, audio_tokens: 1 } });
  assert.deepEqual([w.cache_write, w.input_uncached, w.extra], [6, 4, { input_tokens_details: { audio_tokens: 1 } }], 'a relay-reported write is kept; other detail keys stay');
  assert.equal(mapUsage('openai-responses-ws', { input_tokens: 5 }).total_input, 5);
  assert.equal(mapUsage('openai-responses', { input_tokens: 5 }).reasoning, null, 'no reasoning detail → NULL, not 0');
});
