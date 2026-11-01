// negcache.test.mjs — the (pid, host) negative cache (RFC 4.6 §引擎 5 负缓存, D37).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createNegativeCache, negKey, NEG_BACKOFF } from '../../../src/collector/core/engine/negcache.mjs'

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
const backoff = (row, r) => Math.min(row.base * 2 ** r, row.max)
const meta = { pid: 9, agent: 'kimi' }, host = 'api.test', k = negKey(meta, host)
const reject = (n) => n.observe(k, { rejected: true, meta, host })
// the ways a key is made negative, by the backoff row each one takes (4.6 §引擎 5: a retry's cost decides, not the cause)
const WAYS = [
  { row: 'costly', how: 'two rejections', first: (n) => { reject(n); return reject(n) }, again: reject },
  { row: 'costly', how: 'a certificate alert', first: (n) => n.mark(k, { cause: 'client-rejected-leaf', meta, host, alert: 'x' }), again: (n) => n.mark(k, { cause: 'client-rejected-leaf', meta, host, alert: 'x' }) },
  ...['upstream-cert', 'upstream-handshake'].flatMap((cause) => [true, false].map((free) => ({ row: free ? 'free' : 'costly', how: `${cause} free=${free}`, first: (n) => n.mark(k, { cause, meta, host, free }), again: (n) => n.mark(k, { cause, meta, host, free }) }))),
]

test('W22a/b negative cache: every way in lives its row\'s base, expires at retry_at, renews on the first new answer, doubling to the row\'s max', () => {
  assert.ok(NEG_BACKOFF.free.base < NEG_BACKOFF.costly.base && NEG_BACKOFF.free.max < NEG_BACKOFF.costly.max, 'a free retry comes back sooner')
  for (const w of WAYS) {
    const row = NEG_BACKOFF[w.row], now = clock(), n = createNegativeCache({ now })
    assert.equal(w.first(n), true, w.how)
    let r = 0
    for (; backoff(row, r - 1) < row.max; r++) {
      const e = n.get(k)
      assert.equal(e.renewals, r, w.how); assert.equal(e.retry_at - e.at, backoff(row, r), w.how)
      now.set(e.retry_at - 1); assert.equal(n.has(k), true, w.how)
      now.set(e.retry_at); assert.equal(n.has(k), false, w.how); assert.deepEqual(n.list(), [], w.how)
      assert.equal(w.again(n), true, `${w.how}: one answer after expiry renews`)
    }
    assert.ok(r >= 3, `${w.how}: the doubling ran before the cap`)
    assert.equal(n.get(k).retry_at - n.get(k).at, row.max, w.how)
  }
})

test('negative cache: forgetAgent drops the named harness\'s keys whole, keeps the others, and null drops every key', () => {
  const n = createNegativeCache()
  const a = { pid: 1, agent: 'codex' }, a2 = { negKey: 'cli.codex', agent: 'codex' }, b = { pid: 2, agent: 'kimi' }
  n.mark(negKey(a, 'h1'), { cause: 'upstream-cert', meta: a, host: 'h1', free: true }); n.mark(negKey(a, 'h2'), { cause: 'upstream-cert', meta: a, host: 'h2' })
  n.mark(negKey(a2, 'h1'), { cause: 'upstream-handshake', meta: a2, host: 'h1' }); n.mark(negKey(b, 'h1'), { cause: 'upstream-cert', meta: b, host: 'h1' })
  n.observe(negKey(a, 'h3'), { rejected: true, meta: a, host: 'h3' })
  n.observe(negKey(a, 'h4'), { rejected: false, used: true, meta: a, host: 'h4' })
  const got = n.forgetAgent('codex')
  assert.deepEqual(got.map((g) => [g.neg_key, g.agent, g.hosts.sort(), g.dropped]), [['1', 'codex', ['h1', 'h2'], 2], ['cli.codex', 'codex', ['h1'], 1]])
  assert.equal(n.strikes(negKey(a, 'h3')), 0, 'the key is forgotten whole'); assert.equal(n.holds(1), false)
  assert.equal(n.trusts(negKey(a, 'h4')), true, 'the process still trusts the leaf where it sent application data')
  assert.deepEqual(n.list().map((e) => e.agent), ['kimi'])
  assert.deepEqual(n.forgetAgent('codex'), [])
  assert.deepEqual(n.forgetAgent(null).map((g) => g.neg_key), ['2']); assert.deepEqual(n.list(), [])
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
  assert.equal(e.renewals, 0); assert.equal(e.retry_at - e.at, NEG_BACKOFF.costly.base)
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
