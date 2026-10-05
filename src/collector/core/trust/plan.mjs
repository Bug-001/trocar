// plan.mjs — the trust-injection plan (RFC 4.6 §身份与信任「信任注入」, acceptance T10). A pure function from the
// harness descriptors' `inject(ctx)` declarations to every file asight will write or change, checked against the
// D37④ prohibitions BEFORE anything is touched (安装 MUST 先列出要改的每个文件,再动手). Knows no harness.
//   entry = { kind: 'json-key', path, keys, value, semantic: 'append'|'replace' }   a key in a user file
//   file  = { path, certsFrom: string[] }   an asight-owned trust file: the CERTIFICATE blocks of the user's CA
//           files + the asight CA, nothing else (never a private key, never a copy of a user file)
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import { certBlocks } from './confirm.mjs'

// Login-environment locations: a CA variable there makes every program of the user trust asight (vetoed, D37④).
const LOGIN_ENV = [/\/\.config\/environment\.d\//, /\/\.(profile|bash_profile|bash_login|bashrc|zshrc|zshenv|zprofile|zlogin|pam_environment)$/, /\/\.config\/fish\//, /^\/etc\//]
const NEVER_KEYS = new Set(['NODE_OPTIONS', 'SSL_CERT_DIR', 'NODE_TLS_REJECT_UNAUTHORIZED'])
const fingerprint = (pem) => { try { return new X509Certificate(pem).fingerprint256 } catch { return null } }

export function planTrust({ descriptors, ctxFor, caCertPem, collectorDir }) {
  const entries = []
  const files = []
  const notes = []
  const under = (p) => p.startsWith(collectorDir + path.sep)
  for (const d of descriptors) {
    if (typeof d.inject !== 'function') continue
    const ctx = ctxFor(d)
    const out = d.inject(ctx) || {}
    for (const e of out.entries || []) {
      const where = `${d.name}: ${e.path}`
      if (e.kind !== 'json-key') throw new Error(`${where}: unknown entry kind ${e.kind}`)
      if (!path.isAbsolute(e.path) || !path.isAbsolute(e.value)) throw new Error(`${where}: paths must be absolute`)
      if (LOGIN_ENV.some((re) => re.test(e.path))) throw new Error(`${where}: a login-environment file is never a trust entry (D37④)`)
      if (NEVER_KEYS.has(e.keys[e.keys.length - 1])) throw new Error(`${where}: ${e.keys[e.keys.length - 1]} is never written (D37④)`)
      if (!under(e.value)) throw new Error(`${where}: the value must be a file under ${collectorDir} (it is how asight recognises its key)`)
      if (e.semantic === 'replace' && !/\/combined-[a-z0-9-]+\.pem$/.test(e.value)) throw new Error(`${where}: a replace-semantics entry must point at a combined bundle, never an asight-only file`)
      entries.push({ harness: d.name, ...e })
    }
    for (const f of out.files || []) {
      if (!under(f.path)) throw new Error(`${d.name}: ${f.path} is not under ${collectorDir}`)
      const seen = new Set()
      const pems = []
      const sources = [] // the user's CA files whose certificate blocks were carried over (paths only, for the manifest)
      const add = (pem) => { const fp = fingerprint(pem); if (fp && !seen.has(fp)) { seen.add(fp); pems.push(pem.trim()) } }
      for (const src of f.certsFrom || []) {
        const text = ctx.readText(src)
        if (text == null) { notes.push(`${d.name}: ${src} is unreadable; its certificates are not carried over`); continue }
        sources.push(src)
        certBlocks(text).forEach(add)
      }
      add(caCertPem)
      files.push({ harness: d.name, path: f.path, data: pems.join('\n') + '\n', sources })
    }
    for (const n of out.notes || []) notes.push(`${d.name}: ${n}`)
  }
  return { entries, files, notes, paths: [...files.map((f) => f.path), ...entries.map((e) => e.path)] }
}
