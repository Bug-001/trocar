// The query layer's cache verdict and cost arithmetic (2.2 §缓存判定 · §多花怎么算 · §花费; 3.5 row `cache`). Expected values are worked
// by hand from those sections; nothing here is copied from a run of the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { QUIET_CAUSES, CACHE_STATES, usageOf, hitRatio, cacheState, missedOf, cacheFacts, priceMatch, costOf, breakUsd, bucketOf } from '../../src/view/metrics.mjs';
import * as board from '../../web/legacy/core/metrics.mjs';

const U = { read: 80, create: 10, fresh: 10, out: 5 }; // hit 0.8
const LOW = { read: 10, create: 80, fresh: 10, out: 5 }; // hit 0.1
const ZERO_READ = { read: 0, create: 90, fresh: 10, out: 5 };
const append = { cause: 'append' };
const changed = { cause: 'content-changed' };

// Every row of the table in 2.2 §缓存判定, plus `unjudged` (3.5): [row, state, isBreak].
const TABLE = [
  [{ error: 'boom', usage: U, cacheBreak: changed }, 'failed', false],
  [{ error: 'boom', usage: U, cacheBreak: append, gt: 'provider-contradiction' }, 'failed', false],
  [{ usage: null, cacheBreak: changed }, 'no-usage', false],
  [{ usage: { read: 0, create: 0, fresh: 0, out: 3 }, cacheBreak: changed }, 'no-usage', false],
  [{ usage: U, cacheBreak: { firstCall: true } }, 'first', false],
  [{ usage: U, cacheBreak: { cause: 'first-call' } }, 'first', false],
  [{ usage: U, cacheBreak: append, gt: 'ttl-rebuild' }, 'ttl-rebuild', true],
  [{ usage: U, cacheBreak: { cause: 'append', gt: 'ttl-rebuild' } }, 'ttl-rebuild', true],
  [{ usage: U, cacheBreak: append, gt: 'provider-contradiction' }, 'provider-contradiction', true],
  [{ usage: U, cacheBreak: changed }, 'changed', true],
  [{ usage: LOW, cacheBreak: append }, 'low-hit', true],
  [{ usage: U, cacheBreak: append }, 'reused', false],
  [{ usage: U, cacheBreak: { cause: 'volatile-nonce-only' } }, 'reused', false],
  [{ usage: U }, 'unjudged', false],
];

test('2.2 §缓存判定: each table row gives its state and whether it is a break; the states are the closed list in order', () => {
  assert.deepEqual([...CACHE_STATES], ['failed', 'no-usage', 'first', 'ttl-rebuild', 'provider-contradiction', 'changed', 'low-hit', 'reused', 'unjudged']);
  assert.deepEqual([...QUIET_CAUSES].sort(), ['append', 'first-call', 'volatile-nonce-only']);
  for (const [row, state, isBreak] of TABLE) {
    const c = cacheState(row);
    assert.equal(c.state, state, JSON.stringify(row));
    assert.equal(c.isBreak, isBreak, JSON.stringify(row));
  }
  assert.deepEqual(new Set(TABLE.map(([, s]) => s)), new Set(CACHE_STATES), 'the table walks every state');
});

test('2.2 §缓存判定: the first match wins, the row gt beats cacheBreak.gt, and a hit of exactly 0.3 is not low', () => {
  assert.equal(cacheState({ usage: U, cacheBreak: changed, gt: 'ttl-rebuild' }).state, 'ttl-rebuild');
  assert.equal(cacheState({ usage: U, cacheBreak: { firstCall: true }, gt: 'ttl-rebuild' }).state, 'first');
  assert.equal(cacheState({ usage: U, cacheBreak: { cause: 'append', gt: 'ttl-rebuild' }, gt: null }).state, 'reused');
  assert.equal(cacheState({ usage: { read: 30, create: 70, fresh: 0, out: 1 }, cacheBreak: append }).state, 'reused');
});

test('2.2 §缓存判定: a failed step carrying provider-contradiction is failed, not a break; no usage and an all-zero input have a null hit', () => {
  const failed = cacheState({ error: 'boom', usage: U, cacheBreak: append, gt: 'provider-contradiction' });
  assert.deepEqual([failed.state, failed.isBreak, failed.hit], ['failed', false, null]);
  const none = cacheState({ usage: null, cacheBreak: append });
  assert.deepEqual([none.state, none.hit, none.zeroInput], ['no-usage', null, false]);
  const zero = cacheState({ usage: { read: 0, create: null, fresh: 0, out: 3 }, cacheBreak: append });
  assert.deepEqual([zero.state, zero.hit, zero.zeroInput], ['no-usage', null, true]);
});

test('2.2 §缓存判定 last rule: a zero read is the structural change, ttl only with gt, otherwise a low hit of 0', () => {
  assert.equal(cacheState({ usage: ZERO_READ, cacheBreak: changed }).state, 'changed');
  assert.equal(cacheState({ usage: ZERO_READ, cacheBreak: append, gt: 'ttl-rebuild' }).state, 'ttl-rebuild');
  const low = cacheState({ usage: ZERO_READ, cacheBreak: append, gt: null });
  assert.deepEqual([low.state, low.hit], ['low-hit', 0]);
});

test('2.2 hit: read over read + create + fresh; create null counts as 0; only an object is a usage', () => {
  assert.equal(hitRatio({ read: 75, create: 15, fresh: 10 }), 0.75);
  assert.equal(hitRatio({ read: 75, create: null, fresh: 25 }), 0.75);
  assert.equal(hitRatio({ read: 0, create: 0, fresh: 0 }), null);
  assert.equal(hitRatio(null), null);
  assert.equal(usageOf({ usage: U }), U);
  for (const row of [{ usage: null }, {}, { usage: 3 }, null]) assert.equal(usageOf(row), null);
});

test('2.2 §多花怎么算: missed is what the reference cached and this step did not read; the unit follows whether create is a number', () => {
  const row = [3, 15, 3.75, 0.25]; // input, output, cache write, cache read
  const step = { read: 1000, create: 2000, fresh: 5, out: 1 };
  const ref = { read: 3000, create: 1000, fresh: 5, out: 1 };
  assert.deepEqual(missedOf(step, ref, true), { missed: 3000, why: null }); // 3000 + 1000 − 1000
  assert.deepEqual(missedOf({ ...step, read: 9000 }, ref, true), { missed: 0, why: null });
  assert.equal(breakUsd(step, 3000, row), 0.0105); // 3000 × (3.75 − 0.25) ÷ 10⁶
  assert.equal(breakUsd({ ...step, create: null }, 3000, row), 0.00825); // 3000 × (3 − 0.25) ÷ 10⁶
});

test('2.2 §多花怎么算: a value it needs is missing → the reason and no missed', () => {
  const u = { read: 1, create: 2, fresh: 3, out: 4 };
  const noMissed = (r, why) => { assert.equal(r.why, why); assert.equal(r.missed ?? null, null); };
  noMissed(missedOf(u, u, false), 'no-ref');
  noMissed(missedOf(null, u, true), 'no-usage');
  noMissed(missedOf(u, null, true), 'no-usage');
  noMissed(missedOf({ ...u, read: null }, u, true), 'no-usage');
  noMissed(missedOf(u, { ...u, create: null }, true), 'no-write-counter');
  noMissed(missedOf(u, { ...u, read: null }, true), 'no-write-counter');
});

test('2.2 §花费: costOf sums the four counters at their prices; a null create is not counted; no usage is null, not 0', () => {
  const row = [2, 10, 4, 1];
  assert.equal(costOf(row, { fresh: 1e6, out: 1e6, create: 1e6, read: 1e6 }), 17);
  assert.equal(costOf(row, { fresh: 1e6, out: 0, create: null, read: 5e5 }), 2.5);
  assert.equal(costOf(row, null), null);
  assert.equal(costOf(null, U), null);
});

test('2.2 §花费: priceMatch takes the same name first, then the longest key, equal lengths in lexical order; no key is null', () => {
  const r = (n) => [n, n, n, n];
  const table = { opus: r(1), 'opus-5': r(2), 'claude-opus-5': r(3), '': r(4), zz: r(5), aa: r(6) };
  assert.deepEqual(priceMatch(table, 'opus-5'), { row: r(2), key: 'opus-5', exact: true });
  assert.deepEqual(priceMatch(table, 'claude-opus-5-5'), { row: r(3), key: 'claude-opus-5', exact: false });
  assert.deepEqual(priceMatch(table, 'x-zz-aa'), { row: r(6), key: 'aa', exact: false });
  assert.equal(priceMatch({ '': r(4) }, 'anything'), null, 'an empty key occurs in every id and is no key');
  assert.equal(priceMatch(table, 'gpt'), null);
  assert.equal(priceMatch(table, ''), null);
  assert.equal(priceMatch(null, 'opus'), null);
});

test('3.5 row `cache`: along the state axis only the closed keys appear, and null or false is never written', () => {
  const CLOSED = new Set(['state', 'hit', 'break', 'warm', 'quiet', 'zeroInput', 'missed', 'why']);
  const refs = [{ has: true, usage: { read: 500, create: 500, fresh: 0, out: 1 } }, { has: true, usage: { read: 500, create: null, fresh: 0, out: 1 } }, { has: true, usage: null }, { has: false, usage: null }];
  for (const [row, state, isBreak] of TABLE) for (const ref of refs) {
    const f = cacheFacts(row, ref);
    assert.equal(f.state, state);
    for (const [k, v] of Object.entries(f)) {
      assert.ok(CLOSED.has(k), k);
      assert.ok(v !== null && v !== false && v !== undefined, `${k} in ${JSON.stringify(f)}`);
    }
    assert.equal(f.break, isBreak ? true : undefined);
    assert.equal('missed' in f !== 'why' in f, isBreak, 'a break has exactly one of missed and why; no other row has either');
    if (state !== 'first') assert.ok(!('warm' in f));
    if (state !== 'reused') assert.ok(!('quiet' in f));
    if (state !== 'no-usage') assert.ok(!('zeroInput' in f));
  }
});

test('3.5 row `cache`: the facts of one row of each kind', () => {
  const ref = { has: true, usage: { read: 500, create: 500, fresh: 0, out: 1 } };
  assert.deepEqual(cacheFacts({ usage: { read: 100, create: 200, fresh: 100, out: 1 }, cacheBreak: changed }, ref), { state: 'changed', hit: 0.25, break: true, missed: 900 });
  assert.deepEqual(cacheFacts({ usage: U, cacheBreak: changed }, { has: false, usage: null }), { state: 'changed', hit: 0.8, break: true, why: 'no-ref' });
  assert.deepEqual(cacheFacts({ usage: U, cacheBreak: { firstCall: true } }, ref), { state: 'first', hit: 0.8, warm: true });
  assert.deepEqual(cacheFacts({ usage: ZERO_READ, cacheBreak: { firstCall: true } }, ref), { state: 'first', hit: 0 });
  assert.deepEqual(cacheFacts({ usage: U, cacheBreak: { cause: 'volatile-nonce-only' } }, ref), { state: 'reused', hit: 0.8, quiet: 'volatile-nonce-only' });
  assert.deepEqual(cacheFacts({ usage: { read: 0, create: 0, fresh: 0, out: 1 }, cacheBreak: append }, ref), { state: 'no-usage', zeroInput: true });
  assert.deepEqual(cacheFacts({ error: 'boom', usage: null }, ref), { state: 'failed' });
});

test('2.1 cost buckets: main, sub, not billed, and everything else in the background bucket', () => {
  assert.equal(bucketOf('main'), 'main');
  assert.equal(bucketOf('subagent'), 'sub');
  assert.equal(bucketOf('token-count'), null);
  for (const kind of ['monitor', 'notify', 'titlegen', 'quota', 'aux', 'probe', 'a-kind-from-next-year', 'constructor']) assert.equal(bucketOf(kind), 'bg');
});

// Migration guard, not a source of expected values: it only stops the two copies of the algorithm drifting apart while both exist.
// Delete it with web/legacy/core/metrics.mjs when the board moves to the query fields.
test('the two copies agree on generated rows, price tables and usages', () => {
  const usages = [null, U, LOW, ZERO_READ, { read: 30, create: 70, fresh: 0, out: 1 }, { read: 5, create: null, fresh: 5, out: 1 }, { read: 0, create: 0, fresh: 0, out: 1 }];
  const breaks = [undefined, { firstCall: true }, { cause: 'first-call' }, append, changed, { cause: 'volatile-nonce-only' }, { cause: null }, { cause: 'append', gt: 'ttl-rebuild' }];
  for (const usage of usages) for (const cacheBreak of breaks) for (const gt of [undefined, null, 'ttl-rebuild', 'provider-contradiction']) for (const error of [undefined, 'boom']) {
    const row = { usage, cacheBreak, gt, error };
    const a = cacheState(row), b = board.cacheState(row);
    assert.deepEqual({ ...a, zeroInput: !!a.zeroInput }, { state: b.state, isBreak: b.isBreak, hit: b.hit, warm: b.warm, quiet: b.quiet, zeroInput: !!b.zeroInput }, JSON.stringify(row));
    assert.equal(hitRatio(usage), board.hitRatio(usage));
  }
  const table = { opus: [5, 25, 6.25, 0.5], 'opus-5-5': [4, 20, 5, 0.2], '': [1, 1, 1, 1], bad: [1, 2], sonnet: [3, 15, 3.75, 0.3], tonnes: [3, 15, 3.75, 0.3] };
  for (const model of ['opus', 'claude-opus-5-5', 'x-sonnet-tonnes', 'bad', 'gpt', '', null]) {
    const a = priceMatch(table, model);
    assert.deepEqual(a, board.priceMatch(table, model), String(model));
    for (const u of usages) assert.equal(costOf(a && a.row, u), board.costOf(a && a.row, u));
  }
});
