// openai.mjs — OpenAI dialects: Responses (Codex and the Agents SDK) and Chat Completions (DeepSeek,
// Kimi, GLM, OpenRouter and most relays). Event shapes follow what the official SDKs and Codex parse.
import { randomBytes } from 'node:crypto'
import { plan, splitEvery } from './scenarios.mjs'
import { jsonReply } from './transport.mjs'
import { prefixUsage } from './cache.mjs'

const rid = (p) => `${p}${randomBytes(12).toString('hex')}`
const now = () => Math.floor(Date.now() / 1000)
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? (c.findLast((p) => typeof p.text === 'string')?.text ?? '') : ''
const outputText = (o) => typeof o === 'string' ? o : Array.isArray(o) ? o.map((p) => p.text || '').join('') : JSON.stringify(o ?? '')
const SSE = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }

export const responses = {
  errorReply,
  seen(body) {
    const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : Array.isArray(body.input) ? body.input : []
    const last = input.at(-1)
    if (/_call_output$/.test(last?.type || '')) return { kind: 'tool_result', text: outputText(last.output) }
    return { kind: 'text', text: textOf(input.findLast((i) => i.role === 'user')?.content) }
  },

  reply(body, raw, sc, ctx = {}) {
    const p = plan(responses.seen(body), raw, body, sc)
    const id = rid('resp_mock_'), created_at = now(), headers = { 'x-request-id': rid('req_mock_') }
    const c = prefixUsage(ctx, 'responses', body)
    const usage = { input_tokens: c.total, input_tokens_details: { cached_tokens: c.cached }, output_tokens: p.outputTokens, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: c.total + p.outputTokens }
    const response = (status, output, u = null) => ({ id, object: 'response', created_at, status, model: p.model, output, usage: u, error: null, incomplete_details: null })
    // Codex's remote compaction ends its input with a compaction_trigger and wants one compaction item back
    const items = p.compaction ? [compactionItem(p)] : [p.thinking && reasoningItem(p), messageItem(p), p.tool && functionCallItem(p)].filter(Boolean)
    if (!body.stream) return jsonReply(200, response('completed', items.map((i) => i.done), usage), headers)

    let seq = 0
    const ev = ([type, data], n = seq++) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: n, ...data })}\n\n`
    const pieces = [ev(['response.created', { response: response('in_progress', []) }]), ev(['response.in_progress', { response: response('in_progress', []) }])]
    items.forEach((it, output_index) => {
      pieces.push(ev(['response.output_item.added', { output_index, item: it.added }]))
      for (const e of it.inner({ item_id: it.done.id, output_index })) pieces.push(ev(e))
      pieces.push(ev(['response.output_item.done', { output_index, item: it.done }]))
    })
    pieces.push(ev(['response.completed', { response: response('completed', items.map((i) => i.done), usage) }]))
    const failed = { ...response('failed', []), error: { code: 'server_error', message: 'mock-upstream: scripted stream failure' } }
    return {
      status: 200, headers: { ...SSE, ...headers }, pieces, firstDelta: pieces.findIndex((s) => /^event: response\.[a-z_.]+\.delta\n/.test(s)),
      failEvent: (n) => ev(['response.failed', { response: failed }], n), // n = events already sent, so sequence numbers stay gapless
    }
  },
}

// An output item as its final form, its opening form, and the events between output_item.added/done.
function messageItem(p) {
  const id = rid('msg_mock_'), part = (text) => ({ type: 'output_text', text, annotations: [] })
  const done = { id, type: 'message', status: 'completed', role: 'assistant', content: [part(p.text)] }
  return {
    done, added: { ...done, status: 'in_progress', content: [] },
    inner: (at) => [
      ['response.content_part.added', { ...at, content_index: 0, part: part('') }],
      ...p.parts.map((delta) => ['response.output_text.delta', { ...at, content_index: 0, delta, logprobs: [] }]),
      ['response.output_text.done', { ...at, content_index: 0, text: p.text, logprobs: [] }],
      ['response.content_part.done', { ...at, content_index: 0, part: part(p.text) }],
    ],
  }
}

function reasoningItem(p) {
  const id = rid('rs_mock_'), part = (text) => ({ type: 'summary_text', text })
  const done = { id, type: 'reasoning', summary: [part(p.thinking)] }
  return {
    done, added: { ...done, summary: [] },
    inner: (at) => [
      ['response.reasoning_summary_part.added', { ...at, summary_index: 0, part: part('') }],
      ...p.thinkingParts.map((delta) => ['response.reasoning_summary_text.delta', { ...at, summary_index: 0, delta }]),
      ['response.reasoning_summary_text.done', { ...at, summary_index: 0, text: p.thinking }],
      ['response.reasoning_summary_part.done', { ...at, summary_index: 0, part: part(p.thinking) }],
    ],
  }
}

// encrypted_content is opaque to the client; here it is just the reply text, base64.
function compactionItem(p) {
  const done = { id: rid('cmp_mock_'), type: 'compaction', encrypted_content: Buffer.from(p.text).toString('base64') }
  return { done, added: done, inner: () => [] }
}

function functionCallItem(p) {
  const done = { id: rid('fc_mock_'), type: 'function_call', status: 'completed', call_id: rid('call_mock_'), name: p.tool.name, arguments: p.toolArgs }
  return {
    done, added: { ...done, status: 'in_progress', arguments: '' },
    inner: (at) => [
      ...splitEvery(p.toolArgs, 16).map((delta) => ['response.function_call_arguments.delta', { ...at, delta }]),
      ['response.function_call_arguments.done', { ...at, arguments: p.toolArgs }],
    ],
  }
}

export const chat = {
  errorReply,
  seen(body) {
    const msgs = Array.isArray(body.messages) ? body.messages : []
    if (msgs.at(-1)?.role === 'tool') return { kind: 'tool_result', text: outputText(msgs.at(-1).content) }
    return { kind: 'text', text: textOf(msgs.findLast((m) => m.role === 'user')?.content) }
  },

  reply(body, raw, sc, ctx = {}) {
    const p = plan(chat.seen(body), raw, body, sc)
    const id = rid('chatcmpl-mock-'), created = now(), headers = { 'x-request-id': rid('req_mock_') }
    // prompt_cache_* is DeepSeek's spelling of cached_tokens; clients read whichever they know.
    const c = prefixUsage(ctx, 'chat', body)
    const usage = { prompt_tokens: c.total, completion_tokens: p.outputTokens, total_tokens: c.total + p.outputTokens, prompt_tokens_details: { cached_tokens: c.cached }, prompt_cache_hit_tokens: c.cached, prompt_cache_miss_tokens: c.total - c.cached }
    const base = { id, created, model: p.model, system_fingerprint: 'fp_mock' }
    const call = p.tool && { id: rid('call_mock_'), type: 'function', function: { name: p.tool.name, arguments: p.toolArgs } }
    const finish = call ? 'tool_calls' : 'stop'
    if (!body.stream) {
      // reasoning_content is DeepSeek's (and Kimi's / GLM's) field for thinking text
      const message = { role: 'assistant', content: p.text, ...(p.thinking ? { reasoning_content: p.thinking } : {}), ...(call ? { tool_calls: [call] } : {}) }
      return jsonReply(200, { ...base, object: 'chat.completion', choices: [{ index: 0, message, logprobs: null, finish_reason: finish }], usage }, headers)
    }
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, logprobs: null, finish_reason }] })}\n\n`
    const pieces = [chunk({ role: 'assistant', content: '' }), ...(p.thinkingParts || []).map((reasoning_content) => chunk({ reasoning_content })), ...p.parts.map((content) => chunk({ content }))]
    if (call) {
      pieces.push(chunk({ tool_calls: [{ index: 0, ...call, function: { name: call.function.name, arguments: '' } }] }))
      for (const a of splitEvery(p.toolArgs, 16)) pieces.push(chunk({ tool_calls: [{ index: 0, function: { arguments: a } }] }))
    }
    pieces.push(chunk({}, finish))
    if (body.stream_options?.include_usage) pieces.push(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [], usage })}\n\n`)
    pieces.push('data: [DONE]\n\n')
    // Chat has no error event type; providers send an error object as a data line and stop.
    const failEvent = () => `data: ${JSON.stringify({ error: { message: 'Overloaded', type: 'server_error', param: null, code: 'overloaded' } })}\n\n`
    return { status: 200, headers: { ...SSE, ...headers }, pieces, firstDelta: 1, failEvent }
  },
}

// Status → OpenAI error {type, code}; both dialects share the body shape.
const ERRORS = { 401: ['invalid_request_error', 'invalid_api_key'], 404: ['invalid_request_error', 'model_not_found'], 429: ['requests', 'rate_limit_exceeded'], 529: ['server_error', 'overloaded'] }

export function errorReply(status, message = `mock-upstream: scripted ${status}`) {
  const [type, code] = ERRORS[status] || [status < 500 ? 'invalid_request_error' : 'server_error', null]
  return jsonReply(status, { error: { message, type, param: null, code } }, { 'x-request-id': rid('req_mock_') })
}
