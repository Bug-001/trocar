// test/collector/f-group.test.mjs — RFC 4.6 验收 F 组 (D38 「失败不静默」), one runnable check per F item. Each check
// makes the failure happen in the real component (the daemon over the fake helper and a synthetic /proc, the engine
// with real TLS clients, install / uninstall, the sealer), then asserts what F asks of every item: (i) a durable record
// on disk with a closed reason code; (ii) GET /api/capture-health — over HTTP, from a real `asight serve` server —
// shows the same reason; and for the daemon side (iii) `asight collector status` lists it with no daemon running.
//   Where an F item is checked elsewhere, the test that does is named in place (F5, F8, F9). No `todo` is left: the
// engine's connection-row codes (C2 T-1 / T-2 / T-4 / T-11..T-15) and the combined-bundle check (D-21) landed with the
// merge of the lanes, and the last one, F5's WebSocket labels vs the top bar, with the decision of
// 2026-10-06 (the class split, 4.6 F5). F1(b), F1(d), F2 (table), F4 and F5 (HTTP and WebSocket) are plain tests.
// [test-machine] items are listed at the end; they are not run here.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { X509Certificate } from 'node:crypto'
import http from 'node:http'
import { once } from 'node:events'
import { fakeMac } from '../cli/fixtures/legacy-ctx.mjs'
import { fileURLToPath } from 'node:url'
import { startDaemon } from '../../src/collector/daemon.mjs'
import { installCollector } from '../../src/collector/install.mjs'
import { uninstallCollector } from '../helpers/uninstall.mjs'
import { controlRequest } from '../../src/collector/core/control.mjs'
import { runCollector } from '../../src/collector/cli.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../src/collector/core/tls/leaf.mjs'
import { createWsRecorder } from '../../src/collector/core/ws/recorder.mjs'
import { createFailureRecorder } from '../../src/collector/core/events.mjs'
import { writeStateAtomic, setDesired, emptyState } from '../../src/off/state.mjs'
import { encodeFrame } from '../lab/ws-client.mjs'
import { createRedirectorClient } from '../../src/collector/arch/linux/redirector-client.mjs'
import { createLinuxRedirector } from '../../src/collector/arch/linux/redirector.mjs'
import cc from '../../src/collector/harness/claude-code.mjs'
import codex from '../../src/collector/harness/codex.mjs'
import { createServer } from '../../src/server.mjs'
import { sealShard, sealUnchecked } from '../../src/raw/seal.mjs'
import { fakeProc } from './arch/linux/fixtures/fake-proc.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const FAKE = fileURLToPath(new URL('./arch/linux/fixtures/fake-loader.mjs', import.meta.url))
const UID = process.getuid()
const CC_EXE = '/home/u/.local/share/claude/versions/2.1.289'
function fakeArch(p, extraEnv = {}) {
  const clients = []
  const makeClient = () => { const c = createRedirectorClient({ binary: process.execPath, args: [FAKE], env: { ...process.env, ASIGHT_FAKE_LOADER: '1', ...extraEnv }, autoHeartbeatMs: 0 }); clients.push(c); return c }
  return { clients, arch: { os: 'linux', createRedirector: () => createLinuxRedirector({ makeClient, procRoot: p.root, uid: UID }) } }
}
function sandbox() {
  const root = tmpDir('as-f-') // short: unix socket paths are length-limited
  const home = path.join(root, 'home'); fs.mkdirSync(home)
  return { root, home, asight: path.join(home, '.asight'), collector: path.join(home, '.asight', 'collector'), sock: path.join(root, 'run', 'c.sock'), done: () => fs.rmSync(root, { recursive: true, force: true }) }
}
const req = (sock, method, p, body) => controlRequest({ socketPath: sock, method, path: p, body })
async function until(fn, ms = 4000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) } }
// the daemon rebuilds the bundles of the harnesses whose desired state is on only (4.6 「合并包」, D39)
const turnedOn = (s, ids) => writeStateAtomic(path.join(s.collector, 'state.json'), setDesired(emptyState(), ids, 'on'))
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
  const code = await runCollector(['status'], { env: { XDG_RUNTIME_DIR: path.join(s.root, 'norun') }, home: s.home, request: async () => { throw Object.assign(new Error('no daemon'), { code: 'ENOENT' }) }, statusDeps: { exec: fakeMac({ loaded: [], keychain: false }).run, netenv: async () => ({ at: 'T', products: [], unknown: [{ reason: 'a test: nothing looked at' }] }) }, out: (l) => o.push(l), err: (l) => o.push(l) }) // on a Mac status asks launchd and the keychain (read-only): the runner is the test's
  return { code, text: o.join('\n') }
}
const keys = (h) => (h.collector.failures || []).map((g) => g.key)
const cond = (h, kind) => (h.collector.conditions || []).filter((c) => c.kind === kind)

// A TLS relay with its own private CA, standing in for the agent's upstream (as daemon.test.mjs does)
async function relay({ reply = 'HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n', got = null } = {}) {
  const ca = createCa({ commonName: 'f-group relay CA' })
  const issuer = createLeafIssuer(loadCa(ca))
  const srv = tls.createServer({ SNICallback: (n, cb) => cb(null, issuer.secureContextFor(n)) }, (s) => { s.on('error', () => {}); s.on('data', (d) => { if (got) got.push(d); s.end(reply) }) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { ca, port: srv.address().port, close: () => srv.close() }
}

// A trusted Claude Code agent (pid 7171) behind a real daemon, with a private-CA relay as its upstream; `inject(dst)` makes
// the fake helper steer one more client connection to the engine and returns the client's raw socket. What a test then
// does with that socket is the failure it wants (a refused leaf, a hang-up, garbage, a broken reply …).
async function scene({ reply, got = null, daemon = {} } = {}) {
  const s = sandbox(); const p = fakeProc(); const up = await relay({ reply, got })
  const relayCa = path.join(s.home, 'relay-ca.pem'); fs.writeFileSync(relayCa, up.ca.certPem)
  fs.mkdirSync(path.join(s.home, '.claude'))
  fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `https://relay.asight.test:${up.port}`, NODE_EXTRA_CA_CERTS: relayCa } }))
  await install(s)
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], upstreamCa: up.ca.certPem, ...daemon })
  await req(s.sock, 'POST', '/on', {})
  p.add(7171, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.home, env: { HOME: s.home }, startTicks: nowTicks(p) })
  await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 7171, pid: 7171, comm: 'claude', filename: CC_EXE, ts_ns: 1 })
  await until(async () => (await req(s.sock, 'GET', '/status')).agents.find((a) => a.pid === 7171 && a.trusted))
  const inject = async (dst = { address: '127.0.0.1', port: up.port, family: 4 }) => {
    const raw = net.connect(d.port, '127.0.0.1'); await once(raw, 'connect')
    await clients[0].raw({ op: '__inject_port', port: raw.localPort, family: 4, dst, pid: 7171, decrypt: 1 })
    return raw
  }
  const rows = () => flowsOf(s).filter((f) => f.event == null && f.flow_id) // the connection rows
  const extraCc = path.join(s.collector, 'ca', 'extra-cc.pem') // what the agent trusts: the relay CA + asight's
  let stopped = false
  const stop = async () => { if (!stopped) { stopped = true; await d.stop() } }
  return { s, p, up, d, inject, rows, extraCc, stop, done: async () => { await stop(); up.close(); p.done(); s.done() } }
}
const POST = (body, extra = '') => `POST /v1/messages HTTP/1.1\r\nhost: relay.asight.test\r\ncontent-type: application/json\r\n${extra}content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`

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
    assert.deepEqual(cond(h, 'untrusted').map((c) => [c.pid, c.code]), [[6161, 'config-after-start']], '(a) the endpoint lists the pid as a current condition')
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

test('F1(b) the refused-leaf connection row carries not_captured:\'client-rejected-leaf\' and the client\'s side of it (4.6 §记录 判据), counted by the endpoint', async () => {
  const S = await scene()
  try {
    for (const v of ['TLSv1.3', 'TLSv1.2']) {
      const raw = await S.inject()
      await new Promise((resolve) => { // the system store only: the client refuses the leaf
        const c = tls.connect({ socket: raw, servername: 'relay.asight.test', minVersion: v, maxVersion: v })
        c.on('error', () => { raw.destroy(); resolve() }); c.on('secureConnect', () => assert.fail('the client should refuse the leaf'))
      })
    }
    const rows = await until(() => { const r = S.rows(); return r.length >= 2 && r })
    for (const r of rows) {
      assert.deepEqual([r.decision, r.not_captured, r.error && r.error.side], ['decrypt', 'client-rejected-leaf', 'client'], JSON.stringify(r))
      assert.deepEqual(checkRecord(r), [])
    }
    const h = await endpoint(S.s)
    assert.equal(h.collector.failures.find((g) => g.key === 'flow:client-rejected-leaf').count, 2)
    assert.equal(h.summary.state, 'failing')
  } finally { await S.done() }
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

// The engine half is test/collector/core/not-captured.test.mjs (19 paths, one row each, with the engine alone). This is the
// product path: the same kinds of connection through the daemon, and what the endpoint makes of the rows — a failure-class
// code is listed and turns the bar ⚠, an expected-class code is only counted.
test('F2 table-driven: every connection row the bytes missed carries a closed not_captured; failure-class ones are listed and ⚠, expected-class ones only counted', async () => {
  const S = await scene()
  const sink = net.createServer((c) => { c.on('error', () => {}); c.resume(); c.on('end', () => c.end()) })
  const banner = net.createServer((c) => { c.on('error', () => {}); c.end('SSH-2.0-banner\r\n') })
  await Promise.all([sink, banner].map((x) => new Promise((r) => x.listen(0, '127.0.0.1', r))))
  const at = (x) => ({ address: '127.0.0.1', port: x.address().port, family: 4 })
  const tlsHello = (raw, o) => new Promise((resolve) => { const c = tls.connect({ socket: raw, rejectUnauthorized: false, ...o }); c.on('error', () => {}); c.on('secureConnect', () => { c.end(); resolve() }); c.on('close', resolve) })
  // [name, drive(raw), expected not_captured]
  const table = [
    ['a host outside the decrypt policy', (raw) => tlsHello(raw, { servername: 'other.example.test' }), 'policy'],
    ['only h2 offered', (raw) => tlsHello(raw, { servername: 'relay.asight.test', ALPNProtocols: ['h2'] }), 'h2'],
    ['a ClientHello that does not parse', (raw) => { raw.write(Buffer.from([0x16, 3, 1, 0, 4, 2, 0, 0, 0])); return new Promise((r) => setTimeout(() => { raw.end(); r() }, 80)) }, 'malformed-hello', sink],
    ['an unknown first byte', (raw) => { raw.write('SSH-2.0-client\r\n'); return new Promise((r) => setTimeout(() => { raw.end(); r() }, 80)) }, 'unknown-protocol', sink],
    ['the upstream speaks first', (raw) => new Promise((r) => { raw.on('data', () => {}); raw.on('close', r); setTimeout(() => { raw.destroy(); r() }, 300) }), 'upstream-first', banner],
    ['closed before a routing decision', (raw) => { raw.end(); return new Promise((r) => raw.on('close', r)) }, 'error', sink],
  ]
  try {
    for (const [name, drive, , dstServer] of table) { const raw = await S.inject(dstServer ? at(dstServer) : undefined); raw.on('error', () => {}); await drive(raw); await until(() => S.rows().length >= table.findIndex((t) => t[0] === name) + 1, 4000).catch(() => { throw new Error(`no connection row for: ${name}`) }) }
    const rows = S.rows()
    assert.deepEqual(rows.map((r) => r.not_captured), table.map((t) => t[2]), 'one row per connection, in order, each with its closed code')
    for (const r of rows) { assert.notEqual(r.decision, 'decrypt'); assert.deepEqual(checkRecord(r), [], r.not_captured) } // no non-decrypt row without a code
    const h = await endpoint(S.s)
    assert.deepEqual(['flow:h2', 'flow:malformed-hello'].map((k) => keys(h).includes(k)), [true, true], `failure-class codes are listed: ${keys(h)}`)
    assert.deepEqual(['flow:policy', 'flow:unknown-protocol', 'flow:upstream-first', 'flow:error'].filter((k) => keys(h).includes(k)), [], 'expected-class codes are not failures')
    assert.deepEqual(h.collector.expected, { policy: 1, 'unknown-protocol': 1, 'upstream-first': 1, error: 1 }, 'they are counted, by code')
    assert.equal(h.summary.state, 'failing', 'the failure-class rows turn the bar')
  } finally { sink.close(); banner.close(); await S.done() }
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

test('F4 the connection row of a flow whose envelope could not be written carries write_failed, and the agent still gets its reply', async () => {
  const S = await scene({ reply: 'HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok' })
  try {
    fs.mkdirSync(path.join(S.s.collector, `capture-${new Date().toISOString().slice(0, 10)}.ndjson`)) // the day's capture file cannot be opened
    const raw = await S.inject()
    const c = tls.connect({ socket: raw, servername: 'relay.asight.test', ca: fs.readFileSync(S.extraCc) }); await once(c, 'secureConnect')
    let got = ''; c.on('data', (x) => { got += x })
    c.write(POST('{"model":"claude-x","messages":[]}'))
    await until(() => got.endsWith('ok')); assert.match(got, /^HTTP\/1\.1 200 OK/, 'fail-open: the reply came although nothing could be written')
    c.destroy()
    const row = await until(() => S.rows()[0])
    assert.deepEqual([row.decision, row.write_failed], ['decrypt', 1], 'the row counts the envelope it lost')
    assert.ok(flowsOf(S.s).some((f) => f.event === 'failure' && f.where === 'record'), 'and the write failure itself is a record')
    const h = await endpoint(S.s)
    assert.equal(h.summary.state, 'failing')
  } finally { await S.done() }
})

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

// What the engine's own half asserts piece by piece is test/collector/core/exchange.test.mjs (T-11 / T-12 / T-14) and
// not-captured.test.mjs; these are the same three things through the product path: a daemon, a real TLS client and a real
// upstream, then the row, the event, the envelope on disk and the endpoint.
const captureOf = (s) => fs.readdirSync(s.collector).filter((n) => /^capture-.*\.ndjson$/.test(n) && fs.statSync(path.join(s.collector, n)).isFile())
  .flatMap((n) => fs.readFileSync(path.join(s.collector, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
async function talk(S, bytes, { until: ok = () => true } = {}) {
  const raw = await S.inject()
  const c = tls.connect({ socket: raw, servername: 'relay.asight.test', ca: fs.readFileSync(S.extraCc) }); await once(c, 'secureConnect')
  let got = Buffer.alloc(0); c.on('data', (x) => { got = Buffer.concat([got, x]) }); c.on('error', () => {})
  c.write(bytes)
  await until(() => ok(got)); return { c, got: () => got }
}
test('F5 decoding and truncation of HTTP/1 calls: a response that cannot be framed, a response with no request to pair with, a compressed request body', { timeout: 30000 }, async () => {
  const zlib = (await import('node:zlib')).default
  // (1) the upstream's response cannot be framed: the row says so, one failure event, the open call is an error envelope
  let S = await scene({ reply: 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\nmore' })
  try {
    const t = await talk(S, POST('{"model":"claude-x","messages":[]}'), { until: (g) => g.length > 0 }); t.c.destroy()
    const row = await until(() => S.rows()[0])
    assert.deepEqual([row.decision, row.framer_error && row.framer_error.side], ['decrypt', 'response'], 'the row: framing stopped on the response side')
    const ev = await until(() => flowsOf(S.s).find((f) => f.event === 'failure' && f.code === 'framer-error'))
    assert.deepEqual([ev.where, ev.side, ev.flow_id], ['engine', 'response', row.flow_id])
    const env = captureOf(S.s)
    assert.deepEqual(env.map((e) => [e.error, e.resp && e.resp.error && e.resp.error.type]), [[true, 'framer_error']], 'the call is written, as an error that says why')
    assert.ok(keys(await endpoint(S.s)).includes('engine/framer-error'))
  } finally { await S.done() }
  // (2) a request that stops being framed, then responses: the first pairs with the broken request, the rest have no request
  const ok0 = 'HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n'
  S = await scene({ reply: ok0 + 'HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n' + ok0 })
  try {
    const t = await talk(S, 'POST /v1/messages HTTP/1.1\r\nhost: relay.asight.test\r\ntransfer-encoding: chunked\r\n\r\n2\r\n{}XX', { until: (g) => g.length > 40 }); t.c.destroy()
    const row = await until(() => S.rows()[0])
    assert.equal(row.framer_error && row.framer_error.side, 'request')
    await until(() => flowsOf(S.s).some((f) => f.code === 'unpaired-response'))
    await S.stop() // the recorder folds repeats inside a window and writes the folded count on stop: if the engine wrote one per response, a folded line would show up
    const un = flowsOf(S.s).filter((f) => f.code === 'unpaired-response')
    assert.deepEqual(un.map((f) => [f.status, f.folded ?? null, f.suppressed ?? null]), [[404, null, null]], 'once per connection, not once per response')
    assert.deepEqual(captureOf(S.s).map((e) => e.req_partial), ['framer-error'], 'the unpaired responses are no envelopes')
    const ks = keys(await endpoint(S.s))
    assert.ok(['engine/framer-error', 'engine/unpaired-response'].every((k) => ks.includes(k)), `listed by the endpoint: ${ks}`)
  } finally { await S.done() }
  // (3) a compressed request body: the wire bytes verbatim, the text only where it could be decoded, never invented
  S = await scene({ reply: ok0 })
  try {
    const json = '{"model":"claude-x","messages":[{"role":"user","content":"压缩 ok"}]}'
    const gz = zlib.gzipSync(json), zst = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4]) // a zstd frame header and junk: never decoded at capture
    for (const [enc, body] of [['gzip', gz], ['zstd', zst]]) {
      const raw = await S.inject()
      const c = tls.connect({ socket: raw, servername: 'relay.asight.test', ca: fs.readFileSync(S.extraCc) }); await once(c, 'secureConnect'); c.on('error', () => {})
      let got = ''; c.on('data', (x) => { got += x })
      c.write(Buffer.concat([Buffer.from(`POST /v1/messages HTTP/1.1\r\nhost: relay.asight.test\r\ncontent-encoding: ${enc}\r\ncontent-length: ${body.length}\r\n\r\n`), body]))
      await until(() => got.length > 0); c.destroy()
    }
    const [g, z] = await until(() => { const e = captureOf(S.s); return e.length >= 2 && e })
    assert.deepEqual([g.req_body, g.req_content_encoding, Buffer.from(g.req_body_b64, 'base64').equals(gz)], [json, 'gzip', true], 'gzip: decoded text, and the wire bytes under it')
    assert.deepEqual([z.req_body, z.req_content_encoding, Buffer.from(z.req_body_b64, 'base64').equals(zst)], [null, 'zstd', true], 'zstd: no text, the wire bytes kept')
    assert.match(z.req_encoding_error, /zstd/)
  } finally { await S.done() }
})

// F1(d) (4.6 「合并包」, D38 D-21): the daemon checks every entry's combined bundle at start and daily. A bundle that went
// missing is rebuilt, with one event that names the harness, the file and the errno; a rebuild that fails leaves the old
// file, is a failure of its own that the endpoint lists with the harness and the path, and the resolver (which looks for
// the asight CA in the file the entry names) keeps that agent untrusted meanwhile. The daily timer calls the same function
// as the start, so the start is what is driven here.
test('F1(d) an entry\'s combined bundle deleted → the daemon rebuilds it and records it; a rebuild that fails (read-only dir) leaves the old file, a failure event, and the endpoint lists the harness and path', { skip: process.getuid && process.getuid() === 0 ? 'root ignores directory modes' : false }, async () => {
  const s = sandbox(); const p = fakeProc()
  const osRoots = path.join(s.root, 'os-roots.pem'); fs.writeFileSync(osRoots, '')
  fs.mkdirSync(path.join(s.home, '.codex')); fs.writeFileSync(path.join(s.home, '.codex', 'config.toml'), 'model = "gpt-test-1"\n')
  const CODEX_EXE = '/home/u/.local/bin/codex'
  await install(s, { harnesses: [codex], osRootsFile: osRoots }); turnedOn(s, ['codex'])
  const ca = path.join(s.collector, 'ca'); const bundle = path.join(ca, 'combined-codex.pem')
  const caFp = new X509Certificate(fs.readFileSync(path.join(ca, 'asight-ca.pem'))).fingerprint256
  const hasCa = () => (fs.readFileSync(bundle, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []).some((c) => new X509Certificate(c).fingerprint256 === caFp)
  let FA
  const start = (osRootsFile = osRoots) => { FA = fakeArch(p); return startDaemon({ dir: s.collector, socketPath: s.sock, arch: { ...FA.arch, osRootsFile }, harnesses: [codex], env: { ...process.env, HOME: s.home } }) }
  let d
  try {
    // (1) deleted → rebuilt, and one event says which harness, which file, why
    fs.rmSync(bundle)
    d = await start(); await d.stop()
    assert.ok(hasCa(), 'the bundle is back, with the asight CA')
    const ev = flowsOf(s).filter((f) => f.event === 'bundles-rebuilt' && f.code === 'missing')
    assert.deepEqual(ev.map((f) => [f.harness, f.file, f.errno]), [['codex', bundle, 'ENOENT']])
    // (2) a root changed, but the directory cannot be written: the old file stays as it is, a failure names harness and path
    const before = fs.readFileSync(bundle, 'utf8')
    fs.writeFileSync(osRoots, createCa({ commonName: 'a root the distro added' }).certPem)
    fs.chmodSync(ca, 0o555)
    try {
      d = await start()
      const fail = await until(() => flowsOf(s).find((f) => f.event === 'failure' && f.where === 'bundle'))
      assert.deepEqual([fail.harness, fail.file, typeof fail.code], ['codex', bundle, 'string'])
      assert.equal(fs.readFileSync(bundle, 'utf8'), before, 'the old file is untouched')
      const h = await endpoint(s)
      const g = h.collector.failures.find((x) => x.key.startsWith('bundle/'))
      assert.deepEqual([g.last.harness, g.last.file], ['codex', bundle], 'the endpoint lists the harness and the path')
      assert.equal(h.summary.state, 'failing')
      await d.stop()
      // (3) the bundle gone and not rebuildable: an agent whose entry names it is untrusted, with a reason — not "fine"
      fs.chmodSync(ca, 0o700); fs.rmSync(bundle); fs.chmodSync(ca, 0o555)
      d = await start()
      await req(s.sock, 'POST', '/on', {})
      p.add(5151, { uid: UID, exe: CODEX_EXE, argv: ['codex', 'exec', 'hi'], cwd: s.home, env: { HOME: s.home }, startTicks: nowTicks(p) })
      await FA.clients[0].raw({ op: '__emit', ev: 'exec', tgid: 5151, pid: 5151, comm: 'codex', filename: CODEX_EXE, ts_ns: 1 })
      const a = await until(async () => (await req(s.sock, 'GET', '/status')).agents.find((x) => x.pid === 5151))
      assert.ok(!fs.existsSync(bundle), 'nothing could be written')
      assert.deepEqual([a.trusted, typeof a.reason], [false, 'string'], `untrusted while its bundle is gone: ${JSON.stringify(a)}`)
      assert.ok((await endpoint(s)).collector.conditions.some((c) => c.kind === 'untrusted' && c.pid === 5151), 'and the endpoint lists the pid')
      await d.stop()
    } finally { fs.chmodSync(ca, 0o700) }
  } finally { p.done(); s.done() }
})

// F1(d) / RV-3 (review): a bundle that went missing is rebuilt from the user CA files recorded at install. A file that moved
// leaves its CA out of the rebuilt bundle, which an agent that REPLACES its roots (Codex) cannot reach its relay without: the
// daemon says so, once per bundle, as a failure that names the harness, the file, the lost fingerprint and the source with its
// errno (D38 ②: a silent partial is not allowed), and the endpoint lists it. A rebuild that lost nothing says nothing of the kind.
test('F1(d) a bundle rebuilt without a user CA it held (its source file moved) is a failure naming the harness, the file, the lost CA and the source errno; the endpoint lists it; nothing lost, nothing said', async () => {
  const s = sandbox()
  const osRoots = path.join(s.root, 'os-roots.pem'); fs.writeFileSync(osRoots, '')
  const corpCa = createCa({ commonName: 'corp relay CA' })
  const corp = path.join(s.home, 'corp.pem'); fs.writeFileSync(corp, corpCa.certPem)
  fs.mkdirSync(path.join(s.home, '.codex')); fs.writeFileSync(path.join(s.home, '.codex', 'config.toml'), 'model = "gpt-test-1"\n')
  fs.writeFileSync(path.join(s.home, '.codex', '.env'), `SSL_CERT_FILE=${corp}\n`)
  const p = fakeProc()
  try {
    await install(s, { harnesses: [codex], osRootsFile: osRoots }); turnedOn(s, ['codex'])
    const bundle = path.join(s.collector, 'ca', 'combined-codex.pem')
    const corpFp = new X509Certificate(corpCa.certPem).fingerprint256
    const fpsOf = () => (fs.readFileSync(bundle, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []).map((c) => new X509Certificate(c).fingerprint256)
    assert.ok(fpsOf().includes(corpFp), 'installed with the user CA in the bundle')
    const start = () => startDaemon({ dir: s.collector, socketPath: s.sock, arch: { ...fakeArch(p).arch, osRootsFile: osRoots }, harnesses: [codex], env: { ...process.env, HOME: s.home } })
    // (1) the bundle is deleted but its source is still there: rebuilt with the CA, no loss recorded
    fs.rmSync(bundle)
    let d = await start(); await d.stop()
    assert.ok(fpsOf().includes(corpFp), 'rebuilt from the source, the CA is back')
    assert.deepEqual(flowsOf(s).filter((f) => f.event === 'failure' && f.where === 'bundle'), [], 'nothing was lost: nothing is said')
    // (2) the bundle is deleted and the source moved: rebuilt without the CA, and that is recorded
    fs.rmSync(bundle); fs.renameSync(corp, path.join(s.home, 'corp-moved.pem'))
    d = await start()
    try {
      const lost = await until(() => flowsOf(s).find((f) => f.event === 'failure' && f.where === 'bundle'))
      assert.deepEqual([lost.code, lost.harness, lost.file, lost.errno, lost.lost_fps, lost.sources], ['source-unreadable', 'codex', bundle, 'ENOENT', [corpFp], [{ file: corp, errno: 'ENOENT' }]])
      assert.match(lost.reason, /rebuilt without 1 user CA it held at install/)
      assert.ok(lost.reason.includes(corp) && lost.reason.includes('ENOENT'), 'the reason names the source and its errno')
      assert.ok(!fpsOf().includes(corpFp), 'the rebuilt bundle really lacks it: this is what the event reports')
      const h = await endpoint(s)
      assert.deepEqual(h.collector.failures.filter((x) => x.key.startsWith('bundle/')).map((x) => [x.last.harness, x.last.file]), [['codex', bundle]], 'the endpoint lists the harness and the bundle')
      assert.equal(h.summary.state, 'failing')
    } finally { await d.stop() }
  } finally { p.done(); s.done() }
})

// F5 (WebSocket): the labels on a WebSocket call (不完整 / 已截断 / 未解码) say what is missing from
// THAT call; the top bar goes ⚠ by the D38 class of what happened. A failed write, a message that cannot be decoded, and
// data lost because a direction stopped being followed (or asight's own code threw) are failure events: ⚠. A call cut at
// the 64 MiB cap is by design: a label on the call (`ws_truncated`), no event, no ⚠. The real recorder writes the real
// flows/ through the daemon's failure recorder, the endpoint is read over HTTP; the top bar maps `summary.state` 'failing'
// to ⚠ N and 'ok' to ✓ (test/web/cap-health.test.mjs). The cap is lowered through the recorder's own option: the engine
// takes the 64 MiB constant, and a test that sends 64 MiB through TLS proves nothing more.
const WS_FLOW = { id: 'ws-f5', host: 'api.openai.com', scheme: 'https', dst: { address: '10.0.0.1', port: 443, family: 4 }, proc: { pid: 7171, exe: CC_EXE, agent: 'claude-code' } }
const wsUpgrade = (ext) => {
  const raw = (line, hs) => `${line}\r\n${hs.map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`
  const reqH = [['Host', 'api.openai.com'], ['Upgrade', 'websocket'], ['Session-Id', 's-f5']], respH = [['Upgrade', 'websocket'], ...(ext ? [['Sec-WebSocket-Extensions', ext]] : [])]
  const head = (s, extra) => ({ raw: Buffer.from(s, 'latin1'), startLine: s.split('\r\n')[0], ...extra })
  return { req: { head: head(raw('GET /v1/responses HTTP/1.1', reqH), { method: 'GET', target: '/v1/responses', headers: reqH }) },
    resp: { head: head(raw('HTTP/1.1 101 Switching Protocols', respH), { status: 101, headers: respH }) } }
}
test('F5 WebSocket labels and the top bar, by D38 class: a call cut at the cap is a label only (✓); a failed write, an undecodable message and a stopped direction are failure events (⚠)', { timeout: 30000 }, async () => {
  const S = await scene()
  const failures = createFailureRecorder(S.s.collector) // as the daemon wires it into the engine and the recorder
  try {
    const out = []; let n = 0
    const rec = (o = {}) => createWsRecorder({ flow: WS_FLOW, upgrade: wsUpgrade(o.ext), genId: () => `ws-env-${n++}`, onFailure: failures.event, terminal: [{ pathSuffix: '/responses', patterns: ['^\\{"type":"response\\.completed"'] }],
      recordStore: { envelope: o.write || ((e) => (out.push(e), true)), lastError: null }, ...o })
    const ev = (type, extra = {}) => JSON.stringify({ type, ...extra })
    const cli = (op, payload, opts) => encodeFrame(op, payload, opts), srv = (op, payload, opts) => encodeFrame(op, payload, { mask: false, ...opts })
    const wsKeys = async () => keys(await endpoint(S.s)).filter((k) => k.startsWith('ws/'))
    const before = await endpoint(S.s)
    assert.equal(before.summary.state, 'ok', 'precondition: a running collector, nothing wrong')

    // (1) a call that goes past the cap: its messages after the cap are {omitted_bytes}, the envelope says ws_truncated
    const cap = rec({ maxCallBytes: 4000 })
    cap.fromClient(cli(1, ev('response.create', { input: 1 })))
    cap.fromUpstream(srv(1, ev('response.output_text.delta', { delta: 'x'.repeat(3000) }))); cap.fromUpstream(srv(1, ev('response.output_text.delta', { delta: 'y'.repeat(3000) })))
    cap.fromUpstream(srv(1, ev('response.completed'))); cap.end(null)
    assert.deepEqual(out.map((e) => [e.ws_truncated, e.partial, e.resp.messages.some((m) => m && m.omitted_bytes)]), [[true, undefined, true]], 'the call carries 已截断 (and is not "partial": nothing was lost to a failure)')
    failures.flush()
    assert.deepEqual(flowsOf(S.s).filter((f) => f.where === 'ws'), [], 'no event is written for a cut at the cap')
    let h = await endpoint(S.s)
    assert.equal(h.summary.state, 'ok', 'the top bar stays ✓')
    assert.deepEqual(await wsKeys(), [], 'and no WebSocket group is listed')
    out.length = 0

    // (2) a failed write: the envelope is lost, and that is a failure event
    const w = rec({ write: () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) } })
    w.fromClient(cli(1, ev('response.create'))); w.fromUpstream(srv(1, ev('response.completed')))
    h = await endpoint(S.s)
    assert.equal(h.summary.state, 'failing', 'a failed write turns the top bar ⚠')
    assert.deepEqual(await wsKeys(), ['ws/write-failed'])

    // (3) a message that cannot be decoded (RSV1 with no permessage-deflate agreed)
    const d = rec()
    d.fromClient(cli(1, ev('response.create'))); d.fromUpstream(srv(1, 'abc', { rsv1: true })); d.fromUpstream(srv(1, ev('response.completed'))); d.end(null)
    assert.deepEqual(out.map((e) => [e.partial_reasons, e.resp.messages.some((m) => m && m.decode_error)]), [[['decode-failed'], true]], 'the call is labelled (不完整 / 未解码) and its undecodable message keeps its bytes')
    assert.deepEqual(await wsKeys(), ['ws/write-failed', 'ws/decode-failed'])
    out.length = 0

    // (4) data lost because a direction stopped being followed (a reserved opcode): the same ws_truncated label as a cap, the other class
    const b = rec()
    b.fromClient(cli(1, ev('response.create'))); b.fromUpstream(srv(1, ev('response.output_text.delta'))); b.fromUpstream(Buffer.from([0x83, 0])); b.end(null)
    assert.deepEqual(out.map((e) => [e.ws_truncated, e.partial_reasons]), [[true, ['decode-failed']]], 'labelled 已截断 like the cap, but a stopped direction is an error')
    assert.ok((await wsKeys()).includes('ws/broken'))

    // (5) asight's own code throwing while it follows a direction loses data too: recorder-error, not "bad data"
    const x = rec({ genId: () => { throw new Error('id source gone') } })
    x.fromClient(cli(1, 'a')); x.end(null)
    assert.ok((await wsKeys()).includes('ws/recorder-error'))

    failures.flush()
    h = await endpoint(S.s)
    assert.equal(h.summary.state, 'failing')
    assert.deepEqual([...new Set(await wsKeys())].sort(), ['ws/broken', 'ws/decode-failed', 'ws/recorder-error', 'ws/write-failed'], 'each failure class event is a group of its own, the cap is none of them')
    assert.equal(h.summary.n, h.collector.failures.length, 'the ⚠ N counts the failure groups, every one of them a failure')
    for (const f of flowsOf(S.s).filter((x) => x.where === 'ws')) assert.equal(f.event, 'failure', 'every WebSocket record in flows/ is a failure event: the cap writes none')
  } finally { failures.flush(); await S.done() }
})

// Elsewhere:
//   F5 (WebSocket): test/web/ws-incomplete.test.mjs — partial / ws_truncated / undecoded / non-verbatim reach /api/session
//       and render as 不完整 / 已截断 / 未解码 / 非逐字, through both assemblers. Which of them turn the top bar ⚠ (by D38
//       class) is the F5 WebSocket test above. Response-body labels: test/web/resp-incomplete.test.mjs.
//   F4 (the capture file itself unwritable on the daemon's path): test/collector/daemon.test.mjs "an envelope that cannot be
//       written is a durable failure record" — record/EISDIR in flows/, and the agent still gets its reply.
//   F8: test/capture/legacy-failures.test.mjs, legacy-run.test.mjs, legacy-ops.test.mjs (4.1 #6b); "old MITM only is not
//       「未安装」": test/health/capture-health.test.mjs "the old capture: …".
//   F9: test/server-capture-health.test.mjs (503, installed:false, metadata only, Host / Origin) and
//       test/web/cap-health.test.mjs ("未刷新 · 截至 T" within 2 cycles with live unchecked).
//   F3(c), F3(i): test/collector/arch/linux/redirector-client.unit.test.mjs (heartbeat gap, monotonic timing),
//       test/collector/core/events.test.mjs (the day never goes back), test/health/capture-health.test.mjs (not
//       responding by the lock's age, pid / boot_id mismatch → not running).
//   [test-machine] F3(a) kill -9 of the helper, F3(b) kill -9 of the daemon; F3(f) kernel
//       drops (D-16). They skip without a test machine.
