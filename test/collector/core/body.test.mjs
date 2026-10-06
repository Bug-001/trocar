import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { decodeContent, shapeResponse } from '../../../src/collector/core/record/body.mjs'
import { respIncompleteOf } from '../../../src/dissect/capture-labels.mjs'

const SSE = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"x","role":"assistant","usage":{"input_tokens":3}}}\n\n' +
  ': keep-alive comment\n\nid: 7\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好🙂"}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'

test('SSE: raw keeps comments, id: and event: lines byte-exact; reconstruction still works', () => {
  const r = shapeResponse({ status: 200, headers: [['Content-Type', 'text/event-stream']], body: Buffer.from(SSE), truncated: false })
  assert.equal(r.kind, 'sse'); assert.equal(r.raw, SSE); assert.equal(r.text, '你好🙂')
  assert.equal(r.raw_sse.length, 4); assert.equal(r.headers['content-type'], 'text/event-stream')
})

test('decode: gzip, br, chained "gzip, br" and a broken body', () => {
  const j = Buffer.from('{"a":1}')
  assert.equal(decodeContent(zlib.gzipSync(j), 'gzip').buf.toString(), '{"a":1}')
  assert.equal(decodeContent(zlib.brotliCompressSync(zlib.gzipSync(j)), 'gzip, br').buf.toString(), '{"a":1}')
  const bad = decodeContent(Buffer.from('nope'), 'gzip')
  assert.equal(bad.decoded, false); assert.ok(bad.error)
})

test('shape: json, non-UTF-8 text, truncated and empty bodies are labeled', () => {
  assert.deepEqual(shapeResponse({ status: 200, headers: [['content-type', 'application/json']], body: Buffer.from('{"ok":true}'), truncated: false }).body, { ok: true })
  const bin = shapeResponse({ status: 502, headers: [['content-type', 'text/html']], body: Buffer.from([0xff, 0xfe, 0x00]), truncated: false })
  assert.equal(bin.kind, 'text'); assert.equal(bin.raw_b64, Buffer.from([0xff, 0xfe, 0x00]).toString('base64'))
  const t = shapeResponse({ status: 200, headers: [], body: Buffer.from('abc'), truncated: true })
  assert.equal(t.truncated, true); assert.equal(t.body_bytes, 3)
  assert.equal(shapeResponse({ status: 204, headers: [], body: Buffer.alloc(0), truncated: false }).kind, 'empty')
})

// review (M1, invariant 2): `raw` / `raw_b64` are the wire, not a lossy reading of it. A TextDecoder without ignoreBOM dropped a text
// reply's BOM (a 12-byte reply stored as 9 chars, no label), and a SSE stream with an invalid byte was stored with U+FFFD in its place.
test('a text reply keeps its BOM: raw is the wire bytes, byte for byte', () => {
  const wire = Buffer.from('\ufeffhello\r\n', 'utf8')
  const r = shapeResponse({ status: 200, headers: [['content-type', 'text/plain']], body: wire, truncated: false })
  assert.deepEqual([r.kind, r.raw], ['text', '\ufeffhello\r\n'])
  assert.ok(Buffer.from(r.raw, 'utf8').equals(wire), 'the stored text is exactly the 12 wire bytes')
  // a JSON reply is stored parsed (4.1 保真边界 ⑤), but one that starts with a BOM is still read as JSON — what the answer says is not lost
  const j = shapeResponse({ status: 200, headers: [['content-type', 'application/json']], body: Buffer.from('\ufeff{"a":1}', 'utf8'), truncated: false })
  assert.deepEqual([j.kind, j.body], ['json', { a: 1 }])
})

test('an SSE stream or JSON reply that is not valid UTF-8 keeps its bytes (raw_b64); no text with U+FFFD in it is stored', () => {
  const sse = Buffer.concat([Buffer.from('data: {"a":1}\n\ndata: '), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from('\n\n')])
  const r = shapeResponse({ status: 200, headers: [['content-type', 'text/event-stream']], body: sse, truncated: false })
  assert.equal(r.kind, 'sse')
  assert.equal(r.raw, undefined, 'no lossy text')
  assert.ok(Buffer.from(r.raw_b64, 'base64').equals(sse), 'the wire bytes')
  const json = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}')])
  const j = shapeResponse({ status: 200, headers: [['content-type', 'application/json']], body: json, truncated: false })
  assert.deepEqual([j.kind, j.body, j.raw], ['text', undefined, undefined], 'not read as JSON: the parse would have put U+FFFD in the body')
  assert.ok(Buffer.from(j.raw_b64, 'base64').equals(json))
  // and the reader says so in place (invariant 4): not an empty or a complete reply
  const lab = respIncompleteOf({ resp: r })
  assert.deepEqual([lab.binary, lab.notJson], [true, false])
  assert.match(lab.text, /not UTF-8 text: its bytes are kept \(raw_b64\)/)
})
