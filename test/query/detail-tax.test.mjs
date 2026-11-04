// test/query/detail-tax.test.mjs — `detail.tax` of the `lane` answer (RFC 3.5 §会话读, #46): a step's context in the four segments of
// 2.2 §组成:段权重. The reference below is the 2.2 wording, applied to the list a client rebuilds from the answer's ops, definitions and
// attrs, on sessions generated along the axes the boundary depends on.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { SEVEN } from '../helpers/seven-shapes.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { PACK_MEMBERS } from '../../src/query/ctx-files.mjs'

const homeOf = (p) => { const home = path.join(tmpDir(p), '.trocar'); fs.mkdirSync(path.join(home, 'raw'), { recursive: true }); return home }
const q = (name, home, params) => runQuery(name, params, { home, fs })
const shape = (harness) => SEVEN.find((x) => x.harness === harness)
const REMINDER = '<system-reminder>not a person</system-reminder>'
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0)

// A conversation as wire-neutral turns, on the two ways a request body carries them.
const ask = (text) => ({ ask: text }), say = (text) => ({ say: text })
const call = (n) => ({ call: n }), result = (n) => ({ result: n })
const WIRES = {
  cc: {
    turn: (t) => (t.ask != null ? { role: 'user', content: t.ask } : t.say != null ? { role: 'assistant', content: t.say }
      : t.call != null ? { role: 'assistant', content: [{ type: 'tool_use', id: `t${t.call}`, name: 'Read', input: { file_path: `/f${t.call}` } }] }
        : { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${t.result}`, content: `file ${t.result}` }] }),
    body: ({ turns, system, tools }) => ({ model: 'mock-model', max_tokens: 64, ...(system ? { system } : null), ...(tools ? { tools } : null), messages: turns }),
    tool: { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
    reply: { id: 'msg_1', model: 'mock-model', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 9, output_tokens: 2 } },
  },
  opencode: {
    turn: (t) => (t.ask != null ? { role: 'user', content: t.ask } : t.say != null ? { role: 'assistant', content: t.say }
      : t.call != null ? { role: 'assistant', content: null, tool_calls: [{ id: `t${t.call}`, type: 'function', function: { name: 'read', arguments: `{"p":${t.call}}` } }] }
        : { role: 'tool', tool_call_id: `t${t.result}`, content: `file ${t.result}` }),
    body: ({ turns, system, tools }) => ({ model: 'mock-model', messages: [...(system ? [{ role: 'system', content: system }] : []), ...turns], ...(tools ? { tools } : null) }),
    tool: { type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object' } } },
    reply: { id: 'c1', model: 'mock-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 9, completion_tokens: 2 } },
  },
}
const envelope = (h, sid, i, reqBody, reply) => JSON.stringify({ ts: `2026-10-22T10:00:${String(i).padStart(2, '0')}.000Z`, endpoint: h.path.split('?')[0], method: 'POST',
  req_headers: { host: h.host, ...h.headers(sid) }, req_body: reqBody, resp: { status: 200, kind: 'json', body: reply }, id: `req_${i}`, ts_request: `2026-10-22T10:00:${String(i).padStart(2, '0')}.000Z`,
  is_llm_call: true, capture: 'transparent', host: h.host, traffic_class: 'llm', proc: { pid: 1, exe: `/x/${h.agent}`, agent: h.agent } })
// Each element of `bodies` is one call's request text.
function write(home, wire, bodies) {
  const h = shape(wire), sid = 'tax00000-4a1b-9c2d-000000000001'
  fs.writeFileSync(path.join(home, 'raw', '20261022T100000Z.ndjson'), bodies.map((b, i) => envelope(h, sid, i, b, WIRES[wire].reply)).join('\n') + '\n')
}
// One call per prefix length of `turns`: each call re-sends the one before it.
function session(p, wire, turns, cuts, { system = null, tools = false } = {}) {
  const home = homeOf(p), w = WIRES[wire]
  write(home, wire, cuts.map((n) => JSON.stringify(w.body({ turns: turns.slice(0, n).map(w.turn), system, tools: tools ? [w.tool] : null }))))
  return home
}

// The lanes of a home's one session: each step with its list rebuilt from the ops, a position being its definition and its attrs.
async function read(home) {
  const { sessions } = await q('sessions', home, {}), id = sessions[0].session_id, doc = await q('session', home, { id })
  const steps = []
  for (const { lane } of doc.lanes) {
    const page = await q('lane', home, { id, lane }), defs = new Map(page.defs.map((d) => [d.bid, d])), held = new Map()
    assert.equal(page.prev, null, 'the lane fits one page')
    for (const s of page.steps) {
      const parent = held.get(s.parent) || [], list = []
      for (const [op, ...a] of s.ops) {
        if (op === 0) list.push(...parent.slice(a[0], a[0] + a[1]))
        else for (const bid of a) list.push({ def: defs.get(bid), attrs: s.attrs[list.length] || {} })
      }
      held.set(s.rid, list)
      steps.push({ ...s, list })
    }
  }
  return { id, doc, steps, row: (rid) => doc.calls.find((c) => c.rid === rid) }
}
// 2.2 §组成:段权重: tools and system are their sections; the conversation's task is the last block with a query to the end, its history
// what comes before; with no query, all of it is the task.
function reference(list) {
  const isMsg = (x) => x.def.sec === 'messages'
  const t0 = list.findLastIndex((x) => isMsg(x) && x.attrs.query)
  const seg = (x, i) => (x.def.sec === 'tools' || x.def.sec === 'system' ? x.def.sec : isMsg(x) && i >= Math.max(t0, 0) ? 'task' : 'history')
  const chars = { tools: 0, system: 0, history: 0, task: 0 }, bytes = { ...chars }
  list.forEach((x, i) => { chars[seg(x, i)] += x.def.chars; bytes[seg(x, i)] += x.def.bytes })
  return { chars, bytes }
}

const CONVERSATIONS = {
  'query last': [[ask('first ask'), say('a reply'), ask('second ask')], [1, 3]],
  'query, then tool turns': [[ask('first ask'), say('a reply'), ask('second ask'), call(1), result(1), call(2), result(2)], [3, 5, 7]],
  'no query': [[ask(REMINDER), call(1), result(1), call(2), result(2)], [1, 3, 5]],
}
const AXES = Object.keys(WIRES).flatMap((wire) => Object.entries(CONVERSATIONS).flatMap(([name, [turns, cuts]]) => [false, true].flatMap((tools) => [null, 'You are the agent.'].map((system) => ({ wire, name, turns, cuts, tools, system })))))

test('3.5 #46 segments: every step\'s tax is the 2.2 split of its list; its bytes are the row\'s comp', async () => {
  for (const { wire, name, turns, cuts, tools, system } of AXES) {
    const what = `${wire} / ${name} / tools ${tools} / system ${!!system}`
    const { steps, row } = await read(session('trocar-tax-seg-', wire, turns, cuts, { tools, system }))
    assert.equal(steps.length, cuts.length, `${what}: a step a call`)
    for (const s of steps) {
      const { chars, bytes } = reference(s.list), { comp } = row(s.rid), tax = s.detail.tax
      assert.deepEqual(tax.chars, chars, `${what}: ${s.rid} chars`)
      assert.equal(tax.task, bytes.task, `${what}: ${s.rid} task bytes`)
      assert.equal(bytes.tools, comp.tools || 0, `${what}: ${s.rid} tools bytes = comp.tools`)
      assert.equal(bytes.system, comp.system || 0, `${what}: ${s.rid} system bytes = comp.system`)
      const history = sum(comp) - (comp.tools || 0) - (comp.system || 0) - tax.task
      assert.equal(history, bytes.history, `${what}: ${s.rid} history bytes = the comp's rest`)
      assert.ok(history >= 0, `${what}: ${s.rid} history bytes are no debt`)
    }
  }
})

test('3.5 #46 boundary: the task opens at the last block with a query; with none it is every message', async () => {
  const first = 'aaaa', reply = 'bbbbb', last = 'cccccc'
  for (const wire of Object.keys(WIRES)) {
    const opened = await read(session('trocar-tax-edge-', wire, [ask(first), say(reply), ask(last)], [3]))
    assert.deepEqual(opened.steps[0].detail.tax.chars, { tools: 0, system: 0, history: first.length + reply.length, task: last.length }, `${wire}: what came before the query is history`)
    const on = await read(session('trocar-tax-edge-', wire, [ask(first), say(reply), ask(last), call(1), result(1)], [5]))
    assert.equal(on.steps[0].detail.tax.chars.history, first.length + reply.length, `${wire}: tool turns after the query stay in the task`)
    assert.ok(on.steps[0].detail.tax.chars.task > last.length, `${wire}: tool turns after the query are the task's`)
    const none = await read(session('trocar-tax-edge-', wire, [ask(REMINDER), say(reply), ask(REMINDER)], [3]))
    assert.deepEqual(none.steps[0].detail.tax.chars, { tools: 0, system: 0, history: 0, task: 2 * REMINDER.length + reply.length }, `${wire}: no query, every message is the task`)
  }
})

test('3.5 #46 allVerbatim: false when a tool definition was kept only as metadata, true otherwise', async () => {
  const kept = WIRES.cc.tool, metadata = { name: 'OldTool', input_schema_props: ['command'], description_chars: 812 }
  const tax = async (tools) => {
    const home = homeOf('trocar-tax-meta-')
    write(home, 'cc', [JSON.stringify(WIRES.cc.body({ turns: [{ role: 'user', content: 'hi' }], system: 'You are the agent.', tools }))])
    return (await read(home)).steps[0].detail.tax
  }
  assert.equal((await tax([metadata, kept])).allVerbatim, false)
  assert.equal((await tax([kept])).allVerbatim, true)
  assert.equal((await tax(null)).allVerbatim, true, 'no tools: nothing is short of verbatim')
})

test('3.5 #46 no blocks: a step whose request did not parse says tax null, the key there', async () => {
  const home = homeOf('trocar-tax-none-')
  write(home, 'cc', ['{"model":"mock-model","messages":[{"role":"us', JSON.stringify(WIRES.cc.body({ turns: [{ role: 'user', content: 'hi' }] }))])
  const { steps, row } = await read(home)
  const [cut] = steps.filter((s) => row(s.rid).unparsed)
  assert.ok(cut, 'the unparsed call is a step')
  assert.ok('tax' in cut.detail)
  assert.equal(cut.detail.tax, null)
  assert.ok(steps.some((s) => s.detail.tax), 'a step that parsed has one')
})

test('3.5 #46 one value: a rid\'s tax is the same on the tail page, `--from`, `--pack` and `--tail`', { timeout: 300_000 }, async () => {
  const home = homeOf('trocar-tax-ways-'), s = bigSession({ home, wire: 'http', growth: 200, subEvery: 7, compactAt: 20_000 })
  s.append(PACK_MEMBERS + 60)
  const id = s.id, { lanes } = await q('session', home, { id })
  const stepsOf = (text) => text.trimEnd().split('\n').map((l) => JSON.parse(l)).filter((o) => o.s).map((o) => o.s)
  // every lane: the tail page, and the pages before it by `--to`; `--from` its first step
  const whole = new Map(), from = []
  for (const { lane } of lanes) {
    const pages = [await q('lane', home, { id, lane })]
    while (pages.at(-1).prev != null) pages.push(await q('lane', home, { id, lane, to: pages.at(-1).prev }))
    for (const x of pages.flatMap((p) => p.steps)) whole.set(x.rid, x.detail.tax)
    from.push(...(await q('lane', home, { id, lane, from: pages.at(-1).steps[0].rid })).steps)
  }
  const file = async (params) => stepsOf((await q('lane', home, { id, ...params })).$text)
  const ways = { '--from': from, '--pack': [...await file({ pack: '0.main' }), ...await file({ pack: '0.rest' })], '--tail': [...await file({ tail: 'main' }), ...await file({ tail: 'rest' })] }
  for (const [way, steps] of Object.entries(ways)) {
    assert.ok(steps.length, `${way}: answers steps`)
    for (const x of steps) {
      assert.ok(x.detail.tax, `${way} ${x.rid}: a step with blocks`)
      assert.deepEqual(x.detail.tax, whole.get(x.rid), `${way} ${x.rid}: the pages' tax`)
    }
  }
})
