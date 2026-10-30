// test/view/nonblock-value.test.mjs — 2.6 §A 请求参数 / 涉及源文件: nonBlockKeysOf() ships `value` for a short scalar — a number, a boolean,
// or a string of at most 40 characters — exactly the JSON value in the request; any other key (object, array, null, longer string) has
// none. `chars` and `ref` stay the byte span of the key's verbatim value.
import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleSession } from '../../src/view/assemble.mjs'

const stream = (r) => Object.defineProperty(r, '_stream', { value: 'capture-2026-10-21.ndjson', enumerable: false })
const S40 = 'x'.repeat(39) + 'é'
const S41 = 'y'.repeat(41)
const params = { model: 'claude-x', max_tokens: 8192, stream: true, temperature: 0.7, s40: S40, s41: S41, metadata: { user_id: 'u' }, stop: null, tags: ['a'] }
const SHORT = ['model', 'max_tokens', 'stream', 'temperature', 's40']

const cases = [
  ['anthropic', stream({ id: 'a', ts_request: '2026-10-21T00:00:00Z', is_llm_call: true, endpoint: '/v1/messages', host: 'api.anthropic.com',
    req_headers: { 'x-claude-code-session-id': 'S' }, req_body: JSON.stringify({ ...params, messages: [{ role: 'user', content: 'hi' }] }),
    resp: { status: 200, kind: 'text', raw: 'ok' } })],
  ['openai-chat', stream({ id: 'o', ts_request: '2026-10-21T00:00:00Z', is_llm_call: true, endpoint: '/v1/chat/completions', host: 'api.openai.com',
    req_headers: {}, req_body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...params }, null, 1),
    resp: { status: 200, kind: 'text', raw: 'ok' } })],
]

test('2.6 — a short scalar request parameter carries its value; objects, arrays, null and long strings do not', () => {
  for (const [name, rec] of cases) {
    const keys = assembleSession([rec]).steps[0].nonBlockKeys
    const by = Object.fromEntries(keys.map((k) => [k.key, k]))
    for (const key of Object.keys(params)) {
      const k = by[key]
      assert.ok(k, `${name}: ${key} is listed`)
      const [from, to] = k.ref.split('::').pop().split('-').map(Number)
      assert.deepEqual(JSON.parse(rec.req_body.slice(from, to)), params[key], `${name}: ${key} ref is its verbatim value`)
      assert.equal(k.chars, to - from, `${name}: ${key} chars is the length of that value`)
      if (SHORT.includes(key)) assert.ok(Object.is(k.value, params[key]), `${name}: ${key} value`)
      else assert.ok(!('value' in k), `${name}: ${key} carries no value`)
    }
  }
})
