// test/query/usage-sidecar.test.mjs — the per-segment usage sidecar (RFC 4.2 §用量旁注; 3.5 §访问模式).
// The usage-bearing records are the captured bytes of test/fixtures/old-capture-resp-shapes.ndjson (regression seeds):
// only their time, session id, host and status are restamped, the reply bytes are as captured.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rawHome, writeSegment, envLine } from './raw-home.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'
import { usageFile, readUsage, fillUsage } from '../../src/query/usage.mjs'

const SEG = '20261018T100000Z'
const T0 = Date.parse('2026-10-18T10:00:00.000Z')
const at = (s) => new Date(T0 + s * 1000).toISOString()
const SEED = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/old-capture-resp-shapes.ndjson'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l))
const SID_HEADER = Object.keys(SEED[0].req_headers).find((k) => /session-id$/.test(k))
const seed = (i, { s, session, id, ...over }) => JSON.stringify({ ...SEED[i], ts: at(s), ts_request: at(s), id: id ?? `r-${session}-${s}`,
  req_headers: { ...SEED[i].req_headers, [SID_HEADER]: session }, ...over })
const logged = (o) => { const r = JSON.parse(seed(0, o)); return JSON.stringify({ ...r, body_retention: 'log', req_body: { raw_chars: 116, verbatim: false } }) }
const nonLlm = (s) => envLine({ ts: at(s), id: `t-${s}`, class: 'telemetry', is_llm: false, path: '/api/event_logging/batch' })

// line 1 SEED[0] answered by Anthropic itself · 2 deepseek · 3 status 500 · 4 log-only · 5 non-LLM
const BASE = [
  seed(0, { s: 1, session: 'a', host: 'api.anthropic.com' }),
  seed(0, { s: 2, session: 'a', host: 'api.deepseek.com' }),
  seed(0, { s: 3, session: 'a', resp: { ...SEED[0].resp, status: 500 } }),
  logged({ s: 4, session: 'a' }),
  nonLlm(5),
]
const homeWith = async (lines) => {
  const home = rawHome()
  writeSegment(home, SEG, lines)
  await segmentIndex({ home, segment: SEG, owner: true }) // the index the daemon keeps (4.2 §段索引)
  return home
}
const docOf = (home) => fs.readFileSync(usageFile(home, SEG), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const callsOf = (home) => docOf(home).filter((o) => 'line' in o)
const appendRaw = (home, lines) => fs.appendFileSync(path.join(home, 'raw', `${SEG}.ndjson`), lines.join('\n') + '\n')

test('4.2:53-55 format: one call line per model call, the 3.2 mapping, a v1 mark to the last line', async () => {
  const home = await homeWith(BASE)
  await fillUsage({ home, segments: [SEG] })
  assert.equal(fs.statSync(usageFile(home, SEG)).mode & 0o777, 0o600)
  const doc = docOf(home)
  const calls = doc.filter((o) => 'line' in o)
  assert.deepEqual(calls.map((c) => c.line).sort(), [1, 2, 3], 'the LLM lines that are not log-only')
  for (const c of calls) assert.deepEqual(Object.keys(c), ['line', 'lane', 'model', 'failed', 'cache_known', 'usage'])
  const by = new Map(calls.map((c) => [c.line, c]))
  assert.equal(by.get(3).failed, true)
  assert.equal(by.get(3).usage, null)
  const u = SEED[0].resp.body.usage // Anthropic itself: an absent cache counter reads as 0 (3.2)
  assert.deepEqual(by.get(1).usage, [u.input_tokens, u.output_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0])
  assert.equal(by.get(1).model, JSON.parse(SEED[0].req_body).model)
  assert.equal(by.get(2).usage[3], null, 'a vendor that reports no write counter: null, never 0')
  const last = doc[doc.length - 1]
  assert.equal(last.v, 1)
  assert.equal(last.m.lines, BASE.length)
})

test('4.2:109 · 4.2:57 ④ an append adds only its own calls; a rebuild equals the increments; no model call, no write', async () => {
  const home = await homeWith(BASE)
  await fillUsage({ home, segments: [SEG] })
  const before = fs.readFileSync(usageFile(home, SEG))
  appendRaw(home, [seed(0, { s: 6, session: 'a' }), nonLlm(7), seed(0, { s: 8, session: 'b', host: 'api.deepseek.com' })])
  await fillUsage({ home, segments: [SEG] })
  const grown = fs.readFileSync(usageFile(home, SEG))
  assert.ok(grown.length > before.length && grown.subarray(0, before.length).equals(before), 'the old bytes are a prefix of the new file')
  const incremental = callsOf(home)

  fs.unlinkSync(usageFile(home, SEG))
  await fillUsage({ home, segments: [SEG] })
  assert.deepEqual(callsOf(home), incremental)

  const now = fs.readFileSync(usageFile(home, SEG))
  appendRaw(home, [nonLlm(9)])
  await fillUsage({ home, segments: [SEG] })
  assert.deepEqual(fs.readFileSync(usageFile(home, SEG)), now)
})

test('4.2:55 identity: a rewritten segment voids the sidecar; a sealed one is rebuilt whole with a sealed mark', async () => {
  const home = await homeWith(BASE)
  await fillUsage({ home, segments: [SEG] })
  const plain = callsOf(home)
  const file = path.join(home, 'raw', `${SEG}.ndjson`)
  const bytes = fs.readFileSync(file)
  assert.ok(readUsage({ home, segment: SEG }), 'the filled sidecar is read')

  const rewritten = Buffer.from(bytes.toString('latin1').replace('msg_1', 'msg_2'), 'latin1')
  assert.equal(rewritten.length, bytes.length)
  assert.ok(!rewritten.equals(bytes))
  fs.writeFileSync(file, rewritten)
  assert.equal(readUsage({ home, segment: SEG }), null)

  fs.writeFileSync(file, bytes)
  const { sealSegment } = await import('../../src/raw/seal.mjs')
  await sealSegment(file, { lockFile: path.join(home, 'collector', 'lock'), journal: null })
  assert.equal(readUsage({ home, segment: SEG }), null, 'the plaintext sidecar does not stand for the sealed copy')
  await fillUsage({ home, segments: [SEG] })
  const doc = docOf(home)
  assert.equal(doc[doc.length - 1].m.sealed, true)
  assert.deepEqual(callsOf(home), plain)
  assert.equal(readUsage({ home, segment: SEG }).lines, Infinity)
})
