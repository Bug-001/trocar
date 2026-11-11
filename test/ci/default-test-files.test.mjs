// test/ci/default-test-files.test.mjs — `npm test` gives `node --test` no file list, so Node runs every file its default patterns match.
// A script outside test/ whose name matches runs inside the unit run: the browser suite's script, once named test-*.mjs, built the board
// there, and the npm and Vite it spawned left node-compile-cache/ in the run's temp dir (exit 1, 0 failures). Only files under test/ may match.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
// Node's default patterns (test runner docs, "Running tests from the command line"); .ts/.mts/.cts count once type stripping is on
const EXT = String.raw`\.[cm]?[jt]s$`
const DEFAULT = [String.raw`[^/]*[.\-_]test${EXT}`, String.raw`test-[^/]*${EXT}`, `test${EXT}`, String.raw`test/.+${EXT}`].map((p) => new RegExp(`(^|/)${p}`))
export const runByDefault = (f) => DEFAULT.some((re) => re.test(f))
// node --test leaves node_modules out; dot directories (.git) hold no code
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
  e.name === 'node_modules' || e.name.startsWith('.') ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name).split(path.sep).join('/')])

test('npm test runs only files under test/: no file outside it matches node --test\'s default patterns', () => {
  const outside = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'test').flatMap((e) =>
    e.name === 'node_modules' || e.name.startsWith('.') ? [] : walk(e.name))
  assert.deepEqual(outside.filter(runByDefault), [], 'rename it so no default pattern matches, or move it under test/')
})

test('the default patterns match what node --test runs, and nothing else', () => {
  const run = ['a.test.mjs', 'x/a-test.js', 'x/a_test.cjs', 'scripts/test-build.mjs', 'x/test.ts', 'test/helpers/tmp.mjs', 'web/test/a/b.mts']
  const not = ['scripts/build-check.mjs', 'x/a.test.tsx', 'x/attest.mjs', 'x/contest-a.mjs', 'testing/a.mjs', 'x/test.json']
  assert.deepEqual(run.filter((f) => !runByDefault(f)), [])
  assert.deepEqual(not.filter(runByDefault), [])
})
