// test/web-v2/imports.test.mjs — the board's module graph is closed: every relative specifier (import / export-from /
// import()) in src/web/v2/**/*.mjs resolves to a file inside src/web/v2 or to an allowlisted path the static face serves;
// every relative specifier in test/web-v2/**/*.mjs resolves to an existing file. The scanner is proven not vacuous.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const V2 = path.join(REPO, 'src', 'web', 'v2')
const ALLOW = ['src/cli/words.mjs'] // spec 4.4:13 static-face allowlist; PR 4b's B7 table replaces this const with an import

// a specifier counts only outside string literals: whole quoted strings before the keyword on its line are skipped over,
// so fixture text inside a string is not code while `'key': () => import('./x.mjs')` still is
const SPEC = /^(?:[^'"`\n]|'[^'\n]*'|"[^"\n]*"|`[^`\n]*`)*?(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])(\.{1,2}\/[^'"`]+)\1/gm
const mjsUnder = (dir) => fs.readdirSync(dir, { recursive: true }).filter((p) => p.endsWith('.mjs')).map((p) => path.join(dir, p))

// → the specifiers of `text` (a file at `file`) that do not resolve, or resolve outside `inside` and the allowlist
function unresolved(file, text, inside) {
  const bad = []
  for (const [, , spec] of text.matchAll(SPEC)) {
    const target = path.resolve(path.dirname(file), spec.split(/[?#]/)[0])
    const rel = path.relative(REPO, target).split(path.sep).join('/')
    const contained = !inside || !path.relative(inside, target).startsWith('..') || ALLOW.includes(rel)
    if (!fs.existsSync(target) || !fs.statSync(target).isFile() || !contained) bad.push(`${path.relative(REPO, file)}: ${spec}`)
  }
  return bad
}

test('the scanner is not vacuous: a planted unresolved or escaping specifier is reported, a good one is not', () => {
  const f = path.join(V2, 'main.mjs')
  assert.equal(unresolved(f, "import { x } from './core/no-such-file.mjs'", V2).length, 1)
  assert.equal(unresolved(f, "const m = await import('./nope/x.mjs')", V2).length, 1)
  assert.equal(unresolved(f, "  'k': () => import('./nope/y.mjs'),", V2).length, 1, 'a quoted key before import() does not hide it')
  assert.equal(unresolved(f, "export { y } from '../../server.mjs'", V2).length, 1, 'outside src/web/v2 and not allowlisted')
  assert.deepEqual(unresolved(f, "import { esc } from './core/fmt.mjs'", V2), [])
})

test('every relative specifier in src/web/v2 resolves inside src/web/v2 or to an allowlisted path', () => {
  const files = mjsUnder(V2)
  assert.ok(files.length, 'the walk reaches the tree')
  assert.deepEqual(files.flatMap((f) => unresolved(f, fs.readFileSync(f, 'utf8'), V2)), [])
})

test('every relative specifier in test/web-v2 resolves to an existing file', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  assert.deepEqual(mjsUnder(dir).flatMap((f) => unresolved(f, fs.readFileSync(f, 'utf8'), null)), [])
})
