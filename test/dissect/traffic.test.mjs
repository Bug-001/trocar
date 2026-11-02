// test/dissect/traffic.test.mjs — acceptance K1 (RFC 4.6 §记录「保存级别」, D40): the class patterns are DATA (the harness table and the
// class table), and the capture core names no harness and holds no host pattern (D20, 0.1 §5). The guard runs over the source text.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ── the guard: the capture core holds no harness name and no class pattern ─────────────────────────────────────────────
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// source text with the comments dropped; strings and regex literals stay (the same scanner idea as test/collector/layering.test.mjs)
function stripComments(src) {
  let out = '', i = 0, q = null
  const prevSig = () => { for (let j = out.length - 1; j >= 0; j--) if (!/\s/.test(out[j])) return out[j]; return '' }
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (q) { out += c; if (c === '\\') { out += n ?? ''; i += 2; continue } if (c === q) q = null; i++; continue }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue }
    if (c === '/' && (prevSig() === '' || '(,=:[!&|?{};'.includes(prevSig()) || /\b(return|typeof)$/.test(out.trimEnd()))) {
      let j = i + 1, cls = false
      while (j < src.length && src[j] !== '\n') { const d = src[j]; if (d === '\\') { j += 2; continue } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; j++ }
      out += src.slice(i, j + 1); i = j + 1; continue
    }
    out += c; i++
  }
  return out
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.mjs$/.test(e.name) ? [path.join(d, e.name)] : []))
const HARNESS_NAMES = /\b(claude|codex|opencode|kimi|dsh|deepseek|hermes|zcode|z-code)\b/i
// `\bsentry\b`, not the substring: D39's `rereadsEntry` (a harness flag of the process registry) holds 「sEntry」 and is no Sentry host
const CLASS_PATTERNS = /event_logging|worker\/events|file_upload|domain_info|\bsentry\b|statsig|datadog|downloads\.|\/v1\/code\/sessions/i
export function offenders(files, read = (f) => fs.readFileSync(f, 'utf8')) {
  return files.flatMap((f) => { const code = stripComments(read(f)); return [HARNESS_NAMES, CLASS_PATTERNS].flatMap((re) => (re.test(code) ? [`${path.relative(REPO, f)}: ${code.match(re)[0]}`] : [])) })
}

test('K1 guard: src/collector/core/** and the files that apply the keep level hold no harness name and no class pattern (D20, 0.1 §5)', () => {
  // mitm.mjs went with the old capture (D39⑥ executed 2026-10-11); retention.mjs / keep.mjs with the retention surface (T5),
  // and src/classes/source.mjs is where the level is applied now — its table is DATA (src/dissect), never a pattern of its own
  const capture = ['envelope.mjs', 'request-body.mjs'].map((n) => path.join(REPO, 'src', 'capture', n))
  const files = [...walk(path.join(REPO, 'src', 'collector', 'core')), ...capture, path.join(REPO, 'src', 'classes', 'source.mjs')]
  assert.ok(files.length > 30, 'the scan sees the tree')
  assert.deepEqual(offenders(files), [])
})

test('K1 guard can fail: a planted file with a harness name and a class pattern is caught', () => {
  const planted = { '/x/a.mjs': "const h = 'claude'\n", '/x/b.mjs': "const p = '/api/event_logging/'\n", '/x/c.mjs': "// claude and event_logging in a comment only\nconst ok = 1\n", '/x/d.mjs': "const h = 'o1.ingest.sentry.io'\n", '/x/e.mjs': 'const k = t.rereadsEntry\n' }
  assert.deepEqual(offenders(Object.keys(planted), (f) => planted[f]).map((s) => s.replace(/^.*?x\//, '')), ['a.mjs: claude', 'b.mjs: event_logging', 'd.mjs: sentry'], 'a Sentry host is caught; the word rereadsEntry is not one')
})
