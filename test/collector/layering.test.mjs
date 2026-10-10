// test/collector/layering.test.mjs — automatic guard for the collector's three-way split (RFC 4.6
// §结构: a new OS touches only arch/<os>/, a new harness touches only harness/) and the netenv half of
// 4.8 W39. Rules:
//   1. core/ never branches on process.platform (comments ignored)
//   2. core/ never names a harness (comments ignored; word boundaries, so "handshake" is not "dsh")
//   3. arch/ never imports harness/
//   4. harness/ never imports arch/ or core/engine/
//   5. core/ never imports arch/ or harness/; outside arch/ and harness/, only WIRING_ENTRY may import them
//   6. src/netenv/ never imports arch/ or harness/ (W39: the netenv side knows neither; core's plain
//      modules it may read — findings.mjs reads core/codes.mjs)
// The checker runs on the real tree AND on a planted tree with one violation per rule, so every run
// also proves the guard can still fail.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WIRING_ENTRY = 'src/collector/daemon.mjs' // the single file allowed to wire core + arch + harness
const HARNESS_NAMES = /\b(claude|codex|opencode|kimi|dsh|deepseek|hermes|zcode|z-code)\b/i

// Drop // and /* */ comments; keep strings, template literals and regex literals verbatim.
function stripComments(src) {
  let out = ''
  let i = 0
  let q = null
  const prevSig = () => { for (let j = out.length - 1; j >= 0; j--) if (!/\s/.test(out[j])) return out[j]; return '' }
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (q) {
      out += c
      if (c === '\\') { out += n ?? ''; i += 2; continue }
      if (c === q) q = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue }
    if (c === '/' && (prevSig() === '' || '(,=:[!&|?{};'.includes(prevSig()) || /\b(return|typeof)$/.test(out.trimEnd()))) {
      let j = i + 1
      let cls = false
      while (j < src.length && src[j] !== '\n') {
        const d = src[j]
        if (d === '\\') { j += 2; continue }
        if (d === '[') cls = true
        else if (d === ']') cls = false
        else if (d === '/' && !cls) break
        j++
      }
      out += src.slice(i, j + 1)
      i = j + 1
      continue
    }
    out += c
    i++
  }
  return out
}

function walk(dir) {
  let names
  try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return names.flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]))
}

// The import-clause gap excludes quotes so `import 'a'` is never paired with a later `from 'b'`.
const IMPORT_RE = /\b(?:import|export)\s[^;'"`]*?\bfrom\s*(['"])([^'"]+)\1|\bimport\s*\(\s*(['"])([^'"]+)\3\s*\)|\bimport\s+(['"])([^'"]+)\5/g

function importsOf(code, file, root) {
  const out = []
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[2] || m[4] || m[6]
    if (!spec || !spec.startsWith('.')) continue
    out.push(path.relative(root, path.resolve(path.dirname(file), spec)).split(path.sep).join('/'))
  }
  return out
}

function areaOf(rel) {
  const m = /^src\/collector\/(core|arch|harness)\//.exec(rel)
  if (m) return m[1]
  return rel.startsWith('src/netenv/') ? 'netenv' : 'other'
}

function checkLayering(root) {
  const bad = []
  const files = [...walk(path.join(root, 'src', 'collector')), ...walk(path.join(root, 'src', 'netenv'))].filter((f) => /\.(m|c)?js$/.test(f))
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join('/')
    const area = areaOf(rel)
    const code = stripComments(fs.readFileSync(file, 'utf8'))
    if (area === 'core') {
      if (/\bprocess\.platform\b/.test(code)) bad.push(`rule1 ${rel}`)
      const hit = HARNESS_NAMES.exec(code)
      if (hit) bad.push(`rule2 ${rel} (${hit[0]})`)
    }
    for (const target of importsOf(code, file, root)) {
      const t = areaOf(target)
      if (area === 'arch' && t === 'harness') bad.push(`rule3 ${rel} -> ${target}`)
      if (area === 'harness' && (t === 'arch' || target.startsWith('src/collector/core/engine/'))) bad.push(`rule4 ${rel} -> ${target}`)
      if (area === 'core' && (t === 'arch' || t === 'harness')) bad.push(`rule5 ${rel} -> ${target}`)
      if (area === 'other' && (t === 'arch' || t === 'harness') && rel !== WIRING_ENTRY) bad.push(`rule5 ${rel} -> ${target}`)
      if (area === 'netenv' && (t === 'arch' || t === 'harness')) bad.push(`rule6 ${rel} -> ${target}`)
    }
  }
  return bad.sort()
}

test('layering: the real tree has no violations, and the walk sees src/netenv (W39: not a tree the scan misses)', () => {
  assert.deepEqual(checkLayering(REPO), [])
  const netenv = walk(path.join(REPO, 'src', 'netenv')).filter((f) => /\.(m|c)?js$/.test(f)).map((f) => path.relative(REPO, f))
  assert.ok(netenv.length >= 10, `the netenv half is walked (${netenv.length} files)`)
})

test('collector layering: a planted tree trips every rule and ignores comments and "handshake"', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-layering-'))
  const put = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  try {
    put('src/collector/core/p.mjs', "export const linux = process.platform === 'linux'\n")
    put('src/collector/core/n.mjs', "export const who = 'codex'\n")
    put('src/collector/core/clean.mjs', "// claude codex dsh process.platform\nexport const handshake = /\\/\\/x/ /* hermes */\nexport const s = 'a // not a comment'\n")
    put('src/collector/arch/x/a.mjs', "import d from '../../harness/h.mjs'\nexport default d\n")
    put('src/collector/harness/h.mjs', "import { createEngine } from '../core/engine/engine.mjs'\nimport '../arch/x/a.mjs'\nexport default createEngine\n")
    put('src/collector/core/i.mjs', "export { default } from '../harness/h.mjs'\n")
    put('src/collector/other.mjs', "const m = await import('./arch/x/a.mjs')\nexport default m\n")
    put('src/collector/daemon.mjs', "import a from './arch/x/a.mjs'\nimport h from './harness/h.mjs'\nexport { a, h }\n")
    put('src/netenv/x.mjs', "import a from '../collector/arch/x/a.mjs'\nexport default a\n")
    assert.deepEqual(checkLayering(root), [
      'rule1 src/collector/core/p.mjs',
      'rule2 src/collector/core/n.mjs (codex)',
      'rule3 src/collector/arch/x/a.mjs -> src/collector/harness/h.mjs',
      'rule4 src/collector/harness/h.mjs -> src/collector/arch/x/a.mjs',
      'rule4 src/collector/harness/h.mjs -> src/collector/core/engine/engine.mjs',
      'rule5 src/collector/core/i.mjs -> src/collector/harness/h.mjs',
      'rule5 src/collector/other.mjs -> src/collector/arch/x/a.mjs',
      'rule6 src/netenv/x.mjs -> src/collector/arch/x/a.mjs',
    ])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
