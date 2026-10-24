// test/helpers/leak-guard.test.mjs — the preload `npm test` runs under (test/helpers/leak-guard.cjs): a test run that leaves a
// temp directory or a running child behind fails, names it, and cleans it up; one that leaves nothing, or fails its tests without
// leaking, does not get blamed.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
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
function run(body, scratch = tmpDir('trocar-guardtest-')) {
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

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

// the child would outlive its test file (it ends by itself after 10 minutes, should everything else fail)
test('leak-guard: a child a test file started and did not end is killed when the file ends, named, and fails the run', async () => {
  let pid
  try {
    const r = run(`import { spawn } from 'node:child_process'\ntest('starts a child', () => { const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' }); process.stdout.write('CHILD=' + c.pid + '\\n') })`)
    pid = Number(/CHILD=(\d+)/.exec(r.stdout)?.[1])
    assert.ok(pid > 0, r.stdout)
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^# pass 1$/m, 'the test itself passed — the guard is what fails the run')
    assert.match(r.stderr, /leak-guard: 1 child process was still running/)
    assert.match(r.stderr, new RegExp(`pid ${pid} from .*fixture\\.test\\.mjs: .*-e setTimeout`))
    assert.deepEqual(r.left, [])
    // the orphan is reaped by whoever adopted it; give that a moment
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((ok) => setTimeout(ok, 100))
    assert.equal(alive(pid), false, `child ${pid} is dead`)
  } finally {
    if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL')
  }
})

test('leak-guard: a child with an IPC channel is killed when its file ends and not blamed (it would end when the channel closes)', async () => {
  let pid
  try {
    const r = run(`import { spawn } from 'node:child_process'\ntest('forks', () => { const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); process.stdout.write('CHILD=' + c.pid + '\\n') })`)
    pid = Number(/CHILD=(\d+)/.exec(r.stdout)?.[1])
    assert.ok(pid > 0, r.stdout)
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stderr, /leak-guard/)
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((ok) => setTimeout(ok, 100))
    assert.equal(alive(pid), false, `child ${pid} is dead`)
  } finally {
    if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL')
  }
})

test('leak-guard: a child the test ends and waits for is not blamed', () => {
  const r = run(`import { spawn } from 'node:child_process'\nimport { once } from 'node:events'\ntest('ends its child', async () => { const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' }); try { await new Promise((ok) => setTimeout(ok, 50)) } finally { c.kill(); await once(c, 'exit') } })`)
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stderr, /leak-guard/)
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
  assert.deepEqual(leaked(dir, fs.readdirSync(dir).sort()), ['as-y', 'atrace-z', 'trocar-x', 'whatever'])
  // an entry that went away between the listing and the check does not end the check (an exception there turned the guard off)
  assert.deepEqual(leaked(dir, ['gone-before-lstat', 'trocar-gone', 'whatever']), ['trocar-gone', 'whatever'])
})

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))
async function until(what, ok) {
  for (let i = 0; i < 300; i++) { const v = ok(); if (v) return v; await sleep(50) }
  throw new Error(`timed out waiting for ${what}`)
}

/** A real runner under the guard in `scratch` whose one test waits until `go()` is called; resolves once its run directory is made. */
async function waitingRunner(scratch) {
  const sig = tmpDir('trocar-guardsig-')
  const [pidFile, goFile] = [path.join(sig, 'pid'), path.join(sig, 'go')]
  const file = path.join(sig, 'wait.test.mjs')
  fs.writeFileSync(file, `import test from 'node:test'\nimport fs from 'node:fs'\ntest('waits', async () => { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); while (!fs.existsSync(${JSON.stringify(goFile)})) await new Promise((ok) => setTimeout(ok, 50)) })\n`)
  const runner = spawn(process.execPath, ['--test', '--test-force-exit', '--require', GUARD, file], { env: { ...env, TMPDIR: scratch }, stdio: 'ignore' })
  const exited = once(runner, 'exit')
  const filePid = Number(await until('the waiting test to start', () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')))
  const dir = fs.readdirSync(scratch).find((n) => n.startsWith('trocar-run-'))
  assert.ok(dir, 'the runner made its run directory')
  return {
    dir, runner,
    kill: async () => { runner.kill('SIGKILL'); await exited },
    // lets the test end; the test file's process is waited for even when its runner was killed and it lives on as an orphan
    go: async () => { fs.writeFileSync(goFile, ''); await exited; await until('the test file to end', () => !alive(filePid)) },
  }
}

test('leak-guard: a run removes the run directory a killed runner left behind, and keeps the one of a runner still running', async () => {
  const scratch = tmpDir('trocar-guardtest-')
  const dead = await waitingRunner(scratch)
  let live
  try {
    await dead.kill()
    assert.ok(fs.existsSync(path.join(scratch, dead.dir)), 'a killed runner leaves its directory (the leak)')
    live = await waitingRunner(scratch)
    const r = run(`test('nothing', () => {})`, scratch)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(fs.existsSync(path.join(scratch, dead.dir)), false, 'the killed runner\'s directory is gone')
    assert.ok(fs.existsSync(path.join(scratch, live.dir)), 'the running runner\'s directory is kept')
  } finally {
    await dead.go()
    if (live) await live.go()
  }
  assert.equal(live.runner.exitCode, 0, 'the runner whose directory was kept finished its run')
})

test('leak-guard: a run directory with no runner recorded is removed once a day old and kept while fresh; one whose pid now runs another process is removed', () => {
  const scratch = tmpDir('trocar-guardtest-')
  const mk = (name, owner) => { const d = path.join(scratch, name); fs.mkdirSync(d); if (owner) fs.writeFileSync(path.join(d, '.runner'), JSON.stringify(owner)); return d }
  const stale = mk('trocar-run-stale')
  const day = (Date.now() - 25 * 3600 * 1000) / 1000
  fs.utimesSync(stale, day, day)
  const fresh = mk('trocar-run-fresh')
  const reused = mk('trocar-run-reused', { pid: process.pid, start: 'Thu Jan  1 00:00:00 1970' })
  const r = run(`test('nothing', () => {})`, scratch)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.existsSync(stale), false, 'the day-old one is removed')
  assert.ok(fs.existsSync(fresh), 'the fresh one is kept')
  if (process.platform !== 'win32') assert.equal(fs.existsSync(reused), false, 'a live pid with another start time is no owner')
})
