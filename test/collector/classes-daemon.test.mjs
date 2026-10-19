// test/collector/classes-daemon.test.mjs — D40 through the PRODUCT path: the daemon over the fake helper and a synthetic /proc,
// a trusted agent, a mock upstream behind a lab CA (RFC 4.6 acceptance T17 + K2 / K3 at the daemon):
//   - the default decrypt policy is `all` (an agent's non-model traffic is seen), `auto` stays when the install already wrote it;
//   - a client that does not trust the asight CA costs two failed connections per (pid, host), then passes through byte-exact;
//   - classes.json is read by the daemon's engine, hot, per call; a bad file keeps the builtin table and says so.
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
import { createRedirectorClient } from '../../src/collector/arch/linux/redirector-client.mjs'
import { createLinuxRedirector } from '../../src/collector/arch/linux/redirector.mjs'
import cc from '../../src/collector/harness/claude-code.mjs'
import { fakeProc } from './arch/linux/fixtures/fake-proc.mjs'
import { startMockUpstream } from '../lab/mock-upstream/server.mjs'
import { makeLabCa } from '../lab/mock-upstream/lab-ca.mjs'
import { captureHealth } from '../../src/health/read.mjs'
import { BUILTIN } from '../../src/classes/table.mjs'

const FAKE = fileURLToPath(new URL('./arch/linux/fixtures/fake-loader.mjs', import.meta.url))
const UID = process.getuid()
const CC_EXE = '/home/u/.local/share/claude/versions/2.1.289'
const API = 'api.anthropic.com'
const OTHER = 'telemetry.asight.test' // not a known API host of any harness: only the policy `all` decrypts it (the mock CA's leaf covers *.asight.test)
const req = (sock, method, p, body) => controlRequest({ socketPath: sock, method, path: p, body })
async function until(fn, ms = 4000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) } }
const nowTicks = (p) => Math.ceil((Date.now() / 1000 - p.btime) * 100)
const ndjson = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const flowsOf = (dir) => { const d = path.join(dir, 'flows'); return fs.existsSync(d) ? fs.readdirSync(d).flatMap((n) => ndjson(path.join(d, n))) : [] }
// envelopes live in the raw layer's segments, one directory up from the collector's own (D60)
const capturesOf = (dir) => { const raw = path.join(path.dirname(dir), 'raw'); return fs.existsSync(raw) ? fs.readdirSync(raw).flatMap((n) => ndjson(path.join(raw, n))) : [] }
const b64 = (s) => Buffer.from(s, 'base64')

async function scene({ state = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-rd-')) // short: unix socket paths are length-limited
  const home = path.join(root, 'home'); fs.mkdirSync(home)
  const dir = path.join(home, '.asight', 'collector'), sock = path.join(root, 'run', 'c.sock')
  const p = fakeProc()
  const labCa = makeLabCa(path.join(root, 'lab-ca'))
  const tlsOpts = { key: fs.readFileSync(labCa.key), cert: fs.readFileSync(labCa.cert) }
  const mock = await startMockUpstream({ tls: tlsOpts })
  await installCollector({ home, env: { HOME: home }, osName: 'none', harnesses: [cc], freePort: async () => 0 })
  if (state) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state))
  const clients = []
  const arch = { os: 'linux', createRedirector: () => createLinuxRedirector({ procRoot: p.root, uid: UID, makeClient: () => { const c = createRedirectorClient({ binary: process.execPath, args: [FAKE], env: { ...process.env, ASIGHT_FAKE_LOADER: '1' }, autoHeartbeatMs: 0 }); clients.push(c); return c } }) }
  const d = await startDaemon({ dir, socketPath: sock, arch, harnesses: [cc], env: { ...process.env, HOME: home }, upstreamCa: fs.readFileSync(labCa.caCert, 'utf8') })
  await req(sock, 'POST', '/on', {})
  p.add(4343, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: home, env: { HOME: home }, startTicks: nowTicks(p) })
  await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 4343, pid: 4343, comm: 'claude', filename: CC_EXE, ts_ns: 1 })
  await until(async () => (await req(sock, 'GET', '/status')).agents.find((a) => a.pid === 4343 && a.trusted))
  const asightCa = fs.readFileSync(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).env.NODE_EXTRA_CA_CERTS, 'utf8')
  // one connection of the agent, steered to the engine; `ca` is what the client trusts (the asight CA: the agent's own call; only the lab CA: a child that never heard of it)
  const call = async ({ host = OTHER, path: urlPath = '/api/event_logging/v2/batch', body = '{"events":[1]}', ca = asightCa } = {}) => {
    const raw = net.connect(d.port, '127.0.0.1'); await once(raw, 'connect')
    await clients[0].raw({ op: '__inject_port', port: raw.localPort, family: 4, dst: { address: '127.0.0.1', port: mock.port, family: 4 }, pid: 4343, decrypt: 1 })
    const REQ = `POST ${urlPath} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer sk-ant-oat-SECRET\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    return new Promise((resolve) => {
      const c = tls.connect({ socket: raw, servername: host, ca }, () => c.write(REQ))
      let got = Buffer.alloc(0); c.on('data', (x) => { got = Buffer.concat([got, x]) })
      c.on('end', () => resolve({ ok: true, REQ, got, issuer: c.getPeerX509Certificate().issuer }))
      c.on('error', (e) => resolve({ ok: false, error: e.code || e.message })); c.on('close', () => resolve({ ok: false, error: 'closed' }))
    })
  }
  return { root, home, dir, sock, mock, d, call, labCaPem: fs.readFileSync(labCa.caCert, 'utf8'), asightCa,
    done: async () => { await d.stop(); await mock.close(); p.done(); fs.rmSync(root, { recursive: true, force: true }) } }
}
const lastRequest = (mock) => mock.state.log.filter((e) => e.type === 'request').at(-1)

test('T17 default policy `all`: a trusted agent\'s connection to a host no harness lists is decrypted — request and response bytes are the mock\'s, class `other` — and the install writes policy all', async () => {
  const s = await scene()
  try {
    assert.equal((await req(s.sock, 'GET', '/status')).harnesses['claude-code'].policy, 'all', 'a fresh install runs `all`')
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8')).harnesses['claude-code'].policy, 'all', 'state.json is per harness since D39: the entry says so')
    const r = await s.call()
    assert.equal(r.ok, true); assert.match(r.issuer, /asight collector CA/, 'terminated by the engine')
    const e = lastRequest(s.mock)
    assert.equal(b64(e.req_raw_b64).toString('latin1'), r.REQ, 'the upstream got exactly the bytes the agent sent'); assert.ok(r.got.equals(b64(e.resp_raw_b64)), 'the agent got exactly the bytes the upstream sent')
    const env = await until(() => capturesOf(s.dir).find((x) => x.endpoint === '/api/event_logging/v2/batch'))
    assert.deepEqual([env.req_body, env.host, env.traffic_class, env.is_llm_call, env.proc.agent], ['{"events":[1]}', OTHER, 'other', false, 'claude-code'])
    assert.equal(env.resp.status, e.resp_raw_b64 ? Number(b64(e.resp_raw_b64).toString('latin1').split(' ')[1]) : undefined, 'the response is recorded too')
    assert.ok(!flowsOf(s.dir).some((f) => f.not_captured === 'policy'))
  } finally { await s.done() }
})

test('T17 an install whose state.json already says `auto` keeps it: the same connection is passed through and flows/ says not_captured:policy', async () => {
  const s = await scene({ state: { version: 1, desired: 'off', policy: 'auto', extra_hosts: [] } })
  try {
    assert.equal((await req(s.sock, 'GET', '/status')).harnesses['claude-code'].policy, 'auto', 'a version 1 file that wrote auto reads as auto for the installed harness')
    const r = await s.call({ ca: s.labCaPem })
    assert.equal(r.ok, true); assert.match(r.issuer, /lab|lab-vm|test/i); assert.doesNotMatch(r.issuer, /asight collector CA/, 'the client saw the upstream\'s own certificate')
    assert.equal(b64(lastRequest(s.mock).req_raw_b64).toString('latin1'), r.REQ)
    const row = await until(() => flowsOf(s.dir).find((f) => f.flow_id && f.not_captured === 'policy'))
    assert.equal(row.host, OTHER); assert.equal(capturesOf(s.dir).length, 0, 'nothing recorded')
  } finally { await s.done() }
})

test('T17 a client that does not trust the asight CA (a sandboxed child): two rows client-rejected-leaf, one negative-cache event, then byte-exact passthrough from the third connection on', async () => {
  const s = await scene()
  try {
    for (let i = 0; i < 2; i++) { const r = await s.call({ ca: s.labCaPem }); assert.equal(r.ok, false, `connection ${i + 1} is refused by the client`) }
    await until(() => flowsOf(s.dir).filter((f) => f.not_captured === 'client-rejected-leaf').length >= 2)
    const ev = await until(() => flowsOf(s.dir).find((f) => f.event === 'failure' && f.code === 'negative-cache'))
    assert.deepEqual([ev.host, ev.pid, ev.cause], [OTHER, 4343, 'client-rejected-leaf'])
    const third = await s.call({ ca: s.labCaPem })
    assert.equal(third.ok, true); assert.doesNotMatch(third.issuer, /asight collector CA/, 'the client got the upstream\'s real certificate')
    const e = lastRequest(s.mock)
    assert.equal(b64(e.req_raw_b64).toString('latin1'), third.REQ, 'passed through verbatim'); assert.ok(third.got.equals(b64(e.resp_raw_b64)))
    const row = await until(() => flowsOf(s.dir).find((f) => f.flow_id && f.not_captured === 'negative-cache'))
    assert.equal(row.host, OTHER)
    assert.equal(capturesOf(s.dir).length, 0, 'no envelope for a connection the client refused or that passed through')
    assert.equal(flowsOf(s.dir).filter((f) => f.not_captured === 'client-rejected-leaf').length, 2, 'at most two failed connections per (pid, host)')
  } finally { await s.done() }
})

test('D60③ at the daemon: classes.json is read per call, hot (≤ 1 s); `telemetry` at `log` keeps headers and sizes only; an unparsable file keeps the builtin table, says so (⚠), and says when it is fine again', async () => {
  const s = await scene()
  const file = path.join(s.home, '.asight', 'classes.json')
  const setKeep = (keep) => fs.writeFileSync(file, JSON.stringify({ version: 1, classes: BUILTIN.map((c) => (c.class === 'telemetry' ? { ...c, keep } : c)) }))
  const batch = (n) => ({ host: API, body: JSON.stringify({ events: ['e'.repeat(n)] }) })
  const last = (path_) => capturesOf(s.dir).filter((x) => x.endpoint === path_).at(-1)
  const T = '/api/event_logging/v2/batch'
  const settle = () => new Promise((r) => setTimeout(r, 1150)) // past the daemon's 1 s recheck
  try {
    await s.call({ ...batch(40), path: T })
    assert.deepEqual([last(T).traffic_class, 'body_retention' in last(T), typeof last(T).req_body], ['telemetry', false, 'string'], 'no file: the builtin table, every class full; the cc row classes event_logging as telemetry')
    setKeep('log')
    await settle()
    const b = batch(40); const r = await s.call({ ...b, path: T })
    assert.equal(b64(lastRequest(s.mock).req_raw_b64).toString('latin1'), r.REQ, 'what is forwarded is unchanged')
    await until(() => capturesOf(s.dir).filter((x) => x.endpoint === T).length >= 2)
    const lg = last(T)
    assert.deepEqual([lg.traffic_class, lg.body_retention, lg.req_body, lg.body_wire_bytes.req, lg.req_headers.authorization], ['telemetry', 'log', { raw_chars: Buffer.byteLength(b.body), verbatim: false }, Buffer.byteLength(b.body), 'Bearer sk-ant-oat-SECRET'])
    assert.equal('body' in lg.resp || 'raw' in lg.resp, false); assert.equal(lg.resp.verbatim, false)
    await s.call({ host: API, path: '/v1/messages/count_tokens', body: '{"model":"m","messages":[]}' })
    const ct = await until(() => last('/v1/messages/count_tokens'))
    assert.deepEqual([ct.traffic_class, ct.req_body, 'body_retention' in ct], ['token-count', '{"model":"m","messages":[]}', false], 'another class is untouched by the edit: token-count is full')
    // a file that cannot be parsed: the builtin table applies (nothing is kept less than full), one failure event, the board's health says ⚠
    fs.writeFileSync(file, '{ torn'); await settle()
    await s.call({ ...batch(5), path: T })
    await until(() => capturesOf(s.dir).filter((x) => x.endpoint === T).length >= 3)
    assert.equal(typeof last(T).req_body, 'string', 'unparsable → the builtin level, full')
    const ev = await until(() => flowsOf(s.dir).find((f) => f.event === 'failure' && f.where === 'classes'))
    assert.equal(ev.code, 'classes-unparsable'); assert.match(ev.reason, /builtin class table applies/)
    assert.equal(flowsOf(s.dir).filter((f) => f.event === 'failure' && f.where === 'classes').length, 1, 'one event per state change, not one per call')
    const bad = captureHealth({ home: path.join(s.home, '.asight') })
    assert.ok(bad.collector.conditions.some((c) => c.kind === 'classes'), 'a current condition: the top bar is ⚠'); assert.equal(bad.summary.state, 'failing')
    // fixed: classes-ok, the condition is gone
    setKeep('full'); await settle()
    await s.call({ ...batch(5), path: T })
    await until(() => flowsOf(s.dir).find((f) => f.event === 'classes-ok'))
    assert.equal(captureHealth({ home: path.join(s.home, '.asight') }).collector.conditions.some((c) => c.kind === 'classes'), false)
    assert.equal('body_retention' in last(T), false, 'back to full from the next call on')
  } finally { await s.done() }
})
