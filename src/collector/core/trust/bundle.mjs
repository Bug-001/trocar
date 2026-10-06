// bundle.mjs — the per-harness combined bundles `combined-<h>.pem` (RFC 4.6 §身份与信任「合并包」「替换语义的设置」,
// §安装清单与卸载 撤销顺序第 2 步; acceptance T14). A replace-semantics entry (Codex / Hermes SSL_CERT_FILE, Z-Code
// caCertFile) points at one of these, never at an asight-only file: Node's roots + the OS roots + the user CAs found
// in THAT harness's own config + the asight CA. From a user's CA file only CERTIFICATE PEM blocks are taken; every
// other block (a private key, a TRUSTED CERTIFICATE, a CRL) and a DER file are left out and named, so the user knows
// which CA did not make it. Rebuilt atomically when the roots change (daemon start, daily); at uninstall rewritten
// without the asight CA. Knows no harness and no OS: the caller passes the roots.
import nodeFs from 'node:fs'
import crypto, { X509Certificate } from 'node:crypto'
import { writeDurable, sha256 } from '../../../off/fsutil.mjs'
import { saveManifest } from './journal.mjs'

const BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g
// Every PEM block of a file, in order, from its BEGIN line: a block whose END line does not come before the next BEGIN (a
// file cut short) is listed with pem: null, so it is reported, never silently dropped (review D1-7).
const BEGIN = /-----BEGIN ([A-Z0-9 ]+)-----/g
function pemBlocks(text) {
  const begins = [...text.matchAll(BEGIN)]
  return begins.map((b, i) => {
    const end = `-----END ${b[1]}-----`
    const at = text.indexOf(end, b.index + b[0].length)
    const next = i + 1 < begins.length ? begins[i + 1].index : text.length
    return { type: b[1], pem: at >= 0 && at < next ? text.slice(b.index, at + end.length) : null }
  })
}
const fpOf = (pem) => { try { return new X509Certificate(pem).fingerprint256 } catch { return null } }

// The CERTIFICATE blocks of a user's CA file, and what was left out of it: { certs: [pem], skipped: [{file, type, index,
// why}] }. `index` is the block's position in the file from 1 and `type` its PEM type; a file with no PEM block at all
// is { type: null, index: null } (a DER file?). Never the contents of a block (D-28, 4.6 「合并包」).
export function certsOf(file, buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf)
  const blocks = pemBlocks(text)
  if (!blocks.length) return { certs: [], skipped: [{ file, type: null, index: null, why: 'it holds no PEM block (a DER file, or not a certificate file)' }] }
  const certs = []
  const skipped = []
  blocks.forEach((b, i) => {
    if (b.pem == null) skipped.push({ file, type: b.type, index: i + 1, why: `it has no END ${b.type} line (the file is cut short?)` })
    else if (b.type !== 'CERTIFICATE') skipped.push({ file, type: b.type, index: i + 1, why: /PRIVATE KEY/.test(b.type) ? 'a private key is never copied' : 'only CERTIFICATE blocks are carried over' })
    else if (fpOf(b.pem)) certs.push(b.pem.trim())
    else skipped.push({ file, type: 'CERTIFICATE', index: i + 1, why: 'it does not parse as a certificate' })
  })
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
//   A bundle that is missing or cannot be read (deleted by the user, EACCES) is rebuilt the same way, from the user CA
//   files the install recorded as its `sources` (a source that is gone is simply not carried over): an agent whose entry
//   points at it has no network without it (4.6 「合并包」, D38 F1(d)). Only with the asight CA: at uninstall a bundle that
//   is already gone has nothing to rewrite.
//   At uninstall (`withCa: false`) a bundle that is not there (ENOENT) has nothing to rewrite, but one that is there and cannot
//   be read still holds the asight CA: that is a failure of its own (EACCES, EIO, a directory), never a skip (D38, 4.6
//   「撤销顺序」第 2 步: not silent).
//   `report` ({rebuilt: [{path, harness, why}], failed: [{path, harness, error}], lost: [{path, harness, fps, sources}]}) makes
//   the caller see each bundle's own fate: a bundle whose rebuild throws is listed in `failed` (its old file is untouched: the
//   write is temp + rename) and the others still go on. Without `report` the first failure throws.
//   `lost`: a bundle rebuilt from its recorded sources that no longer holds a user CA it held at install (its `user_fps`): the
//   source file moved or went (`sources`, each with the errno) or no longer has that certificate. The rebuilt bundle is
//   still right for Node, the OS and asight, but an agent that REPLACES its roots with it can no longer reach a relay that
//   signs with the lost CA (D38: a silent partial is what 4.6 「合并包」 forbids).
export function rewriteBundles({ dir, manifest, nodeRoots, osRootsText, caPem = null, withCa = true, force = false, fs = nodeFs, report = null }) {
  const done = []
  const rootsFp = rootsFingerprint(nodeRoots, osRootsText)
  for (const f of manifest.files.filter((x) => x.role === 'bundle')) {
    try {
      let cur = null, gone = null
      try { cur = fs.readFileSync(f.path, 'utf8') } catch (e) { gone = e.code || String(e.message || e) }
      if (cur != null && withCa && !force && f.roots_fp === rootsFp) continue
      if (cur == null && !withCa) {
        if (gone === 'ENOENT') continue // already gone: nothing to rewrite, and uninstall never recreates a bundle
        throw Object.assign(new Error(`${f.path} cannot be read (${gone}), so it was not rewritten without the asight CA`), { code: gone })
      }
      let userCerts
      const unread = []
      if (cur != null) userCerts = userCertsIn(cur, f.user_fps)
      else {
        userCerts = []
        for (const src of f.sources || []) { try { userCerts.push(...certsOf(src, fs.readFileSync(src)).certs) } catch (e) { unread.push({ file: src, errno: e.code || String(e.message || e) }) } } // the user's file moved or went: not carried over, and said
      }
      const b = composeBundle({ nodeRoots, osRootsText, userCerts, caPem: withCa ? caPem : null })
      const lost = cur == null && report ? (f.user_fps || []).filter((x) => !b.user_fps.includes(x)) : []
      writeDurable(f.path, b.data, 0o600, fs)
      Object.assign(f, { roots_fp: b.roots_fp, sha256: sha256(Buffer.from(b.data)), ...(cur == null ? { user_fps: b.user_fps } : {}), ...(withCa ? {} : { without_ca: true }) })
      done.push(f.path)
      if (report) report.rebuilt.push({ path: f.path, harness: f.harness ?? null, why: cur == null ? gone : 'roots-changed' })
      if (lost.length) (report.lost ||= []).push({ path: f.path, harness: f.harness ?? null, fps: lost, sources: unread })
    } catch (e) {
      if (!report) throw e
      report.failed.push({ path: f.path, harness: f.harness ?? null, error: e })
    }
  }
  if (done.length) saveManifest(dir, manifest, fs)
  return done
}
