// test/helpers/tmp.test.mjs — test/helpers/tmp.mjs: the directory is gone however the test process ends.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir, removeTmp } from './tmp.mjs'
import { EXIT_WITH_PARENT, watchEnv } from './standin.mjs'

const HELPER = fileURLToPath(new URL('./tmp.mjs', import.meta.url))
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT

test('tmpDir: a fresh directory under os.tmpdir() with the prefix; removeTmp takes it away now, and twice is fine', () => {
  const dir = tmpDir('trocar-tmptest-')
  assert.equal(path.dirname(dir), os.tmpdir())
  assert.match(path.basename(dir), /^trocar-tmptest-[A-Za-z0-9]{6}$/)
  assert.ok(fs.statSync(dir).isDirectory())
  removeTmp(dir)
  assert.equal(fs.existsSync(dir), false)
  removeTmp(dir)
})

test('removeTmp: only a directory tmpDir made — a path it did not make is left alone, whatever the caller passed', () => {
  const mine = tmpDir('trocar-tmptest-')
  const notMine = path.join(mine, 'not-made-by-tmpDir')
  fs.mkdirSync(notMine)
  fs.writeFileSync(path.join(notMine, 'f'), 'x')
  removeTmp(notMine)
  removeTmp(path.join(mine, 'f-nonexistent'))
  assert.ok(fs.existsSync(path.join(notMine, 'f')), 'a subdirectory of a tmpDir is not itself a tmpDir')
  removeTmp(mine)
  assert.equal(fs.existsSync(mine), false)
})

// each ending of a process that has made a directory: [how the script ends, expected exit status]
const ENDINGS = {
  'falls off the end': ['', 0],
  'calls process.exit(3)': ['process.exit(3)', 3],
  'throws': ['throw new Error("boom")', 1],
  'ends with a failing assertion inside node:test': ['__TEST__', 1],
}

for (const [name, [ending, status]] of Object.entries(ENDINGS)) {
  test(`tmpDir: the directory is removed when the process ${name}`, () => {
    const scratch = tmpDir('trocar-tmpchild-') // the children's dirs are made in here; this one goes at exit, mode-000 leftovers of a broken helper included
    const body = `
      import { tmpDir } from ${JSON.stringify(HELPER)}
      import fs from 'node:fs'
      const dir = tmpDir('trocar-kid-')
      fs.writeFileSync(dir + '/f', 'x')
      fs.writeFileSync(process.env.REPORT, dir)
      ${ending === '__TEST__' ? "const { default: test } = await import('node:test'); test('fails', () => { throw new Error('on purpose') })" : ending}
    `
    const script = path.join(scratch, 'kid.mjs')
    fs.writeFileSync(script, body)
    const report = path.join(scratch, 'dir.txt')
    const args = ending === '__TEST__' ? ['--test', '--test-force-exit', script] : [script]
    const r = spawnSync(process.execPath, args, { env: { ...env, TMPDIR: scratch, REPORT: report }, encoding: 'utf8', timeout: 60_000 })
    assert.equal(r.status, status, r.stderr)
    const made = fs.readFileSync(report, 'utf8')
    assert.ok(made.startsWith(scratch + path.sep), `the child made its directory under ${scratch}: ${made}`)
    assert.equal(fs.existsSync(made), false, `${made} survived the process that made it`)
  })
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  test(`tmpDir: the directory is removed when the process is sent ${sig} (a hung npm test that is interrupted), and it still dies of the signal`, () => {
    const scratch = tmpDir('trocar-tmpchild-') // the children's dirs are made in here; this one goes at exit, mode-000 leftovers of a broken helper included
    const script = path.join(scratch, 'kid.mjs')
    fs.writeFileSync(script, `
      import ${JSON.stringify(EXIT_WITH_PARENT)} // …and, if the test that started this one is killed, its parent being gone (a kill -9 leaves no cleanup to run)
      import { tmpDir } from ${JSON.stringify(HELPER)}
      import fs from 'node:fs'
      const dir = tmpDir('trocar-kid-')
      fs.writeFileSync(dir + '/f', 'x')
      fs.writeFileSync(process.env.REPORT, dir)
      process.kill(process.pid, ${JSON.stringify(sig)})
      setInterval(() => {}, 1000) // a hung test: nothing but the signal ends this process
    `)
    const report = path.join(scratch, 'dir.txt')
    const r = spawnSync(process.execPath, [script], { env: watchEnv({ ...env, TMPDIR: scratch, REPORT: report }), encoding: 'utf8', timeout: 60_000 })
    assert.equal(r.signal, sig, `status ${r.status}: ${r.stderr}`)
    assert.equal(fs.existsSync(fs.readFileSync(report, 'utf8')), false)
  })
}

test('tmpDir: the hung child of the signal tests (nothing but a signal ends it) is bounded by its parent — SIGKILL the process that started it and it goes, taking its directory with it', async () => {
  const scratch = tmpDir('trocar-tmpchild-')
  const kid = path.join(scratch, 'hung.mjs'), parent = path.join(scratch, 'parent.mjs'), report = path.join(scratch, 'dir.txt')
  fs.writeFileSync(kid, `
    import ${JSON.stringify(EXIT_WITH_PARENT)}
    import { tmpDir } from ${JSON.stringify(HELPER)}
    import fs from 'node:fs'
    const dir = tmpDir('trocar-kid-')
    fs.writeFileSync(process.env.REPORT, dir)
    setInterval(() => {}, 1000) // a hung test: only a signal ends this process, and the death of its parent
  `)
  fs.writeFileSync(parent, `
    import { spawn } from 'node:child_process'
    const c = spawn(process.execPath, [${JSON.stringify(kid)}], { stdio: 'ignore', env: { ...process.env, TROCAR_WATCH_PID: String(process.pid) } })
    console.log(c.pid)
    setInterval(() => {}, 1000)
  `)
  const p = spawn(process.execPath, [parent], { env: { ...env, TMPDIR: scratch, REPORT: report }, stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end;) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)) } return fn() }
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
  assert.ok(await until(() => out.includes('\n') && fs.existsSync(report), 15000), 'the hung child started and made its directory')
  const pid = Number(out.trim()), made = fs.readFileSync(report, 'utf8')
  try {
    assert.ok(alive(pid) && fs.existsSync(made), 'it is up and holds its directory')
    p.kill('SIGKILL')
    assert.ok(await until(() => !alive(pid), 10000), `the hung child ${pid} outlived its parent`)
    assert.ok(await until(() => !fs.existsSync(made), 5000), 'and its directory went with it (process.exit runs the cleanup)')
  } finally { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } p.kill('SIGKILL') }
})

test('tmpDir: a directory holding a mode-000 file and a mode-000 subdirectory is removed too', () => {
  const scratch = tmpDir('trocar-tmpchild-')
  const script = path.join(scratch, 'kid.mjs')
  fs.writeFileSync(script, `
    import { tmpDir } from ${JSON.stringify(HELPER)}
    import fs from 'node:fs'
    const dir = tmpDir('trocar-kid-')
    fs.mkdirSync(dir + '/sub'); fs.writeFileSync(dir + '/sub/f', 'x'); fs.writeFileSync(dir + '/g', 'y')
    fs.chmodSync(dir + '/g', 0); fs.chmodSync(dir + '/sub', 0)
    fs.writeFileSync(process.env.REPORT, dir)
  `)
  const report = path.join(scratch, 'dir.txt')
  const r = spawnSync(process.execPath, [script], { env: { ...env, TMPDIR: scratch, REPORT: report }, encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.existsSync(fs.readFileSync(report, 'utf8')), false)
})
