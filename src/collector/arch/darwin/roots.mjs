// roots.mjs — the macOS root certificates a combined bundle starts from (RFC 4.9 §6.2; the mechanism — parse one by one, count what does not parse, dedupe by fingerprint — is 4.8 §6.2's, acceptance
// W20, carried over; the darwin composition itself is what MA4 asserts). Read only: nothing here writes, and it opens no file — in particular never the static `/etc/ssl/cert.pem` a lazy port would
// reach for: the keychain's added roots are not in it, and it is a snapshot of install day, not a read of what the user trusts (4.9 §6.2; the Windows file carries the same warning in its own idiom).
//
// The darwin port of `arch/win32/roots.mjs` (4.9 §1 row roots): the mechanism is carried over, the source list is the delta. Windows reads one store through a fallback chain (Node's system read,
// else the helper's export); macOS takes the UNION of three, none a fallback for another (4.9 §6.2): `getCACertificates('bundled')` (Node's own Mozilla set, 145 on the reference machine) ∪
// `getCACertificates('system')` (the keychain-administered LOCAL trust anchors, user domain + admin domain, 5 on the reference machine — exactly where enterprise and TLS-inspection roots live) ∪
// the SystemRootCertificates export (Apple's standard roots, 158; `security find-certificate -a -p` is a read-only CLI). The overlap is on purpose — 'bundled' and the keychain export are the
// double cover of the standard set — and the overlap dedupes.
//
// darwinRoots({ tls, exec, timeoutMs }) → { pem, fingerprint, source, dropped, tried }
//   The `security` call goes through the injected exec like every other tool call (execTool: a test injects the runner, and under npm test a forgotten one is refused — the ESANDBOX refusal is
//   re-thrown here, never caught as "the tool failed"). Every certificate goes through `new X509Certificate()` first: one that does not parse is dropped and COUNTED (`dropped`), because Codex
//   reads the bundle with rustls and a single broken block makes it refuse the whole file and connect to nothing [T0, W20]; a duplicate is kept once. `pem` is what the install hands the combined
//   bundle as the OS roots (core/tls/roots.mjs `bundleRoots` → `composeBundle`, core/trust — composeBundle dedupes against Node's own roots again, so 'bundled' sitting here too costs nothing); `fingerprint` is a
//   hash of the SET of certificates, so the daily comparison knows the roots changed whatever their order. `source` is an array naming the sources that contributed, in a fixed order
//   (['node-bundled', 'node-system', 'security'], in whole or in part: a union has no single winner, which is why it is not win32's one string); `tried` says why a source failed while the others
//   still gave a set (D38: a bundle quietly missing a third of the roots is not fine). No usable source at all is a RootsUnavailableError with the reasons (D38: unreadable is 「unknown」 and says
//   why), never an empty set.
import crypto from 'node:crypto'
import nodeTls from 'node:tls'
import { execTool } from '../../../off/exec.mjs'

const SECURITY_TIMEOUT_MS = 10000 // a read-only CLI exporting one keychain: execTool's own default, said out loud
const SYSTEM_ROOTS_KEYCHAIN = '/System/Library/Keychains/SystemRootCertificates.keychain'
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g

function parsed(pems) {
  const byFp = new Map()
  let dropped = 0
  for (const pem of pems) {
    let fp
    try { fp = new crypto.X509Certificate(pem).fingerprint256 } catch { dropped++; continue }
    byFp.set(fp, String(pem).trim()) // a duplicate keeps its first place
  }
  return { byFp, dropped }
}
const outcome = (byFp, dropped, source, tried) => ({
  pem: `${[...byFp.values()].join('\n')}\n`,
  fingerprint: crypto.createHash('sha256').update([...byFp.keys()].sort().join('\n')).digest('hex'),
  source,
  dropped,
  tried,
})

/** No source gave a usable root set. `tried` says why each source failed (`node-bundled: …`, `node-system: …`, `security: …`); the caller turns it into a record with a name from the closed set (D38). */
export class RootsUnavailableError extends Error {
  constructor(tried) {
    super(`the macOS root certificates could not be read (${tried.join('; ') || 'no source'})`)
    this.name = 'RootsUnavailableError'
    this.tried = tried
  }
}

export async function darwinRoots({ tls = nodeTls, exec = null, timeoutMs = SECURITY_TIMEOUT_MS } = {}) {
  const tried = []
  const byFp = new Map()
  const source = []
  let dropped = 0
  const merge = (pems, name) => { // one source in: what parses joins the union, what does not is counted, and a source with nothing usable says why
    const got = parsed(pems)
    dropped += got.dropped
    if (!got.byFp.size) { tried.push(`${name}: no certificate`); return }
    source.push(name)
    for (const [fp, pem] of got.byFp) if (!byFp.has(fp)) byFp.set(fp, pem) // a duplicate keeps its first place
  }
  if (typeof tls.getCACertificates === 'function') {
    for (const key of ['bundled', 'system']) { // 'bundled' first: Node's text is the steadier one for a certificate both sources hold
      try { merge(tls.getCACertificates(key), `node-${key}`) } catch (e) { tried.push(`node-${key}: ${e.code || e.message}`) }
    }
  } else tried.push('getCACertificates: not available (Node ≥ 22.15 has it)') // a Node 20 daemon still gets the standard set from the security export, but the keychain's local anchors — the enterprise roots — are only in 'system': the reason says so
  try {
    const r = execTool('security', ['find-certificate', '-a', '-p', SYSTEM_ROOTS_KEYCHAIN], { run: exec, timeoutMs })
    if (r.code === 0) merge(r.out.match(PEM_BLOCK) || [], 'security')
    else tried.push(`security: ${r.err || `exit ${r.code}`}`)
  } catch (e) {
    if (e && e.code === 'ESANDBOX') throw e // exec.mjs: the sandbox refusal must reach the test, not pass as a failed source
    tried.push(`security: ${e.code || e.message}`)
  }
  if (!byFp.size) throw new RootsUnavailableError(tried)
  return outcome(byFp, dropped, source, tried)
}

/** The line the receipt and `status` carry when some certificates were dropped (4.8 §6.2); null when none were. */
export function droppedNote(roots) {
  const n = roots && roots.dropped
  return n > 0 ? `${n} certificate${n === 1 ? '' : 's'} in the macOS roots could not be parsed and ${n === 1 ? 'is' : 'are'} not in the combined bundles (one broken certificate makes Codex refuse the whole bundle)` : null
}
