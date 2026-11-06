// test/ci/spec-paths.test.mjs — every file path the spec names resolves (0.1 §3). A unit that points at a file the tree no longer
// has sends an implementer to code that is gone, and a test it names as a guard guards nothing. A test the spec asks for that is not
// written yet is written 「待写 `test/…`」: planned, never mistaken for a guard; a file the spec requires to be gone is written 「已删 `…`」, and
// then it must NOT exist. The paths that did not resolve when this guard came are listed in spec-paths.debt, one `<unit> <path>` a line: a line
// whose path now resolves, or that its unit no longer names, is red; a new line is refused at review (only paths already there are debt).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SPEC = path.join(ROOT, 'spec/01-trocar-rfc')
const DEBT = fileURLToPath(new URL('./spec-paths.debt', import.meta.url))
// a repo path that names a file: one of the code and test directories, then path characters, then any file extension
const PATH = /(?<![\w./-])(?:test|src|web|scripts|bin)\/[\w./\-[\]]+\.\w+\b/g
const PLANNED = /待写\s*`$/, GONE = /已删\s*`$/
/** isFile(p) → p names a file of the tree with exactly this case (a case-insensitive disk would pass a path that fails on Linux). */
function isFile(p) {
  try { return fs.realpathSync.native(path.join(ROOT, p)).endsWith(path.sep + p.split('/').join(path.sep)) } catch { return false }
}

/** unresolved(text, exists) → the paths `text` names wrongly, each once: one that does not exist and is not marked planned, or one marked
 *  gone that exists (named `已删 <path>`). */
function unresolved(text, exists) {
  const out = new Set()
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(PATH)) {
      const p = m[0], before = line.slice(0, m.index)
      if (GONE.test(before)) { if (exists(p)) out.add(`已删 ${p}`); continue }
      if (exists(p)) continue
      if (p.startsWith('test/') && PLANNED.test(before)) continue
      out.add(p)
    }
  }
  return out
}

test('the rule: a missing path is named; 「待写」 passes a test path only; 「已删」 needs the file gone; a path that exists passes', () => {
  const have = new Set(['src/a.mjs', 'test/a.test.mjs', 'src/g.sql'])
  const exists = (p) => have.has(p)
  const text = ['`src/a.mjs` and `test/a.test.mjs`', 'guard: `test/b.test.mjs`', '待写 `test/c.test.mjs`', '待写 `src/d.mjs`',
    'nested trocar/src/e.mjs is not a repo path', '`web/legacy/core/f.mjs` twice: `web/legacy/core/f.mjs`',
    'any extension: `src/g.sql` and `scripts/h.sh`', '已删 `web/i.mjs` is gone; 已删 `src/a.mjs` is not'].join('\n')
  assert.deepEqual([...unresolved(text, exists)].sort(), ['scripts/h.sh', 'src/d.mjs', 'test/b.test.mjs', 'web/legacy/core/f.mjs', '已删 src/a.mjs'])
})

test('0.1 §3: every path the spec names resolves, is a planned test, or is listed debt; the debt list only shrinks', () => {
  const exists = isFile
  const found = new Set()
  for (const unit of fs.readdirSync(SPEC).filter((f) => f.endsWith('.md')).sort()) {
    for (const p of unresolved(fs.readFileSync(path.join(SPEC, unit), 'utf8'), exists)) found.add(`${unit} ${p}`)
  }
  const debt = new Set(fs.readFileSync(DEBT, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')))
  assert.deepEqual([...found].filter((x) => !debt.has(x)), [], 'a path the spec names does not resolve: point it at the file, write 「待写 `test/…`」 before a planned test, or drop the clause')
  assert.deepEqual([...debt].filter((x) => !found.has(x)), [], 'a debt line no longer applies (its path resolves, or its unit no longer names it): delete the line')
})
