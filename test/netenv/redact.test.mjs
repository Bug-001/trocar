// test/netenv/redact.test.mjs — what may be shown of a proxy setting (RFC 1.6 §9.2「永远不印」, §9.5, V46, V52): the credentials of a proxy URL never, a hash instead of the value where a change has to be noticed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { redactProxyUrl, settingSha, parseProxyUrl } from '../../src/netenv/redact.mjs'

test('redactProxyUrl: user:password@ becomes ***@, and nothing else of the credentials, the query or the fragment survives', () => {
  assert.equal(redactProxyUrl('http://alice:pw@proxy.corp:8080'), 'http://***@proxy.corp:8080')
  assert.equal(redactProxyUrl('socks5h://alice@h:1080'), 'socks5h://***@h:1080')
  assert.equal(redactProxyUrl('alice:pw@h:3128'), '***@h:3128', 'no scheme')
  assert.equal(redactProxyUrl('http://h:1/p?token=abc#frag'), 'http://h:1/p…')
  assert.equal(redactProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890', 'nothing to hide: shown as it is')
  assert.equal(redactProxyUrl('http://al:ice:pw@h:1'), 'http://***@h:1', 'a colon in the password')
  assert.equal(redactProxyUrl(undefined), '')
  for (const v of ['http://alice:pw@proxy.corp:8080', 'alice:pw@h', 'http://u:s3cr3t@h/x?k=s3cr3t']) assert.ok(!/alice|pw|s3cr3t/.test(redactProxyUrl(v)), v)
})

test('redactProxyUrl: the credentials end at the LAST @ of the authority (the way a URL parser reads them), so a password with an unescaped @ is hidden whole; an @ after the authority (path, query) is not a credential', () => {
  assert.equal(redactProxyUrl('http://user:p@ssw0rd@proxy.corp:8080'), 'http://***@proxy.corp:8080')
  assert.equal(redactProxyUrl('http://user:p%40ssw0rd@proxy.corp:8080'), 'http://***@proxy.corp:8080', 'escaped')
  assert.equal(redactProxyUrl('user:a@b@c@h:3128'), '***@h:3128', 'no scheme, several @')
  assert.equal(redactProxyUrl('socks5h://u:@@h:1080'), 'socks5h://***@h:1080', 'a password that is @s')
  assert.equal(redactProxyUrl('http://u:pw@h:1/x@y?k=v#f'), 'http://***@h:1/x@y…', 'the @ of the path is a path')
  assert.equal(redactProxyUrl('http://h:1/p@q'), 'http://h:1/p@q', 'no credentials: an @ after the host is not one')
  assert.equal(redactProxyUrl('http://h:1?to=a@b'), 'http://h:1…', 'nor is the query\'s, and the query is left out')
  for (const v of ['http://user:p@ssw0rd@proxy.corp:8080', 'user:a@b@c@h:3128', 'http://u:p%40ssw0rd@h']) assert.ok(!/user|ssw0rd|a@b|p%40/.test(redactProxyUrl(v)), v)
  // what the URL parser takes for the host is what is left shown
  for (const v of ['http://user:p@ssw0rd@proxy.corp:8080', 'user:a@b@c@h:3128']) assert.equal(new URL(/:\/\//.test(v) ? v : `http://${v}`).host, redactProxyUrl(v).replace(/^[a-z0-9]+:\/\//, '').replace(/^\*\*\*@/, ''))
})

test('settingSha: a 64-digit hex hash of the value as written, different for a different value and not holding the value', () => {
  const a = settingSha('http://alice:pw@proxy.corp:8080'), b = settingSha('http://alice:pw@proxy.corp:8081')
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, b)
  assert.equal(a, settingSha('http://alice:pw@proxy.corp:8080'))
  assert.ok(!a.includes('alice'))
})

test('parseProxyUrl: scheme, host and port of what a setting names, a bare host:port as HTTP, the default port of the scheme, and never the credentials', () => {
  assert.deepEqual(parseProxyUrl('http://127.0.0.1:7890'), { scheme: 'http', host: '127.0.0.1', port: 7890 })
  assert.deepEqual(parseProxyUrl('socks5h://[::1]:1080'), { scheme: 'socks5h', host: '::1', port: 1080 })
  assert.deepEqual(parseProxyUrl('proxy.corp:3128'), { scheme: 'http', host: 'proxy.corp', port: 3128 })
  assert.deepEqual(parseProxyUrl('HTTPS://P.example'), { scheme: 'https', host: 'p.example', port: 443 })
  assert.deepEqual(parseProxyUrl('http://alice:pw@h:1'), { scheme: 'http', host: 'h', port: 1 })
  assert.equal(parseProxyUrl('not a url at all'), null)
  assert.equal(parseProxyUrl(''), null)
  assert.equal(parseProxyUrl(undefined), null)
})
