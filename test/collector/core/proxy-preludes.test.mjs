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
async function lab(t, proxyOpts, { proxies = () => [], trustLab = true, dst = null, policy = () => true, decrypt = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-proxy-'))
  const labCa = makeLabCa(path.join(dir, 'ca'))
  const tlsOpts = { key: fs.readFileSync(labCa.key), cert: fs.readFileSync(labCa.cert) }
  const mock = await startMockUpstream({ tls: tlsOpts })
  const proxy = await startMockProxy({ target: { port: mock.port }, ...proxyOpts, ...(proxyOpts.tls ? { tls: tlsOpts } : {}) })
  const store = createRecordStore({ root: path.join(dir, 'rec') })
  const envelopes = [], flows = [], failures = []
  const port0 = dst ? await dst(proxy.port) : proxy.port
  const engine = createEngine({
    redirector: createStaticRedirector({ dst: { address: '127.0.0.1', port: port0, family: 4 }, pid: 21, agent: 'kimi', decrypt }), policy,
    issuer: createLeafIssuer(loadCa(asightCa)), upstreamCa: trustLab ? fs.readFileSync(labCa.caCert) : undefined,
    store: { envelope: (e) => { envelopes.push(e); return store.envelope(e) }, flow: (f) => { flows.push(structuredClone(f)); return store.flow(f) }, failure: (f) => { failures.push(f); return store.failure(f) } },
    describe: () => ({ proxies: proxies(proxy.port) }),
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
