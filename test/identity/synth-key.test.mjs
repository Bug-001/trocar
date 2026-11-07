// Synthesized session keys (3.4 合成键): the anchor a keyless call is grouped by, and the rule over time.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createSynthKeys, createSynthAssigner, synthFactsOf, SYNTH_GAP_MS, SYNTH_TTL_MS, SYNTH_CAP } from '../../src/dissect/synth-key.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { rawHome, writeSegment } from '../query/raw-home.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { indexRows } from '../../src/query/rows.mjs'
import { fillUsage } from '../../src/query/usage.mjs'
import { segmentIndex, indexDir } from '../../src/query/index-build.mjs'
import { reduction, skeletonDoc, memoryLog, BlockUnread } from '../../src/view/reduce.mjs'
import { extractMembers, blockAt } from '../../src/view/extract.mjs'
import { openProjection } from '../../src/query/projection.mjs'
import { parseTextRef } from '../../src/raw/refs.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { openFoldLog } from '../../src/query/fold-log.mjs'
import v8 from 'node:v8'

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
      const { keyOf } = createSynthKeys()
      const keys = recs.map(keyOf)
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

test('synthesized keys: consecutive keyless calls of one task form one session, across a pause too; a new system prompt starts another; never by pid', async () => {
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
        pairs.push({ a, b, together: samePrompt }) // b's history is a's: step 2, which no window cuts
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
// the wire axis: openai-responses carries the session key; anthropic-messages carries none, so its session is synthesized (3.4); on
// the Anthropic OAuth wire pi's system prompt is the second system block, after Claude Code's identity block
const WIRES = ['keyed', 'keyless', 'oauth']
const CC_ID = "You are Claude Code, Anthropic's official CLI for Claude."
const systemOf = (wire, text) => (wire === 'oauth' ? [{ type: 'text', text: CC_ID }, { type: 'text', text }] : text)
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
  : piCall({ model: 'claude-sonnet-4-5', max_tokens: 4096, system: systemOf(wire, promptOf(s)), messages: msgs(users),
    tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] }, ms, {}, wire)
const summary = (users, ms, wire = 'keyed') => {
  const text = '<conversation>\n' + users.map((u, i) => `[User]: ${u}\n\n[Assistant]: Done with step ${i}.`).join('\n\n') + '\n</conversation>'
  return wire === 'keyed'
    ? piCall({ model: 'gpt-5', input: [{ role: 'developer', content: SUMMARY_PROMPT }, { role: 'user', content: [{ type: 'input_text', text }] }] }, ms)
    : piCall({ model: 'claude-sonnet-4-5', max_tokens: 4096, system: systemOf(wire, SUMMARY_PROMPT), messages: [{ role: 'user', content: [{ type: 'text', text }] }] }, ms, {}, wire)
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

// pi's call after a compaction (`convertToLlm`): the summary as a user message, then the kept recent turns
const COMPACTED = (s) => `The conversation history before this point was compacted into the following summary:\n\n<summary>\nSummary of the work so far ${s}.\n</summary>`
/** n interleaved pi sessions on one wire: three turns each, then each one's summary request, then a call after compaction.
 *  Each summary carries `main`, a call of the session it belongs to. */
function piSessions(lang, n, seed, { gapAfter = 60_000, wire = 'keyed' } = {}) {
  const users = Array.from({ length: n }, (_, s) => [0, 1, 2].map((t) => userText(lang, seed * 100 + s * 10 + t)))
  const keyedRecs = [], summaries = [], after = []
  let ms = T0
  for (let t = 0; t < 3; t++) for (let s = 0; s < n; s++) keyedRecs.push(main(wire, s, SID(s), users[s].slice(0, t + 1), (ms += 5_000)))
  ms += gapAfter
  for (let s = 0; s < n; s++) summaries.push({ main: keyedRecs[s], rec: summary(users[s], (ms += 5_000), wire) })
  for (let s = 0; s < n; s++) after.push(main(wire, s, SID(s), [COMPACTED(s), ...users[s].slice(-2)], (ms += 5_000)))
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

// one summary request: its session, that session's synthesized mark, and whether the call is a compaction there
async function placeOf(home, rec, main) {
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
  return { query: q, synthesized: item.session_synthesized, compaction: !!(row && row.compaction), ids: list.sessions.map((s) => s.session_id),
    mainQuery: m.get(ridOf(home, main))[0] }
}

test('kinship: a keyless summary request joins the session whose user text it carries, marked compaction', async () => {
  for (const wire of WIRES) {
    for (const lang of LANGS) {
      for (const split of ['same', 'next']) {
        const { keyedRecs, summaries, after } = piSessions(lang, 1, 1, { wire })
        const recs = [...keyedRecs, summaries[0].rec, ...after]
        const home = homeOf(split === 'same' ? [[SEG1, recs]] : [[SEG1, keyedRecs], [SEG2, [summaries[0].rec, ...after]]])
        const p = await placeOf(home, summaries[0].rec, summaries[0].main)
        const at = `${wire}/${lang}/${split}`
        if (wire === 'keyed') assert.equal(p.mainQuery, SID(0), `${at}: the keyed session`)
        assert.equal(p.query, p.mainQuery, `${at}: the summary call is in its session (query)`)
        assert.equal(p.ids.filter((id) => id.startsWith('synth-pi-')).length, wire === 'keyed' ? 0 : 1, `${at}: no session of its own`)
        // a keyed session stays uninferred; a keyless one was inferred from its other calls
        assert.equal(p.synthesized, wire !== 'keyed', `${at}: inferred only when keyless (query)`)
        assert.ok(p.compaction, `${at}: a compaction in the session document`)
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
          const p = await placeOf(home, s.rec, s.main)
          assert.equal(p.query, p.mainQuery, `${wire}/${lang}/${n}: query`)
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
        const p = await placeOf(homeOf([[SEG1, recs]]), rec, summaries[0].main)
        const at = `${wire}/${lang}/${why}`
        assert.match(p.query, /^synth-pi-/, `${at}: query`)
        assert.notEqual(p.query, p.mainQuery, `${at}: not the session it shares nothing with`)
        assert.equal(p.synthesized, true, `${at}: inferred (query)`)
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
      // each call is the previous one's history plus the reply and the next user message; a compaction restarts the history from
      // the marker message, which grows the same way
      const hist = { a: [], b: [] }, done = { a: false, b: false }
      const turn = (s, t) => hist[s].length ? [...hist[s], { role: 'assistant', content: `Done with step ${t}.` }, { role: 'user', content: `Step ${t + 1}.` }]
        : [{ role: 'user', content: task }]
      const compacted = (s, t) => done[s] ? turn(s, t) : [{ role: 'user', content: `${MARK} Earlier turns were compacted. The task: ${task}` }]
      // A and B interleaved: three turns each, then B compacts, then A compacts, each going on after its compaction
      const plan = [['a', turn], ['b', turn], ['a', turn], ['b', turn], ['a', turn], ['b', turn],
        ['b', compacted], ['a', turn], ['b', compacted], ['a', compacted], ['b', compacted], ['a', compacted]]
      let ms = T0
      const recs = plan.map(([s, shape], t) => {
        hist[s] = shape(s, t)
        if (shape === compacted) done[s] = true
        return { s, rec: hermesCall(s, hist[s], (ms += 20_000), escaped) }
      })
      const home = homeOf([[SEG1, recs.map((x) => x.rec)]])
      const m = await membership(home)
      const at = `${lang}/${escaped ? 'escaped' : 'literal'}`
      const by = { a: new Set(), b: new Set() }
      for (const x of recs) by[x.s].add(m.get(`${SEG1}:${recs.indexOf(x) + 1}`)[0])
      assert.equal(by.a.size, 1, `${at}: A is one session`)
      assert.equal(by.b.size, 1, `${at}: B is one session`)
      assert.notEqual([...by.a][0], [...by.b][0], `${at}: A and B stay apart`)
    }
  }
})

// ── chains (3.4 合成键): a keyless call joins the open message chain it extends ─────────────────────────────────────────────
// One keyless call of agent `a` on a wire: pi on anthropic-messages (the system a string), pi on the OAuth wire (two system
// blocks), or Hermes on chat-completions (a leading system message). Every agent below shares ONE system text.
const SHARED = 'You are a coding agent. Use the tools to finish the task.'
const BOILER = Array.from({ length: 40 }, (_, i) => WORDS[(i * 7) % WORDS.length]).join(' ') + '\n\n'
const agentCall = (wire, messages, ms) => wire === 'chat'
  ? { ...call({ agent: 'hermes', host: 'llm.internal.test', path: '/v1/chat/completions', ms, body: { model: 'm', messages: [{ role: 'system', content: SHARED }, ...messages] } }), id: rid() }
  : piCall({ model: 'claude-sonnet-4-5', max_tokens: 4096, system: systemOf(wire, SHARED), messages }, ms, {}, wire)
// the cache breakpoint on the last block of the last message: it moves on every call
const cached = (messages) => messages.map((m, i) => i < messages.length - 1 ? m
  : { ...m, content: m.content.map((b, j) => j < m.content.length - 1 ? b : { ...b, cache_control: { type: 'ephemeral' } }) })
// every session of a home, its synthesized mark, and each call's compaction flag (record id → flag)
async function sessionsOf(home) {
  await fillUsage({ home, segments: fs.readdirSync(path.join(home, 'raw')).map((f) => f.replace(/\.ndjson$/, '')) })
  const list = await runQuery('sessions', { limit: '500' }, { home })
  assert.deepEqual(list.errors, [])
  const compaction = new Map()
  for (const s of list.sessions) for (const c of (await runQuery('session', { id: s.session_id }, { home })).calls) compaction.set(c.rid, !!c.compaction)
  return { list: list.sessions, compaction }
}
const sidsOf = (m, home, recs) => new Set(recs.map((r) => m.get(ridOf(home, r))[0]))

test('chains: concurrent agents with one system text are one session each, with no compaction marks', async () => {
  let i = 0
  for (const wire of ['keyless', 'oauth', 'chat']) {
    for (const boiler of [false, true]) {
      for (const order of ['round-robin', 'random']) {
        for (const cache of [false, true]) {
          for (const sameSecond of [false, true]) {
            const n = [2, 3, 5][i++ % 3], TURNS = 4, at = `${wire}/n=${n}/${boiler}/${order}/${cache}/${sameSecond}`
            const users = Array.from({ length: n }, (_, a) => Array.from({ length: TURNS }, (_, t) => (t === 0 && boiler ? BOILER : '') + userText('en', 500 + i * 50 + a * 10 + t)))
            let seq = Array.from({ length: TURNS }, () => Array.from({ length: n }, (_, a) => a)).flat()
            if (order === 'random') { const r = prng(i); seq = seq.map((a) => [r(), a]).sort((x, y) => x[0] - y[0]).map((x) => x[1]) }
            const turn = Array(n).fill(0), by = Array.from({ length: n }, () => []), recs = []
            let ms = T0
            for (const a of seq) {
              const t = turn[a]++
              ms += sameSecond && recs.length < n ? 50 : 5_000
              const messages = msgs(users[a].slice(0, t + 1))
              const rec = agentCall(wire, cache ? cached(messages) : messages, ms)
              by[a].push(rec); recs.push(rec)
            }
            const home = homeOf([[SEG1, recs]])
            const m = await membership(home)
            const ids = by.map((rs) => sidsOf(m, home, rs))
            for (const s of ids) assert.equal(s.size, 1, `${at}: one session per agent`)
            assert.equal(new Set(ids.map((s) => [...s][0])).size, n, `${at}: one session each`)
            const { list, compaction } = await sessionsOf(home)
            for (const s of ids) assert.equal(list.find((x) => x.session_id === [...s][0])?.session_synthesized, true, `${at}: synthesized`)
            assert.deepEqual([...compaction.values()].filter(Boolean), [], `${at}: no compaction`)
          }
        }
      }
    }
  }
})

// A turn returns N parallel tool calls: one call adds the model's output and N results (chat: an assistant message and N `tool`
// messages; Responses `input`: a reasoning item, N function_call and N function_call_output items), however large N is.
const toolTurn = (wire, a, t, n) => {
  const id = (k) => `call_${a}_${t}_${k}`, out = (k) => `result ${k} of turn ${t}: ${userText('en', 9000 + a * 100 + t * 10 + k)}`
  return wire === 'chat'
    ? [{ role: 'assistant', content: null, tool_calls: Array.from({ length: n }, (_, k) => ({ id: id(k), type: 'function', function: { name: 'read', arguments: `{"path":"f${k}"}` } })) },
      ...Array.from({ length: n }, (_, k) => ({ role: 'tool', tool_call_id: id(k), content: out(k) }))]
    : [{ type: 'reasoning', id: `rs_${a}_${t}`, summary: [] },
      ...Array.from({ length: n }, (_, k) => ({ type: 'function_call', call_id: id(k), name: 'read', arguments: `{"path":"f${k}"}` })),
      ...Array.from({ length: n }, (_, k) => ({ type: 'function_call_output', call_id: id(k), output: out(k) }))]
}
const toolCall = (wire, items, ms) => ({ ...call({ agent: 'hermes', host: 'llm.internal.test', ms, ...(wire === 'chat'
  ? { path: '/v1/chat/completions', body: { model: 'm', messages: [{ role: 'system', content: SHARED }, ...items] } }
  : { path: '/v1/responses', body: { model: 'm', instructions: SHARED, input: items } }) }), id: rid() })

test('chains: a turn that adds many items (N parallel tool results) still extends its chain, beside a concurrent agent', async () => {
  for (const wire of ['chat', 'responses']) {
    for (const n of [1, 2, 8, 12]) {
      const at = `${wire}/N=${n}`, by = [[], []], recs = [], hist = [0, 1].map((a) => [{ role: 'user', content: userText('en', 8000 + a + n) }])
      let ms = T0
      for (let t = 0; t < 4; t++) for (const a of [0, 1]) {
        if (t) hist[a] = [...hist[a], ...toolTurn(wire, a, t, n)]
        const rec = toolCall(wire, hist[a], (ms += 5_000)); by[a].push(rec); recs.push(rec)
      }
      const home = homeOf([[SEG1, recs]])
      const m = await membership(home)
      const ids = by.map((rs) => sidsOf(m, home, rs))
      for (const s of ids) assert.equal(s.size, 1, `${at}: one session per agent`)
      assert.notEqual([...ids[0]][0], [...ids[1]][0], `${at}: two agents, two sessions`)
    }
  }
})

// A2 · A3: one agent X compacts (pi: the summary request, then the call after it; Hermes: the call after carries the marker), with
// `others` agents of the same system text beside it; with no evidence the history is rewritten with neither. `boiler`: every agent's
// first user text opens with one shared brief; `fresh`: a new agent (the last of `by`) starts between the summary request and the call after it.
function compacting(shape, others, evidence, seed, { boiler = false, fresh = false } = {}) {
  const n = others + 1 + (fresh ? 1 : 0)
  const task = Array.from({ length: n }, (_, a) => [0, 1, 2, 3].map((t) => (t === 0 && boiler ? BOILER : '') + userText('en', seed + a * 10 + t)))
  const hermes = (messages, ms) => ({ ...call({ agent: 'hermes', host: 'llm.internal.test', path: '/v1/chat/completions', ms,
    body: { model: 'm', messages: [{ role: 'system', content: SHARED }, ...messages] } }), id: rid() })
  const at = (a, messages, ms) => shape === 'pi' ? agentCall('keyless', messages, ms) : hermes(messages, ms)
  const by = Array.from({ length: n }, () => []), recs = []
  const push = (a, rec) => { by[a].push(rec); recs.push(rec); return rec }
  let ms = T0
  const old = fresh ? n - 1 : n
  for (let t = 0; t < 3; t++) for (let a = 0; a < old; a++) push(a, at(a, msgs(task[a].slice(0, t + 1)), (ms += 5_000)))
  let marked = null
  const kept = task[0].slice(1, 3)
  const head = shape === 'pi' ? (evidence ? COMPACTED(0) : `Where we are: ${task[0][0]}`)
    : `${evidence ? MARK + ' ' : ''}Earlier turns were compacted. The task: ${task[0][0]}`
  const after = shape === 'pi' ? [head, ...kept] : [head]
  if (shape === 'pi' && evidence) marked = push(0, summary(task[0].slice(0, 3), (ms += 5_000), 'keyless'))
  if (fresh) push(n - 1, at(n - 1, msgs(task[n - 1].slice(0, 1)), (ms += 5_000)))
  for (let a = 1; a < old; a++) push(a, at(a, msgs(task[a]), (ms += 5_000)))
  const rewritten = push(0, at(0, msgs(after), (ms += 5_000)))
  if (shape === 'hermes' && evidence) marked = rewritten
  push(0, at(0, msgs([...after, task[0][3]]), (ms += 5_000)))
  if (fresh) push(n - 1, at(n - 1, msgs(task[n - 1].slice(0, 2)), (ms += 5_000)))
  return { by, recs, marked, rewritten, texts: [...task.flat(), head] }
}

test('chains: a compaction stays in the session of the chain it rewrites and is marked there, beside concurrent agents', async () => {
  let seed = 7000
  for (const shape of ['pi', 'hermes']) {
    for (const [others, boiler, fresh] of [[0, false, false], [2, false, false], [0, true, false], [0, false, true], [0, true, true], [2, true, true]]) {
      for (const evidence of [true, false]) {
        const at = `${shape}/${others}/${boiler ? 'brief' : ''}/${fresh ? 'fresh' : ''}/${evidence ? 'evidence' : 'none'}`
        const { by, recs, marked, rewritten } = compacting(shape, others, evidence, (seed += 100), { boiler, fresh })
        const home = homeOf([[SEG1, recs]])
        const m = await membership(home)
        const { compaction } = await sessionsOf(home)
        const flagged = recs.filter((r) => compaction.get(ridOf(home, r)))
        const x = sidsOf(m, home, by[0])
        if (evidence) {
          assert.equal(x.size, 1, `${at}: the compacting agent is one session`)
          assert.deepEqual(flagged, [marked], `${at}: the compaction is marked, and nothing else`)
        } else {
          const before = sidsOf(m, home, by[0].slice(0, by[0].indexOf(rewritten)))
          assert.equal(before.size, 1, `${at}: one session before the rewrite`)
          if (shape === 'pi') assert.equal(x.size, 1, `${at}: it kept items, so it is the same conversation`)
          else {
            assert.equal(before.has(m.get(ridOf(home, rewritten))[0]), false, `${at}: nothing kept and no evidence: another session`)
            assert.deepEqual(flagged, [], `${at}: no compaction`)
          }
        }
        for (const rs of by.slice(1)) {
          const s = sidsOf(m, home, rs)
          assert.equal(s.size, 1, `${at}: a concurrent agent is one session`)
          assert.equal(x.has([...s][0]), false, `${at}: apart from the compacting agent`)
        }
      }
    }
  }
})

// real Hermes shapes: older items rewritten in place between calls, tool results or the model's own (the prefix breaks far back or at the
// first item), and a compaction that drops every user text and rewrites the tool results it keeps
const cleared = (it) => (it.role === 'tool' ? { ...it, content: '[old output cleared]' } : it)
const stripped = (it) => (it.role === 'assistant' ? { ...it, reasoning_content: null } : it)
test('chains: older items edited in place stay in the session, beside a concurrent agent, and are no compaction', async () => {
  for (const [edit, change] of [['first', cleared], ['all-but-recent', cleared], ['model, all-but-recent', stripped]]) {
    for (const others of [0, 2]) {
      const at = `${edit}/others=${others}`, n = others + 1, by = Array.from({ length: n }, () => []), recs = []
      const hist = by.map((_, a) => [{ role: 'user', content: userText('en', 8100 + a) }])
      let ms = T0
      for (let t = 0; t < 8; t++) for (let a = 0; a < n; a++) {
        if (t) hist[a] = [...hist[a], ...toolTurn('chat', a, t, 1)]
        if (t === 6 && a === 0) {
          const keep = edit === 'first' ? hist[0].length - 3 : 6, firstTool = hist[0].findIndex((x) => x.role === 'tool')
          hist[0] = hist[0].map((it, i) => (edit === 'first' ? (i === firstTool ? change(it) : it) : i < hist[0].length - keep ? change(it) : it))
        }
        const rec = toolCall('chat', hist[a], (ms += 5_000)); by[a].push(rec); recs.push(rec)
      }
      const home = homeOf([[SEG1, recs]]), m = await membership(home), ids = by.map((rs) => sidsOf(m, home, rs))
      for (const x of ids) assert.equal(x.size, 1, `${at}: one session per agent`)
      assert.equal(new Set(ids.flatMap((x) => [...x])).size, n, `${at}: an agent's session of its own`)
      const { compaction } = await sessionsOf(home)
      assert.deepEqual(recs.filter((r) => compaction.get(ridOf(home, r))), [], `${at}: no compaction`)
    }
  }
})

test('chains: a compaction that keeps recent items and no user text stays in its session, beside a concurrent agent', async () => {
  for (const mark of [true, false]) {
    const at = `mark=${mark}`, by = [[], []], recs = [], hist = [0, 1].map((a) => [{ role: 'user', content: userText('en', 8200 + a) }])
    let ms = T0
    const step = (a) => { const rec = toolCall('chat', hist[a], (ms += 5_000)); by[a].push(rec); recs.push(rec); return rec }
    for (let t = 0; t < 8; t++) for (const a of [0, 1]) { if (t) hist[a] = [...hist[a], ...toolTurn('chat', a, t, 1)]; step(a) }
    hist[0] = [{ role: 'user', content: `${mark ? MARK + ' ' : ''}${userText('en', 8300)}` }, ...hist[0].slice(-6).map(cleared)]
    step(0)
    hist[0] = [...hist[0], ...toolTurn('chat', 0, 9, 1)]; step(0)
    step(1)
    const home = homeOf([[SEG1, recs]]), m = await membership(home), ids = by.map((rs) => sidsOf(m, home, rs))
    for (const x of ids) assert.equal(x.size, 1, `${at}: one session per agent`)
    assert.notEqual([...ids[0]][0], [...ids[1]][0], `${at}: two agents, two sessions`)
  }
})

test('chains: agents that share a first message and nothing recent are not one conversation', async () => {
  const opening = userText('en', 8400), by = [[], []], recs = [], hist = [0, 1].map(() => [{ role: 'user', content: opening }])
  let ms = T0
  for (let t = 0; t < 5; t++) for (const a of [0, 1]) {
    if (t) hist[a] = [...hist[a], ...toolTurn('chat', a, t, 1)]
    const rec = toolCall('chat', hist[a], (ms += 5_000)); by[a].push(rec); recs.push(rec)
  }
  const home = homeOf([[SEG1, recs]]), m = await membership(home), ids = by.map((rs) => sidsOf(m, home, rs.slice(1)))
  assert.notEqual([...ids[0]][0], [...ids[1]][0])
})

test('chains: items other agents hold too tie nothing: two agents with the same short replies, back after the gap, stay apart', async () => {
  const task = [0, 1].map((a) => [0, 1, 2, 3, 4].map((t) => userText('en', 8500 + a * 10 + t))), by = [[], []], recs = []
  let ms = T0
  const step = (a, t) => { const rec = agentCall('keyless', msgs(task[a].slice(0, t + 1)), (ms += 5_000)); by[a].push(rec); recs.push(rec) }
  for (let t = 0; t < 3; t++) for (const a of [0, 1]) step(a, t)
  ms += SYNTH_GAP_MS + 60_000
  for (const t of [3, 4]) for (const a of [0, 1]) step(a, t)
  const home = homeOf([[SEG1, recs]]), m = await membership(home), after = by.map((rs) => sidsOf(m, home, rs.slice(3)))
  for (const x of after) assert.equal(x.size, 1, 'one session per agent after the gap')
  assert.notEqual([...after[0]][0], [...after[1]][0], 'two agents, two sessions')
})

test('chains: a fork is its own session and leaves the session it forked from alone', async () => {
  const task = [0, 1, 2, 3, 4, 5, 6].map((t) => userText('en', 8600 + t)), other = [0, 1, 2].map((t) => userText('en', 8700 + t)), forked = [], orig = [], recs = []
  let ms = T0
  const step = (to, users) => { const rec = agentCall('keyless', msgs(users), (ms += 5_000)); to.push(rec); recs.push(rec) }
  for (const t of [0, 1, 2, 3, 4]) step(orig, task.slice(0, t + 1))
  for (const t of [0, 1, 2]) { // from two turns back: a fork of the very last turn is an edit of its last message, as far as the bytes go (3.4 step 3)
    step(forked, [...task.slice(0, 3), ...other.slice(0, t + 1)])
    if (t < 2) step(orig, task.slice(0, t + 6))
  }
  const home = homeOf([[SEG1, recs]]), m = await membership(home), o = sidsOf(m, home, orig), f = sidsOf(m, home, forked)
  assert.equal(o.size, 1, 'the original stays one session')
  assert.equal(f.size, 1, 'the fork is one session')
  assert.notEqual([...o][0], [...f][0], 'of its own')
})

// 3.4 合成键 step 2 has no time window: a history that holds a chain's whole latest history continues it however long the pause,
// while the chain is open (SYNTH_TTL_MS; at most SYNTH_CAP chains per harness); steps 3, 3b and kinship keep SYNTH_GAP_MS
const HOUR = 3_600_000
const titled = async (home) => { const l = await runQuery('sessions', { limit: '500' }, { home }); assert.deepEqual(l.errors, []); return l.sessions }
const story = (seed, n) => Array.from({ length: n }, (_, t) => userText('en', seed + t))
test('chains: a call that extends a chain after a 2-hour pause joins it, titled by its first prompt; one that does not still splits', async () => {
  const task = story(8800, 4), other = story(8900, 2), recs = [], later = []
  let ms = T0
  for (const t of [0, 1]) recs.push(agentCall('keyless', msgs(task.slice(0, t + 1)), (ms += 5_000)))
  const before = (await titled(homeOf([[SEG1, recs]])))[0].title
  ms += 2 * HOUR
  for (const t of [2, 3]) recs.push(agentCall('keyless', msgs(task.slice(0, t + 1)), (ms += 5_000)))
  ms += 2 * HOUR // the same system text, a history that extends nothing
  for (const t of [0, 1]) { const r = agentCall('keyless', msgs(other.slice(0, t + 1)), (ms += 5_000)); recs.push(r); later.push(r) }
  const home = homeOf([[SEG1, recs]]), m = await membership(home), mine = sidsOf(m, home, recs.slice(0, 4)), theirs = sidsOf(m, home, later)
  assert.equal(mine.size, 1, 'one session across the pause')
  assert.equal(theirs.size, 1)
  assert.notEqual([...mine][0], [...theirs][0], 'a history that extends nothing is another session')
  const list = await titled(home)
  assert.equal(list.length, 2)
  assert.equal(list.find((x) => x.session_id === [...mine][0]).title, before, 'the title is the first prompt\'s, not a later one\'s')
})

test('chains: two calls that extend one tail after a pause: the first continues the chain, the second is a session of its own', async () => {
  const task = story(9000, 2), [x, y] = story(9100, 2), recs = []
  let ms = T0
  for (const t of [0, 1]) recs.push(agentCall('keyless', msgs(task.slice(0, t + 1)), (ms += 5_000)))
  const e1 = agentCall('keyless', msgs([...task, x]), (ms += 2 * HOUR)), e2 = agentCall('keyless', msgs([...task, y]), (ms += 2 * HOUR))
  recs.push(e1, e2)
  const home = homeOf([[SEG1, recs]]), m = await membership(home), id = (r) => m.get(ridOf(home, r))[0]
  assert.equal(id(e1), id(recs[0]), 'the first extender continues the chain')
  assert.notEqual(id(e2), id(recs[0]), 'the chain\'s tail is now the first extender\'s: the second extends nothing')
})

test('chains: a chain past SYNTH_TTL_MS, or pushed out by SYNTH_CAP, is no longer extended', () => {
  assert.ok(SYNTH_TTL_MS >= 2 * SYNTH_GAP_MS && Number.isInteger(SYNTH_CAP) && SYNTH_CAP > 1)
  const f = (ms, chain, hash = 'a') => ({ harness: 'hermes', ms, hash: hash.repeat(64), fp: [], chain })
  let assign = createSynthAssigner()
  const a = assign(f(T0, ['a1'])).key
  assert.equal(assign(f(T0 + SYNTH_TTL_MS - 60_000, ['a1', 'a2'])).key, a, 'within the TTL')
  assert.notEqual(assign(f(T0 + 2 * SYNTH_TTL_MS, ['a1', 'a2', 'a3'])).key, a, 'past it')
  // SYNTH_CAP + 1 chains of one harness, over two system texts: the oldest is pushed out; the cap is the harness's, not a group's
  assign = createSynthAssigner()
  const keys = Array.from({ length: SYNTH_CAP + 1 }, (_, i) => assign(f(T0 + i * 1000, [`c${i}`], i % 2 ? 'b' : 'a')).key)
  assert.equal(new Set(keys).size, SYNTH_CAP + 1)
  const back = T0 + 2 * HOUR
  assert.equal(assign(f(back, ['c1', 'c1+'], 'b')).key, keys[1], 'the second oldest is still open')
  assert.notEqual(assign(f(back + 1000, ['c0', 'c0+'], 'a')).key, keys[0], 'the oldest was pushed out')
})

// the bounds of the rule's state past the gap (3.4 合成键 有界), each step at the pause where it differs
const ff = (ms, chain, more = {}) => ({ harness: 'hermes', ms, hash: 'a'.repeat(64), fp: [], chain, ...more })
test('chains: a chain stripped past 2 x the gap still takes its extension, and its items again', () => {
  const assign = createSynthAssigner(), a = assign(ff(T0, ['a1'], { items: ['i1', 'i2'] })).key
  assign(ff(T0 + 2 * HOUR, ['b1'])) // a new chain: the prune that strips the first runs
  assert.equal(assign(ff(T0 + 2 * HOUR + 1000, ['a1', 'a2'], { items: ['i1', 'i2', 'i3'] })).key, a, 'the tail is kept')
  // its next call edits an older item in place: step 3 reads the items the extension brought back
  assert.equal(assign(ff(T0 + 2 * HOUR + 2000, ['x9'], { items: ['i1', 'i2', 'i3x'] })).key, a, 'the items are back')
})

test('chains: past the gap, steps 3b and 4 open a new chain; only step 2 reaches further', () => {
  const later = T0 + 45 * 60_000 // past SYNTH_GAP_MS, before the strip
  let assign = createSynthAssigner()
  const a = assign(ff(T0, ['a1'], { fp: [1, 2, 3] })).key
  assert.notEqual(assign(ff(later, ['m1'], { fp: [1, 2, 3], mark: true })).key, a, 'step 3b: a marked rewrite past the gap')
  assign = createSynthAssigner()
  const b = assign(ff(T0, ['b1'])).key
  assert.notEqual(assign(ff(later, [])).key, b, 'step 4: a call with no history past the gap')
})

test('chains: SYNTH_CAP counts the keyless chains and the chains of keyed sessions, not the keyed sessions', () => {
  // a keyed session's chain first and oldest (its session entry is newer), then k keyless chains of the same harness
  const lane = (assign, ms, chain) => assign({ harness: 'hermes', ms, key: 'k1', hash: 'l'.repeat(64), fp: [], chain }).lane
  const after = (k) => {
    const assign = createSynthAssigner(), first = lane(assign, T0, ['l1'])
    assign({ harness: 'hermes', ms: T0 + 1, key: 'k1', fp: [] })
    for (let i = 0; i < k; i++) assign(ff(T0 + 2 + i, [`c${i}`]))
    return lane(assign, T0 + 3 * HOUR, ['l1', 'l2']) === first
  }
  assert.equal(after(SYNTH_CAP - 1), true, 'SYNTH_CAP chains in all: none pushed out')
  assert.equal(after(SYNTH_CAP), false, 'one more: the keyed session\'s chain, the oldest, is pushed out')
})

test('chains: a chain stripped with no tail is dropped: it holds no SYNTH_CAP slot', () => {
  const assign = createSynthAssigner(), c0 = assign(ff(T0, ['c0'])).key
  assign(ff(T0 + 1000, [], { hash: 'n'.repeat(64) })) // a chain with no tail, in another group of the harness
  for (let i = 1; i < SYNTH_CAP - 1; i++) assign(ff(T0 + 2 * HOUR + i, [`c${i}`])) // the first one's prune strips both
  assign(ff(T0 + 2 * HOUR + SYNTH_CAP, ['last'])) // SYNTH_CAP chains with the tailless one: c0, the oldest, would go
  assert.equal(assign(ff(T0 + 3 * HOUR, ['c0', 'c0+'])).key, c0, 'the oldest chain with a tail is still open')
})

test('chains: across a pause, the same membership in one pass, cut across two segments, and as the live segment grows', async () => {
  const task = story(9200, 5), other = story(9300, 3), recs = []
  let ms = T0
  for (let t = 0; t < 5; t++) {
    if (t === 2) ms += 3 * HOUR
    recs.push(agentCall('keyless', msgs(task.slice(0, t + 1)), (ms += 5_000)))
    if (t < 3) recs.push(agentCall('keyless', msgs(other.slice(0, t + 1)), (ms += 5_000)))
  }
  const byRec = async (home) => { const m = await membership(home); return new Map(recs.map((r) => [r.id, m.get(ridOf(home, r))[0]])) }
  const one = await byRec(homeOf([[SEG1, recs]]))
  assert.equal(new Set(one.values()).size, 2, 'two conversations, each one session across the pause')
  for (let c = 1; c < recs.length; c++) {
    assert.deepEqual(await byRec(homeOf([[SEG1, recs.slice(0, c)], [SEG2, recs.slice(c)]])), one, `cut at ${c}`)
    const grown = homeOf([[SEG1, recs.slice(0, c)], [SEG2, recs.slice(c, c + 1)]])
    await membership(grown)
    writeSegment(grown, SEG2, lines(recs.slice(c + 1)))
    assert.deepEqual(await byRec(grown), one, `grown after ${c}`)
  }
})

test('chains: a call with no readable history joins the group\'s latest chain and leaves its tail as it was; alone it opens one', () => {
  const assign = createSynthAssigner(), f = (ms, chain) => ({ harness: 'hermes', ms, hash: 'h'.repeat(64), fp: [], chain })
  assert.equal(assign(f(1000, [])).key, assign(f(2000, [])).key, 'no chain open yet, then one')
  const a = assign(f(3000, ['a1'])).key
  assert.notEqual(a, undefined)
  const b = assign(f(4000, ['b1'])).key
  assert.equal(assign(f(5000, [])).key, b)
  assert.equal(assign(f(6000, ['b1', 'b2'])).key, b, 'the tail stands')
})

// 3.4's chain facts computed afresh, no reuse: an item = its JSON with every `cache_control` key dropped; `chain` = the cumulative hashes
// (`c + "\n" + item`) at the last 4 positions and the turn boundaries, at most 12; `items` = the own hashes of the last 12 items that are not system / developer
const h16 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16)
const enc = (it) => JSON.stringify(it, (k, v) => (k === 'cache_control' ? undefined : v)) ?? 'null'
const model = (it) => !!it && (it.role === 'assistant' || it.type === 'reasoning' || /_call$/.test(it.type ?? ''))
const reference = (items) => {
  let c = null
  const cum = items.map((it) => (c = h16(c == null ? enc(it) : c + '\n' + enc(it))))
  return { chain: cum.filter((_, i) => i >= items.length - 4 || (model(items[i + 1]) && !model(items[i]))).slice(-12),
    items: items.filter((it) => it?.role !== 'system' && it?.role !== 'developer').map((it) => h16(enc(it)).slice(0, 8)).slice(-12) }
}

test('chainOf: the facts equal 3.4\'s encoding', () => {
  const cc = { type: 'ephemeral' }
  const shapes = [
    (i) => ({ role: 'user', content: `ask ${i}`, cache_control: cc }), // depth 0
    (i) => ({ role: 'user', content: [{ type: 'text', text: `ask ${i}`, cache_control: cc }] }), // depth 2, in an array
    (i) => ({ role: 'assistant', content: [[{ cache_control: cc, x: i }], undefined, 'é'] }), // nested arrays, undefined in one
    (i) => ({ role: 'tool', content: `the "cache_control": key ${i}`, note: 'cache_control' }), // the name as text and as a value
    (i) => ({ role: 'assistant', content: `中文 ${i} 🙂 \u2028` }),
    (i) => ({ type: 'reasoning', summary: [] }),
    (i) => ({ type: 'function_call', name: 'f', arguments: `{"cache_control":${i}}` }),
    (i) => ({ role: 'user', content: `plain ${i}` }),
    () => undefined,
  ]
  for (const n of [1, 12, 200]) {
    for (const seed of [0, 1, 2]) {
      const items = Array.from({ length: n }, (_, i) => i === 0 && n > 1 ? { role: 'system', content: 'sys', cache_control: cc } : shapes[(i * (seed + 2) + seed) % shapes.length](i))
      // a system and a developer item among the last 12: never an own hash, whatever the window
      if (n > 12) { items[n - 3] = { role: 'developer', content: 'dev' }; items[n - 7] = { role: 'system', content: 'late sys' } }
      const rec = { ...call({ agent: 'hermes', host: 'llm.internal.test', path: '/v1/chat/completions', ms: T0, body: {} }), req_body: { model: 'm', messages: items } }
      const f = synthFactsOf(rec), want = reference(items)
      assert.ok(f && f.chain.length > 0, `${n}/${seed}: keyless facts`)
      assert.deepEqual({ chain: f.chain, items: f.items }, want, `${n} items, seed ${seed}`)
    }
  }
})

test('chainOf with a memo: each call of a group reuses only what is byte-equal to the group\'s previous call', () => {
  // two groups (two system texts) interleave; per group: k+1 extends k, an early item rewritten at the same length, items dropped
  const rec = (system, messages) => ({ ...call({ agent: 'hermes', host: 'llm.internal.test', path: '/v1/chat/completions', ms: T0, body: {} }),
    req_body: { model: 'm', system, messages } })
  const turn = (g, i) => [{ role: 'user', content: `${g} ask ${i}` }, { role: 'assistant', content: `${g} done ${i}`, cache_control: { type: 'ephemeral' } }]
  const story = (g) => {
    const h = []
    const out = []
    for (let i = 0; i < 4; i++) { h.push(...turn(g, i)); out.push(h.slice()) }            // k+1 extends k
    const edited = h.slice(); edited[1] = { ...edited[1], content: `${g} dXne 0` }         // same length, inside the shared prefix
    out.push(edited, [...edited, ...turn(g, 9)])
    const cut = [edited[0], ...edited.slice(5)]; out.push(cut, [...cut, ...turn(g, 10)])  // a compaction drops items, then extends
    out.push(cut.slice(0, 3))                                                              // shorter than the previous, a prefix of it
    return out
  }
  const a = story('A'), b = story('B')
  const memo = new Map()
  for (let k = 0; k < a.length; k++) {
    for (const [sys, hist] of [['sys A', a[k]], ['sys B', b[k]]]) {
      const f = synthFactsOf(rec(sys, hist), memo)
      assert.deepEqual({ chain: f.chain, items: f.items }, reference(hist), `${sys}, call ${k}`)
    }
    assert.equal(memo.size, 2, 'one entry per group: the last call of each')
  }
})

test('chains: the same membership in one pass, cut across two segments, and as the live segment grows; the index holds no message text', async () => {
  const pi = compacting('pi', 2, true, 9100), he = compacting('hermes', 2, true, 9500)
  const recs = [...pi.recs, ...he.recs], texts = [...pi.texts, ...he.texts]
  const byRec = async (home) => { const m = await membership(home); return new Map(recs.map((r) => [r.id, m.get(ridOf(home, r))[0]])) }
  const one = await byRec(homeOf([[SEG1, recs]]))
  const atSummary = recs.indexOf(pi.marked) + 1 // between the summary request and the call after it
  for (const c of [1, atSummary, pi.recs.length, recs.length - 2]) {
    assert.deepEqual(await byRec(homeOf([[SEG1, recs.slice(0, c)], [SEG2, recs.slice(c)]])), one, `cut at ${c}`)
    const grown = homeOf([[SEG1, recs.slice(0, c)], [SEG2, recs.slice(c, c + 1)]])
    await membership(grown)
    writeSegment(grown, SEG2, lines(recs.slice(c + 1)))
    assert.deepEqual(await byRec(grown), one, `grown after ${c}`)
  }
  const home = homeOf([[SEG1, recs]])
  await segmentIndex({ home, segment: SEG1, owner: true })
  const bytes = fs.readFileSync(path.join(indexDir(home), `${SEG1}.json`), 'utf8')
  for (const t of [...texts, 'Done with step 0.']) assert.equal(bytes.includes(t), false, `no message text in the index: ${t.slice(0, 40)}`)
})

// ── keyed chains (3.4 带键会话里的消息链): Kimi's row says `chainLane: 'aux'`; one prompt_cache_key holds the main conversation and the
// agents it opens, each with its own system text
const KMAIN = 'You are Kimi Code. The main conversation.', KSIDE = 'You are an explore agent.', KOTHER = 'You are a coder agent.'
const kimi = (sys, msgs, ms, key = 'K') => call({ agent: 'kimi', host: 'api.moonshot.ai', path: '/v1/chat/completions', ms,
  body: { model: 'kimi', prompt_cache_key: key, messages: [{ role: 'system', content: sys }, ...msgs] } })
const hist = (tag, n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${tag} turn ${i}` }))
const ided = (recs) => recs.map((r, i) => ({ ...r, id: `k${i}` }))
const ridAt = (i) => `${SEG1}:${i + 1}`
// the session document over records in one segment: per record (in order), its lane kind and whether it is a compaction
async function lanesOf(home, id) {
  const doc = await runQuery('session', { id }, { home })
  assert.deepEqual(doc.errors || [], [])
  const kind = new Map(doc.lanes.map((l) => [l.lane, l.kind]))
  return { doc, at: (i) => { const c = doc.calls.find((x) => x.rid === ridAt(i)); return c && { kind: kind.get(c.lane), compaction: !!c.compaction } } }
}

test('keyed chains: another system text is a lane of its own; the main text stays main after a rewrite', async () => {
  let ms = T0
  const recs = ided([
    ...[3, 5, 7, 9].map((n) => kimi(KMAIN, hist('main', n), (ms += 10_000))),
    kimi(KSIDE, hist('side', 3), (ms += 10_000)), kimi(KSIDE, hist('side', 5), (ms += 10_000)),
    kimi(KMAIN, [{ role: 'user', content: 'The conversation so far has been compacted.' }], (ms += 10_000)), // the harness's own compaction: 10 -> 2
  ])
  const home = homeOf([[SEG1, recs]])
  const { at } = await lanesOf(home, 'K')
  for (const i of [0, 1, 2, 3, 6]) assert.equal(at(i).kind, 'main', `call ${i}: the main text is main, the rewrite too`)
  for (const i of [4, 5]) assert.equal(at(i).kind, 'aux', `call ${i}: another text is the row's lane`)
  assert.deepEqual(recs.map((_, i) => at(i).compaction), [false, false, false, false, false, false, true], 'the rewrite only; no drop at the side chain')
})

test('keyed chains: two fresh histories of one text are two lanes', async () => {
  let ms = T0
  const recs = ided([
    ...[3, 5, 9].map((n) => kimi(KMAIN, hist('main', n), (ms += 10_000))),
    kimi(KSIDE, hist('first', 1), (ms += 10_000)), kimi(KSIDE, hist('first', 7), (ms += 10_000)),
    kimi(KSIDE, hist('second', 1), (ms += 10_000)), kimi(KSIDE, hist('second', 3), (ms += 10_000)),
  ])
  const home = homeOf([[SEG1, recs]]), rows = [...await indexRows({ home, errors: [] })]
  const lane = (i) => rows.find((r) => r.id === ridAt(i)).lane_key
  for (const r of rows) assert.equal(r.session_id, 'K', 'one session: the key')
  assert.ok(lane(3) && lane(5), 'each chain is named')
  assert.equal(lane(4), lane(3), 'an extended history stays on its chain')
  assert.equal(lane(6), lane(5))
  assert.notEqual(lane(5), lane(3), 'a fresh history is another chain')
  // and the session document folds each chain on its own: the second history's start is no drop after the first's
  const { at } = await lanesOf(home, 'K')
  assert.deepEqual(recs.map((_, i) => at(i).compaction), recs.map(() => false), 'no compaction where a chain starts')
})

test('keyed chains: the main text moves to a text whose history grows longer', async () => {
  let ms = T0
  const recs = ided([
    ...[3, 5].map((n) => kimi(KMAIN, hist('first', n), (ms += 10_000))),
    ...[1, 3, 5, 7, 9].map((n) => kimi(KOTHER, hist('long', n), (ms += 10_000))),
    kimi(KMAIN, hist('first', 7), (ms += 10_000)),
  ])
  const want = ['aux', 'aux', 'main', 'main', 'main', 'main', 'main', 'aux']
  // before the switch: the first text leads, at 5 the other ties it and the first stays
  const early = { 3: ['main', 'main', 'aux'], 5: ['main', 'main', 'aux', 'aux', 'aux'] }
  const kinds = async (home, n = recs.length) => { const { at } = await lanesOf(home, 'K'); return recs.slice(0, n).map((_, i) => at(i).kind) }
  assert.deepEqual(await kinds(homeOf([[SEG1, recs]])), want, 'read at once')
  for (const c of [3, 5]) { // read as the session grows: the switch comes after the fold took the first calls as main
    const home = homeOf([[SEG1, recs.slice(0, c)]])
    assert.deepEqual(await kinds(home, c), early[c], `before it grew, at ${c}`)
    writeSegment(home, SEG1, lines(recs.slice(c)))
    assert.deepEqual(await kinds(home), want, `grown after ${c}`)
  }
  for (const c of [3, 5, 7]) { // the reduction snapshotted after the first c calls and resumed from that state (REDUCE_V) for the rest
    assert.deepEqual(await chainKinds(recs, { batches: [recs.slice(0, c).map((_, i) => ridAt(i)), recs.slice(c).map((_, i) => ridAt(c + i))], resume: true }), want, `resumed after ${c}`)
  }
})

test('keyed chains: a row without chainLane is untouched', async () => {
  let ms = T0
  const pi = (sys, msgs) => call({ agent: 'pi', host: 'api.example.com', path: '/v1/chat/completions', ms: (ms += 10_000), headers: { session_id: 'P' },
    body: { model: 'm', messages: [{ role: 'system', content: sys }, ...msgs] } })
  const recs = ided([pi('You are pi.', hist('main', 3)), pi('You are pi.', hist('main', 5)), pi('Another text.', hist('side', 1))])
  const home = homeOf([[SEG1, recs]])
  for (const r of await indexRows({ home, errors: [] })) assert.equal(r.lane_key ?? null, null, 'no chain for a row without chainLane')
  const { at } = await lanesOf(home, 'P')
  assert.deepEqual(recs.map((_, i) => at(i).kind), ['main', 'main', 'main'])
})

test('keyed chains: a Kimi-shaped session has main and aux lanes and one compaction', async () => {
  let ms = T0
  const main = Array.from({ length: 21 }, (_, i) => kimi(KMAIN, hist('main', 4 + i), (ms += 10_000))) // 5 .. 25 messages
  const recs = ided([
    ...main.slice(0, 10),
    kimi(KSIDE, hist('side', 3), (ms += 10_000)), kimi(KSIDE, hist('side', 5), (ms += 10_000)), // 4 -> 6, another system text
    ...main.slice(10),
    kimi(KMAIN, [{ role: 'user', content: 'The conversation so far has been compacted.' }, ...hist('kept', 4)], (ms += 10_000)), // 25 -> 6
  ])
  const home = homeOf([[SEG1, recs]])
  await fillUsage({ home, segments: [SEG1] })
  const { doc, at } = await lanesOf(home, 'K')
  assert.deepEqual([...new Set(doc.lanes.map((l) => l.kind))].sort(), ['aux', 'main'])
  const comps = recs.map((_, i) => i).filter((i) => at(i).compaction)
  assert.deepEqual(comps, [recs.length - 1], 'the 25 -> 6 rewrite only, none where the side chain starts')
  assert.equal(at(recs.length - 1).kind, 'main')
  const list = await runQuery('sessions', { limit: '50' }, { home })
  const item = list.sessions.find((s) => s.session_id === 'K')
  assert.equal(item.has_subagent, false)
  assert.equal(item.session_synthesized, false)
})

test('gemini: contents and systemInstruction anchor the chain; two unrelated conversations are two sessions', () => {
  let ms = T0
  const gem = (texts) => call({ agent: 'pi', host: 'generativelanguage.googleapis.com', path: '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', ms: (ms += 60_000),
    body: { systemInstruction: { parts: [{ text: 'You are pi.' }] },
      contents: texts.map((text, i) => ({ role: i % 2 ? 'model' : 'user', parts: [{ text }] })) } })
  const a1 = gem(['fix the build']), b1 = gem(['write a poem']), a2 = gem(['fix the build', 'done', 'now test it'])
  const f = synthFactsOf(a1)
  assert.equal(f.hash, createHash('sha256').update('You are pi.', 'utf8').digest('hex'), 'the system text is systemInstruction')
  assert.ok(f.chain.length > 0, 'the history is contents')
  const { keyOf } = createSynthKeys()
  const [ka1, kb1, ka2] = [a1, b1, a2].map(keyOf)
  assert.notEqual(kb1, ka1, 'an unrelated conversation is another session')
  assert.equal(ka2, ka1, 'a conversation that extends stays one session')
  // calls not seen between (three model turns at once): the earlier call ends where a `model` turn starts, so it is still extended
  const c1 = gem(['plan the release']), c2 = gem(['plan the release', 'planned', 'tag it', 'tagged', 'and notes', 'written', 'ship it', 'shipped', 'thanks'])
  const kc1 = keyOf(c1)
  assert.equal(keyOf(c2), kc1, 'an extension past several model turns stays one session')
})

// the reduction itself over a Kimi-shaped session (3.4 带键会话里的消息链): records extracted into a projection with the members the index gives,
// then added in the batches given; `fail`: a call whose block does not read back live (BlockUnread), or that the fold log already names failed (`cold`)
async function chainKinds(recs, { batches = null, fail = null, cold = false, resume = false } = {}) {
  const home = homeOf([[SEG1, recs]]), members = [...await indexRows({ home, errors: [] })]
  const byId = new Map(recs.map((r, i) => [ridAt(i), Object.defineProperty({ ...r, id: ridAt(i) }, '_stream', { value: `${SEG1}.ndjson`, enumerable: false })]))
  const at = tmpDir('trocar-chains-')
  let store = openProjection({ home: at, key: 'K' })
  extractMembers({ store, members, sessionId: 'K', recordsAt: (ms) => ms.map((m) => byId.get(m.id)).filter(Boolean) })
  // resume: a fold log on disk; after each batch the state snapshotted, serialised and resumed over a store and log opened afresh
  const logOf = (st) => (resume ? openFoldLog({ home: at, key: 'K', projection: { id: st.id, bytes: st.bytes }, errors: [] }) : memoryLog(st))
  const resolve = (ref) => { const id = parseTextRef(ref).recordId; if (id === fail && !cold) throw new BlockUnread('record-missing', 'gone'); return blockAt(byId.get(id), ref) }
  const failedBefore = cold ? (rid) => (rid === fail ? { reason: 'gone', code: 'record-missing' } : null) : null
  let log = logOf(store), R = reduction(store, { log, resolve, failedBefore })
  for (const b of batches || [recs.map((_, i) => ridAt(i))]) {
    R.add(b)
    if (!resume) continue
    const from = v8.deserialize(v8.serialize(R.snapshot()))
    log.close(); store.close()
    store = openProjection({ home: at, key: 'K' }); log = logOf(store); R = reduction(store, { log, resolve, failedBefore, from })
  }
  const doc = skeletonDoc(R), kind = new Map(doc.lanes.map((l) => [l.lane, l.kind]))
  return recs.map((_, i) => { const r = doc.rows.find((x) => x.rid === ridAt(i)); return r ? kind.get(r.lane) : 'failed' })
}

test('keyed chains: a call that failed holds no count: live and cold give the same main', async () => {
  let ms = T0
  // the other text's call has the most messages, and its block does not read back
  const recs = [...[3, 5].map((n) => kimi(KMAIN, hist('main', n), (ms += 10_000))), kimi(KOTHER, hist('other', 9), (ms += 10_000)), kimi(KMAIN, hist('main', 7), (ms += 10_000))]
  const fail = ridAt(2)
  const live = await chainKinds(recs, { fail }), cold = await chainKinds(recs, { fail, cold: true })
  assert.deepEqual(live, ['main', 'main', 'failed', 'main'])
  assert.deepEqual(cold, live)
})

test('keyed chains: a tie keeps the text that got there first, whatever order the calls arrive in', async () => {
  let ms = T0
  const recs = [kimi(KMAIN, hist('main', 5), (ms += 10_000)), kimi(KOTHER, hist('other', 5), (ms += 10_000)), kimi(KOTHER, hist('other', 3), (ms += 10_000))]
  const want = ['main', 'aux', 'aux']
  for (const batches of [[[ridAt(0)], [ridAt(1)], [ridAt(2)]], [[ridAt(1)], [ridAt(0)], [ridAt(2)]], [[ridAt(2), ridAt(1)], [ridAt(0)]]])
    assert.deepEqual(await chainKinds(recs, { batches }), want, JSON.stringify(batches))
})
