// test/collector/index-keeper.test.mjs — the daemon keeps the segment index current (D62, RFC 1.6 §4.1 / 4.2 §段索引).
// What is checked here: the index covers what was appended (no query ever builds it), one pass per burst and never on
// the record's own path, a backlog indexed in chunks with the event loop free between them, NOTHING armed while
// nothing is written (D62 idle wakeups), the hand-over at close (from there the sealer's child owns that index), and
// a write that fails being said, not swallowed (D38).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createIndexKeeper } from '../../src/collector/index-keeper.mjs'
import { segmentIndex, indexDir } from '../../src/query/index-build.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const SEG = '20261019T100000Z'
const line = (i, body = 'x'.repeat(40)) => JSON.stringify({ id: `req_${i}`, ts_request: `2026-10-19T10:00:0${i % 10}.000Z`, endpoint: '/v1/messages', host: 'api.anthropic.com', traffic_class: 'llm', is_llm_call: true, req_body: body, resp: { status: 200 }, proc: { pid: 7, exe: '/x', agent: 'claude-code' }, body_wire_bytes: { req: 1, resp: 2 } }) + '\n'

function home() {
  const h = path.join(tmpDir('asight-keeper-'), '.asight')
  fs.mkdirSync(path.join(h, 'raw'), { recursive: true })
  return h
}
const append = (h, n, from = 0, body) => { fs.appendFileSync(path.join(h, 'raw', `${SEG}.ndjson`), Array.from({ length: n }, (_, i) => line(from + i, body)).join('')) ; return n }
const idxFile = (h, seg = SEG) => path.join(indexDir(h), `${seg}.json`)
const stored = (h, seg = SEG) => JSON.parse(fs.readFileSync(idxFile(h, seg), 'utf8'))
const tick = () => new Promise((r) => setTimeout(r, 20))

test('what the daemon wrote is in the index before any query reads it: a query then reads 0 bytes of the segment', async () => {
  const h = home()
  const keeper = createIndexKeeper({ home: h, debounceMs: 1 })
  append(h, 3)
  keeper.wrote(SEG)
  await tick()
  await keeper.idle()
  const doc = stored(h)
  assert.deepEqual(doc.records.map((r) => r.id), [`${SEG}:1`, `${SEG}:2`, `${SEG}:3`])
  assert.equal(doc.mark.size, fs.statSync(path.join(h, 'raw', `${SEG}.ndjson`)).size, 'the mark covers the segment to its last byte')
  // what the fix is for: the reader finds it current — it reads nothing from the segment and reports no cold build
  const read = await segmentIndex({ home: h, segment: SEG })
  assert.deepEqual([read.bytesRead, read.problems], [0, []])
})

test('a burst is one pass, debounced, and the record\'s own path does no indexing work', async () => {
  const h = home()
  const calls = []
  const keeper = createIndexKeeper({ home: h, debounceMs: 5, index: async (a) => { calls.push(a.segment); return { problems: [], done: true, records: [] } } })
  append(h, 50)
  for (let i = 0; i < 50; i++) keeper.wrote(SEG) // one per record, as the store calls it
  assert.deepEqual(calls, [], 'nothing is indexed on the write path itself')
  await tick()
  await keeper.idle()
  assert.deepEqual(calls, [SEG], '50 records, one pass')
})

test('nothing written, nothing armed: no timer, no index file, no pass', async () => {
  const h = home()
  const calls = []
  const keeper = createIndexKeeper({ home: h, debounceMs: 1, index: async () => { calls.push(1); return { problems: [], done: true } } })
  keeper.wrote(null) // the store answers null for a segment it never opened
  await tick()
  await keeper.idle()
  assert.deepEqual(calls, [])
  assert.equal(fs.existsSync(indexDir(h)), false)
})

test('a backlog is indexed in chunks, the event loop free between them, and the result is the full index', async () => {
  const h = home()
  const big = 'y'.repeat(20_000)
  append(h, 60, 0, big) // ~1.2 MB
  let turns = 0
  const beat = setInterval(() => { turns++ }, 1)
  const keeper = createIndexKeeper({ home: h, debounceMs: 1, chunkBytes: 100_000 })
  keeper.wrote(SEG)
  await tick()
  await keeper.idle()
  clearInterval(beat)
  assert.ok(turns > 1, `the loop ran while the backlog was indexed (${turns} turns)`)
  assert.equal(stored(h).records.length, 60)
  // byte for byte what one uninterrupted build would have stored (the index is a projection, invariant 2)
  const chunked = fs.readFileSync(idxFile(h))
  fs.rmSync(indexDir(h), { recursive: true })
  await segmentIndex({ home: h, segment: SEG, owner: true })
  assert.ok(chunked.equals(fs.readFileSync(idxFile(h))), 'a chunked catch-up stores what one pass stores')
})

test('a segment that grew since the last pass costs only its new bytes', async () => {
  const h = home()
  const keeper = createIndexKeeper({ home: h, debounceMs: 1 })
  append(h, 2)
  keeper.wrote(SEG); await tick(); await keeper.idle()
  const first = stored(h).mark.end
  append(h, 2, 2)
  keeper.wrote(SEG); await tick(); await keeper.idle()
  const read = await segmentIndex({ home: h, segment: SEG })
  assert.equal(read.records.length, 4)
  assert.equal(read.bytesRead, 0)
  assert.ok(stored(h).mark.end > first)
})

test('at close the segment is indexed once more and handed over: the keeper never writes that index again', async () => {
  const h = home()
  const seen = []
  const keeper = createIndexKeeper({ home: h, debounceMs: 1, index: async (a) => { seen.push(a.segment); return { problems: [], done: true } } })
  append(h, 2)
  await keeper.flush(SEG)
  assert.deepEqual(seen, [SEG])
  keeper.wrote(SEG) // the store cannot append to a closed segment; a late call must not race the sealer's child
  await tick(); await keeper.idle()
  assert.deepEqual(seen, [SEG], 'the index of a closed segment belongs to the seal worker from then on')
})

test('an index that cannot be written is said, not swallowed (D38), and the next query is told it built cold', async () => {
  const h = home()
  const said = []
  const keeper = createIndexKeeper({ home: h, debounceMs: 1, failure: (where, err, fields) => said.push([where, err.code, fields.segment, err.message]) })
  append(h, 2)
  fs.writeFileSync(path.join(h, 'index'), 'not a directory') // index/ cannot be created
  keeper.wrote(SEG)
  await tick(); await keeper.idle()
  assert.deepEqual(said.map((s) => s.slice(0, 3)), [['raw', 'index-failed', SEG]])
  assert.match(said[0][3], /the next query indexes/)
})

test('the stop writes nothing more', async () => {
  const h = home()
  const seen = []
  const keeper = createIndexKeeper({ home: h, debounceMs: 1, index: async () => { seen.push(1); return { problems: [], done: true } } })
  append(h, 1)
  keeper.stop()
  keeper.wrote(SEG)
  await keeper.flush(SEG)
  await tick(); await keeper.idle()
  assert.deepEqual(seen, [])
})
