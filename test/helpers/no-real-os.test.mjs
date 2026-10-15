// test/helpers/no-real-os.test.mjs — the preload `npm test` runs under (test/helpers/no-real-os.cjs): no test process runs a real
// launchctl / systemctl / security / certutil / loginctl (0.1 §3 「不碰真实机器」). Every call below that the guard must refuse
// is given a flag none of the guarded tools knows, so that a broken guard makes a test red without touching the machine it runs on.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync, execFile, execFileSync, exec, execSync } from 'node:child_process'
import { tmpDir } from './tmp.mjs'
import { takeRefusals } from './no-real-os.mjs'

const { REAL_TOOLS, realToolsIn } = createRequire(import.meta.url)('./no-real-os.cjs')
const GUARD = fileURLToPath(new URL('./no-real-os.cjs', import.meta.url))
const HELPER = fileURLToPath(new URL('./no-real-os.mjs', import.meta.url))
const NOOP = '--asight-test-noop'
const TOOLS = ['launchctl', 'systemctl', 'security', 'certutil', 'loginctl', 'asight-sign-helper', 'procenv', 'plutil']
const stub = (dir, name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })

test('no-real-os: the preload is on and the guard names the tools of 0.1 §3 and the macOS native pieces', () => {
  assert.equal(process.env.ASIGHT_TEST_SANDBOX, '1')
  assert.ok(process.env.ASIGHT_MIHOMO_SOCK.startsWith(fs.realpathSync(os.tmpdir()) + path.sep), 'the VPN core\'s socket is pinned inside the temp dir: a child `asight status` never asks the developer\'s own mihomo')
  assert.deepEqual([...REAL_TOOLS].sort(), [...TOOLS].sort())
  assert.deepEqual(takeRefusals(), [])
})

test('no-real-os: every way node:child_process runs a command refuses each guarded tool, the promisified ones included', async () => {
  const calls = {
    spawn: (t) => spawn(t, [NOOP]),
    spawnSync: (t) => spawnSync(t, [NOOP]),
    execFile: (t) => execFile(t, [NOOP], () => {}),
    execFileSync: (t) => execFileSync(t, [NOOP]),
    exec: (t) => exec(`${t} ${NOOP}`, () => {}),
    execSync: (t) => execSync(`${t} ${NOOP}`),
    'promisify(execFile)': (t) => promisify(execFile)(t, [NOOP]),
    'promisify(exec)': (t) => promisify(exec)(`${t} ${NOOP}`),
    'spawn with shell': (t) => spawnSync(`${t} ${NOOP}`, [], { shell: true }),
  }
  let n = 0
  for (const [name, call] of Object.entries(calls)) {
    for (const tool of TOOLS) {
      assert.throws(() => call(tool), { code: 'ESANDBOX' }, `${name} ${tool}`)
      n++
    }
  }
  const got = takeRefusals()
  assert.equal(got.length, n, 'every refusal is in the ledger')
  assert.deepEqual([...new Set(got.map((r) => r.tool))].sort(), [...TOOLS].sort())
  assert.ok(got.every((r) => /npm test/.test(r.message) && r.command.includes(r.tool)))
})

test('no-real-os: the committed macOS native binaries are refused by their real paths (the helper would write the login keychain)', () => {
  const native = fileURLToPath(new URL('../../src/collector/arch/darwin/native/', import.meta.url))
  for (const name of ['asight-sign-helper', 'procenv']) {
    assert.ok(fs.existsSync(path.join(native, name)), `${name} is committed`)
    assert.throws(() => spawnSync(path.join(native, name), ['exists']), { code: 'ESANDBOX' }, name)
    assert.throws(() => execFileSync('sh', ['-c', `'${path.join(native, name)}' ${NOOP}`]), { code: 'ESANDBOX' }, `${name} behind sh -c`)
  }
  assert.throws(() => spawnSync('/usr/bin/plutil', ['-extract', 'k', 'json', '-o', '-', '/nonexistent']), { code: 'ESANDBOX' })
  assert.equal(takeRefusals().length, 5)
})

test('no-real-os: an absolute path to a tool, and a tool behind env / sh -c / bash -lc, is refused', () => {
  for (const abs of ['/bin/launchctl', '/usr/bin/security', '/usr/sbin/systemctl', '/usr/bin/certutil']) {
    assert.throws(() => spawnSync(abs, [NOOP]), { code: 'ESANDBOX' }, abs)
  }
  assert.throws(() => spawnSync('env', ['FOO=1', 'security', NOOP]), { code: 'ESANDBOX' })
  assert.throws(() => spawnSync('sh', ['-c', `echo hi; launchctl ${NOOP}`]), { code: 'ESANDBOX' })
  assert.throws(() => spawnSync('bash', ['-lc', `if systemctl ${NOOP}; then :; fi`]), { code: 'ESANDBOX' })
  assert.equal(takeRefusals().length, 7)
})

test('no-real-os: which commands count — a tool in command position does, an argument or another program does not (no spawn here)', () => {
  const cases = [
    [['launchctl', ['list']], ['launchctl']],
    [['/usr/bin/security', []], ['/usr/bin/security']],
    [['sudo', ['-n', 'launchctl', 'bootout', 'x']], ['launchctl']],
    [['env', ['A=1', 'B=2', 'certutil', '-L']], ['certutil']],
    [['timeout', ['5', 'systemctl', 'status']], ['systemctl']],
    [['sh', ['-c', 'echo a && loginctl show-user x | cat']], ['loginctl']],
    [['bash', ['-lc', 'cd /x; (security list-keychains)']], ['security']],
    [['sh', ['-c', 'echo launchctl']], []],
    [['sh', ['script.sh', 'security']], []],
    [[process.execPath, ['-e', 'launchctl']], []],
    [['git', ['log', '--grep', 'security']], []],
    [['node', ['x.js']], []],
  ]
  for (const [[file, args], want] of cases) assert.deepEqual(realToolsIn(file, args), want, `${file} ${args.join(' ')}`)
  assert.deepEqual(realToolsIn('echo launchctl; security x', [], { script: true }), ['security'])
  assert.deepEqual(realToolsIn('echo security', [], { script: true }), [])
})

test('no-real-os: a stub inside the temp dir runs, through every wrapper; a stub that is a link to a real binary, or lies outside the temp dir, does not', async () => {
  const bin = tmpDir('asight-noreal-'); stub(bin, 'launchctl', 'echo stub "$@"')
  const env = { ...process.env, PATH: `${bin}:/bin:/usr/bin` }
  assert.equal(spawnSync('launchctl', ['a'], { env, encoding: 'utf8' }).stdout.trim(), 'stub a')
  assert.equal(execFileSync('launchctl', ['b'], { env, encoding: 'utf8' }).trim(), 'stub b')
  assert.equal(execSync('launchctl c', { env, encoding: 'utf8' }).trim(), 'stub c')
  assert.equal(spawnSync('sh', ['-c', 'launchctl d'], { env, encoding: 'utf8' }).stdout.trim(), 'stub d')
  assert.equal((await promisify(execFile)('launchctl', ['e'], { env })).stdout.trim(), 'stub e')
  assert.deepEqual(takeRefusals(), [], 'a stub of the test\'s own is not a refusal')

  const link = tmpDir('asight-noreal-'); fs.symlinkSync('/bin/sh', path.join(link, 'launchctl'))
  assert.throws(() => spawnSync('launchctl', ['-c', 'true'], { env: { ...process.env, PATH: link } }), { code: 'ESANDBOX' })
  const outside = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'asight-notmp-')) // beside this file: not under os.tmpdir()
  try {
    stub(outside, 'systemctl', 'echo ran')
    assert.throws(() => spawnSync('systemctl', [], { env: { ...process.env, PATH: outside } }), { code: 'ESANDBOX' })
  } finally { fs.rmSync(outside, { recursive: true, force: true }) }
  assert.throws(() => spawnSync('security', [NOOP], { env: { ...process.env, PATH: tmpDir('asight-noreal-') } }), { code: 'ESANDBOX' }, 'on no PATH at all')
  assert.equal(takeRefusals().length, 3)
})

test('no-real-os: everything else still runs (node itself, a shell, a word that merely names a tool)', () => {
  assert.equal(spawnSync(process.execPath, ['-p', '6*7'], { encoding: 'utf8' }).stdout.trim(), '42')
  assert.equal(execSync('echo launchctl security', { encoding: 'utf8' }).trim(), 'launchctl security')
  assert.equal(spawnSync('sh', ['-c', 'echo systemctl'], { encoding: 'utf8' }).stdout.trim(), 'systemctl')
  assert.deepEqual(takeRefusals(), [])
})

// ---- the wrapper reaches an ESM `import { … } from 'node:child_process'`, and an unacknowledged refusal fails the process ----

const childEnv = { ...process.env }
delete childEnv.NODE_TEST_CONTEXT; delete childEnv.NODE_OPTIONS
function runChild(body) {
  const dir = tmpDir('asight-noreal-')
  const file = path.join(dir, 'child.mjs')
  fs.writeFileSync(file, `import { execFileSync } from 'node:child_process'\nimport { takeRefusals } from ${JSON.stringify(HELPER)}\n${body}\n`)
  return spawnSync(process.execPath, ['--require', GUARD, file], { env: childEnv, encoding: 'utf8', timeout: 30_000 })
}

test('no-real-os: a module that imports execFileSync by name gets the guarded one (the patch is seen by a later ESM import)', () => {
  const r = runChild(`try { execFileSync('launchctl', ['${NOOP}']); console.log('RAN') } catch (e) { console.log(e.code); takeRefusals() }`)
  assert.equal(r.stdout.trim(), 'ESANDBOX', r.stderr)
  assert.equal(r.status, 0, 'acknowledged: nothing left in the ledger')
})

test('no-real-os: a process that ends with a refusal nobody took exits 1 and names the command; one that took it exits 0', () => {
  const swallowed = runChild(`try { execFileSync('launchctl', ['${NOOP}']) } catch { /* "the tool failed", carry on */ }\nconsole.log('went on')`)
  assert.equal(swallowed.status, 1)
  assert.equal(swallowed.stdout.trim(), 'went on')
  assert.match(swallowed.stderr, /no-real-os: 1 attempt to run a real OS tool was refused in this process and never acknowledged/)
  assert.match(swallowed.stderr, new RegExp(`^ {2}launchctl ${NOOP}$`, 'm'))
  const taken = runChild(`try { execFileSync('launchctl', ['${NOOP}']) } catch { }\nconsole.log(takeRefusals().length)`)
  assert.equal(taken.status, 0); assert.equal(taken.stdout.trim(), '1'); assert.equal(taken.stderr, '')
})

test('no-real-os: under node --test a file whose test swallows the refusal fails, though every test in it passed; one that takes it passes', () => {
  const scratch = tmpDir('asight-noreal-')
  const fixture = (name, body) => {
    const file = path.join(scratch, `${name}.test.mjs`)
    fs.writeFileSync(file, `import test from 'node:test'\nimport { execFileSync } from 'node:child_process'\nimport { takeRefusals } from ${JSON.stringify(HELPER)}\n${body}\n`)
    return spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-reporter=tap', '--require', GUARD, file], { env: { ...childEnv, TMPDIR: scratch }, encoding: 'utf8', timeout: 60_000 })
  }
  const bad = fixture('swallow', `test('swallows', () => { try { execFileSync('launchctl', ['${NOOP}']) } catch { /* carry on */ } })`)
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /^# pass 1$/m, 'the test itself passed; the guard is what fails the file')
  assert.match(bad.stdout + bad.stderr, /no-real-os: 1 attempt/)
  const good = fixture('takes', `test('takes', () => { try { execFileSync('launchctl', ['${NOOP}']) } catch { } if (takeRefusals().length !== 1) throw new Error('not recorded') })`)
  assert.equal(good.status, 0, good.stdout + good.stderr)
})
