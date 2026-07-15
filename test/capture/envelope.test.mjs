import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildEnvelope, isoStamp, isLlmCall, HOP_BY_HOP, createEnvelopeWriter } from '../../src/capture/envelope.mjs'
import { ccAdapter } from '../../src/adapters/cc.mjs'

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

test('buildEnvelope emits EXACT canonical D10 field names', () => {
  const body = Buffer.from(JSON.stringify({ model: 'claude-x', system: 'you are', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }] }))
  const env = buildEnvelope({ ...baseArgs, reqBody: body, capture: 'reverse-proxy' })
  assert.deepEqual(Object.keys(env).sort(), [
    'auth_mode', 'capture', 'duration_ms', 'endpoint', 'id', 'is_llm_call',
    'method', 'req_body', 'req_headers', 'resp', 'ts', 'ts_request',
    'ts_response_end', 'ts_response_start',
  ])
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

test('non-llm req_body is labeled metadata, not verbatim', () => {
  const env = buildEnvelope({ ...baseArgs, endpoint: '/v1/messages/count_tokens', reqBody: Buffer.from('x'.repeat(42)), capture: 'mitm' })
  assert.equal(env.is_llm_call, false)
  assert.deepEqual(env.req_body, { raw_chars: 42, verbatim: false })
})

test('credentials never reach the envelope (zero-leak)', () => {
  const env = buildEnvelope({ ...baseArgs, reqBody: Buffer.from('{}'), capture: 'mitm' })
  assert.equal(env.req_headers.authorization, '<redacted>')
  assert.ok(!JSON.stringify(env).includes('SECRET'))
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
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asight-w-')), 'trace.ndjson')
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
