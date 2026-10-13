// roots.mjs — the Windows root certificates a combined bundle starts from (RFC 4.8 §6.2; acceptance W20). Read only: nothing here writes, and it opens no file — in particular never the
// macOS `cert.pem` a lab once used for convenience: enterprise and anti-virus TLS-inspection roots live only in Windows' own stores.
//
// windowsRoots({ tls, helper }) → { pem, fingerprint, source: 'node-system' | 'helper', dropped }
//   `tls.getCACertificates('system')` (Node ≥ 22.15) when there is one; else, or when it fails or gives nothing, the helper's `roots` verb (the read-only export of CurrentUser\Root and
//   LocalMachine\Root, de-duplicated by the DER's SHA-256, ~430 KB: the call is given time). Every certificate goes through `new X509Certificate()` first: one that does not parse is dropped and
//   COUNTED (`dropped`, said by `on` and the daemon through core/tls/roots.mjs bundleRoots, 4.8 §6.2), because Codex reads the bundle with rustls and a single broken block makes it refuse the whole file and connect to nothing [T0, W20]; a duplicate is kept once.
//   `pem` is what the install hands the combined bundle as the OS roots (core/tls/roots.mjs `bundleRoots` → `composeBundle`, core/trust); `fingerprint` is a hash of the SET of certificates, so the daily
//   comparison knows the roots changed whatever their order. No usable source is a RootsUnavailableError with a reason (D38: unreadable is 「unknown」 and says why), never an empty set.
import crypto from 'node:crypto'
import nodeTls from 'node:tls'

const HELPER_TIMEOUT_MS = 20000 // a cold PowerShell exporting two stores

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
const outcome = ({ byFp, dropped }, source) => ({
  pem: `${[...byFp.values()].join('\n')}\n`,
  fingerprint: crypto.createHash('sha256').update([...byFp.keys()].sort().join('\n')).digest('hex'),
  source,
  dropped,
})

/** No source gave a usable root set. `tried` says why each source failed (`node-system: …`, `helper: …`); the caller turns it into a record with a name from the closed set (D38). */
export class RootsUnavailableError extends Error {
  constructor(tried) {
    super(`the Windows root certificates could not be read (${tried.join('; ') || 'no source'})`)
    this.name = 'RootsUnavailableError'
    this.tried = tried
  }
}

export async function windowsRoots({ tls = nodeTls, helper = null, timeoutMs = HELPER_TIMEOUT_MS } = {}) {
  const tried = []
  if (typeof tls.getCACertificates === 'function') {
    try {
      const got = parsed(tls.getCACertificates('system'))
      if (got.byFp.size) return outcome(got, 'node-system')
      tried.push('node-system: no certificate')
    } catch (e) { tried.push(`node-system: ${e.code || e.message}`) }
  }
  if (helper) {
    try {
      const answer = await helper.call('roots', {}, { timeoutMs })
      const got = parsed((answer.certs || []).map((c) => c.pem))
      if (got.byFp.size) return outcome(got, 'helper')
      tried.push('helper: no certificate')
    } catch (e) { tried.push(`helper: ${e.code || e.message}`) }
  }
  throw new RootsUnavailableError(tried)
}
