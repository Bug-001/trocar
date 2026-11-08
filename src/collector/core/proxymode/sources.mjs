// sources.mjs — the one reader of the places a harness descriptor's `proxyMode` points at (spec 4.11 §2.3, plan A.3). A descriptor holds data only; this
// module turns that data into paths and values. It knows no harness and no OS: everything that differs per machine comes in through `ctx`:
//   ctx = { os, home, cwd, env (object or Map: the user's environment, as the CLI hands it), dirs: { appSupport, localAppData },
//           readFile(p) → text (throws; ENOENT / ENOTDIR = absent), exists(p) → bool, readdir(p) → names (throws), join(...parts) (default path.join),
//           policy(spec) → { set, value, where } | { error } (the OS reader of managed config: plist / registry), which(command) → path | null }
// `appSupport` is the per-user roaming app-data folder (Electron's appData: ~/Library/Application Support, %APPDATA%); `localAppData` the per-user local one.
//
// <loc>  { base: 'home' | 'appSupport' | 'localAppData' | 'cwd' | 'abs', dir?, path?, env?, glob? } | { perOs: { <os>: <loc> } }
//        base + dir + path; `env` names a variable that, when set, replaces base + dir (CLAUDE_CONFIG_DIR, CODEX_HOME, HERMES_HOME; without `dir` it replaces
//        the base itself); `glob` matches entry names one level below that path ('*' = any run of characters). `perOs` picks ctx.os; a missing OS = no path.
// <src>  { env } | { file: <loc>, format: 'json' | 'jsonc' | 'yaml' | 'dotenv', keys } | { policy: { <os>: spec } } | [<src>, …]
//        '*' in keys matches any key or list index. A list is a precedence: the first source that is set answers (an error answers too: D38).
// <cond> { src, equals? } — without `equals`: "is set".
// A file that exists but cannot be read or parsed is { error }, never "unset" (D38).
import path from 'node:path'
import { parseJsonText } from '../../../off/json-text.mjs'
import { parseDotenv, expandHome } from '../config-read.mjs'
import { resolveLoc } from '../../../off/loc.mjs'
import { certBlocks } from '../../../off/pem.mjs'
import { pathKey } from '../../../off/fsutil.mjs'

const get = (env, k) => (env instanceof Map ? env.get(k) : env ? env[k] : undefined)
const isSet = (v) => v !== undefined && v !== null && v !== ''
const absent = (e) => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')
const why = (e) => `${(e && e.code) || 'error'}: ${(e && e.message) || e}`


// Compared as the OS compares paths (pathKey: no case on Windows and macOS), so another spelling of trocar's own file is still trocar's (4.11 rule U)
/** Is `file` under ~/.trocar? */
export const inTrocar = (file, home, os) => { const k = (p) => pathKey(p, { platform: os, realpath: null }); return k(path.resolve(home, file)).startsWith(`${k(path.join(home, '.trocar'))}/`) }

export { resolveLoc } // the one resolver, shared with the marker undo (src/off/loc.mjs)

/** Every value under a key path ('*' = any key or index): [{ keys, value }] for the set ones. */
function walk(data, keys, at = []) {
  if (!keys.length) return isSet(data) ? [{ keys: at, value: data }] : []
  if (!data || typeof data !== 'object') return []
  const [k, ...rest] = keys
  const ks = k === '*' ? Object.keys(data) : Object.prototype.hasOwnProperty.call(data, k) ? [k] : []
  return ks.flatMap((x) => walk(data[x], rest, [...at, x]))
}

const PARSE = {
  json: (t) => JSON.parse(t.replace(/^\uFEFF/, '')),
  jsonc: (t) => parseJsonText(t) ?? null,
  yaml: (t) => parseYaml(t),
  dotenv: (t) => Object.fromEntries(parseDotenv(t)),
}

// `expand: 'env'` (descriptor data): the program reads `${NAME}` in the value from its environment (`ctx.env`), as Hermes reads config.yaml. A reference
// to a name that is not set stays as written there, names no file, and the program falls back to its default trust: that value is not in effect here
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
/** Whether a value read under `expand: 'env'` names the environment (`${NAME}`): with that environment unread, its file is not known (D38). */
export const namesEnv = (value) => typeof value === 'string' && /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)
const expanded = (value, env) => {
  if (typeof value !== 'string') return value
  let unset = false
  const v = value.replace(REF, (m, k) => { const x = get(env, k); if (!isSet(x)) { unset = true; return m } return x })
  return unset ? undefined : v
}

/** A setting: { set: true, value, where, all: [{ value, where }] } | { set: false } | { error, where }. */
export function readSrc(src, ctx) {
  if (Array.isArray(src)) {
    for (const s of src) { const r = readSrc(s, ctx); if (r.error || r.set) return r }
    return { set: false }
  }
  if ('env' in src) {
    const v = get(ctx.env, src.env)
    return isSet(v) ? { set: true, value: v, where: `env:${src.env}`, all: [{ value: v, where: `env:${src.env}` }] } : { set: false }
  }
  if ('policy' in src) {
    const spec = src.policy && src.policy[ctx.os]
    return spec ? ctx.policy(spec) : { set: false }
  }
  let files
  try { files = resolveLoc(src.file, ctx) } catch (e) { if (!absent(e)) return { error: why(e), where: String(src.file.path || '') }; files = [] }
  const all = []
  for (const f of files) {
    let text
    try { text = ctx.readFile(f) } catch (e) { if (absent(e)) continue; return { error: why(e), where: f } }
    let data
    try { data = PARSE[src.format](String(text)) } catch (e) { return { error: `unparsable ${src.format}: ${(e && e.message) || e}`, where: f } }
    for (const m of walk(data, src.keys)) {
      const value = src.expand === 'env' ? expanded(m.value, ctx.env) : m.value
      if (value !== undefined) all.push({ value, where: `${f}#${m.keys.join('.')}` })
    }
  }
  return all.length ? { set: true, value: all[0].value, where: all[0].where, all } : { set: false }
}

/** Whether a <cond> holds: true, false, or { error } (a source that cannot be read never counts as "does not hold"). */
/** The files a harness's `userCertFiles` settings name now (every match of each, as fileOf reads them), read against `ctx` (rule U, 4.11 P4), in the
 *  descriptor's order → { files, replacing, unread }: `replacing` the files a `semantics: 'replace'` setting names; `unread` is the first setting that could not be read ({ error, where }), or one naming a relative path with no cwd, or null — such a setting names a file not known, never none (D38). */
export function userCertFilesOf(desc, ctx) {
  const srcs = (desc.proxyMode || {}).userCertFiles || [], rs = srcs.map((src) => readSrc(src, ctx))
  const named = rs.flatMap((r, i) => (r.set ? r.all : []).filter((x) => typeof x.value === 'string').map((x) => ({ where: x.where, file: fileOf(x.value, ctx), replace: srcs[i].semantics === 'replace' }))) // every match: one key may name a file per route
  const lost = named.find((x) => x.file == null)
  return { files: [...new Set(named.map((x) => x.file).filter(Boolean))], replacing: new Set(named.filter((x) => x.replace && x.file).map((x) => x.file)), unread: rs.find((r) => r.error) || (lost ? { error: 'names a relative path and the working directory is not known', where: lost.where } : null) }
}

const hex = (fp) => String(fp || '').replace(/:/g, '').toLowerCase()
/** Whether `file` holds the trocar root `fp256` in any certificate block, marked or not (P11 rule 4: the door and `status` read it this one way): no such
 *  file → false; throws when it cannot be read (D38). */
export function rootHeldIn(file, readFile, fp256) {
  try { return certBlocks(readFile(file)).some((b) => hex(b.fp) === hex(fp256)) } catch (e) { if (absent(e)) return false; throw e }
}

const isAbs = (p) => path.posix.isAbsolute(p) || path.win32.isAbsolute(p)
/** The file a setting's value names, one reading for install, status and the door (4.11 P4 rule U): a leading `~/` is the home, a relative path is
 *  under `cwd`; null when it is relative and `cwd` is not known (D38). */
export function fileOf(value, { home, cwd, join = path.join }) {
  const v = expandHome(String(value), home)
  return isAbs(v) ? v : cwd == null ? null : join(cwd, v)
}

export function holds(cond, ctx) {
  const r = readSrc(cond.src, ctx)
  if (r.error) return { error: r.error, where: r.where }
  if (!r.set) return false
  return !('equals' in cond) || r.value === cond.equals
}

/** Whether a form is installed: any of its `present` places exists, or a `{ command }` resolves through ctx.which. */
export function isPresent(form, ctx) {
  return (form.present || []).some((p) => {
    if (p && 'command' in p) return !!ctx.which(p.command)
    try { return resolveLoc(p, ctx).some((f) => ctx.exists(f)) } catch { return false }
  })
}

/** A form the user put out of scope on this OS (D56⑥). It counts as not on the machine, whatever `present` finds (4.11 §2.3, CM43). */
export const outOfScope = (form, os) => !!(form.verified && form.verified[os] && form.verified[os].reason === 'out-of-scope')

/** The forms of a harness that are on this machine, the one answer install, on, setup and status take. */
export const formsHere = (pm, os, ctx) => pm.forms.filter((f) => f.os.includes(os) && !outOfScope(f, os) && isPresent(f, ctx))

/** What `status` and `on` name as out of scope: of the harnesses with no covered form here, the out-of-scope forms that are present and say what they are (`scopeWhat`). */
export const scopeNamed = (harnesses, os, ctx) => harnesses.filter((d) => d.proxyMode).flatMap((d) => {
  const named = d.proxyMode.forms.filter((f) => f.scopeWhat && f.os.includes(os) && outOfScope(f, os) && isPresent(f, ctx))
  return named.length && !formsHere(d.proxyMode, os, ctx).length ? named.map((f) => ({ harness: d.name, form: f.id, what: f.scopeWhat })) : []
})

/** The places of a form that are there now (its `present` places, a `{ command }` as the path it resolves to): which form a running process belongs to is
 *  read from them (1.6 附录 B: the restart steps come from the form the process belongs to). */
export function presentPaths(form, ctx) {
  return (form.present || []).flatMap((p) => {
    if (p && 'command' in p) { const at = ctx.which(p.command); return at ? [at] : [] }
    try { return resolveLoc(p, ctx).filter((f) => ctx.exists(f)) } catch { return [] }
  })
}

/** The forms of a harness present on this machine (of ctx.os) that trocar does not capture, each with why and where (4.6 「不采的形态」) →
 *  [{ form, why, paths }]: the one reader every surface (install, on, status) asks, whatever the OS. Its source is the descriptor's `uncaptured` list. */
export function uncapturedOf(desc, ctx) {
  return (desc.uncaptured || []).filter((u) => u.os.includes(ctx.os)).map((u) => ({ form: u.form, why: u.why, paths: presentPaths(u, ctx) })).filter((u) => u.paths.length)
}

/** The API hosts the agent's own config names (descriptor `configHosts`, 4.11 §2.3): files only — cwd = home, no env, no argv — so every asker
 *  reads the same answer. → { hosts: [lowercase, once each], errors: [text] }; a file there but unreadable or unparsable is an error (D38), never "none". */
export function configuredHosts(desc, { home, os, readFile, readdir }) {
  const errors = []
  const readText = (p) => { try { return readFile(p) } catch (e) { if (!absent(e)) errors.push(`${p}: ${(e && e.code) || e}`); return null } }
  const listDir = (p) => { try { return readdir(p) } catch { return [] } }
  let found = []
  try {
    found = (desc.configHosts && desc.configHosts({ home, os, cwd: home, argv: [], env: new Map(), environ: new Map(), readText, listDir, mtimeOf: () => null, unparsable: (f) => errors.push(`${f}: unparsable`) })) || []
  } catch (e) { errors.push(String((e && e.message) || e)) }
  return { hosts: [...new Set(found.filter(Boolean).map((h) => String(h).toLowerCase()))], errors }
}

// The smallest YAML reader for the key paths descriptors declare: block maps and lists (of scalars or of maps), one-line flow
// collections, plain / single- / double-quoted scalars kept as strings, comments, one leading `---`. Anything else (multi-line flow, block scalars, anchors, tags, tabs in indentation) throws,
// so readSrc reports { error } rather than guessing.
function parseYaml(text) {
  const lines = []
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const s = stripComment(raw)
    if (s.trim() === '') continue
    if (/^---\s*$/.test(s) && !lines.length) continue
    const lead = /^[ \t]*/.exec(s)[0]
    if (lead.includes('\t')) throw new Error('tab in indentation')
    lines.push({ ind: lead.length, text: s.trim() })
  }
  let i = 0
  const item = (t) => t === '-' || t.startsWith('- ')
  const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\-?:,[\]{}&*!|>%@`][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/
  const scalar = (v) => {
    if (/^"/.test(v)) { if (!/^"(?:[^"\\]|\\.)*"$/.test(v)) throw new Error(`bad scalar ${v}`); return JSON.parse(v) }
    if (/^'/.test(v)) { if (!/^'(?:[^']|'')*'$/.test(v)) throw new Error(`bad scalar ${v}`); return v.slice(1, -1).replace(/''/g, "'") }
    if (/^[[{]/.test(v)) return flow(v)
    if (/^[|>&*!%@`]/.test(v)) throw new Error(`unsupported YAML: ${v}`)
    return v
  }
  const key = (k) => (/^["']/.test(k) ? scalar(k) : k)
  function block(ind) { return item(lines[i].text) ? list(ind) : map(ind) }
  function map(ind) {
    const out = {}
    while (i < lines.length && lines[i].ind === ind && !item(lines[i].text)) {
      const m = KEY.exec(lines[i].text)
      if (!m) throw new Error(`not a key: ${lines[i].text}`)
      i++
      if (m[2] !== undefined && m[2] !== '') out[key(m[1])] = scalar(m[2])
      else if (i < lines.length && (lines[i].ind > ind || (lines[i].ind === ind && item(lines[i].text)))) out[key(m[1])] = block(lines[i].ind)
      else out[key(m[1])] = null
    }
    if (i < lines.length && lines[i].ind > ind) throw new Error(`bad indentation: ${lines[i].text}`)
    return out
  }
  function list(ind) {
    const out = []
    while (i < lines.length && lines[i].ind === ind && item(lines[i].text)) {
      const rest = lines[i].text.replace(/^-\s*/, '')
      if (rest === '') { i++; out.push(i < lines.length && lines[i].ind > ind ? block(lines[i].ind) : null); continue }
      if (KEY.test(rest)) { lines[i] = { ind: ind + lines[i].text.length - rest.length, text: rest }; out.push(map(lines[i].ind)); continue }
      out.push(scalar(rest)); i++
    }
    if (i < lines.length && lines[i].ind > ind) throw new Error(`bad indentation: ${lines[i].text}`)
    return out
  }
  if (!lines.length) return null
  const doc = block(lines[0].ind)
  if (i < lines.length) throw new Error(`bad indentation: ${lines[i].text}`)
  return doc
}

/** A one-line flow collection: `[a, 'b', {k: v}]` / `{k: [x]}` of plain or quoted scalars; anchors, tags, aliases and a trailing rest throw. */
function flow(v) {
  let k = 0
  const ws = () => { while (v[k] === ' ') k++ }
  const quoted = () => {
    const m = (v[k] === '"' ? /^"(?:[^"\\]|\\.)*"/ : /^'(?:[^']|'')*'/).exec(v.slice(k))
    if (!m) throw new Error(`bad scalar ${v}`)
    k += m[0].length
    return v[k - m[0].length] === '"' ? JSON.parse(m[0]) : m[0].slice(1, -1).replace(/''/g, "'")
  }
  const plain = (stop) => {
    const m = stop.exec(v.slice(k))
    const t = m ? m[0].trim() : ''
    if (t === '' || /^[&*!|>%@`]/.test(t)) throw new Error(`unsupported YAML: ${v}`)
    k += m[0].length
    return t
  }
  const node = (stop) => {
    ws()
    if (v[k] === '[' || v[k] === '{') return coll()
    return v[k] === '"' || v[k] === "'" ? quoted() : plain(stop)
  }
  function coll() {
    const close = v[k] === '[' ? ']' : '}'
    const out = close === ']' ? [] : {}
    k++; ws()
    if (v[k] === close) { k++; return out }
    for (;;) {
      if (close === ']') out.push(node(/^[^,\]]*/))
      else {
        const key = node(/^[^,:}]*?(?=:(?:\s|[,}]|$))/)
        ws()
        if (v[k++] !== ':') throw new Error(`not a key: ${v}`)
        out[key] = node(/^[^,}]*/)
      }
      ws()
      if (v[k] === ',') { k++; continue }
      if (v[k++] === close) return out
      throw new Error(`unsupported YAML: ${v}`)
    }
  }
  const out = coll()
  if (v.slice(k).trim() !== '') throw new Error(`unsupported YAML: ${v}`)
  return out
}

/** A line without its comment: '#' at the start or after whitespace, outside quotes. */
function stripComment(line) {
  let q = null
  for (let k = 0; k < line.length; k++) {
    const c = line[k]
    if (q) { if (c === '\\' && q === '"') k++; else if (c === q) q = null; continue }
    if ((c === '"' || c === "'") && (k === 0 || /[\s:\-[{,]/.test(line[k - 1]))) q = c
    else if (c === '#' && (k === 0 || /\s/.test(line[k - 1]))) return line.slice(0, k)
  }
  return line
}
