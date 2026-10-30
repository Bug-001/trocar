// core/metrics.mjs — the cache predicate and its precedence (plan P2.4), what a break cost (P2.5), and the helpers they stand on.
// Constructed steps for every rule; the buckets, the session totals and the server's own steps are in metrics-totals.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cacheState, isBreak, isFailed, refOf, breakSteps, breakCost, usageOf, hitRatio, sessionTotals, CACHE_STATES, QUIET_CAUSES, priceMatch } from '../../src/web/v2/core/metrics.mjs'
import * as analysis from '../../src/web/v2/replay/analysis.mjs'

const U = (read, create, fresh, out = 1) => ({ read, create, fresh, out })
// a step: cause, usage, and overrides (gt, error, status, usage:null …)
const step = (cause, usage = U(90, 0, 10), over = {}) => ({ cacheBreak: { cause, firstCall: cause === 'first-call' }, usage, rec: { request: { model: 'm1' } }, ...over })
const ROW = [3, 15, 3.75, 0.3] // [input, output, cache-write, cache-read] $ / Mtok

// ── P2.4: each state ────────────────────────────────────────────────────────────────────────────────────────────────
test('every state of the predicate, on constructed steps', () => {
  const cases = [
    ['failed', step('append', null, { error: true })],
    ['failed', step('append', U(0, 0, 0), { status: 529 })],
    ['no-usage', step('append', null)],
    ['no-usage', step('append', {}, { norm: { usage: {} } })], // before S2: the server sent zeros and an empty raw usage
    ['first', step('first-call', U(0, 100, 0))],
    ['ttl-rebuild', step('append', U(0, 100, 0), { gt: 'ttl-rebuild' })],
    ['provider-contradiction', step('append', U(0, 0, 100), { gt: 'provider-contradiction' })],
    ['changed', step('content-changed', U(0, 100, 0))],
    ['changed', step('compaction', U(90, 0, 10))], // a hit above 30% does not hide a changed prefix
    ['low-hit', step('append', U(10, 0, 90))],
    ['reused', step('append', U(90, 0, 10))],
    ['reused', step('volatile-nonce-only', U(95, 0, 5))],
    ['unjudged', { cacheBreak: null, usage: U(1, 1, 1) }],
  ]
  for (const [want, s] of cases) assert.equal(cacheState(s).state, want, JSON.stringify(s))
  assert.deepEqual([...new Set(cases.map((c) => c[0]))].sort(), [...CACHE_STATES].sort(), 'every state has a case')
  assert.deepEqual(cacheState(step('volatile-nonce-only', U(95, 0, 5))).quiet, 'volatile-nonce-only')
  assert.deepEqual(cacheState(step('append', U(90, 0, 10))).quiet, 'append')
  assert.equal(cacheState(step('first-call', U(500, 100, 0))).warm, true, 'a first call that already read from a warm prefix says so')
  assert.equal(cacheState(step('first-call', U(0, 100, 0))).warm, false)
})
test('isBreak is exactly the four break states; failed, no-usage, first, reused and unjudged are not breaks', () => {
  const brk = { 'ttl-rebuild': step('append', U(0, 100, 0), { gt: 'ttl-rebuild' }), 'provider-contradiction': step('append', U(0, 0, 100), { gt: 'provider-contradiction' }),
    changed: step('content-changed'), 'low-hit': step('append', U(10, 0, 90)) }
  for (const [state, s] of Object.entries(brk)) { assert.equal(cacheState(s).state, state); assert.equal(isBreak(s), true, state) }
  for (const s of [step('append', null, { error: true }), step('append', null), step('first-call'), step('append'), { cacheBreak: null, usage: U(1, 1, 1) }]) assert.equal(isBreak(s), false, cacheState(s).state)
})
test('the order of the rules: the first match wins', () => {
  // failed beats everything, including a ground-truth claim and a changed prefix
  assert.equal(cacheState(step('content-changed', U(0, 0, 0), { gt: 'provider-contradiction', error: true })).state, 'failed')
  assert.equal(cacheState(step('append', U(0, 0, 0), { gt: 'provider-contradiction', status: 500 })).state, 'failed')
  // no usage beats first, ground truth and a changed cause
  assert.equal(cacheState(step('first-call', null)).state, 'no-usage'); assert.equal(cacheState(step('content-changed', null, { gt: 'ttl-rebuild' })).state, 'no-usage')
  // first beats low hit (a first call has nothing to reuse: its cold start is not a finding)
  assert.equal(cacheState(step('first-call', U(0, 100, 0))).isBreak, false)
  // ground truth beats a changed cause, and a changed cause beats low hit
  assert.equal(cacheState(step('content-changed', U(0, 100, 0), { gt: 'ttl-rebuild' })).state, 'ttl-rebuild')
  assert.equal(cacheState(step('content-changed', U(5, 0, 95))).state, 'changed')
  // the ground truth is read from the step, or from its cacheBreak when the step does not carry it; an explicit null on the step wins
  assert.equal(cacheState({ cacheBreak: { cause: 'append', gt: 'provider-contradiction' }, usage: U(0, 0, 100) }).state, 'provider-contradiction')
  assert.equal(cacheState({ cacheBreak: { cause: 'append', gt: 'provider-contradiction' }, gt: null, usage: U(90, 0, 10) }).state, 'reused')
})
test('a failed step carrying gt:provider-contradiction is failed, not a break; a no-usage step is not a break', () => {
  const failed = step('append', U(0, 0, 0), { gt: 'provider-contradiction', error: true })
  assert.equal(cacheState(failed).state, 'failed'); assert.equal(isBreak(failed), false)
  assert.equal(isBreak(step('append', null, { gt: 'provider-contradiction' })), false)
})
test('the quiet causes are one list, and any other cause is a change', () => {
  assert.deepEqual([...QUIET_CAUSES].sort(), ['append', 'first-call', 'volatile-nonce-only'])
  for (const cause of QUIET_CAUSES) assert.notEqual(cacheState(step(cause, U(90, 0, 10))).state, 'changed', cause)
  for (const cause of ['content-changed', 'compaction', 'tool-array-reorder', 'json-key-reorder', 'a-cause-this-board-has-never-seen']) assert.equal(cacheState(step(cause)).state, 'changed', cause)
})
test('usageOf: usage:null and an empty raw usage are none; create:null stays null; nothing becomes a zero', () => {
  assert.equal(usageOf(step('append', null)), null); assert.equal(usageOf(null), null); assert.equal(usageOf({}), null)
  assert.equal(usageOf({ usage: U(1, 2, 3), norm: { usage: {} } }), null)
  assert.deepEqual(usageOf({ usage: { read: 5, create: null, fresh: 1, out: 1 }, norm: { usage: { input_tokens: 6 } } }), { read: 5, create: null, fresh: 1, out: 1 })
  assert.equal(hitRatio(null), null); assert.equal(hitRatio(U(0, 0, 0)), null, 'nothing measured is not 0%')
  assert.equal(hitRatio({ read: 90, create: null, fresh: 10 }), 0.9)
})

// ── the 缓存对比步 ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('refOf: the nearest earlier call that did not fail; null when there is none', () => {
  const ok = step('append'), bad = step('append', null, { error: true }), http = step('append', null, { status: 429 })
  const calls = [ok, bad, http, step('content-changed')]
  assert.equal(refOf(calls, 3), ok, 'failed calls never established a prefix'); assert.equal(refOf(calls, 1), ok); assert.equal(refOf(calls, 0), null)
  assert.equal(refOf([bad, ok], 1), null)
})
test('breakSteps: the main-lane indices that broke the cache (what the old name answered, now by the predicate)', () => {
  const c = (cause, read, ctx, gt = null) => ({ cacheBreak: { cause, gt }, usage: U(read, 0, ctx - read), ctx })
  assert.deepEqual(breakSteps([c('first-call', 0, 10), c('append', 90, 100), c('content-changed', 10, 100), c('append', 0, 100, 'ttl-rebuild'), c('append', 10, 100)]), [2, 3, 4])
  assert.deepEqual(breakSteps([step('append', null, { error: true, gt: 'provider-contradiction' }), step('append', null)]), [], 'failed and no-usage calls are never flagged')
  assert.deepEqual(breakSteps([]), []); assert.deepEqual(breakSteps(null), [])
  assert.equal(analysis.breakSteps, breakSteps, 'replay/analysis.mjs re-exports the same function')
  for (const n of ['hitRatio', 'hitPct', 'hitTier', 'QUIET_CAUSES', 'priceRow', 'priceMatch', 'costOf', 'sessionCost']) assert.ok(n in analysis, n)
})

// ── P2.5: breakCost ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('breakCost: the tokens the reference had cached and this step did not read, at (write or input price) − read price', () => {
  const ref = { usage: U(1000, 4000, 0) }, cur = { usage: U(0, 5000, 0) }
  const r = breakCost(cur, ref, ROW)
  assert.equal(r.missed, 5000); assert.ok(Math.abs(r.unit - (3.75 - 0.3)) < 1e-12); assert.ok(Math.abs(r.usd - (5000 * 3.45) / 1e6) < 1e-12); assert.equal(r.why, null)
  // a vendor with no cache-write counter on THIS step is priced at the uncached-input price
  const auto = breakCost({ usage: { read: 0, create: null, fresh: 5000, out: 1 } }, ref, ROW)
  assert.ok(Math.abs(auto.unit - (3 - 0.3)) < 1e-12); assert.ok(Math.abs(auto.usd - (5000 * 2.7) / 1e6) < 1e-12)
  // a step that read MORE than the reference cached missed nothing: a real zero, not an unknown
  assert.deepEqual([breakCost({ usage: U(9000, 0, 0) }, ref, ROW).usd, breakCost({ usage: U(9000, 0, 0) }, ref, ROW).missed], [0, 0])
  // a priceMatch result is accepted as the price row
  assert.equal(breakCost(cur, ref, priceMatch({ m1: ROW }, 'm1')).usd, r.usd)
})
test('breakCost: any needed value NULL, or no price row → usd null with the reason, never 0', () => {
  const ref = { usage: U(1000, 4000, 0) }, cur = { usage: U(0, 5000, 0) }
  const none = (why, o = {}) => ({ usd: null, missed: null, unit: null, why, ...o })
  assert.deepEqual(breakCost(cur, null, ROW), none('no-ref'))
  assert.deepEqual(breakCost({ usage: null }, ref, ROW), none('no-usage')); assert.deepEqual(breakCost(cur, { usage: null }, ROW), none('no-usage'))
  assert.deepEqual(breakCost(cur, { usage: { read: 1000, create: null, fresh: 0, out: 1 } }, ROW), none('no-write-counter'))
  assert.deepEqual(breakCost(cur, ref, null), none('no-price', { missed: 5000 })); assert.deepEqual(breakCost(cur, ref, [1, 2, 3]), none('no-price', { missed: 5000 }))
  assert.deepEqual(breakCost(cur, ref, [1, 2, 3, null]), none('no-price', { missed: 5000 }), 'a NULL price in the row is no price')
  assert.deepEqual(breakCost({ usage: { read: null, create: 1, fresh: 1, out: 1 } }, ref, ROW), none('no-usage'))
})

test('a usage whose input counters are all zero is no-usage (zeroInput), whatever the cause says — never a 0% hit, never a break', () => {
  const zero = step('append', U(0, 0, 0))
  assert.equal(cacheState(zero).state, 'no-usage'); assert.equal(cacheState(zero).zeroInput, true); assert.equal(cacheState(zero).hit, null); assert.equal(isBreak(zero), false)
  // row 2 outranks a changed prefix: a zero input with a loud cause is still "nothing measured", not a break
  const loud = step('content-changed', U(0, 0, 0))
  assert.equal(cacheState(loud).state, 'no-usage'); assert.equal(isBreak(loud), false)
  // and it outranks a ground-truth claim too
  assert.equal(cacheState(step('append', U(0, 0, 0), { gt: 'provider-contradiction' })).state, 'no-usage')
  // a measured usage keeps its state; only the all-zero input is "nothing measured"
  assert.equal(cacheState(step('append', U(0, 100, 0))).zeroInput, undefined)
})
test('sessionTotals reports the first failed call of any lane as {lane, i}, token-count rulers excluded', () => {
  const lane = (kind, calls) => ({ kind, calls })
  const m = lane('main', [step('append', U(1, 1, 1)), step('append', U(1, 1, 1), { error: true })])
  const sub = lane('subagent', [step('append', U(1, 1, 1), { error: true })])
  const ruler = lane('probe', [{ rid: 'token-count:0', ts: '2026-10-07T10:00:00.000Z', probe: true, usage: null, error: true }]) // the front end's token-count lane
  const t = sessionTotals([m, sub, ruler], () => null)
  assert.equal(t.failed, 2, 'both model calls, not the ruler')
  assert.equal(t.firstFailed.lane, m); assert.equal(t.firstFailed.i, 1, 'the FIRST one, main lane index')
  const t2 = sessionTotals([m], () => null)
  assert.equal(t2.failed, 1); assert.equal(t2.firstFailed.i, 1)
})

test('isFailed: an error, or a status that is not 200; no status is not a failure', () => {
  assert.equal(isFailed({ error: true }), true); assert.equal(isFailed({ status: 500 }), true); assert.equal(isFailed({ status: 200 }), false)
  assert.equal(isFailed({ status: null, error: false }), false); assert.equal(isFailed(null), false)
})

