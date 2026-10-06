// drain.test.mjs — what `off` asks of the connections still relayed through the engine (RFC 1.6 §1.3, 4.6 §开关语义「已有连接」):
// the gate's own rules on fake sockets, and the real engine over TLS against the mock upstream (V36 unit half, V37, V38).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { insertConnectionClose, createDrain } from '../../../src/collector/core/engine/drain.mjs'

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
