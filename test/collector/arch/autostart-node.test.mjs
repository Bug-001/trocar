// autostart-node.test.mjs — the one rule for which `node` the login entry names (D61, src/collector/arch/autostart-node.mjs).
// The hazard it exists for, measured on a macOS machine 2026-10-18: the LaunchAgent named
// /opt/homebrew/Cellar/node/26.0.0/bin/node (process.execPath, already resolved) and `brew upgrade node` deletes that
// directory — after the upgrade no daemon starts at login and every harness that is on reaches nothing (D61 forbids it).
// Generated axes (0.1 §3): where PATH's first node points, whether it is this Node at all, and the separator / names of
// the platform. No real tool and no real HOME: the fs is a temp tree made by tmpDir().
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../../helpers/tmp.mjs'
import { execFileSync } from 'node:child_process'
import { autostartNode, autostartProgram } from '../../../src/collector/arch/autostart-node.mjs'
import { appDir, launcherPath } from '../../../src/off/paths.mjs'
import { runPlaceCli, nodeExe } from '../../../src/cli/place.mjs'
import { userUnit as darwinUnit } from '../../../src/collector/arch/darwin/autostart.mjs'
import { userUnit as linuxUnit } from '../../../src/collector/arch/linux/unit.mjs'
import { userUnit as winUnit } from '../../../src/collector/arch/win32/autostart.mjs'

// a tree that looks like Homebrew's: a versioned real file and the stable symlink a package manager keeps repointing
const tree = () => {
  const root = tmpDir('autostart-node')
  const cellar = path.join(root, 'Cellar', 'node', '26.0.0', 'bin')
  fs.mkdirSync(cellar, { recursive: true })
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  const real = path.join(cellar, 'node')
  fs.writeFileSync(real, '#!/bin/sh\n', { mode: 0o755 })
  const link = path.join(root, 'bin', 'node')
  fs.symlinkSync(real, link)
  return { root, real, link }
}

test('the entry names PATH\'s first node, as PATH writes it, when it is this very Node', () => {
  const t = tree()
  assert.equal(autostartNode({ env: { PATH: path.join(t.root, 'bin') }, execPath: t.real, platform: 'darwin' }), t.link,
    'the stable spelling (the symlink) is named, never the resolved version directory a node upgrade deletes')
  // the same answer when the asking Node IS the link: one program, one answer
  assert.equal(autostartNode({ env: { PATH: path.join(t.root, 'bin') }, execPath: t.link, platform: 'darwin' }), t.link)
})

test('anything else is this process\'s own executable: no node on PATH, no PATH at all, a dangling entry, or another Node', () => {
  const t = tree()
  const other = path.join(t.root, 'other')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, 'node'), '#!/bin/sh\n# a different Node\n', { mode: 0o755 })

  assert.equal(autostartNode({ env: { PATH: path.join(t.root, 'empty') }, execPath: t.real, platform: 'darwin' }), t.real, 'no node on PATH')
  assert.equal(autostartNode({ env: {}, execPath: t.real, platform: 'darwin' }), t.real, 'no PATH at all')
  assert.equal(autostartNode({ env: { PATH: `${other}:${path.join(t.root, 'bin')}` }, execPath: t.real, platform: 'darwin' }), t.real,
    'the FIRST node on PATH decides: a different Node means PATH is not ours to name, even with ours further along')
  assert.equal(autostartNode({ env: { PATH: path.join(t.root, 'bin') }, execPath: path.join(t.root, 'gone') }, { platform: 'darwin' }), path.join(t.root, 'gone'),
    'an execPath that cannot be resolved is named as given, never guessed at')
})

test('the platform decides the separator and the names; Path is read like PATH on Windows', () => {
  const t = tmpDir('autostart-node-win')
  fs.mkdirSync(path.join(t, 'bin'), { recursive: true })
  const real = path.join(t, 'bin', 'node.exe')
  fs.writeFileSync(real, 'MZ')
  assert.equal(autostartNode({ env: { Path: `${path.join(t, 'none')};${path.join(t, 'bin')}` }, execPath: real, platform: 'win32' }), real,
    'node.exe is what a Windows PATH entry holds, and `;` separates')
  assert.equal(autostartNode({ env: { PATH: path.join(t, 'bin') }, execPath: real, platform: 'darwin' }), real,
    'on a POSIX platform node.exe is not looked for: the answer is the asking executable')
})

// ---- the script channel (D74): the login entry starts whatever version the pointer names ---------------------------------------------------
// The lab finding it answers (macOS test machine, 2026-11-03): the LaunchAgent named ~/.trocar/app/0.1.0/..., so after `place` switched to
// 0.1.1 the update's restart through the login entry brought 0.1.0 back. Asserted on the written item of every OS: what it names, and (POSIX)
// what running exactly that command line starts.
const target = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
function version(app, v, nv) { // a version directory pinning Node `nv`, whose binary echoes its arguments
  fs.mkdirSync(path.join(app, v, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(app, v, 'install'), { recursive: true })
  fs.writeFileSync(path.join(app, v, 'bin', 'trocar.mjs'), '')
  fs.writeFileSync(path.join(app, v, 'install', 'node.sha256'), `${'0'.repeat(64)}  node-v${nv}-${target}.tar.xz\n`)
  const exe = nodeExe(app, `${nv}-${target}`)
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, '#!/bin/sh\nprintf "%s|" "$@"\n', { mode: 0o755 })
}
const quiet = { out: () => {}, err: () => {} }

test('script channel: the login entry each OS writes names the launcher, so after place switches versions it starts the new one', async () => {
  const home = tmpDir("autostart script 'q' ")
  const app = appDir(home)
  version(app, '0.1.0', '22.0.0')
  assert.equal(await runPlaceCli([path.join(app, '0.1.0')], { io: quiet, home }), 0)
  // the copy that runs `install`: the private Node and the versioned script of 0.1.0
  const asked = { home, node: nodeExe(app, `22.0.0-${target}`), script: path.join(app, '0.1.0', 'bin', 'trocar.mjs'), env: { PATH: '' } }
  const items = {
    darwin: darwinUnit({ ...asked, uid: 501 }).text({}),
    linux: linuxUnit(asked).text({}),
    win32: winUnit({ ...asked, user: 'H\\ada' }).text(),
  }
  version(app, '0.1.1', '22.1.0') // what update's --stage leaves, then its place
  assert.equal(await runPlaceCli([path.join(app, '0.1.1')], { io: quiet, home }), 0)
  for (const [os, text] of Object.entries(items)) {
    assert.ok(text.includes(launcherPath(home, os)), `${os}: the item names ${launcherPath(home, os)}`)
    assert.ok(!text.includes(path.join(app, '0.1.0')) && !text.includes(path.join(app, 'node')), `${os}: the item names no version directory and no private Node`)
  }
  if (process.platform === 'win32') return
  const plistArgs = [...items.darwin.split('<key>ProgramArguments</key>')[1].split('</array>')[0].matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1].replace(/&amp;/g, '&'))
  const execStart = /^ExecStart=(.*)$/m.exec(items.linux)[1].match(/"(?:[^"\\]|\\.)*"|\S+/g).map((w) => w.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1'))
  for (const [prog, ...args] of [plistArgs, execStart]) {
    assert.equal(execFileSync(prog, args, { encoding: 'utf8' }), `${path.join(app, '0.1.1', 'bin', 'trocar.mjs')}|daemon|`, 'the item starts the version the pointer names now')
  }
})

test('any other copy (npm, a checkout): the entry stays node + that copy\'s script', () => {
  const home = tmpDir('autostart-npm')
  const script = path.join(home, 'lib', 'node_modules', 'trocar-cli', 'bin', 'trocar.mjs')
  assert.deepEqual(autostartProgram({ home, node: process.execPath, script, env: {} }), [process.execPath, script])
})
