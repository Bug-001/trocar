import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'; import tls from 'node:tls'; import { X509Certificate } from 'node:crypto'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { handleFlow } from '../../../src/collector/core/engine/flow.mjs'
import { createNegativeCache } from '../../../src/collector/core/engine/negcache.mjs'

const upCa = createCa({ commonName: 'upstream test CA' }); const upIssuer = createLeafIssuer(loadCa(upCa))
const asightCa = createCa(); const issuer = createLeafIssuer(loadCa(asightCa))
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
// Await an event-backed promise, but fail with a message instead of hanging the whole run if the
// event never comes (e.g. a flow that is never finalized).
const within = (p, what, ms = 5000) => {
  let t
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not within ${ms}ms`)), ms) })]).finally(() => clearTimeout(t))
}

async function harness({ meta = {}, policy = () => true, upstream, onAccept = () => {}, leafIssuer = issuer }) {
  const upPort = await listen(upstream)
  const envelopes = [], flows = [], failures = []
  const ctx = { issuer: leafIssuer, upstreamCa: upCa.certPem, policy, isRecording: () => true, negCache: createNegativeCache(), newFlowId: () => 'f' + flows.length,
    counters: { notCaptured: { h2: 0, httpsProxy: 0, upstreamCert: 0, negative: 0, leafError: 0 } }, failure: (r) => failures.push(r),
    // Snapshot each record when it is written, as the real store does (it serializes at call time):
    // a field the engine sets on the record afterwards never reaches flows/ on disk.
    store: { envelope: (e) => envelopes.push(structuredClone(e)), flow: (f) => flows.push(structuredClone(f)) },
    connectUpstream: (dst) => net.connect(dst.port, dst.address) }
  const done = []
  const engine = net.createServer((c) => { done.push(handleFlow(c, { dst: { address: '127.0.0.1', port: upPort, family: 4 }, pid: 1, agent: 't', decrypt: true, ...meta }, ctx)); onAccept(c) })
  const port = await listen(engine)
  // Resolves once every flow accepted so far has finalized (handleFlow's promise). Assert on flows
  // or envelopes only after this: the client can see the response end (the forwarded TLS
  // close_notify) before the engine has handled the upstream FIN that finalizes the flow.
  const settled = () => Promise.all(done)
  return { port, envelopes, flows, failures, ctx, settled, direct: [], close: async () => { await within(settled(), 'every flow finalized'); engine.close(); upstream.close() } }
}
const httpsUpstream = (handler) => tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)), ALPNProtocols: ['http/1.1'] }, handler)
const request = (port, ca, raw, opts = {}) => new Promise((resolve, reject) => {
  const c = tls.connect({ port, host: '127.0.0.1', servername: 'upstream.test', ca, ALPNProtocols: ['http/1.1'], ...opts }, () => c.write(raw))
  let got = Buffer.alloc(0); c.on('data', (d) => (got = Buffer.concat([got, d])))
  c.on('end', () => resolve({ got: got.toString('latin1'), cert: new X509Certificate(c.getPeerX509Certificate().raw) })); c.on('error', reject)
})
// Stand-in for the VPN/Clash hop an agent's CONNECT goes through. Like a real TCP relay it passes a
// FIN on as a FIN (allowHalfOpen) instead of closing its own write side: after the origin's FIN the
// engine still sends its TLS close_notify (its reply to the origin's) up the tunnel, and an
// auto-ended leg would turn that write into an EPIPE. An error on either leg tears the other down.
// closed() resolves once every leg has fully closed, so a test can end only after the hop is quiet.
function connectProxy(originPort, reply, { onOriginLeg = () => {} } = {}) {
  const legs = []
  const closed = (s) => new Promise((r) => s.once('close', r))
  const server = net.createServer({ allowHalfOpen: true }, (c) => {
    let o = null
    legs.push(closed(c)); c.on('error', () => o?.destroy())
    c.once('data', () => {
      o = net.connect({ port: originPort, host: '127.0.0.1', allowHalfOpen: true }, () => { c.write(reply); c.pipe(o); o.pipe(c) })
      legs.push(closed(o)); o.on('error', () => c.destroy())
      onOriginLeg(o)
    })
  })
  return { server, closed: () => Promise.all(legs) }
}
// Hold a socket's write-side shutdown open for `ms` after end(), as a loaded event loop does. Bytes
// that arrive meanwhile land after end() but before 'finish' — the window the flake needed.
const holdShutdown = (sock, ms) => { const final = sock._final; sock._final = (cb) => setTimeout(() => final.call(sock, cb), ms) }
// The first flight of a real client handshake (SNI upstream.test, ALPN http/1.1), captured raw.
async function clientHello() {
  const srv = net.createServer(); const port = await listen(srv)
  const got = new Promise((r) => srv.once('connection', (s) => s.once('data', (d) => { r(d); s.destroy() })))
  tls.connect({ port, host: '127.0.0.1', servername: 'upstream.test', ALPNProtocols: ['http/1.1'] }).on('error', () => {})
  const hello = await got; srv.close(); return hello
}
const once = (emitter, event) => new Promise((r) => emitter.once(event, r))
const REQ = 'POST /v1/messages HTTP/1.1\r\nHost: upstream.test\r\nContent-Length: 13\r\nConnection: close\r\n\r\n{"model":"m"}'
const RESP = 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nX-Odd-Case: KeepMe\r\nContent-Length: 9\r\nConnection: close\r\n\r\n{"ok":1} '.slice(0, -1)

test('decrypt: client sees an asight-issued leaf; both directions byte-identical; one envelope', async () => {
  let seen = ''
  const h = await harness({ upstream: httpsUpstream((s) => s.on('data', (d) => { seen += d.toString('latin1'); if (seen.endsWith('}')) s.end(RESP) })) })
  const r = await request(h.port, asightCa.certPem, REQ)
  await h.close()
  assert.equal(seen, REQ); assert.equal(r.got, RESP)
  assert.match(r.cert.issuer, /asight collector CA/)
  assert.equal(h.envelopes.length, 1); assert.equal(h.envelopes[0].req_body, '{"model":"m"}')
  assert.equal(h.flows[0].decision, 'decrypt')
})

test('splice: a process not marked decrypt sees the upstream certificate and nothing is recorded', async () => {
  const h = await harness({ meta: { decrypt: false }, upstream: httpsUpstream((s) => s.on('data', () => s.end(RESP))) })
  const r = await request(h.port, upCa.certPem, REQ)
  await h.close()
  assert.match(r.cert.issuer, /upstream test CA/); assert.equal(h.envelopes.length, 0); assert.equal(h.flows[0].decision, 'splice')
})

const h2Upstream = () => tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)), ALPNProtocols: ['h2'] }, (s) => s.end('x'))

test('splice: ALPN offering only h2 is never decrypted, and flows/ says not captured · h2 (T8)', async () => {
  const h = await harness({ upstream: h2Upstream() })
  const r = await request(h.port, upCa.certPem, 'x', { ALPNProtocols: ['h2'] })
  await h.close()
  assert.match(r.cert.issuer, /upstream test CA/); assert.equal(h.flows[0].decision, 'splice')
  assert.deepEqual([h.flows[0].not_captured, h.flows[0].reason], ['h2', 'alpn-h2-only']); assert.equal(h.ctx.counters.notCaptured.h2, 1)
})

test('an h2-only offer to a host the policy would not decrypt anyway is labelled policy (expected), not h2 (D38)', async () => {
  const h = await harness({ policy: () => false, upstream: h2Upstream() })
  await request(h.port, upCa.certPem, 'x', { ALPNProtocols: ['h2'] })
  await h.close()
  assert.equal(h.flows[0].decision, 'splice'); assert.equal(h.flows[0].not_captured, 'policy'); assert.equal(h.ctx.counters.notCaptured.h2, 0)
})

test('upstream reset mid-response: client gets exactly the bytes upstream sent, then a reset; error envelope written', async () => {
  const partial = 'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n6\r\ndata:\n\r\n'
  const h = await harness({ upstream: httpsUpstream((s) => s.on('data', () => { s.write(partial); setTimeout(() => s.destroy(), 50) })) })
  const got = await new Promise((resolve) => {
    const c = tls.connect({ port: h.port, host: '127.0.0.1', servername: 'upstream.test', ca: asightCa.certPem }, () => c.write(REQ))
    let b = ''; c.on('data', (d) => (b += d.toString('latin1'))); c.on('close', () => resolve(b)); c.on('error', () => {})
  })
  await h.close()
  assert.equal(got, partial)
  assert.equal(h.envelopes.length, 1); assert.equal(h.envelopes[0].error, true)
})

test('CONNECT tunnel: the proxy reply is relayed verbatim, then the inner TLS is decrypted', async () => {
  const origin = httpsUpstream((s) => s.on('data', () => s.end(RESP)))
  const originPort = await listen(origin)
  const proxyReply = 'HTTP/1.1 200 Connection established\r\nProxy-Agent: test-vpn/1.0\r\n\r\n'
  // The origin leg's shutdown completes late, so the engine's close_notify always crosses the
  // origin's FIN at the hop (the ordering that used to flake under load) instead of only sometimes.
  const proxy = connectProxy(originPort, proxyReply, { onOriginLeg: (o) => holdShutdown(o, 100) })
  const h = await harness({ upstream: proxy.server })
  const result = await new Promise((resolve, reject) => {
    const raw = net.connect(h.port, '127.0.0.1', () => raw.write('CONNECT upstream.test:443 HTTP/1.1\r\nHost: upstream.test:443\r\n\r\n'))
    raw.once('data', (d) => {
      const reply = d.toString('latin1')
      const t = tls.connect({ socket: raw, servername: 'upstream.test', ca: asightCa.certPem }, () => t.write(REQ))
      let b = ''; t.on('data', (x) => (b += x.toString('latin1'))); t.on('end', () => resolve({ reply, b })); t.on('error', reject)
    })
  })
  await within(proxy.closed(), 'both proxy legs closed')
  await h.close(); origin.close()
  assert.equal(result.reply, proxyReply); assert.equal(result.b, RESP)
  assert.equal(h.flows[0].decision, 'tunnel'); assert.equal(h.envelopes[0].host, 'upstream.test')
})

test('CONNECT refused by the proxy: the client receives the proxy refusal verbatim', async () => {
  const refusal = 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'
  const h = await harness({ upstream: net.createServer((c) => c.once('data', () => c.end(refusal))) })
  const got = await new Promise((resolve) => {
    const raw = net.connect(h.port, '127.0.0.1', () => raw.write('CONNECT x.test:443 HTTP/1.1\r\n\r\n'))
    let b = ''; raw.on('data', (d) => (b += d)); raw.on('close', () => resolve(b))
  })
  await h.close()
  assert.equal(got, refusal)
})

// RFC 4.6 §引擎 5 (D37) · W9: a Node client that does not trust the asight CA sends no alert. Under
// TLS 1.3 we only see a reset; under TLS 1.2 the handshake completes on our side and the client hangs up
// with zero application data. Both count; two in a row make (pid, host) negative, and the reason is on
// each record when it is written (the harness store snapshots, like the real one).
for (const maxVersion of ['TLSv1.2', 'TLSv1.3']) {
  test(`client rejects the leaf (${maxVersion}, no alert): two consecutive rejections → negative, then spliced (W9)`, async () => {
    const h = await harness({ upstream: httpsUpstream((s) => s.on('data', () => s.end(RESP))) })
    const untrusting = () => request(h.port, upCa.certPem, REQ, { maxVersion }).then(() => 'ok', () => 'rejected')
    assert.equal(await untrusting(), 'rejected'); await within(h.settled(), 'first flow finalized')
    assert.equal(h.flows[0].reason, 'client-rejected-leaf')
    assert.equal(h.ctx.negCache.list().length, 0, 'one rejection is not enough (pooled sockets close unused too)')
    assert.equal(await untrusting(), 'rejected'); await within(h.settled(), 'second flow finalized')
    assert.deepEqual(h.ctx.negCache.list().map((e) => [e.pid, e.host, e.cause, e.rejections]), [[1, 'upstream.test', 'client-rejected-leaf', 2]])
    // the negative-cache write is an event of its own, but the engine's negCache wrapper writes it (engine.test, once);
    // the flow must not write it a second time
    assert.deepEqual(h.failures, [], 'flow.mjs itself writes no negative-cache event (D-12: the engine owns it)')
    const r = await request(h.port, upCa.certPem, REQ, { maxVersion })
    await h.close()
    assert.match(r.cert.issuer, /upstream test CA/)
    assert.deepEqual(h.flows.map((f) => [f.decision, f.not_captured ?? null, f.reason ?? null]),
      [['decrypt', 'client-rejected-leaf', 'client-rejected-leaf'], ['decrypt', 'client-rejected-leaf', 'client-rejected-leaf'], ['splice', 'negative-cache', 'client-rejected-leaf']])
    assert.equal(h.ctx.counters.notCaptured.negative, 1)
  })
}

test('a connection that carries data resets the count: rejected, accepted, rejected is not negative (W9)', async () => {
  const h = await harness({ upstream: httpsUpstream((s) => s.on('data', () => s.end(RESP))) })
  await request(h.port, upCa.certPem, REQ).catch(() => {}); await within(h.settled(), 'first flow')
  await request(h.port, asightCa.certPem, REQ); await within(h.settled(), 'second flow')
  await request(h.port, upCa.certPem, REQ).catch(() => {})
  await h.close()
  assert.equal(h.ctx.negCache.list().length, 0)
  assert.deepEqual(h.flows.map((f) => f.reason ?? null), ['client-rejected-leaf', null, 'client-rejected-leaf'])
})

// The rule is about the CLIENT closing (RFC 4.6 §引擎 5: 客户端…随后关闭或 RST). A trusting client's idle
// connection (a preconnect) that the upstream closes, or that the engine itself tears down, says nothing
// about the leaf: no strike, no reason. (Fresh-context review finding: it used to count.)
test('a trusting client\'s idle connection closed by the UPSTREAM is no rejection: no reason, no strike, still decrypted (W9)', async () => {
  const h = await harness({ upstream: httpsUpstream((s) => setTimeout(() => s.end(), 30)) })
  const idle = () => new Promise((resolve) => {
    const c = tls.connect({ port: h.port, host: '127.0.0.1', servername: 'upstream.test', ca: asightCa.certPem }, () => { c.issuer = c.getPeerX509Certificate().issuer })
    c.on('error', () => {}); c.on('close', () => resolve(c.issuer))
  })
  for (let i = 0; i < 3; i++) { assert.match(await idle(), /asight collector CA/, `connection ${i + 1} decrypted`); await within(h.settled(), `flow ${i + 1}`) }
  await h.close()
  assert.deepEqual(h.flows.map((f) => [f.decision, f.reason ?? null]), [['decrypt', null], ['decrypt', null], ['decrypt', null]])
  assert.equal(h.ctx.negCache.strikes('1|upstream.test'), 0); assert.equal(h.ctx.negCache.list().length, 0)
})

// A recording TCP tap: every accepted connection is piped to 127.0.0.1:target(); conns[i] = {c, s} with
// the chunks each way, so a test can compare the bytes on both sides of the engine. closed() resolves
// once every connection so far has closed on both legs.
function tap(target) {
  const conns = [], legs = []
  const closed = (s) => new Promise((r) => s.once('close', r))
  const srv = net.createServer((a) => {
    const l = { c: [], s: [] }; conns.push(l)
    const b = net.connect(target(), '127.0.0.1')
    legs.push(closed(a), closed(b))
    a.on('data', (d) => { l.c.push(d); b.write(d) }); b.on('data', (d) => { l.s.push(d); a.write(d) })
    a.on('end', () => b.end()); b.on('end', () => a.end()); a.on('error', () => b.destroy()); b.on('error', () => a.destroy())
    a.on('close', () => b.destroy()); b.on('close', () => a.destroy())
  })
  return { srv, conns, closed: () => Promise.all(legs) }
}

// RFC 4.6 §引擎 5 · W12 (D37): the upstream's certificate does not verify for the engine (a private CA
// the engine does not trust), but the client trusts it. The engine steps aside: a fresh connection, the
// ClientHello replayed verbatim, then a splice — the client's own handshake succeeds end to end.
const privCa = createCa({ commonName: 'private relay CA' }); const privIssuer = createLeafIssuer(loadCa(privCa))
const privOrigin = () => tls.createServer({ SNICallback: (s, cb) => cb(null, privIssuer.secureContextFor(s)), ALPNProtocols: ['http/1.1'] }, (s) => {
  let seen = ''; s.on('data', (d) => { seen += d.toString('latin1'); if (seen.endsWith('}')) { seen = ''; s.write(RESP) } }); s.on('error', () => {})
})
const talk = (port, ca) => new Promise((resolve) => {
  let issuer = null; let got = ''
  const c = tls.connect({ port, host: '127.0.0.1', servername: 'upstream.test', ca, ALPNProtocols: ['http/1.1'] }, () => { issuer = c.getPeerX509Certificate().issuer; c.write(REQ) })
  c.on('data', (d) => { got += d.toString('latin1'); if (got.length >= RESP.length) c.end() })
  c.on('error', () => {}); c.on('close', () => resolve(issuer ? { issuer, got } : 'closed'))
})

test('upstream certificate does not verify: fresh connection, ClientHello replayed, the client handshakes with the real upstream; bytes identical (W12)', async () => {
  const origin = privOrigin(); const originPort = await listen(origin)
  const up = tap(() => originPort)                         // the original destination, recorded
  const h = await harness({ upstream: up.srv })            // the engine trusts the system roots + upCa only
  const front = tap(() => h.port); const frontPort = await listen(front.srv)
  const r = await talk(frontPort, privCa.certPem)
  await within(h.settled(), 'first flow finalized'); await within(up.closed(), 'upstream legs closed')
  assert.equal(r.got, RESP); assert.match(r.issuer, /private relay CA/)
  assert.equal(up.conns.length, 2, 'our dropped handshake, then the client\'s own')
  const sent = Buffer.concat(front.conns[0].c)
  assert.ok(!Buffer.concat(up.conns[0].c).includes(sent.subarray(11, 43)), 'none of the client\'s bytes (its ClientHello random) went on the unverified connection')
  assert.ok(sent.equals(Buffer.concat(up.conns[1].c)), 'client → upstream bytes identical')
  // upstream → client: identical up to the client's FIN; the upstream's close_notify answering that FIN
  // finds the client gone (relay tears the upstream down on client end, T3), so at most that one
  // trailing TLS record is not delivered
  const back = Buffer.concat(up.conns[1].s), got = Buffer.concat(front.conns[0].s), tail = back.subarray(got.length)
  assert.ok(back.subarray(0, got.length).equals(got), 'upstream → client bytes identical')
  assert.ok(tail.length === 0 || tail.length === 5 + tail.readUInt16BE(3), 'nothing missing but the closing record')
  assert.equal(h.envelopes.length, 0)
  assert.deepEqual([h.flows[0].decision, h.flows[0].not_captured], ['splice', 'upstream-cert']); assert.match(h.flows[0].reason, /CERT|SIGNATURE|ISSUER/)
  assert.deepEqual(h.ctx.negCache.list().map((e) => [e.host, e.cause]), [['upstream.test', 'upstream-cert']])
  assert.deepEqual(h.failures, [], 'the upstream-cert step-aside writes no failure of its own here: the engine\'s negCache wrapper does (engine.test / tls-roots)')
  // the next flow to that host splices at once: one upstream connection, no handshake of ours
  const r2 = await talk(frontPort, privCa.certPem)
  await h.close(); front.srv.close(); origin.close()
  assert.equal(r2.got, RESP); assert.equal(up.conns.length, 3)
  assert.deepEqual([h.flows[1].decision, h.flows[1].not_captured, h.flows[1].reason], ['splice', 'negative-cache', 'upstream-cert'])
  assert.deepEqual([h.ctx.counters.notCaptured.upstreamCert, h.ctx.counters.notCaptured.negative], [1, 1])
})

test('a network failure during our upstream handshake still closes the client: no retry, nothing negative (W12)', async () => {
  let conns = 0
  const h = await harness({ upstream: net.createServer((s) => { conns++; s.on('error', () => {}); s.on('data', () => s.destroy()) }) })
  const r = await talk(h.port, upCa.certPem)
  await h.close()
  assert.equal(r, 'closed'); assert.equal(conns, 1)
  assert.equal(h.ctx.negCache.list().length, 0); assert.equal(h.flows[0].not_captured, 'error', 'a network failure, not upstream-cert (D38)')
  assert.equal(h.flows[0].error.side, 'upstream', 'our upstream handshake failed: the upstream side (D38)')
})

test('an upstream that refuses the connection: flows/ error names the upstream side (D38)', async () => {
  const dead = net.createServer(); const deadPort = await listen(dead); dead.close()
  const h = await harness({ upstream: net.createServer() })
  const engine = net.createServer((c) => { h.direct.push(handleFlow(c, { dst: { address: '127.0.0.1', port: deadPort, family: 4 }, pid: 1, agent: 't', decrypt: true }, h.ctx)) })
  const port = await listen(engine)
  assert.equal(await talk(port, asightCa.certPem), 'closed')
  await within(Promise.all(h.direct), 'flow finalized'); engine.close(); await h.close()
  assert.deepEqual([h.flows[0].decision, h.flows[0].error.type, h.flows[0].error.side], ['error', 'ECONNREFUSED', 'upstream'])
})

test('inside a CONNECT tunnel an unverifiable upstream closes that one flow (no prelude replay); the retry is spliced (W12, invariant 1)', async () => {
  const origin = privOrigin(); const originPort = await listen(origin)
  let proxied = 0
  const proxy = net.createServer((c) => c.once('data', () => {
    proxied++
    const o = net.connect(originPort, '127.0.0.1', () => { c.write('HTTP/1.1 200 OK\r\n\r\n'); c.pipe(o); o.pipe(c) })
    o.on('error', () => c.destroy()); c.on('error', () => o.destroy()); c.on('close', () => o.destroy())
  }))
  const h = await harness({ upstream: proxy })
  const viaConnect = () => new Promise((resolve) => {
    const raw = net.connect(h.port, '127.0.0.1', () => raw.write('CONNECT upstream.test:443 HTTP/1.1\r\nProxy-Authorization: Basic dTpw\r\n\r\n'))
    raw.on('error', () => {}); raw.on('close', () => resolve('closed'))
    raw.once('data', () => {
      let got = ''
      const t = tls.connect({ socket: raw, servername: 'upstream.test', ca: privCa.certPem }, () => t.write(REQ))
      t.on('data', (x) => { got += x.toString('latin1'); if (got.length >= RESP.length) { resolve(got); t.end() } }); t.on('error', () => {})
    })
  })
  assert.equal(await viaConnect(), 'closed'); await within(h.settled(), 'first flow finalized')
  assert.equal(await viaConnect(), RESP)
  await h.close(); origin.close()
  assert.equal(proxied, 2, 'the engine never re-sent a CONNECT prelude (with the agent\'s proxy credentials)')
  assert.deepEqual(h.flows.map((f) => [f.decision, f.not_captured]), [['tunnel', 'upstream-cert'], ['tunnel', 'negative-cache']])
  assert.equal(h.flows[0].error.type, 'upstream_cert')
})

test('client abort mid-flight tears down the upstream socket (acceptance T3)', async () => {
  let upSock = null; let upClosedAt = 0
  let reached; const requestReached = new Promise((r) => { reached = r })
  let upClosed; const closedUp = new Promise((r) => { upClosed = r })
  // consume the request bytes (a real upstream reads them) so the socket reports close on the RST
  const h = await harness({ upstream: httpsUpstream((s) => { upSock = s; s.on('data', () => reached()); s.on('close', () => { upClosedAt = Date.now(); upClosed() }) }) })
  const c = tls.connect({ port: h.port, host: '127.0.0.1', servername: 'upstream.test', ca: asightCa.certPem }, () => c.write(REQ))
  c.on('error', () => {})
  // wait for the decrypt handshake + REQ to reach the upstream (a fixed 120 ms flaked under a loaded suite)
  await within(requestReached, 'the decrypted request reached the upstream')
  assert.ok(upSock, 'upstream should have accepted the decrypted connection')
  const t = Date.now(); c.destroy()
  await within(closedUp, 'the upstream socket closed after the client abort', 1000)
  await h.close()
  // "at once" (relay destroys the upstream on the client's end), with room for a loaded parallel suite (134 ms
  // seen at 8 parallel runs); without the teardown the upstream only closes at its idle timeout, never here
  assert.ok(upClosedAt > 0 && upClosedAt - t < 400, `upstream closed ${upClosedAt - t}ms after client abort`)
})

test('client reset before a routing decision is caught: flow finalized with the error, upstream dropped (T3)', async () => {
  const hello = await clientHello()
  // [when, first bytes the client sends, what shows the engine is inside that window]
  const cases = [
    ['before its first byte', null, 'accepted'],
    ['mid-ClientHello', hello.subarray(0, 20), 'engine-read'],
    ['mid-CONNECT head', Buffer.from('CONNECT x.test:443 HTTP/1.1\r\n'), 'engine-read'],
    ['waiting for the proxy reply to its CONNECT', Buffer.from('CONNECT x.test:443 HTTP/1.1\r\n\r\n'), 'upstream-read'], // upstream never replies
    ['during the upstream TLS handshake', hello, 'upstream-read'], // upstream never answers the engine's ClientHello
  ]
  for (const [when, first, ready] of cases) {
    let upSock = null, upClosed = null, engineRead = null
    const upstream = net.createServer((s) => { upSock = s; upClosed = once(s, 'close'); s.on('error', () => {}); s.on('data', () => {}) })
    const upAccepted = once(upstream, 'connection')
    const h = await harness({ upstream, onAccept: (c) => { engineRead = once(c, 'data') } })
    const c = net.connect(h.port, '127.0.0.1', () => { if (first) c.write(first) }); c.on('error', () => {})
    await within(upAccepted, when) // the engine has accepted the client and dialled the upstream: no decision yet
    if (ready === 'engine-read') await within(engineRead, when)
    if (ready === 'upstream-read') await within(once(upSock, 'data'), when)
    c.resetAndDestroy()
    await h.close()
    await within(upClosed, `${when}: upstream dropped`)
    assert.equal(h.flows.length, 1, when); assert.equal(h.flows[0].decision, 'error', when)
    assert.equal(h.flows[0].error?.type, 'ECONNRESET', when); assert.equal(h.flows[0].error?.side, 'client', when)
  }
})

// D38: a capture failure is never silent — and an internal error costs one flow, never
// the collector (fail-open). RFC 4.6 §引擎 5 / §记录「采集失败不静默」.
test('a leaf the engine cannot issue steps aside like an unverifiable upstream: the client reaches the real upstream; flows/ says leaf-error (connection row and failure event); nothing negative (D38)', async () => {
  const h = await harness({ upstream: httpsUpstream((s) => s.on('data', () => s.end(RESP))), leafIssuer: { secureContextFor() { throw new Error('cannot sign a leaf') } } })
  const r = await request(h.port, upCa.certPem, REQ)
  await h.close()
  assert.match(r.cert.issuer, /upstream test CA/); assert.equal(r.got, RESP)
  assert.deepEqual([h.flows[0].decision, h.flows[0].not_captured, h.flows[0].reason], ['splice', 'leaf-error', 'cannot sign a leaf'])
  assert.deepEqual(h.failures.map((f) => [f.code, f.flow_id, f.host, f.reason]), [['leaf-error', h.flows[0].flow_id, 'upstream.test', 'cannot sign a leaf']])
  assert.equal(h.ctx.negCache.list().length, 0, 'asight\'s own fault, not a property of the host'); assert.equal(h.ctx.counters.notCaptured.leafError, 1)
})

test('an internal error while routing (here the daemon\'s policy throws) ends that one flow with a record, not the collector (D38)', async () => {
  const h = await harness({ policy: () => { throw new Error('policy bug') }, upstream: httpsUpstream((s) => s.on('data', () => s.end(RESP))) })
  const r = await talk(h.port, upCa.certPem)
  await h.close()
  assert.equal(r, 'closed')
  assert.deepEqual([h.flows[0].decision, h.flows[0].error.type, h.flows[0].error.message], ['error', 'engine_error', 'policy bug'])
  assert.deepEqual(h.failures.map((f) => [f.code, f.flow_id, f.reason]), [['engine-error', h.flows[0].flow_id, 'policy bug']])
})

test('a socket error on either side reaches flows/ with its side (D38)', async () => {
  let gotReq
  const seen = new Promise((r) => { gotReq = r })
  const h = await harness({ upstream: httpsUpstream((s) => { s.on('error', () => {}); s.on('data', () => gotReq()) }) })
  const raw = net.connect(h.port, '127.0.0.1'); raw.on('error', () => {})
  const c = tls.connect({ socket: raw, servername: 'upstream.test', ca: asightCa.certPem }, () => c.write(REQ)); c.on('error', () => {})
  await within(seen, 'request reached the upstream')
  raw.resetAndDestroy()
  await h.close()
  assert.deepEqual([h.flows[0].decision, h.flows[0].error?.type, h.flows[0].error?.side], ['decrypt', 'ECONNRESET', 'client'])
})

// RFC 4.6 §记录: bytes_up / bytes_down are the agent's own connection's wire bytes,
// the same measure for every path. They used to count only what relay() forwarded: decrypted flows counted
// plaintext, and bytes written before relay (a CONNECT prelude and the proxy's reply, the first chunk of a
// client-first splice) were missing.
test('flows/ bytes_up / bytes_down == the agent socket\'s own counters: decrypted, through a CONNECT prelude, and a client-first splice', async () => {
  const viaTls = (port, prelude) => new Promise((resolve) => {
    const raw = net.connect(port, '127.0.0.1', () => { if (prelude) raw.write(prelude); else go() })
    raw.on('error', () => {})
    const go = () => { const t = tls.connect({ socket: raw, servername: 'upstream.test', ca: asightCa.certPem }, () => t.write(REQ)); t.resume(); t.on('error', () => {}); t.on('close', () => resolve(raw)) }
    if (prelude) raw.once('data', go)
  })
  const counted = (h) => [h.flows[0].bytes_up, h.flows[0].bytes_down]
  const d = await harness({ upstream: httpsUpstream((s) => s.on('data', () => s.end(RESP))) })
  const r1 = await viaTls(d.port); await d.close()
  assert.deepEqual(counted(d), [r1.bytesWritten, r1.bytesRead], 'decrypted: TLS records, handshake and closing alerts included')
  const origin = httpsUpstream((s) => s.on('data', () => s.end(RESP))); const originPort = await listen(origin)
  const proxy = connectProxy(originPort, 'HTTP/1.1 200 Connection established\r\n\r\n')
  const t = await harness({ upstream: proxy.server })
  const r2 = await viaTls(t.port, 'CONNECT upstream.test:443 HTTP/1.1\r\nHost: upstream.test:443\r\n\r\n')
  await within(proxy.closed(), 'proxy legs closed'); await t.close(); origin.close()
  assert.equal(t.flows[0].decision, 'tunnel'); assert.deepEqual(counted(t), [r2.bytesWritten, r2.bytesRead], 'the CONNECT prelude and the proxy reply count')
  const s = await harness({ upstream: net.createServer((u) => u.once('data', (x) => u.end(Buffer.concat([x, x])))) })
  const r3 = await new Promise((resolve) => { const c = net.connect(s.port, '127.0.0.1', () => c.write('hello?')); c.resume(); c.on('close', () => resolve(c)) })
  await s.close()
  assert.equal(s.flows[0].decision, 'splice'); assert.deepEqual(counted(s), [6, 12]); assert.deepEqual(counted(s), [r3.bytesWritten, r3.bytesRead])
})

// D38 / invariant 4: an HTTP framing error stops recording the rest of the connection — recorded when it
// happens, and the open exchange says framer_error, not a connection reset it never was.
test('an upstream framing error is a framer-error failure event with the flow id; the open exchange is written as framer_error (D38)', async () => {
  const bad = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\nxx\r\n0\r\n\r\n'
  const h = await harness({ upstream: httpsUpstream((s) => s.on('data', () => s.end(bad))) })
  const r = await request(h.port, asightCa.certPem, REQ)
  await h.close()
  assert.equal(r.got, bad, 'forwarded untouched')
  assert.deepEqual(h.failures.map((f) => [f.code, f.flow_id, f.side]), [['framer-error', h.flows[0].flow_id, 'response']])
  assert.deepEqual(h.envelopes.map((e) => [e.error, e.resp.error?.type]), [[true, 'framer_error']])
})
