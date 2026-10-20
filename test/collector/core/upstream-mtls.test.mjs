// test/collector/core/upstream-mtls.test.mjs — RFC 4.6 §引擎 5 · 验收 T18 (D40 audit finding 缓存 mTLS): under the default `all` a trusted agent
// connects to hosts nobody listed — an enterprise gateway, an MCP server — and some of them REQUIRE a client certificate. The
// engine terminates TLS to the upstream first and has no certificate to show, so the upstream answers its handshake with an alert.
// The engine must not break the agent for that: "能解密就想办法解密,不能解密就透明转发并且在日志中记录" .
//   TLS 1.2: the refusal comes before the handshake is done, the client is untouched → fresh connection, ClientHello replayed,
//            the client's own handshake (with its certificate) reaches the real host; the (pid, host) is passed through from then on.
//   TLS 1.3: the refusal comes AFTER the handshake — the client is already on trocar's leaf and cannot be moved. That ONE
//            connection fails; the (pid, host) is passed through from the next connection, and says why (flows/ row + failure event).
// Real engine, real TLS, an upstream that really demands a client certificate (rejectUnauthorized, no certificate → an alert).
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import tls from 'node:tls'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { name, ext, buildCertificate } from '../../../src/collector/core/tls/cert.mjs'
import { closeWithin, within } from '../../helpers/bounded.mjs'

const T = { timeout: 30_000 }
const RESP = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'
const REQ = 'GET /v1/tools HTTP/1.1\r\nHost: gateway.example.test\r\nConnection: close\r\n\r\n'

// A client certificate with no extended key usage, signed by its own CA: valid for the upstream's `ca` check, whatever the purpose.
function clientCert() {
  const ca = createCa({ commonName: 'enterprise client CA' }), loaded = loadCa(ca)
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f
  const now = Date.now()
  const certPem = buildCertificate({ serial, issuer: loaded.subject, subject: name('the agent'), notBefore: new Date(now - 86400e3), notAfter: new Date(now + 86400e3), publicKey, signingKey: loaded.key,
    extensions: [ext.basicConstraints(false), ext.keyUsage(0x80), ext.authorityKeyId(loaded.ski)] })
  return { caPem: ca.certPem, certPem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

async function rig(maxVersion) {
  const upCa = createCa({ commonName: 'gateway CA' }), upIssuer = createLeafIssuer(loadCa(upCa))
  const client = clientCert(); const trocarCa = createCa()
  const saw = []      // what the real host's TLS layer saw: one entry per connection that ended with / without a certificate
  // one certificate, no SNICallback: a context handed out by SNICallback has its own trust store, and `ca` here would not apply to it
  const leaf = upIssuer.issue('gateway.example.test')
  const up = tls.createServer({ key: leaf.keyPem, cert: leaf.certPem + '\n' + upCa.certPem, requestCert: true, rejectUnauthorized: true, ca: client.caPem, maxVersion, ALPNProtocols: ['http/1.1'] }, (s) => {
    saw.push(`served authorized=${s.authorized}`); s.on('error', () => {}); s.once('data', () => s.end(RESP))
  })
  up.on('tlsClientError', (e) => saw.push(`refused ${e.code || e.message}`))
  await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const redirector = createStaticRedirector({ dst: { address: '127.0.0.1', port: up.address().port, family: 4 }, pid: 7, agent: 'claude-code', decrypt: true })
  const flows = [], envelopes = [], failures = []
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(trocarCa)), upstreamCa: upCa.certPem, store: { envelope: (e) => envelopes.push(e), flow: (f) => flows.push(f) }, onFailure: (f) => failures.push(f) })
  const { port } = await engine.listen({})
  // one agent connection: the agent holds a client certificate and trusts both trocar's CA and the gateway's own
  const connect = (servername = 'gateway.example.test') => new Promise((resolve) => {
    let issuer = null, got = ''
    const c = tls.connect({ port, host: '127.0.0.1', servername, ca: [trocarCa.certPem, upCa.certPem], key: client.keyPem, cert: client.certPem, ALPNProtocols: ['http/1.1'], maxVersion }, () => { issuer = c.getPeerX509Certificate().issuer; c.write(REQ) })
    c.on('data', (d) => { got += d.toString('latin1') }); c.on('error', () => {})
    c.on('close', () => resolve({ issuer, got }))
  })
  const settled = (n) => within(new Promise((r) => { const t = setInterval(() => { if (flows.length >= n) { clearInterval(t); r() } }, 5) }), 5000, `${n} flow rows written`)
  return { engine, flows, envelopes, failures, saw, connect, settled, close: async () => { await closeWithin(engine); up.close() } }
}

test('TLS 1.2: an upstream that wants a client certificate is stepped aside — the agent\'s own handshake, certificate and all, reaches it; the host is passed through from then on (§引擎 5, T18)', T, async () => {
  const r = await rig('TLSv1.2')
  const a = await r.connect(); await r.settled(1)
  assert.equal(a.got, RESP, 'the agent got the real answer on its FIRST connection')
  assert.match(a.issuer, /gateway CA/, 'it saw the real host\'s certificate, not trocar\'s')
  assert.deepEqual([r.flows[0].decision, r.flows[0].not_captured], ['splice', 'upstream-handshake'])
  assert.match(r.flows[0].reason, /ALERT_HANDSHAKE_FAILURE/); assert.match(r.flows[0].reason, /client certificate/)
  assert.deepEqual(r.engine.negatives().map((e) => [e.pid, e.host, e.cause]), [[7, 'gateway.example.test', 'upstream-handshake']], 'negative at once: an alert is an answer')
  assert.deepEqual(r.failures.map((f) => [f.where, f.code, f.host, f.cause]), [['engine', 'negative-cache', 'gateway.example.test', 'upstream-handshake']], 'one named failure event (D38)')
  const b = await r.connect(); await r.settled(2)
  assert.equal(b.got, RESP)
  assert.deepEqual([r.flows[1].decision, r.flows[1].not_captured, r.flows[1].reason], ['splice', 'negative-cache', 'upstream-handshake'])
  assert.equal(r.envelopes.length, 0, 'nothing was decrypted, nothing is claimed as captured')
  assert.deepEqual(r.saw.filter((x) => x.startsWith('served')), ['served authorized=true', 'served authorized=true'], 'the host authenticated the agent\'s own certificate both times')
  await r.close()
})

test('TLS 1.3: the refusal comes after the handshake — that ONE connection fails, the next is passed through, and the host is never failed twice (§引擎 5, T18)', T, async () => {
  const r = await rig('TLSv1.3')
  const a = await r.connect(); await r.settled(1)
  assert.equal(a.got, '', 'the client was already on trocar\'s leaf: this connection gets no answer')
  assert.deepEqual([r.flows[0].decision, r.flows[0].not_captured], ['decrypt', 'upstream-handshake'], 'the row says what happened, not an anonymous error')
  assert.match(r.flows[0].reason, /ALERT_CERTIFICATE_REQUIRED/); assert.match(r.flows[0].reason, /passed through/)
  assert.equal(r.flows[0].error.side, 'upstream')
  assert.deepEqual(r.engine.negatives().map((e) => [e.pid, e.host, e.cause]), [[7, 'gateway.example.test', 'upstream-handshake']], 'negative after ONE, not after two')
  assert.deepEqual(r.failures.map((f) => [f.code, f.cause]), [['negative-cache', 'upstream-handshake']])
  // every later connection gets through, with the host's real certificate and its own client certificate
  for (let i = 0; i < 3; i++) {
    const b = await r.connect(); await r.settled(2 + i)
    assert.equal(b.got, RESP, `retry ${i + 1}`); assert.match(b.issuer, /gateway CA/)
    assert.deepEqual([r.flows[1 + i].decision, r.flows[1 + i].not_captured, r.flows[1 + i].reason], ['splice', 'negative-cache', 'upstream-handshake'])
  }
  assert.equal(r.failures.length, 1, 'no further failure events: the host is not failed again')
  assert.deepEqual(r.saw.filter((x) => x.startsWith('served')).length, 3)
  await r.close()
})

test('a host that does not ask for a client certificate is decrypted as before: the new rule is no blanket passthrough (T18)', T, async () => {
  const upCa = createCa({ commonName: 'plain CA' }), upIssuer = createLeafIssuer(loadCa(upCa)), trocarCa = createCa()
  const up = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)), ALPNProtocols: ['http/1.1'] }, (s) => { s.on('error', () => {}); s.once('data', () => s.end(RESP)) })
  await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const redirector = createStaticRedirector({ dst: { address: '127.0.0.1', port: up.address().port, family: 4 }, pid: 7, agent: 'claude-code', decrypt: true })
  const flows = [], envelopes = []
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(trocarCa)), upstreamCa: upCa.certPem, store: { envelope: (e) => envelopes.push(e), flow: (f) => flows.push(f) }, onFailure: () => {} })
  const { port } = await engine.listen({})
  const got = await new Promise((resolve) => { let g = ''; const c = tls.connect({ port, host: '127.0.0.1', servername: 'plain.example.test', ca: trocarCa.certPem, ALPNProtocols: ['http/1.1'] }, () => c.write(REQ)); c.on('data', (d) => { g += d }); c.on('error', () => {}); c.on('close', () => resolve(g)) })
  await within(new Promise((r) => { const t = setInterval(() => { if (flows.length) { clearInterval(t); r() } }, 5) }), 5000, 'flow row')
  assert.equal(got, RESP); assert.deepEqual([flows[0].decision, flows[0].not_captured ?? null], ['decrypt', null]); assert.equal(envelopes.length, 1); assert.deepEqual(engine.negatives(), [])
  await closeWithin(engine); up.close()
})
