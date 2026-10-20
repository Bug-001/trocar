// test/collector/core/ingress-pac.test.mjs — CM19 / CM33 at the ingress (4.11 P10, plan §E.6 ruling 2): an origin-form GET is served only on an
// auth:false door, through the injected servePac; on a door that takes credentials (or with no server) it is closed and recorded ingress-unknown, and
// no lookup is asked. The CONNECT's X-Trocar-Upstream reaches the lookup (4.11 P7 step 1) and nothing else.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createIngress } from '../../../src/collector/core/engine/ingress.mjs'

const T = { timeout: 10_000 }
async function door(t, { open, servePac = null, lookupIngress = async () => null }) {
  const failures = [], asked = []
  const ing = createIngress({ token: 'f'.repeat(32), failure: (f) => failures.push(f), handleFlow: () => {}, connectUpstream: () => { throw new Error('no upstream in this test') }, servePac, lookupIngress: async (q) => { asked.push(q); return lookupIngress(q) } })
  const srv = net.createServer((s) => ing.connection(s, { user: 'h:pac', token: open ? null : 'a'.repeat(32), open }))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => srv.close(r)))
  const send = (text) => new Promise((resolve) => {
    const c = net.connect(srv.address().port, '127.0.0.1', () => c.write(text))
    let got = ''
    c.on('data', (d) => { got += d.toString('latin1') }); c.on('close', () => resolve(got)); c.on('error', () => {})
  })
  return { send, failures, asked }
}

test('CM19 · GET /trocar.pac on an auth:false door is answered by servePac with the peer and the door group', T, async (t) => {
  const calls = []
  const d = await door(t, { open: true, servePac: async (q) => { calls.push(q); return { status: 200, headers: { 'content-type': 'application/x-ns-proxy-autoconfig' }, body: 'function FindProxyForURL(){return "DIRECT"}' } } })
  const got = await d.send('GET /trocar.pac HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
  assert.match(got, /^HTTP\/1\.1 200 OK\r\n/)
  assert.match(got, /content-type: application\/x-ns-proxy-autoconfig/)
  assert.match(got, /FindProxyForURL/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].user, 'h:pac'); assert.equal(calls[0].path, '/trocar.pac'); assert.equal(calls[0].peer.address, '127.0.0.1')
  assert.deepEqual(d.asked, [], 'a GET is not a lookup')
})

test('CM33 · a GET on a door that takes credentials is closed, recorded ingress-unknown, and servePac is never asked', T, async (t) => {
  let asked = 0
  const d = await door(t, { open: false, servePac: async () => { asked++; return { status: 200, body: 'x' } } })
  assert.equal(await d.send('GET /trocar.pac HTTP/1.1\r\nHost: x\r\n\r\n'), '')
  assert.equal(asked, 0)
  assert.equal(d.failures.length, 1); assert.equal(d.failures[0].code, 'ingress-unknown'); assert.match(d.failures[0].reason, /GET/)
})

test('CM33 · an open door with no PAC server, or an absolute-URI GET, is closed and recorded; a refused peer (servePac null) gets nothing', T, async (t) => {
  const none = await door(t, { open: true })
  assert.equal(await none.send('GET /trocar.pac HTTP/1.1\r\n\r\n'), '')
  assert.equal(none.failures[0].code, 'ingress-unknown')
  const d = await door(t, { open: true, servePac: async () => null })
  assert.equal(await d.send('GET http://x/trocar.pac HTTP/1.1\r\n\r\n'), '')
  assert.equal(d.failures[0].code, 'ingress-unknown')
  assert.equal(await d.send('GET /trocar.pac HTTP/1.1\r\n\r\n'), '', 'servePac said no (another user): the socket is closed with no answer')
})

test('CM20 · the CONNECT\'s X-Trocar-Upstream reaches the lookup as `header`; a CONNECT without it carries none', T, async (t) => {
  const d = await door(t, { open: true })
  await d.send('CONNECT api.example:443 HTTP/1.1\r\nX-Trocar-Upstream: http://corp:3128\r\n\r\n')
  await d.send('CONNECT api.example:443 HTTP/1.1\r\n\r\n')
  assert.equal(d.asked[0].header, 'http://corp:3128')
  assert.equal('header' in d.asked[1], false)
})

test('a door URL whose user is the group id `<harness>:<route>` authenticates: the password is what follows the LAST colon', T, async (t) => {
  const d = await door(t, { open: false })
  const basic = Buffer.from(`h:pac:${'a'.repeat(32)}`).toString('base64')
  await d.send(`CONNECT api.example:443 HTTP/1.1\r\nProxy-Authorization: Basic ${basic}\r\n\r\n`)
  assert.equal(d.asked.length, 1, 'the token held: the lookup was asked')
  assert.equal(d.failures[0].reason, 'unknown user')
})

test('CM33 · a refusal by process on the PAC door (lookup answers {refuse}) is ONE record of its code with the peer, zero ingress-auth-failed, and the connection closed with zero bytes — not a 407 (4.8 §5.1, 4.11 P10)', T, async (t) => {
  const d = await door(t, { open: true, lookupIngress: async () => ({ refuse: { code: 'pac-peer-refused', reason: 'pid ?: not shown to be this user\'s (no-row)' } }) })
  const got = await d.send('CONNECT api.example:443 HTTP/1.1\r\nHost: api.example:443\r\n\r\n')
  assert.equal(got, '', 'closed without an answer')
  assert.equal(d.failures.filter((f) => f.code === 'ingress-auth-failed').length, 0)
  const refused = d.failures.filter((f) => f.code === 'pac-peer-refused')
  assert.equal(refused.length, 1)
  assert.equal(refused[0].where, 'ingress')
  assert.ok(refused[0].peer, 'the record names the peer')
})

test('CM33 · null from the lookup keeps its one meaning on any door: unknown user → 407 and ingress-auth-failed', T, async (t) => {
  const d = await door(t, { open: true })
  assert.match(await d.send('CONNECT api.example:443 HTTP/1.1\r\nHost: api.example:443\r\n\r\n'), /^HTTP\/1\.1 407 /)
  assert.equal(d.failures.filter((f) => f.code === 'ingress-auth-failed').length, 1)
})
