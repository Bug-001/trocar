// asight collector: trust plugin for OpenCode on macOS. Written by `asight on` as asight-ca.js into OpenCode's own plugin directory, which OpenCode discovers; `asight off` removes it
// (RFC 4.9 §2.3 · §6.1, D37④ bounded exception; the shape is the win32 twin's, 4.8 §6.1 / W22 — darwin has no /proc either, so the marker's start time is performance.timeOrigin, the
// same answer the win line measured). What it does, and nothing else:
//   reads   the asight CA file, the process's default roots, the process's own Node flags
//   changes the trust the process' TLS uses by ONE of two ways. A Node sidecar (tls.setDefaultCACertificates exists): Node's default roots become those defaults + the asight CA. Bun (it has
//           none): globalThis.fetch is wrapped, each call going on unchanged except that tls.ca = the caller's own ca (or, when it brought none, the default roots, since a per-request ca
//           replaces the store in Bun) + the asight CA
//   writes  one marker, <marker dir>/<pid> = this process's start time in milliseconds, so the asight engine knows the CA is in
// The request and the response pass through as the same objects; no body is read, no connection opened, no agent config written, rejectUnauthorized never set. Nothing changes and no marker is
// written when the CA file is missing or not PEM, or under --use-openssl-ca (the call would replace the roots); it never throws.
import fs from 'node:fs'
import tls from 'node:tls'

const CA_FILE = '__ASIGHT_CA_FILE__'
const MARKER_DIR = '__ASIGHT_MARKER_DIR__'
const PEM = /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/

function wrapFetch(asight, defaults) {
  const inner = globalThis.fetch
  const fetch = function (input, init) {
    const own = (init && init.tls) || {}
    const had = own.ca == null ? defaults : Array.isArray(own.ca) ? own.ca : [own.ca]
    return inner.call(this, input, { ...init, tls: { ...own, ca: [...had, asight] } })
  }
  for (const k of Object.getOwnPropertyNames(inner)) { // e.g. Bun's fetch.preconnect
    if (!['length', 'name', 'prototype', 'arguments', 'caller'].includes(k)) Object.defineProperty(fetch, k, Object.getOwnPropertyDescriptor(inner, k))
  }
  globalThis.fetch = fetch
}

function addCa() {
  let ca = null
  try { ca = PEM.exec(fs.readFileSync(CA_FILE, 'utf8')) } catch { return }
  if (!ca || typeof tls.getCACertificates !== 'function') return
  const asight = ca[0]
  if (typeof tls.setDefaultCACertificates === 'function') {
    if ([...process.execArgv, ...String(process.env.NODE_OPTIONS || '').split(/\s+/)].includes('--use-openssl-ca')) return
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), asight])
  } else if (typeof globalThis.fetch === 'function') wrapFetch(asight, tls.getCACertificates('default'))
  else return
  const tmp = `${MARKER_DIR}/.${process.pid}.tmp`
  fs.writeFileSync(tmp, String(Math.round(performance.timeOrigin)), { mode: 0o600 }) // darwin has no /proc: the process' own start, which the engine compares with a tolerance
  fs.renameSync(tmp, `${MARKER_DIR}/${process.pid}`)
}

try { addCa() } catch { /* asight never stops the agent from starting */ }

export const AsightCaPlugin = async () => ({})
