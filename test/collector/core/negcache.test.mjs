// negcache.test.mjs — the (pid, host) negative cache (RFC 4.6 §引擎 5 负缓存, D37).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createNegativeCache, negKey } from '../../../src/collector/core/engine/negcache.mjs'

test('negative cache: CONSECUTIVE leaf rejections per (pid, host), a used connection resets the count; an upstream-cert failure is negative at once', () => {
  const n = createNegativeCache({ now: () => 42 })
  const meta = { pid: 9, agent: 'kimi' }
  const k = negKey(meta, 'api.moonshot.cn')
  assert.equal(k, '9|api.moonshot.cn')
  n.observe(k, { rejected: true, meta, host: 'api.moonshot.cn' }); n.observe(k, { rejected: false, meta, host: 'api.moonshot.cn' })
  n.observe(k, { rejected: true, meta, host: 'api.moonshot.cn' }); assert.equal(n.has(k), false, 'the used connection in between reset the count')
  assert.equal(n.observe(k, { rejected: true, meta, host: 'api.moonshot.cn' }), true); assert.equal(n.has(k), true)
  assert.equal(n.observe(k, { rejected: true, meta, host: 'api.moonshot.cn' }), false, 'already negative')
  assert.deepEqual(n.get(k), { pid: 9, agent: 'kimi', host: 'api.moonshot.cn', key: k, cause: 'client-rejected-leaf', rejections: 2, at: 42 })
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
