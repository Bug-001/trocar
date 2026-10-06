// test/collector/f-group.test.mjs — RFC 4.6 验收 F 组 (D38 「失败不静默」), one runnable check per F item. Each check
// makes the failure happen in the real component (the daemon over the fake helper and a synthetic /proc, the engine
// with real TLS clients, install / uninstall, the sealer), then asserts what F asks of every item: (i) a durable record
// on disk with a closed reason code; (ii) GET /api/capture-health — over HTTP, from a real `asight serve` server —
// shows the same reason; and for the daemon side (iii) `asight collector status` lists it with no daemon running.
//   Where an F item is checked elsewhere, the test that does is named in place (F5, F8, F9). What waits on another
// lane's code (the engine's connection-row codes, C2 T-1 / T-2 / T-4 / T-13 / T-15) is a `todo` test: it runs, and
// turns into a plain test when that lands. [VM] items are listed at the end; they are not run here.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import http from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { startDaemon } from '../../src/collector/daemon.mjs'
import { installCollector, uninstallCollector } from '../../src/collector/install.mjs'
import { controlRequest } from '../../src/collector/core/control.mjs'
import { runCollector } from '../../src/collector/cli.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../src/collector/core/tls/leaf.mjs'
import { createRedirectorClient } from '../../src/collector/arch/linux/redirector-client.mjs'
import { createLinuxRedirector } from '../../src/collector/arch/linux/redirector.mjs'
import cc from '../../src/collector/harness/claude-code.mjs'
import { createServer } from '../../src/server.mjs'
import { sealShard, sealUnchecked } from '../../src/raw/seal.mjs'
import { fakeProc } from './arch/linux/fixtures/fake-proc.mjs'
import { checkRecord } from '../../src/health/codes.mjs'

const FAKE = fileURLToPath(new URL('./arch/linux/fixtures/fake-loader.mjs', import.meta.url))
const UID = process.getuid()
const CC_EXE = '/home/u/.local/share/claude/versions/2.1.289'
function fakeArch(p, extraEnv = {}) {
  const clients = []
  const makeClient = () => { const c = createRedirectorClient({ binary: process.execPath, args: [FAKE], env: { ...process.env, ASIGHT_FAKE_LOADER: '1', ...extraEnv }, autoHeartbeatMs: 0 }); clients.push(c); return c }
  return { clients, arch: { os: 'linux', createRedirector: () => createLinuxRedirector({ makeClient, procRoot: p.root, uid: UID }) } }
}
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-f-')) // short: unix socket paths are length-limited
  const home = path.join(root, 'home'); fs.mkdirSync(home)
  return { root, home, asight: path.join(home, '.asight'), collector: path.join(home, '.asight', 'collector'), sock: path.join(root, 'run', 'c.sock'), done: () => fs.rmSync(root, { recursive: true, force: true }) }
}
const req = (sock, method, p, body) => controlRequest({ socketPath: sock, method, path: p, body })
async function until(fn, ms = 4000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) } }
const install = (s, o = {}) => installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [cc], freePort: async () => 0, ...o })
const nowTicks = (p) => Math.ceil((Date.now() / 1000 - p.btime) * 100)
// (i): every flows/ line is in the D38 closed sets
const flowsOf = (s) => {
  const d = path.join(s.collector, 'flows')
  const lines = fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.ndjson') && fs.statSync(path.join(d, n)).isFile()).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) : []
  for (const l of lines) assert.deepEqual(checkRecord(l), [], `outside the closed sets: ${JSON.stringify(l)}`)
  return lines
}
// (ii): the endpoint, over HTTP, from a real board server reading this home
async function endpoint(s) {
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: null, healthHome: s.asight })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    return await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/capture-health' }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(b) }))
    }).on('error', reject))
  } finally { server.close() }
}
// (iii): `asight collector status` with no daemon answering — it reads the disk
async function statusOffline(s) {
  const o = []
  const code = await runCollector(['status'], { env: { XDG_RUNTIME_DIR: path.join(s.root, 'norun') }, home: s.home, request: async () => { throw Object.assign(new Error('no daemon'), { code: 'ENOENT' }) }, out: (l) => o.push(l), err: (l) => o.push(l) })
  return { code, text: o.join('\n') }
}
const keys = (h) => (h.collector.failures || []).map((g) => g.key)
const cond = (h, kind) => (h.collector.conditions || []).filter((c) => c.kind === kind)

// A TLS relay with its own private CA, standing in for the agent's upstream (as daemon.test.mjs does)
async function relay() {
  const ca = createCa({ commonName: 'f-group relay CA' })
  const issuer = createLeafIssuer(loadCa(ca))
  const srv = tls.createServer({ SNICallback: (n, cb) => cb(null, issuer.secureContextFor(n)) }, (s) => { s.on('error', () => {}); s.on('data', () => s.end('HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n')) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { ca, port: srv.address().port, close: () => srv.close() }
}

test('F1 CA and trust: (a) an untrusted agent is a condition until it exits, the event stays; (b) a leaf refused under TLS 1.3 and 1.2 → rows, a negative cache → a condition that a restart clears; (c) an unusable CA → "CA 不可用", never "not installed"; (e) a user CA block not carried over → the last install lists it', async () => {
  const s = sandbox(); const p = fakeProc(); const up = await relay()
  const relayCa = path.join(s.home, 'relay-ca.pem')
  fs.writeFileSync(relayCa, `-----BEGIN PRIVATE KEY-----\nNOT-A-KEY\n-----END PRIVATE KEY-----\n${up.ca.certPem}`) // (e) a key block beside the cert
  fs.mkdirSync(path.join(s.home, '.claude'))
  fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `https://relay.asight.test:${up.port}`, NODE_EXTRA_CA_CERTS: relayCa } }))
  p.add(6161, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.home, env: { HOME: s.home }, startTicks: nowTicks(p) - 6000 }) // started before install
  await install(s)
  const { arch, clients } = fakeArch(p)
  let d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], upstreamCa: up.ca.certPem })
  try {
    await req(s.sock, 'POST', '/on', {})
    // (a)
    let h = await endpoint(s)
    assert.deepEqual(cond(h, 'untrusted').map((c) => [c.pid, c.reason]), [[6161, 'config-after-start']], '(a) the endpoint lists the pid as a current condition')
    await clients[0].raw({ op: '__emit', ev: 'exit', tgid: 6161, ts_ns: 5 })
    await until(() => flowsOf(s).some((f) => f.event === 'agent-exit' && f.pid === 6161))
    h = await endpoint(s)
    assert.deepEqual(cond(h, 'untrusted'), [], '(a) gone once it exited')
    assert.ok(keys(h).includes('agent-untrusted:config-after-start'), '(a) the event is still listed')
    // (e)
    const note = h.collector.install.install.find((n) => n.kind === 'skipped-block')
    assert.deepEqual([note.file, note.type], [relayCa, 'PRIVATE KEY'], '(e) the last install lists the block it did not carry over')
    // (b) a trusted agent whose TLS client does not trust the asight CA after all
    p.add(7171, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.home, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 7171, pid: 7171, comm: 'claude', filename: CC_EXE, ts_ns: 6 })
    await until(async () => (await req(s.sock, 'GET', '/status')).agents.find((a) => a.pid === 7171 && a.trusted))
    for (const v of ['TLSv1.3', 'TLSv1.2']) {
      const raw = net.connect(d.port, '127.0.0.1'); await once(raw, 'connect')
      await clients[0].raw({ op: '__inject_port', port: raw.localPort, family: 4, dst: { address: '127.0.0.1', port: up.port, family: 4 }, pid: 7171, decrypt: 1 })
      await new Promise((resolve) => {
        const c = tls.connect({ socket: raw, servername: 'relay.asight.test', minVersion: v, maxVersion: v }) // the system store only
        c.on('error', () => { raw.destroy(); resolve() }); c.on('secureConnect', () => assert.fail('the client should refuse the leaf'))
      })
    }
    await until(() => flowsOf(s).some((f) => f.event === 'failure' && f.code === 'negative-cache'))
    const rows = flowsOf(s).filter((f) => f.reason === 'client-rejected-leaf')
    assert.equal(rows.length, 2, '(b) one connection row per refusal')
    h = await endpoint(s)
    assert.equal(h.collector.failures.find((g) => g.key === 'flow:client-rejected-leaf').count, 2, '(b) the endpoint counts both')
    assert.deepEqual(cond(h, 'negative-cache').map((c) => [c.pid, c.host]), [[7171, 'relay.asight.test']], '(b) 因负缓存停采 (pid, host)')
    assert.equal(h.summary.state, 'failing')
  } finally { await d.stop() }
  let st = await statusOffline(s)
  assert.match(st.text, /not running/)
  assert.match(st.text, /negative-cache/, '(iii) status lists the condition with no daemon')
  assert.match(st.text, /client-rejected-leaf/)
  d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc], upstreamCa: up.ca.certPem })
  try {
    const h = await endpoint(s)
    assert.deepEqual(cond(h, 'negative-cache'), [], '(b) a restart empties the engine\'s negative cache: the condition is gone')
    assert.ok(keys(h).includes('engine/negative-cache'), '(b) the write event is still listed')
  } finally { await d.stop() }
  // (c) an unusable CA (a key that is not the certificate's), on a start after a crash: the unclean stop is this start's
  // first line, the CA check comes after it, so the condition is this run's
  fs.writeFileSync(path.join(s.collector, 'ca', 'ca.key'), createCa().keyPem)
  fs.writeFileSync(path.join(s.collector, 'lock'), JSON.stringify({ pid: 999999, socket: s.sock }))
  d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc] })
  try {
    const h = await endpoint(s)
    assert.ok(flowsOf(s).some((f) => f.code === 'unclean-stop'))
    assert.deepEqual(cond(h, 'ca-invalid').map((c) => c.which), ['pair'], '(c) CA 不可用, which part')
    assert.deepEqual([h.installed, h.collector.installed], [true, true], '(c) never "not installed"')
  } finally { await d.stop(); up.close() }
  st = await statusOffline(s)
  assert.match(st.text, /ca-invalid/)
  assert.doesNotMatch(st.text, /not installed/)
  await assert.rejects(install(s), /CA|unusable/i, '(c) install does not answer "already installed"')
  p.done(); s.done()
})

test('F1(b) the refused-leaf connection row carries not_captured:\'client-rejected-leaf\' (4.6 §记录 判据)', { todo: 'C2 T-4 (engine, another lane): the row has reason only' }, () => {
  // the row the engine writes today (src/collector/core/engine/flow.mjs, judge()): reason set, not_captured not
  const row = { decision: 'decrypt', reason: 'client-rejected-leaf' }
  assert.equal(row.not_captured, 'client-rejected-leaf')
})

test('F2 not captured: a direct connection of an untrusted agent is a failure-class row, a lookup miss a failure event; both counted by the endpoint; a process the daemon does not know is untracked', async () => {
  const s = sandbox(); const p = fakeProc()
  p.add(6161, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.home, env: { HOME: s.home }, startTicks: nowTicks(p) - 6000 })
  await install(s)
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc] })
  try {
    await req(s.sock, 'POST', '/on', {})
    for (const pid of [6161, 9999]) await clients[0].raw({ op: '__emit', ev: 'flow', pid, dst: { address: '160.79.104.10', port: 443, family: 4 }, ts_ns: 9 })
    const c = net.connect(d.port, '127.0.0.1'); await once(c, 'close') // steered here with no original destination
    await until(() => flowsOf(s).filter((f) => f.not_captured).length >= 2 && flowsOf(s).some((f) => f.code === 'lookup-miss'))
    const rows = flowsOf(s).filter((f) => f.decision === 'direct')
    assert.deepEqual(rows.map((r) => [r.pid, r.not_captured]).sort(), [[6161, 'untrusted'], [9999, 'untracked']])
    const h = await endpoint(s)
    for (const k of ['flow:untrusted', 'flow:untracked', 'engine/lookup-miss']) assert.ok(keys(h).includes(k), `the endpoint counts ${k}: ${keys(h)}`)
    assert.equal(h.summary.state, 'failing')
  } finally { await d.stop(); p.done(); s.done() }
})

test('F2 table-driven: every connection-row code of §记录 (the expected class too), and no non-decrypt row without not_captured', { todo: 'C2 T-1 / T-2 / T-15 (engine, another lane): policy, not-trust-path, malformed-hello, https-proxy, proxy-refused, upstream-first, unknown-protocol, upgrade-not-followed, error are not written yet' }, () => {
  assert.fail('waits on the engine writing the expected-class codes')
})

test('F3 parts: off, a helper death (degraded), a SIGHUP stop and its clean restart, a protocol mismatch, a start refused (port held) — each on disk, at the endpoint and in an offline status', async () => {
  const s = sandbox(); const p = fakeProc()
  const free = net.createServer(); await new Promise((r) => free.listen(0, '127.0.0.1', r)); const enginePort = free.address().port; free.close()
  await install(s, { freePort: async () => enginePort })
  const { arch, clients } = fakeArch(p)
  let d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc] })
  let h
  try {
    // (g) off → 采集关 · 自 T 起: not ✓, not empty
    await req(s.sock, 'POST', '/on', {}); await req(s.sock, 'POST', '/off')
    h = await endpoint(s)
    assert.deepEqual([h.summary.state, typeof h.summary.since], ['off', 'string'], '(g)')
    // (a, unit) the helper dies → degraded, with how it ended
    clients[0]._child.kill('SIGKILL')
    await until(async () => (await req(s.sock, 'GET', '/status')).degraded)
    h = await endpoint(s)
    assert.deepEqual(cond(h, 'degraded').map((c) => c.exit), ['SIGKILL'], '(a) 降级')
  } finally { await d.stop({ signal: 'SIGHUP' }) }
  // (h) a SIGHUP stop: not running · 因 SIGHUP, from disk; an offline status says so, with the condition as of the stop
  h = await endpoint(s)
  assert.deepEqual([h.collector.daemon.state, h.summary.state], ['not-running', 'not-running'])
  assert.equal(h.collector.daemon.last_stop.signal, 'SIGHUP')
  const st = await statusOffline(s)
  assert.match(st.text, /SIGHUP/)
  assert.match(st.text, /degraded/, '(iii) the condition as of the stop')
  // (d) a helper speaking another protocol: never attaches; no "unclean stop" after a SIGHUP (h)
  d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p, { ASIGHT_FAKE_PROTO: '3' }).arch, harnesses: [cc] })
  try {
    await req(s.sock, 'POST', '/on', {})
    h = await endpoint(s)
    assert.equal(cond(h, 'helper-version').length, 1, '(d) 协议版本不符')
    assert.ok(keys(h).some((k) => k.startsWith('attach-failed')), `(d) 挂钩失败 listed: ${keys(h)}`)
    assert.deepEqual(cond(h, 'degraded'), [], 'the last run\'s helper death is not a current condition')
    assert.equal(flowsOf(s).filter((f) => f.code === 'unclean-stop').length, 0, '(h) a SIGHUP stop is a clean stop')
  } finally { await d.stop() }
  // (d) start refused: the engine port recorded at install is held by another process
  const port = JSON.parse(fs.readFileSync(path.join(s.collector, 'install-manifest.json'), 'utf8')).engine_port
  const squat = net.createServer(); await new Promise((r) => squat.listen(port, '127.0.0.1', r))
  try {
    await assert.rejects(startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc] }), /held by another process/)
    h = await endpoint(s)
    assert.ok(keys(h).some((k) => k.startsWith('start/')), `(d) the endpoint lists the refusal: ${keys(h)}`)
    const o = []
    assert.equal(await runCollector(['start'], { env: {}, home: s.home, daemon: { startDaemon: () => startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc] }) }, out: (l) => o.push(l), err: (l) => o.push(l), proc: { on() {}, stdin: null }, waitForStop: async () => 'SIGTERM' }), 1, '(d) the CLI exits non-0')
  } finally { squat.close(); p.done(); s.done() }
})

test('F3(e) a heartbeat refused twice within 10 s is one line, the second folded in at stop; the endpoint counts both', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc] })
  try {
    d.redirector.emit('heartbeat-error', { code: 'heartbeat-failed', reason: 'refused' })
    d.redirector.emit('heartbeat-error', { code: 'heartbeat-failed', reason: 'refused' })
  } finally { await d.stop() }
  const lines = flowsOf(s).filter((f) => f.where === 'heartbeat')
  assert.deepEqual(lines.map((f) => [f.code, f.suppressed || 0, !!f.folded]), [['heartbeat-failed', 0, false], ['heartbeat-failed', 1, true]])
  const h = await endpoint(s)
  assert.equal(h.collector.failures.find((g) => g.key === 'heartbeat/heartbeat-failed').count, 2)
  p.done(); s.done()
})

test('F4 write failures: an event line that cannot be written is on stderr and in status, then a log-gap; the endpoint says 读不全 meanwhile (200, not empty) and lists the gap after', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const logs = []
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc], log: (w, e) => logs.push(`${w}: ${e && e.message}`) })
  try {
    const day = path.join(s.collector, 'flows', `${new Date().toISOString().slice(0, 10)}.ndjson`)
    fs.rmSync(day, { force: true }); fs.mkdirSync(day) // every append fails: EISDIR
    d.redirector.emit('heartbeat-error', { code: 'heartbeat-failed', reason: 'timed out' })
    assert.equal((await req(s.sock, 'GET', '/status')).events.lost, 1)
    assert.ok(logs.some((l) => /EISDIR/.test(l)), 'stderr')
    let h = await endpoint(s)
    assert.equal(h.status, 200)
    assert.ok(h.summary.read_errors >= 1 && h.read.errors.some((e) => e.file === day), 'the endpoint says the day file could not be read — not "no failures"')
    fs.rmdirSync(day)
    d.redirector.emit('helper-error', { reason: 'ringbuf poll failed' })
    await until(() => flowsOf(s).some((f) => f.event === 'log-gap'))
    h = await endpoint(s)
    const gap = h.collector.failures.find((g) => g.key.startsWith('log-gap'))
    assert.equal(gap.last.lost, 1, 'the gap, with how many lines were lost')
  } finally { await d.stop(); p.done(); s.done() }
  // flows/ itself unreadable → 503, never empty: test/server-capture-health.test.mjs "unreadable flows/ → 503 …"
})

test('F4 the connection row of a flow whose envelope could not be written carries write_failed', { todo: 'C2 T-13 (engine, another lane)' }, () => { assert.fail('waits on C2 T-13') })

test('F6 install / uninstall: an entry uninstall cannot undo → exit-worthy `left`, the manifest kept, a failure event; the endpoint and an offline status say 未安装 · 残留 N 项, not "not installed"', async () => {
  const s = sandbox()
  const settings = path.join(s.home, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(settings)); fs.writeFileSync(settings, '{"model":"x"}')
  await install(s)
  fs.writeFileSync(settings, '{ not json any more')
  const r = await uninstallCollector({ home: s.home, env: {}, stop: async () => 'none' })
  assert.equal(r.left.length, 1)
  assert.ok(flowsOf(s).some((f) => f.event === 'failure' && f.where === 'uninstall' && f.code === 'left-unparsable'))
  const h = await endpoint(s)
  assert.deepEqual([h.summary.state, h.summary.n], ['residue', 1], '未安装 · 残留 1 项')
  assert.ok(keys(h).includes('uninstall/left-unparsable'))
  const st = await statusOffline(s)
  assert.match(st.text, /not installed — an uninstall left 1 item/)
  s.done()
})

test('F7 sealing and reading: a seal refused on an unclosed shard is a journal line the endpoint lists (⚠); an unreadable journal is said; a sealed flows/ file is still read', async () => {
  const s = sandbox()
  const journal = path.join(s.asight, 'raw', 'journal.jsonl')
  const shard = path.join(s.asight, 'sessions', 'p', 's', 'calls.ndjson')
  fs.mkdirSync(path.dirname(shard), { recursive: true }); fs.writeFileSync(shard, '{"id":"a"}\n')
  await assert.rejects(sealShard(shard, { journal }))
  let h = await endpoint(s)
  assert.deepEqual(h.raw.problems.map((x) => [x.op, x.outcome]), [['seal', 'refused']])
  assert.deepEqual([h.summary.state, h.summary.part], ['failing', 'raw'], 'the top bar turns ⚠')
  // a sealed flows/ day of an installed collector: its failure is still listed
  await install(s)
  const old = path.join(s.collector, 'flows', '2000-01-01.ndjson')
  fs.mkdirSync(path.dirname(old), { recursive: true })
  fs.writeFileSync(old, JSON.stringify({ ts: new Date(Date.now() - 3600e3).toISOString(), event: 'failure', where: 'engine', code: 'loader-down', reason: 'in a sealed file' }) + '\n')
  await sealUnchecked(old, { split: false, deleteOriginal: true, journal })
  assert.ok(!fs.existsSync(old))
  h = await endpoint(s)
  assert.ok(keys(h).includes('engine/loader-down') && h.read.files.some((f) => f.endsWith('.sealed')), `read through src/raw/: ${keys(h)}`)
  assert.match((await statusOffline(s)).text, /loader-down/, 'and by an offline status')
  // the journal itself unreadable
  fs.chmodSync(journal, 0o000)
  try {
    h = await endpoint(s)
    assert.ok(h.read.errors.some((e) => e.file === journal) && h.summary.read_errors >= 1, 'an unreadable journal is an error, never an empty list')
  } finally { fs.chmodSync(journal, 0o600); s.done() }
})

test('F5 decoding and truncation of HTTP/1 calls: response framing error, unpaired response, compressed request body', { todo: 'C2 T-11 / T-12 / T-14 (engine, another lane); the WebSocket labels are test/web/ws-incomplete.test.mjs' }, () => { assert.fail('waits on C2') })

// Elsewhere:
//   F5 (WebSocket): test/web/ws-incomplete.test.mjs — partial / ws_truncated / undecoded / non-verbatim reach /api/session
//       and render as 不完整 / 已截断 / 未解码 / 非逐字, through both assemblers; labels never turn the top bar ⚠
//       (test/web/cap-health.test.mjs "#caphealth: every … state").
//   F8: test/capture/legacy-failures.test.mjs, legacy-run.test.mjs, legacy-ops.test.mjs (4.1 #6b); "old MITM only is not
//       「未安装」": test/health/capture-health.test.mjs "the old capture: …".
//   F9: test/server-capture-health.test.mjs (503, installed:false, metadata only, Host / Origin) and
//       test/web/cap-health.test.mjs ("未刷新 · 截至 T" within 2 cycles with live unchecked).
//   F3(c), F3(i): test/collector/arch/linux/redirector-client.unit.test.mjs (heartbeat gap, monotonic timing),
//       test/collector/core/events.test.mjs (the day never goes back), test/health/capture-health.test.mjs (not
//       responding by the lock's age, pid / boot_id mismatch → not running).
//   [test-machine] F3(a) kill -9 of the helper, F3(b) kill -9 of the daemon; F3(f) kernel
//       drops (D-16). They skip without a test machine.
