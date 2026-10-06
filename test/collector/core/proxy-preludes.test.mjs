// proxy-preludes.test.mjs — RFC 4.6 §引擎 3 / §记录 代理前导 (D37) · acceptance W8 / T6: SOCKS4 / 4a / 5
// and CONNECT through the real engine, against the mock proxy (test/lab/mock-upstream/proxy.mjs) in front
// of the TLS mock upstream. The prelude is relayed verbatim both ways, recorded verbatim in the 0600
// flows file, and the tunnelled TLS is decrypted and recorded; a refusal reaches the client unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import net from 'node:net'; import tls from 'node:tls'; import { once } from 'node:events'
import { Duplex } from 'node:stream'
import { startMockUpstream } from '../../lab/mock-upstream/server.mjs'
import { startMockProxy } from '../../lab/mock-upstream/proxy.mjs'
import { makeLabCa } from '../../lab/mock-upstream/lab-ca.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { createRecordStore } from '../../../src/collector/core/record/store.mjs'

const T = { timeout: 20000 }
const asightCa = createCa()
const HOST = 'api.anthropic.com'
const body = JSON.stringify({ model: 'claude-sonnet-4-5', stream: true, messages: [{ role: 'user', content: 'via proxy' }] })
const REQ = `POST /v1/messages HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
const b64 = (s) => Buffer.from(s, 'base64')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The engine steers every accepted connection to `dst()` (the mock proxy, or a stand-in in front of it).
async function lab(t, proxyOpts, { proxies = () => [], trustLab = true, dst = null, policy = () => true, decrypt = true, timing = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-proxy-'))
  const labCa = makeLabCa(path.join(dir, 'ca'))
  const tlsOpts = { key: fs.readFileSync(labCa.key), cert: fs.readFileSync(labCa.cert) }
  const mock = await startMockUpstream({ tls: tlsOpts })
  const proxy = await startMockProxy({ target: { port: mock.port }, ...proxyOpts, ...(proxyOpts.tls ? { tls: tlsOpts } : {}) })
  const store = createRecordStore({ root: path.join(dir, 'rec') })
  const envelopes = [], flows = [], failures = []
  const port0 = dst ? await dst(proxy.port, mock.port) : proxy.port
  const engine = createEngine({
    redirector: createStaticRedirector({ dst: { address: '127.0.0.1', port: port0, family: 4 }, pid: 21, agent: 'kimi', decrypt }), policy,
    issuer: createLeafIssuer(loadCa(asightCa)), upstreamCa: trustLab ? fs.readFileSync(labCa.caCert) : undefined,
    store: { envelope: (e) => { envelopes.push(e); return store.envelope(e) }, flow: (f) => { flows.push(structuredClone(f)); return store.flow(f) }, failure: (f) => { failures.push(f); return store.failure(f) } },
    describe: () => ({ proxies: proxies(proxy.port) }), timing,
  })
  const { port } = await engine.listen({})
  t.after(async () => { await engine.close(); await proxy.close(); await mock.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const settled = async (n) => { for (let i = 0; i < 400 && flows.length < n; i++) await sleep(10) }
  return { port, mock, proxy, envelopes, flows, failures, engine, dir, labCa, settled }
}

// The client side of a SOCKS prelude, written message by message as a SOCKS client would.
async function socks(port, { version, auth, domain = HOST, ip }) {
  const sock = net.connect(port, '127.0.0.1'); await once(sock, 'connect')
  const wrote = [], got = []
  let buf = Buffer.alloc(0)
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]) })
  const read = async (n) => { for (let i = 0; buf.length < n; i++) { if (i > 500) throw new Error('no reply'); await sleep(5) } const b = buf.subarray(0, n); buf = buf.subarray(n); got.push(b); return b }
  const write = (b) => { wrote.push(b); sock.write(b) }
  const portBytes = Buffer.from([1, 187]) // 443
  const detach = () => { sock.removeAllListeners('data') }
  if (version === 4) {
    write(Buffer.concat([Buffer.from([4, 1]), portBytes, ip ? Buffer.from(ip.split('.').map(Number)) : Buffer.from([0, 0, 0, 1]), Buffer.from('agent\0'), ip ? Buffer.alloc(0) : Buffer.from(`${domain}\0`)]))
    const rep = await read(8); detach(); return { sock, ok: rep[1] === 0x5a, wrote, got }
  }
  write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]))
  const m = await read(2)
  if (m[1] === 0xff) { detach(); return { sock, ok: false, wrote, got } }
  if (m[1] === 2) { write(Buffer.concat([Buffer.from([1, auth.username.length]), Buffer.from(auth.username), Buffer.from([auth.password.length]), Buffer.from(auth.password)])); if ((await read(2))[1] !== 0) { detach(); return { sock, ok: false, wrote, got } } }
  write(Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), Buffer.from(domain), portBytes]))
  const rep = await read(10); detach(); return { sock, ok: rep[1] === 0, wrote, got }
}
const exchange = (socket, ca = asightCa.certPem) => new Promise((resolve, reject) => {
  const c = tls.connect({ socket, servername: HOST, ca }, () => c.write(REQ))
  let b = Buffer.alloc(0); c.on('data', (d) => { b = Buffer.concat([b, d]) }); c.on('end', () => resolve(b)); c.on('error', reject)
})
const flowsFile = (L) => path.join(L.dir, 'rec', 'flows', fs.readdirSync(path.join(L.dir, 'rec', 'flows'))[0])

for (const [name, opts, client] of [
  ['SOCKS5 with username/password', { kind: 'socks5', auth: { username: 'u1', password: 'pw-SECRET' } }, { version: 5, auth: { username: 'u1', password: 'pw-SECRET' } }],
  ['SOCKS5 without auth', { kind: 'socks5' }, { version: 5 }],
  ['SOCKS4a (domain)', { kind: 'socks4' }, { version: 4 }],
  ['SOCKS4 (IPv4)', { kind: 'socks4' }, { version: 4, ip: '127.0.0.1' }],
]) {
  test(`W8 ${name}: the prelude is relayed verbatim both ways, the tunnelled TLS is decrypted and recorded`, T, async (t) => {
    const L = await lab(t, opts)
    const s = await socks(L.port, client)
    assert.equal(s.ok, true)
    const resp = await exchange(s.sock); await L.settled(1)
    const [pl] = L.proxy.log
    assert.ok(Buffer.concat(s.wrote).equals(b64(pl.in_b64)), 'the proxy got exactly the client prelude')
    assert.ok(Buffer.concat(s.got).equals(b64(pl.out_b64)), 'the client got exactly the proxy answer')
    const entry = L.mock.state.log.find((e) => e.type === 'request')
    assert.equal(b64(entry.req_raw_b64).toString('latin1'), REQ); assert.ok(resp.equals(b64(entry.resp_raw_b64)))
    assert.equal(L.envelopes.length, 1); assert.equal(L.envelopes[0].host, HOST, 'the SNI names the host, whatever the prelude said')
    const f = L.flows.at(-1)
    assert.deepEqual([f.decision, f.inner, f.not_captured], ['tunnel', 'decrypt', undefined])
    assert.equal(f.prelude.kind, client.version === 5 ? 'socks5' : client.ip ? 'socks4' : 'socks4a')
    assert.equal(f.prelude.target, `${client.ip || HOST}:443`)
    assert.ok(b64(f.prelude.client_b64).equals(Buffer.concat(s.wrote))); assert.ok(b64(f.prelude.proxy_b64).equals(Buffer.concat(s.got)))
    assert.equal(fs.statSync(flowsFile(L)).mode & 0o777, 0o600, 'prelude bytes (proxy credentials) are owner-only')
    if (client.auth) assert.ok(b64(JSON.parse(fs.readFileSync(flowsFile(L), 'utf8').trim().split('\n').at(-1)).prelude.client_b64).includes('pw-SECRET'))
  })
}

test('W8 / T6 SOCKS5 refused by the proxy: the client receives the refusal verbatim, nothing is synthesized or recorded', T, async (t) => {
  const L = await lab(t, { kind: 'socks5', refuse: true })
  const s = await socks(L.port, { version: 5 })
  assert.equal(s.ok, false); s.sock.destroy(); await L.settled(1)
  assert.ok(Buffer.concat(s.got).equals(b64(L.proxy.log[0].out_b64)))
  assert.equal(L.envelopes.length, 0)
  const f = L.flows.at(-1)
  assert.deepEqual([f.decision, f.not_captured, f.reason, f.prelude.kind], ['tunnel', 'proxy-refused', 'socks5-reply-2', 'socks5'])
})

test('W8 SOCKS5 with wrong credentials: the proxy\'s auth failure is relayed verbatim and labelled', T, async (t) => {
  const L = await lab(t, { kind: 'socks5', auth: { username: 'u1', password: 'right' } })
  const s = await socks(L.port, { version: 5, auth: { username: 'u1', password: 'wrong' } })
  assert.equal(s.ok, false); s.sock.destroy(); await L.settled(1)
  assert.ok(Buffer.concat(s.got).equals(b64(L.proxy.log[0].out_b64)))
  assert.deepEqual([L.flows[0].not_captured, L.flows[0].reason], ['proxy-refused', 'socks5-auth-failed'])
})

test('W8 SOCKS4 refused: the 91 reply is relayed verbatim and labelled socks4-reply-91', T, async (t) => {
  const L = await lab(t, { kind: 'socks4', refuse: true })
  const s = await socks(L.port, { version: 4 })
  assert.equal(s.ok, false); s.sock.destroy(); await L.settled(1)
  assert.ok(Buffer.concat(s.got).equals(b64(L.proxy.log[0].out_b64)))
  assert.deepEqual([L.flows[0].decision, L.flows[0].not_captured, L.flows[0].reason], ['tunnel', 'proxy-refused', 'socks4-reply-91'])
})

test('T6 CONNECT: the prelude (Proxy-Authorization included) is recorded verbatim both ways; the tunnelled call is recorded', T, async (t) => {
  const L = await lab(t, { kind: 'connect', auth: { username: 'u1', password: 'pw-SECRET' } })
  const head = `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\nProxy-Authorization: Basic ${Buffer.from('u1:pw-SECRET').toString('base64')}\r\n\r\n`
  const raw = net.connect(L.port, '127.0.0.1'); await once(raw, 'connect'); raw.write(head)
  const [reply] = await once(raw, 'data')
  const resp = await exchange(raw); await L.settled(1)
  assert.ok(reply.equals(b64(L.proxy.log[0].out_b64)), 'the proxy reply, verbatim')
  const f = L.flows.at(-1)
  assert.deepEqual([f.decision, f.inner, f.prelude.kind, f.prelude.target], ['tunnel', 'decrypt', 'connect', `${HOST}:443`])
  assert.equal(b64(f.prelude.client_b64).toString('latin1'), head); assert.ok(b64(f.prelude.proxy_b64).equals(reply))
  assert.equal(L.envelopes.length, 1); assert.ok(resp.length > 0)
})

// A client that does not wait for the 2xx: its ClientHello is on the wire before the proxy has answered.
// The engine must hold those bytes (it used to drop them: no 'data' listener while it waited).
test('T6 an eager CONNECT client (ClientHello sent before the proxy answers) is still decrypted and recorded', T, async (t) => {
  const slowFront = async (proxyPort) => { // answers 150 ms late: the client's ClientHello is already at the engine
    const s = net.createServer((c) => { const p = net.connect(proxyPort, '127.0.0.1'); c.on('data', (d) => p.write(d)); let first = true
      p.on('data', (d) => { if (first) { first = false; p.pause(); setTimeout(() => { c.write(d); p.resume() }, 150) } else c.write(d) })
      c.on('end', () => p.end()); p.on('end', () => c.end()); c.on('error', () => p.destroy()); p.on('error', () => c.destroy()) })
    await new Promise((r) => s.listen(0, '127.0.0.1', r)); t.after(() => s.close()); return s.address().port
  }
  const L = await lab(t, { kind: 'connect' }, { dst: slowFront })
  const raw = net.connect(L.port, '127.0.0.1'); await once(raw, 'connect')
  let head = Buffer.alloc(0), passed = false
  const d = new Duplex({ read() {}, write(chunk, enc, cb) { raw.write(chunk, cb) }, final(cb) { raw.end(); cb() } })
  raw.on('data', (x) => { if (passed) return d.push(x); head = Buffer.concat([head, x]); const i = head.indexOf('\r\n\r\n'); if (i < 0) return; passed = true; if (head.length > i + 4) d.push(head.subarray(i + 4)) })
  raw.on('end', () => d.push(null)); raw.on('error', (e) => d.destroy(e))
  raw.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`)
  await sleep(50) // the head is at the proxy, its answer is 100 ms away: the ClientHello arrives as a chunk of its own
  const resp = await Promise.race([exchange(d), sleep(5000).then(() => { raw.destroy(); throw new Error('the tunnelled exchange never completed (the ClientHello was lost?)') })])
  await L.settled(1)
  const entry = L.mock.state.log.find((e) => e.type === 'request')
  assert.ok(resp.equals(b64(entry.resp_raw_b64)))
  assert.deepEqual([L.flows[0].decision, L.flows[0].inner], ['tunnel', 'decrypt']); assert.equal(L.envelopes.length, 1)
})

test('a SOCKS5 method the engine does not follow (GSSAPI) is spliced from there, labelled unknown-protocol, prelude so far recorded', T, async (t) => {
  // a stand-in proxy that picks GSSAPI (1) and then just echoes
  const L = await lab(t, { kind: 'socks5' }, { dst: async () => { const s = net.createServer((c) => { c.once('data', () => { c.write(Buffer.from([5, 1])); c.on('data', (x) => c.write(x)) }); c.on('error', () => {}) }); await new Promise((r) => s.listen(0, '127.0.0.1', r)); t.after(() => s.close()); return s.address().port } })
  const c = net.connect(L.port, '127.0.0.1'); await once(c, 'connect')
  c.write(Buffer.from([5, 1, 1]))
  let got = Buffer.alloc(0); c.on('data', (x) => { got = Buffer.concat([got, x]) })
  for (let i = 0; i < 100 && got.length < 2; i++) await sleep(5)
  c.write('gss-token-bytes')
  for (let i = 0; i < 100 && got.length < 17; i++) await sleep(5)
  c.end(); await L.settled(1)
  assert.equal(got.toString('latin1'), '\x05\x01gss-token-bytes', 'the method choice and everything after it, verbatim')
  assert.deepEqual([L.flows[0].decision, L.flows[0].not_captured, L.flows[0].reason], ['tunnel', 'unknown-protocol', 'socks5: method 1 not followed'])
  assert.deepEqual([b64(L.flows[0].prelude.client_b64), b64(L.flows[0].prelude.proxy_b64)], [Buffer.from([5, 1, 1]), Buffer.from([5, 1])])
})

test('T6 CONNECT refused: client bytes sent behind the CONNECT head still reach the proxy verbatim (nothing dropped, nothing added)', T, async (t) => {
  const seen = []
  const L = await lab(t, { kind: 'connect' }, { dst: async () => { const s = net.createServer((c) => { c.on('data', (x) => seen.push(x)); c.on('error', () => {}); setTimeout(() => c.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'), 100) }); await new Promise((r) => s.listen(0, '127.0.0.1', r)); t.after(() => s.close()); return s.address().port } })
  const head = 'CONNECT x.test:443 HTTP/1.1\r\n\r\n'
  const c = net.connect(L.port, '127.0.0.1'); await once(c, 'connect'); c.write(head + 'EAGER')
  let got = ''; c.on('data', (x) => { got += x }); await once(c, 'end'); c.destroy(); await L.settled(1)
  assert.equal(got, 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
  assert.equal(Buffer.concat(seen).toString(), head + 'EAGER')
  assert.deepEqual([L.flows[0].not_captured, L.flows[0].reason], ['proxy-refused', 'proxy-status-403'])
})


// ── https:// proxies (RFC 4.6 §引擎 3, §记录 https:// 代理; Plan 3c-7; W8 / W12) ────────────────────────────
// The client speaks TLS to the proxy host first (outer TLS), sends CONNECT inside it, then TLS to the API host
// inside the tunnel (TLS in TLS). Only the API host is in the decrypt policy here (`auto`).
const PROXY_HOST = 'proxy.asight.test'
const onlyApi = (meta, host) => host === HOST
const httpsProxyClient = (port, ca, { innerCa = ca } = {}) => new Promise((resolve, reject) => {
  const outer = tls.connect({ port, host: '127.0.0.1', servername: PROXY_HOST, ca }, () => outer.write(`CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`))
  outer.on('error', reject)
  outer.once('data', (reply) => exchange(outer, innerCa).then((resp) => resolve({ reply, resp, issuer: outer.getPeerX509Certificate().issuer }), reject))
})
const table = (own) => (port) => [{ scheme: 'https', host: PROXY_HOST, port, own, source: 'env:HTTPS_PROXY' }]

test('W8 an https:// proxy from the process\'s own config: outer TLS terminated, CONNECT relayed and recorded, the inner call decrypted and recorded', T, async (t) => {
  const L = await lab(t, { kind: 'connect', tls: true }, { proxies: table(true), policy: onlyApi })
  const r = await httpsProxyClient(L.port, asightCa.certPem); await L.settled(1)
  assert.match(r.issuer, /asight collector CA/, 'the outer TLS was terminated by the engine')
  assert.ok(r.reply.equals(b64(L.proxy.log[0].out_b64)), 'the proxy reply, verbatim')
  const entry = L.mock.state.log.find((e) => e.type === 'request')
  assert.equal(b64(entry.req_raw_b64).toString('latin1'), REQ); assert.ok(r.resp.equals(b64(entry.resp_raw_b64)))
  assert.deepEqual(L.envelopes.map((e) => e.host), [HOST])
  const f = L.flows.at(-1)
  assert.deepEqual([f.decision, f.inner, f.host, f.prelude.kind, f.prelude.target], ['tunnel', 'decrypt', HOST, 'connect', `${HOST}:443`])
  assert.deepEqual(f.via_proxy, { scheme: 'https', host: PROXY_HOST, port: L.proxy.port, source: 'env:HTTPS_PROXY', terminated: true })
})

test('W8 a listed https:// proxy that is not the process\'s own: spliced, flows/ says not captured · https proxy', T, async (t) => {
  const L = await lab(t, { kind: 'connect', tls: true }, { proxies: table(false), policy: onlyApi })
  const ca = fs.readFileSync(L.labCa.caCert)
  const r = await httpsProxyClient(L.port, ca); await L.settled(1) // the client talks to the real proxy
  assert.match(r.issuer, /asight lab CA|lab/i); assert.ok(r.reply.equals(b64(L.proxy.log[0].out_b64)))
  assert.equal(L.envelopes.length, 0)
  const f = L.flows.at(-1)
  assert.deepEqual([f.decision, f.not_captured, f.reason, f.via_proxy.terminated], ['splice', 'https-proxy', 'proxy-not-own', false])
  assert.equal(L.engine.stats().notCaptured.httpsProxy, 1)
})

test('W8 an https:// proxy the daemon did not list, under auto: an ordinary TLS splice (policy), not labelled https proxy', T, async (t) => {
  const L = await lab(t, { kind: 'connect', tls: true }, { policy: onlyApi })
  await httpsProxyClient(L.port, fs.readFileSync(L.labCa.caCert)); await L.settled(1)
  const f = L.flows.at(-1)
  assert.deepEqual([f.decision, f.not_captured, f.via_proxy], ['splice', 'policy', undefined])
  assert.equal(L.engine.stats().notCaptured.httpsProxy, 0)
})

test('W8 under `all` an https:// proxy the daemon did not list is terminated too: its CONNECT is followed, the inner call recorded', T, async (t) => {
  const L = await lab(t, { kind: 'connect', tls: true }, { policy: () => true })
  const r = await httpsProxyClient(L.port, asightCa.certPem); await L.settled(1)
  const entry = L.mock.state.log.find((e) => e.type === 'request')
  assert.ok(r.resp.equals(b64(entry.resp_raw_b64))); assert.deepEqual(L.envelopes.map((e) => e.host), [HOST])
  const f = L.flows.at(-1)
  assert.deepEqual([f.decision, f.inner, f.prelude.kind], ['tunnel', 'decrypt', 'connect'])
  assert.deepEqual(f.via_proxy, { scheme: 'https', host: PROXY_HOST, port: L.proxy.port, source: null, terminated: true })
})

test('W8 an own https:// proxy of an untrusted process is never terminated: untrusted, via_proxy says not terminated', T, async (t) => {
  const L = await lab(t, { kind: 'connect', tls: true }, { proxies: table(true), policy: onlyApi, decrypt: false })
  const r = await httpsProxyClient(L.port, fs.readFileSync(L.labCa.caCert)); await L.settled(1)
  assert.match(r.issuer, /lab/i); assert.equal(L.envelopes.length, 0)
  assert.deepEqual([L.flows[0].decision, L.flows[0].not_captured, L.flows[0].via_proxy.terminated], ['splice', 'untrusted', false])
})

// RFC 4.6 §引擎 3/5 · W12 (https:// proxy outer leg): the process's own https:// proxy presents a certificate the
// engine cannot verify (a private CA the client trusts). The engine steps aside — fresh connection, ClientHello
// replayed, splice — and the next connection to that proxy is spliced at once (negative cache).
test('W12 an own https:// proxy whose certificate the engine cannot verify: the client reaches the proxy itself, then the proxy is negative-cached', T, async (t) => {
  const L = await lab(t, { kind: 'connect', tls: true }, { proxies: table(true), policy: onlyApi, trustLab: false })
  const ca = fs.readFileSync(L.labCa.caCert)
  const r1 = await httpsProxyClient(L.port, ca); await L.settled(1)
  const r2 = await httpsProxyClient(L.port, ca); await L.settled(2)
  const reqs = L.mock.state.log.filter((e) => e.type === 'request')
  assert.equal(reqs.length, 2); assert.ok(r1.resp.equals(b64(reqs[0].resp_raw_b64))); assert.ok(r2.resp.equals(b64(reqs[1].resp_raw_b64)))
  assert.equal(L.envelopes.length, 0)
  assert.deepEqual(L.flows.map((f) => [f.decision, f.not_captured, f.via_proxy.terminated]), [['splice', 'upstream-cert', false], ['splice', 'negative-cache', false]])
  assert.deepEqual(L.proxy.log.map((e) => e.conn), [1, 2], 'one CONNECT per client connection: the prelude reached the proxy once each')
  const nc = L.engine.stats().notCaptured
  assert.deepEqual([nc.upstreamCert, nc.negative, nc.httpsProxy], [1, 1, 0])
  assert.deepEqual(L.failures.map((f) => [f.reason, f.host, f.cause]), [['negative-cache-add', PROXY_HOST, 'upstream-cert']])
})

test('an own https:// proxy: the client goes after CONNECT 200 without starting the inner TLS — the row is written, nothing hangs', T, async (t) => {
  const L = await lab(t, { kind: 'connect', tls: true }, { proxies: table(true), policy: onlyApi })
  let outer
  await new Promise((resolve) => {
    outer = tls.connect({ port: L.port, host: '127.0.0.1', servername: PROXY_HOST, ca: asightCa.certPem }, () => outer.write(`CONNECT ${HOST}:443 HTTP/1.1\r\n\r\n`))
    outer.on('error', () => {}); outer.once('data', () => outer.end()); outer.on('close', resolve)
  })
  await L.settled(1)
  if (!L.flows.length) { outer.destroy(); L.proxy.close(); assert.fail('the flow never finished') }
  const f = L.flows[0]
  assert.deepEqual([f.decision, f.not_captured, f.error.type, f.error.side, f.via_proxy.terminated], ['tunnel', 'error', 'closed_before_decision', 'client', true])
})


// ── review B: eager SOCKS clients through the engine, mid-prelude closes, refusals and BIND end to end, IPv6,
// a stalled partial message ───────────────────────────────────────────────────────────────────────────────────
// A SOCKS5 stand-in that answers each message 40 ms late and notes whether bytes of the NEXT message had
// already reached it before it answered (they must not: the engine holds them until the proxy has answered).
async function strictSocks5(t, mockPort, delay = 40) {
  const log = { early: false, got: [] }
  const s = net.createServer((c) => {
    c.on('error', () => {})
    let buf = Buffer.alloc(0), stage = 0, busy = false
    const want = () => (stage === 0 ? (buf.length >= 2 ? 2 + buf[1] : Infinity) : stage === 1 ? (buf.length >= 5 ? 7 + buf[4] : Infinity) : Infinity)
    const step = () => {
      if (busy || stage > 1) return
      const n = want(); if (buf.length < n) return
      if (buf.length > n) log.early = true
      log.got.push(buf.subarray(0, n)); buf = buf.subarray(n); busy = true
      setTimeout(() => {
        busy = false
        if (stage === 0) { c.write(Buffer.from([5, 0])); stage = 1; return step() }
        stage = 2; c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
        const up = net.connect(mockPort, '127.0.0.1'); up.on('error', () => c.destroy()); c.on('close', () => up.destroy())
        if (buf.length) up.write(buf)
        c.removeAllListeners('data'); c.pipe(up); up.pipe(c)
      }, delay)
    }
    c.on('data', (d) => { if (stage > 1) return; if (busy) log.early = true; buf = Buffer.concat([buf, d]); step() }) // bytes while an answer is pending came early
  })
  await new Promise((r) => s.listen(0, '127.0.0.1', r)); t.after(() => s.close())
  return { port: s.address().port, log }
}
const greeting = Buffer.from([5, 1, 0])
const request = Buffer.concat([Buffer.from([5, 1, 0, 3, HOST.length]), Buffer.from(HOST), Buffer.from([1, 187])])

test('review B · an eager SOCKS5 client (greeting + request in one write): each message reaches the proxy only after the previous answer; decrypted', T, async (t) => {
  let sp
  const L = await lab(t, { kind: 'socks5' }, { dst: async (_, mockPort) => { sp = await strictSocks5(t, mockPort); return sp.port } })
  const raw = net.connect(L.port, '127.0.0.1'); await once(raw, 'connect')
  raw.write(Buffer.concat([greeting, request]))
  let got = Buffer.alloc(0); const onD = (d) => { got = Buffer.concat([got, d]) }; raw.on('data', onD)
  for (let i = 0; i < 300 && got.length < 12; i++) await sleep(5)
  raw.removeListener('data', onD)
  assert.ok(got.equals(Buffer.from([5, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0])), 'both answers, verbatim, in order')
  const resp = await exchange(raw); await L.settled(1)
  assert.equal(sp.log.early, false, 'the request was held until the proxy had answered the greeting')
  assert.deepEqual(sp.log.got.map((b) => b.toString('hex')), [greeting.toString('hex'), request.toString('hex')])
  assert.ok(resp.length > 0); assert.equal(L.envelopes.length, 1)
  assert.ok(b64(L.flows[0].prelude.client_b64).equals(Buffer.concat([greeting, request])))
})

test('review B · a SOCKS5 request and the ClientHello in one write: the ClientHello goes on into the tunnel and is decrypted', T, async (t) => {
  const L = await lab(t, { kind: 'socks5' })
  const raw = net.connect(L.port, '127.0.0.1'); await once(raw, 'connect')
  raw.write(greeting); await once(raw, 'data') // [5, 0]
  let first = true, head = Buffer.alloc(0), passed = false
  const d = new Duplex({ read() {}, write(chunk, enc, cb) { if (first) { first = false; raw.write(Buffer.concat([request, chunk]), cb) } else raw.write(chunk, cb) }, final(cb) { raw.end(); cb() } })
  raw.on('data', (x) => { if (passed) return d.push(x); head = Buffer.concat([head, x]); if (head.length < 10) return; passed = true; if (head.length > 10) d.push(head.subarray(10)) })
  raw.on('end', () => d.push(null)); raw.on('error', (e) => d.destroy(e))
  const resp = await Promise.race([exchange(d), sleep(5000).then(() => { raw.destroy(); throw new Error('no tunnelled exchange') })])
  await L.settled(1)
  const entry = L.mock.state.log.find((e) => e.type === 'request')
  assert.ok(resp.equals(b64(entry.resp_raw_b64))); assert.equal(L.envelopes.length, 1)
  assert.deepEqual([L.flows[0].decision, L.flows[0].inner], ['tunnel', 'decrypt'])
})

for (const who of ['client', 'proxy']) {
  test(`review B · the ${who} goes after the SOCKS5 greeting: one error row, no prelude`, T, async (t) => {
    const L = await lab(t, { kind: 'socks5' }, { dst: async () => { const s = net.createServer((c) => { c.on('error', () => {}); c.once('data', () => { c.write(Buffer.from([5, 0])); if (who === 'proxy') setTimeout(() => c.destroy(), 30) }) }); await new Promise((r) => s.listen(0, '127.0.0.1', r)); t.after(() => s.close()); return s.address().port } })
    const raw = net.connect(L.port, '127.0.0.1'); await once(raw, 'connect'); raw.on('error', () => {})
    raw.write(greeting); await once(raw, 'data')
    if (who === 'client') raw.end(); else await once(raw, 'close')
    await L.settled(1); raw.destroy()
    assert.equal(L.flows.length, 1)
    assert.deepEqual([L.flows[0].decision, L.flows[0].not_captured, L.flows[0].prelude], ['error', 'error', undefined])
  })
}

test('review B · SOCKS5 with no acceptable method, and a BIND request, through the engine', T, async (t) => {
  const L = await lab(t, { kind: 'socks5', auth: { username: 'u', password: 'p' } }) // wants method 2; the client offers only 0
  const s = await socks(L.port, { version: 5 }); s.sock.destroy(); await L.settled(1)
  assert.ok(Buffer.concat(s.got).equals(Buffer.from([5, 0xff])))
  assert.deepEqual([L.flows[0].not_captured, L.flows[0].reason], ['proxy-refused', 'socks5-no-acceptable-method'])
  const M = await lab(t, { kind: 'socks5' })
  const raw = net.connect(M.port, '127.0.0.1'); await once(raw, 'connect'); raw.on('error', () => {})
  raw.write(greeting); await once(raw, 'data')
  raw.write(Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 1, 187])) // BIND
  await sleep(50); raw.destroy(); await M.settled(1)
  assert.deepEqual([M.flows[0].decision, M.flows[0].not_captured, M.flows[0].reason], ['tunnel', 'unknown-protocol', 'socks5: not CONNECT'])
  assert.equal(b64(M.proxy.log[0].in_b64).subarray(3).toString('hex'), '05020001' + '7f000001' + '01bb', 'the BIND request reached the proxy verbatim')
})

test('review B · IPv6 targets: SOCKS5 ATYP 4 and a CONNECT authority are recorded in the same compressed form', T, async (t) => {
  const L = await lab(t, { kind: 'socks5', refuse: true })
  const raw = net.connect(L.port, '127.0.0.1'); await once(raw, 'connect'); raw.on('error', () => {})
  raw.write(greeting); await once(raw, 'data')
  raw.write(Buffer.from([5, 1, 0, 4, ...Array(15).fill(0), 1, 1, 187])); await once(raw, 'data'); raw.destroy(); await L.settled(1)
  assert.deepEqual([L.flows[0].prelude.target, L.flows[0].host], ['[::1]:443', '::1'])
  const C = await lab(t, { kind: 'connect', refuse: true })
  const c = net.connect(C.port, '127.0.0.1'); await once(c, 'connect'); c.on('error', () => {})
  c.write('CONNECT [::1]:443 HTTP/1.1\r\n\r\n'); await once(c, 'data'); c.destroy(); await C.settled(1)
  assert.deepEqual([C.flows[0].prelude.target, C.flows[0].host], ['[::1]:443', '::1'])
})

test('review B · a first byte that only looks like SOCKS (0x05, then a partial "greeting" and silence) is passed through after the stall, not held', T, async (t) => {
  const seen = []
  const L = await lab(t, { kind: 'socks5' }, { timing: { preludeStallMs: 100 }, dst: async () => { const s = net.createServer((c) => { c.on('error', () => {}); c.on('data', (d) => { seen.push(d); c.write('pong') }) }); await new Promise((r) => s.listen(0, '127.0.0.1', r)); t.after(() => s.close()); return s.address().port } })
  const raw = net.connect(L.port, '127.0.0.1'); await once(raw, 'connect'); raw.on('error', () => {})
  raw.write(Buffer.from([5, 9, 1, 2])) // claims 9 methods, sends 2, then waits for its peer
  const [answer] = await Promise.race([once(raw, 'data'), sleep(3000).then(() => { raw.destroy(); throw new Error('held forever') })])
  raw.destroy(); await L.settled(1)
  assert.equal(answer.toString(), 'pong'); assert.equal(Buffer.concat(seen).toString('hex'), '05090102', 'the held bytes, verbatim')
  assert.deepEqual([L.flows[0].not_captured, /incomplete/.test(L.flows[0].reason)], ['unknown-protocol', true])
})

// review TR-2: a whole message that only looks like SOCKS. Its first bytes parse as a complete SOCKS5 greeting
// (05 01 00) or SOCKS4 request (04 01 … NUL at byte 8), so they are forwarded and the engine waits for a proxy answer —
// but the peer is a client-first server waiting for the rest of the message, which the engine held: both sides waited
// forever. The engine must not hold bytes for either side (RFC 4.6 §记录 代理前导).
async function waitingServer(t, need) {
  const got = []
  const s = net.createServer((c) => { c.on('error', () => {}); let n = 0; c.on('data', (d) => { got.push(d); n += d.length; if (n >= need) c.write('REPLY') }) })
  await new Promise((r) => s.listen(0, '127.0.0.1', r)); t.after(() => s.close())
  return { port: s.address().port, got }
}
const mongoLike = Buffer.alloc(261, 0x41); mongoLike.writeUInt32LE(261, 0) // 05 01 00 00 …: reads as greeting {1 method: 0}
const socks4Like = Buffer.alloc(260, 0); socks4Like.writeUInt32LE(260, 0); socks4Like.fill(0x41, 16) // 04 01 00 00 … NUL at 8
for (const [name, msg, kind] of [['SOCKS5 greeting', mongoLike, 'socks5'], ['SOCKS4 request', socks4Like, 'socks4']]) {
  test(`review TR-2 · a client-first message whose head parses as a whole ${name}: the held rest reaches the server after the stall, the reply reaches the client`, T, async (t) => {
    let srv
    const L = await lab(t, { kind: 'socks5' }, { timing: { preludeStallMs: 100 }, dst: async () => { srv = await waitingServer(t, msg.length); return srv.port } })
    const raw = net.connect(L.port, '127.0.0.1'); await once(raw, 'connect'); raw.on('error', () => {})
    raw.write(msg)
    const [answer] = await Promise.race([once(raw, 'data'), sleep(3000).then(() => { raw.destroy(); throw new Error('held forever') })])
    raw.destroy(); await L.settled(1)
    assert.equal(answer.toString(), 'REPLY')
    assert.ok(Buffer.concat(srv.got).equals(msg), 'the server got the whole message, verbatim, in order')
    const f = L.flows[0]
    assert.deepEqual([f.decision, f.not_captured, f.prelude.kind], ['tunnel', 'unknown-protocol', kind])
    assert.match(f.reason, new RegExp(`^${kind}: incomplete exchange, the proxy sent nothing for 100 ms while \\d+ bytes were held$`))
  })
}

test('review TR-2 · bytes the client keeps sending while the proxy is silent do not restart the clock: the held bytes go after the stall', T, async (t) => {
  let srv
  const L = await lab(t, { kind: 'socks5' }, { timing: { preludeStallMs: 100 }, dst: async () => { srv = await waitingServer(t, 4); return srv.port } })
  const raw = net.connect(L.port, '127.0.0.1'); await once(raw, 'connect'); raw.on('error', () => {})
  raw.write(Buffer.from([5, 1, 0]))
  const drip = setInterval(() => raw.write(Buffer.from([0x41])), 20) // the client keeps talking; the "proxy" never answers
  t.after(() => clearInterval(drip))
  const [answer] = await Promise.race([once(raw, 'data'), sleep(1000).then(() => { clearInterval(drip); raw.destroy(); throw new Error('the client\'s own bytes kept the rest held') })])
  clearInterval(drip); raw.destroy(); await L.settled(1)
  assert.equal(answer.toString(), 'REPLY')
  assert.equal(Buffer.concat(srv.got).subarray(0, 4).toString('hex'), '05010041')
  assert.match(L.flows[0].reason, /^socks5: incomplete exchange/)
})

test('review TR-2 · an eager SOCKS5 client meets a proxy that answers only after the stall: both messages reach it verbatim and in order, the tunnel is spliced, nothing is lost', T, async (t) => {
  let sp
  const L = await lab(t, { kind: 'socks5' }, { timing: { preludeStallMs: 100 }, dst: async (_, mockPort) => { sp = await strictSocks5(t, mockPort, 300); return sp.port } })
  const raw = net.connect(L.port, '127.0.0.1'); await once(raw, 'connect')
  raw.write(Buffer.concat([greeting, request]))
  let got = Buffer.alloc(0); const onD = (d) => { got = Buffer.concat([got, d]) }; raw.on('data', onD)
  for (let i = 0; i < 400 && got.length < 12; i++) await sleep(5)
  raw.removeListener('data', onD)
  assert.ok(got.equals(Buffer.from([5, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0])), 'both answers, verbatim, in order')
  const resp = await exchange(raw, fs.readFileSync(L.labCa.caCert)); await L.settled(1) // the client talks to the real upstream
  assert.equal(sp.log.early, true, 'the request was let go after the stall, not held for the proxy')
  assert.deepEqual(sp.log.got.map((b) => b.toString('hex')), [greeting.toString('hex'), request.toString('hex')])
  const entry = L.mock.state.log.find((e) => e.type === 'request')
  assert.ok(resp.equals(b64(entry.resp_raw_b64))); assert.equal(L.envelopes.length, 0)
  assert.deepEqual([L.flows[0].decision, L.flows[0].not_captured], ['tunnel', 'unknown-protocol'])
  assert.equal(L.flows[0].reason, `socks5: incomplete exchange, the proxy sent nothing for 100 ms while ${request.length} bytes were held`)
})

test('review TR-2 · a SOCKS5 proxy that answers each message only after the stall, with nothing held, is still followed: no limit on the wait', T, async (t) => {
  const L = await lab(t, { kind: 'socks5' }, { timing: { preludeStallMs: 100 }, dst: async (_, mockPort) => (await strictSocks5(t, mockPort, 300)).port })
  const s = await socks(L.port, { version: 5 })
  assert.equal(s.ok, true)
  const resp = await exchange(s.sock); await L.settled(1)
  assert.ok(resp.length > 0); assert.equal(L.envelopes.length, 1)
  assert.deepEqual([L.flows[0].decision, L.flows[0].inner, L.flows[0].not_captured], ['tunnel', 'decrypt', undefined])
})

// review B #7: upstream bytes in the same chunk as the proxy's 200 — the upstream spoke first in the tunnel
test('review B · bytes the upstream sends with the proxy\'s 200 make the tunnel upstream-first; relayed verbatim', T, async (t) => {
  const L = await lab(t, { kind: 'connect' }, { dst: async () => { const s = net.createServer((c) => { c.on('error', () => {}); c.once('data', () => { c.write('HTTP/1.1 200 OK\r\n\r\nSSH-2.0-banner\r\n'); c.on('data', () => {}) }) }); await new Promise((r) => s.listen(0, '127.0.0.1', r)); t.after(() => s.close()); return s.address().port } })
  const raw = net.connect(L.port, '127.0.0.1'); await once(raw, 'connect'); raw.on('error', () => {})
  raw.write('CONNECT host.test:22 HTTP/1.1\r\n\r\n')
  let got = ''; raw.on('data', (d) => { got += d })
  for (let i = 0; i < 200 && !got.includes('banner\r\n'); i++) await sleep(5)
  raw.destroy(); await L.settled(1)
  assert.equal(got, 'HTTP/1.1 200 OK\r\n\r\nSSH-2.0-banner\r\n')
  assert.deepEqual([L.flows[0].decision, L.flows[0].inner, L.flows[0].not_captured], ['tunnel', 'splice', 'upstream-first'])
})

// review B #8: a keep-alive proxy answers 407; the client retries with credentials on the same connection
async function authProxy(t, mockPort, { closeAfterRefusal = false, silentOnRetry = false } = {}) {
  const s = net.createServer((c) => {
    c.on('error', () => {})
    let buf = ''
    const onData = (d) => {
      buf += d.toString('latin1'); const i = buf.indexOf('\r\n\r\n'); if (i < 0) return
      const head = buf.slice(0, i + 4); buf = buf.slice(i + 4)
      if (!/Proxy-Authorization: Basic /i.test(head)) {
        c.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="lab"\r\nContent-Length: 5\r\n\r\n')
        setTimeout(() => { c.write('nope!'); if (closeAfterRefusal) c.end() }, 20)
        return
      }
      if (silentOnRetry) return
      c.removeListener('data', onData); c.write('HTTP/1.1 200 Connection established\r\n\r\n')
      const up = net.connect(mockPort, '127.0.0.1'); up.on('error', () => c.destroy()); c.on('close', () => up.destroy())
      c.pipe(up); up.pipe(c)
    }
    c.on('data', onData)
  })
  await new Promise((r) => s.listen(0, '127.0.0.1', r)); t.after(() => s.close())
  return s.address().port
}
const H1 = `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`
const H2 = `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\nProxy-Authorization: Basic dTpw\r\n\r\n`
const R407 = 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="lab"\r\nContent-Length: 5\r\n\r\n'

test('review B · CONNECT refused with 407, retried with credentials on the same connection: the retry is followed and the call decrypted', T, async (t) => {
  const L = await lab(t, { kind: 'connect' }, { dst: (_, mockPort) => authProxy(t, mockPort) })
  const raw = net.connect(L.port, '127.0.0.1'); await once(raw, 'connect')
  let got = ''; const onD = (d) => { got += d.toString('latin1') }; raw.on('data', onD)
  raw.write(H1)
  for (let i = 0; i < 200 && !got.endsWith('nope!'); i++) await sleep(5)
  assert.equal(got, R407 + 'nope!', 'the refusal and its body, verbatim')
  got = ''; raw.write(H2)
  for (let i = 0; i < 200 && !got.endsWith('\r\n\r\n'); i++) await sleep(5)
  raw.removeListener('data', onD)
  assert.equal(got, 'HTTP/1.1 200 Connection established\r\n\r\n')
  const resp = await exchange(raw); await L.settled(1)
  const entry = L.mock.state.log.find((e) => e.type === 'request')
  assert.ok(resp.equals(b64(entry.resp_raw_b64))); assert.equal(L.envelopes.length, 1)
  const f = L.flows[0]
  assert.deepEqual([f.decision, f.inner, f.not_captured, f.reason], ['tunnel', 'decrypt', undefined, null])
  assert.equal(b64(f.prelude.client_b64).toString('latin1'), H1 + H2)
  assert.equal(b64(f.prelude.proxy_b64).toString('latin1'), R407 + 'HTTP/1.1 200 Connection established\r\n\r\n')
})

test('review B · after a 407 the client gives up: proxy-refused, no error; the proxy closing lets the client read the whole refusal', T, async (t) => {
  const L = await lab(t, { kind: 'connect' }, { dst: (_, mockPort) => authProxy(t, mockPort) })
  const raw = net.connect(L.port, '127.0.0.1'); await once(raw, 'connect'); raw.on('error', () => {})
  let got = ''; raw.on('data', (d) => { got += d.toString('latin1') })
  raw.write(H1)
  for (let i = 0; i < 200 && !got.endsWith('nope!'); i++) await sleep(5)
  raw.end(); await L.settled(1)
  assert.deepEqual([L.flows[0].decision, L.flows[0].not_captured, L.flows[0].reason, L.flows[0].error], ['tunnel', 'proxy-refused', 'proxy-status-407', undefined])
  const M = await lab(t, { kind: 'connect' }, { dst: (_, mockPort) => authProxy(t, mockPort, { closeAfterRefusal: true }) })
  const c = net.connect(M.port, '127.0.0.1'); await once(c, 'connect'); c.on('error', () => {})
  let got2 = ''; c.on('data', (d) => { got2 += d.toString('latin1') }); c.write(H1)
  await once(c, 'end'); c.destroy(); await M.settled(1)
  assert.equal(got2, R407 + 'nope!', 'the body was drained, not cut')
  assert.deepEqual([M.flows[0].not_captured, M.flows[0].error], ['proxy-refused', undefined])
})

// review C #2: the retried CONNECT is still waiting for the proxy when the client goes — the row is coded (D38)
test('review C · CONNECT retried after a 407, the client goes before the proxy answers: the row says not captured · error', T, async (t) => {
  const L = await lab(t, { kind: 'connect' }, { dst: (_, mockPort) => authProxy(t, mockPort, { silentOnRetry: true }) })
  const raw = net.connect(L.port, '127.0.0.1'); await once(raw, 'connect'); raw.on('error', () => {})
  let got = ''; raw.on('data', (d) => { got += d.toString('latin1') })
  raw.write(H1)
  for (let i = 0; i < 200 && !got.endsWith('nope!'); i++) await sleep(5)
  raw.write(H2); await sleep(50); raw.end(); await L.settled(1)
  assert.equal(L.flows.length, 1)
  const f = L.flows[0]
  assert.deepEqual([f.decision, f.inner, f.not_captured, f.error?.type, f.error?.side], ['tunnel', undefined, 'error', 'closed_before_decision', 'client'])
  assert.equal(b64(f.prelude.client_b64).toString('latin1'), H1, 'the prelude holds the round trips that completed')
})

// review C #3: the https:// proxy table against the policy — a listed proxy that is not the process's own is
// terminated when the policy covers its host; an own proxy keeps an h2-only offer and a daemon code
test('review C · a listed https:// proxy that is not the process\'s own, under `all`: terminated (the policy covers it), via_proxy keeps its source', T, async (t) => {
  const L = await lab(t, { kind: 'connect', tls: true }, { proxies: table(false), policy: () => true })
  const r = await httpsProxyClient(L.port, asightCa.certPem); await L.settled(1)
  assert.match(r.issuer, /asight collector CA/)
  const entry = L.mock.state.log.find((e) => e.type === 'request'); assert.ok(r.resp.equals(b64(entry.resp_raw_b64)))
  const f = L.flows.at(-1)
  assert.deepEqual([f.decision, f.inner, f.not_captured], ['tunnel', 'decrypt', undefined])
  assert.deepEqual(f.via_proxy, { scheme: 'https', host: PROXY_HOST, port: L.proxy.port, source: 'env:HTTPS_PROXY', terminated: true })
  assert.equal(L.engine.stats().notCaptured.httpsProxy, 0)
})

test('review C · an own https:// proxy offered only h2: spliced, not captured · h2 (the own-proxy rule does not lift it)', T, async (t) => {
  const L = await lab(t, { kind: 'connect', tls: true }, { proxies: table(true), policy: onlyApi })
  const outer = tls.connect({ port: L.port, host: '127.0.0.1', servername: PROXY_HOST, ca: fs.readFileSync(L.labCa.caCert), ALPNProtocols: ['h2'] })
  outer.on('error', () => {})
  await once(outer, 'secureConnect')
  assert.match(outer.getPeerX509Certificate().issuer, /lab/i, 'the client reached the proxy itself')
  outer.end(); await L.settled(1)
  const f = L.flows[0]
  assert.deepEqual([f.decision, f.not_captured, f.reason, f.via_proxy.terminated], ['splice', 'h2', 'alpn-h2-only', false])
})

test('review C · an own https:// proxy of a process the daemon says is not on the trust path: spliced, not-trust-path is kept', T, async (t) => {
  const L = await lab(t, { kind: 'connect', tls: true }, { proxies: table(true), policy: () => ({ not_captured: 'not-trust-path', reason: 'no NODE_EXTRA_CA_CERTS' }) })
  const r = await httpsProxyClient(L.port, fs.readFileSync(L.labCa.caCert)); await L.settled(1)
  assert.match(r.issuer, /lab/i); assert.equal(L.envelopes.length, 0)
  const f = L.flows[0]
  assert.deepEqual([f.decision, f.not_captured, f.reason, f.via_proxy.terminated], ['splice', 'not-trust-path', 'no NODE_EXTRA_CA_CERTS', false])
})
