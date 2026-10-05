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

