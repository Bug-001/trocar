import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildEnvelope, isoStamp, isLlmCall, endpointClass, logResponse, HOP_BY_HOP, createEnvelopeWriter } from '../../src/capture/envelope.mjs'
import { ccAdapter } from '../../src/adapters/cc.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const baseArgs = {
  id: 'req_00001',
  tsRequest: '2026-07-15T00:00:00.000Z',
  tsRespStart: '2026-07-15T00:00:01.000Z',
  tsRespEnd: '2026-07-15T00:00:02.000Z',
  durationMs: 2000,
  method: 'POST',
  endpoint: '/v1/messages',
  reqHeaders: { authorization: 'Bearer sk-ant-oat-SECRET', 'anthropic-version': '2023-06-01' },
  resp: { status: 200, kind: 'json', body: { ok: true }, request_id: 'rid_1' },
}

test('isLlmCall: /v1/messages is llm, count_tokens/telemetry are not', () => {
  assert.equal(isLlmCall('/v1/messages'), true)
  assert.equal(isLlmCall('/v1/messages?beta=true'), true)
  assert.equal(isLlmCall('/v1/messages/count_tokens'), false)
  assert.equal(isLlmCall('/v1/organizations/x/telemetry'), false)
})

test('isLlmCall: relay-prefixed and Gemini inference paths count, count_tokens does not', async () => {
  const { isLlmCall } = await import('../../src/capture/envelope.mjs')
  for (const p of ['/anthropic/v1/messages', '/api/anthropic/v1/messages?beta=true', '/api/paas/v4/chat/completions', '/codex/responses', '/v1beta/models/gemini-x:streamGenerateContent?alt=sse'])
    assert.equal(isLlmCall(p), true, p)
  for (const p of ['/v1/messages/count_tokens', '/v1/models', '/api/event_logging/v2/batch']) assert.equal(isLlmCall(p), false, p)
})

test('endpointClass tells llm and token-count by the endpoint alone; every other class is the read side\'s to tell (D40)', () => {
  assert.equal(endpointClass('/v1/messages'), 'llm'); assert.equal(endpointClass('/anthropic/v1/messages?beta=true'), 'llm')
  assert.equal(endpointClass('/v1/messages/count_tokens'), 'token-count')
  assert.equal(endpointClass('/api/event_logging/v2/batch'), null)
})

test('buildEnvelope emits EXACT canonical D10 field names', () => {
  const body = Buffer.from(JSON.stringify({ model: 'claude-x', system: 'you are', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }] }))
  const env = buildEnvelope({ ...baseArgs, reqBody: body, capture: 'reverse-proxy' })
  assert.deepEqual(Object.keys(env).sort(), [
    'auth_mode', 'body_wire_bytes', 'capture', 'duration_ms', 'endpoint', 'id', 'is_llm_call',
    'method', 'req_body', 'req_headers', 'resp', 'traffic_class', 'ts', 'ts_request',
    'ts_response_end', 'ts_response_start',
  ])  // D40: traffic_class + body_wire_bytes on every envelope; host / body_retention / b64 only when there is something to say
  assert.equal(env.ts, env.ts_request) // core.ts mirrors request start
  assert.equal(env.is_llm_call, true)
  assert.equal(env.capture, 'reverse-proxy')
  assert.equal(env.auth_mode, 'oauth')
})

test('req_body is the VERBATIM captured STRING for llm calls (adapter slices byte spans; no re-serialization)', () => {
  // deliberately non-canonical wire spacing — must survive byte-for-byte
  const raw = '{ "model":"claude-x" , "system":"S","messages":[{"role":"user","content":"hi"}],"tools":[{"name":"t","description":"FULL","input_schema":{"type":"object","properties":{"a":{}}}}]}'
  const env = buildEnvelope({ ...baseArgs, reqBody: Buffer.from(raw), capture: 'mitm' })
  assert.equal(typeof env.req_body, 'string') // NOT a parsed object — the adapter needs the string
  assert.equal(env.req_body, raw) // byte-exact incl the odd spacing (D19 depends on this)
  assert.notEqual(env.req_body, JSON.stringify(JSON.parse(raw))) // a re-serialize would have differed
  assert.match(env.req_body, /"description":"FULL"/) // D15 tools verbatim, in the string
})

test('capture→adapter seam: a built envelope feeds parseBlocks and rebuilds byte-exact (AC-1 across the seam)', () => {
  const raw = '{"model":"claude-opus-4-8","system":[{"type":"text","text":"You are Claude Code"}],"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],"tools":[{"name":"Read","description":"Read a file","input_schema":{"type":"object"}}]}'
  const env = buildEnvelope({ ...baseArgs, reqHeaders: { 'x-claude-code-session-id': 's1' }, reqBody: Buffer.from(raw), capture: 'mitm' })
  assert.equal(ccAdapter.detect(env), true) // the CC adapter claims the captured record
  const blocks = ccAdapter.parseBlocks(env) // the seam: adapter consumes the envelope's req_body STRING
  assert.ok(blocks.length >= 3)
  for (const b of blocks) assert.equal(b.text, raw.slice(b.text_ref[0], b.text_ref[1])) // verbatim 回源, byte-diff 0
  const toolBlk = blocks.find((b) => b.section === 'tools')
  assert.equal(toolBlk.text, '{"name":"Read","description":"Read a file","input_schema":{"type":"object"}}')
})

// D40 FLIPPED THIS GUARD (it asserted "non-llm req_body is labeled metadata, not verbatim", i.e. {raw_chars}). The user
// decided on 2026-10-07 that non-LLM traffic is not an exception: a telemetry batch, a session worker event, a
// count_tokens context and a file upload are what an agent harness does BESIDES calling the model, which is exactly
// what is worth reading. Spec 4.1 验收 #3b. The old shape is still READ (read side labels it 「本条采于 D40 之前」).
test('a non-llm request body is stored verbatim, like an llm one (D40 · 4.1 #3b)', () => {
  const wire = '{ "events" : [ {"name":"tengu_init"} ] }' // odd spacing on purpose: stored as sent, not re-serialized
  for (const endpoint of ['/v1/messages/count_tokens', '/api/event_logging/v2/batch', '/v1/code/sessions/cse_1/worker/events']) {
    const env = buildEnvelope({ ...baseArgs, endpoint, reqBody: Buffer.from(wire), capture: 'mitm' })
    assert.equal(env.is_llm_call, false, endpoint)
    assert.equal(env.req_body, wire, endpoint)
    assert.equal('req_body_b64' in env, false)
    assert.deepEqual(env.body_wire_bytes, { req: Buffer.byteLength(wire), resp: null })
  }
  // the SAME bytes sent to an llm endpoint take the same shape: only is_llm_call / traffic_class differ
  const a = buildEnvelope({ ...baseArgs, endpoint: '/v1/messages', reqBody: Buffer.from(wire), capture: 'mitm' })
  const b = buildEnvelope({ ...baseArgs, endpoint: '/api/event_logging/v2/batch', reqBody: Buffer.from(wire), capture: 'mitm' })
  for (const k of ['is_llm_call', 'traffic_class', 'endpoint']) { delete a[k]; delete b[k] }
  assert.deepEqual(a, b)
  // no body (a GET) is the empty string, as it is for an llm call, never {raw_chars: 0}
  assert.equal(buildEnvelope({ ...baseArgs, method: 'GET', endpoint: '/api/web/domain_info', reqBody: Buffer.alloc(0), capture: 'mitm' }).req_body, '')
})

test('a request body that is not UTF-8 is req_body:null + req_body_b64 = the wire bytes, with no content-encoding (D40 · 4.1 #3d)', () => {
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]) // not UTF-8
  for (const endpoint of ['/api/oauth/file_upload', '/v1/messages']) {
    const env = buildEnvelope({ ...baseArgs, endpoint, reqBody: bin, capture: 'reverse-proxy' })
    assert.equal(env.req_body, null, endpoint)
    assert.equal(env.req_body_b64, bin.toString('base64'), endpoint)
    assert.equal('req_content_encoding' in env, false, 'the missing content-encoding is what tells this apart from a compressed body')
    assert.equal('req_encoding_error' in env, false)
  }
  // a BOM is bytes, not text: kept
  const bom = Buffer.from('\ufeff{"a":1}', 'utf8')
  assert.equal(buildEnvelope({ ...baseArgs, endpoint: '/x', reqBody: bom, capture: 'mitm' }).req_body, '\ufeff{"a":1}')
})

test('a compressed request body is handled the same on every endpoint: wire bytes kept, gzip decoded, zstd never (D40 · T16)', async () => {
  const zlib = (await import('node:zlib')).default
  const text = '{"events":[1,2,3]}'
  const gz = zlib.gzipSync(text)
  for (const endpoint of ['/v1/messages', '/api/event_logging/v2/batch']) {
    const env = buildEnvelope({ ...baseArgs, endpoint, reqHeaders: { 'content-encoding': 'gzip' }, reqBody: gz, capture: 'mitm' })
    assert.deepEqual([env.req_body, env.req_body_b64, env.req_content_encoding, 'req_encoding_error' in env], [text, gz.toString('base64'), 'gzip', false], endpoint)
    assert.deepEqual(env.body_wire_bytes.req, gz.length, 'the wire length is the compressed length')
  }
  const calls = []; const zs = zlib.zstdDecompressSync; if (zs) zlib.zstdDecompressSync = (...a) => { calls.push(a); return zs(...a) } // a spy: zstd is never decoded at capture
  try {
    const z = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00])
    const env = buildEnvelope({ ...baseArgs, endpoint: '/api/event_logging/v2/batch', reqHeaders: { 'Content-Encoding': 'zstd' }, reqBody: z, capture: 'mitm' })
    assert.deepEqual([env.req_body, env.req_body_b64, env.req_content_encoding], [null, z.toString('base64'), 'zstd'])
    assert.match(env.req_encoding_error, /zstd/)
    assert.equal(calls.length, 0)
  } finally { if (zs) zlib.zstdDecompressSync = zs }
  // a body that claims gzip and is not: kept as wire bytes, labelled; decoded-but-not-UTF-8 likewise
  const bad = buildEnvelope({ ...baseArgs, endpoint: '/x', reqHeaders: { 'content-encoding': 'gzip' }, reqBody: Buffer.from('nope'), capture: 'mitm' })
  assert.equal(bad.req_body, null); assert.ok(bad.req_encoding_error); assert.equal(bad.req_body_b64, Buffer.from('nope').toString('base64'))
  const notText = buildEnvelope({ ...baseArgs, endpoint: '/x', reqHeaders: { 'content-encoding': 'gzip' }, reqBody: zlib.gzipSync(Buffer.from([0xff, 0xfe])), capture: 'mitm' })
  assert.equal(notText.req_body, null); assert.equal(notText.req_encoding_error, 'decoded body is not UTF-8')
})

test('a body cut at the cap or never finished is not decoded and says why; the wire length is still exact (D40 · invariant 4)', async () => {
  const zlib = (await import('node:zlib')).default
  const gz = zlib.gzipSync('x'.repeat(100)).subarray(0, 12)
  const cut = buildEnvelope({ ...baseArgs, endpoint: '/api/x', reqHeaders: { 'content-encoding': 'gzip' }, reqBody: gz, reqTruncated: true, reqWireBytes: 5000, capture: 'mitm' })
  assert.deepEqual([cut.req_body, cut.req_body_b64, cut.req_truncated, cut.req_body_bytes, cut.body_wire_bytes.req, 'req_encoding_error' in cut], [null, gz.toString('base64'), true, 12, 5000, false])
  const text = buildEnvelope({ ...baseArgs, endpoint: '/api/x', reqBody: Buffer.from('{"a":'), reqPartial: 'aborted', capture: 'mitm' })
  assert.deepEqual([text.req_body, text.req_partial, 'req_truncated' in text], ['{"a":', 'aborted', false])
  // a UTF-8 character cut in half by the cap is bytes, not text: never a lossy U+FFFD
  const half = Buffer.from('ab€', 'utf8').subarray(0, 4)
  const env = buildEnvelope({ ...baseArgs, endpoint: '/api/x', reqBody: half, reqTruncated: true, reqWireBytes: 99, capture: 'mitm' })
  assert.deepEqual([env.req_body, env.req_body_b64], [null, half.toString('base64')])
})

test('the log level keeps the headers and the size, not the body, and says so in place (D40 · 4.1 #3e, invariant 4)', () => {
  const env = buildEnvelope({ ...baseArgs, endpoint: '/api/event_logging/v2/batch', reqBody: null, reqWireBytes: 4321, retention: 'log', trafficClass: 'telemetry',
    resp: logResponse({ status: 200, headers: { 'Content-Type': 'application/json', 'request-id': 'rid_9' }, wireBytes: 17 }), capture: 'mitm', host: 'api.anthropic.com' })
  assert.deepEqual(env.req_body, { raw_chars: 4321, verbatim: false })
  assert.deepEqual(env.resp, { status: 200, kind: 'json', headers: { 'content-type': 'application/json', 'request-id': 'rid_9' }, request_id: 'rid_9', raw_chars: 17, verbatim: false })
  assert.deepEqual([env.body_retention, env.traffic_class, env.host, env.body_wire_bytes], ['log', 'telemetry', 'api.anthropic.com', { req: 4321, resp: null }])
  assert.equal(env.req_headers.authorization, baseArgs.reqHeaders.authorization, 'the headers are the main behaviour signal: kept verbatim')
  assert.equal(logResponse({ status: 204, wireBytes: 0 }).kind, 'empty'); assert.equal(logResponse({ status: 200, headers: { 'content-type': 'text/event-stream' }, wireBytes: 5 }).kind, 'sse')
  assert.equal('body_retention' in buildEnvelope({ ...baseArgs, reqBody: Buffer.from('{}'), capture: 'mitm' }), false, 'a full-level envelope carries no body_retention')
})

test('D40 field order: everything new follows req_body, so the sharder still finds the session headers first', () => {
  const env = buildEnvelope({ ...baseArgs, reqBody: Buffer.from('{}'), host: 'h.test', trafficClass: 'llm', capture: 'mitm' })
  const keys = Object.keys(env)
  for (const k of ['host', 'traffic_class', 'body_wire_bytes']) assert.ok(keys.indexOf(k) > keys.indexOf('req_body'), k)
  assert.ok(JSON.stringify(env).indexOf('"req_headers":{') < JSON.stringify(env).indexOf('"req_body"'))
})

// CONTRACT CHANGE, not a relaxation (2026-07-20 · spec 4.1 §采集安全 patched in the
// same commit). This asserted the opposite — that Authorization arrived as `<redacted>`. asight
// exists to show what really went over the wire, and rewriting a header made the capture
// non-verbatim at exactly the layer whose thesis is byte-fidelity. The protection MOVED to file
// permissions: these bytes hold live credentials, so the writer creates 0600 and `asight doctor` ④b
// hard-fails on anything looser (test/capture/verbatim-headers.test.mjs).
test('credential headers are stored VERBATIM (they are what went over the wire)', () => {
  const env = buildEnvelope({ ...baseArgs, reqBody: Buffer.from('{}'), capture: 'mitm' })
  assert.equal(env.req_headers.authorization, baseArgs.reqHeaders.authorization,
    'the Authorization header must survive byte-for-byte')
  assert.doesNotMatch(JSON.stringify(env.req_headers), /<redacted>/,
    'a `<redacted>` sentinel survives — a half-removed firewall leaves some captures verbatim and '
    + 'some not, with nothing saying which')
  assert.equal(env.auth_mode, 'oauth', 'the derived auth_mode label still works off real headers')
})

test('interrupted turn produces an error:true envelope with resp.kind=error', () => {
  const env = buildEnvelope({
    ...baseArgs, tsRespStart: null, reqBody: Buffer.from('{}'), capture: 'mitm', error: true,
    resp: { status: null, kind: 'error', error: { type: 'ECONNRESET', message: 'boom' } },
  })
  assert.equal(env.error, true)
  assert.equal(env.resp.kind, 'error')
  assert.equal(env.ts_response_start, null)
})

test('envelope PARITY: same interaction via two sources differs ONLY in capture', () => {
  const body = Buffer.from(JSON.stringify({ model: 'claude-x', messages: [] }))
  const a = buildEnvelope({ ...baseArgs, reqBody: body, capture: 'reverse-proxy' })
  const b = buildEnvelope({ ...baseArgs, reqBody: body, capture: 'mitm' })
  delete a.capture; delete b.capture
  assert.deepEqual(a, b) // RFC 4.1 §验收1: adapter seam does not leak at the capture end
})

test('createEnvelopeWriter appends one flat NDJSON line per envelope (D20, no per-session split)', () => {
  const f = path.join(tmpDir('asight-w-'), 'trace.ndjson')
  const w = createEnvelopeWriter(f)
  w.write(buildEnvelope({ ...baseArgs, reqBody: Buffer.from('{}'), capture: 'mitm' }))
  w.write(buildEnvelope({ ...baseArgs, id: 'req_00002', reqBody: Buffer.from('{}'), capture: 'mitm' }))
  w.close()
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).id, 'req_00001')
  assert.equal(JSON.parse(lines[1]).id, 'req_00002')
})

test('HOP_BY_HOP contains the relay-managed headers', () => {
  for (const h of ['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization']) {
    assert.ok(HOP_BY_HOP.has(h))
  }
})

// review (H2): the decoded copy of a compressed request body is bounded for a call that is not inference — 204 KB of gzip used to become
// a 200 MiB req_body (and an escape-heavy one pushed the NDJSON line past V8's string limit: the call was not captured at all). The wire
// bytes are the verbatim record either way; over the limit they stay as stored and the call says so.
test('a compressed body that decodes past 1 MiB on a call that is not inference keeps its wire bytes and says so; inference keeps its higher limit', async () => {
  const zlib = (await import('node:zlib')).default
  const { NON_INFERENCE_MAX_DECODED_BYTES } = await import('../../src/capture/request-body.mjs')
  const bomb = zlib.gzipSync(Buffer.alloc(3 * 1024 * 1024, 0x61)) // 3 MiB of 'a' in ~3 KB
  assert.ok(bomb.length < 10 * 1024, 'a small body on the wire')
  const nonLlm = buildEnvelope({ ...baseArgs, endpoint: '/api/event_logging/v2/batch', reqHeaders: { 'content-encoding': 'gzip' }, reqBody: bomb, capture: 'mitm' })
  assert.deepEqual([nonLlm.req_body, nonLlm.req_body_b64, nonLlm.req_content_encoding, nonLlm.body_wire_bytes.req], [null, bomb.toString('base64'), 'gzip', bomb.length])
  assert.match(nonLlm.req_encoding_error, new RegExp(`over the ${NON_INFERENCE_MAX_DECODED_BYTES}-byte capture limit for a call that is not inference`))
  assert.ok(JSON.stringify(nonLlm).length < 50 * 1024, 'the record stays small')
  // the same shape is labelled for the reader and the board (invariant 4): not an empty or a verbatim-text body
  const { captureLabelsOf } = await import('../../src/dissect/capture-labels.mjs')
  assert.deepEqual(captureLabelsOf(nonLlm).map((l) => l.id), ['req-undecoded'])
  // under the limit a non-inference body is decoded as before; an inference body of the same size decodes (its limit is 256 MiB)
  const small = zlib.gzipSync(Buffer.alloc(512 * 1024, 0x62))
  assert.equal(buildEnvelope({ ...baseArgs, endpoint: '/api/event_logging/v2/batch', reqHeaders: { 'content-encoding': 'gzip' }, reqBody: small, capture: 'mitm' }).req_body.length, 512 * 1024)
  const llm = buildEnvelope({ ...baseArgs, endpoint: '/v1/messages', reqHeaders: { 'content-encoding': 'gzip' }, reqBody: bomb, capture: 'mitm' })
  assert.deepEqual([llm.req_body.length, 'req_encoding_error' in llm], [3 * 1024 * 1024, false])
})
