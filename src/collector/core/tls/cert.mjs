// cert.mjs — X.509 v3 certificate builder on top of der.mjs. ECDSA P-256 / ecdsa-with-SHA256
// throughout (RFC 4.6 §身份与信任). buildCertificate signs a TBSCertificate with node:crypto and
// PEM-wraps it; certSubjectAndSki walks a finished cert back out for the leaf issuer (AKI = CA SKI).
import crypto from 'node:crypto'
import net from 'node:net'
import { tlv, seq, set, int, oid, utf8, bitString, octet, bool, explicit, time, readTlv } from './der.mjs'

const OID_CN = '2.5.4.3'
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2'
const OID_SKI = '2.5.29.14'

// Name ::= RDNSequence of one RDN carrying commonName (UTF8String).
export function name(cn) {
  return seq(set(seq(oid(OID_CN), utf8(cn))))
}

// keyIdentifier = SHA-1 over the subjectPublicKey BIT STRING *contents* (RFC 5280 §4.2.1.2 method 1).
function keyId(pub) {
  const spki = pub.export({ type: 'spki', format: 'der' })
  const outer = readTlv(spki, 0)                 // SubjectPublicKeyInfo SEQUENCE
  const alg = readTlv(spki, outer.start)         // AlgorithmIdentifier
  const bits = readTlv(spki, alg.end)            // subjectPublicKey BIT STRING
  const keyBytes = spki.subarray(bits.start + 1, bits.end) // skip the unused-bits count byte
  return crypto.createHash('sha1').update(keyBytes).digest()
}

// KeyUsage BIT STRING from a single content byte, DER-minimal (trailing zero bits dropped).
function keyUsageBits(firstByte) {
  let unused = 0
  if (firstByte === 0) unused = 8
  else { let b = firstByte; while ((b & 1) === 0) { b >>= 1; unused++ } }
  return tlv(0x03, Buffer.from([unused, firstByte]))
}

function ipBytes(a) {
  if (net.isIPv4(a)) return Buffer.from(a.split('.').map((n) => Number(n) & 0xff))
  // IPv6 → 16 bytes, expanding a single '::' run.
  let head = a, tail = ''
  if (a.includes('::')) { const [h, t] = a.split('::'); head = h; tail = t }
  const hp = head ? head.split(':') : []
  const tp = tail ? tail.split(':') : []
  const groups = [...hp, ...Array(Math.max(0, 8 - hp.length - tp.length)).fill('0'), ...tp]
  const out = Buffer.alloc(16)
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i] || '0', 16)
    out[i * 2] = (v >> 8) & 0xff
    out[i * 2 + 1] = v & 0xff
  }
  return out
}

// Extension ::= SEQUENCE { extnID OID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }
const extension = (oidStr, value, critical = false) =>
  seq(oid(oidStr), ...(critical ? [bool(true)] : []), octet(value))

export const ext = {
  basicConstraints: (ca) => extension('2.5.29.19', ca ? seq(bool(true)) : seq(), true),
  keyUsage: (bits) => extension('2.5.29.15', keyUsageBits(bits), true),
  extKeyUsageServerAuth: () => extension('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.1'))),
  subjectAltName: ({ dns = [], ip = [] }) => extension('2.5.29.17', seq(
    ...dns.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))),   // [2] dNSName
    ...ip.map((a) => tlv(0x87, ipBytes(a))))),               // [7] iPAddress
  subjectKeyId: (pub) => extension('2.5.29.14', octet(keyId(pub))),
  authorityKeyId: (id) => extension('2.5.29.35', seq(tlv(0x80, id))), // [0] keyIdentifier
}

export function buildCertificate({ serial, issuer, subject, notBefore, notAfter, publicKey, signingKey, extensions }) {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' })
  const tbs = seq(
    explicit(0, int(2n)),                 // version v3
    int(serial),
    seq(oid(OID_ECDSA_SHA256)),           // signature AlgorithmIdentifier (no params)
    issuer,
    seq(time(notBefore), time(notAfter)), // validity
    subject,
    spkiDer,                              // SubjectPublicKeyInfo embedded as-is
    explicit(3, seq(...extensions)),      // [3] EXPLICIT extensions
  )
  const sig = crypto.sign('sha256', tbs, signingKey) // DER ECDSA signature
  const cert = seq(tbs, seq(oid(OID_ECDSA_SHA256)), bitString(sig))
  return pemWrap(cert, 'CERTIFICATE')
}

function pemWrap(der, label) {
  const b64 = der.toString('base64').match(/.{1,64}/g) || ['']
  return `-----BEGIN ${label}-----\n${b64.join('\n')}\n-----END ${label}-----\n`
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '')
  return Buffer.from(b64, 'base64')
}

function oidContentEquals(contentBuf, dotted) {
  const full = oid(dotted)
  const t = readTlv(full, 0)
  return Buffer.compare(contentBuf, full.subarray(t.start, t.end)) === 0
}

// Walk a finished certificate's DER to pull the subject Name (full TLV, reusable verbatim as an
// issuer) and the Subject Key Identifier value (the raw 20-byte keyId, or null).
export function certSubjectAndSki(certPem) {
  const der = pemToDer(certPem)
  const cert = readTlv(der, 0)
  const tbs = readTlv(der, cert.start)
  let o = tbs.start
  let t = readTlv(der, o)
  if (t.tag === 0xa0) { o = t.end; t = readTlv(der, o) }   // optional version [0]
  o = t.end; t = readTlv(der, o)                            // serialNumber → signature alg
  o = t.end; t = readTlv(der, o)                            // signature alg → issuer
  o = t.end; t = readTlv(der, o)                            // issuer → validity
  o = t.end                                                 // validity → subject
  const subjectTlv = readTlv(der, o)
  const subject = Buffer.from(der.subarray(o, subjectTlv.end))
  o = subjectTlv.end
  const spki = readTlv(der, o)
  o = spki.end
  let ski = null
  if (o < cert.end) {
    const extsExplicit = readTlv(der, o)
    if (extsExplicit.tag === 0xa3) {
      const extsSeq = readTlv(der, extsExplicit.start)
      let eo = extsSeq.start
      while (eo < extsSeq.end) {
        const extTlv = readTlv(der, eo)
        let io = extTlv.start
        const idTlv = readTlv(der, io)
        const idContent = der.subarray(idTlv.start, idTlv.end)
        io = idTlv.end
        let v = readTlv(der, io)
        if (v.tag === 0x01) { io = v.end; v = readTlv(der, io) } // skip critical BOOLEAN
        if (oidContentEquals(idContent, OID_SKI)) {
          const inner = readTlv(der, v.start)                     // extnValue OCTET STRING wraps the SKI OCTET STRING
          ski = Buffer.from(der.subarray(inner.start, inner.end))
        }
        eo = extTlv.end
      }
    }
  }
  return { subject, ski }
}
