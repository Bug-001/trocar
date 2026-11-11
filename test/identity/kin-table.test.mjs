// test/identity/kin-table.test.mjs — the attribution table (4.2 §归属表): a compaction request's kinship outcome, stored by record id,
// gives the same membership with no record read back; another version or a torn file is no table; a request a failed read decided is
// not stored; a segment gone takes its entries with it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { KIN_V } from '../../src/dissect/synth-key.mjs'
import { indexRows, saveKin } from '../../src/query/rows.mjs'
import { rawHome, writeSegment } from '../query/raw-home.mjs'

const T0 = Date.parse('2026-10-18T10:00:00.000Z'), MIN = 60_000
const UA = { 'user-agent': 'pi/1.4.0 (darwin; node/v22.23.3; arm64)' }
const PI = 'You are pi, an expert coding assistant.', SUMMARY = 'You are a context summarization assistant. Produce a structured summary.'
const WORDS = 'the parser keeps every token offset while the lexer module reports each failing test before release and after review'.split(' ')
const prose = (seed, len) => { let s = '', x = seed; while (s.length < len) { x = (Math.imul(x ^ (x >>> 15), 2246822507) + 0x9e3779b9) >>> 0; s += WORDS[x % WORDS.length] + ' ' } return s.slice(0, len).trim() }
let n = 0
const rec = (system, input, reply, ms) => ({ id: `req_${++n}`, ts: new Date(ms).toISOString(), ts_request: new Date(ms).toISOString(), method: 'POST', host: 'api.anthropic.com',
  endpoint: '/v1/messages', req_headers: { 'content-type': 'application/json', ...UA },
  req_body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4096, system, messages: input.map((t) => ({ role: 'user', content: [{ type: 'text', text: t }] })) }),
  resp: { status: 200, kind: 'json', body: { content: reply ? [{ type: 'text', text: reply }] : [] } },
  is_llm_call: true, capture: 'transparent', traffic_class: 'llm', proc: { pid: 7, exe: '/x', agent: 'pi' } })
const saying = (s) => Array.from({ length: 3 }, (_, i) => `user ${s} asks ${i}: ${prose(700 + 10 * s + i, 300)}`)
const asking = (s, reply, ms) => rec(`${PI}\n<cwd>\n/work/${s}\n</cwd>`, saying(s), reply, ms)
// session 1 replied r1; session 0 is the latest to speak. The summary carries session 0's user texts and session 1's reply: by its items
// (three of session 0's, one of session 1's) it joins session 0; by the reply alone it would join session 1; one that shares nothing joins none
const r1 = prose(41, 600)
const RECS = [asking(1, r1, T0), asking(0, null, T0 + MIN),
  rec(SUMMARY, ['<conversation>\n' + [...saying(0).map((u) => `[User]: ${u}`), `[Assistant]: ${r1}`].join('\n\n') + '\n</conversation>'], null, T0 + 2 * MIN),
  rec(SUMMARY, ['<conversation>\n[User]: ' + prose(99, 900) + '\n</conversation>'], null, T0 + 3 * MIN)]
const SEG = '20261018T100000Z', file = (home) => path.join(home, 'index', 'kinship.json')
const homeOf = () => { const h = rawHome('trocar-kin-table-'); writeSegment(h, SEG, RECS.map((r) => JSON.stringify(r))); return h }
// a process of its own: a new fs object is a new table and a new row list (warm.mjs fsTag). `eio`: every record read back fails (a seek
// to a line reads from the newline before it); the index's scan of the segment does not seek there
const ENDS = RECS.slice(0, -1).reduce((a, r) => [...a, (a.at(-1) ?? -1) + Buffer.byteLength(JSON.stringify(r)) + 1], [])
const reader = (eio = false) => ({ ...fs, readSync: (fd, b, o, len, pos, ...rest) => {
  if (eio && ENDS.includes(pos)) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
  return fs.readSync(fd, b, o, len, pos, ...rest)
} })
const build = async (home, f) => { const errors = [], rows = [...await indexRows({ home, fs: f, errors })]; return { errors, sids: rows.map((r) => r.session_id), ids: rows.map((r) => r.id) } }
const doc = (home) => JSON.parse(fs.readFileSync(file(home), 'utf8'))

test('4.2 归属表: the outcome is stored by the record of the session\'s latest call; with it, the same membership and no record read back', async () => {
  const home = homeOf(), f = reader()
  const first = await build(home, f)
  assert.deepEqual(first.errors, [])
  assert.equal(first.sids[2], first.sids[1], 'by items: session 0')
  assert.notEqual(first.sids[2], first.sids[0])
  await saveKin({ home, fs: f })
  assert.deepEqual(doc(home), { v: KIN_V, d: { [first.ids[2]]: first.ids[1], [first.ids[3]]: '' } }, 'session 0\'s latest call; none')
  const again = await build(home, reader(true)) // every record read back fails: none is made
  assert.deepEqual(again.errors, [])
  assert.deepEqual(again.sids, first.sids)
  fs.rmSync(file(home))
  assert.notEqual((await build(home, reader(true))).errors.length, 0, 'no table: the rule reads back')
})

test('4.2 归属表: another version, or a torn file, is no table: the rule decides and the save writes this version', async () => {
  const home = homeOf(), { sids: want, ids } = await build(home, reader())
  for (const bytes of [JSON.stringify({ v: KIN_V + 1, d: { [ids[2]]: ids[0] } }), '{"v":' + KIN_V + ',"d":{"' + ids[2]]) {
    fs.mkdirSync(path.dirname(file(home)), { recursive: true }); fs.writeFileSync(file(home), bytes)
    const f = reader(), got = await build(home, f)
    assert.deepEqual(got.errors, [])
    assert.deepEqual(got.sids, want, 'the stored outcome is not taken')
    await saveKin({ home, fs: f })
    assert.equal(doc(home).v, KIN_V)
    assert.equal(doc(home).d[ids[2]], ids[1])
  }
})

test('4.2 归属表: a request decided while a record could not be read back is not stored; a segment gone takes its entries', async () => {
  const home = homeOf(), at = ENDS[0] // session 0's latest call
  const f = { ...fs, readSync: (fd, b, o, len, pos, ...rest) => { if (pos === at) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); return fs.readSync(fd, b, o, len, pos, ...rest) } }
  const got = await build(home, f)
  assert.notEqual(got.errors.length, 0)
  fs.mkdirSync(path.dirname(file(home)), { recursive: true })
  fs.writeFileSync(file(home), JSON.stringify({ v: KIN_V, d: { '20200101T000000Z:3': '20200101T000000Z:1' } }))
  const g = reader(), ok = await build(home, g)
  await saveKin({ home, fs: f })
  assert.equal(doc(home).d[got.ids[2]], undefined, 'not stored by the build that failed a read')
  await saveKin({ home, fs: g })
  assert.deepEqual(doc(home), { v: KIN_V, d: { [ok.ids[2]]: ok.ids[1], [ok.ids[3]]: '' } }, 'the gone segment\'s entry dropped')
})
