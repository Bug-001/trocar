// `trocar install` (RFC 1.6 §1.1, §1.6): its own command; root refused before anything is read; a v2 manifest refused before any write;
// no terminal and no --yes → the plan only, exit 2, nothing written; --yes → the model install, its receipt and an install-note; exit 0 / 1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertEnglish } from '../helpers/english.mjs'
import fs from 'node:fs'
import tls from 'node:tls'
import path from 'node:path'
import { runInstallCli } from '../../src/cli/install.mjs'
import { commandNamed } from '../../src/cli/commands.mjs'
import { modelWorld } from '../helpers/model-world.mjs'
import { unservable } from '../helpers/model-daemon.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { ERROR_CODES } from '../../src/cli/json.mjs'
import { CUSTODY_FAILED, custodyPreflight } from '../../src/collector/model-install.mjs'
import { backendsFor } from '../../src/collector/arch/model-backends.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { BOARD_RANGE } from '../../src/collector/core/ingress-config.mjs'
import { onCtx, snapshot, recordingExec } from './fixtures/on-ctx.mjs'
import { runUninstall } from '../../src/cli/uninstall.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { setupOf } from '../../src/collector/core/proxymode/status-facts.mjs'
import { findingFor } from '../../src/netenv/findings.mjs'
import { BLOCK_OPEN, BLOCK_END } from '../../src/off/text-edit.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { runOff } from '../../src/off/orchestrate.mjs'
import { startControlServer } from '../../src/collector/core/control.mjs'
import { formatRefusal, markedRefusal } from '../../src/cli/receipt.mjs'

function fakeIo({ tty = false } = {}) {
  const out = [], err = []
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: tty }, stdout: { isTTY: tty }, stderr: {}, text: () => [...out, ...err].join('\n'), json: () => JSON.parse(out.join('\n')) }
}
/** launchctl as a recording fake: install registers and starts the LaunchAgent (D61), and no test may run the real tool (0.1 §3). */
function fakeLaunchctl() {
  const calls = []
  return { calls, run: (file, args) => { calls.push([file, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' } } }
}
async function cli(argv, { tty = false, over = {}, setup = null } = {}) {
  const w = await modelWorld({ commands: ['codex'] })
  if (setup) setup(w)
  const io = fakeIo({ tty })
  const launchctl = fakeLaunchctl()
  // the control endpoint a daemon publishes (arch/darwin/control-path.mjs): without the file the CLI has no socket to ask, so the
  // probe below would never be asked anything and a started daemon could not be seen
  const { controlEndpoint } = await import('../../src/collector/arch/darwin/control-path.mjs')
  const endpoint = () => controlEndpoint({ dir: w.dir }) // called below only when this run gets as far as writing: as root nothing may appear under ~/.trocar
  // nothing answers until the registration started it: the first probe is ENOENT, the ones after it answer (D61: install registers AND starts)
  let probes = 0
  const deps = { getuid: () => 501, exec: launchctl.run, request: async () => { if (probes++ === 0) throw Object.assign(new Error('nothing answers yet'), { code: 'ENOENT' }); return {} }, sleep: async () => {}, launchctl, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, ...over }
  if ((over.getuid ? over.getuid() : 501) !== 0) endpoint()
  const exit = await runInstallCli(argv, { io, env: w.env, home: w.home, platform: 'darwin', deps })
  return { w, io, exit, launchctl: deps.launchctl || launchctl }
}

test('0.1 §3: what is installed is asked of the world the test gives, never of the machine under the test', async () => {
  const app = '/Applications/Kimi Code.app'
  const { io } = await cli(['--dry-run', '--json'], { setup: (w) => { const { exists } = w.ctx; w.ctx.exists = (p) => p === app || exists(p) } })
  assert.ok(io.json().planned.some((r) => r.harness === 'kimi-code'))
})

test('install is a command of its own (and the hidden `collector install` alias is gone, 1.6 §2: one feature, one name)', () => {
  assert.ok(commandNamed('install'))
  assert.equal(commandNamed('collector'), undefined)
})

test('1.6 §1.5: as root, install refuses before it reads anything — exit 2 with the manual\'s one line, no ~/.trocar', async () => {
  const { w, exit, io } = await cli(['--yes'], { over: { getuid: () => 0 } })
  assert.equal(exit, 2)
  assert.match(io.text(), /^trocar install: run this as your own user, not as root\.$/m)
  assertEnglish(io.text(), 'the root refusal')
  assert.equal(fs.existsSync(path.join(w.home, '.trocar')), false)
})

test('1.6 §1.6: no terminal and no --yes → the plan (cost and residual-risk lines) and exit 2, nothing written; --dry-run → exit 0, nothing written', async () => {
  const a = await cli([])
  assert.equal(a.exit, 2)
  assert.match(a.io.text(), /^While installed, programs you run trust certificates issued by this/m) // the cost line (§3.2)
  assert.match(a.io.text(), /^Any program running as you can ask trocar to issue a trusted certificate/m) // the residual risk of a same-user root
  assert.match(a.io.text(), /^  codex +reads your user trust store$/m, 'every agent found is a line of the plan')
  assert.match(a.io.text(), /Nothing was changed\. Read the plan above, then run it again with --yes/)
  assertEnglish(a.io.text(), 'the install plan')
  assert.equal(fs.existsSync(path.join(a.w.home, '.trocar', 'collector', 'install-manifest.json')), false)
  const b = await cli(['--dry-run'])
  assert.equal(b.exit, 0)
  assert.equal(fs.existsSync(path.join(b.w.home, '.trocar', 'collector', 'install-manifest.json')), false)
})

test('4.11 ⑰: a version 2 manifest is refused before any write — exit 1, the file as it was', async () => {
  const w = await modelWorld()
  const f = path.join(w.home, '.trocar', 'collector', 'install-manifest.json')
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ version: 2, entries: [], files: [] }))
  const io = fakeIo()
  assert.equal(await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform: 'darwin', deps: { getuid: () => 501 } }), 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).version, 2)
})

test('install --yes --json: the receipt (fingerprint, carriers, residual risk, commands) and an install-note; exit 0; a declined root store → exit 1', async () => {
  const { w, io, exit, launchctl } = await cli(['--yes', '--json'])
  assert.equal(exit, 0, io.text())
  const r = io.json()
  assert.deepEqual([r.command, r.ok, typeof r.fp256, r.commands.includes('trocar uninstall')], ['install', true, 'string', true])
  // D61: install registers the login autostart, enables it (an `enable` clears a disable an earlier version left) and starts the daemon now
  assert.deepEqual(launchctl.calls.filter((c) => /enable|bootstrap/.test(c)), ['launchctl enable gui/501/com.trocar.collector', `launchctl bootstrap gui/501 ${path.join(w.home, 'Library', 'LaunchAgents', 'com.trocar.collector.plist')}`], launchctl.calls.join(' | '))
  assert.deepEqual([r.daemon.state, r.daemon.started], ['running', true])
  // 附录 C.2: the receipt confirms the login entry it registered, and carries no key C.2 does not name (H-1)
  assert.deepEqual(r.autostart, { entry: path.join(w.home, 'Library', 'LaunchAgents', 'com.trocar.collector.plist'), enabled: true })
  assert.deepEqual(validateReceipt(r), [])
  const day = fs.readdirSync(path.join(w.dir, 'flows')).find((n) => n.endsWith('.ndjson'))
  assert.ok(fs.readFileSync(path.join(w.dir, 'flows', day), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).some((e) => e.event === 'install-note' && e.kind === 'result'))
  w.store.answer = 'declined'
  const again = await cli(['--yes'])
  again.w.store.answer = 'declined'
  const io2 = fakeIo()
  assert.equal(await runInstallCli(['--yes'], { io: io2, env: again.w.env, home: tmpHomeOf(again.w), platform: 'darwin', deps: { getuid: () => 501, unit: null, backends: { custody: again.w.custody, rootStore: again.w.store, dirs: again.w.ctx.dirs }, ctx: again.w.ctx, harnesses: [], owns: again.w.owns } }), 1)
})
const tmpHomeOf = () => tmpDir('trocar-model-2-') // a second HOME, made where the leak guard sweeps

// 1.6 §3.3 / 附录 C.2: `autostart.enabled` is the login entry asked again after the run, not "no error was seen". A daemon that holds the control
// socket and does not answer stops the run before anything is registered; launchd then has no such job, and the receipt must not say it starts at login.
test('install: a daemon that does not answer stops the run before the login entry is registered, and the receipt says it is not enabled', async () => {
  let loaded = false
  const launchctl = { calls: [], run: (file, args) => { launchctl.calls.push([file, ...args].join(' ')); if (args[0] === 'bootstrap') loaded = true; return args[0] === 'print' && !loaded ? { status: 113, stdout: '', stderr: 'Could not find service' } : { status: 0, stdout: '', stderr: '' } } }
  const { io, exit } = await cli(['--yes', '--json'], { over: { launchctl, exec: launchctl.run, request: async () => { throw Object.assign(new Error('timed out after 2000 ms'), { code: 'ETIMEDOUT' }) } } })
  assert.equal(exit, 1, io.text())
  const r = io.json()
  assert.deepEqual([r.ok, r.autostart.enabled, r.daemon.state], [false, false, 'not-responding'])
  assert.equal(launchctl.calls.some((c) => / bootstrap /.test(c)), false, 'nothing was registered')
  assert.deepEqual(validateReceipt(r), [])
})

// 4.11 P4: the LaunchAgent plist under trocar's label is trocar's by its place; one no record lists, holding someone else's bytes, is replaced —
// the plan says so, and the bytes that were there are kept in the backup folder first, byte for byte
test('4.11 P4 · darwin: a plist under trocar\'s label that no record lists is backed up byte for byte, then replaced, and the plan says it replaces it', async () => {
  const old = Buffer.from('<?xml version="1.0"?>\n<plist><dict><key>Label</key><string>someone else</string></dict></plist>\n')
  const plist = (w) => path.join(w.home, 'Library', 'LaunchAgents', 'com.trocar.collector.plist')
  const setup = (w) => { fs.mkdirSync(path.dirname(plist(w)), { recursive: true }); fs.writeFileSync(plist(w), old) }
  const backups = (w) => { const d = path.join(w.home, '.trocar', 'backup'); return fs.existsSync(d) ? fs.readdirSync(d).map((n) => fs.readFileSync(path.join(d, n))) : [] }
  const dry = await cli(['--dry-run', '--json'], { setup })
  const row = dry.io.json().planned.find((p) => p.what === 'autostart')
  assert.ok(row && row.detail.includes(path.join('~', '.trocar', 'backup')), `the plan names where the old bytes go: ${JSON.stringify(row)}`)
  assert.ok(fs.readFileSync(plist(dry.w)).equals(old), 'the dry run wrote nothing')
  const { w, io, exit } = await cli(['--yes', '--json'], { setup })
  assert.equal(exit, 0, io.text())
  assert.ok(backups(w).some((b) => b.equals(old)), 'the old bytes are in the backup folder')
  const now = fs.readFileSync(plist(w))
  assert.ok(!now.equals(old) && now.includes('<string>com.trocar.collector</string>'), 'the plist is trocar\'s')
  assert.ok(JSON.parse(fs.readFileSync(path.join(w.dir, 'install-manifest.json'), 'utf8')).files.some((f) => f.path === plist(w) && f.role === 'unit'), 'and the record lists it')
  // the whole cycle: the replaced bytes were an older trocar's entry, so uninstall drops that backup with every other one (1.6 §3.6) and leaves no plist
  const { runUninstall } = await import('../../src/cli/uninstall.mjs')
  const { recordingExec } = await import('./fixtures/on-ctx.mjs')
  const u = await runUninstall({ home: w.home, env: w.env, yes: true, deps: { platform: 'darwin', exec: recordingExec().run, custody: w.custody, procs: async () => [], sleep: async () => {}, drainMs: 0, getuid: () => 501 } })
  assert.equal(u.exit, 0, JSON.stringify(u.receipt))
  assert.deepEqual([backups(w), fs.existsSync(plist(w))], [[], false], 'no backup and no plist at trocar\'s path after uninstall')
})

// the documented order — install, then on — through the CLI: install writes the root, its carriers and
// the inert autostart unit; on enables the unit, which starts the REAL daemon (test/helpers/model-daemon.mjs), asks it for the doors and writes the entries.
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: install then on through the CLI (temp HOME, stub backends) — on starts: exit 0, the doors' entries written`, { skip: await unservable(platform), timeout: 30_000 }, async () => {
    const { runOnCli } = await import('../../src/cli/on.mjs')
    const { liveUnit, withScratchCwd } = await import('../helpers/model-daemon.mjs')
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    const box = await liveUnit({ w, platform })
    const deps = { getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit: box.unit }
    await withScratchCwd(platform, async () => { // install already starts the daemon (enable --now), so it runs in the scratch cwd too
      try {
        const io = fakeIo()
        assert.equal(await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform, deps }), 0, io.text())
        const io2 = fakeIo()
        // `on` asks the OS for the process table once (D62: the op lock's identity question comes out of it) — injected here, this platform being
        // simulated: an empty table (boot time, no rows) is what a machine with nothing on it would print.
        const exec = (file, args) => ({ status: 0, stdout: /ForEach-Object/.test([file, ...args].join(' ')) ? 'boot 1740000000000\n' : '', stderr: '' })
        const exit = await runOnCli(['--yes'], { io: io2, env: w.env, home: w.home, platform, deps: { ...deps, parts: box.parts, exec, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 25))) } })
        assert.equal(exit, 0, io2.text())
        assert.doesNotMatch(io2.text(), /ca\.key|CA is unusable/, 'the old on refusing the model install\'s root (the finding) is gone')
        assert.match(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'), /127\.0\.0\.1:\d+/, 'codex\'s entry holds its door')
        const m = JSON.parse(fs.readFileSync(path.join(w.dir, 'install-manifest.json'), 'utf8'))
        assert.ok(m.files.some((f) => f.role === 'unit' && f.phase === 'install'), 'the unit is install\'s item')
      } finally { await box.stop() }
    })
  })
}

// macOS test machine, 2026-10-18: in a HOME with no login keychain the signing helper reports "A default keychain could not be found" and `install`
// exited 70 with the stack of that throw. A custody that cannot be used is a stated refusal: exit 1, `error.code` from the closed set
// (src/cli/json.mjs ERROR_CODES), and a sentence that says what the reader has to do. Driven with a custody stand-in that fails the same way.
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: a key custody that cannot be used is a refusal — exit 1, error.code, and what to do; never a stack`, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    w.custody.switches.failed = true
    const deps = { getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit: null }
    const io = fakeIo()
    const exit = await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform, deps })
    assert.equal(exit, 1, io.text())
    assertEnglish(io.text(), 'the refusal of an install whose key custody failed')
    assert.match(io.text(), /trocar install/, 'it names what to run once the custody can be used')
    const j = fakeIo()
    assert.equal(await runInstallCli(['--yes', '--json'], { io: j, env: w.env, home: w.home, platform, deps }), 1, j.text())
    const doc = j.json()
    assert.equal(doc.ok, false)
    assert.ok(ERROR_CODES.includes(doc.error.code), `error.code is in the closed set: ${JSON.stringify(doc.error)}`)
    assert.ok(doc.error.message.includes('trocar install'), doc.error.message)
    assert.equal(doc.fp256, null, 'no root was made')
  })
}

// the refusal is asked before the first write: a custody that cannot be used leaves the HOME as it was — no trocar-off, no record, no login entry
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: an install whose key custody cannot be used writes nothing, with the same exit and error.code`, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    w.custody.switches.failed = true
    const exec = fakeLaunchctl()
    const { userUnit } = await import(`../../src/collector/arch/${platform}/autostart.mjs`)
    const unit = userUnit({ home: w.home, node: process.execPath, script: '/repo/bin/trocar.mjs', run: exec.run, env: w.env, spawn: () => assert.fail('nothing is started') })
    const deps = { getuid: () => 501, exec: exec.run, request: async () => { throw Object.assign(new Error('nothing answers'), { code: 'ENOENT' }) }, sleep: async () => {}, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit }
    const before = snapshot(w.home)
    const io = fakeIo()
    assert.equal(await runInstallCli(['--yes', '--json'], { io, env: w.env, home: w.home, platform, deps }), 1, io.text())
    assert.equal(io.json().error.code, CUSTODY_FAILED)
    assert.deepEqual(validateReceipt(io.json()), [])
    assert.equal(io.json().undo, null, 'nothing was installed, so there is nothing to undo')
    for (const k of ['standalone', 'residual_risk']) assert.equal(k in io.json(), false, `${k}: about an install that did not happen`)
    assert.deepEqual(snapshot(w.home), before, 'the HOME is byte for byte as it was')
    // a dry run says the run's refusal in `blocked` (C.2), and no plan is offered for a run that would refuse: without --yes it is the run's receipt
    const d = fakeIo()
    assert.equal(await runInstallCli(['--dry-run', '--json'], { io: d, env: w.env, home: w.home, platform, deps }), 0, d.text())
    assert.equal(d.json().error.code, CUSTODY_FAILED)
    assert.ok(d.json().blocked.length, d.text())
    assert.deepEqual(validateReceipt(d.json()), [])
    const p = fakeIo()
    assert.equal(await runInstallCli(['--json'], { io: p, env: w.env, home: w.home, platform, deps }), 1, p.text())
    assert.equal(p.json().error.code, CUSTODY_FAILED)
    assert.deepEqual(snapshot(w.home), before, 'the plan and the dry run wrote nothing either')
  })
}

// two installs that overlap (update's install and the user's, or the board's Set up): the answer asked before the lock is only a gate. B asks first and
// sees no key, A then runs to its end (key made, root added, record written), then B goes on under the lock: it must read the key again, and remove nothing
// macOS: the custody's helper is one of the things install places. The gate before any write asks the copy trocar ships with, through the
// real backends on a clean HOME, with a runner that answers only for a file that is really there (a stand-in that answers for any path hid this)
test('darwin: a first install on a clean HOME is not refused for the custody: the gate asks the helper trocar ships, not the one install has yet to place', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['codex'] })
  const asked = []
  const run = (file, args) => {
    if (!fs.existsSync(file)) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT', errno: -2, syscall: `spawn ${file}`, path: file })
    asked.push(file)
    return { status: 0, stdout: JSON.stringify(args[0] === 'session' ? { graphic: true } : { exists: false }), stderr: '' }
  }
  const real = await backendsFor({ os: 'darwin', home: w.home, run, env: w.env })
  assert.equal(fs.existsSync(path.join(w.home, '.trocar')), false, 'a clean HOME')
  const deps = { getuid: () => 501, backends: { ...real, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which }
  const io = fakeIo()
  assert.equal(await runInstallCli(['--dry-run', '--json'], { io, env: w.env, home: w.home, platform: 'darwin', deps }), 0, io.text())
  assert.equal(io.json().error, undefined, io.text())
  assert.ok(asked.length > 0 && asked.every((f) => !f.startsWith(w.home)), `the shipped helper was asked: ${asked}`)
})

// the advice to log in at the desktop is for the keychain's own failure; a helper that could not be run at all is not that
test('darwin: a custody helper that cannot be run is refused without the advice to log in', async () => {
  const run = (file) => { throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }) }
  const real = await backendsFor({ os: 'darwin', home: tmpDir(), run, env: {} })
  const { refusal } = await custodyPreflight({ os: 'darwin', custody: real.custody })
  assert.equal(refusal.code, CUSTODY_FAILED)
  assert.doesNotMatch(refusal.reason, /log in/)
})

// macOS: looking up a missing key needs no graphical session, making one does. With no key the gate also asks whether this
// session can make it (the helper's `session`); with a key it does not ask, since signing with an existing key needs no prompt
for (const [key, graphic, refused] of [[false, false, true], [false, true, false], [true, false, false]]) {
  test(`darwin: key ${key ? 'present' : 'absent'}, graphical session ${graphic}: the custody gate ${refused ? 'refuses and writes nothing' : 'lets install go on'}`, async () => {
    const w = await modelWorld({ os: 'darwin', commands: ['codex'] })
    const asked = []
    const run = (file, args) => {
      asked.push(args[0])
      return { status: 0, stdout: JSON.stringify(args[0] === 'session' ? { graphic } : { exists: key }), stderr: '' }
    }
    const real = await backendsFor({ os: 'darwin', home: w.home, run, env: w.env })
    const deps = { getuid: () => 501, backends: { ...real, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit: null }
    const before = snapshot(w.home)
    const io = fakeIo()
    if (refused) {
      assert.equal(await runInstallCli(['--yes', '--json'], { io, env: w.env, home: w.home, platform: 'darwin', deps }), 1, io.text())
      assert.equal(io.json().error.code, CUSTODY_FAILED)
      assert.deepEqual(snapshot(w.home), before, 'the HOME is byte for byte as it was')
    } else {
      assert.equal(await runInstallCli(['--dry-run', '--json'], { io, env: w.env, home: w.home, platform: 'darwin', deps }), 0, io.text())
      assert.equal(io.json().error, undefined, io.text())
    }
    assert.equal(asked.includes('session'), !key, `asked: ${asked}`)
  })
}

test('an install that waited behind another reads the key again under the lock: the root and record the first one made stay', async () => {
  const w = await modelWorld({ commands: ['codex'] })
  const run = async (custody) => {
    const io = fakeIo()
    const deps = { getuid: () => 501, backends: { custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit: null }
    return { exit: await runInstallCli(['--yes', '--json'], { io, env: w.env, home: w.home, platform: 'darwin', deps }), io }
  }
  let a = null
  const b = await run({ ...w.custody, exists: async () => { const has = w.custody.exists(); if (!a) a = await run(w.custody); return has } })
  assert.ok(a, 'A ran between B\'s first question and B\'s run')
  const fp = a.io.json().fp256
  assert.ok(fp, a.io.text())
  const m = JSON.parse(fs.readFileSync(path.join(w.dir, 'install-manifest.json'), 'utf8'))
  assert.equal(m.entries.find((e) => e.kind === 'root-key')?.fp256, fp, `A's key record stays: ${b.io.text()}`)
  assert.ok(m.entries.some((e) => e.kind === 'system-root' && e.fp256 === fp), "A's root-store record stays")
  assert.ok(w.store.held.has(fp), "A's root is still in the store")
  assert.ok(!w.store.calls.includes('remove'), 'nothing was removed from the store')
  assert.equal(w.custody.calls.filter((c) => c.verb === 'remove').length, 0, 'the key was not removed')
})

// §1.1 / D58 (macOS and Windows test machines, 2026-10-18): a receipt has no two identical rows, and it never prints trocar's own ids at a person — a form id
// (`codex.vscode`) and a carrier kind (`config-key`) are read out in words (src/cli/receipt.mjs formWords / carrierWords, one vocabulary).
test('the install receipt prints each (agent, carrier, file) fact once, in words — never one row per form, never a form or carrier id', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['claude', 'codex', 'dsh', 'kimi', 'opencode', 'hermes'] })
  const io = fakeIo()
  const deps = { getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit: null }
  assert.equal(await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform: 'darwin', deps }), 0, io.text())
  const text = io.text().slice(io.text().indexOf('Installed.')) // the receipt alone: the plan above it is a screen of its own, printed before anything was written
  const rows = text.split('\n').filter((l) => /^ {2}\S/.test(l))
  assert.deepEqual(rows.filter((l, i) => rows.indexOf(l) !== i), [], `a row is printed twice:\n${text}`)
  const forms = w.harnesses.flatMap((d) => ((d.proxyMode && d.proxyMode.forms) || []).map((f) => f.id))
  assert.ok(forms.length > 0, 'the world has forms to name')
  for (const id of forms) assert.ok(!text.includes(id), `the receipt prints the form id ${id} instead of what the form is`)
  // the whole run says the residual risk once: it is the last line of the plan (§3.2), not a paragraph the receipt repeats (macOS test machine run 2, 2026-10-18)
  const risk = io.text().match(/Any program running as you can ask trocar/g) || []
  assert.equal(risk.length, 1, `the residual-risk paragraph is printed ${risk.length} times`)
  assertEnglish(text, 'the install receipt')
})

// V85 (the model path): the plan names every file of yours outside ~/.trocar by full path, and trocar's own tree in one line — the line the
// model path had no equivalent of (it listed the carriers and the root, and nothing about ~/.trocar at all).
test('V85: the model install plan names trocar\'s own tree in one line and every carrier of yours by path', async () => {
  const { io, exit, w } = await cli(['--dry-run', '--json'])
  assert.equal(exit, 0)
  const plan = io.json().planned
  const trocarLine = plan.filter((p) => /^~[\\/]\.trocar[\\/]:/.test(p.detail))
  assert.equal(trocarLine.length, 1, `trocar's own tree is one line, not ${trocarLine.length}: ${JSON.stringify(plan)}`)
  assert.match(trocarLine[0].detail, /trocar-off/, 'and that line names the undo program, so the plan is readable without a second lookup')
  assert.equal(plan.filter((p) => p.detail.includes(w.home)).length, 0, 'every path is written under ~, never the home twice')
  for (const item of plan) assert.ok(item.detail.length > 0 && item.what, 'every planned item says what it is about')
})

test('4.4 §Plan 「端口」 · V67: install records the board\'s port in ingress.json once — a second install leaves the file byte- and mtime-identical', async () => {
  const { w, io, exit } = await cli(['--yes', '--json'])
  assert.equal(exit, 0, io.text())
  const file = path.join(w.dir, 'ingress.json')
  const bytes = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs
  const { boardPort } = JSON.parse(bytes)
  assert.ok(boardPort >= BOARD_RANGE[0] && boardPort <= BOARD_RANGE[1], String(boardPort))
  await new Promise((r) => setTimeout(r, 20))
  const io2 = fakeIo()
  assert.equal(await runInstallCli(['--yes'], { io: io2, env: w.env, home: w.home, platform: 'darwin', deps: { getuid: () => 501, unit: null, backends: { custody: w.custody, rootStore: w.store, dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns } }), 0, io2.text())
  assert.deepEqual([fs.readFileSync(file), fs.statSync(file).mtimeMs], [bytes, mtime])
})

// V108, the third failure: a collector on other code that cannot be stopped (it refuses the drain) is left running — exit 1, ok false, problems,
// not replaced, and the receipt says it still runs. A real daemon always obeys the drain (test/cli/install-replace-e2e.test.mjs), so the
// refusal is the control channel's answer here. A 400 naming `by` (an earlier build that does not know install) is asked once more as update, never
// again: a collector that refuses that too is left the same way; any other refusal is not asked again (1.6 §3.2 step 5).
for (const [why, status, asks] of [['refuses the drain', 409, ['install']], ['refuses by:install and by:update', 400, ['install', 'update']]]) {
  test(`V108: install leaves a collector on other code that ${why}, and says so`, async () => {
    const posted = []
    const refuse = async ({ method, body }) => { if (method === 'POST') { posted.push(body.by); throw Object.assign(new Error(`${status}: "by" is not one this collector knows`), { status }) } return {} }
    const { io, exit } = await cli(['--yes', '--json'], { over: { daemonCode: async () => '0.1.0+0000000', request: refuse, daemonState: async () => ({ state: 'running', socket: 'control.sock', lock: { pid: 4242 } }), drainMs: 0 } })
    const r = io.json()
    assert.deepEqual([exit, r.ok, r.problems.length > 0, r.daemon.replaced, r.daemon.state], [1, false, true, false, 'running'], io.text())
    assert.deepEqual(posted, asks, 'the exit requests the collector was sent')
  })
}

// 1.6 §5.5 step 4: the update that runs install replaces the collector itself, right after it
test('install under an update that replaces the collector next sends it no exit request and plans no replacement', async () => {
  const posted = []
  const { io, exit } = await cli(['--yes', '--json'], { over: { keepDaemon: true, daemonCode: async () => '0.1.0+0000000', request: async ({ method, body }) => { if (method === 'POST') posted.push(body); return {} }, daemonState: async () => ({ state: 'running', socket: 'control.sock', lock: { pid: 4242 } }), drainMs: 0 } })
  const r = io.json()
  assert.deepEqual([exit, posted, r.daemon.replaced, r.planned.filter((p) => p.what === 'daemon')], [0, [], false, []], io.text())
})

// 1.6 §3.2 计划: every row that names a place says what changes there — a carrier with no key (a launch command, a plug-in) in the receipt's words,
// from the carrier kind (the macOS plan printed `kimi-code  ~/.kimi-code/bin` and nothing else)
test('1.6 §3.2: every plan row that names a path says what changes there, a carrier with no key included', async () => {
  const kimi = (w) => { const f = path.join(w.home, '.kimi-code', 'bin', 'kimi'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4])) }
  const { io, exit } = await cli(['--dry-run', '--json'], { setup: kimi })
  assert.equal(exit, 0)
  const plan = io.json().planned
  assert.ok(plan.some((p) => p.what === 'kimi-code'), JSON.stringify(plan))
  for (const p of plan.filter((x) => /^~[\\/]/.test(x.detail))) assert.match(p.detail, /^\S.*: \S/, `${p.what}: the path, then what changes there`)
})

// 4.4 Set up (install <harness>): kimi-code installed with a user certificate file (rule U), then its wrapper lost to the agent's own update —
// the Set up's dry run (`planned` is the plan the board confirms, 4.4 #13 · V85) is asked of it
async function setUpKimi({ owns = null, after = () => {} } = {}) {
  const { install } = await import('../../src/cli/install.mjs')
  const { readManifest } = await import('../../src/off/manifest.mjs')
  const w = await modelWorld({ commands: ['kimi'], env: (home) => ({ NODE_EXTRA_CA_CERTS: path.join(home, 'certs', 'mine.pem') }) })
  w.file = w.env.NODE_EXTRA_CA_CERTS
  const own = owns ? owns(w) : w.owns
  fs.mkdirSync(path.dirname(w.file), { recursive: true }); fs.writeFileSync(w.file, `${(await import('node:tls')).rootCertificates[1].trim()}\n`)
  const kimi = path.join(w.home, '.kimi-code', 'bin', 'kimi')
  fs.mkdirSync(path.dirname(kimi), { recursive: true }); fs.writeFileSync(kimi, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])) // its native program: the wrapper's precondition
  await w.install({ wrapperKit: { renderWrapper }, owns: own })
  const wrapper = readManifest(w.dir).files.find((f) => f.harness === 'kimi-code' && f.role === 'wrapper')
  assert.ok(wrapper, 'kimi-code has a carrier of its own to lose')
  fs.writeFileSync(wrapper.path, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 9, 9, 9, 9])) // the agent's update put its own program back over trocar's launch command
  await after(w)
  const io = fakeIo()
  const deps = { getuid: () => 501, unit: null, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: w.harnesses.filter((d) => d.name === 'kimi-code'), which: w.ctx.which, owns: own } // kimi-code alone: this machine's own agents name no file of this world
  assert.equal(await install({ io, env: w.env, home: w.home, platform: 'darwin', deps, flags: new Set(['--dry-run', '--json']), only: 'kimi-code' }), 0, io.text())
  assert.deepEqual(validateReceipt(io.json()), [], io.text())
  return { w, planned: io.json().planned, left: io.json().left || [] }
}

test('V85 · Set up: a rule U block that is intact is not in the plan of the harness that is set up again', async () => {
  const { w, planned } = await setUpKimi()
  assert.ok(planned.some((p) => p.carrier === 'wrapper'), `the lost carrier is planned: ${JSON.stringify(planned)}`)
  assert.deepEqual(planned.filter((p) => (p.paths || []).includes(w.file)), [], 'the intact block is not a change')
})

test('4.4 #13 · V85 · Set up: a block of an older root in the user file is replaced by the run, so the plan names it', async () => {
  const tls = await import('node:tls')
  const { readManifest, saveManifest } = await import('../../src/off/manifest.mjs')
  const { w, planned } = await setUpKimi({
    after: (w) => { // the block and its record hold another root (the root was made again since): both rewritten alike, so the block is still intact
      const m = readManifest(w.dir)
      const e = m.entries.find((x) => x.kind === 'text' && x.path === w.file)
      const was = fs.readFileSync(path.join(w.dir, 'ca', 'trocar-ca.pem'), 'utf8').trim()
      const swap = (t) => { assert.ok(t.includes(was)); return t.split(was).join(tls.rootCertificates[2].trim()) }
      for (const o of e.ops) if (o.pem) o.inserted = swap(o.inserted)
      fs.writeFileSync(w.file, swap(fs.readFileSync(w.file, 'latin1')), 'latin1')
      saveManifest(w.dir, m)
    },
  })
  assert.ok(planned.some((p) => (p.paths || []).includes(w.file)), `the older root's block is a change: ${JSON.stringify(planned)}`)
})

test('4.4 #13 · Set up: a certificate file that is not this user\'s is no row of the plan the board confirms; the dry run says it apart', async () => {
  const { w, planned, left } = await setUpKimi({ owns: (w) => (p) => (p === fs.realpathSync(w.env.NODE_EXTRA_CA_CERTS) ? false : w.owns(p)) })
  assert.ok(planned.some((p) => p.carrier === 'wrapper'), `the lost carrier is planned: ${JSON.stringify(planned)}`)
  assert.deepEqual(planned.filter((p) => p.state), [], 'every row of the plan is a change')
  assert.ok(left.some((p) => p.state === 'skipped' && p.code === 'not-users-file' && p.paths.includes(w.file)), JSON.stringify(left))
})

// 1.6 §3.2: the undo's rows come from standaloneFiles, the one list install writes and uninstall removes (trocar-off.cmd beside it on Windows)
for (const platform of ['darwin', 'win32']) {
  test(`1.6 §3.2 (${platform}): the install plan names every file of the standalone undo`, async () => {
    const { install } = await import('../../src/cli/install.mjs')
    const { standaloneFiles } = await import('../../src/off/paths.mjs')
    const { tilde } = await import('../../src/cli/receipt.mjs')
    const w = await modelWorld({ os: platform })
    const io = fakeIo()
    const deps = { getuid: () => 501, unit: null, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: [], which: w.ctx.which, owns: w.owns }
    assert.equal(await install({ io, env: w.env, home: w.home, platform, deps, flags: new Set(['--dry-run', '--json']) }), 0, io.text())
    const words = io.json().planned.map((p) => p.detail).join('\n')
    for (const f of standaloneFiles(w.home, platform)) assert.ok(words.includes(tilde(f, w.home)), `${f} is named: ${words}`)
  })
}

// 1.6 §3.2 「标记却没有记录」: the install record is gone and files still hold trocar's marked text — install refuses before it writes anything,
// exit 1, `error.code` marked-without-record, `error.command` the uninstall that takes such text out by its marks, and every such file in `problems`
test('1.6 §3.2 (linux): marked text no record lists, in two files → refused, both named, the command given, the home byte for byte as it was', async () => {
  const home = tmpDir('trocar-mwr-')
  const env = (dir) => ({ name: dir, runtime: 'rust', processes: { names: [{ name: dir }] }, hosts: [], trust: { chain: [{ var: 'EXTRA_CA', semantic: 'append' }] },
    inject: (ctx) => ({ entries: [{ kind: 'text', format: 'dotenv-block', path: path.join(ctx.home, `.${dir}`, '.env'), vars: { EXTRA_CA: path.join(ctx.collectorDir, 'ca', 'trocar-ca.pem') }, semantic: 'append' }] }) })
  const files = ['a', 'b'].map((d) => path.join(home, `.${d}`, '.env'))
  for (const f of files) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${BLOCK_OPEN}\nSSL_CERT_FILE=/x\n${BLOCK_END}\nKEY=1\n`) }
  const before = snapshot(home)
  const io = fakeIo()
  const exit = await runInstallCli(['--yes', '--json'], onCtx(home, io, { harnesses: [env('a'), env('b')] }))
  const doc = io.json()
  assert.deepEqual([exit, doc.error && doc.error.code, doc.error && doc.error.command], [1, 'marked-without-record', 'trocar uninstall'])
  for (const f of files) assert.ok(doc.problems.some((p) => p.includes(f)), `${f} is named: ${JSON.stringify(doc.problems)}`)
  assert.deepEqual(validateReceipt(doc), [])
  assert.deepEqual(snapshot(home), before, 'nothing was written')
})

// 1.6 §3.2 + 4.11 P4: a harness whose owned file lands on someone else's file is dropped from the plan — its marked file is still named, because the
// marked files are gathered before any harness is dropped; `on` gives the same refusal, with the command
test('1.6 §3.2 (linux): a marked file of a harness dropped for a foreign file is named too, by install and by on', async () => {
  const home = tmpDir('trocar-mwr-order-')
  const plug = path.join(home, '.p', 'plugins', 'trocar-ca.js')
  const env = (dir, owned = false) => ({ name: dir, runtime: 'rust', processes: { names: [{ name: dir }] }, hosts: [], trust: { chain: [{ var: 'EXTRA_CA', semantic: 'append' }] },
    inject: (ctx) => ({ entries: [{ kind: 'text', format: 'dotenv-block', path: path.join(ctx.home, `.${dir}`, '.env'), vars: { EXTRA_CA: path.join(ctx.collectorDir, 'ca', 'trocar-ca.pem') }, semantic: 'append' }], ...(owned ? { owned: [{ path: plug, role: 'plugin', data: '// trocar collector: plugin\n', mode: 0o644 }] } : {}) }) })
  const files = ['a', 'p'].map((d) => path.join(home, `.${d}`, '.env'))
  for (const f of files) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${BLOCK_OPEN}\nSSL_CERT_FILE=/x\n${BLOCK_END}\n`) }
  fs.mkdirSync(path.dirname(plug), { recursive: true }); fs.writeFileSync(plug, '// the user\'s own plugin\n')
  const before = snapshot(home)
  for (const run of [runInstallCli, runOnCli]) {
    const io = fakeIo()
    const exit = await run(['--yes', '--json'], onCtx(home, io, { harnesses: [env('a'), env('p', true)] }))
    const doc = io.json()
    assert.deepEqual([exit, doc.error && doc.error.code, doc.error && doc.error.command], [1, 'marked-without-record', 'trocar uninstall'], JSON.stringify(doc))
    for (const f of files) assert.ok(doc.problems.some((p) => p.startsWith(f)), `${f} is named: ${JSON.stringify(doc.problems)}`)
    assert.deepEqual(validateReceipt(doc), [])
  }
  assert.deepEqual(snapshot(home), before, 'nothing was written')
})

// 1.6 §1.1⑥: a path in the refusal prints whole on its line, however long — never folded
test('1.6 §1.1⑥: the refusal prints each path whole', () => {
  const long = `/Users/someone/Library/Application Support/${'a rather long folder name/'.repeat(4)}.env` // a space, as macOS paths have: fit folds at spaces
  const e = { code: 'marked-without-record', message: 'these files hold trocar\'s text.', paths: [long] }
  const lines = formatRefusal(markedRefusal('install', e), { paths: e.paths })
  assert.ok(lines.some((l) => l.includes(long)), lines.join('\n'))
})

// 1.6 §3.2 (macOS / Windows): trocar's marked text in a carrier's file and no record → that carrier is skipped with marked-without-record, the file untouched
for (const os of ['darwin', 'win32']) {
  test(`1.6 §3.2 · ${os}: a carrier whose file holds trocar's marked text and no record is skipped with marked-without-record`, async () => {
    const w = await modelWorld({ os, commands: ['dsh'] })
    const patch = path.join(w.home, '.dsh', 'cordis.patch.yml')
    const text = `${BLOCK_OPEN}\n- insert: []\n${BLOCK_END}\n`
    fs.mkdirSync(path.dirname(patch), { recursive: true }); fs.writeFileSync(patch, text)
    const r = await w.install()
    assert.equal(r.exit, 1)
    assert.ok(r.carriers.some((c) => c.harness === 'deepseek-dsh' && c.state === 'skipped' && c.code === 'marked-without-record'), JSON.stringify(r.carriers))
    assert.equal(fs.readFileSync(patch, 'utf8'), text)
  })
}
// 4.11 P4 (Windows): the scheduled task under trocar's name is no file under HOME — the run asks the unit what is registered (registeredBytes) and
// backs it up before it replaces it, so the plan asks the same seam and says where the old bytes go; with nothing registered it says no replacement
test('4.11 P4 · win32: the plan asks what is registered under trocar\'s task name and says where its bytes go', async () => {
  for (const registered of [Buffer.from('<Task>an older one</Task>'), null]) {
    const w = await modelWorld({ os: 'win32', commands: ['codex'] })
    const unit = { path: path.join(w.dir, 'task.xml'), text: () => '<Task>trocar</Task>', registeredBytes: () => registered }
    const io = fakeIo()
    const exit = await runInstallCli(['--dry-run', '--json'], { io, env: w.env, home: w.home, platform: 'win32', deps: { getuid: () => 501, unit, backends: { custody: w.custody, rootStore: w.store, installHelper: null, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns } })
    assert.equal(exit, 0, io.text())
    const row = JSON.parse(io.text()).planned.find((p) => p.what === 'autostart')
    assert.equal(row.detail.includes(path.win32.join('~', '.trocar', 'backup')) || row.detail.includes(path.join('~', '.trocar', 'backup')), registered !== null, JSON.stringify(row))
  }
})

// 4.11 P4b: install.skipped is rewritten only for the harnesses a run judged the carriers of (an install that stops before them keeps it), and a skip
// counts only while its file still holds the marked text no record lists
for (const os of ['darwin', 'win32']) {
  test(`4.11 P4b · ${os}: a skip survives an install that stops before the carriers, and stops counting once the marked text is gone`, async () => {
    const w = await modelWorld({ os, commands: ['dsh'] })
    const patch = path.join(w.home, '.dsh', 'cordis.patch.yml')
    fs.mkdirSync(path.dirname(patch), { recursive: true }); fs.writeFileSync(patch, `${BLOCK_OPEN}\n- insert: []\n${BLOCK_END}\n`)
    assert.equal((await w.install()).exit, 1)
    const dsh = w.harnesses.find((d) => d.name === 'deepseek-dsh')
    const what = () => [...new Set(setupOf(dsh, { os, manifest: readManifest(w.dir), ctx: w.ctx }).missing.map((x) => x.what))]
    assert.deepEqual(what(), ['marked-without-record'])
    w.custody.switches.failed = true // the key custody fails: install stops before any carrier
    assert.equal((await w.install()).exit, 1)
    assert.deepEqual(what(), ['marked-without-record'], 'the stopped install kept the skip')
    w.custody.switches.failed = false
    fs.writeFileSync(patch, '- insert: []\n') // the user took trocar's text out
    assert.ok(!what().includes('marked-without-record'), JSON.stringify(what()))
  })
}

// 1.6 §3.2 (macOS / Windows), through the CLI: the record is gone and the root with it, while the user's files still hold trocar's marked text (rule U's
// block in the certificate file NODE_EXTRA_CA_CERTS names, dsh's loader row). Install skips each such carrier and installs the rest, and the receipt
// is the refusal's: `error.code` marked-without-record, `error.command` the uninstall that takes the text out by its marks, every such file in
// `problems` (each starting with its path), and in the text each of them whole on a line of its own (§1.1⑥). The plug-in files carrying trocar's
// sentinel are trocar's own and are taken over (4.11 P4): no such file is named
for (const os of ['darwin', 'win32']) {
  test(`1.6 §3.2 · ${os}: install after a lost record names every file of trocar's marked text, with the command, through the CLI`, async () => {
    const w = await modelWorld({ os, commands: ['claude', 'kimi', 'dsh', 'pi'], env: (home) => ({ CLAUDE_CODE_CERT_STORE: 'bundled', NODE_EXTRA_CA_CERTS: path.join(home, 'certs', 'user-ca.pem') }) })
    fs.mkdirSync(path.dirname(w.env.NODE_EXTRA_CA_CERTS), { recursive: true }); fs.writeFileSync(w.env.NODE_EXTRA_CA_CERTS, `${tls.rootCertificates[2].trim()}\n`)
    for (const d of ['.dsh', '.zcode']) fs.mkdirSync(path.join(w.home, d), { recursive: true })
    assert.equal((await w.install()).exit, 0)
    const manifest = path.join(w.dir, 'install-manifest.json')
    const marked = [...new Set(JSON.parse(fs.readFileSync(manifest, 'utf8')).entries.filter((e) => e.kind === 'text').map((e) => e.path))] // trocar's text in the user's files
    assert.ok(marked.includes(w.env.NODE_EXTRA_CA_CERTS) && marked.length >= 2, JSON.stringify(marked))
    fs.rmSync(manifest); w.store.held.clear() // the record lost, and the root taken out by hand: only the marked text is left
    const deps = { getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit: null }
    const io = fakeIo()
    assert.equal(await runInstallCli(['--yes', '--json'], { io, env: w.env, home: w.home, platform: os, deps }), 1, io.text())
    const doc = io.json()
    assert.deepEqual([doc.error && doc.error.code, doc.error && doc.error.command], ['marked-without-record', 'trocar uninstall'], JSON.stringify(doc.error))
    for (const f of marked) assert.ok(doc.problems.some((p) => p.startsWith(f)), `${f} is named: ${JSON.stringify(doc.problems)}`)
    assert.deepEqual(doc.problems.filter((p) => !marked.some((f) => p.startsWith(f))), [], 'no other file is named: a plug-in file with trocar\'s sentinel is taken over')
    assert.deepEqual(validateReceipt(doc), [])
    const text = fakeIo()
    assert.equal(await runInstallCli(['--yes'], { io: text, env: w.env, home: w.home, platform: os, deps }), 1)
    const lines = text.text().split('\n').map((l) => l.trim())
    for (const f of marked) assert.ok(lines.includes(path.join('~', path.relative(w.home, f))), `${f} prints whole on a line of its own:\n${text.text()}`)
    // 4.11 P4b: status and on judge a skipped harness by install's own skip, whose fix is uninstall (install again repeats the skip); the rest read ready
    const setup = (h) => setupOf(w.harnesses.find((d) => d.name === h), { os, manifest: readManifest(w.dir), ctx: w.ctx })
    const skipped = [...new Set(doc.carriers.filter((c) => c.code === 'marked-without-record').map((c) => c.harness))]
    const placed = [...new Set(doc.carriers.filter((c) => c.carrier !== 'root' && c.state && c.state !== 'skipped').map((c) => c.harness))].filter((h) => !doc.carriers.some((c) => c.harness === h && c.state === 'skipped'))
    assert.ok(skipped.includes('claude-code') && placed.length, JSON.stringify(doc.carriers))
    for (const h of skipped) {
      const s = setup(h)
      assert.deepEqual([s.state, [...new Set(s.missing.map((x) => x.what))]], ['needed', ['marked-without-record']], `${h}: ${JSON.stringify(s)}`)
    }
    for (const h of placed) assert.equal(setup(h).state, 'ready', h)
    // 1.6 §3.3 / 附录 B: on and status give the finding's steps for a skipped harness; run in order, they end with it turned on
    const steps = findingFor('marked-without-record', { platform: os }).commands.map((c) => c.run)
    const sock = path.join(w.home, 'c.sock'), token = 'k'.repeat(32)
    fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
    const server = await startControlServer({ socketPath: sock, token, routes: {
      'GET /status': async () => ({ doors: {} }), 'GET /holders': async () => ({ count: 0, holders: [] }), 'POST /off': async () => ({ actual: 'off', confirmed: true }),
      'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
    } })
    const unit = { path: '/nowhere/unit', text: () => '', registered: () => ({ state: 'present' }), enable: () => {}, start: () => {}, startNow: () => {} }
    const reader = { ready: Promise.resolve({ ready: true, via: 'daemon' }), close: async () => {}, self: () => null, call: async () => ({ procs: [] }) }
    const exec = recordingExec().run
    const onDeps = { getuid: () => 501, exec, backends: { dirs: w.ctx.dirs, rootStore: w.store }, harnesses: w.harnesses, which: w.ctx.which, daemonReader: reader, parts: { os, harnesses: w.harnesses, arch: { unit: { userUnit: () => unit } } } }
    const on = async (argv) => { const io = fakeIo(); const exit = await runOnCli([...argv, '--yes', '--json'], { io, env: w.env, home: w.home, platform: os, deps: onDeps }); return { exit, doc: io.json() } }
    const uninstall = () => runUninstall({ home: w.home, env: w.env, yes: true, deps: { platform: os, exec, custody: w.custody, rootStore: w.store, harnesses: w.harnesses, procs: async () => [], sleep: async () => {}, drainMs: 0, getuid: () => 501 } })
    const live = os === 'darwin' // the stand-in daemon listens on a unix socket; Windows names a pipe, which cannot be served here: on names only what it refuses
    try {
      const first = await on(live ? [] : skipped)
      assert.deepEqual([first.exit, first.doc.error && first.doc.error.code], [1, 'setup-needed'], JSON.stringify(first.doc))
      assert.deepEqual(first.doc.refused.map((x) => [x.harness, x.commands]).sort(), skipped.map((h) => [h, steps]).sort(), JSON.stringify(first.doc.refused))
      const { modelNetForms } = await import('../../src/collector/arch/model-backends.mjs')
      const net = await modelNetForms({ os, home: w.home, env: w.env, status: { cert: { root: { state: 'trusted' } }, daemon: { reply: null } }, harnesses: w.harnesses, procs: [], systemProxy: null, chainSp: null, dirs: w.ctx.dirs })
      for (const h of skipped) assert.ok(net.forms[h].some((f) => f.certificate.code === 'marked-without-record' && f.certificate.command === steps[0]), `${h}: ${JSON.stringify(net.forms[h].map((f) => f.certificate))}`)
      if (live) assert.equal((await uninstall()).exit, 1, 'uninstall refuses while the nameless on keeps the others on: off comes first')
      for (const run of steps) {
        if (run === 'trocar off') { if (live) { const o = await runOff({ home: w.home, env: w.env, deps: { platform: os, exec, procs: async () => [], sleep: async () => {}, getuid: () => 501 } }); assert.equal(o.exit, 0, JSON.stringify(o.receipt.problems)) } }
        else if (run === 'trocar uninstall') { const u = await uninstall(); assert.equal(u.exit, 0, JSON.stringify(u.receipt.problems)) }
        else if (run === 'trocar install') assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0, run)
        else assert.fail(`a step this test does not know: ${run}`)
      }
      for (const h of [...skipped, ...placed]) assert.equal(setup(h).state, 'ready', h)
      if (live) { fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token })) /* uninstall took the daemon's file with the rest */; const last = await on(skipped); assert.deepEqual([last.exit, last.doc.refused, last.doc.harnesses.sort()], [0, [], [...skipped].sort()], JSON.stringify(last.doc)) }
    } finally { await server.close() }
  })
}
// 1.6 §3.2: a record install cannot build on is refused before the plan, whatever the OS: writing over it would lose what it lists. Each case has its own way out
for (const platform of ['darwin', 'win32', 'linux']) {
  const cases = [
    ['not JSON', (f) => fs.writeFileSync(f, '{ not json'), 'trocar uninstall'],
    ['a list', (f) => fs.writeFileSync(f, '[]'), 'trocar uninstall'],
    ['of a version this build does not read', (f) => fs.writeFileSync(f, JSON.stringify({ version: 99 })), undefined],
    ['not readable (a directory)', (f) => fs.mkdirSync(f), undefined],
  ]
  for (const [what, make, command] of cases) {
    test(`1.6 §3.2 · ${platform}: an install record that is ${what} refuses: manifest-unreadable, its own way out, the file named, nothing written`, async () => {
      const home = tmpDir(), dir = path.join(home, '.trocar', 'collector'), file = path.join(dir, 'install-manifest.json')
      fs.mkdirSync(dir, { recursive: true }); make(file)
      const was = fs.statSync(file).isDirectory() ? null : fs.readFileSync(file)
      for (const [flags, code] of [[['--yes', '--json'], 1], [['--json'], 1], [['--dry-run', '--json'], 0]]) { // §1.4: a dry run exits 0 and says what stops the run
        const io = fakeIo()
        const exit = await runInstallCli(flags, { io, env: {}, home, platform, deps: { getuid: () => 501 } })
        const doc = io.json()
        assert.equal(exit, code, io.text())
        assert.deepEqual([doc.ok, doc.error.code, doc.error.command], [false, 'manifest-unreadable', command])
        assert.ok(doc.error.message.includes(file), doc.error.message)
        assert.deepEqual(validateReceipt(doc), [])
      }
      assert.deepEqual([fs.readdirSync(path.join(home, '.trocar')), fs.readdirSync(dir)], [['collector'], ['install-manifest.json']], 'nothing was written')
      if (was) assert.deepEqual(fs.readFileSync(file), was)
    })
  }
}
// the way out of a damaged record really is one: with the file moved where the refusal says, the same install goes on
test('1.6 §3.2: a damaged record moved aside as the refusal says: install no longer refuses', async () => {
  const home = tmpDir(), dir = path.join(home, '.trocar', 'collector'), file = path.join(dir, 'install-manifest.json')
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, '{ not json')
  const said = fakeIo()
  await runInstallCli(['--yes', '--json'], { io: said, env: {}, home, platform: 'darwin', deps: { getuid: () => 501 } })
  const [, from, to] = said.json().error.message.split('\n').find((l) => l.trim().startsWith('mv ')).match(/^\s*mv '(.+)' '(.+)'$/)
  assert.equal(from, file)
  const { io } = await cli(['--dry-run', '--json'], { setup: (w) => { fs.mkdirSync(w.dir, { recursive: true }); fs.writeFileSync(path.join(w.dir, path.basename(to)), '{ not json') } }) // what is left once it is moved
  assert.equal(io.json().error, undefined, io.text())
  assert.ok(io.json().planned.length > 0)
})
