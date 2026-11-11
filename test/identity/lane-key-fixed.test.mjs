// test/identity/lane-key-fixed.test.mjs — a keyed call's chain (3.4 带键会话里的消息链, `lane_key`) is the rule's over the calls before
// it only: once a row has one, later records, a segment boundary or a rebuild of the index never give that row another. The context
// projection keeps a member's chain from when it was extracted and checks a row by its id (4.3 §4 有效性), so a row whose `lane_key`
// could move while its id stays would be folded under a chain it no longer has.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { indexRows } from '../../src/query/rows.mjs'
import { indexDir } from '../../src/query/index-build.mjs'
import { rawHome, writeSegment } from '../query/raw-home.mjs'

const T0 = Date.parse('2026-10-18T10:00:00.000Z')
const MAIN = 'You are Kimi Code. The main conversation.', SIDE = 'You are an explore agent.'
const hist = (tag, n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${tag} turn ${i}` }))
let n = 0
const kimi = (sys, msgs, ms) => ({ id: `k${++n}`, ts: new Date(ms).toISOString(), ts_request: new Date(ms).toISOString(), endpoint: '/v1/chat/completions', method: 'POST',
  host: 'api.moonshot.ai', req_headers: { 'content-type': 'application/json' }, req_body: JSON.stringify({ model: 'kimi', prompt_cache_key: 'K', messages: [{ role: 'system', content: sys }, ...msgs] }),
  resp: { status: 200, kind: 'json' }, is_llm_call: true, capture: 'transparent', traffic_class: 'llm', proc: { pid: 7, exe: '/x', agent: 'kimi' } })
// two side chains of one text, interleaved with the main one; each later call extends one, a fresh history starts another
let ms = T0
const RECS = [kimi(MAIN, hist('main', 3), (ms += 10_000)), kimi(SIDE, hist('a', 1), (ms += 10_000)), kimi(SIDE, hist('b', 1), (ms += 10_000)),
  kimi(MAIN, hist('main', 5), (ms += 10_000)), kimi(SIDE, hist('a', 3), (ms += 10_000)), kimi(SIDE, hist('b', 3), (ms += 10_000)),
  kimi(SIDE, hist('c', 1), (ms += 10_000)), kimi(SIDE, hist('a', 5), (ms += 10_000)), kimi(MAIN, hist('main', 7), (ms += 10_000))]
const SEG = ['20261018T100000Z', '20261018T110000Z']
const lanes = async (home) => new Map([...await indexRows({ home, fs: { ...fs } })].map((r) => [JSON.parse(fs.readFileSync(path.join(home, 'raw', `${r.segment}.ndjson`), 'utf8').split('\n')[r.lineNo - 1]).id, r.lane_key]))

test('3.4 带键会话里的消息链: a row keeps its chain as later records come, across a segment cut and after the index is rebuilt', async () => {
  const whole = rawHome('trocar-lane-key-')
  writeSegment(whole, SEG[0], RECS.map((r) => JSON.stringify(r)))
  const want = await lanes(whole)
  assert.ok(new Set([...want.values()].filter(Boolean)).size >= 3, 'three chains are named')
  for (let k = 1; k <= RECS.length; k++) { // grown one record at a time: every row read so far keeps the chain the whole read gives it
    const live = rawHome('trocar-lane-key-live-')
    writeSegment(live, SEG[0], RECS.slice(0, k).map((r) => JSON.stringify(r)))
    for (const [id, l] of await lanes(live)) assert.equal(l, want.get(id), `${id} after ${k} records`)
  }
  for (let cut = 1; cut < RECS.length; cut++) {
    const two = rawHome('trocar-lane-key-cut-')
    writeSegment(two, SEG[0], RECS.slice(0, cut).map((r) => JSON.stringify(r)))
    writeSegment(two, SEG[1], RECS.slice(cut).map((r) => JSON.stringify(r)))
    assert.deepEqual(await lanes(two), want, `cut at ${cut}`)
  }
  fs.rmSync(indexDir(whole), { recursive: true, force: true })
  assert.deepEqual(await lanes(whole), want, 'the index rebuilt')
})
