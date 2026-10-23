// 3.5 验收 #29 (§内存有界 `steady`): what every query reads again — the segments' index rows, the row list and its session index —
// holds at most 64 B of V8 heap per index row, and `steadyBytes()` charges at least what it holds. Measured as the worker reads:
// a child process in a heap of the worker's size, homes the keeper indexed (the reader reads the index files), forced GC.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { heapFlags } from '../../src/query/warm.mjs'
import { segmentIndex, segmentFiles } from '../../src/query/index-build.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { writeSegment } from './raw-home.mjs'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const N = 20_000, SEGMENTS = 3, PER_ROW = 64 // 64 B: spec 3.5:48

// one shape at any size: sessions of ~200 rows (model calls and the non-model rows around them), and session-less telemetry
const shape = (n, t0) => {
  const ts = new Date(t0 + n * 1000).toISOString()
  if (n % 5 === 4) return { id: `t${n}`, ts, is_llm: false, class: 'telemetry', host: `h${n % 7}.example`, path: `/v1/t/${n % 11}`, harness: 'claude-code' }
  return { id: `r${n}`, ts, is_llm: n % 5 !== 3, class: n % 5 === 3 ? 'files' : 'llm', status: [200, 200, 429, 500][n % 4],
    sessionKey: `s-${Math.floor(n / 200)}`, harness: 'opencode', path: n % 5 === 3 ? '/v1/files' : '/v1/messages' }
}
async function home(rows, base) {
  const h = path.join(tmpDir('trocar-steady-'), '.trocar')
  fs.mkdirSync(path.join(h, 'raw'), { recursive: true })
  const per = Math.ceil(rows / SEGMENTS)
  for (let s = 0; s < SEGMENTS; s++) {
    const lines = []
    for (let n = s * per; n < Math.min(rows, (s + 1) * per); n++) lines.push(shape(base + n, Date.parse('2026-11-01T00:00:00Z')))
    writeSegment(h, `20261101T0${s}0000Z`, lines)
  }
  for (const [segment] of segmentFiles(h)) await segmentIndex({ home: h, segment, owner: true }) // the keeper's pass
  return h
}

// homes in order (the first warms the code up); for each: the live heap and steadyBytes() it added, and its rows
const MEASURE = `
import { indexRows, sessionGroups } from ${JSON.stringify(new URL('../../src/query/rows.mjs', import.meta.url).href)}
import { liveHeap, steadyBytes } from ${JSON.stringify(new URL('../../src/query/warm.mjs', import.meta.url).href)}
const held = [], out = []
for (const home of JSON.parse(process.argv[1])) {
  const h0 = liveHeap(), s0 = steadyBytes()
  const rows = await indexRows({ home }), groups = sessionGroups(rows)
  held.push(rows, groups, groups.size)
  out.push({ rows: rows.length, heap: liveHeap() - h0, steady: steadyBytes() - s0 })
}
process.stdout.write(JSON.stringify(out))
`
let measured = null
const measure = () => (measured ||= (async () => {
  const homes = [await home(600, 0), await home(N, 1e6), await home(2 * N, 2e6)]
  const out = JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, '--expose-gc', '--single-threaded', ...heapFlags(),
    '--input-type=module', '-e', MEASURE, JSON.stringify(homes)], { maxBuffer: 1 << 24 }))
  return { one: out[1], two: out[2] }
})())

test('the steady heap grows by at most 64 B per index row (3.5 #29)', { timeout: 300_000 }, async () => {
  const { one, two } = await measure()
  assert.equal(two.rows, 2 * one.rows)
  const slope = (two.heap - one.heap) / one.rows
  assert.ok(slope <= PER_ROW, `live heap per index row: ${slope.toFixed(1)} B (${JSON.stringify({ one, two })})`)
})

test('steadyBytes() charges at least the live heap the rows hold, and at most 64 B per row (3.5 #29)', { timeout: 300_000 }, async () => {
  const { two } = await measure()
  assert.ok(two.steady >= two.heap && two.steady <= PER_ROW * two.rows, `steadyBytes() +${two.steady} B for +${two.heap} B live, ${two.rows} rows`)
})
