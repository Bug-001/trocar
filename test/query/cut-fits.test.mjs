// test/query/cut-fits.test.mjs — a session past the heap bound shows the newest calls that FIT, not a sliver of them (RFC 3.5
// §内存有界: 只读从尾部往前放得进的记录,至多少一步,截断点落在步格上).
//
// The room is the spine's share of the read side's budget: the budget less the working set of a fold (working()), the steady
// caches, the distinct blocks (SPINE_PER_BLOCK each) and the fixed caches (CACHES, K) at their bytes. A cut session reads
// the newest rows that fit the room less at most one step, the cut on the step grid (a step: a tenth of the budget, at most a
// quarter of the room, rounded down to a power of two): its rows, each at what the plan reckons a row costs, fill the room less at most two steps, and at least
// half of it. The
// plan reckons SPINE_PER_ROW until a fold measured more (the measured bound: a fold whose heap passes the whole reservation stops,
// and the plan reads as many rows as it got through, its cost rounded up to a quarter power of two), so rows that cost the estimate
// are cut by the estimate, and rows far dearer by what they cost: never to a sliver (review 2026-10-21: dividing the heap's whole
// growth by the rows folded showed ~1 % of the user's session).
//
// One cold query in a process of its own with a small heap (test/query/past-room.mjs readerFlags), of a session grown and extracted
// past its room beforehand (pastRoom), so a session past its budget stays small.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpDir } from '../helpers/tmp.mjs'
import { pastRoom, readerFlags } from './past-room.mjs'

const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
// read as the worker reads it (it writes the projection, 3.5 §后台抽取), until no member is above the extraction frontier
const READ = `
const fs = await import('node:fs')
const { runQuery } = await import(${at('../../src/query/named/index.mjs')}) // first: the registry imports session.mjs
const { SPINE_PER_ROW, SPINE_PER_BLOCK, CACHES, working } = await import(${at('../../src/query/named/session.mjs')})
const { heapBudget, steadyBytes, liveHeap } = await import(${at('../../src/query/warm.mjs')})
const { projectionFile } = await import(${at('../../src/query/projection.mjs')})
const { indexRows, sessionGroups } = await import(${at('../../src/query/rows.mjs')})
// the projection's definition lines, counted over its bytes (a Buffer, outside the heap measured)
const defs = (b) => { let n = 0; for (let i = b.indexOf('\\n{"d":'); i >= 0; i = b.indexOf('\\n{"d":', i + 1)) n++; return n }
const [home, id] = process.argv.slice(1)
await indexRows({ home, errors: [] }) // the segment index's rows: the bound's \`steady\`, not the session's spine
const before = liveHeap()
let doc
do doc = await runQuery('session', { id, limit: '60' }, { home, writer: true }); while (doc.pending)
const { truncated } = doc, total = doc.lanes.reduce((n, l) => n + l.count, 0)
doc = null
const kept = liveHeap() - before // the spine and the store's blocks, kept warm for the next look
const rows = sessionGroups(await indexRows({ home, errors: [] })).get(id), blocks = defs(fs.readFileSync(projectionFile(home, id)))
// the room: the budget less the work, the steady caches and the distinct blocks, at their bytes
const step = heapBudget() / 10
const room = heapBudget() - working(rows) - steadyBytes() - blocks * SPINE_PER_BLOCK - CACHES
console.log(JSON.stringify({ truncated, total, rows: rows.length, kept, room, step, blocks, SPINE_PER_ROW, SPINE_PER_BLOCK, CACHES }))`

const cut = (shape, heapMb) => {
  const home = path.join(tmpDir('trocar-cutfits-'), '.trocar'), id = pastRoom({ home, shape, heapMb })
  const out = JSON.parse(execFileSync(process.execPath, [...readerFlags(heapMb), '--input-type=module', '-e', READ, home, id], { encoding: 'utf8', maxBuffer: 1 << 20 }))
  fs.rmSync(path.dirname(home), { recursive: true, force: true }) // hundreds of MB on disk
  const t = out.truncated
  assert.ok(t && out.room > 0, `a session of ${out.rows} rows is past a room of ${mb(out.room)} MB (else this test proves nothing)`)
  assert.ok(t.shown < t.total && out.total === t.shown)
  return { ...out, shown: t.shown, total: t.total, perRow: out.kept / t.shown }
}
const mb = (n) => (n / 1048576).toFixed(1)

// Rows that cost about what the plan reckons: the plan's cut stands — the measured bound, there for rows dearer than the estimate,
// does not cut harder. A row that kept its request body alive (6a2e79a3: an object key that were a slice of it) made the measured
// bound cut this session, as it cut the user's to ~4 % of its calls.
test('3.5 §内存有界: a cut session whose rows cost what the plan reckons shows the calls that fit the room, less at most two steps and at least half', { timeout: 120_000 }, () => {
  // Claude Code on Message Threads, its tool definitions and cache markers riding every request (cc): a body has the long keys and
  // the resent items a real one has
  const c = cut({ growth: 150, subEvery: 4, subLanes: 3, subLen: 12, wire: 'threads', compactAt: 3_000, cc: 4 }, 160)
  // the calls shown and the store's blocks, beside the fixed caches (3.5 §内存有界 K): the store's, the reduction's lists and facts,
  // the fold log's lines
  const bound = c.shown * c.SPINE_PER_ROW + c.blocks * c.SPINE_PER_BLOCK + c.CACHES
  assert.ok(c.kept <= bound, `${mb(c.kept)} MB kept for ${c.shown} calls and ${c.blocks} blocks, past ${mb(bound)} MB`)
  assert.ok(c.shown * c.SPINE_PER_ROW >= Math.max(c.room - 2 * c.step, c.room / 2) - c.SPINE_PER_ROW,
    `${c.shown} / ${c.total} calls shown, ${mb(c.shown * c.SPINE_PER_ROW)} MB at ${c.SPINE_PER_ROW} B each, of a ${mb(c.room)} MB room: more than two ${mb(c.step)} MB steps or half of it short (${(c.perRow / 1024).toFixed(1)} KiB kept a call)`)
})

// Rows far dearer than the estimate (every call uses a tool no call before it did, its name thousands of characters: the fold's tool
// map keeps each distinct name, ~8 KB a call at 16,000): the estimate's cut reads more than the room holds at what they cost, the fold passes
// its reservation and stops, and the measured bound cuts again by the rows the fold got through, never fewer than half of those asked,
// the cost rounded up to a quarter power of two; the cut then shows at least half of what that fits — not a sliver of it.
// A 160 MB reader at 32,000 characters a name: growing the session past its room is most of this case's time. At 144 MB with
// 16,000 the measured bound never fires (2,928 calls shown against 1,934 asked): the dear rows fit in the W + K slack.
test('3.5 §内存有界: a cut session whose rows cost far more than the plan reckons is cut by the measured bound to at least half of what fits', { timeout: 180_000 }, () => {
  const c = cut({ growth: 150, subEvery: 4, subLanes: 3, subLen: 12, wire: 'threads', compactAt: 3_000, cc: 4, names: 32_000 }, 160)
  // the fewest calls the estimate's cut shows (the test above): the rows asked
  const asked = Math.max(c.room - 2 * c.step, c.room / 2) / c.SPINE_PER_ROW - 1
  assert.ok(c.shown < asked, `${c.shown} calls shown, not fewer than the ${Math.floor(asked)} the estimate asks for: the measured bound did not cut (else this test proves nothing)`)
  const fits = asked / 2 / 2 ** 0.25
  assert.ok(c.shown >= fits / 2, `${c.shown} / ${c.total} calls shown: fewer than half of the ${Math.floor(fits)} that fit at least (half of the ${Math.floor(asked)} asked, the cost rounded up)`)
})
