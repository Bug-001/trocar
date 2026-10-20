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
  const h = path.join(tmpDir('trocar-keeper-'), '.trocar')
  fs.mkdirSync(path.join(h, 'raw'), { recursive: true })
  return h
}
const append = (h, n, from = 0, body) => { fs.appendFileSync(path.join(h, 'raw', `${SEG}.ndjson`), Array.from({ length: n }, (_, i) => line(from + i, body)).join('')) ; return n }
const idxFile = (h, seg = SEG) => path.join(indexDir(h), `${seg}.json`)
// The append-only index document (4.2 §段索引): entry lines, problem lines and one mark line per pass, up to the
// last complete mark.
const stored = (h, seg = SEG) => {
  const lines = fs.readFileSync(idxFile(h, seg), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { records: lines.filter((o) => !o.m && !o.p), mark: lines.filter((o) => o.m).pop().m }
}
const tick = () => new Promise((r) => setTimeout(r, 20))
// The keeper's debounce timer is unref()'d — the index is a cache and never keeps a process alive on its own — so a
// test that awaits what only that timer brings about must hold the loop open itself, as the daemon's servers do;
// otherwise the runner sees an empty loop and cancels the test ("Promise resolution is still pending but the event
// loop has already resolved", macOS 27 / node 22, 2026-10-21). It waits for the event, never for a time.
const alive = async (p) => { const hold = setInterval(() => {}, 60_000); try { return await p } finally { clearInterval(hold) } }

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
  const n = append(h, 60, 0, big) // ~1.2 MB
  let turns = 0
  const beat = setInterval(() => { turns++ }, 1)
  const keeper = createIndexKeeper({ home: h, debounceMs: 1, chunkBytes: 100_000 })
  keeper.wrote(SEG)
  await tick()
  await keeper.idle()
  clearInterval(beat)
  assert.ok(turns > 1, `the loop ran while the backlog was indexed (${turns} turns)`)
  assert.equal(stored(h).records.length, n)
  // the records one uninterrupted build would have stored (the index is a projection, invariant 2; the file itself
  // carries one more mark line per chunk, which is what makes keeping it current cost the new bytes only)
  const chunked = stored(h).records
  fs.rmSync(indexDir(h), { recursive: true })
  await segmentIndex({ home: h, segment: SEG, owner: true })
  assert.deepEqual(chunked, stored(h).records, 'a chunked catch-up stores what one pass stores')
})

test('a segment that grew since the last pass costs only its new bytes, and the index file is only appended to', async () => {
  const h = home()
  const keeper = createIndexKeeper({ home: h, debounceMs: 1 })
  append(h, 2)
  keeper.wrote(SEG); await tick(); await keeper.idle()
  const first = stored(h).mark.end
  const was = fs.readFileSync(idxFile(h))
  append(h, 2, 2)
  keeper.wrote(SEG); await tick(); await keeper.idle()
  const now = fs.readFileSync(idxFile(h))
  assert.ok(now.length > was.length && now.subarray(0, was.length).equals(was), 'the second pass rewrote bytes the first had written (D62: the cost must be the new records only)')
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
})

test('the stop writes nothing more', async () => {
  const h = home()
  const seen = []
  const keeper = createIndexKeeper({ home: h, debounceMs: 1, index: async () => { seen.push(1); return { problems: [], done: true } } })
  append(h, 1)
  await keeper.stop()
  keeper.wrote(SEG)
  await keeper.flush(SEG)
  await tick(); await keeper.idle()
  assert.deepEqual(seen, [])
})

// The JSDoc of stop() promises that nothing of the keeper's is written after it returns. A stop before any pass
// cannot show that: the pass has to be IN FLIGHT when stop is called (what the daemon's stop does to a keeper that
// is still catching up).
// `wrote` is called ON the record's own write path, so a failure of the keeper's there must never reach the store:
// the store would count it as a `record-error` (D38's class for a record that was NOT written) and keep it as its
// last error, while the record is in fact on disk and only the index is behind.
test('a failure on the record\'s write path is the keeper\'s own (raw / index-failed), never thrown into the store', async () => {
  const h = home()
  const said = []
  const keeper = createIndexKeeper({ home: h, debounceMs: 1, failure: (where, err, fields) => said.push([where, err.code, fields.segment]) })
  const real = globalThis.setTimeout
  globalThis.setTimeout = () => { throw new Error('no timers left') } // the resource the debounce needs is gone
  try { keeper.wrote(SEG) } finally { globalThis.setTimeout = real }
  assert.deepEqual(said, [['raw', 'index-failed', SEG]])
})

test('stop() settles only after the pass in flight, and the index file does not grow after that', async () => {
  const h = home()
  let open = null
  const inside = new Promise((r) => { open = r })
  let gate = null
  const held = new Promise((r) => { gate = r })
  const keeper = createIndexKeeper({ home: h, debounceMs: 1,
    index: async (a) => { open(); await held; return segmentIndex(a) } })
  append(h, 3)
  keeper.wrote(SEG)
  await alive(inside) // a real pass is now inside index(), its bytes not yet written
  let settled = false
  const stopping = keeper.stop().then(() => { settled = true })
  await tick()
  assert.equal(settled, false, 'stop() must not settle while a pass is still writing')
  gate()
  await alive(stopping)
  const size = fs.statSync(idxFile(h)).size
  assert.ok(size > 0, 'the pass that was in flight finished its write before stop() settled')
  await tick()
  assert.equal(fs.statSync(idxFile(h)).size, size, 'nothing of the keeper\'s is written after stop() settles')
})

// ONE WRITER (4.2 §段索引 谁写哪一笔, MUST): the seal queue waits for `flush` before it queues a closed segment, but
// that wait has a deadline (seal-queue.mjs BEFORE_SEAL_MS) — past it the segment is sealed while a keeper pass may
// still be in flight. `handOff` is what the deadline calls: from then on this keeper writes nothing more for that
// segment, so the index the seal worker renamed into place stays the seal worker's (review of D62, 2026-10-20).
test('交接之后在飞的那趟不再写:封存器换掉索引文件,新文件一个字节不动', async () => {
  const h = home()
  append(h, 40, 0, 'y'.repeat(20_000)) // ~800 KB: more than one chunk of this keeper
  const sealer = Buffer.from('{"m":{"size":99,"sealed":true},"v":5}\n')
  let raced = false, passOver = null
  const handedOver = new Promise((r) => { passOver = r })
  const keeper = createIndexKeeper({ home: h, debounceMs: 1, chunkBytes: 100_000,
    index: async (a) => {
      const r = await segmentIndex(a)
      // the seal queue's deadline, exactly between two chunks: it takes the index away and the sealer's child
      // renames its own whole document over this file
      if (!r.done && !raced) {
        raced = true
        keeper.handOff(SEG)
        const tmp = `${idxFile(h)}.sealer`
        fs.writeFileSync(tmp, sealer); fs.renameSync(tmp, idxFile(h))
      }
      if (raced || r.done) passOver() // the hand-over happened, or the backlog ended without one (asserted below)
      return r
    } })
  keeper.wrote(SEG)
  await alive(handedOver); await keeper.idle(); await tick()
  assert.equal(raced, true, 'the backlog did take more than one chunk, which is where the hand-over was placed')
  assert.deepEqual(fs.readFileSync(idxFile(h)), sealer, 'the pass stopped before writing again')
  keeper.wrote(SEG) // and a later append to a segment that is no longer the keeper's changes nothing either
  await tick(); await keeper.idle()
  assert.deepEqual(fs.readFileSync(idxFile(h)), sealer)
})
