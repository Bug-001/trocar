// test/collector/core/tls/root.test.mjs — CM1 (RFC 4.11 §验收): the ROOT and INTERMEDIATE profiles of P1 / P2 and checkProfile, the one
// checker install runs on the root a custody returns and the issuer on every intermediate. The stub custody's root and
// intermediate pass; variants generated off the root's extension list each fail, with the violation named.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { ROOT, INTERMEDIATE, OID_SERVER_AUTH, checkProfile, buildCertificateDer, rootCertDer, name, ext } from '../../../../src/collector/core/tls/cert.mjs'
import { seq, tlv } from '../../../../src/collector/core/tls/der.mjs'
import { custodyStub } from '../../../helpers/custody-stub.mjs'

const DAY = 86400e3
const keyOf = (curve = 'prime256v1') => crypto.generateKeyPairSync('ec', { namedCurve: curve })
const spki = (k) => k.publicKey.export({ type: 'spki', format: 'der' })
const sign = (k) => (tbs) => crypto.sign('sha256', tbs, k.privateKey)
const now = Date.now()

// a root over `k`, signed by `by`, with extensions `exts` — the axes the variants move along
function cert({ k = keyOf(), by = k, issuer = 'trocar root (test)', exts }) {
  return buildCertificateDer({ serial: Buffer.from([1]), issuer: name(issuer), subject: name('trocar root (test)'), notBefore: new Date(now - DAY), notAfter: new Date(now + 365 * DAY),
    spkiDer: spki(k), sign: sign(by), extensions: exts(k) })
}
const base = { bc: (k) => ext.basicConstraints(true, 1), ku: () => ext.keyUsage(0x06), eku: () => ext.extKeyUsageServerAuth(), ski: (k) => ext.subjectKeyId(spki(k)) }
const withExt = (over) => (k) => Object.values({ ...base, ...over }).map((f) => f(k))

test('CM1 the stub custody\'s root is the ROOT profile, and the same shape built by hand passes too', () => {
  const stub = custodyStub()
  const { rootDer, fp256 } = stub.create()
  assert.deepEqual(checkProfile(rootDer, ROOT), [])
  assert.equal(fp256, new crypto.X509Certificate(rootDer).fingerprint256)
  assert.deepEqual(checkProfile(cert({ exts: withExt({}) }), ROOT), [])
})

const NAME_CONSTRAINTS = () => ext.custom('2.5.29.30', seq(tlv(0xa0, seq(tlv(0x82, Buffer.from('example.test'))))), true)
const variants = [
  ['name constraints present', { exts: withExt({ nc: NAME_CONSTRAINTS }) }, /name constraints/],
  ...[0, 2, null].map((n) => [`pathLen ${n ?? 'absent'}`, { exts: withExt({ bc: () => ext.basicConstraints(true, n) }) }, /pathLen/]),
  ['CA:false', { exts: withExt({ bc: () => ext.basicConstraints(false) }) }, /CA:true/],
  ['an extra EKU (clientAuth)', { exts: withExt({ eku: () => ext.extKeyUsage([OID_SERVER_AUTH, '1.3.6.1.5.5.7.3.2']) }) }, /EKU/],
  ['no EKU', { exts: (k) => [base.bc(k), base.ku(k), base.ski(k)] }, /EKU/],
  ['not self-signed: signed by another key', { by: keyOf(), exts: withExt({}) }, /self-signed/],
  ['not self-signed: another issuer name', { issuer: 'someone else', exts: withExt({}) }, /self-signed/],
  ['a P-384 key', { k: keyOf('secp384r1'), exts: withExt({}) }, /P-256/],
]
for (const [what, o, re] of variants) {
  test(`CM1 checkProfile(ROOT) rejects: ${what}`, () => {
    const bad = checkProfile(cert(o), ROOT)
    assert.ok(bad.length >= 1, `${what} passed the root profile`)
    assert.ok(bad.some((b) => re.test(b)), `${what}: ${bad.join(' | ')}`)
  })
}

test('CM1 the intermediate the custody issues is the INTERMEDIATE profile against its root, and nothing else', () => {
  const stub = custodyStub(); stub.create()
  const k = keyOf()
  const der = stub.issueIntermediate({ spkiDer: spki(k), serial: Buffer.from([7]), notBefore: new Date(now) })
  assert.deepEqual(checkProfile(der, INTERMEDIATE, { root: stub.rootDer }), [])
  assert.ok(checkProfile(der, ROOT).some((b) => /pathLen|self-signed/.test(b)), 'an intermediate is not a root')
  assert.ok(checkProfile(stub.rootDer, INTERMEDIATE, { root: stub.rootDer }).some((b) => /pathLen/.test(b)), 'a root is not an intermediate')
  const other = custodyStub(); other.create()
  assert.ok(checkProfile(der, INTERMEDIATE, { root: other.rootDer }).some((b) => /signed by the root|issuer/.test(b)), 'checked against another root')
  assert.ok(checkProfile(der, INTERMEDIATE).some((b) => /no root/.test(b)), 'without a root to check against')
  // 8 days instead of 7: a hand-built intermediate shape with the wrong validity
  const long = rootCertDer({ subject: 'x', spkiDer: spki(k), serial: Buffer.from([8]), notBefore: new Date(now), notAfter: new Date(now + 8 * DAY), sign: sign(k) })
  assert.ok(checkProfile(long, INTERMEDIATE, { root: stub.rootDer }).some((b) => /valid 8 days/.test(b)))
  assert.deepEqual(checkProfile(Buffer.from('junk'), ROOT).length, 1)
})
