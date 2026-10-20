// test/view/norm-tools.test.mjs — one neutral reply field (2.6 §A 「回复 · 工具调用」): every server normalizer the board's
// steps[].norm comes from names a reply's tool calls `tools` and never the wire name `tool_calls`, which the browser may not
// read (invariant 3, no-provider-branches.test.mjs). Real records for the Anthropic JSON reply; generated frames for the rest.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normResp } from '../../src/view/analyze.mjs'
import { normResp as normResponses, normRespChat } from '../../src/dissect/openai.mjs'
import { normRespWs } from '../../src/dissect/openai-ws.mjs'

const DEMO = fileURLToPath(new URL('../../samples/demo-session.ndjson', import.meta.url))
const demo = fs.readFileSync(DEMO, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('real replies: norm.tools carries the reply\'s tool_use names in order; norm has no tool_calls key', () => {
  let seen = 0
  for (const r of demo) {
    const c = (r.resp && r.resp.body && Array.isArray(r.resp.body.content)) ? r.resp.body.content : []
    const want = c.filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use').map((b) => b.name)
    const n = normResp(r)
    assert.deepEqual(n.tools.map((t) => t.name), want)
    assert.ok(!('tool_calls' in n))
    seen += want.length
  }
  assert.ok(seen > 0, 'the fixture has replies with tool calls')
})

// the collector's reconstructed SSE reply (resp.tool_calls is the collector's own field, 4.2:74) → the neutral name
test('a reconstructed streamed reply: thinking and tools pass through under the neutral names', () => {
  for (const k of [0, 1, 3]) {
    const calls = Array.from({ length: k }, (_, i) => ({ id: 't' + i, name: 'n' + i, input: { i } }))
    const n = normResp({ resp: { status: 200, text: 'x', thinking: 'th', tool_calls: calls, usage: {} } })
    assert.deepEqual(n.tools, calls); assert.equal(n.thinking, 'th'); assert.ok(!('tool_calls' in n))
  }
})

test('the other wire normalizers (chat, responses, responses over WebSocket) also name them tools', () => {
  const chat = normRespChat({ resp: { raw_sse: [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'ls', arguments: '{"a"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] },
  ] } })
  const done = { type: 'response.completed', response: { status: 'completed', usage: {}, output: [{ type: 'function_call', call_id: 'c2', name: 'cat', arguments: '{}' }] } }
  const resp = normResponses({ resp: { raw_sse: [done] } })
  const ws = normRespWs({ ws: { messages: [] }, resp: {} })
  for (const [n, names] of [[chat, ['ls']], [resp, ['cat']], [ws, []]]) {
    assert.deepEqual((n.tools || []).map((t) => t.name), names)
    assert.ok(!('tool_calls' in n))
  }
})
