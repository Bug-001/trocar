// test/capture/legacy-failures.test.mjs — the old capture's failures are never silent (D38; RFC 4.1 「过渡期采集源的失败也
// 不静默」 + 验收 #6 / #6b): an agent that refuses the CA's leaf (L-1), an upstream that closes mid-response (L-2), an SSE
// stream that cannot be decompressed (L-3), a body that is not JSON (L-4), an SSE `data:` line that is not JSON (L-5),
// a blind tunnel that fails (L-10, counted only) — each leaves its record; the client gets the bytes or an ended
// response, never a hang; every event line passes the D38 closed sets. Offline: injected upstreams, throwaway certs.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { once } from 'node:events'
import { createReverseProxy } from '../../src/capture/reverse-proxy.mjs'
import { createMitmProxy, makeBlindTunnel } from '../../src/capture/mitm.mjs'
import { makeSseReconstructor } from '../../src/capture/sse-reconstruct.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../src/collector/core/tls/leaf.mjs'
import { checkRecord } from '../../src/health/codes.mjs'

const listen = async (srv) => { srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); return srv.address().port }
// an upstream answering every request with `handler(req, res)`
async function upstream(handler) { const srv = http.createServer(handler); const port = await listen(srv); return { port, close: () => srv.close() } }
async function proxied(handler, opts = {}) {
  const up = await upstream(handler)
  const envelopes = [], events = []
  const px = createReverseProxy({ target: `http://127.0.0.1:${up.port}`, onEnvelope: (e) => envelopes.push(e), onEvent: (e) => events.push(e), ...opts })
  const port = await listen(px)
  const send = () => new Promise((resolve) => {
    setTimeout(() => resolve({ ended: 'hung' }), 3000).unref() // a response left open is a failure of its own
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), ended: 'end' }))
      res.on('error', (e) => resolve({ status: res.statusCode, body: Buffer.concat(chunks), ended: 'error', e }))
      res.on('aborted', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), ended: 'aborted' }))
    })
    r.on('error', (e) => resolve({ ended: 'error', e }))
    r.end('{"model":"m","messages":[]}')
  })
  const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)) }
  return { envelopes, events, send, until, close: () => { px.close(); up.close() } }
}
const allInSet = (events) => { for (const e of events) assert.deepEqual(checkRecord({ ts: 't', ...e }), [], JSON.stringify(e)) }

// cut = how the upstream ends mid-response: a FIN (destroy) or a reset (RST → ECONNRESET on the proxy's request too,
// which once wrote a second envelope with the same id and appended an error JSON to the client's stream)
const cutSocket = (sock, cut) => { const raw = sock._parent || sock; if (cut === 'reset') (raw.resetAndDestroy ? raw : sock).resetAndDestroy(); else sock.destroy() }
for (const cut of ['fin', 'reset']) {
  test(`L-2 (${cut}): an upstream that closes mid-response → one error:true envelope with what arrived, the client's response ended (not hanging, nothing appended), an upstream-aborted event`, async () => {
    const p = await proxied((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"x"}}\n\n'); setTimeout(() => cutSocket(res.socket, cut), 20) })
    try {
      const r = await p.send()
      assert.ok(['error', 'aborted'].includes(r.ended), `the client sees the response cut — not complete, not hanging (${r.ended})`)
      assert.ok(!String(r.body || '').includes('"error"'), 'no error JSON appended to the event stream')
      await p.until(() => p.envelopes.length)
      await new Promise((ok) => setTimeout(ok, 100)) // a second envelope would come by now
      assert.equal(p.envelopes.length, 1, 'one envelope per request')
      const env = p.envelopes[0]
      assert.deepEqual([env.error, env.resp.kind, env.resp.error.type, env.resp.partial.message.id], [true, 'error', 'upstream_aborted', 'm1'])
      assert.deepEqual(p.events.map((e) => [e.where, e.code]), [['proxy', 'upstream-aborted']])
      allInSet(p.events)
    } finally { p.close() }
  })
}

test('L-3: a compressed SSE stream that cannot be decompressed → the envelope still comes, with encoding_error and the wire bytes; a decode-failed event', async () => {
  const garbage = Buffer.from('this is not gzip at all, but says it is')
  const p = await proxied((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }); res.end(garbage) })
  try {
    const r = await p.send()
    assert.ok(r.body.equals(garbage), 'the client got the bytes as sent')
    await p.until(() => p.envelopes.length)
    const env = p.envelopes[0]
    assert.equal(env.error, undefined)
    assert.ok(env.resp.encoding_error && Buffer.from(env.resp.raw_b64, 'base64').equals(garbage))
    assert.deepEqual(p.events.map((e) => [e.where, e.code]), [['proxy', 'Z_DATA_ERROR']], 'Node\'s own code')
    allInSet(p.events)
  } finally { p.close() }
})

test('L-4: a body that is not JSON keeps its text; one that cannot be decompressed keeps its bytes', async () => {
  const html = '<html><body>502 Bad Gateway (from a proxy)</body></html>'
  let p = await proxied((req, res) => { res.writeHead(502, { 'content-type': 'text/html' }); res.end(html) })
  try {
    await p.send(); await p.until(() => p.envelopes.length)
    assert.deepEqual([p.envelopes[0].resp.kind, p.envelopes[0].resp.raw], ['text', html], 'never just a character count')
  } finally { p.close() }
  const bad = Buffer.from([1, 2, 3, 250])
  p = await proxied((req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' }); res.end(bad) })
  try {
    await p.send(); await p.until(() => p.envelopes.length)
    const r = p.envelopes[0].resp
    assert.ok(r.encoding_error && Buffer.from(r.raw_b64, 'base64').equals(bad))
  } finally { p.close() }
  p = await proxied((req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(zlib.gzipSync('{"ok":1}')) })
  try { await p.send(); await p.until(() => p.envelopes.length); assert.deepEqual(p.envelopes[0].resp.body, { ok: 1 }, 'a good body is unchanged') } finally { p.close() }
})

test('L-5: an SSE data: line that is not JSON is counted, and kept with --raw-sse', () => {
  for (const keep of [false, true]) {
    const r = makeSseReconstructor(keep)
    r.push(Buffer.from('data: {"type":"message_start","message":{"id":"a"}}\n\ndata: <html>oops</html>\n\n'))
    const f = r.finish()
    assert.equal(f.unparsed_events, 1, `keepRaw=${keep}`)
    if (keep) assert.deepEqual(f.raw_sse.at(-1), { unparsed: '<html>oops</html>' })
  }
  assert.equal(makeSseReconstructor().finish().unparsed_events, undefined, 'none: no field')
})

test('L-1: an agent that refuses the capture\'s leaf (does not trust the CA) — every handshake is a failure line with its code; L-10: a failed blind tunnel is counted and logged, never an event line', async () => {
  const ca = createCa({ commonName: 'asight legacy test CA' })
  const leafCtx = createLeafIssuer(loadCa(ca)).issue('api.anthropic.com')
  const events = []
  const px = createMitmProxy({ targetHost: 'api.anthropic.com', leaf: { key: leafCtx.keyPem, cert: leafCtx.certPem }, onEnvelope: () => {}, onEvent: (e) => events.push(e),
    connectUpstream: () => { throw new Error('never reached') }, blindTunnel: () => {} })
  const port = await listen(px)
  try {
    // TLS 1.3 (the server never sees the client's Finished) and TLS 1.2 (it does, then the client closes): Node clients
    // send no alert either way — they check the chain in JS and close
    for (const v of ['TLSv1.3', 'TLSv1.2']) {
      await new Promise((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => sock.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n'))
        sock.once('data', () => {
          const t = tls.connect({ socket: sock, servername: 'api.anthropic.com', minVersion: v, maxVersion: v }) // the system store: the asight CA is not in it
          t.on('error', () => { sock.destroy(); resolve() }) // as an agent does: the tunnel goes with the refused TLS session
        })
      })
    }
    for (let i = 0; i < 200 && events.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(events.length, 2, 'one line per refused handshake')
    assert.deepEqual(events.map((e) => e.code).sort(), ['ECONNRESET', 'client-rejected-leaf'], JSON.stringify(events))
    assert.ok(events.every((e) => e.where === 'mitm' && /TLS handshake with the capture .*may not trust the asight CA/.test(e.reason)), JSON.stringify(events))
    allInSet(events)
  } finally { px.close() }
  // a blind tunnel (outside the target) whose upstream proxy refuses: counted and logged, never an event line
  const refuse = net.createServer((s) => s.once('data', () => s.end('HTTP/1.1 403 Forbidden\r\n\r\n')))
  const rp = await listen(refuse)
  const logs = [], blindEvents = []
  const px2 = createMitmProxy({ targetHost: 'api.anthropic.com', leaf: { key: leafCtx.keyPem, cert: leafCtx.certPem }, upstreamProxy: `http://127.0.0.1:${rp}`, onEnvelope: () => {}, onEvent: (e) => blindEvents.push(e), log: (m) => logs.push(m) })
  const p2 = await listen(px2)
  try {
    const status = await new Promise((resolve) => {
      const sock = net.connect(p2, '127.0.0.1', () => sock.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'))
      sock.on('data', () => {}); sock.on('close', () => resolve('closed')); sock.on('error', () => {})
      setTimeout(() => { resolve('hung'); sock.destroy() }, 3000).unref()
    })
    assert.equal(status, 'closed', 'the client is not left hanging')
    assert.equal(px2.legacyStats.tunnelFailures, 1)
    assert.match(logs.join('\n'), /blind tunnel failed \(example\.com:443: HTTP\/1\.1 403 Forbidden\); 1 so far/)
    assert.deepEqual(blindEvents, [], 'outside the target: no event line')
  } finally { px2.close(); refuse.close() }
})

for (const cut of ['fin', 'reset']) test(`L-2 on the MITM too (4.1 #6, ${cut}): an upstream cut mid-stream → one error:true envelope (capture:mitm) with what arrived, the agent's connection ended, a mitm/upstream-aborted event`, async () => {
  const ca = createCa({ commonName: 'asight legacy test CA' })
  const leafCtx = createLeafIssuer(loadCa(ca)).issue('api.anthropic.com')
  const api = https.createServer({ key: leafCtx.keyPem, cert: leafCtx.certPem }, (req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m2","model":"x"}}\n\n'); setTimeout(() => cutSocket(res.socket, cut), 20) })
  })
  const apiPort = await listen(api)
  const envelopes = [], events = []
  const px = createMitmProxy({ targetHost: 'api.anthropic.com', leaf: { key: leafCtx.keyPem, cert: leafCtx.certPem }, onEnvelope: (e) => envelopes.push(e), onEvent: (e) => events.push(e),
    connectUpstream: (_o, cb) => { const s = tls.connect({ host: '127.0.0.1', port: apiPort, servername: 'api.anthropic.com', ca: ca.certPem }, () => cb(null, s)); s.on('error', cb) }, blindTunnel: () => {} })
  const port = await listen(px)
  try {
    const got = await new Promise((resolve) => {
      setTimeout(() => resolve('hung'), 3000).unref()
      const sock = net.connect(port, '127.0.0.1', () => sock.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n'))
      sock.once('data', () => {
        const t = tls.connect({ socket: sock, servername: 'api.anthropic.com', ca: ca.certPem }, () => t.write('POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}'))
        let b = ''; t.on('data', (d) => { b += d }); t.on('close', () => resolve(b)); t.on('error', () => {})
      })
    })
    assert.notEqual(got, 'hung', 'the agent\'s connection is ended, not left hanging')
    assert.ok(!/\r\n0\r\n\r\n$/.test(got), 'and not ended as a complete chunked response')
    assert.ok(!got.includes('"error"'), 'no error JSON appended to the event stream')
    for (let i = 0; i < 200 && !envelopes.length; i++) await new Promise((r) => setTimeout(r, 10))
    await new Promise((ok) => setTimeout(ok, 100)) // a second envelope would come by now
    assert.equal(envelopes.length, 1, 'one envelope per request')
    const env = envelopes[0]
    assert.deepEqual([env.capture, env.error, env.resp.kind, env.resp.error.type, env.resp.partial.message.id], ['mitm', true, 'error', 'upstream_aborted', 'm2'])
    assert.deepEqual(events.map((e) => [e.where, e.code]), [['mitm', 'upstream-aborted']])
    allInSet(events)
  } finally { px.close(); api.close() }
})
