// retention-engine.test.mjs — D40 through the REAL engine path (handleFlow + the exchange tee + a real TLS leaf and upstream):
// what the collector stores of a call that is NOT an inference call, and what the retention level does to it. The unit
// halves are in exchange.test.mjs (sampling, wire counts, the cap), record.test.mjs and ws-recorder.test.mjs; this file proves
// the wiring: handleFlow hands ctx.retention to the tee, the bytes forwarded are untouched, and the envelope that lands is
// the shape the old capture path that survives writes for the same call (4.1 #3d, 4.6 T16 / W16 / K2).
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'; import tls from 'node:tls'
import zlib from 'node:zlib'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { handleFlow } from '../../../src/collector/core/engine/flow.mjs'
import { createNegativeCache } from '../../../src/collector/core/engine/negcache.mjs'

const upCa = createCa({ commonName: 'upstream test CA' }); const upIssuer = createLeafIssuer(loadCa(upCa))
const trocarCa = createCa(); const issuer = createLeafIssuer(loadCa(trocarCa))
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
const within = (p, what, ms = 8000) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: not within ${ms}ms`)), ms) })]).finally(() => clearTimeout(t)) }

// one connection per call: the upstream records the bytes it was sent and answers with `respond(req)`
async function rig({ retention, respond }) {
  const sent = []
  const upstream = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)), ALPNProtocols: ['http/1.1'] }, (s) => {
    let got = Buffer.alloc(0)
    s.on('data', (d) => { got = Buffer.concat([got, d]); const i = got.indexOf('\r\n\r\n'); if (i < 0) return
      const m = /content-length: (\d+)/i.exec(got.subarray(0, i).toString('latin1')); const need = i + 4 + (m ? Number(m[1]) : 0)
      if (got.length >= need) { sent.push(got); s.end(respond(got)) } })
  })
  const upPort = await listen(upstream)
  const envelopes = [], flows = [], failures = []
  const ctx = { issuer, upstreamCa: upCa.certPem, policy: () => true, isRecording: () => true, retention, negCache: createNegativeCache(), newFlowId: () => 'f' + flows.length,
    counters: { notCaptured: { h2: 0, httpsProxy: 0, upstreamCert: 0, negative: 0, leafError: 0 } }, failure: (r) => failures.push(r),
    store: { envelope: (e) => envelopes.push(structuredClone(e)), flow: (f) => flows.push(structuredClone(f)) }, connectUpstream: (dst) => net.connect(dst.port, dst.address) }
  const done = []
  const engine = net.createServer((c) => { done.push(handleFlow(c, { dst: { address: '127.0.0.1', port: upPort, family: 4 }, pid: 7, agent: 'claude-code', decrypt: true }, ctx)) })
  const port = await listen(engine)
  const call = (raw) => new Promise((resolve, reject) => {
    const c = tls.connect({ port, host: '127.0.0.1', servername: 'telemetry.example.test', ca: trocarCa.certPem, ALPNProtocols: ['http/1.1'] }, () => c.write(raw))
    let got = Buffer.alloc(0); c.on('data', (d) => (got = Buffer.concat([got, d]))); c.on('end', () => resolve(got)); c.on('error', reject)
  })
  return { call, sent, envelopes, failures, close: async () => { await within(Promise.all(done), 'every flow finalized'); engine.close(); upstream.close() } }
}
const req = (path, body, headers = '') => { const b = Buffer.from(body); return Buffer.concat([Buffer.from(`POST ${path} HTTP/1.1\r\nHost: telemetry.example.test\r\n${headers}Content-Length: ${b.length}\r\nConnection: close\r\n\r\n`), b]) }
const JSON_RESP = '{"accepted":true}'
const resp200 = () => `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nRequest-Id: rid_7\r\nContent-Length: ${JSON_RESP.length}\r\nConnection: close\r\n\r\n${JSON_RESP}`

test('T16 / 4.1 #3d through the engine: a non-LLM endpoint keeps JSON, text, binary and gzip request bodies verbatim, the same shape an inference endpoint gets, and no forwarded byte changes', async () => {
  const h = await rig({ respond: resp200 })
  const json = '{ "events" : [ {"name":"x"} ] }', text = 'plain — ünïcode ✓', bin = Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00, 0x80]), gz = zlib.gzipSync(json)
  const cases = [[json, ''], [text, ''], [bin, ''], [gz, 'Content-Encoding: gzip\r\n']]
  for (const [body, hdr] of cases) { const raw = req('/api/event_logging/v2/batch', body, hdr); const got = await h.call(raw); assert.ok(h.sent.at(-1).equals(raw), 'the upstream got exactly the bytes the client sent'); assert.match(got.toString('latin1'), /accepted/) }
  const bodyOf = (e) => ({ req_body: e.req_body, ...(e.req_body_b64 !== undefined ? { b64: e.req_body_b64 } : {}), ...(e.req_content_encoding !== undefined ? { enc: e.req_content_encoding } : {}) })
  await h.close()
  assert.deepEqual(h.envelopes.map(bodyOf), [{ req_body: json }, { req_body: text }, { req_body: null, b64: bin.toString('base64') }, { req_body: json, b64: gz.toString('base64'), enc: 'gzip' }])
  assert.ok(h.envelopes.every((e) => e.is_llm_call === false && e.host === 'telemetry.example.test'), 'host = the SNI, beside the verbatim Host header')
  assert.deepEqual(h.envelopes.map((e) => e.body_wire_bytes.req), [json, text, bin, gz].map((b) => Buffer.byteLength(b)))
  assert.equal(h.failures.length, 0)
})

test('K2 through the engine: the class and level the daemon\'s callback names are sampled at request start; log keeps headers and sizes only; the other class stays full', async () => {
  const asked = []
  const h = await rig({ respond: resp200, retention: (proc, host, method, path) => { asked.push([proc.agent, host, method, path]); return path.startsWith('/api/event_logging') ? { class: 'telemetry', level: 'log' } : { class: 'other', level: 'full' } } })
  const body = JSON.stringify({ events: ['a'.repeat(200)] })
  const tel = req('/api/event_logging/v2/batch', body, 'Authorization: Bearer sk-ant-oat-SECRET\r\n')
  const got = await h.call(tel)
  assert.ok(h.sent.at(-1).equals(tel), 'the upstream got exactly the request, at the log level too'); assert.match(got.toString('latin1'), /rid_7/)
  await h.call(req('/v1/other', '{"keep":1}'))
  await h.close()
  assert.deepEqual(asked, [['claude-code', 'telemetry.example.test', 'POST', '/api/event_logging/v2/batch'], ['claude-code', 'telemetry.example.test', 'POST', '/v1/other']])
  const [a, b] = h.envelopes
  assert.deepEqual([a.body_retention, a.traffic_class, a.req_body, a.resp.raw_chars, a.resp.kind, a.resp.request_id], ['log', 'telemetry', { raw_chars: body.length, verbatim: false }, JSON_RESP.length, 'json', 'rid_7'])
  assert.deepEqual([a.req_headers.authorization, a.body_wire_bytes], ['Bearer sk-ant-oat-SECRET', { req: body.length, resp: JSON_RESP.length }])
  assert.doesNotMatch(JSON.stringify(a), /aaaaaaaaaaaa|accepted/)
  assert.deepEqual([b.req_body, 'body_retention' in b, b.traffic_class, b.resp.body], ['{"keep":1}', false, 'other', { accepted: true }])
})

// K2 parity with the old MITM went with src/capture/mitm.mjs (D39⑥ executed 2026-10-11): the second leg of the
// comparison is gone, and the collector's own shape is what the cells above pin. The parity that still matters — the old
// capture path that survives writes the same envelope contract — is test/capture/non-llm-verbatim.test.mjs.
