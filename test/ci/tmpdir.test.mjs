// test/ci/tmpdir.test.mjs — the rule 「测试要临时目录一律 test/helpers/tmp.mjs 的 tmpDir()」 as a check: a hand-written
// mkdtemp(os.tmpdir()) escapes leak-guard.cjs's accounting. The files that still do are pinned in fixtures/mkdtemp-legacy.json and may only shrink:
// a new file with one is red, a pinned file that no longer has one must leave the list.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findIn } from '../helpers/code-text.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(mjs|cjs|js)$/.test(e.name) ? [path.join(d, e.name).split(path.sep).join('/')] : [])
const MKDTEMP_TMP = /\bmkdtemp(?:Sync)?\s*\(\s*(?:path\.join\s*\(\s*)?(?:os\.)?tmpdir\s*\(/g
const LEGACY = JSON.parse(fs.readFileSync(new URL('./fixtures/mkdtemp-legacy.json', import.meta.url), 'utf8'))
export const handMade = (files, read) => files.filter((f) => f !== 'test/helpers/tmp.mjs' && findIn(read(f), MKDTEMP_TMP, { strings: false }).length > 0)

test('tmpDir(): no test file outside the pinned legacy list makes its own mkdtemp(os.tmpdir()), and the list only shrinks', () => {
  const found = handMade(walk('test'), (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
  assert.deepEqual(found.filter((f) => !LEGACY.includes(f)), [], 'use tmpDir() from test/helpers/tmp.mjs')
  assert.deepEqual(LEGACY.filter((f) => !found.includes(f)), [], 'this file no longer makes its own: remove it from fixtures/mkdtemp-legacy.json')
})

test('tmpDir(): the scan goes red on a seeded hand-made temp dir, in each spelling, and not in a comment', () => {
  const seeded = { a: "const d = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))", b: "const d = await mkdtemp(join(tmpdir(), 'x'))\n", c: "fs.mkdtempSync(os.tmpdir() + '/x')", d: "// fs.mkdtempSync(os.tmpdir())\nconst d = tmpDir('x-')" }
  assert.deepEqual(handMade(Object.keys(seeded), (f) => seeded[f]), ['a', 'c'])
})
