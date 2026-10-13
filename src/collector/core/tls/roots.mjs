// roots.mjs — the trust set the engine verifies upstreams against (RFC 4.6 §引擎 5: 按系统根证书校验), and the roots a combined bundle
// starts from (4.6 「合并包」: bundleRoots, the one resolver of them; rootsLeftOut, what they lack as the records that say it; osBundleRoots, the Linux arch's osRoots).
// The engine's set is the union of three, none overriding another, read once: the OS store (corporate and TLS-inspection CAs live there),
// Node's bundled roots, and this process's NODE_EXTRA_CA_CERTS. The OS store comes from tls.getCACertificates('system') where Node has it
// (≥ 22.15) plus the first OS PEM bundle that holds a certificate (Node's own system read can come back empty on Linux; Node 20 has only the
// file). No process.platform branch (4.6 §结构): the bundle paths are data (SYSTEM_BUNDLES, kept in src/off/pem.mjs so `off` reads the same
// list, R3), and a path that does not exist is skipped.
import fs from 'node:fs'
import tls from 'node:tls'
import { SYSTEM_BUNDLES, osBundle, certBlocks } from '../../../off/pem.mjs'
import { CODE } from '../codes.mjs'

export { SYSTEM_BUNDLES }

const PEM = /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g
const pems = (text) => (String(text).match(PEM) || []).map((p) => p.replace(/\r\n/g, '\n'))
const readText = (f) => fs.readFileSync(f, 'utf8')
const msg = (e) => String((e && e.message) || e)

/** systemRoots({api, files, read}) → {certs, sources, errors}: the OS trust store (empty = not found). */
export function systemRoots({ api = tls.getCACertificates, files = SYSTEM_BUNDLES, read = readText } = {}) {
  const certs = [], sources = [], errors = []
  if (typeof api === 'function') {
    try { const c = api('system'); if (c.length) { certs.push(...c); sources.push('node:system') } } catch (e) { errors.push(`node:system: ${msg(e)}`) }
  }
  const b = osBundle({ files, read })
  for (const f of b.failed) errors.push(`${f.file}: ${msg(f.error)}`) // there but unreadable: say so (D38)
  if (b.file) { certs.push(...pems(b.text)); sources.push(b.file) }
  return { certs, sources, errors }
}

/** osBundleRoots({files, read}) → {pem, file, missing, dropped}: the OS roots of a combined bundle on an arch whose OS store is one PEM file — the first
 *  of `files` that holds a certificate (4.6 「合并包」; Linux: Debian's, Fedora's, openSUSE's, … whichever this machine has). None → pem '' and
 *  `missing` says so, naming every path looked at: the bundles then carry Node's roots only, and a CA installed system-wide (a corporate
 *  proxy's) is not in them — the caller records that (D38), never an empty answer alone. `dropped` counts the blocks of the file that are not
 *  certificates Node parses (a broken one, another PEM type, one cut short): composeBundle leaves them out of every bundle, so they are said like
 *  the darwin and win32 readers' (4.8 §6.2 / W20). A bundle that is there but cannot be read throws
 *  (with its errno as `code`): the caller keeps what it had and says why (`on` stops; the daemon keeps the previous bundles). */
export function osBundleRoots({ files = SYSTEM_BUNDLES, read = readText } = {}) {
  const b = osBundle({ files, read })
  if (b.failed.length) throw Object.assign(new Error(`the OS trust bundle cannot be read (${b.failed.map((f) => `${f.file}: ${msg(f.error)}`).join('; ')})`), { code: b.failed[0].error && b.failed[0].error.code })
  const dropped = b.file ? (b.text.match(/-----BEGIN [A-Z0-9 ]+-----/g) || []).length - certBlocks(b.text).length : 0
  return { pem: b.text, file: b.file, missing: b.file ? null : `no OS trust bundle holds a certificate (looked at ${files.join(', ')})`, dropped }
}

/** bundleRoots(arch, {nodeRoots}) → {node, osText, missing, dropped, partial}: the roots every combined bundle starts from (4.6 「合并包」) — Node's own and what
 *  `arch.osRoots()` answers, read each time it is asked (Linux: osBundleRoots above; darwin: darwinRoots, 4.9 §6.2; win32: windowsRoots, 4.8 §6.2).
 *  The one resolver of them in the collector (the platform-seam rule): the install's plan (install.mjs planOn — `on`, `collector install`) and the daemon's
 *  rebuild both ask it, and no caller keeps a fallback of its own. (`off` rebuilds a gone bundle without collector code, R3: src/off/orchestrate.mjs.) An arch without osRoots (a test's) gives Node's roots alone, nothing said missing. A read
 *  that fails throws: `on` stops before a file is written, the daemon keeps the previous bundles (D38). What the reader left out is passed on, never
 *  dropped here: `dropped` = how many certificates did not parse (0 when none), `partial` = the reasons of the sources whose read failed while others
 *  gave roots (darwin's `tried`, joined), or null — the callers say both through rootsLeftOut below. */
export async function bundleRoots(arch, { nodeRoots = tls.rootCertificates } = {}) {
  const got = arch && typeof arch.osRoots === 'function' ? await arch.osRoots() : null
  const tried = (got && got.tried) || []
  return { node: [...nodeRoots], osText: (got && got.pem) || '', missing: (got && got.missing) || null, dropped: (got && got.dropped) || 0, partial: tried.length ? tried.join('; ') : null }
}

/** rootsLeftOut(roots, files) → [{code, files, dropped?, reason}]: what bundleRoots says the OS roots lack, as the records `on`'s plan (an install-note,
 *  one line of the receipt) and the daemon's rebuild (a `bundle` failure) both write — one text for both (4.8 §6.2 「回执与 status 各一行」, 4.9 §6.2, D38).
 *  `files` = the combined bundles composed from these roots; none → nothing is missing from one, nothing to say. `missing` (no OS root at all) is the
 *  callers' own line (system-roots-unavailable, per bundle). */
export function rootsLeftOut(roots, files) {
  if (!roots || !files.length) return []
  const out = []
  const n = roots.dropped || 0
  const where = `the combined bundles ${files.join(', ')}`
  if (n > 0) out.push({ code: CODE.systemRootsUnparsable, files, dropped: n, reason: `${n} certificate${n === 1 ? '' : 's'} in the OS roots could not be parsed and ${n === 1 ? 'is' : 'are'} not in ${where} (one broken certificate makes a rustls client refuse a whole bundle)` })
  if (roots.partial) out.push({ code: CODE.systemRootsPartial, files, reason: `${where} lack the OS roots of a source that could not be read (${roots.partial}); a CA only that source holds (a corporate proxy's, say) is not in them, and an agent whose entry points at one may not reach a relay that signs with it` })
  return out
}

/** nodeRoots({api, env, read, errors}) → PEM[]: Node's bundled roots plus NODE_EXTRA_CA_CERTS of this
 *  process; a read failure is pushed to `errors`. */
export function nodeRoots({ api = tls.getCACertificates, env = process.env, read = readText, errors = [] } = {}) {
  // read on both paths: with the API, Node already merged what it could and only warned on stderr, so an
  // unreadable file would otherwise go unrecorded (D38)
  let extra = []
  if (env.NODE_EXTRA_CA_CERTS) { try { extra = pems(read(env.NODE_EXTRA_CA_CERTS)) } catch (e) { errors.push(`NODE_EXTRA_CA_CERTS ${env.NODE_EXTRA_CA_CERTS}: ${msg(e)}`) } }
  if (typeof api === 'function') { try { return api('default') } catch { /* fall back to the pieces */ } }
  return [...tls.rootCertificates, ...extra]
}

/** createUpstreamTrust({system, node, extra}) → {secureContext, count, sources, missingSystem, errors}
 *  extra = the engine's upstreamCa option (PEM text / Buffer / array), added to the union. */
export function createUpstreamTrust({ system = systemRoots(), node, extra = [] } = {}) {
  const errors = [...system.errors]
  const roots = node ?? nodeRoots({ errors })
  const ca = [...new Set([...roots, ...system.certs, ...[].concat(extra || []).flatMap(pems)].map((p) => p.trim()))]
  return { secureContext: tls.createSecureContext({ ca }), count: ca.length, sources: system.sources, missingSystem: system.certs.length === 0, errors }
}
