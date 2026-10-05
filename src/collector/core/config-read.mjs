// config-read.mjs — tiny readers for the agents' own config files (RFC 4.6 §解密策略: relay hosts come
// from the agent's env AND its config files, D37). Zero dependencies (D18), so each parser covers only
// the subset the harness readers need. They read and never write; they never throw on input they do
// not understand — an unparsable file yields what could be read plus an error count, so a broken config
// degrades that agent to its known hosts (relay traffic passes through untouched) instead of crashing.
import fs from 'node:fs'
import path from 'node:path'

export function readText(file, { readFile = fs.readFileSync } = {}) {
  try { return readFile(file, 'utf8') } catch { return null }
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

// ── JSONC: strip // and /* */ comments and trailing commas outside strings, then JSON.parse ──
export function parseJsonc(text) {
  const s = String(text || '')
  let out = ''
  for (let i = 0, inStr = false; i < s.length; i++) {
    const c = s[i]
    if (inStr) { out += c; if (c === '\\') out += s[++i] ?? ''; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 1; continue }
    if (c === ',') { let j = i + 1; while (/\s/.test(s[j] || '')) j++; if (s[j] === '}' || s[j] === ']') continue }
    out += c
  }
  try { return { data: JSON.parse(out), errors: 0 } } catch { return { data: null, errors: 1 } }
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
