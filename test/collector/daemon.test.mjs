// test/collector/daemon.test.mjs — the vertical-slice daemon over the fake helper and a synthetic /proc (no root):
// Claude Code's real descriptor, trusted through the settings key `installCollector` wrote, has a TLS request
// decrypted and recorded verbatim; the board server, on its default source, serves it from ~/.asight/collector;
// off stops recording; the same program without the CA is only observed; desired state survives a restart.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { startDaemon } from '../../src/collector/daemon.mjs'
import { installCollector } from '../../src/collector/install.mjs'
import { writeStateAtomic, setDesired, emptyState } from '../../src/off/state.mjs'
import { controlRequest } from '../../src/collector/core/control.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { osRootsFor } from '../../src/off/os-roots.mjs'
const osBundleRoots = osRootsFor('linux') // the Linux reader, through the one table
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
import { failureBrief } from '../../src/cli/words.mjs'
import { writeNetenv } from '../../src/netenv/index.mjs'
import { settingSha } from '../../src/netenv/redact.mjs'
import { readManifest, saveManifest } from '../../src/off/manifest.mjs'
import { recordEntryFindings } from '../../src/collector/arch/win32/optin.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const FAKE = fileURLToPath(new URL('./arch/linux/fixtures/fake-loader.mjs', import.meta.url))
const UID = process.getuid()
const CC_EXE = '/home/u/.local/share/claude/versions/2.1.289'
const CODEX_EXE = '/home/u/.local/bin/codex'
// an arch's osRoots over one PEM file: the Linux arch's own resolver (osBundleRoots) with its list cut to that file — the shape every real arch gives
// its OS roots in, asked through the one resolver (core/tls/roots.mjs bundleRoots), never a test-only arm (the platform-seam rule)
const fileRoots = (file) => () => osBundleRoots({ files: [file] })
function fakeArch(p, extraEnv = {}, clientOpts = {}) {
  const clients = []
  const makeClient = () => { const c = createRedirectorClient({ binary: process.execPath, args: [FAKE], env: { ...process.env, ASIGHT_FAKE_LOADER: '1', ...extraEnv }, autoHeartbeatMs: 0, ...clientOpts }); clients.push(c); return c }
  return { clients, arch: { os: 'linux', createRedirector: () => createLinuxRedirector({ makeClient, procRoot: p.root, uid: UID }) } }
}
function sandbox() {
  const root = tmpDir('as-d-') // short: unix socket paths are length-limited
  const home = path.join(root, 'home'); fs.mkdirSync(home)
  return { root, home, collector: path.join(home, '.asight', 'collector'), sock: path.join(root, 'run', 'c.sock'), done: () => fs.rmSync(root, { recursive: true, force: true }) }
}
const req = (sock, method, p, body) => controlRequest({ socketPath: sock, method, path: p, body })
// status reports capture health read by the board's reader (src/health): the last record of each failure kind
const statusFailures = (st) => st.health.collector.failures.map((g) => g.last)
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
  const held = [] // replies withheld while `hold` is set (a response that is slow): release() sends them in order
  const state = { hold: false }
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
        const reply = () => { if (s.writable) s.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${REPLY.length}\r\n\r\n${REPLY}`) }
        if (state.hold) held.push(reply); else reply()
      }
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { ca, got, port: srv.address().port, hold: () => { state.hold = true }, release: () => { state.hold = false; while (held.length) held.shift()() }, close: () => srv.close() }
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
    const post = (text) => {
      const body = JSON.stringify({ model: 'claude-x', max_tokens: 16, system: [{ type: 'text', text: 'You are a test.' }], messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
      return `POST /v1/messages HTTP/1.1\r\nhost: relay.asight.test:${up.port}\r\nanthropic-version: 2023-06-01\r\nx-claude-code-session-id: ${sid}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    }
    const send = (text) => new Promise((resolve) => {
      let reply = ''
      const onData = (x) => { reply += x; if (reply.endsWith(REPLY)) { c.off('data', onData); resolve(reply) } }
      c.on('data', onData)
      c.write(post(text))
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

    // 4.6 §开关「已有连接」: a request that started before off is recorded, one that starts after it is not, through the daemon's own isRecording wiring
    // (sw.isRecording(meta.agent)). The connection is kept busy across off — the relay is slow — so the next request is pipelined on it after off.
    let seen = ''; c.on('data', (x) => { seen += x })
    up.hold()
    c.write(post('asight-in-flight'))
    await until(() => up.got.length === 2)
    const off = await req(s.sock, 'POST', '/off')
    assert.deepEqual([off.relayed, off.pid], [{ closing: 1, waiting: 0, cut: 0 }, process.pid], 'busy: it closes at the response boundary, not at once')
    c.write(post('asight-after-off')) // started after off
    await until(() => up.got.length === 3) // still the agent's own request: forwarded untouched, just not recorded
    up.release()
    await once(c, 'close') // the engine closes it once the responses are out
    assert.equal(seen.split(REPLY).length - 1, 2, 'both replies reached the client in full before the close')
    await until(() => fs.readFileSync(path.join(s.collector, capture), 'utf8').includes('asight-in-flight'))
    const after = fs.readFileSync(path.join(s.collector, capture), 'utf8')
    assert.ok(!after.includes('asight-after-off'), 'a request that starts after off is never recorded')
    assert.equal(after.trim().split('\n').length, 2, 'the first call and the one that was in flight when off came')
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
    await req(s.sock, 'POST', '/on', { harnesses: ['claude-code'] })
    const row = (await req(s.sock, 'GET', '/status')).agents.find((a) => a.pid === 5151) // picked up by the rescan in `on`
    assert.deepEqual([row.agent, row.trusted, row.reason, row.decrypt, row.source], ['claude-code', false, 'var-missing', false, 'scan'])
    assert.equal(row.hint, 'no asight trust entry is in effect for this process', 'status says why in words (R4)')
    await clients[0].raw({ op: '__emit', ev: 'flow', pid: 5151, dst: { address: '160.79.104.10', port: 443, family: 4 }, ts_ns: 5 })
    const f = await until(() => flowsOf(s).find((x) => x.decision === 'direct'))
    assert.deepEqual([f.pid, f.agent, f.reason, f.not_captured], [5151, 'claude-code', 'untrusted: var-missing', 'untrusted'], 'the closed code too (D-11)')
    await clients[0].raw({ op: '__emit', ev: 'flow', pid: 5252, dst: { address: '160.79.104.10', port: 443, family: 4 }, ts_ns: 6 }) // a pid the table does not have
    const u = await until(() => flowsOf(s).find((x) => x.decision === 'direct' && x.pid === 5252))
    assert.equal(u.not_captured, 'untracked')
  } finally { await d.stop(); p.done(); s.done() }
})

// A redirector whose directCount is a Promise (the Windows one reads the connection table through its helper): status awaits it. The daemon used to read `.count` off the Promise,
// so every agent showed `direct: undefined` and "still going direct" was silently empty (4.6 §开关语义, D-17: unknown is said, never nothing).
test('daemon: status awaits the redirector\'s directCount — an arch whose answer is a Promise still gives each agent its `direct` count, and a count it cannot tell stays null with its error', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const { arch } = fakeArch(p)
  const calls = []
  const asynchronous = { os: arch.os, createRedirector: (o) => { const r = arch.createRedirector(o); const real = r.directCount.bind(r); r.directCount = async (pid) => { calls.push(pid); return pid === 5252 ? { count: null, error: 'helper-down' } : real(pid) }; return r } }
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: asynchronous, harnesses: [cc], env: { ...process.env, HOME: s.home } })
  try {
    p.add(5151, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) })
    p.add(5252, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await req(s.sock, 'POST', '/on', {})
    const agents = (await req(s.sock, 'GET', '/status')).agents
    const by = Object.fromEntries(agents.map((a) => [a.pid, a]))
    assert.deepEqual([by[5151].direct, by[5151].direct_error ?? null], [0, null], 'the count the Promise resolved to, not undefined')
    assert.deepEqual([by[5252].direct, by[5252].direct_error], [null, 'helper-down'], 'a count nobody could read is null with the reason')
    assert.ok(calls.includes(5151) && calls.includes(5252))
  } finally { await d.stop(); p.done(); s.done() }
})


// 4.8 §3 (W69): the daemon's /status reply carries the host sets the plan last applied per host-tree form (`applied_hosts`, the wiring's win32 bag),
// which is where `status`'s facts reach them to compare with a fresh read and say when the kernel's set is old. A platform whose redirector has no
// `win32` bag (Linux) simply says nothing there — no key, never a vacuous one.
test('daemon: /status relays the win32 bag\'s applied host sets; a redirector without the bag carries no applied_hosts key', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const { arch } = fakeArch(p)
  const APPLIED = { 'kimi-code.vscode': { hosts: ['api.moonshot.cn', 'relay.corp.example'], settings: 'read', dropped: [] } }
  const withBag = { os: arch.os, createRedirector: (o) => { const r = arch.createRedirector(o); r.win32 = { appliedHosts: () => APPLIED }; return r } }
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: withBag, harnesses: [cc], env: { ...process.env, HOME: s.home } })
  try {
    const st = await req(s.sock, 'GET', '/status')
    assert.deepEqual(st.applied_hosts, APPLIED, 'the applied sets, as the wiring keeps them')
  } finally { await d.stop(); p.done(); s.done() }
  const s2 = sandbox(); const p2 = fakeProc()
  await install(s2)
  const plain = fakeArch(p2)
  const d2 = await startDaemon({ dir: s2.collector, socketPath: s2.sock, arch: plain.arch, harnesses: [cc], env: { ...process.env, HOME: s2.home } })
  try {
    const st = await req(s2.sock, 'GET', '/status')
    assert.equal('applied_hosts' in st, false, 'no bag, no key: a Linux reply is exactly what it was')
  } finally { await d2.stop(); p2.done(); s2.done() }
})

// Review B-4(a) (4.6 子进程与嵌套 agent): "嵌套关系记在 flows/ 的 parent_pid / parent_agent 里" — the engine's rows and the
// metadata row of a connection that went direct carry them, and status lists them with the agent.
test('daemon: an agent started by another agent is recorded with parent_pid and parent_agent in flows/ and status (B-4a)', async () => {
  const s = sandbox(); const p = fakeProc()
  await installCollector({ home: path.join(s.root, 'other-home'), env: {}, osName: 'none', harnesses: [], freePort: async () => 0 })
  fs.cpSync(path.join(s.root, 'other-home', '.asight'), path.join(s.home, '.asight'), { recursive: true })
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], env: { ...process.env, HOME: s.home } })
  try {
    p.add(5100, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) })
    p.add(5101, { ppid: 5100, uid: UID, exe: CC_EXE, argv: ['claude', '-p'], cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await req(s.sock, 'POST', '/on', { harnesses: ['claude-code'] })
    const agents = (await req(s.sock, 'GET', '/status')).agents
    assert.deepEqual(['5100', '5101'].map((id) => { const a = agents.find((x) => x.pid === Number(id)); return [a.parent_pid, a.parent_agent] }), [[1, null], [5100, 'claude-code']])
    for (const pid of [5100, 5101]) await clients[0].raw({ op: '__emit', ev: 'flow', pid, dst: { address: '160.79.104.10', port: 443, family: 4 }, ts_ns: pid })
    const rows = await until(() => { const r = flowsOf(s).filter((x) => x.decision === 'direct'); return r.length === 2 && r })
    const by = Object.fromEntries(rows.map((r) => [r.pid, r]))
    assert.deepEqual([by[5100].parent_pid, 'parent_agent' in by[5100]], [1, false], 'an agent nobody launched an agent for: no parent_agent')
    assert.deepEqual([by[5101].parent_pid, by[5101].parent_agent], [5100, 'claude-code'], 'the nested one says who started it')
  } finally { await d.stop(); p.done(); s.done() }
})

// Review B-4(b) (4.6 agent-transport): QUIC and AF_UNIX never reach the engine, so no connection row can say so: the daemon
// writes one state event per (pid, transport) — once, however often the process is judged again — and status lists them.
test('daemon: an agent started with ANTHROPIC_UNIX_SOCKET or the HTTP3 flag is an agent-transport event once per transport and a line in status; the event is no failure (B-4b)', async () => {
  const s = sandbox(); const p = fakeProc()
  await installCollector({ home: path.join(s.root, 'other-home'), env: {}, osName: 'none', harnesses: [], freePort: async () => 0 })
  fs.cpSync(path.join(s.root, 'other-home', '.asight'), path.join(s.home, '.asight'), { recursive: true })
  const { arch } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], env: { ...process.env, HOME: s.home } })
  try {
    p.add(5300, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: s.home, ANTHROPIC_UNIX_SOCKET: '/run/ant.sock', BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT: '1' }, startTicks: nowTicks(p) })
    p.add(5301, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await req(s.sock, 'POST', '/on', { harnesses: ['claude-code'] })
    await req(s.sock, 'POST', '/off', {}); await req(s.sock, 'POST', '/on', { harnesses: ['claude-code'] }) // every on judges the live processes again
    const st = await req(s.sock, 'GET', '/status')
    assert.deepEqual(st.agents.find((a) => a.pid === 5300).unreachable.map((u) => [u.transport, u.var]), [['af-unix', 'ANTHROPIC_UNIX_SOCKET'], ['quic', 'BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT']])
    assert.deepEqual(st.agents.find((a) => a.pid === 5301).unreachable, [])
    const ev = flowsOf(s).filter((f) => f.event === 'agent-transport')
    assert.deepEqual(ev.map((f) => [f.pid, f.agent, f.transport, f.var]), [[5300, 'claude-code', 'af-unix', 'ANTHROPIC_UNIX_SOCKET'], [5300, 'claude-code', 'quic', 'BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT']], 'once per (pid, transport), none for the plain agent')
    assert.ok(ev.every((f) => typeof f.reason === 'string' && f.reason.length > 0))
    assert.deepEqual(statusFailures(st).filter((f) => f.event === 'agent-transport' || f.code === 'agent-transport'), [], 'a state event, never a failure (⚠)')
  } finally { await d.stop(); p.done(); s.done() }
})

// Review B-1 (4.6 exe-unreadable): on a stock machine, processes of the user's uid that are not dumpable (sshd's session
// processes, (sd-pam), the daemon's own helper) cannot have their exe read. That is normal, so it is no failure and no ⚠: it
// is a count in status (`unjudged`) with samples. A process whose readable command line fits a harness's argv conditions could
// be an agent nobody can judge: that one is the failure, naming the candidates.
test('daemon: a process whose exe cannot be read is a failure only if its command line could be an agent\'s; the rest is counted in status as unjudged, never ⚠ (B-1)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const gamma = { ...cc, name: 'gamma', processes: { names: [{ name: 'node', args: '^\\S*/gamma\\.js( |$)' }] } }
  const unreadableExe = (pid, argv, comm) => { p.add(pid, { uid: UID, exe: '/x/y', argv, comm }); fs.rmSync(path.join(p.root, String(pid), 'exe')); fs.mkdirSync(path.join(p.root, String(pid), 'exe')) }
  unreadableExe(6001, ['sshd: u@notty'], 'sshd'); unreadableExe(6002, ['(sd-pam)'], '(sd-pam)')
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc, gamma], env: { ...process.env, HOME: s.home } })
  try {
    await req(s.sock, 'POST', '/on', {}) // the rescan reads every process of this uid
    let st = await req(s.sock, 'GET', '/status')
    assert.deepEqual([st.unjudged.count, st.unjudged.sample.map((u) => [u.pid, u.comm, u.errno]).sort()], [2, [[6001, 'sshd', 'EINVAL'], [6002, '(sd-pam)', 'EINVAL']]], 'counted, with samples')
    assert.deepEqual(flowsOf(s).filter((f) => f.code === 'exe-unreadable'), [], 'no failure record')
    assert.deepEqual(statusFailures(st).filter((f) => f.code === 'exe-unreadable'), [], 'nothing for the top bar')
    unreadableExe(6003, ['/usr/bin/node', '/opt/gamma.js'], 'node') // a command line gamma's argv condition fits
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 6003, pid: 6003, comm: 'node', filename: '/usr/bin/node', ts_ns: 1 })
    const f = await until(() => flowsOf(s).find((x) => x.code === 'exe-unreadable'))
    assert.deepEqual([f.event, f.where, f.pid, f.errno, f.candidates], ['failure', 'tracker', 6003, 'EINVAL', ['gamma']])
    assert.match(f.reason, /unreadable \(.*\); it is never judged.*its command line fits gamma/)
    st = await req(s.sock, 'GET', '/status')
    assert.equal(st.unjudged.count, 2, 'the candidate is the failure, not part of the count')
    assert.equal(statusFailures(st).filter((x) => x.code === 'exe-unreadable').length, 1)
  } finally { await d.stop(); p.done(); s.done() }
})

test('W25 the win32 daemon refuses an elevated or SYSTEM token before it claims its endpoint: one {start, elevated-token} record, no socket, no control.json; a token that cannot be read is not a refusal (4.8 §7, R7/R11)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const asked = []
  const endpoints = []
  const winish = (answer) => ({ ...fakeArch(p).arch, refuseElevated: async (o) => { asked.push(o); return answer }, controlEndpoint: ({ dir }) => { endpoints.push(dir); return { path: s.sock, token: 't'.repeat(64) } } })
  const winish2 = (note, answer) => ({ ...winish(answer), refuseElevated: async (o) => { asked.push(o); note(o); return answer } })
  // the elevated token: refused, the record is startDaemon's own catch, and neither the endpoint nor its control.json was touched
  await assert.rejects(startDaemon({ dir: s.collector, arch: winish({ code: 'elevated-token', reason: '用你自己的账号跑,不要「以管理员身份运行」(R7)', token: { elevated: true, system: false, integrity: 'high' } }), harnesses: [cc] }), /R7/)
  const w25 = flowsOf(s).filter((l) => l.event === 'failure' && l.where === 'start')
  assert.deepEqual(w25.map((x) => x.code), ['elevated-token'], 'one record of the refusal, where the pin says')
  assert.deepEqual(w25.map((x) => checkRecord(x)), [[]], 'a record the closed set takes')
  assert.equal(fs.existsSync(s.sock), false, 'no endpoint was claimed')
  assert.deepEqual(endpoints, [], 'the arch\'s controlEndpoint was never asked')
  assert.equal(fs.existsSync(path.join(s.collector, 'control.json')), false, 'no control.json was written')
  // a token that cannot be read is not a refusal: the daemon goes on (R11), the unknown said through its log — and its endpoint is the arch's, with the token
  const unknown = []
  const d = await startDaemon({ dir: s.collector, arch: winish2((o) => { if (o.onUnknown) o.onUnknown('the token could not be read: the helper did not answer') }, null), harnesses: [cc], log: (w, e) => unknown.push([w, String(e)]) })
  try {
    assert.equal(asked.length, 2, 'the check ran again')
    assert.ok(unknown.some(([, m]) => /could not be read/.test(m)), 'the unreadable answer was said, not silent (R11)')
    assert.deepEqual(endpoints, [s.collector], 'the daemon asked the arch for its endpoint (the collector dir, 4.8 §7)')
    await assert.rejects(controlRequest({ socketPath: s.sock, method: 'GET', path: '/status' }), (e) => e.status === 401, 'a request without the token is refused at the door')
    const tok = await controlRequest({ socketPath: s.sock, method: 'GET', path: '/status', token: 't'.repeat(64) })
    assert.equal(typeof tok.actual, 'string', 'one with it passes (the status answer itself)')
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
    assert.deepEqual(flowsOf(s).filter((f) => f.event === 'helper-down').map((f) => f.exit), ['SIGKILL'], 'helper-down names how it ended (D-14)')
    const failures = statusFailures(await req(s.sock, 'GET', '/status')).map((f) => f.event)
    assert.ok(failures.includes('helper-down') && failures.includes('attach-failed'), `status reports both (D38): ${failures}`)
  } finally { await d.stop() }
  const mis = fakeArch(p, { ASIGHT_FAKE_PROTO: '3' })
  const d2 = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: mis.arch, harnesses: [cc] })
  try {
    const on = await req(s.sock, 'POST', '/on', {})
    assert.deepEqual([on.actual, on.helper.ok], ['off', false])
    assert.ok(flowsOf(s).some((f) => f.event === 'attach-failed' && /protocol 3/.test(f.reason)), 'every failure record carries reason (D38)')
    assert.ok(flowsOf(s).some((f) => f.event === 'helper-version-mismatch' && /speaks protocol 3, this daemon expects 2; run "sudo asight setup-helper"/.test(f.reason)))
  } finally { await d2.stop(); p.done(); s.done() }
})

test('daemon: the install-time engine port held by another process → start fails with the reason, no helper spawned, nothing steered (G3)', async () => {
  const s = sandbox(); const p = fakeProc()
  const squat = net.createServer(); await new Promise((r) => squat.listen(0, '127.0.0.1', r))
  try {
    await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [cc], freePort: async () => squat.address().port })
    const { arch, clients } = fakeArch(p)
    await assert.rejects(startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc] }), /recorded at install is held by another process; nothing is steered, agent connections go direct\. Free the port, or run "asight uninstall" and "asight on" to pick a new one$/)
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
    await req(s.sock, 'POST', '/on', {}); await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 6161, pid: 6161, comm: 'claude', filename: CC_EXE, ts_ns: 6 }) // a second judgment of the same pid and reason
    await new Promise((r) => setTimeout(r, 50))
    const recs = flowsOf(s).filter((f) => f.event === 'agent-untrusted')
    assert.deepEqual(recs.map((f) => [f.pid, f.agent, f.code, f.via.startsWith('user settings env')]), [[6161, 'claude-code', 'config-after-start', true]], 'a durable record with the reason code, once per pid and reason (D38)')
    assert.match(recs[0].reason, /restart it to be captured/, 'reason is the text that says what to do; the code is machine-readable (D38 event shape)')
    assert.ok(statusFailures(await req(s.sock, 'GET', '/status')).some((f) => f.event === 'agent-untrusted' && f.pid === 6161), 'status shows it')
    // switched off, it is not a capture target: the condition ends (agent-exit via off), and `on` opens it again for the pid that is still untrusted (1.6 §1.5)
    await req(s.sock, 'POST', '/off'); await req(s.sock, 'POST', '/on', {})
    assert.deepEqual(flowsOf(s).filter((f) => (f.event === 'agent-untrusted' || f.event === 'agent-exit') && f.pid === 6161).map((f) => [f.event, f.code, f.via && f.via.startsWith('user settings env') ? 'trust-via' : f.via ?? null]), [['agent-untrusted', 'config-after-start', 'trust-via'], ['agent-exit', 'config-after-start', 'off'], ['agent-untrusted', 'config-after-start', 'trust-via']])
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
    assert.deepEqual(['daemon', 'engine', 'helper', 'heartbeat'].map((w) => statusFailures(st).some((f) => f.where === w)), [true, true, true, true], 'status reports them')
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
    assert.ok(statusFailures(await req(s.sock, 'GET', '/status')).some((f) => f.where === 'control'), 'status reports it')
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
      assert.deepEqual([on.engine.v6, typeof on.engine.v6_error], [null, 'string'], 'status never says [::1] listens')
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
    let reply = ''; c.on('data', (x) => { reply += x })
    c.write(`POST /v1/messages HTTP/1.1\r\nhost: relay.asight.test\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`)
    await until(() => flowsOf(s).some((f) => f.event === 'failure' && f.where === 'record'))
    assert.match(flowsOf(s).find((f) => f.where === 'record').reason, /EISDIR/)
    await until(() => reply.endsWith(REPLY))
    assert.match(reply, /^HTTP\/1\.1 200 OK/, 'fail-open (D31, F4): the agent got the reply although its envelope could not be written')
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
    assert.ok(statusFailures(await req(s.sock, 'GET', '/status')).some((x) => x.where === 'tracker' && x.pid === 8282), 'status reports it')
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
    const r = await d.stop()
    assert.deepEqual(r.failed, ['helper'], 'stop says which step failed, so `collector start` exits non-zero')
    const f = flowsOf(s).find((x) => x.event === 'failure' && x.where === 'helper')
    assert.match(f && f.reason, /^while stopping: the helper did not exit in time$/)
    assert.deepEqual(flowsOf(s).filter((x) => x.event === 'daemon-stop').map((x) => x.failed), [['helper']])
    assert.ok(!fs.existsSync(path.join(s.collector, 'lock')), 'the later steps ran: the lock is gone')
    assert.ok(!fs.existsSync(s.sock), 'and the control socket')
  } finally { p.done(); s.done() }
})

test('daemon: a plugin harness is marker-pending (not recorded) until its marker appears in run/trust, then trusted at once; a config file that cannot be read is a config-unreadable failure (4.6 「标记」, D38)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const locked = path.join(s.home, 'locked.env'); fs.writeFileSync(locked, 'X=1\n'); fs.chmodSync(locked, 0o000)
  const plug = { name: 'plug-agent', runtime: 'node', hosts: ['api.plug.test'], processes: { names: [{ name: 'plug-agent' }] },
    layers: (ctx) => { ctx.readText(locked); ctx.unparsable(path.join(s.home, 'broken.json')); return [] }, bypass: () => [{ host: 'early.plug.test', reason: 'before-plugin' }],
    trust: { chain: [{ var: 'NODE_EXTRA_CA_CERTS', semantic: 'append' }, { var: 'asight:marker', semantic: 'append' }], refine: (r) => (r.reason === 'var-missing' ? 'no-marker' : null) } }
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc, plug] })
  try {
    await req(s.sock, 'POST', '/on', { harnesses: ['claude-code', 'plug-agent'] }) // a harness that is off is not judged at all (1.6 §1.5): the plugin harness is on
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
  const rep = { name: 'rep', runtime: 'rust', hosts: [], processes: { names: [{ name: 'rep' }] }, trust: { chain: [{ var: 'SSL_CERT_FILE', semantic: 'replace' }] },
    inject: (ctx) => ({ entries: [{ kind: 'text', format: 'dotenv-block', path: path.join(ctx.home, '.rep.env'), vars: { SSL_CERT_FILE: path.join(dir, 'ca', 'combined-rep.pem') }, semantic: 'replace' }], files: [{ path: path.join(dir, 'ca', 'combined-rep.pem'), bundle: true, certsFrom: [path.join(ctx.home, 'corp.pem')] }] }) }
  await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [rep], freePort: async () => 0, arch: { osRoots: fileRoots(osRoots) } })
  writeStateAtomic(path.join(dir, 'state.json'), setDesired(emptyState(), ['rep'], 'on')) // the daemon rebuilds the bundles of the harnesses whose desired state is on only (4.6 「合并包」, D39)
  const bundle = path.join(dir, 'ca', 'combined-rep.pem')
  const before = fs.readFileSync(bundle, 'utf8')
  const { arch } = fakeArch(p)
  let d = await startDaemon({ dir, socketPath: s.sock, arch: { ...arch, osRoots: fileRoots(osRoots) }, harnesses: [rep] })
  await d.stop()
  assert.equal(fs.readFileSync(bundle, 'utf8'), before, 'same roots: the bundle is left as it is')
  const newRoot = createCa({ commonName: 'a new OS root' }); fs.writeFileSync(osRoots, newRoot.certPem) // the distro updated its roots
  d = await startDaemon({ dir, socketPath: s.sock, arch: { ...fakeArch(p).arch, osRoots: fileRoots(osRoots) }, harnesses: [rep] })
  try {
    const now = fs.readFileSync(bundle, 'utf8')
    for (const c of [newRoot.certPem, corp.certPem, fs.readFileSync(path.join(dir, 'ca', 'asight-ca.pem'), 'utf8')]) assert.ok(now.includes(c.trim()), 'the new root, the user\'s CA and the asight CA')
    assert.ok(now.includes(tls.rootCertificates[0].trim()), 'Node\'s roots stay first')
    assert.ok(flowsOf(s).some((f) => f.event === 'bundles-rebuilt' && f.code === 'roots-changed' && f.reason.includes('combined-rep.pem')), 'the rebuild is recorded')
  } finally { await d.stop(); p.done(); s.done() }
})

// 4.6 「合并包」, D38: the Linux arch's OS roots are the first OS PEM bundle of SYSTEM_BUNDLES this machine has, read on every rebuild — not the Debian path alone
// (Fedora / RHEL / openSUSE have no /etc/ssl/certs/ca-certificates.crt). A machine with none gets bundles with Node's roots only, and that is a failure record that
// status (and the board, the same reader) shows; Fedora's bundle, once there, is in the next rebuild. Judged by the bundle on disk and the records, through the real arch.
test('daemon: the Linux arch\'s OS roots — none on the machine is a bundle failure status shows; Fedora\'s bundle, once there, is in the rebuilt bundle (4.6 「合并包」, D38)', async () => {
  const s = sandbox(); const p = fakeProc()
  const { loadArch } = await import('../../src/collector/arch/index.mjs')
  const { SYSTEM_BUNDLES } = await import('../../src/collector/core/tls/roots.mjs')
  const linux = await loadArch('linux')
  const disk = new Map(), denied = new Set() // this machine's /etc as the arch reads it: empty = no OS bundle at all
  const read = (f) => {
    if (denied.has(f)) throw Object.assign(new Error(`EACCES: permission denied, open '${f}'`), { code: 'EACCES' })
    if (disk.has(f)) return disk.get(f); throw Object.assign(new Error(`ENOENT: no such file or directory, open '${f}'`), { code: 'ENOENT' })
  }
  const osRoots = () => linux.osRoots({ read })
  const dir = s.collector
  const rep = { name: 'rep', runtime: 'rust', hosts: [], processes: { names: [{ name: 'rep' }] }, trust: { chain: [{ var: 'SSL_CERT_FILE', semantic: 'replace' }] },
    inject: (ctx) => ({ entries: [{ kind: 'text', format: 'dotenv-block', path: path.join(ctx.home, '.rep.env'), vars: { SSL_CERT_FILE: path.join(dir, 'ca', 'combined-rep.pem') }, semantic: 'replace' }], files: [{ path: path.join(dir, 'ca', 'combined-rep.pem'), bundle: true, certsFrom: [] }] }) }
  const first = osRoots()
  await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [rep], freePort: async () => 0, roots: { node: [...tls.rootCertificates], osText: first.pem, missing: first.missing } })
  writeStateAtomic(path.join(dir, 'state.json'), setDesired(emptyState(), ['rep'], 'on'))
  const bundle = path.join(dir, 'ca', 'combined-rep.pem')
  const fedora = createCa({ commonName: 'corp CA in the Fedora system bundle' })
  const d = await startDaemon({ dir, socketPath: s.sock, arch: { ...fakeArch(p).arch, osRoots }, harnesses: [rep], bundleMs: 30 })
  try {
    const f = await until(() => flowsOf(s).find((x) => x.event === 'failure' && x.where === 'bundle' && x.code === 'system-roots-unavailable'))
    assert.deepEqual(f.files, [bundle], 'the bundle that carries no OS root')
    for (const b of SYSTEM_BUNDLES) assert.ok(f.reason.includes(b), `the reason names every path looked at: ${b}`)
    const st = await req(s.sock, 'GET', '/status')
    const g = st.health.collector.failures.find((x) => x.last.where === 'bundle' && x.last.code === 'system-roots-unavailable')
    assert.ok(g, 'status (the board\'s reader) shows it')
    assert.match(failureBrief(g), /^合并包里没有系统根证书\(/, 'in the words status prints')
    assert.ok(!fs.readFileSync(bundle, 'utf8').includes(fedora.certPem.trim()))
    disk.set('/etc/pki/tls/certs/ca-bundle.crt', fedora.certPem) // the machine is a Fedora one after all (or ca-certificates got installed): the next rebuild reads it
    await until(() => fs.readFileSync(bundle, 'utf8').includes(fedora.certPem.trim()))
    assert.ok(fs.readFileSync(bundle, 'utf8').includes(tls.rootCertificates[0].trim()), 'Node\'s roots stay in it')
    assert.ok(flowsOf(s).some((x) => x.event === 'bundles-rebuilt' && x.code === 'roots-changed' && x.reason.includes('combined-rep.pem')), 'the rebuild is recorded')
    // a bundle that is there but cannot be read: the rebuild stops, the bundles keep the roots they have (not rebuilt without them), and that is a failure
    const kept = fs.readFileSync(bundle, 'utf8')
    denied.add(SYSTEM_BUNDLES[0])
    const eacces = await until(() => flowsOf(s).find((x) => x.event === 'failure' && x.where === 'bundle' && x.code === 'EACCES'))
    assert.match(eacces.reason, /the OS trust bundle cannot be read .*EACCES.*; they keep their previous roots/)
    await new Promise((r) => setTimeout(r, 100)) // a few more rounds at 30 ms
    assert.equal(fs.readFileSync(bundle, 'utf8'), kept, 'the bundle is as it was')
  } finally { await d.stop(); p.done(); s.done() }
})

// 4.8 §6.2 / W20, 4.9 §6.2, 4.6 「合并包」: the OS roots the reader left out — certificates that did not parse, a source whose read failed while others gave
// roots (darwin on Node 20: no getCACertificates, so not the keychain's local anchors, where a corporate CA lives) — are in no combined bundle, and every
// rebuild says so as a `bundle` failure status shows (D38); an answer with nothing left out says nothing.
test('daemon: OS roots the reader dropped as unparsable, or a roots source that failed, are bundle failures at every rebuild that status shows; nothing left out says nothing (4.8 §6.2, D38)', async () => {
  const s = sandbox(); const p = fakeProc()
  const dir = s.collector
  const root = createCa({ commonName: 'an OS root' })
  let answer = { pem: root.certPem, dropped: 0, tried: [] }, asked = 0
  const osRoots = async () => { asked++; return answer }
  const rep = { name: 'rep', runtime: 'rust', hosts: [], processes: { names: [{ name: 'rep' }] }, trust: { chain: [{ var: 'SSL_CERT_FILE', semantic: 'replace' }] },
    inject: (ctx) => ({ entries: [{ kind: 'text', format: 'dotenv-block', path: path.join(ctx.home, '.rep.env'), vars: { SSL_CERT_FILE: path.join(dir, 'ca', 'combined-rep.pem') }, semantic: 'replace' }], files: [{ path: path.join(dir, 'ca', 'combined-rep.pem'), bundle: true, certsFrom: [] }] }) }
  await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [rep], freePort: async () => 0, arch: { osRoots } })
  writeStateAtomic(path.join(dir, 'state.json'), setDesired(emptyState(), ['rep'], 'on'))
  const bundle = path.join(dir, 'ca', 'combined-rep.pem')
  const said = () => flowsOf(s).filter((x) => x.event === 'failure' && x.where === 'bundle' && /^system-roots-(unparsable|partial)$/.test(x.code))
  const d = await startDaemon({ dir, socketPath: s.sock, arch: { ...fakeArch(p).arch, osRoots }, harnesses: [rep], bundleMs: 30 })
  try {
    const before = asked
    await until(() => asked >= before + 4) // three whole rebuilds with nothing left out (a round reads, then writes; the 4th read means the 3rd round wrote)
    assert.deepEqual(said(), [], 'nothing left out: no failure')
    answer = { pem: root.certPem, dropped: 2, tried: ['getCACertificates: not available (Node ≥ 22.15 has it)'] }
    const u = await until(() => said().find((x) => x.code === 'system-roots-unparsable'))
    const q = await until(() => said().find((x) => x.code === 'system-roots-partial'))
    assert.deepEqual([u.files, u.dropped, q.files], [[bundle], 2, [bundle]], 'the bundle they are missing from, and how many did not parse')
    assert.match(u.reason, /^2 certificates in the OS roots could not be parsed and are not in the combined bundles .*combined-rep\.pem/)
    assert.match(q.reason, /combined-rep\.pem.*getCACertificates: not available \(Node ≥ 22\.15 has it\)/, 'the reason of the failed source')
    const st = await req(s.sock, 'GET', '/status')
    const g = (code) => st.health.collector.failures.find((x) => x.last.where === 'bundle' && x.last.code === code)
    assert.ok(g('system-roots-unparsable') && g('system-roots-partial'), 'status (the board\'s reader) shows both')
    assert.match(failureBrief(g('system-roots-unparsable')), /^有系统根证书解析不了,没进合并包\(/, 'in the words status prints')
    assert.match(failureBrief(g('system-roots-partial')), /^合并包少了一部分系统根证书\(/)
  } finally { await d.stop(); p.done(); s.done() }
})

// 4.6 「合并包」, D39: the daily rebuild is for the harnesses whose desired state is on, and works on the manifest as it is on disk. `asight off <h>` runs while
// the daemon does (it is not stopped for one harness): what it removed or kept without the asight CA must not come back with it, and the manifest it saved
// must not be written over by the copy the daemon read at start.
test('daemon: the daily bundle rebuild never writes the asight CA back into a bundle `asight off` removed, nor puts its undone entries back, and leaves a harness that is not on alone (4.6 「合并包」, D39)', async () => {
  const s = sandbox(); const p = fakeProc()
  const { createCa } = await import('../../src/collector/core/tls/ca.mjs')
  const { readManifest } = await import('../../src/off/manifest.mjs')
  const { undoHarnesses } = await import('../../src/off/undo.mjs')
  const tlsMod = await import('node:tls')
  const osRoots = path.join(s.root, 'os-roots.pem'); fs.writeFileSync(osRoots, '')
  fs.writeFileSync(path.join(s.home, 'corp.pem'), createCa({ commonName: 'corp' }).certPem)
  const dir = s.collector
  const repOf = (name) => ({ name, runtime: 'rust', hosts: [], processes: { names: [{ name }] }, trust: { chain: [{ var: 'SSL_CERT_FILE', semantic: 'replace' }] },
    inject: (ctx) => ({ entries: [{ kind: 'text', format: 'dotenv-block', path: path.join(ctx.home, `.${name}.env`), vars: { SSL_CERT_FILE: path.join(dir, 'ca', `combined-${name}.pem`) }, semantic: 'replace' }], files: [{ path: path.join(dir, 'ca', `combined-${name}.pem`), bundle: true, certsFrom: [path.join(ctx.home, 'corp.pem')] }] }) })
  const list = [repOf('stay'), repOf('gone'), repOf('idle')]
  await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: list, freePort: async () => 0, arch: { osRoots: fileRoots(osRoots) } })
  writeStateAtomic(path.join(dir, 'state.json'), setDesired(emptyState(), ['stay', 'gone'], 'on')) // idle was never turned on
  const bundle = (n) => path.join(dir, 'ca', `combined-${n}.pem`)
  const idleBefore = fs.readFileSync(bundle('idle'), 'utf8')
  const { arch } = fakeArch(p)
  const d = await startDaemon({ dir, socketPath: s.sock, arch: { ...arch, osRoots: fileRoots(osRoots) }, harnesses: list, bundleMs: 30 })
  try {
    // `asight off gone`, while the daemon runs: its entry out, its bundle removed (nobody holds it), the manifest saved
    const off = await undoHarnesses({ dir, home: s.home, manifest: readManifest(dir), ids: ['gone'], procs: async () => [], roots: { node: tlsMod.rootCertificates, osText: '' } })
    writeStateAtomic(path.join(dir, 'state.json'), setDesired(emptyState(), ['stay'], 'on'))
    assert.deepEqual([off.results.map((r) => r.result), fs.existsSync(bundle('gone'))], [['restored'], false])
    const saved = fs.readFileSync(path.join(dir, 'install-manifest.json'), 'utf8')
    // the distro updates its roots: the next rebuild is due for every bundle whose roots differ
    const newRoot = createCa({ commonName: 'a new OS root' }); fs.writeFileSync(osRoots, newRoot.certPem)
    await until(() => fs.readFileSync(bundle('stay'), 'utf8').includes(newRoot.certPem.trim()))
    assert.deepEqual([fs.existsSync(bundle('gone')), fs.readFileSync(bundle('idle'), 'utf8') === idleBefore], [false, true], 'the bundle `off` removed is not recreated, and a harness that is not on is left as it is')
    const m = readManifest(dir)
    assert.deepEqual([m.entries.map((e) => e.harness).sort(), m.files.filter((f) => f.role === 'bundle').map((f) => f.harness).sort(), Object.keys(m.liveness).sort()], [['idle', 'stay'], ['idle', 'stay'], ['idle', 'stay']], '`off`\'s manifest stands: nothing of gone came back from the copy read at start')
    assert.ok(JSON.parse(saved).files.every((f) => f.harness !== 'gone'), 'what off saved had no bundle of gone')
    assert.ok(!flowsOf(s).some((f) => f.event === 'bundles-rebuilt' && f.harness === 'gone'), 'and no rebuild was recorded for it')
  } finally { await d.stop(); p.done(); s.done() }
})

// 1.6 R12: the daemon's rebuild reads the manifest, rewrites bundles and saves the manifest — the same files `on`, `off` and `uninstall` change — so it does that under the op lock.
test('daemon: the bundle rebuild runs under the op lock (1.6 R12) — while another command holds it nothing is rewritten and the manifest is not read-modified-saved; a round after it lets go does the rebuild; a stale lock is taken over and released', async () => {
  const s = sandbox(); const p = fakeProc()
  const { createCa } = await import('../../src/collector/core/tls/ca.mjs')
  const osRoots = path.join(s.root, 'os-roots.pem'); fs.writeFileSync(osRoots, '')
  const dir = s.collector
  const rep = { name: 'rep', runtime: 'rust', hosts: [], processes: { names: [{ name: 'rep' }] }, trust: { chain: [{ var: 'SSL_CERT_FILE', semantic: 'replace' }] },
    inject: (ctx) => ({ entries: [{ kind: 'text', format: 'dotenv-block', path: path.join(ctx.home, '.rep.env'), vars: { SSL_CERT_FILE: path.join(dir, 'ca', 'combined-rep.pem') }, semantic: 'replace' }], files: [{ path: path.join(dir, 'ca', 'combined-rep.pem'), bundle: true, certsFrom: [], role: 'bundle' }] }) }
  await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [rep], freePort: async () => 0, arch: { osRoots: fileRoots(osRoots) } })
  writeStateAtomic(path.join(dir, 'state.json'), setDesired(emptyState(), ['rep'], 'on'))
  const bundle = path.join(dir, 'ca', 'combined-rep.pem'), lock = path.join(dir, 'op.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, start_time: null, boot_id: null }) + '\n') // another command is running: this process stands in for it
  const root1 = createCa({ commonName: 'an OS root' }); fs.writeFileSync(osRoots, root1.certPem)
  const d = await startDaemon({ dir, socketPath: s.sock, arch: { ...fakeArch(p).arch, osRoots: fileRoots(osRoots) }, harnesses: [rep], bundleMs: 30 })
  try {
    await new Promise((r) => setTimeout(r, 250)) // several rounds at 30 ms
    assert.ok(!fs.readFileSync(bundle, 'utf8').includes(root1.certPem.trim()), 'nothing was rewritten while the lock was held')
    assert.ok(fs.readFileSync(lock, 'utf8').includes(String(process.pid)), 'and the holder\'s lock is still its own')
    fs.rmSync(lock) // the command is done
    await until(() => fs.readFileSync(bundle, 'utf8').includes(root1.certPem.trim()))
    assert.ok(!fs.existsSync(lock), 'the daemon let go of the lock after its rebuild')
    const root2 = createCa({ commonName: 'another OS root' }); fs.writeFileSync(osRoots, root2.certPem)
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 7, start_time: '1', boot_id: 'b' }) + '\n') // the lock of a command that died
    await until(() => fs.readFileSync(bundle, 'utf8').includes(root2.certPem.trim()))
    assert.ok(!fs.existsSync(lock), 'a stale lock is taken over, and released')
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
    const { trust, ...extras } = d.tracker.extrasFor(5151)
    assert.equal(trust.var, 'SSL_CERT_FILE', 'the trust entry the verdict relied on rides along (D51④)')
    assert.deepEqual(extras, { wsTerminal: codex.wsTerminal, proxies: [{ scheme: 'https', host: 'proxy.lab.test', port: 8443, own: true, source: 'env:HTTPS_PROXY' }] })

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
    assert.match(st.health.read.errors[0].error, /EISDIR/, 'and that the day file cannot be read')
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

// D-24 / D-27 / W-4 / D-22: the daemon's own lifecycle is on disk — what started (with its identity, version, whether
// it runs in a terminal, its own NODE_EXTRA_CA_CERTS, linger) and what stopped it (SIGHUP = the terminal closed).
test('daemon: daemon-start carries its identity, version, foreground, upstream_ca and linger; daemon-stop the signal; the next start sees a clean stop (D-24, D-27)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const lingerDir = path.join(s.root, 'linger'); fs.mkdirSync(lingerDir); fs.writeFileSync(path.join(lingerDir, os.userInfo().username), '')
  const { arch: base } = fakeArch(p)
  const withLinger = { os: 'linux', createRedirector: (o) => { const r = base.createRedirector(o); r.linger = () => fs.existsSync(path.join(lingerDir, os.userInfo().username)); return r } }
  const opts = { dir: s.collector, socketPath: s.sock, arch: withLinger, harnesses: [cc], foreground: true, env: { ...process.env, NODE_EXTRA_CA_CERTS: '/etc/relay-ca.pem' }, identity: () => ({ start_time: '42', boot_id: 'b-9' }) }
  let d = await startDaemon(opts)
  await d.stop({ signal: 'SIGHUP' })
  d = await startDaemon({ ...opts, foreground: false, env: { ...process.env, NODE_EXTRA_CA_CERTS: '' } })
  try {
    const life = flowsOf(s).filter((f) => f.event === 'daemon-start' || f.event === 'daemon-stop')
    assert.deepEqual(life.map((f) => [f.event, f.pid, f.start_time ?? null, f.boot_id ?? null, f.version ?? null, f.foreground ?? null, f.upstream_ca ?? null, f.linger ?? null, f.signal ?? null]),
      [['daemon-start', process.pid, '42', 'b-9', '0.0.0', true, '/etc/relay-ca.pem', true, null], ['daemon-stop', process.pid, null, null, null, null, null, null, 'SIGHUP'], ['daemon-start', process.pid, '42', 'b-9', '0.0.0', false, null, true, null]])
    assert.equal(flowsOf(s).filter((f) => f.code === 'unclean-stop').length, 0, 'a SIGHUP stop is a clean stop')
  } finally { await d.stop(); p.done(); s.done() }
})

// 1.6 §2: what the daemon tells a user to run is a command of help, never a hidden alias (`collector install` / `collector uninstall` are only kept for scripts written before D39).
test('daemon: started where asight is not installed, or where the manifest cannot be read, it says which commands to run — `asight on`, `asight uninstall` (1.6 §2)', async () => {
  const s = sandbox()
  try {
    const arch = { os: 'linux', createRedirector: () => { throw new Error('must not get this far') } }
    await assert.rejects(startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc] }), (e) => e.code === 'not-installed' && /the collector is not installed for this user: run "asight on" first$/.test(e.message))
    fs.mkdirSync(s.collector, { recursive: true }); fs.writeFileSync(path.join(s.collector, 'install-manifest.json'), '{not json')
    await assert.rejects(startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc] }), (e) => e.code === 'manifest-unreadable' && /is unreadable \(.*\); run "asight uninstall", then "asight on"$/.test(e.message))
  } finally { s.done() }
})

// D-31: started as root (sudo -E), it refuses before writing anything else, and the refusal it records in the user's
// collector directory is given back to the directory's owner — no root-owned file the user's daemon cannot append to.
test('daemon: started as root it refuses (root-refused), and the record it leaves is chowned to the collector directory owner (D-31)', async () => {
  const s = sandbox()
  await install(s)
  const chowned = []
  await assert.rejects(startDaemon({ dir: s.collector, socketPath: s.sock, arch: { os: 'linux', createRedirector: () => { throw new Error('must not get this far') } }, harnesses: [cc], getuid: () => 0, chown: (f, u, g) => chowned.push([path.relative(s.collector, f), u, g]) }), /not as root/)
  try {
    const rec = flowsOf(s).find((f) => f.where === 'start')
    assert.deepEqual([rec.code, /not as root/.test(rec.reason)], ['root-refused', true])
    const { uid, gid } = fs.statSync(s.collector)
    assert.deepEqual(chowned.map(([f]) => f).sort(), ['flows', path.join('flows', fs.readdirSync(path.join(s.collector, 'flows'))[0])])
    assert.ok(chowned.every(([, u, g]) => u === uid && g === gid))
    assert.equal(fs.existsSync(path.join(s.collector, 'lock')), false, 'nothing else written')
  } finally { s.done() }
})

// D-24 / D-12 / D-19: an agent's exit is on disk and drops what it held (its negative-cache entries, said); a pid
// that becomes trusted is on disk; a process two descriptors claim is a failure record and listed by status.
test('daemon: agent-trusted, agent-exit (also found by a rescan) and negative-cache-cleared; an ambiguous process is recorded and listed (D-24, D-12, D-19)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const twin = { ...cc, name: 'claude-twin' } // claims the same processes as claude-code
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], env: { ...process.env, HOME: s.home } })
  try {
    p.add(6262, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await req(s.sock, 'POST', '/on', {})
    await until(() => flowsOf(s).some((f) => f.event === 'agent-trusted' && f.pid === 6262))
    const forgot = []; const realForget = d.engine.forgetPid
    d.engine.forgetPid = (pid) => { forgot.push(pid); realForget(pid); return 2 } // as if two hosts of it were negative-cached
    await clients[0].raw({ op: '__emit', ev: 'exit', tgid: 6262, ts_ns: 7 })
    const exit = await until(() => flowsOf(s).find((f) => f.event === 'agent-exit' && f.pid === 6262))
    assert.deepEqual([exit.agent, exit.via], ['claude-code', 'exit'])
    assert.deepEqual(forgot, [6262], 'the engine forgets the exited pid (a reused pid inherits nothing)')
    assert.deepEqual(flowsOf(s).filter((f) => f.event === 'negative-cache-cleared').map((f) => [f.pid, f.dropped, f.neg_key]), [[6262, 2, '6262']], 'the clearing says which key it cleared (4.8 §5.5)')
    fs.rmSync(path.join(p.root, '6262'), { recursive: true })
    p.add(6363, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await req(s.sock, 'POST', '/off'); await req(s.sock, 'POST', '/on', {}) // the rescan behind `on` picks it up
    fs.rmSync(path.join(p.root, '6363'), { recursive: true }) // exits while no exit event reaches us
    await req(s.sock, 'POST', '/off'); await req(s.sock, 'POST', '/on', {})
    assert.ok(flowsOf(s).some((f) => f.event === 'agent-exit' && f.pid === 6363 && f.via === 'rescan'), 'an exit found by a rescan is recorded too')
    // D1-4: an agent that execs into a program no descriptor matches leaves the same way (agent-exit, forgetPid)
    p.add(6565, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 6565, pid: 6565, comm: 'claude', filename: CC_EXE, ts_ns: 8 })
    await until(() => flowsOf(s).some((f) => f.event === 'agent-trusted' && f.pid === 6565))
    fs.rmSync(path.join(p.root, '6565'), { recursive: true })
    p.add(6565, { uid: UID, exe: '/usr/bin/bash', argv: ['bash'], cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 6565, pid: 6565, comm: 'bash', filename: '/usr/bin/bash', ts_ns: 9 })
    const away = await until(() => flowsOf(s).find((f) => f.event === 'agent-exit' && f.pid === 6565))
    assert.deepEqual([away.agent, away.via, forgot.includes(6565)], ['claude-code', 'exec', true], 'exec\'d away: recorded, and its negative-cache entries forgotten')
  } finally { await d.stop() }
  p.add(6464, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) })
  const d2 = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc, twin], env: { ...process.env, HOME: s.home } }) // restores `on`: its rescan sees 6464
  try {
    const st = await req(s.sock, 'GET', '/status')
    assert.deepEqual(st.unmatched.map((u) => [u.pid, u.candidates]), [[6464, ['claude-code', 'claude-twin']]])
    const f = flowsOf(s).filter((x) => x.where === 'tracker' && x.code === 'ambiguous')
    assert.deepEqual(f.map((x) => [x.pid, x.candidates]), [[6464, ['claude-code', 'claude-twin']]], 'once per pid')
    await req(s.sock, 'POST', '/off'); await req(s.sock, 'POST', '/on', {})
    assert.equal(flowsOf(s).filter((x) => x.code === 'ambiguous').length, 1, 'not again on the next rescan')
  } finally { await d2.stop(); p.done(); s.done() }
})

// D-10: any [::1] failure, not only EADDRINUSE, is recorded and makes status say IPv6 is not listening.
test('daemon: [::1] that cannot be bound for another reason (no IPv6) is recorded with its errno, and status never reports it listening (D-10)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const realListen = net.Server.prototype.listen
  net.Server.prototype.listen = function (...a) { if (a[1] === '::1') { process.nextTick(() => this.emit('error', Object.assign(new Error('listen EADDRNOTAVAIL: address not available ::1'), { code: 'EADDRNOTAVAIL' }))); return this } return realListen.apply(this, a) }
  let d
  try { d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc] }) } finally { net.Server.prototype.listen = realListen }
  try {
    const st = await req(s.sock, 'GET', '/status')
    assert.deepEqual([st.engine.v6, /EADDRNOTAVAIL/.test(st.engine.v6_error)], [null, true])
    assert.deepEqual(flowsOf(s).filter((f) => f.where === 'engine').map((f) => f.code), ['EADDRNOTAVAIL'])
  } finally { await d.stop(); p.done(); s.done() }
})

// D-4 / F1(c): an unusable CA (the key of another CA, a key file gone, or found broken by the daily check) means
// "CA unusable" on disk and in status — never "not installed" — and the daemon never hooks: agents go direct.
test('daemon: an unusable CA is recorded as ca-invalid with which part and file, status says so, on never attaches; the daily check finds a CA broken later (D-4)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const caDir = path.join(s.collector, 'ca')
  const goodKey = fs.readFileSync(path.join(caDir, 'ca.key'), 'utf8')
  fs.writeFileSync(path.join(caDir, 'ca.key'), createCa().keyPem) // another CA's key: not a pair
  let d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc] })
  try {
    const rec = flowsOf(s).find((f) => f.code === 'ca-invalid')
    assert.deepEqual([rec.where, rec.which, rec.file], ['ca', 'pair', path.join(caDir, 'asight-ca.pem')])
    const on = await req(s.sock, 'POST', '/on', {})
    assert.deepEqual([on.ca.ok, on.ca.which, on.actual], [false, 'pair', 'off'], 'never hooked')
    assert.ok(flowsOf(s).some((f) => f.event === 'attach-failed' && /CA is unusable/.test(f.reason)))
    assert.ok(!JSON.stringify(on).includes('not installed'), 'never "not installed"')
  } finally { await d.stop() }
  fs.rmSync(path.join(caDir, 'ca.key'))
  d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc] })
  try {
    const st = await req(s.sock, 'GET', '/status')
    assert.deepEqual([st.ca.ok, st.ca.which, st.ca.errno], [false, 'key', 'ENOENT'], 'a missing key file: which file and the errno')
  } finally { await d.stop() }
  fs.writeFileSync(path.join(caDir, 'ca.key'), goodKey, { mode: 0o600 })
  d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: fakeArch(p).arch, harnesses: [cc], caCheckMs: 40 })
  try {
    assert.equal((await req(s.sock, 'GET', '/status')).ca.ok, true)
    const before = flowsOf(s).filter((f) => f.code === 'ca-invalid').length
    fs.writeFileSync(path.join(caDir, 'asight-ca.pem'), 'garbage')
    await until(() => flowsOf(s).filter((f) => f.code === 'ca-invalid').length > before)
    assert.equal((await req(s.sock, 'GET', '/status')).ca.which, 'cert', 'the daily check found it')
  } finally { await d.stop(); p.done(); s.done() }
})

// D1-2 (4.6 §身份与信任「CA」): a CA unusable at start that a later check finds usable is rebuilt and said (ca-ok):
// the condition clears, `on` attaches, and the engine signs with it — not with the start-time stub, which would make
// every decrypted connection step aside as leaf-error while status says the CA is fine.
test('daemon: a CA that becomes usable again is rebuilt — ca-ok clears the condition, on attaches, and a trusted agent is decrypted with it (D1-2)', async () => {
  const s = sandbox(); const p = fakeProc(); const up = await relay()
  const relayCa = path.join(s.home, 'relay-ca.pem'); fs.writeFileSync(relayCa, up.ca.certPem)
  fs.mkdirSync(path.join(s.home, '.claude'))
  fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `https://relay.asight.test:${up.port}`, NODE_EXTRA_CA_CERTS: relayCa } }, null, 2))
  await install(s)
  const caDir = path.join(s.collector, 'ca')
  const goodKey = fs.readFileSync(path.join(caDir, 'ca.key'), 'utf8')
  fs.writeFileSync(path.join(caDir, 'ca.key'), createCa().keyPem) // another CA's key: not a pair
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], env: { ...process.env, HOME: s.home }, upstreamCa: up.ca.certPem, caCheckMs: 40 })
  try {
    assert.equal((await req(s.sock, 'POST', '/on', {})).actual, 'off', 'unusable at start: never hooked')
    fs.writeFileSync(path.join(caDir, 'ca.key'), goodKey, { mode: 0o600 }) // the key is put back
    const ok = await until(() => flowsOf(s).find((f) => f.event === 'ca-ok'))
    assert.equal(ok.file, path.join(caDir, 'asight-ca.pem'))
    const st = await req(s.sock, 'GET', '/status')
    assert.equal(st.ca.ok, true)
    assert.deepEqual(st.health.collector.conditions.filter((c) => c.kind === 'ca-invalid'), [], 'the board no longer says CA unusable')
    assert.deepEqual((await req(s.sock, 'POST', '/on', {})).actual, 'on')

    p.add(4343, { uid: UID, exe: CC_EXE, argv: ['claude', '-p', 'hi'], cwd: s.home, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 4343, pid: 4343, comm: 'claude', filename: CC_EXE, ts_ns: 1 })
    await until(async () => (await req(s.sock, 'GET', '/status')).agents.find((a) => a.pid === 4343 && a.trusted))
    const raw = net.connect(d.port, '127.0.0.1'); await once(raw, 'connect')
    await clients[0].raw({ op: '__inject_port', port: raw.localPort, family: 4, dst: { address: '127.0.0.1', port: up.port, family: 4 }, pid: 4343, decrypt: 1 })
    const extraCc = fs.readFileSync(path.join(caDir, 'extra-cc.pem'), 'utf8') // relay CA + asight CA
    const c = tls.connect({ socket: raw, servername: 'relay.asight.test', ca: extraCc }); await once(c, 'secureConnect')
    const asightCa = new crypto.X509Certificate(fs.readFileSync(path.join(caDir, 'asight-ca.pem')))
    assert.ok(new crypto.X509Certificate(c.getPeerCertificate().raw).checkIssued(asightCa), 'the leaf is signed by the asight CA: decrypted, not stepped aside')
    // a call goes through (a client that hung up right after the handshake would be, by the engine's rule, one that
    // refused the leaf: not_captured client-rejected-leaf — the merged rows now say so, they used to carry reason only)
    c.write('POST /v1/messages HTTP/1.1\r\nHost: relay.asight.test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}'); await once(c, 'data')
    c.end(); await once(c, 'close')
    const row = await until(() => flowsOf(s).find((f) => f.pid === 4343 && f.event == null && f.flow_id))
    assert.deepEqual([row.decision, row.not_captured ?? null], ['decrypt', null])
    assert.ok(!flowsOf(s).some((f) => f.code === 'leaf-error'), 'no leaf-error')
  } finally { await d.stop(); up.close(); p.done(); s.done() }
})

test('daemon: every check (5 s), with nobody running status — links lost behind its back are one state-mismatch, their return a switch event; an on in flight is never a mismatch (D-26, F3(f))', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const { arch: base, clients } = fakeArch(p)
  const arch = { ...base, createRedirector: (o) => { const r = base.createRedirector(o); const attach = r.attach; r.attach = async () => { await new Promise((ok) => setTimeout(ok, 200)); return attach() }; return r } } // a slow kernel
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], checkMs: 20 })
  try {
    await req(s.sock, 'POST', '/on', {})
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(flowsOf(s).filter((f) => f.code === 'state-mismatch'), [], 'desired on while the attach is still running is not a disagreement')
    await clients[0].raw({ op: '__yank' })
    const mm = await until(() => flowsOf(s).find((f) => f.code === 'state-mismatch'))
    assert.deepEqual([mm.event, mm.where, mm.desired, mm.actual, mm.links], ['failure', 'switch', 'on', 'off', []])
    assert.match(mm.reason, /capture is on but the kernel has not got this instance's links: nothing is steered.*; run "asight on" again$/)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(flowsOf(s).filter((f) => f.code === 'state-mismatch').length, 1, 'once per disagreement, not once per check')
    const switches = () => flowsOf(s).filter((f) => f.event === 'switch')
    const n = switches().length
    await clients[0].raw({ op: 'attach' }) // the kernel has the links again
    const back = await until(() => switches().length > n && switches().at(-1))
    assert.deepEqual([back.desired, back.actual], ['on', 'on'])
    assert.match(back.reason, /matches the desired state again/)
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: kernel drop counters become kernel-drops with the increments by reason — folded, never counted twice, the rest written at stop; status shows the counters (D-26, D-16, F3(f))', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], checkMs: 20, foldMs: 400 })
  let stopped = false
  try {
    await req(s.sock, 'POST', '/on', {})
    const drops = () => flowsOf(s).filter((f) => f.code === 'kernel-drops')
    await new Promise((r) => setTimeout(r, 60))
    assert.deepEqual(drops(), [], 'all counters zero: nothing')
    await clients[0].raw({ op: '__drops', counts: { 'no-listener': 3 } })
    const k1 = await until(() => drops()[0])
    assert.deepEqual([k1.event, k1.where, k1.counts], ['failure', 'kernel', { 'no-listener': 3 }])
    assert.match(k1.reason, /let 3 connection\(s\) or event\(s\) go uncaptured .*no-listener 3.*went direct/)
    await clients[0].raw({ op: '__drops', counts: { 'no-listener': 2, 'hb-stale': 1 } })
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(drops().length, 1, 'inside the fold window: one line')
    const k2 = await until(() => drops()[1])
    assert.deepEqual(k2.counts, { 'no-listener': 2, 'hb-stale': 1 }, 'the increments since the last line')
    assert.deepEqual((await req(s.sock, 'GET', '/status')).drops, { 'no-config': 0, 'hb-stale': 1, 'no-listener': 5, 'orig-write': 0, 'byport-write': 0, 'ringbuf-full': 0 })
    await clients[0].raw({ op: '__drops', counts: { 'orig-write': 1 } })
    await d.stop(); stopped = true
    assert.deepEqual(drops().map((k) => k.counts), [{ 'no-listener': 3 }, { 'no-listener': 2, 'hb-stale': 1 }, { 'orig-write': 1 }], 'the last increment is written at stop, not lost')
  } finally { if (!stopped) await d.stop(); p.done(); s.done() }
})

test('daemon: a trusted agent whose trust file changed is judged again by the check — the same CA keeps it trusted; the file gone makes it agent-untrusted with cause entry-changed, observed only; trust never comes back by a recheck (D-26)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], checkMs: 20 })
  try {
    await req(s.sock, 'POST', '/on', {})
    p.add(9191, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.home, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 9191, pid: 9191, comm: 'claude', filename: CC_EXE, ts_ns: 1 })
    await until(async () => (await req(s.sock, 'GET', '/status')).agents.find((a) => a.pid === 9191 && a.trusted))
    const file = path.join(s.collector, 'ca', 'asight-ca.pem')
    const untrusted = () => flowsOf(s).filter((f) => f.event === 'agent-untrusted' && f.pid === 9191)
    fs.writeFileSync(path.join(s.collector, 'ca', 'x.tmp'), fs.readFileSync(file)); fs.renameSync(path.join(s.collector, 'ca', 'x.tmp'), file) // rewritten, same CA
    await new Promise((r) => setTimeout(r, 120))
    assert.deepEqual(untrusted(), [], 'judged again, still trusted: nothing to record')
    assert.equal((await clients[0].raw({ op: '__watched' })).watch['9191'], 1)
    fs.renameSync(file, path.join(s.collector, 'ca', 'asight-ca.pem.bak'))
    const u = await until(() => untrusted()[0])
    assert.deepEqual([u.cause, u.code, u.agent], ['entry-changed', 'file-unreadable', 'claude-code'])
    assert.equal((await clients[0].raw({ op: '__watched' })).watch['9191'], 0, 'the kernel only observes it from now on')
    const good = fs.readFileSync(path.join(s.collector, 'ca', 'asight-ca.pem.bak'))
    fs.writeFileSync(file, good) // back again: a process that found it missing does not trust it now, so trust never comes back by a recheck
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(untrusted().length, 1)
    assert.ok(!flowsOf(s).some((f) => f.event === 'agent-trusted' && f.pid === 9191 && f.ts > u.ts), 'never trusted again by a recheck')
    assert.equal((await clients[0].raw({ op: '__watched' })).watch['9191'], 0)
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: a Claude Code whose settings.json does not parse is a settings-unparsable failure with pid and file, and agent-untrusted names it, with the hint (D-9)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const settings = path.join(s.home, '.claude', 'settings.json')
  fs.writeFileSync(settings, fs.readFileSync(settings, 'utf8').replace(/\}\s*$/, ',, }')) // the user broke it after install
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc] })
  try {
    await req(s.sock, 'POST', '/on', {})
    p.add(9292, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.home, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 9292, pid: 9292, comm: 'claude', filename: CC_EXE, ts_ns: 1 })
    const u = await until(() => flowsOf(s).find((f) => f.event === 'agent-untrusted' && f.pid === 9292))
    assert.deepEqual([u.code, u.via], ['settings-unparsable', `user settings env (${settings})`])
    assert.match(u.reason, /does not parse/, 'the reason is the harness\'s hint: what to do about it')
    const f = flowsOf(s).find((x) => x.code === 'settings-unparsable')
    assert.deepEqual([f.event, f.where, f.pid, f.file], ['failure', 'harness', 9292, settings])
    assert.match(f.reason, /does not parse \(.+\); that layer is not counted, so it is judged untrusted/)
  } finally { await d.stop(); p.done(); s.done() }
})


// ── per-harness switching and the state.json re-read before every heartbeat (1.6 §1.5 / V30 unit half, 4.6 §开关语义) ───────────────
const opsOf = async (c) => (await c.raw({ op: '__oplog' })).log
const installWithClaudeHome = (s) => { fs.mkdirSync(path.join(s.home, '.claude')); fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), '{}'); return install(s) } // a Claude Code home to put the trust key in
// a machine with Claude Code and Codex homes, both installed: the install manifest names both, so `on` with no names turns both on
const installBoth = (s) => {
  fs.mkdirSync(path.join(s.home, '.claude')); fs.writeFileSync(path.join(s.home, '.claude', 'settings.json'), '{}')
  fs.mkdirSync(path.join(s.home, '.codex')); fs.writeFileSync(path.join(s.home, '.codex', 'config.toml'), 'model = "gpt-test-1"\n')
  return installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [cc, codex], freePort: async () => 0 })
}
const afterMark = async (c, name) => { const log = await opsOf(c); return log.slice(log.lastIndexOf(`mark ${name}`) + 1) }
const rewriteState = (s, fn) => { const f = path.join(s.collector, 'state.json'); const st = JSON.parse(fs.readFileSync(f, 'utf8')); fn(st); fs.writeFileSync(f, JSON.stringify(st)) } // the operator's CLI, in place
const untrustedLines = (s) => flowsOf(s).filter((f) => f.event === 'agent-untrusted')
const watched = async (c) => (await c.raw({ op: '__watched' })).watch // the kernel's own table: tgid → decrypt

test('V30 unit half: a 3 s event-loop stall while state.json turns a harness off — after it the table is reconciled before the next heartbeat, nothing is attached by the file, and no agent-untrusted is written for the harness that is off', { timeout: 60000 }, async () => {
  const s = sandbox(); const p = fakeProc()
  await installBoth(s)
  const { arch, clients } = fakeArch(p, {}, { autoHeartbeatMs: 100 })
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc, codex], env: { ...process.env, HOME: s.home }, checkMs: 150 })
  try {
    const on = await req(s.sock, 'POST', '/on', {})
    assert.deepEqual([on.desired, on.actual, Object.values(on.harnesses).map((h) => h.desired)], ['on', 'on', ['on', 'on']], 'no names: every installed harness')
    const exec = async (pid, exe, argv, env) => { p.add(pid, { uid: UID, exe, argv, cwd: s.root, env, startTicks: nowTicks(p) }); await clients[0].raw({ op: '__emit', ev: 'exec', tgid: pid, pid, comm: argv[0], filename: exe, ts_ns: pid }) }
    await exec(4242, CC_EXE, ['claude', '-p', 'hi'], { HOME: s.home }) // trusted through the key `install` wrote
    await exec(4343, CC_EXE, ['claude'], { HOME: s.root }) // no key in its HOME: untrusted, and said so while the harness is on
    await exec(4545, CODEX_EXE, ['codex', 'exec', 'hi'], { HOME: s.root })
    const rows = await until(async () => { const a = (await req(s.sock, 'GET', '/status')).agents; return a.length === 3 && a })
    assert.deepEqual(rows.map((a) => [a.pid, a.trusted]), [[4242, true], [4343, false], [4545, false]])
    assert.deepEqual(untrustedLines(s).map((l) => [l.pid, l.agent]), [[4343, 'claude-code'], [4545, 'codex']])

    // the operator's CLI writes claude-code off; the daemon's event loop is stalled over the next 3 s
    await clients[0].raw({ op: '__mark', name: 'stall' })
    rewriteState(s, (st) => { st.harnesses['claude-code'].desired = 'off' })
    const end = Date.now() + 3000; while (Date.now() < end) { /* the stall: no timer, no socket runs */ }
    const after = await until(async () => { const a = await afterMark(clients[0], 'stall'); return a.includes('heartbeat') && a })
    assert.deepEqual(after.slice(0, 2), ['unwatch 4242', 'unwatch 4343'], 'the table is reconciled first, before any heartbeat')
    assert.ok(after.indexOf('heartbeat') > 1 && !after.includes('detach'), 'codex is still on: the links stay, the beat resumes after the unwatches')
    assert.deepEqual(await watched(clients[0]), { 4545: 0 }, 'the kernel watches codex only')
    const st = await req(s.sock, 'GET', '/status')
    assert.deepEqual([st.desired, st.actual, st.harnesses['claude-code'].desired, st.harnesses.codex.desired, st.running_untrusted], ['on', 'on', 'off', 'on', 1])
    assert.deepEqual(st.agents.map((a) => [a.pid, !!a.off]), [[4242, true], [4343, true], [4545, false]])
    assert.equal(st.agents[0].reason, 'off')

    // a process of the harness that is off is neither judged nor reported; what was recorded about the others ends
    const before = untrustedLines(s).length
    await exec(4444, CC_EXE, ['claude'], { HOME: s.root })
    await until(async () => (await req(s.sock, 'GET', '/status')).agents.some((a) => a.pid === 4444 && a.off))
    assert.equal(untrustedLines(s).length, before, 'no agent-untrusted for a harness that is off')
    assert.deepEqual(await watched(clients[0]), { 4545: 0 })
    const ended = flowsOf(s).filter((f) => f.event === 'agent-exit')
    assert.deepEqual(ended.map((f) => [f.pid, f.via, f.code]), [[4343, 'off', 'var-missing']], 'the untrusted condition of 4343 ends: it is off, not exited')

    // codex goes off in the file too: nothing is left on, the table first, then the links
    await clients[0].raw({ op: '__mark', name: 'last' })
    rewriteState(s, (x) => { x.harnesses.codex.desired = 'off' })
    const last = await until(async () => { const a = await afterMark(clients[0], 'last'); return a.includes('detach') && a })
    assert.deepEqual(last, ['unwatch 4545', 'detach'], 'unwatch, then detach, and not one more heartbeat')
    const off = await req(s.sock, 'GET', '/status')
    assert.deepEqual([off.desired, off.actual, off.links, off.recording], ['off', 'off', [], false])
    assert.deepEqual(await watched(clients[0]), {})

    // the file never attaches: writing claude-code on again changes nothing until an `on` request
    await clients[0].raw({ op: '__mark', name: 'again' })
    rewriteState(s, (x) => { x.harnesses['claude-code'].desired = 'on' })
    await new Promise((r) => setTimeout(r, 600)) // several 5 s checks' worth at checkMs 150, and no heartbeat timer to carry a reload either
    assert.deepEqual([await afterMark(clients[0], 'again'), (await req(s.sock, 'GET', '/status')).harnesses['claude-code'].desired], [[], 'off'])
    const back = await req(s.sock, 'POST', '/on', { harnesses: ['claude-code'] })
    assert.deepEqual([back.desired, back.actual, back.harnesses['claude-code'].desired, back.harnesses.codex.desired], ['on', 'on', 'on', 'off'])
    assert.deepEqual(back.agents.map((a) => [a.pid, !!a.off]), [[4242, false], [4343, false], [4444, false], [4545, true]], 'the rescan behind on judges the harness again')
    assert.deepEqual(Object.keys(await watched(clients[0])).sort(), ['4242', '4343', '4444'])
    assert.equal(flowsOf(s).filter((f) => f.event === 'failure' && f.where === 'switch').length, 0, 'no state-mismatch on the way')
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: /off {harnesses} unwatches exactly those processes and says which, the links stay while any harness is on and come off with the last, /on {harnesses} turns only those on', async () => {
  const s = sandbox(); const p = fakeProc()
  await installBoth(s)
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc, codex], env: { ...process.env, HOME: s.home } })
  try {
    await req(s.sock, 'POST', '/on', {})
    for (const [pid, exe, argv] of [[4242, CC_EXE, ['claude']], [4545, CODEX_EXE, ['codex']]]) { p.add(pid, { uid: UID, exe, argv, cwd: s.root, env: { HOME: s.home }, startTicks: nowTicks(p) }); await clients[0].raw({ op: '__emit', ev: 'exec', tgid: pid, pid, comm: argv[0], filename: exe, ts_ns: pid }) }
    await until(async () => (await req(s.sock, 'GET', '/status')).agents.length === 2)
    const part = await req(s.sock, 'POST', '/off', { harnesses: ['codex'] })
    assert.deepEqual([part.desired, part.actual, part.unwatched, part.confirmed, part.noop], ['on', 'on', [4545], true, undefined])
    assert.deepEqual([part.harnesses.codex.desired, part.harnesses['claude-code'].desired, part.agents.map((a) => !!a.off)], ['off', 'on', [false, true]])
    assert.deepEqual(Object.keys(await watched(clients[0])), ['4242'])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.collector, 'state.json'), 'utf8')).harnesses.codex.desired, 'off', 'written first: the file is what a restart would restore')
    const again = await req(s.sock, 'POST', '/off', { harnesses: ['codex'] })
    assert.deepEqual([again.noop, again.unwatched, again.confirmed], [true, [], true])
    const all = await req(s.sock, 'POST', '/off', {})
    assert.deepEqual([all.desired, all.actual, all.links, all.unwatched, all.confirmed], ['off', 'off', [], [4242], true])
    assert.deepEqual(await watched(clients[0]), {})
    assert.deepEqual((await opsOf(clients[0])).filter((o) => /^(unwatch|detach)/.test(o)), ['unwatch 4545', 'unwatch 4242', 'detach'], 'the watch table first, the links last')
    const one = await req(s.sock, 'POST', '/on', { harnesses: ['codex'] })
    assert.deepEqual([one.desired, one.actual, one.harnesses.codex.desired, one.harnesses['claude-code'].desired, one.agents.map((a) => [a.pid, !!a.off])], ['on', 'on', 'on', 'off', [[4242, true], [4545, false]]])
    assert.deepEqual(Object.keys(await watched(clients[0])), ['4545'])
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: a harness that state.json has off at start is never watched or reported untrusted; a version 1 state.json restores on for the installed harnesses only (V28)', async () => {
  const s = sandbox(); const p = fakeProc()
  await installWithClaudeHome(s) // the install manifest names claude-code; codex was never installed
  fs.writeFileSync(path.join(s.collector, 'state.json'), JSON.stringify({ version: 2, updated_at: 'T0', harnesses: { 'claude-code': { desired: 'off', updated_at: 'T0' }, codex: { desired: 'on', updated_at: 'T0' } } }))
  p.add(4242, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.root, env: { HOME: s.root }, startTicks: nowTicks(p) })
  p.add(4545, { uid: UID, exe: CODEX_EXE, argv: ['codex'], cwd: s.root, env: { HOME: s.root }, startTicks: nowTicks(p) })
  let a = fakeArch(p)
  let d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: a.arch, harnesses: [cc, codex], env: { ...process.env, HOME: s.home } })
  try {
    const st = await req(s.sock, 'GET', '/status')
    assert.deepEqual([st.desired, st.actual, st.agents.map((x) => [x.pid, !!x.off])], ['on', 'on', [[4242, true], [4545, false]]], 'restored from the file: codex on, claude-code off — the file may name a harness the manifest does not')
    assert.deepEqual([Object.keys(await watched(a.clients[0])), untrustedLines(s).map((l) => l.agent)], [['4545'], ['codex']])
    await d.stop()
    const seen = untrustedLines(s).length
    fs.writeFileSync(path.join(s.collector, 'state.json'), JSON.stringify({ version: 1, desired: 'on', policy: 'all', extra_hosts: ['relay.example.com'], updated_at: 'T1' })) // what an older daemon left
    a = fakeArch(p)
    d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch: a.arch, harnesses: [cc, codex], env: { ...process.env, HOME: s.home } })
    const v1 = await req(s.sock, 'GET', '/status')
    assert.deepEqual([v1.desired, v1.actual, v1.agents.map((x) => [x.pid, !!x.off])], ['on', 'on', [[4242, false], [4545, true]]], 'only the installed harness is carried to on: codex was never installed, so it is not a capture target')
    assert.deepEqual(Object.entries(v1.harnesses).map(([id, h]) => [id, h.desired, h.policy, h.extra_hosts, h.updated_at]), [['claude-code', 'on', 'all', ['relay.example.com'], 'T1']])
    assert.deepEqual(untrustedLines(s).slice(seen).map((l) => l.agent), ['claude-code'], 'no agent-untrusted for the harness that was never installed')
    assert.deepEqual(Object.keys(await watched(a.clients[0])), ['4242'])
    assert.equal(d.tracker.policy({ pid: 4242 }, 'anything.example').not_captured, 'untrusted', 'policy all is in force, and still never for an untrusted process')
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: an unwatch the helper cannot do is a tracker failure and /off says confirmed:false; with no heartbeat running the 5 s check is what reads state.json and takes a harness away', async () => {
  const s = sandbox(); const p = fakeProc()
  await installBoth(s)
  const { arch, clients } = fakeArch(p) // autoHeartbeatMs 0: no beat gate runs at all
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc, codex], env: { ...process.env, HOME: s.home }, checkMs: 100 })
  try {
    await req(s.sock, 'POST', '/on', {})
    for (const [pid, exe, argv] of [[4242, CC_EXE, ['claude']], [4545, CODEX_EXE, ['codex']]]) { p.add(pid, { uid: UID, exe, argv, cwd: s.root, env: { HOME: s.root }, startTicks: nowTicks(p) }); await clients[0].raw({ op: '__emit', ev: 'exec', tgid: pid, pid, comm: argv[0], filename: exe, ts_ns: pid }) }
    await until(async () => (await req(s.sock, 'GET', '/status')).agents.length === 2)
    const real = d.redirector.unwatch
    d.redirector.unwatch = async (pid) => { if (pid === 4545) throw Object.assign(new Error('helper said no'), { code: 'loader-down' }); return real(pid) }
    const bad = await req(s.sock, 'POST', '/off', { harnesses: ['codex'] })
    assert.deepEqual([bad.desired, bad.unwatched, bad.confirmed, bad.agents.find((a) => a.pid === 4545).off], ['on', [], false, true], 'the pid the kernel may still steer is not reported as taken away')
    assert.ok(flowsOf(s).some((f) => f.event === 'failure' && f.where === 'tracker' && /pid 4545 \(unwatch\): helper said no/.test(f.reason)), 'and it is a record, not a swallowed error')
    assert.deepEqual(Object.keys(await watched(clients[0])).sort(), ['4242', '4545'], 'the kernel still has it')
    d.redirector.unwatch = real
    const retry = await req(s.sock, 'POST', '/off', { harnesses: ['codex'] }) // the repeat is what makes it true: nothing was left to turn off, the table is asked again
    assert.deepEqual([retry.unwatched, retry.confirmed, Object.keys(await watched(clients[0]))], [[4545], true, ['4242']])
    // the CLI writes claude-code off; nothing beats (autoHeartbeatMs 0), so only the check can see it
    rewriteState(s, (st) => { st.harnesses['claude-code'].desired = 'off' })
    // the check reads the file (desired turns off), then takes the table, then the links: `actual` is the last of them, so it is what says the check is done
    const st = await until(async () => { const x = await req(s.sock, 'GET', '/status'); return x.harnesses['claude-code'].desired === 'off' && x.actual === 'off' && x })
    assert.deepEqual([st.desired, st.actual, st.links, st.agents.map((a) => !!a.off), await watched(clients[0])], ['off', 'off', [], [true, true], {}], 'taken away by the check: the table, then the links')
  } finally { await d.stop(); p.done(); s.done() }
})

// ── the table must be clean before the beat resumes; a dead helper has nothing to unwatch; the route checks its names (review of Task 2) ──
// two agents, one per harness, both on and in the kernel's table
async function twoAgents(s, p, clients) {
  await req(s.sock, 'POST', '/on', {})
  for (const [pid, exe, argv] of [[4242, CC_EXE, ['claude']], [4545, CODEX_EXE, ['codex']]]) { p.add(pid, { uid: UID, exe, argv, cwd: s.root, env: { HOME: s.root }, startTicks: nowTicks(p) }); await clients[0].raw({ op: '__emit', ev: 'exec', tgid: pid, pid, comm: argv[0], filename: exe, ts_ns: pid }) }
  await until(async () => (await req(s.sock, 'GET', '/status')).agents.length === 2)
}
const failUnwatchOf = (d, pid) => { const real = d.redirector.unwatch; const box = { asked: 0, restore: () => { d.redirector.unwatch = real } }; d.redirector.unwatch = async (x) => { if (x === pid) { box.asked++; throw Object.assign(new Error('helper said no'), { code: 'loader-down' }) } return real(x) }; return box }

test('daemon: an unwatch that fails when state.json turns a harness off is asked again at every beat tick, and no heartbeat goes out until the kernel table is clean (4.6 §开关语义, V30)', { timeout: 30000 }, async () => {
  const s = sandbox(); const p = fakeProc()
  await installBoth(s)
  const { arch, clients } = fakeArch(p, {}, { autoHeartbeatMs: 100 })
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc, codex], env: { ...process.env, HOME: s.home } }) // checkMs stays 5 s: only the beat gate runs
  try {
    await twoAgents(s, p, clients)
    const bad = failUnwatchOf(d, 4242)
    rewriteState(s, (st) => { st.harnesses['claude-code'].desired = 'off' }) // the operator's CLI: claude-code off; codex still on, so the beat would go on
    await until(() => bad.asked >= 3) // the reload asked once, and the next ticks asked again
    await clients[0].raw({ op: '__mark', name: 'stuck' })
    const asked = bad.asked
    await new Promise((r) => setTimeout(r, 500)) // five beat ticks' worth
    assert.deepEqual(await afterMark(clients[0], 'stuck'), [], 'no heartbeat while the kernel may still steer a pid of the harness that is off (the steering lapses, fail open)')
    assert.ok(bad.asked > asked, 'the unwatch is asked again every tick, not once')
    assert.deepEqual(Object.keys(await watched(clients[0])).sort(), ['4242', '4545'], 'the kernel really still holds it')
    assert.equal((await req(s.sock, 'GET', '/status')).agents.find((a) => a.pid === 4242).off, true, 'status says it is off — and the beat says the table is not clean yet')
    bad.restore()
    const after = await until(async () => { const a = await afterMark(clients[0], 'stuck'); return a.includes('heartbeat') && a })
    assert.equal(after[0], 'unwatch 4242', 'the table is clean first, and only then does the beat resume')
    assert.deepEqual(await watched(clients[0]), { 4545: 0 })
    assert.equal(after.filter((o) => o === 'unwatch 4242').length, 1, 'answered once')
    const st = await req(s.sock, 'GET', '/status')
    assert.deepEqual([st.desired, st.actual, st.harnesses['claude-code'].desired], ['on', 'on', 'off'])
    assert.ok(flowsOf(s).some((f) => f.event === 'failure' && f.where === 'tracker' && /pid 4242 \(unwatch\): helper said no/.test(f.reason)), 'the failure is a record, folded, not swallowed')
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: with no beat gate running, the 5 s check asks again for an unwatch that failed when state.json turned a harness off', { timeout: 30000 }, async () => {
  const s = sandbox(); const p = fakeProc()
  await installBoth(s)
  const { arch, clients } = fakeArch(p) // autoHeartbeatMs 0
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc, codex], env: { ...process.env, HOME: s.home }, checkMs: 100 })
  try {
    await twoAgents(s, p, clients)
    const bad = failUnwatchOf(d, 4242)
    rewriteState(s, (st) => { st.harnesses['claude-code'].desired = 'off' })
    await until(() => bad.asked >= 3) // the check that read the file asked once; the later checks ask again
    assert.deepEqual(Object.keys(await watched(clients[0])).sort(), ['4242', '4545'])
    bad.restore()
    await until(async () => !(4242 in await watched(clients[0])))
    assert.deepEqual(await watched(clients[0]), { 4545: 0 }, 'nobody asked: the check made the table clean')
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: with the helper dead, /off is confirmed — its links and watch table died with it — and nothing is asked of it or recorded as an unwatch failure', async () => {
  const s = sandbox(); const p = fakeProc()
  await installBoth(s)
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc, codex], env: { ...process.env, HOME: s.home } })
  try {
    await twoAgents(s, p, clients)
    clients[0]._child.kill('SIGKILL')
    await until(async () => (await req(s.sock, 'GET', '/status')).degraded)
    const one = await req(s.sock, 'POST', '/off', { harnesses: ['codex'] })
    assert.deepEqual([one.desired, one.actual, !!one.degraded, one.confirmed, one.unwatched, one.agents.map((a) => !!a.off)], ['on', 'off', true, true, [4545], [false, true]], 'confirmed: nothing is steered; the pid is out of a table that no longer exists')
    const all = await req(s.sock, 'POST', '/off', {})
    assert.deepEqual([all.desired, all.actual, all.confirmed, all.unwatched, all.agents.map((a) => !!a.off)], ['off', 'off', true, [4242], [true, true]])
    assert.deepEqual(d.tracker.stuckPids(), [])
    assert.deepEqual(flowsOf(s).filter((f) => f.where === 'tracker' && /unwatch/.test(f.reason || '')), [], 'no unwatch-error: nobody could have answered it')
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.collector, 'state.json'), 'utf8')).harnesses.codex.desired, 'off', 'the desired state is still written')
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: /on and /off take only a non-empty array of harness names the daemon knows; anything else is a 400 naming the problem, changes nothing and is no daemon failure (1.6 §1.5)', async () => {
  const s = sandbox(); const p = fakeProc()
  await installBoth(s)
  const { arch } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc, codex], env: { ...process.env, HOME: s.home } })
  try {
    const file = path.join(s.collector, 'state.json')
    const bad400 = async (route, body, re) => assert.rejects(req(s.sock, 'POST', route, body), (e) => e.status === 400 && re.test(e.message), `${route} ${JSON.stringify(body)}`)
    for (const route of ['/on', '/off']) {
      await bad400(route, { harnesses: 'codex' }, /non-empty array/) // a string would spread into one name per character
      await bad400(route, { harnesses: [] }, /non-empty array/) // not "all"
      await bad400(route, { harnesses: [''] }, /non-empty array/)
      await bad400(route, { harnesses: [1] }, /non-empty array/)
      await bad400(route, { harnesses: { codex: true } }, /non-empty array/)
      await bad400(route, { harnesses: ['codex', 'nope'] }, /unknown harness: nope/) // the typo is named; codex is not turned on by a request that is refused
    }
    assert.equal(fs.existsSync(file), false, 'not one of them wrote the state file')
    assert.deepEqual(flowsOf(s).filter((f) => f.where === 'control'), [], 'a caller\'s mistake is not a failure of the daemon')
    const all = await req(s.sock, 'POST', '/on', { harnesses: null }) // null is "every installed harness", like leaving it out
    assert.deepEqual(Object.entries(all.harnesses).map(([id, h]) => [id, h.desired]), [['claude-code', 'on'], ['codex', 'on']])
    const named = await req(s.sock, 'POST', '/off', { harnesses: ['claude-code'] })
    assert.deepEqual(Object.entries(named.harnesses).map(([id, h]) => [id, h.desired]), [['claude-code', 'off'], ['codex', 'on']])
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).harnesses).sort(), ['claude-code', 'codex'], 'only harnesses that exist are ever written')
  } finally { await d.stop(); p.done(); s.done() }
})

// 1.6 §1.3 / §1.4 5 (V36 daemon half): `off` with no names and `exit` — the daemon stops itself once no connection is left in the engine, or at
// once with `now`; a spliced connection (the engine sees no response boundary) keeps it alive until it closes by itself.
async function withSplice(fn) {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], env: { ...process.env, HOME: s.home } })
  const echo = net.createServer((x) => x.pipe(x)); await new Promise((r) => echo.listen(0, '127.0.0.1', r))
  try {
    await req(s.sock, 'POST', '/on', {})
    p.add(4242, { uid: UID, exe: CC_EXE, argv: ['claude', '-p', 'hi'], cwd: s.home, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 4242, pid: 4242, comm: 'claude', filename: CC_EXE, ts_ns: 1 })
    await until(async () => (await req(s.sock, 'GET', '/status')).agents.find((a) => a.pid === 4242))
    const raw = net.connect(d.port, '127.0.0.1'); await once(raw, 'connect')
    await clients[0].raw({ op: '__inject_port', port: raw.localPort, family: 4, dst: { address: '127.0.0.1', port: echo.address().port, family: 4 }, pid: 4242, decrypt: 0 })
    raw.write('ZZZZ not a protocol the engine knows\n') // classified unknown: passed through, never framed
    await once(raw, 'data')
    await fn({ s, d, raw, flows: () => flowsOf(s) })
  } finally { echo.close(); await d.stop(); p.done(); s.done() }
}

test('daemon: POST /off {exit:true} with a spliced connection open: the reply says 1 waiting and the daemon\'s pid, it stays up, status counts the connection, and it stops (daemon-stop, reason off) once the connection closes by itself (V36 daemon half, 1.6 §1.4 5)', async () => {
  await withSplice(async ({ s, d, raw, flows }) => {
    const off = await req(s.sock, 'POST', '/off', { exit: true })
    assert.deepEqual([off.relayed, off.pid, off.desired], [{ closing: 0, waiting: 1, cut: 0 }, process.pid, 'off'])
    await new Promise((r) => setTimeout(r, 400))
    const st = await req(s.sock, 'GET', '/status')
    assert.deepEqual(st.relayed, { closing: 0, waiting: 1 }, 'still running, and status counts what is still relayed')
    assert.equal(fs.existsSync(path.join(s.collector, 'lock')), true)
    let stopped = false; d.exited.then(() => { stopped = true })
    raw.destroy() // the connection closes by itself
    await until(() => stopped)
    const stop = flows().find((f) => f.event === 'daemon-stop')
    assert.deepEqual([stop.reason, stop.signal, stop.failed], ['off', undefined, undefined])
    assert.equal(fs.existsSync(path.join(s.collector, 'lock')), false)
    const spliced = flows().find((f) => f.decision === 'splice')
    assert.deepEqual([spliced.error, spliced.agent], [undefined, 'claude-code'])
  })
})

test('daemon: /on after POST /off {exit:true} while a splice is still open cancels the pending exit — the daemon stays up and attached when the splice closes, and a later /off {exit:true} stops it (1.6 §1.4 5, T05 review)', async () => {
  await withSplice(async ({ s, d, raw, flows }) => {
    const off = await req(s.sock, 'POST', '/off', { exit: true })
    assert.deepEqual(off.relayed, { closing: 0, waiting: 1, cut: 0 })
    const on = await req(s.sock, 'POST', '/on', {})
    assert.deepEqual([on.desired, on.actual], ['on', 'on'])
    let stopped = false; d.exited.then(() => { stopped = true })
    raw.destroy() // the splice closes by itself: nothing is left in the engine, but the operator turned capture on again
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(stopped, false, 'the daemon did not exit although capture is on')
    const st = await req(s.sock, 'GET', '/status')
    assert.deepEqual([st.desired, st.actual], ['on', 'on'], 'still attached')
    assert.equal(fs.existsSync(path.join(s.collector, 'lock')), true)
    assert.equal(flows().some((f) => f.event === 'daemon-stop'), false)
    // the exit is re-armed by a later /off {exit:true}, not left cancelled for good
    const off2 = await req(s.sock, 'POST', '/off', { exit: true })
    assert.deepEqual(off2.relayed, { closing: 0, waiting: 0, cut: 0 })
    await d.exited
    assert.equal(flows().find((f) => f.event === 'daemon-stop').reason, 'off')
  })
})

test('daemon: a withdrawn exit is not revived — /off {exit:true}, /on, then a plain /off (no exit) while the splice is still open: when the splice closes the daemon stays up, off (1.6 §1.4 5, T05 review)', async () => {
  await withSplice(async ({ s, d, raw }) => {
    await req(s.sock, 'POST', '/off', { exit: true })
    await req(s.sock, 'POST', '/on', {})
    const off = await req(s.sock, 'POST', '/off', { harnesses: ['claude-code'] }) // asks nothing of the daemon's life
    assert.equal(off.desired, 'off')
    let stopped = false; d.exited.then(() => { stopped = true })
    raw.destroy()
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(stopped, false, 'the exit that /on withdrew did not come back')
    assert.equal((await req(s.sock, 'GET', '/status')).desired, 'off')
  })
})

test('daemon: POST /off {exit:true, now:true} cuts the spliced connection and stops the daemon within 1 s; the row says cut-by-off (V36 daemon half, 1.6 §1.3)', async () => {
  await withSplice(async ({ s, d, raw, flows }) => {
    const t0 = Date.now()
    const off = await req(s.sock, 'POST', '/off', { exit: true, now: true })
    assert.deepEqual(off.relayed, { closing: 0, waiting: 0, cut: 1 })
    await d.exited
    assert.ok(Date.now() - t0 < 1000, `stopped in ${Date.now() - t0} ms`)
    if (!raw.destroyed) await once(raw, 'close') // cut
    const row = flows().find((f) => f.decision === 'splice')
    assert.deepEqual([row.error.type, row.error.side], ['cut-by-off', 'engine'])
    assert.equal(flows().find((f) => f.event === 'daemon-stop').reason, 'off')
  })
})

test('daemon: /off takes boolean now and exit only, and exit takes no harness names; a refusal is a 400 that changes nothing (1.6 §1.4)', async () => {
  await withSplice(async ({ s, d }) => {
    for (const body of [{ now: 'yes' }, { exit: 1 }, { exit: true, harnesses: ['claude-code'] }]) {
      await assert.rejects(req(s.sock, 'POST', '/off', body), (e) => e.status === 400, JSON.stringify(body))
    }
    assert.equal((await req(s.sock, 'GET', '/status')).desired, 'on', 'nothing was turned off')
    const named = await req(s.sock, 'POST', '/off', { harnesses: ['claude-code'], now: true })
    assert.deepEqual(named.relayed, { closing: 0, waiting: 0, cut: 1 }, 'a named off with now cuts that harness\'s connections and leaves the daemon running')
    assert.equal(await Promise.race([d.exited.then(() => 'stopped'), new Promise((r) => setTimeout(() => r('running'), 300))]), 'running')
  })
})

test('daemon: POST /off {exit:true} with nothing relayed stops the daemon on its own, once, and a later stop() is a no-op that returns the same result', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const { arch } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], env: { ...process.env, HOME: s.home } })
  try {
    await req(s.sock, 'POST', '/on', {})
    const off = await req(s.sock, 'POST', '/off', { exit: true })
    assert.deepEqual(off.relayed, { closing: 0, waiting: 0, cut: 0 })
    const r = await d.exited
    assert.deepEqual(r, { failed: [] })
    assert.deepEqual(await d.stop({ signal: 'SIGTERM' }), r)
    assert.equal(flowsOf(s).filter((f) => f.event === 'daemon-stop').length, 1, 'one daemon-stop line, for the reason that stopped it first')
  } finally { await d.stop(); p.done(); s.done() }
})

test('daemon: a harness that state.json turns off (the CLI writes the file; the 5 s check reads it) has its relayed connections drained too, not only one the /off route turned off (1.6 §1.3, §1.5)', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], env: { ...process.env, HOME: s.home }, checkMs: 100 })
  const echo = net.createServer((x) => x.pipe(x)); await new Promise((r) => echo.listen(0, '127.0.0.1', r))
  try {
    await req(s.sock, 'POST', '/on', {})
    p.add(4242, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: s.home, env: { HOME: s.home }, startTicks: nowTicks(p) })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 4242, pid: 4242, comm: 'claude', filename: CC_EXE, ts_ns: 1 })
    await until(async () => (await req(s.sock, 'GET', '/status')).agents.find((a) => a.pid === 4242))
    const raw = net.connect(d.port, '127.0.0.1'); await once(raw, 'connect')
    await clients[0].raw({ op: '__inject_port', port: raw.localPort, family: 4, dst: { address: '127.0.0.1', port: echo.address().port, family: 4 }, pid: 4242, decrypt: 0 })
    raw.write('ZZZZ not a protocol the engine knows\n'); await once(raw, 'data')
    assert.deepEqual((await req(s.sock, 'GET', '/status')).relayed, { closing: 0, waiting: 0 }, 'while it is on nothing is asked to close')
    rewriteState(s, (st) => { st.harnesses['claude-code'].desired = 'off' })
    const st = await until(async () => { const x = await req(s.sock, 'GET', '/status'); return x.relayed.waiting === 1 && x })
    assert.equal(st.harnesses['claude-code'].desired, 'off')
    raw.destroy()
  } finally { echo.close(); await d.stop(); p.done(); s.done() }
})

// §9.5 / V47: the 5 s check stats the files a harness reads its proxy from and compares what it finds with what `on` recorded (`adopted`): one `netenv-change` per change, however many checks, nothing written to the agent's file.
test('daemon: the 5 s check records a change of the proxy setting once — netenv-change, no failure while the harness is still captured — and never writes the agent\'s file', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const file = path.join(s.home, '.claude', 'settings.json')
  const setProxy = (v) => { const d = JSON.parse(fs.readFileSync(file, 'utf8')); d.env.HTTPS_PROXY = v; fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`) }
  setProxy('http://proxy.old:3128')
  const rec = { at: 'T', routing: 'driver', chain: 'c', source: [], sha256: settingSha('http://proxy.old:3128'), file_sha256: settingSha('http://proxy.old:3128'), proxy: 'http://proxy.old:3128', vpn: null }
  writeNetenv(s.home, { at: 'T', products: [], unknown: [{ reason: 'a test' }], adopted: { 'claude-code': rec } })
  const { arch } = fakeArch(p)
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], env: { ...process.env, HOME: s.home }, checkMs: 20 })
  try {
    await req(s.sock, 'POST', '/on', {})
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(flowsOf(s).filter((f) => f.event === 'netenv-change').length, 0, 'what `on` found is what is there: nothing to say')
    setProxy('http://proxy.new:3128')
    const bytes = fs.readFileSync(file)
    await until(() => flowsOf(s).some((f) => f.event === 'netenv-change'))
    await new Promise((r) => setTimeout(r, 200)) // more checks than one
    const lines = flowsOf(s).filter((f) => f.where === 'netenv' || f.event === 'netenv-change')
    assert.deepEqual(lines.map((f) => [f.event, f.where, f.code, f.harness, f.from, f.to, f.captured]), [['netenv-change', 'netenv', 'proxy-changed', 'claude-code', 'http://proxy.old:3128', 'http://proxy.new:3128', true]], 'one line, no failure: the eBPF route still steers it')
    assert.deepEqual(fs.readFileSync(file), bytes, 'the daemon only reads the agent\'s file')
  } finally { await d.stop(); p.done(); s.done() }
})

// §9.5: the semantics of a drift belong to the record `on` made, not to a property of the platform module (the Linux one has none, a proxy-mode one need not declare one): a record of a routing that owns the
// proxy field is measured against what asight wrote there, so the entry asight put in the field is not a change — and the user's own edit of it is, with the harness left uncaptured.
test('daemon: the 5 s check takes a proxy-mode record\'s own semantics — the field holding what asight wrote says nothing, the user\'s edit of it is one netenv-change (captured false) and one failure — with an arch that declares no routing', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  const file = path.join(s.home, '.claude', 'settings.json')
  const setProxy = (v) => { const d = JSON.parse(fs.readFileSync(file, 'utf8')); d.env.HTTPS_PROXY = v; fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`) }
  const KERNEL = 'http://127.0.0.1:17991'
  setProxy(KERNEL) // `on` in proxy mode pointed the agent's proxy at asight's own kernel
  const rec = { at: 'T', routing: 'proxy', chain: 'c', source: [], sha256: settingSha('http://proxy.old:3128'), file_sha256: settingSha('http://proxy.old:3128'), proxy: 'http://proxy.old:3128', vpn: null, written_sha256: settingSha(KERNEL) }
  writeNetenv(s.home, { at: 'T', products: [], unknown: [{ reason: 'a test' }], adopted: { 'claude-code': rec } })
  const { arch } = fakeArch(p)
  assert.equal(arch.routing, undefined, 'the arch module declares nothing: the record says what kind it is')
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], env: { ...process.env, HOME: s.home }, checkMs: 20 })
  try {
    await req(s.sock, 'POST', '/on', {})
    await new Promise((r) => setTimeout(r, 200))
    assert.deepEqual(flowsOf(s).filter((f) => f.where === 'netenv' || f.event === 'netenv-change'), [], 'what asight wrote is not a change of the user\'s setting')
    setProxy('http://proxy.new:3128')
    const bytes = fs.readFileSync(file)
    await until(() => flowsOf(s).some((f) => f.event === 'failure' && f.where === 'netenv'))
    await new Promise((r) => setTimeout(r, 200))
    const lines = flowsOf(s).filter((f) => f.where === 'netenv' || f.event === 'netenv-change')
    assert.deepEqual(lines.map((f) => [f.event, f.where, f.code, f.harness, f.captured]), [['netenv-change', 'netenv', 'proxy-changed', 'claude-code', false], ['failure', 'netenv', 'proxy-changed', 'claude-code', undefined]])
    assert.deepEqual(fs.readFileSync(file), bytes)
  } finally { await d.stop(); p.done(); s.done() }
})

// 4.8 §2.4「入口还有没有效」+ W68, the daemon's half: the 5 s check runs the same arch hook status folds into its rows. The check itself has
// its own cells over the real Windows world (optin-check.test.mjs); what is pinned here is the WIRING — the manifest read as the disk has it
// on every tick (an entry added after the start is seen: the copy read at start is not the truth), the process table of this collector's own
// scan (a parent row included), the real record (once per occurrence, only §9.7's netenv failure codes — entry-changed is no event), and a
// manifest without opt-in entries paying for none of it (no check, no scan).
test('daemon: the 5 s check re-verifies the opt-in entries (W68) — the fresh manifest and the scan\'s own table into the arch hook\'s check, one netenv failure per finding, entry-changed no event, and no check at all without opt-in entries', async () => {
  const s = sandbox(); const p = fakeProc()
  await install(s)
  p.add(600, { uid: UID, ppid: 599, exe: '/opt/tools/launcher.exe', argv: ['/opt/tools/launcher.exe'] }) // not an agent: the table's rows are the check's to match, not the tracker's
  const { arch: base } = fakeArch(p)
  const asked = []
  let scans = 0
  let answer = []
  const arch = {
    os: base.os,
    createRedirector: (o) => { const r = base.createRedirector(o); const real = r.scan.bind(r); r.scan = async (...a) => { scans++; return real(...a) }; return r },
    optIn: { check: (q) => { asked.push(q); return answer }, record: recordEntryFindings },
  }
  const d = await startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], env: { ...process.env, HOME: s.home }, checkMs: 20 })
  try {
    await req(s.sock, 'POST', '/on', {})
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(asked.length, 0, 'the install manifest holds no opt-in entry: the check does not run')
    const scansBefore = scans
    // what `on --opt-in` leaves behind: the manifest on disk gains the entry while this daemon runs — the copy read at start never knew it
    const m = readManifest(s.collector)
    m.entries.push({ kind: 'optin-user-path', phase: 'on', harness: 'claude-code', form: 'claude-code.cli', item: 'user-path-shim', scope: 'user', confirmed: true, values: { command: 'claude', binDir: 'C:\\b', realBinary: 'C:\\r.exe' } })
    saveManifest(s.collector, m)
    answer = [
      { form: 'claude-code.cli', item: 'user-path-shim', harness: 'claude-code', code: 'shim-not-on-path', detail: 'claude resolves first to C:\\npm\\claude.cmd — the machine PATH\'s C:\\npm' },
      { form: 'claude-code.cli', item: 'user-path-shim', harness: 'claude-code', code: 'entry-changed', detail: 'the real binary the dispatcher falls back to (C:\\r.exe) is gone' },
      { form: 'claude-code.cli', item: 'user-path-shim', harness: 'claude-code', code: 'not-via-entry', detail: '1 running claude-code process(es) were not started through the entry' },
    ]
    await until(() => asked.length > 0)
    assert.equal(asked[0].manifest.entries.filter((e) => e.kind === 'optin-user-path').length, 1, 'the manifest as the disk has it NOW, not the copy read at start')
    assert.deepEqual(asked[0].harnesses, [cc], 'the same harness list the plan is asked of')
    assert.ok(asked[0].procs.some((x) => x.pid === 600 && x.ppid === 599), 'the process table of this collector\'s own scan, a parent row included')
    assert.ok(scans > scansBefore, 'the scan is paid for only now that there is an entry in effect')
    await until(() => flowsOf(s).some((f) => f.event === 'failure' && f.where === 'netenv'))
    await new Promise((r) => setTimeout(r, 200)) // more checks than one
    const netFailures = () => flowsOf(s).filter((f) => f.event === 'failure' && f.where === 'netenv')
    assert.deepEqual(netFailures().map((f) => [f.code, f.harness, f.form, f.item]), [['shim-not-on-path', 'claude-code', 'claude-code.cli', 'user-path-shim'], ['not-via-entry', 'claude-code', 'claude-code.cli', 'user-path-shim']], 'one line per coded finding however many checks ran; entry-changed is no event')
    assert.ok(asked.length > 3, `the check ran on many ticks (${asked.length})`)
    // the same finding moved fires once more; the unchanged one stays at one line (recordEntryFindings' own rule, through the daemon's state)
    answer = [{ ...answer[0], detail: 'claude resolves first to D:\\tools\\claude.cmd — the machine PATH\'s D:\\tools' }]
    await until(() => netFailures().length === 3)
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(netFailures().length, 3, 'a changed finding fires once more, the unchanged ones stay at their one line')
    // the entry undone on disk (what `off` leaves behind): nothing in effect any more, so no check and no scan
    const m2 = readManifest(s.collector)
    m2.entries = m2.entries.filter((e) => e.kind !== 'optin-user-path')
    saveManifest(s.collector, m2)
    const askedAt = asked.length; const scansAt = scans
    await new Promise((r) => setTimeout(r, 200))
    assert.deepEqual([asked.length, scans], [askedAt, scansAt], 'no opt-in entry in effect any more: neither the check nor the scan runs')
  } finally { await d.stop(); p.done(); s.done() }
})
