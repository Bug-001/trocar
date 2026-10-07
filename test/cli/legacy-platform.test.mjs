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
import { macHome, fakeMac, fakeCore, fakeClock, readEvents, USER_MAIN, NO_OP, CA_CN, LABELS } from './fixtures/legacy-ctx.mjs'
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

test('1.6 §4 (Linux): off takes out the CC-CLI steer of `monitor on` from its stash and the old CA from the user NSS database, besides the new capture — no launchctl; off codex leaves them (they are claude-code\'s)', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
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
