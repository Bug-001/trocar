// asight collector: trust plugin for DeepSeek dsh on macOS. Rendered into asight's own plugin directory (<collectorDir>/plugins/dsh/index.js, the Linux descriptor's layout — the
// Windows twin's beside-the-patch-file shape was its lab's, not macOS's) and loaded by one sentinel-marked row of the user's cordis.patch.yml that names it by absolute path;
// `asight off` removes both (RFC 4.9 §2.3 · §6.1, D37④ bounded exception; the plugin body is the win32 twin's, 4.8 §6.1 / W22 — darwin has no /proc either, so the marker's start
// time is performance.timeOrigin, the same answer the win line measured). What it does, and nothing else:
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
  fs.writeFileSync(tmp, String(Math.round(performance.timeOrigin)), { mode: 0o600 }) // darwin has no /proc: the process' own start, which the engine compares with a tolerance
  fs.renameSync(tmp, `${MARKER_DIR}/${process.pid}`)
}

try { addCa() } catch { /* asight never stops the agent from starting */ }

export const name = 'asight-ca'
export function apply() {}
