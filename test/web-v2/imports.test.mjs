// test/web-v2/imports.test.mjs — the board's module graph is closed: every relative specifier (import / export-from /
// import()) in src/web/v2/**/*.mjs resolves to a file inside src/web/v2 or to a shared module the static face serves (src/server.mjs SHARED, 4.4:13);
// every relative specifier in test/web-v2/**/*.mjs resolves to an existing file. The scanner is proven not vacuous.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHARED } from '../../src/server.mjs'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const V2 = path.join(REPO, 'src', 'web', 'v2')

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
    const contained = !inside || !path.relative(inside, target).startsWith('..') || SHARED.some((s) => 'src/' + s === rel)
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
  assert.deepEqual(unresolved(f, "import '../../off/token-header.mjs'", V2), [], 'a SHARED module is allowed')
  assert.equal(unresolved(f, "import '../../off/control-client.mjs'", V2).length, 1, 'a module outside SHARED is reported')
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

// 1.2 #24: index.html preloads, in one go, the static import closure of the boot (main.mjs) and of the replay desk, each module at the
// URL the page asks for it by (a shared module the static face serves sits outside the board's folder: /off/…)
test('index.html modulepreloads exactly the static import closure of main.mjs and replay/replay.mjs', () => {
  const page = 'http://board/', seen = new Map() // page URL → file
  const walk = (url, file) => {
    if (seen.has(url)) return
    seen.set(url, file)
    for (const m of fs.readFileSync(file, 'utf8').matchAll(SPEC)) {
      if (/\bimport\s*\(\s*['"`]$/.test(m[0].slice(0, -(m[2].length + 1)))) continue // import() loads on demand: not in the closure
      walk(new URL(m[2], url).href, path.resolve(path.dirname(file), m[2]))
    }
  }
  for (const entry of ['main.mjs', 'replay/replay.mjs']) walk(new URL(entry, page).href, path.join(V2, entry))
  assert.ok(seen.size > 2 && [...seen.keys()].some((u) => !u.startsWith(page + 'core/') && u.includes('/off/')), 'the walk reaches the graph and the shared module')
  const html = fs.readFileSync(path.join(V2, 'index.html'), 'utf8')
  const preload = [...html.matchAll(/<link\s+rel="modulepreload"\s+href="([^"]+)"/g)].map((m) => new URL(m[1], page).href)
  assert.deepEqual(preload.slice().sort(), [...seen.keys()].sort())
  assert.equal(new Set(preload).size, preload.length, 'each module once')
})
