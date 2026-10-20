// test/collector/harness/darwin-trust.test.mjs — the macOS root readers (RFC 4.9 §6.2, acceptance W20; spec 4.6:419 names this file for the
// system-roots-unparsable / system-roots-partial half on macOS) and isOwnPath's macOS rule. The macOS trust entries of the old per-OS overlays
// (W19 / W22) retired with the darwin descriptor overlays; the model's entries are test/collector/core/proxymode/entries*.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { isOwnPath } from '../../../src/collector/harness/_common.mjs'

test('isOwnPath: on macOS a path is trocar\'s when it is under the collector directory as the plain exact-case prefix, and not for a sibling directory of a longer name; on Windows the slash and the case do not matter; elsewhere it is the plain prefix', () => {
  const mac = { os: 'darwin', collectorDir: '/Users/u/.trocar/collector' }
  assert.equal(isOwnPath(mac, '/Users/u/.trocar/collector/ca/x.pem'), true)
  for (const other of ['/Users/u/.trocar/collector2/ca/x.pem', '/Users/u/.trocar/collector', '/Users/u/corp/ca.pem', '/users/u/.trocar/collector/ca/x.pem', '', null, undefined, 7]) assert.equal(isOwnPath(mac, other), false, `${String(other)}: the darwin compare is exact — APFS is case-insensitive by default, and whether darwin should get the win32 case-blind compare is the integrator's question`)
  assert.equal(isOwnPath({ os: 'darwin', collectorDir: '/Users/u/.trocar/collector/' }, '/Users/u/.trocar/collector/ca/x.pem'), false, 'a trailing slash on the directory is not today\'s darwin shape (the win line normalises it away): flagged in the port report')
  const win = { os: 'win32', collectorDir: 'C:\\Users\\u\\.trocar\\collector' }
  for (const own of ['C:/Users/u/.trocar/collector/ca/x.pem', 'C:\\Users\\u\\.trocar\\collector\\ca\\x.pem', 'c:/USERS/U/.trocar/Collector/ca/x.pem']) assert.equal(isOwnPath(win, own), true, own)
  for (const other of ['C:/Users/u/.trocar/collector2/ca/x.pem', 'C:/Users/u/.trocar/collector', 'C:/corp/ca.pem', '', null, undefined, 7]) assert.equal(isOwnPath(win, other), false, String(other))
  assert.equal(isOwnPath({ os: 'win32', collectorDir: 'C:/Users/u/.trocar/collector/' }, 'C:/Users/u/.trocar/collector/ca/x.pem'), true, 'a trailing slash on the directory')
  const lin = { os: 'linux', collectorDir: '/h/.trocar/collector' }
  assert.equal(isOwnPath(lin, '/h/.trocar/collector/ca/x.pem'), true)
  assert.equal(isOwnPath(lin, '/h/.trocar/collector2/ca/x.pem'), false)
  assert.equal(isOwnPath(lin, '/H/.TROCAR/collector/ca/x.pem'), false, 'case counts outside Windows')
})


// ── W20: the combined bundle's macOS roots (4.9 §6.2: the union of three sources, none a fallback for another) ──
import nodeFs from 'node:fs'
import { osRootsFor } from '../../../src/off/os-roots.mjs'
const darwinRoots = osRootsFor('darwin') // the readers are reached through their one table, as src/ reaches them
const unavailable = (e) => e instanceof Error && e.name === 'RootsUnavailableError'

const R = [createCa({ commonName: 'macOS root one' }), createCa({ commonName: 'macOS root two' }), createCa({ commonName: 'macOS root three' })].map((c) => c.certPem)
const BROKEN = '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n'
const fp = (pem) => new crypto.X509Certificate(pem).fingerprint256
const execOf = (pems, calls = []) => (file, args, opts) => { calls.push([file, args, opts]); return { status: 0, stdout: pems.join('\n'), stderr: '' } }

test('W20: the macOS roots are the union of Node\'s bundled set, the keychain\'s local trust anchors and the security export — parsed one by one: a certificate that does not parse is dropped and counted, a duplicate is kept once, and every source that contributed is named', async () => {
  const asked = []
  const calls = []
  const tls = { getCACertificates: (k) => { asked.push(k); return k === 'bundled' ? [R[0], BROKEN, R[1], R[0]] : [R[1], R[2]] } }
  const r = await darwinRoots({ tls, exec: execOf([R[0]], calls) })
  assert.deepEqual(asked, ['bundled', 'system'], 'both Node reads, bundled first (the steadier text for a certificate both hold)')
  assert.deepEqual([calls[0][0], calls[0][1]], ['security', ['find-certificate', '-a', '-p', '/System/Library/Keychains/SystemRootCertificates.keychain']], 'the read-only export of Apple\'s standard roots')
  assert.ok(calls[0][2].timeout >= 10000, 'a read-only CLI exporting one keychain: the call is given time (execTool hands the runner spawnSync\'s own options)')
  assert.deepEqual(r.source, ['node-bundled', 'node-system', 'security'], 'a union has no single winner: the array names every source that contributed, in the fixed order')
  assert.equal(r.dropped, 1)
  assert.deepEqual(r.pem.match(/-----BEGIN CERTIFICATE-----/g).length, 3, 'three distinct certificates: R0 R1 R2, each once however often the sources overlap')
  assert.ok(r.pem.includes(R[0].trim()) && r.pem.includes(R[1].trim()) && r.pem.includes(R[2].trim()) && !r.pem.includes('bm90IGEg'), 'the broken block is not in the text')
  assert.ok(r.pem.endsWith('\n') && !r.pem.includes('\n\n'))
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/)
  assert.deepEqual(r.tried, [], 'every source answered: nothing to say')
})

test('W20: a source that fails while the others give the set is named in tried (D38), and with no usable source at all the answer is a reason, not an empty bundle; the sandbox refusal is re-thrown, never passed off as a failed source', async () => {
  const oneDown = await darwinRoots({ tls: { getCACertificates: (k) => k === 'bundled' ? [R[0]] : (() => { throw Object.assign(new Error('no keychain read'), { code: 'EIO' }) })() }, exec: () => ({ status: 1, stdout: '', stderr: 'segv' }) })
  assert.deepEqual([oneDown.source, oneDown.tried], [['node-bundled'], ['node-system: EIO', 'security: segv']], 'a bundle quietly missing two of its three sources is not fine: both failures are said')
  const clean = await darwinRoots({ tls: { getCACertificates: (k) => k === 'bundled' ? [R[0]] : [] }, exec: execOf([R[1]]) })
  assert.deepEqual([clean.source, clean.tried], [['node-bundled', 'security'], []], 'a keychain with no added anchor answers empty: that is not a failed read (no daily alarm on a clean Mac)')
  // an EMPTY answer is not a failed read (above); a missing read is, and with no source at all every reason is kept, empty or failed, in source order
  const node20 = await darwinRoots({ tls: {}, exec: execOf([R[1]]) })
  assert.deepEqual([node20.source, node20.tried.length], [['security'], 1], 'Node 20: the standard set from the export, and the missing keychain read is said')
  assert.match(node20.tried[0], /^getCACertificates: not available/)
  await assert.rejects(darwinRoots({ tls: { getCACertificates: (k) => k === 'bundled' ? [] : (() => { throw Object.assign(new Error('x'), { code: 'EIO' }) })() }, exec: execOf([]) }),
    (e) => unavailable(e) && e.tried.join(' | ') === 'node-bundled: no certificate | node-system: EIO | security: no certificate', 'nothing at all: every source\'s reason, empty or failed, in source order')
  await assert.rejects(darwinRoots({ tls: {}, exec: () => ({ status: 1, stdout: '', stderr: '' }) }), (e) => unavailable(e) && /could not be read/.test(e.message) && e.tried.length === 2 && /Node ≥ 22.15/.test(e.tried[0]) && e.tried[1] === 'security: exit 1', 'no Node 22.15 read and a failed export: both reasons')
  await assert.rejects(darwinRoots({ tls: { getCACertificates: () => [BROKEN] }, exec: execOf([BROKEN]) }), (e) => unavailable(e) && e.tried.length === 3 && e.tried.every((t) => t.endsWith(': no certificate')), 'stores of nothing but broken certificates are not a root set')
  await assert.rejects(darwinRoots({ tls: {}, exec: () => { throw new Error('boom') } }), (e) => unavailable(e) && /security: boom/.test(e.message), 'a thrown runner is a reason')
  await assert.rejects(darwinRoots({ tls: { getCACertificates: () => [R[0]] }, exec: () => { throw Object.assign(new Error('sandbox'), { code: 'ESANDBOX' }) } }), (e) => e.code === 'ESANDBOX', 'the sandbox refusal reaches the test even when another source already gave a set')
})

test('W20: the fingerprint is of the set, not of its order or its duplicates, and changes with the set', async () => {
  const a = await darwinRoots({ tls: { getCACertificates: (k) => k === 'bundled' ? [R[0], R[1]] : [] }, exec: () => ({ status: 1, stdout: '', stderr: '' }) })
  assert.equal((await darwinRoots({ tls: { getCACertificates: (k) => k === 'bundled' ? [R[1], R[0], R[1]] : [R[0]] }, exec: () => ({ status: 1, stdout: '', stderr: '' }) })).fingerprint, a.fingerprint)
  assert.notEqual((await darwinRoots({ tls: { getCACertificates: (k) => k === 'bundled' ? [R[0], R[2]] : [] }, exec: () => ({ status: 1, stdout: '', stderr: '' }) })).fingerprint, a.fingerprint)
})

test('W20: the darwin reader reads no file at all — never the static /etc/ssl/cert.pem a lazy port would reach for, not even through the `read` the table\'s callers pass (off does)', async () => {
  assert.equal(darwinRoots.name, 'darwinRoots', 'darwin\'s entry of the one table (src/off/os-roots.mjs)')
  assert.ok(!/cert\.pem|\/etc\/ssl|readFile|createReadStream|\bfs\b|\bread\b/.test(darwinRoots.toString().replace(/\/\/.*$/gm, '')), 'its own code names no file and takes no reader')
  const reads = []
  const real = nodeFs.readFileSync
  nodeFs.readFileSync = (...a) => { reads.push(String(a[0])); return real(...a) }
  try { await osRootsFor('darwin')({ tls: { getCACertificates: (k) => k === 'bundled' ? [R[0]] : [] }, exec: execOf([R[1]]), read: (f) => { reads.push(f); return '' } }) } finally { nodeFs.readFileSync = real }
  assert.deepEqual(reads, [])
})
