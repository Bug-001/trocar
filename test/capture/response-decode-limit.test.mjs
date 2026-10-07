// test/capture/response-decode-limit.test.mjs — RFC 4.1 §统一原始信封 `resp` (D40 audit finding 偷懒), the OLD capture's side of
// test/collector/core/response-bomb.test.mjs: a compressed RESPONSE is expanded to at most 1 MiB when the call is not inference and 64 MiB when
// it is — by both old paths (reverse proxy, MITM), for a plain body (decodeBodyChecked) and for an SSE stream (the streaming decoder). Past the
// limit the wire bytes are kept (raw_b64), the reply says why (encoding_error), one `decode-failed` line with Node's own code says it too, and
// the client gets every byte. Before this the decode had no limit: 713 KB of gzip became 700 MiB in the capture process.
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { LEGACY_PATHS } from '../helpers/legacy-paths.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { bodyResp } from '../../src/capture/response-tee.mjs'

const MiB = 1 << 20
const zeros = (mib) => zlib.gzipSync(Buffer.alloc(mib * MiB), { level: 9 })
// the upstream: /…?bomb=<MiB>&ct=<content-type> answers that many MiB of zeros, gzipped; /…?ok=1 answers a small gzip JSON
const upstream = (req, res) => {
  req.resume()
  req.on('end', () => {
    const q = new URL(req.url, 'http://x').searchParams
    if (q.has('bomb')) { const wire = zeros(Number(q.get('bomb'))); res.writeHead(200, { 'content-type': q.get('ct') || 'application/octet-stream', 'content-encoding': 'gzip', 'content-length': wire.length }); return res.end(wire) }
    const wire = zlib.gzipSync(JSON.stringify({ rows: 'x'.repeat(900 * 1024) }))
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': wire.length }); res.end(wire)
  })
}
const until = async (fn) => { for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)) }
const T = { timeout: 60_000 }

for (const start of LEGACY_PATHS) {
  test(`${start === LEGACY_PATHS[0] ? 'reverse proxy' : 'MITM'}: a non-inference reply that decodes past 1 MiB is not expanded — wire bytes kept, the reason said, one decode-failed line, the client gets every byte (D40 audit)`, T, async () => {
    const p = await start(upstream)
    try {
      const wire = zeros(40)
      const r = await p.send({ path: '/api/blob?bomb=40' })
      assert.ok(r.body.equals(wire), 'the client got the compressed body as sent')
      await until(() => p.envelopes.length); const env = p.envelopes[0]
      assert.match(env.resp.encoding_error, /^decoded size over 1048576 bytes for a call that is not inference; the wire bytes are in raw_b64$/)
      assert.ok(Buffer.from(env.resp.raw_b64, 'base64').equals(wire), 'the wire bytes, verbatim')
      assert.equal(env.resp.raw, undefined); assert.equal(env.resp.body, undefined)
      assert.equal(env.body_wire_bytes.resp, wire.length)
      assert.deepEqual(p.events.map((e) => e.code), ['ERR_BUFFER_TOO_LARGE'], 'Node\'s own code, once')
      for (const e of p.events) assert.deepEqual(checkRecord({ ts: 't', ...e }), [], JSON.stringify(e))
    } finally { p.stop() }
  })

  test(`${start === LEGACY_PATHS[0] ? 'reverse proxy' : 'MITM'}: an inference reply is expanded to 64 MiB at most (D40 audit)`, T, async () => {
    const p = await start(upstream)
    try {
      const wire = zeros(70)
      const r = await p.send({ path: '/v1/messages?bomb=70', headers: { 'content-type': 'application/json' }, body: '{"model":"m"}', method: 'POST' })
      assert.ok(r.body.equals(wire)); await until(() => p.envelopes.length); const env = p.envelopes[0]
      assert.equal(env.is_llm_call, true)
      assert.match(env.resp.encoding_error, /^decoded size over 67108864 bytes; the wire bytes are in raw_b64$/)
      assert.ok(Buffer.from(env.resp.raw_b64, 'base64').equals(wire))
    } finally { p.stop() }
  })

  test(`${start === LEGACY_PATHS[0] ? 'reverse proxy' : 'MITM'}: a compressed SSE stream past the limit is not expanded further — wire bytes kept, the reason said, the client unaffected (D40 audit)`, T, async () => {
    const p = await start(upstream)
    try {
      const wire = zeros(8)
      const r = await p.send({ path: '/api/events?bomb=8&ct=text/event-stream' })
      assert.ok(r.body.equals(wire), 'the client got the stream as sent')
      await until(() => p.envelopes.length); const env = p.envelopes[0]
      assert.equal(env.resp.kind, 'sse')
      assert.match(env.resp.encoding_error, /^decoded size over 1048576 bytes for a call that is not inference/)
      assert.ok(Buffer.from(env.resp.raw_b64, 'base64').equals(wire)); assert.equal(env.resp.raw, undefined, 'no decoded text of the stream beyond the limit')
      assert.deepEqual(p.events.map((e) => e.code), ['ERR_BUFFER_TOO_LARGE'])
      for (const e of p.events) assert.deepEqual(checkRecord({ ts: 't', ...e }), [], JSON.stringify(e))
    } finally { p.stop() }
  })

  test(`${start === LEGACY_PATHS[0] ? 'reverse proxy' : 'MITM'}: a reply that decodes within the limit is unchanged, with no event (D40 audit)`, T, async () => {
    const p = await start(upstream)
    try {
      await p.send({ path: '/api/list?ok=1' }); await until(() => p.envelopes.length)
      const env = p.envelopes[0]
      assert.equal(env.resp.encoding_error, undefined); assert.equal(env.resp.kind, 'json'); assert.equal(env.resp.body.rows.length, 900 * 1024); assert.deepEqual(p.events, [])
    } finally { p.stop() }
  })
}

test('bodyResp: the limit and the wording are per call kind; a body inside the limit is read as before', () => {
  const wire = zeros(2)
  const non = bodyResp(200, wire, 'gzip', null, { maxBytes: 1 * MiB, llm: false })
  assert.match(non.encoding_error, /over 1048576 bytes for a call that is not inference/); assert.ok(Buffer.from(non.raw_b64, 'base64').equals(wire))
  let told = null
  bodyResp(200, wire, 'gzip', (d) => { told = d }, { maxBytes: 1 * MiB, llm: false })
  assert.equal(told.code, 'ERR_BUFFER_TOO_LARGE'); assert.equal(told.over, true)
  assert.equal(bodyResp(200, wire, 'gzip').encoding_error, undefined, 'the default limit is the inference one')
  assert.deepEqual(bodyResp(200, zlib.gzipSync('{"a":1}'), 'gzip', null, { maxBytes: 1 * MiB, llm: false }).body, { a: 1 })
})
