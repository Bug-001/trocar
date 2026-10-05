// asight collector: trust plugin for OpenCode. Written by `asight collector install`; `asight collector uninstall`
// removes it (RFC 4.6 §身份与信任, D37④ bounded exception, acceptance T13). What it does, and nothing else:
//   reads   the asight CA file, the process's default roots, this process's start time
//   changes globalThis.fetch: each call goes on unchanged except that tls.ca = the caller's own ca (or, when it
//           brought none, the default roots, since a per-request ca replaces the store in Bun) + the asight CA
//   writes  one marker, <marker dir>/<pid> = this process's start time, so the asight engine knows the CA is in
// The request and the response pass through as the same objects; no body is read, no connection opened, no agent
// config written, rejectUnauthorized never set. Nothing changes and no marker is written when the CA file is missing
// or not PEM; it never throws.
import fs from 'node:fs'
import tls from 'node:tls'

const CA_FILE = '__ASIGHT_CA_FILE__'
const MARKER_DIR = '__ASIGHT_MARKER_DIR__'
const PEM = /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/

// Field 22 of /proc/self/stat (start time in clock ticks); the fields after the ")" that ends the command name.
function startTicks() {
  const stat = fs.readFileSync('/proc/self/stat', 'utf8')
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
}

function wrapFetch() {
  let ca = null
  try { ca = PEM.exec(fs.readFileSync(CA_FILE, 'utf8')) } catch { return }
  if (!ca || typeof tls.getCACertificates !== 'function' || typeof globalThis.fetch !== 'function') return
  const asight = ca[0]
  const defaults = tls.getCACertificates('default')
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
  const ticks = startTicks()
  const tmp = `${MARKER_DIR}/.${process.pid}.tmp`
  fs.writeFileSync(tmp, ticks, { mode: 0o600 })
  fs.renameSync(tmp, `${MARKER_DIR}/${process.pid}`)
}

try { wrapFetch() } catch { /* asight never stops the agent from starting */ }

export const AsightCaPlugin = async () => ({})
