// cert.mjs — X.509 v3 certificate builder on top of der.mjs. ECDSA P-256 / ecdsa-with-SHA256
// throughout (RFC 4.6 §身份与信任). buildCertificate signs a TBSCertificate with node:crypto — or hands it to a
// `sign(tbs)` callback, so a root key held by an OS custody backend never enters Node (4.11 P2) — and PEM-wraps it;
// certSubjectAndSki walks a finished cert back out for the leaf issuer (AKI = CA SKI). The root and intermediate
// profiles of 4.11 P1/P2 live here once: the builders a custody backend uses, and checkProfile, which install runs on
// the root a custody returns and the issuer on every intermediate.
import crypto from 'node:crypto'
import net from 'node:net'
import { tlv, seq, set, int, oid, utf8, bitString, octet, bool, explicit, time, readTlv } from './der.mjs'

const OID_CN = '2.5.4.3'
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2'
const OID_SKI = '2.5.29.14'
const OID_BC = '2.5.29.19'
const OID_EKU = '2.5.29.37'
const OID_NAME_CONSTRAINTS = '2.5.29.30'
export const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1'
const DAY = 86400e3

// Name ::= RDNSequence of one RDN carrying commonName (UTF8String).
export function name(cn) {
  return seq(set(seq(oid(OID_CN), utf8(cn))))
}

// keyIdentifier = SHA-1 over the subjectPublicKey BIT STRING *contents* (RFC 5280 §4.2.1.2 method 1).
function keyId(pub) {
  const spki = Buffer.isBuffer(pub) ? pub : pub.export({ type: 'spki', format: 'der' })
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

const extKeyUsage = (oids) => extension(OID_EKU, seq(...oids.map((o) => oid(o))))
export const ext = {
  // pathLen: an integer adds pathLenConstraint; null / absent leaves it out (a CA without a limit)
  basicConstraints: (ca, pathLen = null) => extension(OID_BC, ca ? seq(bool(true), ...(pathLen == null ? [] : [int(BigInt(pathLen))])) : seq(), true),
  keyUsage: (bits) => extension('2.5.29.15', keyUsageBits(bits), true),
  extKeyUsage,
  extKeyUsageServerAuth: () => extKeyUsage([OID_SERVER_AUTH]),
  custom: extension,
  subjectAltName: ({ dns = [], ip = [] }) => extension('2.5.29.17', seq(
    ...dns.map((d) => tlv(0x82, Buffer.from(d, 'ascii'))),   // [2] dNSName
    ...ip.map((a) => tlv(0x87, ipBytes(a))))),               // [7] iPAddress
  subjectKeyId: (pub) => extension(OID_SKI, octet(keyId(pub))), // pub: a KeyObject or SPKI DER
  authorityKeyId: (id) => extension('2.5.29.35', seq(tlv(0x80, id))), // [0] keyIdentifier
}

/** The certificate DER. The public key is `publicKey` (a KeyObject) or `spkiDer`; the signature is node:crypto's with
 *  `signingKey`, or what `sign(tbsDer)` returns (DER ECDSA; a Promise of it makes the result a Promise too). */
export function buildCertificateDer({ serial, issuer, subject, notBefore, notAfter, publicKey, spkiDer, signingKey, sign, extensions }) {
  const tbs = seq(
    explicit(0, int(2n)),                 // version v3
    int(serial),
    seq(oid(OID_ECDSA_SHA256)),           // signature AlgorithmIdentifier (no params)
    issuer,
    seq(time(notBefore), time(notAfter)), // validity
    subject,
    spkiDer || publicKey.export({ type: 'spki', format: 'der' }), // SubjectPublicKeyInfo embedded as-is
    explicit(3, seq(...extensions)),      // [3] EXPLICIT extensions
  )
  const done = (sig) => seq(tbs, seq(oid(OID_ECDSA_SHA256)), bitString(Buffer.from(sig)))
  const sig = sign ? sign(tbs) : crypto.sign('sha256', tbs, signingKey) // DER ECDSA signature
  return sig && typeof sig.then === 'function' ? sig.then(done) : done(sig)
}

export function buildCertificate(o) {
  const der = buildCertificateDer(o)
  return typeof der.then === 'function' ? der.then(certPem) : certPem(der)
}

export const certPem = (der) => pemWrap(der, 'CERTIFICATE')

function pemWrap(der, label) {
  const b64 = der.toString('base64').match(/.{1,64}/g) || ['']
  return `-----BEGIN ${label}-----\n${b64.join('\n')}\n-----END ${label}-----\n`
}

export function pemToDer(pem) {
  const b64 = pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '')
  return Buffer.from(b64, 'base64')
}

const derOf = (c) => (Buffer.isBuffer(c) ? c : pemToDer(String(c)))

function oidText(b) {
  const parts = [Math.floor(b[0] / 40), b[0] % 40]
  let v = 0
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(v); v = 0 } }
  return parts.join('.')
}

// The parts of a certificate the profiles and the leaf issuer read: issuer and subject Names (full TLVs, reusable verbatim)
// and the extensions, each {oid, critical, value: the extnValue OCTET STRING's content}.
function parseCert(der) {
  const cert = readTlv(der, 0)
  const tbs = readTlv(der, cert.start)
  let o = tbs.start
  let t = readTlv(der, o)
  if (t.tag === 0xa0) { o = t.end; t = readTlv(der, o) }   // optional version [0]
  o = t.end                                                 // serialNumber → signature alg
  o = readTlv(der, o).end                                   // signature alg → issuer
  const iss = readTlv(der, o)
  const issuer = Buffer.from(der.subarray(o, iss.end))
  o = readTlv(der, iss.end).end                             // validity → subject
  const sub = readTlv(der, o)
  const subject = Buffer.from(der.subarray(o, sub.end))
  o = readTlv(der, sub.end).end                             // SubjectPublicKeyInfo
  const exts = []
  for (; o < tbs.end; o = readTlv(der, o).end) {
    const x = readTlv(der, o)
    if (x.tag !== 0xa3) continue
    const list = readTlv(der, x.start)
    for (let eo = list.start; eo < list.end;) {
      const e = readTlv(der, eo)
      const id = readTlv(der, e.start)
      let v = readTlv(der, id.end), critical = false
      if (v.tag === 0x01) { critical = der[v.start] !== 0; v = readTlv(der, v.end) }
      exts.push({ oid: oidText(der.subarray(id.start, id.end)), critical, value: Buffer.from(der.subarray(v.start, v.end)) })
      eo = e.end
    }
  }
  return { issuer, subject, exts }
}

// Walk a finished certificate (PEM or DER) to pull the subject Name (full TLV, reusable verbatim as an
// issuer) and the Subject Key Identifier value (the raw 20-byte keyId, or null).
export function certSubjectAndSki(cert) {
  const { subject, exts } = parseCert(derOf(cert))
  const e = exts.find((x) => x.oid === OID_SKI)
  const inner = e && readTlv(e.value, 0)                    // extnValue wraps the SKI OCTET STRING
  return { subject, ski: e ? Buffer.from(e.value.subarray(inner.start, inner.end)) : null }
}

// ---- the custody profiles (4.11 P1 / P2) ──────────────----------------------------------------------------------------------------
/** The root a custody backend self-signs: no name constraints, CA pathLen 1, EKU serverAuth alone, P-256. */
export const ROOT = Object.freeze({ name: 'root', pathLen: 1, selfSigned: true })
/** The intermediate a custody backend issues for the daemon's in-memory key: CA pathLen 0, EKU serverAuth, 7 days, signed by the root. */
export const INTERMEDIATE = Object.freeze({ name: 'intermediate', pathLen: 0, selfSigned: false, validityDays: 7 })
const KU_CA = 0x06 // keyCertSign | cRLSign
const caExtensions = (pathLen, spkiDer) => [ext.basicConstraints(true, pathLen), ext.keyUsage(KU_CA), ext.extKeyUsageServerAuth(), ext.subjectKeyId(spkiDer)]
const asName = (n) => (Buffer.isBuffer(n) ? n : name(n))

/** The ROOT profile's certificate DER over `spkiDer`, signed by `sign(tbs)` (the custody backend's own key). */
export function rootCertDer({ subject, spkiDer, serial, notBefore, notAfter, sign }) {
  const n = asName(subject)
  return buildCertificateDer({ serial, issuer: n, subject: n, notBefore, notAfter, spkiDer, sign, extensions: caExtensions(ROOT.pathLen, spkiDer) })
}

/** The INTERMEDIATE profile's certificate DER for `spkiDer`: issuer = the root's subject, AKI = its SKI, valid 7 days from notBefore. */
export function intermediateCertDer({ root, subject, spkiDer, serial, notBefore, sign }) {
  const r = certSubjectAndSki(root)
  return buildCertificateDer({ serial, issuer: r.subject, subject: asName(subject), notBefore, notAfter: new Date(notBefore.getTime() + INTERMEDIATE.validityDays * DAY),
    spkiDer, sign, extensions: [...caExtensions(INTERMEDIATE.pathLen, spkiDer), ext.authorityKeyId(r.ski)] })
}

function basicOf(v) {
  const s = readTlv(v, 0)
  let o = s.start, ca = false, pathLen = null
  if (o < s.end && v[o] === 0x01) { const t = readTlv(v, o); ca = v[t.start] !== 0; o = t.end }
  if (o < s.end && v[o] === 0x02) { const t = readTlv(v, o); pathLen = parseInt(v.subarray(t.start, t.end).toString('hex'), 16) }
  return { ca, pathLen }
}
function oidsOf(v) {
  const s = readTlv(v, 0), out = []
  for (let o = s.start; o < s.end;) { const t = readTlv(v, o); out.push(oidText(v.subarray(t.start, t.end))); o = t.end }
  return out
}

/** checkProfile(cert, profile, { root }) → [] or the violations, one line each. `cert` and `root` are DER or PEM; an
 *  INTERMEDIATE is checked against `root` (issuer = its subject, signed by its key). Never throws. */
export function checkProfile(cert, profile, { root = null } = {}) {
  const bad = []
  let der, x, p
  try { der = derOf(cert); x = new crypto.X509Certificate(der); p = parseCert(der) } catch (e) { return [`the certificate does not parse (${(e && e.message) || e})`] }
  const one = (id) => p.exts.find((e) => e.oid === id)
  const bc = one(OID_BC) && basicOf(one(OID_BC).value)
  if (!bc || !bc.ca) bad.push('basicConstraints is not CA:true')
  else if (bc.pathLen !== profile.pathLen) bad.push(`pathLen is ${bc.pathLen ?? 'absent'}, not ${profile.pathLen}`)
  if (one(OID_NAME_CONSTRAINTS)) bad.push('it has name constraints')
  const eku = one(OID_EKU) ? oidsOf(one(OID_EKU).value) : []
  if (eku.length !== 1 || eku[0] !== OID_SERVER_AUTH) bad.push(`EKU is [${eku.join(', ')}], not serverAuth alone`)
  const curve = x.publicKey.asymmetricKeyDetails && x.publicKey.asymmetricKeyDetails.namedCurve
  if (curve !== 'prime256v1') bad.push(`the key is ${curve || x.publicKey.asymmetricKeyType}, not P-256`)
  if (profile.selfSigned) {
    if (!p.issuer.equals(p.subject) || !x.verify(x.publicKey)) bad.push('it is not self-signed')
  } else {
    let r = null
    try { r = root && new crypto.X509Certificate(derOf(root)) } catch { /* said below */ }
    if (!r) bad.push('no root to check it against')
    else {
      if (!p.issuer.equals(parseCert(r.raw).subject)) bad.push('its issuer is not the root\'s subject')
      if (!x.verify(r.publicKey)) bad.push('it is not signed by the root')
    }
  }
  if (profile.validityDays != null) {
    const days = (Date.parse(x.validTo) - Date.parse(x.validFrom)) / DAY
    if (days !== profile.validityDays) bad.push(`it is valid ${days} days, not ${profile.validityDays}`)
  }
  return bad
}
