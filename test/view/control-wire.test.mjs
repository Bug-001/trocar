// test/view/control-wire.test.mjs — a query document never carries a credential-class header's value (RFC 2.6 §保真边界 2 · #13,
// 4.1 §凭据处置): controlRecordWire blanks every credential-class header's value (isSecretHeader) in the header objects and the raw heads, names them in
// ctl.masked, and `reveal` returns exactly one. The record is a captured seed line (test/fixtures/old-capture-resp-shapes.ndjson).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { controlRecordWire } from '../../src/view/control-wire.mjs'
import { isSecretHeader } from '../../src/capture/redact.mjs'
import { isCredentialHeader } from '../../src/web/v2/core/sensitive.mjs'

const SEED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/old-capture-resp-shapes.ndjson'), 'utf8').split('\n')[0])
const CASES = [(n) => n, (n) => n.replace(/(^|-)([a-z])/g, (_, d, c) => d + c.toUpperCase()), (n) => n.toUpperCase()]
const SHAPES = [(v) => v, (v) => [v, `${v}-2`]]
// 4.1 §凭据处置 凭据类头: the four listed names plus set-cookie, or a name ending in a whole `api-key` word
const LISTED = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie']
const CREDS = [...LISTED, 'x-api-key', 'api-key', 'x-goog-api-key', 'x-foo-api-key']
const NOT_CREDS = ['apikey', 'x-api-keys', 'api-keyring', 'content-type', 'x-request-id', 'keep-alive', 'x-apikey', 'api-key-id']
const isSecret = (k) => CREDS.includes(k.trim().toLowerCase())
const head = (start, pairs) => [start, ...pairs.map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`)].join('\r\n') + '\r\n\r\n'
const blankHead = (start, pairs, keep) => [start, ...pairs.map(([k, v]) => (isSecret(k) && k.toLowerCase() !== keep ? `${k}: ` : `${k}: ${[].concat(v).join(', ')}`))].join('\r\n') + '\r\n\r\n'

// one record carrying every credential name in one case/shape, beside the seed's own headers
function build(caseOf, shapeOf, extraResp = {}) {
  const creds = CREDS.map((n, i) => [caseOf(n), shapeOf(`cred-value-${i}`)])
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
  assert.deepEqual(out.ctl.masked, [...CREDS].filter((n) => n !== keep).sort())
}

test('every credential-class value is blank in headers and raw heads, named in ctl.masked; all else as stored', () => {
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

test('reveal returns that one value and keeps every other credential blank', () => {
  for (const caseOf of CASES) {
    const b = build(caseOf, SHAPES[0])
    const out = controlRecordWire(b.rec, { reveal: 'authorization' })
    assertMasked(out, b, 'authorization')
    assert.equal(out.req_headers[caseOf('authorization')], b.rec.req_headers[caseOf('authorization')])
    assert.equal(out.ctl.masked.includes('authorization'), false)
  }
})

const WS = [(n) => n, (n) => ` ${n}`, (n) => `${n} `, (n) => `\t${n}\t`]

test('the board predicate and the server predicate agree on every name, case and surrounding whitespace (2.6 #13)', () => {
  for (const base of [...CREDS, 'X-Foo-Api-Key', ...NOT_CREDS]) for (const caseOf of CASES) for (const ws of WS) {
    const n = ws(caseOf(base.toLowerCase()))
    assert.equal(isSecretHeader(n), isCredentialHeader(n), JSON.stringify(n))
    assert.equal(isSecretHeader(n), CREDS.includes(base.toLowerCase()), JSON.stringify(n))
  }
})

// raw head shapes for one credential header: [the line(s) as sent, the header-object value]
const RAW_SHAPES = [
  (k, v) => [`${k}: ${v}\r\n`, v],
  (k, v) => [`${k} : ${v}\r\n`, v],
  (k, v) => [`${k}\t:\t${v}\r\n`, v],
  (k, v) => [`${k}  :${v}\r\n`, v],
  (k, v) => [`${k}: ${v}\r\n ${v}-fold-1\r\n`, `${v} ${v}-fold-1`],
  (k, v) => [`${k}: ${v}\r\n\t${v}-fold-1\r\n  ${v}-fold-2\r\n`, `${v} ${v}-fold-1 ${v}-fold-2`],
]
const SIDES = [
  { start: 'POST /v1/messages HTTP/1.1\r\n', raw: 'req_head_raw', put: (rec, h) => ({ ...rec, req_headers: { ...rec.req_headers, ...h } }) },
  { start: 'HTTP/1.1 200 OK\r\n', raw: 'resp_head_raw', put: (rec, h) => ({ ...rec, resp: { ...rec.resp, headers: { 'content-type': 'application/json', ...h } } }) },
]

test('every credential name, raw shape (whitespace before the colon, obs-fold) and side is blanked; other lines byte-identical; reveal keeps that one', () => {
  let i = 0
  for (const base of CREDS) for (const caseOf of CASES) for (const shape of RAW_SHAPES) for (const side of SIDES) {
    const secret = `cred-value-${i++}`, k = caseOf(base)
    const [credLines, objVal] = shape(k, secret)
    const raw = `${side.start}x-request-id: rid-${i}\r\n${credLines}content-type: application/json\r\n\r\n`
    const rec = { ...side.put(SEED, { [k]: objVal, 'x-request-id': `rid-${i}` }), [side.raw]: raw }
    const out = controlRecordWire(rec)
    assert.equal(JSON.stringify(out).includes(secret), false, raw)
    assert.ok(out.ctl.masked.includes(base), raw)
    const inLines = raw.split(/(?<=\n)/), outLines = out[side.raw].split(/(?<=\n)/)
    assert.equal(outLines.length, inLines.length, raw)
    assert.equal(outLines.at(-1), '\r\n')
    for (const [j, line] of inLines.entries()) {
      if (!line.includes(secret)) assert.equal(outLines[j], line, raw)
      else assert.ok(outLines[j].trim() !== '' || /^[ \t]/.test(outLines[j]), raw) // a blanked continuation keeps its fold whitespace
    }
    const shown = controlRecordWire(rec, { reveal: ` ${base.toUpperCase()} ` })
    assert.equal(shown[side.raw], raw)
    assert.ok(JSON.stringify(shown).includes(secret))
    assert.equal(shown.ctl?.masked?.includes(base) ?? false, false)
  }
})

// D-9 / 3.2 traffic_class: the class shown is the one the call was recorded under (the collector writes it, D60 ③), also a class the
// operator added; a record without one shows none, never a re-derived one
test('ctl.traffic_class is the record\'s own traffic_class, or null when it has none', () => {
  const { traffic_class: _drop, ...bare } = SEED
  for (const cls of ['my-sync', 'telemetry']) {
    assert.equal(controlRecordWire({ ...bare, traffic_class: cls, is_llm_call: false, endpoint: '/api/event_logging/v2/batch' }).ctl.traffic_class, cls)
  }
  assert.equal(controlRecordWire(bare).ctl.traffic_class, null)
})
