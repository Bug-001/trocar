// test/rules/units.test.mjs — a captured record as the units a rule would have seen (RFC 1.6 §4.4 `rules test`, 5.1 §记录与标注). The records are shaped as the collector writes them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { unitsOf } from '../../src/rules/units.mjs'

const sha = (b) => createHash('sha256').update(b).digest('hex')
const req = { on: 'request' }, resp = { on: 'response' }
const record = (over = {}) => ({
  endpoint: '/v1/messages', method: 'POST', host: 'api.example.com', traffic_class: 'llm', proc: { pid: 41, agent: 'claude-code' },
  req_headers: { 'content-type': 'application/json' }, req_body: '{"a":"中"}', resp: { status: 200, kind: 'json', headers: { server: 'x' }, raw: '{"ok":true}' }, ...over,
})
const joined = (units) => Buffer.concat(units.map((u) => u.body))

test('a request is one unit with the envelope\'s fields; the harness is the code id a rule names', () => {
  const { units: [unit, ...rest] } = unitsOf(record(), req)
  assert.deepEqual(rest, [])
  const { body, ...fields } = unit
  assert.deepEqual(body, Buffer.from('{"a":"中"}'))
  assert.deepEqual(fields, {
    on: 'request', harness: 'claude-code', pid: 41, method: 'POST', host: 'api.example.com', path: '/v1/messages', class: 'llm', status: null, event_index: null,
    sse: false, encoding: null, headers: [['content-type', 'application/json']], req_headers: [['content-type', 'application/json']],
  })
})

test('a response\'s head is its own and the request\'s stays readable', () => {
  const [unit] = unitsOf(record(), resp).units
  assert.deepEqual([unit.status, unit.headers, unit.req_headers], [200, [['server', 'x']], [['content-type', 'application/json']]])
})

const STREAMS = {
  lf: 'event: a\ndata: {"x":1}\n\nevent: b\ndata: {"x":"中😀"}\n\n',
  crlf: 'event: a\r\ndata: {"x":1}\r\n\r\ndata: {"y":2}\r\n\r\n',
  'no last blank line': 'data: 1\n\ndata: 2\n',
  'blank lines around': '\n\ndata: 1\n\n\n\ndata: 2\n\n\n',
  comments: ': ping\n\ndata: 1\n\n',
}
for (const [name, raw] of Object.entries(STREAMS)) {
  test(`SSE, ${name}: one unit per event, numbered from 0, and they add up to raw byte for byte`, () => {
    const { units } = unitsOf(record({ resp: { status: 200, kind: 'sse', headers: {}, raw } }), resp)
    assert.deepEqual(units.map((u) => u.event_index), units.map((_, i) => i))
    assert.equal(units.length, 2)
    assert.ok(units.every((u) => u.sse))
    assert.ok(joined(units).equals(Buffer.from(raw)))
  })
}

test('a whole rule sees an SSE stream as one unit', () => {
  const raw = STREAMS.lf
  const { units } = unitsOf(record({ resp: { status: 200, kind: 'sse', headers: {}, raw } }), { on: 'response', whole: true })
  assert.equal(units.length, 1)
  assert.ok(units[0].sse && units[0].body.equals(Buffer.from(raw)) && units[0].event_index === null)
})

test('a response keeps its bytes however it is stored', () => {
  const body = { a: 1 }, bytes = Buffer.from([0xff, 0x00, 0x41])
  assert.deepEqual(unitsOf(record({ resp: { status: 200, kind: 'json', body } }), resp).units[0].body, Buffer.from(JSON.stringify(body)))
  assert.deepEqual(unitsOf(record({ resp: { status: 200, kind: 'text', raw_b64: bytes.toString('base64') } }), resp).units[0].body, bytes)
  assert.equal(unitsOf(record({ resp: { status: 204, kind: 'empty' } }), resp).units[0].body, null)
})

test('a reply that did not arrive whole, or whose text was not kept, cannot be tested', () => {
  const cases = [
    ['partial', { status: 502, kind: 'error', partial: { kind: 'sse', raw: 'data: 1\n\n' } }],
    ['partial', { status: 502, kind: 'error', partial: { kind: 'json', body: { a: 1 } } }],
    ['no-response', { status: 502, kind: 'error' }],
    ['body-not-kept', { status: 200, kind: 'sse', raw_sse: [{ data: '1' }] }],
    ['body-not-kept', { status: 200, kind: 'text' }],
  ]
  for (const [cannot, r] of cases) {
    for (const rule of [resp, { on: 'response', whole: true }]) assert.deepEqual(unitsOf(record({ resp: r }), rule), { cannot }, JSON.stringify(r))
  }
})

test('WebSocket: each message of the side is a unit, in order', () => {
  const ws = record({ transport: 'ws', req_body: 'one', req_extra_messages: ['two', { b64: Buffer.from('three').toString('base64') }], resp: { messages: ['a', 'b'] } })
  assert.deepEqual(unitsOf(ws, { on: 'ws-client' }).units.map((u) => String(u.body)), ['one', 'two', 'three'])
  assert.deepEqual(unitsOf(ws, { on: 'ws-server' }).units.map((u) => [String(u.body), u.on]), [['a', 'ws-server'], ['b', 'ws-server']])
  assert.deepEqual(unitsOf(ws, { on: 'ws-client' }).units.map((u) => u.event_index), [0, 1, 2], '5.1: which message on the connection, from 0')
  assert.deepEqual(unitsOf(ws, { on: 'ws-server' }).units.map((u) => u.event_index), [0, 1])
  assert.deepEqual(unitsOf(ws, req).units, [], 'an HTTP rule has nothing to act on here')
  assert.deepEqual(unitsOf(record(), { on: 'ws-client' }).units, [])
})

test('a message kept only by its size, or not decoded, cannot be tested', () => {
  for (const kept of [{ omitted_bytes: 9 }, { raw_chars: 9, verbatim: false }, { b64: 'AA==', decode_error: 'x' }]) {
    assert.ok(unitsOf(record({ transport: 'ws', req_extra_messages: [kept] }), { on: 'ws-client' }).cannot)
    assert.ok(unitsOf(record({ transport: 'ws', resp: { messages: [kept] } }), { on: 'ws-server' }).cannot)
  }
  assert.ok(unitsOf(record({ transport: 'ws', ws_truncated: true }), { on: 'ws-client' }).cannot)
})

test('what was not kept whole cannot be tested, on either side', () => {
  const cases = [{ body_retention: 'log', req_body: { raw_chars: 9, verbatim: false } }, { req_truncated: true, req_body_bytes: 3 }, { req_partial: 'aborted' }]
  for (const over of cases) for (const rule of [req, resp]) assert.ok(unitsOf(record(over), rule).cannot, JSON.stringify(over))
  assert.ok(unitsOf(record({ resp: null }), resp).cannot, 'no response')
  assert.ok(unitsOf(record({ resp: { status: 200, kind: 'text', raw: 'ab', truncated: true } }), resp).cannot)
  assert.ok(unitsOf(record({ resp: null }), req).units, 'a request does not need its response')
})

test('a compressed body goes as the wire bytes, with its encoding', () => {
  const wire = gzipSync('{"a":1}')
  const [unit] = unitsOf(record({ req_body: '{"a":1}', req_body_b64: wire.toString('base64'), req_content_encoding: 'gzip' }), req).units
  assert.ok(unit.body.equals(wire))
  assert.equal(unit.encoding, 'gzip')
})

test('binary and empty bodies', () => {
  const bytes = Buffer.from([0xff, 0xfe])
  assert.ok(unitsOf(record({ req_body: null, req_body_b64: bytes.toString('base64') }), req).units[0].body.equals(bytes))
  assert.equal(unitsOf(record({ req_body: null, method: 'GET' }), req).units[0].body, null)
})

const AGENT = 'say ALPHA 中', WIRE = 'say BRAVO 中'
const patched = (over = {}) => ({ recover: 'patch', edits: [{ at: 4, del: 5, ins: 'ALPHA' }], base_sha256: sha(WIRE), result_sha256: sha(AGENT), ...over })
const changed = (agent_request) => record({ req_body: WIRE, intervention: { agent_request } })

test('a changed record: the agent\'s bytes by default, restored and checked; the wire\'s with asSent', () => {
  const inline = { recover: 'inline', body_b64: Buffer.from(AGENT).toString('base64'), base_sha256: sha(WIRE), result_sha256: sha(AGENT) }
  for (const recover of [patched(), inline]) {
    assert.equal(String(unitsOf(changed(recover), req).units[0].body), AGENT)
    assert.equal(String(unitsOf(changed(recover), req, { asSent: true }).units[0].body), WIRE)
  }
})

test('restored bytes that fail their check cannot be tested, and the wire\'s still can', () => {
  const cases = [patched({ result_sha256: sha('other') }), patched({ base_sha256: sha('other') }), patched({ edits: [{ at: 0, del: 1, ins: 'x' }] }), { recover: 'inline', base_sha256: sha(WIRE), result_sha256: sha(AGENT) }]
  for (const recover of cases) {
    assert.ok(unitsOf(changed(recover), req).cannot, JSON.stringify(recover))
    assert.equal(String(unitsOf(changed(recover), req, { asSent: true }).units[0].body), WIRE)
  }
})
