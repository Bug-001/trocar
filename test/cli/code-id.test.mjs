// test/cli/code-id.test.mjs — 1.6 §2 `--version` (D67⑤): which code this is. In a git checkout the version and HEAD's first 7; anywhere else the version
// and the first 7 of a hash of the code itself, so two different trees of one version tell apart and install's replace-daemon (§3.2) does not keep a
// collector on the code from before (a macOS run upgraded by replacing the files: both trees said the plain version, the old collector stayed). Then
// status and doctor say a collector on other code (§3.5, §3.7, C.3 `daemon.runs_this_code`). Temp trees and injected daemon answers only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { codeId } from '../../src/version.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { runDoctor } from '../../src/cli/doctor.mjs'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { fakeIo, recordingExec } from './fixtures/on-ctx.mjs'
import { reply, asDaemon, SOCK } from './fixtures/status-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'

/** A copy of trocar's shape: package.json with `version`, and `files` under it. */
function tree(files, version = '1.2.3') {
  const root = tmpDir('trocar-code-')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'trocar', version }))
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }
  return root
}
const CODE = { 'bin/trocar.mjs': 'import "../src/cli/main.mjs"\n', 'src/cli/main.mjs': 'export const x = 1\n', 'src/off/a.mjs': 'export const a = 2\n' }

test('outside a git checkout the code id is the version and 7 hex of the code: the same code anywhere is one id; a byte, a file or a name changed is another', () => {
  const a = codeId(tree(CODE)), b = codeId(tree(CODE))
  assert.match(a, /^1\.2\.3\+[0-9a-f]{7}$/)
  assert.equal(b, a, 'the same code in another place')
  for (const [why, files] of [['a byte changed', { ...CODE, 'src/off/a.mjs': 'export const a = 3\n' }], ['a file added', { ...CODE, 'src/off/b.mjs': '' }],
    ['a file renamed', { 'bin/trocar.mjs': CODE['bin/trocar.mjs'], 'src/cli/main.mjs': CODE['src/cli/main.mjs'], 'src/off/c.mjs': CODE['src/off/a.mjs'] }]]) {
    const c = codeId(tree(files))
    assert.match(c, /^1\.2\.3\+[0-9a-f]{7}$/, why)
    assert.notEqual(c, a, `${why}: another id`)
  }
  assert.equal(codeId(tree({})), '1.2.3', 'no code to hash: the plain version, never a guess')
})

test('in a git checkout the code id is the version and HEAD\'s first 7, as before', () => {
  const root = tree(CODE), sha = 'ab'.repeat(20)
  fs.mkdirSync(path.join(root, '.git')); fs.writeFileSync(path.join(root, '.git', 'HEAD'), `${sha}\n`)
  assert.equal(codeId(root), `1.2.3+${sha.slice(0, 7)}`)
})

const statusOf = async (s, code, argv) => {
  const io = fakeIo()
  await runStatusCli(argv, { io, home: s.home, platform: 'linux', env: { ...s.sh.env, XDG_RUNTIME_DIR: path.join(s.home, 'run') }, deps: { request: asDaemon(reply(code === undefined ? {} : { code })), socketPath: SOCK, procs: async () => [], lingerRead: () => ({ state: true }), spawn: absentSpawn, exec: recordingExec().run } })
  return io.stdoutText()
}
test('C.3 daemon.runs_this_code and the daemon line: the collector on this code, on other code (said, with trocar install), or saying no code', async () => {
  const s = await installedHome()
  const doc = async (code) => JSON.parse(await statusOf(s, code, ['--json'])).daemon
  assert.deepEqual([(await doc(codeId())).runs_this_code, (await doc('9.9.9+fffffff')).runs_this_code, (await doc(undefined)).runs_this_code], [true, false, null])
  const other = await statusOf(s, '9.9.9+fffffff', [])
  assert.ok(other.includes('9.9.9+fffffff') && other.includes(codeId()), `both codes named:\n${other}`)
  assert.match(other, /trocar install/, 'with the way out')
  assert.ok(!(await statusOf(s, codeId(), [])).includes(codeId()), 'on this code: nothing said about it')
})

test('doctor: a collector on other code is a problem, daemon-other-code, fixed by trocar install; on this code it is not there', async () => {
  const s = await installedHome()
  const run = async (code) => {
    const io = fakeIo()
    await runDoctor(['--json'], { io, home: s.home, platform: 'linux', env: { ...s.sh.env, XDG_RUNTIME_DIR: path.join(s.home, 'run') }, deps: { spawn: absentSpawn, has: () => true, request: asDaemon(reply({ code })), procs: async () => [], lingerRead: () => ({ state: true }), socketPath: SOCK, user: 'alice', exec: recordingExec().run } })
    return JSON.parse(io.stdoutText()).findings || []
  }
  const f = (await run('9.9.9+fffffff')).find((x) => x.code === 'daemon-other-code')
  assert.ok(f && f.class === 'problem', JSON.stringify(f))
  assert.ok(f.commands.some((c) => c.run === 'trocar install'))
  assert.equal((await run(codeId())).some((x) => x.code === 'daemon-other-code'), false)
})
