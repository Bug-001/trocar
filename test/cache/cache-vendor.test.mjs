// test/cache/cache-vendor.test.mjs — 3.3:89 (D37: cache labels by VENDOR) + 3.2:124 (NULL prefix facts
// for partial / server_edited contexts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCacheEvents, breakKindFor } from '../../src/cache/cache-events.mjs';

const blk = (seq, text, extra = {}) => ({ seq, content_hash: 'h' + text, text, volatile: false, cache_control: null, ...extra });
const PREV = [blk(0, 'tools'), blk(1, 'sys', { cache_control: { type: 'ephemeral' } })];
const CUR = [...PREV, blk(2, 'user')];
const USAGE = { cache_read: 100, cache_write: 0, total_input: 120 };

test('dsh (Anthropic wire on api.deepseek.com) never gets Anthropic labels; DeepSeek-via-Anthropic is unverified (3.3:89 OPEN)', () => {
  const ev = deriveCacheEvents(PREV, CUR, USAGE, { vendor: 'deepseek', wireFormat: 'anthropic' });
  assert.notEqual(ev.break_kind, 'explicit-breakpoint', 'MUST NOT borrow Anthropic semantics because the wire is Anthropic');
  // the OPEN's recommended default: NULL + 「厂商缓存语义未知」 until a real capture settles it
  assert.deepEqual([ev.break_kind, ev.cache_write_billing, ev.extra.vendor_cache_semantics], [null, null, 'unknown']);
  assert.deepEqual(ev.declared_breakpoints, [1], 'breakpoints are a WIRE fact: the Anthropic wire carries cache_control');
  // the DeepSeek row applies on the wire it was established on
  const chat = deriveCacheEvents(PREV, CUR, USAGE, { vendor: 'deepseek', wireFormat: 'openai-chat' });
  assert.deepEqual([chat.break_kind, chat.cache_write_billing, chat.extra.vendor_cache_semantics], ['automatic-disk', 'none', undefined]);
  assert.equal(chat.declared_breakpoints, null, 'no cache_control on a Chat wire');
});

test('an unknown vendor gets NULL labels plus vendor_cache_semantics=unknown', () => {
  const ev = deriveCacheEvents(PREV, CUR, USAGE, { vendor: null, wireFormat: 'anthropic' });
  assert.deepEqual([ev.break_kind, ev.cache_write_billing, ev.extra.vendor_cache_semantics], [null, null, 'unknown']);
  assert.deepEqual(breakKindFor('moonshot'), { break_kind: null, cache_write_billing: null }, 'MUST NOT borrow Anthropic semantics (3.3:89)');
  const known = deriveCacheEvents(PREV, CUR, USAGE, { vendor: 'anthropic', wireFormat: 'anthropic' });
  assert.deepEqual([known.break_kind, known.cache_write_billing, known.extra.vendor_cache_semantics], ['explicit-breakpoint', 'charged', undefined]);
});

test('partial and server_edited calls get NULL prefix_sha256 and ground_truth_flag', () => {
  for (const contextState of ['partial', 'server_edited']) {
    const ev = deriveCacheEvents(PREV, CUR, { cache_read: 0, cache_write: 0, total_input: 120 }, { vendor: 'anthropic', contextState });
    assert.equal(ev.prefix_sha256, null, contextState);
    assert.equal(ev.ground_truth_flag, null, contextState);
    assert.equal(ev.extra.context_state, contextState);
  }
  const ok = deriveCacheEvents(PREV, CUR, { cache_read: 0, cache_write: 0, total_input: 120 }, { vendor: 'anthropic', contextState: 'reconstructed' });
  assert.match(ok.prefix_sha256, /^[0-9a-f]{64}$/, 'reconstructed stays authoritative (3.2:124)');
  assert.equal(ok.ground_truth_flag, 'provider-contradiction');
  assert.equal(deriveCacheEvents(PREV, CUR, USAGE, { vendor: 'anthropic', contextState: 'complete' }).extra.context_state, undefined);
});

test('legacy callers passing provider still work (back-compat alias)', () => {
  assert.equal(deriveCacheEvents(PREV, CUR, USAGE, { provider: 'anthropic' }).break_kind, 'explicit-breakpoint');
  assert.equal(deriveCacheEvents(PREV, CUR, USAGE, { provider: 'deepseek' }).break_kind, 'automatic-disk');
  assert.equal(deriveCacheEvents(PREV, CUR, USAGE).break_kind, 'explicit-breakpoint', 'no opts = the Phase-1 Anthropic default');
});
