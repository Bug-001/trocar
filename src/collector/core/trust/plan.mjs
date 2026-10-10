// plan.mjs — the trust-injection plan (RFC 4.6 §身份与信任「信任注入」, acceptance T10). A pure function from the
// harness descriptors' `inject(ctx)` declarations to every file asight will write or change, checked against the
// D37④ prohibitions BEFORE anything is touched (安装 MUST 先列出要改的每个文件,再动手). Knows no harness.
//   entry = { kind: 'json-key', path, keys, value, semantic: 'append'|'replace' }   a key in a user file
//         | { kind: 'text', path, format: 'dotenv-block', vars, semantic }   a sentinel block (text-edit.mjs)
//         | { kind: 'text', path, format: 'line'|'yaml-list', line, after? }   one sentinel line / YAML row
//   file  = { path, certsFrom: string[], bundle? }   an asight-owned trust file: the CERTIFICATE blocks of the user's
//           CA files + the asight CA, nothing else (never a private key, never a copy of a user file); `bundle: true`
//           makes it a combined bundle (bundle.mjs: Node roots + OS roots first), the only file a replace-semantics
//           entry may name (combined-<harness>.pem)
//   owned = { path, role: 'plugin'|'shim', data, mode? }   a file asight writes whole (a trust plugin, a launch shim);
//           outside the collector dir only with "asight" in its name and the sentinel in its text (4.6 文件头的哨兵注释)
//   watch = { path, why }   a path the agent may write because of asight's file (OpenCode's npm install, 4.6):
//           whether it existed is recorded at install; uninstall reports, never deletes, what appeared
//   notes = string | { code, text }   what the user should know; also written as install-note events (D38)
// Windows (4.8 §6.1, `ctx.os === 'win32'`): the entries come from the descriptor's `win32.inject(ctx)` (the same contract), automatic ones only — a proxy entry is data
// (`win32.groups[].proxyEntry`), written after the kernel's read-back, never part of this plan (1.6 R9). A path may be written with either slash and is compared
// ignoring case; every path an entry writes INTO an agent's config (a key's value, a block's variables) is returned with forward slashes, because dotenvy reads a
// backslash as an escape and silently drops the value; a dotenv block's entry also says `quote: true`, so a profile directory with a space (C:\Users\John Smith) is written in double
// quotes instead of refused (the entry's `vars` keep the plain path). The PowerShell profile is the Windows login environment: never an entry.
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import { certsOf, composeBundle } from './bundle.mjs'
import { SENTINEL } from '../../../off/text-edit.mjs'
import { CODE } from '../codes.mjs'

// Login-environment locations: a CA variable there makes every program of the user trust asight (vetoed, D37④).
const LOGIN_ENV = [/\/\.config\/environment\.d\//, /\/\.(profile|bash_profile|bash_login|bashrc|zshrc|zshenv|zprofile|zlogin|pam_environment)$/, /\/\.config\/fish\//, /^\/etc\//]
const WIN_LOGIN_ENV = [/\/(Windows)?PowerShell\/[^/]*profile\.ps1$/i] // $PROFILE (slash-normalised path)
const slash = (p) => String(p).replace(/\\/g, '/')
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

// roots = { node: tls.rootCertificates, osText: the OS bundle's text } — needed only when a harness declares a bundle.
export function planTrust({ descriptors, ctxFor, caCertPem, collectorDir, roots = { node: [], osText: '' } }) {
  const entries = []
  const files = []
  const notes = []
  const skipped = [] // every block of a user CA file that is not carried over: {harness, file, type, index (from 1), note} (D-28)
  const owned = []
  const shimNames = [] // the file name of every launch shim, to refuse two of one name
  const watch = []
  const records = [] // the notes as install-note events: { harness, code, reason }
  for (const d of descriptors) {
    const ctx = ctxFor(d)
    const win = ctx.os === 'win32'
    const inject = win ? d.win32 && d.win32.inject : d.inject
    if (typeof inject !== 'function') continue
    // the path rules of the OS the entries are for: Windows paths are absolute with either slash, compare ignoring case, and are written with forward slashes
    const isAbs = win ? (p) => path.win32.isAbsolute(p) : (p) => path.isAbsolute(p)
    const under = win ? (p) => slash(p).toLowerCase().startsWith(slash(collectorDir).toLowerCase() + '/') : (p) => p.startsWith(collectorDir + path.sep)
    const base = win ? (p) => slash(p).split('/').pop() : (p) => path.basename(p)
    const binDir = win ? `${slash(collectorDir)}/bin` : path.join(collectorDir, 'bin')
    const inBin = (p) => (win ? slash(p).split('/').slice(0, -1).join('/').toLowerCase() === binDir.toLowerCase() : path.dirname(p) === binDir)
    const sameFile = (a, b) => (win ? slash(a).toLowerCase() === slash(b).toLowerCase() : a === b)
    const loginEnv = (p) => (win ? WIN_LOGIN_ENV.some((re) => re.test(slash(p))) : LOGIN_ENV.some((re) => re.test(p)))
    // a profile directory on Windows often has a space (C:\Users\John Smith): the block may then write its value in double quotes (`quote`, text-edit.mjs); the entry keeps the plain path
    const forward = (e) => (!win ? e : { ...e, ...(typeof e.value === 'string' ? { value: slash(e.value) } : {}), ...(e.vars ? { vars: Object.fromEntries(Object.entries(e.vars).map(([k, v]) => [k, slash(v)])), ...(e.format === 'dotenv-block' ? { quote: true } : {}) } : {}) })
    const out = inject(ctx) || {}
    // one variable set to one value: the checks every CA setting asight writes must pass (key or block variable)
    const checkVar = (where, key, value, semantic) => {
      if (!isAbs(value)) throw new Error(`${where}: paths must be absolute`)
      if (NEVER_KEYS.has(key)) throw new Error(`${where}: ${key} is never written (D37④)`)
      if (!under(value)) throw new Error(`${where}: the value must be a file under ${collectorDir} (it is how asight recognises its key)`)
      const declared = ((d.trust && d.trust.chain) || []).some((c) => c.var === key && c.semantic === 'replace')
      if (semantic === 'replace' || REPLACE_KEYS.has(key) || declared) {
        if (base(value) !== `combined-${d.name}.pem`) throw new Error(`${where}: ${key} replaces the trust store, so it may only point at this harness's own combined bundle combined-${d.name}.pem — never an asight-only file or another harness's bundle`)
        if (!(out.files || []).some((f) => sameFile(f.path, value) && f.bundle)) throw new Error(`${where}: ${key} names ${value}, which this harness does not declare as its combined bundle (files: [{ path, bundle: true }])`)
      }
    }
    for (const e of out.entries || []) {
      const where = `${d.name}: ${e.path}`
      if (!isAbs(e.path)) throw new Error(`${where}: paths must be absolute`)
      const inLogin = loginEnv(e.path)
      if (e.kind === 'json-key') {
        if (inLogin) throw new Error(`${where}: a login-environment file is never a trust entry (D37④)`)
        checkVar(where, e.keys[e.keys.length - 1], e.value, e.semantic)
      } else if (e.kind === 'text' && e.format === 'dotenv-block') {
        if (inLogin) throw new Error(`${where}: a login-environment file is never a trust entry (D37④)`)
        if (!e.vars || !Object.keys(e.vars).length) throw new Error(`${where}: a block needs its variables`)
        for (const [k, v] of Object.entries(e.vars)) checkVar(where, k, v, e.semantic)
      } else if (e.kind === 'text' && (e.format === 'line' || e.format === 'yaml-list')) {
        if (typeof e.line !== 'string' || !e.line.includes(SENTINEL)) throw new Error(`${where}: a line asight writes carries the sentinel comment`)
        if (CA_WORDS.test(e.line)) throw new Error(`${where}: a line never sets a CA variable or a TLS switch (D37④)`)
        if (inLogin && !(e.format === 'line' && shimPathLine(collectorDir).test(e.line) && e.after)) {
          throw new Error(`${where}: a login-environment file only ever gets the launch-shim PATH line, placed after the agent installer's own (D37④)`)
        }
      } else throw new Error(`${where}: unknown entry kind ${e.kind}${e.format ? ` / format ${e.format}` : ''}`)
      entries.push({ harness: d.name, ...forward(e) })
    }
    for (const o of out.owned || []) {
      const where = `${d.name}: ${o.path}`
      if (!isAbs(o.path)) throw new Error(`${where}: paths must be absolute`)
      if (o.role !== 'plugin' && o.role !== 'shim') throw new Error(`${where}: unknown owned-file role ${o.role}`)
      if (typeof o.data !== 'string') throw new Error(`${where}: an owned file needs its contents`)
      if (loginEnv(o.path)) throw new Error(`${where}: a login-environment file is never a trust entry (D37④)`)
      if (o.role === 'shim' && !inBin(o.path)) throw new Error(`${where}: a launch shim lives in ${collectorDir}/bin, the shim directory, and nowhere else`)
      if (o.role !== 'shim' && inBin(o.path)) throw new Error(`${where}: ${collectorDir}/bin is first on the user's PATH, so it holds launch shims only`)
      if (!under(o.path) && (!base(o.path).includes('asight') || !o.data.includes(SENTINEL))) {
        throw new Error(`${where}: a file asight puts in an agent's directory has "asight" in its name and the sentinel comment in its text`)
      }
      if (o.role === 'shim') shimNames.push(base(o.path))
      owned.push({ harness: d.name, mode: 0o600, ...o })
    }
    for (const w of out.watch || []) {
      if (!isAbs(w.path)) throw new Error(`${d.name}: ${w.path}: paths must be absolute`)
      watch.push({ harness: d.name, ...w })
    }
    for (const f of out.files || []) {
      if (!under(f.path)) throw new Error(`${d.name}: ${f.path} is not under ${collectorDir}`)
      if (f.bundle && base(f.path) !== `combined-${d.name}.pem`) throw new Error(`${d.name}: a combined bundle is named combined-${d.name}.pem, not ${base(f.path)}`)
      const userCerts = []
      const sources = [] // the user's CA files whose certificate blocks were carried over (paths only, for the manifest)
      for (const src of f.certsFrom || []) {
        const buf = ctx.readBytes ? ctx.readBytes(src) : ctx.readText(src)
        if (buf == null) { note(d.name, CODE.sourceUnreadable, `${src} is unreadable; its certificates are not carried over`); continue }
        sources.push(src)
        const got = certsOf(src, buf)
        userCerts.push(...got.certs)
        // 4.6 「合并包」: only CERTIFICATE blocks are carried over, and the install report names every other block —
        // by type and position, never its contents (a private key is never copied anywhere) (D-28)
        for (const k of got.skipped) {
          const text = `${k.file}: ${k.type ? `block ${k.index} (${k.type})` : 'the file'} is not carried over: ${k.why}`
          note(d.name, CODE.certNotMerged, text, { kind: 'skipped-block', file: k.file, type: k.type, index: k.index })
          skipped.push({ harness: d.name, file: k.file, type: k.type, index: k.index, note: `${d.name}: ${text}` })
        }
      }
      if (f.bundle) {
        const b = composeBundle({ nodeRoots: roots.node, osRootsText: roots.osText, userCerts, caPem: caCertPem })
        files.push({ harness: d.name, path: f.path, role: 'bundle', data: b.data, sources, user_fps: b.user_fps, roots_fp: b.roots_fp })
      } else {
        const seen = new Set()
        const pems = []
        for (const pem of [...userCerts, ...(caCertPem ? [caCertPem] : [])]) { const fp = fingerprint(pem); if (fp && !seen.has(fp)) { seen.add(fp); pems.push(pem.trim()) } }
        files.push({ harness: d.name, path: f.path, role: 'trust-file', data: pems.join('\n') + '\n', sources })
      }
    }
    for (const n of out.notes || []) note(d.name, typeof n === 'string' ? CODE.harnessNote : n.code, typeof n === 'string' ? n : n.text)
  }
  function note(harness, code, text, extra = {}) { const n = `${harness}: ${text}`; notes.push(n); records.push({ harness, code, reason: n, ...extra }) } // the record says what was printed, word for word (D-28)
  if (new Set(shimNames).size !== shimNames.length) throw new Error('two launch shims of one name: the shim directory holds one shim per command')
  return { entries, files, owned, watch, notes, records, skipped, paths: [...files.map((f) => f.path), ...owned.map((o) => o.path), ...entries.map((e) => e.path)] }
}
