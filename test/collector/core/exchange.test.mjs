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
  assert.deepEqual(out.map((e) => [e.endpoint, e.resp.status, e.req_body, e.req_partial]), [['/v1/messages', 413, '{"model":"m",', 'early-response'], ['/next', 200, '', undefined]])
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

// RFC 4.6 §传输与帧级记录「升级与中断」+ §记录 seq (D37): the upgrade is not an envelope of its own; the
// first call after the 101 takes the upgrade request's seq, later calls count on, and every call carries
// the upgrade request and the 101 verbatim. A refused upgrade (426) is an ordinary HTTP exchange.
const UPGRADE = 'GET /v1/responses HTTP/1.1\r\nHost: api.openai.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
const SWITCH = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
const cframe = (text) => Buffer.from([0x81, 0x80 | text.length, 0, 0, 0, 0, ...Buffer.from(text)]) // masked with key 0
const sframe = (text) => Buffer.from([0x81, text.length, ...Buffer.from(text)])

test('WebSocket 101: no HTTP envelope for the upgrade; frames after it (even in the 101 chunk, even before the 101) go to the ws recorder', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store, wsTerminal: [{ patterns: ['^done$'] }] })
  t.fromClient(Buffer.from('GET /v1/models HTTP/1.1\r\n\r\n'))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'))
  t.fromClient(Buffer.concat([Buffer.from(UPGRADE), cframe('early')])) // a client that does not wait for the 101
  t.fromUpstream(Buffer.concat([Buffer.from(SWITCH), sframe('done')]))
  t.fromClient(cframe('ping'))
  t.fromUpstream(sframe('done'))
  assert.deepEqual(out.map((e) => [e.seq, e.transport, e.req_body, e.resp.messages ?? e.resp.status]),
    [[0, undefined, '', 200], [1, 'ws', 'early', ['done']], [2, 'ws', 'ping', ['done']]], 'the first call takes the upgrade\'s seq: no gap, no duplicate')
  assert.equal(out[2].req_head_raw, UPGRADE); assert.equal(out[2].resp_head_raw, SWITCH)
  assert.equal(t.wsSummary().calls, 2)
  t.upstreamEnded(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
  assert.equal(t.wsSummary().calls, 2)
})

test('WebSocket: a connection error reaches the recorder, so the open call is an error envelope with its type', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store, wsTerminal: [{ patterns: ['^done$'] }] })
  t.fromClient(Buffer.from(UPGRADE)); t.fromUpstream(Buffer.from(SWITCH))
  t.fromClient(cframe('go')); t.fromUpstream(sframe('half'))
  t.upstreamEnded(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
  assert.deepEqual(out.map((e) => [e.error, e.resp.error.type, e.resp.partial.messages]), [[true, 'ECONNRESET', ['half']]])
  t.abort({ type: 'ECONNRESET', message: 'flow closed' }) // the flow's teardown after it: nothing more
  assert.equal(out.length, 1)
})

test('an upgrade refused with 426 is an ordinary exchange, and the next request on the connection is framed as HTTP', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store })
  t.fromClient(Buffer.from(UPGRADE + 'POST /v1/responses HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}'))
  t.fromUpstream(Buffer.from('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}'))
  assert.deepEqual(out.map((e) => [e.seq, e.method, e.resp.status, e.transport]), [[0, 'GET', 426, undefined], [1, 'POST', 200, undefined]])
  assert.equal(t.wsSummary(), null)
})

test('a framing error on either side calls onFailure once with its side; open exchanges are written with the framer error', () => {
  const { out, store } = sink(); const failures = []
  const t = createExchangeTee({ flow: FLOW, recordStore: store, onFailure: (f) => failures.push(f) })
  t.fromClient(Buffer.from('POST /v1/messages HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}'))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\n'))
  t.fromUpstream(Buffer.from('more'))
  assert.deepEqual(failures.map((f) => [f.code, f.flow_id, f.side]), [['framer-error', 'f', 'response']])
  assert.deepEqual(out.map((e) => [e.error, e.resp.error.type, e.resp.status]), [[true, 'framer_error', 200]])
  const q = createExchangeTee({ flow: FLOW, recordStore: sink().store, onFailure: (f) => failures.push(f) })
  q.fromClient(Buffer.from('POST /a HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nQQ\r\n'))
  assert.deepEqual(failures.at(-1).side, 'request')
})

// ── D38 (RFC 4.6 §记录): what the connection's flows/ row and the engine's events must say ──────────────
const failSink = () => { const out = [], failures = []; return { out, failures, store: { envelope: (e) => out.push(e) }, onFailure: (f) => failures.push(f) } }
const OK0 = 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'

test('an exception while building an envelope is engine-error, not a framing error; the next exchange is still framed (D38 T-11)', () => {
  const { out, failures, store, onFailure } = failSink()
  const flow = { ...FLOW, get host() { throw new Error('boom') } }
  const t = createExchangeTee({ flow, recordStore: store, onFailure })
  for (let i = 0; i < 2; i++) { t.fromClient(Buffer.from(`GET /${i} HTTP/1.1\r\n\r\n`)); t.fromUpstream(Buffer.from(OK0)) }
  assert.equal(out.length, 0)
  assert.deepEqual(failures.map((f) => [f.code, f.flow_id, f.seq, /recording failed: boom/.test(f.reason)]), [['engine-error', 'f', 0, true], ['engine-error', 'f', 1, true]])
})

test('a response with no request to pair with is one unpaired-response event per connection, not dropped silently (D38 T-12)', () => {
  const { out, failures, store, onFailure } = failSink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store, onFailure })
  t.fromClient(Buffer.from('POST /v1/messages HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}XX')) // bad chunk terminator: the request framer stops
  for (let i = 0; i < 3; i++) t.fromUpstream(Buffer.from(i === 1 ? 'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n' : OK0))
  assert.deepEqual(out.map((e) => e.req_partial), ['framer-error'], 'the first response pairs with the broken request')
  assert.deepEqual(t.rowNotes(), { framerError: { side: 'request', message: 'bad chunk terminator' } }, 'the row says framing stopped (D38 review A)')
  assert.deepEqual(failures.map((f) => [f.code, f.side ?? f.status]), [['framer-error', 'request'], ['unpaired-response', 404]])
})

test('envelopes the store did not write are counted for the flows/ row (false or a throw); written ones are not (D38 T-13)', () => {
  let n = 0
  const store = { envelope: () => { n++; if (n === 1) return false; if (n === 2) throw new Error('EIO'); return true } }
  const t = createExchangeTee({ flow: FLOW, recordStore: store })
  for (let i = 0; i < 3; i++) { t.fromClient(Buffer.from(`GET /${i} HTTP/1.1\r\n\r\n`)); t.fromUpstream(Buffer.from(OK0)) }
  assert.deepEqual([t.rowNotes(), t.stats.recorded], [{ writeFailed: 2 }, 1])
})

test('after a WebSocket 101 the recorder\'s lost envelopes are counted on the row too (D38 T-13)', () => {
  const failures = []
  const t = createExchangeTee({ flow: FLOW, recordStore: { envelope: () => false }, onFailure: (f) => failures.push(f) })
  t.fromClient(Buffer.from('GET /v1/responses HTTP/1.1\r\nHost: h.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'))
  t.fromUpstream(Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n'))
  const mask = Buffer.from([1, 2, 3, 4]), text = Buffer.from('{"a":1}')
  t.fromClient(Buffer.concat([Buffer.from([0x81, 0x80 | text.length]), mask, Buffer.from(text.map((b, i) => b ^ mask[i % 4]))]))
  t.fromUpstream(Buffer.concat([Buffer.from([0x81, 2]), Buffer.from('ok')]))
  t.clientEnded(null) // the connection ends: the open call is written (and lost)
  assert.equal(t.rowNotes().writeFailed, 1)
  assert.deepEqual(failures.map((f) => [f.where, f.code, f.flow_id]), [['ws', 'write-failed', 'f']], 'and the ws recorder says it as a failure event, through the same sink')
})

test('a non-WebSocket 101 or a CONNECT 2xx: nothing after it is framed, and the row will say so (D38 T-15)', () => {
  for (const [req, resp, why] of [
    ['GET / HTTP/1.1\r\nUpgrade: h2c\r\nConnection: Upgrade, HTTP2-Settings\r\n\r\n', 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n', '101 h2c'],
    ['CONNECT inner.test:443 HTTP/1.1\r\n\r\n', 'HTTP/1.1 200 Connection established\r\n\r\n', 'CONNECT 200'],
  ]) {
    const { out, store } = sink()
    const t = createExchangeTee({ flow: FLOW, recordStore: store })
    t.fromClient(Buffer.from(req)); t.fromUpstream(Buffer.from(resp))
    t.fromClient(Buffer.from('GET /after HTTP/1.1\r\n\r\n')); t.fromUpstream(Buffer.from(OK0))
    assert.equal(out.length, 1, 'the head exchange only'); assert.deepEqual(t.rowNotes(), { notFollowed: why })
  }
})

test('a gzip request body is recorded decoded, its wire bytes kept; the bytes the tee saw are untouched (RFC 4.6 请求体压缩, T16)', async () => {
  const zlib = (await import('node:zlib')).default
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store })
  const gz = zlib.gzipSync('{"model":"m"}')
  const wire = Buffer.concat([Buffer.from(`POST /v1/messages HTTP/1.1\r\nContent-Encoding: gzip\r\nContent-Length: ${gz.length}\r\n\r\n`), gz])
  const copy = Buffer.from(wire)
  t.fromClient(wire)
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}'))
  assert.equal(out[0].req_body, '{"model":"m"}'); assert.equal(out[0].req_body_b64, gz.toString('base64')); assert.equal(out[0].req_content_encoding, 'gzip')
  assert.ok(wire.equals(copy), 'recording never rewrites the forwarded bytes')
})

// ── D40 (RFC 4.6 §记录「保存级别」): class + level sampled when the request starts; wire lengths exact past the cap ─────────
const ok = (body, extra = '') => `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
const post = (path, body, extra = '') => `POST ${path} HTTP/1.1\r\n${extra}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`

test('D40: the retention callback is asked once per request with (proc, host, method, path); its class lands in traffic_class, host and body_wire_bytes are written', () => {
  const { out, store } = sink(); const asked = []
  const t = createExchangeTee({ flow: FLOW, recordStore: store, retention: (...a) => { asked.push(a); return { class: 'telemetry', level: 'full' } } })
  t.fromClient(Buffer.from(post('/api/event_logging/v2/batch?x=1', '{"e":1}'))); t.fromUpstream(Buffer.from(ok('{"ok":1}')))
  assert.deepEqual(asked, [[FLOW.proc, 'h.test', 'POST', '/api/event_logging/v2/batch?x=1']])
  assert.deepEqual([out[0].traffic_class, out[0].host, out[0].body_wire_bytes, out[0].req_body, 'body_retention' in out[0]], ['telemetry', 'h.test', { req: 7, resp: 8 }, '{"e":1}', false])
  const bare = sink(); const u = createExchangeTee({ flow: FLOW, recordStore: bare.store })
  u.fromClient(Buffer.from(post('/v1/messages', '{}'))); u.fromUpstream(Buffer.from(ok('{}')))
  assert.equal(bare.out[0].traffic_class, 'llm', 'no callback: every call is full, told by its endpoint')
})

test('D40 · K2: at the log level nothing is buffered — req_body and resp are sizes — and the headers and the exact wire lengths stay', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store, retention: () => ({ class: 'telemetry', level: 'log' }) })
  const body = 'x'.repeat(300)
  t.fromClient(Buffer.from(`POST /api/event_logging/v2/batch HTTP/1.1\r\nAuthorization: Bearer k\r\nContent-Length: 300\r\n\r\n${body.slice(0, 100)}`)); t.fromClient(Buffer.from(body.slice(100)))
  t.fromUpstream(Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nRequest-Id: r1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n3\r\n!!!\r\n0\r\n\r\n'))
  const [e] = out
  assert.deepEqual(e.req_body, { raw_chars: 300, verbatim: false })
  assert.deepEqual(e.resp, { status: 200, kind: 'json', headers: { 'content-type': 'application/json', 'request-id': 'r1', 'transfer-encoding': 'chunked' }, request_id: 'r1', raw_chars: 8, verbatim: false })
  assert.deepEqual([e.body_retention, e.body_wire_bytes, e.req_headers.authorization], ['log', { req: 300, resp: 8 }, 'Bearer k'])
  assert.match(e.req_head_raw, /^POST \/api\/event_logging/); assert.match(e.resp_head_raw, /^HTTP\/1.1 200/)
  assert.doesNotMatch(JSON.stringify(e), /xxxxxxxx|hello/, 'no byte of either body is in the envelope')
})

test('D40 · K2: body_wire_bytes is the full length past the 64 MiB cap, at the log level (a 65 MiB request and a 66 MiB response; no label, nothing was kept) and at full (a cut prefix + the exact length)', () => {
  const MiB = 1 << 20, chunk = Buffer.alloc(MiB, 0x61)
  const lg = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: lg.store, retention: () => ({ class: 'files', level: 'log' }) })
  t.fromClient(Buffer.from(`POST /upload HTTP/1.1\r\nContent-Length: ${65 * MiB}\r\n\r\n`)); for (let i = 0; i < 65; i++) t.fromClient(chunk)
  t.fromUpstream(Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${66 * MiB}\r\n\r\n`)); for (let i = 0; i < 66; i++) t.fromUpstream(chunk)
  assert.deepEqual(lg.out[0].body_wire_bytes, { req: 65 * MiB, resp: 66 * MiB })
  assert.deepEqual([lg.out[0].req_body, lg.out[0].resp.raw_chars, 'req_truncated' in lg.out[0], 'truncated' in lg.out[0].resp], [{ raw_chars: 65 * MiB, verbatim: false }, 66 * MiB, false, false])
  const full = sink(); const f = createExchangeTee({ flow: FLOW, recordStore: full.store, maxBodyBytes: 8 })
  f.fromClient(Buffer.from(post('/upload', '0123456789abcdef'))); f.fromUpstream(Buffer.from(ok('{"long":"response body"}')))
  const e = full.out[0]
  assert.deepEqual([e.req_body, e.req_truncated, e.req_body_bytes, e.body_wire_bytes], ['01234567', true, 8, { req: 16, resp: 24 }])
  assert.deepEqual([e.resp.truncated, e.resp.body_bytes], [true, 8])
})

test('D40: the level is the one sampled when the request STARTED — a change in the middle of the body does not reach it; the next request takes the new one', () => {
  const { out, store } = sink(); let level = 'log'
  const t = createExchangeTee({ flow: FLOW, recordStore: store, retention: () => ({ class: 'telemetry', level }) })
  t.fromClient(Buffer.from('POST /a HTTP/1.1\r\nContent-Length: 6\r\n\r\nabc')); level = 'full'; t.fromClient(Buffer.from('def'))
  t.fromUpstream(Buffer.from(ok('{"a":1}')))
  t.fromClient(Buffer.from(post('/b', 'ghi'))); t.fromUpstream(Buffer.from(ok('{"b":1}')))
  assert.deepEqual([out[0].body_retention, out[0].req_body, out[1].body_retention, out[1].req_body, out[1].resp.body], ['log', { raw_chars: 6, verbatim: false }, undefined, 'ghi', { b: 1 }])
})

test('D40: pipelined requests of different levels each get the level of their own request: a response follows the request it answers', () => {
  const { out, store } = sink()
  const t = createExchangeTee({ flow: FLOW, recordStore: store, retention: (_p, _h, _m, path) => ({ class: 'other', level: path === '/quiet' ? 'log' : 'full' }) })
  t.fromClient(Buffer.from(`${post('/quiet', 'q')}${post('/loud', 'l')}`))
  t.fromUpstream(Buffer.from(`${ok('{"q":1}')}${ok('{"l":1}')}`))
  assert.deepEqual(out.map((e) => [e.endpoint, e.body_retention, e.resp.body, e.resp.raw_chars]), [['/quiet', 'log', undefined, 7], ['/loud', undefined, { l: 1 }, undefined]])
})

test('D40: a retention callback that throws or answers nonsense is `full`, and never stops the framing', () => {
  for (const retention of [() => { throw new Error('boom') }, () => null, () => ({ class: 'nonsense', level: 'half' })]) {
    const { out, store } = sink()
    const t = createExchangeTee({ flow: FLOW, recordStore: store, retention })
    t.fromClient(Buffer.from(post('/v1/messages', '{"a":1}'))); t.fromUpstream(Buffer.from(ok('{}')))
    assert.deepEqual([out[0].req_body, 'body_retention' in out[0], ['llm', 'other'].includes(out[0].traffic_class)], ['{"a":1}', false, true])
  }
})
