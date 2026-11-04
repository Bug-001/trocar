// test/helpers/imports.test.mjs — the closure walk's own guard: a planted tree whose imports, requires and URLs are known, so a walk
// that silently reports nothing (or everything) is red instead of green. The product consumer is doctor's no-package check.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from './tmp.mjs'
import { closure } from './imports.mjs'

test('closure: the files an entry reaches by import, require, new URL and a template path, comments excluded', () => {
  const root = tmpDir('trocar-closure-')
  const put = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  put('src/a.mjs', 'export const a = 1\n')
  put('lab/ok.mjs', "// import x from './nope.mjs'  (a comment)\nimport { a } from '../src/a.mjs'\nimport fs from 'node:fs'\nconst probe = new URL('./probe.mjs', import.meta.url)\nconst tmpl = new URL('./tmpl/', import.meta.url)\nexport const s = \"import y from './also-nope.mjs'\"\nexport { a, probe, tmpl, fs }\n")
  put('lab/probe.mjs', "const c = require('../c.cjs')\nmodule.exports = c\n")
  put('lab/tmpl/x.sh.tmpl', 'echo hi\n')
  put('c.cjs', "const os = require('os')\nmodule.exports = os\n")
  put('lab/jxa.mjs', "export const js = 'ObjC.import(\"AppKit\"); ObjC.import(\'Foundation\')'\nexport const run = (ObjC) => { ObjC.import('AppKit'); return reimport('x') }\n") // a member call named import is no module
  assert.deepEqual(closure(['lab/ok.mjs', 'lab/jxa.mjs'], { root }), { files: ['c.cjs', 'lab/jxa.mjs', 'lab/ok.mjs', 'lab/probe.mjs', 'lab/tmpl/x.sh.tmpl', 'src/a.mjs'], problems: [] })
})

test('closure: a missing file and a bare package are each reported, with the file that names them', () => {
  const root = tmpDir('trocar-closure-')
  const put = (rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  put('lab/ok.mjs', 'export const ok = 1\n')
  put('lab/bad.mjs', "import { ok } from './ok.mjs'\nimport gone from './gone.mjs'\nimport pad from 'left-pad'\nexport default [ok, gone, pad]\n")
  const bad = closure(['lab/bad.mjs'], { root })
  assert.deepEqual(bad.files, ['lab/bad.mjs', 'lab/ok.mjs'])
  assert.equal(bad.problems.length, 2, JSON.stringify(bad.problems))
  assert.ok(bad.problems.some((p) => /gone\.mjs/.test(p)) && bad.problems.some((p) => /"left-pad"/.test(p)), JSON.stringify(bad.problems))
})
