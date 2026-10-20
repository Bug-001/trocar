// pem.mjs (src/off) — the PEM reading and writing `off` needs without the collector (RFC 4.6 §身份与信任「合并包」, §安装清单与卸载「撤销顺序」
// 第 2 / 3 步, 1.6 R3). The combined bundle `combined-<h>.pem` (Node's roots + the OS roots + the user's CAs + the trocar CA) is composed by the
// collector at install and rebuilt by it; `off` takes the trocar CA back out of it (stripCert), or composes the same file without it when it
// is gone (composeBundle). The functions that were in src/collector/core/trust/bundle.mjs moved here with their behaviour, so the file that
// install writes and the file `off` writes are made by one piece of code; bundle.mjs re-exports them. Imports only node:* (0.1 §2).
import crypto, { X509Certificate } from 'node:crypto'
import nodeFs from 'node:fs'

const BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g
// Every PEM block of a file, in order, from its BEGIN line: a block whose END line does not come before the next BEGIN (a
// file cut short) is listed with pem: null, so it is reported, never silently dropped (review D1-7). `start` / `end` are its offsets in `text`.
const BEGIN = /-----BEGIN ([A-Z0-9 ]+)-----/g
function pemBlocks(text) {
  const begins = [...text.matchAll(BEGIN)]
  return begins.map((b, i) => {
    const end = `-----END ${b[1]}-----`
    const at = text.indexOf(end, b.index + b[0].length)
    const next = i + 1 < begins.length ? begins[i + 1].index : text.length
    const whole = at >= 0 && at < next
    return { type: b[1], pem: whole ? text.slice(b.index, at + end.length) : null, start: b.index, end: whole ? at + end.length : next }
  })
}
const fpOf = (pem) => { try { return new X509Certificate(pem).fingerprint256 } catch { return null } }

/** The certificates of a text, in order: `[{ pem, fp }]`, `fp` the SHA-256 of the DER in the form node prints (`AB:CD:…`, the form the
 *  install manifest's `user_fps` holds). Private keys, other block types, blocks that do not parse and a block cut short are not certificates. */
export function certBlocks(text) {
  return pemBlocks(String(text)).filter((b) => b.type === 'CERTIFICATE' && b.pem != null).map((b) => ({ pem: b.pem, fp: fpOf(b.pem) })).filter((b) => b.fp)
}

/** `text` without every certificate block whose fingerprint is `fp`, each with the one newline that ends it; every other byte unchanged (a
 *  comment, a blank line, another block, the line endings). `removed`: false when there was none (the same text back). */
export function stripCert(text, fp) {
  const hit = pemBlocks(text).filter((b) => b.type === 'CERTIFICATE' && b.pem != null && fpOf(b.pem) === fp)
  if (!hit.length) return { text, removed: false }
  let out = text
  for (const b of hit.reverse()) { // from the end, so the offsets of the earlier blocks stay true
    const end = out.startsWith('\r\n', b.end) ? b.end + 2 : out.startsWith('\n', b.end) ? b.end + 1 : b.end
    out = out.slice(0, b.start) + out.slice(end)
  }
  return { text: out, removed: true }
}

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

// The bundle text: Node roots, OS roots, the user's CAs, the trocar CA (when given), each certificate once.
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

// The OS PEM bundle of each distro family, in the order a lookup tries them: the one list of this fact. It lives here because `off` may import
// nothing outside src/off (R3) and rebuilds a gone bundle from it; src/collector/core/tls/roots.mjs re-exports it for the engine's trust set and
// for the Linux arch's combined-bundle roots (4.6 §引擎 第 5 步, 「合并包」). Data, not a platform branch: a path that is not on this OS is skipped.
export const SYSTEM_BUNDLES = Object.freeze([
  '/etc/ssl/certs/ca-certificates.crt',                // Debian, Ubuntu, Arch, Alpine, NixOS, Gentoo
  '/etc/pki/tls/certs/ca-bundle.crt',                  // Fedora, RHEL, CentOS
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem', // RHEL 7+
  '/etc/ssl/ca-bundle.pem',                            // openSUSE
  '/etc/pki/tls/cacert.pem',                           // OpenELEC
  '/etc/ssl/cert.pem',                                 // Alpine's link; macOS, BSD (not the keychain's added roots)
])

/** osBundle({files, read}) → {file, text, failed}: the first OS PEM bundle that holds a certificate — file null and text '' when none
 *  does. A path that is not on this OS (ENOENT, ENOTDIR) is skipped; one that is there but cannot be read is skipped and listed in
 *  `failed` as {file, error}, for the caller to say (D38). */
export function osBundle({ files = SYSTEM_BUNDLES, read = (f) => nodeFs.readFileSync(f, 'utf8') } = {}) {
  const failed = []
  for (const file of files) {
    let text
    try { text = String(read(file)) } catch (e) {
      if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) failed.push({ file, error: e })
      continue
    }
    if (certBlocks(text).length) return { file, text, failed }
  }
  return { file: null, text: '', failed }
}

// The user's certificates of an existing bundle (by fingerprint, as recorded at install): what a rebuild carries over
// without reading the user's files again (they may have moved; their contents are not trocar's to re-copy).
export function userCertsIn(text, userFps) {
  const want = new Set(userFps || [])
  return (String(text || '').match(BLOCK) || []).filter((pem) => want.has(fpOf(pem)))
}
