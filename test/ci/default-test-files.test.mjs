// test/ci/default-test-files.test.mjs — `npm test` gives `node --test` no file list, so Node runs every file its default patterns match.
// A script outside test/ whose name matches runs inside the unit run: the browser suite's script, once named test-*.mjs, built the board
// there, and the npm and Vite it spawned left node-compile-cache/ in the run's temp dir (exit 1, 0 failures). Only files under test/ may match.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
// Node's default patterns (test runner docs, "Running tests from the command line"); .ts/.mts/.cts count once type stripping is on;
// case-blind: on the default macOS volume Node runs Test-a.mjs too (a stricter match only ever flags a name to change)
const EXT = String.raw`\.[cm]?[jt]s$`
const DEFAULT = [String.raw`[^/]*[.\-_]test${EXT}`, String.raw`test-[^/]*${EXT}`, `test${EXT}`, String.raw`test/.+${EXT}`].map((p) => new RegExp(`(^|/)${p}`, 'i'))
const runByDefault = (f) => DEFAULT.some((re) => re.test(f))
// node --test leaves node_modules out; dot directories (.git) hold no code
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
  e.name === 'node_modules' || e.name.startsWith('.') ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name).split(path.sep).join('/')])

test('npm test runs only files under test/: no file outside it matches node --test\'s default patterns', () => {
  assert.deepEqual(walk('').filter((f) => !f.startsWith('test/') && runByDefault(f)), [], 'rename it so no default pattern matches, or move it under test/')
})

test('the matcher takes the names node --test runs by default and no others (each case run through node --test on Node 22 and 26)', () => {
  const run = ['a.test.mjs', 'test.mjs', 'x/a-test.js', 'x/a_test.cjs', 'x/test-a.mjs', 'x/Test-a.mjs', 'x/test.ts', 'test/helpers/tmp.mjs', 'web/test/a/b.mts']
  const not = ['scripts/build-check.mjs', 'x/a.test.tsx', 'x/attest.mjs', 'x/contest-a.mjs', 'testing/a.mjs', 'x/test.json']
  assert.deepEqual(run.filter((f) => !runByDefault(f)), [])
  assert.deepEqual(not.filter(runByDefault), [])
})
