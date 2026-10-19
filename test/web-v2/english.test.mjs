// test/web-v2/english.test.mjs — the board speaks English (D58①), carries no internal label (D58②) and uses one word per
// concept (1.5 §看板词表 "一个概念只用一个词"; the glossary of record lives beside the label code, src/web/v2/labels/glossary.md).
// Offenders are reported grouped by file: the translators work from that list.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripComments } from '../helpers/code-text.mjs'
import { views } from '../netenv/fixtures/write-scan.mjs'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const V2 = path.join(REPO, 'src', 'web', 'v2')
const GLOSSARY = path.join(V2, 'labels', 'glossary.md')
const TODO = 'the English pass'

const walk = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name)
  return e.isDirectory() ? walk(p, ext) : p.endsWith(ext) ? [p] : []
})
const rel = (p) => path.relative(REPO, p)
const report = (hits) => Object.entries(Object.groupBy(hits, (h) => h.file)).map(([f, hs]) => `${f}\n${hs.map((h) => `  ${h.line}: ${h.text}`).join('\n')}`).join('\n')
const lineHits = (file, text, re) => text.split('\n').flatMap((l, k) => [...l.matchAll(re)].map((m) => ({ file, line: k + 1, text: m[0] })))

// --- 1 · CJK (D58①) -------------------------------------------------------------------------------------------------------
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]+/g
const blankHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '))
const cssContent = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).split('\n')
  .map((l) => [...l.matchAll(/content\s*:\s*([^;}]*)/g)].map((m) => m[1]).join(' ')).join('\n')
const cjkIn = (file, src) => {
  const text = file.endsWith('.mjs') ? stripComments(src) : file.endsWith('.html') ? blankHtmlComments(src) : cssContent(src)
  return lineHits(rel(file), text, CJK)
}

test('CJK scanner: a planted CJK string literal is caught, a CJK comment is not', () => {
  const hits = cjkIn('x.mjs', "// 注释里的中文\nexport const A = '会话'\n/* 块注释 */\n")
  assert.deepEqual(hits.map((h) => [h.line, h.text]), [[2, '会话']])
})

test('no CJK in the board\'s code, html or css content (D58①)', { todo: TODO }, () => {
  const files = [...walk(V2, '.mjs'), path.join(V2, 'index.html'), ...walk(V2, '.css')]
  const hits = files.flatMap((f) => cjkIn(f, fs.readFileSync(f, 'utf8')))
  assert.equal(hits.length, 0, `CJK in user text:\n${report(hits)}`)
})

// --- 2 · internal labels (D58②) --------------------------------------------------------------------------------------------
const INTERNAL = [/§/, /\bD\d{2}\b/, /\bK-\d{2}\b/, /src\//, /\.mjs\b/, /undefined/]
const strings = (v, seen = new Set()) => {
  if (typeof v === 'string') return [v]
  if (!v || typeof v !== 'object' || seen.has(v)) return []
  seen.add(v)
  return Object.values(v).flatMap((x) => strings(x, seen))
}

test('label strings carry no section, decision or K number, source path or `undefined` (D58②)', { todo: TODO }, async () => {
  const hits = []
  for (const f of walk(path.join(V2, 'labels'), '.mjs')) {
    const mod = await import(pathToFileURL(f).href)
    for (const s of strings({ ...mod })) for (const re of INTERNAL) if (re.test(s)) hits.push({ file: rel(f), line: '-', text: `${re} in ${JSON.stringify(s)}` })
  }
  assert.equal(hits.length, 0, `internal labels:\n${report(hits)}`)
})

// --- 3 · one spelling per concept (1.5 §看板词表; glossary beside the label code) --------------------------------------------------
const glossary = () => {
  const md = fs.readFileSync(GLOSSARY, 'utf8')
  const at = md.indexOf('## 界面词表')
  if (at < 0) return []
  const end = md.indexOf('\n## ', at + 1)
  const sec = md.slice(at, end < 0 ? undefined : end)
  const rows = sec.split('\n').filter((l) => /^\|/.test(l)).slice(2) // header + separator
  return rows.map((l) => l.split('|').slice(1, -1).map((c) => c.trim())).map(([concept, en, no]) => ({
    concept, en, notUsed: (no || '').split(',').map((s) => s.replace(/`/g, '').trim()).filter(Boolean),
  }))
}
// the text inside string, template and regex literals (the comment-stripped code minus the code-only view)
const stringText = (src) => { const { nc, code } = views(src); return [...nc].map((c, i) => (c === code[i] ? (c === '\n' ? '\n' : ' ') : c)).join('') }
const wordRe = (w) => new RegExp(`(?<![\\p{L}\\p{N}_-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'giu')

test('glossary parses: every row has a concept and an English word', () => {
  const g = glossary()
  assert.ok(g.length > 0, 'no glossary table under "## 界面词表"')
  for (const r of g) assert.ok(r.concept && r.en, `incomplete row ${JSON.stringify(r)}`)
})

test('one-spelling scanner: a planted "not used" spelling is caught case-insensitively, a part of a word is not', () => {
  const src = "// Dashboard in a comment\nconst a = 'Open the Dashboard'\nconst b = 'dashboards-x'\n"
  assert.deepEqual(lineHits('x', stringText(src), wordRe('dashboard')).map((h) => [h.line, h.text]), [[2, 'Dashboard']])
})

test('the board\'s strings use no rejected spelling of a glossary concept (one concept, one word)', () => {
  const g = glossary()
  const hits = walk(V2, '.mjs').flatMap((f) => {
    const text = stringText(fs.readFileSync(f, 'utf8'))
    return g.flatMap((r) => r.notUsed.flatMap((w) => lineHits(rel(f), text, wordRe(w)).map((h) => ({ ...h, text: `${h.text} → use "${r.en}"` }))))
  })
  assert.equal(hits.length, 0, `rejected spellings:\n${report(hits)}`)
})
