// test/query/cut-fits.test.mjs — a session past the heap bound shows the newest calls that FIT, not a sliver of them (RFC 3.5
// §内存有界: 只读从尾部往前放得进的记录,至多少一步,截断点落在步格上).
//
// The room is the spine's share of the read side's budget: the budget less the working set of a fold (working()), the steady
// caches and the distinct blocks (SPINE_PER_BLOCK each) counted in whole steps (a step = a tenth of the budget). A cut session reads the newest rows that fit the room less at most
// one step, the cut on the step grid: its rows, each at what the plan reckons a row costs, fill the room less at most two steps. The
// plan reckons SPINE_PER_ROW until a fold measured more (the measured bound: a fold whose heap passes the whole reservation stops,
// and the plan reads as many rows as it got through, its cost rounded up to a quarter power of two), so rows that cost the estimate
// are cut by the estimate, and rows far dearer by what they cost — never harder (review 2026-10-21: dividing the heap's whole growth
// by the rows folded showed ~1 % of the user's session).
//
// One cold query in a process of its own with a small heap, so a session past its budget stays small; the session is grown from that
// process's own room.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
const CHILD = `
const { runQuery } = await import(${at('../../src/query/named/index.mjs')})
const fs = await import('node:fs')
const { SPINE_PER_ROW, SPINE_PER_BLOCK, working } = await import(${at('../../src/query/named/session.mjs')})
const { heapBudget, steadyBytes, liveHeap } = await import(${at('../../src/query/warm.mjs')})
const { STORE_HEAP, projectionFile } = await import(${at('../../src/query/projection.mjs')})
// the projection's definition lines, counted over its bytes (a Buffer, outside the heap measured)
const defs = (b) => { let n = 0; for (let i = b.indexOf('\\n{"d":'); i >= 0; i = b.indexOf('\\n{"d":', i + 1)) n++; return n }
const { indexRows, sessionGroups } = await import(${at('../../src/query/rows.mjs')})
const { bigSession } = await import(${at('./big-session.mjs')})
const [home, shape, dear] = [process.argv[1], JSON.parse(process.argv[2]), Number(process.argv[3])]
const step = heapBudget() / 10
// the distinct blocks (the projection's \`d\` lines) are reserved beside the steady caches, in whole steps too
const roomOf = (rows, blocks = 0) => heapBudget() - working(rows) - Math.ceil(steadyBytes() / step) * step - Math.ceil(blocks * SPINE_PER_BLOCK / step) * step
const rowsOf = async (id) => sessionGroups(await indexRows({ home, errors: [] })).get(id) || []
const s = bigSession({ home, growth: 150, subEvery: 4, subLanes: 3, subLen: 12, ...shape })
// half again as many rows as the room holds, each at the estimate (or at dear times it, for rows that cost that much more)
for (let rows = []; rows.length * SPINE_PER_ROW * dear <= 1.5 * roomOf(rows); rows = await rowsOf(s.id)) s.append(500)
const before = liveHeap()
// as the worker reads it (it writes the projection, 3.5 §后台抽取), until no member is above the extraction frontier
let doc
do doc = await runQuery('session', { id: s.id, limit: '60' }, { home, writer: true }); while (doc.pending)
const { truncated } = doc, total = doc.lanes.reduce((n, l) => n + l.count, 0)
doc = null
const kept = liveHeap() - before // the spine, kept warm for the next look
const rows = await rowsOf(s.id), blocks = defs(fs.readFileSync(projectionFile(home, s.id)))
console.log(JSON.stringify({ truncated, total, rows: rows.length, kept, room: roomOf(rows, blocks), step, SPINE_PER_ROW, STORE_HEAP }))`

const cut = (shape, { dear, heapMb }) => {
  const home = path.join(tmpDir('trocar-cutfits-'), '.trocar')
  const out = JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, '--expose-gc', `--max-old-space-size=${heapMb}`, '--input-type=module', '-e', CHILD, home, JSON.stringify(shape), String(dear)],
    { encoding: 'utf8', maxBuffer: 1 << 20 }))
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
  const c = cut({ wire: 'threads', compactAt: 3_000, cc: 4 }, { dear: 1, heapMb: 128 })
  assert.ok(c.kept <= c.shown * c.SPINE_PER_ROW + c.STORE_HEAP,
    `${mb(c.kept)} MB kept for ${c.shown} calls: ${(c.perRow / 1024).toFixed(0)} KiB a call, past ${c.SPINE_PER_ROW / 1024} KiB each beside the projection store's caches`)
  assert.ok(c.shown * c.SPINE_PER_ROW >= c.room - 2 * c.step,
    `${c.shown} / ${c.total} calls shown, ${mb(c.shown * c.SPINE_PER_ROW)} MB at ${c.SPINE_PER_ROW / 1024} KiB each, of a ${mb(c.room)} MB room: more than two ${mb(c.step)} MB steps short (${(c.perRow / 1024).toFixed(0)} KiB kept a call)`)
})

// Rows far dearer than the estimate (every call reads hundreds of files: as many resources in its lane's meta): the measured bound
// makes the cut, and the calls it shows, at what each costs, still fill the room — less the step left, the step of the grid and the
// rounding of the measured cost up to a quarter power of two — not a sliver of it.
test('3.5 §内存有界: a cut session whose rows cost far more than the plan reckons shows the calls that fit the room by their measured cost', { timeout: 300_000 }, () => {
  const c = cut({ wire: 'http', compactAt: 150, reads: 200, cc: 1 }, { dear: 2, heapMb: 192 }) // a short main context: a body stays small however many files it reads
  assert.ok(c.perRow > 2 * c.SPINE_PER_ROW, `${(c.perRow / 1024).toFixed(0)} KiB kept a call: not dearer than the estimate (else this test proves nothing)`)
  assert.ok(c.kept >= c.room / 2 ** 0.25 - 2 * c.step,
    `${c.shown} / ${c.total} calls shown keep ${mb(c.kept)} MB (${(c.perRow / 1024).toFixed(0)} KiB each) of a ${mb(c.room)} MB room: more than two ${mb(c.step)} MB steps and the cost's rounding short`)
})
