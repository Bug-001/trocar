// test/cli/place.test.mjs — `trocar place <dir>` (RFC 1.6 §2, V110; D74④): the pointer and launcher it leaves, and what its prune keeps.
// The contracts only: the pointer's bytes, that the launcher runs the version the pointer names, that an unchanged launcher is not rewritten,
// and that the three kept versions (new, previous, install.code) and their pinned Node directories survive while the rest go.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpDir } from '../helpers/tmp.mjs'
import { runPlaceCli } from '../../src/cli/place.mjs'
import { appDir, launcherPath, collectorDir } from '../../src/off/paths.mjs'
import { saveManifest, MANIFEST_VERSION } from '../../src/off/manifest.mjs'

const plat = process.platform === 'win32' ? 'win' : process.platform
const target = `${plat}-${process.arch}`
const io = () => { const err = []; return { err, io: { out: () => {}, err: (s) => err.push(String(s)) } } }

/** A version directory pinning Node `nv`, and that Node directory (its binary echoes its arguments). */
function version(app, v, nv) {
  fs.mkdirSync(path.join(app, v, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(app, v, 'install'), { recursive: true })
  fs.writeFileSync(path.join(app, v, 'bin', 'trocar.mjs'), '')
  fs.writeFileSync(path.join(app, v, 'install', 'node.sha256'), `${'0'.repeat(64)}  node-v${nv}-${target}.tar.xz\n${'1'.repeat(64)}  node-v${nv}-sunos-x64.tar.xz\n`)
  const exe = process.platform === 'win32' ? path.join(app, 'node', `${nv}-${target}`, 'node.exe') : path.join(app, 'node', `${nv}-${target}`, 'bin', 'node')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, '#!/bin/sh\nprintf "%s|" "$@"\n', { mode: 0o755 })
}

test('place switches the pointer, writes a launcher that runs that version, and prunes only what nothing can name', async () => {
  const home = tmpDir("trocar place 'q' ")
  const app = appDir(home)
  version(app, '0.1.0', '22.0.0') // the version the pointer named before
  version(app, '0.1.1', '22.1.0') // the version install last ran on
  version(app, '0.1.2', '22.2.0') // nothing names it
  version(app, '0.1.3', '22.0.0') // the new one, on the same Node as 0.1.0
  fs.mkdirSync(path.join(app, 'node', `9.9.9-${target}`)) // a Node no kept version pins
  fs.writeFileSync(path.join(app, 'current'), `0.1.0 22.0.0-${target}\n`)
  saveManifest(collectorDir(home), { version: MANIFEST_VERSION, entries: [], files: [], install: { code: '0.1.1' } })

  const o = io()
  assert.equal(await runPlaceCli([path.join(app, '0.1.3')], { io: o.io, home }), 0, o.err.join('\n'))
  assert.equal(fs.readFileSync(path.join(app, 'current'), 'utf8'), `0.1.3 22.0.0-${target}\n`)
  assert.deepEqual(fs.readdirSync(app).filter((n) => /^\d/.test(n)).sort(), ['0.1.0', '0.1.1', '0.1.3'])
  assert.deepEqual(fs.readdirSync(path.join(app, 'node')).sort(), [`22.0.0-${target}`, `22.1.0-${target}`])
  if (process.platform !== 'win32') {
    const ran = execFileSync(launcherPath(home), ['a b', 'c'], { encoding: 'utf8' })
    assert.equal(ran, `${path.join(app, '0.1.3', 'bin', 'trocar.mjs')}|a b|c|`)
  }

  const ino = fs.statSync(launcherPath(home)).ino
  assert.equal(await runPlaceCli([path.join(app, '0.1.3')], { io: o.io, home }), 0)
  assert.equal(fs.statSync(launcherPath(home)).ino, ino, 'a launcher with the same bytes is not rewritten')
})

test('a directory that is not a complete version of ~/.trocar/app: exit 1 with a reason, the pointer unchanged', async () => {
  const home = tmpDir('trocar-place-')
  const app = appDir(home)
  version(app, '0.1.0', '22.0.0')
  fs.writeFileSync(path.join(app, 'current'), `0.1.0 22.0.0-${target}\n`)
  fs.mkdirSync(path.join(app, '0.2.0', 'bin'), { recursive: true }) // no trocar.mjs, no pin
  const elsewhere = tmpDir('trocar-place-other-')
  version(elsewhere, '0.3.0', '22.0.0')
  for (const dir of [path.join(app, '0.2.0'), path.join(elsewhere, '0.3.0')]) {
    const o = io()
    assert.equal(await runPlaceCli([dir], { io: o.io, home }), 1)
    assert.ok(o.err.length, 'it says why')
    assert.equal(fs.readFileSync(path.join(app, 'current'), 'utf8'), `0.1.0 22.0.0-${target}\n`)
  }
})
