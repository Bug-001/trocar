import test from 'node:test'
import assert from 'node:assert/strict'
import tls from 'node:tls'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'

const raw = createCa()
const issuer = createLeafIssuer(loadCa(raw))

test('leaf: strict openssl verify against the CA, 199-day validity, SAN matches', () => {
  const { certPem } = issuer.issue('relay.example.test')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-leaf-'))
  fs.writeFileSync(path.join(dir, 'ca.pem'), raw.certPem); fs.writeFileSync(path.join(dir, 'leaf.pem'), certPem)
  const out = execFileSync('openssl', ['verify', '-x509_strict', '-CAfile', path.join(dir, 'ca.pem'), path.join(dir, 'leaf.pem')]).toString()
  assert.match(out, /OK/)
  const x = new X509Certificate(certPem)
  assert.equal(x.checkHost('relay.example.test'), 'relay.example.test')
  const days = (Date.parse(x.validTo) - Date.parse(x.validFrom)) / 86400e3
  assert.ok(days >= 200 && days <= 202, `validity ${days}`)
})

test('leaf: IP literal gets an IP SAN; contexts are cached per host', () => {
  assert.equal(new X509Certificate(issuer.issue('127.0.0.1').certPem).checkIP('127.0.0.1'), '127.0.0.1')
  const a = issuer.secureContextFor('a.test'); const b = issuer.secureContextFor('a.test')
  assert.equal(a, b)
})

test('leaf: a TLS client that trusts ONLY the CA completes a handshake for any SNI', async () => {
  const server = tls.createServer({ SNICallback: (sni, cb) => cb(null, issuer.secureContextFor(sni)) }, (s) => s.end('hi'))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const got = await new Promise((resolve, reject) => {
    const c = tls.connect({ port: server.address().port, host: '127.0.0.1', servername: 'made-up-relay.test', ca: raw.certPem }, () => {})
    let d = ''; c.on('data', (x) => (d += x)); c.on('end', () => resolve({ d, ok: c.authorized })); c.on('error', reject)
  })
  server.close()
  assert.deepEqual(got, { d: 'hi', ok: true })
})
