// trocar collector: trust plugin for pi. Written by `trocar collector install` as <agent dir>/extensions/trocar-ca.js
// (<agent dir> = $PI_CODING_AGENT_DIR, else ~/.pi/agent), where pi discovers and imports it at start; `trocar collector
// uninstall` removes it (RFC 4.6 §身份与信任, D37④ bounded exception, acceptance T13). What it does, and nothing else:
//   reads   the trocar CA file, Node's default roots, this process's own Node flags and start time
//   changes Node's default trusted roots to those defaults + the trocar CA (appended, nothing taken away)
//   writes  one marker, <marker dir>/<pid> = this process's start time, so the trocar engine knows the CA is in
// It never touches request or response bytes, opens no connection, writes no agent config, registers nothing with pi.
// It adds nothing and writes no marker when tls.setDefaultCACertificates is missing (Node < 22.19), under
// --use-openssl-ca (the call would then replace the roots), or when the CA file is missing or not PEM; it never throws.
import fs from 'node:fs'
import tls from 'node:tls'

const CA_FILE = '__TROCAR_CA_FILE__'
const MARKER_DIR = '__TROCAR_MARKER_DIR__'
const PEM = /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/

// Field 22 of /proc/self/stat (start time in clock ticks); the fields after the ")" that ends the command name.
function startTicks() {
  const stat = fs.readFileSync('/proc/self/stat', 'utf8')
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
}

function addCa() {
  if (typeof tls.setDefaultCACertificates !== 'function' || typeof tls.getCACertificates !== 'function') return
  if ([...process.execArgv, ...String(process.env.NODE_OPTIONS || '').split(/\s+/)].includes('--use-openssl-ca')) return
  let ca = null
  try { ca = PEM.exec(fs.readFileSync(CA_FILE, 'utf8')) } catch { return }
  if (!ca) return
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ca[0]])
  const ticks = startTicks()
  const tmp = `${MARKER_DIR}/.${process.pid}.tmp`
  fs.writeFileSync(tmp, ticks, { mode: 0o600 })
  fs.renameSync(tmp, `${MARKER_DIR}/${process.pid}`)
}

try { addCa() } catch { /* trocar never stops the agent from starting */ }

// pi calls an extension's default export with its API; this one registers nothing
export default function () {}
