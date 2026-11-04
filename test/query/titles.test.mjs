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
import { TITLE_V, titlesFile } from '../../src/query/titles.mjs'
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
      assert.deepEqual((await saved(home, { fs: warm })).sessions.map((m) => m.title), [null])
      s.append(3)
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
    const titles = new Set()
    for (let i = 0; i < 14; i++) {
      // a first run of calls of other lanes, so the list has read past calls with no main one; the main calls land in and before them
      const kind = i < 5 ? rest[Math.floor(r() * rest.length)] : KINDS[Math.floor(r() * KINDS.length)]
      const { body, headers } = kind(i)
      append(home, [envelope(CC, sid, body, replyTo(CC, i), stamp(Math.floor(r() * 10_000)), headers)])
      const meta = await metaOf(home, sid)
      const live = await saved(home, { fs: warm })
      assert.deepEqual(live.errors, [])
      assert.deepEqual(live.sessions.map((s) => [s.title, s.title_source]), [[meta.title, meta.title == null ? null : 'wire']], `call ${i}, warm`)
      assert.equal((await listOf(home)).sessions[0].title, meta.title, `call ${i}, from the file`)
      titles.add(meta.title)
    }
    assert.ok(titles.size > 1, 'the generated rows moved the title')
  })
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

test('3.5 #41: a record that cannot be read: title null, one `errors` entry, nothing in the table; the next read tries again', async () => {
  const home = homeOf(), sid = 'lost-0000-4a1b-9c2d-000000000001'
  append(home, [0, 1, 2, 3, 4, 5].map((t) => envelope(CC, sid, CC.body(sid, t), replyTo(CC, t), stamp(t))))
  await segmentIndex({ home, segment: SEG, owner: true })
  let broken = false
  const faulty = Object.assign(cold(), { openSync: (f, ...a) => { if (broken && String(f).startsWith(path.join(home, 'raw'))) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); return fs.openSync(f, ...a) } })
  await runQuery('segments', {}, { home, fs: faulty })
  broken = true
  const doc = await saved(home, { fs: faulty })
  assert.deepEqual(doc.sessions.map((s) => [s.title, s.title_source]), [[null, null]])
  assert.deepEqual(doc.errors.map((e) => [e.where, e.code]), [[`session/${sid}`, 'record-unreadable']])
  assert.ok(!fs.existsSync(titlesFile(home)) || !(sid in table(home).titles), 'not in the table')
  broken = false
  const back = await saved(home, { fs: faulty })
  assert.deepEqual(back.errors, [])
  assert.deepEqual(back.sessions.map((s) => s.title), [(await metaOf(home, sid)).title])
  assert.ok(table(home).titles[sid].t, 'read again, it is kept')
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
