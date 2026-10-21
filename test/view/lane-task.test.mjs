// test/view/lane-task.test.mjs — every lane says what it was asked (RFC 4.4 §看板 v2 需要的补充 `lanes[].task`): the spawn's
// argument when the spawn is known, else the first prompt of the lane's first call, the same rule on every wire (invariant 3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession, firstAskOf } from '../query/big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { sessionView } from '../../src/view/board.mjs'

for (const wire of ['http', 'chat', 'threads', 'ws']) {
  test(`${wire}: every lane's task is its first call's first prompt, and no label says "subagent:"`, async () => {
    const home = path.join(tmpDir('trocar-lanetask-'), '.trocar')
    const s = bigSession({ home, wire, growth: 600, subEvery: 3, subLanes: 3, subLen: 6 })
    s.append(24)
    const recs = fs.readFileSync(s.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) // a call's id is <segment>:<line> (3.5)
    const doc = await runQuery('session', { id: s.id, limit: 500 }, { home })
    const lanes = doc.analyzed.lanes
    assert.ok(lanes.some((l) => l.kind === 'main') && lanes.some((l) => l.kind === 'subagent'))
    for (const l of lanes) {
      const rec = recs[Number(String(l.calls[0].id).split(':').pop()) - 1]
      assert.ok(rec, `lane ${l.id}: its first call names a record`)
      assert.equal(l.task, firstAskOf(rec, recs), `lane ${l.id}`)
      assert.ok(!String(l.label).includes('subagent:'), l.label)
    }
  })
}

// A Claude Code shaped call (the generator's http form) with the messages given.
const T = Date.parse('2026-10-21T08:00:00Z')
const rec = (i, messages, agent = null) => ({
  ts: new Date(T + i * 1000).toISOString(), ts_request: new Date(T + i * 1000).toISOString(), id: `r${i}`, endpoint: '/v1/messages', method: 'POST',
  req_headers: { host: 'api.anthropic.com', 'content-type': 'application/json', 'user-agent': 'claude-cli/2.0.0 (external, cli)', 'x-claude-code-session-id': 'S',
    ...(agent ? { 'x-claude-code-agent-id': agent } : {}) },
  req_body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 32000, system: [{ type: 'text', text: 'You are a coding agent.' }],
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: {} } }], messages }),
  resp: { status: 200, kind: 'json', body: { id: `msg_${i}`, model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } },
  is_llm_call: true, capture: 'transparent', host: 'api.anthropic.com', traffic_class: 'llm', proc: { pid: 1, exe: '/x/claude', agent: 'claude-code' },
})
const R = (t) => `<system-reminder>${t}</system-reminder>`

test('a prompt that is only wrapped reminders is skipped for the next text; a lane with none has task null', () => {
  const recs = [
    rec(1, [{ role: 'user', content: [{ type: 'text', text: R('skills: a, b') }, { type: 'text', text: `  Fix the\n\n  retry   queue ${R('date')}` }] }]),
    rec(2, [{ role: 'user', content: [{ type: 'text', text: `${R('only')}\n${R('reminders')}` }] }], 'agent-1'),
  ]
  const lanes = sessionView(recs, 'S').analyzed.lanes
  assert.deepEqual(lanes.map((l) => [l.kind, l.task]), [['main', 'Fix the retry queue'], ['subagent', null]])
})
