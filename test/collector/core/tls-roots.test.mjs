// tls-roots.test.mjs — the trust set the engine verifies upstreams against (RFC 4.6 §引擎 5: the OS store
// ∪ Node's bundled roots ∪ the engine's NODE_EXTRA_CA_CERTS), and the engine using it end to end.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { systemRoots, nodeRoots, createUpstreamTrust, osBundleRoots, SYSTEM_BUNDLES } from '../../../src/collector/core/tls/roots.mjs'
import { SYSTEM_BUNDLES as OFF_BUNDLES } from '../../../src/off/pem.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { createRecordStore } from '../../../src/collector/core/record/store.mjs'
import { createFailureRecorder } from '../../../src/collector/core/events.mjs'
import { within, closeWithin } from '../../helpers/bounded.mjs'

const a = createCa({ commonName: 'system store CA' }), b = createCa({ commonName: 'bundle file CA' }), x = createCa({ commonName: 'extra CA' })

test('systemRoots: Node\'s system store and the first existing OS bundle together; Node 20 (no API) reads the bundle; nothing found is reported', () => {
  const files = { '/etc/pki/tls/certs/ca-bundle.crt': `junk\r\n${b.certPem}`, '/etc/ssl/cert.pem': a.certPem }
  const read = (f) => { if (!(f in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[f] }
  const both = systemRoots({ api: (t) => (t === 'system' ? [a.certPem] : []), read })
  assert.deepEqual(both.sources, ['node:system', '/etc/pki/tls/certs/ca-bundle.crt'], 'the first bundle that exists, after the API')
  assert.equal(both.certs.length, 2); assert.ok(both.certs[1].startsWith('-----BEGIN CERTIFICATE-----') && !both.certs[1].includes('\r'))
  assert.deepEqual(systemRoots({ api: () => [], read }).sources, ['/etc/pki/tls/certs/ca-bundle.crt'], 'an empty API answer (Linux without --use-system-ca paths) falls back to the bundle')
  assert.deepEqual(systemRoots({ api: null, read }).sources, ['/etc/pki/tls/certs/ca-bundle.crt'], 'Node 20: no getCACertificates')
  const missing = () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }) }
  assert.deepEqual(systemRoots({ api: () => { throw new Error('boom') }, read: missing }), { certs: [], sources: [], errors: ['node:system: boom'] }, 'a bundle that is not on this OS is no error')
  const denied = systemRoots({ api: null, read: (f) => { if (f === SYSTEM_BUNDLES[0]) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return f === '/etc/pki/tls/certs/ca-bundle.crt' ? b.certPem : missing() } })
  assert.deepEqual([denied.sources, denied.errors], [['/etc/pki/tls/certs/ca-bundle.crt'], [`${SYSTEM_BUNDLES[0]}: EACCES: permission denied`]], 'a bundle that exists but cannot be read is reported')
  assert.ok(SYSTEM_BUNDLES.includes('/etc/ssl/certs/ca-certificates.crt') && SYSTEM_BUNDLES.includes('/etc/pki/tls/certs/ca-bundle.crt'))
})

// 4.6 「合并包」: on Linux the combined bundles start from the first OS bundle this machine has (the Linux arch's osRoots), not the Debian path alone —
// Fedora / RHEL / openSUSE have none there, and the bundles then dropped the OS roots and every CA installed system-wide with them. None is said (D38).
test('osBundleRoots: the first of SYSTEM_BUNDLES that holds a certificate; none is `missing`, naming every path looked at; one there but unreadable throws with its errno', () => {
  const only = (files) => (f) => { if (f in files) return files[f]; throw Object.assign(new Error(`ENOENT: no such file or directory, open '${f}'`), { code: 'ENOENT' }) }
  assert.deepEqual(osBundleRoots({ read: only({ '/etc/pki/tls/certs/ca-bundle.crt': b.certPem }) }), { pem: b.certPem, file: '/etc/pki/tls/certs/ca-bundle.crt', missing: null }, 'Fedora / RHEL: only its path exists')
  assert.equal(osBundleRoots({ read: only({ '/etc/ssl/certs/ca-certificates.crt': '', '/etc/ssl/ca-bundle.pem': b.certPem }) }).file, '/etc/ssl/ca-bundle.pem', 'a path that holds no certificate is passed over (openSUSE)')
  const none = osBundleRoots({ read: only({}) })
  assert.deepEqual([none.pem, none.file], ['', null], 'none: Node\'s roots are all a bundle gets')
  for (const f of SYSTEM_BUNDLES) assert.ok(none.missing.includes(f), `the reason names ${f}`)
  assert.throws(() => osBundleRoots({ read: (f) => { throw Object.assign(new Error(`EACCES: permission denied, open '${f}'`), { code: 'EACCES' }) } }),
    (e) => e.code === 'EACCES' && e.message.includes(SYSTEM_BUNDLES[0]), 'there but unreadable: thrown, the caller keeps what it had and says why')
})

test('SYSTEM_BUNDLES is one list: the collector\'s is the one `off` reads (src/off/pem.mjs), and no path of it is a string literal anywhere else in src/', () => {
  assert.equal(SYSTEM_BUNDLES, OFF_BUNDLES)
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src')
  const home = path.join(src, 'off', 'pem.mjs')
  const files = fs.readdirSync(src, { recursive: true }).map((f) => path.join(src, f)).filter((f) => f.endsWith('.mjs') && f !== home)
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  // a quoted string is a copy of the fact; a comment's `backticked` mention of a path is prose
  const hits = files.flatMap((f) => { const t = fs.readFileSync(f, 'utf8'); return SYSTEM_BUNDLES.filter((p) => new RegExp(`['"]${esc(p)}['"]`).test(t)).map((p) => `${path.relative(src, f)}: ${p}`) })
  assert.deepEqual(hits, [], 'a second copy of the list drifts from the first (the Linux arch named Debian\'s path alone; off had three of six)')
})

test('nodeRoots: without the API, Node\'s bundled roots plus this process\'s NODE_EXTRA_CA_CERTS', () => {
  const errors = []
  assert.equal(nodeRoots({ api: null, env: { NODE_EXTRA_CA_CERTS: '/gone.pem' }, read: () => { throw new Error('ENOENT: gone') }, errors }).length, tls.rootCertificates.length)
  assert.deepEqual(errors, ['NODE_EXTRA_CA_CERTS /gone.pem: ENOENT: gone'], 'an unreadable NODE_EXTRA_CA_CERTS is reported')
  const errors22 = [] // Node ≥ 22.15: getCACertificates('default') already holds what it could read; the failure is still ours to report
  assert.equal(nodeRoots({ api: (t) => (t === 'default' ? ['d'] : []), env: { NODE_EXTRA_CA_CERTS: '/gone.pem' }, read: () => { throw new Error('ENOENT: gone') }, errors: errors22 }).join(), 'd')
  assert.deepEqual(errors22, ['NODE_EXTRA_CA_CERTS /gone.pem: ENOENT: gone'], 'reported on the API path too (fresh-context review)')
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
test('engine: an upstream signed by a CA only the (injected) system store holds is decrypted; an unknown CA steps aside with flows/ on disk; no system roots at all is a failure record', { timeout: 60_000 }, async (t) => {
  const corp = createCa({ commonName: 'corporate inspection CA' }), stranger = createCa({ commonName: 'unknown CA' }), asightCa = createCa()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-roots-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let n = 0
  const run = async (signer, clientCa, systemCa) => {
    const up = tls.createServer({ SNICallback: (s, cb) => cb(null, createLeafIssuer(loadCa(signer)).secureContextFor(s)) }, (s) => { s.on('error', () => {}); s.on('data', () => s.end('pong')) })
    await new Promise((r) => up.listen(0, '127.0.0.1', r))
    const root = path.join(dir, String(++n)), store = createRecordStore({ root }), errors = []
    const engine = createEngine({ redirector: createStaticRedirector({ dst: { address: '127.0.0.1', port: up.address().port, family: 4 }, pid: 3, agent: 'cc', decrypt: true }),
      issuer: createLeafIssuer(loadCa(asightCa)), store, systemCa, onFailure: createFailureRecorder(root).event, onError: (e) => errors.push(e.message) })
    const { port } = await engine.listen({})
    let c
    const issuer = await within(new Promise((resolve) => {
      c = tls.connect({ port, host: '127.0.0.1', servername: 'api.anthropic.com', ca: clientCa }, () => { const i = c.getPeerX509Certificate().issuer; c.on('end', () => resolve(i)); c.resume(); c.write('ping') })
      c.on('error', (e) => resolve(e.code))
    }), 10_000, 'the client never finished its handshake and exchange', () => c.destroy())
    try { await closeWithin(engine) } finally { up.close(); store.close() } // bounded: engine.close() waits for every flow still open and never destroys one
    const read = (sub) => { const d = path.join(root, sub); return fs.existsSync(d) ? fs.readdirSync(d).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l))) : [] }
    return { issuer, flows: read('flows').filter((r) => r.event == null), failures: read('flows').filter((r) => r.event === 'failure'), errors, stats: engine.stats() }
  }
  const ok = await run(corp, asightCa.certPem, corp.certPem)
  assert.match(ok.issuer, /asight collector CA/, 'decrypted: the engine trusted the corporate CA from the system store')
  assert.deepEqual(ok.flows.map((f) => [f.decision, f.not_captured ?? null]), [['decrypt', null]]); assert.deepEqual(ok.failures, [])
  const bad = await run(stranger, stranger.certPem, corp.certPem)
  assert.match(bad.issuer, /unknown CA/, 'stepped aside: the client did its own handshake with the real upstream')
  assert.deepEqual(bad.flows.map((f) => [f.decision, f.not_captured, typeof f.reason]), [['splice', 'upstream-cert', 'string']], 'flows/ on disk says why')
  assert.equal(bad.stats.notCaptured.upstreamCert, 1)
  assert.deepEqual(bad.failures.map((f) => [f.code, f.pid, f.host, f.cause]), [['negative-cache', 3, 'api.anthropic.com', 'upstream-cert']], 'the negative-cache write is a failure event (D-12)')
  const none = await run(corp, corp.certPem, [])
  assert.match(none.issuer, /corporate inspection CA/, 'no system roots: the corporate upstream is not trusted either, so it steps aside')
  assert.deepEqual(none.failures.map((f) => [f.where, f.code]), [['engine', 'system-roots-unavailable'], ['engine', 'negative-cache']], 'and that is not silent; the (pid, host) it stepped aside for is negative from now on, and that is said too (D-12)')
  assert.equal(none.errors.length, 1)
  const partial = await run(corp, asightCa.certPem, { certs: [corp.certPem], errors: ['/etc/ssl/certs/ca-certificates.crt: EACCES: permission denied'] })
  assert.match(partial.issuer, /asight collector CA/, 'what was read is still used')
  assert.deepEqual(partial.failures.map((f) => [f.code, f.reason]), [['trust-store-error', '/etc/ssl/certs/ca-certificates.crt: EACCES: permission denied']], 'an unreadable source is not silent')
})
