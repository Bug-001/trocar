// ca-store.mjs — the collector CA on disk (RFC 4.6 §身份与信任「CA」, D36, acceptance T9). The private
// key lives in the operator's own ~/.asight/collector/ca/ca.key (0600, dir 0700) — never in the legacy
// MITM CA dirs (~/.asight/ca, ~/.atrace/ca: a second CA with the same CN once broke Desktop networking,
// the CA collision of 2026-07-21), never in any trust store, never rotated (agents read
// the PEM once at start). Half pairs: key without PEM means a mint crashed before the PEM was written,
// so nothing can trust it yet → mint again; PEM without key may already be injected into agents →
// refuse rather than silently replace it.
import nodeFs from 'node:fs'
import path from 'node:path'
import { createCa } from './ca.mjs'

export const COLLECTOR_CA_CN = 'asight collector CA'

export const caPaths = (dir) => ({ dir, key: path.join(dir, 'ca.key'), pem: path.join(dir, 'asight-ca.pem') })

function writeAtomic(fs, file, text, mode) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, { mode })
  fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, file)
}

export function loadOrCreateCa({ dir, fs = nodeFs }) {
  const parent = path.basename(path.dirname(dir))
  if (path.basename(dir) !== 'ca' || parent !== 'collector') {
    throw new Error(`collector CA dir must be …/collector/ca (got ${dir}); the legacy MITM CA dirs are never used`)
  }
  const p = caPaths(dir)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  const hasKey = fs.existsSync(p.key)
  const hasPem = fs.existsSync(p.pem)
  if (hasKey && hasPem) {
    return { keyPem: fs.readFileSync(p.key, 'utf8'), certPem: fs.readFileSync(p.pem, 'utf8'), created: false, paths: p }
  }
  if (hasPem && !hasKey) throw new Error(`${p.key} is missing but ${p.pem} exists; refusing to replace a CA agents may already trust`)
  const { keyPem, certPem } = createCa({ commonName: COLLECTOR_CA_CN })
  writeAtomic(fs, p.key, keyPem, 0o600)     // key first: a crash before the PEM leaves "key only" → re-mint
  writeAtomic(fs, p.pem, certPem, 0o644)
  return { keyPem, certPem, created: true, paths: p }
}

// The CA as installed, or {error, code, which, file} saying which file could not be read and why — an unreadable CA is
// "CA unusable", never "not installed" (D38 D-4). The daemon only reads it: `asight collector install` mints it,
// inside the install manifest, so uninstall finds and removes it (4.6 §安装清单与卸载).
export function readCa({ dir, fs = nodeFs }) {
  const p = caPaths(dir)
  const read = (which, file) => { try { return { text: fs.readFileSync(file, 'utf8') } } catch (e) { return { error: `${file}: ${String(e.message || e)}`, code: e.code || null, which, file } } }
  const key = read('key', p.key)
  if (key.error) return { ...key, paths: p }
  const cert = read('cert', p.pem)
  if (cert.error) return { ...cert, paths: p }
  return { keyPem: key.text, certPem: cert.text, created: false, paths: p }
}
