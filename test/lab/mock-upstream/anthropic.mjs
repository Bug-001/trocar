// anthropic.mjs — Anthropic Messages dialect: read the last user turn, answer as JSON or as the SSE
// event sequence the official SDKs parse (message_start … message_stop).
import { randomBytes } from 'node:crypto'
import { plan } from './scenarios.mjs'
import { jsonReply } from './transport.mjs'

const rid = (p) => `${p}${randomBytes(12).toString('hex')}`

export function seen(body) {
  const last = (body.messages || []).findLast((m) => m.role === 'user')
  if (!last) return { kind: 'text', text: '' }
  if (typeof last.content === 'string') return { kind: 'text', text: last.content }
  const blocks = Array.isArray(last.content) ? last.content : []
  const tr = blocks.findLast((b) => b.type === 'tool_result')
  if (tr) return { kind: 'tool_result', text: typeof tr.content === 'string' ? tr.content : (tr.content || []).map((c) => c.text || '').join('') }
  return { kind: 'text', text: blocks.findLast((b) => b.type === 'text')?.text || '' }
}

export function reply(body, raw) {
  const p = plan(seen(body), raw, body.model)
  const id = rid('msg_mock_'), headers = { 'request-id': rid('req_mock_') }
  const usage = { input_tokens: p.inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: p.outputTokens }
  const blocks = [{ start: { type: 'text', text: '' }, deltas: p.parts.map((text) => ({ type: 'text_delta', text })), final: { type: 'text', text: p.text } }]
  const message = { id, type: 'message', role: 'assistant', model: p.model, content: blocks.map((b) => b.final), stop_reason: 'end_turn', stop_sequence: null, usage }
  if (!body.stream) return jsonReply(200, message, headers)

  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const pieces = [ev('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } })]
  blocks.forEach((b, index) => {
    pieces.push(ev('content_block_start', { index, content_block: b.start }))
    if (index === 0) pieces.push(ev('ping', {}))
    for (const delta of b.deltas) pieces.push(ev('content_block_delta', { index, delta }))
    pieces.push(ev('content_block_stop', { index }))
  })
  pieces.push(ev('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage }), ev('message_stop', {}))
  return {
    status: 200, pieces, firstDelta: pieces.findIndex((s) => s.startsWith('event: content_block_delta')),
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', ...headers },
  }
}

// Status → Anthropic error type, per the documented error table.
const ERROR_TYPES = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 500: 'api_error', 504: 'timeout_error', 529: 'overloaded_error' }

export function errorReply(status, message = `mock-upstream: scripted ${status}`) {
  const type = ERROR_TYPES[status] || (status < 500 ? 'invalid_request_error' : 'api_error')
  const request_id = rid('req_mock_')
  return jsonReply(status, { type: 'error', error: { type, message: status === 529 ? 'Overloaded' : message }, request_id }, { 'request-id': request_id })
}
