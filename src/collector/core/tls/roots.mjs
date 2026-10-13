// roots.mjs — the trust set the engine verifies upstreams against (RFC 4.6 §引擎 5: 按系统根证书校验), and the roots a combined bundle
// starts from (4.6 「合并包」: bundleRoots, the collector's way to them; the readers themselves are src/off/os-roots.mjs, `off`'s too).
// The engine's set is the union of three, none overriding another, read once: the OS store (corporate and TLS-inspection CAs live there),
// Node's bundled roots, and this process's NODE_EXTRA_CA_CERTS. The OS store comes from tls.getCACertificates('system') where Node has it
// (≥ 22.15) plus the first OS PEM bundle that holds a certificate (Node's own system read can come back empty on Linux; Node 20 has only the
// file). No process.platform branch (4.6 §结构): the bundle paths are data (SYSTEM_BUNDLES, kept in src/off/pem.mjs so `off` reads the same
// list, R3), and a path that does not exist is skipped.
import fs from 'node:fs'
import tls from 'node:tls'
import { SYSTEM_BUNDLES, osBundle } from '../../../off/pem.mjs'

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

/** bundleRoots(arch, {nodeRoots}) → {node, osText, missing}: the roots every combined bundle starts from (4.6 「合并包」) — Node's own and what
 *  `arch.osRoots()` answers, read each time it is asked — src/off/os-roots.mjs osRootsFor(<the arch's os>): Linux osBundleRoots, darwin darwinRoots (4.9 §6.2), win32 windowsRoots (4.8 §6.2).
 *  The one resolver of them in the collector (the platform-seam rule): the install's plan (install.mjs planOn — `on`, `collector install`) and the daemon's
 *  rebuild both ask it, and no caller keeps a fallback of its own. (`off` rebuilds a gone bundle without collector code, R3, through the same osRootsFor table: src/off/orchestrate.mjs.) An arch without osRoots (a test's) gives Node's roots alone, nothing said missing. A read
 *  that fails throws: `on` stops before a file is written, the daemon keeps the previous bundles (D38). */
export async function bundleRoots(arch, { nodeRoots = tls.rootCertificates } = {}) {
  const got = arch && typeof arch.osRoots === 'function' ? await arch.osRoots() : null
  return { node: [...nodeRoots], osText: (got && got.pem) || '', missing: (got && got.missing) || null }
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
