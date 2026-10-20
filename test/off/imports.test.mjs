// test/off/imports.test.mjs — 0.1 §2 / 1.6 R3 / V11 (the source half): every file in src/off/ imports only `node:*` and files of src/off/
// itself (`./x.mjs`), so the single-file `~/.trocar/bin/trocar-off` can be made of that directory alone and runs without the repo or
// node_modules. The scan reads import / export-from clauses and `import()` calls; it is proven to fail on a planted bad file (a scan that
// cannot fail checks nothing, 0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { stripComments, specsOf, OPAQUE } from '../helpers/imports.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** The problems with the files directly in `<root>/src/off`: one line each, `<file>: <why>`. Empty = fine. */
function offImportProblems(root) {
  const dir = path.join(root, 'src', 'off')
  const problems = []
  const names = fs.readdirSync(dir).filter((n) => /\.(m|c)?js$/.test(n)).sort()
  for (const name of names) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8')
    for (const spec of specsOf(text)) {
      if (spec.startsWith('node:')) continue
      if (/^\.\/[A-Za-z0-9_.-]+\.mjs$/.test(spec)) { if (!names.includes(spec.slice(2))) problems.push(`${name}: ${spec} is not a file of src/off`); continue }
      problems.push(`${name}: imports ${JSON.stringify(spec)}; src/off may import only node:* and ./x.mjs`)
    }
    if (OPAQUE.test(stripComments(text))) problems.push(`${name}: a dynamic import or a require the scan cannot read`)
  }
  return problems
}

test('0.1 §2: every file in src/off imports only node:* or a file of src/off', () => {
  assert.ok(fs.readdirSync(path.join(REPO, 'src', 'off')).filter((n) => n.endsWith('.mjs')).length >= 8, 'the scan sees the directory (a wrong path would pass on zero files)')
  assert.deepEqual(offImportProblems(REPO), [])
})

test('0.1 §2: the scan fails on a planted bad import of every shape, and ignores comments and a string that only mentions an import', () => {
  const root = tmpDir('trocar-offimp-'); fs.mkdirSync(path.join(root, 'src', 'off'), { recursive: true })
  const put = (n, t) => fs.writeFileSync(path.join(root, 'src', 'off', n), t)
  put('good.mjs', "// import x from '../paths.mjs'  (a comment)\nimport fs from 'node:fs'\nimport { b } from './b.mjs'\nexport const s = \"import y from '../collector/x.mjs'\"\nexport { b }\n")
  put('b.mjs', "import path from 'node:path'\nexport const b = path.sep\n")
  assert.deepEqual(offImportProblems(root), [], 'the planted tree is clean before the bad files go in')
  put('up.mjs', "import { trocarHome } from '../paths.mjs'\nexport default trocarHome\n")
  put('bare.mjs', "import fs from 'fs'\nexport default fs\n") // a builtin without the node: prefix is a package name to a bundler and to 0.1 §2
  put('pkg.mjs', "import x from 'left-pad'\nexport default x\n")
  put('reexport.mjs', "export * from '../cli/schema.mjs'\n")
  put('sideeffect.mjs', "import '../collector/daemon.mjs'\n")
  put('dyn.mjs', "export const load = () => import('../collector/x.mjs')\n")
  put('dynexpr.mjs', "export const load = (p) => import(p)\n")
  put('req.mjs', "import { createRequire } from 'node:module'\nexport const r = createRequire(import.meta.url)('../x')\n")
  put('sub.mjs', "import x from './sub/dir.mjs'\nexport default x\n")
  put('missing.mjs', "import x from './nope.mjs'\nexport default x\n")
  const got = offImportProblems(root)
  for (const f of ['up', 'bare', 'pkg', 'reexport', 'sideeffect', 'dyn', 'dynexpr', 'req', 'sub', 'missing']) assert.ok(got.some((p) => p.startsWith(`${f}.mjs:`)), `${f}.mjs is reported: ${JSON.stringify(got)}`)
  assert.ok(!got.some((p) => p.startsWith('good.mjs') || p.startsWith('b.mjs')), 'the clean files are not')
})

// The standalone trocar-off is these files concatenated (plan Task 8), so a top-level name declared in two of them would be one declaration
// twice. Checked from the start, so a file added later cannot collide with a name an earlier task already took. Column-0 declarations only
// (how every file here is written); a `const { a, b } = …` at the top level is refused so the check cannot be sidestepped by it.
const DECL_RE = /^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm
const DESTRUCTURED_RE = /^(?:export\s+)?(?:const|let|var)\s*[{[]/m
function duplicateTopLevelNames(root) {
  const dir = path.join(root, 'src', 'off')
  const where = new Map(); const out = []
  for (const name of fs.readdirSync(dir).filter((n) => /\.(m|c)?js$/.test(n)).sort()) {
    const code = stripComments(fs.readFileSync(path.join(dir, name), 'utf8'))
    if (DESTRUCTURED_RE.test(code)) out.push(`${name}: a top-level destructuring declaration; write one const per name`)
    for (const m of code.matchAll(DECL_RE)) {
      if (where.has(m[1]) && where.get(m[1]) !== name) out.push(`${m[1]}: declared in ${where.get(m[1])} and ${name}`)
      else where.set(m[1], name)
    }
  }
  return out
}

test('plan Task 8: top-level names are unique across src/off (the standalone copy is the files concatenated); the check fails on a planted duplicate', () => {
  assert.deepEqual(duplicateTopLevelNames(REPO), [])
  const root = tmpDir('trocar-offdup-'); fs.mkdirSync(path.join(root, 'src', 'off'), { recursive: true })
  const put = (n, t) => fs.writeFileSync(path.join(root, 'src', 'off', n), t)
  put('a.mjs', "export const same = 1\nexport function only() {}\n")
  put('b.mjs', "const same = 2\nexport default same\n")
  put('c.mjs', "export const { x, y } = { x: 1, y: 2 }\n")
  assert.deepEqual(duplicateTopLevelNames(root), ['same: declared in a.mjs and b.mjs', 'c.mjs: a top-level destructuring declaration; write one const per name'])
})
