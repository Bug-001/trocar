// leaf.mjs — per-SNI leaf issuer (RFC 4.6 §身份与信任). One P-256 leaf key per issuer instance,
// in memory only, regenerated each time the daemon starts. Leaves are v3, CA:FALSE,
// KeyUsage digitalSignature critical, EKU serverAuth, AKI = CA SKI, issuer = CA subject verbatim,
// 199-day validity, backdated 2 days. Certs and SecureContexts are cached per host (LRU).
import tls from 'node:tls'
import crypto from 'node:crypto'
import net from 'node:net'
import { name, ext, buildCertificate } from './cert.mjs'

const DAY = 86400e3

export function createLeafIssuer(ca, { now = () => new Date(), validityDays = 199, backdateDays = 2, cacheSize = 256 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const certCache = new Map() // host → {certPem, keyPem}
  const ctxCache = new Map()  // host → tls.SecureContext

  // Map used as an LRU: on hit, delete + re-set so recent keys sort last; evict from the front.
  function touch(m, key) { const v = m.get(key); m.delete(key); m.set(key, v); return v }
  function evict(m) { while (m.size > cacheSize) m.delete(m.keys().next().value) }

  function issue(host) {
    if (certCache.has(host)) return touch(certCache, host)
    const n = now()
    const serial = crypto.randomBytes(16); serial[0] &= 0x7f
    const isIp = net.isIP(host) !== 0
    const certPem = buildCertificate({
      serial,
      issuer: ca.subject,              // CA subject DN bytes, reused verbatim
      subject: name(host),
      notBefore: new Date(n.getTime() - backdateDays * DAY),
      notAfter: new Date(n.getTime() + validityDays * DAY),
      publicKey, signingKey: ca.key,
      extensions: [
        ext.basicConstraints(false),
        ext.keyUsage(0x80),            // digitalSignature
        ext.extKeyUsageServerAuth(),
        ext.subjectAltName(isIp ? { ip: [host] } : { dns: [host] }),
        ext.authorityKeyId(ca.ski),
      ],
    })
    const rec = { certPem, keyPem }
    certCache.set(host, rec); evict(certCache)
    return rec
  }

  function secureContextFor(host) {
    if (ctxCache.has(host)) return touch(ctxCache, host)
    const { certPem } = issue(host)
    // Send the leaf AND the CA so strict clients see the full chain.
    const ctx = tls.createSecureContext({ key: keyPem, cert: certPem + '\n' + ca.certPem })
    ctxCache.set(host, ctx); evict(ctxCache)
    return ctx
  }

  return { issue, secureContextFor, get size() { return certCache.size } }
}
