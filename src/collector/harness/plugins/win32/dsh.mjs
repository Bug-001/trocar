// asight collector: trust plugin for DeepSeek dsh on Windows. Written by `asight on` beside the user's cordis.patch.yml as asight-ca.mjs and loaded by one sentinel-marked row of that
// file; `asight off` removes both (RFC 4.8 §6.1, D37④ bounded exception, acceptance W22). What it does, and nothing else:
//   reads   the asight CA file, Node's default roots, this process's own Node flags
//   changes Node's default trusted roots to those defaults + the asight CA (appended, nothing taken away)
//   writes  one marker, <marker dir>/<pid> = this process's start time in milliseconds, so the asight engine knows the CA is in
// It never touches request or response bytes, opens no connection, writes no agent config. It adds nothing and writes no marker when tls.setDefaultCACertificates is missing (Node < 22.19),
// under --use-openssl-ca (the call would then replace the roots), or when the CA file is missing or not PEM; it never throws.
import fs from 'node:fs'
import tls from 'node:tls'

const CA_FILE = '__ASIGHT_CA_FILE__'
const MARKER_DIR = '__ASIGHT_MARKER_DIR__'
const PEM = /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/

function addCa() {
  if (typeof tls.setDefaultCACertificates !== 'function' || typeof tls.getCACertificates !== 'function') return
  if ([...process.execArgv, ...String(process.env.NODE_OPTIONS || '').split(/\s+/)].includes('--use-openssl-ca')) return
  let ca = null
  try { ca = PEM.exec(fs.readFileSync(CA_FILE, 'utf8')) } catch { return }
  if (!ca) return
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ca[0]])
  const tmp = `${MARKER_DIR}/.${process.pid}.tmp`
  fs.writeFileSync(tmp, String(Math.round(performance.timeOrigin)), { mode: 0o600 }) // Windows has no /proc: the process' own start, which the engine compares with a tolerance
  fs.renameSync(tmp, `${MARKER_DIR}/${process.pid}`)
}

try { addCa() } catch { /* asight never stops the agent from starting */ }

export const name = 'asight-ca'
export function apply() {}
