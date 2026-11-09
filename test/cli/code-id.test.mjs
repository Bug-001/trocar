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
import { readManifest, saveManifest } from '../../src/off/manifest.mjs'

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
  // what a build writes beside the code (the outputs a .gitignore there names) and what the OS or an editor leaves (dotfiles) is not code
  const IGNORE = { 'src/arch/.gitignore': '# build outputs\nbpf/*.o\nbpf/vmlinux.h\nhelper\n' }
  const built = codeId(tree({ ...CODE, ...IGNORE }))
  assert.equal(codeId(tree({ ...CODE, ...IGNORE, 'src/arch/bpf/redirect.o': 'ELF', 'src/arch/bpf/vmlinux.h': '', 'src/arch/helper': 'ELF', 'src/.DS_Store': 'x', 'src/off/.a.mjs.swp': 'x' })), built, 'a build beside the code: the same id')
  // a packed copy carries no .gitignore (npm never packs one): the outputs named in the shipped build-outputs file keep the id there too
  const PACKED = { 'src/arch/build-outputs': 'bpf/*.o\nbpf/vmlinux.h\nhelper\n' }
  const packed = codeId(tree({ ...CODE, ...PACKED }))
  assert.equal(codeId(tree({ ...CODE, ...PACKED, 'src/arch/bpf/redirect.o': 'ELF', 'src/arch/bpf/vmlinux.h': '', 'src/arch/helper': 'ELF' })), packed, 'a helper build in a packed copy: the same id')
  // every file that ships counts, whatever its name: a shell shim with no extension, the board's page and styles
  for (const [rel, text] of [['src/shims/kimi', '#!/bin/sh\n'], ['src/web/index.html', '<p>'], ['src/web/a.css', 'p{}'], ['src/arch/bpf/redirect.c', 'int x;']]) {
    assert.notEqual(codeId(tree({ ...CODE, ...IGNORE, [rel]: text })), built, `${rel}: a file that ships changes the id`)
  }
})

test('every build-outputs file names what the .gitignore beside it names (one for every channel, one for git)', () => {
  const pats = (t) => t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).sort()
  const src = new URL('../../src/', import.meta.url)
  const found = fs.readdirSync(src, { recursive: true }).filter((rel) => path.basename(rel) === 'build-outputs')
  assert.ok(found.length >= 1, 'the Linux helper names its outputs')
  for (const rel of found) assert.deepEqual(pats(fs.readFileSync(new URL(rel, src), 'utf8')), pats(fs.readFileSync(new URL(path.join(path.dirname(rel), '.gitignore'), src), 'utf8')), rel)
})

test('the daemon\'s way, without holding the event loop, gives the same id', async () => {
  const { codeIdAsync } = await import('../../src/version.mjs')
  for (const files of [CODE, {}]) { const root = tree(files), r2 = tree(files); assert.equal(await codeIdAsync(root), codeId(r2)) }
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
  const other = await statusOf(s, '9.9.9+fffffff', ['--details']) // the codes are facts of --details (1.6 §1.1 ④)
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

// §3.5 · §3.7: after a git pull by hand the last install ran other code, and `trocar update` is the one way out (install cannot redo on's entries);
// a service another copy started, with this code installed, stays `trocar install`'s
test('a service on other code after a pull by hand: status and doctor say trocar update; with this code installed, trocar install', async () => {
  const s = await installedHome()
  const dir = path.join(s.home, '.trocar', 'collector')
  const doctorFix = async () => {
    const io = fakeIo()
    await runDoctor(['--json'], { io, home: s.home, platform: 'linux', env: { ...s.sh.env, XDG_RUNTIME_DIR: path.join(s.home, 'run') }, deps: { spawn: absentSpawn, has: () => true, request: asDaemon(reply({ code: '9.9.9+fffffff' })), procs: async () => [], lingerRead: () => ({ state: true }), socketPath: SOCK, user: 'alice', exec: recordingExec().run } })
    return ((JSON.parse(io.stdoutText()).findings || []).find((x) => x.code === 'daemon-other-code') || { commands: [] }).commands.map((c) => c.run)
  }
  const said = async () => [await statusOf(s, '9.9.9+fffffff', []), await statusOf(s, '9.9.9+fffffff', ['--details'])]
  assert.deepEqual(await doctorFix(), ['trocar install'], 'this code installed: another copy started the service')
  const m = readManifest(dir); m.install = { ...m.install, code: '0.0.1+0000000' }; saveManifest(dir, m)
  assert.deepEqual(await doctorFix(), ['trocar update'], 'install ran older code: update is the way out')
  for (const text of await said()) { assert.match(text, /trocar update/, text); assert.doesNotMatch(text, /Put it on this code: trocar install/, text) }
})
