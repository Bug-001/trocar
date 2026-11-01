import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSseReconstructor } from '../../src/capture/sse-reconstruct.mjs'

const SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-x","role":"assistant","usage":{"input_tokens":10,"cache_read_input_tokens":5,"cache_creation_input_tokens":2,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather","input":{}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"SF\\"}"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":1}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n')

test('reconstructs text, tool_use input JSON, and terminal usage', () => {
  const r = makeSseReconstructor()
  // split mid-line to prove the pending-line buffer survives chunk boundaries
  const buf = Buffer.from(SSE, 'utf8')
  r.push(buf.subarray(0, 137))
  r.push(buf.subarray(137))
  const out = r.finish()
  assert.equal(out.text, 'Hello world')
  assert.equal(out.stop_reason, 'tool_use')
  assert.deepEqual(out.tool_calls, [{ id: 'tu_1', name: 'get_weather', input: { city: 'SF' } }])
  // message_delta output overrides message_start; input/cache come from message_start
  assert.equal(out.usage.output_tokens, 7)
  assert.equal(out.usage.input_tokens, 10)
  assert.equal(out.usage.cache_read_input_tokens, 5)
  assert.equal(out.usage.cache_creation_input_tokens, 2)
})

test('keepRaw retains the raw event log', () => {
  const r = makeSseReconstructor(true)
  r.push(Buffer.from(SSE, 'utf8'))
  const out = r.finish()
  assert.ok(Array.isArray(out.raw_sse))
  assert.equal(out.raw_sse[0].type, 'message_start')
})
