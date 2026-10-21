// test/view/extract-heap.test.mjs — extraction is bounded by construction (RFC 4.3 §4 门槛「抽取按构造有界」): what it keeps
// while it runs does not grow with the session's contexts. Its peak live heap at a small worker-like heap stays under half of it,
// and a session twice as long peaks no higher than the shorter one plus SLACK_PER_CALL for each added call: what extraction keeps
// of a call it has written is where that call's row and new blocks are on disk and the id a successor links it by, never the row,
// its facts or its record (holding the rows cost ~10 KiB a call: the 2026-10-21 OOM class).
//
// Generated sessions (test/query/big-session.mjs): Message Threads (each call stitched to its predecessor's row), thirty subagent
// lanes side by side, tool results of a few KB each turn. Each session is extracted whole in a process of its own; the peak is
// sampled after a forced GC at every fourth chunk of records read, above the heap held once the index is read.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from '../query/big-session.mjs'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const HEAP_MB = 64 // the child's old space (the query worker's is larger; the bound is a share of whatever it is)
const SLACK_PER_CALL = 2 * 1024
const N = 2_000
const src = (p) => JSON.stringify(new URL(`../../src/${p}`, import.meta.url).href)
const CHILD = `
const { indexRows, sessionGroups } = await import(${src('query/rows.mjs')})
const { recordsAt } = await import(${src('query/records.mjs')})
const { openProjection } = await import(${src('query/projection.mjs')})
const { extractMembers } = await import(${src('view/extract.mjs')})
const [home, id] = process.argv.slice(1)
const errors = [], members = sessionGroups(await indexRows({ home, errors })).get(id)
global.gc(); global.gc()
const base = process.memoryUsage().heapUsed
let peak = 0, n = 0
const sample = () => { global.gc(); peak = Math.max(peak, process.memoryUsage().heapUsed - base) }
const read = (rows) => { if (n++ % 4 === 0) sample(); return recordsAt({ home, rows, errors, remember: false }) }
const r = extractMembers({ store: openProjection({ home, key: id }), members, recordsAt: read, sessionId: id })
sample()
console.log(JSON.stringify({ done: r.done, total: r.total, peak }))`

function peakOf(calls) {
  const home = path.join(tmpDir('trocar-extract-heap-'), '.trocar')
  const s = bigSession({ home, wire: 'threads', growth: 8_000, subEvery: 2, subLanes: 30, subLen: 12, compactAt: 400_000 })
  s.append(calls)
  let out
  try {
    out = execFileSync(process.execPath, ['--require', NO_REAL_OS, '--expose-gc', `--max-old-space-size=${HEAP_MB}`, '--input-type=module', '-e', CHILD, home, s.id],
      { encoding: 'utf8', maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    assert.fail(`extracting ${calls} calls at ${HEAP_MB} MB did not finish (exit ${e.status}): ${String(e.stderr).split('\n').find((l) => /FATAL|Error/.test(l)) || ''}`)
  }
  const r = JSON.parse(out)
  assert.equal(r.done, r.total)
  assert.equal(r.total, calls)
  return r.peak
}

test(`extraction peaks under half the heap, and ${2 * N} calls peak no higher than ${N} plus SLACK_PER_CALL a call`, () => {
  const one = peakOf(N), two = peakOf(2 * N), mb = (b) => `${(b / 1048576).toFixed(1)} MB`
  for (const p of [one, two]) assert.ok(p < (HEAP_MB << 20) / 2, `peak ${mb(p)} at a ${HEAP_MB} MB heap`)
  assert.ok(two - one <= N * SLACK_PER_CALL, `${N} calls peak at ${mb(one)}, ${2 * N} at ${mb(two)}: past ${SLACK_PER_CALL} bytes for each added call`)
})
