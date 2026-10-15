// `asight install` on Linux (override #15; 1.6 §1.6 步骤): the CA, asight's own trust files and the (c)-level keys, all phase install, plus asight-off;
// no unit, no state, no daemon. The `on` that follows finds every certificate item intact and touches none of their bytes (D55①).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { runInstallCli } from '../../src/cli/install.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { fakeIo, onCtx, seedClaude, snapshot } from './fixtures/on-ctx.mjs'

const certBytes = (home) => Object.fromEntries(Object.entries(snapshot(home)).filter(([k]) => k.startsWith('.asight/collector/ca/') || k === '.claude/settings.json'))

test('Linux install: CA + trust entries (phase install) + asight-off, no unit, no state; a second install changes nothing; the on after it leaves every certificate byte as install wrote it', async () => {
  const home = tmpDir('asight-install-linux-')
  seedClaude(home)
  const ctx = (io) => ({ ...onCtx(home, io), platform: 'linux' })
  const io = fakeIo()
  assert.equal(await runInstallCli(['--yes'], ctx(io)), 0, io.text())
  const dir = path.join(home, '.asight', 'collector')
  const m = readManifest(dir)
  assert.equal(m.install.state, 'complete')
  assert.ok(m.files.some((f) => f.role === 'ca-key') && m.entries.length > 0)
  assert.deepEqual([...m.entries, ...m.files].filter((x) => x.phase !== 'install'), [], 'every item is phase install')
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false, 'no state: that is on\'s')
  assert.equal(m.files.some((f) => f.role === 'unit'), false, 'no unit: that is on\'s')
  assert.ok(fs.existsSync(path.join(home, '.asight', 'bin', 'asight-off')), 'the standalone undo')
  const certs = certBytes(home)
  const again = fakeIo()
  assert.equal(await runInstallCli(['--yes'], ctx(again)), 0)
  assert.match(again.text(), /已经装好/)
  const onIo = fakeIo()
  assert.equal(await runOnCli(['--yes'], onCtx(home, onIo)), 0, onIo.text())
  assert.deepEqual(certBytes(home), certs, 'on wrote no certificate byte')
})

test('Linux install: no terminal and no --yes → the plan with D55\'s cost line, exit 2, nothing written; --dry-run → exit 0', async () => {
  const home = tmpDir('asight-install-linux-')
  seedClaude(home)
  const before = snapshot(home)
  const io = fakeIo()
  assert.equal(await runInstallCli([], { ...onCtx(home, io), platform: 'linux' }), 2)
  assert.match(io.text(), /代价:证书在时/)
  assert.deepEqual(snapshot(home), before)
  assert.equal(await runInstallCli(['--dry-run'], { ...onCtx(home, fakeIo()), platform: 'linux' }), 0)
  assert.deepEqual(snapshot(home), before)
})
