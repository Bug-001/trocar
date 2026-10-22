// test/view/extract-heap.test.mjs — extraction is bounded by construction (RFC 4.3 §4 门槛「抽取按构造有界」): what it keeps
// while it runs does not grow with the session's contexts. Its peak live heap at a small worker-like heap stays under half of it,
// and a session twice as long peaks no higher than the shorter one plus SLACK_PER_CALL for each added call: what extraction keeps
// of a call it has written is where that call's row and new blocks are on disk and the id a successor links it by, never the row,
// its facts or its record (holding the rows cost ~10 KiB a call: the 2026-10-21 OOM class).
//   Nor does what it keeps grow with how long a context gets: one lane that never compacts, its context a few MB at the end,
// still peaks under half the heap (rows kept by count held a long lane's rows, each the size of its context: 2026-10-22). A
// session whose calls each bring new tool definitions grows by at most SLACK_PER_DEF for each new definition. And it runs in
// time linear in the calls of a lane that compacts: four times the calls take at most SLOWER times as long (each operation of
// the store's caches O(1); evicting from one Map in insertion order cost time with its size, 2026-10-22).
//
// Both media of the store hold to it: the projection file (the worker) and the off-heap arena that writes nothing (the local path),
// so neither keeps the rows in the V8 heap. And a cluster of records megabytes each is read a chunk of stored bytes at a time, so
// extraction's peak stays within what the session reserves for its work (working(), src/query/named/session.mjs).
//
// Generated sessions (test/query/big-session.mjs): Message Threads (each call stitched to its predecessor's row), thirty subagent
// lanes side by side, tool results of a few KB each turn, and the live session's paths, writes and prompts. Each session is
// extracted whole in a process of its own; the peak is sampled after a forced GC once a chunk of records is read (every fourth
// chunk, or every one), above the heap held once the index is read.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from '../query/big-session.mjs'
import { WORKER_MEMORY_MB, heapFlags } from '../../src/query/warm.mjs'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const HEAP_MB = WORKER_MEMORY_MB / 6 // the child's heap: a share of the worker's (the bound is a share of whatever it is)
const SLACK_PER_CALL = 2 * 1024
const N = 2_000
const SLACK_PER_DEF = 512
const SLOWER = 5 // four times the calls: 4 if linear, a quarter more for noise
const src = (p) => JSON.stringify(new URL(`../../src/${p}`, import.meta.url).href)
const CHILD = `
const { indexRows, sessionGroups } = await import(${src('query/rows.mjs')})
const { recordsAt } = await import(${src('query/records.mjs')})
const { openProjection } = await import(${src('query/projection.mjs')})
const { extractMembers } = await import(${src('view/extract.mjs')})
await import(${src('query/named/index.mjs')}) // the registry first: it imports session.mjs
const { working } = await import(${src('query/named/session.mjs')})
const [home, id, medium, every] = process.argv.slice(1)
const errors = [], members = sessionGroups(await indexRows({ home, errors })).get(id)
global.gc(); global.gc()
const base = process.memoryUsage().heapUsed
let peak = 0, n = 0
const sample = () => { global.gc(); peak = Math.max(peak, process.memoryUsage().heapUsed - base) }
const read = (rows) => { const got = recordsAt({ home, rows, errors, remember: false }); if (n++ % Number(every) === 0) sample(); return got }
const t0 = performance.now()
const r = extractMembers({ store: openProjection({ home, key: id, write: medium === 'file' }), members, recordsAt: read, sessionId: id })
const ms = performance.now() - t0
sample()
console.log(JSON.stringify({ done: r.done, total: r.total, peak, ms, working: working(members) }))`

const LANES = { wire: 'threads', growth: 8_000, subEvery: 2, subLanes: 30, subLen: 12, compactAt: 400_000 }
// the user's live session's axes (test/query/big-session.mjs live()) on the lanes above: paths named, prompts with their reminders, writes
const SHAPED = { ...LANES, paths: 4, prompt: 12_000, writes: 1_200 }
// the store's two media: a projection file (the worker), the off-heap arena that writes nothing (the local path)
const MEDIA = ['file', 'arena']
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`

function run(calls, shape = LANES, { medium = 'file', heapMb = HEAP_MB, every = 4 } = {}) {
  const home = path.join(tmpDir('trocar-extract-heap-'), '.trocar')
  const s = bigSession({ home, ...shape })
  s.append(calls)
  let out
  try {
    out = execFileSync(process.execPath, ['--require', NO_REAL_OS, '--expose-gc', ...heapFlags(heapMb), '--input-type=module', '-e', CHILD, home, s.id, medium, String(every)],
      { encoding: 'utf8', maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    assert.fail(`extracting ${calls} calls (${medium}) at ${heapMb} MB did not finish (exit ${e.status}): ${String(e.stderr).split('\n').find((l) => /FATAL|Error/.test(l)) || ''}`)
  }
  const r = JSON.parse(out)
  assert.equal(r.done, r.total)
  assert.equal(r.total, calls)
  return r
}
const peakOf = (calls, shape, o) => run(calls, shape, o).peak

for (const medium of MEDIA) {
  test(`extraction into the ${medium} peaks under half the heap, and ${2 * N} calls peak no higher than ${N} plus SLACK_PER_CALL a call`, () => {
    const one = peakOf(N, SHAPED, { medium }), two = peakOf(2 * N, SHAPED, { medium })
    for (const p of [one, two]) assert.ok(p < (HEAP_MB << 20) / 2, `${medium}: peak ${mb(p)} at a ${HEAP_MB} MB heap`)
    assert.ok(two - one <= N * SLACK_PER_CALL, `${medium}: ${N} calls peak at ${mb(one)}, ${2 * N} at ${mb(two)}: past ${SLACK_PER_CALL} bytes for each added call`)
  })
}

// a cluster of records megabytes each (files read into the context), so sixteen records in a row store far more than CHUNK_STORED:
// what extraction holds at once is a chunk by stored bytes, so its peak stays within the work the session reserves for it
test('extraction through records of megabytes peaks within the work reserved for it (working())', () => {
  const r = run(32, { wire: 'http', growth: 2_000, subEvery: 0, bigEvery: 16, bigRun: 16, bigBytes: 15_500_000 }, { heapMb: WORKER_MEMORY_MB, every: 1 })
  assert.ok(r.peak <= r.working, `peak ${mb(r.peak)} above the ${mb(r.working)} reserved`)
})

test('one lane that never compacts peaks under half the heap', () => {
  const p = peakOf(1_000, { wire: 'threads', growth: 4_000, subEvery: 0, compactAt: Infinity })
  assert.ok(p < (HEAP_MB << 20) / 2, `peak ${mb(p)} at a ${HEAP_MB} MB heap`)
})

test(`calls that bring new tool definitions grow the peak by at most SLACK_PER_DEF for each`, () => {
  const tools = 40, n = 500, shape = { wire: 'threads', growth: 2_000, subEvery: 0, compactAt: 200_000, freshTools: tools }
  const one = peakOf(n, shape), two = peakOf(2 * n, shape)
  assert.ok(two - one <= n * tools * SLACK_PER_DEF, `${n} calls peak at ${mb(one)}, ${2 * n} at ${mb(two)}: past ${SLACK_PER_DEF} bytes for each of ${n * tools} new definitions`)
})

test(`a lane that compacts: four times the calls extract in at most SLOWER times as long`, () => {
  const shape = { wire: 'threads', growth: 4_000, subEvery: 0, compactAt: 800_000 }
  const one = run(400, shape).ms, four = run(1_600, shape).ms
  assert.ok(four <= SLOWER * one, `400 calls in ${Math.round(one)} ms, 1600 in ${Math.round(four)} ms: ${(four / one).toFixed(1)}×`)
})
