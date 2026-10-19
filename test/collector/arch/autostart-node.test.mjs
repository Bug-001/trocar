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
import { autostartNode } from '../../../src/collector/arch/autostart-node.mjs'

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
