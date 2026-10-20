// test/helpers/standin.test.mjs — a process a test starts to stand in for a daemon, an agent or a server ends by itself when the test process is gone (test/helpers/standin.mjs).
// The case is the one a `finally { child.kill() }` cannot cover: the test process is SIGKILLed — a killed runner, a timeout — so no cleanup of the test runs and the child is left parentless.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from './tmp.mjs'
import { spawnStandin, WITH_PARENT, EXIT_WITH_PARENT, watchEnv } from './standin.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STANDIN = path.join(HERE, 'standin.mjs')
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function gone(pid, ms) { for (const end = Date.now() + ms; Date.now() < end;) { if (!alive(pid)) return true; await sleep(50) } return !alive(pid) }

/** A process of its own that starts `what` (source of the child to start; its pid is printed), then stays up like a test process in the middle of a test. → { parent, childPid }. */
async function parentOf(what) {
  const dir = tmpDir('trocar-standin-')
  const file = path.join(dir, 'parent.mjs')
  fs.writeFileSync(file, `import { spawnStandin, WITH_PARENT, watchEnv } from ${JSON.stringify(STANDIN)}\nimport { spawn } from 'node:child_process'\nconst child = ${what}\nconsole.log(child.pid)\nsetInterval(() => {}, 1000)\n`)
  const parent = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'inherit'], env })
  const childPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the parent printed no pid')), 15000)
    readline.createInterface({ input: parent.stdout }).once('line', (l) => { clearTimeout(timer); resolve(Number(l)) })
  })
  return { parent, childPid }
}
const killAll = (...pids) => { for (const p of pids) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } } }

test('a stand-in stays up while its parent is there (the watch ends nothing early) and ends when its owner kills it', async () => {
  const c = spawnStandin()
  try {
    await sleep(1600) // three periods of the watch
    assert.ok(alive(c.pid), 'still up')
    assert.equal(c.exitCode, null)
    const exited = new Promise((r) => c.once('exit', (code, sig) => r(sig)))
    c.kill('SIGTERM')
    assert.equal(await exited, 'SIGTERM', 'the owner can still end it: the watch adds a way out, it takes none away')
  } finally { killAll(c.pid) }
})

for (const [when, settle] of [['once it has settled (the watch\'s own timer ends it)', 800], ['right after it was started (it may not have got as far as its watch: the pid it was told ends it)', 0]]) {
  test(`a stand-in exits by itself after its parent is SIGKILLed ${when}: no finally, no after — what a killed test runner leaves behind`, async () => {
    const { parent, childPid } = await parentOf('spawnStandin()')
    try {
      assert.ok(alive(childPid), 'the stand-in is up')
      assert.ok(alive(parent.pid))
      await sleep(settle)
      assert.ok(alive(childPid), 'and nothing ended it while its parent was there')
      parent.kill('SIGKILL')
      await new Promise((r) => parent.once('exit', r))
      assert.ok(await gone(childPid, 10000), `the stand-in ${childPid} is still alive 10 s after its parent was killed`)
    } finally { killAll(childPid, parent.pid) }
  })
}

test('the same for a node process that serves (a mock, a daemon of a test) and loads the watch with `--import`: it listens, so nothing but the watch would end it', async () => {
  const server = "spawn(process.execPath, [...WITH_PARENT, '-e', \"require('net').createServer().listen(0, '127.0.0.1')\"], { stdio: 'ignore', env: watchEnv() })"
  const { parent, childPid } = await parentOf(server)
  try {
    await sleep(700)
    assert.ok(alive(childPid), 'a server with the watch in it is up')
    parent.kill('SIGKILL')
    await new Promise((r) => parent.once('exit', r))
    assert.ok(await gone(childPid, 10000), `the server ${childPid} is still alive 10 s after its parent was killed`)
  } finally { killAll(childPid, parent.pid) }
})

test('the test rig\'s daemons (a CONNECT proxy that listens and reads stdin) carry the watch themselves: they end with the test process (the EOF on their stdin that its death brings does not end a server that listens)', async () => {
  const fixture = path.join(HERE, '..', 'lab', 'linux', 'fixtures', 'mock-proxy-daemon.mjs')
  const proxy = `spawn(process.execPath, [${JSON.stringify(fixture)}], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, TROCAR_MOCK_PROXY: '1', TROCAR_MOCK_TARGET_PORT: '9' } })`
  const { parent, childPid } = await parentOf(proxy)
  try {
    await sleep(1200)
    assert.ok(alive(childPid), 'the proxy daemon is up')
    parent.kill('SIGKILL')
    await new Promise((r) => parent.once('exit', r))
    assert.ok(await gone(childPid, 10000), `the proxy daemon ${childPid} is still alive 10 s after its parent was killed`)
  } finally { killAll(childPid, parent.pid) }
})

// The Windows collector's stand-in (test/collector/arch/win32/fixtures/): the fake helper that hangs before its ready line (the fake kernel went with the kernel, D47). It is a child of a
// test that kills it in an `after`; a killed runner leaves no `after`, so it carries the watch itself, and ends within seconds of its parent's death.
for (const [name, source] of [
  ['fake Windows helper (hangs before ready)', (dir) => `spawn(process.execPath, [${JSON.stringify(path.join(HERE, '..', 'collector', 'arch', 'win32', 'fixtures', 'fake-helper.mjs'))}, '{"hangBeforeReady":true}'], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, TROCAR_FAKE_HELPER: '1' } })`],
]) {
  test(`the ${name} carries the watch: it ends by itself within seconds of its parent being SIGKILLed`, async () => {
    const dir = tmpDir('trocar-standin-win-')
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ 'external-controller': '127.0.0.1:0', secret: 'x', listeners: [] }))
    const { parent, childPid } = await parentOf(source(dir))
    try {
      await sleep(1200)
      assert.ok(alive(childPid), `the ${name} is up while its parent is`)
      parent.kill('SIGKILL')
      await new Promise((r) => parent.once('exit', r))
      assert.ok(await gone(childPid, 10000), `the ${name} ${childPid} is still alive 10 s after its parent was killed`)
    } finally { killAll(childPid, parent.pid) }
  })
}

test('and the red side of it: without the watch the same child outlives a SIGKILLed parent (so the two tests above are not passing by accident)', async () => {
  const bare = "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })"
  const { parent, childPid } = await parentOf(bare)
  try {
    parent.kill('SIGKILL')
    await new Promise((r) => parent.once('exit', r))
    assert.equal(await gone(childPid, 2500), false, 'a bare keep-alive is still there: that is the leak')
  } finally { killAll(childPid, parent.pid) }
})

// The stand-ins of the suite: any test file that starts a bare keep-alive (`setInterval(() => {}, <ms>)` as a process of its own) must load the watch too.
const BARE = new RegExp(String.raw`setInterval\(\(\) => \{\}, \d+\)`)
function testFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' || e.name === 'fixtures-big' ? [] : testFiles(path.join(dir, e.name))) : /\.(mjs|cjs|js)$/.test(e.name) ? [path.join(dir, e.name)] : []))
}
test('no test file starts a bare keep-alive without the watch: every one that has one names the standin helper or the preload', () => {
  const offenders = []
  for (const file of testFiles(path.resolve(HERE, '..'))) {
    if (file === fileURLToPath(import.meta.url) || file === STANDIN) continue
    const src = fs.readFileSync(file, 'utf8')
    if (BARE.test(src) && !/standin\.mjs|exit-with-parent|EXIT_WITH_PARENT|spawnStandin/.test(src)) offenders.push(path.relative(path.resolve(HERE, '..', '..'), file))
  }
  assert.deepEqual(offenders, [], 'start it with spawnStandin() or add WITH_PARENT to the node arguments (test/helpers/standin.mjs)')
  assert.ok(fs.existsSync(EXIT_WITH_PARENT))
})
