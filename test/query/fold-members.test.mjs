// test/query/fold-members.test.mjs — 4.3 §4 折叠日志: a fold log is taken up again only under the same members, by identity, not by
// count. Two summary requests quote session A's reply; in one process the first is read back and joins A while the second cannot be
// read and stays apart, in the other the other way round. A keeps as many members, its frontier (a later turn) the same, one member
// swapped before it: the log the first process folded must not answer for the second.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { answer } from '../../src/query/answers.mjs'
import { extendSession } from '../../src/query/named/session.mjs'
import { sessionDir } from '../../src/query/projection.mjs'
import { drain } from '../helpers/bounded.mjs'
import { rawHome, writeSegment } from './raw-home.mjs'

const T0 = Date.parse('2026-10-18T10:00:00.000Z'), MIN = 60_000
const UA = { 'user-agent': 'pi/1.4.0 (darwin; node/v22.23.3; arm64)' }
const PI = 'You are pi, an expert coding assistant.', SUMMARY = 'You are a context summarization assistant. Produce a structured summary.'
const WORDS = 'the parser keeps every token offset while the lexer module reports each failing test before release and after review'.split(' ')
const prose = (seed, len) => { let s = '', x = seed; while (s.length < len) { x = (Math.imul(x ^ (x >>> 15), 2246822507) + 0x9e3779b9) >>> 0; s += WORDS[x % WORDS.length] + ' ' } return s.slice(0, len).trim() }
let n = 0
const rec = (system, input, reply, ms, sid = null) => ({ id: `req_${++n}`, ts: new Date(ms).toISOString(), ts_request: new Date(ms).toISOString(), method: 'POST',
  host: 'api.openai.com', endpoint: '/v1/responses', req_headers: { 'content-type': 'application/json', ...UA, ...(sid ? { session_id: sid } : {}) },
  req_body: JSON.stringify({ model: 'gpt-5', ...(sid ? { prompt_cache_key: sid } : {}), input: [{ role: 'developer', content: system }, ...input.map((t) => ({ role: 'user', content: [{ type: 'input_text', text: t }] }))] }),
  resp: { status: 200, kind: 'sse', raw_sse: reply ? [{ type: 'response.output_text.delta', delta: reply }] : [] },
  is_llm_call: true, capture: 'transparent', traffic_class: 'llm', proc: { pid: 7, exe: '/x', agent: 'pi' } })
const rA = prose(1, 900)
const turn = (t, reply, ms) => rec(`${PI}\n<cwd>\n/work/a\n</cwd>`, Array.from({ length: t + 1 }, (_, i) => `user a turn ${i} ${prose(9000 + i, 60)}`), reply, ms, 'sid-a')
const summary = (k, ms) => rec(SUMMARY, [`<conversation>\n[Assistant]: ${rA}\n\n[User]: ${prose(500 + k, 200)}\n</conversation>`], null, ms)
const RECS = [turn(0, rA, T0), summary(1, T0 + MIN), summary(2, T0 + 2 * MIN), turn(1, null, T0 + 3 * MIN)]
const SEG = '20261018T100000Z'
// a seek to line i + 1 reads from the newline before it (records.mjs): the record at RECS[i + 1] fails while `fail` names it
const SEEK = RECS.slice(0, -1).reduce((a, r) => [...a, (a.at(-1) ?? -1) + Buffer.byteLength(JSON.stringify(r)) + 1], [])
// a process of its own (warm.mjs fsTag): its own row list and session state; the summary at `fail` (1 or 2) cannot be read
const proc = (home, fail) => ({ home, writer: true, fs: { ...fs, readSync: (fd, b, o, len, pos, ...a) => {
  if (pos === SEEK[fail - 1]) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
  return fs.readSync(fd, b, o, len, pos, ...a)
} } })
const req = { name: 'session', params: { id: 'sid-a' }, indent: 0 }
const callsOf = async (ctx) => {
  await drain(() => extendSession(ctx, 'sid-a', Infinity))
  const doc = JSON.parse((await answer(req, ctx)).bytes)
  assert.equal(doc.pending, undefined)
  return doc.calls.map((c) => c.rid)
}

test('4.3 §4 折叠日志: a member swapped before the frontier, as many members as before, is folded again, not answered from the log', async () => {
  const home = rawHome('trocar-fold-members-')
  writeSegment(home, SEG, RECS.map((r) => JSON.stringify(r)))
  const first = await callsOf(proc(home, 2))
  assert.deepEqual(first, [`${SEG}:1`, `${SEG}:2`, `${SEG}:4`], 'summary 1 read back, in A; summary 2 not')
  const reused = await callsOf(proc(home, 1)) // the log the first process folded is on disk
  fs.rmSync(sessionDir(home, 'sid-a'), { recursive: true, force: true })
  const fresh = await callsOf(proc(home, 1))
  assert.deepEqual(fresh, [`${SEG}:1`, `${SEG}:3`, `${SEG}:4`], 'summary 2 read back, in A; summary 1 not')
  assert.deepEqual(reused, fresh, 'over the earlier log: what a fresh fold answers')
})

// one worker across the swap: its first row list could not read summary 2; a minute on (rows.mjs FAILED_RETRY_MS) a list built again
// reads it back, and the rule moves the summaries with no file changed. The plan, state and answer the worker holds for A follow
// the members, not their count
test('4.3 §4 折叠日志: a worker that holds A across a swap at equal count answers what a fresh fold answers', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 })
  const home = rawHome('trocar-fold-members-warm-')
  writeSegment(home, SEG, RECS.map((r) => JSON.stringify(r)))
  const disk = { fail: 2 }
  const ctx = { home, writer: true, fs: { ...fs, readSync: (fd, b, o, len, pos, ...a) => {
    if (disk.fail && pos === SEEK[disk.fail - 1]) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
    return fs.readSync(fd, b, o, len, pos, ...a)
  } } }
  assert.deepEqual(await callsOf(ctx), [`${SEG}:1`, `${SEG}:2`, `${SEG}:4`])
  const before = await answer(req, ctx)
  disk.fail = 1
  t.mock.timers.tick(60_000)
  await answer(req, ctx) // the first read a minute on says the old failure and lets that list go
  // the answer kept for A (src/query/answers.mjs) is not handed out: a swap with no file changed comes of a read that failed and
  // reads now, and the version carries the index's errors (3.5 答案缓存)
  assert.notEqual((await answer(req, ctx)).tag, before.tag, 'another version')
  assert.deepEqual(await callsOf(ctx), [`${SEG}:1`, `${SEG}:3`, `${SEG}:4`], 'summary 2 read back, in A; summary 1 not')
  // the head the daemon hands out from disk (4.4 §答案文件) is the one a fresh fold of these members writes
  const headOf = (h) => { const d = JSON.parse(gunzipSync(fs.readFileSync(path.join(sessionDir(h, 'sid-a'), 'head.json.gz')))); delete d.as_of; return d }
  const other = rawHome('trocar-fold-members-fresh-')
  writeSegment(other, SEG, RECS.map((r) => JSON.stringify(r)))
  await callsOf(proc(other, 1))
  assert.deepEqual(headOf(home), headOf(other), 'the head file')
})

