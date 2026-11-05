// test/view/lane-task.test.mjs — every lane says what it was asked (RFC 4.4 §看板 v2 需要的补充 `lanes[].task`): a sub-agent the
// spawn's description, else the first line of its first text that fewer than 3 sub-agent lanes share; the other lanes the first prompt
// of their first call. The same rule on every wire (invariant 3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession, firstAskOf, firstPromptOf, rng } from '../query/big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { SEGMENT, homeWith, query, sessionDoc } from '../helpers/session-doc.mjs'

// Every sub-agent's first prompt opens with these lines, more of them than the lanes' own: only the lanes' own lines say a task.
const PREAMBLE = Array.from({ length: 40 }, (_, i) => `[workflow] shared instruction ${i}: work only in the given worktree and report back.`).join('\n')
const squashed = (t) => t.replace(/\s+/g, ' ').trim().slice(0, 80)
const subTasks = (doc) => doc.lanes.filter((l) => l.kind === 'subagent').map((l) => l.task)
for (const wire of ['http', 'chat', 'threads', 'ws']) {
  test(`${wire}: a sub-agent's task is its first own line, the other lanes' their first prompt, and no label says "subagent:"`, async () => {
    const home = path.join(tmpDir('trocar-lanetask-'), '.trocar')
    const s = bigSession({ home, wire, growth: 600, subEvery: 3, subLanes: 3, subLen: 6, preamble: PREAMBLE })
    s.append(24)
    const recs = fs.readFileSync(s.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) // a call's id is <segment>:<line> (3.5)
    const doc = await runQuery('session', { id: s.id }, { home })
    const lanes = doc.lanes, shared = new Set(subTasks(doc).length < 3 ? [] : PREAMBLE.split('\n')) // a flat wire's sub-agents are one doc lane
    assert.ok(lanes.some((l) => l.kind === 'main') && lanes.some((l) => l.kind === 'subagent'))
    for (const l of lanes) {
      const rec = recs[Number(String(l.first).split(':').pop()) - 1]
      assert.ok(rec, `lane ${l.lane}: its first call names a record`)
      const own = firstPromptOf(rec, recs).split('\n').find((x) => x.trim() && !shared.has(x.trim()))
      assert.equal(l.task, l.kind === 'subagent' ? squashed(own) : firstAskOf(rec, recs), `lane ${l.lane}`)
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

test('a prompt that is only wrapped reminders is skipped for the next text; a lane with none has task null', async () => {
  const recs = [
    rec(1, [{ role: 'user', content: [{ type: 'text', text: R('skills: a, b') }, { type: 'text', text: `  Fix the\n\n  retry   queue ${R('date')}` }] }]),
    rec(2, [{ role: 'user', content: [{ type: 'text', text: `${R('only')}\n${R('reminders')}` }] }], 'agent-1'),
  ]
  const { lanes } = await sessionDoc(recs, 'S')
  assert.deepEqual(lanes.map((l) => [l.kind, l.task]), [['main', 'Fix the retry queue'], ['subagent', null]])
})

const user = (...texts) => [{ role: 'user', content: texts.map((text) => ({ type: 'text', text })) }]
// a main lane and one sub-agent lane a first message: its text blocks, or its one text
const session = (messages) => [rec(1, user('Run the plan')), ...messages.map((m, i) => rec(i + 2, user(...[m].flat()), `agent-${i}`))]
const tasksOf = async (messages) => subTasks(await sessionDoc(session(messages), 'S'))

for (const k of [2, 3, 4]) for (const at of [0, 1, 2, 3])
  test(`${k} lanes sharing three lines, each its own at line ${at}: the task is the first line held by fewer than 3 lanes`, async () => {
    const text = (own) => { const l = ['Work in the given worktree.', 'Report back when done.', 'Do not push.']; l.splice(at, 0, own); return l.join('\n') }
    const owns = Array.from({ length: k }, (_, i) => `implement   the part ${i}`)
    assert.deepEqual(await tasksOf(owns.map(text)), owns.map((o) => squashed(k < 3 ? text(o).split('\n')[0] : o)))
  })

test('leading heading, list and quote marks are not words; a line of only punctuation is passed over; what only looks like a mark stays', async () => {
  const marks = ['# ', '###### ', '- ', '* ', '+ ', '1. ', '12) ', '> ', '> - ', '## 1. ', '']
  const lines = ['fix the queue', '修复队列', 'v2', '#tag', '-x', '1.5 is the rate', '*bold* first']
  const punct = ['---', '***', '...', '## ---', '> - !', '-', '====', '§§', '#', '1.', '()']
  const cases = marks.flatMap((m, i) => lines.map((l, j) => ({ text: `${punct[(i + j) % punct.length]}\n${m}${l}`, want: l })))
  for (let i = 0; i < cases.length; i += 8) { // lanes few enough that no punctuation line is shared: only the rule passes it over
    const part = cases.slice(i, i + 8)
    assert.deepEqual(await tasksOf(part.map((c) => c.text)), part.map((c) => c.want))
  }
})

for (const k of [3, 4])
  test(`${k} lanes that share every line have no task`, async () => {
    assert.deepEqual(await tasksOf(Array(k).fill('Work in the given worktree.\n\n  Report back when done.  ')), Array(k).fill(null))
  })

test('a spawn\'s description names its lane, and that lane still counts toward what is shared', async () => {
  const text = (own) => `Work in the given worktree.\n${own}`
  const recs = session([text('first own line'), text('second own line'), text('third own line')])
  recs[0].resp.body = { ...recs[0].resp.body, stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Scan the repo', prompt: text('first own line') } }] }
  const lanes = (await sessionDoc(recs, 'S')).lanes.filter((l) => l.kind === 'subagent')
  assert.ok(lanes[0].spawnRid != null, 'the first sub-agent lane is linked to its spawn')
  assert.deepEqual(lanes.map((l) => l.task), ['Scan the repo', 'second own line', 'third own line'])
})

test('a first message in several text blocks: the words may be in a later block, and reminders are not words', async () => {
  const blocks = (own) => [`${R('skills: a, b')}\nWork in the given worktree.`, R('date'), `${R('env')}\n${own} ${R('late')}\nmore`]
  assert.deepEqual(await tasksOf(['part a', 'part b', 'part c'].map(blocks)), ['part a', 'part b', 'part c'])
})

test('a third lane moves the words of the two before it, and the --since answer carries those lanes', async () => {
  const text = (own) => `Work in the given worktree.\n${own}`
  const [main, a, b, c] = session(['a', 'b', 'c'].map((x) => text(`part ${x}`)))
  const home = homeWith([main, a, b])
  const full = await query(home, 'session', { id: 'S' })
  assert.deepEqual(subTasks(full), Array(2).fill('Work in the given worktree.'))
  fs.appendFileSync(path.join(home, 'raw', `${SEGMENT}.ndjson`), JSON.stringify(c) + '\n')
  const d = await query(home, 'session', { id: 'S', since: full.mark })
  assert.deepEqual(subTasks(d), ['part a', 'part b', 'part c'])
})

test('the tasks do not depend on the order calls arrive in, nor on how many answers the fold took', async () => {
  const lines = (own, ...more) => [...more, own, 'Report back when done.'].join('\n')
  const texts = [lines('own a', 'All', 'Pair'), lines('own b', 'All', 'Pair'), lines('own c', 'All', 'Trio'), lines('own d', 'All', 'Trio'), lines('own e', 'All', 'Trio')]
  // each lane two calls: its first message opens both
  const recs = [...session(texts), ...texts.map((t, i) => rec(i + 20, [...user(t), { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, ...user('go on')], `agent-${i}`))]
  const sorted = (doc) => subTasks(doc).sort()
  const want = ['Pair', 'Pair', 'own c', 'own d', 'own e'].sort()
  assert.deepEqual(sorted(await sessionDoc(recs, 'S')), want)
  for (const seed of [3, 17, 29]) {
    const next = rng(seed), mixed = recs.map((r) => [next(), r]).sort((x, y) => x[0] - y[0]).map(([, r]) => r)
    assert.deepEqual(sorted(await sessionDoc(mixed, 'S')), want, `seed ${seed} in one answer`)
    const home = homeWith(mixed.slice(0, 1)), raw = path.join(home, 'raw', `${SEGMENT}.ndjson`)
    await query(home, 'session', { id: 'S' })
    for (const r of mixed.slice(1)) { fs.appendFileSync(raw, JSON.stringify(r) + '\n'); await query(home, 'session', { id: 'S' }) }
    assert.deepEqual(sorted(await query(home, 'session', { id: 'S' })), want, `seed ${seed} a call at a time`)
  }
})

// A session whose sub-agents come on two wires (D37 ①: the wire is per call): Claude Code's, and a flat-lane wire's, every sub-agent's
// first prompt opening with the same workflow preamble. The rule is one over every sub-agent lane of the session (invariant 3).
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
