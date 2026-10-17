// leaf.mjs — per-SNI leaf issuer (RFC 4.6 §身份与信任). One P-256 leaf key per issuer instance,
// in memory only, regenerated each time the daemon starts. Leaves are v3, CA:FALSE,
// KeyUsage digitalSignature critical, EKU serverAuth, AKI = CA SKI, issuer = CA subject verbatim,
// 199-day validity, backdated 2 days. Certs and SecureContexts are cached per host (LRU). A cached leaf
// is re-signed once it is within `renewDays` (7) of its notAfter: a daemon that runs for months never
// hands out an expired leaf, which a client would reject as if it did not trust asight (RFC 4.6 §身份与信任,
// D38: 叶证缓存按 notAfter 换新). The CA is any signer object {key, certPem, subject, ski, notAfter?}: the file root on Linux,
// an intermediate on mac/win (core/tls/issuer.mjs). With `notAfter` (ms) a leaf never outlives it (4.11 P2), and such a clamped
// leaf is kept to its own notAfter: the issuer rotates the CA, and with it this whole cache, before then.
import tls from 'node:tls'
import crypto from 'node:crypto'
import net from 'node:net'
import { name, ext, buildCertificate } from './cert.mjs'

const DAY = 86400e3

export function createLeafIssuer(ca, { now = () => new Date(), validityDays = 199, backdateDays = 2, cacheSize = 256, renewDays = 7 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const certCache = new Map() // host → {certPem, keyPem}
  const ctxCache = new Map()  // host → {ctx: tls.SecureContext, rec}: rec is the leaf record it was built from
  const fresh = (rec) => rec.notAfter - (rec.clamped ? 0 : renewDays * DAY) > now().getTime()

  // Map used as an LRU: on hit, delete + re-set so recent keys sort last; evict from the front.
  function touch(m, key) { const v = m.get(key); m.delete(key); m.set(key, v); return v }
  function evict(m) { while (m.size > cacheSize) m.delete(m.keys().next().value) }

  function issue(host) {
    const hit = certCache.get(host)
    if (hit && fresh(hit)) return touch(certCache, host)
    const n = now()
    const own = n.getTime() + validityDays * DAY
    const clamped = ca.notAfter != null && ca.notAfter < own
    const notAfter = new Date(clamped ? ca.notAfter : own)
    const serial = crypto.randomBytes(16); serial[0] &= 0x7f
    const isIp = net.isIP(host) !== 0
    const certPem = buildCertificate({
      serial,
      issuer: ca.subject,              // CA subject DN bytes, reused verbatim
      subject: name(host),
      notBefore: new Date(n.getTime() - backdateDays * DAY),
      notAfter,
      publicKey, signingKey: ca.key,
      extensions: [
        ext.basicConstraints(false),
        ext.keyUsage(0x80),            // digitalSignature
        ext.extKeyUsageServerAuth(),
        ext.subjectAltName(isIp ? { ip: [host] } : { dns: [host] }),
        ext.authorityKeyId(ca.ski),
      ],
    })
    const rec = { certPem, keyPem, notAfter: notAfter.getTime(), clamped }
    certCache.delete(host); certCache.set(host, rec); evict(certCache)
    return rec
  }

  function secureContextFor(host) {
    const hit = ctxCache.get(host)
    if (hit && fresh(hit.rec)) return touch(ctxCache, host).ctx
    const rec = issue(host)
    // Send the leaf AND the CA so strict clients see the full chain.
    const ctx = tls.createSecureContext({ key: keyPem, cert: rec.certPem + '\n' + ca.certPem })
    ctxCache.delete(host); ctxCache.set(host, { ctx, rec }); evict(ctxCache)
    return ctx
  }

  /** The key and the chain a TLS context serves for `host`: leaf + the CA's certificate (4.11 P2: always leaf + intermediate). */
  const chainFor = (host) => ({ key: keyPem, cert: issue(host).certPem + ca.certPem })

  return { issue, secureContextFor, chainFor, get size() { return certCache.size } }
}
