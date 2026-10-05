import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { decodeContent, shapeResponse } from '../../../src/collector/core/record/body.mjs'

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
