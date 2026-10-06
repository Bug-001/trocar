// test/collector/core/response-bomb.test.mjs — RFC 4.6 §记录 / 4.1 §统一原始信封 (D40 audit finding 偷懒): under `all` ANY host of a trusted agent
// can answer with a compression bomb. The request side was bounded by the first review (a compressed request body decodes to 1 MiB when the
// call is not inference); the RESPONSE side was not: a 713 KB gzip reply that expands to 700 MiB left no envelope at all (an engine-error
// "Cannot create a string longer than …"), stalled the daemon's one event loop for 510 ms and cost 732 MiB of RSS. A reply is now decoded
// under the same two limits: 1 MiB when the call is not inference, 64 MiB when it is. Past the limit the wire bytes are kept (raw_b64) and the
// reply says why (encoding_error), so the board labels it 回复未解码, never an empty hole. Driven through the real engine over real TLS.
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { shapeResponse } from '../../../src/collector/core/record/body.mjs'
import { NON_INFERENCE_MAX_DECODED_BYTES, MAX_DECODED_RESPONSE_BYTES } from '../../../src/capture/request-body.mjs'
import { engineExchange } from '../../helpers/engine-exchange.mjs'

const T = { timeout: 30_000 }
const MiB = 1 << 20
const gzipZeros = (mib) => zlib.gzipSync(Buffer.alloc(mib * MiB), { level: 9 })

// one request through the engine to an upstream that answers `wire` (a gzip body) with the given content type
const exchange = ({ path, ctype, wire }) => engineExchange({ path, headers: { 'Content-Type': ctype, 'Content-Encoding': 'gzip' }, wire })

test('a non-inference reply that decodes past 1 MiB is not expanded: the envelope has the wire bytes and says why; the client got every byte (§记录, D40 audit)', T, async () => {
  const wire = gzipZeros(40)                      // ~40 KB on the wire, 40 MiB decoded
  const r = await exchange({ path: '/files/archive', ctype: 'application/octet-stream', wire })
  assert.equal(r.envelopes.length, 1); assert.deepEqual(r.failures, [], 'no engine-error: the call is recorded, not lost')
  assert.equal(r.got, Buffer.byteLength(r.head) + wire.length, 'forwarded bytes == received bytes')
  const resp = r.env.resp
  assert.equal(r.env.error, undefined)
  assert.match(resp.encoding_error, new RegExp(`decoded size over ${NON_INFERENCE_MAX_DECODED_BYTES} bytes for a call that is not inference`))
  assert.ok(Buffer.from(resp.raw_b64, 'base64').equals(wire), 'the wire bytes, verbatim')
  assert.equal(resp.raw, undefined); assert.equal(resp.body, undefined)
  assert.ok(JSON.stringify(r.env).length < 4 * wire.length + 5000, 'the record is the size of the wire, not of the expansion')
  assert.equal(r.env.body_wire_bytes.resp, wire.length)
})

test('an inference reply is expanded to 64 MiB at most: a bomb past it is the same record, not a lost call (§记录, D40 audit)', T, async () => {
  const wire = gzipZeros(70)                      // 70 MiB decoded, past the 64 MiB limit
  const r = await exchange({ path: '/v1/messages', ctype: 'application/json', wire })
  assert.equal(r.envelopes.length, 1); assert.deepEqual(r.failures, [])
  assert.match(r.env.resp.encoding_error, new RegExp(`decoded size over ${MAX_DECODED_RESPONSE_BYTES} bytes`)); assert.ok(!/not inference/.test(r.env.resp.encoding_error))
  assert.equal(r.env.resp.kind, 'json'); assert.ok(Buffer.from(r.env.resp.raw_b64, 'base64').equals(wire))
  assert.equal(r.env.is_llm_call, true)
})

test('a compressed SSE bomb is held to the same limits (§记录, D40 audit)', T, async () => {
  const r = await exchange({ path: '/api/stream', ctype: 'text/event-stream', wire: gzipZeros(8) })
  assert.equal(r.envelopes.length, 1); assert.deepEqual(r.failures, [])
  assert.equal(r.env.resp.kind, 'sse'); assert.match(r.env.resp.encoding_error, /decoded size over \d+ bytes for a call that is not inference/)
  assert.equal(r.env.resp.raw, undefined, 'no 8 MiB text in the record')
})

test('a reply that decodes within the limit is unchanged: the new limit is not a blanket refusal to decode (§记录)', T, async () => {
  const body = JSON.stringify({ rows: 'x'.repeat(900 * 1024) })           // 900 KiB decoded, under 1 MiB
  const r = await exchange({ path: '/api/list', ctype: 'application/json', wire: zlib.gzipSync(body) })
  assert.equal(r.env.resp.encoding_error, undefined); assert.equal(r.env.resp.kind, 'json'); assert.equal(r.env.resp.body.rows.length, 900 * 1024)
})

test('shapeResponse: the limit is per call kind, the label names it, and the default (no llm flag) is the inference limit', () => {
  const wire = gzipZeros(2)
  const head = [['content-type', 'application/json'], ['content-encoding', 'gzip']]
  const non = shapeResponse({ status: 200, headers: head, body: wire, llm: false })
  assert.match(non.encoding_error, /decoded size over 1048576 bytes for a call that is not inference/); assert.ok(Buffer.from(non.raw_b64, 'base64').equals(wire))
  const llm = shapeResponse({ status: 200, headers: head, body: wire })
  assert.equal(llm.encoding_error, undefined, '2 MiB of zeros decodes for inference'); assert.equal(llm.kind, 'text', 'zeros are not JSON: kept as text')
})
