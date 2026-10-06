// test/collector/daemon.test.mjs — the vertical-slice daemon over the fake helper and a synthetic /proc (no root):
// Claude Code's real descriptor, trusted through the settings key `installCollector` wrote, has a TLS request
// decrypted and recorded verbatim; the board server, on its default source, serves it from ~/.asight/collector;
// off stops recording; the same program without the CA is only observed; desired state survives a restart.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { startDaemon } from '../../src/collector/daemon.mjs'
import { installCollector } from '../../src/collector/install.mjs'
import { controlRequest } from '../../src/collector/core/control.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../src/collector/core/tls/leaf.mjs'
import { createRedirectorClient } from '../../src/collector/arch/linux/redirector-client.mjs'
import { createLinuxRedirector } from '../../src/collector/arch/linux/redirector.mjs'
import cc from '../../src/collector/harness/claude-code.mjs'
import codex from '../../src/collector/harness/codex.mjs'
import { startMockUpstream } from '../lab/mock-upstream/server.mjs'
import { makeLabCa } from '../lab/mock-upstream/lab-ca.mjs'
import { wsConnect } from '../lab/ws-client.mjs'
import { createServer } from '../../src/server.mjs'
import { serveSource } from '../../src/paths.mjs'
import { fakeProc } from './arch/linux/fixtures/fake-proc.mjs'
import { checkRecord } from '../../src/health/codes.mjs'

const FAKE = fileURLToPath(new URL('./arch/linux/fixtures/fake-loader.mjs', import.meta.url))
const UID = process.getuid()
const CC_EXE = '/home/u/.local/share/claude/versions/2.1.289'
const CODEX_EXE = '/home/u/.local/bin/codex'
function fakeArch(p, extraEnv = {}) {
  const clients = []
  const makeClient = () => { const c = createRedirectorClient({ binary: process.execPath, args: [FAKE], env: { ...process.env, ASIGHT_FAKE_LOADER: '1', ...extraEnv }, autoHeartbeatMs: 0 }); clients.push(c); return c }
  return { clients, arch: { os: 'linux', createRedirector: () => createLinuxRedirector({ makeClient, procRoot: p.root, uid: UID }) } }
}
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-d-')) // short: unix socket paths are length-limited
  const home = path.join(root, 'home'); fs.mkdirSync(home)
  return { root, home, collector: path.join(home, '.asight', 'collector'), sock: path.join(root, 'run', 'c.sock'), done: () => fs.rmSync(root, { recursive: true, force: true }) }
}
const req = (sock, method, p, body) => controlRequest({ socketPath: sock, method, path: p, body })
async function until(fn, ms = 3000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) } }
const install = (s) => installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [cc], freePort: async () => 0 })
// /proc start time of a process started now (fake-proc counts ticks of 1/100 s from its btime).
const nowTicks = (p) => Math.ceil((Date.now() / 1000 - p.btime) * 100)
// Every flows/ line any daemon test produced is checked against the D38 closed sets (src/health/codes.mjs).
const flowsOf = (s) => {
  const d = path.join(s.collector, 'flows')
  const lines = fs.existsSync(d) ? fs.readdirSync(d).filter((n) => fs.statSync(path.join(d, n)).isFile()).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) : []
  for (const l of lines) assert.deepEqual(checkRecord(l), [], `outside the closed sets: ${JSON.stringify(l)}`)
  return lines
}

// A keep-alive TLS relay for relay.asight.test with its own private CA. A daemon process would trust it for the
// upstream side through NODE_EXTRA_CA_CERTS (gate G8, test/collector/core/upstream-trust.test.mjs); in-process the
// test hands the engine the CA through startDaemon's upstreamCa seam. It answers every complete request with a fixed message.
const REPLY = '{"id":"msg_1","type":"message","role":"assistant","model":"claude-x","content":[{"type":"text","text":"pong"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":1}}'
async function relay() {
  const ca = createCa({ commonName: 'lab relay CA' })
  const issuer = createLeafIssuer(loadCa(ca))
  const got = []
  const srv = tls.createServer({ SNICallback: (n, cb) => cb(null, issuer.secureContextFor(n)) }, (s) => {
    let buf = Buffer.alloc(0)
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        const len = Number(/content-length: (\d+)/i.exec(buf.subarray(0, end).toString('latin1'))[1])
        if (buf.length < end + 4 + len) return
        got.push(buf.subarray(0, end + 4 + len)); buf = buf.subarray(end + 4 + len)
        s.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${REPLY.length}\r\n\r\n${REPLY}`)
      }
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { ca, got, port: srv.address().port, close: () => srv.close() }
}

test('daemon: CC trusted through the installed settings key is decrypted and recorded verbatim; the board serves it from its default source; off stops recording (S2/S1/T7 unit)', async () => {
  const s = sandbox(); const p = fakeProc(); const up = await relay()
  const relayCa = path.join(s.home, 'relay-ca.pem'); fs.writeFileSync(relayCa, up.ca.certPem)
  // the user's own Claude Code config, as for any private-CA relay: base URL + the relay's CA
  fs.mkdirSync(path.join(s.home, '.claude'))
  fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `https://relay.asight.test:${up.port}`, NODE_EXTRA_CA_CERTS: relayCa } }, null, 2))
  await install(s)
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], env: { ...process.env, HOME: s.home }, upstreamCa: up.ca.certPem })
  let server = null
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(s.collector, 'lock'), 'utf8'))
    assert.deepEqual([lock.pid, lock.engine_port, lock.helper_pid, fs.statSync(path.join(s.collector, 'lock')).mode & 0o777], [process.pid, d.port, clients[0]._child.pid, 0o600])
    assert.equal((await req(s.sock, 'GET', '/status')).desired, 'off')
    const on = await req(s.sock, 'POST', '/on', {})
    assert.deepEqual([on.desired, on.actual, on.recording], ['on', 'on', true])

    p.add(4242, { uid: UID, exe: CC_EXE, argv: ['claude', '-p', 'hi'], cwd: s.home, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 4242, pid: 4242, comm: 'claude', filename: CC_EXE, ts_ns: 1 })
    const row = await until(async () => (await req(s.sock, 'GET', '/status')).agents.find((a) => a.pid === 4242 && a.trusted))
    assert.deepEqual([row.agent, row.reason, row.trust_var, row.trust_via.startsWith('user settings env'), row.hosts.includes('relay.asight.test'), row.direct], ['claude-code', 'ok', 'NODE_EXTRA_CA_CERTS', true, true, 0])

    const raw = net.connect(d.port, '127.0.0.1'); await once(raw, 'connect')
    await clients[0].raw({ op: '__inject_port', port: raw.localPort, family: 4, dst: { address: '127.0.0.1', port: up.port, family: 4 }, pid: 4242, decrypt: 1 })
    const extraCc = fs.readFileSync(path.join(s.collector, 'ca', 'extra-cc.pem'), 'utf8') // what CC now trusts: relay CA + asight CA
    const c = tls.connect({ socket: raw, servername: 'relay.asight.test', ca: extraCc }); await once(c, 'secureConnect')
    const sid = '6a1b7c2d-0000-4000-8000-000000000001'
    const send = (text) => new Promise((resolve) => {
      const body = JSON.stringify({ model: 'claude-x', max_tokens: 16, system: [{ type: 'text', text: 'You are a test.' }], messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
      let reply = ''
      const onData = (x) => { reply += x; if (reply.endsWith(REPLY)) { c.off('data', onData); resolve(reply) } }
      c.on('data', onData)
      c.write(`POST /v1/messages HTTP/1.1\r\nhost: relay.asight.test:${up.port}\r\nanthropic-version: 2023-06-01\r\nx-claude-code-session-id: ${sid}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    })
    assert.match(await send('asight-e2e-1'), /^HTTP\/1\.1 200 OK/)
    const capture = await until(() => fs.readdirSync(s.collector).find((n) => /^capture-.*\.ndjson$/.test(n)))
    const envs = await until(() => { const t = fs.readFileSync(path.join(s.collector, capture), 'utf8'); return t.includes('asight-e2e-1') && t.trim().split('\n').map((l) => JSON.parse(l)) })
    assert.equal(envs.length, 1)
    assert.deepEqual(Buffer.concat([Buffer.from(envs[0].req_head_raw, 'latin1'), Buffer.from(envs[0].req_body, 'utf8')]), up.got[0], 'recorded request bytes == bytes the relay received')
    assert.deepEqual([envs[0].host, envs[0].proc.pid, envs[0].proc.agent, envs[0].proc.exe, envs[0].is_llm_call], ['relay.asight.test', 4242, 'claude-code', CC_EXE, true])

    // the read side through the product path: `asight serve` with no --source reads serveSource()
    const roots = serveSource({ home: path.join(s.home, '.asight'), legacyExists: false })
    assert.deepEqual(roots, [path.join(s.home, '.asight'), s.collector])
    ;({ server } = await createServer({ sourcePath: roots, dbPath: path.join(s.root, 'none.duckdb') }))
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const get = async (u) => (await fetch(`http://127.0.0.1:${server.address().port}${u}`)).json()
    const projects = await get('/api/projects')
    assert.ok(projects.projects.some((pr) => pr.sessions.some((x) => x.id === sid || x.session_id === sid)), JSON.stringify(projects))
    const view = await get(`/api/session?id=${sid}`)
    const steps = view.analyzed.steps
    assert.deepEqual([steps.length, steps[0].norm.text, steps[0].flat.map((b) => b.kind)], [1, 'pong', ['system', 'text']])
    const relayBody = up.got[0].subarray(up.got[0].indexOf('\r\n\r\n') + 4).toString('utf8')
    for (const b of steps[0].flat) { // 看全文 = 回源 (4.2:55): each block's bytes, served by /api/block, are the bytes the relay got
      const blk = await get(`/api/block?ref=${encodeURIComponent(b.text_ref)}`)
      const [, from, to] = /::(\d+)-(\d+)$/.exec(b.text_ref)
      assert.equal(blk.text, relayBody.slice(Number(from), Number(to)), `${b.key}: board bytes == relay bytes`)
    }

    await req(s.sock, 'POST', '/off')
    assert.match(await send('asight-after-off'), /^HTTP\/1\.1 200 OK/) // 4.6 §开关「已有连接」: keeps relaying until it closes
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(!fs.readFileSync(path.join(s.collector, capture), 'utf8').includes('asight-after-off'), 'a request that starts after off is never recorded')
    c.end(); await once(c, 'close')
    await until(() => flowsOf(s).some((f) => f.decision === 'decrypt' && f.agent === 'claude-code' && f.pid === 4242))
  } finally { if (server) server.close(); await d.stop(); up.close(); p.done(); s.done() }
})

test('daemon: the same program without the CA is only observed; its direct connection is metadata in flows/ (T7 unit)', async () => {
  const s = sandbox(); const p = fakeProc()
  await installCollector({ home: path.join(s.root, 'other-home'), env: {}, osName: 'none', harnesses: [], freePort: async () => 0 }) // a CC whose HOME has no settings key
  fs.cpSync(path.join(s.root, 'other-home', '.asight'), path.join(s.home, '.asight'), { recursive: true })
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], env: { ...process.env, HOME: s.home } })
  try {
    p.add(5151, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await req(s.sock, 'POST', '/on', {})
    const row = (await req(s.sock, 'GET', '/status')).agents.find((a) => a.pid === 5151) // picked up by the rescan in `on`
    assert.deepEqual([row.agent, row.trusted, row.reason, row.decrypt, row.source], ['claude-code', false, 'var-missing', false, 'scan'])
    assert.equal(row.hint, 'no asight trust entry is in effect for this process', 'status says why in words (R4)')
    await clients[0].raw({ op: '__emit', ev: 'flow', pid: 5151, dst: { address: '160.79.104.10', port: 443, family: 4 }, ts_ns: 5 })
    const f = await until(() => flowsOf(s).find((x) => x.decision === 'direct'))
    assert.deepEqual([f.pid, f.agent, f.reason], [5151, 'claude-code', 'untrusted: var-missing'])
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: refuses to start uninstalled; desired state survives a restart; on/off idempotent (S6, S9 unit)', async () => {
  const s = sandbox(); const p = fakeProc()
  try {
    await assert.rejects(startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc] }), /not installed/)
    await install(s)
    let d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc] })
    await req(s.sock, 'POST', '/on', {})
    assert.deepEqual([(await req(s.sock, 'POST', '/on', {})).noop, (await req(s.sock, 'GET', '/status')).actual], [true, 'on'])
    await d.stop()
    d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc] })
    const st = await req(s.sock, 'GET', '/status')
    assert.deepEqual([st.desired, st.actual], ['on', 'on'])
    const off = await req(s.sock, 'POST', '/off')
    assert.deepEqual([off.desired, off.actual, off.recording], ['off', 'off', false])
    assert.equal((await req(s.sock, 'POST', '/off')).noop, true)
    await d.stop()
  } finally { p.done(); s.done() }
})

test('daemon: a helper death is degraded and on reports why; a protocol mismatch never attaches (G2); a second daemon is refused before spawning a helper', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc] })
  try {
    const second = fakeArch(p)
    await assert.rejects(startDaemon({ dir: s.collector, socketPath: s.sock, arch: second.arch, harnesses: [cc] }), /another collector daemon/)
    assert.equal(second.clients.length, 0)
    clients[0]._child.kill('SIGKILL')
    const st = await until(async () => { const r = await req(s.sock, 'GET', '/status'); return r.degraded ? r : null })
    assert.deepEqual([st.actual, st.helper.down !== null], ['off', true])
    const on = await req(s.sock, 'POST', '/on', {})
    assert.deepEqual([on.desired, on.actual], ['on', 'off'])
    assert.ok(flowsOf(s).some((f) => f.event === 'attach-failed' && /helper is down/.test(f.error)))
    const failures = (await req(s.sock, 'GET', '/status')).failures.map((f) => f.event)
    assert.ok(failures.includes('helper-down') && failures.includes('attach-failed'), `status reports both (D38): ${failures}`)
  } finally { await d.stop() }
  const mis = fakeArch(p, { ASIGHT_FAKE_PROTO: '2' })
  const d2 = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: mis.arch, harnesses: [cc] })
  try {
    const on = await req(s.sock, 'POST', '/on', {})
    assert.deepEqual([on.actual, on.helper.ok], ['off', false])
    assert.ok(flowsOf(s).some((f) => f.event === 'attach-failed' && /protocol 2/.test(f.reason)), 'every failure record carries reason (D38)')
    assert.ok(flowsOf(s).some((f) => f.event === 'helper-version-mismatch' && /speaks protocol 2, this daemon expects 1; run "sudo asight setup-helper"/.test(f.reason)))
  } finally { await d2.stop(); p.done(); s.done() }
})

test('daemon: the install-time engine port held by another process → start fails with the reason, no helper spawned, nothing steered (G3)', async () => {
  const s = sandbox(); const p = fakeProc()
  const squat = net.createServer(); await new Promise((r) => squat.listen(0, '127.0.0.1', r))
  try {
    await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [cc], freePort: async () => squat.address().port })
    const { arch, clients } = fakeArch(p)
    await assert.rejects(startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc] }), /recorded at install is held by another process; nothing is steered/)
    assert.ok(flowsOf(s).some((f) => f.event === 'failure' && f.where === 'start' && /held by another process/.test(f.reason)), 'the refusal to start is recorded (D38)')
    assert.equal(clients.length, 0, 'the helper was never spawned, so no connection is redirected')
    assert.ok(!fs.existsSync(path.join(s.collector, 'lock')))
    squat.close()
    const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc] }) // the control socket was released
    assert.equal(d.port, readManifestPort(s))
    await d.stop()
  } finally { squat.close(); p.done(); s.done() }
})
const readManifestPort = (s) => JSON.parse(fs.readFileSync(path.join(s.collector, 'install-manifest.json'), 'utf8')).engine_port

test('daemon: a control request that arrives while the daemon is still wiring waits for it instead of failing', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const { arch } = fakeArch(p)
  let release
  const held = new Promise((r) => { release = r })
  const slow = { os: arch.os, createRedirector: (o) => { const r = arch.createRedirector(o); const start = r.start.bind(r); r.start = async () => { await held; return start() }; return r } }
  const starting = startDaemon({ dir: s.collector, socketPath: s.sock, arch: slow, harnesses: [cc] })
  try {
    await until(() => fs.existsSync(s.sock))
    const early = req(s.sock, 'GET', '/status')
    let answered = false; early.then(() => { answered = true }, () => { answered = true })
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(answered, false, 'no answer while the helper is not started')
    release()
    const st = await early
    assert.deepEqual([st.desired, typeof st.engine.port, st.helper.ok], ['off', 'number', true])
  } finally { release(); await (await starting).stop(); p.done(); s.done() }
})

test('daemon: a Claude Code started before install is config-after-start — untrusted, observed only, never decrypted (coordinator 2026-10-06)', async () => {
  const s = sandbox(); const p = fakeProc()
  p.add(6161, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) - 6000 }) // a minute ago
  await install(s)
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc] })
  try {
    const on = await req(s.sock, 'POST', '/on', {})
    const row = on.agents.find((a) => a.pid === 6161)
    assert.deepEqual([row.agent, row.trusted, row.reason, row.decrypt, row.trust_via.startsWith('user settings env')], ['claude-code', false, 'config-after-start', false, true])
    assert.equal((await clients[0].raw({ op: '__watched' })).watch['6161'], 0, 'the kernel only observes it: its connections go direct')
    await req(s.sock, 'POST', '/off'); await req(s.sock, 'POST', '/on', {}) // a second judgment of the same pid and reason
    const recs = flowsOf(s).filter((f) => f.event === 'agent-untrusted')
    assert.deepEqual(recs.map((f) => [f.pid, f.agent, f.code, f.via.startsWith('user settings env')]), [[6161, 'claude-code', 'config-after-start', true]], 'a durable record with the reason code, once per pid and reason (D38)')
    assert.match(recs[0].reason, /restart it to be captured/, 'reason is the text that says what to do; the code is machine-readable (D38 event shape)')
    assert.ok((await req(s.sock, 'GET', '/status')).failures.some((f) => f.event === 'agent-untrusted' && f.pid === 6161), 'status shows it')
    await clients[0].raw({ op: '__emit', ev: 'exit', tgid: 6161, ts_ns: 9 })
    const exit = await until(() => flowsOf(s).find((f) => f.event === 'agent-exit' && f.pid === 6161))
    assert.equal(exit.code, 'config-after-start', 'its exit ends the condition, and says which one (D38)')
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: failures it owns leave a durable record with a reason, also when it cannot be seen live (D38)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  fs.writeFileSync(path.join(s.collector, 'lock'), JSON.stringify({ pid: 999999, socket: s.sock })) // a daemon that was killed -9
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc] })
  const fails = (where) => flowsOf(s).filter((f) => f.event === 'failure' && f.where === where)
  let stopped = false
  try {
    assert.match(fails('daemon')[0].reason, /previous daemon \(pid 999999\) ended without a clean stop.*connections then in flight through its engine were cut \(how many is not known\)/)
    // engine: a connection steered to it whose original destination is unknown is closed — recorded, folded within 10 s
    for (let i = 0; i < 2; i++) { const c = net.connect(d.port, '127.0.0.1'); await once(c, 'close') }
    await until(() => fails('engine').length === 1)
    assert.match(fails('engine')[0].reason, /no original destination for 127\.0\.0\.1:\d+; the steered connection was closed/)
    // helper-reported errors and failed heartbeats
    await clients[0].raw({ op: '__emit', ev: 'error', reason: 'ringbuf poll failed' })
    d.redirector.emit('heartbeat-error', { reason: 'timed out' })
    await until(() => fails('helper').length && fails('heartbeat').length)
    assert.match(fails('heartbeat')[0].reason, /timed out; once the last beat is 2 s old the kernel stops steering/)
    const st = await req(s.sock, 'GET', '/status')
    assert.deepEqual(['daemon', 'engine', 'helper', 'heartbeat'].map((w) => st.failures.some((f) => f.where === w)), [true, true, true, true], 'status reports them')
    await d.stop(); stopped = true
    assert.deepEqual(fails('engine').map((f) => [f.code || null, f.suppressed || 0, !!f.folded]), [['lookup-miss', 0, false], ['lookup-miss', 1, true]], 'the folded second miss is written at stop, not lost')
  } finally { if (!stopped) await d.stop(); p.done(); s.done() }
})

test('daemon: an unreadable lock, an unreadable state file and a control request that fails are each recorded (D38)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  fs.writeFileSync(path.join(s.collector, 'lock'), '{"pid": 12') // torn by a power loss
  fs.mkdirSync(path.join(s.collector, 'state.json')) // neither readable nor writable as a file
  const { arch } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc] })
  const fails = (where) => flowsOf(s).filter((f) => f.event === 'failure' && f.where === where)
  try {
    assert.match(fails('daemon')[0].reason, /unreadable lock .*ended without a clean stop, and connections then in flight through its engine were cut \(how many is not known\)/)
    assert.match(fails('state')[0].reason, /state\.json is unreadable .*reads as off/)
    await assert.rejects(req(s.sock, 'POST', '/on', {}), /^Error: 500: /)
    const c = fails('control')
    assert.deepEqual([c.length, c[0].route], [1, 'on'])
    assert.ok(c[0].reason.length > 0)
    assert.ok((await req(s.sock, 'GET', '/status')).failures.some((f) => f.where === 'control'), 'status reports it')
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: [::1] at the engine port held by another process is recorded with its code, and on refuses to attach (M8, D38)', async (t) => {
  const squat = net.createServer()
  try { await new Promise((r, j) => { squat.once('error', j); squat.listen(0, '::1', r) }) } catch { t.skip('no IPv6 loopback here'); return }
  const s = sandbox(); const p = fakeProc()
  const port = squat.address().port
  try {
    await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [cc], freePort: async () => port })
    const { arch } = fakeArch(p)
    const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc] })
    try {
      const f = flowsOf(s).filter((r) => r.event === 'failure' && r.where === 'engine')
      assert.deepEqual([f.length, f[0].code], [1, 'EADDRINUSE'])
      assert.match(f[0].reason, new RegExp(`\\[::1\\]:${port} unavailable: .*on will refuse to attach \\(M8\\)`))
      const on = await req(s.sock, 'POST', '/on', {})
      assert.equal(on.actual, 'off')
      assert.ok(flowsOf(s).some((r) => r.event === 'attach-failed' && /held by another process; refusing to attach/.test(r.reason)))
    } finally { await d.stop() }
  } finally { squat.close(); p.done(); s.done() }
})

test('daemon: an envelope that cannot be written is a durable failure record, not a stderr line (D38)', async () => {
  const s = sandbox(); const p = fakeProc(); const up = await relay()
  const relayCa = path.join(s.home, 'relay-ca.pem'); fs.writeFileSync(relayCa, up.ca.certPem)
  fs.mkdirSync(path.join(s.home, '.claude'))
  fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `https://relay.asight.test:${up.port}`, NODE_EXTRA_CA_CERTS: relayCa } }))
  await install(s)
  fs.mkdirSync(path.join(s.collector, `capture-${new Date().toISOString().slice(0, 10)}.ndjson`)) // the day's capture file cannot be opened
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], upstreamCa: up.ca.certPem })
  try {
    await req(s.sock, 'POST', '/on', {})
    p.add(7171, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.home, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 7171, pid: 7171, comm: 'claude', filename: CC_EXE, ts_ns: 1 })
    await until(async () => (await req(s.sock, 'GET', '/status')).agents.find((a) => a.pid === 7171 && a.trusted))
    const raw = net.connect(d.port, '127.0.0.1'); await once(raw, 'connect')
    await clients[0].raw({ op: '__inject_port', port: raw.localPort, family: 4, dst: { address: '127.0.0.1', port: up.port, family: 4 }, pid: 7171, decrypt: 1 })
    const c = tls.connect({ socket: raw, servername: 'relay.asight.test', ca: fs.readFileSync(path.join(s.collector, 'ca', 'extra-cc.pem')) }); await once(c, 'secureConnect')
    const body = JSON.stringify({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] })
    c.write(`POST /v1/messages HTTP/1.1\r\nhost: relay.asight.test\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`)
    await until(() => flowsOf(s).some((f) => f.event === 'failure' && f.where === 'record'))
    assert.match(flowsOf(s).find((f) => f.where === 'record').reason, /EISDIR/)
    c.destroy()
  } finally { await d.stop(); up.close(); p.done(); s.done() }
})

test('daemon: a harness whose configuration reader throws is recorded with the reason (D38)', async () => {
  const s = sandbox(); const p = fakeProc()
  const broken = { ...cc, layers: () => { throw new Error('settings.json: unexpected token') } }
  await install(s)
  p.add(8181, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) })
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [broken] })
  try {
    await req(s.sock, 'POST', '/on', {})
    const f = flowsOf(s).find((x) => x.event === 'failure' && x.where === 'harness')
    assert.match(f && f.reason, /claude-code pid 8181: reading its configuration failed \(settings\.json: unexpected token\); judged on its known hosts only/)
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: an error judging a process is a failure record carrying the pid; on still attaches for the rest (D38, review 2 #4)', async () => {
  const s = sandbox(); const p = fakeProc()
  const thrower = { ...cc, trust: { ...cc.trust, refine: () => { throw new Error('refine blew up') } } }
  await install(s)
  const other = path.join(s.root, 'other-home'); fs.mkdirSync(other) // no settings there: untrusted, so refine runs
  p.add(8282, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: other }, startTicks: nowTicks(p) })
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [thrower] })
  try {
    const on = await req(s.sock, 'POST', '/on', {})
    assert.equal(on.actual, 'on', 'one bad process never blocks on')
    const f = flowsOf(s).find((x) => x.event === 'failure' && x.where === 'tracker')
    assert.deepEqual([f && f.pid, f && f.phase], [8282, 'judge'])
    assert.match(f.reason, /pid 8282 \(judge\): refine blew up; it is not watched, its connections go direct/)
    assert.ok((await req(s.sock, 'GET', '/status')).failures.some((x) => x.where === 'tracker' && x.pid === 8282), 'status reports it')
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: a CC started after install stays trusted when settings.json is later edited for something else; a CA value changed after it started is config-after-start, with the hint (review 2 #5)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const settings = path.join(s.home, '.claude', 'settings.json')
  p.add(7171, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) }) // started after install
  const edit = (fn) => { const j = JSON.parse(fs.readFileSync(settings, 'utf8')); fn(j); fs.writeFileSync(settings, JSON.stringify(j, null, 2)); const t = new Date(Date.now() + 120_000); fs.utimesSync(settings, t, t) }
  edit((j) => { j.theme = 'dark' }) // after it started: the file's mtime is now past its start
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc] })
  try {
    const row = (await req(s.sock, 'POST', '/on', {})).agents.find((a) => a.pid === 7171)
    assert.deepEqual([row.trusted, row.decrypt], [true, true], 'the CA asight wrote was there when it started')
    // now the CA value itself changes after it started (to a copy that holds the asight CA too)
    const copy = path.join(s.home, 'copy.pem')
    edit((j) => { fs.copyFileSync(j.env.NODE_EXTRA_CA_CERTS, copy); j.env.NODE_EXTRA_CA_CERTS = copy })
    await req(s.sock, 'POST', '/off'); const again = (await req(s.sock, 'POST', '/on', {})).agents.find((a) => a.pid === 7171)
    assert.deepEqual([again.trusted, again.reason], [false, 'config-after-start'])
    const rec = flowsOf(s).find((f) => f.event === 'agent-untrusted' && f.pid === 7171)
    assert.deepEqual([rec.code, /started before the CA was in its settings.*restart it to be captured/.test(rec.reason)], ['config-after-start', true])
    edit((j) => { j.env.NODE_EXTRA_CA_CERTS = path.join(s.collector, 'ca', 'asight-ca.pem') }) // the value asight installed, again
    await req(s.sock, 'POST', '/off'); await req(s.sock, 'POST', '/on', {})
    const back = flowsOf(s).find((f) => f.event === 'agent-trusted' && f.pid === 7171)
    assert.ok(back && back.code === 'ok', 'a pid recorded untrusted that is trusted again says so: the condition clears (D38)')
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: a step that fails while stopping is recorded with its reason, and stop still finishes (D38)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc] })
  try {
    const realClose = d.redirector.close.bind(d.redirector)
    d.redirector.close = async () => { await realClose(); throw new Error('the helper did not exit in time') }
    await d.stop()
    const f = flowsOf(s).find((x) => x.event === 'failure' && x.where === 'helper')
    assert.match(f && f.reason, /^while stopping: the helper did not exit in time$/)
    assert.ok(!fs.existsSync(path.join(s.collector, 'lock')), 'the later steps ran: the lock is gone')
    assert.ok(!fs.existsSync(s.sock), 'and the control socket')
  } finally { p.done(); s.done() }
})

test('daemon: a plugin harness is marker-pending (not recorded) until its marker appears in run/trust, then trusted at once; a config file that cannot be read is a config-unreadable failure (4.6 「标记」, D38)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const locked = path.join(s.home, 'locked.env'); fs.writeFileSync(locked, 'X=1\n'); fs.chmodSync(locked, 0o000)
  const plug = { name: 'plug-agent', runtime: 'node', hosts: ['api.plug.test'], signatures: { linux: { match: [{ exe: /\/plug-agent$/ }] } },
    layers: (ctx) => { ctx.readText(locked); ctx.unparsable(path.join(s.home, 'broken.json')); return [] }, bypass: () => [{ host: 'early.plug.test', reason: 'before-plugin' }],
    trust: { chain: [{ var: 'NODE_EXTRA_CA_CERTS', semantic: 'append' }, { var: 'asight:marker', semantic: 'append' }], refine: (r) => (r.reason === 'var-missing' ? 'no-marker' : null) } }
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc, plug] })
  try {
    const markers = path.join(s.collector, 'run', 'trust')
    assert.equal(fs.statSync(markers).mode & 0o777, 0o700, 'the marker dir exists while the daemon runs, the operator\'s only')
    const ticks = nowTicks(p)
    p.add(9191, { uid: UID, exe: '/opt/plug-agent', argv: ['plug-agent'], cwd: s.root, env: { HOME: s.home }, startTicks: ticks })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 9191, pid: 9191, comm: 'plug-agent', filename: '/opt/plug-agent', ts_ns: 1 })
    const pending = await until(() => d.tracker.describe(9191))
    assert.deepEqual([pending.trusted, pending.reason], [false, 'marker-pending'])
    const view = (await req(s.sock, 'GET', '/status')).agents.find((a) => a.pid === 9191)
    assert.match(view.hint, /waiting for the trust plugin/, 'status says what it waits for')
    fs.writeFileSync(path.join(markers, '9191'), `${ticks}\n`) // what the plugin writes once it added the CA
    const row = await until(() => { const r = d.tracker.describe(9191); return r && r.trusted ? r : null })
    assert.equal(row.trustVia, 'plugin marker')
    const trusted = (await req(s.sock, 'GET', '/status')).agents.find((a) => a.pid === 9191)
    assert.deepEqual([trusted.hint, trusted.not_via_trust_path], [undefined, [{ host: 'early.plug.test', reason: 'before-plugin' }]], 'hosts it never decrypts are listed with why (4.6 不经信任路径)')
    assert.equal((await clients[0].raw({ op: '__watched' })).watch['9191'], 1, 'decrypted from its next connection')
    assert.ok(!flowsOf(s).some((f) => f.event === 'agent-untrusted' && f.pid === 9191), 'a pending plugin is not a failure')
    const unreadable = flowsOf(s).find((f) => f.event === 'failure' && f.code === 'config-unreadable' && f.pid === 9191)
    if (process.getuid() !== 0) assert.ok(unreadable && unreadable.reason.includes('locked.env'), 'the unreadable file is named, not taken for absent')
    const unparsable = flowsOf(s).find((f) => f.event === 'failure' && f.code === 'config-unparsable' && f.pid === 9191)
    assert.ok(unparsable && unparsable.reason.includes('broken.json exists but does not parse'), 'a config file that does not parse is named too (review 3 #9)')
  } finally { await d.stop(); fs.chmodSync(locked, 0o600); p.done(); s.done() }
})

test('daemon: combined bundles follow the roots — rebuilt at start when the OS roots changed since install, recorded; unchanged roots leave them (4.6 「合并包」, T14)', async () => {
  const s = sandbox(); const p = fakeProc()
  const { createCa } = await import('../../src/collector/core/tls/ca.mjs')
  const tls = await import('node:tls')
  const osRoots = path.join(s.root, 'os-roots.pem'); fs.writeFileSync(osRoots, '')
  const corp = createCa({ commonName: 'corp' }); fs.writeFileSync(path.join(s.home, 'corp.pem'), corp.certPem)
  const dir = s.collector
  const rep = { name: 'rep', runtime: 'rust', hosts: [], signatures: { linux: { match: [{ exe: /\/rep$/ }] } }, trust: { chain: [{ var: 'SSL_CERT_FILE', semantic: 'replace' }] },
    inject: (ctx) => ({ entries: [{ kind: 'text', format: 'dotenv-block', path: path.join(ctx.home, '.rep.env'), vars: { SSL_CERT_FILE: path.join(dir, 'ca', 'combined-rep.pem') }, semantic: 'replace' }], files: [{ path: path.join(dir, 'ca', 'combined-rep.pem'), bundle: true, certsFrom: [path.join(ctx.home, 'corp.pem')] }] }) }
  await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [rep], freePort: async () => 0, osRootsFile: osRoots })
  const bundle = path.join(dir, 'ca', 'combined-rep.pem')
  const before = fs.readFileSync(bundle, 'utf8')
  const { arch } = fakeArch(p)
  let d = await startDaemon({ dir, socketPath: s.sock, arch: { ...arch, osRootsFile: osRoots }, harnesses: [rep] })
  await d.stop()
  assert.equal(fs.readFileSync(bundle, 'utf8'), before, 'same roots: the bundle is left as it is')
  const newRoot = createCa({ commonName: 'a new OS root' }); fs.writeFileSync(osRoots, newRoot.certPem) // the distro updated its roots
  d = await startDaemon({ dir, socketPath: s.sock, arch: { ...fakeArch(p).arch, osRootsFile: osRoots }, harnesses: [rep] })
  try {
    const now = fs.readFileSync(bundle, 'utf8')
    for (const c of [newRoot.certPem, corp.certPem, fs.readFileSync(path.join(dir, 'ca', 'asight-ca.pem'), 'utf8')]) assert.ok(now.includes(c.trim()), 'the new root, the user\'s CA and the asight CA')
    assert.ok(now.includes(tls.rootCertificates[0].trim()), 'Node\'s roots stay first')
    assert.ok(flowsOf(s).some((f) => f.event === 'bundles-rebuilt' && f.code === 'roots-changed' && f.reason.includes('combined-rep.pem')), 'the rebuild is recorded')
  } finally { await d.stop(); p.done(); s.done() }
})

// The daemon hands the engine each process's harness data (plan 3c §2 describe): Codex's WebSocket terminators reach the
// recorder, so a call is cut at response.completed and is on disk while the connection stays open (W10 through the
// product path); without them it waits for the next message or the close. The same FlowExtras carry its own proxies.
test('daemon: describe hands the engine the harness WebSocket terminators and the process\'s own proxies — a Codex WebSocket call is on disk at response.completed (plan 3c §2, W10)', { timeout: 20000 }, async () => {
  const s = sandbox(); const p = fakeProc()
  const labCa = makeLabCa(path.join(s.root, 'lab-ca'))
  const mock = await startMockUpstream({ tls: { key: fs.readFileSync(labCa.key), cert: fs.readFileSync(labCa.cert) } })
  fs.mkdirSync(path.join(s.home, '.codex')); fs.writeFileSync(path.join(s.home, '.codex', 'config.toml'), 'model = "gpt-test-1"\n')
  await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [codex], freePort: async () => 0 })
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [codex], env: { ...process.env, HOME: s.home }, upstreamCa: fs.readFileSync(labCa.caCert, 'utf8') })
  let c = null
  try {
    await req(s.sock, 'POST', '/on', {})
    p.add(5151, { uid: UID, exe: CODEX_EXE, argv: ['codex', 'exec', 'hi'], cwd: s.home, env: { HOME: s.home, HTTPS_PROXY: 'https://u:pw@Proxy.Lab.test:8443' }, startTicks: nowTicks(p) })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 5151, pid: 5151, comm: 'codex', filename: CODEX_EXE, ts_ns: 1 })
    const row = await until(async () => (await req(s.sock, 'GET', '/status')).agents.find((a) => a.pid === 5151 && a.trusted))
    assert.deepEqual([row.agent, row.trust_var, row.hosts.includes('proxy.lab.test')], ['codex', 'SSL_CERT_FILE', false], 'its proxy reaches the engine as FlowExtras, not as a decrypt host')
    assert.deepEqual(d.tracker.extrasFor(5151), { wsTerminal: codex.wsTerminal, proxies: [{ scheme: 'https', host: 'proxy.lab.test', port: 8443, own: true, source: 'env:HTTPS_PROXY' }] })

    const raw = net.connect(d.port, '127.0.0.1'); await once(raw, 'connect')
    await clients[0].raw({ op: '__inject_port', port: raw.localPort, family: 4, dst: { address: '127.0.0.1', port: mock.port, family: 4 }, pid: 5151, decrypt: 1 })
    const bundle = fs.readFileSync(path.join(s.collector, 'ca', 'combined-codex.pem'), 'utf8') // what this codex trusts
    c = await wsConnect(0, { tls: { socket: raw, servername: 'api.openai.com', ca: bundle }, extensions: 'permessage-deflate; client_max_window_bits' })
    assert.equal(c.status, 101)
    const msg = JSON.stringify({ type: 'response.create', model: 'gpt-test-1', store: false, stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'asight-ws-describe' }] }] })
    await c.sendText(msg)
    const evs = await c.events()
    assert.equal(evs.at(-1).type, 'response.completed')
    const capture = () => fs.readdirSync(s.collector).filter((n) => /^capture-.*\.ndjson$/.test(n)).flatMap((n) => fs.readFileSync(path.join(s.collector, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    const [e] = await until(() => { const l = capture().filter((x) => x.transport === 'ws'); return l.length && l }, 1500)
    assert.ok(!c.state.closed, 'cut at the terminal message, not at the close')
    assert.deepEqual([e.req_body, e.resp.messages.map((m) => JSON.parse(m)), e.proc.pid, e.proc.agent], [msg, evs, 5151, 'codex'])

    // describe throws: the connection goes on without extras — the call is cut only at the close — and flows/ has the
    // failure under its code (4.6 §记录, describe-error)
    d.tracker.extrasFor = () => { throw new Error('extras exploded') }
    const raw2 = net.connect(d.port, '127.0.0.1'); await once(raw2, 'connect')
    await clients[0].raw({ op: '__inject_port', port: raw2.localPort, family: 4, dst: { address: '127.0.0.1', port: mock.port, family: 4 }, pid: 5151, decrypt: 1 })
    const c2 = await wsConnect(0, { tls: { socket: raw2, servername: 'api.openai.com', ca: bundle } })
    assert.equal(c2.status, 101, 'the connection goes on')
    const msg2 = msg.replace('asight-ws-describe', 'asight-ws-no-extras')
    await c2.sendText(msg2)
    assert.equal((await c2.events()).at(-1).type, 'response.completed')
    await new Promise((r) => setTimeout(r, 400))
    assert.ok(!capture().some((x) => x.req_body === msg2), 'no terminators: not cut at response.completed')
    c2.sock.destroy()
    await until(() => capture().some((x) => x.req_body === msg2), 1500)
    const f = await until(() => flowsOf(s).find((r) => r.event === 'failure' && r.where === 'engine' && r.code === 'describe-error'))
    assert.match(f.reason, /describing pid 5151 \(codex\) for 127\.0\.0\.1:\d+ failed: extras exploded/)
    assert.deepEqual([f.pid, f.agent, f.dst && f.dst.port], [5151, 'codex', mock.port], 'pid, agent and destination as fields')
  } finally { if (c) c.sock.destroy(); await d.stop(); await mock.close(); p.done(); s.done() }
})

// D-1: an event line the daemon cannot write goes to stderr and into status; the first line written afterwards is a
// log-gap with the count, so the gap is on disk too.
test('daemon: an event line that cannot be written is on stderr and in status; once it can, a log-gap comes first (D-1)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const { arch } = fakeArch(p)
  const logs = []
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], log: (w, e) => logs.push([w, String(e && e.message)]) })
  try {
    const day = path.join(s.collector, 'flows', `${new Date().toISOString().slice(0, 10)}.ndjson`)
    fs.mkdirSync(path.dirname(day), { recursive: true }); fs.rmSync(day, { force: true }); fs.mkdirSync(day) // every append fails (EISDIR)
    d.redirector.emit('heartbeat-error', { code: 'heartbeat-failed', reason: 'timed out' })
    const st = await req(s.sock, 'GET', '/status')
    assert.equal(st.events.lost, 1, 'status reports the lost line')
    assert.match(st.failures_read.errors[0], /EISDIR/, 'and that the day file cannot be read')
    assert.ok(logs.some(([w, m]) => w === 'events' && /EISDIR/.test(m)), 'stderr has it')
    fs.rmdirSync(day)
    d.redirector.emit('helper-error', { reason: 'ringbuf poll failed' })
    await until(() => flowsOf(s).length >= 2)
    assert.deepEqual(flowsOf(s).slice(-2).map((l) => (l.event === 'log-gap' ? ['log-gap', l.lost] : [l.where, l.code])), [['log-gap', 1], ['helper', 'helper-error']])
  } finally { await d.stop(); p.done(); s.done() }
})

// D-25: the lock names pid, start time and boot id, and its mtime is refreshed, so readers judge the daemon from disk.
test('daemon: the lock carries pid, start time and boot id and is refreshed while it runs; a clean stop removes it (D-25)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const { arch } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], identity: (pid) => ({ start_time: `t${pid}`, boot_id: 'boot-1' }), lockRefreshMs: 30 })
  const file = path.join(s.collector, 'lock')
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual([lock.pid, lock.start_time, lock.boot_id, lock.socket], [process.pid, `t${process.pid}`, 'boot-1', s.sock])
    const old = new Date(Date.now() - 60_000); fs.utimesSync(file, old, old)
    await until(() => fs.statSync(file).mtimeMs > Date.now() - 5000, 2000)
  } finally { await d.stop(); p.done() }
  assert.equal(fs.existsSync(file), false, 'a clean stop removes it')
  s.done()
})
