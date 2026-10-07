// test/cli/legacy-platform.test.mjs — `asight on | off | status` where there is no new collector (RFC 1.6 §4 「旧采集(过渡期)」; macOS today): the old capture is what they drive. V12 (com.asight.env goes with
// the old capture, and only its own value of the login environment), V14 (the note, the macOS row of §4 call for call), V23 (the Clash route: ledgered, stripped, READ BACK from the core — also when only
// the runtime holds it; a core that does not answer is exit 1 and 「不知道」; a block an old command wrote is 「旧命令装的,无备份」), V31 (the MITM is unloaded only after the route is confirmed gone, and drains).
// A sandbox HOME, a fake launchd / login environment / keychain, a Clash core on a real unix socket (test/cli/fixtures/legacy-ctx.mjs); nothing reaches the machine the tests run on (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { runOffCli } from '../../src/off/main.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { runUninstallCli } from '../../src/cli/uninstall.mjs'
import { asightOffInProcess } from '../../src/capture/control.mjs'
import { legacyLifecycle } from '../../src/capture/legacy-run.mjs'
import { createSteerWatch, legacyOffPending } from '../../src/capture/steer-watch.mjs'
import { appendLegacyEvent } from '../../src/capture/events.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { LEGACY_NOTE } from '../../src/off/legacy.mjs'
import { newManifest, saveManifestAt } from '../../src/off/manifest.mjs'
import { writeBackup } from '../../src/off/backup.mjs'
import { sha256 } from '../../src/off/fsutil.mjs'
import { legacyManifestPath } from '../../src/off/paths.mjs'
import { fakeIo, snapshot, changedFiles } from './fixtures/on-ctx.mjs'
import { standalonePath, backupDir } from '../../src/off/paths.mjs'
import { macHome, fakeMac, fakeCore, fakeClock, fakeOpenssl, readEvents, USER_MAIN, NO_OP, CA_CN, LABELS } from './fixtures/legacy-ctx.mjs'
import { installedHome } from '../off/fixtures/off-ctx.mjs'

const BLOCK = 'atrace desktop capture'
const offCtx = (s, io, { core = null, mac, clock = fakeClock(), deps = {}, env = {} } = {}) => ({
  io, home: s.home, platform: 'darwin',
  env: { PATH: process.env.PATH, ASIGHT_MIHOMO_SOCK: core ? core.sock : path.join(s.home, 'no-such-mihomo.sock'), ...env },
  deps: { getuid: () => 501, exec: mac.run, alive: () => false, procs: async () => [], ms: clock.ms, sleep: clock.sleep, now: () => new Date(clock.ms()), ...deps },
})
const launchCalls = (mac) => mac.calls.filter((c) => /^(launchctl|security) /.test(c))

test('V14: off first says it drives the old capture, then follows the macOS row of §4 call for call — the route is stripped, reloaded and read back before the MITM is unloaded, then the monitor, the primer (and the login variable), the CA — and the receipt names each thing', async () => {
  const s = macHome({ userMain: USER_MAIN }); const order = []
  const core = await fakeCore({ order }); const mac = fakeMac({ env: { NODE_EXTRA_CA_CERTS: s.caPath }, order })
  try {
    const io = fakeIo()
    assert.equal(await runOffCli([], offCtx(s, io, { core, mac })), 0, io.text())
    assert.ok(io.text().startsWith(`${LEGACY_NOTE}\n`), 'the first line says which generation this drives (1.6 §4)')
    assert.deepEqual(order, [
      // reading what is there
      'launchctl list com.asight.mitm', 'launchctl list com.asight.monitor', 'launchctl list com.asight.env', 'launchctl getenv NODE_EXTRA_CA_CERTS', `security find-certificate -c ${CA_CN} ${s.keychain}`,
      // the Clash route: reloaded, then READ BACK from the core
      'PUT /configs', 'GET /proxies',
      // the MITM (launchd sends it SIGTERM), each unload checked, then the monitor, the primer, the login variable, the CA
      `launchctl unload ${s.plist('com.asight.mitm')}`, 'launchctl list com.asight.mitm',
      `launchctl unload ${s.plist('com.asight.monitor')}`, 'launchctl list com.asight.monitor',
      `launchctl unload ${s.plist('com.asight.env')}`, 'launchctl list com.asight.env',
      'launchctl unsetenv NODE_EXTRA_CA_CERTS',
      `security delete-certificate -c ${CA_CN} ${s.keychain}`, `security find-certificate -c ${CA_CN} ${s.keychain}`,
    ])
    assert.equal(core.state.live, false, 'the core no longer lists atrace-mitm')
    assert.equal(fs.readFileSync(s.script, 'utf8'), USER_MAIN, 'D28: the user\'s own Script.js, byte for byte, once the block is out')
    assert.deepEqual(LABELS.map((l) => fs.existsSync(s.plist(l))), [false, false, false], 'the three LaunchAgents are gone')
    const settings = JSON.parse(fs.readFileSync(s.settings, 'utf8'))
    assert.deepEqual(settings.env, { KEEP: '1' }, 'the steer is out of settings.json (the stash displaced nothing), the user\'s own keys stay')
    assert.equal(fs.existsSync(s.stash), false)
    for (const word of ['Script.js', 'settings.json', 'com.asight.mitm', 'com.asight.monitor', 'com.asight.env', 'NODE_EXTRA_CA_CERTS', '旧命令装的,无备份']) assert.ok(io.text().includes(word), `the receipt says ${word}`)
    assert.ok(!fs.existsSync(path.join(s.home, '.asight', 'legacy-off.pending')), 'the marker of an off in progress is gone')
  } finally { await core.close() }
})

test('V12: com.asight.env goes with the old capture, and the login environment\'s CA variable is unset only when it points at asight\'s CA — another value is left, and said', async () => {
  for (const [value, unset] of [['own', true], ['/somewhere/else.pem', false], ['', false]]) {
    const s = macHome({ block: false, runtime: false, agents: ['com.asight.env'], steer: false })
    const mac = fakeMac({ loaded: ['com.asight.env'], pids: {}, env: value ? { NODE_EXTRA_CA_CERTS: value === 'own' ? s.caPath : value } : {}, keychain: false })
    const io = fakeIo()
    assert.equal(await runOffCli([], offCtx(s, io, { mac })), 0, io.text())
    assert.equal(fs.existsSync(s.plist('com.asight.env')), false, `${value || 'unset'}: the plist is removed`)
    assert.equal(mac.has(/^launchctl unsetenv NODE_EXTRA_CA_CERTS/), unset, `${value || 'unset'}: unsetenv ${unset ? 'runs' : 'does not run'}`)
    if (value === '/somewhere/else.pem') assert.match(io.text(), /not asight's CA: left as it is/)
    assert.ok(!mac.has(/^launchctl unload .*com\.asight\.(mitm|monitor)/), 'only the agent that is there')
  }
})

test('V12: off codex (a harness other than claude-code) exits 2 and calls no launchctl, no security — not one byte moves; claude-code and claude are the same as no name', async () => {
  const s = macHome(); const before = snapshot(s.home)
  const mac = fakeMac({ env: { NODE_EXTRA_CA_CERTS: s.caPath } })
  const io = fakeIo()
  assert.equal(await runOffCli(['codex'], offCtx(s, io, { mac })), 2)
  assert.match(io.text(), /本平台只有 claude-code 的旧采集,没有按 harness 的开关/)
  assert.deepEqual([mac.calls, snapshot(s.home)], [[], before], 'nothing was asked of the machine and nothing changed')
  assert.equal(await runOffCli(['claude-code', 'codex'], offCtx(s, fakeIo(), { mac })), 2)
  assert.equal(mac.calls.length, 0)
  const core = await fakeCore()
  try { assert.equal(await runOffCli(['claude'], offCtx(s, fakeIo(), { core, mac })), 0); assert.ok(mac.has(/unload .*com\.asight\.mitm/)) } finally { await core.close() }
})

test('V23: a route an old command wrote (no ledger entry) is stripped and read back from the core, and the receipt calls it 「旧命令装的,无备份」 — also when only the RUNTIME holds it (the file has no block)', async () => {
  for (const [name, seed] of [['block in Script.js and the runtime', { block: true, runtime: true }], ['no block in Script.js, the runtime still holds the route', { block: false, runtime: true }]]) {
    const s = macHome({ ...seed, agents: [], steer: false, userMain: USER_MAIN })
    const core = await fakeCore(); const mac = fakeMac({ loaded: [], keychain: false })
    try {
      const io = fakeIo()
      assert.equal(await runOffCli(['--json'], offCtx(s, io, { core, mac })), 0, `${name}: ${io.text()}`)
      const r = io.json()
      assert.deepEqual(validateReceipt(r), [], name)
      assert.ok(core.state.puts.length >= 1, `${name}: the core was reloaded even though ${seed.block ? 'the file had the block' : 'the FILE has no block'}`)
      assert.equal(core.state.puts.at(-1).payload.includes('atrace-mitm'), false, `${name}: the payload pushed carries no route`)
      assert.equal(core.state.live, false, `${name}: the core says the route is gone`)
      assert.equal(core.state.gets.length >= 1, true, `${name}: and it was ASKED (GET /proxies), not taken on trust`)
      assert.equal(fs.readFileSync(s.script, 'utf8'), USER_MAIN)
      if (seed.block) assert.ok(r.changed.some((c) => c.path === s.script && c.result === 'old-command' && c.backup === null), `${name}: a change an old command made has no backup, and says so`)
    } finally { await core.close() }
  }
})

test('V23: a core that does not answer is exit 1 and 「不知道」 — the block is out of the file, the MITM is NOT unloaded (Desktop would be left pointed at nothing), and the receipt says what to do', async () => {
  const s = macHome({ agents: ['com.asight.mitm'], steer: false }); const mac = fakeMac({ loaded: ['com.asight.mitm'], keychain: false })
  const io = fakeIo()
  assert.equal(await runOffCli(['--json'], offCtx(s, io, { mac })), 1)
  const r = io.json()
  assert.equal(r.ok, false)
  assert.ok(r.problems.some((p) => /不知道/.test(p) && /no-such-mihomo\.sock|control socket/.test(p)), r.problems.join(' | '))
  assert.equal(fs.readFileSync(s.script, 'utf8').includes(BLOCK), false, 'the file half is done')
  assert.equal(mac.has(/launchctl unload .*com\.asight\.mitm/), false, 'the MITM keeps running while the route may still lead to it')
  assert.equal(fs.existsSync(s.plist('com.asight.mitm')), true)
  assert.ok(r.skipped.some((x) => x.what === 'com.asight.mitm' && /not confirmed gone/.test(x.reason)))
  assert.equal(r.relayed, 'unknown', 'the MITM keeps serving: how many connections it still relays is 「不知道」, never a count of 0 (R5, R11)')
  assert.match(r.relayed_reason, /Clash route was not confirmed gone, so the MITM was left running/)
  assert.ok(readEvents(s.home).some((e) => e.event === 'failure' && e.where === 'off'), 'R11: a failure is a line in the old capture\'s log')
  const text = fakeIo(); await runOffCli([], offCtx(s, text, { mac }))
  assert.match(text.text(), /仍经 asight 的连接数: 不知道\(the Clash route was not confirmed gone/, 'and the printed receipt says so too')
})

test('V23: a reload the core accepted is not proof — when the proxy list cannot be read back, the route is 「不知道」 (exit 1) and the MITM is left running; a rejected reload is a failure of its own', async () => {
  const s = macHome({ agents: ['com.asight.mitm'], steer: false }); const mac = fakeMac({ loaded: ['com.asight.mitm'], pids: {}, keychain: false })
  const core = await fakeCore({ breakProxies: true })
  try {
    const io = fakeIo()
    assert.equal(await runOffCli(['--json'], offCtx(s, io, { core, mac })), 1)
    const r = io.json()
    assert.ok(core.state.puts.length >= 1 && r.problems.some((p) => /不知道/.test(p)), r.problems.join(' | '))
    assert.equal(mac.has(/unload .*com\.asight\.mitm/), false)
    assert.equal(r.relayed, 'unknown'); assert.ok(r.relayed_reason)
  } finally { await core.close() }
  const s2 = macHome({ agents: ['com.asight.mitm'], steer: false }); const mac2 = fakeMac({ loaded: ['com.asight.mitm'], pids: {}, keychain: false })
  const core2 = await fakeCore({ rejectAll: 'rules[3] [NOPE] error' })
  try {
    const io = fakeIo()
    assert.equal(await runOffCli(['--json'], offCtx(s2, io, { core: core2, mac: mac2 })), 1)
    const r = io.json()
    assert.ok(r.problems.some((p) => /rules\[3\] \[NOPE\] error/.test(p) && !/不知道/.test(p)), 'mihomo\'s own message, and not "unknown": the core answered, it said no')
    assert.equal(mac2.has(/unload .*com\.asight\.mitm/), false)
    assert.equal(r.relayed, 'unknown', 'a rejected reload leaves the MITM serving too: not a count of 0'); assert.match(r.relayed_reason, /not confirmed gone/)
  } finally { await core2.close() }
})

test('V23: while the route is not confirmed gone the MITM keeps running and so does the trust for its certificate — the primer plist, the login variable and the CA stay (a Desktop started now would meet the MITM without it), each is listed as skipped with the reason, the monitor still goes; the next off with the core answering takes them all out', async () => {
  const s = macHome({ userMain: USER_MAIN, steer: false }) // block, runtime, the three LaunchAgents
  const mac = fakeMac({ env: { NODE_EXTRA_CA_CERTS: s.caPath }, pids: {} })
  const io = fakeIo()
  assert.equal(await runOffCli(['--json'], offCtx(s, io, { mac })), 1, io.text()) // the core is a socket nobody listens on
  const r = io.json()
  assert.equal(fs.existsSync(s.plist('com.asight.monitor')), false, 'the monitor is the CC-CLI proxy\'s: it is not held by the Clash route')
  assert.deepEqual(['com.asight.mitm', 'com.asight.env'].map((l) => [fs.existsSync(s.plist(l)), mac.state.loaded.has(l)]), [[true, true], [true, true]], 'the MITM and the primer are as they were')
  assert.deepEqual([mac.has(/^launchctl unsetenv/), mac.has(/^security delete-certificate/), mac.has(/^launchctl unload .*com\.asight\.(mitm|env)/)], [false, false, false])
  assert.equal(mac.state.env.NODE_EXTRA_CA_CERTS, s.caPath); assert.equal(mac.state.keychain, true)
  for (const what of ['com.asight.mitm', 'com.asight.env', 'launchctl setenv NODE_EXTRA_CA_CERTS', s.keychain]) assert.ok(r.skipped.some((x) => x.what === what && /not confirmed gone/.test(x.reason)), `${what} is listed as skipped, with the reason`)
  assert.equal(r.relayed, 'unknown')
  const core = await fakeCore({ live: true })
  try {
    const again = fakeIo()
    assert.equal(await runOffCli(['--json'], offCtx(s, again, { core, mac })), 0, again.text())
    assert.deepEqual(['com.asight.mitm', 'com.asight.env'].map((l) => fs.existsSync(s.plist(l)) || mac.state.loaded.has(l)), [false, false])
    assert.deepEqual([mac.state.env.NODE_EXTRA_CA_CERTS, mac.state.keychain, core.state.live], [undefined, false, false], 'the second off finishes what the first held back')
    assert.deepEqual(again.json().skipped.filter((x) => /not confirmed gone/.test(x.reason)), [])
  } finally { await core.close() }
})

test('V31: `launchctl unload` of the MITM blocks until the job has exited, so it is given the drain — drainMs + 10 s (20 s by default), not the tool\'s default 10 s; the other tools keep the default; a MITM that is gone when the unload was cut off is read from `launchctl list`, not from the exit code', async () => {
  const s = macHome({ agents: ['com.asight.mitm', 'com.asight.monitor'], steer: false, userMain: USER_MAIN })
  const core = await fakeCore(); const mac = fakeMac({ loaded: ['com.asight.mitm', 'com.asight.monitor'], pids: {}, keychain: false })
  const seen = []
  const run = (file, args, o) => { seen.push({ cmd: [file, ...args].join(' '), timeout: o && o.timeout }); return mac.run(file, args) }
  try {
    const io = fakeIo()
    assert.equal(await runOffCli(['--json'], offCtx(s, io, { core, mac, deps: { exec: run } })), 0, io.text())
    const timeoutOf = (re) => seen.filter((x) => re.test(x.cmd)).map((x) => x.timeout)
    assert.deepEqual(timeoutOf(/^launchctl unload .*com\.asight\.mitm/), [20000], 'the whole drain, the grace after it, and 5 s more')
    assert.deepEqual(timeoutOf(/^launchctl unload .*com\.asight\.monitor/), [10000], 'the default for a job that does not drain')
    assert.ok(timeoutOf(/^launchctl list/).every((t) => t === 10000))
  } finally { await core.close() }
  // the unload ran into its limit (exit code none) but the job is gone: that is what `launchctl list` says, and that is what counts
  const t = macHome({ agents: ['com.asight.mitm'], steer: false, userMain: USER_MAIN })
  const core2 = await fakeCore(); const mac2 = fakeMac({ loaded: ['com.asight.mitm'], pids: {}, keychain: false })
  const cutOff = (file, args, o) => { const r = mac2.run(file, args, o); return file === 'launchctl' && args[0] === 'unload' ? { status: null, stdout: '', stderr: '', error: new Error('spawnSync launchctl ETIMEDOUT') } : r }
  try {
    const io = fakeIo()
    assert.equal(await runOffCli(['--json', '--now'], offCtx(t, io, { core: core2, mac: mac2, deps: { exec: cutOff, drainMs: 0 } })), 0, io.text())
    assert.equal(fs.existsSync(t.plist('com.asight.mitm')), false)
  } finally { await core2.close() }
})

test('V23 / D28: a Merge.yaml of the user\'s own — prepend-rules that are not asight\'s — is no evidence of asight and is never rewritten: not one byte, no row in the receipt, no reload of Clash; with asight\'s route elsewhere the route comes out and Merge.yaml still is not touched', async () => {
  const MERGE = 'prepend-rules:\n  - DOMAIN,corp.example.com,DIRECT\n  - DOMAIN-SUFFIX,intranet.example,DIRECT\n'
  const s = macHome({ block: false, runtime: false, agents: [], steer: false, ca: false, userMain: USER_MAIN }); fs.writeFileSync(s.merge, MERGE)
  const core = await fakeCore({ live: false }); const mac = fakeMac({ loaded: [], keychain: false })
  try {
    const before = snapshot(s.home); const io = fakeIo()
    assert.equal(await runOffCli(['--json'], offCtx(s, io, { core, mac })), 0, io.text())
    assert.equal(fs.readFileSync(s.merge, 'utf8'), MERGE, 'Merge.yaml is the user\'s: byte for byte')
    assert.equal(core.state.puts.length, 0, 'nothing says asight put a route in this Clash: it is not reloaded')
    assert.deepEqual([io.json().changed, changedFiles(before, snapshot(s.home))], [[], []], 'no row in the receipt, no file different')
  } finally { await core.close() }
  const t = macHome({ block: true, runtime: true, agents: [], steer: false, userMain: USER_MAIN }); fs.writeFileSync(t.merge, MERGE)
  const core2 = await fakeCore({ live: true }); const mac2 = fakeMac({ loaded: [], keychain: false })
  try {
    const io = fakeIo()
    assert.equal(await runOffCli(['--json'], offCtx(t, io, { core: core2, mac: mac2 })), 0, io.text())
    assert.equal(fs.readFileSync(t.script, 'utf8'), USER_MAIN, 'the route is out of Script.js')
    assert.equal(fs.readFileSync(t.merge, 'utf8'), MERGE, 'and Merge.yaml still is not touched')
    assert.ok(!io.json().changed.some((c) => c.path === t.merge), 'the receipt does not list it')
  } finally { await core2.close() }
})

test('V23: the core lists the route but there is no runtime config to reload from — off cannot take it out: exit 1, the problem says why (not "undefined"), no reload is sent, the MITM is left running', async () => {
  const s = macHome({ block: false, runtime: false, agents: ['com.asight.mitm'], steer: false }); fs.rmSync(s.runtimePath)
  const core = await fakeCore({ live: true }); const mac = fakeMac({ loaded: ['com.asight.mitm'], pids: {}, keychain: false })
  try {
    const io = fakeIo()
    assert.equal(await runOffCli(['--json'], offCtx(s, io, { core, mac })), 1, io.text())
    const r = io.json()
    assert.ok(r.problems.some((p) => /still in the core's live proxy list and no reload was made: there is no runtime config/.test(p)), r.problems.join(' | '))
    assert.ok(!r.problems.join(' ').includes('undefined') && r.skipped.every((x) => !String(x.reason).includes('undefined')))
    assert.deepEqual([core.state.puts.length, mac.has(/launchctl unload .*com\.asight\.mitm/)], [0, false])
    assert.ok(r.left.some((l) => l.path === s.script && l.reason && l.result === 'error'), 'the row left says why')
  } finally { await core.close() }
})

test('V23 + R2: a ledgered block (asight on wrote it, with a backup) — the backup goes when Script.js is back to what it was; one the file no longer matches is KEPT and listed (kept_backups), and the ledger keeps it', async () => {
  for (const [name, userMain, identical] of [['custom main()', USER_MAIN, true], ['the stock no-op main()', NO_OP, false]]) {
    const s = macHome({ userMain, agents: [], steer: false })
    const backup = writeBackup({ home: s.home, file: s.script, data: userMain, now: new Date('2026-10-07T01:00:00Z') })
    const m = newManifest(new Date('2026-10-07T01:00:00Z'))
    m.entries.push({ kind: 'legacy-clash-block', harness: 'claude-code', path: s.script, existed_before: true, pre_sha256: sha256(userMain), post_sha256: sha256(fs.readFileSync(s.script)), backup, installed_at: '2026-10-07T01:00:00.000Z' })
    saveManifestAt(legacyManifestPath(s.home), m)
    const core = await fakeCore(); const mac = fakeMac({ loaded: [], keychain: false })
    try {
      const io = fakeIo()
      assert.equal(await runOffCli(['--json'], offCtx(s, io, { core, mac })), 0, io.text())
      const r = io.json()
      const row = r.changed.find((c) => c.path === s.script)
      if (identical) {
        assert.equal(fs.existsSync(backup), false, `${name}: the backup is dropped`)
        assert.equal(fs.existsSync(legacyManifestPath(s.home)), false, `${name}: and the ledger, with nothing left in it`)
        assert.equal(row.backup_dropped, true); assert.equal(row.result, 'reverted')
      } else {
        assert.equal(fs.existsSync(backup), true, `${name}: the file is not byte for byte what it was: the backup stays`)
        assert.equal(row.result, 'reverted-not-identical')
        assert.deepEqual(r.kept_backups.map((k) => [k.path, k.backup]), [[s.script, backup]])
        const left = JSON.parse(fs.readFileSync(legacyManifestPath(s.home), 'utf8'))
        assert.deepEqual([left.entries.length, left.kept_backups.map((k) => k.backup)], [0, [backup]], `${name}: the ledger keeps the pointer to it`)
      }
    } finally { await core.close() }
  }
})

test('R3 / V3: the receipt lists what changed — every file that differs after off is in it; --json passes validateReceipt; the old capture\'s log has the off-note lines and the last is the result', async () => {
  const s = macHome({ userMain: USER_MAIN }); const before = snapshot(s.home)
  const core = await fakeCore(); const mac = fakeMac({ env: { NODE_EXTRA_CA_CERTS: s.caPath } })
  try {
    const io = fakeIo()
    assert.equal(await runOffCli(['--json'], offCtx(s, io, { core, mac })), 0, io.text())
    const r = io.json()
    assert.deepEqual(validateReceipt(r), [])
    assert.equal(r.command, 'off'); assert.equal(r.legacy, true)
    const listed = new Set([...r.changed.map((c) => c.path), ...r.removed])
    for (const f of changedFiles(before, snapshot(s.home))) {
      const abs = path.join(s.home, f)
      if (abs === r.log) continue // the log is named in `log`
      assert.ok(listed.has(abs), `${f} changed and the receipt does not list it`)
    }
    const ev = readEvents(s.home)
    assert.ok(ev.length >= 3 && ev.every((e) => e.event === 'off-note' || e.event === 'failure'))
    assert.equal(ev.at(-1).kind, 'result')
    for (const e of ev) assert.deepEqual(checkRecord(e), [], JSON.stringify(e))
  } finally { await core.close() }
})

// ── V31 ────────────────────────────────────────────────────────────────────────────────────────────

/** A real legacyLifecycle around a real http server in this process, its `proc` a fake: `launchctl unload` of the MITM makes the fake launchd send it SIGTERM. */
async function liveMitm(s, clock) {
  const proc = Object.assign(new EventEmitter(), { pid: 4242, exited: false, exit() { this.exited = true } })
  const server = http.createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const file = path.join(s.home, '.asight', 'logs', 'mitm-events.ndjson')
  const record = (rec) => appendLegacyEvent(rec, { file, now: new Date(clock.ms()), log: () => {} })
  const life = legacyLifecycle({ source: 'mitm', port: server.address().port, out: path.join(s.home, 'cap.ndjson'), record, proc, log: () => {}, server, drainMs: 10000, clock })
  life.started()
  const clients = []
  const connect = () => new Promise((resolve) => { const c = net.connect(server.address().port, '127.0.0.1', () => resolve(c)); clients.push(c); c.on('error', () => {}) })
  return { proc, server, connect, close: () => { for (const c of clients) c.destroy(); server.close() } }
}

test('V31: with a connection open the MITM drains — the recorded order is strip → reload → verify → unload; the connection ending at 2 s is cut: 0, the receipt says so', async () => {
  const s = macHome({ agents: ['com.asight.mitm'], steer: false }); const order = []; const clock = fakeClock()
  const core = await fakeCore({ order }); const m = await liveMitm(s, clock)
  const mac = fakeMac({ loaded: ['com.asight.mitm'], pids: { 'com.asight.mitm': 4242 }, keychain: false, order, onUnload: (label) => { if (label === 'com.asight.mitm') m.proc.emit('SIGTERM') } })
  try {
    const c = await m.connect()
    clock.at(2000, () => c.destroy())
    const io = fakeIo()
    assert.equal(await runOffCli(['--json'], offCtx(s, io, { core, mac, clock, deps: { alive: (pid) => pid === 4242 && !m.proc.exited } })), 0, io.text())
    const r = io.json()
    assert.deepEqual(order.filter((x) => /^(PUT|GET \/proxies|launchctl unload)/.test(x)).map((x) => x.replace(s.la + '/', '')), ['PUT /configs', 'GET /proxies', 'launchctl unload com.asight.mitm.plist'], 'strip → reload → verify → unload')
    assert.deepEqual(r.relayed, { closing: 0, waiting: 0, cut: 0 }, 'the connection ended by itself inside the drain: nothing was cut')
    assert.ok(clock.elapsed() >= 2000 && clock.elapsed() < 10000, `waited for it (${clock.elapsed()} ms), not for the whole drain`)
    const stop = readEvents(s.home).find((e) => e.event === 'mitm-stop')
    assert.deepEqual([stop.source, stop.signal, stop.cut, stop.pid], ['mitm', 'SIGTERM', 0, 4242])
  } finally { m.close(); await core.close() }
})

test('V31: a connection that stays open is cut after 10 s (injected clock) and COUNTED — in mitm-stop, and in the receipt (relayed.cut)', async () => {
  const s = macHome({ agents: ['com.asight.mitm'], steer: false }); const order = []; const clock = fakeClock()
  const core = await fakeCore({ order }); const m = await liveMitm(s, clock)
  const mac = fakeMac({ loaded: ['com.asight.mitm'], pids: { 'com.asight.mitm': 4242 }, keychain: false, order, onUnload: (label) => { if (label === 'com.asight.mitm') m.proc.emit('SIGTERM') } })
  try {
    await m.connect()
    const io = fakeIo()
    assert.equal(await runOffCli([], offCtx(s, io, { core, mac, clock, deps: { alive: (pid) => pid === 4242 && !m.proc.exited } })), 0, io.text())
    assert.ok(clock.elapsed() >= 10000, `it waited the whole drain (${clock.elapsed()} ms)`)
    assert.equal(readEvents(s.home).find((e) => e.event === 'mitm-stop').cut, 1)
    assert.match(io.text(), /已切断 1 条连接/)
  } finally { m.close(); await core.close() }
})

test('V31: with no connection the unload is immediate — cut 0, no waiting; --now is accepted and says it changes nothing here (the old MITM always drains)', async () => {
  const s = macHome({ agents: ['com.asight.mitm'], steer: false }); const clock = fakeClock()
  const core = await fakeCore(); const m = await liveMitm(s, clock)
  const mac = fakeMac({ loaded: ['com.asight.mitm'], pids: { 'com.asight.mitm': 4242 }, keychain: false, onUnload: (label) => { if (label === 'com.asight.mitm') m.proc.emit('SIGTERM') } })
  try {
    const io = fakeIo()
    assert.equal(await runOffCli(['--json', '--now'], offCtx(s, io, { core, mac, clock, deps: { alive: (pid) => pid === 4242 && !m.proc.exited } })), 0, io.text())
    const r = io.json()
    assert.deepEqual(r.relayed, { closing: 0, waiting: 0, cut: 0 })
    assert.ok(clock.elapsed() < 1000, `no waiting (${clock.elapsed()} ms)`)
    assert.ok(r.notes.some((n) => /--now 在旧采集上没有用/.test(n)))
  } finally { m.close(); await core.close() }
})

test('V31: no steer-missing between the strip and the unload — the marker names off\'s live pid while it runs, the watch says nothing then, and says it again when the marker is gone', async () => {
  const s = macHome({ agents: ['com.asight.mitm'], steer: false }); const recs = []
  const marker = path.join(s.home, '.asight', 'legacy-off.pending')
  const status = async () => ({ scriptInstalled: fs.readFileSync(s.script, 'utf8').includes(BLOCK), live: true, scriptPath: s.script, proxyName: 'atrace-mitm' })
  const check = createSteerWatch({ status, record: (r) => recs.push(r), pending: () => legacyOffPending({ home: s.home }) })
  await check() // seen installed
  const seenMarker = []
  const core = await fakeCore({ onRequest: async (tag) => { if (tag === 'GET /proxies') { seenMarker.push(fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, 'utf8')).pid === process.pid); await check() } } })
  const mac = fakeMac({ loaded: ['com.asight.mitm'], pids: {}, keychain: false })
  try {
    assert.equal(await runOffCli([], offCtx(s, fakeIo(), { core, mac })), 0)
    assert.deepEqual(seenMarker, [true], 'while the route is read back, the marker names this process')
    assert.deepEqual(recs, [], 'the block was already out of Script.js when the watch looked: it said nothing')
    assert.equal(fs.existsSync(marker), false, 'and the marker is removed when off is done')
    await check()
    assert.deepEqual(recs.map((r) => r.code), ['steer-missing'], 'with no off in progress the same look IS a failure (the watch is not blind)')
    for (const r of recs) assert.deepEqual(checkRecord({ ts: 't', ...r }), [])
  } finally { await core.close() }
  assert.equal(legacyOffPending({ home: s.home, alive: () => true }), false, 'no marker, no pending')
  fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, JSON.stringify({ pid: 99999999 }))
  assert.equal(legacyOffPending({ home: s.home, alive: () => false }), false, 'a marker whose pid is dead is stale and ignored')
  assert.equal(legacyOffPending({ home: s.home, alive: () => true }), true)
})

// ── Linux: the new collector is there, and `off` still takes out what an old command left on this machine (1.6 §4 table, row Linux) ───────────────────────────────────────────────────────────────

/** What `monitor on` and a `desktop`-era install leave on a Linux machine that has the new collector: the CC-CLI steer (HTTPS_PROXY in settings.json, the displaced value in its stash) and the old CA in the
 *  user NSS database. `exec` answers `certutil` the way the real one does and hands everything else to the sandbox's runner; `certutil` lists what it was asked. */
function linuxOldCapture(s) {
  const settings = path.join(s.home, '.claude', 'settings.json'), stash = path.join(s.home, '.atrace', 'steer-backup.json'), nss = path.join(s.home, '.pki', 'nssdb')
  const j = JSON.parse(fs.readFileSync(settings, 'utf8'))
  fs.writeFileSync(settings, JSON.stringify({ ...j, env: { ...(j.env || {}), HTTPS_PROXY: 'http://127.0.0.1:8899', NO_PROXY: '127.0.0.1,localhost' } }, null, 2) + '\n')
  fs.mkdirSync(path.dirname(stash), { recursive: true }); fs.writeFileSync(stash, JSON.stringify({ settingsPath: null, env: { HTTPS_PROXY: 'http://corp:3128' } }) + '\n')
  fs.mkdirSync(nss, { recursive: true })
  let caInNss = true; const certutil = []
  const exec = (file, args, o) => {
    if (file !== 'certutil') return s.sys.exec.run(file, args, o)
    certutil.push(args.join(' '))
    if (args[0] === '-D') { caInNss = false; return { status: 0, stdout: '', stderr: '' } }
    return caInNss ? { status: 0, stdout: 'Certificate Nickname', stderr: '' } : { status: 255, stdout: '', stderr: 'certutil: Could not find cert: asight-ca' }
  }
  return { settings, stash, nss, certutil, exec }
}

test('1.6 §4 (Linux): off takes out the CC-CLI steer of `monitor on` from its stash and the old CA from the user NSS database, besides the new capture — no launchctl; off codex leaves them (they are claude-code\'s)', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  const { settings, stash, nss, certutil, exec } = linuxOldCapture(s)
  const ctx = (io, deps) => ({ io, home: s.home, env: s.sh.env, platform: 'linux', deps: s.offDeps({ getuid: () => 1000, exec, ...deps }) })
  assert.equal(await runOffCli(['codex'], ctx(fakeIo())), 0)
  assert.equal(fs.existsSync(stash), true, 'off codex: the old steer is claude-code\'s, it stays')
  assert.deepEqual(certutil, [], 'and the NSS database is not looked at')
  const io = fakeIo()
  assert.equal(await runOffCli(['--json'], ctx(io)), 0, io.text())
  const r = io.json()
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).env?.HTTPS_PROXY, 'http://corp:3128', 'the value the steer displaced is back')
  assert.equal(fs.existsSync(stash), false)
  assert.deepEqual(certutil, [`-L -d sql:${nss} -n asight-ca`, `-D -d sql:${nss} -n asight-ca`, `-L -d sql:${nss} -n asight-ca`], 'ask, delete, ask again')
  assert.equal(s.sys.exec.calls.some((c) => /^(launchctl|security) /.test(c)), false, 'Linux has no launchd and no keychain')
  assert.ok(r.changed.some((c) => c.path === settings && c.result === 'old-command'))
  assert.ok(r.changed.some((c) => c.path === nss), 'the receipt names the NSS database')
  assert.equal(fs.existsSync(path.join(s.home, '.asight', 'legacy-off.pending')), false)
})

test('1.6 §1.1, §4 (Linux): uninstall takes out the same leftovers `off` does — the CC-CLI steer from its stash and the old CA from the NSS database — so no HTTPS_PROXY is left pointing at a dead local port (zero residue); a failure of that undo is exit 1 and says so', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  const { settings, stash, nss, certutil, exec } = linuxOldCapture(s)
  const io = fakeIo()
  const exit = await runUninstallCli(['--json'], { io, env: s.sh.env, home: s.home, platform: 'linux', deps: s.offDeps({ getuid: () => 1000, exec }) })
  assert.equal(exit, 0, io.text())
  const r = io.json()
  assert.deepEqual(validateReceipt(r), [])
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).env?.HTTPS_PROXY, 'http://corp:3128', 'the value the steer displaced is back, and the dead port is gone from settings.json')
  assert.equal(fs.existsSync(stash), false, 'the stash goes with the steer')
  assert.deepEqual(certutil, [`-L -d sql:${nss} -n asight-ca`, `-D -d sql:${nss} -n asight-ca`, `-L -d sql:${nss} -n asight-ca`], 'the old CA is asked about, deleted, asked about again')
  assert.ok(r.changed.some((c) => c.path === settings && c.result === 'old-command') && r.changed.some((c) => c.path === nss), 'the receipt names both')
  assert.equal(s.sys.exec.calls.some((c) => /^(launchctl|security) /.test(c)), false, 'Linux has no launchd and no keychain')
  // a delete that fails is not "uninstalled": the CA is still trusted, so the run is exit 1 with the reason, and asight's own files stay for the next run
  const t = await installedHome({ names: ['claude-code'] })
  const bad = linuxOldCapture(t)
  const stuck = (file, args, o) => (file === 'certutil' && args[0] !== '-L' ? { status: 255, stdout: '', stderr: 'certutil: unable to open the database' } : bad.exec(file, args, o))
  const io2 = fakeIo()
  assert.equal(await runUninstallCli(['--json'], { io: io2, env: t.sh.env, home: t.home, platform: 'linux', deps: t.offDeps({ getuid: () => 1000, exec: stuck }) }), 1, io2.text())
  assert.equal(io2.json().ok, false); assert.ok(io2.json().problems.some((p) => /old CA is still/.test(p)), io2.json().problems.join(' | '))
})

test('1.6 §4 (Linux): with no old capture there is nothing to undo — off writes no file of the old capture\'s (no log, no marker, no ledger) and runs no certutil', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  const calls = s.sys.exec.calls.length
  const io = fakeIo()
  assert.equal(await runOffCli([], { io, home: s.home, env: s.sh.env, platform: 'linux', deps: s.offDeps({ getuid: () => 1000 }) }), 0, io.text())
  assert.equal(s.sys.exec.calls.slice(calls).some((c) => /^certutil /.test(c)), false)
  for (const f of ['logs/mitm-events.ndjson', 'legacy-off.pending', 'legacy-manifest.json']) assert.equal(fs.existsSync(path.join(s.home, '.asight', f)), false, f)
})

// ── on (1.6 §4: the old capture is what `on` drives where there is no new collector) ───────────────────────────────────────────────────────────────────────────────────────────────────

const onCtx = (s, io, { core = null, mac, deps = {}, env = {} } = {}) => ({
  io, home: s.home, platform: 'darwin',
  env: { PATH: process.env.PATH, ASIGHT_MIHOMO_SOCK: core ? core.sock : path.join(s.home, 'no-such-mihomo.sock'), ...env },
  deps: { getuid: () => 501, exec: mac.run, run: fakeOpenssl, netenv: async () => ({ at: '2026-10-07T00:00:00.000Z', products: [], unknown: [{ reason: 'a test: no VPN probe runs here' }] }), now: () => new Date('2026-10-07T03:00:00.000Z'), ...deps },
})
const freshMac = (o = {}) => macHome({ block: false, runtime: false, agents: [], steer: false, ca: false, userMain: USER_MAIN, ...o })
const ledgerOf = (s) => JSON.parse(fs.readFileSync(path.join(s.home, '.asight', 'legacy-manifest.json'), 'utf8'))

test('V12 + V14 + V23: on writes the Clash block (the Script.js backed up first, the entry in the ledger), installs com.asight.mitm and com.asight.env, and says it drives the old capture; the receipt lists every file and names the way back', async () => {
  const s = freshMac(); const order = []
  const core = await fakeCore({ live: false, order }); const mac = fakeMac({ loaded: [], keychain: false, order })
  try {
    const original = fs.readFileSync(s.script, 'utf8'); const before = snapshot(s.home)
    const io = fakeIo()
    assert.equal(await runOnCli(['--yes', '--json'], onCtx(s, io, { core, mac })), 0, io.text())
    const r = io.json()
    assert.deepEqual(validateReceipt(r), []); assert.equal(r.command, 'on'); assert.equal(r.legacy, true)
    assert.equal(io.stderrText().split('\n')[0], LEGACY_NOTE, 'on says first which generation it drives (the one JSON is stdout)')
    // the route: backup first, then the block, reloaded, live
    assert.ok(fs.readFileSync(s.script, 'utf8').includes(BLOCK))
    const e = ledgerOf(s).entries.find((x) => x.kind === 'legacy-clash-block' && x.path === s.script)
    assert.deepEqual([e.pre_sha256, e.post_sha256], [sha256(original), sha256(fs.readFileSync(s.script))])
    assert.equal(fs.readFileSync(e.backup, 'utf8'), original, 'the backup holds Script.js as it was before the block')
    assert.equal(fs.statSync(e.backup).mode & 0o777, 0o600); assert.equal(fs.statSync(backupDir(s.home)).mode & 0o777, 0o700)
    assert.ok(r.changed.some((c) => c.path === s.script && c.backup === e.backup), 'the receipt lists it with its backup')
    assert.equal(core.state.live, true); assert.ok(order.indexOf('PUT /configs') >= 0)
    // the agents
    for (const label of ['com.asight.mitm', 'com.asight.env']) { assert.ok(fs.existsSync(s.plist(label)), label); assert.ok(mac.state.loaded.has(label), `${label} is loaded`) }
    assert.match(fs.readFileSync(s.plist('com.asight.mitm'), 'utf8'), /<key>ExitTimeOut<\/key><integer>15<\/integer>/)
    assert.match(fs.readFileSync(s.plist('com.asight.env'), 'utf8'), new RegExp(`NODE_EXTRA_CA_CERTS</string>\\s*<string>${s.caPath}</string>`))
    assert.equal(fs.existsSync(s.plist('com.asight.monitor')), false, 'the monitor (the CC-CLI proxy) is `monitor on`\'s, not on\'s')
    assert.deepEqual(ledgerOf(s).entries.map((x) => x.kind).sort(), ['legacy-clash-block', 'legacy-env', 'legacy-launch-agent'])
    for (const x of ledgerOf(s).entries) assert.ok(x.undo_by_hand && x.installed_at, `${x.kind} says how to undo it by hand`)
    // never the old CC-CLI steer (it cannot meet the off guarantee, 1.6 §4)
    assert.equal(fs.existsSync(s.stash), false); assert.equal(fs.readFileSync(s.settings, 'utf8'), '{"model":"x"}\n', 'settings.json is not touched')
    assert.equal(mac.has(/security add-certificates/), false, 'on does not put the CA into the keychain: node trusts it through the variable')
    // every file that changed is in the receipt; the way back is named
    const listed = new Set([...r.changed.map((c) => c.path), ...r.changed.map((c) => c.backup).filter(Boolean), ...r.created.map((c) => (typeof c === 'string' ? c : c.path))])
    for (const f of changedFiles(before, snapshot(s.home))) { const abs = path.join(s.home, f); if (abs !== r.log && !listed.has(abs) && ![...listed].some((l) => abs.startsWith(l + path.sep))) assert.fail(`${f} changed and the receipt does not list it`) }
    assert.ok(r.undo.includes(standalonePath(s.home)) && r.created.includes(standalonePath(s.home)), 'asight-off is written first and named: the way back works without the repository')
    assert.ok(fs.existsSync(standalonePath(s.home)))
    assert.ok(ledgerOf(s).confirmed_paths.includes(s.script), 'what the operator confirmed is recorded (the next on asks only about more)')
  } finally { await core.close() }
})

test('V23 round trip: on, then off — Script.js is back to the user\'s own bytes, both backups and the ledger are gone, the agents are unloaded, nothing of asight\'s is left on the Mac', async () => {
  const s = freshMac(); const order = []
  const core = await fakeCore({ live: false, order }); const mac = fakeMac({ loaded: [], keychain: false, order, pids: {} })
  try {
    const original = fs.readFileSync(s.script, 'utf8')
    assert.equal(await runOnCli(['--yes'], onCtx(s, fakeIo(), { core, mac })), 0)
    const backups = fs.readdirSync(backupDir(s.home))
    assert.equal(backups.length, 1)
    const io = fakeIo()
    assert.equal(await runOffCli(['--json'], offCtx(s, io, { core, mac, deps: { exec: mac.run } })), 0, io.text())
    assert.equal(fs.readFileSync(s.script, 'utf8'), original)
    assert.equal(core.state.live, false)
    assert.equal(fs.existsSync(path.join(s.home, '.asight', 'legacy-manifest.json')), false)
    assert.equal(fs.existsSync(backupDir(s.home)) ? fs.readdirSync(backupDir(s.home)).length : 0, 0, 'verified back to its pre_sha256: the backup is dropped')
    assert.deepEqual(['com.asight.mitm', 'com.asight.env'].map((l) => fs.existsSync(s.plist(l)) || mac.state.loaded.has(l)), [false, false])
    const r = io.json()
    assert.ok(r.changed.some((c) => c.path === s.script && c.result === 'reverted' && c.backup_dropped === true), 'asight on wrote it, so it is not 「旧命令装的」 and its backup went')
    assert.ok(r.changed.filter((c) => c.launch_agent).every((c) => c.result === 'reverted'), 'and the plists it installed are its own too')
  } finally { await core.close() }
})

test('R6 / V7: not in a terminal and no --yes, on prints the plan and writes nothing, calls nothing, exits 2; --dry-run exits 0 with the same lines; a terminal is asked once and no says no', async () => {
  const s = freshMac(); const before = snapshot(s.home)
  const mac = fakeMac({ loaded: [], keychain: false })
  const plan = fakeIo()
  assert.equal(await runOnCli([], onCtx(s, plan, { mac })), 2)
  for (const word of ['Script.js', 'com.asight.mitm.plist', 'com.asight.env.plist', 'legacy-manifest.json', 'asight-off', '备份', 'Claude Desktop']) assert.ok(plan.text().includes(word), `the plan names ${word}`)
  assert.deepEqual([snapshot(s.home), mac.calls], [before, []], 'nothing written, nothing asked of launchd')
  const dry = fakeIo()
  assert.equal(await runOnCli(['--dry-run'], onCtx(s, dry, { mac })), 0)
  assert.deepEqual([snapshot(s.home), mac.calls], [before, []])
  assert.match(dry.text(), /将打开采集/); assert.ok(dry.text().includes('Script.js'))
  const no = fakeIo({ tty: true, answers: ['n'] })
  assert.equal(await runOnCli([], onCtx(s, no, { mac })), 1)
  assert.equal(no.asked.length, 1); assert.deepEqual([snapshot(s.home), mac.calls], [before, []])
})

test('R8 / R9: on over an old capture that is already there (an old `desktop on`) leaves it alone — no unload, no load, no reload, no restart of the running MITM — and the second on writes nothing and asks nothing; what an old command wrote is 「旧命令装的,无备份」', async () => {
  const s = macHome({ userMain: USER_MAIN, steer: false })
  const core = await fakeCore({ live: true }); const mac = fakeMac({ keychain: false, env: { NODE_EXTRA_CA_CERTS: s.caPath } })
  try {
    const scriptBefore = fs.readFileSync(s.script, 'utf8')
    const io = fakeIo()
    assert.equal(await runOnCli(['--yes', '--json'], onCtx(s, io, { core, mac })), 0, io.text())
    const r = io.json()
    assert.deepEqual(mac.mutating(), [], 'a running capture is not restarted by on (R8)')
    assert.equal(core.state.puts.length, 0, 'the route is live: Clash is not reloaded for nothing')
    assert.equal(fs.readFileSync(s.script, 'utf8'), scriptBefore, 'Script.js is not rewritten')
    assert.equal(fs.existsSync(path.join(s.home, '.asight', 'legacy-manifest.json')), false, 'nothing was written by this on: nothing to put in the ledger')
    assert.ok((r.unchanged || []).includes(s.script) && (r.unchanged || []).includes(s.plist('com.asight.mitm')), 'the receipt says what was already in place')
    assert.ok(r.notes.some((n) => n.includes('旧命令装的,无备份')), 'and who wrote it')
    // the second on: no plan, no question, no file
    const mid = snapshot(s.home)
    const again = fakeIo({ tty: true })
    assert.equal(await runOnCli([], onCtx(s, again, { core, mac })), 0, again.text())
    assert.deepEqual([again.asked, snapshot(s.home), mac.mutating()], [[], mid, []], 'on, on: nothing asked, nothing written, nothing run')
  } finally { await core.close() }
})

test('V12 (on): a harness other than claude-code, --no-autostart and --no-unit are exit 2 with nothing touched; Windows has no old capture to turn on: 本平台未实现, exit 1; on as root is refused', async () => {
  const s = freshMac(); const before = snapshot(s.home); const mac = fakeMac({ loaded: [], keychain: false })
  for (const argv of [['codex'], ['claude-code', 'hermes'], ['--no-autostart'], ['--no-unit']]) {
    const io = fakeIo()
    assert.equal(await runOnCli(['--yes', ...argv], onCtx(s, io, { mac })), 2, argv.join(' '))
  }
  const names = fakeIo(); await runOnCli(['--yes', 'codex'], onCtx(s, names, { mac }))
  assert.match(names.text(), /本平台只有 claude-code 的旧采集,没有按 harness 的开关/)
  const win = fakeIo()
  assert.equal(await runOnCli(['--yes'], { ...onCtx(s, win, { mac }), platform: 'win32' }), 1)
  assert.match(win.text(), /本平台未实现/)
  const root = fakeIo()
  assert.equal(await runOnCli(['--yes'], onCtx(s, root, { mac, deps: { getuid: () => 0 } })), 1)
  assert.match(root.text(), /root/)
  assert.deepEqual([snapshot(s.home), mac.calls], [before, []])
})

test('V23: a core that does not take the route is exit 1 — the durable half is in (Script.js, the ledger: off can take it out), the receipt says why and how to apply it by hand; no Clash Verge on the machine is exit 1 with nothing written', async () => {
  const s = freshMac(); const mac = fakeMac({ loaded: [], keychain: false })
  const io = fakeIo()
  assert.equal(await runOnCli(['--yes', '--json'], onCtx(s, io, { mac })), 1) // the core is a socket nobody listens on
  const r = io.json()
  assert.equal(r.ok, false); assert.ok(r.notes.some((p) => /NOT live now/.test(p) && /reactivate/.test(p)), r.notes.join(' | '))
  assert.ok(fs.readFileSync(s.script, 'utf8').includes(BLOCK)); assert.equal(ledgerOf(s).entries.some((x) => x.kind === 'legacy-clash-block'), true, 'it is in the ledger: off takes it out')
  const bare = macHome({ block: false, runtime: false, agents: [], steer: false, ca: false, verge: false }); const b = snapshot(bare.home)
  const io2 = fakeIo()
  assert.equal(await runOnCli(['--yes'], onCtx(bare, io2, { mac: fakeMac({ loaded: [], keychain: false }) })), 1)
  assert.match(io2.text(), /Clash Verge/)
  assert.deepEqual(snapshot(bare.home), b, 'no Verge: not even its directories were made')
})

test('R2: a backup that cannot be written stops the change — Script.js keeps its bytes, nothing is reloaded, no agent is installed, the failure is exit 1 with its reason and a backup-failed line in the old capture\'s log', async () => {
  const s = freshMac(); const core = await fakeCore({ live: false }); const mac = fakeMac({ loaded: [], keychain: false })
  try {
    fs.mkdirSync(path.join(s.home, '.asight'), { recursive: true }); fs.writeFileSync(backupDir(s.home), 'a file where the backup directory should be')
    const original = fs.readFileSync(s.script, 'utf8')
    const io = fakeIo()
    assert.equal(await runOnCli(['--yes', '--json'], onCtx(s, io, { core, mac })), 1, io.text())
    const r = io.json()
    assert.equal(r.ok, false); assert.ok(r.notes.some((n) => /backup/.test(n) && /was not changed/.test(n)), r.notes.join(' | '))
    assert.equal(fs.readFileSync(s.script, 'utf8'), original); assert.equal(core.state.puts.length, 0)
    assert.deepEqual([fs.existsSync(s.plist('com.asight.mitm')), mac.mutating()], [false, []])
    const ev = readEvents(s.home).find((e) => e.code === 'backup-failed')
    assert.ok(ev && ev.event === 'failure' && ev.where === 'install', 'the failure is in the log'); assert.deepEqual(checkRecord(ev), [])
  } finally { await core.close() }
})

test('R9 / V23: an old capture that is half there — the block is in Script.js but the core has no route, the agent plists are there but not loaded — is completed: the core gets the route, the agents are loaded, no file is rewritten, and the receipt says it is 「旧命令装的,无备份」', async () => {
  const s = macHome({ userMain: USER_MAIN, steer: false, runtime: true }); const core = await fakeCore({ live: false }); const mac = fakeMac({ loaded: [], keychain: false })
  try {
    const before = snapshot(s.home)
    const io = fakeIo()
    assert.equal(await runOnCli(['--yes', '--json'], onCtx(s, io, { core, mac })), 0, io.text())
    const r = io.json()
    assert.equal(core.state.live, true, 'the route is in the core now')
    assert.deepEqual(['com.asight.mitm', 'com.asight.env'].map((l) => mac.state.loaded.has(l)), [true, true])
    assert.equal(mac.has(/launchctl unload/), false, 'an agent that is there is loaded, never unloaded and loaded again')
    for (const f of [s.plist('com.asight.mitm'), s.plist('com.asight.env')]) assert.ok(!changedFiles(before, snapshot(s.home)).includes(path.relative(s.home, f)), `${f} was not rewritten`)
    assert.ok(r.changed.some((c) => c.path === s.plist('com.asight.mitm') && /launchctl load/.test(c.change)))
    assert.ok(r.notes.some((n) => n.includes('旧命令装的,无备份')))
    assert.equal(fs.existsSync(backupDir(s.home)) && fs.readdirSync(backupDir(s.home)).length > 0, false, 'nothing of the user\'s was changed, so nothing was backed up')
  } finally { await core.close() }
})

test('R6: what the operator confirmed is not asked again — after an on --yes, Verge regenerates Script.js without the block, and the next on (no terminal, no --yes) writes the block back without a question; a file that was never confirmed still stops at the plan', async () => {
  const s = freshMac(); const core = await fakeCore({ live: false }); const mac = fakeMac({ loaded: [], keychain: false })
  try {
    assert.equal(await runOnCli(['--yes'], onCtx(s, fakeIo(), { core, mac })), 0)
    fs.writeFileSync(s.script, USER_MAIN) // a regen of the profile: the block is gone
    const io = fakeIo()
    assert.equal(await runOnCli(['--json'], onCtx(s, io, { core, mac })), 0, io.text())
    assert.ok(fs.readFileSync(s.script, 'utf8').includes(BLOCK))
    assert.equal(ledgerOf(s).entries.filter((x) => x.kind === 'legacy-clash-block' && x.path === s.script).length, 2, 'each write has its own entry and its own backup')
    fs.writeFileSync(s.merge, 'prepend-proxies:\n  - name: atrace-mitm\n    type: http\n    server: 127.0.0.1\n    port: 9898\n') // a file `on` has not been confirmed for
    const plan = fakeIo()
    assert.equal(await runOnCli([], onCtx(s, plan, { core, mac })), 2)
    assert.ok(plan.text().includes('Merge.yaml'))
    // off settles both writes: Script.js is back to the user's own bytes, so both backups go and the ledger with them
    fs.rmSync(s.merge)
    assert.equal(await runOffCli(['--json'], offCtx(s, fakeIo(), { core, mac, deps: { exec: mac.run } })), 0)
    assert.equal(fs.readFileSync(s.script, 'utf8'), USER_MAIN)
    assert.deepEqual([fs.existsSync(legacyManifestPath(s.home)), fs.existsSync(backupDir(s.home)) ? fs.readdirSync(backupDir(s.home)) : []], [false, []])
  } finally { await core.close() }
})

test('V40 (wiring): the web switch\'s own `asight off` — asightOffInProcess — is the CLI run in this process: on a sandbox Mac it takes the old capture out and answers with the CLI\'s receipt and exit; a core that does not confirm is exit 1 and the receipt says so', async () => {
  const s = macHome({ userMain: USER_MAIN, steer: false }); const order = []
  const core = await fakeCore({ order }); const mac = fakeMac({ env: { NODE_EXTRA_CA_CERTS: s.caPath }, order, pids: {} })
  try {
    const c = offCtx(s, fakeIo(), { core, mac })
    const r = await asightOffInProcess({ home: s.home, env: c.env, platform: 'darwin', deps: c.deps })
    assert.equal(r.exit, 0, r.stderr); assert.deepEqual(validateReceipt(r.receipt), []); assert.equal(r.receipt.command, 'off'); assert.equal(r.receipt.ok, true)
    assert.ok(r.receipt.changed.some((x) => x.path === s.script), 'the receipt is the CLI\'s'); assert.equal(fs.readFileSync(s.script, 'utf8'), USER_MAIN)
    assert.match(r.stderr, /驱动旧采集/, 'what the CLI says on stderr comes back as well')
  } finally { await core.close() }
  const t = macHome({ userMain: USER_MAIN, steer: false }); const silent = fakeMac({ env: {}, pids: {} })
  const c2 = offCtx(t, fakeIo(), { mac: silent }) // no core answering: the route cannot be confirmed
  const bad = await asightOffInProcess({ home: t.home, env: c2.env, platform: 'darwin', deps: c2.deps })
  assert.equal(bad.exit, 1); assert.equal(bad.receipt.ok, false)
});

// ── status (1.6 §2, §4: claude-code is Desktop and CLI where the old capture is what on / off drive) ──────────────────────────────────────────────────────────────────────────────────────

const statusCtx = (s, io, { core = null, mac, deps = {}, platform = 'darwin' } = {}) => ({
  io, home: s.home, platform,
  env: { PATH: process.env.PATH, ASIGHT_MIHOMO_SOCK: core ? core.sock : path.join(s.home, 'no-such-mihomo.sock') },
  deps: { exec: mac.run, netenv: async () => ({ at: '2026-10-07T00:00:00.000Z', products: [], unknown: [{ reason: 'a test: no VPN probe runs here' }] }), ...deps },
})
const statusJson = async (s, ctx) => { const io = fakeIo(); const exit = await runStatusCli(['--json'], { ...ctx, io }); return { exit, j: io.json() } }
const NOT_NETENV = (f) => f !== '.asight/netenv.json' // the board's copy of the VPN probe is the one file status may write (src/netenv)

test('V23 / 1.6 §4: status after on — claude-code is two rows: Desktop captured (the block, the core, the MITM, the variable: each with who wrote it and the backup), CLI not captured with 「`on` 不做旧 steer;要采集 CLI 用 `monitor on`」; the ledger is listed; nothing but the VPN copy is written; exit 0', async () => {
  const s = freshMac(); const core = await fakeCore({ live: false }); const mac = fakeMac({ loaded: [], keychain: false })
  try {
    assert.equal(await runOnCli(['--yes'], onCtx(s, fakeIo(), { core, mac })), 0)
    mac.state.env.NODE_EXTRA_CA_CERTS = s.caPath // what the primer does when launchd runs it
    const before = snapshot(s.home)
    const io = fakeIo()
    assert.equal(await runStatusCli([], statusCtx(s, io, { core, mac })), 0, io.text())
    const t = io.stdoutText()
    assert.match(t, /^本平台\(darwin\)还没有新采集器:这里 asight on \/ off 驱动旧采集/m)
    assert.match(t, /^claude-code$/m); assert.match(t, /^  Desktop: 已采集$/m)
    assert.match(t, /Script\.js 里有 asight 的块\(asight on 写的,备份 ~\/\.asight\/backup\/[0-9a-f]{16}-/)
    assert.match(t, /核里:atrace-mitm 在/); assert.match(t, /com\.asight\.mitm: 已加载,在跑\(pid 4242;asight on 写的/); assert.match(t, /NODE_EXTRA_CA_CERTS = ~\/\.asight\/ca\/atrace-ca\.crt\(asight 的 CA\)/)
    assert.match(t, /^  CLI: 没开$/m); assert.ok(t.includes('`on` 不做旧 steer;要采集 CLI 用 `monitor on`'))
    assert.match(t, /asight on 的账 ~\/\.asight\/legacy-manifest\.json: 3 项/); assert.match(t, /legacy-clash-block .*Script\.js  备份 /)
    assert.ok(!t.includes('旧命令装的'), 'everything here was written by on')
    assert.deepEqual(changedFiles(before, snapshot(s.home)).filter(NOT_NETENV), [], 'status reads')
    const { exit, j } = await statusJson(s, statusCtx(s, fakeIo(), { core, mac }))
    assert.equal(exit, 0); assert.deepEqual(validateReceipt(j), [])
    const h = j.harnesses[0]
    assert.deepEqual([h.harness, h.desired, h.captured, h.desktop.state, h.cli.state], ['claude-code', 'on', true, 'captured', 'off'])
    assert.equal(j.legacy.ledger.entries.length, 3)
  } finally { await core.close() }
})

test('V23 / R11: a Clash core that does not answer is 「不知道」 and exit 3 — never a pass; a route that is in the file but not in the core is not captured, exit 1, with the reason; the old command\'s block is 「旧命令装的,无备份」', async () => {
  const s = macHome({ userMain: USER_MAIN, steer: false }); const mac = fakeMac({ keychain: false, env: { NODE_EXTRA_CA_CERTS: s.caPath } })
  const io = fakeIo()
  assert.equal(await runStatusCli([], statusCtx(s, io, { mac })), 3, io.text()) // the core is a socket nobody listens on
  assert.match(io.stdoutText(), /^  Desktop: 不知道\(Clash 的核问不到/m); assert.match(io.stdoutText(), /核里:不知道\(/)
  assert.ok(io.stdoutText().includes('旧命令装的,无备份'))
  const core = await fakeCore({ live: false })
  try {
    const bad = fakeIo()
    assert.equal(await runStatusCli([], statusCtx(s, bad, { core, mac })), 1, bad.text())
    assert.match(bad.stdoutText(), /^  Desktop: 没采集\(Clash 核里没有 atrace-mitm/m); assert.match(bad.stdoutText(), /✗ Clash 路由: .*核里:atrace-mitm 不在/)
    const { exit, j } = await statusJson(s, statusCtx(s, fakeIo(), { core, mac }))
    assert.deepEqual([exit, j.harnesses[0].captured, j.harnesses[0].desktop.state], [1, false, 'not-captured'])
  } finally { await core.close() }
})

test('1.6 §4: status where nothing of the old capture is there is exit 0 with 没开 for both parts (a Verge that does not answer is nothing to worry about when asight put nothing in it); the CLI steer of `monitor on` makes the CLI row captured while com.asight.monitor runs and not captured when it does not; a name other than claude-code is exit 2; Windows has no Desktop part', async () => {
  const s = freshMac(); const mac = fakeMac({ loaded: [], keychain: false })
  const io = fakeIo()
  assert.equal(await runStatusCli([], statusCtx(s, io, { mac })), 0, io.text())
  assert.match(io.stdoutText(), /^  Desktop: 没开$/m); assert.match(io.stdoutText(), /^  CLI: 没开$/m); assert.match(io.stdoutText(), /asight on 的账: 没有/)
  const steered = macHome({ block: false, runtime: false, agents: [] , ca: false })
  const loaded = fakeMac({ loaded: ['com.asight.monitor'], pids: { 'com.asight.monitor': 77 }, keychain: false })
  const a = fakeIo()
  assert.equal(await runStatusCli([], statusCtx(steered, a, { mac: loaded })), 0, a.text())
  assert.match(a.stdoutText(), /^  CLI: 已采集$/m); assert.match(a.stdoutText(), /旧 steer: 在位:settings\.json 的 env\.HTTPS_PROXY = http:\/\/127\.0\.0\.1:9898\(旧命令装的,无备份\)/); assert.match(a.stdoutText(), /com\.asight\.monitor: 已加载\(pid 77\)/)
  const b = fakeIo()
  assert.equal(await runStatusCli([], statusCtx(steered, b, { mac: fakeMac({ loaded: [], keychain: false }) })), 1, b.text())
  assert.match(b.stdoutText(), /^  CLI: 没采集\(com\.asight\.monitor 没在跑/m)
  const name = fakeIo()
  assert.equal(await runStatusCli(['codex'], statusCtx(s, name, { mac })), 2); assert.match(name.stderrText(), /本平台只有 claude-code 的旧采集,没有按 harness 的开关/)
  const win = fakeIo()
  assert.equal(await runStatusCli([], statusCtx(freshMac(), win, { mac, platform: 'win32' })), 0, win.text()); assert.match(win.stdoutText(), /Desktop: 没开/); assert.match(win.stdoutText(), /本平台\(win32\)没有旧采集的 Desktop 部分/)
})

test('1.6 §4: Desktop is captured only when every part holds — a MITM that is loaded but not running, a login variable that is unset or points at another CA, each makes it 没采集 (exit 1) and names the part; with the core live the rest does not matter', async () => {
  const s = macHome({ userMain: USER_MAIN, steer: false }); const core = await fakeCore({ live: true })
  try {
    const cases = [
      ['loaded, no pid', fakeMac({ pids: {}, env: { NODE_EXTRA_CA_CERTS: s.caPath }, keychain: false }), /✗ com\.asight\.mitm: 已加载,但没在跑/],
      ['variable unset', fakeMac({ env: {}, keychain: false }), /✗ com\.asight\.env: 已装;登录环境的 NODE_EXTRA_CA_CERTS 没设/],
      ['variable of another CA', fakeMac({ env: { NODE_EXTRA_CA_CERTS: '/etc/other-ca.pem' }, keychain: false }), /✗ com\.asight\.env: .*= \/etc\/other-ca\.pem\(不是 asight 的 CA\)/],
    ]
    for (const [name, mac, line] of cases) {
      const io = fakeIo()
      assert.equal(await runStatusCli([], statusCtx(s, io, { core, mac })), 1, `${name}: ${io.text()}`)
      assert.match(io.stdoutText(), /^  Desktop: 没采集/m, name); assert.match(io.stdoutText(), line, name)
    }
  } finally { await core.close() }
})
