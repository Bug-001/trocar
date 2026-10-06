// test/off/exec.test.mjs — src/off/exec.mjs, the one way new code runs an OS tool (0.1 §3 「不碰真实机器」): under `npm test` a real
// tool (launchctl, systemctl, security, certutil, loginctl …) is refused, a stub put on PATH inside the temp dir runs, and a runner a test
// injects is the only thing called. Outside a test it is a plain spawn.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { execTool } from '../../src/off/exec.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const stub = (dir, name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })

test('execTool: under npm test a real OS tool is refused, a PATH stub in the temp dir runs, an injected runner never spawns', () => {
  assert.equal(process.env.ASIGHT_TEST_SANDBOX, '1', 'the preload is on: run with --require ./test/helpers/no-real-os.cjs (npm test does)')
  assert.throws(() => execTool('launchctl', ['list'], { env: { ...process.env, PATH: '/bin:/usr/bin' } }), { code: 'ESANDBOX' })
  const bin = tmpDir('asight-exec-'); fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\necho stub "$@"\n', { mode: 0o755 })
  assert.match(execTool('launchctl', ['list'], { env: { ...process.env, PATH: bin } }).out, /^stub list/)
  const seen = []
  assert.equal(execTool('systemctl', ['--user', 'stop', 'x'], { run: (f, a) => { seen.push([f, ...a]); return { status: 0, stdout: '', stderr: '' } } }).code, 0)
  assert.deepEqual(seen, [['systemctl', '--user', 'stop', 'x']])
})

test('execTool: the refusal is for every OS tool the spec names, on any PATH, and it says why', () => {
  for (const tool of ['launchctl', 'systemctl', 'security', 'certutil', 'loginctl']) {
    assert.throws(() => execTool(tool, ['x']), (e) => e.code === 'ESANDBOX' && /npm test/.test(e.message) && e.message.includes(tool), tool)
  }
})

test('execTool: an absolute path to a real binary is refused too (not only a PATH lookup)', () => {
  for (const real of ['/bin/sh', '/usr/bin/security', '/bin/launchctl', process.execPath]) {
    assert.throws(() => execTool(real, ['-c', 'true'], { env: { ...process.env } }), { code: 'ESANDBOX' }, real)
  }
})

test('execTool: a stub that is a symlink to a real binary is refused (the check follows the link)', () => {
  const bin = tmpDir('asight-exec-'); fs.symlinkSync('/bin/sh', path.join(bin, 'launchctl'))
  assert.throws(() => execTool('launchctl', ['-c', 'true'], { env: { ...process.env, PATH: bin } }), { code: 'ESANDBOX' })
})

test('execTool: a stub outside the temp dir is refused (a script in the repo or in $HOME is not a sandbox)', () => {
  const home = fs.mkdtempSync(path.join(REPO, 'test', 'off', 'asight-notmp-')) // not under os.tmpdir()
  try {
    stub(home, 'systemctl', 'echo ran')
    assert.throws(() => execTool('systemctl', [], { env: { ...process.env, PATH: home } }), { code: 'ESANDBOX' })
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
  assert.throws(() => execTool('launchctl', ['list'], { env: { PATH: '/bin:/usr/bin' } }), { code: 'ESANDBOX' })
  assert.throws(() => execTool('launchctl', ['list'], { env: {} }), { code: 'ESANDBOX' })
})

test('execTool: a tool that is nowhere on PATH is refused the same way (not an ENOENT that a caller might treat as "not installed")', () => {
  assert.throws(() => execTool('no-such-tool-xyz', [], { env: { ...process.env, PATH: tmpDir('asight-exec-') } }), { code: 'ESANDBOX' })
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
