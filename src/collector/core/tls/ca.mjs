// ca.mjs — the collector's in-process root CA (RFC 4.6 §身份与信任): v3, ECDSA P-256,
// BasicConstraints CA:TRUE critical, KeyUsage keyCertSign|cRLSign critical, Subject Key Identifier.
// Minted with node:crypto, zero dependencies. The private key never leaves this process in Plan 1;
// Plan 2's arch layer owns persistence (root-only /etc/asight/ca/ca.key).
import crypto from 'node:crypto'
import { name, ext, buildCertificate, certSubjectAndSki } from './cert.mjs'

const DAY = 86400e3

/** Create a fresh CA keypair + self-signed v3 certificate. Returns PEM strings. */
export function createCa({ commonName = 'asight collector CA', now = new Date(), years = 10 } = {}) {
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
