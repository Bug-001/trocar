// test/ci/spec-paths.test.mjs — every file path the spec names resolves (0.1 §3). A unit that points at a file the tree no longer
// has sends an implementer to code that is gone, and a test it names as a guard guards nothing. A test the spec asks for that is not
// written yet is written 「待写 `test/…`」: planned, never mistaken for a guard. The paths that do not resolve today are listed in
// spec-paths.debt, one `<unit> <path>` a line; the list only shrinks: a line whose path now resolves, or that its unit no longer names, is red.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SPEC = path.join(ROOT, 'spec/01-trocar-rfc')
const DEBT = fileURLToPath(new URL('./spec-paths.debt', import.meta.url))
// a repo path that names a file: one of the tree's top directories, then path characters, then a file extension
const PATH = /(?<![\w./-])(?:test|src|web|scripts|bin)\/[\w./\-[\]]+\.(?:m?js|cjs|tsx?|css|html|json)\b/g
const PLANNED = /待写\s*`$/

/** unresolved(text, exists) → the paths `text` names that `exists` does not find and that are not marked planned, each once. */
function unresolved(text, exists) {
  const out = new Set()
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(PATH)) {
      const p = m[0]
      if (exists(p)) continue
      if (p.startsWith('test/') && PLANNED.test(line.slice(0, m.index))) continue
      out.add(p)
    }
  }
  return out
}

test('the rule: a missing path is named; 「待写」 passes a test path only; a path that exists passes', () => {
  const have = new Set(['src/a.mjs', 'test/a.test.mjs'])
  const exists = (p) => have.has(p)
  const text = ['`src/a.mjs` and `test/a.test.mjs`', 'guard: `test/b.test.mjs`', '待写 `test/c.test.mjs`', '待写 `src/d.mjs`',
    'nested trocar/src/e.mjs is not a repo path', '`web/legacy/core/f.mjs` twice: `web/legacy/core/f.mjs`'].join('\n')
  assert.deepEqual([...unresolved(text, exists)].sort(), ['src/d.mjs', 'test/b.test.mjs', 'web/legacy/core/f.mjs'])
})

test('0.1 §3: every path the spec names resolves, is a planned test, or is listed debt; the debt list only shrinks', () => {
  const exists = (p) => fs.existsSync(path.join(ROOT, p))
  const found = new Set()
  for (const unit of fs.readdirSync(SPEC).filter((f) => f.endsWith('.md')).sort()) {
    for (const p of unresolved(fs.readFileSync(path.join(SPEC, unit), 'utf8'), exists)) found.add(`${unit} ${p}`)
  }
  const debt = new Set(fs.readFileSync(DEBT, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')))
  assert.deepEqual([...found].filter((x) => !debt.has(x)), [], 'a path the spec names does not resolve: point it at the file, write 「待写 `test/…`」 before a planned test, or drop the clause')
  assert.deepEqual([...debt].filter((x) => !found.has(x)), [], 'a debt line no longer applies (its path resolves, or its unit no longer names it): delete the line')
})
