// subagent-pair: one reply carries two calls to the request's own subagent tool, in each dialect the mock speaks, so an agent that runs
// tool calls together starts two subagents at once. Each call has a schema-valid input; the two are told apart by their description.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startMockUpstream } from './server.mjs'
import { request, parseSse } from '../helpers.mjs'

const str = { type: 'string' }
const AGENT = { type: 'object', required: ['description', 'prompt'], properties: { description: str, prompt: str, subagent_type: str } }
const DSH = { type: 'object', required: ['prompt'], properties: { description: str, prompt: str } } // DeepSeek dsh's `subagent`: no subagent_type
const say = 'two at once [[mock:subagent-pair]]'
const descs = (inputs) => inputs.map((i) => i.description)

test('anthropic: two Agent tool_use blocks in one reply (streamed and whole), stop_reason tool_use', async (t) => {
  const up = await startMockUpstream(); t.after(() => up.close())
  const body = { model: 'claude-test-1', tools: [{ name: 'Read', input_schema: {} }, { name: 'Agent', input_schema: AGENT }], messages: [{ role: 'user', content: say }] }
  const j = JSON.parse((await request(up.url, '/v1/messages', JSON.stringify(body))).body)
  const uses = j.content.filter((b) => b.type === 'tool_use')
  assert.deepEqual([j.stop_reason, uses.map((u) => u.name)], ['tool_use', ['Agent', 'Agent']])
  assert.deepEqual(descs(uses.map((u) => u.input)), ['trocar mock subagent 1', 'trocar mock subagent 2'])
  assert.notEqual(uses[0].id, uses[1].id)
  const evs = parseSse((await request(up.url, '/v1/messages', JSON.stringify({ ...body, stream: true }))).body.toString('utf8')).map((e) => JSON.parse(e.data))
  const starts = evs.filter((e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use')
  const args = starts.map((s) => JSON.parse(evs.filter((e) => e.index === s.index && e.delta?.type === 'input_json_delta').map((e) => e.delta.partial_json).join('')))
  assert.deepEqual(descs(args), ['trocar mock subagent 1', 'trocar mock subagent 2'])
})

test('chat completions: two tool_calls with their own index (streamed and whole), finish_reason tool_calls; dsh\'s `subagent` tool is picked', async (t) => {
  const up = await startMockUpstream(); t.after(() => up.close())
  const body = { model: 'deepseek-test', tools: [{ type: 'function', function: { name: 'subagent', parameters: DSH } }], messages: [{ role: 'user', content: say }] }
  const j = JSON.parse((await request(up.url, '/v1/chat/completions', JSON.stringify(body))).body)
  const calls = j.choices[0].message.tool_calls
  assert.deepEqual([j.choices[0].finish_reason, calls.map((c) => c.function.name)], ['tool_calls', ['subagent', 'subagent']])
  assert.deepEqual(descs(calls.map((c) => JSON.parse(c.function.arguments))), ['trocar mock subagent 1', 'trocar mock subagent 2'])
  const chunks = parseSse((await request(up.url, '/v1/chat/completions', JSON.stringify({ ...body, stream: true }))).body.toString('utf8')).filter((e) => e.data !== '[DONE]').map((e) => JSON.parse(e.data))
  const byIndex = {}
  for (const c of chunks) for (const d of c.choices[0]?.delta?.tool_calls || []) byIndex[d.index] = (byIndex[d.index] || '') + (d.function?.arguments || '')
  assert.deepEqual(descs(Object.values(byIndex).map((a) => JSON.parse(a))), ['trocar mock subagent 1', 'trocar mock subagent 2'])
  // both results back: the turn ends in text, or the agent would start two more forever
  const back = { ...body, messages: [...body.messages, j.choices[0].message, ...calls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: 'done' }))] }
  const next = JSON.parse((await request(up.url, '/v1/chat/completions', JSON.stringify(back))).body).choices[0]
  assert.deepEqual([next.finish_reason, next.message.tool_calls], ['stop', undefined])
  const other = { ...body, tools: [{ type: 'function', function: { name: 'subagent', parameters: { type: 'object', properties: { agent: str, task: str } } } }] }
  assert.equal(JSON.parse((await request(up.url, '/v1/chat/completions', JSON.stringify(other))).body).choices[0].message.tool_calls, undefined, 'a `subagent` tool without a prompt is not dsh\'s')
})

test('responses: two function_call output items in one reply; one subagent still gets the plain description', async (t) => {
  const up = await startMockUpstream(); t.after(() => up.close())
  const body = (s) => ({ model: 'gpt-test-1', tools: [{ type: 'function', name: 'Agent', parameters: AGENT }], input: [{ role: 'user', content: s }] })
  const j = JSON.parse((await request(up.url, '/v1/responses', JSON.stringify(body(say)))).body)
  const fcs = j.output.filter((o) => o.type === 'function_call')
  assert.deepEqual(descs(fcs.map((f) => JSON.parse(f.arguments))), ['trocar mock subagent 1', 'trocar mock subagent 2'])
  assert.notEqual(fcs[0].call_id, fcs[1].call_id)
  const one = JSON.parse((await request(up.url, '/v1/responses', JSON.stringify(body('one [[mock:subagent]]')))).body)
  assert.deepEqual(descs(one.output.filter((o) => o.type === 'function_call').map((f) => JSON.parse(f.arguments))), ['trocar mock subagent'])
})
