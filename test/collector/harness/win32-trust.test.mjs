// test/collector/harness/win32-trust.test.mjs — the Windows trust readers that outlive the overlays (RFC 4.8 §6.2; acceptance W20): isOwnPath's Windows rule and
// the Windows roots readers. The overlays' trust entries (W19, W22) retired with them; the model's entries are test/collector/core/proxymode/entries*.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { isOwnPath } from '../../../src/collector/harness/_common.mjs'

const raw = String.raw

test('isOwnPath: on Windows a path is asight\'s when it is under the collector directory whatever the slash and the case, and not for a sibling directory of a longer name; elsewhere it is the plain prefix', () => {
  const win = { os: 'win32', collectorDir: raw`C:\Users\u\.asight\collector` }
  for (const own of ['C:/Users/u/.asight/collector/ca/x.pem', raw`C:\Users\u\.asight\collector\ca\x.pem`, 'c:/USERS/U/.asight/Collector/ca/x.pem']) assert.equal(isOwnPath(win, own), true, own)
  for (const other of ['C:/Users/u/.asight/collector2/ca/x.pem', 'C:/Users/u/.asight/collector', 'C:/corp/ca.pem', '', null, undefined, 7]) assert.equal(isOwnPath(win, other), false, String(other))
  assert.equal(isOwnPath({ os: 'win32', collectorDir: 'C:/Users/u/.asight/collector/' }, 'C:/Users/u/.asight/collector/ca/x.pem'), true, 'a trailing slash on the directory')
  const lin = { os: 'linux', collectorDir: '/h/.asight/collector' }
  assert.equal(isOwnPath(lin, '/h/.asight/collector/ca/x.pem'), true)
  assert.equal(isOwnPath(lin, '/h/.asight/collector2/ca/x.pem'), false)
  assert.equal(isOwnPath(lin, '/H/.ASIGHT/collector/ca/x.pem'), false, 'case counts outside Windows')
})

// ── W20: the combined bundle's Windows roots (4.8 §6.2) ──
import nodeFs from 'node:fs'
import { osRootsFor } from '../../../src/off/os-roots.mjs'
const windowsRoots = osRootsFor('win32') // the readers are reached through their one table, as src/ reaches them
const unavailable = (e) => e instanceof Error && e.name === 'RootsUnavailableError'

const R = [createCa({ commonName: 'Windows root one' }), createCa({ commonName: 'Windows root two' }), createCa({ commonName: 'Windows root three' })].map((c) => c.certPem)
const BROKEN = '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n'
const fp = (pem) => new crypto.X509Certificate(pem).fingerprint256
const helperOf = (certs, calls = []) => ({ call: async (verb, args, opts) => { calls.push([verb, args, opts]); return { counts: { CurrentUser: certs.length, LocalMachine: 0 }, certs: certs.map((pem) => ({ sha256: 'x', pem, stores: ['CurrentUser'] })) } } })

test('W20: the Windows roots come from Node\'s own system store when it has one, parsed one by one: a certificate that does not parse is dropped and counted, a duplicate is kept once', async () => {
  const asked = []
  const tls = { getCACertificates: (k) => { asked.push(k); return [R[0], BROKEN, R[1], R[0]] } }
  const r = await windowsRoots({ tls })
  assert.deepEqual([asked, r.source, r.dropped], [['system'], 'node-system', 1])
  assert.deepEqual(r.pem.match(/-----BEGIN CERTIFICATE-----/g).length, 2, 'two distinct certificates')
  assert.ok(r.pem.includes(R[0].trim()) && r.pem.includes(R[1].trim()) && !r.pem.includes('bm90IGEg'), 'the broken block is not in the text')
  assert.ok(r.pem.endsWith('\n') && !r.pem.includes('\n\n'))
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/)
})

test('W20: without Node\'s system store — or when it fails or is empty — the helper\'s read-only export is the source, and with neither the answer is a reason, not an empty bundle', async () => {
  const calls = []
  const viaHelper = await windowsRoots({ tls: {}, helper: helperOf([R[0], BROKEN, R[2]], calls) })
  assert.deepEqual([viaHelper.source, viaHelper.dropped, viaHelper.pem.match(/BEGIN CERTIFICATE/g).length], ['helper', 1, 2])
  assert.deepEqual([calls[0][0], calls[0][1]], ['roots', {}])
  assert.ok(calls[0][2].timeoutMs >= 10000, 'about 430 KB through a cold PowerShell: the call is given time')
  for (const tls of [{ getCACertificates: () => { throw new Error('no system store') } }, { getCACertificates: () => [] }, { getCACertificates: () => [BROKEN] }]) assert.equal((await windowsRoots({ tls, helper: helperOf([R[1]]) })).source, 'helper')
  await assert.rejects(windowsRoots({ tls: {} }), (e) => unavailable(e) && /^the Windows root certificates could not be read \(getCACertificates: not available \(Node ≥ 22\.15 has it\)\)$/.test(e.message) && e.tried.length === 1, 'no Node 22.15 read and no helper (off has none, 4.8 §6.2): the reason says which, so off\'s note can')
  await assert.rejects(windowsRoots({ tls: { getCACertificates: () => [] }, helper: { call: async () => { throw Object.assign(new Error('x'), { code: 'helper-down' }) } } }), (e) => unavailable(e) && /node-system: no certificate; helper: helper-down/.test(e.message) && e.tried.length === 2)
  await assert.rejects(windowsRoots({ tls: {}, helper: helperOf([BROKEN]) }), unavailable, 'a store of nothing but broken certificates is not a root set')
})

test('W20: the fingerprint is of the set, not of its order, and changes with the set', async () => {
  const a = await windowsRoots({ tls: { getCACertificates: () => [R[0], R[1]] } })
  assert.equal((await windowsRoots({ tls: { getCACertificates: () => [R[1], R[0], R[1]] } })).fingerprint, a.fingerprint)
  assert.notEqual((await windowsRoots({ tls: { getCACertificates: () => [R[0], R[2]] } })).fingerprint, a.fingerprint)
})

test('W20: the Windows reader reads no file at all — never the macOS cert.pem a test machine once used — not even through the `read` the table\'s callers pass (off does)', async () => {
  assert.equal(windowsRoots.name, 'windowsRoots', 'win32\'s entry of the one table (src/off/os-roots.mjs)')
  assert.ok(!/cert\.pem|\/etc\/ssl|readFile|createReadStream|\bfs\b|\bread\b/.test(windowsRoots.toString().replace(/\/\/.*$/gm, '')), 'its own code names no file and takes no reader')
  const reads = []
  const real = nodeFs.readFileSync
  nodeFs.readFileSync = (...a) => { reads.push(String(a[0])); return real(...a) }
  const read = (f) => { reads.push(f); return '' }
  try { await osRootsFor('win32')({ tls: { getCACertificates: () => [R[0]] }, read }); await osRootsFor('win32')({ tls: {}, helper: helperOf([R[1]]), read }) } finally { nodeFs.readFileSync = real }
  assert.deepEqual(reads, [])
})

