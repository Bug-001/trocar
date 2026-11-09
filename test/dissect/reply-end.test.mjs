// test/dissect/reply-end.test.mjs — the reply's own terminal (3.1 `ended`) and the record a client closed after it (3.5 §访问模式 ②),
// over replies shaped by the collector's own shapeResponse. Axes: wire × the named endings × what can make a whole-looking partial
// not whole (a status ≥ 400, the capture cap, a body not decoded).
import test from 'node:test'
import assert from 'node:assert/strict'
import { shapeResponse } from '../../src/collector/core/record/body.mjs'
import { replyEndOf, closedAfterEnd } from '../../src/dissect/registry.mjs'
import { failedOf, cutOf } from '../../src/dissect/endpoints.mjs'

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
const shaped = (events, o = {}) => shapeResponse({ status: o.status ?? 200, headers: [['content-type', 'text/event-stream'], ...(o.headers || [])], body: o.body ?? Buffer.from(sse(events)), truncated: !!o.truncated })
const rec = (path, resp) => ({ id: 'r', is_llm_call: true, endpoint: path, req_body: path === C ? '{"model":"m","messages":[]}' : '{}', resp })
const cut = (path, resp) => ({ ...rec(path, { status: resp.status, kind: 'error', error: { type: 'ECONNRESET', message: 'closed' }, partial: resp }), error: true })

const A = '/v1/messages', R = '/v1/responses', C = '/v1/chat/completions'
const choice = (finish_reason) => ({ choices: [{ index: 0, delta: {}, finish_reason }] })
const resp = (type, status) => ({ type, response: { id: 'r', status, output: [] } })
// [path, events, the named ending]: 'ok' and 'failed' are on each wire's closed list; null is everything else
const CASES = [
  [A, [{ type: 'message_start', message: { id: 'm' } }, { type: 'message_stop' }], 'ok'],
  [A, [{ type: 'message_start', message: { id: 'm' } }, { type: 'error', error: { type: 'overloaded_error' } }], 'failed'],
  [A, [{ type: 'message_start', message: { id: 'm' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }], null],
  [R, [resp('response.completed', 'completed')], 'ok'],
  [R, [resp('response.incomplete', 'incomplete')], 'ok'],
  [R, [resp('response.failed', 'failed')], 'failed'],
  [R, [{ type: 'error', message: 'x' }], 'failed'],
  [R, [resp('response.created', 'in_progress')], null],
  [R, [resp('response.completed', 'completed'), { type: 'error', message: 'x' }], 'failed'], // an error event after the terminal still fails it
  ...['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].map((f) => [C, [choice(f)], 'ok']),
  [C, [choice('stop'), { error: { message: 'x' } }], 'failed'],
  [C, [choice('error')], null],
  [C, [choice('insufficient_system_resource')], null],
  [C, [{ choices: [{ index: 0, delta: { content: 'a' } }] }], null],
  [C, [{ choices: [{ index: 1, delta: { content: 'a' } }] }, choice('stop')], null], // n > 1: one choice still open
  [C, [{ choices: [{ index: 0, delta: { content: 'a' } }] }, choice('stop'), { choices: [{ index: 0, delta: {} }] }], 'ok'], // a finished choice stays finished
]

test('3.1 ended: each wire names its success and failure endings; anything else is null', () => {
  for (const [path, events, want] of CASES) assert.equal(replyEndOf(rec(path, shaped(events))), want, `${path} ${JSON.stringify(events.at(-1))}`)
})

test('3.5 ②: only a cut after a named success is read as that reply; a status ≥ 400, a capped or undecoded partial is not', () => {
  for (const [path, events, want] of CASES) {
    const r = cut(path, shaped(events)), got = closedAfterEnd(r)
    assert.equal(!!got, want === 'ok', `${path} ${want}`)
    if (got) { assert.equal(got.resp, r.resp.partial); assert.equal(got.error, true, 'the record keeps its error') }
  }
  const stop = [{ type: 'message_start', message: { id: 'm' } }, { type: 'message_stop' }]
  assert.equal(closedAfterEnd(cut(A, shaped(stop, { status: 529 }))), null, 'status ≥ 400')
  const whole = Buffer.from(sse(stop))
  assert.equal(closedAfterEnd(cut(A, shaped(stop, { body: whole.subarray(0, whole.length - 10), truncated: true }))), null, 'cut at the capture cap')
  const undecoded = shaped(stop, { headers: [['content-encoding', 'gzip']], body: Buffer.from('not gzip') })
  assert.ok(undecoded.encoding_error)
  assert.equal(closedAfterEnd(cut(A, undecoded)), null, 'not decoded')
  assert.equal(closedAfterEnd(rec(A, shaped(stop))), null, 'a whole record is itself')
})

test('3.5 ②: a named success lifts the error of a cut record only; a whole record that carries error stays failed', () => {
  const whole = { ...rec(A, shaped([{ type: 'message_start', message: { id: 'm' } }, { type: 'message_stop' }])), error: true }
  assert.equal(cutOf(whole), false)
  assert.equal(failedOf({ status: 200, error: true, ended: 'ok', cut: cutOf(whole) }), true)
  const closed = closedAfterEnd(cut(A, shaped([{ type: 'message_start', message: { id: 'm' } }, { type: 'message_stop' }])))
  assert.equal(cutOf(closed), true)
  assert.equal(failedOf({ status: 200, error: true, ended: 'ok', cut: cutOf(closed) }), false)
})
