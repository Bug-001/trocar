// plan.mjs — the trust-injection plan (RFC 4.6 §身份与信任「信任注入」, acceptance T10). A pure function from the
// harness descriptors' `inject(ctx)` declarations to every file asight will write or change, checked against the
// D37④ prohibitions BEFORE anything is touched (安装 MUST 先列出要改的每个文件,再动手). Knows no harness.
//   entry = { kind: 'json-key', path, keys, value, semantic: 'append'|'replace' }   a key in a user file
//         | { kind: 'text', path, format: 'dotenv-block', vars, semantic }   a sentinel block (text-edit.mjs)
//         | { kind: 'text', path, format: 'line'|'yaml-list', line, after? }   one sentinel line / YAML row
//   file  = { path, certsFrom: string[] }   an asight-owned trust file: the CERTIFICATE blocks of the user's CA
//           files + the asight CA, nothing else (never a private key, never a copy of a user file)
//   owned = { path, role: 'plugin'|'shim', data, mode? }   a file asight writes whole (a trust plugin, a launch shim);
//           outside the collector dir only with "asight" in its name and the sentinel in its text (4.6 文件头的哨兵注释)
//   watch = { path, why }   a path the agent may write because of asight's file (OpenCode's npm install, 4.6):
//           whether it existed is recorded at install; uninstall reports, never deletes, what appeared
//   notes = string | { code, text }   what the user should know; also written as install-note events (D38)
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import { certBlocks } from './confirm.mjs'
import { SENTINEL } from './text-edit.mjs'
import { CODE } from '../codes.mjs'

// Login-environment locations: a CA variable there makes every program of the user trust asight (vetoed, D37④).
const LOGIN_ENV = [/\/\.config\/environment\.d\//, /\/\.(profile|bash_profile|bash_login|bashrc|zshrc|zshenv|zprofile|zlogin|pam_environment)$/, /\/\.config\/fish\//, /^\/etc\//]
const NEVER_KEYS = new Set(['NODE_OPTIONS', 'SSL_CERT_DIR', 'NODE_TLS_REJECT_UNAUTHORIZED'])
// Library-level variables that REPLACE the trust store (or the one CA file a client uses) whatever a descriptor
// declares: pointed at an asight-only file they would break every other TLS peer of the process (0.1 §5, T10). The
// descriptor's own trust chain adds its harness-specific ones (`semantic: 'replace'`). No harness names here.
const REPLACE_KEYS = new Set(['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'])
const fingerprint = (pem) => { try { return new X509Certificate(pem).fingerprint256 } catch { return null } }
// A CA variable or a TLS switch in a text line: lines asight writes never set one (D37④; a block sets its vars).
const CA_WORDS = /\b(NODE_EXTRA_CA_CERTS|NODE_OPTIONS|SSL_CERT_FILE|SSL_CERT_DIR|NODE_TLS_REJECT_UNAUTHORIZED|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|ssl_verify)\b/
// The one line a login-environment file may get: the launch-shim directory first on PATH (4.6 Kimi row) — it changes
// what a command name resolves to, it is not a CA variable. Exactly this shape, the dir under the collector dir.
const shimPathLine = (collectorDir) => new RegExp(`^export PATH="${(collectorDir + '/bin').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\$PATH" # ${SENTINEL}: `)

export function planTrust({ descriptors, ctxFor, caCertPem, collectorDir }) {
  const entries = []
  const files = []
  const notes = []
  const under = (p) => p.startsWith(collectorDir + path.sep)
  const owned = []
  const watch = []
  const records = [] // the notes as install-note events: { harness, code, reason }
  for (const d of descriptors) {
    if (typeof d.inject !== 'function') continue
    const ctx = ctxFor(d)
    const out = d.inject(ctx) || {}
    // one variable set to one value: the checks every CA setting asight writes must pass (key or block variable)
    const checkVar = (where, key, value, semantic) => {
      if (!path.isAbsolute(value)) throw new Error(`${where}: paths must be absolute`)
      if (NEVER_KEYS.has(key)) throw new Error(`${where}: ${key} is never written (D37④)`)
      if (!under(value)) throw new Error(`${where}: the value must be a file under ${collectorDir} (it is how asight recognises its key)`)
      const declared = ((d.trust && d.trust.chain) || []).some((c) => c.var === key && c.semantic === 'replace')
      if ((semantic === 'replace' || REPLACE_KEYS.has(key) || declared) && path.basename(value) !== `combined-${d.name}.pem`) {
        throw new Error(`${where}: ${key} replaces the trust store, so it may only point at this harness's own combined bundle combined-${d.name}.pem — never an asight-only file or another harness's bundle`)
      }
    }
    for (const e of out.entries || []) {
      const where = `${d.name}: ${e.path}`
      if (!path.isAbsolute(e.path)) throw new Error(`${where}: paths must be absolute`)
      const loginEnv = LOGIN_ENV.some((re) => re.test(e.path))
      if (e.kind === 'json-key') {
        if (loginEnv) throw new Error(`${where}: a login-environment file is never a trust entry (D37④)`)
        checkVar(where, e.keys[e.keys.length - 1], e.value, e.semantic)
      } else if (e.kind === 'text' && e.format === 'dotenv-block') {
        if (loginEnv) throw new Error(`${where}: a login-environment file is never a trust entry (D37④)`)
        if (!e.vars || !Object.keys(e.vars).length) throw new Error(`${where}: a block needs its variables`)
        for (const [k, v] of Object.entries(e.vars)) checkVar(where, k, v, e.semantic)
      } else if (e.kind === 'text' && (e.format === 'line' || e.format === 'yaml-list')) {
        if (typeof e.line !== 'string' || !e.line.includes(SENTINEL)) throw new Error(`${where}: a line asight writes carries the sentinel comment`)
        if (CA_WORDS.test(e.line)) throw new Error(`${where}: a line never sets a CA variable or a TLS switch (D37④)`)
        if (loginEnv && !(e.format === 'line' && shimPathLine(collectorDir).test(e.line) && e.after)) {
          throw new Error(`${where}: a login-environment file only ever gets the launch-shim PATH line, placed after the agent installer's own (D37④)`)
        }
      } else throw new Error(`${where}: unknown entry kind ${e.kind}${e.format ? ` / format ${e.format}` : ''}`)
      entries.push({ harness: d.name, ...e })
    }
    for (const o of out.owned || []) {
      const where = `${d.name}: ${o.path}`
      if (!path.isAbsolute(o.path)) throw new Error(`${where}: paths must be absolute`)
      if (o.role !== 'plugin' && o.role !== 'shim') throw new Error(`${where}: unknown owned-file role ${o.role}`)
      if (typeof o.data !== 'string') throw new Error(`${where}: an owned file needs its contents`)
      if (LOGIN_ENV.some((re) => re.test(o.path))) throw new Error(`${where}: a login-environment file is never a trust entry (D37④)`)
      if (o.role === 'shim' && path.dirname(o.path) !== path.join(collectorDir, 'bin')) throw new Error(`${where}: a launch shim lives in ${collectorDir}/bin, the shim directory, and nowhere else`)
      if (!under(o.path) && (!path.basename(o.path).includes('asight') || !o.data.includes(SENTINEL))) {
        throw new Error(`${where}: a file asight puts in an agent's directory has "asight" in its name and the sentinel comment in its text`)
      }
      owned.push({ harness: d.name, mode: 0o600, ...o })
    }
    for (const w of out.watch || []) {
      if (!path.isAbsolute(w.path)) throw new Error(`${d.name}: ${w.path}: paths must be absolute`)
      watch.push({ harness: d.name, ...w })
    }
    for (const f of out.files || []) {
      if (!under(f.path)) throw new Error(`${d.name}: ${f.path} is not under ${collectorDir}`)
      const seen = new Set()
      const pems = []
      const sources = [] // the user's CA files whose certificate blocks were carried over (paths only, for the manifest)
      const add = (pem) => { const fp = fingerprint(pem); if (fp && !seen.has(fp)) { seen.add(fp); pems.push(pem.trim()) } }
      for (const src of f.certsFrom || []) {
        const text = ctx.readText(src)
        if (text == null) { note(d.name, CODE.sourceUnreadable, `${src} is unreadable; its certificates are not carried over`); continue }
        sources.push(src)
        certBlocks(text).forEach(add)
      }
      add(caCertPem)
      files.push({ harness: d.name, path: f.path, data: pems.join('\n') + '\n', sources })
    }
    for (const n of out.notes || []) note(d.name, typeof n === 'string' ? CODE.harnessNote : n.code, typeof n === 'string' ? n : n.text)
  }
  function note(harness, code, text) { notes.push(`${harness}: ${text}`); records.push({ harness, code, reason: text }) }
  const shims = owned.filter((o) => o.role === 'shim')
  if (new Set(shims.map((o) => path.basename(o.path))).size !== shims.length) throw new Error('two launch shims of one name: the shim directory holds one shim per command')
  return { entries, files, owned, watch, notes, records, paths: [...files.map((f) => f.path), ...owned.map((o) => o.path), ...entries.map((e) => e.path)] }
}
