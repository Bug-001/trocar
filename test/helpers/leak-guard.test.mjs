// test/helpers/leak-guard.test.mjs — the preload `npm test` runs under (test/helpers/leak-guard.cjs): a test run that leaves a
// temp directory behind fails, names it, and cleans it up; one that leaves nothing, or fails its tests without leaking, does not
// get blamed.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from './tmp.mjs'
import guard from './leak-guard.cjs'

const { leaked } = guard
const GUARD = fileURLToPath(new URL('./leak-guard.cjs', import.meta.url))
const TMP_HELPER = fileURLToPath(new URL('./tmp.mjs', import.meta.url))
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_OPTIONS

/** Runs `node --test --test-force-exit --require <guard>` on a generated test file, TMPDIR pointing at a scratch dir of its own. */
function run(body) {
  const scratch = tmpDir('trocar-guardtest-')
  const file = path.join(scratch, 'fixture.test.mjs')
  fs.writeFileSync(file, `import test from 'node:test'\nimport fs from 'node:fs'\nimport os from 'node:os'\nimport path from 'node:path'\nimport { tmpDir } from ${JSON.stringify(TMP_HELPER)}\n${body}\n`)
  const r = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-reporter=tap', '--require', GUARD, file], { env: { ...env, TMPDIR: scratch }, encoding: 'utf8', timeout: 60_000 })
  return { ...r, scratch, left: fs.readdirSync(scratch).filter((n) => n !== 'fixture.test.mjs') }
}

test('leak-guard: a test that leaves a directory behind fails the run, and the message names it and where it came from', () => {
  const r = run(`test('leaks', () => { fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-leaky-')) })`)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^# pass 1$/m, 'the leaking test itself passed — the guard is what fails the run')
  assert.match(r.stderr, /leak-guard: 1 temp entry made by this test run was not removed/)
  assert.match(r.stderr, /^ {2}trocar-leaky-[A-Za-z0-9]{6}\/$/m)
  assert.match(r.stderr, /grep -rn "'trocar-leaky-" test/)
  assert.deepEqual(r.left, [], 'the guard removed what it found, and its own run directory')
})

test('leak-guard: tmpDir() directories leave nothing, so a run that uses them passes — a failing test included', () => {
  const ok = run(`test('clean', () => { fs.writeFileSync(path.join(tmpDir('trocar-clean-'), 'f'), 'x') })`)
  assert.equal(ok.status, 0, ok.stderr)
  assert.doesNotMatch(ok.stderr, /leak-guard/)
  assert.deepEqual(ok.left, [])
  const failing = run(`test('fails', () => { tmpDir('trocar-failing-'); throw new Error('on purpose') })`)
  assert.equal(failing.status, 1)
  assert.doesNotMatch(failing.stderr, /leak-guard/, 'a failed test that cleans up is not a leak')
  assert.deepEqual(failing.left, [])
})

test('leak-guard: every test file process sees a TMPDIR inside the run\'s directory; a file nobody names is not blamed', () => {
  const r = run(`test('where', () => { fs.writeFileSync(path.join(os.tmpdir(), 'libfoo.so'), 'x'); process.stdout.write('TMPDIR=' + os.tmpdir() + '\\n') })`)
  assert.equal(r.status, 0, r.stderr)
  const seen = /^TMPDIR=(.*)$/m.exec(r.stdout)?.[1] ?? /TMPDIR=(\S+)/.exec(r.stdout)?.[1]
  assert.ok(seen && path.dirname(seen) === r.scratch && path.basename(seen).startsWith('trocar-run-'), `${seen} is a run directory under ${r.scratch}`)
  assert.deepEqual(r.left, [])
})

test('leak-guard: leaked() — directories and our prefixes count, a stray library file does not', () => {
  const dir = tmpDir('trocar-leakedtest-')
  fs.mkdirSync(path.join(dir, 'whatever'))
  fs.writeFileSync(path.join(dir, 'trocar-x'), '')
  fs.writeFileSync(path.join(dir, 'as-y'), '')
  fs.writeFileSync(path.join(dir, 'atrace-z'), '')
  fs.writeFileSync(path.join(dir, 'libduck.so'), '')
  assert.deepEqual(leaked(dir, fs.readdirSync(dir).sort()), ['as-y', 'trocar-x', 'atrace-z', 'whatever'])
  // an entry that went away between the listing and the check does not end the check (an exception there turned the guard off)
  assert.deepEqual(leaked(dir, ['gone-before-lstat', 'trocar-gone', 'whatever']), ['trocar-gone', 'whatever'])
})
