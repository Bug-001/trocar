// test/view/control-wire.test.mjs — a query document never carries a credential-class header's value (RFC 2.6 §保真边界 2 · #13,
// 4.1 §凭据处置): controlRecordWire blanks every SECRET_HEADERS value in the header objects and the raw heads, names them in
// ctl.masked, and `reveal` returns exactly one. The record is a captured seed line (test/fixtures/old-capture-resp-shapes.ndjson).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { controlRecordWire } from '../../src/view/control-wire.mjs'
import { SECRET_HEADERS } from '../../src/capture/redact.mjs'
import { CREDENTIAL_HEADERS } from '../../src/web/v2/core/sensitive.mjs'

const SEED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/old-capture-resp-shapes.ndjson'), 'utf8').split('\n')[0])
const CASES = [(n) => n, (n) => n.replace(/(^|-)([a-z])/g, (_, d, c) => d + c.toUpperCase()), (n) => n.toUpperCase()]
const SHAPES = [(v) => v, (v) => [v, `${v}-2`]]
const isSecret = (k) => SECRET_HEADERS.has(k.toLowerCase())
const head = (start, pairs) => [start, ...pairs.map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`)].join('\r\n') + '\r\n\r\n'
const blankHead = (start, pairs, keep) => [start, ...pairs.map(([k, v]) => (isSecret(k) && k.toLowerCase() !== keep ? `${k}: ` : `${k}: ${[].concat(v).join(', ')}`))].join('\r\n') + '\r\n\r\n'

// one record carrying every credential name in one case/shape, beside the seed's own headers
function build(caseOf, shapeOf, extraResp = {}) {
  const creds = [...SECRET_HEADERS].map((n, i) => [caseOf(n), shapeOf(`cred-value-${i}`)])
  const reqPairs = [...Object.entries(SEED.req_headers), ...creds]
  const respPairs = [['content-type', 'application/json'], ...creds]
  const rec = { ...SEED, req_headers: Object.fromEntries(reqPairs), resp: { ...SEED.resp, headers: Object.fromEntries(respPairs), ...extraResp },
    req_head_raw: head('POST /v1/messages HTTP/1.1', reqPairs), resp_head_raw: head('HTTP/1.1 200 OK', respPairs) }
  return { rec, reqPairs, respPairs }
}
const blanked = (v) => (Array.isArray(v) ? v.map(() => '') : '')
const without = (o, drop) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop(k)))
const SHAPED = new Set(['ctl', 'req_headers', 'resp', 'req_head_raw', 'resp_head_raw', 'req_body'])

function assertMasked(out, { rec, reqPairs, respPairs }, keep = null) {
  for (const [hdrs, src] of [[out.req_headers, rec.req_headers], [out.resp.headers, rec.resp.headers]]) {
    for (const [k, v] of Object.entries(src)) assert.deepEqual(hdrs[k], isSecret(k) && k.toLowerCase() !== keep ? blanked(v) : v, k)
    assert.deepEqual(Object.keys(hdrs), Object.keys(src))
  }
  assert.equal(out.req_head_raw, blankHead('POST /v1/messages HTTP/1.1', reqPairs, keep))
  assert.equal(out.resp_head_raw, blankHead('HTTP/1.1 200 OK', respPairs, keep))
  assert.deepEqual(out.ctl.masked, [...SECRET_HEADERS].filter((n) => n !== keep).sort())
}

test('A1: every credential-class value is blank in headers and raw heads, named in ctl.masked; all else as stored', () => {
  for (const caseOf of CASES) for (const shapeOf of SHAPES) {
    const b = build(caseOf, shapeOf)
    const out = controlRecordWire(b.rec)
    assertMasked(out, b)
    assert.equal(out.ctl.error, undefined)
    for (const k of Object.keys(b.rec)) if (!SHAPED.has(k)) assert.deepEqual(out[k], b.rec[k], k)
    assert.deepEqual(without(out.resp, (k) => k === 'headers'), without(b.rec.resp, (k) => k === 'headers'))
    assert.equal(b.rec.req_headers[caseOf('authorization')] !== '', true) // the input record is not touched
  }
  // the old capture placeholder is no credential: left as stored
  const old = controlRecordWire({ ...SEED, req_headers: { ...SEED.req_headers, authorization: '<redacted>' } })
  assert.equal(old.req_headers.authorization, '<redacted>')
  // a record the shaping chokes on (a JSON body JSON.stringify cannot write) still ships blank values beside ctl.error
  const b = build(CASES[1], SHAPES[0], { body: { n: 1n } })
  const bad = controlRecordWire(b.rec)
  assert.equal(typeof bad.ctl.error, 'string')
  assertMasked(bad, b)
})

test('A2: reveal returns that one value and keeps every other credential blank', () => {
  for (const caseOf of CASES) {
    const b = build(caseOf, SHAPES[0])
    const out = controlRecordWire(b.rec, { reveal: 'authorization' })
    assertMasked(out, b, 'authorization')
    assert.equal(out.req_headers[caseOf('authorization')], b.rec.req_headers[caseOf('authorization')])
    assert.equal(out.ctl.masked.includes('authorization'), false)
  }
})

test('A3: the board list and the server list are one set (2.6 #13)', () => {
  assert.deepEqual(new Set(CREDENTIAL_HEADERS), new Set(SECRET_HEADERS))
})
