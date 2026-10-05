import test from 'node:test'
import assert from 'node:assert/strict'
import { createFramer } from '../../../src/collector/core/http1/framer.mjs'

function run(side, input, methods = []) {
  const ev = []
  const f = createFramer(side, {
    onHead: (h) => ev.push(['head', h.startLine, h.raw.toString('latin1')]),
    onBody: (b) => ev.push(['body', b.toString('latin1')]),
    onEnd: (e) => ev.push(['end', e.framing, !!e.interim]),
    onUpgrade: () => ev.push(['upgrade']),
    onError: (e) => ev.push(['error', e.message]),
  })
  for (const m of methods) f.expect({ method: m })
  return { f, ev }
}
function feedAll(side, input, methods, split) {
  const { f, ev } = run(side, input, methods)
  const buf = Buffer.from(input, 'latin1')
  for (let i = 0; i < buf.length; i += split) f.push(buf.subarray(i, i + split))
  f.end()
  // merge adjacent body events so different split points compare equal
  return ev.reduce((a, e) => { const l = a.at(-1); if (e[0] === 'body' && l?.[0] === 'body') l[1] += e[1]; else a.push([...e]); return a }, [])
}
const same = (side, input, methods = []) => {
  const whole = feedAll(side, input, methods, 1 << 20)
  assert.deepEqual(feedAll(side, input, methods, 1), whole)
  assert.deepEqual(feedAll(side, input, methods, 7), whole)
  return whole
}

test('request: content-length body, then a pipelined chunked request with a trailer', () => {
  const a = 'POST /v1/messages HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello'
  const b = 'POST /v1/responses HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3;ext=1\r\nabc\r\n2\r\nde\r\n0\r\nX-T: 1\r\n\r\n'
  assert.deepEqual(same('request', a + b), [
    ['head', 'POST /v1/messages HTTP/1.1', 'POST /v1/messages HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\n'],
    ['body', 'hello'], ['end', 'length', false],
    ['head', 'POST /v1/responses HTTP/1.1', 'POST /v1/responses HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n'],
    ['body', 'abcde'], ['end', 'chunked', false],
  ])
})

test('response: 100-continue interim, HEAD has no body, 204 has no body, close-delimited last', () => {
  const r = 'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nokHTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\nHTTP/1.1 204 No Content\r\n\r\nHTTP/1.1 200 OK\r\n\r\nuntil-close'
  const ev = same('response', r, ['POST', 'HEAD', 'GET', 'GET'])
  assert.deepEqual(ev.filter((e) => e[0] !== 'head'), [
    ['end', 'none', true], ['body', 'ok'], ['end', 'length', false],
    ['end', 'none', false], ['end', 'none', false], ['body', 'until-close'], ['end', 'close', false],
  ])
})

test('response: 101 and CONNECT 2xx switch to upgrade and ignore the rest', () => {
  assert.deepEqual(same('response', 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n\x81\x05hello', ['GET']).map((e) => e[0]), ['head', 'upgrade'])
  assert.deepEqual(same('response', 'HTTP/1.1 200 Connection established\r\n\r\n\x16\x03\x01', ['CONNECT']).map((e) => e[0]), ['head', 'upgrade'])
})

test('framing violations are reported, not thrown', () => {
  const ev = same('request', 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\n')
  assert.equal(ev.at(-1)[0], 'error')
})

// RFC 4.6 §引擎 6 (D37): after a 101 the raw bytes keep flowing and the side copy goes to ws/. The bytes
// that followed the 101 head in the same chunk belong to the new protocol; on the request side the bytes
// after an Upgrade request wait until the exchange layer knows whether the upgrade happened.
test('upgrade: the bytes after a 101 head are handed over; a request that asks to upgrade holds what follows until told', () => {
  let rest = null
  const r = createFramer('response', { onHead() {}, onBody() {}, onEnd() {}, onUpgrade: (u) => { rest = u.rest }, onError() {} })
  r.expect({ method: 'GET' }); r.push(Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n\x81\x02hi', 'latin1'))
  assert.equal(rest.toString('latin1'), '\x81\x02hi')
  const heads = []
  const q = createFramer('request', { onHead: (h) => heads.push(h.target), onBody() {}, onEnd() {}, onUpgrade() {}, onError() {} })
  q.push(Buffer.from('GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nGET /next HTTP/1.1\r\n\r\n'))
  assert.deepEqual(heads, ['/ws'], 'held while the upgrade is undecided')
  q.release(); assert.deepEqual(heads, ['/ws', '/next'], 'refused: framed as HTTP again')
  const w = createFramer('request', { onHead() {}, onBody() {}, onEnd() {}, onUpgrade() {}, onError() {} })
  w.push(Buffer.from('GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n\r\n\x81\x80abcd', 'latin1'))
  w.push(Buffer.from('\x88\x80wxyz', 'latin1'))
  assert.equal(w.takeRest().toString('latin1'), '\x81\x80abcd\x88\x80wxyz', 'every byte held, across pushes')
  const plain = []
  const p = createFramer('request', { onHead: (h) => plain.push(h.target), onBody() {}, onEnd() {}, onUpgrade() {}, onError() {} })
  p.push(Buffer.from('GET /a HTTP/1.1\r\nUpgrade: websocket\r\n\r\nGET /b HTTP/1.1\r\n\r\n'))
  assert.deepEqual(plain, ['/a', '/b'], 'an Upgrade header without Connection: upgrade asks for nothing')
})
