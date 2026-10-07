// ingress.test.mjs — the engine's proxy ingress (RFC 4.8 §5.1 · §5.2 · §5.5; acceptance W13, W15, W17). A real engine on loopback, the static
// redirector's lookupIngress, a plain TCP echo as the upstream and, where a proxy is the upstream, the mock proxy. No mihomo here: the
// health probe is replayed from the bytes the REAL mihomo sent (test/netenv/fixtures/mihomo-probe.bytes, recorded by the W57 contract test).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { parseAuthority } from '../../../src/collector/core/engine/ingress.mjs'
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

