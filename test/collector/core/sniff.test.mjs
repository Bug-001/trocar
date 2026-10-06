import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'; import tls from 'node:tls'
import { classify, parseClientHello, parseHead } from '../../../src/collector/core/engine/sniff.mjs'

async function captureClientHello(opts) {
  const server = net.createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const got = new Promise((resolve) => server.on('connection', (s) => {
    let b = Buffer.alloc(0)
    s.on('data', (d) => { b = Buffer.concat([b, d]); if (parseClientHello(b).complete) { resolve(b); s.destroy() } })
  }))
  const c = tls.connect({ port: server.address().port, host: '127.0.0.1', ...opts }); c.on('error', () => {})
  const b = await got; server.close(); return b
}

test('ClientHello: SNI and ALPN are extracted', async () => {
  const hello = await captureClientHello({ servername: 'api.anthropic.com', ALPNProtocols: ['h2', 'http/1.1'] })
  assert.equal(classify(hello), 'tls')
  assert.deepEqual(parseClientHello(hello), { complete: true, sni: 'api.anthropic.com', alpn: ['h2', 'http/1.1'] })
})

test('ClientHello: incomplete until the last byte, then complete when split byte-by-byte', async () => {
  const hello = await captureClientHello({ servername: 'relay.test' })
  for (let i = 1; i < hello.length; i++) assert.equal(parseClientHello(hello.subarray(0, i)).complete, false, `at ${i}`)
  assert.equal(parseClientHello(hello).sni, 'relay.test')
})

test('ClientHello: no SNI (IP literal) and no ALPN', async () => {
  const hello = await captureClientHello({})
  assert.deepEqual(parseClientHello(hello), { complete: true, sni: null, alpn: null })
})

test('classify and parseHead: CONNECT, plain HTTP, unknown, need-more', () => {
  const connect = Buffer.from('CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\nProxy-Authorization: Basic eDp5\r\n\r\n')
  assert.equal(classify(connect), 'connect')
  const h = parseHead(connect)
  assert.equal(h.startLine, 'CONNECT api.openai.com:443 HTTP/1.1')
  assert.deepEqual(h.headers[1], ['Proxy-Authorization', 'Basic eDp5'])
  assert.equal(h.headLength, connect.length)
  assert.equal(classify(Buffer.from('POST /v1/messages HTTP/1.1\r\n')), 'http')
  assert.equal(classify(Buffer.from('SSH-2.0-OpenSSH_9.6\r\n')), 'unknown')
  assert.equal(classify(Buffer.from('PO')), 'need-more')
  assert.equal(parseHead(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n')), null)
})

test('classify: a SOCKS4 or SOCKS5 first byte is a proxy prelude (D37)', () => {
  assert.equal(classify(Buffer.from([5])), 'socks'); assert.equal(classify(Buffer.from([4, 1, 0, 80])), 'socks')
  assert.equal(classify(Buffer.from([0x16])), 'need-more'); assert.equal(classify(Buffer.from([0x06, 0x00])), 'unknown')
})
