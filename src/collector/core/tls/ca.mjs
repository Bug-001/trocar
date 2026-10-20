// ca.mjs — the collector's in-process root CA (RFC 4.6 §身份与信任): v3, ECDSA P-256,
// BasicConstraints CA:TRUE critical, KeyUsage keyCertSign|cRLSign critical, Subject Key Identifier.
// Minted with node:crypto, zero dependencies. Persistence is core/tls/ca-store.mjs: the operator's
// ~/.trocar/collector/ca/ca.key, 0600 (D36 — the root-only /etc/trocar location of D31⑦ is withdrawn).
import crypto from 'node:crypto'
import { name, ext, buildCertificate, certSubjectAndSki } from './cert.mjs'
import { createLeafIssuer } from './leaf.mjs'

const DAY = 86400e3

/** Create a fresh CA keypair + self-signed v3 certificate. Returns PEM strings. */
export function createCa({ commonName = 'trocar collector CA', now = new Date(), years = 10 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f          // positive
  const subject = name(commonName)
  const notBefore = new Date(now.getTime() - 2 * DAY)              // backdate 2 days for clock skew
  const notAfter = new Date(now.getTime()); notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years)
  const certPem = buildCertificate({
    serial, issuer: subject, subject, notBefore, notAfter,
    publicKey, signingKey: privateKey,
    extensions: [
      ext.basicConstraints(true),
      ext.keyUsage(0x06),            // keyCertSign (bit 5, 0x04) | cRLSign (bit 6, 0x02)
      ext.subjectKeyId(publicKey),
    ],
  })
  return { keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), certPem }
}

/** Load a CA for signing: the private key plus the subject DN bytes and SKI the leaf issuer needs. */
export function loadCa({ keyPem, certPem }) {
  const key = crypto.createPrivateKey(keyPem)
  const { subject, ski } = certSubjectAndSki(certPem)
  return { key, certPem, subject, ski }
}

/** checkCa({keyPem, certPem, now}) → {ok:true, not_after} | {ok:false, which, reason}: whether this CA can sign leaves an
 *  agent that trusts it accepts (4.6 §身份与信任「CA」, D38 D-4). which = 'key' (does not parse) · 'cert' (does not parse)
 *  · 'not-yet-valid' / 'expired' (now outside its validity) · 'pair' (a probe leaf signed with the key does not verify
 *  under the certificate's public key: key and certificate are not one pair). Never throws. */
export function checkCa({ keyPem, certPem, now = new Date() } = {}) {
  const msg = (e) => String((e && e.message) || e)
  try { crypto.createPrivateKey(keyPem) } catch (e) { return { ok: false, which: 'key', reason: `the private key does not parse (${msg(e)})` } }
  let cert
  try { cert = new crypto.X509Certificate(certPem) } catch (e) { return { ok: false, which: 'cert', reason: `the certificate does not parse (${msg(e)})` } }
  if (now < new Date(cert.validFrom)) return { ok: false, which: 'not-yet-valid', reason: `the certificate is valid from ${cert.validFrom} only (is the clock right?)` }
  if (now > new Date(cert.validTo)) return { ok: false, which: 'expired', reason: `the certificate expired ${cert.validTo}` }
  try {
    const probe = new crypto.X509Certificate(createLeafIssuer(loadCa({ keyPem, certPem }), { now: () => now }).issue('trocar-ca-probe.invalid').certPem)
    if (!probe.verify(cert.publicKey)) return { ok: false, which: 'pair', reason: 'a leaf signed with the private key does not verify under the certificate: they are not one pair' }
  } catch (e) { return { ok: false, which: 'pair', reason: `a probe leaf could not be signed (${msg(e)})` } }
  return { ok: true, not_after: new Date(cert.validTo).toISOString() }
}
