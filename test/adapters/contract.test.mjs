import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry, collectExtra } from '../../src/adapters/contract.mjs';

const fake = (name, priority, claim) => ({ name, priority, detect: (r) => claim(r) });

test('collectExtra dumps unconsumed keys and counts them', () => {
  const obj = { a: 1, b: 2, novel: 3 };
  const { extra, unmapped_count } = collectExtra(obj, ['a', 'b']);
  assert.deepEqual(extra, { novel: 3 });
  assert.equal(unmapped_count, 1);
});

test('collectExtra: consuming every key yields empty extra / count 0', () => {
  const { extra, unmapped_count } = collectExtra({ a: 1 }, new Set(['a']));
  assert.deepEqual(extra, {});
  assert.equal(unmapped_count, 0);
});

test('collectExtra invariant: canonical-keys ∪ extra-keys == obj keys; count == |extra keys|', () => {
  const obj = { a: 1, b: 2, c: 3, d: 4 };
  const consumed = ['a', 'c'];
  const { extra, unmapped_count } = collectExtra(obj, consumed);
  const reconstructed = new Set([...consumed, ...Object.keys(extra)]);
  assert.deepEqual([...reconstructed].sort(), Object.keys(obj).sort());
  assert.equal(unmapped_count, Object.keys(extra).length);
});

test('dispatch routes a record to the single claiming adapter', () => {
  const reg = createRegistry();
  reg.register(fake('cc', 10, (r) => r.who === 'cc'));
  reg.register(fake('codex', 10, (r) => r.who === 'codex'));
  const res = reg.dispatch({ id: 'r1', who: 'cc' });
  assert.equal(res.status, 'claimed');
  assert.equal(res.adapter.name, 'cc');
  assert.equal(res.conflict, undefined); // single claim → no conflict
});

test('unclaimed record is quarantined + counted, never dropped/thrown', () => {
  const reg = createRegistry();
  reg.register(fake('cc', 10, () => false));
  const res = reg.dispatch({ id: 'r2', who: 'unknown' });
  assert.equal(res.status, 'quarantine');
  assert.equal(reg.stats().quarantined, 1);
});

test('multiple claims -> highest-priority wins AND a conflict is reported (not silent)', () => {
  const reg = createRegistry();
  reg.register(fake('low', 1, () => true));
  reg.register(fake('high', 5, () => true));
  const res = reg.dispatch({ id: 'r3' });
  assert.equal(res.status, 'claimed');
  assert.equal(res.adapter.name, 'high');
  assert.ok(res.conflict);
  assert.deepEqual(res.conflict.claimants.sort(), ['high', 'low']);
  assert.equal(res.conflict.chosen, 'high');
  assert.equal(res.conflict.record_id, 'r3');
  assert.equal(reg.stats().conflicts.length, 1);
});

test('a throwing detect() is treated as no-claim (a broken adapter never crashes dispatch)', () => {
  const reg = createRegistry();
  reg.register(fake('boom', 10, () => {
    throw new Error('bad adapter');
  }));
  const res = reg.dispatch({ id: 'r4' });
  assert.equal(res.status, 'quarantine');
  assert.equal(reg.stats().quarantined, 1);
});

test('register rejects an adapter missing name or detect()', () => {
  const reg = createRegistry();
  assert.throws(() => reg.register({ name: 'x' }), /need name \+ detect/);
  assert.throws(() => reg.register({ detect: () => true }), /need name \+ detect/);
});
