// test/collector/core/leaf-verdict.test.mjs — RFC 4.6 §引擎 5 and acceptance 19–22: what a zero-data close or a client alert on our leaf
// means. Under a slow engine a close before the handshake completes counts but never writes trust-rejected (both doors), a certificate
// alert is an answer at once, a (pid, host) that has sent data on our leaf is not judged again by a zero-data close there while the engine is slow (on a fast engine it is), and a negative entry expires at retry_at and is renewed with a doubled backoff. A real engine
// and real TLS (the pattern of trust-rejected.test.mjs); a raw TLS 1.2 client sends the alerts.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { NEG_RETRY_MS } from '../../../src/collector/core/engine/negcache.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { closeWithin } from '../../helpers/bounded.mjs'

const T = { timeout: 20_000 }
const TOKEN = '0123456789abcdef0123456789abcdef' // a fixture token, never a real one
const USER = 'of.lv'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const upCa = createCa({ commonName: 'upstream test CA' })
const upIssuer = createLeafIssuer(loadCa(upCa))
const trocarCa = createCa()

// the engine with a static owner (pid 7) on both doors; delayMs slows the owner question of either door
async function rig(t, { delayMs = 0, timing = {} } = {}) {
  const up = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)) }, (s) => { s.on('error', () => {}); s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')) })
  await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const meta = { dst: { address: '127.0.0.1', port: up.address().port, family: 4 }, pid: 7, agent: 'claude-code', decrypt: true, door: 'g', negKey: '7', exe: '/x/claude', argv: ['claude'] }
  const redirector = createStaticRedirector(meta)
  const lookup = redirector.lookup
  redirector.lookup = async (q) => { await sleep(delayMs); return lookup(q) }
  redirector.setIngress(USER, async () => { await sleep(delayMs); return { ...meta, dst: undefined, capture: 'proxy', upstream: { kind: 'direct' } } })
  const fails = [], flows = []
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(trocarCa)), upstreamCa: upCa.certPem, systemCa: { certs: [], sources: ['test'], errors: [] },
    store: { envelope() {}, flow: (f) => flows.push(structuredClone(f)) }, onFailure: (f) => fails.push(f), timing, ingressToken: TOKEN })
  const { port, ingressPort } = await engine.listen({ ingress: { port: 0 } })
  t.after(async () => { await closeWithin(engine); up.close() })
  const settled = async (n) => { for (let i = 0; i < 800 && flows.length < n; i++) await sleep(10); assert.ok(flows.length >= n, `${n} rows`) }
  // a plain socket to the engine: straight to the transparent door, or through a CONNECT on the proxy ingress
  const open = async (door) => {
    if (door === 'transparent') { const s = net.connect(port, '127.0.0.1'); s.on('error', () => {}); await new Promise((r) => s.once('connect', r)); return s }
    const s = net.connect(ingressPort, '127.0.0.1'); s.on('error', () => {})
    s.write(`CONNECT 127.0.0.1:${meta.dst.port} HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: Basic ${Buffer.from(`${USER}:${TOKEN}`).toString('base64')}\r\n\r\n`)
    let head = Buffer.alloc(0)
    await new Promise((r) => { const on = (d) => { head = Buffer.concat([head, d]); if (head.includes('\r\n\r\n')) { s.removeListener('data', on); s.pause(); r() } }; s.on('data', on) })
    assert.match(head.toString('latin1'), /^HTTP\/1\.1 200 /)
    return s
  }
  // a Node TLS client over that socket; resolves with it once secure, or null when it refused the leaf
  const hello = async (door, { ca, servername = 'h.test' }) => {
    const socket = await open(door)
    return new Promise((resolve) => { const c = tls.connect({ socket, servername, ca }, () => resolve(c)); c.on('error', () => resolve(null)) })
  }
  const rejecting = async (door = 'transparent', servername = 'h.test') => { const c = await hello(door, { ca: upCa.certPem, servername }); if (c) c.destroy() }
  const used = async (door = 'transparent') => {
    const c = await hello(door, { ca: trocarCa.certPem }); c.write('GET / HTTP/1.1\r\nHost: h.test\r\n\r\n')
    await new Promise((r) => c.once('data', r)); c.end(); await new Promise((r) => c.once('close', r))
  }
  // a raw TLS 1.2 client: a real ClientHello, then on the engine's first flight a plaintext alert record (code), or a hang-up
  // with no alert and no Finished (code null: a client that gave up waiting, the handshake never completes)
  const alert = async (code, servername = 'api.test', door = 'transparent') => {
    const hold = net.createServer(); await new Promise((r) => hold.listen(0, '127.0.0.1', r))
    const got = new Promise((r) => hold.once('connection', (s) => s.once('data', (d) => { r(d); s.destroy() })))
    const c = tls.connect({ port: hold.address().port, host: '127.0.0.1', servername, maxVersion: 'TLSv1.2' }); c.on('error', () => {})
    const ch = await got; hold.close()
    const s = await open(door)
    s.once('data', () => { if (code === null) return s.destroy(); s.write(Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, code])); s.end() }); s.resume()
    s.write(ch)
    await new Promise((r) => s.once('close', r))
  }
  const critical = () => fails.filter((f) => f.code === 'trust-rejected')
  return { engine, fails, flows, settled, rejecting, used, alert, critical }
}

// a give-up (the raw client hangs up on our first flight) and a Node refusal (it destroys its socket before its Finished leaves) look the
// same to the engine; under a slow engine both count toward the entry (D31 fail-open) and neither writes trust-rejected (D38)
const giveUp = (s, door) => s.alert(null, 'h.test', door)
const refuse = (s, door) => s.rejecting(door)
for (const door of ['transparent', 'ingress']) for (const [kind, close] of [['a client that hangs up on our first flight', giveUp], ['a Node client that refuses the leaf', refuse]]) {
  test(`4.6 W19 (${door}): the engine slower than slowEngineMs, ${kind} → client-closed-no-data/engine-slow, negative after two, never trust-rejected`, T, async (t) => {
    const s = await rig(t, { delayMs: 300, timing: { slowEngineMs: 100 } })
    await close(s, door); await s.settled(1)
    assert.deepEqual(s.engine.negatives(), [])
    await close(s, door); await s.settled(2)
    assert.deepEqual(s.flows.map((f) => [f.not_captured, f.reason]), Array(2).fill(['client-closed-no-data', 'engine-slow']))
    assert.deepEqual(s.engine.negatives().map((e) => [e.host, e.cause]), [['h.test', 'client-rejected-leaf']])
    assert.deepEqual(s.critical(), [])
  })
}

for (const code of [42, 43, 44, 45, 46, 48]) {
  test(`4.6 W20: a certificate alert (${code}) from the client → the key is negative after one connection, client-rejected-leaf, one trust-rejected`, T, async (t) => {
    const s = await rig(t)
    await s.alert(code); await s.settled(1)
    assert.equal(s.flows[0].not_captured, 'client-rejected-leaf')
    assert.deepEqual(s.engine.negatives().map((e) => [e.host, e.cause]), [['api.test', 'client-rejected-leaf']])
    assert.equal(s.critical().length, 1)
    assert.match(s.critical()[0].alert, /ALERT_/)
  })
}

test('4.6 W20: a non-certificate alert (internal_error) is a suspicion only — not negative after one connection, negative after the second', T, async (t) => {
  const s = await rig(t)
  await s.alert(80); await s.settled(1)
  assert.deepEqual(s.engine.negatives(), [])
  assert.deepEqual(s.critical(), [])
  await s.alert(80); await s.settled(2)
  assert.deepEqual(s.engine.negatives().map((e) => [e.host, e.cause]), [['api.test', 'client-rejected-leaf']])
})

test('4.6 W21(a): under a slow engine, a (pid, host) that sent data on our leaf → its later zero-data closes there are client-closed-no-data/trusted-before; the same pid closing on another host is engine-slow and negative after two, a certificate alert at once', T, async (t) => {
  const s = await rig(t, { delayMs: 300, timing: { slowEngineMs: 100 } })
  await s.used(); await s.settled(1)
  await s.rejecting(); await s.settled(2)
  await s.rejecting(); await s.settled(3)
  assert.deepEqual(s.flows.slice(1).map((f) => [f.not_captured, f.reason]), Array(2).fill(['client-closed-no-data', 'trusted-before']))
  assert.deepEqual(s.engine.negatives(), [])
  assert.deepEqual(s.critical(), [])
  await s.rejecting('transparent', 'pinned.test'); await s.settled(4)
  await s.rejecting('transparent', 'pinned.test'); await s.settled(5)
  assert.deepEqual(s.flows.slice(3).map((f) => [f.not_captured, f.reason]), Array(2).fill(['client-closed-no-data', 'engine-slow']))
  await s.alert(48, 'other.test'); await s.settled(6)
  assert.deepEqual(s.engine.negatives().map((e) => [e.host, e.cause]).sort(), [['other.test', 'client-rejected-leaf'], ['pinned.test', 'client-rejected-leaf']])
})

test('4.6 W21(b): a fast engine — a client of a trusted (pid, host) that refuses our leaf there is client-rejected-leaf, negative after two, one trust-rejected', T, async (t) => {
  const s = await rig(t)
  await s.used(); await s.settled(1)
  await s.rejecting(); await s.settled(2)
  assert.deepEqual(s.engine.negatives(), [])
  await s.rejecting(); await s.settled(3)
  assert.deepEqual(s.flows.slice(1).map((f) => f.not_captured), ['client-rejected-leaf', 'client-rejected-leaf'])
  assert.deepEqual(s.engine.negatives().map((e) => [e.host, e.cause]), [['h.test', 'client-rejected-leaf']])
  assert.equal(s.critical().length, 1)
})

const clock = () => { const c = { t: 1_000_000_000, now: () => c.t }; return c }

test('4.6 W22: an entry carries retry_at = now + NEG_RETRY_MS; before it the key is spliced, after it a trusting client is decrypted again', T, async (t) => {
  const c = clock()
  const s = await rig(t, { timing: { now: c.now } })
  await s.rejecting(); await s.settled(1)
  await s.rejecting(); await s.settled(2)
  assert.deepEqual(s.engine.negatives().map((e) => e.retry_at), [c.t + NEG_RETRY_MS])
  await s.rejecting(); await s.settled(3)
  assert.equal(s.flows[2].not_captured, 'negative-cache')
  c.t += NEG_RETRY_MS
  await s.used(); await s.settled(4)
  assert.deepEqual([s.flows[3].decision, s.flows[3].not_captured], ['decrypt', undefined])
})

test('4.6 W22: after retry_at one rejection renews the entry with a doubled backoff; the negative-cache record carries retry_at; no second trust-rejected', T, async (t) => {
  const c = clock()
  const s = await rig(t, { timing: { now: c.now } })
  await s.rejecting(); await s.settled(1)
  await s.rejecting(); await s.settled(2)
  assert.equal(s.critical().length, 1)
  c.t += NEG_RETRY_MS
  await s.rejecting(); await s.settled(3)
  const neg = s.fails.filter((f) => f.code === 'negative-cache')
  assert.equal(neg.length, 2)
  assert.equal(neg[1].retry_at, new Date(c.t + 2 * NEG_RETRY_MS).toISOString())
  assert.equal(s.critical().length, 1)
})
