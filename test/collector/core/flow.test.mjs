import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'; import tls from 'node:tls'; import { X509Certificate } from 'node:crypto'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { handleFlow } from '../../../src/collector/core/engine/flow.mjs'

const upCa = createCa({ commonName: 'upstream test CA' }); const upIssuer = createLeafIssuer(loadCa(upCa))
const asightCa = createCa(); const issuer = createLeafIssuer(loadCa(asightCa))
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))

async function harness({ meta = {}, policy = () => true, upstream }) {
  const upPort = await listen(upstream)
  const envelopes = [], flows = []
  const ctx = { issuer, upstreamCa: upCa.certPem, policy, isRecording: () => true, negCache: new Map(), newFlowId: () => 'f' + flows.length,
    store: { envelope: (e) => envelopes.push(e), flow: (f) => flows.push(f) },
    connectUpstream: (dst) => net.connect(dst.port, dst.address) }
  const engine = net.createServer((c) => handleFlow(c, { dst: { address: '127.0.0.1', port: upPort, family: 4 }, pid: 1, agent: 't', decrypt: true, ...meta }, ctx))
  const port = await listen(engine)
  return { port, envelopes, flows, close: () => { engine.close(); upstream.close() } }
}
const httpsUpstream = (handler) => tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)), ALPNProtocols: ['http/1.1'] }, handler)
const request = (port, ca, raw, opts = {}) => new Promise((resolve, reject) => {
  const c = tls.connect({ port, host: '127.0.0.1', servername: 'upstream.test', ca, ALPNProtocols: ['http/1.1'], ...opts }, () => c.write(raw))
  let got = Buffer.alloc(0); c.on('data', (d) => (got = Buffer.concat([got, d])))
  c.on('end', () => resolve({ got: got.toString('latin1'), cert: new X509Certificate(c.getPeerX509Certificate().raw) })); c.on('error', reject)
})
const REQ = 'POST /v1/messages HTTP/1.1\r\nHost: upstream.test\r\nContent-Length: 13\r\nConnection: close\r\n\r\n{"model":"m"}'
const RESP = 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nX-Odd-Case: KeepMe\r\nContent-Length: 9\r\nConnection: close\r\n\r\n{"ok":1} '.slice(0, -1)

test('decrypt: client sees an asight-issued leaf; both directions byte-identical; one envelope', async () => {
  let seen = ''
  const h = await harness({ upstream: httpsUpstream((s) => s.on('data', (d) => { seen += d.toString('latin1'); if (seen.endsWith('}')) s.end(RESP) })) })
  const r = await request(h.port, asightCa.certPem, REQ)
  h.close()
  assert.equal(seen, REQ); assert.equal(r.got, RESP)
  assert.match(r.cert.issuer, /asight collector CA/)
  assert.equal(h.envelopes.length, 1); assert.equal(h.envelopes[0].req_body, '{"model":"m"}')
  assert.equal(h.flows[0].decision, 'decrypt')
})

test('splice: a process not marked decrypt sees the upstream certificate and nothing is recorded', async () => {
  const h = await harness({ meta: { decrypt: false }, upstream: httpsUpstream((s) => s.on('data', () => s.end(RESP))) })
  const r = await request(h.port, upCa.certPem, REQ)
  h.close()
  assert.match(r.cert.issuer, /upstream test CA/); assert.equal(h.envelopes.length, 0); assert.equal(h.flows[0].decision, 'splice')
})

test('splice: ALPN offering only h2 is never decrypted', async () => {
  const h = await harness({ upstream: tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)), ALPNProtocols: ['h2'] }, (s) => s.end('x')) })
  const r = await request(h.port, upCa.certPem, 'x', { ALPNProtocols: ['h2'] })
  h.close()
  assert.match(r.cert.issuer, /upstream test CA/); assert.equal(h.flows[0].decision, 'splice')
})

test('upstream reset mid-response: client gets exactly the bytes upstream sent, then a reset; error envelope written', async () => {
  const partial = 'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n6\r\ndata:\n\r\n'
  const h = await harness({ upstream: httpsUpstream((s) => s.on('data', () => { s.write(partial); setTimeout(() => s.destroy(), 50) })) })
  const got = await new Promise((resolve) => {
    const c = tls.connect({ port: h.port, host: '127.0.0.1', servername: 'upstream.test', ca: asightCa.certPem }, () => c.write(REQ))
    let b = ''; c.on('data', (d) => (b += d.toString('latin1'))); c.on('close', () => resolve(b)); c.on('error', () => {})
  })
  await new Promise((r) => setTimeout(r, 50)); h.close()
  assert.equal(got, partial)
  assert.equal(h.envelopes.length, 1); assert.equal(h.envelopes[0].error, true)
})

test('CONNECT tunnel: the proxy reply is relayed verbatim, then the inner TLS is decrypted', async () => {
  const origin = httpsUpstream((s) => s.on('data', () => s.end(RESP)))
  const originPort = await listen(origin)
  const proxyReply = 'HTTP/1.1 200 Connection established\r\nProxy-Agent: test-vpn/1.0\r\n\r\n'
  const proxy = net.createServer((c) => c.once('data', () => {
    const o = net.connect(originPort, '127.0.0.1', () => { c.write(proxyReply); c.pipe(o); o.pipe(c) })
  }))
  const h = await harness({ upstream: proxy })
  const result = await new Promise((resolve, reject) => {
    const raw = net.connect(h.port, '127.0.0.1', () => raw.write('CONNECT upstream.test:443 HTTP/1.1\r\nHost: upstream.test:443\r\n\r\n'))
    raw.once('data', (d) => {
      const reply = d.toString('latin1')
      const t = tls.connect({ socket: raw, servername: 'upstream.test', ca: asightCa.certPem }, () => t.write(REQ))
      let b = ''; t.on('data', (x) => (b += x.toString('latin1'))); t.on('end', () => resolve({ reply, b })); t.on('error', reject)
    })
  })
  h.close(); origin.close()
  assert.equal(result.reply, proxyReply); assert.equal(result.b, RESP)
  assert.equal(h.flows[0].decision, 'tunnel'); assert.equal(h.envelopes[0].host, 'upstream.test')
})

test('CONNECT refused by the proxy: the client receives the proxy refusal verbatim', async () => {
  const refusal = 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'
  const h = await harness({ upstream: net.createServer((c) => c.once('data', () => c.end(refusal))) })
  const got = await new Promise((resolve) => {
    const raw = net.connect(h.port, '127.0.0.1', () => raw.write('CONNECT x.test:443 HTTP/1.1\r\n\r\n'))
    let b = ''; raw.on('data', (d) => (b += d)); raw.on('close', () => resolve(b))
  })
  h.close()
  assert.equal(got, refusal)
})

test('client rejects the leaf (does not trust asight CA): negative-cached, next connection spliced', async () => {
  const h = await harness({ upstream: httpsUpstream((s) => s.on('data', () => s.end(RESP))) })
  await request(h.port, upCa.certPem, REQ).catch(() => {})
  await new Promise((r) => setTimeout(r, 50))
  const r = await request(h.port, upCa.certPem, REQ)
  h.close()
  assert.match(r.cert.issuer, /upstream test CA/)
  assert.equal(h.flows[0].reason, 'client-rejected-leaf'); assert.equal(h.flows.at(-1).decision, 'splice')
})

test('client abort mid-flight tears down the upstream socket (acceptance T3)', async () => {
  let upSock = null; let upClosedAt = 0
  // consume the request bytes (a real upstream reads them) so the socket reports close on the RST
  const h = await harness({ upstream: httpsUpstream((s) => { upSock = s; s.on('data', () => {}); s.on('close', () => { upClosedAt = Date.now() }) }) })
  const c = tls.connect({ port: h.port, host: '127.0.0.1', servername: 'upstream.test', ca: asightCa.certPem }, () => c.write(REQ))
  c.on('error', () => {})
  await new Promise((r) => setTimeout(r, 120)) // let the decrypt handshake + REQ reach the upstream
  assert.ok(upSock, 'upstream should have accepted the decrypted connection')
  const t = Date.now(); c.destroy()
  await new Promise((r) => setTimeout(r, 150))
  h.close()
  assert.ok(upClosedAt > 0 && upClosedAt - t < 120, `upstream closed ${upClosedAt - t}ms after client abort`)
})
