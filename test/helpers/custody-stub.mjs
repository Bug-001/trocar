// test/helpers/custody-stub.mjs — an in-Node key custody with the keychain / CNG semantics of RFC 4.11 P1, for the tests of the
// issuer, install and uninstall (T12, T13, T14, T18, T20). The root key never leaves it; `issueIntermediate` builds the TBS
// itself from the INTERMEDIATE profile (it takes no caller TBS, CM3). Switches:
//   unavailable — create / issueIntermediate answer 'unavailable' (no GUI session, a locked keychain)
//   failed      — EVERY verb throws the way cliCustody reports a program that could not run at all: a HOME with no login keychain
//                 answers "A default keychain could not be found" (macOS test machine, 2026-10-18). Set it to the message, or to true for that one.
//   throws      — issueIntermediate throws (the helper crashed)
//   keyLost     — exists() is false: the key was deleted behind trocar's back (create then makes a new one; create over a key that exists throws, code 'exists')
//   wrongProfile — issueIntermediate hands back a self-signed root-shaped certificate instead
//   wrongKey    — a well-formed intermediate for another public key than the one sent
//   skewMs      — a well-formed intermediate whose notBefore is shifted by this much (a local-vs-UTC slip)
import crypto from 'node:crypto'
import { rootCertDer, intermediateCertDer } from '../../src/collector/core/tls/cert.mjs'
import { NO_KEY } from '../../src/collector/core/tls/custody-cli.mjs'

const DAY = 86400e3
const spkiOf = (k) => k.export({ type: 'spki', format: 'der' })
const serialOf = () => { const s = crypto.randomBytes(16); s[0] &= 0x7f; return s }
const p256 = () => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const signer = (k) => (tbs) => crypto.sign('sha256', tbs, k)

export function custodyStub({ kind = 'stub', clock = () => Date.now() } = {}) {
  let keys = null, rootDer = null
  const switches = { unavailable: false, failed: false, throws: false, keyLost: false, wrongProfile: false, wrongKey: false, skewMs: 0 }
  const calls = []
  // what cliCustody throws when the program ran and reported a failure: the message it builds, with the error word as `code`
  const failure = (verb) => Object.assign(new Error(`${kind} ${verb} failed (exit 1): failed: ${switches.failed === true ? 'A default keychain could not be found' : switches.failed}`), { code: 'failed' })
  const self = {
    kind, switches, calls,
    get rootDer() { return rootDer },
    create({ subject = 'trocar root (test)' } = {}) {
      calls.push({ verb: 'create' })
      if (switches.failed) throw failure('create')
      if (switches.unavailable) return 'unavailable'
      if (keys && !switches.keyLost) throw Object.assign(new Error('stub custody: a key already exists'), { code: 'exists' }) // the helper's exit 5
      switches.keyLost = false
      keys = p256()
      const now = clock()
      rootDer = rootCertDer({ subject, spkiDer: spkiOf(keys.publicKey), serial: serialOf(), notBefore: new Date(now - DAY), notAfter: new Date(now + 3650 * DAY), sign: signer(keys.privateKey) })
      return { rootDer, fp256: new crypto.X509Certificate(rootDer).fingerprint256 }
    },
    exists: () => { if (switches.failed) throw failure('exists'); return !!keys && !switches.keyLost },
    issueIntermediate({ spkiDer, serial, notBefore }) {
      calls.push({ verb: 'issue', spkiDer, serial, notBefore })
      if (switches.throws) throw new Error('stub custody: the helper crashed')
      if (switches.unavailable) return 'unavailable'
      if (!self.exists()) throw Object.assign(new Error('stub custody: no root key'), { code: NO_KEY }) // the programs' exit 4
      if (switches.wrongProfile) { const k = p256(); return rootCertDer({ subject: 'not an intermediate', spkiDer: spkiOf(k.publicKey), serial, notBefore, notAfter: new Date(notBefore.getTime() + 7 * DAY), sign: signer(k.privateKey) }) }
      const nb = new Date(notBefore.getTime() + switches.skewMs)
      return intermediateCertDer({ root: rootDer, subject: `trocar intermediate ${nb.toISOString()}`, spkiDer: switches.wrongKey ? spkiOf(p256().publicKey) : spkiDer, serial, notBefore: nb, sign: signer(keys.privateKey) })
    },
    remove() { calls.push({ verb: 'remove' }); if (switches.failed) throw failure('remove'); if (switches.unavailable) return 'unavailable'; const had = !!keys; keys = null; rootDer = null; return { removed: had } },
  }
  return self
}
