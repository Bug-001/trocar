// test/capture/json-reply-verbatim.test.mjs — RFC 4.1 保真边界 ⑤ + Extensions (D40 audit finding 偷换概念): a non-LLM reply is to be
// stored VERBATIM, but a JSON reply was stored as the parsed value and re-serialized on write: {"id": 12345678901234567890,"dup": 1,"dup": 2}
// (the finding's own wire body) came out as {"id":12345678901234567000,"dup":2}, with nothing on the board saying so. Duplicate-key JSON is a
// classic parser-differential trick, and the point of D40 is forensics on what a harness did. Now the parsed value stays (readers use it) and the
// wire text is stored beside it as `resp.raw` whenever writing the value back out would not give that text — in both capture paths (the old
// reverse proxy / MITM and the collector engine), for LLM and non-LLM calls alike; the board shows `raw`; a record from before this says it is
// re-serialized (invariant 4).
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseJsonReply } from '../../src/capture/request-body.mjs'
import { shapeResponse } from '../../src/collector/core/record/body.mjs'
import { bodyResp } from '../../src/capture/response-tee.mjs'
import { captureLabelsOf } from '../../src/dissect/capture-labels.mjs'
import { controlRecordWire } from '../../src/view/control-wire.mjs'
import { LEGACY_PATHS } from '../helpers/legacy-paths.mjs'
import { engineExchange } from '../helpers/engine-exchange.mjs'

const T = { timeout: 30_000 }
const TRICKY = '{"id": 12345678901234567890,"dup": 1,"dup": 2}'
const CASES = [
  ['a big integer and a duplicated key (the finding\'s own body)', TRICKY],
  ['whitespace and a trailing newline', '{ "a" : 1,\n  "b" : [1, 2] }\n'],
  ['integer-like keys, which JavaScript re-orders', '{"b":1,"2":2,"1":3}'],
  ['\\u escapes', '{"s":"\\u00e9\\u4e2d"}'],
  ['a BOM', '﻿{"a":1}'],
]

test('parseJsonReply: the wire text is kept exactly when writing the parsed value back would not give it', () => {
  for (const [what, text] of CASES) {
    const j = parseJsonReply(text)
    assert.equal(j.raw, text, what); assert.ok(j.body && typeof j.body === 'object', what)
  }
  for (const text of ['{"a":1}', '[1,2,3]', '{"a":{"b":[true,null,"x"]}}', '"just a string"', '0']) assert.deepEqual(Object.keys(parseJsonReply(text)), ['body'], `${text}: nothing to keep twice`)
  assert.equal(parseJsonReply('not json'), null); assert.equal(parseJsonReply('{"a":'), null)
  assert.equal(parseJsonReply(TRICKY).body.dup, 2, 'the parsed value is still what readers use (the last duplicate wins)')
})

test('the collector and the old capture shape every one of these replies the same way, and keep the wire text', () => {
  for (const [what, text] of CASES) {
    const wire = Buffer.from(text, 'utf8')
    const col = shapeResponse({ status: 200, headers: [['content-type', 'application/json']], body: wire })
    const old = bodyResp(200, wire, '')
    for (const r of [col, old]) { assert.equal(r.kind, 'json', what); assert.equal(r.raw, text, `${what}: the wire text`); assert.ok(Buffer.from(r.raw, 'utf8').equals(wire)) }
    assert.deepEqual(col.body, old.body, what)
  }
  for (const text of ['{"a":1}', '[1,2]']) {
    const wire = Buffer.from(text)
    assert.equal('raw' in shapeResponse({ status: 200, headers: [['content-type', 'application/json']], body: wire }), false, 'collector: canonical JSON is not stored twice')
    assert.equal('raw' in bodyResp(200, wire, ''), false, 'old capture: likewise')
  }
})

for (const start of LEGACY_PATHS) {
  const name = start === LEGACY_PATHS[0] ? 'reverse proxy' : 'MITM'
  test(`${name}: a JSON reply is stored with its wire text — non-LLM and inference alike; the client gets the bytes as sent (D40 audit)`, T, async () => {
    const reply = (req, res) => { req.resume(); req.on('end', () => { const b = Buffer.from(TRICKY); res.writeHead(200, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b) }) }
    const p = await start(reply)
    try {
      for (const path of ['/api/oauth/profile', '/v1/messages']) {
        const r = await p.send({ method: path === '/v1/messages' ? 'POST' : 'GET', path, body: path === '/v1/messages' ? '{"model":"m"}' : undefined })
        assert.equal(r.body.toString(), TRICKY, 'the client got the wire bytes')
        for (let i = 0; i < 200 && !p.envelopes.some((e) => e.endpoint === path); i++) await new Promise((ok) => setTimeout(ok, 10))
        const env = p.envelopes.find((e) => e.endpoint === path)
        assert.equal(env.resp.raw, TRICKY, `${path}: the stored text is the wire text`)
        assert.deepEqual([env.resp.kind, env.resp.body.dup], ['json', 2], `${path}: the parsed value stays for readers`)
        assert.deepEqual(captureLabelsOf(env).map((l) => l.id), [], `${path}: complete: no 「非逐字」 label`)
      }
    } finally { p.stop() }
  })
}

test('the collector engine: the same reply, through real TLS, is stored with its wire text (D40 audit)', T, async () => {
  const r = await engineExchange({ path: '/api/oauth/profile', headers: { 'Content-Type': 'application/json' }, wire: Buffer.from(TRICKY) })
  assert.equal(r.got, Buffer.byteLength(r.head) + TRICKY.length)
  assert.equal(r.env.resp.raw, TRICKY); assert.deepEqual([r.env.resp.kind, r.env.resp.body.dup], ['json', 2])
  assert.deepEqual(captureLabelsOf(r.env).map((l) => l.id), [])
  const ok = await engineExchange({ path: '/api/x', headers: { 'Content-Type': 'application/json' }, wire: Buffer.from('{"a":1}') })
  assert.equal('raw' in ok.env.resp, false, 'a reply that re-serializes to itself stores nothing twice')
})

test('the board: a reply that has its wire text shows it verbatim; a record from before D40 says its JSON reply is re-serialized (invariant 4)', () => {
  const rec = { id: 'n1', endpoint: '/api/x', method: 'GET', is_llm_call: false, req_headers: { host: 'a.test' }, req_body: '', body_wire_bytes: { req: 0, resp: TRICKY.length },
    resp: { status: 200, kind: 'json', body: JSON.parse(TRICKY), raw: TRICKY } }
  const w = controlRecordWire(rec)
  assert.deepEqual([w.ctl.resp.kind, w.ctl.resp.text], ['text', TRICKY], 'the panel shows the wire text, not a pretty-printed re-serialization')
  assert.deepEqual(w.ctl.labels.map((l) => l.id), [])
  // an exact reply of a current record: nothing to disclaim either
  assert.deepEqual(captureLabelsOf({ ...rec, resp: { status: 200, kind: 'json', body: { a: 1 } } }).map((l) => l.id), [])
  // before D40: no body_wire_bytes, no raw — the shape alone says the JSON was parsed and written back
  const { body_wire_bytes, ...old } = rec; old.resp = { status: 200, kind: 'json', body: JSON.parse(TRICKY) }
  const ow = controlRecordWire(old)
  assert.ok(ow.ctl.labels.some((l) => l.id === 'resp-json-reserialized' && /not wire bytes/.test(l.label)), 'said in place')
})
