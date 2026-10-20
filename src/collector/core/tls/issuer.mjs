// issuer.mjs — the daemon's leaf issuer over a key custody (RFC 4.11 P2). A custody without issueIntermediate (`file`, Linux)
// signs leaves with the root exactly as createLeafIssuer does today. Otherwise the root key stays in its OS backend: at start
// the issuer makes a fresh in-memory P-256 key, has the custody issue a 7-day intermediate for it, checks it against the
// INTERMEDIATE profile, and signs leaves with it; it issues the next one when the current one is 6 days old. A failure keeps
// the current intermediate, records `cert-intermediate-unavailable` once per failure streak and retries every hour; when the
// current one expires the issuer has nothing to sign with (state not 'ready', leafFor → null: the doors forward only) until an
// issue succeeds. A root key not in its custody is `cert-key-missing`, retried the same way. No private key is ever written:
// this module has no file system at all.
import crypto from 'node:crypto'
import { checkProfile, certPem, certSubjectAndSki, INTERMEDIATE } from './cert.mjs'
import { loadCa } from './ca.mjs'
import { createLeafIssuer } from './leaf.mjs'
import { CODE } from '../codes.mjs'
import { NO_KEY } from './custody-cli.mjs'

const HOUR = 3600e3
const DAY = 86400e3
const REISSUE_AFTER_MS = 6 * DAY // the next intermediate when the current one is 6 days old (4.11 P2)
const RETRY_MS = HOUR             // a failed issue is retried every hour
const SKEW_MS = 10 * 60e3 // the intermediate's notBefore is backdated this much for clock skew

// what the profile cannot know: the certificate is for the key we hold, and starts when we asked (to the second, the
// DER time resolution). A backend that signs another SPKI, or slips local time against UTC, would otherwise serve leaves
// every client refuses (a key mismatch, not yet valid) or one already expired — all silently.
function asRequested(der, { spkiDer, notBefore }) {
  const x = new crypto.X509Certificate(der)
  const bad = []
  if (!x.publicKey.export({ type: 'spki', format: 'der' }).equals(spkiDer)) bad.push('it certifies another public key than the one sent')
  if (Math.abs(Date.parse(x.validFrom) - notBefore.getTime()) >= 1000) bad.push(`notBefore ${x.validFrom}, asked ${notBefore.toISOString()}`)
  return bad
}

/** makeIssuer({ custody, root, clock, timers, record }) → { state(), leafFor(host), close() }. `root` is the installed root
 *  certificate (DER or PEM) every intermediate is checked against; `clock()` → ms; `record(r)` takes a D38 failure record. */
export async function makeIssuer({ custody, root = null, clock = () => Date.now(), timers = { setTimeout, clearTimeout }, record = () => {} }) {
  const now = () => new Date(clock())
  const fail = (code, reason) => record({ event: 'failure', where: 'ca', code, reason })

  if (typeof custody.issueIntermediate !== 'function') {
    // the file custody: today's root-signed leaves
    const ca = custody.read()
    if (ca.error) {
      const missing = !custody.exists()
      fail(missing ? CODE.certKeyMissing : 'ca-invalid', ca.error)
      return { state: () => (missing ? 'key-missing' : 'unavailable'), leafFor: () => null, close() {} }
    }
    const leaves = createLeafIssuer(loadCa(ca), { now })
    return { state: () => 'ready', leafFor: (host) => leaves.chainFor(host), close() {} }
  }

  let current = null      // { notAfter, leaves }
  let failState = null    // 'unavailable' | 'key-missing' of the running failure streak
  let streakCode = null   // the code already recorded for this streak
  let next = null, expiry = null, closed = false
  const at = (ms, fn) => { const t = timers.setTimeout(fn, Math.max(0, ms - clock())); if (t && t.unref) t.unref(); return t }

  function failed(code, reason) {
    failState = code === CODE.certKeyMissing ? 'key-missing' : 'unavailable'
    if (streakCode !== code) { streakCode = code; fail(code, reason) }
    next = at(clock() + RETRY_MS, attempt)
  }

  function install(der, key) {
    const pem = certPem(der)
    const notAfter = Date.parse(new crypto.X509Certificate(der).validTo)
    const { subject, ski } = certSubjectAndSki(der)
    current = { notAfter, leaves: createLeafIssuer({ key: key.privateKey, certPem: pem, subject, ski, notAfter }, { now }) } // a new cache: rotation empties it
    failState = null; streakCode = null
    if (expiry) timers.clearTimeout(expiry)
    expiry = at(notAfter, () => { if (current && clock() >= current.notAfter) current = null })
    next = at(clock() + REISSUE_AFTER_MS, attempt)
  }

  async function attempt() {
    next = null
    if (closed) return
    let reason
    try {
      // no exists() first: the custody's own `issue` answers no-key (both helpers' exit 4), and each question is a process (a PowerShell on Windows,
      // 0.4–0.6 s on a Windows test machine, 2026-10-17) on the daemon's way to answering `on`
      const key = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) // the intermediate key: memory only
      const serial = crypto.randomBytes(16); serial[0] &= 0x7f
      const spkiDer = key.publicKey.export({ type: 'spki', format: 'der' })
      const notBefore = new Date(clock() - SKEW_MS)
      const der = await custody.issueIntermediate({ spkiDer, serial, notBefore })
      if (closed) return
      if (!Buffer.isBuffer(der)) reason = `the ${custody.kind} custody answered ${JSON.stringify(der)}`
      else {
        const bad = checkProfile(der, INTERMEDIATE, { root }).concat(asRequested(der, { spkiDer, notBefore }))
        if (!bad.length) return install(der, key)
        reason = `the ${custody.kind} custody issued a certificate that is not the intermediate profile: ${bad.join('; ')}`
      }
    } catch (e) {
      if (e && e.code === NO_KEY) return failed(CODE.certKeyMissing, `the root key is not in its ${custody.kind} custody; run trocar install`)
      reason = `the ${custody.kind} custody failed: ${String((e && e.message) || e)}`
    }
    if (!closed) failed(CODE.certIntermediateUnavailable, reason)
  }

  await attempt()
  const live = () => (current && clock() < current.notAfter ? current : null)
  return {
    state: () => (live() ? 'ready' : failState || 'unavailable'),
    expires: () => { const c = live(); return c ? new Date(c.notAfter).toISOString() : null }, // the current intermediate's notAfter (1.6 §9.4 cert.intermediate.expires)
    leafFor: (host) => { const c = live(); return c ? c.leaves.chainFor(host) : null },
    close() { closed = true; for (const t of [next, expiry]) if (t) timers.clearTimeout(t) },
  }
}
