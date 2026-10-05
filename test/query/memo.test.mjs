import test from 'node:test';
import assert from 'node:assert/strict';
import { createLru, memoKey, memoize, RENDER_STRATEGY_VERSION } from '../../src/query/memo.mjs';

test('createLru: MRU touch + bounded eviction', () => {
  const lru = createLru(2);
  lru.set('a', 1); lru.set('b', 2);
  assert.equal(lru.get('a'), 1);       // touch a → MRU
  lru.set('c', 3);                      // evicts b (LRU), not a
  assert.equal(lru.has('b'), false);
  assert.equal(lru.get('a'), 1);
  assert.equal(lru.get('c'), 3);
  assert.equal(lru.size, 2);
});

test('memoKey: keyed by (session, source sig, strategy version)', () => {
  assert.equal(memoKey('s1', 'sig9'), `s1|sig9|${RENDER_STRATEGY_VERSION}`);
  assert.notEqual(memoKey('s1', 'sigA'), memoKey('s1', 'sigB')); // source change → new key
});

test('memoize: computes once per key, recomputes on key change', () => {
  const lru = createLru(4);
  let calls = 0;
  const f = memoize(lru, (id, sig) => memoKey(id, sig), (id) => { calls++; return { id, calls }; });
  const a1 = f('s1', 'v1'); const a2 = f('s1', 'v1');
  assert.equal(calls, 1, 'same key → computed once');
  assert.equal(a1, a2, 'same cached object');
  f('s1', 'v2'); // source changed → recompute
  assert.equal(calls, 2);
});
