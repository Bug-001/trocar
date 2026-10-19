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
import { parseDotenv } from '../config-read.mjs'

const get = (env, k) => (env instanceof Map ? env.get(k) : env ? env[k] : undefined)
const isSet = (v) => v !== undefined && v !== null && v !== ''
const absent = (e) => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')
const why = (e) => `${(e && e.code) || 'error'}: ${(e && e.message) || e}`
const pickOs = (x, ctx) => (x && x.perOs ? x.perOs[ctx.os] : x)

/** The absolute paths a <loc> names on this machine: one without `glob`, the matching entries with it; [] when it names nothing here. */
export function resolveLoc(loc, ctx) {
  const l = pickOs(loc, ctx)
  if (!l) return []
  const join = ctx.join || path.join
  const over = l.env ? get(ctx.env, l.env) : undefined
  const tilde = (v) => (/^~([\\/]|$)/.test(v) ? join(ctx.home, v.slice(2)) : v)
  const baseDir = { home: ctx.home, cwd: ctx.cwd, abs: '', appSupport: ctx.dirs && ctx.dirs.appSupport, localAppData: ctx.dirs && ctx.dirs.localAppData }[l.base]
  if (baseDir == null) return []
  const top = isSet(over) ? tilde(over) : l.dir ? join(baseDir, l.dir) : baseDir
  const at = l.path ? (top === '' ? l.path : join(top, l.path)) : top
  if (!l.glob) return [at]
  const re = new RegExp(`^${l.glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return ctx.readdir(at).filter((n) => re.test(n)).sort().map((n) => join(at, n))
}

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
    for (const m of walk(data, src.keys)) all.push({ value: m.value, where: `${f}#${m.keys.join('.')}` })
  }
  return all.length ? { set: true, value: all[0].value, where: all[0].where, all } : { set: false }
}

/** Whether a <cond> holds: true, false, or { error } (a source that cannot be read never counts as "does not hold"). */
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

/** The places of a form that are there now (its `present` places, a `{ command }` as the path it resolves to): which form a running process belongs to is
 *  read from them (1.6 §9.6: the restart steps come from the form the process belongs to). */
export function presentPaths(form, ctx) {
  return (form.present || []).flatMap((p) => {
    if (p && 'command' in p) { const at = ctx.which(p.command); return at ? [at] : [] }
    try { return resolveLoc(p, ctx).filter((f) => ctx.exists(f)) } catch { return [] }
  })
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
