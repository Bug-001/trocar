import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normPrompt, subagentFirstPrompt, parentTaskPrompts, buildParentIndex, resolveParent,
} from '../../src/identity/session-identity.mjs'
import { rec } from './fixtures.mjs'

const TASK = 'Investigate the auth bug in module X'

// A parent call whose message history contains an assistant tool_use launching a sub-agent.
function parent(sid, ts, prompt = TASK) {
  return rec(sid, {
    ts,
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Task', input: { prompt } }] },
    ],
  })
}
// A sub-agent call: cc_is_subagent, first user msg = the Task prompt (+ appended env block).
function sub(sid, ts, prompt = TASK) {
  return rec(sid, { ts, sub: true, first: prompt, cwd: '/tmp/projX' })
}

test('normPrompt collapses whitespace + trims', () => {
  assert.equal(normPrompt('  a\n b   c '), 'a b c')
})

test('subagentFirstPrompt returns first user message text', () => {
  assert.equal(subagentFirstPrompt(sub('S', '2026-07-13T00:00:05Z')).startsWith(TASK), true)
})

test('parentTaskPrompts extracts Task/Agent tool_use input.prompt', () => {
  assert.deepEqual(parentTaskPrompts(parent('P', '2026-07-13T00:00:03Z')), [TASK])
})

test('buildParentIndex dedups (session,prompt) and skips subagents', () => {
  const idx = buildParentIndex([parent('P', '2026-07-13T00:00:03Z'), parent('P', '2026-07-13T00:00:04Z'), sub('S', '2026-07-13T00:00:05Z')])
  assert.deepEqual(idx, [{ session_id: 'P', ts: '2026-07-13T00:00:03Z', prompt: TASK }])
})

test('认亲: unique parent match -> parent_session_id high (prefix tolerates appended env)', () => {
  const idx = buildParentIndex([parent('P', '2026-07-13T00:00:03Z')])
  const out = resolveParent(sub('S', '2026-07-13T00:00:05Z'), idx)
  assert.deepEqual(out, { parent_session_id: 'P', forked_at_seq: null, confidence: 'high' })
})

test('认亲: no match -> null parent, null confidence', () => {
  const idx = buildParentIndex([parent('P', '2026-07-13T00:00:03Z', 'a totally different task')])
  const out = resolveParent(sub('S', '2026-07-13T00:00:05Z'), idx)
  assert.deepEqual(out, { parent_session_id: null, forked_at_seq: null, confidence: null })
})

test('认亲 tie-break: multiple parents -> nearest preceding by ts, confidence medium', () => {
  const idx = buildParentIndex([
    parent('P1', '2026-07-13T00:00:03Z'), // precedes sub (05)
    parent('P2', '2026-07-13T00:00:07Z'), // after sub -> not preceding
  ])
  const out = resolveParent(sub('S', '2026-07-13T00:00:05Z'), idx)
  assert.deepEqual(out, { parent_session_id: 'P1', forked_at_seq: null, confidence: 'medium' })
})

test('认亲 self-guard: a subagent never matches its own session as parent', () => {
  // MINOR fix (off-by-one): the 8th intended case — a candidate carrying the SAME session id as the
  // sub is excluded by resolveParent's self-guard, so no spurious self-parent lineage is minted.
  const idx = [{ session_id: 'S', ts: '2026-07-13T00:00:03Z', prompt: TASK }]
  const out = resolveParent(sub('S', '2026-07-13T00:00:05Z'), idx)
  assert.deepEqual(out, { parent_session_id: null, forked_at_seq: null, confidence: null })
})
