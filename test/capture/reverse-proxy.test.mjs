import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createReverseProxy } from '../../src/capture/reverse-proxy.mjs'

const SSE_BODY = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"m","model":"claude-x","role":"assistant","usage":{"input_tokens":3,"cache_read_input_tokens":0,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}',
  '',
].join('\n')

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }

test('reverse-proxy: byte-transparent to client + faithful envelope + zero leak', async () => {
  // mock upstream returns an SSE stream verbatim
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(SSE_BODY)
  })
  const upPort = await listen(upstream)

  const envelopes = []
  const proxy = createReverseProxy({
    target: new URL(`http://127.0.0.1:${upPort}`),
    upstreamProxy: '',
    onEnvelope: (e) => envelopes.push(e),
  })
  const pxPort = await listen(proxy)

  const reqBody = JSON.stringify({ model: 'claude-x', system: 'S', messages: [{ role: 'user', content: 'hi' }] })
  const received = await new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: pxPort, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-ant-oat-SECRET' },
    }, (res) => {
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => resolve(buf))
    })
    r.on('error', reject)
    r.end(reqBody)
  })

  // transparency: the client receives the upstream entity body byte-for-byte
  assert.equal(received, SSE_BODY)

  // wait for the tee to finalize
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(envelopes.length, 1)
  const env = envelopes[0]
  assert.equal(env.capture, 'reverse-proxy')
  assert.equal(env.resp.kind, 'sse')
  assert.equal(env.resp.text, 'Hello world')
  assert.equal(env.resp.usage.output_tokens, 9) // terminal value
  assert.equal(typeof env.req_body, 'string') // D10: verbatim captured string (adapter parses it)
  assert.deepEqual(JSON.parse(env.req_body).messages, [{ role: 'user', content: 'hi' }]) // verbatim content survives
  // 2026-07-20 contract change: headers stored VERBATIM (spec 4.1 §采集安全, patched same commit).
  assert.notEqual(env.req_headers.authorization, '<redacted>',
    'redaction must be gone — the capture records what really went over the wire')
  // Inverted with the contract: the token IS in the envelope now, on purpose. Asserting its ABSENCE
  // was the old zero-leak check; asserting its PRESENCE is what byte-fidelity means here.
  assert.ok(JSON.stringify(env.req_headers).includes('SECRET'),
    'the credential must be stored verbatim — that is the whole point of removing redaction')

  proxy.close(); upstream.close()
})

test('interrupted upstream still writes an error:true envelope (turn stays visible)', async () => {
  const envelopes = []
  // point at a closed port -> ECONNREFUSED, no response ever arrives
  const proxy = createReverseProxy({ target: new URL('http://127.0.0.1:1'), upstreamProxy: '', onEnvelope: (e) => envelopes.push(e) })
  const pxPort = await new Promise((r) => { proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)) })

  const status = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: pxPort, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
    req.on('error', () => resolve('client-error'))
    req.end(JSON.stringify({ model: 'claude-x', messages: [] }))
  })

  await new Promise((r) => setTimeout(r, 50))
  assert.equal(status, 502) // client sees a failure ...
  assert.equal(envelopes.length, 1) // ... AND the failed turn is recorded, not invisible
  assert.equal(envelopes[0].error, true)
  assert.equal(envelopes[0].resp.kind, 'error')
  assert.equal(envelopes[0].capture, 'reverse-proxy')
  proxy.close()
})
