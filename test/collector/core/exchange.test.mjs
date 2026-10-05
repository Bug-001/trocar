import test from 'node:test'
import assert from 'node:assert/strict'
import { createExchangeTee } from '../../../src/collector/core/engine/exchange.mjs'

const FLOW = { id: 'f', host: 'h.test', scheme: 'https', dst: { address: '1.2.3.4', port: 443 }, proc: { pid: 1, exe: 'x', agent: 'a' } }
const sink = () => { const out = []; return { out, store: { envelope: (e) => out.push(e) } } }

test('keep-alive: three exchanges, split across arbitrary chunks, three envelopes in order', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store })
  for (let i = 0; i < 3; i++) {
    const req = `POST /v1/messages HTTP/1.1\r\nContent-Length: 2\r\n\r\n{${i}`
    const resp = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n{"n":${i}}`
    for (const c of req) t.fromClient(Buffer.from(c))
    t.fromUpstream(Buffer.from(resp.slice(0, 10))); t.fromUpstream(Buffer.from(resp.slice(10)))
  }
  assert.deepEqual(out.map((e) => [e.seq, e.req_body, e.resp.body.n]), [[0, '{0', 0], [1, '{1', 1], [2, '{2', 2]])
})

test('recording switch is sampled at request start: in-flight exchange is still recorded after off', () => {
  const { out, store } = sink(); let on = true
  const t = createExchangeTee({ flow: FLOW, recordStore: store, isRecording: () => on })
  t.fromClient(Buffer.from('GET /a HTTP/1.1\r\n\r\n')); on = false
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
  t.fromClient(Buffer.from('GET /b HTTP/1.1\r\n\r\n'))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
  assert.deepEqual(out.map((e) => e.endpoint), ['/a'])
})

test('a request body past maxBodyBytes reaches the envelope labelled req_truncated; one under the cap does not', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store, maxBodyBytes: 4 })
  t.fromClient(Buffer.from('POST /v1/messages HTTP/1.1\r\nContent-Length: 10\r\n\r\n0123456789'))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
  t.fromClient(Buffer.from('POST /v1/messages HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc'))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
  assert.deepEqual(out.map((e) => [e.req_body, e.req_truncated, e.req_body_bytes]), [['0123', true, 4], ['abc', undefined, undefined]])
})

test('abort mid-response emits an error envelope carrying the partial body', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store })
  t.fromClient(Buffer.from('POST /v1/messages HTTP/1.1\r\nContent-Length: 0\r\n\r\n'))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\ndata:\r\n'))
  t.abort({ type: 'ECONNRESET', message: 'upstream reset' })
  assert.equal(out.length, 1); assert.equal(out[0].error, true); assert.equal(out[0].resp.kind, 'error')
  assert.equal(out[0].resp.status, 200)
})
