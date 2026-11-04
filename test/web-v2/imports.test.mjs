// test/web-v2/imports.test.mjs — the board's import rule (0.1 §2, 4.4 §静态面): every relative specifier in web/**/*.{mjs,ts,tsx}
// resolves to a file inside web/, or to a src/ module whose whole import closure stays in src/ and imports no `node:*` (it is bundled
// into the build); a bare specifier in web/ names a devDependency (`node:*` only in the Node-side configs at the top of web/), and web/legacy/ has none (so core/first.mjs, the cold open's early
// read, has no framework in its closure, 1.2 #24); src/ never imports web/; every relative specifier in test/web-v2 resolves. The component
// tests under web/ (*.test.tsx, the files web/vitest.config.mjs collects, D75④) are never bundled, so they get only the test/web-v2 check.
// The scanner is proven not vacuous on a planted tree with one violation of each kind.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// a static import / export-from is a statement: it starts its line (the clause may span lines); an import() counts only outside string
// literals: whole quoted strings before it on its line are skipped over, so fixture text is not code while `'k': () => import('./x.mjs')` is
const STATIC = /^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1|^\s*import\s*(['"])([^'"\n]+)\3/gm
const DYNAMIC = /^(?:[^'"`\n]|'[^'\n]*'|"[^"\n]*"|`[^`\n]*`)*?\bimport\s*\(\s*(['"`])([^'"`\n]+)\1/gm
const specsOf = (file) => { const t = fs.readFileSync(file, 'utf8'); return [...t.matchAll(STATIC), ...t.matchAll(DYNAMIC)].map((m) => m[2] || m[4]) }
const codeUnder = (dir, skip = () => false) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }) : [])
  .filter((p) => /\.(mjs|ts|tsx)$/.test(p) && !skip(p.split(path.sep).join('/'))).map((p) => path.join(dir, p))
const inside = (dir, p) => !path.relative(dir, p).startsWith('..') && !path.isAbsolute(path.relative(dir, p))
const fileAt = (p) => ['', '.ts', '.tsx'].map((x) => p + x).find((c) => fs.existsSync(c) && fs.statSync(c).isFile())
const pkgOf = (spec) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')
const isTest = (p) => /\.test\.tsx$/.test(p) // web/vitest.config.mjs `include: ['web/**/*.test.tsx']`

/** → the import-rule violations of the tree at `root` (a repo: web/, src/, package.json), each `<file>: <specifier>`. */
function violations(root) {
  const web = path.join(root, 'web'), src = path.join(root, 'src'), legacy = path.join(web, 'legacy')
  const dev = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies || {}))
  const bad = [], closed = new Map() // src file → its closure is clean
  const say = (file, spec) => bad.push(`${path.relative(root, file).split(path.sep).join('/')}: ${spec}`)
  const srcClean = (file) => {
    if (closed.has(file)) return closed.get(file)
    closed.set(file, true) // a cycle is judged by its other edges
    const ok = specsOf(file).every((s) => {
      const t = s.startsWith('.') && fileAt(path.resolve(path.dirname(file), s.split(/[?#]/)[0]))
      return t && inside(src, t) && srcClean(t)
    })
    closed.set(file, ok)
    return ok
  }
  for (const f of codeUnder(web, (p) => p.startsWith('public/') || p.includes('node_modules/'))) {
    for (const s of specsOf(f)) {
      if (isTest(f)) { if (s.startsWith('.') && !fileAt(path.resolve(path.dirname(f), s.split(/[?#]/)[0]))) say(f, s); continue }
      if (!s.startsWith('.')) {
        if (inside(legacy, f) || !(s.startsWith('node:') ? path.dirname(f) === web : dev.has(pkgOf(s)))) say(f, s)
        continue
      }
      const t = fileAt(path.resolve(path.dirname(f), s.split(/[?#]/)[0]))
      if (!t || !(inside(web, t) || (inside(src, t) && srcClean(t)))) say(f, s)
    }
  }
  for (const f of codeUnder(src)) {
    for (const s of specsOf(f)) if (s.startsWith('.') && inside(web, path.resolve(path.dirname(f), s))) say(f, s)
  }
  return bad
}

test('the scanner is not vacuous: one planted violation of each kind is reported, the clean files are not', () => {
  const root = tmpDir('trocar-imports-')
  const put = (p, text) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), text) }
  put('package.json', JSON.stringify({ devDependencies: { react: '0', '@tanstack/react-query': '0' } }))
  put('src/view/pure.mjs', "import { a } from './pure2.mjs'\n")
  put('src/view/pure2.mjs', 'export const a = 1\n')
  put('src/view/nodeish.mjs', "import { b } from './deep.mjs'\n")
  put('src/view/deep.mjs', "import fs from 'node:fs'\n")
  put('src/view/escapes.mjs', "import '../../outside.mjs'\n")
  put('outside.mjs', '')
  put('src/cli/back.mjs', "import '../../web/legacy/ok.mjs'\n")
  put('web/legacy/ok.mjs', "import { a } from '../../src/view/pure.mjs'\nimport { c } from './core/c.mjs'\n  'k': () => import('./core/c.mjs'),\n")
  put('web/legacy/core/c.mjs', 'export const c = 1\n')
  put('web/legacy/bad.mjs', [
    "import { x } from './core/no-such-file.mjs'",
    "  'k': () => import('./nope/y.mjs'),",
    "import '../../outside.mjs'",
    "import { b } from '../../src/view/nodeish.mjs'",
    "import '../../src/view/escapes.mjs'",
    "import { useState } from 'react'",
  ].join('\n'))
  put('web/src/main.tsx', "import { useQuery } from '@tanstack/react-query'\nimport { a } from '../../src/view/pure.mjs'\nimport 'left-pad'\n")
  put('web/src/fixture.tsx', "import { w } from '../../test/web-v2/world.mjs'\n")
  put('web/src/main.test.tsx', "import { w } from '../../test/web-v2/world.mjs'\nimport fs from 'node:fs'\nimport './gone.mjs'\n")
  put('test/web-v2/world.mjs', "import { createHash } from 'node:crypto'\n")
  put('web/vite.config.mjs', "import { fileURLToPath } from 'node:url'\n")
  put('web/public/assets/x.mjs', "import 'not-scanned'\n")
  assert.deepEqual(violations(root).sort(), [
    'src/cli/back.mjs: ../../web/legacy/ok.mjs',
    'web/legacy/bad.mjs: ../../outside.mjs',
    'web/legacy/bad.mjs: ../../src/view/escapes.mjs',
    'web/legacy/bad.mjs: ../../src/view/nodeish.mjs',
    'web/legacy/bad.mjs: ./core/no-such-file.mjs',
    'web/legacy/bad.mjs: ./nope/y.mjs',
    'web/legacy/bad.mjs: react',
    'web/src/fixture.tsx: ../../test/web-v2/world.mjs',
    'web/src/main.test.tsx: ./gone.mjs',
    'web/src/main.tsx: left-pad',
  ])
})

test('the board, web/ and src/ keep the import rule', () => {
  assert.ok(codeUnder(path.join(REPO, 'web', 'legacy')).length > 10, 'the walk reaches the tree')
  assert.deepEqual(violations(REPO), [])
})

test('every relative specifier in test/web-v2 resolves to an existing file', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const bad = codeUnder(dir).flatMap((f) => specsOf(f).filter((s) => s.startsWith('.') && !fileAt(path.resolve(path.dirname(f), s.split(/[?#]/)[0])))
    .map((s) => `${path.relative(REPO, f)}: ${s}`))
  assert.deepEqual(bad, [])
})
