// config-read.mjs — tiny readers for the agents' own config files (RFC 4.6 §解密策略: relay hosts come
// from the agent's env AND its config files, D37). Zero dependencies (D18), so each parser covers only
// the subset the harness readers need. They read and never write; they never throw on input they do
// not understand — an unparsable file yields what could be read plus an error count, so a broken config
// degrades that agent to its known hosts (relay traffic passes through untouched) instead of crashing.
import fs from 'node:fs'
import path from 'node:path'
import { parseJsonText } from '../../off/json-text.mjs'

export function readText(file, { readFile = fs.readFileSync } = {}) {
  try { return readFile(file, 'utf8') } catch { return null }
}

// {text, error}: a missing file is {text: null, error: null}; one that is there but cannot be read (EACCES, EISDIR,
// EIO…) is {text: null, error: {code, message}} — "unreadable" is never folded into "absent" (D-9, D38).
const ABSENT = new Set(['ENOENT', 'ENOTDIR'])
export function readTextOrError(file, { readFile = fs.readFileSync } = {}) {
  try { return { text: readFile(file, 'utf8'), error: null } } catch (e) {
    return ABSENT.has(e && e.code) ? { text: null, error: null } : { text: null, error: { code: (e && e.code) || null, message: String((e && e.message) || e) } }
  }
}

export function hostOf(url) {
  if (typeof url !== 'string' || !url.trim()) return null
  try {
    const h = new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase()
    return h.replace(/^\[|\]$/g, '') || null
  } catch { return null }
}

export function expandHome(p, home) {
  return typeof p === 'string' && p.startsWith('~/') ? path.join(home, p.slice(2)) : p
}

export function dig(obj, dotted) {
  let cur = obj
  for (const k of dotted.split('.')) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[k] }
  return cur
}

// ── dotenv (Node util.parseEnv / python-dotenv subset): KEY=VALUE, `export `, quotes, # comments; later wins ──
export function parseDotenv(text) {
  const out = new Map()
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2]
    const dq = /^"((?:[^"\\]|\\.)*)"/.exec(v)
    const sq = /^'([^']*)'/.exec(v)
    if (dq) v = dq[1].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c))
    else if (sq) v = sq[1]
    else v = v.replace(/\s+#.*$/, '').trim()
    out.set(m[1], v)
  }
  return out
}

// ── TOML subset (Codex config.toml): [table] / [a."b.c"] headers, bare / quoted / dotted keys, string / number / bool
// values, inline tables. Arrays and multi-line strings are skipped (no reader needs them; their lines are never taken
// for keys). [[array-of-tables]] and lines it cannot read count in `errors` (a key under an unread header must not land
// in the table before it): a reader reports such a file, since a relay host set there stays unknown (review 4 #4).
function splitKey(s) {
  const parts = []
  for (const m of s.matchAll(/\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*(?:\.|$)/g)) parts.push(m[1].replace(/^["']|["']$/g, ''))
  return parts
}
function tomlScalar(v) {
  const s = v.trim()
  let m
  if ((m = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(s))) return m[1].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c))
  if ((m = /^'([^']*)'\s*(#.*)?$/.exec(s))) return m[1]
  if ((m = /^(true|false)\s*(#.*)?$/.exec(s))) return m[1] === 'true'
  if ((m = /^([+-]?\d[\d_]*(\.\d+)?)\s*(#.*)?$/.exec(s))) return Number(m[1].replace(/_/g, ''))
  return undefined
}
// Index just past the string that starts at s[i] (basic, literal or their triple-quoted forms); -1 while it is open.
function stringEnd(s, i) {
  const c = s[i]
  const q = s.startsWith(c.repeat(3), i) ? c.repeat(3) : c
  for (let j = i + q.length; j < s.length; j++) {
    if (s.startsWith(q, j)) return j + q.length
    if (c === '"' && s[j] === '\\') j++
  }
  return -1
}
// Index just past the bracket that closes s[0] ('[' or '{'), skipping strings and comments; -1 while it is still open.
function closeOf(s) {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"' || c === "'") { const e = stringEnd(s, i); if (e < 0) return -1; i = e - 1 } else if (c === '#') { const e = s.indexOf('\n', i); if (e < 0) return -1; i = e } else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') { if (--depth === 0) return i + 1 }
  }
  return -1
}
const SKIP = Symbol('skipped')
// The parts of an inline table's body between top-level commas; null when a string or bracket in it does not close.
function topLevelParts(body) {
  const parts = []
  let from = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    let e = null
    if (c === '"' || c === "'") e = stringEnd(body, i)
    else if (c === '[' || c === '{') { const k = closeOf(body.slice(i)); e = k < 0 ? -1 : i + k }
    if (e != null) { if (e < 0) return null; i = e - 1; continue }
    if (c === ',') { parts.push(body.slice(from, i)); from = i + 1 }
  }
  parts.push(body.slice(from))
  return parts
}
const KEY = /^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+|\s)+?)\s*=\s*([\s\S]*)$/
const descendInto = (base, keys) => { let o = base; for (const k of keys) o = o[k] = (o[k] && typeof o[k] === 'object') ? o[k] : {}; return o }
// A complete value: an inline table (object), an array or a multi-line string (SKIP), a scalar, or undefined.
function tomlValue(s) {
  const v = s.trim()
  if (v.startsWith('"""') || v.startsWith("'''")) return SKIP
  if (v.startsWith('[') || v.startsWith('{')) {
    const e = closeOf(v)
    if (e < 0 || !/^\s*(#.*)?$/.test(v.slice(e))) return undefined
    if (v[0] === '[') return SKIP
    const out = {}
    for (const part of topLevelParts(v.slice(1, e - 1)) || [null]) {
      if (part == null) return undefined
      if (!part.trim()) continue
      const kv = KEY.exec(part.trim())
      const val = kv ? tomlValue(kv[2]) : undefined
      if (val === undefined) return undefined
      if (val === SKIP) continue
      const keys = splitKey(kv[1])
      descendInto(out, keys.slice(0, -1))[keys[keys.length - 1]] = val
    }
    return out
  }
  return tomlScalar(v)
}
export function parseTomlLite(text) {
  const root = {}
  let cur = root
  let errors = 0
  const lines = String(text || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[[')) { errors++; cur = {}; continue } // array-of-tables: its keys are dropped
    const h = /^\[([^\]]+)\]\s*(#.*)?$/.exec(line)
    if (h) { cur = descendInto(root, splitKey(h[1])); continue }
    const kv = KEY.exec(line)
    if (!kv) { errors++; continue }
    let raw = kv[2]
    const t = raw.trim()
    // a value that goes on over the next lines: an array or inline table until its bracket closes, a multi-line string
    // until its closing quotes
    const ml = t.startsWith('"""') ? '"""' : t.startsWith("'''") ? "'''" : null
    if (ml) { if (t.indexOf(ml, 3) < 0) { while (i + 1 < lines.length && !lines[++i].includes(ml)); } continue }
    if (t.startsWith('[') || t.startsWith('{')) while (closeOf(raw.trim()) < 0 && i + 1 < lines.length) raw += '\n' + lines[++i]
    const v = tomlValue(raw)
    if (v === undefined) { errors++; continue }
    if (v === SKIP) continue
    const keys = splitKey(kv[1])
    descendInto(cur, keys.slice(0, -1))[keys[keys.length - 1]] = v
  }
  return { data: root, errors }
}

// ── JSONC: the one reading of a user's JSON (json-text.mjs parseJsonText, the writer's own: a mark, comments, trailing commas; 4.6「JSON 按 JSONC 读写」).
// No document (empty, blank, a mark, comments only) is { data: null, errors: 0 } — not a parse error; what the writer refuses is { data: null, errors: 1, error }.
export function parseJsonc(text) {
  try { return { data: parseJsonText(String(text ?? '')) ?? null, errors: 0 } } catch (e) { return { data: null, errors: 1, error: String((e && e.message) || e) } }
}

// The Node.js release an executable is, read from the file without running it (4.6 lab ⑤, G24): a node binary embeds
// its own download URL `…/download/release/vX.Y.Z/…` (process.release.sourceUrl). Streamed in 1 MiB chunks, cached per
// file identity (dev, inode, size, mtime). null when the file is unreadable or not a Node release build.
const NODE_RELEASE = Buffer.from('/download/release/v')
const versionCache = new Map()
export function nodeReleaseVersion(file, { fs: f = fs, chunk = 1 << 20 } = {}) {
  let st
  try { st = f.statSync(String(file).replace(/ \(deleted\)$/, '')) } catch { return null }
  const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`
  if (versionCache.has(key)) return versionCache.get(key)
  let found = null
  let fd = null
  try {
    fd = f.openSync(String(file).replace(/ \(deleted\)$/, ''), 'r')
    const buf = Buffer.alloc(chunk + 64)
    let carry = 0
    for (let pos = 0; pos < st.size && !found;) {
      const n = f.readSync(fd, buf, carry, chunk, pos)
      if (n <= 0) break
      pos += n
      const view = buf.subarray(0, carry + n)
      const i = view.indexOf(NODE_RELEASE)
      if (i >= 0) {
        const m = /^(\d+)\.(\d+)\.(\d+)\//.exec(view.subarray(i + NODE_RELEASE.length, i + NODE_RELEASE.length + 24).toString('latin1'))
        if (m) { found = `${m[1]}.${m[2]}.${m[3]}`; break }
      }
      carry = Math.min(64, view.length)
      view.copy(buf, 0, view.length - carry) // keep a tail so a marker cut by the chunk edge is still found
    }
  } catch { found = null } finally { if (fd != null) try { f.closeSync(fd) } catch { /* ignore */ } }
  versionCache.set(key, found)
  return found
}

// a.b.c ≥ x.y.z
export function versionAtLeast(v, min) {
  if (!v) return false
  const a = v.split('.').map(Number); const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) }
  return true
}
