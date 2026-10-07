// test/netenv/noproxy.test.mjs — which of a harness's API hosts a NO_PROXY list names (4.6 「eBPF 模式下的网络拓扑」: the proxy keys of an environment are `*_PROXY` and `NO_PROXY`). The usual reading of the
// variable (curl, Go, Node): `*` is everything; an entry is the host itself or a domain it ends with, with or without a leading dot or `*.`; a port is ignored; an address range is not a host name.
import test from 'node:test'
import assert from 'node:assert/strict'
import { noProxyNames } from '../../src/netenv/noproxy.mjs'

test('noProxyNames: the hosts a NO_PROXY list covers — exact, domain suffix (leading dot or *.), `*`, a port ignored, separators comma or space, case ignored — and nothing for a list that names others, an address range or no list', () => {
  const hosts = ['api.anthropic.com', 'chatgpt.com']
  assert.deepEqual(noProxyNames('localhost,.anthropic.com', hosts), ['api.anthropic.com'])
  assert.deepEqual(noProxyNames('anthropic.com', hosts), ['api.anthropic.com'], 'a bare domain covers its subdomains')
  assert.deepEqual(noProxyNames('*.anthropic.com', hosts), ['api.anthropic.com'])
  assert.deepEqual(noProxyNames('API.Anthropic.COM:443 chatgpt.com', hosts), ['api.anthropic.com', 'chatgpt.com'])
  assert.deepEqual(noProxyNames('*', hosts), hosts)
  assert.deepEqual(noProxyNames('example.com,10.0.0.0/8,notanthropic.com', hosts), [], 'a longer name that merely ends in the same letters is another host')
  assert.deepEqual(noProxyNames('', hosts), [])
  assert.deepEqual(noProxyNames(undefined, hosts), [])
  assert.deepEqual(noProxyNames('*', []), [])
})
