// tls-roots.test.mjs — the trust set the engine verifies upstreams against (RFC 4.6 §引擎 5: the OS store
// ∪ Node's bundled roots ∪ the engine's NODE_EXTRA_CA_CERTS), and the engine using it end to end.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import tls from 'node:tls'
import { systemRoots, nodeRoots, createUpstreamTrust, SYSTEM_BUNDLES } from '../../../src/collector/core/tls/roots.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { createRecordStore } from '../../../src/collector/core/record/store.mjs'

const a = createCa({ commonName: 'system store CA' }), b = createCa({ commonName: 'bundle file CA' }), x = createCa({ commonName: 'extra CA' })

test('systemRoots: Node\'s system store and the first existing OS bundle together; Node 20 (no API) reads the bundle; nothing found is reported', () => {
  const files = { '/etc/pki/tls/certs/ca-bundle.crt': `junk\r\n${b.certPem}`, '/etc/ssl/cert.pem': a.certPem }
  const read = (f) => { if (!(f in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[f] }
  const both = systemRoots({ api: (t) => (t === 'system' ? [a.certPem] : []), read })
  assert.deepEqual(both.sources, ['node:system', '/etc/pki/tls/certs/ca-bundle.crt'], 'the first bundle that exists, after the API')
  assert.equal(both.certs.length, 2); assert.ok(both.certs[1].startsWith('-----BEGIN CERTIFICATE-----') && !both.certs[1].includes('\r'))
  assert.deepEqual(systemRoots({ api: () => [], read }).sources, ['/etc/pki/tls/certs/ca-bundle.crt'], 'an empty API answer (Linux without --use-system-ca paths) falls back to the bundle')
  assert.deepEqual(systemRoots({ api: null, read }).sources, ['/etc/pki/tls/certs/ca-bundle.crt'], 'Node 20: no getCACertificates')
  assert.deepEqual(systemRoots({ api: () => { throw new Error('boom') }, read: () => { throw new Error('ENOENT') } }), { certs: [], sources: [], errors: ['node:system: boom'] })
  assert.ok(SYSTEM_BUNDLES.includes('/etc/ssl/certs/ca-certificates.crt') && SYSTEM_BUNDLES.includes('/etc/pki/tls/certs/ca-bundle.crt'))
})

test('nodeRoots: without the API, Node\'s bundled roots plus this process\'s NODE_EXTRA_CA_CERTS', () => {
  const roots = nodeRoots({ api: null, env: { NODE_EXTRA_CA_CERTS: '/x.pem' }, read: (f) => (f === '/x.pem' ? x.certPem : '') })
  assert.equal(roots.length, tls.rootCertificates.length + 1); assert.equal(roots.at(-1), x.certPem.replace(/\r\n/g, '\n').trim())
  assert.equal(nodeRoots({ api: (t) => (t === 'default' ? ['d'] : []) }).join(), 'd')
})

test('createUpstreamTrust: one context over the union; no OS roots at all is flagged', () => {
  const t = createUpstreamTrust({ system: { certs: [a.certPem], sources: ['s'], errors: [] }, node: [b.certPem], extra: x.certPem })
  assert.equal(t.count, 3); assert.equal(t.missingSystem, false); assert.ok(t.secureContext)
  assert.equal(createUpstreamTrust({ system: { certs: [], sources: [], errors: [] }, node: [b.certPem] }).missingSystem, true)
})

// The cross-OS review's case: a corporate / TLS-inspection CA that only the OS store trusts. The engine
// must accept an upstream it signed; an upstream signed by a CA nobody trusts steps aside, durably recorded.
test('engine: an upstream signed by a CA only the (injected) system store holds is decrypted; an unknown CA steps aside with flows/ on disk; no system roots at all is a failure record', async (t) => {
  const corp = createCa({ commonName: 'corporate inspection CA' }), stranger = createCa({ commonName: 'unknown CA' }), asightCa = createCa()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-roots-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let n = 0
  const run = async (signer, clientCa, systemCa) => {
    const up = tls.createServer({ SNICallback: (s, cb) => cb(null, createLeafIssuer(loadCa(signer)).secureContextFor(s)) }, (s) => { s.on('error', () => {}); s.on('data', () => s.end('pong')) })
    await new Promise((r) => up.listen(0, '127.0.0.1', r))
    const root = path.join(dir, String(++n)), store = createRecordStore({ root }), errors = []
    const engine = createEngine({ redirector: createStaticRedirector({ dst: { address: '127.0.0.1', port: up.address().port, family: 4 }, pid: 3, agent: 'cc', decrypt: true }),
      issuer: createLeafIssuer(loadCa(asightCa)), store, systemCa, onError: (e) => errors.push(e.message) })
    const { port } = await engine.listen({})
    const issuer = await new Promise((resolve) => {
      const c = tls.connect({ port, host: '127.0.0.1', servername: 'api.anthropic.com', ca: clientCa }, () => { const i = c.getPeerX509Certificate().issuer; c.on('end', () => resolve(i)); c.resume(); c.write('ping') })
      c.on('error', (e) => resolve(e.code))
    })
    await engine.close(); up.close(); store.close()
    const read = (sub) => { const d = path.join(root, sub); return fs.existsSync(d) ? fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l))) : [] }
    return { issuer, flows: read('flows'), failures: read('failures'), errors, stats: engine.stats() }
  }
  const ok = await run(corp, asightCa.certPem, corp.certPem)
  assert.match(ok.issuer, /asight collector CA/, 'decrypted: the engine trusted the corporate CA from the system store')
  assert.deepEqual(ok.flows.map((f) => [f.decision, f.not_captured ?? null]), [['decrypt', null]]); assert.deepEqual(ok.failures, [])
  const bad = await run(stranger, stranger.certPem, corp.certPem)
  assert.match(bad.issuer, /unknown CA/, 'stepped aside: the client did its own handshake with the real upstream')
  assert.deepEqual(bad.flows.map((f) => [f.decision, f.not_captured, typeof f.reason]), [['splice', 'upstream-cert', 'string']], 'flows/ on disk says why')
  assert.equal(bad.stats.notCaptured.upstreamCert, 1)
  const none = await run(corp, corp.certPem, [])
  assert.match(none.issuer, /corporate inspection CA/, 'no system roots: the corporate upstream is not trusted either, so it steps aside')
  assert.deepEqual(none.failures.map((f) => f.reason), ['system-roots-unavailable'], 'and that is not silent')
  assert.equal(none.errors.length, 1)
})
