// test/query/index-facts.test.mjs — the segment index's two version keys (4.2 §段索引 两个版本键): `v` (INDEX_V) for the envelope's fields,
// `fv` (FACTS_V) for the facts read from the request body (BODY_FACTS). An index whose `v` is past and whose `fv` is current is rebuilt from the
// envelopes, its body facts taken from the old entry of the same line; a past `fv` rebuilds all; a v-12 mark with no `fv` is FACTS_V 1's.
// The old index is made stale by rewriting its marks, and a planted body fact (a value no record gives) says whether a field was copied.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { segmentIndex, indexDir, indexEntryOf, BODY_FACTS } from '../../src/query/index-build.mjs'
import { rawHome, writeSegment } from './raw-home.mjs'
import { bigSession } from './big-session.mjs'

const T0 = Date.parse('2026-10-18T10:00:00.000Z'), MIN = 60_000, SEG = '20261018T100000Z'
const UA = { 'user-agent': 'pi/1.4.0 (darwin; node/v22.23.3; arm64)' }
let n = 0
// a pi call (a `synth` harness: every body fact is there to read): keyless, or keyed on the Responses wire; a summary request when `summary`
const pi = ({ i, keyed = false, summary = false, ms = T0 + i * MIN }) => {
  const responses = keyed
  const system = summary ? 'You are a context summarization assistant. Produce a structured summary.' : `You are pi, an expert coding assistant.\n<cwd>\n/work/${i % 3}\n</cwd>`
  const texts = Array.from({ length: 2 + (i % 4) }, (_, k) => `turn ${k} of agent ${i % 3}: ${'the parser keeps every token offset '.repeat(3 + k)}`)
  const body = responses
    ? { model: 'gpt-5', prompt_cache_key: `sid-${i % 2}`, input: [{ role: 'developer', content: system }, ...texts.map((t) => ({ role: 'user', content: [{ type: 'input_text', text: t }] }))] }
    : { model: 'claude-sonnet-4-5', max_tokens: 4096, system, messages: texts.map((t) => ({ role: 'user', content: [{ type: 'text', text: t }] })) }
  const reply = `reply ${i}: ${'a long answer about the lexer module and each failing test '.repeat(8)}`
  return {
    id: `req_${++n}`, ts: new Date(ms).toISOString(), ts_request: new Date(ms).toISOString(), method: 'POST',
    host: responses ? 'api.openai.com' : 'api.anthropic.com', endpoint: responses ? '/v1/responses' : '/v1/messages',
    req_headers: { 'content-type': 'application/json', ...UA }, req_body: JSON.stringify(body), // a keyed call's key is in its body (prompt_cache_key)
    resp: responses ? { status: 200, kind: 'sse', raw_sse: [{ type: 'response.output_text.delta', delta: reply }] } : { status: 200, kind: 'json', body: { content: [{ type: 'text', text: reply }] } },
    is_llm_call: true, capture: 'transparent', traffic_class: 'llm', proc: { pid: 7, exe: '/x', agent: 'pi' }, body_wire_bytes: { req: 100, resp: 200 },
  }
}
// the same record with its request body stored compressed, as the collector stores a body that came compressed
const gzipped = (r) => { const { req_body, ...rest } = r; return { ...rest, req_body: null, req_body_b64: zlib.gzipSync(req_body).toString('base64'), req_content_encoding: 'gzip' } }
const PI = () => [0, 1, 2, 3, 4, 5].map((i) => pi({ i, keyed: i % 3 === 1 })).concat([pi({ i: 6, summary: true }), gzipped(pi({ i: 7 }))])

const linesOf = (home, segment) => fs.readFileSync(path.join(home, 'raw', `${segment}.ndjson`), 'utf8').split('\n').filter(Boolean)
const idxFile = (home, segment = SEG) => path.join(indexDir(home), `${segment}.json`)
const docOf = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const writeDoc = (file, doc) => fs.writeFileSync(file, doc.map((o) => JSON.stringify(o) + '\n').join(''))
/** The index file rewritten: every mark through `mark`, and the entry `at` (an index into the entries) through `entry`. */
function edit(home, { mark = (o) => o, entry = (o) => o, at = 0, segment = SEG } = {}) {
  let k = -1
  writeDoc(idxFile(home, segment), docOf(idxFile(home, segment)).map((o) => (o.m ? mark(o) : o.p ? o : ++k === at ? entry(o) : o)))
}
const PLANT = '9 9 9' // a kin_fp no record gives
const entries = (got) => [...got.records].map((r) => ({ ...r }))
const fresh = async (recs) => { const h = rawHome('trocar-facts-'); writeSegment(h, SEG, recs.map((r) => JSON.stringify(r))); return entries(await segmentIndex({ home: h, segment: SEG, owner: true })) }
async function built(recs) {
  const home = rawHome('trocar-facts-')
  writeSegment(home, SEG, recs.map((r) => JSON.stringify(r)))
  await segmentIndex({ home, segment: SEG, owner: true }) // the keeper's index of the plain segment
  return home
}

test('4.2 两个版本键: every field but BODY_FACTS reads no request body, on every wire and on a compressed body', async () => {
  const home = rawHome('trocar-facts-wires-'), segs = []
  for (const [k, wire] of ['http', 'threads', 'ws', 'chat'].entries()) {
    const segment = `2026101${k}T100000Z`
    bigSession({ home, wire, id: `big-0000-4a1b-9c2d-00000000000${k}`, segment, growth: 300, subEvery: 3, seal: 1 << 30 }).append(12)
    segs.push(segment)
  }
  writeSegment(home, SEG, PI().map((r) => JSON.stringify(r))); segs.push(SEG)
  let seen = 0
  for (const segment of segs) {
    linesOf(home, segment).forEach((line, i) => {
      const at = { segment, lineNo: i + 1, storedBytes: Buffer.byteLength(line), offset: null }
      const whole = indexEntryOf(JSON.parse(line), at)
      const { req_body, req_body_b64, ...bodyless } = JSON.parse(line)
      assert.deepEqual(indexEntryOf(bodyless, { ...at, facts: whole }), whole, `${segment}:${i + 1}: the envelope's fields are the same with no body`)
      seen++
    })
  }
  assert.ok(seen > 40, 'records of every wire were read')
  const pis = PI().map((r) => indexEntryOf(r, { segment: SEG, lineNo: 1, storedBytes: 1 }))
  assert.ok(pis.some((e) => e.kin_reply) && pis.some((e) => e.session_key), 'the pi records have body facts to lose, a session key among them')
})

test('4.2 两个版本键: an index whose v is past and whose fv is current is rebuilt from the envelopes, its body facts copied line by line', async () => {
  const recs = PI(), home = await built(recs), cold = await fresh(recs)
  edit(home, { mark: (o) => ({ ...o, v: o.v - 1 }), entry: (o) => ({ ...o, kin_fp: PLANT }), at: 2 })
  const got = entries(await segmentIndex({ home, segment: SEG, owner: true }))
  assert.equal(got[2].kin_fp, PLANT, 'copied from the old entry, not read from the body')
  assert.deepEqual(got.map((r, i) => (i === 2 ? { ...r, kin_fp: cold[2].kin_fp } : r)), cold, 'every other field as a cold build gives it')
  assert.deepEqual(docOf(idxFile(home)).filter((o) => o.m).map((o) => [o.v, o.fv]), [docOf(idxFile(await built(recs))).filter((o) => o.m).map((o) => [o.v, o.fv])[0]], 'written at the current versions')
})

test('4.2 两个版本键: a line whose old entry is not its own (other stored bytes, another offset) is computed, as is a line the old index lacks', async () => {
  const recs = PI(), home = await built(recs.slice(0, 5)), cold = await fresh(recs)
  writeSegment(home, SEG, recs.slice(5).map((r) => JSON.stringify(r))) // grown since the old index
  edit(home, { mark: (o) => ({ ...o, v: o.v - 1 }), entry: (o) => ({ ...o, kin_fp: PLANT, stored_bytes: o.stored_bytes + 1 }), at: 1 })
  let got = entries(await segmentIndex({ home, segment: SEG }))
  assert.deepEqual(got, cold, 'the mismatched line and the new lines read their bodies')
  edit(home, { mark: (o) => o, entry: (o) => ({ ...o, kin_fp: PLANT, stored_bytes: cold[3].stored_bytes, offset: o.offset + 1 }), at: 3 })
  got = entries(await segmentIndex({ home, segment: SEG }))
  assert.deepEqual(got[3], cold[3], 'another offset: computed')
})

test('4.2 两个版本键: a past fv rebuilds every fact; a v-12 mark with no fv is FACTS_V 1, past now, and rebuilds; an older one with none rebuilds', async () => {
  const recs = PI(), cold = await fresh(recs)
  let home = await built(recs)
  edit(home, { mark: (o) => ({ ...o, fv: 0 }), entry: (o) => ({ ...o, kin_fp: PLANT }), at: 2 })
  assert.deepEqual(entries(await segmentIndex({ home, segment: SEG })), cold, 'fv past: every body read again')
  home = await built(recs)
  edit(home, { mark: ({ fv, ...o }) => o, entry: (o) => ({ ...o, kin_fp: PLANT }), at: 2 })
  assert.deepEqual(entries(await segmentIndex({ home, segment: SEG })), cold, 'no fv at v 12 is FACTS_V 1, which is past: every body read again')
  home = await built(recs)
  edit(home, { mark: ({ fv, ...o }) => ({ ...o, v: 11 }), entry: (o) => ({ ...o, kin_fp: PLANT }), at: 2 })
  assert.deepEqual(entries(await segmentIndex({ home, segment: SEG })), cold, 'no fv before v 12: no known facts, every body read again')
})

test('4.2 两个版本键: a segment rewritten under the old index copies nothing, the lines may have moved', async () => {
  const recs = PI(), home = await built(recs)
  edit(home, { mark: (o) => ({ ...o, v: o.v - 1 }), entry: (o) => ({ ...o, kin_fp: PLANT }), at: 2 })
  const other = [recs[1], recs[0], ...recs.slice(2)]
  fs.rmSync(path.join(home, 'raw', `${SEG}.ndjson`)); writeSegment(home, SEG, other.map((r) => JSON.stringify(r)))
  assert.deepEqual(entries(await segmentIndex({ home, segment: SEG })), await fresh(other))
})

test('4.2 两个版本键: a sealed segment\'s index is rebuilt from the envelopes the same way', async () => {
  const fixture = fileURLToPath(new URL('../fixtures/sealed-v1/20261005T100000Z.sealed', import.meta.url))
  const home = rawHome('trocar-facts-sealed-'), segment = '20261005T100000Z'
  fs.copyFileSync(fixture, path.join(home, 'raw', `${segment}.sealed`))
  const cold = entries(await segmentIndex({ home, segment })) // a reader writes a sealed segment's index
  assert.ok(cold.length > 1)
  edit(home, { mark: (o) => ({ ...o, v: o.v - 1 }), entry: (o) => ({ ...o, kin_fp: PLANT }), at: 1, segment })
  const got = entries(await segmentIndex({ home, segment }))
  assert.equal(got[1].kin_fp, PLANT, 'copied')
  assert.deepEqual(got.map((r, i) => (i === 1 ? { ...r, kin_fp: cold[1].kin_fp } : r)), cold)
  assert.equal(entries(await segmentIndex({ home, segment }))[1].kin_fp, PLANT, 'and written: the next read reuses it')
})

test('BODY_FACTS names fields the entry has', () => {
  const e = indexEntryOf(pi({ i: 0 }), { segment: SEG, lineNo: 1, storedBytes: 1 })
  for (const k of BODY_FACTS) assert.ok(k in e, k)
})
