// test/cli/legacy-uninstall.test.mjs — `asight uninstall` where the old capture is what `on` / `off` drive (RFC 1.6 §4, §1.1, R2, R6; V8 for this platform): off for the old capture, then asight's
// own files — every backup (the kept ones listed), the ledger, the CA that `on` made, the single-file undo — and nothing of the user's data; what could not be undone keeps all of it for the
// next run. A sandbox HOME, a fake launchd / keychain / Clash core (test/cli/fixtures/legacy-ctx.mjs); nothing reaches the machine the tests run on (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOnCli } from '../../src/cli/on.mjs'
import { runUninstallCli } from '../../src/cli/uninstall.mjs'
import { runOffCli } from '../../src/off/main.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { LEGACY_NOTE } from '../../src/off/legacy.mjs'
import { backupDir, standalonePath, legacyManifestPath } from '../../src/off/paths.mjs'
import { fakeIo, snapshot, changedFiles } from './fixtures/on-ctx.mjs'
import { macHome, fakeMac, fakeCore, fakeClock, fakeOpenssl, readEvents, USER_MAIN } from './fixtures/legacy-ctx.mjs'

const BLOCK = 'atrace desktop capture'
const ctx = (s, io, { core = null, mac, clock = fakeClock(), deps = {} } = {}) => ({
  io, home: s.home, platform: 'darwin',
  env: { PATH: process.env.PATH, ASIGHT_MIHOMO_SOCK: core ? core.sock : path.join(s.home, 'no-such-mihomo.sock') },
  // hasNewCollector: () => false — the darwin flip (4.9 §4) put darwin on the NEW collector; the old capture's uninstall keeps its tests through the seam (as legacy-platform.test.mjs does)
  deps: { hasNewCollector: () => false, getuid: () => 501, exec: mac.run, run: fakeOpenssl, alive: () => false, procs: async () => [], ms: clock.ms, sleep: clock.sleep, now: () => new Date(clock.ms()), netenv: async () => ({ at: '2026-10-07T00:00:00.000Z', products: [], unknown: [{ reason: 'a test' }] }), ...deps },
})
const freshMac = () => macHome({ block: false, runtime: false, agents: [], steer: false, ca: false, userMain: USER_MAIN })
const on = async (s, core, mac) => { assert.equal(await runOnCli(['--yes'], ctx(s, fakeIo(), { core, mac })), 0) }
const tree = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : [])

test('uninstall after on: Script.js is the user\'s own bytes, the agents are gone, and so are asight\'s own files — the backups, the ledger, the CA on made, asight-off; the logs and the captures stay, v0\'s ~/.atrace is not touched; the receipt lists each, exit 0, an uninstall-note result in the log', async () => {
  const s = freshMac(); const order = []
  const core = await fakeCore({ live: false, order }); const mac = fakeMac({ loaded: [], keychain: false, order, pids: {} })
  try {
    const original = fs.readFileSync(s.script, 'utf8')
    await on(s, core, mac)
    const dataFile = path.join(s.home, '.asight', 'claude-capture.ndjson'); fs.writeFileSync(dataFile, '{"id":"r1"}\n')
    const v0 = path.join(s.home, '.atrace', 'ca', 'atrace-ca.key'); fs.mkdirSync(path.dirname(v0), { recursive: true }); fs.writeFileSync(v0, 'v0 key')
    assert.ok(fs.existsSync(standalonePath(s.home)) && fs.existsSync(path.join(s.home, '.asight', 'ca')) && tree(backupDir(s.home)).length === 1, 'on wrote them')
    const io = fakeIo()
    assert.equal(await runUninstallCli(['--json'], ctx(s, io, { core, mac })), 0, io.text())
    const r = io.json()
    assert.deepEqual(validateReceipt(r), []); assert.equal(r.command, 'uninstall'); assert.equal(r.ok, true)
    assert.equal(io.stderrText().split('\n')[0], LEGACY_NOTE)
    assert.equal(fs.readFileSync(s.script, 'utf8'), original)
    assert.deepEqual([fs.existsSync(s.plist('com.asight.mitm')), fs.existsSync(s.plist('com.asight.env'))], [false, false])
    for (const gone of [backupDir(s.home), legacyManifestPath(s.home), standalonePath(s.home), path.dirname(standalonePath(s.home)), path.join(s.home, '.asight', 'ca')]) assert.equal(fs.existsSync(gone), false, `${gone} is gone`)
    assert.equal(fs.readFileSync(dataFile, 'utf8'), '{"id":"r1"}\n', 'the capture stays'); assert.ok(fs.existsSync(v0), 'v0\'s CA is not touched')
    assert.ok(fs.existsSync(path.join(s.home, '.asight', 'logs', 'mitm-events.ndjson')), 'the log stays')
    for (const p of [standalonePath(s.home), path.join(s.home, '.asight', 'ca'), legacyManifestPath(s.home)]) assert.ok(r.removed.includes(p), `the receipt lists ${p}`)
    assert.equal(r.dropped_backups.length, 0, 'the one backup was dropped by the undo itself (the file is back to what it was)')
    const last = readEvents(s.home).at(-1)
    assert.deepEqual([last.event, last.kind, last.outcome], ['uninstall-note', 'result', 'uninstalled']); assert.deepEqual(checkRecord(last), [])
    for (const e of readEvents(s.home)) assert.deepEqual(checkRecord(e), [], JSON.stringify(e))
    const text = fakeIo(); assert.equal(await runUninstallCli([], ctx(s, text, { core, mac })), 0)
    assert.match(text.stdoutText(), /asight 已卸载/); assert.match(text.stdoutText(), /采集数据保留在 /)
  } finally { await core.close() }
})

test('uninstall: a backup the undo kept because the user changed Script.js since is dropped and listed (non-identical); nothing of asight\'s is left in ~/.asight but the log', async () => {
  const s = freshMac(); const core = await fakeCore({ live: false }); const mac = fakeMac({ loaded: [], keychain: false, pids: {} })
  try {
    await on(s, core, mac)
    fs.writeFileSync(s.script, fs.readFileSync(s.script, 'utf8').replace('// my rules', '// my rules, edited since')) // the user's edit above the block
    const io = fakeIo()
    assert.equal(await runUninstallCli([], ctx(s, io, { core, mac })), 0, io.text())
    const t = io.stdoutText()
    assert.match(t, /删了 1 个备份/); assert.match(t, /其中不逐字节相同的.*Script\.js\(备份 [^:]*:/, 'the one the undo kept is listed, with its path and why')
    assert.equal(fs.existsSync(backupDir(s.home)), false); assert.equal(fs.existsSync(legacyManifestPath(s.home)), false)
    assert.ok(fs.readFileSync(s.script, 'utf8').includes('edited since') && !fs.readFileSync(s.script, 'utf8').includes(BLOCK), 'only asight\'s block went')
    assert.deepEqual(tree(path.join(s.home, '.asight')).filter((n) => !n.startsWith('logs')), [])
  } finally { await core.close() }
})

test('uninstall that cannot confirm the Clash route: exit 1, the old capture is as far out as off could take it, and asight\'s own files stay — the ledger, the backup, asight-off, the CA; the same command with the core answering finishes the job', async () => {
  const s = freshMac(); const core = await fakeCore({ live: false }); const mac = fakeMac({ loaded: [], keychain: false, pids: {} })
  try {
    await on(s, core, mac)
    const silent = fakeIo()
    assert.equal(await runUninstallCli(['--json'], ctx(s, silent, { mac })), 1, silent.text()) // the core is a socket nobody listens on
    const r = silent.json()
    assert.equal(r.ok, false); assert.ok(r.problems.some((p) => /left in place/.test(p)), r.problems.join(' | '))
    assert.equal(r.relayed, 'unknown', 'the MITM was left running: the receipt does not claim 0 connections'); assert.match(r.relayed_reason, /not confirmed gone/)
    assert.deepEqual(['com.asight.mitm', 'com.asight.env'].map((l) => fs.existsSync(s.plist(l))), [true, true], 'the MITM and the trust for it are still there, so a Desktop started now is not broken')
    for (const kept of [legacyManifestPath(s.home), standalonePath(s.home), path.join(s.home, '.asight', 'ca')]) assert.ok(fs.existsSync(kept), `${kept} stays`)
    assert.equal(tree(backupDir(s.home)).length, 1)
    assert.equal(readEvents(s.home).at(-1).outcome, 'failed')
    const again = fakeIo()
    assert.equal(await runUninstallCli(['--json'], ctx(s, again, { core, mac })), 0, again.text())
    assert.deepEqual([fs.existsSync(legacyManifestPath(s.home)), fs.existsSync(backupDir(s.home)), fs.existsSync(standalonePath(s.home))], [false, false, false])
  } finally { await core.close() }
})

test('uninstall --dry-run writes and runs nothing mutating; --purge-data needs a yes — without a terminal and without --yes the plan is printed and nothing is done (exit 2), a "no" in a terminal is exit 1, --yes deletes the capture files at the top of ~/.asight and nothing under logs/ or sessions/', async () => {
  const s = freshMac(); const core = await fakeCore({ live: false }); const mac = fakeMac({ loaded: [], keychain: false, pids: {} })
  try {
    await on(s, core, mac)
    for (const f of ['claude-capture.ndjson', 'capture.ndjson']) fs.writeFileSync(path.join(s.home, '.asight', f), '{}\n')
    fs.mkdirSync(path.join(s.home, '.asight', 'sessions'), { recursive: true }); fs.writeFileSync(path.join(s.home, '.asight', 'sessions', 'a.ndjson'), '{}\n')
    const before = snapshot(s.home), mutBefore = mac.mutating().length
    const dry = fakeIo()
    assert.equal(await runUninstallCli(['--dry-run'], ctx(s, dry, { core, mac })), 0, dry.text())
    assert.deepEqual([snapshot(s.home), mac.mutating().length], [before, mutBefore]); assert.match(dry.stdoutText(), /asight 将卸载/)
    const plan = fakeIo()
    assert.equal(await runUninstallCli(['--purge-data'], ctx(s, plan, { core, mac })), 2, plan.text())
    assert.deepEqual([snapshot(s.home), mac.mutating().length], [before, mutBefore]); assert.ok(plan.text().includes('capture*.ndjson')); assert.match(plan.stderrText(), /没有 --yes/)
    const no = fakeIo({ tty: true, answers: ['n'] })
    assert.equal(await runUninstallCli(['--purge-data'], ctx(s, no, { core, mac })), 1); assert.equal(no.asked.length, 1)
    assert.deepEqual([snapshot(s.home), mac.mutating().length], [before, mutBefore])
    const yes = fakeIo()
    assert.equal(await runUninstallCli(['--purge-data', '--yes', '--json'], ctx(s, yes, { core, mac })), 0, yes.text())
    assert.equal(yes.json().purge_data, true)
    assert.deepEqual(['claude-capture.ndjson', 'capture.ndjson'].map((f) => fs.existsSync(path.join(s.home, '.asight', f))), [false, false])
    assert.ok(fs.existsSync(path.join(s.home, '.asight', 'sessions', 'a.ndjson')), 'sessions/ is not the old capture\'s file')
    assert.ok(fs.existsSync(path.join(s.home, '.asight', 'logs', 'mitm-events.ndjson')))
  } finally { await core.close() }
})

test('uninstall with nothing of asight on the Mac is exit 0 and writes nothing but the one result line — no ~/.asight is made for it; a second uninstall after a full one is the same', async () => {
  const s = freshMac(); const mac = fakeMac({ loaded: [], keychain: false }); const before = snapshot(s.home)
  const io = fakeIo()
  assert.equal(await runUninstallCli(['--json'], ctx(s, io, { mac })), 0, io.text())
  assert.equal(io.json().ok, true)
  assert.deepEqual(changedFiles(before, snapshot(s.home)).filter((f) => !f.startsWith('.asight/')), [], 'nothing of the user\'s moved')
  assert.deepEqual(mac.mutating(), [], 'no tool that changes a machine was run')
})

// audit rule-b 8: on a Mac that never had asight, taking the old capture's lock made ~/.asight and `off` left it behind, empty; `uninstall` left `netenv.json` (and so the directory) behind.
test('old capture: off on a machine that never had asight leaves no ~/.asight; uninstall takes ~/.asight/netenv.json with the rest and leaves the directory only for the captures and the log of what it did', async () => {
  const bare = () => macHome({ block: false, runtime: false, agents: [], steer: false, ca: false })
  const offRun = async (s) => { const io = fakeIo(); return { exit: await runOffCli([], ctx(s, io, { mac: fakeMac({ loaded: [], keychain: false }) })), io } }
  const uninstallRun = async (s) => { const io = fakeIo(); return { exit: await runUninstallCli([], ctx(s, io, { mac: fakeMac({ loaded: [], keychain: false }) })), io } }
  const s = bare()
  assert.ok(!fs.existsSync(path.join(s.home, '.asight')), 'a machine that never had asight')
  const off = await offRun(s)
  assert.equal(off.exit, 0, off.io.text())
  assert.ok(!fs.existsSync(path.join(s.home, '.asight')), 'off made nothing and left nothing, not even an empty ~/.asight')
  // uninstall of an old install that only has the board's copy of the VPN probe left
  const t = bare(); fs.mkdirSync(path.join(t.home, '.asight'), { recursive: true })
  const nf = path.join(t.home, '.asight', 'netenv.json'); fs.writeFileSync(nf, '{"schema":1}\n')
  const un = await uninstallRun(t)
  assert.equal(un.exit, 0, un.io.text())
  assert.ok(!fs.existsSync(nf), 'netenv.json is removed')
  assert.deepEqual(tree(path.join(t.home, '.asight')), ['logs', path.join('logs', 'mitm-events.ndjson')], 'what is left of asight\'s is the log of what the uninstall did (the logs stay, 4.6)')
  assert.ok(un.io.text().includes('netenv.json'), 'the receipt lists it among what was removed')
  // with a capture in it the directory stays — the captures are the user's
  const u = bare(); fs.mkdirSync(path.join(u.home, '.asight'), { recursive: true })
  fs.writeFileSync(path.join(u.home, '.asight', 'netenv.json'), '{"schema":1}\n'); fs.writeFileSync(path.join(u.home, '.asight', 'capture-2026-10-06.ndjson'), '{}\n')
  assert.equal((await uninstallRun(u)).exit, 0)
  assert.deepEqual(fs.readdirSync(path.join(u.home, '.asight')).sort(), ['capture-2026-10-06.ndjson', 'logs'], 'the captures are the user\'s, and so stay with the log')
})

test('semantics 7 (old capture): off on a Mac asight was never on says so first — nothing to close, not 「asight 已关闭采集」 — in the text and in --json', async () => {
  const bare = () => macHome({ block: false, runtime: false, agents: [], steer: false, ca: false })
  const run = async (argv) => { const s = bare(); const io = fakeIo(); return { exit: await runOffCli(argv, ctx(s, io, { mac: fakeMac({ loaded: [], keychain: false }) })), io } }
  const off = await run([])
  assert.equal(off.exit, 0, off.io.text())
  assert.match(off.io.text(), /这台机器上没有 asight 的安装\(没装过,或已经 uninstall\),没有东西要关/)
  assert.doesNotMatch(off.io.text(), /asight 已关闭/)
  const json = await run(['--json'])
  assert.equal(json.io.json().nothing_installed, true)
})
