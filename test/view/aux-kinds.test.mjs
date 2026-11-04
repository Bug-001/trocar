// test/view/aux-kinds.test.mjs — which background kind a call is (RFC 2.1 §种类怎么认): generated Claude Code shaped calls, read through
// the `session` and `lane` queries. Axes: kind × with or without the owning sub-agent's agent-id × short or long history.
import test from 'node:test'
import assert from 'node:assert/strict'
import { homeWith, query } from '../helpers/session-doc.mjs'

const T = Date.parse('2026-10-21T08:00:00Z')
const SYSTEM = 'You are a coding agent.'
const user = (...content) => ({ role: 'user', content: content.map((c) => (typeof c === 'string' ? { type: 'text', text: c } : c)) })
const said = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] })
const result = { type: 'tool_result', tool_use_id: 't1', content: 'done' }
const turns = (n) => Array.from({ length: n }, (_, i) => [user(`turn ${i}: fix the queue`), said(`on it ${i}`)]).flat()

const rec = (i, messages, { agent = null, system = SYSTEM, maxTokens = 32000 } = {}) => ({
  ts_request: new Date(T + i * 1000).toISOString(), id: `r${i}`, endpoint: '/v1/messages', host: 'api.anthropic.com',
  req_headers: { host: 'api.anthropic.com', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.0.0 (external, cli)', 'x-claude-code-session-id': 'S',
    'x-claude-code-request-class': 'auxiliary', ...(agent ? { 'x-claude-code-agent-id': agent } : {}) },
  req_body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: maxTokens, system: [{ type: 'text', text: system }], tools: [], messages }),
  resp: { status: 200, kind: 'json', body: { id: `msg_${i}`, model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } },
})

// each kind's call over `history` earlier messages: what puts it there sits where the table reads it
const SUGGEST = '[SUGGESTION MODE: Suggest what the user might naturally type next.]'
const FORMS = {
  quota: [(h) => ({ messages: [user('anything'), ...turns(h)], maxTokens: 1 }), (h) => ({ messages: [user(' quota\n'), ...turns(h)] })],
  titlegen: [(h) => ({ messages: [user('Write a 2-4 word lowercase label for this job: tidy the queue'), ...turns(h)] })],
  notify: [(h) => ({ messages: [user('here is the tail'), ...turns(h)], system: 'The user walked away. Read the tail of what the agent did.' })],
  suggest: [(h) => ({ messages: [...turns(h), user(SUGGEST)] })],
  websearch: [(h) => ({ messages: [user('  Perform a web search for the query: node test runner'), ...turns(h)] })],
  webfetch: [(h) => ({ messages: [user('Web page content:\n---\nsome page'), ...turns(h)] }),
    (h) => ({ messages: [user('Answer from the page below.\n\nWeb page content:\n---\nsome page'), ...turns(h)] })],
  aux: [(h) => ({ messages: [user('Summarise the release notes'), ...turns(h)] })],
}

async function laneOf(calls) {
  const home = homeWith(calls)
  const doc = await query(home, 'session', { id: 'S' })
  const lanes = await Promise.all(doc.lanes.map((l) => query(home, 'lane', { id: 'S', lane: l.lane })))
  return { doc, lanes }
}
const kindsOf = async (...calls) => (await laneOf(calls.map(([m, o], i) => rec(i + 1, m, o)))).doc.lanes.map((l) => l.kind)

for (const [kind, forms] of Object.entries(FORMS)) for (const [f, form] of forms.entries()) for (const agent of [null, 'agent-1']) for (const history of [0, 40]) {
  test(`${kind} form ${f}, agent-id ${agent ? 'set' : 'unset'}, ${history} earlier messages: its own lane, one aux event per call`, async () => {
    const calls = [1, 2, 3].map((i) => { const { messages, ...o } = form(history); return rec(i, messages, { agent, ...o }) })
    const { doc, lanes } = await laneOf(calls)
    assert.deepEqual(doc.lanes.map((l) => l.kind), [kind])
    const [{ lane, count }] = doc.lanes
    assert.equal(count, calls.length)
    assert.equal(doc.calls.filter((c) => c.lane === lane).length, calls.length)
    assert.deepEqual(lanes[0].resources, [])
    assert.deepEqual(doc.events.filter((e) => e.lane === lane).map((e) => e.type), calls.map(() => 'aux'))
  })
}

test('the suggestion marker quoted in an earlier user turn is no suggestion: only the last user text counts', async () => {
  assert.deepEqual(await kindsOf([[user(SUGGEST), said('what is that?'), user('Summarise the release notes')]]), ['aux'])
})

test('a suggestion whose call ends in a tool_result-only turn and a system-role message is still a suggestion', async () => {
  assert.deepEqual(await kindsOf([[...turns(3), user(SUGGEST), said('reading'), user(result), { role: 'system', content: 'a note' }]]), ['suggest'])
})

test('more than one leading line is no web page summary, and the words past the start of the first prompt name nothing', async () => {
  assert.deepEqual(await kindsOf([[user('one\ntwo\nWeb page content:\nx')]], [[user('Please Perform a web search for the query: x')]]), ['aux'])
})
