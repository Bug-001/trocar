// bundle.mjs — the per-harness combined bundles `combined-<h>.pem` (RFC 4.6 §身份与信任「合并包」「替换语义的设置」,
// §安装清单与卸载 撤销顺序第 2 步; acceptance T14). A replace-semantics entry (Codex / Hermes SSL_CERT_FILE, Z-Code
// caCertFile) points at one of these, never at an asight-only file: Node's roots + the OS roots + the user CAs found
// in THAT harness's own config + the asight CA. From a user's CA file only CERTIFICATE PEM blocks are taken; every
// other block (a private key, a TRUSTED CERTIFICATE, a CRL) and a DER file are left out and named, so the user knows
// which CA did not make it. Rebuilt atomically when the roots change (daemon start, daily); at uninstall rewritten
// without the asight CA. Knows no harness and no OS: the caller passes the roots.
import nodeFs from 'node:fs'
import { writeDurable, sha256 } from '../../../off/fsutil.mjs'
import { saveManifest } from '../../../off/manifest.mjs'
import { certsOf, rootsFingerprint, composeBundle, userCertsIn } from '../../../off/pem.mjs'

// The PEM readers and the bundle composer moved into src/off/pem.mjs, so `asight off` (which runs without the collector) makes the same
// bundle the install does (1.6 R3, 0.1 §2); the collector's importers keep their names here.
export { certsOf, rootsFingerprint, composeBundle, userCertsIn }

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
//   `only` (a Set of harness ids, daemon only): the bundles of other harnesses are left as they are; a bundle with no harness is rebuilt as before.
//   `report` ({rebuilt: [{path, harness, why}], failed: [{path, harness, error}], lost: [{path, harness, fps, sources}]}) makes
//   the caller see each bundle's own fate: a bundle whose rebuild throws is listed in `failed` (its old file is untouched: the
//   write is temp + rename) and the others still go on. Without `report` the first failure throws.
//   `lost`: a bundle rebuilt from its recorded sources that no longer holds a user CA it held at install (its `user_fps`): the
//   source file moved or went (`sources`, each with the errno) or no longer has that certificate. The rebuilt bundle is
//   still right for Node, the OS and asight, but an agent that REPLACES its roots with it can no longer reach a relay that
//   signs with the lost CA (D38: a silent partial is what 4.6 「合并包」 forbids).
export function rewriteBundles({ dir, manifest, nodeRoots, osRootsText, caPem = null, withCa = true, force = false, only = null, fs = nodeFs, report = null }) {
  const done = []
  const rootsFp = rootsFingerprint(nodeRoots, osRootsText)
  for (const f of manifest.files.filter((x) => x.role === 'bundle')) {
    if (withCa && !force && f.without_ca) continue // `off` kept it without the asight CA for a live process: never written back with it (4.6 「合并包」, D39); `force` (`on`) does
    if (withCa && !force && only && f.harness != null && !only.has(f.harness)) continue // `only`: the harnesses whose desired state is on (a daemon rebuilds no other); null = every one
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
      if (withCa) delete f.without_ca
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
