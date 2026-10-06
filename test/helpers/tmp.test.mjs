// test/helpers/tmp.test.mjs — test/helpers/tmp.mjs: the directory is gone however the test process ends.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir, removeTmp } from './tmp.mjs'

const HELPER = fileURLToPath(new URL('./tmp.mjs', import.meta.url))
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT

test('tmpDir: a fresh directory under os.tmpdir() with the prefix; removeTmp takes it away now, and twice is fine', () => {
  const dir = tmpDir('asight-tmptest-')
  assert.equal(path.dirname(dir), os.tmpdir())
  assert.match(path.basename(dir), /^asight-tmptest-[A-Za-z0-9]{6}$/)
  assert.ok(fs.statSync(dir).isDirectory())
  removeTmp(dir)
  assert.equal(fs.existsSync(dir), false)
  removeTmp(dir)
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
    const scratch = tmpDir('asight-tmpchild-') // the children's dirs are made in here; this one goes at exit, mode-000 leftovers of a broken helper included
    const body = `
      import { tmpDir } from ${JSON.stringify(HELPER)}
      import fs from 'node:fs'
      const dir = tmpDir('asight-kid-')
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
    const scratch = tmpDir('asight-tmpchild-') // the children's dirs are made in here; this one goes at exit, mode-000 leftovers of a broken helper included
    const script = path.join(scratch, 'kid.mjs')
    fs.writeFileSync(script, `
      import { tmpDir } from ${JSON.stringify(HELPER)}
      import fs from 'node:fs'
      const dir = tmpDir('asight-kid-')
      fs.writeFileSync(dir + '/f', 'x')
      fs.writeFileSync(process.env.REPORT, dir)
      process.kill(process.pid, ${JSON.stringify(sig)})
      setInterval(() => {}, 1000) // a hung test: nothing but the signal ends this process
    `)
    const report = path.join(scratch, 'dir.txt')
    const r = spawnSync(process.execPath, [script], { env: { ...env, TMPDIR: scratch, REPORT: report }, encoding: 'utf8', timeout: 60_000 })
    assert.equal(r.signal, sig, `status ${r.status}: ${r.stderr}`)
    assert.equal(fs.existsSync(fs.readFileSync(report, 'utf8')), false)
  })
}

test('tmpDir: a directory holding a mode-000 file and a mode-000 subdirectory is removed too', () => {
  const scratch = tmpDir('asight-tmpchild-')
  const script = path.join(scratch, 'kid.mjs')
  fs.writeFileSync(script, `
    import { tmpDir } from ${JSON.stringify(HELPER)}
    import fs from 'node:fs'
    const dir = tmpDir('asight-kid-')
    fs.mkdirSync(dir + '/sub'); fs.writeFileSync(dir + '/sub/f', 'x'); fs.writeFileSync(dir + '/g', 'y')
    fs.chmodSync(dir + '/g', 0); fs.chmodSync(dir + '/sub', 0)
    fs.writeFileSync(process.env.REPORT, dir)
  `)
  const report = path.join(scratch, 'dir.txt')
  const r = spawnSync(process.execPath, [script], { env: { ...env, TMPDIR: scratch, REPORT: report }, encoding: 'utf8', timeout: 60_000 })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.existsSync(fs.readFileSync(report, 'utf8')), false)
})
