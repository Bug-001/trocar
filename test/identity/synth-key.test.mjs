// Synthesized session keys (3.4 合成键): the anchor a keyless call is grouped by, and the rule over time.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createSynthKeys, stampSynthKeys, SYNTH_GAP_MS } from '../../src/dissect/synth-key.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { rawHome, writeSegment } from '../query/raw-home.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { indexRows } from '../../src/query/rows.mjs'
import { fillUsage } from '../../src/query/usage.mjs'
import { groupSessions, sessionView } from '../../src/view/board.mjs'

const T0 = Date.parse('2026-10-18T10:00:00.000Z')
const sha12 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12)
const EMPTY = sha12('')
const KEY = /^synth-([a-z0-9-]+?)-([0-9a-f]{12})-\d{8}T\d{6}Z$/

// one captured call as the collector writes it (src/capture/envelope.mjs field names)
const call = ({ agent, host, path, body, ms, pid = 7, headers = {} }) => ({
  id: 'r', ts: new Date(ms).toISOString(), ts_request: new Date(ms).toISOString(), endpoint: path, method: 'POST', host,
  req_headers: { 'content-type': 'application/json', ...headers }, req_body: JSON.stringify(body),
  resp: { status: 200, kind: 'json' }, is_llm_call: true, capture: 'transparent', traffic_class: 'llm',
  proc: { pid, exe: '/x', agent },
})

test('systemTextOf: the first system / developer item of a Responses input is the anchor', () => {
  // keyless pi openai-responses calls: no session_id header, no prompt_cache_key
  const piResp = (item, ms = T0) => call({ agent: 'pi', host: 'api.openai.com', path: '/v1/responses', ms,
    headers: { 'user-agent': 'pi/1.4.0 (darwin; node/v22.23.3; arm64)' },
    body: { model: 'm', input: [item, { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] } })
  const shapes = { string: (t) => t, parts: (t) => [{ type: 'input_text', text: t }] }
  const prompts = ['You are pi, a coding agent.', 'You are pi. Another task entirely.']
  for (const role of ['developer', 'system']) {
    for (const [shape, content] of Object.entries(shapes)) {
      const recs = prompts.map((p) => piResp({ role, content: content(p) }))
      stampSynthKeys(recs)
      const keys = recs.map((r) => r._synthKey)
      assert.notEqual(keys[0], keys[1], `${role}/${shape}: two prompts, two sessions`)
      keys.forEach((k, i) => {
        const m = KEY.exec(k || '')
        assert.ok(m, `${role}/${shape}: a synthesized key (${k})`)
        assert.equal(m[1], 'pi')
        assert.equal(m[2], sha12(prompts[i]), `${role}/${shape}: the key hashes the prompt text`)
        assert.notEqual(m[2], EMPTY)
      })
    }
  }
})

test('synthesized keys: consecutive keyless calls of one task form one session; a new system prompt or a 30-minute gap starts another; never by pid', async () => {
  // keyless Hermes chat calls on a custom endpoint
  const hermes = (prompt, ms, pid) => call({ agent: 'hermes', host: 'llm.internal.test', path: '/v1/chat/completions', ms, pid,
    body: { model: 'm', messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'turn' }] } })
  // pairs along the axes: the second call's gap (below / above the window), prompt (same / new), pid (same / other)
  const recs = []
  const pairs = []
  let base = T0
  let i = 0
  for (const gap of [SYNTH_GAP_MS / 2, SYNTH_GAP_MS + 60_000]) {
    for (const samePrompt of [true, false]) {
      for (const samePid of [true, false]) {
        const p = `You are Hermes. Task ${i++}.`
        const a = hermes(p, base, 7)
        const b = hermes(samePrompt ? p : `${p} Another.`, base + gap, samePid ? 7 : 8)
        pairs.push({ a, b, together: samePrompt && gap <= SYNTH_GAP_MS })
        recs.push(a, b)
        base += 3 * SYNTH_GAP_MS
      }
    }
  }
  // two tasks interleaved on one pid stay apart
  const A = `You are Hermes. Task ${i++}.`, B = `You are Hermes. Task ${i++}.`
  const inter = [0, 1, 2, 3, 4, 5].map((n) => ({ task: n % 2 ? B : A, r: hermes(n % 2 ? B : A, base + n * 60_000, 7) }))
  recs.push(...inter.map((x) => x.r))
  recs.sort((x, y) => Date.parse(x.ts_request) - Date.parse(y.ts_request))

  const k = createSynthKeys()
  const keyOf = new Map(recs.map((r) => [r, k.keyOf(r)]))
  for (const r of recs) assert.match(keyOf.get(r) || '', KEY)
  for (const { a, b, together } of pairs) {
    assert.equal(keyOf.get(a) === keyOf.get(b), together, `${a.req_body} → ${b.req_body} (pid ${a.proc.pid}→${b.proc.pid})`)
  }
  for (const x of inter) for (const y of inter) assert.equal(keyOf.get(x.r) === keyOf.get(y.r), x.task === y.task)

  // the query lists the same sessions, each marked synthesized
  const home = rawHome('trocar-synth-')
  writeSegment(home, '20261018T100000Z', recs.map((r) => JSON.stringify(r)))
  const doc = await runQuery('sessions', { limit: '500' }, { home })
  assert.deepEqual(doc.errors, [])
  assert.deepEqual(new Set(doc.sessions.map((s) => s.session_id)), new Set(keyOf.values()))
  for (const s of doc.sessions) assert.equal(s.session_synthesized, true, s.session_id)
})

// ── kinship (3.4 合成键 · 按内容认亲): pi's keyless summary request goes back to the keyed session it summarizes ──────────
// The shape is the live capture's: keyed openai-responses calls (header session_id = body prompt_cache_key), and the summary
// request on the same endpoint with neither key, no tools, the summarization prompt and the conversation as one user message.
const PI_UA = { 'user-agent': 'pi/1.4.0 (darwin; node/v22.23.3; arm64)' }
const PI_PROMPT = 'You are pi, an expert coding assistant. You help users by reading files, executing commands and writing code.'
const SUMMARY_PROMPT = 'You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary.'
const SEG1 = '20261018T100000Z', SEG2 = '20261018T110000Z'
let nextId = 0
const rid = () => `req_${String(++nextId).padStart(5, '0')}`
const piCall = (body, ms, headers = {}, wire = 'keyed') => ({ ...call({ agent: 'pi', ms, headers: { ...PI_UA, ...headers }, body,
  ...(wire === 'keyed' ? { host: 'api.openai.com', path: '/v1/responses' } : { host: 'api.anthropic.com', path: '/v1/messages' }) }), id: rid() })
// the wire axis: openai-responses carries the session key; anthropic-messages carries none, so its session is synthesized (3.4)
const WIRES = ['keyed', 'keyless']
const turns = (users) => users.flatMap((u, i) => [{ role: 'user', content: [{ type: 'input_text', text: u }] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Done with step ${i}.` }] }])
const msgs = (users) => users.flatMap((u, i) => [{ role: 'user', content: [{ type: 'text', text: u }] },
  ...(i < users.length - 1 ? [{ role: 'assistant', content: [{ type: 'text', text: `Done with step ${i}.` }] }] : [])])
// a keyless pi session's system prompt names its working directory, so two keyless sessions are two synthesized groups
const promptOf = (s) => `${PI_PROMPT}\nCurrent working directory: /work/project-${s}`
const main = (wire, s, sid, users, ms) => wire === 'keyed'
  ? piCall({ model: 'gpt-5', prompt_cache_key: sid,
    tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    input: [{ role: 'developer', content: PI_PROMPT }, ...turns(users)] }, ms, { session_id: sid })
  : piCall({ model: 'claude-sonnet-4-5', max_tokens: 4096, system: promptOf(s), messages: msgs(users),
    tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] }, ms, {}, wire)
const summary = (users, ms, wire = 'keyed') => {
  const text = '<conversation>\n' + users.map((u, i) => `[User]: ${u}\n\n[Assistant]: Done with step ${i}.`).join('\n\n') + '\n</conversation>'
  return wire === 'keyed'
    ? piCall({ model: 'gpt-5', input: [{ role: 'developer', content: SUMMARY_PROMPT }, { role: 'user', content: [{ type: 'input_text', text }] }] }, ms)
    : piCall({ model: 'claude-sonnet-4-5', max_tokens: 4096, system: SUMMARY_PROMPT, messages: [{ role: 'user', content: [{ type: 'text', text }] }] }, ms, {}, wire)
}

// user text along the language axis, from a seeded generator: English words, CJK with no spaces, or both mixed
const prng = (seed) => () => ((seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 2 ** 32)
const WORDS = 'please refactor the parser so that every token keeps its byte offset and then update the failing tests in the lexer module before release'.split(' ')
const userText = (lang, seed) => {
  const r = prng(seed), en = () => Array.from({ length: 14 }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ')
  const cjk = () => Array.from({ length: 40 }, () => String.fromCharCode(0x4e00 + Math.floor(r() * 0x5000))).join('')
  return lang === 'en' ? `${en()} ${en()}` : lang === 'cjk' ? cjk() + cjk() : `${en()}${cjk()} ${en()}`
}
const LANGS = ['en', 'cjk', 'mixed']
const SID = (s) => `0199c0de-${String(s).padStart(4, '0')}-7000-8000-00000000abcd`

/** n interleaved pi sessions on one wire: three turns each, then each one's summary request, then a call after compaction.
 *  Each summary carries `main`, a call of the session it belongs to. */
function piSessions(lang, n, seed, { gapAfter = 60_000, wire = 'keyed' } = {}) {
  const users = Array.from({ length: n }, (_, s) => [0, 1, 2].map((t) => userText(lang, seed * 100 + s * 10 + t)))
  const keyedRecs = [], summaries = [], after = []
  let ms = T0
  for (let t = 0; t < 3; t++) for (let s = 0; s < n; s++) keyedRecs.push(main(wire, s, SID(s), users[s].slice(0, t + 1), (ms += 5_000)))
  ms += gapAfter
  for (let s = 0; s < n; s++) summaries.push({ main: keyedRecs[s], rec: summary(users[s], (ms += 5_000), wire) })
  for (let s = 0; s < n; s++) after.push(main(wire, s, SID(s), [`Summary of the work so far ${s}.`], (ms += 5_000)))
  return { keyedRecs, summaries, after }
}
const lines = (recs) => recs.map((r) => JSON.stringify(r))
const ridOf = (home, rec) => { // the record id `<segment>:<line>` a record has in the home it was written to
  for (const seg of fs.readdirSync(path.join(home, 'raw')).sort()) {
    const ls = fs.readFileSync(path.join(home, 'raw', seg), 'utf8').split('\n')
    const i = ls.findIndex((l) => l && JSON.parse(l).id === rec.id)
    if (i >= 0) return `${seg.replace(/\.ndjson$/, '')}:${i + 1}`
  }
  return null
}
const homeOf = (parts) => { // parts: [[segment, records], …]
  const home = rawHome('trocar-kin-')
  for (const [seg, recs] of parts) writeSegment(home, seg, lines(recs))
  return home
}
const membership = async (home) => {
  const errors = []
  const rows = await indexRows({ home, errors })
  assert.deepEqual(errors, [])
  return new Map([...rows].map((r) => [r.id, [r.session_id, r.synthesized]]))
}
const fresh = (recs) => recs.map((r) => JSON.parse(JSON.stringify(r))) // the board stamps the objects it reads: give it its own

// one summary request: its session on both readers, that session's synthesized mark, and whether the call is a compaction there
async function placeOf(home, recs, rec, main) {
  await fillUsage({ home, segments: fs.readdirSync(path.join(home, 'raw')).map((f) => f.replace(/\.ndjson$/, '')) })
  const list = await runQuery('sessions', { limit: '500' }, { home })
  assert.deepEqual(list.errors, [])
  const id = ridOf(home, rec)
  const m = await membership(home)
  const q = m.get(id)[0]
  const item = list.sessions.find((s) => s.session_id === q)
  assert.ok(item, `${q} is listed`)
  const doc = await runQuery('session', { id: q }, { home })
  assert.deepEqual(item, doc.meta, 'the list item is the session document meta')
  const row = doc.calls.find((c) => c.rid === id)
  const board = fresh(recs)
  const groups = groupSessions(board)
  const boardOf = (x) => [...groups].find(([, rs]) => rs.some((r) => r.id === x.id))[0]
  const b = boardOf(rec)
  const view = sessionView(board, b)
  const step = view.analyzed.steps.find((c) => c.rec && c.rec.id === rec.id)
  return { query: q, board: b, synthesized: item.session_synthesized, boardSynthesized: view.meta.session_synthesized,
    compaction: !!(row && row.compaction), boardCompaction: !!(step && step.compaction), ids: list.sessions.map((s) => s.session_id),
    mainQuery: m.get(ridOf(home, main))[0], mainBoard: boardOf(main) }
}

test('kinship: a keyless summary request joins the session whose user text it carries, marked compaction; query and board agree', async () => {
  for (const wire of WIRES) {
    for (const lang of LANGS) {
      for (const split of ['same', 'next']) {
        const { keyedRecs, summaries, after } = piSessions(lang, 1, 1, { wire })
        const recs = [...keyedRecs, summaries[0].rec, ...after]
        const home = homeOf(split === 'same' ? [[SEG1, recs]] : [[SEG1, keyedRecs], [SEG2, [summaries[0].rec, ...after]]])
        const p = await placeOf(home, recs, summaries[0].rec, summaries[0].main)
        const at = `${wire}/${lang}/${split}`
        if (wire === 'keyed') assert.equal(p.mainQuery, SID(0), `${at}: the keyed session`)
        assert.equal(p.query, p.mainQuery, `${at}: the summary call is in its session (query)`)
        assert.equal(p.board, p.mainBoard, `${at}: the summary call is in its session (board)`)
        assert.equal(p.board, p.query, `${at}: both readers name it the same`)
        assert.equal(p.ids.filter((id) => id.startsWith('synth-pi-')).length, wire === 'keyed' ? 0 : 1, `${at}: no session of its own`)
        // a keyed session stays uninferred; a keyless one was inferred from its other calls
        assert.equal(p.synthesized, wire === 'keyless', `${at}: inferred only when keyless (query)`)
        assert.equal(p.boardSynthesized, wire === 'keyless', `${at}: inferred only when keyless (board)`)
        assert.ok(p.compaction, `${at}: a compaction in the session document`)
        assert.ok(p.boardCompaction, `${at}: a compaction on the board`)
      }
    }
  }
})

test('kinship: concurrent sessions each take back their own summary request, and two summaries never merge', async () => {
  for (const wire of WIRES) {
    for (const lang of LANGS) {
      for (const n of [2, 3]) {
        const { keyedRecs, summaries, after } = piSessions(lang, n, 2 + n, { wire })
        const recs = [...keyedRecs, ...summaries.map((s) => s.rec), ...after]
        const home = homeOf([[SEG1, recs]])
        const got = new Set()
        for (const s of summaries) {
          const p = await placeOf(home, recs, s.rec, s.main)
          assert.equal(p.query, p.mainQuery, `${wire}/${lang}/${n}: query`)
          assert.equal(p.board, p.mainBoard, `${wire}/${lang}/${n}: board`)
          got.add(p.query)
        }
        assert.equal(got.size, n, `${wire}/${lang}/${n}: one session per summary`)
      }
    }
  }
})

test('kinship: a summary request that shares no fragment with any session, or comes after the window, keeps a synthesized key of its own', async () => {
  for (const wire of WIRES) {
    for (const lang of LANGS) {
      for (const why of ['no-fragment', 'after-window']) {
        const { keyedRecs, summaries } = piSessions(lang, 1, 7, { wire, ...(why === 'after-window' ? { gapAfter: SYNTH_GAP_MS + 60_000 } : {}) })
        const rec = why === 'no-fragment' ? summary([userText(lang, 99_001), userText(lang, 99_002)], Date.parse(summaries[0].rec.ts_request), wire) : summaries[0].rec
        const recs = [...keyedRecs, rec]
        const p = await placeOf(homeOf([[SEG1, recs]]), recs, rec, summaries[0].main)
        const at = `${wire}/${lang}/${why}`
        assert.match(p.query, /^synth-pi-/, `${at}: query`)
        assert.notEqual(p.query, p.mainQuery, `${at}: not the session it shares nothing with`)
        assert.equal(p.board, p.query, `${at}: the board names it the same`)
        assert.equal(p.synthesized, true, `${at}: inferred (query)`)
        assert.equal(p.boardSynthesized, true, `${at}: inferred (board)`)
      }
    }
  }
})

test('kinship: the same membership across segments, after the index is deleted and rebuilt, and as the live segment grows', async () => {
  for (const wire of WIRES) {
    for (const lang of LANGS) {
      const { keyedRecs, summaries, after } = piSessions(lang, 2, 11, { wire })
      const tail = [...summaries.map((s) => s.rec), ...after]
      const whole = await membership(homeOf([[SEG1, keyedRecs], [SEG2, tail]]))
      for (const s of summaries) {
        assert.equal(whole.get(`${SEG2}:${tail.indexOf(s.rec) + 1}`)[0], whole.get(`${SEG1}:${keyedRecs.indexOf(s.main) + 1}`)[0], `${wire}/${lang}: across segments`)
      }
      // the index deleted and rebuilt
      const home = homeOf([[SEG1, keyedRecs], [SEG2, tail]])
      await membership(home)
      fs.rmSync(path.join(home, 'index'), { recursive: true, force: true })
      assert.deepEqual(await membership(home), whole, `${wire}/${lang}: rebuilt`)
      // the live segment grows: read it, append the summary requests and what follows, read again (the resumed rule)
      const grown = homeOf([[SEG1, keyedRecs], [SEG2, tail.slice(0, 1)]])
      await membership(grown)
      writeSegment(grown, SEG2, lines(tail.slice(1)))
      assert.deepEqual(await membership(grown), whole, `${wire}/${lang}: grown`)
    }
  }
})

// Hermes keeps its compaction marker in the history, a user message every later call of that session carries; the call after a
// compaction is a turn of its own session, not a summary request looking for one. Two keyless Hermes sessions on one task (the
// same user text, two working directories) stay two however their compactions interleave (3.4 按内容认亲: the probe is the call
// that is the compaction request)
const MARK = '[CONTEXT COMPACTION — REFERENCE ONLY]'
const hermesCall = (s, messages, ms, escaped) => {
  const r = { ...call({ agent: 'hermes', host: 'llm.internal.test', path: '/v1/chat/completions', ms,
    body: { model: 'm', tools: [{ type: 'function', function: { name: 'terminal', parameters: { type: 'object' } } }],
      messages: [{ role: 'system', content: `You are Hermes Agent.\nCurrent working directory: /work/hermes-${s}` }, ...messages] } }), id: rid() }
  return escaped ? { ...r, req_body: r.req_body.replace(/—/g, '\\u2014') } : r // Python's json.dumps escapes it
}
test('kinship: a Hermes call after a compaction stays in its own session; two sessions on one task never merge', async () => {
  for (const lang of LANGS) {
    for (const escaped of [false, true]) {
      const task = userText(lang, 4242)
      const turn = (t) => [{ role: 'user', content: task }, { role: 'assistant', content: `Done with step ${t}.` }, { role: 'user', content: `Step ${t + 1}.` }]
      const compacted = (t) => [{ role: 'user', content: `${MARK} Earlier turns were compacted. The task: ${task}` },
        { role: 'assistant', content: `Done with step ${t}.` }, { role: 'user', content: `Step ${t + 1}.` }]
      // A and B interleaved: three turns each, then B compacts, then A compacts, each going on after its compaction
      const plan = [['a', turn], ['b', turn], ['a', turn], ['b', turn], ['a', turn], ['b', turn],
        ['b', compacted], ['a', turn], ['b', compacted], ['a', compacted], ['b', compacted], ['a', compacted]]
      let ms = T0
      const recs = plan.map(([s, shape], t) => ({ s, rec: hermesCall(s, shape(t), (ms += 20_000), escaped) }))
      const home = homeOf([[SEG1, recs.map((x) => x.rec)]])
      const m = await membership(home)
      const board = groupSessions(fresh(recs.map((x) => x.rec)))
      const boardOf = (rec) => [...board].find(([, rs]) => rs.some((r) => r.id === rec.id))[0]
      const at = `${lang}/${escaped ? 'escaped' : 'literal'}`
      for (const reader of ['query', 'board']) {
        const keyOf = (x) => (reader === 'query' ? m.get(`${SEG1}:${recs.indexOf(x) + 1}`)[0] : boardOf(x.rec))
        const by = { a: new Set(), b: new Set() }
        for (const x of recs) by[x.s].add(keyOf(x))
        assert.equal(by.a.size, 1, `${at}: A is one session (${reader})`)
        assert.equal(by.b.size, 1, `${at}: B is one session (${reader})`)
        assert.notEqual([...by.a][0], [...by.b][0], `${at}: A and B stay apart (${reader})`)
      }
    }
  }
})
