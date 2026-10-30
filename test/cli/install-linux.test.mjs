// `trocar install` on Linux (override #15; 1.6 §1.6 步骤): the CA, trocar's own trust files and the (c)-level keys, all phase install, plus trocar-off,
// and (D61) the login unit, enabled, with the daemon up; no state: that is `on`'s. The `on` that follows finds every certificate item intact and touches none of their bytes (D55①).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertEnglish } from '../helpers/english.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { runInstallCli } from '../../src/cli/install.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { fakeIo, fakeSystem, onCtx, seedClaude, snapshot, changedFiles } from './fixtures/on-ctx.mjs'
import { unitPath, UNIT_NAME } from '../../src/collector/arch/linux/unit.mjs'

const certBytes = (home) => Object.fromEntries(Object.entries(snapshot(home)).filter(([k]) => k.startsWith('.trocar/collector/ca/') || k === '.claude/settings.json'))

test('Linux install: CA + trust entries (phase install) + trocar-off, no unit, no state; a second install changes nothing; the on after it leaves every certificate byte as install wrote it', async () => {
  const home = tmpDir('trocar-install-linux-')
  seedClaude(home)
  const ctx = (io) => ({ ...onCtx(home, io), platform: 'linux' })
  const io = fakeIo()
  assert.equal(await runInstallCli(['--yes'], ctx(io)), 0, io.text())
  // R1: the receipt says each user file it changed — path, what was changed, where the backup is — not only the plan before the yes
  const receipt = io.text().slice(io.text().indexOf("Installed. trocar's certificates are in place."))
  assert.match(receipt.replace(/\s+/g, ' '), /~\/\.claude\/settings\.json env\.NODE_EXTRA_CA_CERTS added \(backup/, receipt)
  assert.match(receipt, /trocar's own files: .*trocar-off/, receipt)
  assertEnglish(io.text(), 'the Linux install plan and receipt')
  const dir = path.join(home, '.trocar', 'collector')
  const m = readManifest(dir)
  assert.equal(m.install.state, 'complete')
  assert.ok(m.files.some((f) => f.role === 'ca-key') && m.entries.length > 0)
  assert.deepEqual([...m.entries, ...m.files].filter((x) => x.phase !== 'install'), [], 'every item is phase install')
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false, 'no state: that is on\'s')
  assert.ok(fs.existsSync(path.join(home, '.trocar', 'bin', 'trocar-off')), 'the standalone undo')
  const certs = certBytes(home)
  const again = fakeIo()
  assert.equal(await runInstallCli(['--yes'], ctx(again)), 0)
  assert.match(again.text(), /^Already installed\. Nothing was changed\.$/m); assertEnglish(again.text(), 'the second install')
  const onIo = fakeIo()
  assert.equal(await runOnCli(['--yes'], onCtx(home, onIo)), 0, onIo.text())
  assert.deepEqual(certBytes(home), certs, 'on wrote no certificate byte')
})

// D61 (4.6 「用户级自启单元」, 1.6 §3.2 步骤 5): registering the login entry and pulling the daemon up is install's, not on's — through the
// one seam (ensureDaemonUp), so `--now` is only asked for when nothing answers (拉起不是重启, R8).
test('Linux install writes the systemd user unit and enables it with --now when no daemon answers; with one up it enables without --now', async () => {
  const home = tmpDir('trocar-install-unit-')
  seedClaude(home)
  const down = fakeSystem({ up: false }) // nothing answers the control socket yet: the unit is enabled AND started
  const io = fakeIo()
  assert.equal(await runInstallCli(['--yes'], { ...onCtx(home, io, { exec: down.exec, daemon: down.daemon }), platform: 'linux' }), 0, io.text())
  assert.equal(fs.existsSync(unitPath(home)), true, 'the unit file install wrote')
  assert.equal(readManifest(path.join(home, '.trocar', 'collector')).files.some((f) => f.role === 'unit' && f.path === unitPath(home) && f.phase === 'install'), true, 'listed in the manifest, phase install')
  assert.deepEqual(down.exec.calls.filter((c) => /--user enable /.test(c)), [`systemctl --user enable --now ${UNIT_NAME}`])
  const other = tmpDir('trocar-install-unit-up-')
  seedClaude(other)
  const up = fakeSystem({ up: true })
  const again = fakeIo()
  assert.equal(await runInstallCli(['--yes'], { ...onCtx(other, again, { exec: up.exec, daemon: up.daemon }), platform: 'linux' }), 0, again.text())
  assert.deepEqual(up.exec.calls.filter((c) => /--user enable /.test(c)), [`systemctl --user enable ${UNIT_NAME}`], 'a daemon that already answers is not started a second time')
})

test('Linux install: no terminal and no --yes → the plan with D55\'s cost line, exit 2, nothing written; --dry-run → exit 0', async () => {
  const home = tmpDir('trocar-install-linux-')
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
  const home = tmpDir('trocar-install-linux-')
  seedClaude(home)
  const before = snapshot(home)
  const io = fakeIo()
  assert.equal(await runOnCli(['--yes'], onCtx(home, io)), 1)
  assert.match(io.text(), /trocar install/)
  assert.deepEqual(snapshot(home), before, 'not a byte: no CA, no settings key, no unit, no state.json')
  const j = fakeIo()
  assert.equal(await runOnCli(['--yes', '--json'], onCtx(home, j)), 1)
  assert.equal(j.json().error.code, 'cert-not-installed')
  assert.deepEqual(snapshot(home), before)
})

// The other half of D55⑥: an install whose certificate item is gone (the user took trocar's key out of settings.json by hand) is not rewritten by `on`;
// on names it and says to run install.
test('Linux on after install with a certificate item gone: on leaves it gone, exit 1, and says the way back is off, install, on', async () => {
  const home = tmpDir('trocar-install-linux-')
  seedClaude(home)
  assert.equal(await runInstallCli(['--yes'], { ...onCtx(home, fakeIo()), platform: 'linux' }), 0)
  const settings = path.join(home, '.claude', 'settings.json')
  fs.writeFileSync(settings, '{"model":"x"}\n')
  const io = fakeIo()
  assert.equal(await runOnCli(['--yes'], onCtx(home, io)), 1, io.text())
  assert.match(io.text(), /"trocar off", then "trocar install" and "trocar on"/, 'the way back is install\'s')
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"model":"x"}\n', 'on did not write the key')
})

// D61 (1.6 §3.2 step 5 and exit codes, §3.3): a Linux box where systemctl --user has no manager to ask — the answers are systemctl 255's on Ubuntu 24.04
// with no user bus (measured 2026-10-30): exit 1, no state on stdout, the reason on stderr. The login entry is an install item like any other: not
// registered = install not finished (exit 1, `autostart.enabled: false`), and `on` refuses with the reason it could not be read. Once a manager answers,
// the same `trocar install` — the fix line of that refusal — registers it, though every certificate item is already in place, and `on` goes on.
test('Linux install with no systemd --user: exit 1, the entry not enabled and said as a problem; on refuses it as unreadable; once a manager answers, install again registers it and on goes on', async () => {
  const home = tmpDir('trocar-install-nobus-')
  seedClaude(home)
  let manager = false
  const sys = fakeSystem({ up: false })
  const run = (file, args) => {
    const cmd = [file, ...args].join(' ')
    if (!manager && file === 'systemctl') { sys.exec.calls.push(cmd); return { status: 1, stdout: '', stderr: 'Failed to connect to bus: No such file or directory' } }
    return sys.exec.run(file, args)
  }
  const ctx = (io) => ({ ...onCtx(home, io, { exec: { run }, daemon: sys.daemon }), platform: 'linux' })
  const io = fakeIo()
  assert.equal(await runInstallCli(['--yes', '--json'], ctx(io)), 1, io.text())
  const r = io.json()
  assert.deepEqual([r.ok, r.autostart.enabled, r.autostart.entry, r.daemon.state], [false, false, unitPath(home), 'not-running'], io.text())
  const problem = r.problems.find((p) => /Failed to connect to bus/.test(p))
  assert.ok(problem, `the reason is systemctl's own: ${JSON.stringify(r.problems)}`)
  assert.ok(!r.notes.includes(problem), 'said once, as a problem')
  const certs = certBytes(home)

  const before = snapshot(home)
  const refused = fakeIo()
  assert.equal(await runOnCli(['--yes', '--json'], ctx(refused)), 2, refused.text())
  assert.equal(refused.json().error.code, 'autostart-missing')
  assert.match(refused.json().error.message, /Failed to connect to bus/, 'with systemctl\'s own reason (the unreadable answer: unit.test.mjs)')
  assert.deepEqual(changedFiles(before, snapshot(home)).filter((f) => !f.startsWith('.trocar/collector/flows/')), [], 'not a byte but the refusal\'s own record')

  manager = true
  const again = fakeIo()
  assert.equal(await runInstallCli(['--yes'], ctx(again)), 0, again.text())
  assert.ok(sys.exec.calls.includes(`systemctl --user enable --now ${UNIT_NAME}`), `the second install registers the entry (${sys.exec.calls.join(' | ')})`)
  assert.deepEqual(certBytes(home), certs, 'and writes no certificate byte')
  assertEnglish(again.text(), 'the install that registers the entry again')
  const on = fakeIo()
  assert.equal(await runOnCli(['--yes'], onCtx(home, on, { exec: { run }, daemon: sys.daemon })), 0, on.text())
})
