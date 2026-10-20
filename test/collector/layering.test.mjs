// test/collector/layering.test.mjs — automatic guard for the collector's three-way split (RFC 4.6
// §结构: a new OS touches only arch/<os>/, a new harness touches only harness/) and the netenv half of
// 4.8 W39. Rules:
//   1. core/ never branches on process.platform (comments ignored)
//   2. core/ never names a harness (comments ignored; word boundaries, so "handshake" is not "dsh")
//   3. arch/ never imports harness/
//   4. harness/ never imports arch/ or core/engine/
//   5. core/ never imports arch/ or harness/; outside arch/ and harness/, only the ENTRIES may import them
//      (daemon.mjs wires them; net-deps.mjs is the small read-only arch-facing entry a CLI read command uses, W39)
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
import { stripComments, specsOf } from '../helpers/imports.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ENTRIES = ['src/collector/daemon.mjs', 'src/collector/net-deps.mjs'] // daemon.mjs wires core + arch + harness; net-deps.mjs only READS the
// two values a read-only CLI command needs of them (the descriptors, the platform's netFacts) — so `status` does not load the daemon's graph (D62)
const HARNESS_NAMES = /\b(claude|codex|opencode|kimi|dsh|deepseek|hermes|zcode|z-code)\b/i

function walk(dir) {
  let names
  try { names = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return names.flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]))
}

function importsOf(code, file, root) {
  return specsOf(code).filter((spec) => spec.startsWith('.')).map((spec) => path.relative(root, path.resolve(path.dirname(file), spec)).split(path.sep).join('/'))
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
    const text = fs.readFileSync(file, 'utf8')
    const code = stripComments(text)
    if (area === 'core') {
      if (/\bprocess\.platform\b/.test(code)) bad.push(`rule1 ${rel}`)
      const hit = HARNESS_NAMES.exec(code)
      if (hit) bad.push(`rule2 ${rel} (${hit[0]})`)
    }
    for (const target of importsOf(text, file, root)) {
      const t = areaOf(target)
      if (area === 'arch' && t === 'harness') bad.push(`rule3 ${rel} -> ${target}`)
      if (area === 'harness' && (t === 'arch' || target.startsWith('src/collector/core/engine/'))) bad.push(`rule4 ${rel} -> ${target}`)
      if (area === 'core' && (t === 'arch' || t === 'harness')) bad.push(`rule5 ${rel} -> ${target}`)
      if (area === 'other' && (t === 'arch' || t === 'harness') && !ENTRIES.includes(rel)) bad.push(`rule5 ${rel} -> ${target}`)
      if (area === 'netenv' && (t === 'arch' || t === 'harness')) bad.push(`rule6 ${rel} -> ${target}`)
    }
  }
  return bad.sort()
}

test('layering: the real tree has no violations, and the walk sees src/netenv (W39: not a tree the scan misses)', () => {
  assert.deepEqual(checkLayering(REPO), [])
  const netenv = walk(path.join(REPO, 'src', 'netenv')).filter((f) => /\.(m|c)?js$/.test(f)).map((f) => path.relative(REPO, f))
  assert.ok(netenv.length >= 10, `the netenv half is walked (${netenv.length} files)`)
  // W39: `netFactsDeps` is defined once, in the small arch-facing entry, and re-exported by the wiring one — a `status` that imported
  // daemon.mjs for it loaded the engine, the TLS issuer, the record store and the seal queue with it (89 ms on the Windows test machine; D62)
  const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8')
  assert.match(read('src', 'collector', 'daemon.mjs'), /export \{ netFactsDeps \} from '\.\/net-deps\.mjs'/)
  assert.match(read('src', 'collector', 'net-deps.mjs'), /export async function netFactsDeps/)
  const statusSrc = read('src', 'cli', 'status.mjs')
  assert.match(statusSrc, /import\('\.\.\/collector\/net-deps\.mjs'\)/, '`status` reaches the descriptors and the platform\'s netFacts through the small entry')
  for (const m of statusSrc.matchAll(/import\('\.\.\/collector\/daemon\.mjs'\)/g)) {
    const line = statusSrc.slice(0, m.index).split('\n').length
    assert.match(statusSrc.split('\n').slice(line - 6, line).join('\n'), /linux/, `status.mjs:${line} still loads the daemon's whole graph outside the Linux linger read`)
  }
})

test('collector layering: a planted tree trips every rule and ignores comments and "handshake"', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-layering-'))
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
    put('src/collector/net-deps.mjs', "import a from './arch/x/a.mjs'\nimport h from './harness/h.mjs'\nexport { a, h }\n") // the second entry: no violation
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
