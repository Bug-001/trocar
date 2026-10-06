// test/collector/daemon-proxies.test.mjs — the daemon hands the engine each process's own proxies (plan 3c §2
// describe → tracker.extrasFor; RFC 4.6 §引擎 3, §记录 https:// 代理, acceptance W8): a trusted agent whose
// HTTPS_PROXY names an https:// proxy has that proxy's outer TLS terminated, the CONNECT inside it relayed and
// recorded, and the call in the tunnel decrypted and recorded — through the product path (the daemon over the fake
// helper and a synthetic /proc), not only an engine given the table by hand.
//   The shipped Claude Code descriptor declares no proxy reader (the harness files that do arrive with the harness
// lane), so the agent here is Claude Code's descriptor plus one: the plumbing under test is the daemon's.
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
import { toProxyEntry } from '../../src/collector/core/tracker.mjs'
import { createRedirectorClient } from '../../src/collector/arch/linux/redirector-client.mjs'
import { createLinuxRedirector } from '../../src/collector/arch/linux/redirector.mjs'
import cc from '../../src/collector/harness/claude-code.mjs'
import { fakeProc } from './arch/linux/fixtures/fake-proc.mjs'
import { startMockUpstream } from '../lab/mock-upstream/server.mjs'
import { startMockProxy } from '../lab/mock-upstream/proxy.mjs'
import { makeLabCa } from '../lab/mock-upstream/lab-ca.mjs'

const FAKE = fileURLToPath(new URL('./arch/linux/fixtures/fake-loader.mjs', import.meta.url))
const UID = process.getuid()
const CC_EXE = '/home/u/.local/share/claude/versions/2.1.289'
const API = 'api.anthropic.com'
const PROXY_HOST = 'proxy.asight.test' // the mock CA's leaf covers *.asight.test
function fakeArch(p) {
  const clients = []
  const makeClient = () => { const c = createRedirectorClient({ binary: process.execPath, args: [FAKE], env: { ...process.env, ASIGHT_FAKE_LOADER: '1' }, autoHeartbeatMs: 0 }); clients.push(c); return c }
  return { clients, arch: { os: 'linux', createRedirector: () => createLinuxRedirector({ makeClient, procRoot: p.root, uid: UID }) } }
}
const req = (sock, method, p, body) => controlRequest({ socketPath: sock, method, path: p, body })
async function until(fn, ms = 3000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) } }
const nowTicks = (p) => Math.ceil((Date.now() / 1000 - p.btime) * 100)
const ndjson = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const flowsOf = (dir) => { const d = path.join(dir, 'flows'); return fs.existsSync(d) ? fs.readdirSync(d).flatMap((n) => ndjson(path.join(d, n))) : [] }
const capturesOf = (dir) => fs.readdirSync(dir).filter((n) => /^capture-.*\.ndjson$/.test(n)).flatMap((n) => ndjson(path.join(dir, n)))

// Claude Code's descriptor with a proxy reader, as the harness files of the other agents declare one
const ccWithProxies = { ...cc, proxies: (ctx) => ['HTTPS_PROXY', 'https_proxy'].filter((k) => (ctx.env.get(k) || '') !== '').map((k) => ({ url: ctx.env.get(k), source: `env:${k}` })) }

test('toProxyEntry: scheme-less is http, credentials are never kept, unknown schemes are dropped, IPv6 unbracketed', () => {
  assert.deepEqual(toProxyEntry({ url: 'https://u:pw@Proxy.Example.com:8443', source: 'env:HTTPS_PROXY' }), { scheme: 'https', host: 'proxy.example.com', port: 8443, own: true, source: 'env:HTTPS_PROXY' })
  assert.deepEqual(toProxyEntry({ url: 'plain.example.com:3128', source: 's' }), { scheme: 'http', host: 'plain.example.com', port: 3128, own: true, source: 's' })
  assert.deepEqual(toProxyEntry({ url: 'socks5h://[::1]:1080', source: 's' }), { scheme: 'socks5h', host: '::1', port: 1080, own: true, source: 's' })
  assert.deepEqual([toProxyEntry({ url: 'socks://127.0.0.1', source: 's' }).scheme, toProxyEntry({ url: 'https://h', source: 's' }).port], ['socks5', 443])
  assert.deepEqual([toProxyEntry({ url: 'ftp://x', source: 's' }), toProxyEntry({ url: 'http://', source: 's' })], [null, null])
})

test('daemon: an agent\'s own https:// proxy (HTTPS_PROXY) reaches the engine through describe — outer TLS terminated, CONNECT recorded, the tunnelled call decrypted and recorded (W8 through the daemon)', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-dp-')) // short: unix socket paths are length-limited
  const home = path.join(root, 'home'); fs.mkdirSync(home)
  const dir = path.join(home, '.asight', 'collector'), sock = path.join(root, 'run', 'c.sock')
  const p = fakeProc()
  const labCa = makeLabCa(path.join(root, 'lab-ca'))
  const tlsOpts = { key: fs.readFileSync(labCa.key), cert: fs.readFileSync(labCa.cert) }
  const mock = await startMockUpstream({ tls: tlsOpts })
  const proxy = await startMockProxy({ kind: 'connect', tls: tlsOpts, target: { port: mock.port } })
  await installCollector({ home, env: { HOME: home }, osName: 'none', harnesses: [ccWithProxies], freePort: async () => 0 })
  const { arch, clients } = fakeArch(p)
  // upstreamCa: the mock CA, for the engine's TLS to the proxy and to the API host behind it (gate G8's test seam)
  const d = await startDaemon({ dir, socketPath: sock, arch, harnesses: [ccWithProxies], env: { ...process.env, HOME: home }, upstreamCa: fs.readFileSync(labCa.caCert, 'utf8') })
  let raw = null
  try {
    await req(sock, 'POST', '/on', {})
    p.add(4343, { uid: UID, exe: CC_EXE, argv: ['claude', '-p', 'hi'], cwd: home, env: { HOME: home, HTTPS_PROXY: `https://u1:pw-SECRET@Proxy.Asight.test:${proxy.port}` }, startTicks: nowTicks(p) })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 4343, pid: 4343, comm: 'claude', filename: CC_EXE, ts_ns: 1 })
    const row = await until(async () => (await req(sock, 'GET', '/status')).agents.find((a) => a.pid === 4343 && a.trusted))
    assert.equal(row.hosts.includes(PROXY_HOST), false, 'its proxy is FlowExtras, never a decrypt host')
    assert.deepEqual(d.tracker.extrasFor(4343), { wsTerminal: null, proxies: [{ scheme: 'https', host: PROXY_HOST, port: proxy.port, own: true, source: 'env:HTTPS_PROXY' }] }, 'no credentials')

    // the agent connects to its proxy; the kernel steers that connection to the engine
    raw = net.connect(d.port, '127.0.0.1'); await once(raw, 'connect')
    await clients[0].raw({ op: '__inject_port', port: raw.localPort, family: 4, dst: { address: '127.0.0.1', port: proxy.port, family: 4 }, pid: 4343, decrypt: 1 })
    const trusted = fs.readFileSync(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).env.NODE_EXTRA_CA_CERTS, 'utf8') // what this CC trusts: the CA install put in its settings
    const body = JSON.stringify({ model: 'claude-x', max_tokens: 16, messages: [{ role: 'user', content: 'asight-via-own-https-proxy' }] })
    const REQ = `POST /v1/messages HTTP/1.1\r\nHost: ${API}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
    const r = await new Promise((resolve, reject) => {
      const outer = tls.connect({ socket: raw, servername: PROXY_HOST, ca: trusted }, () => outer.write(`CONNECT ${API}:443 HTTP/1.1\r\nHost: ${API}:443\r\n\r\n`))
      outer.on('error', reject)
      outer.once('data', (reply) => {
        const inner = tls.connect({ socket: outer, servername: API, ca: trusted }, () => inner.write(REQ))
        let b = Buffer.alloc(0); inner.on('data', (x) => { b = Buffer.concat([b, x]) }); inner.on('error', reject)
        inner.on('end', () => resolve({ reply: reply.toString('latin1'), resp: b, issuer: outer.getPeerX509Certificate().issuer }))
      })
    })
    assert.match(r.issuer, /asight collector CA/, 'the outer TLS to the proxy was terminated by the engine')
    assert.match(r.reply, /^HTTP\/1\.1 200 /)
    const entry = mock.state.log.find((e) => e.type === 'request')
    assert.equal(Buffer.from(entry.req_raw_b64, 'base64').toString('latin1'), REQ, 'the API host got the request verbatim')
    assert.ok(r.resp.equals(Buffer.from(entry.resp_raw_b64, 'base64')), 'the agent got the response verbatim')

    const env = await until(() => capturesOf(dir).find((e) => e.req_body === body))
    assert.deepEqual([env.host, env.proc.pid, env.proc.agent], [API, 4343, 'claude-code'])
    const f = await until(() => flowsOf(dir).find((x) => x.flow_id && x.pid === 4343 && x.decision === 'tunnel'))
    assert.deepEqual([f.inner, f.host, f.prelude.kind, f.prelude.target], ['decrypt', API, 'connect', `${API}:443`])
    assert.deepEqual(f.via_proxy, { scheme: 'https', host: PROXY_HOST, port: proxy.port, source: 'env:HTTPS_PROXY', terminated: true })
  } finally { if (raw) raw.destroy(); await d.stop(); await proxy.close(); await mock.close(); p.done(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('daemon: describe that throws costs the connection nothing — it goes on without the proxy table (spliced, policy) and the failure is recorded under describe-error', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-dp-'))
  const home = path.join(root, 'home'); fs.mkdirSync(home)
  const dir = path.join(home, '.asight', 'collector'), sock = path.join(root, 'run', 'c.sock')
  const p = fakeProc()
  const labCa = makeLabCa(path.join(root, 'lab-ca'))
  const tlsOpts = { key: fs.readFileSync(labCa.key), cert: fs.readFileSync(labCa.cert) }
  const mock = await startMockUpstream({ tls: tlsOpts })
  const proxy = await startMockProxy({ kind: 'connect', tls: tlsOpts, target: { port: mock.port } })
  await installCollector({ home, env: { HOME: home }, osName: 'none', harnesses: [ccWithProxies], freePort: async () => 0 })
  const { arch, clients } = fakeArch(p)
  const d = await startDaemon({ dir, socketPath: sock, arch, harnesses: [ccWithProxies], env: { ...process.env, HOME: home }, upstreamCa: fs.readFileSync(labCa.caCert, 'utf8') })
  let raw = null
  try {
    await req(sock, 'POST', '/on', {})
    p.add(4444, { uid: UID, exe: CC_EXE, argv: ['claude'], cwd: home, env: { HOME: home, HTTPS_PROXY: `https://${PROXY_HOST}:${proxy.port}` }, startTicks: nowTicks(p) })
    await clients[0].raw({ op: '__emit', ev: 'exec', tgid: 4444, pid: 4444, comm: 'claude', filename: CC_EXE, ts_ns: 1 })
    await until(async () => (await req(sock, 'GET', '/status')).agents.find((a) => a.pid === 4444 && a.trusted))
    d.tracker.extrasFor = () => { throw new Error('extras exploded') }
    raw = net.connect(d.port, '127.0.0.1'); await once(raw, 'connect')
    await clients[0].raw({ op: '__inject_port', port: raw.localPort, family: 4, dst: { address: '127.0.0.1', port: proxy.port, family: 4 }, pid: 4444, decrypt: 1 })
    const issuer = await new Promise((resolve, reject) => {
      const outer = tls.connect({ socket: raw, servername: PROXY_HOST, ca: fs.readFileSync(labCa.caCert) }, () => { resolve(outer.getPeerX509Certificate().issuer); outer.end() })
      outer.on('error', reject)
    })
    assert.doesNotMatch(issuer, /asight collector CA/, 'no table: the proxy is an ordinary TLS host outside the policy, spliced')
    const f = await until(() => flowsOf(dir).find((x) => x.event === 'failure' && x.where === 'engine' && x.code === 'describe-error'))
    assert.match(f.reason, new RegExp(`describing pid 4444 \\(claude-code\\) for 127\\.0\\.0\\.1:${proxy.port} failed: extras exploded`))
    const row = await until(() => flowsOf(dir).find((x) => x.flow_id && x.pid === 4444))
    assert.deepEqual([row.decision, row.not_captured, row.via_proxy], ['splice', 'policy', undefined])
  } finally { if (raw) raw.destroy(); await d.stop(); await proxy.close(); await mock.close(); p.done(); fs.rmSync(root, { recursive: true, force: true }) }
})
