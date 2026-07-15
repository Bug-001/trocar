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
