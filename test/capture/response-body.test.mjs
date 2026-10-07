// test/capture/response-body.test.mjs — the old capture's non-SSE response shaping (src/capture/response-tee.mjs::bodyResp) keeps the wire
// bytes when it cannot keep them as text (invariant 2): a JSON reply that is not valid UTF-8 is not parsed through U+FFFD, and the old
// capture and the collector (src/collector/core/record/body.mjs) shape the same reply the same way (review 2026-10-07, M1).
import test from 'node:test'
import assert from 'node:assert/strict'
import { bodyResp } from '../../src/capture/response-tee.mjs'
import { shapeResponse } from '../../src/collector/core/record/body.mjs'

const wires = {
  json: Buffer.from('{"ok":true,"n":[1,2]}'),
  html: Buffer.from('<html>502 Bad Gateway</html>'),
  bomText: Buffer.from('﻿plain text\r\n', 'utf8'),
  badUtf8Json: Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]),
  binary: Buffer.from([0xff, 0xfe, 0x00, 0x01]),
}

test('a reply that is not valid UTF-8 keeps its bytes whether or not it says it is JSON; a BOM stays in a text reply', () => {
  const bad = bodyResp(200, wires.badUtf8Json, '')
  assert.deepEqual([bad.kind, bad.body, bad.raw], ['text', undefined, undefined])
  assert.ok(Buffer.from(bad.raw_b64, 'base64').equals(wires.badUtf8Json), 'the wire bytes, not a reading with U+FFFD in it')
  const bom = bodyResp(200, wires.bomText, '')
  assert.ok(Buffer.from(bom.raw, 'utf8').equals(wires.bomText), 'the BOM is kept')
})

test('the old capture and the collector shape a reply the same way (the same keys, the same bytes)', () => {
  const ctype = { json: 'application/json', html: 'text/html', bomText: 'text/plain', badUtf8Json: 'application/json', binary: 'application/octet-stream' }
  for (const [name, wire] of Object.entries(wires)) {
    const old = bodyResp(200, wire, '')
    const col = shapeResponse({ status: 200, headers: [['content-type', ctype[name]]], body: wire, truncated: false })
    const pick = (r) => ({ kind: r.kind, body: r.body, raw: r.raw, raw_b64: r.raw_b64 })
    assert.deepEqual(pick(col), pick(old), name)
  }
})
