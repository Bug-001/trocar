// test/capture/non-llm-verbatim.test.mjs — D40 end to end through the old capture path that still has a runner (spec 4.1
// 验收 #3b / #3d / #3e / #3f / #7): what an agent does besides calling the model — a telemetry batch, a file upload, a
// non-LLM event stream — is stored verbatim, like an inference call; the bytes forwarded either way are unchanged; the
// cap and the log level say so in the envelope. The reverse proxy talks plain HTTP to a mock upstream. The MITM leg went
// with src/capture/mitm.mjs (D39⑥ executed 2026-10-11) — the same envelope contract, one surviving source.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { createReverseProxy } from '../../src/capture/reverse-proxy.mjs'
import { createRetention } from '../../src/capture/retention.mjs'
import { endpointClass } from '../../src/capture/envelope.mjs'
import { makeClassifier } from '../../src/dissect/traffic.mjs'
import { retentionFile } from '../../src/paths.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const listen = async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const SSE = 'event: ping\ndata: {"n":1}\n\ndata: plain text, no json\n\n: a comment line\nid: 7\ndata: 日本語 ✓\n\n'

// the mock upstream: records the exact bytes it received and answers by path
function mockUpstream(server) {
  const seen = []
  const handler = (req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ url: req.url, body })
      if (req.url.startsWith('/stream')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE); return }
      if (req.url.startsWith('/gzstream')) { res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' }); res.end(zlib.gzipSync(SSE)); return }
      if (req.url.startsWith('/big')) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'request-id': 'rid_big' }); res.end(Buffer.alloc(5000, 0x61)); return }
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'rid_1' }); res.end(JSON.stringify({ accepted: true, n: body.length }))
    })
  }
  return { seen, handler }
}

// A path under test: start(opts) → {send({method,path,headers,body}) → {status, headers, body}, envelopes, seen, stop()}
async function reverseProxyPath(opts = {}) {
  const up = mockUpstream(); const upstream = http.createServer(up.handler); const upPort = await listen(upstream)
  const envelopes = []
  const proxy = createReverseProxy({ target: new URL(`http://127.0.0.1:${upPort}`), onEnvelope: (e) => envelopes.push(e), ...opts })
  const px = await listen(proxy)
  const send = ({ method = 'POST', path: p, headers = {}, body }) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: px, method, path: p, headers }, (res) => { const cs = []; res.on('data', (c) => cs.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(cs) })) })
    r.on('error', reject); r.end(body)
  })
  return { send, envelopes, seen: up.seen, host: '127.0.0.1', capture: 'reverse-proxy', stop: () => { proxy.close(); upstream.close() } }
}
const PATHS = [['reverse proxy', reverseProxyPath]]
const settle = () => new Promise((r) => setTimeout(r, 60))

for (const [name, start] of PATHS) {
  test(`${name}: a non-LLM request body is stored verbatim — JSON, text, binary, gzip — and the bytes forwarded are the bytes sent (D40 · #3b #3d #7)`, async () => {
    const p = await start()
    try {
      const json = '{ "events" : [ {"name":"tengu_init", "n": 1.0} ] }'   // odd spacing: stored as sent
      const text = 'plain text — ünïcode ✓\nsecond line'
      const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80, 0x0d, 0x0a])
      const gz = zlib.gzipSync(json)
      const cases = [
        ['json', json, {}, { req_body: json }],
        ['text', text, {}, { req_body: text }],
        ['binary', bin, {}, { req_body: null, req_body_b64: bin.toString('base64') }],
        ['gzip', gz, { 'content-encoding': 'gzip' }, { req_body: json, req_body_b64: gz.toString('base64'), req_content_encoding: 'gzip' }],
      ]
      for (const [label, body, headers, want] of cases) {
        const r = await p.send({ path: `/api/event_logging/v2/batch?c=${label}`, headers: { authorization: 'Bearer sk-ant-oat-SECRET', ...headers }, body })
        assert.equal(r.status, 200, label)
        assert.deepEqual(JSON.parse(r.body.toString()), { accepted: true, n: Buffer.from(body).length }, 'the client got the upstream answer')
        assert.ok(p.seen.at(-1).body.equals(Buffer.from(body)), `${label}: the upstream received the bytes the client sent`)
        await settle()
        const env = p.envelopes.at(-1)
        for (const [k, v] of Object.entries(want)) assert.deepEqual(env[k], v, `${label} ${k}`)
        assert.equal('req_content_encoding' in env, label === 'gzip', `${label}: content-encoding only where the body was compressed`)
        assert.deepEqual([env.is_llm_call, env.host, env.capture, env.body_wire_bytes.req], [false, p.host, p.capture, Buffer.from(body).length], label)
        assert.match(env.req_headers.authorization, /^Bearer sk-ant/, 'headers verbatim')
      }
      // the same bytes sent to an inference endpoint take the same shape: only is_llm_call / traffic_class / endpoint / id / times differ
      const same = (e) => { const { id, ts, ts_request, ts_response_start, ts_response_end, duration_ms, endpoint, is_llm_call, traffic_class, resp, ...rest } = e; return rest }
      await p.send({ path: '/v1/messages', headers: { authorization: 'Bearer sk-ant-oat-SECRET' }, body: bin }); await settle()
      const llm = p.envelopes.at(-1); const plain = p.envelopes.find((e) => e.endpoint.includes('c=binary'))
      assert.deepEqual(same({ ...llm, req_headers: {} }), same({ ...plain, req_headers: {} }))
      assert.deepEqual([llm.traffic_class, plain.traffic_class], ['llm', 'other'])
    } finally { p.stop() }
  })

  test(`${name}: a non-LLM SSE response keeps its text in resp.raw, gzip decoded; the client gets the stream byte for byte (D40 · #3f)`, async () => {
    const p = await start()
    try {
      const plain = await p.send({ method: 'GET', path: '/stream/events' })
      assert.equal(plain.body.toString(), SSE); await settle()
      const env = p.envelopes.at(-1)
      assert.equal(env.resp.kind, 'sse'); assert.equal(env.resp.raw, SSE, 'comments, ids and non-JSON data lines survive: the reconstructor rebuilt nothing from this stream')
      assert.equal(env.is_llm_call, false); assert.equal(env.body_wire_bytes.resp, Buffer.byteLength(SSE))
      const gz = await p.send({ method: 'GET', path: '/gzstream/events' })
      assert.ok(gz.body.equals(zlib.gzipSync(SSE)) || zlib.gunzipSync(gz.body).toString() === SSE, 'the client got the compressed stream as sent'); await settle()
      const genv = p.envelopes.at(-1)
      assert.equal(genv.resp.raw, SSE, 'the stored text is the decoded stream'); assert.equal(genv.body_wire_bytes.resp, zlib.gzipSync(SSE).length, 'the wire length is the compressed length')
    } finally { p.stop() }
  })

  test(`${name}: past the 64 MiB cap (shrunk here) only the prefix is stored and labelled; the full length is counted; nothing forwarded is cut (D40 · #3f, invariant 4)`, async () => {
    const p = await start({ maxBodyBytes: 1000 })
    try {
      const body = Buffer.alloc(3000, 0x62)
      const r = await p.send({ path: '/big/up', headers: { 'content-type': 'application/octet-stream' }, body })
      assert.equal(r.body.length, 5000, 'the client got all of the response'); assert.equal(p.seen.at(-1).body.length, 3000, 'the upstream got all of the request'); await settle()
      const env = p.envelopes.at(-1)
      assert.deepEqual([env.req_truncated, env.req_body_bytes, env.req_body.length, env.body_wire_bytes], [true, 1000, 1000, { req: 3000, resp: 5000 }])
      assert.deepEqual([env.resp.truncated, env.resp.body_bytes, env.resp.raw.length], [true, 1000, 1000])
      // under the cap: neither label
      await p.send({ path: '/api/small', body: 'tiny' }); await settle()
      const small = p.envelopes.at(-1)
      for (const k of ['req_truncated', 'req_body_bytes']) assert.equal(k in small, false, k)
      assert.equal('truncated' in small.resp, false)
    } finally { p.stop() }
  })

  test(`${name}: at the log level the headers and sizes stay, no body does, and the envelope says so; the bytes forwarded are unchanged (D40 · #3e)`, async () => {
    const p = await start({ retention: ({ endpoint }) => ({ class: endpoint.includes('event_logging') ? 'telemetry' : 'llm', level: endpoint.includes('event_logging') ? 'log' : 'full' }) })
    try {
      const body = JSON.stringify({ events: ['a'.repeat(300)] })
      const r = await p.send({ path: '/api/event_logging/v2/batch', headers: { authorization: 'Bearer sk-ant-oat-SECRET', 'content-type': 'application/json' }, body })
      assert.deepEqual(JSON.parse(r.body.toString()), { accepted: true, n: body.length }); assert.equal(p.seen.at(-1).body.toString(), body); await settle()
      const env = p.envelopes.at(-1)
      assert.deepEqual(env.req_body, { raw_chars: body.length, verbatim: false })
      assert.equal(env.body_retention, 'log'); assert.equal(env.traffic_class, 'telemetry')
      assert.deepEqual(Object.keys(env.resp).sort(), ['headers', 'kind', 'raw_chars', 'request_id', 'status', 'verbatim'])
      assert.deepEqual([env.resp.status, env.resp.kind, env.resp.request_id, env.resp.verbatim, env.resp.headers['content-type']], [200, 'json', 'rid_1', false, 'application/json'])
      assert.equal(env.resp.raw_chars, JSON.stringify({ accepted: true, n: body.length }).length); assert.deepEqual(env.body_wire_bytes, { req: body.length, resp: env.resp.raw_chars })
      assert.match(env.req_headers.authorization, /^Bearer sk-ant/); assert.equal(JSON.stringify(env).includes('aaaaaaaaaa'), false, 'no byte of the body is in the envelope')
      // another class on the same path is still full
      await p.send({ path: '/v1/messages', body: '{"model":"m"}' }); await settle()
      const llm = p.envelopes.at(-1)
      assert.deepEqual([llm.req_body, 'body_retention' in llm, llm.traffic_class], ['{"model":"m"}', false, 'llm'])
    } finally { p.stop() }
  })
}

test('K2 end to end with the real settings file: cc · telemetry = log applies to the calls that start after the edit, one second at most (D40 · K2 / K3)', async () => {
  const home = tmpDir('asight-k2-'); const file = retentionFile(home)
  let t = 10_000_000
  // the cc telemetry pattern is host-keyed (api.anthropic.com, src/dissect/harnesses.mjs) — a host the MITM leg produced and the
  // reverse proxy (upstream 127.0.0.1) does not; the class is named at the seam so the cell stays about what it tests: the hot reload
  const classify = ({ host, endpoint }) => (endpoint.startsWith('/api/event_logging') ? 'telemetry' : makeClassifier({ endpointClass })({ harness: 'cc', host, endpoint }))
  const keep = createRetention({ file, now: () => t, classify })
  const p = await reverseProxyPath({ retention: ({ host, method, endpoint }) => keep.decide({ harness: 'cc', host, method, endpoint }) })
  try {
    const call = async () => { await p.send({ path: '/api/event_logging/v2/batch', body: '{"e":1}' }); await settle(); return p.envelopes.at(-1) }
    const before = await call()
    assert.deepEqual([before.traffic_class, before.req_body, 'body_retention' in before], ['telemetry', '{"e":1}', false], 'the default is full')
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ version: 1, levels: { cc: { telemetry: 'log' } } }))
    t += 1100
    const after = await call()
    assert.deepEqual([after.body_retention, after.req_body], ['log', { raw_chars: 7, verbatim: false }])
    await p.send({ path: '/v1/messages', body: '{"model":"m"}' }); await settle()
    assert.equal(p.envelopes.at(-1).req_body, '{"model":"m"}', 'another class keeps its body')
  } finally { p.stop() }
})
