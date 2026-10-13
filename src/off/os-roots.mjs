// os-roots.mjs (src/off) — the OS roots a combined bundle starts from, read on this machine's platform (RFC 4.6 §身份与信任「合并包」, 4.9 §6.2, 4.8 §6.2): the one
// reader the collector composes the bundles with (core/tls/roots.mjs bundleRoots, through each arch's osRoots — the install's plan and the daemon's rebuild) and the
// one `off` rebuilds a gone bundle with (4.6 撤销顺序 第 2 步). It is here, not in the collector, because `off` may import only node:* and src/off (1.6 R3); before
// it was, `off` read a fixed list of PEM files on every platform — /etc/ssl/cert.pem on a Mac, which 4.9 §6.2 forbids, and nothing on Windows.
//
//   osRootsFor(platform)  the reader of a platform: darwin → darwinRoots, win32 → windowsRoots, any other → osBundleRoots. The one table of them (the platform-seam rule), and
//                         the one export: the arches ask it with their own name, `off` with the platform it runs on, the tests through it too. Every reader takes one
//                         options object and ignores what it does not use; a failed read is an Error named RootsUnavailableError.
//   osBundleRoots({files, read}) → {pem, file, missing, dropped}
//                         Linux: the first OS PEM bundle of SYSTEM_BUNDLES that holds a certificate (pem.mjs osBundle, the one list). None → pem '' and `missing` names
//                         every path looked at; one there but unreadable throws with its errno as `code`. `dropped` counts the blocks of the file that are not a
//                         certificate Node parses (composeBundle leaves them out).
//   darwinRoots({tls, exec, timeoutMs}) → {pem, fingerprint, source, dropped, tried}
//                         The UNION of three, none a fallback for another (4.9 §6.2): getCACertificates('bundled') (Node's own Mozilla set) ∪ getCACertificates('system')
//                         (the keychain-administered LOCAL trust anchors, user + admin domain — exactly where enterprise and TLS-inspection roots live) ∪ the
//                         SystemRootCertificates export (Apple's standard roots; `security find-certificate -a -p` is a read-only CLI). The overlap is on purpose and
//                         dedupes. It opens no file — never the static /etc/ssl/cert.pem: the keychain's added roots are not in it. `source` names the sources that
//                         contributed, in a fixed order (['node-bundled', 'node-system', 'security'], in whole or in part); `tried` names each source whose READ failed
//                         while the others still gave a set (D38: a bundle quietly missing a source is not fine) — an empty answer is not a failure (node-system on a
//                         Mac with no added anchor). `security` goes through execTool like every tool call: the sandbox refusal (ESANDBOX) is re-thrown, never a
//                         failed source.
//   windowsRoots({tls, helper, timeoutMs}) → {pem, fingerprint, source: 'node-system' | 'helper', dropped}
//                         getCACertificates('system') (Node ≥ 22.15) when there is one; else, or when it fails or gives nothing, the helper's `roots` verb (the read-only
//                         export of CurrentUser\Root and LocalMachine\Root) when there is a helper — the daemon has one, `off` does not (4.8 §6.2). Never the macOS cert.pem.
// darwin and win32: every certificate goes through `new X509Certificate()` first; one that does not parse is dropped and COUNTED (`dropped`), because Codex reads the bundle
// with rustls and a single broken block makes it refuse the whole file [T0, W20]; a duplicate is kept once. `pem` is what the bundle takes as the OS roots; `fingerprint`
// is a hash of the SET, so the daily comparison knows the roots changed whatever their order. No usable source at all is a RootsUnavailableError naming every reason
// (D38: unreadable is 「unknown」 and says why), never an empty set.
// Imports only node:* and src/off.
import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import nodeTls from 'node:tls'
import { execTool } from './exec.mjs'
import { SYSTEM_BUNDLES, osBundle, certBlocks } from './pem.mjs'

const SECURITY_TIMEOUT_MS = 10000 // a read-only CLI exporting one keychain: execTool's own default, said out loud
const HELPER_TIMEOUT_MS = 20000 // a cold PowerShell exporting two stores
const SYSTEM_ROOTS_KEYCHAIN = '/System/Library/Keychains/SystemRootCertificates.keychain'
const ROOT_PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]+-----/g
const rootsErr = (e) => String((e && e.message) || e)

function parsedRoots(pems) {
  const byFp = new Map()
  let dropped = 0
  for (const pem of pems) {
    let fp
    try { fp = new crypto.X509Certificate(pem).fingerprint256 } catch { dropped++; continue }
    byFp.set(fp, String(pem).trim()) // a duplicate keeps its first place
  }
  return { byFp, dropped }
}
const rootsOutcome = (byFp, dropped, source, tried) => ({
  pem: `${[...byFp.values()].join('\n')}\n`,
  fingerprint: crypto.createHash('sha256').update([...byFp.keys()].sort().join('\n')).digest('hex'),
  source,
  dropped,
  ...(tried ? { tried } : {}),
})

/** No source gave a usable root set. `tried` says why each source gave nothing (`node-system: …`, `security: …`, `helper: …`); the caller turns it into a record with a
 *  name from the closed set (D38). `what` is whose roots: 'the macOS root certificates' | 'the Windows root certificates'. */
class RootsUnavailableError extends Error {
  constructor(tried, what = 'the OS root certificates') {
    super(`${what} could not be read (${tried.join('; ') || 'no source'})`)
    this.name = 'RootsUnavailableError'
    this.tried = tried
  }
}

function osBundleRoots({ files = SYSTEM_BUNDLES, read = (f) => nodeFs.readFileSync(f, 'utf8') } = {}) {
  const b = osBundle({ files, read })
  if (b.failed.length) throw Object.assign(new Error(`the OS trust bundle cannot be read (${b.failed.map((f) => `${f.file}: ${rootsErr(f.error)}`).join('; ')})`), { code: b.failed[0].error && b.failed[0].error.code })
  const dropped = (b.text.match(PEM_BEGIN) || []).length - certBlocks(b.text).length
  return { pem: b.text, file: b.file, missing: b.file ? null : `no OS trust bundle holds a certificate (looked at ${files.join(', ')})`, dropped }
}

async function darwinRoots({ tls = nodeTls, exec = null, timeoutMs = SECURITY_TIMEOUT_MS } = {}) {
  const tried = [] // reads that failed
  const reasons = [] // every source that gave nothing, in order: what a RootsUnavailableError says
  const byFp = new Map()
  const source = []
  let dropped = 0
  const failed = (why) => { tried.push(why); reasons.push(why) }
  const merge = (pems, name) => { // one source in: what parses joins the union, what does not is counted; an answer with nothing usable is a reason, not a failed read
    const got = parsedRoots(pems)
    dropped += got.dropped
    if (!got.byFp.size) { reasons.push(`${name}: no certificate`); return }
    source.push(name)
    for (const [fp, pem] of got.byFp) if (!byFp.has(fp)) byFp.set(fp, pem)
  }
  if (typeof tls.getCACertificates === 'function') {
    for (const key of ['bundled', 'system']) { // 'bundled' first: Node's text is the steadier one for a certificate both sources hold
      try { merge(tls.getCACertificates(key), `node-${key}`) } catch (e) { failed(`node-${key}: ${e.code || e.message}`) }
    }
  } else failed('getCACertificates: not available (Node ≥ 22.15 has it)') // Node 20 still gets the standard set from the security export, but the keychain's local anchors — the enterprise roots — are only in 'system'
  try {
    const r = execTool('security', ['find-certificate', '-a', '-p', SYSTEM_ROOTS_KEYCHAIN], { run: exec, timeoutMs })
    if (r.code === 0) merge(r.out.match(ROOT_PEM_BLOCK) || [], 'security')
    else failed(`security: ${r.err || `exit ${r.code}`}`)
  } catch (e) {
    if (e && e.code === 'ESANDBOX') throw e // exec.mjs: the sandbox refusal must reach the test, not pass as a failed source
    failed(`security: ${e.code || e.message}`)
  }
  if (!byFp.size) throw new RootsUnavailableError(reasons, 'the macOS root certificates')
  return rootsOutcome(byFp, dropped, source, tried)
}

async function windowsRoots({ tls = nodeTls, helper = null, timeoutMs = HELPER_TIMEOUT_MS } = {}) {
  const tried = []
  if (typeof tls.getCACertificates === 'function') {
    try {
      const got = parsedRoots(tls.getCACertificates('system'))
      if (got.byFp.size) return rootsOutcome(got.byFp, got.dropped, 'node-system')
      tried.push('node-system: no certificate')
    } catch (e) { tried.push(`node-system: ${e.code || e.message}`) }
  } else tried.push('getCACertificates: not available (Node ≥ 22.15 has it)')
  if (helper) {
    try {
      const answer = await helper.call('roots', {}, { timeoutMs })
      const got = parsedRoots((answer.certs || []).map((c) => c.pem))
      if (got.byFp.size) return rootsOutcome(got.byFp, got.dropped, 'helper')
      tried.push('helper: no certificate')
    } catch (e) { tried.push(`helper: ${e.code || e.message}`) }
  }
  throw new RootsUnavailableError(tried, 'the Windows root certificates')
}

/** The reader of `platform`'s OS roots (process.platform's names). */
export function osRootsFor(platform) {
  if (platform === 'darwin') return darwinRoots
  if (platform === 'win32') return windowsRoots
  return osBundleRoots
}
