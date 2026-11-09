import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapUsage, unmappedUsage } from '../../src/model/schema.mjs';

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
});

test('mapUsage: reasoning null when no thinking detail; Anthropic write concept => 0 not null', () => {
  const u = mapUsage('anthropic', {
    input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5,
  });
  assert.equal(u.reasoning, null);
  assert.equal(u.cache_write, 0); // Anthropic HAS write concept -> 0
  assert.equal(u.total_input, 10);
});

test('mapUsage: unknown provider fails loud (never silently mis-maps)', () => {
  assert.throws(() => mapUsage('openai', {}), /no canonical mapping for provider/);
});

test('anthropic wire: an absent write counter is NULL for any vendor but Anthropic (3.2 D37 note, 3.3:89)', () => {
  const raw = { input_tokens: 100, cache_read_input_tokens: 60, output_tokens: 5 };
  for (const vendor of ['deepseek', 'zai', 'moonshot', null]) {
    const u = mapUsage('anthropic', raw, { vendor });
    assert.deepEqual([u.cache_write, u.total_input], [null, 160], `${vendor}: reported nothing → NULL, not a made-up 0`);
  }
  assert.equal(mapUsage('anthropic', raw, { vendor: 'anthropic' }).cache_write, 0, 'Anthropic always reports it: absent reads as 0');
  assert.equal(mapUsage('anthropic', { ...raw, cache_creation_input_tokens: 7 }, { vendor: 'deepseek' }).cache_write, 7, 'a reported write is kept, whoever reports it');
  assert.equal(mapUsage('anthropic', raw).cache_write, 0, 'no vendor given: unchanged');
});

test('openai-responses: input_tokens is total; cached → cache_read; write NULL unless reported', () => {
  const u = mapUsage('openai-responses', { input_tokens: 1000, input_tokens_details: { cached_tokens: 768 }, output_tokens: 40,
    output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 1040 });
  assert.deepEqual([u.input_uncached, u.cache_read, u.cache_write, u.output, u.reasoning, u.total_input], [232, 768, null, 40, 12, 1000]);
  const w = mapUsage('openai-responses', { input_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 6, audio_tokens: 1 } });
  assert.deepEqual([w.cache_write, w.input_uncached], [6, 4], 'a relay-reported write is kept');
  assert.equal(mapUsage('openai-responses-ws', { input_tokens: 5 }).total_input, 5);
  assert.equal(mapUsage('openai-responses', { input_tokens: 5 }).reasoning, null, 'no reasoning detail → NULL, not 0');
});

test('openai-chat: DeepSeek hit/miss wins over cached_tokens; cache_write NULL', () => {
  const ds = mapUsage('openai-chat', { prompt_tokens: 900, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 260 });
  assert.deepEqual([ds.cache_read, ds.input_uncached, ds.cache_write, ds.output, ds.total_input], [640, 260, null, 30, 900]);
  const oa = mapUsage('openai-chat', { prompt_tokens: 500, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 384, audio_tokens: 0 }, total_tokens: 505,
    completion_tokens_details: { reasoning_tokens: 3 } });
  assert.deepEqual([oa.cache_read, oa.input_uncached, oa.cache_write, oa.reasoning, oa.total_input], [384, 116, null, 3, 500]);
  assert.equal(mapUsage('openai-chat', { prompt_tokens: 9, cached_tokens: 4 }).cache_read, 4, 'Kimi names it at the top level');
});

// 2.6 #18: what Call details lists as not in the counts. The keys each wire's mapping reads are 3.2's table, written here from the spec
const READ = {
  anthropic: ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens', 'output_tokens_details.thinking_tokens'],
  'openai-responses': ['input_tokens', 'input_tokens_details.cached_tokens', 'input_tokens_details.cache_write_tokens', 'output_tokens', 'output_tokens_details.reasoning_tokens'],
  'openai-chat': ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'completion_tokens', 'completion_tokens_details.reasoning_tokens'],
};
const EXTRA = ['service_tier', 'cache_creation.ephemeral_5m_input_tokens', 'vendor_probe_tokens', 'relay.note'];
const nest = (pairs) => { const o = {}; for (const [k, v] of pairs) { const at = k.split('.'); at.slice(0, -1).reduce((x, p) => (x[p] ??= {}), o)[at.at(-1)] = v; } return o; };
test('2.6 #18 unmappedUsage: the keys 3.2 reads are never listed; every other leaf is, with its value; a change to a listed one moves no count', () => {
  for (const [format, read] of Object.entries(READ)) {
    const raw = nest([...read.map((k, i) => [k, 10 + i]), ...EXTRA.map((k, i) => [k, k === 'service_tier' ? 'standard' : k === 'relay.note' ? 'via x' : 3 + i])]);
    const listed = unmappedUsage(format, raw, { vendor: null });
    assert.deepEqual(listed.map(([k]) => k).sort(), [...EXTRA].sort(), format);
    assert.deepEqual(Object.fromEntries(listed).service_tier, 'standard');
    for (const [k] of listed) {
      const moved = nest([...read.map((x, i) => [x, 10 + i]), ...EXTRA.map((x) => [x, x === k ? 999 : 1])]);
      const same = nest([...read.map((x, i) => [x, 10 + i]), ...EXTRA.map((x) => [x, 1])]);
      assert.deepEqual(mapUsage(format, moved, { vendor: null }), mapUsage(format, same, { vendor: null }), `${format} ${k}`);
    }
  }
  assert.deepEqual(unmappedUsage('no-such-wire', { a: 1, b: { c: 'x' } }), [['a', '1'], ['b.c', 'x']], 'a wire with no mapping lists every key');
  assert.deepEqual(unmappedUsage('anthropic', null), []);
  assert.deepEqual(unmappedUsage('anthropic', 7), [['usage', '7']], 'a usage that is no object is one row');
  // a mapping that throws on a changed leaf depends on it: read, never a crash (a mapping that reads an array: .map, .find)
  const fussy = (_p, u) => ({ n: u.list.map((x) => x.n).length, m: u.m });
  assert.deepEqual(unmappedUsage('stub', { list: [{ n: 1 }], m: 2, other: 3 }, {}, fussy), [['other', '3']]);
  assert.deepEqual(unmappedUsage('anthropic', { input_tokens: '1', output_tokens: true, cache_creation: {} }), [['cache_creation', '{}']], 'a value num() reads counts as read; an empty object is a row');
  // a fallback key the preferred one stands in front of is not used on this step: listed (DeepSeek's whole Chat usage)
  const ds = unmappedUsage('openai-chat', { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40, prompt_tokens_details: { cached_tokens: 60 } }).map(([k]) => k);
  assert.deepEqual(ds.sort(), ['prompt_tokens', 'prompt_tokens_details.cached_tokens']);
  assert.deepEqual(unmappedUsage('openai-chat', { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 } }), [], 'without the preferred keys the fallbacks are used');
});
