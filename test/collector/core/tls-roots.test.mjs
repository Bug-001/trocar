// tls-roots.test.mjs — the trust set the engine verifies upstreams against (RFC 4.6 §引擎 5: the OS store
// ∪ Node's bundled roots ∪ the engine's NODE_EXTRA_CA_CERTS), and the engine using it end to end.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { systemRoots, nodeRoots, createUpstreamTrust, bundleRoots, SYSTEM_BUNDLES } from '../../../src/collector/core/tls/roots.mjs'
import { osRootsFor } from '../../../src/off/os-roots.mjs'
const osBundleRoots = osRootsFor('linux') // the Linux reader, through the one table
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
  assert.deepEqual(osBundleRoots({ read: only({ '/etc/pki/tls/certs/ca-bundle.crt': b.certPem }) }), { pem: b.certPem, file: '/etc/pki/tls/certs/ca-bundle.crt', missing: null, dropped: 0 }, 'Fedora / RHEL: only its path exists')
  assert.equal(osBundleRoots({ read: only({ '/etc/ssl/certs/ca-certificates.crt': '', '/etc/ssl/ca-bundle.pem': b.certPem }) }).file, '/etc/ssl/ca-bundle.pem', 'a path that holds no certificate is passed over (openSUSE)')
  const none = osBundleRoots({ read: only({}) })
  assert.deepEqual([none.pem, none.file, none.dropped], ['', null, 0], 'none: Node\'s roots are all a bundle gets')
  const broken = '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n'
  const trusted = '-----BEGIN TRUSTED CERTIFICATE-----\nAAAA\n-----END TRUSTED CERTIFICATE-----\n'
  assert.equal(osBundleRoots({ read: only({ [SYSTEM_BUNDLES[0]]: `${b.certPem}${broken}${trusted}` }) }).dropped, 2, 'a block that is not a certificate Node parses is counted: composeBundle leaves it out (W20\'s count, every reader)')
  for (const f of SYSTEM_BUNDLES) assert.ok(none.missing.includes(f), `the reason names ${f}`)
  assert.throws(() => osBundleRoots({ read: (f) => { throw Object.assign(new Error(`EACCES: permission denied, open '${f}'`), { code: 'EACCES' }) } }),
    (e) => e.code === 'EACCES' && e.message.includes(SYSTEM_BUNDLES[0]), 'there but unreadable: thrown, the caller keeps what it had and says why')
})

// 4.8 §6.2 / W20, carried to Linux by 4.6 「合并包」: a block of the OS bundle that is not a certificate Node parses is left out of every combined bundle
// (composeBundle skips it — one broken block makes Codex's rustls refuse the whole file), and that is counted, so it can be said (D38), never only skipped.
test('osBundleRoots: the blocks of the OS bundle that are not certificates Node parses are counted in `dropped` — a broken one, another type, one cut short', () => {
  const BROKEN = '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n'
  const text = `${b.certPem}${BROKEN}-----BEGIN TRUSTED CERTIFICATE-----\nAAAA\n-----END TRUSTED CERTIFICATE-----\n${a.certPem}-----BEGIN CERTIFICATE-----\nMIIcut`
  const r = osBundleRoots({ read: (f) => { if (f === SYSTEM_BUNDLES[0]) return text; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } })
  assert.deepEqual([r.file, r.dropped], [SYSTEM_BUNDLES[0], 3], 'two certificates parse; the broken one, the TRUSTED CERTIFICATE and the cut-short one do not')
  assert.equal(r.pem, text, 'the text is handed on as read: composeBundle takes the certificates out of it')
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

// the platform-seam rule: the combined bundles' roots have one resolver. A caller with an arm of its own (a named file read beside the arch's osRoots, a
// fallback) is the drift this closes — on.mjs, install.mjs and the daemon once each chose between `osRootsFile` and `osRoots()`, an arm only test arches took;
// and `off` once read a fixed PEM list of its own (/etc/ssl/cert.pem on a Mac). The readers are src/off/os-roots.mjs's, chosen by its one table osRootsFor.
test('bundleRoots is the collector\'s one resolver of the combined bundles\' roots: the arch\'s osRoots or Node\'s alone; no other code in src/ asks osRoots, no file arm is left, and every reader is reached through osRootsFor — by the arches with their own name, by off with its platform', async () => {
  assert.deepEqual(await bundleRoots({ osRoots: async () => ({ pem: b.certPem, file: '/f' }) }, { nodeRoots: [x.certPem] }), { node: [x.certPem], osText: b.certPem, missing: null, dropped: 0, partial: null })
  assert.deepEqual(await bundleRoots({ osRoots: () => ({ pem: '', missing: 'none here' }) }, { nodeRoots: [] }), { node: [], osText: '', missing: 'none here', dropped: 0, partial: null }, '`missing` reaches the callers (planTrust\'s note, the daemon\'s failure)')
  assert.deepEqual(await bundleRoots(null, { nodeRoots: [x.certPem] }), { node: [x.certPem], osText: '', missing: null, dropped: 0, partial: null }, 'no osRoots: Node\'s roots alone')
  // 4.8 §6.2 / W20, 4.9 §6.2: what the reader left out reaches the callers too — the count of certificates that did not parse, and the sources whose read
  // failed while others gave roots (darwin's `tried`: on Node 20 the keychain's local anchors, where a corporate CA lives, are not in the bundles)
  assert.deepEqual(await bundleRoots({ osRoots: async () => ({ pem: b.certPem, dropped: 2, tried: ['getCACertificates: not available (Node ≥ 22.15 has it)', 'security: exit 1'] }) }, { nodeRoots: [] }),
    { node: [], osText: b.certPem, missing: null, dropped: 2, partial: 'getCACertificates: not available (Node ≥ 22.15 has it); security: exit 1' }, '`dropped` and `partial` reach planTrust\'s notes and the daemon\'s failures')
  assert.deepEqual(await bundleRoots({ osRoots: () => ({ pem: b.certPem, dropped: 0, tried: [] }) }, { nodeRoots: [] }), { node: [], osText: b.certPem, missing: null, dropped: 0, partial: null }, 'nothing left out: nothing to say')
  await assert.rejects(bundleRoots({ osRoots: async () => { throw new Error('the OS trust bundle cannot be read (EACCES)') } }), /cannot be read/, 'a read that fails throws: `on` stops, the daemon keeps its bundles')
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src')
  const home = path.join(src, 'collector', 'core', 'tls', 'roots.mjs')
  const readers = path.join(src, 'off', 'os-roots.mjs')
  const code = (t) => t.replace(/\/\/.*$/gm, '').replace(/^\s*\/?\*.*$/gm, '') // comments may name the hook; only code is judged
  const all = fs.readdirSync(src, { recursive: true }).map((f) => path.join(src, f)).filter((f) => f.endsWith('.mjs')).map((f) => ({ f, t: code(fs.readFileSync(f, 'utf8')) }))
  // `.osRoots` / `['osRoots']` / `{ osRoots }` read the hook; a reader called outside its table reads OS roots beside it; osRootsFile is the old file arm
  const second = ({ f, t }) => (f !== home && /\.osRoots\b|\[\s*['"]osRoots['"]\s*\]|\bosRoots\s*[,}]|osRootsFile/.test(t)) || (f !== readers && /\b(osBundleRoots|darwinRoots|windowsRoots)\b/.test(t)) // a reader named at all — called, imported or handed on by reference — outside its table
  assert.deepEqual(all.filter(second).map(({ f }) => path.relative(src, f)), [], 'a second reader of the OS roots, or a file arm beside them, is a second resolver')
  const askers = all.filter(({ f, t }) => f !== readers && /\bosRootsFor\s*\(/.test(t))
  assert.deepEqual(askers.map(({ f }) => path.relative(src, f)).sort(), [path.join('collector', 'arch', 'index.mjs'), path.join('off', 'orchestrate.mjs')], 'the table is asked by the arches and by off\'s rebuild, no one else')
  assert.deepEqual([...askers.find(({ f }) => f.endsWith('index.mjs')).t.matchAll(/osRootsFor\('([a-z0-9]+)'\)/g)].map((m) => m[1]).sort(), ['darwin', 'linux', 'win32'], 'each arch asks for its own platform, once')
})

test('nodeRoots: without the API, Node\'s bundled roots plus this process\'s NODE_EXTRA_CA_CERTS', () => {
  const errors = []
  assert.equal(nodeRoots({ api: null, env: { NODE_EXTRA_CA_CERTS: '/gone.pem' }, read: () => { throw new Error('ENOENT: gone') }, errors }).length, tls.rootCertificates.length)
  assert.deepEqual(errors, ['NODE_EXTRA_CA_CERTS /gone.pem: ENOENT: gone'], 'an unreadable NODE_EXTRA_CA_CERTS is reported')
  const errors22 = [] // Node ≥ 22.15: getCACertificates('default') already holds what it could read; the failure is still ours to report
  assert.equal(nodeRoots({ api: (t) => (t === 'default' ? ['d'] : []), env: { NODE_EXTRA_CA_CERTS: '/gone.pem' }, read: () => { throw new Error('ENOENT: gone') }, errors: errors22 }).join(), 'd')
  assert.deepEqual(errors22, ['NODE_EXTRA_CA_CERTS /gone.pem: ENOENT: gone'], 'reported on the API path too')
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
  const corp = createCa({ commonName: 'corporate inspection CA' }), stranger = createCa({ commonName: 'unknown CA' }), trocarCa = createCa()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-roots-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let n = 0
  const run = async (signer, clientCa, systemCa) => {
    const up = tls.createServer({ SNICallback: (s, cb) => cb(null, createLeafIssuer(loadCa(signer)).secureContextFor(s)) }, (s) => { s.on('error', () => {}); s.on('data', () => s.end('pong')) })
    await new Promise((r) => up.listen(0, '127.0.0.1', r))
    const root = path.join(dir, String(++n)), store = createRecordStore({ root, raw: root }), errors = []
    const engine = createEngine({ redirector: createStaticRedirector({ dst: { address: '127.0.0.1', port: up.address().port, family: 4 }, pid: 3, agent: 'cc', decrypt: true }),
      issuer: createLeafIssuer(loadCa(trocarCa)), store, systemCa, onFailure: createFailureRecorder(root).event, onError: (e) => errors.push(e.message) })
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
  const ok = await run(corp, trocarCa.certPem, corp.certPem)
  assert.match(ok.issuer, /trocar collector CA/, 'decrypted: the engine trusted the corporate CA from the system store')
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
  const partial = await run(corp, trocarCa.certPem, { certs: [corp.certPem], errors: ['/etc/ssl/certs/ca-certificates.crt: EACCES: permission denied'] })
  assert.match(partial.issuer, /trocar collector CA/, 'what was read is still used')
  assert.deepEqual(partial.failures.map((f) => [f.code, f.reason]), [['trust-store-error', '/etc/ssl/certs/ca-certificates.crt: EACCES: permission denied']], 'an unreadable source is not silent')
})
