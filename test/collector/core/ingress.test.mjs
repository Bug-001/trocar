// ingress.test.mjs — the engine's proxy ingress (RFC 4.8 §5.1 · §5.2 · §5.5; acceptance W13, W15, W17). A real engine on loopback, the static
// redirector's lookupIngress, a plain TCP echo as the upstream and, where a proxy is the upstream, the mock proxy. No mihomo here: the
// health probe is replayed from the bytes the REAL mihomo sent (test/netenv/fixtures/mihomo-probe.bytes, recorded by the W57 contract test).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { parseAuthority } from '../../../src/collector/core/engine/ingress.mjs'
import { startMockProxy } from '../../lab/mock-upstream/proxy.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { checkRecord } from '../../../src/health/codes.mjs'
import { within, closeWithin } from '../../helpers/bounded.mjs'

const T = { timeout: 20_000 }
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE = fs.readFileSync(path.join(HERE, '..', '..', 'netenv', 'fixtures', 'mihomo-probe.bytes'), 'latin1')
const TOKEN = '0123456789abcdef0123456789abcdef' // the token inside the recorded probe bytes: a fixture value, never a real one
const USER = 'vb.spike'
const HEALTH_PORT = 18000 // the re-entry point the recorded bytes are normalised to
const basic = (user, pass) => `Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}\r\n`
const connectHead = (target, { user = USER, pass = TOKEN, auth = true } = {}) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? basic(user, pass) : ''}\r\n`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const asightCa = createCa()

// a client socket with the reads a handshake needs; every wait is bounded (test/helpers/bounded.mjs)
function client(port) {
  const sock = net.connect(port, '127.0.0.1'); sock.on('error', () => {})
  let buf = Buffer.alloc(0), wake = null, ended = false
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); if (wake) wake() })
  sock.on('close', () => { ended = true; if (wake) wake() })
  const until = (pred, what) => within((async () => { while (!pred() && !ended) { await new Promise((r) => { wake = r }); wake = null } })(), 4000, what, () => sock.destroy())
  const c = {
    sock,
    write: (b) => sock.write(b),
    get buf() { return buf },
    async bytes(n) { await until(() => buf.length >= n, `${n} bytes`); const b = buf.subarray(0, n); buf = buf.subarray(n); return b },
    async head() { await until(() => buf.includes('\r\n\r\n'), 'a response head'); const i = buf.indexOf('\r\n\r\n') + 4; const b = buf.subarray(0, i); buf = buf.subarray(i); return b.toString('latin1') },
    async closed() { await until(() => false, 'the close'); return true },
    get ended() { return ended },
  }
  return c
}

async function lab(t, { meta = {}, timing = {}, connectUpstream, redirector = createStaticRedirector(), noToken = false, upstreamCa } = {}) {
  const flows = [], failures = [], envelopes = []
  const upConns = []
  const echo = net.createServer((s) => { upConns.push(s); s.on('error', () => {}); s.pipe(s) })
  await new Promise((r) => echo.listen(0, '127.0.0.1', r))
  const echoPort = echo.address().port
  // the group's health target is the recorded 127.0.0.1:18000; every other target is an agent's connection
  redirector.setIngress(USER, ({ target }) => (target.address === '127.0.0.1' && target.port === HEALTH_PORT ? { health: true, group: 'spike' }
    : { pid: 4242, agent: 'claude-code', decrypt: false, capture: 'vpn-block', form: 'claude-code.cli', pid_source: 'socket-table', pid_ms: 7, negKey: '4242', upstream: { kind: 'direct' }, ...meta }))
  const dials = [] // every upstream the engine was asked to open, whoever asked
  const connect = (d) => { dials.push({ ...d }); return connectUpstream ? connectUpstream(d) : net.connect(d.port, d.address) }
  const engine = createEngine({
    redirector, issuer: createLeafIssuer(loadCa(asightCa)), connectUpstream: connect, timing, upstreamCa,
    store: { envelope: (e) => { envelopes.push(e); return true }, flow: (f) => { flows.push(structuredClone(f)); return true } },
    onFailure: (f) => failures.push(f), ...(noToken ? {} : { ingressToken: TOKEN }),
  })
  const { ingressPort } = await engine.listen({ ingress: { port: 0 } })
  const made = []
  t.after(async () => { for (const c of made) c.sock.destroy(); echo.close(); for (const s of upConns) s.destroy(); await closeWithin(engine) })
  const settled = async (n) => { for (let i = 0; i < 400 && flows.length < n; i++) await sleep(10) }
  return { engine, ingressPort, echo, echoPort, upConns, dials, flows, failures, envelopes, redirector, settled, client: () => { const c = client(ingressPort); made.push(c); return c } }
}

test('W13 CONNECT with the right credentials: the upstream is dialled, then 200; the agent\'s bytes go through; the row says how it came and carries no prelude', T, async (t) => {
  const L = await lab(t)
  const c = L.client(); c.write(connectHead(`127.0.0.1:${L.echoPort}`))
  assert.match(await c.head(), /^HTTP\/1\.1 200 /)
  assert.equal(L.upConns.length, 1, 'the upstream was dialled before the 200 was said')
  c.write('ping!'); assert.equal((await c.bytes(5)).toString(), 'ping!')
  c.sock.end(); await L.settled(1)
  const [row] = L.flows
  assert.deepEqual([row.pid, row.agent, row.dst, row.decision, row.not_captured], [4242, 'claude-code', { address: '127.0.0.1', port: L.echoPort, family: 4 }, 'splice', 'unknown-protocol'])
  assert.deepEqual(row.ingress, { route: 'vb', group: 'spike' })
  assert.deepEqual([row.pid_source, row.pid_ms, row.upstream], ['socket-table', 7, { kind: 'direct' }])
  assert.equal('prelude' in row, false, 'the CONNECT is mihomo\'s, with asight\'s token: it is not recorded as the agent\'s prelude (invariant 4)')
  assert.deepEqual([row.bytes_up, row.bytes_down], [5, 5], 'the agent\'s own bytes: the opener and asight\'s 200 are not counted')
  assert.deepEqual(L.failures, [])
  assert.deepEqual(L.engine.stats().ingress, { connections: 1, flows: 1, health: 0, authFailed: 0, unknown: 0, refused: 0, unreachable: 0 })
})

test('W13 an agent that speaks at once (its first bytes arrive with the CONNECT) loses nothing', T, async (t) => {
  const L = await lab(t)
  const c = L.client(); c.write(connectHead(`127.0.0.1:${L.echoPort}`) + 'ping!')
  assert.match(await c.head(), /^HTTP\/1\.1 200 /)
  assert.equal((await c.bytes(5)).toString(), 'ping!')
  await L.settled(0); assert.deepEqual(L.failures, [])
})

test('W13 the 200 waits for the upstream: nothing is said to the client until the direct upstream has connected', T, async (t) => {
  let connectIt
  const fake = new PassThrough(); fake.connecting = true // a socket whose TCP connect is still in flight
  const L = await lab(t, { connectUpstream: () => { new Promise((r) => { connectIt = r }).then(() => { fake.connecting = false; fake.emit('connect') }); return fake } })
  const c = L.client(); c.write(connectHead('203.0.113.7:443'))
  await sleep(250); assert.equal(c.buf.length, 0, 'not a byte to the client while the upstream connect is pending')
  await within((async () => { while (!connectIt) await sleep(5) })(), 2000, 'the ingress to dial'); connectIt()
  assert.match(await c.head(), /^HTTP\/1\.1 200 /)
  c.sock.destroy(); fake.destroy()
})

test('W13 a wrong token is 407, with no upstream connection and one ingress-auth-failed that does not carry the token; no credentials at all, and an unknown user, the same', T, async (t) => {
  const L = await lab(t)
  const target = `127.0.0.1:${L.echoPort}`
  for (const [what, head] of [['token', connectHead(target, { pass: 'f'.repeat(32) })], ['no header', connectHead(target, { auth: false })], ['unknown user', connectHead(target, { user: 'vb.nobody' })]]) {
    const c = L.client(); c.write(head)
    assert.match(await c.head(), /^HTTP\/1\.1 407 Proxy Authentication Required\r\n/, what)
    await c.closed()
  }
  assert.equal(L.upConns.length, 0, 'zero upstream connections')
  assert.deepEqual(L.failures.map((f) => [f.event, f.where, f.code, f.reason]), [
    ['failure', 'ingress', 'ingress-auth-failed', 'token mismatch'], ['failure', 'ingress', 'ingress-auth-failed', 'no Proxy-Authorization'], ['failure', 'ingress', 'ingress-auth-failed', 'unknown user']])
  for (const f of L.failures) assert.deepEqual(checkRecord(f), [], 'a record the closed sets accept')
  assert.equal(JSON.stringify(L.failures).includes(TOKEN) || JSON.stringify(L.failures).includes('ffffffff'), false, 'no token, wrong or right, is written')
  assert.equal(L.flows.length, 0); assert.equal(L.engine.stats().ingress.authFailed, 3)
})

test('W13 SOCKS5 with username/password: the token is checked, the upstream dialled, the success said last; a wrong token is an authentication failure', T, async (t) => {
  const L = await lab(t)
  const auth = (user, pass) => Buffer.concat([Buffer.from([1, user.length]), Buffer.from(user), Buffer.from([pass.length]), Buffer.from(pass)])
  const req = (host, port) => Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host), Buffer.from([port >> 8, port & 255])])
  const c = L.client(); c.write(Buffer.from([5, 1, 2]))
  assert.deepEqual([...await c.bytes(2)], [5, 2])
  c.write(auth(USER, TOKEN)); assert.deepEqual([...await c.bytes(2)], [1, 0])
  c.write(req('127.0.0.1', L.echoPort)); assert.deepEqual([...await c.bytes(10)], [5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
  assert.equal(L.upConns.length, 1)
  c.write('ping!'); assert.equal((await c.bytes(5)).toString(), 'ping!')
  c.sock.end(); await L.settled(1)
  assert.deepEqual([L.flows[0].ingress, L.flows[0].upstream, 'prelude' in L.flows[0]], [{ route: 'vb', group: 'spike' }, { kind: 'direct' }, false])
  assert.deepEqual([L.flows[0].bytes_up, L.flows[0].bytes_down], [5, 5])

  const bad = L.client(); bad.write(Buffer.from([5, 1, 2])); await bad.bytes(2)
  bad.write(auth(USER, 'e'.repeat(32))); assert.deepEqual([...await bad.bytes(2)], [1, 1]); await bad.closed()
  const none = L.client(); none.write(Buffer.from([5, 1, 0])) // offers no-auth only: the ingress takes no credentials-free client
  assert.deepEqual([...await none.bytes(2)], [5, 0xff]); await none.closed()
  assert.equal(L.upConns.length, 1, 'neither refused client reached the upstream')
  assert.deepEqual(L.failures.map((f) => [f.where, f.code, f.reason]), [['ingress', 'ingress-auth-failed', 'token mismatch'], ['ingress', 'ingress-auth-failed', 'no username/password method offered']])
})

test('W13 the health probe, replayed from the bytes the real mihomo sent: 200, then 204 for each HEAD, on a kept-alive tunnel; no upstream, no flows/ row, no envelope', T, async (t) => {
  const L = await lab(t)
  const [open, ...heads] = PROBE.split('\r\n\r\n').filter(Boolean).map((m) => `${m}\r\n\r\n`)
  assert.match(open, /^CONNECT 127\.0\.0\.1:18000 HTTP\/1\.1\r\n/); assert.equal(heads.length, 2, 'unified-delay: two HEADs in the tunnel')
  // as mihomo does: the HEAD goes out only after the 200
  const c = L.client(); c.write(open)
  assert.match(await c.head(), /^HTTP\/1\.1 200 /)
  for (const h of heads) { c.write(h); assert.equal(await c.head(), 'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n') }
  c.sock.end(); await c.closed()
  // and all at once (an eager client), over a second connection
  const e = L.client(); e.write(PROBE)
  assert.match(await e.head(), /^HTTP\/1\.1 200 /)
  for (let i = 0; i < 2; i++) assert.equal(await e.head(), 'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n')
  e.sock.end(); await e.closed()
  assert.equal(L.upConns.length, 0, 'the probe never leaves the machine: no upstream connection'); assert.deepEqual(L.dials, [], 'the engine was not even asked to dial')
  assert.equal(L.flows.length, 0); assert.equal(L.envelopes.length, 0)
  assert.deepEqual(L.failures, [])
  assert.deepEqual([L.engine.stats().ingress.health, L.engine.stats().ingress.flows], [2, 0])
})

test('W13 the same probe bytes to a target that is not the group\'s re-entry point are an ordinary CONNECT', T, async (t) => {
  const L = await lab(t)
  const [open, head1] = PROBE.split('\r\n\r\n').filter(Boolean).map((m) => `${m}\r\n\r\n`)
  const c = L.client(); c.write(open.replace('127.0.0.1:18000 HTTP', `127.0.0.1:${L.echoPort} HTTP`))
  assert.match(await c.head(), /^HTTP\/1\.1 200 /)
  assert.equal(L.upConns.length, 1, 'dialled like any agent connection')
  c.write(head1); assert.equal((await c.bytes(head1.length)).toString('latin1'), head1, 'the HEAD is an agent\'s byte here: it went through to the upstream and came back')
  c.sock.end(); await L.settled(1)
  assert.equal(L.flows[0].dst.port, L.echoPort)
})

test('W13 a request inside the health tunnel that is not the probe closes it and is not silent', T, async (t) => {
  const L = await lab(t)
  const c = L.client(); c.write(connectHead(`127.0.0.1:${HEALTH_PORT}`)); assert.match(await c.head(), /^HTTP\/1\.1 200 /)
  c.write('GET /v1/messages HTTP/1.1\r\nHost: x\r\n\r\n'); await c.closed()
  assert.deepEqual(L.failures.map((f) => [f.where, f.code]), [['ingress', 'ingress-unknown']])
  assert.match(L.failures[0].reason, /inside the health tunnel/)
  const d = L.client(); d.write(connectHead(`127.0.0.1:${HEALTH_PORT}`)); await d.head()
  d.write('HEAD /asight-health/another-group HTTP/1.1\r\nHost: x\r\n\r\n'); await d.closed() // the probe of a group that is not this one's
  assert.equal(L.failures.length, 2)
})

test('W13 an absolute-URI GET, a TLS hello and other bytes that are not CONNECT or SOCKS5 are closed with ingress-unknown; no upstream is dialled', T, async (t) => {
  const L = await lab(t)
  for (const bytes of ['GET http://asight-health.invalid/spike HTTP/1.1\r\nHost: asight-health.invalid\r\n\r\n', Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 1, 2, 3, 4, 5]), 'hello there, this is not a proxy request\r\n\r\n', 'POST /x HTTP/1.1\r\n\r\n']) {
    const c = L.client(); c.write(bytes); await c.closed()
  }
  assert.equal(L.upConns.length, 0)
  assert.deepEqual(L.failures.map((f) => [f.where, f.code]), Array(4).fill(['ingress', 'ingress-unknown']))
  assert.match(L.failures[0].reason, /GET/); assert.match(L.failures[1].reason, /0x16/)
  assert.equal(JSON.stringify(L.failures).includes('asight-health.invalid'), false, 'the reason names the method, not what the client put in the URL')
  assert.equal(L.engine.stats().ingress.unknown, 4)
})

test('W13 a SOCKS5 target that is not a name or an address (control bytes would go into a proxy prelude) is refused, and an upstream kind the ingress does not dial is a 502 with a row', T, async (t) => {
  const L = await lab(t, { meta: { upstream: { kind: 'gopher', host: '127.0.0.1', port: 1 } } })
  const s = L.client(); s.write(Buffer.from([5, 1, 2])); await s.bytes(2)
  s.write(Buffer.concat([Buffer.from([1, USER.length]), Buffer.from(USER), Buffer.from([TOKEN.length]), Buffer.from(TOKEN)])); await s.bytes(2)
  const evil = 'a.test\r\nProxy-Authorization: x'
  s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, evil.length]), Buffer.from(evil), Buffer.from([1, 187])]))
  assert.equal((await s.bytes(10))[1], 8, 'address type not supported'); await s.closed()
  assert.deepEqual(L.failures.map((f) => [f.code, /not a host name/.test(f.reason)]), [['ingress-unknown', true]]); assert.deepEqual(L.dials, [])
  const c = L.client(); c.write(connectHead('upstream.test:443'))
  assert.match(await c.head(), /^HTTP\/1\.1 502 /); await L.settled(1)
  assert.deepEqual([L.flows[0].decision, L.flows[0].error.type, L.dials.length], ['error', 'unsupported_upstream', 0])
})

test('W13 a malformed CONNECT target, and a client that never finishes its opener, are ingress-unknown; one that goes before sending anything is not an event', T, async (t) => {
  const L = await lab(t, { timing: { ingressOpenerMs: 150 } })
  const c = L.client(); c.write(connectHead('no-port-here')); await c.closed()
  const d = L.client(); d.write('CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: x\r\n'); await d.closed() // the blank line never comes
  const e = L.client(); await e.closed() // sends nothing: the opener times out
  const g = L.client(); g.sock.destroy(); await g.closed() // goes at once: nobody was asked anything
  assert.deepEqual(L.failures.map((f) => [f.code, /not host:port|no complete CONNECT|no opener/.exec(f.reason)?.[0]]), [['ingress-unknown', 'not host:port'], ['ingress-unknown', 'no complete CONNECT'], ['ingress-unknown', 'no opener']])
})

test('W13 an upstream that cannot be reached is a 502, never a 200 first; the row says the upstream failed, and the agent was told 502', T, async (t) => {
  const L = await lab(t)
  const dead = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  const c = L.client(); c.write(connectHead(`127.0.0.1:${dead}`))
  assert.match(await c.head(), /^HTTP\/1\.1 502 Bad Gateway\r\n/); await c.closed()
  await L.settled(1)
  const [row] = L.flows
  assert.deepEqual([row.decision, row.not_captured, row.error.type, row.error.side, row.pid, row.ingress], ['error', 'error', 'ECONNREFUSED', 'upstream', 4242, { route: 'vb', group: 'spike' }])
  assert.equal(L.envelopes.length, 0); assert.deepEqual(L.failures, [], 'a row, not an event: the row is the record')
  assert.equal(L.engine.stats().ingress.unreachable, 1)
})

test('W13 a lookup that throws is a 502 and a loader-down record, not a hang; a SOCKS5 client gets a failure reply, not a success', T, async (t) => {
  const redirector = createStaticRedirector(); redirector.lookupIngress = async () => { throw Object.assign(new Error('helper gone'), { code: 'loader-timeout' }) }
  const L = await lab(t, { redirector })
  const c = L.client(); c.write(connectHead('127.0.0.1:9')); assert.match(await c.head(), /^HTTP\/1\.1 502 /); await c.closed()
  assert.deepEqual(L.failures.map((f) => [f.where, f.code]), [['engine', 'loader-timeout']])
  assert.equal(L.failures[0].reason.includes(TOKEN), false)
  const s = L.client(); s.write(Buffer.from([5, 1, 2])); await s.bytes(2)
  s.write(Buffer.concat([Buffer.from([1, USER.length]), Buffer.from(USER), Buffer.from([TOKEN.length]), Buffer.from(TOKEN)])); await s.bytes(2)
  s.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 9]))
  const reply = await s.bytes(10); assert.deepEqual([reply[0], reply[1] !== 0], [5, true], 'a failure reply, never the success a SOCKS5 client would act on'); await s.closed()
})

test('W13 engine.close() ends a half-open handshake and a health tunnel instead of waiting out their idle timeouts; in-flight flows still finish', T, async (t) => {
  const L = await lab(t, { timing: { ingressOpenerMs: 60_000, ingressHealthIdleMs: 60_000 } })
  const h = L.client(); h.write(connectHead(`127.0.0.1:${HEALTH_PORT}`)); await h.head()
  const half = L.client(); half.write('CONNECT 127.0.0.1:1 HTTP/1.1\r\n')
  await sleep(50)
  await closeWithin(L.engine, 3000, 'engine.close() waiting for idle ingress sockets')
  await h.closed(); await half.closed()
})

test('W13 listen(): the ingress listens beside the transparent door; a redirector with no `lookup` has no transparent door; the ingress needs lookupIngress and a token', T, async () => {
  const mk = (redirector, opts = {}) => createEngine({ redirector, issuer: createLeafIssuer(loadCa(createCa())), store: { envelope() {}, flow() {} }, onFailure() {}, ...opts })
  const both = mk(createStaticRedirector(), { ingressToken: TOKEN })
  const r = await both.listen({ ingress: { port: 0 } })
  assert.ok(r.port > 0 && r.ingressPort > 0 && r.port !== r.ingressPort)
  await closeWithin(both)
  const ingressOnly = mk({ lookupIngress: async () => null }, { ingressToken: TOKEN })
  const o = await ingressOnly.listen({ ingress: { port: 0 } })
  assert.equal(o.port, null, 'no `lookup`: no transparent listener'); assert.ok(o.ingressPort > 0)
  await closeWithin(ingressOnly)
  await assert.rejects(() => mk({ lookupIngress: async () => null }).listen({}), /nothing to listen on/)
  await assert.rejects(() => mk({ lookup: async () => null }).listen({ ingress: { port: 0 } }), /no lookupIngress/)
  await assert.rejects(() => mk(createStaticRedirector()).listen({ ingress: { port: 0 } }), /token/)
  const plain = mk(createStaticRedirector()); const p = await plain.listen({}); assert.equal(p.ingressPort, undefined, 'without {ingress} nothing changes for the transparent door'); await closeWithin(plain)
})

test('parseAuthority: host:port, [v6]:port and what is not one', () => {
  assert.deepEqual(parseAuthority('api.anthropic.com:443'), { host: 'api.anthropic.com', port: 443 })
  assert.deepEqual(parseAuthority('127.0.0.1:18000'), { host: '127.0.0.1', port: 18000 })
  assert.deepEqual(parseAuthority('[0:0:0:0:0:0:0:1]:443'), { host: '::1', port: 443 }, 'an IPv6 literal is written compressed, one spelling per host')
  for (const bad of ['', 'host', 'host:', ':443', 'host:0', 'host:65536', 'host:44a', '[::1]', '[::1:443', 'a:b:443', 'ho st:443']) assert.equal(parseAuthority(bad), null, bad)
})

// ── W15: the upstreams · one dial per flow · the step-aside · the user's credentials ───────────────────────────────────────────────
const privCa = createCa({ commonName: 'private origin CA' })
const privIssuer = createLeafIssuer(loadCa(privCa))
const REQ = 'GET /v1/models HTTP/1.1\r\nhost: upstream.test\r\n\r\n'
const RESP = 'HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\nok'
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r))
const b64 = (s) => Buffer.from(s, 'base64')
const CRED = { username: 'u1', password: 'pw-SECRET' }

// A TLS origin signed by a private CA behind a recording tap: what each connection to it received (after any proxy prelude), and sent.
async function origin(t) {
  const srv = tls.createServer({ SNICallback: (n, cb) => cb(null, privIssuer.secureContextFor(n)), ALPNProtocols: ['http/1.1'] }, (s) => {
    let seen = ''; s.on('data', (d) => { seen += d.toString('latin1'); if (seen.includes('\r\n\r\n')) { seen = ''; s.write(RESP) } }); s.on('error', () => {})
  })
  await listen(srv)
  const conns = [], sockets = new Set()
  const front = net.createServer((a) => {
    const rec = { c: [], s: [], done: new Promise((r) => a.once('close', r)) }; conns.push(rec)
    const b = net.connect(srv.address().port, '127.0.0.1'); sockets.add(a); sockets.add(b)
    a.on('data', (d) => { rec.c.push(d); b.write(d) }); b.on('data', (d) => { rec.s.push(d); a.write(d) })
    for (const [x, y] of [[a, b], [b, a]]) { x.on('end', () => y.end()); x.on('error', () => y.destroy()); x.on('close', () => y.destroy()) }
  })
  await listen(front)
  t.after(() => { for (const s of sockets) s.destroy(); front.close(); srv.close() })
  return { port: front.address().port, conns, closed: () => within(Promise.all(conns.map((c) => c.done)), 4000, 'the origin\'s connections to close') }
}
// CONNECT through the ingress; resolves with the raw socket (no listeners left on it) once the head is read
function tunnel(port, target, head = connectHead(target)) {
  const sock = net.connect(port, '127.0.0.1'); sock.on('error', () => {})
  sock.write(head)
  return within(new Promise((res) => {
    let b = Buffer.alloc(0)
    const on = (d) => { b = Buffer.concat([b, d]); const i = b.indexOf('\r\n\r\n'); if (i >= 0) { sock.removeListener('data', on); res({ sock, head: b.subarray(0, i + 4).toString('latin1'), rest: b.subarray(i + 4) }) } }
    sock.on('data', on); sock.once('close', () => res({ sock, head: b.toString('latin1'), closed: true }))
  }), 4000, 'the tunnel head', () => sock.destroy())
}
// a TLS client over the tunnel, as an agent would: what the peer's certificate was issued by and what came back
const talk = (sock, ca) => within(new Promise((resolve) => {
  let issuer = null, got = ''
  const c = tls.connect({ socket: sock, servername: 'upstream.test', ca, ALPNProtocols: ['http/1.1'] }, () => { issuer = c.getPeerX509Certificate().issuer; c.write(REQ) })
  c.on('data', (d) => { got += d.toString('latin1'); if (got.length >= RESP.length) c.end() })
  c.on('error', () => {}); c.on('close', () => resolve(issuer ? { issuer, got } : 'closed'))
}), 6000, 'the TLS exchange over the tunnel', () => sock.destroy())

test('W15 a direct upstream, decrypted: one dial for the whole flow (the wrapper hands the ingress\'s connection over once), the call is recorded under the agent\'s pid', T, async (t) => {
  const o = await origin(t)
  const L = await lab(t, { upstreamCa: privCa.certPem, meta: { decrypt: true } })
  const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`)
  const r = await talk(sock, asightCa.certPem)
  assert.equal(r.got, RESP); assert.match(r.issuer, /asight collector CA/)
  await L.settled(1)
  assert.deepEqual(L.dials, [{ address: '127.0.0.1', port: o.port }], 'one upstream dial for one agent connection'); assert.equal(o.conns.length, 1)
  assert.deepEqual(L.envelopes.map((e) => [e.host, e.proc.pid, e.proc.agent, e.scheme]), [['upstream.test', 4242, 'claude-code', 'https']])
  assert.deepEqual([L.flows[0].decision, L.flows[0].not_captured ?? null, L.flows[0].upstream, 'prelude' in L.flows[0]], ['decrypt', null, { kind: 'direct' }, false])
  assert.deepEqual(L.failures, [])
})

test('W15 an http upstream: the user\'s credentials ride only in asight\'s prelude for the agent\'s connection; the flow is decrypted over one connection to the proxy; the row has neither credentials nor prelude', T, async (t) => {
  const o = await origin(t)
  const proxy = await startMockProxy({ kind: 'connect', target: { port: o.port }, auth: CRED }); t.after(() => proxy.close())
  const L = await lab(t, { upstreamCa: privCa.certPem, meta: { decrypt: true, upstream: { kind: 'http', host: '127.0.0.1', port: proxy.port, auth: CRED } } })
  const { sock, head } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`)
  assert.match(head, /^HTTP\/1\.1 200 /)
  const r = await talk(sock, asightCa.certPem); assert.equal(r.got, RESP); await L.settled(1)
  assert.equal(proxy.log.length, 1, 'one connection to the proxy for one agent connection')
  assert.equal(proxy.log[0].target, `127.0.0.1:${o.port}`); assert.equal(proxy.log[0].ok, true)
  assert.ok(b64(proxy.log[0].in_b64).toString('latin1').includes(`Proxy-Authorization: Basic ${Buffer.from('u1:pw-SECRET').toString('base64')}`), 'the credentials are in the prelude to the proxy')
  assert.deepEqual(L.flows[0].upstream, { kind: 'http', host: '127.0.0.1', port: proxy.port, reply: 200 })
  assert.equal('prelude' in L.flows[0], false)
  for (const [what, v] of [['flows/', L.flows], ['envelopes', L.envelopes], ['failures', L.failures]]) {
    const text = JSON.stringify(v); assert.equal(text.includes('pw-SECRET') || text.includes(Buffer.from('u1:pw-SECRET').toString('base64')), false, `${what} hold no credentials`)
  }
})

test('W15 a socks5 upstream: the target goes as a domain or an address, the credentials by RFC 1929; decrypted; the row says upstream.reply 0', T, async (t) => {
  const o = await origin(t)
  const proxy = await startMockProxy({ kind: 'socks5', target: { port: o.port }, auth: CRED }); t.after(() => proxy.close())
  const L = await lab(t, { upstreamCa: privCa.certPem, meta: { decrypt: true, upstream: { kind: 'socks5', host: '127.0.0.1', port: proxy.port, auth: CRED } } })
  const { sock } = await tunnel(L.ingressPort, 'upstream.test:443') // a name: ATYP 3 (the mock proxy goes to its own target whatever it was asked for)
  const r = await talk(sock, asightCa.certPem); assert.equal(r.got, RESP); await L.settled(1)
  assert.equal(proxy.log.length, 1); assert.equal(proxy.log[0].target, 'upstream.test:443'); assert.equal(proxy.log[0].ok, true)
  assert.deepEqual(L.flows[0].upstream, { kind: 'socks5', host: '127.0.0.1', port: proxy.port, reply: 0 })
  assert.equal(JSON.stringify(L.flows).includes('pw-SECRET'), false)
  const p2 = await startMockProxy({ kind: 'socks5', target: { port: o.port } }); t.after(() => p2.close()) // no credentials, an address literal (v4 and v6)
  const M = await lab(t, { upstreamCa: privCa.certPem, meta: { decrypt: true, upstream: { kind: 'socks5', host: '127.0.0.1', port: p2.port } } })
  for (const target of [`127.0.0.1:${o.port}`, `[::1]:${o.port}`]) { const x = await tunnel(M.ingressPort, target); assert.match(x.head, /^HTTP\/1\.1 200 /); x.sock.destroy() }
  assert.deepEqual(p2.log.map((e) => e.target), [`127.0.0.1:${o.port}`, `[0:0:0:0:0:0:0:1]:${o.port}`])
})

test('W15 the health probe makes zero connections to the user\'s proxy: its credentials are used for agent connections only', T, async (t) => {
  const proxy = await startMockProxy({ kind: 'connect', target: { port: 9 }, auth: CRED }); t.after(() => proxy.close())
  const L = await lab(t, { meta: { upstream: { kind: 'http', host: '127.0.0.1', port: proxy.port, auth: CRED } } })
  const c = L.client(); c.write(PROBE)
  assert.match(await c.head(), /^HTTP\/1\.1 200 /); for (let i = 0; i < 2; i++) assert.match(await c.head(), /^HTTP\/1\.1 204 /)
  assert.deepEqual(proxy.log, []); assert.deepEqual(L.dials, []); assert.equal(L.flows.length, 0)
})

test('W15 the proxy refuses: its own reply goes back verbatim, never a 200 first; the row says proxy-refused with the reply code; no flow', T, async (t) => {
  const refusing = await startMockProxy({ kind: 'connect', target: { port: 9 }, refuse: true }); t.after(() => refusing.close())
  const L = await lab(t, { meta: { upstream: { kind: 'http', host: '127.0.0.1', port: refusing.port } } })
  const c = L.client(); c.write(connectHead('upstream.test:443'))
  assert.equal(await c.head(), 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n', 'the proxy\'s own refusal, byte for byte'); await c.closed(); await L.settled(1)
  const [row] = L.flows
  assert.deepEqual([row.decision, row.not_captured, row.reason, row.upstream.reply, row.host, 'inner' in row, 'prelude' in row], ['tunnel', 'proxy-refused', 'proxy-status-403', 403, 'upstream.test', false, false])
  assert.deepEqual(checkRecord(row), []); assert.equal(L.engine.stats().ingress.refused, 1); assert.equal(L.envelopes.length, 0)
  // wrong credentials for the proxy: the proxy says 403 itself
  const strict = await startMockProxy({ kind: 'connect', target: { port: 9 }, auth: CRED }); t.after(() => strict.close())
  const M = await lab(t, { meta: { upstream: { kind: 'http', host: '127.0.0.1', port: strict.port, auth: { username: 'u1', password: 'wrong' } } } })
  const d = M.client(); d.write(connectHead('upstream.test:443')); assert.match(await d.head(), /^HTTP\/1\.1 403 /); await M.settled(1)
  assert.deepEqual([M.flows[0].not_captured, M.flows[0].reason], ['proxy-refused', 'proxy-status-403'])
  // SOCKS5: the agent's SOCKS5 client gets a failure reply, the row the proxy's reason
  const s5 = await startMockProxy({ kind: 'socks5', target: { port: 9 }, refuse: true }); t.after(() => s5.close())
  const S = await lab(t, { meta: { upstream: { kind: 'socks5', host: '127.0.0.1', port: s5.port } } })
  const e = S.client(); e.write(Buffer.from([5, 1, 2])); await e.bytes(2)
  e.write(Buffer.concat([Buffer.from([1, USER.length]), Buffer.from(USER), Buffer.from([TOKEN.length]), Buffer.from(TOKEN)])); await e.bytes(2)
  e.write(Buffer.from([5, 1, 0, 3, 4, ...Buffer.from('a.zz'), 1, 187])); const rep = await e.bytes(10); assert.notEqual(rep[1], 0); await S.settled(1)
  assert.deepEqual([S.flows[0].not_captured, S.flows[0].reason, S.flows[0].upstream.reply], ['proxy-refused', 'socks5-reply-2', 2])
  const auth5 = await startMockProxy({ kind: 'socks5', target: { port: 9 }, auth: CRED }); t.after(() => auth5.close())
  const A = await lab(t, { meta: { upstream: { kind: 'socks5', host: '127.0.0.1', port: auth5.port, auth: { username: 'u1', password: 'nope' } } } })
  const f = A.client(); f.write(connectHead('a.zz:443')); assert.match(await f.head(), /^HTTP\/1\.1 502 /); await A.settled(1)
  assert.deepEqual([A.flows[0].not_captured, A.flows[0].reason], ['proxy-refused', 'socks5-auth-failed'])
})

test('W15 the proxy cannot be reached or hangs up mid-prelude: 502 and a row with the error; the 200 is said only once the proxy has answered', T, async (t) => {
  const dead = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  const L = await lab(t, { meta: { upstream: { kind: 'http', host: '127.0.0.1', port: dead } } })
  const c = L.client(); c.write(connectHead('upstream.test:443')); assert.match(await c.head(), /^HTTP\/1\.1 502 /); await L.settled(1)
  assert.deepEqual([L.flows[0].decision, L.flows[0].error.type, L.flows[0].upstream.kind], ['error', 'ECONNREFUSED', 'http'])
  // a proxy that takes its time: no byte reaches the agent before the proxy's own answer
  let release, held = null
  const slow = net.createServer((s) => { held = s; s.on('error', () => {}); s.once('data', () => { new Promise((r) => { release = r }).then(() => s.write('HTTP/1.1 200 Connection established\r\n\r\n')) }) })
  await listen(slow); t.after(() => { slow.close(); if (held) held.destroy() })
  const M = await lab(t, { meta: { upstream: { kind: 'http', host: '127.0.0.1', port: slow.address().port } } })
  const d = M.client(); d.write(connectHead('upstream.test:443'))
  await sleep(200); assert.equal(d.buf.length, 0, 'nothing is said to the agent while the proxy has not answered')
  await within((async () => { while (!release) await sleep(5) })(), 2000, 'the proxy to receive the prelude'); release()
  assert.match(await d.head(), /^HTTP\/1\.1 200 /)
  const hang = net.createServer((s) => { s.on('error', () => {}); s.once('data', () => s.destroy()) }); await listen(hang); t.after(() => hang.close())
  const H = await lab(t, { meta: { upstream: { kind: 'http', host: '127.0.0.1', port: hang.address().port } } })
  const e = H.client(); e.write(connectHead('upstream.test:443')); assert.match(await e.head(), /^HTTP\/1\.1 502 /); await H.settled(1)
  assert.equal(H.flows[0].error.type, 'proxy_closed')
})

test('W15 bytes that reach the agent\'s upstream in the same chunk as the proxy\'s 200 are the upstream speaking first: kept, in order, and labelled', T, async (t) => {
  const early = net.createServer((s) => { s.on('error', () => {}); s.once('data', () => s.write('HTTP/1.1 200 Connection established\r\n\r\nHELLO')) })
  await listen(early); t.after(() => early.close())
  const L = await lab(t, { meta: { upstream: { kind: 'http', host: '127.0.0.1', port: early.address().port } } })
  const c = L.client(); c.write(connectHead('upstream.test:443'))
  assert.match(await c.head(), /^HTTP\/1\.1 200 /); assert.equal((await c.bytes(5)).toString(), 'HELLO')
  c.sock.end(); await L.settled(1)
  assert.deepEqual([L.flows[0].decision, L.flows[0].not_captured], ['splice', 'upstream-first'])
})

// The step-aside (4.6 让路): the engine does not trust the origin's CA, the agent does: the engine drops its own handshake and the agent meets the real
// upstream with its own ClientHello. Through the ingress that second dial is a handshake with the proxy again — unless the proxy is the user's and
// wants their credentials, which asight does not send twice (invariant 1).
const front = async (t, port) => { // a tap in front of the ingress: the bytes the agent sent
  const conns = []; const socks = new Set()
  const srv = net.createServer((a) => { const rec = []; conns.push(rec); const b = net.connect(port, '127.0.0.1'); socks.add(a); socks.add(b)
    a.on('data', (d) => { rec.push(d); b.write(d) }); b.on('data', (d) => a.write(d))
    for (const [x, y] of [[a, b], [b, a]]) { x.on('end', () => y.end()); x.on('error', () => y.destroy()); x.on('close', () => y.destroy()) } })
  await listen(srv); t.after(() => { for (const s of socks) s.destroy(); srv.close() })
  return { port: srv.address().port, conns }
}
for (const kind of ['direct', 'http (no credentials)', 'socks5 (no credentials)']) {
  test(`W15 step-aside over a ${kind} upstream: dialled again, the ClientHello arrives byte for byte, the agent's own handshake succeeds`, T, async (t) => {
    const o = await origin(t)
    const proxy = kind === 'direct' ? null : await startMockProxy({ kind: kind.startsWith('http') ? 'connect' : 'socks5', target: { port: o.port } })
    if (proxy) t.after(() => proxy.close())
    const L = await lab(t, { meta: { decrypt: true, ...(proxy ? { upstream: { kind: kind.startsWith('http') ? 'http' : 'socks5', host: '127.0.0.1', port: proxy.port } } : {}) } }) // no upstreamCa: the origin's CA is not trusted
    const tap = await front(t, L.ingressPort)
    const head = connectHead(`127.0.0.1:${o.port}`)
    const { sock, head: reply } = await tunnel(tap.port, `127.0.0.1:${o.port}`, head)
    assert.match(reply, /^HTTP\/1\.1 200 /)
    const r = await talk(sock, privCa.certPem)
    assert.equal(r.got, RESP); assert.match(r.issuer, /private origin CA/, 'the agent met the real upstream')
    await L.settled(1); await o.closed()
    assert.equal(o.conns.length, 2, 'the engine\'s dropped handshake, then the agent\'s own')
    if (proxy) assert.equal(proxy.log.length, 2, 'two connections to the proxy: the second is a fresh prelude')
    const sent = Buffer.concat(tap.conns[0]).subarray(Buffer.byteLength(head))
    assert.ok(sent.equals(Buffer.concat(o.conns[1].c)), 'agent → upstream bytes identical on the second connection')
    assert.ok(!Buffer.concat(o.conns[0].c).includes(sent.subarray(11, 43)), 'none of the agent\'s bytes (its ClientHello random) went on the unverified connection')
    assert.deepEqual([L.flows[0].decision, L.flows[0].not_captured], ['splice', 'upstream-cert']); assert.equal(L.envelopes.length, 0)
    assert.deepEqual(L.flows[0].upstream.kind, kind.split(' ')[0])
  })
}

test('W15 step-aside over an upstream that carries the user\'s credentials: the flow is closed, no second credentialed connection is opened', T, async (t) => {
  const o = await origin(t)
  for (const kind of ['connect', 'socks5']) {
    const proxy = await startMockProxy({ kind, target: { port: o.port }, auth: CRED }); t.after(() => proxy.close())
    const L = await lab(t, { meta: { decrypt: true, upstream: { kind: kind === 'connect' ? 'http' : 'socks5', host: '127.0.0.1', port: proxy.port, auth: CRED } } })
    const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`)
    assert.equal(await talk(sock, privCa.certPem), 'closed', `${kind}: the agent's connection is closed, not re-dialled`); await L.settled(1)
    assert.equal(proxy.log.length, 1, `${kind}: one prelude with the user's credentials, no second`)
    assert.deepEqual([L.flows[0].decision, L.flows[0].not_captured, L.flows[0].error.type], ['error', 'upstream-cert', 'upstream_cert'])
    assert.equal(JSON.stringify(L.flows).includes('pw-SECRET'), false)
    // the retry splices at once (negative cache): one more connection, again with the credentials, and the agent meets the real upstream
    const again = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`)
    assert.equal((await talk(again.sock, privCa.certPem)).got, RESP); await L.settled(2)
    assert.deepEqual([L.flows[1].decision, L.flows[1].not_captured], ['splice', 'negative-cache']); assert.equal(proxy.log.length, 2)
  }
})

// ── W17: the negative cache has a key of its own for a connection with no pid (4.8 §5.5) ─────────────────────────────────────────────
test('W17 two forms with no pid: one that rejects the leaf does not poison the other\'s same host; clearing by form clears only that form; every event carries neg_key', T, async (t) => {
  const o = await origin(t)
  const L = await lab(t, { upstreamCa: privCa.certPem })
  const pidless = (negKey) => ({ pid: null, agent: 'claude-code', decrypt: true, capture: 'vpn-block', form: negKey, pid_source: null, pid_ms: 3, negKey, upstream: { kind: 'direct' } })
  L.redirector.setIngress('vb.claude-code.cli', pidless('vb.claude-code.cli')); L.redirector.setIngress('vb.codex.app', pidless('vb.codex.app'))
  const go = async (user, ca) => { const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`, connectHead(`127.0.0.1:${o.port}`, { user })); return talk(sock, ca) }
  let n = 0; const next = async () => { await L.settled(++n) }
  // form A's client does not trust the asight CA: it rejects the leaf, twice in a row → (A, host) is negative
  assert.equal(await go('vb.claude-code.cli', privCa.certPem), 'closed'); await next()
  assert.equal(L.engine.negatives().length, 0, 'one rejection is not enough')
  assert.equal(await go('vb.claude-code.cli', privCa.certPem), 'closed'); await next()
  assert.deepEqual(L.engine.negatives().map((e) => [e.pid, e.negKey, e.host, e.cause, e.rejections]), [[null, 'vb.claude-code.cli', 'upstream.test', 'client-rejected-leaf', 2]])
  const neg = L.failures.filter((f) => f.code === 'negative-cache')
  assert.deepEqual(neg.map((f) => [f.where, f.pid, f.neg_key, f.host, f.cause]), [['engine', null, 'vb.claude-code.cli', 'upstream.test', 'client-rejected-leaf']], 'the write is a failure event, once, with its neg_key')
  assert.match(neg[0].reason, /vb\.claude-code\.cli/); assert.deepEqual(checkRecord(neg[0]), [])
  // form A's next connection to that host is spliced; form B's connection to the SAME host is still decrypted
  const spliced = await go('vb.claude-code.cli', privCa.certPem); await next()
  assert.deepEqual([spliced.got, spliced.issuer.includes('private origin CA')], [RESP, true]); assert.deepEqual([L.flows[2].decision, L.flows[2].not_captured], ['splice', 'negative-cache'])
  const other = await go('vb.codex.app', asightCa.certPem); await next()
  assert.match(other.issuer, /asight collector CA/, 'the other form is untouched'); assert.deepEqual([L.flows[3].decision, L.flows[3].not_captured ?? null], ['decrypt', null])
  assert.deepEqual(L.failures.filter((f) => f.code === 'negative-cache').length, 1)
  // the last process of form A has gone: clear by form; B's entries (none here) and a pid's are not touched
  assert.equal(L.engine.forgetPid(4242), 0, 'a pid is not a form key')
  assert.equal(L.engine.forgetNegKey('vb.codex.app'), 0); assert.equal(L.engine.negatives().length, 1)
  assert.equal(L.engine.forgetNegKey('vb.claude-code.cli'), 1); assert.deepEqual(L.engine.negatives(), [])
  const again = await go('vb.claude-code.cli', asightCa.certPem); await next()
  assert.match(again.issuer, /asight collector CA/, 'decrypted again after the clearing')
})

test('W17 a connection whose pid is known keeps the (pid, host) key: neg_key is "<pid>"', T, async (t) => {
  const o = await origin(t)
  const L = await lab(t, { upstreamCa: privCa.certPem, meta: { decrypt: true, pid: 77, negKey: '77' } })
  for (let i = 1; i <= 2; i++) { const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`); assert.equal(await talk(sock, privCa.certPem), 'closed'); await L.settled(i) }
  assert.deepEqual(L.failures.filter((f) => f.code === 'negative-cache').map((f) => [f.pid, f.neg_key]), [[77, '77']])
  assert.equal(L.engine.forgetPid(77), 1)
})

// the drain gate (CLI T5, 1.6 §1.3): an ingress flow mid-SSE when the switch goes off closes at the response end, like a transparent one
test('W15 drain: an ingress flow mid-SSE when the switch goes off ends at the response end (the CLI plan\'s T5 gate)', { skip: 'CLI T5 (`off` drains in-flight calls, `Connection: close`) is not on this branch: the ingress flows go through the same handleFlow, so they will drain the same way; this runs once T5 lands' }, () => {})
