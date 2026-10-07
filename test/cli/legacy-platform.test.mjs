// test/cli/legacy-platform.test.mjs — `asight on | off | status` where there is no new collector (RFC 1.6 §4 「旧采集(过渡期)」; macOS today): the old capture is what they drive. V23 (the Clash route: ledgered,
// stripped, READ BACK from the core — also when only the runtime holds it; a core that does not answer is exit 1 and 「不知道」; a block an old command wrote is 「旧命令装的,无备份」), the CC-CLI steer
// from its stash, the usage error of a harness other than claude-code, Linux's leftovers.
// A sandbox HOME, a fake launchd / login environment / keychain, a Clash core on a real unix socket (test/cli/fixtures/legacy-ctx.mjs); nothing reaches the machine the tests run on (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOffCli } from '../../src/off/main.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { newManifest, saveManifestAt } from '../../src/off/manifest.mjs'
import { writeBackup } from '../../src/off/backup.mjs'
import { sha256 } from '../../src/off/fsutil.mjs'
import { legacyManifestPath } from '../../src/off/paths.mjs'
import { fakeIo, snapshot } from './fixtures/on-ctx.mjs'
import { macHome, fakeMac, fakeCore, fakeClock, readEvents, USER_MAIN, NO_OP } from './fixtures/legacy-ctx.mjs'

const BLOCK = 'atrace desktop capture'
const offCtx = (s, io, { core = null, mac, clock = fakeClock(), deps = {}, env = {} } = {}) => ({
  io, home: s.home, platform: 'darwin',
  env: { PATH: process.env.PATH, ASIGHT_MIHOMO_SOCK: core ? core.sock : path.join(s.home, 'no-such-mihomo.sock'), ...env },
  deps: { getuid: () => 501, exec: mac.run, alive: () => false, procs: async () => [], ms: clock.ms, sleep: clock.sleep, now: () => new Date(clock.ms()), ...deps },
})

test('1.6 §4: the CC-CLI steer is taken out of settings.json from its stash (the values it displaced come back, the keys it introduced go, the user\'s own keys stay), the stash is consumed, and the receipt calls it 「旧命令装的,无备份」', async () => {
  const s = macHome({ block: false, runtime: false, agents: [], displaced: { HTTPS_PROXY: 'http://corp:3128' } }); const mac = fakeMac({ loaded: [], keychain: false })
  const io = fakeIo()
  assert.equal(await runOffCli([], offCtx(s, io, { mac })), 0, io.text())
  assert.deepEqual(JSON.parse(fs.readFileSync(s.settings, 'utf8')).env, { HTTPS_PROXY: 'http://corp:3128', KEEP: '1' })
  assert.equal(fs.existsSync(s.stash), false); assert.equal(fs.existsSync(s.settings + '.asight-bak'), false, 'no copy of settings.json is left behind that the receipt does not list')
  assert.match(io.text(), /settings\.json[^\n]*旧命令装的,无备份/)
  assert.ok(!mac.has(/^security delete|^launchctl unload/), 'nothing of launchd or the keychain was there to touch')
})

test('V12: off codex (a harness other than claude-code) exits 2 and calls no launchctl, no security — not one byte moves', async () => {
  const s = macHome(); const before = snapshot(s.home)
  const mac = fakeMac({ env: { NODE_EXTRA_CA_CERTS: s.caPath } })
  for (const argv of [['codex'], ['claude-code', 'codex']]) {
    const io = fakeIo()
    assert.equal(await runOffCli(argv, offCtx(s, io, { mac })), 2)
    assert.match(io.text(), /本平台只有 claude-code 的旧采集,没有按 harness 的开关/)
  }
  assert.deepEqual([mac.calls, snapshot(s.home)], [[], before], 'nothing was asked of the machine and nothing changed')
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
  assert.ok(readEvents(s.home).some((e) => e.event === 'failure' && e.where === 'off'), 'R11: a failure is a line in the old capture\'s log')
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
  } finally { await core.close() }
  const s2 = macHome({ agents: ['com.asight.mitm'], steer: false }); const mac2 = fakeMac({ loaded: ['com.asight.mitm'], pids: {}, keychain: false })
  const core2 = await fakeCore({ rejectAll: 'rules[3] [NOPE] error' })
  try {
    const io = fakeIo()
    assert.equal(await runOffCli(['--json'], offCtx(s2, io, { core: core2, mac: mac2 })), 1)
    const r = io.json()
    assert.ok(r.problems.some((p) => /rules\[3\] \[NOPE\] error/.test(p) && !/不知道/.test(p)), 'mihomo\'s own message, and not "unknown": the core answered, it said no')
    assert.equal(mac2.has(/unload .*com\.asight\.mitm/), false)
  } finally { await core2.close() }
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
