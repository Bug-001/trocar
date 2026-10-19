// test/off/exec.test.mjs — src/off/exec.mjs, the one way new code runs an OS tool (0.1 §3 「不碰真实机器」): under `npm test` a real
// tool (launchctl, systemctl, security, certutil, loginctl …) is refused, a stub put on PATH inside the temp dir runs, and a runner a test
// injects is the only thing called. Outside a test it is a plain spawn.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { execTool, runAsync } from '../../src/off/exec.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { takeRefusals } from '../helpers/no-real-os.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const stub = (dir, name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
/** `call` throws ESANDBOX, and the refusal is in the preload's ledger once (a test process that ends with an unacknowledged one exits 1). */
function refused(call, tool, why) {
  assert.throws(call, { code: 'ESANDBOX' }, why)
  const got = takeRefusals()
  assert.equal(got.length, 1, `${why || tool}: one refusal recorded`)
  assert.equal(got[0].tool, tool); assert.ok(got[0].command.startsWith(tool), got[0].command)
}

test('execTool: under npm test a real OS tool is refused, a PATH stub in the temp dir runs, an injected runner never spawns', () => {
  assert.equal(process.env.ASIGHT_TEST_SANDBOX, '1', 'the preload is on: run with --require ./test/helpers/no-real-os.cjs (npm test does)')
  refused(() => execTool('launchctl', ['list'], { env: { ...process.env, PATH: '/bin:/usr/bin' } }), 'launchctl')
  const bin = tmpDir('asight-exec-'); fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\necho stub "$@"\n', { mode: 0o755 })
  assert.match(execTool('launchctl', ['list'], { env: { ...process.env, PATH: bin } }).out, /^stub list/)
  const seen = []
  assert.equal(execTool('systemctl', ['--user', 'stop', 'x'], { run: (f, a) => { seen.push([f, ...a]); return { status: 0, stdout: '', stderr: '' } } }).code, 0)
  assert.deepEqual(seen, [['systemctl', '--user', 'stop', 'x']])
})

test('execTool: the refusal is for every OS tool the spec names, on any PATH, and it says why', () => {
  for (const tool of ['launchctl', 'systemctl', 'security', 'certutil', 'loginctl']) {
    assert.throws(() => execTool(tool, ['x']), (e) => e.code === 'ESANDBOX' && /npm test/.test(e.message) && e.message.includes(tool), tool)
    assert.deepEqual(takeRefusals().map((r) => r.tool), [tool])
  }
})

test('execTool: an absolute path to a real binary is refused too (not only a PATH lookup)', () => {
  for (const real of ['/bin/sh', '/usr/bin/security', '/bin/launchctl', process.execPath]) {
    refused(() => execTool(real, ['-c', 'true'], { env: { ...process.env } }), real, real)
  }
})

test('execTool: a stub that is a symlink to a real binary is refused (the check follows the link)', () => {
  const bin = tmpDir('asight-exec-'); fs.symlinkSync('/bin/sh', path.join(bin, 'launchctl'))
  refused(() => execTool('launchctl', ['-c', 'true'], { env: { ...process.env, PATH: bin } }), 'launchctl')
})

test('execTool: a stub outside the temp dir is refused (a script in the repo or in $HOME is not a sandbox)', () => {
  const home = fs.mkdtempSync(path.join(REPO, 'test', 'off', 'asight-notmp-')) // not under os.tmpdir()
  try {
    stub(home, 'systemctl', 'echo ran')
    refused(() => execTool('systemctl', [], { env: { ...process.env, PATH: home } }), 'systemctl')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('execTool: a stub in a sibling directory whose name merely starts with the temp dir\'s is refused (the prefix is a path, not a string)', () => {
  const base = tmpDir('asight-exec-'), tmp = path.join(base, 'tmp'), sibling = path.join(base, 'tmp-evil')
  for (const d of [tmp, sibling]) { fs.mkdirSync(d); stub(d, 'launchctl', 'echo ran') }
  // a child with TMPDIR = `tmp`, so os.tmpdir() there is that directory; two stubs, one inside it and one beside it
  const script = `import { execTool } from ${JSON.stringify(new URL('../../src/off/exec.mjs', import.meta.url).href)}
const env = { ...process.env, PATH: process.argv[1] }
const tryIt = () => { try { return execTool('launchctl', [], { env }).out } catch (e) { return e.code } }
console.log(JSON.stringify([tryIt()]))`
  const run = (dir) => JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], { env: { ...process.env, TMPDIR: tmp, ASIGHT_TEST_SANDBOX: '1', NODE_OPTIONS: '' }, encoding: 'utf8' }).stdout)
  assert.deepEqual(run(tmp), ['ran'])
  assert.deepEqual(run(sibling), ['ESANDBOX'])
})

test('execTool: the sandbox flag of the process is honoured even when the caller passes an env of its own without it', () => {
  refused(() => execTool('launchctl', ['list'], { env: { PATH: '/bin:/usr/bin' } }), 'launchctl')
  refused(() => execTool('launchctl', ['list'], { env: {} }), 'launchctl')
})

test('execTool: a tool that is nowhere on PATH is refused the same way (not an ENOENT that a caller might treat as "not installed")', () => {
  refused(() => execTool('no-such-tool-xyz', [], { env: { ...process.env, PATH: tmpDir('asight-exec-') } }), 'no-such-tool-xyz')
})

test('execTool: a stub gets the arguments, its stdin, and its exit code, stdout and stderr come back trimmed', () => {
  const bin = tmpDir('asight-exec-')
  stub(bin, 'security', 'read -r line; echo "$line"; echo "args:$1,$2"; echo oops >&2; exit 3') // shell built-ins only: PATH is just this dir
  const r = execTool('security', ['find-certificate', '-a'], { env: { ...process.env, PATH: bin }, input: 'in-line\n' })
  assert.deepEqual(r, { code: 3, out: 'in-line\nargs:find-certificate,-a', err: 'oops' })
})

test('execTool: an injected runner is called with (file, args, options) and its status / stdout / stderr are mapped; no stub is looked for', () => {
  const calls = []
  const run = (file, args, opts) => { calls.push({ file, args, opts }); return { status: 1, stdout: ' out \n', stderr: ' err\n' } }
  const r = execTool('certutil', ['-L', '-d', 'sql:/x'], { run, env: { PATH: '/nonexistent' }, input: 'q', timeoutMs: 77 })
  assert.deepEqual(r, { code: 1, out: 'out', err: 'err' })
  assert.equal(calls.length, 1)
  assert.deepEqual([calls[0].file, calls[0].args], ['certutil', ['-L', '-d', 'sql:/x']])
  assert.equal(calls[0].opts.input, 'q'); assert.equal(calls[0].opts.timeout, 77); assert.equal(calls[0].opts.encoding, 'utf8'); assert.equal(calls[0].opts.env.PATH, '/nonexistent')
  // a runner that reports an error (no such binary) and no status: code null, the message in err
  assert.deepEqual(execTool('loginctl', [], { run: () => ({ status: null, error: new Error('spawn loginctl ENOENT') }) }), { code: null, out: '', err: 'spawn loginctl ENOENT' })
  // a runner that throws is the caller's to handle: it is not swallowed
  assert.throws(() => execTool('loginctl', [], { run: () => { throw new Error('boom') } }), /boom/)
})

test('execTool: outside a test (no sandbox flag) it is a plain spawn: the code, output and a timeout come back; a missing tool is code null with the reason', () => {
  const env = { ...process.env, PATH: '/bin:/usr/bin' }; delete env.ASIGHT_TEST_SANDBOX; delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT
  const script = `import { execTool } from ${JSON.stringify(new URL('../../src/off/exec.mjs', import.meta.url).href)}
console.log(JSON.stringify([execTool('echo', ['hi']), execTool('sh', ['-c', 'exit 4']), execTool('sleep', ['5'], { timeoutMs: 150 }), execTool('no-such-tool-xyz', [])]))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 30000 })
  assert.equal(r.status, 0, r.stderr)
  const [echo, four, slept, missing] = JSON.parse(r.stdout)
  assert.deepEqual(echo, { code: 0, out: 'hi', err: '' })
  assert.deepEqual(four, { code: 4, out: '', err: '' })
  assert.equal(slept.code, null, 'killed by the timeout: no exit code')
  assert.equal(missing.code, null); assert.match(missing.err, /ENOENT/)
})

test('execTool: the guard is on under npm test because package.json loads the preload (take it out and this is red)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  assert.match(pkg.scripts.test, /--require \.\/test\/helpers\/no-real-os\.cjs/)
  assert.ok(fs.existsSync(path.join(REPO, 'test/helpers/no-real-os.cjs')))
})

test('execTool: a refusal that a caller swallows stays in the preload\'s ledger, with the command (the process exits 1 unless the test takes it: no-real-os.test.mjs)', () => {
  let swallowed = false
  try { execTool('security', ['find-certificate', '-a']) } catch { swallowed = true } // what a "the tool failed, carry on" caller does
  assert.ok(swallowed)
  assert.deepEqual(takeRefusals().map((r) => r.command), ['security find-certificate -a'])
  assert.deepEqual(takeRefusals(), [], 'taking them empties the ledger')
})

// 0.1 §3: the preload wraps node:child_process, so a direct spawn is refused at run time; this is the cheaper half that names the file.
// src/off, src/cli and src/netenv run OS tools through execTool and nothing else, so a test can inject a runner into every call.
const CHILD_PROCESS_ALLOWED = ['src/off/exec.mjs']
const CHILD_PROCESS_IMPORT = /(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*['"](?:node:)?child_process['"]/
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(mjs|cjs|js)$/.test(e.name) ? [path.join(d, e.name)] : [])) : [])
function childProcessUsers(root) {
  return ['src/off', 'src/cli', 'src/netenv'].flatMap((dir) => walk(path.join(root, dir)))
    .filter((f) => CHILD_PROCESS_IMPORT.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .filter((rel) => !CHILD_PROCESS_ALLOWED.includes(rel))
}

test('0.1 §3 src/off, src/cli and src/netenv reach node:child_process only through src/off/exec.mjs (the scan sees exec.mjs, and fails on a planted file)', () => {
  assert.ok(CHILD_PROCESS_IMPORT.test(fs.readFileSync(path.join(REPO, 'src/off/exec.mjs'), 'utf8')), 'the one allowed file still imports it (else the scan proves nothing)')
  assert.deepEqual(childProcessUsers(REPO), [])
  const root = tmpDir('asight-cpscan-')
  for (const [rel, src] of [
    ['src/off/a.mjs', "import { spawnSync } from 'node:child_process'\n"],
    ['src/cli/b.mjs', "const cp = await import('node:child_process')\n"],
    ['src/netenv/c.mjs', "const { execFileSync } = require('child_process')\n"],
    ['src/cli/d.mjs', "import cp from \"child_process\"\n"],
    ['src/cli/ok.mjs', "// runs tools through child_process? no: execTool\nimport { execTool } from '../off/exec.mjs'\n"],
    ['src/off/exec.mjs', "import { spawnSync } from 'node:child_process'\n"],
  ]) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), src) }
  assert.deepEqual(childProcessUsers(root).sort(), ['src/cli/b.mjs', 'src/cli/d.mjs', 'src/netenv/c.mjs', 'src/off/a.mjs'])
})

test('runAsync quiet settles on the child\'s exit, not when something it started lets go of the pipes; past the timeout it is status null', { skip: process.platform === 'win32', timeout: 20_000 }, async () => {
  const bin = tmpDir('asight-exec-'), env = { ...process.env, PATH: bin }
  stub(bin, 'opener', 'sleep 5 & exit 0'); stub(bin, 'stuck', 'exec sleep 5'); stub(bin, 'nope', 'exit 3')
  const t0 = Date.now()
  assert.equal((await runAsync('opener', [], { env, timeout: 3000, quiet: true })).status, 0)
  assert.ok(Date.now() - t0 < 2500, `${Date.now() - t0} ms`)
  assert.equal((await runAsync('stuck', [], { env, timeout: 300, quiet: true })).status, null)
  assert.equal((await runAsync('nope', [], { env, timeout: 3000, quiet: true })).status, 3)
})
