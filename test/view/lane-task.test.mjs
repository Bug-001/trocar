// test/view/lane-task.test.mjs — every lane says what it was asked (RFC 4.4 §看板 v2 需要的补充 `lanes[].task`): the spawn's
// argument when the spawn is known, else the first prompt of the lane's first call, the same rule on every wire (invariant 3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession, firstAskOf, rng } from '../query/big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { sessionView } from '../helpers/session-view.mjs'
import { departer } from '../../src/view/blockmeta.mjs'

for (const wire of ['http', 'chat', 'threads', 'ws']) {
  test(`${wire}: every lane's task is its first call's first prompt, and no label says "subagent:"`, async () => {
    const home = path.join(tmpDir('trocar-lanetask-'), '.trocar')
    const s = bigSession({ home, wire, growth: 600, subEvery: 3, subLanes: 3, subLen: 6 })
    s.append(24)
    const recs = fs.readFileSync(s.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) // a call's id is <segment>:<line> (3.5)
    const doc = await runQuery('session', { id: s.id }, { home })
    const lanes = doc.lanes
    assert.ok(lanes.some((l) => l.kind === 'main') && lanes.some((l) => l.kind === 'subagent'))
    for (const l of lanes) {
      const rec = recs[Number(String(l.first).split(':').pop()) - 1]
      assert.ok(rec, `lane ${l.lane}: its first call names a record`)
      assert.equal(l.task, firstAskOf(rec, recs), `lane ${l.lane}`)
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

test('sub-agents whose first prompts share a long preamble are told apart by the first line where each departs from the others', () => {
  const preamble = Array.from({ length: 120 }, (_, i) => `[harness] shared instruction line ${i}: work in the given worktree and report back.`).join('\n')
  const ask = (line) => [{ role: 'user', content: [{ type: 'text', text: `${preamble}\n${line}\nmore   text that follows\n` }] }]
  const recs = [
    rec(1, [{ role: 'user', content: [{ type: 'text', text: 'Run the plan' }] }]),
    rec(2, ask('## Your task: implement   the retry queue in src/queue.mjs and its tests'), 'agent-a'),
    rec(3, ask('## Your task: review the branch'), 'agent-b'),
    rec(4, ask('## Your task: review the branch'), 'agent-c'), // the same prompt twice: still told apart from agent-a
  ]
  const lanes = sessionView(recs, 'S').analyzed.lanes
  const from = (line) => `${line}\nmore   text that follows`.replace(/\s+/g, ' ').trim().slice(0, 80) // that line on, squashed, ≤ 80
  assert.deepEqual(lanes.map((l) => l.task), ['Run the plan', from('## Your task: implement   the retry queue in src/queue.mjs and its tests'),
    from('## Your task: review the branch'), from('## Your task: review the branch')])
})

// A session whose sub-agents come on two wires (D37 ①: the wire is per call): Claude Code's, and a flat-lane wire's, every sub-agent's
// first prompt opening with the same workflow preamble. The rule is one over every sub-agent lane of the session (invariant 3).
const PREAMBLE = Array.from({ length: 40 }, (_, i) => `[workflow] shared instruction ${i}: work only in the given worktree and report back.`).join('\n')
for (const flat of ['chat', 'ws'])
  test(`http + ${flat}: sub-agents sharing a preamble are told apart on every wire, none named by the preamble`, async () => {
    const home = path.join(tmpDir('trocar-lanetask-'), '.trocar')
    const opts = { home, growth: 600, subEvery: 3, subLanes: 3, subLen: 6, preamble: PREAMBLE }
    const a = bigSession({ ...opts, wire: 'http' }), b = bigSession({ ...opts, wire: flat, segment: '20261020T170000Z', seed: 11 })
    a.append(18); b.append(18)
    const doc = await runQuery('session', { id: a.id }, { home })
    const subs = doc.lanes.filter((l) => l.kind === 'subagent')
    assert.ok(new Set(subs.map((l) => l.first.split(':')[0])).size === 2, 'sub-agent lanes on both wires (each wire its own segment)')
    for (const l of subs) assert.ok(l.task && !PREAMBLE.startsWith(l.task.slice(0, 20)), `lane ${l.lane} is not named by the preamble: ${l.task}`)
    assert.equal(new Set(subs.map((l) => l.task)).size, subs.length, 'each sub-agent its own task')
  })

// departer (4.4 §看板 v2 需要的补充 `lanes[].task`): a prompt departs from its siblings at the line where it parts from the DISTINCT prompt
// it shares the longest prefix with (an identical prompt is no sibling); 0 when it parts at the start, never parts, or has no sibling.
// Seeded add / remove sequences over prompts that share long multi-line preambles, with duplicates, prefixes and a leading newline.
test('departer: after every add and remove each prompt departs where the brute-force rule says, and every prompt that moved is named', () => {
  const ref = (h, present) => {
    let d = -1
    for (const o of present) if (o !== h) { let i = 0; while (i < h.length && i < o.length && h[i] === o[i]) i++; d = Math.max(d, i) }
    return d <= 0 || d >= h.length ? 0 : h.lastIndexOf('\n', d - 1) + 1
  }
  const pre = (tag, n) => Array.from({ length: n }, (_, i) => `[${tag}] shared line ${i}: work in the given worktree`).join('\n')
  for (const seed of [3, 17, 29, 101]) {
    const next = rng(seed), pick = (a) => a[Math.floor(next() * a.length)]
    const pres = [pre('a', 30), pre('a', 12), pre('b', 30), '', '\n']
    const tails = ['', '\n## task: retry queue', '\n## task: retry queue\nmore', '\n## task: review', 'x', '\n## task: review the branch\n']
    const pool = Array.from({ length: 24 }, () => pick(pres) + pick(tails)).filter(Boolean)
    const dep = departer(), held = []
    for (let op = 0; op < 400; op++) {
      const before = new Map([...new Set(held)].map((h) => [h, ref(h, new Set(held))]))
      let moved
      if (held.length && next() < 0.45) moved = dep.remove(held.splice(Math.floor(next() * held.length), 1)[0])
      else { const h = pick(pool); held.push(h); moved = dep.add(h) }
      const present = new Set(held)
      for (const h of present) {
        const want = ref(h, present)
        assert.equal(dep.offset(h), want, `seed ${seed} op ${op}: ${JSON.stringify(h.slice(-40))}`)
        if (before.get(h) !== want) assert.ok(moved.includes(h), `seed ${seed} op ${op}: a prompt whose offset moved is named`)
      }
    }
  }
})
