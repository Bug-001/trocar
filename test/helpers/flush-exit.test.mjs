// test/helpers/flush-exit.test.mjs — the preload `npm test` runs under (test/helpers/flush-exit.mjs): a test file's forced exit
// waits for the reporter output to reach the runner, so every test it ran is counted.
//
// Without the preload, a file of 300 chatty sync tests reported 295 to 298 of them on every one of 25 Node 20 runs and 294 to
// 299 on 8 of 25 Node 22 runs. These tests spawn their own `node --test` the way `npm test` does, so Node 20 is where a
// regression shows on the first run; Node 22 shows it on about one run in three, hence several runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PRELOAD = fileURLToPath(new URL('./flush-exit.mjs', import.meta.url))

// the outer runner's NODE_TEST_CONTEXT would make the inner `node --test` act as one of its files
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
delete env.NODE_OPTIONS

function fixtureDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-flush-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Runs `node --test --test-force-exit --import <preload>` on a generated test file; returns the TAP counts. */
function run(dir, body) {
  const file = path.join(dir, 'fixture.test.mjs')
  fs.writeFileSync(file, `import test from 'node:test'\n${body}\n`)
  const args = ['--test', '--test-force-exit', '--test-reporter=tap', '--import', PRELOAD, file]
  const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 << 20 })
  const n = (key) => Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(r.stdout)?.[1])
  return { status: r.status, tests: n('tests'), pass: n('pass'), fail: n('fail'), stdout: r.stdout, stderr: r.stderr }
}

const CHATTY = 300
const chatty = `for (let i = 0; i < ${CHATTY}; i++) test('t' + i + ' ' + 'x'.repeat(2000), () => {})`

test('flush-exit: 300 chatty sync tests in one file are all counted, run after run', (t) => {
  const dir = fixtureDir(t)
  for (let i = 0; i < 4; i++) {
    const r = run(dir, chatty)
    assert.deepEqual([r.status, r.tests, r.pass, r.fail], [0, CHATTY, CHATTY, 0], `run ${i + 1}: ${r.stdout.slice(-300)}`)
  }
})

test('flush-exit: a failing test still fails the run (the exit code survives the deferred exit) and is counted', (t) => {
  const dir = fixtureDir(t)
  const r = run(dir, `${chatty}\ntest('this one fails', () => { throw new Error('on purpose') })`)
  assert.equal(r.status, 1)
  assert.deepEqual([r.tests, r.pass, r.fail], [CHATTY + 1, CHATTY, 1])
})

test('flush-exit: a process.exit() that is not the test runner\'s is immediate, as before — nothing after it runs', () => {
  const r = spawnSync(process.execPath, ['--import', PRELOAD, '-e', 'process.exit(7); console.log("ran after exit")'], { env, encoding: 'utf8', timeout: 30_000 })
  assert.equal(r.status, 7)
  assert.doesNotMatch(r.stdout, /ran after exit/)
})
