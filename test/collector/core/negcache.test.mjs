// negcache.test.mjs — the (pid, host) negative cache (RFC 4.6 §引擎 5 负缓存, D37).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createNegativeCache, negKey, NEG_RETRY_MS, NEG_RETRY_MAX_MS } from '../../../src/collector/core/engine/negcache.mjs'

test('negative cache: CONSECUTIVE leaf rejections per (pid, host), a used connection resets the count; an upstream-cert failure is negative at once', () => {
  const n = createNegativeCache({ now: () => 42 })
  const meta = { pid: 9, agent: 'kimi' }
  const k = negKey(meta, 'api.moonshot.cn')
  assert.equal(k, '9|api.moonshot.cn')
  n.observe(k, { rejected: true, meta, host: 'api.moonshot.cn' }); n.observe(k, { rejected: false, meta, host: 'api.moonshot.cn' })
  n.observe(k, { rejected: true, meta, host: 'api.moonshot.cn' }); assert.equal(n.has(k), false, 'the used connection in between reset the count')
  assert.equal(n.observe(k, { rejected: true, meta, host: 'api.moonshot.cn' }), true); assert.equal(n.has(k), true)
  assert.equal(n.observe(k, { rejected: true, meta, host: 'api.moonshot.cn' }), false, 'already negative')
  assert.equal(n.has(negKey({ pid: 9 }, 'other.host')), false, 'another host of the same pid is untouched')
  assert.equal(n.get(negKey({ pid: 10 }, 'api.moonshot.cn')), null, 'the same host of another pid is untouched')
  const p = negKey(meta, 'proxy.corp')
  assert.equal(n.mark(p, { cause: 'upstream-cert', meta, host: 'proxy.corp' }), true)
  assert.equal(n.mark(p, { cause: 'upstream-cert', meta, host: 'proxy.corp' }), false)
  assert.deepEqual(n.list().map((e) => [e.host, e.cause, e.rejections]), [['api.moonshot.cn', 'client-rejected-leaf', 2], ['proxy.corp', 'upstream-cert', 1]])
})

test('negative cache: forgetPid drops one pid\'s entries and strikes only (the process exited; a reused pid starts clean)', () => {
  const n = createNegativeCache()
  const a = { pid: 7, agent: 'codex' }, b = { pid: 8, agent: 'codex' }
  n.mark(negKey(a, 'chatgpt.com'), { cause: 'upstream-cert', meta: a, host: 'chatgpt.com' })
  n.observe(negKey(a, 'api.openai.com'), { rejected: true, meta: a, host: 'api.openai.com' })
  n.observe(negKey(b, 'api.openai.com'), { rejected: true, meta: b, host: 'api.openai.com' })
  n.mark(negKey(b, 'chatgpt.com'), { cause: 'upstream-cert', meta: b, host: 'chatgpt.com' })
  assert.equal(n.forgetPid(7), 1)
  assert.deepEqual(n.list().map((e) => e.pid), [8], 'another pid keeps its entries')
  assert.equal(n.strikes(negKey(a, 'api.openai.com')), 0, 'a half-way count is forgotten too')
  assert.equal(n.strikes(negKey(b, 'api.openai.com')), 1, 'another pid keeps its half-way count')
  assert.equal(n.forgetPid(7), 0)
})

// RFC 4.8 §5.5 · W17: a connection through the proxy ingress whose pid could not be found is keyed by its form ("<route>.<group>"), not by `null`
test('negative cache: a connection with no pid is keyed by meta.negKey; forms are apart, and forgetKey clears one form (strikes included) and no other', () => {
  const n = createNegativeCache()
  const a = { pid: null, negKey: 'of.claude-code.cli', agent: 'claude-code' }, b = { pid: null, negKey: 'of.codex.cli', agent: 'codex' }, p = { pid: 5, agent: 'claude-code' }
  assert.equal(negKey(a, 'api.test'), 'of.claude-code.cli|api.test'); assert.equal(negKey(b, 'api.test'), 'of.codex.cli|api.test'); assert.equal(negKey(p, 'api.test'), '5|api.test')
  assert.equal(negKey({ pid: null }, 'h'), 'null|h', 'a flow with neither a pid nor a form is what it always was')
  n.mark(negKey(a, 'api.test'), { cause: 'upstream-cert', meta: a, host: 'api.test' })
  n.observe(negKey(a, 'other.test'), { rejected: true, meta: a, host: 'other.test' }) // half-way
  n.mark(negKey(p, 'api.test'), { cause: 'upstream-cert', meta: p, host: 'api.test' })
  assert.equal(n.has(negKey(b, 'api.test')), false, 'the other form is untouched')
  assert.deepEqual(n.list().map((e) => [e.pid ?? null, e.negKey]), [[null, 'of.claude-code.cli'], [5, '5']])
  assert.equal(n.forgetKey('of.codex.cli'), 0)
  assert.equal(n.forgetKey('of.claude-code.cli'), 1); assert.equal(n.strikes(negKey(a, 'other.test')), 0, 'its half-way count goes too')
  assert.deepEqual(n.list().map((e) => e.negKey), ['5'], 'the pid\'s entry stays')
  assert.equal(n.forgetPid(5), 1)
})

// RFC 4.6 §引擎 5 负缓存 生存期 / 试用期 · W22 (unit half): entries expire at retry_at, a single rejection renews with doubled backoff
const clock = () => { let t = 1000; const c = () => t; c.set = (v) => { t = v }; return c }
const backoff = (r) => Math.min(NEG_RETRY_MS * 2 ** r, NEG_RETRY_MAX_MS)
const meta = { pid: 9, agent: 'kimi' }, host = 'api.test', k = negKey(meta, host)
const reject = (n) => n.observe(k, { rejected: true, meta, host })

test('W22a negative cache: two rejections make an entry that lives NEG_RETRY_MS, and at retry_at has/get/list treat it as gone', () => {
  const now = clock(), n = createNegativeCache({ now })
  reject(n); assert.equal(reject(n), true)
  const e = n.get(k)
  assert.equal(e.retry_at - e.at, NEG_RETRY_MS); assert.equal(e.renewals, 0)
  now.set(e.retry_at - 1); assert.equal(n.has(k), true)
  now.set(e.retry_at)
  assert.equal(n.has(k), false); assert.equal(n.get(k), null); assert.deepEqual(n.list(), [])
})

test('W22b negative cache: after expiry ONE rejection renews; the backoff doubles per renewal and caps at NEG_RETRY_MAX_MS', () => {
  const now = clock(), n = createNegativeCache({ now })
  reject(n); reject(n)
  let r = 0
  for (; backoff(r - 1) < NEG_RETRY_MAX_MS; r++) {
    const e = n.list().find((x) => x.key === k)
    assert.equal(e.renewals, r); assert.equal(e.retry_at - e.at, backoff(r))
    now.set(e.retry_at)
    assert.equal(n.has(k), false)
    assert.equal(reject(n), true, 'probation: one rejection makes it negative again')
  }
  assert.ok(r >= 3, 'the doubling ran at least 1, 2, 4 before the cap')
  assert.equal(n.get(k).retry_at - n.get(k).at, NEG_RETRY_MAX_MS)
})

test('W22c negative cache: an upstream-cert mark expires and renews the same way', () => {
  const now = clock(), n = createNegativeCache({ now })
  const m = () => n.mark(k, { cause: 'upstream-cert', meta, host })
  assert.equal(m(), true)
  for (let r = 0; r < 3; r++) {
    const e = n.get(k)
    assert.equal(e.cause, 'upstream-cert'); assert.equal(e.renewals, r); assert.equal(e.retry_at - e.at, backoff(r))
    assert.equal(m(), false, 'still negative')
    now.set(e.retry_at); assert.equal(n.has(k), false); assert.equal(m(), true)
  }
})

test('W22d negative cache: application data after a renewal clears the history and marks the key as trusting; forgetKey drops both', () => {
  const now = clock(), n = createNegativeCache({ now })
  reject(n); reject(n); now.set(n.get(k).retry_at); reject(n)
  assert.equal(n.get(k).renewals, 1)
  now.set(n.get(k).retry_at); assert.equal(n.has(k), false)
  assert.equal(n.trusts(k), false)
  n.observe(k, { rejected: false, used: true, meta, host })
  assert.equal(n.trusts(k), true); assert.equal(n.trusts(negKey(meta, 'other.test')), false); assert.equal(n.trusts(negKey({ pid: 10 }, host)), false)
  reject(n); assert.equal(reject(n), true, 'the strikes were cleared: two rejections again')
  const e = n.get(k)
  assert.equal(e.renewals, 0); assert.equal(e.retry_at - e.at, NEG_RETRY_MS)
  n.forgetKey(meta.pid)
  assert.equal(n.trusts(k), false); assert.equal(n.holds(meta.pid), false)
})

test('W22e negative cache: holds(who) is true while only the renewal history remains', () => {
  const now = clock(), n = createNegativeCache({ now })
  reject(n); reject(n); now.set(n.get(k).retry_at)
  assert.deepEqual(n.list(), [])
  n.observe(k, { rejected: false, meta, host }) // window elapsed: strikes go, history stays
  assert.equal(n.strikes(k), 0)
  assert.equal(n.holds(meta.pid), true)
  assert.equal(n.holds(10), false)
})
