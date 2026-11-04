// test/query/titles.test.mjs — `sessions` knows every title when it lists a session (RFC 3.5 §访问模式 · #40 · #41, 4.2 §标题表, 4.4
// §人类标题的来源, D78 ①): out of the title table, or computed on the spot from a session's first model calls, the same text `session`
// says in `meta.title`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { within } from '../helpers/bounded.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { SEVEN } from '../helpers/seven-shapes.mjs'
import { bigSession, firstAskOf, rng } from './big-session.mjs'
import { runQuery, stampOf } from '../../src/query/named/index.mjs'
import { extendSession } from '../../src/query/named/session.mjs'
import { readHead } from '../../src/query/ctx-files.mjs'
import { TITLE_BUDGET_MS, TITLE_V, titlesFile } from '../../src/query/titles.mjs'
import { answer } from '../../src/query/answers.mjs'
import { fillUsage, usageFile } from '../../src/query/usage.mjs'
import { indexDir, segmentIndex } from '../../src/query/index-build.mjs'
import { createQueryService } from '../../src/query/service.mjs'

const SEG = '20261022T100000Z'
const homeOf = () => { const home = path.join(tmpDir('trocar-titles-'), '.trocar'); fs.mkdirSync(path.join(home, 'raw'), { recursive: true }); return home }
const rawFile = (home) => path.join(home, 'raw', `${SEG}.ndjson`)
const append = (home, lines) => fs.appendFileSync(rawFile(home), lines.join('\n') + '\n')
// A filesystem of its own: the tables and rows a test reads through it start cold, as in a process that has just started.
const cold = () => Object.create(fs)
const listOf = async (home, ctx = {}, params = {}) => runQuery('sessions', params, { home, fs: cold(), ...ctx })
const metaOf = async (home, id) => (await runQuery('session', { id, limit: 500 }, { home, fs: cold() })).meta
const saved = async (home, ctx = {}) => {
  const queue = []
  const doc = await runQuery('sessions', {}, { home, ...ctx, later: (fn) => queue.push(fn) })
  for (const fn of queue) await fn()
  return doc
}
const table = (home) => JSON.parse(fs.readFileSync(titlesFile(home), 'utf8'))

let n = 0
const stamp = (i) => new Date(Date.parse('2026-10-22T10:00:00Z') + i * 1000).toISOString()
const envelope = (h, sid, body, resp, ts, headers = {}) => JSON.stringify({ ts, endpoint: h.path.split('?')[0], method: 'POST', req_headers: { host: h.host, ...h.headers(sid), ...headers }, req_body: body,
  resp: { status: 200, kind: 'json', body: resp }, id: `req_${++n}`, ts_request: ts, is_llm_call: true, capture: 'transparent', host: h.host, traffic_class: 'llm',
  proc: { pid: 1, exe: `/x/${h.agent}`, agent: h.agent } })
const replyTo = (h, t) => (h.wire === 'anthropic'
  ? { id: `msg_${t}`, model: 'mock-model', stop_reason: 'end_turn', content: [{ type: 'text', text: `a${t}` }], usage: { input_tokens: 10, output_tokens: 5 } }
  : { id: `c_${t}`, model: 'mock-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `a${t}` } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
const MONITOR = JSON.stringify({ model: 'mock-model', max_tokens: 64, system: [{ type: 'text', text: 'You are a security monitor for autonomous agents.' }],
  messages: [{ role: 'user', content: 'Review this action: rm -rf build' }] })

// One session per HTTP shape, four turns. `lead`: calls of another lane at the head of the Claude Code session.
function sevenHome({ lead = [] } = {}) {
  const home = homeOf(), lines = []
  let i = 0
  for (const h of SEVEN.filter((x) => x.body)) {
    const sid = `seven-${h.harness}-4a1b-9c2d-000000000001`
    if (h.harness === 'cc') for (const l of lead) lines.push(envelope(h, sid, l.body, replyTo(h, i), stamp(i++), l.headers))
    for (let t = 0; t < 4; t++) lines.push(envelope(h, sid, h.body(sid, t), replyTo(h, t), stamp(i++)))
  }
  append(home, lines)
  return home
}
const agreesWithSession = async (home) => {
  const doc = await listOf(home)
  assert.deepEqual(doc.errors, [])
  for (const s of doc.sessions) {
    const meta = await metaOf(home, s.session_id)
    assert.equal(s.title, meta.title, s.session_id)
    assert.equal(s.title_source, s.title == null ? null : 'wire', s.session_id)
  }
  return doc
}
const noProjections = (home) => {
  assert.equal(fs.existsSync(titlesFile(home)), false, 'the one-shot path writes no table')
  assert.deepEqual(fs.readdirSync(indexDir(home)).filter((f) => f.endsWith('.usage.json')), [], 'no usage sidecar was there to read')
}

test('3.5 #40: on the seven-shape home, with no table and no sidecars, the first `sessions` has every title, and it is `session`\'s', async () => {
  const home = sevenHome()
  const doc = await agreesWithSession(home)
  assert.equal(doc.sessions.length, SEVEN.filter((x) => x.body).length)
  for (const s of doc.sessions) assert.match(s.title, /^q0 for /, s.session_id)
  fs.mkdirSync(indexDir(home), { recursive: true })
  noProjections(home)
})

for (const wire of ['http', 'chat', 'threads', 'ws']) {
  test(`3.5 #40: ${wire}: the first \`sessions\` of a long session has its first prompt, and it is \`session\`'s`, async () => {
    const home = homeOf()
    const s = bigSession({ home, wire, growth: 600, subEvery: 3, segment: SEG })
    s.append(9)
    const recs = fs.readFileSync(s.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const doc = await agreesWithSession(home)
    const want = firstAskOf(recs[0], recs)
    assert.ok(want, 'the generator wrote a prompt')
    assert.deepEqual(doc.sessions.map((m) => [m.session_id, m.title, m.title_source]), [[s.id, want, 'wire']])
  })

  // the subagents' calls come first in the session and in the file, so the main call is past the first read, or past the second
  // `marked` is an Anthropic wire's. On Message Threads the marker rides on a thread's create only: past the first read a subagent's
  // continuation is told by the calls before it, so a read must fold them too
  for (const lead of [6, 30]) for (const marked of wire === 'http' || wire === 'threads' ? [false, true] : [false]) {
    test(`3.5 #40: ${wire}: ${lead} subagent calls${marked ? ' told by their system marker' : ''} before the first main call: the title is still the main prompt`, async () => {
      const home = homeOf()
      const s = bigSession({ home, wire, growth: 300, subEvery: 0, subLanes: 2, quiet: [0, lead], marked, segment: SEG })
      s.append(lead + 3)
      const recs = fs.readFileSync(s.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      const doc = await agreesWithSession(home)
      assert.equal(doc.sessions[0].title, firstAskOf(recs[lead], recs), 'the first call past the subagents\' is the main one')
    })

    test(`4.2 §标题表: ${wire}: ${lead} subagent calls${marked ? ' told by their system marker' : ''} listed first, the main call appended after: the table reads on to \`session\`'s title`, async () => {
      const home = homeOf(), warm = cold()
      const s = bigSession({ home, wire, growth: 300, subEvery: 0, subLanes: 2, quiet: [0, lead], marked, segment: SEG })
      s.append(lead)
      const first = JSON.parse(fs.readFileSync(s.file, 'utf8').split('\n')[0])
      assert.deepEqual((await saved(home, { fs: warm })).sessions.map((m) => m.title), [firstAskOf(first, [first])], 'no main call yet: the first subagent lane\'s task')
      s.append(Math.max(3, Math.ceil(lead / 8)))
      const recs = fs.readFileSync(s.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      assert.deepEqual((await saved(home, { fs: warm })).sessions.map((m) => m.title), [firstAskOf(recs[lead], recs)])
      assert.deepEqual((await listOf(home)).sessions.map((m) => m.title), [(await metaOf(home, s.id)).title], 'from the file, as from memory')
    })
  }

  test(`3.5 #40: ${wire}: the main call is written after the calls it started before`, async () => {
    const home = homeOf()
    const s = bigSession({ home, wire, growth: 300, subEvery: 2, hold: { 0: 7 }, segment: SEG })
    s.append(9)
    const doc = await agreesWithSession(home)
    assert.ok(doc.sessions[0].title, 'the generator wrote a main prompt')
    const main = (await runQuery('session', { id: s.id, limit: 500 }, { home })).lanes.find((l) => l.kind === 'main')
    assert.ok(Number(String(main.first).split(':').pop()) > 1, 'the main call is not the first line')
  })
}

test('3.5 #40: background and monitor calls at the head of a session: the title is the main prompt', async () => {
  for (const count of [1, 4, 5, 21]) {
    const lead = Array.from({ length: count }, (_, i) => (i % 2
      ? { body: JSON.stringify({ model: 'mock-model', max_tokens: 64, system: 'Summarize.', messages: [{ role: 'user', content: `summary ${i}` }] }), headers: { 'x-claude-code-request-class': 'auxiliary' } }
      : { body: MONITOR }))
    const home = sevenHome({ lead })
    const doc = await agreesWithSession(home)
    assert.match(doc.sessions.find((s) => s.session_id.startsWith('seven-cc-')).title, /^q0 for /, `${count} calls ahead of it`)
  }
})

test('3.5 #40 · #41: through a real worker the document is the local one, and the table then holds every session; the next `sessions` opens no raw file; without the table the answer is the same', { timeout: 60_000 }, async () => {
  const home = sevenHome()
  await segmentIndex({ home, segment: SEG, owner: true })
  const local = await listOf(home)
  const svc = createQueryService({ home, fork: workerFork, idleMs: 20_000 })
  let worked = null
  try {
    worked = await within((async () => {
      for (;;) {
        const chunks = []
        let status = null
        const res = { headersSent: false, writeHead: (s) => { status = s; res.headersSent = true }, write: (b) => { chunks.push(b); return true }, end: () => {}, once: () => {} }
        await svc.route({ query: new URLSearchParams({ name: 'sessions' }), res })
        if (status === 200) return JSON.parse(Buffer.concat(chunks).toString('utf8'))
        await new Promise((d) => setTimeout(d, 50))
      }
    })(), 30_000, 'the worker answered')
    await within((async () => { while (!fs.existsSync(titlesFile(home))) await new Promise((d) => setTimeout(d, 20)) })(), 10_000, 'the worker wrote the table')
  } finally { svc.stop() }
  assert.deepEqual(worked, local)

  const { v, titles } = table(home)
  assert.equal(v, TITLE_V)
  assert.equal(fs.statSync(titlesFile(home)).mode & 0o777, 0o600)
  assert.deepEqual(Object.keys(titles).sort(), local.sessions.map((s) => s.session_id).sort())
  for (const s of local.sessions) assert.equal(titles[s.session_id].t, s.title, s.session_id)

  // the rows warm through this filesystem first, so what is counted is what the titles read
  let opened = 0
  const counting = Object.assign(cold(), { openSync: (f, ...a) => { if (String(f).startsWith(path.join(home, 'raw'))) opened++; return fs.openSync(f, ...a) } })
  await runQuery('segments', {}, { home, fs: counting })
  opened = 0
  assert.deepEqual(await listOf(home, { fs: counting }), local)
  assert.equal(opened, 0, 'no record was read')

  fs.writeFileSync(titlesFile(home), JSON.stringify({ v: TITLE_V + 1, titles: { [local.sessions[0].session_id]: { t: 'other', r: null, c: 0, m: 1e9 } } }))
  assert.deepEqual(await listOf(home), local, 'another version is an empty table')
  fs.writeFileSync(titlesFile(home), '{ not json')
  assert.deepEqual(await listOf(home), local, 'an unreadable table is an empty one')
  fs.unlinkSync(titlesFile(home))
  assert.deepEqual(await listOf(home), local, 'no table')
})

// Calls of a session arrive one by one, each with a time of its own, so a call lands before, between or after the calls already there:
// whatever the table holds, warm or read back from its file, the list says what `session` says.
const CC = SEVEN.find((x) => x.harness === 'cc')
const anth = (messages) => JSON.stringify({ ...JSON.parse(CC.body('s', 0)), messages }) // a conversation's call: the system prompt and the tools every one carries
const KINDS = [
  (i) => ({ body: anth([{ role: 'user', content: `prompt ${i}` }]) }),
  (i) => ({ body: anth([{ role: 'user', content: `prompt ${i}` }]) }),
  () => ({ body: MONITOR }),
  (i) => ({ body: anth([{ role: 'user', content: `sub ${i}` }]), headers: { 'x-claude-code-agent-id': `agent-${i % 2}` } }),
  (i) => ({ body: anth([{ role: 'user', content: `aux ${i}` }]), headers: { 'x-claude-code-request-class': 'auxiliary' } }),
]
const rest = KINDS.slice(2)
for (let seed = 1; seed <= 6; seed++) {
  test(`3.5 #41: seed ${seed}: calls landing anywhere in a session keep \`sessions\` equal to \`session\`, from the table in memory and from its file`, async () => {
    const r = rng(seed), home = homeOf(), sid = `grow-${seed}-4a1b-9c2d-000000000001`
    const warm = cold()
    const titles = new Set(), sent = []
    let said = null
    for (let i = 0; i < 14; i++) {
      // a first run of calls of other lanes, so the list has read past calls with no main one; the main calls land in and before them
      const kind = i < 5 ? rest[Math.floor(r() * rest.length)] : KINDS[Math.floor(r() * KINDS.length)]
      const { body, headers } = kind(i), ts = stamp(Math.floor(r() * 10_000))
      append(home, [envelope(CC, sid, body, replyTo(CC, i), ts, headers)])
      sent.push({ ts, agent: headers?.['x-claude-code-agent-id'], main: !headers && body !== MONITOR, ask: JSON.parse(body).messages[0].content })
      const meta = await metaOf(home, sid)
      const live = await saved(home, { fs: warm })
      assert.deepEqual(live.errors, [])
      // the first main prompt; no main call: the first subagent lane's task, the first prompt in step order
      const inStep = [...sent].sort((a, b) => a.ts.localeCompare(b.ts)), whole = (inStep.find((c) => c.main) || inStep.find((c) => c.agent))?.ask ?? null
      // an entry with no main call stands until the session has an eighth more calls (4.2 §标题表): the title lags, no further
      const { r: found, c: read } = table(home).titles[sid]
      const want = found == null && sent.some((c) => c.main) && sent.length * 8 < read * 9 ? said : whole
      assert.equal(meta.title, want, `call ${i}, session`)
      assert.deepEqual(live.sessions.map((s) => [s.title, s.title_source]), [[want, want == null ? null : 'wire']], `call ${i}, warm`)
      assert.equal((await listOf(home)).sessions[0].title, want, `call ${i}, from the file`)
      titles.add(want)
      said = want
    }
    assert.ok(titles.size > 1, 'the generated rows moved the title')
  })
}

const subCall = (sid, ask, agent, i) => envelope(CC, sid, anth([{ role: 'user', content: ask }]), replyTo(CC, i), stamp(i), { 'x-claude-code-agent-id': agent })
// A filesystem whose raw files cannot be opened once `broken` is set.
const faultyFs = (home) => {
  const f = Object.assign(cold(), { broken: false, openSync: (p, ...a) => { if (f.broken && String(p).startsWith(path.join(home, 'raw'))) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); return fs.openSync(p, ...a) } })
  return f
}

test('4.2 §标题表: a growing session whose title stands does not rewrite the table', async () => {
  const home = homeOf(), sid = 'still-0000-4a1b-9c2d-000000000001', warm = cold()
  append(home, [envelope(CC, sid, anth([{ role: 'user', content: 'first prompt' }]), replyTo(CC, 0), stamp(0))])
  await saved(home, { fs: warm })
  const bytes = fs.readFileSync(titlesFile(home), 'utf8')
  append(home, [envelope(CC, sid, anth([{ role: 'user', content: 'first prompt' }, { role: 'assistant', content: 'a0' }, { role: 'user', content: 'next' }]), replyTo(CC, 1), stamp(1))])
  await saved(home, { fs: warm })
  assert.equal(fs.readFileSync(titlesFile(home), 'utf8'), bytes)
})

test('3.5 #41: a record that cannot be read and no entry: title null from `unread`, one `errors` entry, nothing in the table; the next read tries again', async () => {
  const home = homeOf(), sid = 'lost-0000-4a1b-9c2d-000000000001'
  append(home, [0, 1, 2, 3, 4, 5].map((t) => envelope(CC, sid, CC.body(sid, t), replyTo(CC, t), stamp(t))))
  await segmentIndex({ home, segment: SEG, owner: true })
  const faulty = faultyFs(home)
  await runQuery('segments', {}, { home, fs: faulty })
  faulty.broken = true
  const doc = await saved(home, { fs: faulty })
  assert.deepEqual(doc.sessions.map((s) => [s.title, s.title_source]), [[null, 'unread']])
  assert.deepEqual(doc.errors.map((e) => [e.where, e.code]), [[`session/${sid}`, 'record-unreadable']])
  assert.ok(!fs.existsSync(titlesFile(home)) || !(sid in table(home).titles), 'not in the table')
  faulty.broken = false
  const back = await saved(home, { fs: faulty })
  assert.deepEqual(back.errors, [])
  assert.deepEqual(back.sessions.map((s) => s.title), [(await metaOf(home, sid)).title])
  assert.ok(table(home).titles[sid].t, 'read again, it is kept')
})

test('3.5 #41: a record that cannot be read beside an entry with a title: the title stands, from the wire, one `errors` entry, the table as it was', async () => {
  const home = homeOf(), sid = 'kept-0000-4a1b-9c2d-000000000001', warm = faultyFs(home)
  append(home, [1, 2, 3].map((t) => envelope(CC, sid, CC.body(sid, t), replyTo(CC, t), stamp(t))))
  await segmentIndex({ home, segment: SEG, owner: true })
  const { sessions: [{ title }] } = await saved(home, { fs: warm })
  assert.ok(title, 'the table has it')
  const bytes = fs.readFileSync(titlesFile(home))
  append(home, [envelope(CC, sid, CC.body(sid, 0), replyTo(CC, 0), stamp(0))]) // sorts before the entry's call: the session is read again
  await segmentIndex({ home, segment: SEG, owner: true })
  await runQuery('segments', {}, { home, fs: warm })
  warm.broken = true
  const doc = await saved(home, { fs: warm })
  assert.deepEqual(doc.sessions.map((s) => [s.title, s.title_source]), [[title, 'wire']])
  assert.deepEqual(doc.errors.map((e) => [e.where, e.code]), [[`session/${sid}`, 'record-unreadable']])
  assert.deepEqual(fs.readFileSync(titlesFile(home)), bytes)
})

test('3.5 #40: a session of subagent calls only: the title is the task of the first lane in step order, from the wire, the entry names no main call; a main call then replaces it', async () => {
  const home = homeOf(), sid = 'subs-0000-4a1b-9c2d-000000000001', warm = cold()
  append(home, [subCall(sid, 'second', 'lane-b', 2), subCall(sid, 'first', 'lane-a', 1), subCall(sid, 'third', 'lane-b', 3)])
  const doc = await saved(home, { fs: warm })
  assert.deepEqual(doc.sessions.map((s) => [s.title, s.title_source]), [['first', 'wire']])
  assert.equal(table(home).titles[sid].r, null)
  append(home, [envelope(CC, sid, anth([{ role: 'user', content: 'the main prompt' }]), replyTo(CC, 4), stamp(4))])
  assert.deepEqual((await saved(home, { fs: warm })).sessions.map((s) => [s.title, s.title_source]), [['the main prompt', 'wire']])
  assert.notEqual(table(home).titles[sid].r, null)
})

test('3.5 #40: a session of subagent calls only says the title `sessions` says at tier 0, on the head and on `session`', async () => {
  const home = homeOf(), sid = 'subs-0000-4a1b-9c2d-000000000002'
  append(home, [subCall(sid, 'second', 'lane-b', 2), subCall(sid, 'first', 'lane-a', 1), subCall(sid, 'third', 'lane-b', 3)])
  const said = ({ title, title_source }) => ({ title, title_source }), listed = said((await listOf(home)).sessions[0])
  assert.deepEqual(listed, { title: 'first', title_source: 'wire' })
  let fail = true
  const failing = Object.assign(cold(), { openSync: (f, ...a) => { if (fail && String(f).includes(`${path.sep}ctx${path.sep}`)) { fail = false; throw new Error('injected: the projection could not be read') } return fs.openSync(f, ...a) } })
  await assert.rejects(extendSession({ home, fs: failing, writer: true }, sid, 10))
  const tier0 = readHead(home, sid)
  assert.equal(tier0.tier, 0)
  assert.deepEqual(said(tier0.meta), listed)
  const ctx = { home, fs: cold(), writer: true }
  while (await extendSession(ctx, sid, 1_000));
  const head = readHead(home, sid)
  assert.equal(head.tier, 1)
  assert.deepEqual(said(head.meta), listed)
  assert.deepEqual(said((await runQuery('session', { id: sid }, ctx)).meta), listed)
})

test('3.5 #40: a head at a first slice short of the first main call has the title', async () => {
  const home = homeOf(), sid = 'late-0000-4a1b-9c2d-000000000001', pad = 'x'.repeat(1 << 19)
  // a slice extracts a chunk of stored bytes: these subagent calls are more than one, the main call is past it
  append(home, Array.from({ length: 20 }, (_, i) => envelope(CC, sid, anth([{ role: 'user', content: `task ${i}` }, { role: 'assistant', content: 'a' }, { role: 'user', content: pad }]), replyTo(CC, i), stamp(i), { 'x-claude-code-agent-id': 'lane-a' })))
  append(home, [envelope(CC, sid, anth([{ role: 'user', content: 'the main prompt' }]), replyTo(CC, 20), stamp(20))])
  const wait = new Int32Array(new SharedArrayBuffer(4)), slow = Object.assign(cold(), { burn: false, openSync: (f, ...a) => { if (slow.burn && String(f).startsWith(path.join(home, 'raw'))) Atomics.wait(wait, 0, 0, 60); return fs.openSync(f, ...a) } })
  const ctx = { home, fs: slow, writer: true }, { sessions: [listed] } = await runQuery('sessions', {}, ctx)
  assert.equal(listed.title, 'the main prompt')
  slow.burn = true
  const head = await runQuery('session', { id: sid, head: true }, ctx)
  assert.ok(head.tier === 1 && head.pending, 'tier 1, short of the end')
  assert.ok(!head.lanes.some((l) => l.kind === 'main'), 'short of the main call')
  assert.deepEqual([head.meta.title, head.meta.title_source], [listed.title, listed.title_source])
})

for (const read of [2, 3, 8, 9, 16, 40]) {
  test(`4.2 §标题表: ${read} calls read and no main one: no record is read again until the session has an eighth more calls`, async () => {
    const home = homeOf(), sid = 'lags-0000-4a1b-9c2d-000000000001'
    let opened = 0
    const counting = Object.assign(cold(), { openSync: (f, ...a) => { if (String(f).startsWith(path.join(home, 'raw'))) opened++; return fs.openSync(f, ...a) } })
    const grown = async (i) => {
      append(home, [subCall(sid, `task ${i}`, 'lane-a', i)])
      await runQuery('segments', {}, { home, fs: counting }) // the rows warm first, so what is counted is what the titles read
      opened = 0
      await saved(home, { fs: counting })
    }
    append(home, Array.from({ length: read - 1 }, (_, i) => subCall(sid, `task ${i}`, 'lane-a', i)))
    await grown(read - 1)
    let calls = read
    while ((calls + 1) * 8 < read * 9) { await grown(calls++); assert.equal(opened, 0, `at ${calls} calls`) }
    await grown(calls++)
    assert.ok(opened > 0, `at ${calls} calls`)
    assert.equal(table(home).titles[sid].c, calls)
  })
}

test('3.5 §访问模式: in the worker a page of titles gives way at the budget, a title further each ask, what was computed saved; the one-shot path answers at once', async () => {
  const home = sevenHome(), wait = new Int32Array(new SharedArrayBuffer(4))
  await segmentIndex({ home, segment: SEG, owner: true })
  const local = await listOf(home)
  const slowFs = () => {
    const slow = Object.assign(cold(), { burn: false, openSync: (f, ...a) => { if (slow.burn && String(f).startsWith(path.join(home, 'raw'))) Atomics.wait(wait, 0, 0, TITLE_BUDGET_MS + 20); return fs.openSync(f, ...a) } })
    return slow
  }
  const warmed = async () => { const f = slowFs(); await runQuery('segments', {}, { home, fs: f }); f.burn = true; return f }

  const inWorker = await warmed(), queue = []
  const ask = () => answer({ name: 'sessions' }, { home, fs: inWorker, writer: true, later: (fn) => queue.push(fn) })
  let got = await ask(), gaveWay = 0
  while (got.status === 102) {
    gaveWay++
    assert.ok(gaveWay <= local.sessions.length, 'each ask computes a title')
    assert.equal(got.bytes.length, 0)
    for (const fn of queue.splice(0)) await fn()
    assert.ok(Object.keys(table(home).titles).length >= gaveWay, 'the titles computed are in the table')
    got = await ask()
  }
  assert.ok(gaveWay > 0, 'the list gave way')
  assert.equal(got.status, 200)
  assert.deepEqual(JSON.parse(got.bytes), local)

  fs.unlinkSync(titlesFile(home))
  const oneShot = await answer({ name: 'sessions' }, { home, fs: await warmed() })
  assert.equal(oneShot.status, 200)
  assert.deepEqual(JSON.parse(oneShot.bytes), local)
})

test('3.5 §访问模式: a window that narrows to later rows leaves the title as it is', async () => {
  const home = sevenHome()
  const all = await listOf(home)
  for (const s of all.sessions) {
    const narrowed = await listOf(home, {}, { since: s.last_ts })
    assert.equal(narrowed.sessions.find((x) => x.session_id === s.session_id).title, s.title, s.session_id)
  }
})

test('4.4 §人类标题的来源: a session whose main calls carry no prompt: title and title_source null, and nothing to report', async () => {
  const home = homeOf(), sid = 'mute-0000-4a1b-9c2d-000000000001'
  const mute = (i) => envelope(CC, sid, anth([{ role: 'assistant', content: 'nothing asked' }]), replyTo(CC, i), stamp(i))
  append(home, [mute(0), mute(1)])
  const doc = await agreesWithSession(home)
  assert.deepEqual(doc.sessions.map((s) => [s.title, s.title_source]), [[null, null]])
})

test('4.4 §条件 GET: the sessions stamp moves when the title table is written, not when a usage sidecar is', async () => {
  const home = sevenHome(), ctx = { home, env: {}, fs: cold() }
  await segmentIndex({ home, segment: SEG, owner: true })
  const before = stampOf('sessions', {}, ctx)
  await fillUsage({ home, segments: [SEG] })
  assert.ok(fs.existsSync(usageFile(home, SEG)), 'the sidecar is there')
  assert.equal(stampOf('sessions', {}, ctx), before)
  await saved(home, { fs: ctx.fs })
  assert.notEqual(stampOf('sessions', {}, ctx), before)
})
