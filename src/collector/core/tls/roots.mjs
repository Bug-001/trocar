// roots.mjs — the trust set the engine verifies upstreams against (RFC 4.6 §引擎 5: 按系统根证书校验).
// The union of three, none overriding another, read once: the OS store (corporate and TLS-inspection
// CAs live there), Node's bundled roots, and this process's NODE_EXTRA_CA_CERTS. The OS store comes from
// tls.getCACertificates('system') where Node has it (≥ 22.15) plus the first OS PEM bundle that exists
// (Node's own system read can come back empty on Linux; Node 20 has only the file). No process.platform
// branch (4.6 §结构): the bundle paths are data, and a path that does not exist is skipped.
import fs from 'node:fs'
import tls from 'node:tls'

export const SYSTEM_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt',                // Debian, Ubuntu, Arch, Alpine, NixOS
  '/etc/pki/tls/certs/ca-bundle.crt',                  // Fedora, RHEL, CentOS
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem', // RHEL 7+
  '/etc/ssl/ca-bundle.pem',                            // openSUSE
  '/etc/pki/tls/cacert.pem',                           // OpenELEC
  '/etc/ssl/cert.pem',                                 // macOS, BSD (not the keychain's added roots)
]
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
  for (const f of files) {
    let c
    try { c = pems(read(f)) } catch { continue } // not on this OS
    if (c.length) { certs.push(...c); sources.push(f); break }
  }
  return { certs, sources, errors }
}

/** nodeRoots({api, env, read}) → PEM[]: Node's bundled roots plus NODE_EXTRA_CA_CERTS of this process. */
export function nodeRoots({ api = tls.getCACertificates, env = process.env, read = readText } = {}) {
  if (typeof api === 'function') { try { return api('default') } catch { /* fall back to the pieces */ } }
  let extra = []
  if (env.NODE_EXTRA_CA_CERTS) { try { extra = pems(read(env.NODE_EXTRA_CA_CERTS)) } catch { /* Node itself only warns */ } }
  return [...tls.rootCertificates, ...extra]
}

/** createUpstreamTrust({system, node, extra}) → {secureContext, count, sources, missingSystem, errors}
 *  extra = the engine's upstreamCa option (PEM text / Buffer / array), added to the union. */
export function createUpstreamTrust({ system = systemRoots(), node = nodeRoots(), extra = [] } = {}) {
  const ca = [...new Set([...node, ...system.certs, ...[].concat(extra || []).flatMap(pems)].map((p) => p.trim()))]
  return { secureContext: tls.createSecureContext({ ca }), count: ca.length, sources: system.sources, missingSystem: system.certs.length === 0, errors: system.errors }
}
