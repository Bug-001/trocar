// `asight install` on Linux (override #15; 1.6 §1.6 步骤): the CA, asight's own trust files and the (c)-level keys, all phase install, plus asight-off;
// no unit, no state, no daemon. The `on` that follows finds every certificate item intact and touches none of their bytes (D55①).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertEnglish } from '../helpers/english.mjs'
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
  // R1: the receipt says each user file it changed — path, what was changed, where the backup is — not only the plan before the yes
  const receipt = io.text().slice(io.text().indexOf("Installed. asight's certificates are in place."))
  assert.match(receipt.replace(/\s+/g, ' '), /~\/\.claude\/settings\.json env\.NODE_EXTRA_CA_CERTS added \(backup/, receipt)
  assert.match(receipt, /asight's own files: .*asight-off/, receipt)
  assertEnglish(io.text(), 'the Linux install plan and receipt')
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
  assert.match(again.text(), /^Already installed\. Nothing was changed\.$/m); assertEnglish(again.text(), 'the second install')
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
  assert.match(io.text(), /^While installed, programs you run trust certificates issued by this/m)
  assertEnglish(io.text(), 'the Linux install plan')
  assert.deepEqual(snapshot(home), before)
  assert.equal(await runInstallCli(['--dry-run'], { ...onCtx(home, fakeIo()), platform: 'linux' }), 0)
  assert.deepEqual(snapshot(home), before)
})

// D55⑥ / override #15 (1.6 §1.1): on never writes a certificate, so it never installs silently. Red before T20 6/6: the first `on` made the CA and wrote every entry.
test('Linux on without an install record: cert-not-installed, exit 1, nothing written (no CA, no entry, no unit, no state); with --json the receipt carries the code', async () => {
  const home = tmpDir('asight-install-linux-')
  seedClaude(home)
  const before = snapshot(home)
  const io = fakeIo()
  assert.equal(await runOnCli(['--yes'], onCtx(home, io)), 1)
  assert.match(io.text(), /asight install/)
  assert.deepEqual(snapshot(home), before, 'not a byte: no CA, no settings key, no unit, no state.json')
  const j = fakeIo()
  assert.equal(await runOnCli(['--yes', '--json'], onCtx(home, j)), 1)
  assert.equal(j.json().code, 'cert-not-installed')
  assert.deepEqual(snapshot(home), before)
})

// The other half of D55⑥: an install whose certificate item is gone (the user took asight's key out of settings.json by hand) is not rewritten by `on`;
// on names it and says to run install.
test('Linux on after install with a certificate item gone: on leaves it gone, exit 1, and says the way back is off, install, on', async () => {
  const home = tmpDir('asight-install-linux-')
  seedClaude(home)
  assert.equal(await runInstallCli(['--yes'], { ...onCtx(home, fakeIo()), platform: 'linux' }), 0)
  const settings = path.join(home, '.claude', 'settings.json')
  fs.writeFileSync(settings, '{"model":"x"}\n')
  const io = fakeIo()
  assert.equal(await runOnCli(['--yes'], onCtx(home, io)), 1, io.text())
  assert.match(io.text(), /"asight off", then "asight install" and "asight on"/, 'the way back is install\'s')
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"model":"x"}\n', 'on did not write the key')
})
