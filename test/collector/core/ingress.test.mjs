// ingress.test.mjs — the engine's proxy ingress (RFC 4.8 §5.1 · §5.2 · §5.5; acceptance W13, W15, W17). A real engine on loopback, the static
// redirector's lookupIngress, a plain TCP echo as the upstream and, where a proxy is the upstream, the mock proxy. No mihomo here: the
// health probe is replayed from the bytes the REAL mihomo sent (test/netenv/fixtures/mihomo-probe.bytes, recorded from a real mihomo).
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
const USER = 'of.spike'
const HEALTH_PORT = 18000 // the re-entry point the recorded bytes are normalised to
const basic = (user, pass) => `Proxy-Authorization: Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}\r\n`
const connectHead = (target, { user = USER, pass = TOKEN, auth = true } = {}) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? basic(user, pass) : ''}\r\n`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const trocarCa = createCa()

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

async function lab(t, { meta = {}, timing = {}, connectUpstream, redirector = createStaticRedirector(), noToken = false, upstreamCa, onHeld } = {}) {
  const flows = [], failures = [], envelopes = []
  const upConns = []
  const echo = net.createServer((s) => { upConns.push(s); s.on('error', () => {}); s.pipe(s) })
  await new Promise((r) => echo.listen(0, '127.0.0.1', r))
  const echoPort = echo.address().port
  // the group's health target is the recorded 127.0.0.1:18000; every other target is an agent's connection
  redirector.setIngress(USER, ({ target }) => (target.address === '127.0.0.1' && target.port === HEALTH_PORT ? { health: true, group: 'spike' }
    : { pid: 4242, agent: 'claude-code', decrypt: false, capture: 'proxy', form: 'claude-code.cli', pid_source: 'socket-table', pid_ms: 7, negKey: '4242', upstream: { kind: 'direct' }, ...meta }))
  const dials = [] // every upstream the engine was asked to open, whoever asked
  const connect = (d) => { dials.push({ ...d }); return connectUpstream ? connectUpstream(d) : net.connect(d.port, d.address) }
  const engine = createEngine({
    redirector, issuer: createLeafIssuer(loadCa(trocarCa)), connectUpstream: connect, timing, upstreamCa,
    store: { envelope: (e) => { envelopes.push(e); return true }, flow: (f) => { flows.push(structuredClone(f)); return true } },
    onFailure: (f) => failures.push(f), ...(noToken ? {} : { ingressToken: TOKEN }), ...(onHeld ? { onHeld } : {}),
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
  assert.deepEqual(row.ingress, { route: 'of', group: 'spike' })
  assert.deepEqual([row.pid_source, row.pid_ms, row.upstream], ['socket-table', 7, { kind: 'direct' }])
  assert.equal('prelude' in row, false, 'the CONNECT is mihomo\'s, with trocar\'s token: it is not recorded as the agent\'s prelude (invariant 4)')
  assert.deepEqual([row.bytes_up, row.bytes_down], [5, 5], 'the agent\'s own bytes: the opener and trocar\'s 200 are not counted')
  assert.deepEqual(L.failures, [])
  assert.deepEqual(L.engine.stats().ingress, { connections: 1, flows: 1, health: 0, challenged: 0, authFailed: 0, unknown: 0, refused: 0, unreachable: 0 })
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

test('W13 a wrong token is 407, with no upstream connection and one ingress-auth-failed that does not carry the token; an unknown user the same; no credentials at all is the 407 challenge, counted, no failure line', T, async (t) => {
  const L = await lab(t)
  const target = `127.0.0.1:${L.echoPort}`
  for (const [what, head] of [['token', connectHead(target, { pass: 'f'.repeat(32) })], ['no header', connectHead(target, { auth: false })], ['unknown user', connectHead(target, { user: 'of.nobody' })]]) {
    const c = L.client(); c.write(head)
    assert.match(await c.head(), /^HTTP\/1\.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic /, what)
    await c.closed()
  }
  assert.equal(L.upConns.length, 0, 'zero upstream connections')
  assert.deepEqual(L.failures.map((f) => [f.event, f.where, f.code, f.reason]), [
    ['failure', 'ingress', 'ingress-auth-failed', 'token mismatch'], ['failure', 'ingress', 'ingress-auth-failed', 'unknown user']])
  for (const f of L.failures) assert.deepEqual(checkRecord(f), [], 'a record the closed sets accept')
  assert.equal(JSON.stringify(L.failures).includes(TOKEN) || JSON.stringify(L.failures).includes('ffffffff'), false, 'no token, wrong or right, is written')
  assert.equal(L.flows.length, 0)
  assert.deepEqual([L.engine.stats().ingress.authFailed, L.engine.stats().ingress.challenged], [2, 1])
})

test('W13 the Basic challenge round trip (VS Code\'s Chromium): no credentials → 407, then the same CONNECT with the door\'s user:token → 200, and not one failure line', T, async (t) => {
  const L = await lab(t)
  const target = `127.0.0.1:${L.echoPort}`
  const first = L.client(); first.write(connectHead(target, { auth: false }))
  assert.match(await first.head(), /^HTTP\/1\.1 407 /)
  await first.closed()
  const again = L.client(); again.write(connectHead(target))
  assert.match(await again.head(), /^HTTP\/1\.1 200 /)
  again.sock.destroy()
  assert.deepEqual(L.failures, [])
  assert.equal(L.engine.stats().ingress.challenged, 1)
})

test('W13 no token reaches a record through the user field: the token sent as a username, or as a credential with no colon, is written as "(not a route name)"; a real route name is kept', T, async (t) => {
  const L = await lab(t)
  const WRONG = 'f'.repeat(32), target = `127.0.0.1:${L.echoPort}`
  const raw = (cred) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${Buffer.from(cred).toString('base64')}\r\n\r\n`
  const http = [['the token alone, no colon', TOKEN], ['the token as the username, a wrong password', `${TOKEN}:${WRONG}`], ['a route name with the token inside it', `of.${TOKEN}:${WRONG}`],
    ['the token as the username and as the password: the token is right, the user is not known', `${TOKEN}:${TOKEN}`], ['a wrong token alone', WRONG], ['a route name nobody knows, with the right token', `of.nobody:${TOKEN}`]]
  for (const [what, cred] of http) { const c = L.client(); c.write(raw(cred)); assert.match(await c.head(), /^HTTP\/1\.1 407 /, what); await c.closed() }
  const login = (user, pass) => { const c = L.client(); c.write(Buffer.from([5, 1, 2])); return c.bytes(2).then(() => { c.write(Buffer.concat([Buffer.from([1, user.length]), Buffer.from(user), Buffer.from([pass.length]), Buffer.from(pass)])); return c.bytes(2) }) }
  await login(TOKEN, WRONG); await login('of.nobody', WRONG) // SOCKS5: the token as the username; an ordinary route name with a wrong token
  assert.deepEqual(L.failures.map((f) => [f.code, f.user]), [
    ['ingress-auth-failed', '(not a route name)'], ['ingress-auth-failed', '(not a route name)'], ['ingress-auth-failed', '(not a route name)'],
    ['ingress-auth-failed', '(not a route name)'], ['ingress-auth-failed', '(not a route name)'], ['ingress-auth-failed', 'of.nobody'],
    ['ingress-auth-failed', '(not a route name)'], ['ingress-auth-failed', 'of.nobody']])
  const all = JSON.stringify(L.failures)
  for (const secret of [TOKEN, WRONG, Buffer.from(TOKEN).toString('base64'), Buffer.from(`${TOKEN}:${WRONG}`).toString('base64')]) assert.equal(all.includes(secret), false, `no ${secret.slice(0, 6)}… in any record`)
  for (const f of L.failures) assert.deepEqual(checkRecord(f), [])
})

test('W13 a lookup that throws for a user that is the token does not write the token into its reason', T, async (t) => {
  const redirector = createStaticRedirector(); redirector.lookupIngress = async () => { throw new Error('helper gone') }
  const L = await lab(t, { redirector })
  const c = L.client(); c.write(`CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Basic ${Buffer.from(`${TOKEN}:${TOKEN}`).toString('base64')}\r\n\r\n`)
  assert.match(await c.head(), /^HTTP\/1\.1 502 /); await c.closed()
  assert.deepEqual(L.failures.map((f) => f.code), ['loader-down']); assert.equal(JSON.stringify(L.failures).includes(TOKEN), false)
  assert.match(L.failures[0].reason, /\(not a route name\)/)
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
  assert.deepEqual([L.flows[0].ingress, L.flows[0].upstream, 'prelude' in L.flows[0]], [{ route: 'of', group: 'spike' }, { kind: 'direct' }, false])
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
  d.write('HEAD /trocar-health/another-group HTTP/1.1\r\nHost: x\r\n\r\n'); await d.closed() // the probe of a group that is not this one's
  assert.equal(L.failures.length, 2)
})

test('W13 an absolute-URI GET, a TLS hello and other bytes that are not CONNECT or SOCKS5 are closed with ingress-unknown; no upstream is dialled', T, async (t) => {
  const L = await lab(t)
  for (const bytes of ['GET http://trocar-health.invalid/spike HTTP/1.1\r\nHost: trocar-health.invalid\r\n\r\n', Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 1, 2, 3, 4, 5]), 'hello there, this is not a proxy request\r\n\r\n', 'POST /x HTTP/1.1\r\n\r\n']) {
    const c = L.client(); c.write(bytes); await c.closed()
  }
  assert.equal(L.upConns.length, 0)
  assert.deepEqual(L.failures.map((f) => [f.where, f.code]), Array(4).fill(['ingress', 'ingress-unknown']))
  assert.match(L.failures[0].reason, /GET/); assert.match(L.failures[1].reason, /0x16/)
  assert.equal(JSON.stringify(L.failures).includes('trocar-health.invalid'), false, 'the reason names the method, not what the client put in the URL')
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
  assert.deepEqual([row.decision, row.not_captured, row.error.type, row.error.side, row.pid, row.ingress], ['error', 'error', 'ECONNREFUSED', 'upstream', 4242, { route: 'of', group: 'spike' }])
  assert.equal(L.envelopes.length, 0)
  assert.deepEqual(L.failures.filter((f) => f.code === 'upstream-unreachable'), [], 'a direct upstream dials the target itself: one dead host is that connection\'s row, not the door\'s upstream being down (4.8 W73)')
  assert.equal(L.engine.stats().ingress.unreachable, 1)
})

test('W73 upstream-unreachable blames the door\'s upstream only when the upstream proxy itself fails before a target is named (dial, SOCKS5 method / auth stage) or its kind cannot be dialled; a dead target host, direct or after the proxy got the request naming it, stays on its row', T, async (t) => {
  const deadPort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  const listen = async (onConn) => { const s = net.createServer((c) => { c.on('error', () => {}); onConn(c) }); await new Promise((r) => s.listen(0, '127.0.0.1', r)); t.after(() => s.close()); return s.address().port }
  // takes the TCP connection, then drops the first message: for HTTP that is the CONNECT naming the target; for SOCKS5 it is the greeting, before any target
  const closer = await listen((c) => c.once('data', () => c.destroy()))
  // takes the connection and answers in something that is not SOCKS5: the method reply already shows the proxy is broken
  const garbage = await listen((c) => c.once('data', () => c.end('HTTP/1.1 400 Bad Request\r\n\r\n')))
  // a SOCKS5 proxy that accepts no-auth, then drops the CONNECT request that names the target
  const socksDrop = await listen((c) => { let n = 0; c.on('data', () => { if (n++ === 0) c.write(Buffer.from([5, 0])); else c.destroy() }) })
  // a SOCKS5 proxy that asks for user/pass, then drops the authentication
  const authDrop = await listen((c) => { let n = 0; c.on('data', () => { if (n++ === 0) c.write(Buffer.from([5, 2])); else c.destroy() }) })
  const auth = { username: 'u', password: 'p' }
  const dead = await deadPort()
  const cases = [ // [upstream, target, does the door's upstream get the blame]
    [{ kind: 'direct' }, `127.0.0.1:${dead}`, false],
    [{ kind: 'http', host: '127.0.0.1', port: dead }, 'api.example:443', true],
    [{ kind: 'socks5', host: '127.0.0.1', port: dead }, 'api.example:443', true],
    [{ kind: 'http', host: '127.0.0.1', port: closer }, 'api.example:443', false],
    [{ kind: 'socks5', host: '127.0.0.1', port: closer }, 'api.example:443', true],
    [{ kind: 'socks5', host: '127.0.0.1', port: garbage }, 'api.example:443', true],
    [{ kind: 'socks5', host: '127.0.0.1', port: authDrop, auth }, 'api.example:443', true],
    [{ kind: 'socks5', host: '127.0.0.1', port: socksDrop }, 'api.example:443', false],
    [{ kind: 'quic', host: '127.0.0.1', port: dead }, 'api.example:443', true],
  ]
  for (const [upstream, target, blamed] of cases) {
    const L = await lab(t, { meta: { upstream } })
    const c = L.client(); c.write(connectHead(target))
    assert.match(await c.head(), /^HTTP\/1\.1 502 /, `${upstream.kind}: 502`); await c.closed()
    await L.settled(1)
    assert.deepEqual([L.flows[0].decision, L.flows[0].error.side], ['error', 'upstream'], `${upstream.kind}: the row says the upstream side failed`)
    const ev = L.failures.filter((f) => f.code === 'upstream-unreachable')
    assert.deepEqual(ev.map((f) => [f.where, f.group]), blamed ? [['netenv', 'spike']] : [], `${upstream.kind} → ${target}: ${blamed ? 'the door\'s upstream is down' : 'one target, not the door'}`)
  }
})

test('upstream-unreachable is written at most once per form (door group) per 60 s (1.6 §9.7), whatever the number of connections', T, async (t) => {
  let now = 1_000_000
  const dead = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  const L = await lab(t, { timing: { now: () => now }, meta: { upstream: { kind: 'http', host: '127.0.0.1', port: dead } } }) // the door's upstream proxy is down
  const once = async () => { const c = L.client(); c.write(connectHead('api.example:443')); await c.head(); await c.closed() }
  for (let i = 0; i < 3; i++) await once()
  now += 59_999; await once()
  now += 1; await once()
  await L.settled(5)
  assert.equal(L.failures.filter((f) => f.code === 'upstream-unreachable').length, 2)
  assert.equal(L.engine.stats().ingress.unreachable, 5)
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

test('W13 a lookup that refuses because the upstream cannot be dialled (the redirector\'s `upstream-unavailable`) is a 502 and that code at the ingress with its reason — not loader-down, which names a helper that has nothing to do with it', T, async (t) => {
  const redirector = createStaticRedirector(); redirector.lookupIngress = async () => { throw Object.assign(new Error('the login of the upstream proxy of g (prior:g) cannot be read, so nothing can be dialled through that proxy'), { code: 'upstream-unavailable', why: 'upstream-credentials-unavailable' }) }
  const L = await lab(t, { redirector })
  const c = L.client(); c.write(connectHead('127.0.0.1:9')); assert.match(await c.head(), /^HTTP\/1\.1 502 /); await c.closed()
  assert.deepEqual(L.failures.map((f) => [f.where, f.code, f.why]), [['ingress', 'upstream-unavailable', 'upstream-credentials-unavailable']])
  assert.match(L.failures[0].reason, /cannot be read/)
  assert.equal(L.failures[0].reason.includes(TOKEN), false)
  const other = createStaticRedirector(); other.lookupIngress = async () => { throw Object.assign(new Error('x'), { code: 'upstream-surprise' }) }
  const M = await lab(t, { redirector: other })
  const d = M.client(); d.write(connectHead('127.0.0.1:9')); await d.head(); await d.closed()
  assert.deepEqual(M.failures.map((f) => f.code), ['loader-down'], 'a code the ingress does not know is the lookup failing, as before')
})

test('W13 engine.close() ends a half-open handshake and a health tunnel instead of waiting out their idle timeouts (an in-flight flow is left alone: see the test below that opens one)', T, async (t) => {
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

test('W13 listen() twice on one ingress port, 127.0.0.1 first and [::1] after, as the daemon does it (D-10): one ingress behind both; a [::1] failure rejects only its own call and the 127.0.0.1 ingress goes on serving', T, async (t) => {
  const v6 = await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(0, '::1', () => s.close(() => r(true))) })
  if (!v6) return t.skip('this machine has no IPv6 loopback')
  const mk = () => createEngine({ redirector: { lookupIngress: async () => ({ health: true, group: 'spike' }) }, issuer: createLeafIssuer(loadCa(createCa())), store: { envelope() {}, flow() {} }, onFailure() {}, ingressToken: TOKEN })
  const healthy = (host, port) => within(new Promise((res, rej) => { // the 200 of a health probe: the ingress answered on this address
    const c = net.connect(port, host); let b = ''; c.on('error', rej); c.write(connectHead(`127.0.0.1:${HEALTH_PORT}`))
    c.on('data', (d) => { b += d.toString('latin1'); if (b.includes('\r\n\r\n')) { c.destroy(); res(b.split('\r\n')[0]) } })
  }), 4000, `the ingress on ${host}`)
  const engine = mk(); t.after(() => closeWithin(engine))
  const first = await engine.listen({ hosts: ['127.0.0.1'], ingress: { port: 0 } })
  const second = await engine.listen({ hosts: ['::1'], ingress: { port: first.ingressPort } })
  assert.deepEqual([second.ingressPort, second.port], [first.ingressPort, null], 'the same ingress port; a redirector with no lookup has no transparent door')
  for (const host of ['127.0.0.1', '::1']) assert.equal(await healthy(host, first.ingressPort), 'HTTP/1.1 200 Connection established', host)
  assert.equal(engine.stats().ingress.health, 2, 'one ingress, one set of counters, behind both listeners')
  // [::1]:<port> is taken by someone else: the second call rejects, and what the first call bound is unharmed
  const e2 = mk(); t.after(() => closeWithin(e2))
  const a = await e2.listen({ hosts: ['127.0.0.1'], ingress: { port: 0 } })
  const squatter = net.createServer(); await new Promise((r) => squatter.listen(a.ingressPort, '::1', r)); t.after(() => squatter.close())
  await assert.rejects(() => e2.listen({ hosts: ['::1'], ingress: { port: a.ingressPort } }), { code: 'EADDRINUSE' })
  assert.equal(await healthy('127.0.0.1', a.ingressPort), 'HTTP/1.1 200 Connection established', 'the 127.0.0.1 ingress still serves')
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
// `hold` (a promise): the origin answers a request only once it settles; `onRequest()`: called when a request head has arrived (the drain test below needs both)
async function origin(t, { hold = null, onRequest = null } = {}) {
  const srv = tls.createServer({ SNICallback: (n, cb) => cb(null, privIssuer.secureContextFor(n)), ALPNProtocols: ['http/1.1'] }, (s) => {
    let seen = ''; s.on('data', (d) => { seen += d.toString('latin1'); if (seen.includes('\r\n\r\n')) { seen = ''; if (onRequest) onRequest(); Promise.resolve(hold).then(() => s.write(RESP)) } }); s.on('error', () => {})
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
  const r = await talk(sock, trocarCa.certPem)
  assert.equal(r.got, RESP); assert.match(r.issuer, /trocar collector CA/)
  await L.settled(1)
  assert.deepEqual(L.dials, [{ address: '127.0.0.1', port: o.port }], 'one upstream dial for one agent connection'); assert.equal(o.conns.length, 1)
  assert.deepEqual(L.envelopes.map((e) => [e.host, e.proc.pid, e.proc.agent, e.scheme]), [['upstream.test', 4242, 'claude-code', 'https']])
  assert.deepEqual([L.flows[0].decision, L.flows[0].not_captured ?? null, L.flows[0].upstream, 'prelude' in L.flows[0]], ['decrypt', null, { kind: 'direct' }, false])
  assert.deepEqual(L.failures, [])
})

// `trocar status` prints stats().decrypted / spliced as outcomes: a row that keeps its planned decision while nothing was forwarded (RFC 4.6
// §记录 连接行怎么落码) counts in neither. Field case: the upstream FINs after reading the engine's ClientHello.
test('W15 a connection whose upstream hangs up during the engine\'s TLS handshake is not counted as decrypted; a decrypted one is', T, async (t) => {
  const o = await origin(t)
  const fin = net.createServer((s) => { s.on('error', () => {}); s.once('data', () => setTimeout(() => s.end(), 50)) }); await listen(fin); t.after(() => fin.close())
  const L = await lab(t, { upstreamCa: privCa.certPem, meta: { decrypt: true } })
  assert.equal(await talk((await tunnel(L.ingressPort, `127.0.0.1:${fin.address().port}`)).sock, trocarCa.certPem), 'closed'); await L.settled(1)
  assert.deepEqual([L.flows[0].decision, L.flows[0].not_captured], ['decrypt', 'error'], 'the row keeps the plan')
  assert.equal((await talk((await tunnel(L.ingressPort, `127.0.0.1:${o.port}`)).sock, trocarCa.certPem)).got, RESP); await L.settled(2)
  await until(() => L.engine.stats().active === 0, 'both flows to finish')
  assert.deepEqual([L.engine.stats().decrypted, L.engine.stats().spliced], [1, 0])
})

test('W15 an IP-literal target with an IP-SAN certificate is decrypted: no SNI exists for an IP (RFC 6066), so the upstream is verified against the address — not against Node\'s own \'localhost\' default (the macOS smoke run\'s live find, 2026-10-09)', T, async (t) => {
  // the origin answers on loopback with a leaf issued FOR the address (leaf.mjs puts an IP SAN on it); the agent speaks TLS with no servername — exactly
  // what every real client does to an IP-literal destination, and exactly what used to fail: without the host handed to tls.connect, Node verified the
  // upstream against 'localhost' and the flow was spliced away with not_captured 'upstream-cert' / ERR_TLS_CERT_ALTNAME_INVALID whatever the certificate
  const ipCa = createCa({ commonName: 'ip origin CA' })
  const ipLeaf = createLeafIssuer(loadCa(ipCa)).issue('127.0.0.1')
  const originSockets = new Set()
  const ipOrigin = tls.createServer({ key: ipLeaf.keyPem, cert: ipLeaf.certPem, ALPNProtocols: ['http/1.1'] }, (s) => { originSockets.add(s); s.on('error', () => {}); let seen = ''; s.on('data', (d) => { seen += d.toString('latin1'); if (seen.includes('\r\n\r\n')) s.write(RESP) }) })
  await listen(ipOrigin)
  t.after(() => { for (const x of originSockets) x.destroy(); ipOrigin.close() })
  const L = await lab(t, { upstreamCa: ipCa.certPem, meta: { decrypt: true } })
  const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${ipOrigin.address().port}`)
  const got = await within(new Promise((resolve) => {
    let out = ''
    const agent = tls.connect({ socket: sock, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] }, () => agent.write(REQ.replace('upstream.test', '127.0.0.1')))
    agent.on('data', (d) => { out += d.toString('latin1'); if (out.length >= RESP.length) agent.end() })
    agent.on('error', () => {}); agent.on('close', () => resolve(out))
  }), 6000, 'the agent\'s TLS over the tunnel to the IP-literal origin', () => sock.destroy())
  assert.equal(got, RESP, 'the agent\'s call was answered')
  await L.settled(1)
  assert.equal(L.flows[0].decision, 'decrypt', 'the upstream verified against its address: the flow is captured, not stepped aside')
  assert.equal(L.flows[0].not_captured ?? null, null)
  assert.equal(L.envelopes[0].host, '127.0.0.1')
  assert.deepEqual(L.failures, [])
})

test('W15 an http upstream: the user\'s credentials ride only in trocar\'s prelude for the agent\'s connection; the flow is decrypted over one connection to the proxy; the row has neither credentials nor prelude', T, async (t) => {
  const o = await origin(t)
  const proxy = await startMockProxy({ kind: 'connect', target: { port: o.port }, auth: CRED }); t.after(() => proxy.close())
  const L = await lab(t, { upstreamCa: privCa.certPem, meta: { decrypt: true, upstream: { kind: 'http', host: '127.0.0.1', port: proxy.port, auth: CRED } } })
  const { sock, head } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`)
  assert.match(head, /^HTTP\/1\.1 200 /)
  const r = await talk(sock, trocarCa.certPem); assert.equal(r.got, RESP); await L.settled(1)
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
  const r = await talk(sock, trocarCa.certPem); assert.equal(r.got, RESP); await L.settled(1)
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

test('W15 a proxy that does not answer is waited for without a limit and said once: upstream-slow (phase proxy-reply) after upstreamSlowMs, no credentials in it, the agent not cut; a client that leaves first leaves no event', T, async (t) => {
  let release, held = null
  const slow = net.createServer((s) => { held = s; s.on('error', () => {}); s.once('data', () => { new Promise((r) => { release = r }).then(() => s.write('HTTP/1.1 200 Connection established\r\n\r\n')) }) })
  await listen(slow); t.after(() => { slow.close(); if (held) held.destroy() })
  const L = await lab(t, { timing: { upstreamSlowMs: 80 }, meta: { upstream: { kind: 'http', host: '127.0.0.1', port: slow.address().port, auth: CRED } } })
  const c = L.client(); c.write(connectHead('upstream.test:443'))
  await until(() => L.failures.length, 'the upstream-slow event')
  await sleep(250) // the event is once, not every interval
  assert.deepEqual(L.failures.map((f) => [f.where, f.code, f.phase, f.host]), [['engine', 'upstream-slow', 'proxy-reply', 'upstream.test']])
  assert.ok(L.failures[0].waited_ms >= 80, `waited_ms ${L.failures[0].waited_ms}`); assert.deepEqual(checkRecord(L.failures[0]), [])
  assert.equal(JSON.stringify(L.failures).includes('pw-SECRET'), false, 'the user\'s proxy credentials are not in it')
  assert.equal(c.buf.length, 0, 'the agent was not cut and was told nothing')
  await until(() => release, 'the proxy to receive the prelude'); release()
  assert.match(await c.head(), /^HTTP\/1\.1 200 /, 'the wait had no limit: the proxy\'s late answer still reaches the agent'); assert.equal(L.failures.length, 1)
  // a SOCKS5 proxy that never answers its greeting is the same; and a client that goes before the threshold takes the watch with it
  const quiet = await silentProxy(t)
  const S = await lab(t, { timing: { upstreamSlowMs: 150 }, meta: { upstream: { kind: 'socks5', host: '127.0.0.1', port: quiet.port } } })
  const gone = S.client(); gone.write(connectHead('upstream.test:443')); await until(() => quiet.socks.length && quiet.socks[0].got.length, 'the greeting'); gone.sock.destroy()
  const stays = S.client(); stays.write(connectHead('upstream.test:443'))
  await until(() => S.failures.length, 'the SOCKS5 upstream-slow event'); await sleep(300)
  assert.deepEqual(S.failures.map((f) => [f.code, f.phase]), [['upstream-slow', 'proxy-reply']], 'one event, for the client that stayed; none for the one that left before the threshold')
})

test('W15 a proxy whose reply to CONNECT is not an HTTP status line is a dial that failed, not a refusal: 502, bad_proxy_reply in the row, the proxy\'s own bytes not forwarded', T, async (t) => {
  const garbage = net.createServer((s) => { s.on('error', () => {}); s.once('data', () => s.write('SSH-2.0-OpenSSH_9.6\r\n\r\n')) })
  await listen(garbage); t.after(() => garbage.close())
  const L = await lab(t, { meta: { upstream: { kind: 'http', host: '127.0.0.1', port: garbage.address().port } } })
  const c = L.client(); c.write(connectHead('upstream.test:443'))
  assert.equal(await c.head(), 'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n', 'trocar\'s own 502, not the proxy\'s bytes'); await c.closed(); await L.settled(1)
  const [row] = L.flows
  assert.deepEqual([row.decision, row.not_captured, row.error.type, row.error.side, 'reason' in row && row.reason], ['error', 'error', 'bad_proxy_reply', 'upstream', null])
  assert.match(row.error.message, /not .*HTTP status line/); assert.equal(JSON.stringify(row).includes('NaN'), false)
  assert.deepEqual([L.engine.stats().ingress.unreachable, L.engine.stats().ingress.refused], [1, 0])
  const old = net.createServer((s) => { s.on('error', () => {}); s.once('data', () => s.write('HTTP/1.0 200 OK\r\n\r\n')) }) // an HTTP/1.0 proxy that says yes is still a yes
  await listen(old); t.after(() => old.close())
  const M = await lab(t, { meta: { upstream: { kind: 'http', host: '127.0.0.1', port: old.address().port } } })
  const d = M.client(); d.write(connectHead('upstream.test:443')); assert.match(await d.head(), /^HTTP\/1\.1 200 /)
})

// The step-aside (4.6 让路): the engine does not trust the origin's CA, the agent does: the engine drops its own handshake and the agent meets the real
// upstream with its own ClientHello. Through the ingress that second dial is a handshake with the proxy again — unless the proxy is the user's and
// wants their credentials, which trocar does not send twice (invariant 1).
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

// The second dial of a step-aside through an http proxy is a handshake (a Promise), and it can go wrong in two ways the first dial's tests do not reach:
// the proxy refuses the second prelude, or the client is gone by the time the proxy answers (4.8 §5.2: 重拨失败 → 行 decision:'error',客户端的连接关掉).
// A proxy that is good for its first CONNECT (it tunnels to the origin) and does `second` for the next one: 'refuse' (403) or 'hold' (no answer until release()).
async function twoStepProxy(t, originPort, second) {
  const conns = []
  const srv = net.createServer((s) => {
    const rec = { sock: s, n: conns.length + 1, closed: closedOf(s), release: null }; conns.push(rec); s.on('error', () => {})
    s.once('data', () => {
      if (rec.n === 1) { const up = net.connect(originPort, '127.0.0.1'); up.on('error', () => s.destroy()); s.on('close', () => up.destroy()); up.once('connect', () => { s.write('HTTP/1.1 200 Connection established\r\n\r\n'); s.pipe(up); up.pipe(s) }); return }
      if (second === 'refuse') s.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
      else rec.release = () => s.write('HTTP/1.1 200 Connection established\r\n\r\n')
    })
  })
  await listen(srv); t.after(() => { srv.close(); for (const r of conns) r.sock.destroy() })
  return { port: srv.address().port, conns }
}

test('W15 step-aside whose second proxy prelude is refused: the agent\'s connection is closed, the row keeps the planned splice with the proxy\'s refusal, and no connection to the proxy is left open', T, async (t) => {
  const o = await origin(t), proxy = await twoStepProxy(t, o.port, 'refuse')
  const L = await lab(t, { meta: { decrypt: true, upstream: { kind: 'http', host: '127.0.0.1', port: proxy.port } } }) // no upstreamCa: the origin's CA is not trusted, so the engine steps aside
  const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`)
  assert.equal(await talk(sock, privCa.certPem), 'closed', 'the agent\'s connection is closed: there is nothing left to splice it to'); await L.settled(1)
  assert.equal(proxy.conns.length, 2, 'the first prelude, and the second that was refused')
  const [row] = L.flows
  assert.deepEqual([row.decision, row.not_captured, row.error.type, row.error.side, row.error.wait?.phase], ['splice', 'upstream-cert', 'proxy-refused', 'upstream', 'proxy-reply'])
  assert.match(row.error.message, /refused the second connection \(proxy-status-403\)/); assert.deepEqual(checkRecord(row), [])
  await until(() => L.engine.stats().active === 0, 'the flow to finish'); assert.equal(L.engine.stats().spliced, 0, 'nothing was spliced: not counted as passed through')
  await within(Promise.all(proxy.conns.map((c) => c.closed)), 3000, 'every connection to the proxy to be closed'); await o.closed()
  assert.equal(L.envelopes.length, 0)
})

test('W15 step-aside whose client is gone when the proxy answers the second prelude: the new upstream is destroyed, nothing is spliced, and the row says the client left during the wait', T, async (t) => {
  const o = await origin(t), proxy = await twoStepProxy(t, o.port, 'hold')
  const L = await lab(t, { meta: { decrypt: true, upstream: { kind: 'http', host: '127.0.0.1', port: proxy.port } } })
  const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`)
  const agent = talk(sock, privCa.certPem)
  await until(() => proxy.conns.length === 2 && proxy.conns[1].release, 'the second prelude to reach the proxy', 4000) // the engine is waiting for it: the redial is in flight
  sock.destroy(); assert.equal(await agent, 'closed')
  await sleep(100); proxy.conns[1].release() // the proxy says yes, to nobody
  await within(proxy.conns[1].closed, 3000, 'the connection the redial opened to be destroyed'); await L.settled(1)
  // the plan (splice) stays on the row; the error says the client left while the engine waited on the proxy's answer to the second prelude (RFC 4.6 §记录)
  assert.deepEqual([L.flows[0].decision, L.flows[0].not_captured, L.flows[0].error.type, L.flows[0].error.side, L.flows[0].error.wait?.phase], ['splice', 'upstream-cert', 'closed_before_reply', 'client', 'proxy-reply'])
  await o.closed(); assert.equal(o.conns.length, 1, 'the origin saw only the engine\'s dropped handshake: no ClientHello of the agent\'s went anywhere'); assert.equal(L.envelopes.length, 0)
  await until(() => L.engine.stats().active === 0, 'the flow to finish'); assert.equal(L.engine.stats().spliced, 0, 'nothing was spliced: not counted as passed through')
})

// The second prelude of a step-aside is one wait: a slow one is one upstream-slow event (4.8 §5.2), the flow's, with its flow_id
test('W15 step-aside whose second proxy prelude is slow: one upstream-slow event, carrying the flow', T, async (t) => {
  const o = await origin(t), proxy = await twoStepProxy(t, o.port, 'hold')
  const L = await lab(t, { meta: { decrypt: true, upstream: { kind: 'http', host: '127.0.0.1', port: proxy.port } }, timing: { upstreamSlowMs: 60 } })
  const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`)
  const agent = talk(sock, privCa.certPem)
  await until(() => proxy.conns.length === 2 && proxy.conns[1].release, 'the second prelude to reach the proxy', 4000)
  await sleep(300)
  sock.destroy(); await agent; proxy.conns[1].release(); await L.settled(1)
  const slow = L.failures.filter((f) => f.code === 'upstream-slow')
  assert.deepEqual(slow.map((f) => [f.phase, f.flow_id]), [['proxy-reply', L.flows[0].flow_id]], JSON.stringify(slow))
})

// A reset off the wire on the second dial is the OS's ECONNRESET on the row, not a close (wentBy reads a reset without `syscall` as Node's invented one)
test('W15 step-aside whose second dial to the proxy is reset by the OS: the row keeps ECONNRESET on the upstream side', T, async (t) => {
  const o = await origin(t), proxy = await twoStepProxy(t, o.port, 'hold')
  let toProxy = 0
  const connectUpstream = (d) => {
    const s = net.connect(d.port, d.address)
    if (d.port === proxy.port && ++toProxy === 2) process.nextTick(() => s.destroy(Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET', syscall: 'connect' })))
    return s
  }
  const L = await lab(t, { meta: { decrypt: true, upstream: { kind: 'http', host: '127.0.0.1', port: proxy.port } }, connectUpstream })
  const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`)
  assert.equal(await talk(sock, privCa.certPem), 'closed'); await L.settled(1)
  assert.deepEqual([L.flows[0].decision, L.flows[0].not_captured, L.flows[0].error.type, L.flows[0].error.side], ['splice', 'upstream-cert', 'ECONNRESET', 'upstream'])
  assert.deepEqual(checkRecord(L.flows[0]), [])
})

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
  const pidless = (negKey) => ({ pid: null, agent: 'claude-code', decrypt: true, capture: 'proxy', form: negKey, pid_source: null, pid_ms: 3, negKey, upstream: { kind: 'direct' } })
  L.redirector.setIngress('of.claude-code.cli', pidless('of.claude-code.cli')); L.redirector.setIngress('of.codex.app', pidless('of.codex.app'))
  const go = async (user, ca) => { const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`, connectHead(`127.0.0.1:${o.port}`, { user })); return talk(sock, ca) }
  let n = 0; const next = async () => { await L.settled(++n) }
  // form A's client does not trust the trocar CA: it rejects the leaf, twice in a row → (A, host) is negative
  assert.equal(await go('of.claude-code.cli', privCa.certPem), 'closed'); await next()
  assert.equal(L.engine.negatives().length, 0, 'one rejection is not enough')
  assert.equal(await go('of.claude-code.cli', privCa.certPem), 'closed'); await next()
  assert.deepEqual(L.engine.negatives().map((e) => [e.pid, e.negKey, e.host, e.cause, e.rejections]), [[null, 'of.claude-code.cli', 'upstream.test', 'client-rejected-leaf', 2]])
  const neg = L.failures.filter((f) => f.code === 'negative-cache')
  assert.deepEqual(neg.map((f) => [f.where, f.pid, f.neg_key, f.host, f.cause]), [['engine', null, 'of.claude-code.cli', 'upstream.test', 'client-rejected-leaf']], 'the write is a failure event, once, with its neg_key')
  assert.match(neg[0].reason, /of\.claude-code\.cli/); assert.deepEqual(checkRecord(neg[0]), [])
  // form A's next connection to that host is spliced; form B's connection to the SAME host is still decrypted
  const spliced = await go('of.claude-code.cli', privCa.certPem); await next()
  assert.deepEqual([spliced.got, spliced.issuer.includes('private origin CA')], [RESP, true]); assert.deepEqual([L.flows[2].decision, L.flows[2].not_captured], ['splice', 'negative-cache'])
  const other = await go('of.codex.app', trocarCa.certPem); await next()
  assert.match(other.issuer, /trocar collector CA/, 'the other form is untouched'); assert.deepEqual([L.flows[3].decision, L.flows[3].not_captured ?? null], ['decrypt', null])
  assert.deepEqual(L.failures.filter((f) => f.code === 'negative-cache').length, 1)
  // the last process of form A has gone: clear by form; B's entries (none here) and a pid's are not touched
  assert.equal(L.engine.forgetPid(4242), 0, 'a pid is not a form key')
  assert.equal(L.engine.forgetNegKey('of.codex.app'), 0); assert.equal(L.engine.negatives().length, 1)
  assert.equal(L.engine.forgetNegKey('of.claude-code.cli'), 1); assert.deepEqual(L.engine.negatives(), [])
  const again = await go('of.claude-code.cli', trocarCa.certPem); await next()
  assert.match(again.issuer, /trocar collector CA/, 'decrypted again after the clearing')
})

test('W17 a connection whose pid is known keeps the (pid, host) key: neg_key is "<pid>"', T, async (t) => {
  const o = await origin(t)
  const L = await lab(t, { upstreamCa: privCa.certPem, meta: { decrypt: true, pid: 77, negKey: '77' } })
  for (let i = 1; i <= 2; i++) { const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`); assert.equal(await talk(sock, privCa.certPem), 'closed'); await L.settled(i) }
  assert.deepEqual(L.failures.filter((f) => f.code === 'negative-cache').map((f) => [f.pid, f.neg_key]), [[77, '77']])
  assert.equal(L.engine.forgetPid(77), 1)
})

test('4.8 §5.5 a lone rejection hands its key to the sweep at once; once the key is forgotten the strike is gone with it', T, async (t) => {
  const o = await origin(t)
  const held = []
  const L = await lab(t, { upstreamCa: privCa.certPem, meta: { decrypt: true, pid: 77, negKey: '77@5' }, onHeld: (who) => held.push(who) })
  const reject = async (n) => { const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`); assert.equal(await talk(sock, privCa.certPem), 'closed'); await L.settled(n) }
  await reject(1)
  assert.deepEqual([L.engine.negatives().length, L.failures.filter((f) => f.code === 'trust-rejected' || f.code === 'negative-cache').length], [0, 0], 'below the threshold: no entry, no failure record')
  assert.ok(held.includes('77@5'), 'the strike alone is held: the sweep is armed for it')
  L.engine.forgetNegKey('77@5') // its process left the table
  await reject(2)
  assert.deepEqual(L.engine.negatives(), [], 'the earlier strike went with the key: one rejection after the clearing is again below the threshold')
})

test('4.8 §5.5 an acceptance after a lone rejection leaves nothing held under the key: the sweep has nothing to watch', T, async (t) => {
  const o = await origin(t)
  const L = await lab(t, { upstreamCa: privCa.certPem, meta: { decrypt: true, pid: 78, negKey: '78@5' } })
  const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`); assert.equal(await talk(sock, privCa.certPem), 'closed'); await L.settled(1)
  assert.equal(L.engine.holdsNegKey('78@5'), true, 'the strike is held under its key')
  assert.equal((await talk((await tunnel(L.ingressPort, `127.0.0.1:${o.port}`)).sock, trocarCa.certPem)).got, RESP); await L.settled(2)
  assert.equal(L.engine.holdsNegKey('78@5'), false, 'the acceptance reset the strike: nothing left under the key')
})

test('W17 the ingress keys a connection by its own user when the lookup gives no negKey and no pid: two such forms do not poison each other; a known pid is the key', T, async (t) => {
  const o = await origin(t)
  const L = await lab(t, { upstreamCa: privCa.certPem })
  const bare = (form) => ({ pid: null, agent: 'claude-code', decrypt: true, capture: 'proxy', form, pid_source: null, pid_ms: 3, upstream: { kind: 'direct' } }) // no negKey: the contract asks for one, a lookup may forget
  L.redirector.setIngress('of.claude-code.cli', bare('claude-code.cli')); L.redirector.setIngress('of.codex.app', bare('codex.app'))
  const go = async (user, ca) => { const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`, connectHead(`127.0.0.1:${o.port}`, { user })); return talk(sock, ca) }
  let n = 0; const next = async () => { await L.settled(++n) }
  assert.equal(await go('of.claude-code.cli', privCa.certPem), 'closed'); await next()
  assert.equal(await go('of.claude-code.cli', privCa.certPem), 'closed'); await next()
  assert.deepEqual(L.engine.negatives().map((e) => [e.pid, e.negKey, e.host]), [[null, 'of.claude-code.cli', 'upstream.test']], 'the key is the connection\'s own user, not "null"')
  const other = await go('of.codex.app', trocarCa.certPem); await next()
  assert.match(other.issuer, /trocar collector CA/, 'the other form is not poisoned by the first one\'s rejections'); assert.equal(L.flows[2].decision, 'decrypt')
  assert.equal(L.engine.forgetNegKey('of.claude-code.cli'), 1)
  L.redirector.setIngress('of.known', { ...bare('known'), pid: 88 }) // a pid and still no negKey: the pid
  for (let i = 0; i < 2; i++) { assert.equal(await go('of.known', privCa.certPem), 'closed'); await next() }
  assert.deepEqual(L.engine.negatives().map((e) => [e.pid, e.negKey]), [[88, '88']]); assert.equal(L.engine.forgetPid(88), 1)
})

// ── fail-open: a client that leaves, a hold that grows, a command that is not CONNECT (4.8 §5.1) ───────────────────────────────────
// Each is a MUST the ingress carries. Removing any one of them left the first suite green (review 2026-10-07), so each has a test that goes red without it.
const IDLE = { connections: 1, flows: 0, health: 0, challenged: 0, authFailed: 0, unknown: 0, refused: 0, unreachable: 0 } // one connection came, nothing became of it
const socksLogin = async (c) => { c.write(Buffer.from([5, 1, 2])); await c.bytes(2); c.write(Buffer.concat([Buffer.from([1, USER.length]), Buffer.from(USER), Buffer.from([TOKEN.length]), Buffer.from(TOKEN)])); await c.bytes(2) }
const hungSocket = () => { const s = new PassThrough(); s.connecting = true; return s } // a TCP connect that never completes; destroy() is its close
const until = (pred, what, ms = 2000) => within((async () => { while (!pred()) await sleep(5) })(), ms, what)
const closedOf = (s) => new Promise((r) => (s.destroyed ? r() : s.once('close', r)))
function noCrash(t) { const seen = []; const on = (e) => seen.push(String((e && e.stack) || e)); process.on('uncaughtException', on); t.after(() => process.removeListener('uncaughtException', on)); return seen }
// a proxy that takes the prelude and never answers; `socks` has every connection it was given
async function silentProxy(t) {
  const socks = []
  const srv = net.createServer((s) => { const rec = { sock: s, got: [], closed: closedOf(s) }; socks.push(rec); s.on('error', () => {}); s.on('data', (d) => rec.got.push(d)) })
  await listen(srv); t.after(() => { srv.close(); for (const r of socks) r.sock.destroy() })
  return { port: srv.address().port, socks }
}

test('W13 engine.close() leaves an agent flow that is in flight alone: it keeps relaying, its row is written, and close() returns only after it has ended', T, async (t) => {
  const L = await lab(t)
  const c = L.client(); c.write(connectHead(`127.0.0.1:${L.echoPort}`)); assert.match(await c.head(), /^HTTP\/1\.1 200 /)
  c.write('one'); assert.equal((await c.bytes(3)).toString(), 'one')
  let closed = false
  const closing = L.engine.close().then(() => { closed = true })
  await sleep(150) // closeIdle has run and the listener is shut
  assert.equal(c.ended, false, 'close() did not destroy the flow')
  c.write('two'); assert.equal((await c.bytes(3)).toString(), 'two', 'the flow still relays after close() began')
  assert.equal(closed, false, 'close() is waiting for the flow')
  c.sock.end(); await within(closing, 4000, 'engine.close() once the flow had ended')
  assert.deepEqual([L.flows.length, L.flows[0].pid, L.flows[0].bytes_up, L.flows[0].bytes_down], [1, 4242, 6, 6], 'the flow\'s row was written')
})

test('W13 a client that resets after the ingress has answered, or while it looks up or dials, ends that connection only: never an uncaught exception', T, async (t) => {
  const crashes = noCrash(t)
  const L = await lab(t, { connectUpstream: (d) => (d.port === 1 ? hungSocket() : net.connect(d.port, d.address)) })
  const real = L.redirector.lookupIngress.bind(L.redirector)
  L.redirector.lookupIngress = async (q) => { if (q.target.port === 2) await sleep(250); return real(q) }
  const dead = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  for (let i = 0; i < 6; i++) {
    const denied = L.client(); denied.write(connectHead('127.0.0.1:9', { pass: 'f'.repeat(32) })); await denied.head(); denied.sock.resetAndDestroy() // reset after the 407
    const bad502 = L.client(); bad502.write(connectHead(`127.0.0.1:${dead}`)); await bad502.head(); bad502.sock.resetAndDestroy() // reset after the 502
    const looking = L.client(); looking.write(connectHead('127.0.0.1:2')); await sleep(30); looking.sock.resetAndDestroy() // reset during the lookup
    const dialling = L.client(); dialling.write(connectHead('127.0.0.1:1')); await sleep(30); dialling.sock.resetAndDestroy() // reset during the dial
  }
  await sleep(400) // every lookup has returned
  assert.deepEqual(crashes, [], 'no uncaught exception')
  assert.equal(L.engine.stats().ingress.flows, 0)
})

test('W13 a client that leaves while the upstream is being dialled takes the dial down: the upstream is destroyed, nothing is counted, and one row says the client left during the dial (RFC 4.6 §记录)', T, async (t) => {
  const hung = []
  const L = await lab(t, { connectUpstream: (d) => (d.port === 1 ? (hung.push(hungSocket()), hung.at(-1)) : net.connect(d.port, d.address)) })
  const a = L.client(); a.write(connectHead('127.0.0.1:1')) // a direct upstream whose connect never completes
  await until(() => hung.length, 'the ingress to dial'); a.sock.destroy()
  await within(closedOf(hung[0]), 1500, 'the direct upstream to be destroyed')
  const proxy = await silentProxy(t) // an http proxy that has the prelude and never answers
  const P = await lab(t, { meta: { upstream: { kind: 'http', host: '127.0.0.1', port: proxy.port } } })
  const b = P.client(); b.write(connectHead('upstream.test:443'))
  await until(() => proxy.socks.length && proxy.socks[0].got.length, 'the proxy to get the prelude'); b.sock.destroy()
  await within(proxy.socks[0].closed, 1500, 'the connection to the proxy to be destroyed')
  await sleep(100)
  // no flow existed, but the give-up is on record: who left, during which wait, for how long (the one signal that would show trocar delaying agents)
  for (const [X, phase] of [[L, 'connect'], [P, 'proxy-reply']]) {
    assert.equal(X.flows.length, 1, phase)
    const [row] = X.flows
    assert.deepEqual([row.decision, row.not_captured, row.error.type, row.error.side, row.error.wait?.phase], ['error', 'error', 'closed_before_reply', 'client', phase])
    assert.ok(row.error.wait.ms >= 0 && row.duration_ms === row.error.wait.ms, JSON.stringify(row)); assert.deepEqual(checkRecord(row), [])
    assert.deepEqual(X.failures, []); assert.deepEqual(X.engine.stats().ingress, IDLE)
  }
  assert.equal(proxy.socks.length, 1, 'nothing dialled again')
})

test('W13 a client that leaves while lookupIngress is still running never gets a dial: the user\'s proxy sees no connection and no Proxy-Authorization for a connection nobody waits on', T, async (t) => {
  const proxy = await silentProxy(t)
  const L = await lab(t, { meta: { upstream: { kind: 'http', host: '127.0.0.1', port: proxy.port, auth: CRED } } })
  const real = L.redirector.lookupIngress.bind(L.redirector)
  L.redirector.lookupIngress = async (q) => { await sleep(300); return real(q) }
  const c = L.client(); c.write(connectHead('upstream.test:443'))
  await sleep(100); c.sock.resetAndDestroy()
  await sleep(500) // the lookup has returned by now
  assert.equal(proxy.socks.length, 0, 'not one connection to the proxy')
  assert.deepEqual(L.dials, []); assert.equal(L.flows.length, 0); assert.deepEqual(L.failures, []); assert.deepEqual(L.engine.stats().ingress, IDLE)
})

test('W13 a SOCKS5 command that is not CONNECT (BIND, UDP ASSOCIATE) is answered "command not supported" and recorded ingress-unknown; no lookup, no dial', T, async (t) => {
  const L = await lab(t)
  for (const cmd of [2, 3]) {
    const c = L.client(); await socksLogin(c); c.write(Buffer.from([5, cmd, 0, 1, 127, 0, 0, 1, 0, 80]))
    const rep = await c.bytes(10); assert.deepEqual([rep[0], rep[1]], [5, 7], `command ${cmd}`); await c.closed()
  }
  assert.deepEqual(L.failures.map((f) => [f.where, f.code, /command (\d)/.exec(f.reason)?.[1]]), [['ingress', 'ingress-unknown', '2'], ['ingress', 'ingress-unknown', '3']])
  for (const f of L.failures) assert.deepEqual(checkRecord(f), [])
  assert.deepEqual(L.dials, []); assert.equal(L.redirector.ingressLookups, 0, 'no lookup for a command the ingress does not do'); assert.equal(L.engine.stats().ingress.unknown, 2)
})

test('W13 a client that sends more than 256 KiB before the tunnel is open is cut off with ingress-unknown, and the dial it was waiting on is taken down', T, async (t) => {
  const hung = []
  const L = await lab(t, { connectUpstream: () => { const s = hungSocket(); hung.push(s); return s } })
  const c = L.client(); c.write(connectHead('203.0.113.7:443'))
  await until(() => hung.length, 'the ingress to dial')
  c.write(Buffer.alloc(300 * 1024, 0x41)); await c.closed()
  await within(closedOf(hung[0]), 1500, 'the dial to be taken down')
  assert.deepEqual(L.failures.map((f) => [f.where, f.code]), [['ingress', 'ingress-unknown']]); assert.match(L.failures[0].reason, /more than 256 KiB/)
  assert.deepEqual(checkRecord(L.failures[0]), []); assert.equal(L.flows.length, 0)
})

// the drain gate (CLI T5, 1.6 §1.3): the second door goes through the same runFlow, so `off` reaches an ingress flow like a transparent one
test('W15 drain: `off` lands after an ingress flow\'s request went out and before its response head: the engine asks it to close (closing 1), the response carries the one Connection: close line, the connection ends after it, and drained() resolves', T, async (t) => {
  let release, asked
  const hold = new Promise((r) => { release = r }), requested = new Promise((r) => { asked = r })
  const o = await origin(t, { hold, onRequest: asked })
  const L = await lab(t, { upstreamCa: privCa.certPem, meta: { decrypt: true } })
  const { sock } = await tunnel(L.ingressPort, `127.0.0.1:${o.port}`)
  let got = ''
  const done = new Promise((resolve) => {
    const c = tls.connect({ socket: sock, servername: 'upstream.test', ca: trocarCa.certPem, ALPNProtocols: ['http/1.1'] }, () => c.write(REQ))
    c.on('data', (d) => { got += d.toString('latin1') }); c.on('error', () => {}); c.on('close', () => resolve())
  })
  await within(requested, 4000, 'the origin to see the request')
  await sleep(50) // the engine's tee has the request by now
  assert.deepEqual(L.engine.drain({ agents: new Set(['codex']) }), { closing: 0, waiting: 0, cut: 0 }, 'another harness\'s off does not touch this flow')
  assert.deepEqual(L.engine.drain({ agents: new Set(['claude-code']) }), { closing: 1, waiting: 0, cut: 0 }, 'the ingress flow is one of the engine\'s flows: the gate is asked and holds the head')
  assert.deepEqual(L.engine.relayed({ agents: null }), { closing: 1, waiting: 0 })
  let drained = false; L.engine.drained({ agents: null }).then(() => { drained = true })
  await sleep(50); assert.equal(drained, false, 'the engine is not drained while the response is still to come')
  release()
  await within(done, 6000, 'the connection to end after the response')
  assert.match(got, /^HTTP\/1\.1 200 OK\r\ncontent-length: 2\r\nconnection: keep-alive\r\nConnection: close\r\n\r\nok$/, 'the origin\'s head, plus the one line before the blank line; the body whole')
  await L.settled(1)
  assert.equal(L.envelopes[0].trocar_added.join(), 'connection-close', 'recorded as trocar\'s own addition, not the agent\'s or the origin\'s bytes')
  await within(L.engine.drained({ agents: null }), 4000, 'drained()')
  assert.deepEqual(L.failures, [])
})

