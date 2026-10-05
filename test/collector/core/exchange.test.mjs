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
  for (const k of ['req_truncated', 'req_body_bytes', 'req_partial']) assert.ok(out.every((e) => !(k in e)), k)
})

test('recording switch is sampled at request start: in-flight exchange is still recorded after off', () => {
  const { out, store } = sink(); let on = true
  const t = createExchangeTee({ flow: FLOW, recordStore: store, isRecording: () => on })
  t.fromClient(Buffer.from('GET /a HTTP/1.1\r\n\r\n')); on = false
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
  t.fromClient(Buffer.from('GET /b HTTP/1.1\r\n\r\n'))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
  on = true; t.fromClient(Buffer.from('GET /c HTTP/1.1\r\n\r\n'))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
  assert.deepEqual(out.map((e) => [e.endpoint, e.seq]), [['/a', 0], ['/c', 2]], 'an exchange not recorded still takes its seq')
})

test('a request body past maxBodyBytes reaches the envelope labelled req_truncated; one under the cap does not', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store, maxBodyBytes: 4 })
  t.fromClient(Buffer.from('POST /v1/messages HTTP/1.1\r\nContent-Length: 10\r\n\r\n0123456789'))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
  t.fromClient(Buffer.from('POST /v1/messages HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc'))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
  assert.deepEqual(out.map((e) => [e.req_body, e.req_truncated, e.req_body_bytes, e.req_partial]), [['0123', true, 4, undefined], ['abc', undefined, undefined, undefined]])
})

test('early final response (413 mid-upload): prefix body labelled req_partial:early-response; the next request is recorded clean', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store })
  t.fromClient(Buffer.from('POST /v1/messages HTTP/1.1\r\nContent-Length: 21\r\n\r\n{"model":"m",'))
  t.fromUpstream(Buffer.from('HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\n\r\n'))
  t.fromClient(Buffer.from('"n":123}GET /next HTTP/1.1\r\n\r\n'))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
  assert.deepEqual(out.map((e) => [e.endpoint, e.resp.status, e.req_body, e.req_partial]), [['/v1/messages', 413, '{"model":"m",', 'early-response'], ['/next', 200, { raw_chars: 0, verbatim: false }, undefined]])
  assert.equal('req_truncated' in out[0], false)
  assert.equal(out[1].method, 'GET'); assert.equal(out[1].req_head_raw, 'GET /next HTTP/1.1\r\n\r\n')
})

test('abort mid-upload: error envelope with the prefix body labelled req_partial:aborted', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store })
  t.fromClient(Buffer.from('POST /v1/messages HTTP/1.1\r\nContent-Length: 10\r\n\r\n01234'))
  t.abort({ type: 'ECONNRESET', message: 'client reset' })
  assert.deepEqual(out.map((e) => [e.error, e.req_body, e.req_partial]), [[true, '01234', 'aborted']])
})

const PIPE_A = 'POST /v1/messages HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}'
const PIPE_B_HALF = 'POST /v1/messages HTTP/1.1\r\nContent-Length: 6\r\n\r\nabc'

test('pipelined: A answered while B uploads leaves B open; B is recorded whole and unlabelled', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store })
  t.fromClient(Buffer.from(PIPE_A + PIPE_B_HALF))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))   // A's response
  t.fromClient(Buffer.from('def'))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))   // B's response
  assert.deepEqual(out.map((e) => [e.seq, e.req_body, e.req_partial]), [[0, '{}', undefined], [1, 'abcdef', undefined]])
})

test('pipelined abort during B upload: B labelled aborted, completed A carries no label', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store })
  t.fromClient(Buffer.from(PIPE_A + PIPE_B_HALF))
  t.abort({ type: 'ECONNRESET', message: 'reset' })
  assert.deepEqual(out.map((e) => [e.seq, e.error, e.req_body, e.req_partial]), [[0, true, '{}', undefined], [1, true, 'abc', 'aborted']])
})

test('request framing error mid-body (bad chunk terminator): prefix body labelled req_partial:framer-error', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store })
  t.fromClient(Buffer.from('POST /v1/messages HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nabcdeXX'))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
  assert.deepEqual(out.map((e) => [e.resp.status, e.req_body, e.req_partial]), [[200, 'abcde', 'framer-error']])
})

test('abort mid-response emits an error envelope carrying the partial body', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store })
  t.fromClient(Buffer.from('POST /v1/messages HTTP/1.1\r\nContent-Length: 0\r\n\r\n'))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\ndata:\r\n'))
  t.abort({ type: 'ECONNRESET', message: 'upstream reset' })
  assert.equal(out.length, 1); assert.equal(out[0].error, true); assert.equal(out[0].resp.kind, 'error')
  assert.equal(out[0].resp.status, 200)
  // 4.6 T2: the error envelope carries the partial body it did receive (带部分内容)
  assert.ok(JSON.stringify(out[0].resp.partial).includes('data:'), 'partial response bytes are preserved')
})
