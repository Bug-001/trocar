// test/view/lane-task.test.mjs — every lane says what it was asked (RFC 4.4 §看板 v2 需要的补充 `lanes[].task`): the spawn's
// argument when the spawn is known, else the first prompt of the lane's first call, the same rule on every wire (invariant 3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession, firstAskOf, rng } from '../query/big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { homeWith, query, sessionDoc } from '../helpers/session-doc.mjs'
import { askOf, departer, taskOf, TASK_MAX } from '../../src/view/blockmeta.mjs'

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

test('a prompt that is only wrapped reminders is skipped for the next text; a lane with none has task null', async () => {
  const recs = [
    rec(1, [{ role: 'user', content: [{ type: 'text', text: R('skills: a, b') }, { type: 'text', text: `  Fix the\n\n  retry   queue ${R('date')}` }] }]),
    rec(2, [{ role: 'user', content: [{ type: 'text', text: `${R('only')}\n${R('reminders')}` }] }], 'agent-1'),
  ]
  const { lanes } = await sessionDoc(recs, 'S')
  assert.deepEqual(lanes.map((l) => [l.kind, l.task]), [['main', 'Fix the retry queue'], ['subagent', null]])
})

test('sub-agents whose first prompts share a long preamble are told apart by the first line where each departs from the others', async () => {
  const preamble = Array.from({ length: 120 }, (_, i) => `[harness] shared instruction line ${i}: work in the given worktree and report back.`).join('\n')
  const ask = (line) => [{ role: 'user', content: [{ type: 'text', text: `${preamble}\n${line}\nmore   text that follows\n` }] }]
  const recs = [
    rec(1, [{ role: 'user', content: [{ type: 'text', text: 'Run the plan' }] }]),
    rec(2, ask('## Your task: implement   the retry queue in src/queue.mjs and its tests'), 'agent-a'),
    rec(3, ask('## Your task: review the branch'), 'agent-b'),
    rec(4, ask('## Your task: review the branch'), 'agent-c'), // the same prompt twice: still told apart from agent-a
  ]
  const { lanes } = await sessionDoc(recs, 'S')
  const from = (line) => taskOf(`${line}\nmore   text that follows`) // that line on, squashed, cut at the cap
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

// The question past injected wrappers (4.4 #20), through the whole pipeline: the main lane's task, the session's title and the list's title
// say the same. `want` is the fixture's text squashed and cut at 80: what a title is, never what the code printed.
const U = (...texts) => ({ role: 'user', content: texts.map((text) => ({ type: 'text', text })) })
const A = { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
const squashed = (t) => taskOf(t)
const BOOT = '<boot>a</boot>', LONG = `<boot>${'x '.repeat(9000)}</boot>\nFix it`
const ASKS = [
  ['a wrapper before the question', [[U('<EXTREMELY_IMPORTANT>\nboot\n</EXTREMELY_IMPORTANT>\n\nFix the retry queue')]], 'Fix the retry queue'],
  ['two wrappers, the second with attributes, before the question', [[U('<boot>a</boot>\n<env cwd="/w" os="x">b</env>\nFix the retry queue')]], 'Fix the retry queue'],
  ['a wrapper alone in its block: the next block of the message', [[U(BOOT, 'Fix it')]], 'Fix it'],
  ['a wrapper alone in its message: the next user message', [[U(BOOT), A, U('Fix it')]], 'Fix it'],
  ['all wrapped: the inner text of a span with attributes', [[U('<file name="brief.md">Build the parser</file>')]], 'Build the parser'],
  ['all wrapped, no attributes: the text as it was', [[U('<boot>skills</boot>')]], squashed('<boot>skills</boot>')],
  ['all wrapped over two texts: the attributed span of the second', [[U(BOOT, '<file name="b">c</file>')]], 'c'],
  ['an attributed span with nothing inside: the text as it was', [[U('<file name="a"></file>')]], squashed('<file name="a"></file>')],
  ['never closed: not a wrapper', [[U('<boot>never closed\nFix it')]], squashed('<boot>never closed\nFix it')],
  ['a self-closed tag: not a wrapper', [[U('<br/> Fix it')]], squashed('<br/> Fix it')],
  ['closed past the 16 KiB read: not a wrapper', [[U(LONG)]], squashed(LONG)],
  ['a tag inside the text stays', [[U('Why does <file name="a">b</file> fail?')]], 'Why does <file name="a">b</file> fail?'],
  ['reminders go first, then the wrapper', [[U(`${R('date')}${BOOT}\nFix it`)]], 'Fix it'],
  ['a later call is not read', [[U(BOOT)], [U(BOOT), A, U('Fix it')]], squashed(BOOT)],
]
for (const [name, calls, want] of ASKS)
  test(`the question: ${name}`, async () => {
    const home = homeWith(calls.map((messages, i) => rec(i + 1, messages)))
    const doc = await query(home, 'session', { id: 'S' }), { sessions } = await query(home, 'sessions')
    assert.deepEqual([doc.lanes.find((l) => l.kind === 'main').task, doc.meta.title, sessions[0].title], [want, want, want])
  })

test('a wrapper goes by its shape: any name, with or without attributes, any space after it', () => {
  for (const n of ['system', 'EXTREMELY_IMPORTANT', 'environment_context', 'user-prompt.v2', 'ns:tag'])
    for (const a of ['', ' a="1"'])
      for (const sep of ['', '\n', '\n\n  '])
        assert.equal(askOf([`<${n}${a}>body</${n}>${sep}Fix it`]), 'Fix it', JSON.stringify([n, a, sep]))
})

for (const wire of ['http', 'chat', 'threads', 'ws'])
  test(`${wire}: a sub-agent's task skips the wrapper its first prompt opens with`, async () => {
    const home = path.join(tmpDir('trocar-lanetask-'), '.trocar')
    // one sub-agent lane: a sibling's departure line would hide the wrapper
    const s = bigSession({ home, wire, growth: 600, subEvery: 3, subLanes: 1, subLen: 100, preamble: '<boot>injected</boot>' })
    s.append(18)
    const recs = fs.readFileSync(s.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const subs = (await runQuery('session', { id: s.id }, { home })).lanes.filter((l) => l.kind === 'subagent')
    assert.equal(subs.length, 1)
    for (const l of subs) {
      // the prompt as a wire reader takes it, wrapper and all: what is left of it is where the task starts
      const want = firstAskOf(recs[Number(String(l.first).split(':').pop()) - 1], recs).replace('<boot>injected</boot> ', '').replace(/…$/, '')
      assert.ok(want && l.task && l.task.startsWith(want), `lane ${l.lane}: ${l.task}`)
    }
  })

for (const text of ['<boot>a</boot>\nFix it', '<boot>a</boot>'])
  test(`the turn keeps its text: ${JSON.stringify(text)}`, async () => {
    const home = homeWith([rec(1, [U(text)])])
    const { lanes } = await query(home, 'session', { id: 'S' })
    const page = await query(home, 'lane', { id: 'S', lane: lanes.find((l) => l.kind === 'main').lane })
    assert.deepEqual(Object.values(page.steps[0].attrs).map((a) => a.query).filter(Boolean), [squashed(text)])
    assert.equal(page.events.filter((e) => e.type === 'user').length, 1)
  })

test('a task is cut at TASK_MAX code points and says so with …; never inside a surrogate pair; one that fits is the squashed text', () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
  assert.equal(taskOf('  fix   the\n\ttest  '), 'fix the test')
  assert.equal(taskOf(''), null)
  assert.equal(taskOf('   '), null)
  for (const unit of ['a', '你', '😀', 'a😀']) for (const n of [TASK_MAX - 1, TASK_MAX, TASK_MAX + 1, 3 * TASK_MAX]) {
    const text = unit.repeat(n), at = `${JSON.stringify(unit)} × ${n}`, whole = Array.from(text)
    const t = taskOf(text), cps = Array.from(t)
    assert.ok(!lone.test(t), `${at}: no half of a surrogate pair`)
    assert.ok(cps.length <= TASK_MAX, `${at}: ${cps.length} code points`)
    if (whole.length <= TASK_MAX) assert.equal(t, text, `${at}: fits, kept whole`)
    else { assert.ok(t.endsWith('…'), `${at}: a cut says so`); assert.ok(text.startsWith(t.slice(0, -1)), `${at}: the cut is a prefix`) }
  }
})
