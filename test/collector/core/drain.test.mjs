// drain.test.mjs — what `off` asks of the connections still relayed through the engine (RFC 1.6 §1.3, 4.6 §开关语义「已有连接」):
// the gate's own rules on fake sockets, and the real engine over TLS against the mock upstream (V36 unit half, V37, V38).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import tls from 'node:tls'
import { insertConnectionClose, createDrain } from '../../../src/collector/core/engine/drain.mjs'
import { startMockUpstream } from '../../lab/mock-upstream/server.mjs'
import { makeLabCa } from '../../lab/mock-upstream/lab-ca.mjs'
import { wsConnect } from '../../lab/ws-client.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../../src/collector/core/redirector.mjs'
import { createRecordStore } from '../../../src/collector/core/record/store.mjs'
import { createFailureRecorder } from '../../../src/collector/core/events.mjs'
import { closeWithin } from '../../helpers/bounded.mjs'

const head = (lines) => Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1')
const CRLF = '\r\n'

test('insertConnectionClose: one `Connection: close` line goes in before the final blank line, every other byte stays', () => {
  const h = head(['HTTP/1.1 200 OK', 'content-type: application/json', 'connection: keep-alive', 'content-length: 2'])
  const r = insertConnectionClose(h)
  assert.equal(r.added, true)
  assert.equal(r.head.toString('latin1'), h.toString('latin1').replace(/\r\n\r\n$/, `${CRLF}Connection: close${CRLF}${CRLF}`))
  assert.equal(r.head.length, h.length + 'Connection: close\r\n'.length)
})

test('insertConnectionClose: not added when a Connection header already has the close token (any case, any position), for a 1xx head, or for bytes that are not a whole status head', () => {
  for (const line of ['connection: Close', 'Connection: keep-alive, close', 'CONNECTION:close']) {
    const h = head(['HTTP/1.1 200 OK', 'x-a: 1', line, 'x-b: 2'])
    const r = insertConnectionClose(h)
    assert.deepEqual([r.added, r.head === h], [false, true], line)
  }
  for (const h of [head(['HTTP/1.1 100 Continue']), head(['HTTP/1.1 101 Switching Protocols', 'upgrade: websocket']), Buffer.from('HTTP/1.1 200 OK\r\nx: 1\r\n'), Buffer.from('not http\r\n\r\n'), Buffer.alloc(0)]) {
    const r = insertConnectionClose(h)
    assert.deepEqual([r.added, r.head === h], [false, true], JSON.stringify(h.toString('latin1')))
  }
  assert.equal(insertConnectionClose(head(['HTTP/1.1 200 OK', 'x-connection: close'])).added, true, 'only a header named Connection counts')
})

// a gate over fake sockets and a fake tee
const sock = () => Object.assign(new EventEmitter(), {
  writable: true, readableLength: 0, ended: 0, destroyed: 0, resumed: 0,
  end() { this.ended++; this.writable = false }, destroy() { this.destroyed++; this.writable = false }, resume() { this.resumed++; this.readableLength = 0 },
})
function gateOf({ view = { idle: false, headPending: true, seq: 3, blind: false }, tee: noTee = false, ...opts } = {}) {
  const c = sock(), u = sock(), marks = [], failures = [], closes = []
  const tee = noTee ? null : { view, boundary: () => tee.view, markAdded: (seq, what) => marks.push([seq, what]) }
  const g = createDrain({ flowId: 'flow_1', tee, client: c, upstream: u, timeoutMs: 40, onClosed: (k) => closes.push(k), onFailure: (f) => failures.push(f), ...opts })
  return { g, c, u, tee, marks, failures, closes }
}
const text = (parts) => Buffer.concat(parts).toString('latin1')

test('gate: a head that arrives in two chunks is held from its first byte until it is whole, then forwarded with the line; the body behind it follows untouched; the exchange is marked once', () => {
  const { g, tee, marks } = gateOf()
  assert.equal(g.start(), 'closing')
  const h = head(['HTTP/1.1 200 OK', 'connection: keep-alive', 'content-length: 5']).toString('latin1')
  assert.deepEqual(g.beforeUpstream(Buffer.from(h.slice(0, 20), 'latin1')), [], 'nothing forwarded while the head is incomplete')
  const out = g.beforeUpstream(Buffer.from(`${h.slice(20)}hello`, 'latin1'))
  assert.equal(text(out), h.replace(/\r\n\r\n$/, '\r\nConnection: close\r\n\r\n') + 'hello')
  assert.deepEqual(marks, [[3, 'connection-close']])
  assert.deepEqual(g.beforeUpstream(Buffer.from('more')).map(String), ['more'], 'after the head the gate only forwards')
  tee.view = { idle: true, headPending: false, seq: null, blind: false }
  g.afterUpstream()
  assert.equal(g.state(), 'closed')
})

test('gate: 100 Continue is forwarded as it is and the gate keeps waiting for the final head, which gets the line', () => {
  const { g, marks } = gateOf()
  g.start()
  const interim = head(['HTTP/1.1 100 Continue']).toString('latin1')
  const fin = head(['HTTP/1.1 200 OK', 'content-length: 0']).toString('latin1')
  assert.equal(text(g.beforeUpstream(Buffer.from(interim, 'latin1'))), interim)
  assert.deepEqual(marks, [])
  assert.equal(text(g.beforeUpstream(Buffer.from(fin, 'latin1'))), fin.replace(/\r\n\r\n$/, '\r\nConnection: close\r\n\r\n'))
  assert.deepEqual(marks, [[3, 'connection-close']])
})

test('gate: the 101 of a WebSocket upgrade is the last head the gate holds: what follows is frames and goes through as it comes', () => {
  const { g, marks } = gateOf()
  g.start()
  const sw = head(['HTTP/1.1 101 Switching Protocols', 'upgrade: websocket']).toString('latin1')
  assert.equal(text(g.beforeUpstream(Buffer.from(sw, 'latin1'))), sw)
  assert.deepEqual(g.beforeUpstream(Buffer.from([0x81, 0x02, 0x68, 0x69])).map((b) => [...b]), [[0x81, 0x02, 0x68, 0x69]])
  assert.deepEqual(marks, [])
})

test('gate: a response head already forwarded (a stream under way) gets nothing; the close comes when the response has ended', () => {
  const { g, tee, marks } = gateOf({ view: { idle: false, headPending: false, seq: 0, blind: false } })
  assert.equal(g.start(), 'closing')
  assert.deepEqual(g.beforeUpstream(Buffer.from('data: 1\n\n')).map(String), ['data: 1\n\n'])
  g.afterUpstream(); assert.equal(g.state(), 'closing')
  tee.view = { idle: true, headPending: false, seq: null, blind: false }
  g.afterUpstream()
  assert.equal(g.state(), 'closed')
  assert.deepEqual(marks, [])
})

test('gate: the response the client had already asked for behind the one in flight is the last one: its head carries the line', () => {
  const { g, tee, marks } = gateOf({ view: { idle: false, headPending: false, seq: 0, blind: false } })
  g.start()
  tee.view = { idle: false, headPending: true, seq: 1, blind: false } // response 0 ended, request 1 is waiting for its head
  g.afterUpstream()
  assert.equal(g.state(), 'closing')
  const out = g.beforeUpstream(head(['HTTP/1.1 200 OK', 'content-length: 0']))
  assert.match(text(out), /\r\nConnection: close\r\n\r\n$/)
  assert.deepEqual(marks, [[1, 'connection-close']])
})

test('gate: an idle connection is closed at once with a FIN (end), not an RST; destroy only after the timeout', async () => {
  const { g, c, u, closes } = gateOf({ view: { idle: true, headPending: false, seq: null, blind: false } })
  assert.equal(g.start(), 'closed')
  assert.deepEqual([c.ended, u.ended, c.destroyed, u.destroyed, closes], [1, 1, 0, 0, ['closed']])
  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual([c.destroyed, u.destroyed], [1, 1], 'a peer that does not close is destroyed after timeoutMs')
})

test('gate: the forced destroy waits for the client\'s unread bytes to be read: it resumes the socket first, never destroys over them (an RST)', async () => {
  const { g, c } = gateOf({ view: { idle: true, headPending: false, seq: null, blind: false } })
  c.readableLength = 9
  g.start()
  const order = []
  const resume = c.resume.bind(c), destroy = c.destroy.bind(c)
  c.resume = () => { order.push(`resume@${c.readableLength}`); resume() }
  c.destroy = () => { order.push(`destroy@${c.readableLength}`); destroy() }
  await new Promise((r) => setTimeout(r, 120))
  assert.deepEqual(order, ['resume@9', 'destroy@0'])
})

test('gate: no tee (a spliced connection) or a connection the tee cannot follow is waiting, and stays open', () => {
  const s = gateOf({ tee: true })
  assert.equal(s.g.start(), 'waiting'); assert.equal(s.g.state(), 'waiting'); assert.deepEqual([s.c.ended, s.u.ended], [0, 0])
  const b = gateOf({ view: { idle: false, headPending: false, seq: null, blind: true } })
  assert.equal(b.g.start(), 'waiting')
  b.g.afterUpstream(); assert.equal(b.c.ended, 0)
})

test('gate: now destroys both sockets at once (cut) — an idle connection is closed gracefully, nothing was in flight', () => {
  const a = gateOf()
  assert.equal(a.g.start({ now: true }), 'cut')
  assert.deepEqual([a.c.destroyed, a.u.destroyed, a.c.ended, a.closes], [1, 1, 0, ['cut']])
  const w = gateOf({ tee: true })
  assert.equal(w.g.start({ now: true }), 'cut')
  const i = gateOf({ view: { idle: true, headPending: false, seq: null, blind: false } })
  assert.equal(i.g.start({ now: true }), 'closed')
  assert.deepEqual([i.c.destroyed, i.c.ended], [0, 1])
})

test('gate: a throw inside it is fail-open — the held bytes go on unchanged, engine-error is recorded, the connection is not gated any more', () => {
  const { g, tee, failures } = gateOf()
  tee.markAdded = () => { throw new Error('boom') }
  g.start()
  const h = head(['HTTP/1.1 200 OK', 'content-length: 0'])
  const out = g.beforeUpstream(h)
  assert.equal(text(out), h.toString('latin1'), 'the head as the upstream sent it')
  assert.deepEqual(failures.map((f) => [f.code, f.flow_id]), [['engine-error', 'flow_1']])
  assert.match(failures[0].reason, /boom/)
  assert.deepEqual(g.beforeUpstream(Buffer.from('x')).map(String), ['x'])
  tee.view = { idle: true, headPending: false, seq: null, blind: false }
  g.afterUpstream(); assert.notEqual(g.state(), 'closed')
})

test('gate: when the upstream goes away with part of a head held, flush() hands those bytes back for the client', () => {
  const { g } = gateOf()
  g.start()
  assert.deepEqual(g.beforeUpstream(Buffer.from('HTTP/1.1 200 O')), [])
  assert.equal(text(g.flush()), 'HTTP/1.1 200 O')
  assert.deepEqual(g.flush(), [])
})

test('gate: bytes that do not start a status head (the head began before the gate looked) are not held; neither is a head that never ends', () => {
  const { g, marks } = gateOf()
  g.start()
  assert.deepEqual(g.beforeUpstream(Buffer.from('tail of a head\r\n\r\n')).map(String), ['tail of a head\r\n\r\n'])
  assert.deepEqual(marks, [])
  const h = gateOf(); h.g.start()
  const long = Buffer.from(`HTTP/1.1 200 OK\r\nx: ${'a'.repeat(70 * 1024)}`)
  assert.equal(Buffer.concat(h.g.beforeUpstream(long)).length, long.length)
})

// ── the real engine, over TLS, against the mock upstream ───────────────────────────────────────────────────────────────
const T = { timeout: 20000 }
const TERMINAL = [{ pathSuffix: '/responses', patterns: ['^\\{"type":"(response\\.(completed|failed|incomplete)|error)"'] }]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, what, ms = 4000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) { const v = fn(); if (v) return v } throw new Error(`${what}: not within ${ms}ms`) }
const asightCa = createCa()
const labCaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-drain-labca-'))
const labCa = makeLabCa(labCaDir)
process.on('exit', () => fs.rmSync(labCaDir, { recursive: true, force: true }))
const BODY = JSON.stringify({ model: 'claude-x', max_tokens: 16, messages: [{ role: 'user', content: [{ type: 'text', text: 'drain me' }] }] })
const SSE_BODY = (text = 'drain me') => JSON.stringify({ model: 'claude-x', max_tokens: 16, stream: true, messages: [{ role: 'user', content: [{ type: 'text', text: `${text} [[mock:slow-drip]]` }] }] })
const split = (b) => { const i = b.indexOf('\r\n\r\n') + 4; return { head: b.subarray(0, i).toString('latin1'), body: b.subarray(i) } }

async function lab(t, { delays, terminal = TERMINAL, spliceHost = 'splice.asight.test', upstream = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-drain-'))
  const mock = upstream ? await upstream() : await startMockUpstream({ tls: { key: fs.readFileSync(labCa.key), cert: fs.readFileSync(labCa.cert) }, delays })
  const envelopes = [], errors = []
  const store = createRecordStore({ root: path.join(dir, 'rec') })
  const L = { recording: true }
  const redirector = createStaticRedirector({ dst: { address: '127.0.0.1', port: mock.port, family: 4 }, pid: 11, agent: 'claude-code', decrypt: true })
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(asightCa)), upstreamCa: fs.readFileSync(labCa.caCert), systemCa: fs.readFileSync(labCa.caCert, 'utf8'),
    store: { envelope: (e) => { envelopes.push(e); return store.envelope(e) }, flow: (f) => store.flow(f) }, onFailure: createFailureRecorder(path.join(dir, 'rec')).event,
    isRecording: () => L.recording, policy: (meta, host) => host !== spliceHost, describe: () => ({ wsTerminal: terminal }), onError: (e) => errors.push(e), drainTimeoutMs: 1500 })
  const { port } = await engine.listen({})
  const clients = []
  t.after(async () => {
    for (const c of clients) c.sock.destroy()
    try { await mock.close(); await closeWithin(engine) } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  })
  const read = (sub) => { const d = path.join(dir, 'rec', sub); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.ndjson')).flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) : [] }
  // a keep-alive TLS client through the engine: what it received, whether it was closed
  const client = async ({ servername = 'api.anthropic.com', ca = asightCa.certPem } = {}) => {
    const sock = tls.connect({ port, host: '127.0.0.1', servername, ca }); sock.on('error', () => {})
    await once(sock, 'secureConnect')
    const chunks = []; sock.on('data', (d) => chunks.push(d))
    const c = { sock, bytes: () => Buffer.concat(chunks), closed: new Promise((r) => sock.once('close', r)), ended: new Promise((r) => sock.once('end', r)) }
    clients.push(c); return c
  }
  const post = (c, p, body, headers = {}) => c.sock.write(`POST ${p} HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  const wire = (n = 0) => { const e = mock.state.log.filter((x) => x.type === 'request')[n]; return e && Buffer.from(e.resp_raw_b64, 'base64') } // the bytes the mock wrote for its nth response
  const connectWs = async (opts = {}) => { const c = await wsConnect(port, { tls: { servername: 'api.openai.com', ca: asightCa.certPem }, ...opts }); clients.push(c); return c }
  return { mock, engine, port, envelopes, errors, client, post, wire, connectWs, set recording(v) { L.recording = v }, rows: () => read('flows').filter((r) => r.event == null), failures: () => read('flows').filter((r) => r.event === 'failure'), dir }
}
const NOW = { agents: null }

test('V37: off lands after the request went out and before the response head: one Connection: close line, the body verbatim, no reuse; recorded in the envelope and on the flows/ row', T, async (t) => {
  const L = await lab(t, { delays: { stallMs: 300 } })
  const c = await L.client()
  L.post(c, '/v1/messages', BODY, { 'x-mock-scenario': 'slow-headers' }) // the mock answers 300 ms later
  await sleep(60); L.recording = false // off: requests from now on are not recorded; this one began on
  assert.deepEqual(L.engine.drain(NOW), { closing: 1, waiting: 0, cut: 0 })
  assert.deepEqual(L.engine.relayed(NOW), { closing: 1, waiting: 0 })
  await c.closed
  const sent = split(L.wire()), got = split(c.bytes())
  assert.equal(got.head, sent.head.replace(/\r\n\r\n$/, '\r\nConnection: close\r\n\r\n'), 'the head the client got: the mock\'s, plus the one line before the blank line')
  assert.ok(got.body.equals(sent.body), 'the body byte for byte')
  const env = await until(() => L.envelopes.at(-1), 'the envelope')
  assert.deepEqual(env.asight_added, ['connection-close'])
  assert.equal(Object.keys(env).at(-1), 'asight_added', 'appended after every other key')
  assert.equal(env.resp_head_raw, sent.head, 'resp_head_raw is the head the upstream sent')
  const [row] = await until(() => { const r = L.rows().filter((x) => x.asight_added); return r.length && r }, 'the flows/ row')
  assert.deepEqual(row.asight_added, [{ seq: 0, what: 'connection-close' }])
  assert.deepEqual(L.engine.relayed(NOW), { closing: 0, waiting: 0 }, 'once the connection is gone nothing is relayed')
})

test('V37: the upstream already says Connection: close → nothing added, nothing recorded; a head already forwarded (a stream) → nothing added', T, async (t) => {
  const L = await lab(t, { delays: { stallMs: 300 } })
  const c = await L.client()
  L.post(c, '/v1/messages', BODY, { 'x-mock-scenario': 'slow-headers', connection: 'close' }) // the mock then answers with Connection: close
  await sleep(60)
  assert.deepEqual(L.engine.drain(NOW), { closing: 1, waiting: 0, cut: 0 })
  await c.closed
  assert.equal(split(c.bytes()).head, split(L.wire()).head, 'the head as the mock wrote it')
  const env = await until(() => L.envelopes.at(-1), 'the envelope')
  assert.equal(env.asight_added, undefined)
  await until(() => L.rows().length, 'the row'); assert.equal(L.rows().at(-1).asight_added, undefined)

  const S = await lab(t, { delays: { dripMs: 80 } })
  const s2 = await S.client()
  S.post(s2, '/v1/messages', SSE_BODY())
  await until(() => s2.bytes().includes('message_start'), 'the first events')
  assert.deepEqual(S.engine.drain(NOW), { closing: 1, waiting: 0, cut: 0 })
  await s2.closed
  const sent = split(S.wire()), got = split(s2.bytes())
  assert.equal(got.head, sent.head, 'the head had been forwarded: nothing to add')
  assert.ok(got.body.equals(sent.body), 'every event, to the last one, then the close')
  const env2 = await until(() => S.envelopes.at(-1), 'the stream envelope')
  assert.equal(env2.asight_added, undefined)
  await until(() => S.rows().length, 'the stream row'); assert.equal(S.rows().at(-1).asight_added, undefined)
})

test('V37: an idle keep-alive connection is closed at once, with or without a request behind it; a request that starts after off is not recorded and the line it gets is on the flows/ row only', T, async (t) => {
  const L = await lab(t, { delays: { stallMs: 300 } })
  const fresh = await L.client()                       // TLS done, nothing sent: nothing in flight
  const used = await L.client()
  L.post(used, '/v1/messages', BODY); await until(() => used.bytes().toString('latin1').endsWith('0\r\n\r\n'), 'the first response') // keep-alive, now idle
  const n = L.envelopes.length
  L.recording = false
  assert.deepEqual(L.engine.drain(NOW), { closing: 0, waiting: 0, cut: 0 }, 'both closed at once: nothing left to wait for')
  await Promise.all([fresh.closed, used.closed])
  const late = await L.client() // a connection the engine still got (it was steered before the link went away)
  L.post(late, '/v1/messages', BODY, { 'x-mock-scenario': 'slow-headers' })
  await sleep(60)
  assert.deepEqual(L.engine.drain(NOW), { closing: 1, waiting: 0, cut: 0 })
  await late.closed
  assert.match(split(late.bytes()).head, /\r\nConnection: close\r\n\r\n$/)
  assert.equal(L.envelopes.length, n, 'nothing recorded after off')
  const row = await until(() => L.rows().find((x) => x.asight_added), 'the row of the late connection')
  assert.deepEqual(row.asight_added, [{ seq: 0, what: 'connection-close' }])
})

test('V37: a small response that reaches the engine whole, head and body in one chunk, is still marked in its envelope (the gate acts before the tee closes the exchange)', T, async (t) => {
  const reply = '{"id":"msg_1","type":"message","content":[{"type":"text","text":"pong"}]}'
  const resp = `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${reply.length}\r\n\r\n${reply}`
  const L = await lab(t, { upstream: async () => {
    const srv = tls.createServer({ key: fs.readFileSync(labCa.key), cert: fs.readFileSync(labCa.cert) }, (s) => { s.on('error', () => {}); s.once('data', () => setTimeout(() => s.write(resp), 200)) })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    return { port: srv.address().port, state: { log: [] }, close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections?.() }) }
  } })
  const c = await L.client()
  L.post(c, '/v1/messages', BODY)
  await sleep(60)
  assert.deepEqual(L.engine.drain(NOW), { closing: 1, waiting: 0, cut: 0 })
  await c.closed
  assert.equal(c.bytes().toString('latin1'), resp.replace('\r\n\r\n', '\r\nConnection: close\r\n\r\n'))
  const env = await until(() => L.envelopes.at(-1), 'the envelope')
  assert.deepEqual([env.asight_added, env.resp_head_raw, env.resp.kind], [['connection-close'], resp.slice(0, resp.indexOf('\r\n\r\n') + 4), 'json'])
})

// ── WebSocket (V38) ───────────────────────────────────────────────────────────────────────────────────────────────
const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const create = (text) => JSON.stringify({ type: 'response.create', model: 'gpt-test-1', store: false, stream: true, input: [user(text)] })
const b64 = (s) => Buffer.from(s, 'base64')
const mockWire = (L) => { // what the mock wrote on the WebSocket connection: the 101, then its frames in order
  const log = L.mock.state.log
  return Buffer.concat([b64(log.find((e) => e.type === 'request').resp_raw_b64), ...log.filter((e) => e.type === 'ws_frame' && e.dir === 'out').map((e) => b64(e.raw_b64))])
}

test('V38: off while a call is open: the engine forwards every frame up to the terminal message, then closes (FIN); it wrote no byte the upstream did not send; the call is recorded whole', T, async (t) => {
  const L = await lab(t, { delays: { dripMs: 100 } })
  const c = await L.connectWs()
  await c.sendText(create('drain ws [[mock:slow-drip]]'))
  assert.equal((await c.message()).opcode, 1) // the first event is in: the call is open
  assert.deepEqual(L.engine.drain(NOW), { closing: 1, waiting: 0, cut: 0 })
  assert.equal(c.state.closed, false, 'not closed under an open call')
  await until(() => c.state.closed, 'the close after the terminal message', 8000)
  assert.ok(Buffer.concat(c.state.received).equals(mockWire(L)), 'the client got exactly the mock\'s bytes: the 101 and every frame to response.completed, no synthesized close frame')
  assert.equal(c.state.ended, true, 'a FIN, not a reset'); assert.equal(c.state.error, null)
  const types = L.mock.state.log.filter((e) => e.type === 'ws_frame' && e.dir === 'out').map((e) => e.opcode)
  assert.ok(types.length > 3 && types.every((o) => o === 1), 'text frames only')
  const env = await until(() => L.envelopes.at(-1), 'the envelope')
  assert.equal(L.envelopes.length, 1)
  assert.equal(JSON.parse(env.resp.messages.at(-1)).type, 'response.completed')
  assert.equal(env.error, undefined); assert.equal(env.asight_added, undefined, 'nothing is added to a WebSocket connection')
  assert.deepEqual(L.failures(), [])
})

test('V38: off with no call open: the WebSocket connection is closed at once, with no frame of ours; no terminal message declared: it is not closed and counts as waiting', T, async (t) => {
  const L = await lab(t)
  const c = await L.connectWs()
  assert.deepEqual(L.engine.drain(NOW), { closing: 0, waiting: 0, cut: 0 })
  await until(() => c.state.closed, 'closed at once')
  assert.ok(Buffer.concat(c.state.received).equals(mockWire(L)), 'only the 101')
  const N = await lab(t, { terminal: null, delays: { dripMs: 50 } })
  const d = await N.connectWs()
  await d.sendText(create('no pattern [[mock:slow-drip]]'))
  assert.deepEqual(N.engine.drain(NOW), { closing: 0, waiting: 1, cut: 0 })
  await d.events(); await sleep(300)
  assert.equal(d.state.closed, false, 'the call ran to its end and the connection stays open: nothing says where a turn ends')
  assert.deepEqual(N.engine.relayed(NOW), { closing: 0, waiting: 1 })
  assert.deepEqual(N.engine.drain({ agents: null, now: true }), { closing: 0, waiting: 0, cut: 1 }, '--now cuts it')
  await until(() => d.state.closed, 'cut')
})

// ── off --now and what stays (V36 unit half) ──────────────────────────────────────────────────────────────────────
// an SSE response under way, a WebSocket with a call open, a spliced connection (a host outside the decrypt policy)
async function trio(t) {
  const L = await lab(t, { delays: { dripMs: 200 } })
  const sse = await L.client(); L.post(sse, '/v1/messages', SSE_BODY())
  const ws = await L.connectWs(); await ws.sendText(create('trio [[mock:slow-drip]]'))
  const sp = await L.client({ servername: 'splice.asight.test', ca: fs.readFileSync(labCa.caCert) })
  await until(() => sse.bytes().includes('message_start'), 'the stream is under way')
  await ws.message()
  return { L, sse, ws, sp, closedAll: () => Promise.all([sse.closed, until(() => ws.state.closed, 'ws closed', 3000), sp.closed]) }
}

test('V36 unit: off --now cuts the SSE, the WebSocket and the spliced connection: cut 3, all closed within 1 s, three rows with error.type cut-by-off', T, async (t) => {
  const { L, ws, sse, sp } = await trio(t)
  const t0 = Date.now()
  assert.deepEqual(L.engine.drain({ agents: null, now: true }), { closing: 0, waiting: 0, cut: 3 })
  await Promise.all([sse.closed, sp.closed, until(() => ws.state.closed, 'ws closed', 1000)])
  assert.ok(Date.now() - t0 < 1000, `closed in ${Date.now() - t0} ms`)
  const rows = await until(() => { const r = L.rows().filter((x) => x.error && x.error.type === 'cut-by-off'); return r.length === 3 && r }, 'three cut rows')
  assert.deepEqual(rows.map((r) => r.error.side), ['engine', 'engine', 'engine'])
  assert.deepEqual(rows.map((r) => r.decision).sort(), ['decrypt', 'decrypt', 'splice'])
  const interrupted = await until(() => L.envelopes.length === 2 && L.envelopes, 'the two interrupted calls are written, not lost')
  assert.deepEqual(interrupted.map((e) => [e.error, e.resp.kind, e.resp.error.type]).sort(), [[true, 'error', 'cut-by-off'], [true, 'error', 'ws_closed']], 'the stream says it was cut by off; the WebSocket call that its connection closed before the terminal message')
  await L.engine.drained(NOW)
})

test('V36 unit: without now the same situation is closing 2, waiting 1 — the stream and the WebSocket finish and close, the splice stays and keeps drained() pending', T, async (t) => {
  const { L, ws, sse, sp } = await trio(t)
  assert.deepEqual(L.engine.drain({ agents: new Set(['codex']) }), { closing: 0, waiting: 0, cut: 0 }, 'other harnesses are not touched')
  assert.deepEqual(L.engine.relayed({ agents: new Set(['codex']) }), { closing: 0, waiting: 0 })
  assert.deepEqual(L.engine.drain(NOW), { closing: 2, waiting: 1, cut: 0 })
  assert.deepEqual(L.engine.relayed(NOW), { closing: 2, waiting: 1 })
  let drained = false; L.engine.drained(NOW).then(() => { drained = true })
  await Promise.all([sse.closed, until(() => ws.state.closed, 'ws closed', 6000)])
  assert.deepEqual(L.engine.relayed(NOW), { closing: 0, waiting: 1 }, 'what is left is the splice, waiting for its own close')
  await sleep(150); assert.equal(drained, false, 'the engine is not drained while it holds the splice')
  assert.ok(sse.bytes().toString('latin1').endsWith('0\r\n\r\n'), 'the stream ran to its last chunk')
  sp.sock.destroy()
  await until(() => drained, 'drained once the splice closed')
  assert.equal((await until(() => L.rows().find((r) => r.decision === 'splice'), 'splice row')).error, undefined, 'not cut: it closed by itself')
})
