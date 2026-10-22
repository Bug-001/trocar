// test/query/cut-fits.test.mjs — a session past the heap bound shows the newest calls that FIT, not a sliver of them (RFC 3.5
// §内存有界: 只读从尾部往前放得进的记录,至多少一步,截断点落在步格上).
//
// The room is the spine's share of the read side's budget: the budget less the working set of a fold (working()), the steady
// caches and the distinct blocks (SPINE_PER_BLOCK each) counted in whole steps (a step = a tenth of the budget). A cut session reads the newest rows that fit the room less at most
// one step, the cut on the step grid: its rows, each at what the plan reckons a row costs, fill the room less at most two steps. The
// plan reckons SPINE_PER_ROW until a fold measured more (the measured bound: a fold whose heap passes the whole reservation stops,
// and the plan reads as many rows as it got through, its cost rounded up to a quarter power of two), so rows that cost the estimate
// are cut by the estimate, never harder (review 2026-10-21: dividing the heap's whole growth by the rows folded showed ~1 % of the
// user's session).
//
// One cold query in a process of its own with a small heap (test/query/past-room.mjs readerFlags), of a session grown and extracted
// past its room beforehand (pastRoom), so a session past its budget stays small.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpDir } from '../helpers/tmp.mjs'
import { REDUCE_HEAP } from '../../src/view/reduce.mjs'
import { LOG_BYTES } from '../../src/query/fold-log.mjs'
import { pastRoom, readerFlags } from './past-room.mjs'

const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
// read as the worker reads it (it writes the projection, 3.5 §后台抽取), until no member is above the extraction frontier
const READ = `
const fs = await import('node:fs')
const { runQuery } = await import(${at('../../src/query/named/index.mjs')}) // first: the registry imports session.mjs
const { SPINE_PER_ROW, SPINE_PER_BLOCK, working } = await import(${at('../../src/query/named/session.mjs')})
const { heapBudget, steadyBytes, liveHeap } = await import(${at('../../src/query/warm.mjs')})
const { STORE_HEAP, projectionFile } = await import(${at('../../src/query/projection.mjs')})
const { indexRows, sessionGroups } = await import(${at('../../src/query/rows.mjs')})
// the projection's definition lines, counted over its bytes (a Buffer, outside the heap measured)
const defs = (b) => { let n = 0; for (let i = b.indexOf('\\n{"d":'); i >= 0; i = b.indexOf('\\n{"d":', i + 1)) n++; return n }
const [home, id] = process.argv.slice(1)
const before = liveHeap()
let doc
do doc = await runQuery('session', { id, limit: '60' }, { home, writer: true }); while (doc.pending)
const { truncated } = doc, total = doc.lanes.reduce((n, l) => n + l.count, 0)
doc = null
const kept = liveHeap() - before // the spine, kept warm for the next look
const rows = sessionGroups(await indexRows({ home, errors: [] })).get(id), blocks = defs(fs.readFileSync(projectionFile(home, id)))
// the room: the budget less the work, the steady caches and the distinct blocks, each counted in whole steps
const step = heapBudget() / 10
const room = heapBudget() - working(rows) - Math.ceil(steadyBytes() / step) * step - Math.ceil(blocks * SPINE_PER_BLOCK / step) * step
console.log(JSON.stringify({ truncated, total, rows: rows.length, kept, room, step, SPINE_PER_ROW, STORE_HEAP }))`

const cut = (shape, heapMb) => {
  const home = path.join(tmpDir('trocar-cutfits-'), '.trocar'), id = pastRoom({ home, shape, heapMb })
  const out = JSON.parse(execFileSync(process.execPath, [...readerFlags(heapMb), '--input-type=module', '-e', READ, home, id], { encoding: 'utf8', maxBuffer: 1 << 20 }))
  const t = out.truncated
  assert.ok(t, `a session of ${out.rows} rows is past a room of ${mb(out.room)} MB (else this test proves nothing)`)
  assert.ok(t.shown < t.total && out.total === t.shown)
  return { ...out, shown: t.shown, total: t.total, perRow: out.kept / t.shown }
}
const mb = (n) => (n / 1048576).toFixed(0)

// Rows that cost about what the plan reckons: the plan's cut stands — the measured bound, there for rows dearer than the estimate,
// does not cut harder. A row that kept its request body alive (6a2e79a3: an object key that were a slice of it) made the measured
// bound cut this session, as it cut the user's to ~4 % of its calls.
test('3.5 §内存有界: a cut session whose rows cost what the plan reckons shows the calls that fit the room, less at most two steps', { timeout: 300_000 }, () => {
  // Claude Code on Message Threads, its tool definitions and cache markers riding every request (cc): a body has the long keys and
  // the resent items a real one has
  const c = cut({ growth: 150, subEvery: 4, subLanes: 3, subLen: 12, wire: 'threads', compactAt: 3_000, cc: 4 }, 128)
  // beside the fixed caches (3.5 §内存有界 K): the store's, the reduction's lists and facts, the fold log's lines
  assert.ok(c.kept <= c.shown * c.SPINE_PER_ROW + c.STORE_HEAP + REDUCE_HEAP + 2 * LOG_BYTES,
    `${mb(c.kept)} MB kept for ${c.shown} calls: ${(c.perRow / 1024).toFixed(0)} KiB a call, past ${c.SPINE_PER_ROW / 1024} KiB each beside the fixed caches`)
  assert.ok(c.shown * c.SPINE_PER_ROW >= c.room - 2 * c.step,
    `${c.shown} / ${c.total} calls shown, ${mb(c.shown * c.SPINE_PER_ROW)} MB at ${c.SPINE_PER_ROW / 1024} KiB each, of a ${mb(c.room)} MB room: more than two ${mb(c.step)} MB steps short (${(c.perRow / 1024).toFixed(0)} KiB kept a call)`)
})
