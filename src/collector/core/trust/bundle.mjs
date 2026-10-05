// bundle.mjs — the per-harness combined bundles `combined-<h>.pem` (RFC 4.6 §身份与信任「合并包」「替换语义的设置」,
// §安装清单与卸载 撤销顺序第 2 步; acceptance T14). A replace-semantics entry (Codex / Hermes SSL_CERT_FILE, Z-Code
// caCertFile) points at one of these, never at an asight-only file: Node's roots + the OS roots + the user CAs found
// in THAT harness's own config + the asight CA. From a user's CA file only CERTIFICATE PEM blocks are taken; every
// other block (a private key, a TRUSTED CERTIFICATE, a CRL) and a DER file are left out and named, so the user knows
// which CA did not make it. Rebuilt atomically when the roots change (daemon start, daily); at uninstall rewritten
// without the asight CA. Knows no harness and no OS: the caller passes the roots.
import nodeFs from 'node:fs'
import crypto, { X509Certificate } from 'node:crypto'
import { writeDurable, saveManifest, sha256 } from './journal.mjs'

const BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g
const fpOf = (pem) => { try { return new X509Certificate(pem).fingerprint256 } catch { return null } }

// The CERTIFICATE blocks of a user's CA file, and what was left out of it: { certs: [pem], skipped: [{file, type}] }.
export function certsOf(file, buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf)
  const blocks = [...text.matchAll(BLOCK)]
  if (!blocks.length) return { certs: [], skipped: [{ file, type: text.trim() ? 'DER or other non-PEM content' : 'empty file' }] }
  const certs = []
  const skipped = []
  for (const m of blocks) {
    if (m[1] !== 'CERTIFICATE') { skipped.push({ file, type: m[1] }); continue }
    if (fpOf(m[0])) certs.push(m[0].trim())
    else skipped.push({ file, type: 'CERTIFICATE (unparsable)' })
  }
  return { certs, skipped }
}

// One fingerprint for the root set, so a rebuild knows the roots changed.
export function rootsFingerprint(nodeRoots, osRootsText) {
  const fps = [...nodeRoots, ...(String(osRootsText || '').match(BLOCK) || [])].map(fpOf).filter(Boolean).sort()
  return crypto.createHash('sha256').update([...new Set(fps)].join('\n')).digest('hex')
}

// The bundle text: Node roots, OS roots, the user's CAs, the asight CA (when given), each certificate once.
export function composeBundle({ nodeRoots, osRootsText, userCerts = [], caPem = null }) {
  const seen = new Set()
  const out = []
  const add = (pem) => { const fp = fpOf(pem); if (fp && !seen.has(fp)) { seen.add(fp); out.push(pem.trim()) } }
  for (const p of nodeRoots) add(p)
  for (const m of String(osRootsText || '').match(BLOCK) || []) if (m.startsWith('-----BEGIN CERTIFICATE-----')) add(m)
  const userFps = []
  for (const p of userCerts) { const fp = fpOf(p); if (fp && !userFps.includes(fp)) userFps.push(fp); add(p) } // kept even when a root today
  if (caPem) add(caPem)
  return { data: out.join('\n') + '\n', user_fps: userFps, roots_fp: rootsFingerprint(nodeRoots, osRootsText) }
}

// The user's certificates of an existing bundle (by fingerprint, as recorded at install): what a rebuild carries over
// without reading the user's files again (they may have moved; their contents are not asight's to re-copy).
export function userCertsIn(text, userFps) {
  const want = new Set(userFps || [])
  return (String(text || '').match(BLOCK) || []).filter((pem) => want.has(fpOf(pem)))
}

// Rebuild every bundle the manifest lists whose roots changed (`withCa`), or every one without the asight CA
// (uninstall step 2, `withCa: false`). Atomic per file (temp + rename); the manifest records the new roots / sha.
// Returns the paths rewritten.
export function rewriteBundles({ dir, manifest, nodeRoots, osRootsText, caPem = null, withCa = true, force = false, fs = nodeFs }) {
  const done = []
  const rootsFp = rootsFingerprint(nodeRoots, osRootsText)
  for (const f of manifest.files.filter((x) => x.role === 'bundle')) {
    if (withCa && !force && f.roots_fp === rootsFp) continue
    let cur
    try { cur = fs.readFileSync(f.path, 'utf8') } catch (e) { if (e.code === 'ENOENT') continue; throw e }
    const b = composeBundle({ nodeRoots, osRootsText, userCerts: userCertsIn(cur, f.user_fps), caPem: withCa ? caPem : null })
    writeDurable(f.path, b.data, 0o600, fs)
    Object.assign(f, { roots_fp: b.roots_fp, sha256: sha256(Buffer.from(b.data)), ...(withCa ? {} : { without_ca: true }) })
    done.push(f.path)
  }
  if (done.length) saveManifest(dir, manifest, fs)
  return done
}
