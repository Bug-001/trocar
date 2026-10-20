// test/off/pem.test.mjs — src/off/pem.mjs (RFC 4.6 撤销顺序第 2 / 3 步, 1.6 R3): the PEM readers `off` needs without the collector. certBlocks lists
// the certificates of a file by fingerprint; stripCert takes one out and leaves every other byte; composeBundle (moved from the collector's
// bundle.mjs, which still re-exports it) makes "the same bundle without the trocar CA" the same bytes as stripCert makes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import { certBlocks, stripCert, composeBundle, certsOf } from '../../src/off/pem.mjs'
import * as collectorBundle from '../../src/collector/core/trust/bundle.mjs'

const A = createCa({ commonName: 'pem A' }), B = createCa({ commonName: 'pem B' }), C = createCa({ commonName: 'pem C' })
const fp = (ca) => new X509Certificate(ca.certPem).fingerprint256
const KEY = '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n'

test('certBlocks lists the CERTIFICATE blocks of a file in order, each with the fingerprint of its certificate; keys, junk and cut-short blocks are not certificates', () => {
  const text = `# header\n${KEY}${A.certPem}\nnoise\n${B.certPem}-----BEGIN CERTIFICATE-----\nnot base64 !!\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\ncut short`
  const got = certBlocks(text)
  assert.deepEqual(got.map((b) => b.fp), [fp(A), fp(B)])
  assert.ok(got[0].pem.startsWith('-----BEGIN CERTIFICATE-----') && got[0].pem.endsWith('-----END CERTIFICATE-----'))
  assert.deepEqual(certBlocks(''), [])
  assert.deepEqual(certBlocks(KEY), [])
})

test('stripCert takes out the block of one fingerprint and its newline, and not one other byte: first, middle, last, duplicated, CRLF, no trailing newline', () => {
  const [a, b, c] = [A, B, C].map((x) => x.certPem.trim())
  const doc = (...parts) => parts.join('')
  const text = doc('# user header\n', a, '\n', '\n# a user comment\n', b, '\n', c, '\n', '# footer')
  for (const [ca, rest] of [[A, doc('# user header\n', '\n# a user comment\n', b, '\n', c, '\n', '# footer')], [B, doc('# user header\n', a, '\n', '\n# a user comment\n', c, '\n', '# footer')], [C, doc('# user header\n', a, '\n', '\n# a user comment\n', b, '\n', '# footer')]]) {
    assert.deepEqual(stripCert(text, fp(ca)), { text: rest, removed: true }, `taking out ${ca === A ? 'A' : ca === B ? 'B' : 'C'}`)
  }
  const bundle = `${a}\n${b}\n${c}\n`
  assert.equal(stripCert(bundle, fp(C)).text, `${a}\n${b}\n`, 'the last block of a bundle')
  assert.equal(stripCert(`${a}\n${b}`, fp(B)).text, `${a}\n`, 'a last block with no newline after it leaves the one before intact')
  assert.deepEqual(stripCert(`${a}\n${b}\n${a}\n`, fp(A)), { text: `${b}\n`, removed: true }, 'a certificate that is in twice goes both times')
  assert.equal(stripCert(bundle.replace(/\n/g, '\r\n'), fp(B)).text, bundle.replace(/\n/g, '\r\n').replace(`${b.replace(/\n/g, '\r\n')}\r\n`, ''), 'CRLF files keep their line endings')
  assert.deepEqual(stripCert(bundle, fp(createCa({ commonName: 'not there' }))), { text: bundle, removed: false }, 'not there: the same text back, removed false')
})

test('stripCert of the trocar CA from a composed bundle is byte for byte the bundle composed without it (so "the same file without the trocar CA" is one thing)', () => {
  const roots = { nodeRoots: [A.certPem], osRootsText: B.certPem }
  const withCa = composeBundle({ ...roots, userCerts: [C.certPem], caPem: createCa({ commonName: 'trocar' }).certPem })
  const caFp = certBlocks(withCa.data).at(-1).fp
  const without = composeBundle({ ...roots, userCerts: [C.certPem], caPem: null })
  assert.equal(stripCert(withCa.data, caFp).text, without.data)
  assert.deepEqual(without.user_fps, withCa.user_fps)
})

test('composeBundle and certsOf are the collector\'s own: bundle.mjs re-exports the functions that moved into src/off/pem.mjs', () => {
  assert.equal(collectorBundle.composeBundle, composeBundle)
  assert.equal(collectorBundle.certsOf, certsOf)
})
