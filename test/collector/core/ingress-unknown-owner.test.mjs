// ingress-unknown-owner.test.mjs — an opener the door cannot take (RFC 4.8 §5.1 实现细节, W13): the ingress-unknown record names the process
// that sent it, asked through the redirector's ownerOfPeer (the arch's owner question, injected here), or says why it could not be told; a
// plain-HTTP opener adds its method and target host, never its path, query or headers; the door's answer to the opener is the same with or
// without an owner question (closed, no byte said).
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { checkRecord } from '../../../src/health/codes.mjs'
import { within, closeWithin } from '../../helpers/bounded.mjs'

const T = { timeout: 20_000 }
const TOKEN = 'fake-token-0123456789abcdef-not-real'
const ca = createCa()

async function door(t, ownerOfPeer) {
  const failures = []
  const redirector = Object.assign(createStaticRedirector(), ownerOfPeer ? { ownerOfPeer } : {})
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(ca)), store: { envelope: () => true, flow: () => true }, onFailure: (f) => failures.push(f), ingressToken: TOKEN })
  const { ingressPort } = await engine.listen({ ingress: { port: 0 } })
  t.after(() => closeWithin(engine))
  // send the bytes, collect what the door says until it closes
  const send = (bytes) => within(new Promise((res) => {
    const s = net.connect(ingressPort, '127.0.0.1'); let got = Buffer.alloc(0), local = null
    s.on('error', () => {}); s.on('data', (d) => { got = Buffer.concat([got, d]) }); s.on('close', () => res({ said: got, local }))
    s.on('connect', () => { local = s.localPort; s.write(bytes) })
  }), 4000, 'the door closing the connection')
  return { failures, send }
}

const OPENERS = [ // the varying axis: the shapes of a non-proxy opener; host is what the record may carry, never the path or query
  { bytes: 'HEAD http://user:secret@probe.example:8080/a/path?q=1 HTTP/1.1\r\nHost: probe.example:8080\r\nX-Api-Key: fake\r\n\r\n', method: 'HEAD', host: 'probe.example' },
  { bytes: 'HEAD / HTTP/1.1\r\nhost: Other.Example\r\nAuthorization: fake\r\n\r\n', method: 'HEAD', host: 'other.example' },
  { bytes: 'POST /x?y=z HTTP/1.1\r\n\r\n', method: 'POST', host: undefined },
  { bytes: Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 1, 2, 3, 4, 5]), method: undefined, host: undefined },
]

test('W13 an ingress-unknown record carries the pid and name of the process that sent the opener, and method / host of a plain-HTTP one only', T, async (t) => {
  const asked = []
  const D = await door(t, async (peer) => { asked.push(peer.port); return { pid: 4321, process: 'codex' } })
  for (const o of OPENERS) {
    const r = await D.send(o.bytes)
    assert.equal(r.said.length, 0, 'the door says nothing to an opener it cannot take')
    const f = D.failures.at(-1)
    assert.deepEqual([f.where, f.code, f.pid, f.process, f.method, f.host], ['ingress', 'ingress-unknown', 4321, 'codex', o.method, o.host])
    assert.equal(f.peer.port, r.local, 'the owner asked is the peer of this connection')
    assert.deepEqual(checkRecord({ event: 'failure', ...f }), [])
    const text = JSON.stringify(f)
    for (const never of ['/a/path', 'q=1', 'y=z', 'secret', 'X-Api-Key', 'Authorization', 'fake']) assert.equal(text.includes(never), false, `${never} is not recorded`)
  }
  assert.equal(D.failures.length, OPENERS.length)
  assert.equal(asked.length, OPENERS.length)
})

test('W13 an owner question that finds nothing, or fails, writes why instead of a pid; the answer to the opener is unchanged', T, async (t) => {
  for (const answer of [async () => ({ pid: null, why: 'no-row' }), async () => { throw new Error('the table could not be read') }]) {
    const D = await door(t, answer)
    const r = await D.send('HEAD / HTTP/1.1\r\nHost: h.example\r\n\r\n')
    assert.equal(r.said.length, 0)
    const [f] = D.failures
    assert.equal(f.code, 'ingress-unknown'); assert.equal(f.pid ?? null, null); assert.equal(f.process ?? null, null)
    assert.equal(typeof f.owner_unread, 'string'); assert.ok(f.owner_unread.length > 0)
  }
})

test('W13 the door does not wait on one owner question: another connection is answered while it is unanswered', T, async (t) => {
  let release
  const D = await door(t, () => new Promise((res) => { release = () => res({ pid: 7, process: 'slow' }) }))
  const first = D.send('HEAD / HTTP/1.1\r\n\r\n')
  while (!release) await new Promise((r) => setTimeout(r, 5))
  const second = await D.send('CONNECT h.example:443 HTTP/1.1\r\n\r\n') // no credentials: the 407 challenge, at once
  assert.match(second.said.toString('latin1'), /^HTTP\/1\.1 407 /)
  release()
  const r = await first
  assert.equal(r.said.length, 0)
  assert.deepEqual(D.failures.map((f) => [f.code, f.pid, f.process]), [['ingress-unknown', 7, 'slow']])
})
