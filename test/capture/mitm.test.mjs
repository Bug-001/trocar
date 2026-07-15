import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createMitmProxy } from '../../src/capture/mitm.mjs'

// Ephemeral CA + leaf for api.anthropic.com (the atrace-mkca recipe; import-only, throwaway dir).
// This is the offline reproduction of the CA maker: it NEVER touches the login keychain
// and NEVER sets a system trust flag (RFC 4.1 line 53 / §采集安全#3). The §验收5 "CA 无系统信任"
// keychain assertion is deferred to src/capture/onboard.mjs (macOS-host-specific sub-unit).
function makeCerts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-ca-'))
  const P = (f) => path.join(dir, f)
  execFileSync('openssl', ['genrsa', '-out', P('ca.key'), '2048'], { stdio: 'ignore' })
  execFileSync('openssl', ['req', '-x509', '-new', '-nodes', '-key', P('ca.key'), '-sha256', '-days', '3', '-subj', '/CN=asight test CA', '-out', P('ca.crt')], { stdio: 'ignore' })
  execFileSync('openssl', ['genrsa', '-out', P('leaf.key'), '2048'], { stdio: 'ignore' })
  execFileSync('openssl', ['req', '-new', '-key', P('leaf.key'), '-subj', '/CN=api.anthropic.com', '-out', P('leaf.csr')], { stdio: 'ignore' })
  fs.writeFileSync(P('leaf.ext'), 'subjectAltName=DNS:api.anthropic.com\nextendedKeyUsage=serverAuth\n')
  execFileSync('openssl', ['x509', '-req', '-in', P('leaf.csr'), '-CA', P('ca.crt'), '-CAkey', P('ca.key'), '-CAcreateserial', '-days', '3', '-sha256', '-extfile', P('leaf.ext'), '-out', P('leaf.crt')], { stdio: 'ignore' })
  return { caCert: fs.readFileSync(P('ca.crt')), leaf: { key: fs.readFileSync(P('leaf.key')), cert: fs.readFileSync(P('leaf.crt')) } }
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }

test('MITM: decrypts + records the target host, blind-tunnels (never decrypts) the rest', async () => {
  const { caCert, leaf } = makeCerts()

  // mock "real api" behind TLS with the leaf cert (SAN api.anthropic.com)
  const mockApi = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, saw_len: b.length })) })
  })
  const apiPort = await listen(mockApi)

  const envelopes = []
  let blindCalled = false
  const proxy = createMitmProxy({
    targetHost: 'api.anthropic.com',
    leaf,
    onEnvelope: (e) => envelopes.push(e),
    // inject a DIRECT connector to the local mock (offline harness — no 7897/CONNECT)
    connectUpstream: (_opts, cb) => { const s = tls.connect({ host: '127.0.0.1', port: apiPort, servername: 'api.anthropic.com', ca: caCert }, () => cb(null, s)); s.on('error', cb) },
    // inject a blind tunnel that echoes: proves non-target bytes flow but are never decrypted
    blindTunnel: (_hostPort, client) => { blindCalled = true; client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); client.on('data', (d) => client.write(d)) },
  })
  const pxPort = await listen(proxy)

  // ── target host: CONNECT api.anthropic.com, TLS with the leaf, send a request ──
  const targetResp = await new Promise((resolve, reject) => {
    const sock = net.connect(pxPort, '127.0.0.1', () => sock.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n'))
    sock.once('data', () => {
      const t = tls.connect({ socket: sock, servername: 'api.anthropic.com', ca: caCert }, () => {
        const body = JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'ping' }] })
        t.write(`POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nauthorization: Bearer sk-ant-oat-SECRET\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`)
      })
      let out = ''
      t.on('data', (d) => (out += d)); t.on('end', () => resolve(out)); t.on('error', reject)
    })
    sock.on('error', reject)
  })
  assert.match(targetResp, /"ok":true/) // client got the real response through the MITM

  // ── non-target host: CONNECT example.com, push a probe through the blind tunnel ──
  const PROBE = 'PROBE-MARKER-XYZ'
  const echoed = await new Promise((resolve, reject) => {
    const sock = net.connect(pxPort, '127.0.0.1', () => sock.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'))
    let phase = 0, out = ''
    sock.on('data', (d) => {
      if (phase === 0) { phase = 1; sock.write(PROBE); return }
      out += d.toString()
      if (out.includes(PROBE)) resolve(out)
    })
    sock.on('error', reject)
  })

  await new Promise((r) => setTimeout(r, 50))
  // selective-decrypt (RFC 4.1 §验收4): target host decrypted+recorded ...
  const llm = envelopes.filter((e) => e.is_llm_call)
  assert.equal(llm.length, 1)
  assert.equal(typeof llm[0].req_body, 'string') // D10: verbatim captured string (adapter parses it)
  assert.deepEqual(JSON.parse(llm[0].req_body).messages, [{ role: 'user', content: 'ping' }])
  assert.equal(llm[0].capture, 'mitm')
  assert.equal(llm[0].req_headers.authorization, '<redacted>')
  // ... while the non-target host went through the blind tunnel: bytes flowed, NOTHING recorded
  assert.ok(blindCalled)
  assert.ok(echoed.includes(PROBE))
  assert.equal(envelopes.filter((e) => JSON.stringify(e).includes(PROBE)).length, 0)
  assert.ok(!JSON.stringify(envelopes).includes('SECRET'))

  proxy.close(); mockApi.close()
})
