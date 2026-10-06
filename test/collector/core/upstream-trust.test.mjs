// The engine verifies the upstream against Node's default store, so NODE_EXTRA_CA_CERTS in the daemon's environment
// is honoured (gate G8: a relay with a private CA needs no asight variable). NODE_EXTRA_CA_CERTS is read once at
// process start, so each case runs the engine in a child process.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'

const src = (p) => JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../../../src/collector/core', p)).href)
// One decrypted flow: an HTTPS upstream signed by the upstream CA, handleFlow with NO upstreamCa, a client that
// trusts the asight CA. Prints the flow record and what the client got.
const CHILD = `
import net from 'node:net'; import tls from 'node:tls'; import fs from 'node:fs'
const { loadCa } = await import(${src('tls/ca.mjs')}); const { createLeafIssuer } = await import(${src('tls/leaf.mjs')})
const { handleFlow } = await import(${src('engine/flow.mjs')}); const { createNegativeCache } = await import(${src('engine/negcache.mjs')})
const [upCa, asightCa] = [process.argv[1], process.argv[2]].map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
const up = createLeafIssuer(loadCa(upCa)); const issuer = createLeafIssuer(loadCa(asightCa))
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)))
const upstream = tls.createServer({ SNICallback: (n, cb) => cb(null, up.secureContextFor(n)), ALPNProtocols: ['http/1.1'] },
  (s) => s.once('data', () => s.end('HTTP/1.1 200 OK\\r\\ncontent-length: 2\\r\\nconnection: close\\r\\n\\r\\nok')))
const upPort = await listen(upstream)
const flows = []
const ctx = { issuer, policy: () => true, isRecording: () => true, negCache: createNegativeCache(), newFlowId: () => 'f', store: { envelope: () => {}, flow: (f) => flows.push(f) }, connectUpstream: (d) => net.connect(d.port, d.address),
  counters: { notCaptured: { h2: 0, httpsProxy: 0, upstreamCert: 0, negative: 0, leafError: 0 } }, failure: () => {} }
let done
const engine = net.createServer((c) => { done = handleFlow(c, { dst: { address: '127.0.0.1', port: upPort, family: 4 }, pid: 1, agent: 't', decrypt: true }, ctx) })
const port = await listen(engine)
const got = await new Promise((resolve) => {
  const c = tls.connect({ port, host: '127.0.0.1', servername: 'relay.asight.test', ca: asightCa.certPem, ALPNProtocols: ['http/1.1'] }, () => c.write('GET / HTTP/1.1\\r\\nhost: relay.asight.test\\r\\n\\r\\n'))
  let b = ''; c.on('data', (d) => (b += d)); c.on('end', () => resolve(b)); c.on('error', (e) => resolve('client error: ' + e.code)); c.on('close', () => resolve(b))
})
await done
console.log(JSON.stringify({ got, flow: flows[0] }))
engine.close(); upstream.close()
`

function run(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-g8-'))
  try {
    const upCa = createCa({ commonName: 'relay test CA' }); const asightCa = createCa()
    const files = ['up.json', 'asight.json', 'up.pem'].map((n) => path.join(dir, n))
    fs.writeFileSync(files[0], JSON.stringify(upCa)); fs.writeFileSync(files[1], JSON.stringify(asightCa)); fs.writeFileSync(files[2], upCa.certPem)
    const childEnv = { ...process.env }; delete childEnv.NODE_EXTRA_CA_CERTS
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD, files[0], files[1]], { encoding: 'utf8', timeout: 20000, env: { ...childEnv, ...env(files[2]) } })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout.trim().split('\n').pop())
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('engine: an upstream signed by a private CA is decrypted when the daemon has NODE_EXTRA_CA_CERTS for it (G8)', () => {
  const r = run((pem) => ({ NODE_EXTRA_CA_CERTS: pem }))
  assert.match(r.got, /^HTTP\/1\.1 200 OK[\s\S]*ok$/)
  assert.equal(r.flow.decision, 'decrypt')
  assert.equal(r.flow.error, undefined)
})

// An upstream that does not verify steps aside (4.6 §引擎 5, feat/collector-ws-recorder): the flow is not decrypted,
// it records not_captured:'upstream-cert' with Node's verify code, and the client meets the real upstream itself.
test('engine: without NODE_EXTRA_CA_CERTS the same upstream fails verification; the client gets nothing decrypted', () => {
  const r = run(() => ({}))
  assert.doesNotMatch(r.got, /200 OK/)
  assert.equal(r.flow.not_captured, 'upstream-cert')
  assert.match(r.flow.reason, /SELF_SIGNED|UNABLE_TO_VERIFY|CERT/)
})
