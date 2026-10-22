// test/query/worker-cold-heap.test.mjs — a session shaped like the user's live Claude Code one, read cold by the real worker under
// its real heap, answers with a whole document (RFC 3.5 §内存有界: 工作进程 MUST NOT 因为任何一个会话的大小而退出; D38; invariant 4).
//
// The shape is what made the worker die on a real machine: Message Threads, many sub-agent lanes side by side whose
// calls end late, and every request carrying Claude Code's tool definitions and cache markers (test/query/big-session.mjs `cc`) —
// so what a fold keeps per call can be far more than the plan reckons. The seam is crossed the way the board crosses it: the real
// board face, the real query service, the worker forked as the service forks it (test/helpers/worker-fork.mjs: WORKER_MEMORY_MB),
// a real socket. The answer is 200 and whole JSON; a cut session says so (`truncated`, counted against the listing); no worker dies.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { serveFace, request, withToken } from '../server/face.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { within } from '../helpers/bounded.mjs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { heapFlags } from '../../src/query/warm.mjs'
const rowsOf = (doc) => doc.lanes.reduce((n, l) => n + l.count, 0)

const CALLS = 1_500 // ~150 MB stored; the fold before the measured bound kept ~300 KB a call of this shape and died near 1 000

test('3.5 §内存有界: a cold read of a large real-shaped session answers 200 with a whole document, cut and said so if it must be', { timeout: 300_000 }, async () => {
  const home = path.join(tmpDir('trocar-coldheap-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const s = bigSession({ home, wire: 'threads', growth: 3_000, subEvery: 2, subLanes: 8, subLen: 60, late: 3, compactAt: 300_000, cc: 30 })
  s.append(CALLS)
  const failed = []
  const face = await serveFace({ home, failure: (where, e) => failed.push(`${e.code}: ${e.message}`) })
  try {
    const get = async (name, q) => {
      const r = await request(face.port, `/api/${name}?${new URLSearchParams(q)}`, { headers: withToken() })
      return { status: r.status, doc: JSON.parse(r.body) } // a cut body is not JSON: it throws here
    }
    const list = await get('sessions', {})
    assert.equal(list.status, 200)
    const listed = list.doc.sessions.find((x) => x.session_id === s.id)
    assert.ok(listed, 'the session is listed')
    // a session not yet extracted to its last member answers with `pending` (3.5 后台抽取): asked until it answers without
    await within((async () => { for (;;) { const a = await get('session', { id: s.id, limit: '60' }); assert.equal(a.status, 200); if (!a.doc.pending) return; await new Promise((d) => setTimeout(d, 50)) } })(), 240_000, 'the session answered without pending')
    const reads = []
    for (let i = 0; i < 2; i++) { // twice: the same answer
      const a = await get('session', { id: s.id, limit: '60' })
      assert.equal(a.status, 200, `read ${i + 1}: ${JSON.stringify(a.doc).slice(0, 600)}`)
      const t = a.doc.truncated
      if (t) {
        assert.ok(t.shown < t.total, 'a cut session shows fewer calls than it has')
        assert.equal(t.total, listed.calls, 'and counts them all')
        assert.equal(rowsOf(a.doc), t.shown, 'the lanes count the calls shown')
      } else assert.equal(rowsOf(a.doc), listed.calls)
      reads.push({ total: rowsOf(a.doc), truncated: t })
    }
    assert.deepEqual(reads[1], reads[0], 'a warm read answers what the cold one did')
    assert.deepEqual(failed, [], 'no query worker died')
  } finally { face.close() }
})

// A worker that went idle and exited opens a projected session again (3.5 后台抽取与归约; 3.5 设计界 ③): with no state of it, it
// answers from the session's fold log at the log's frontier, folding nothing — the bytes the warm worker answered, the session and the
// main lane's tail page both. What it keeps is the step-order columns, not a fold: what 4N keeps more than 2N is within SPINE_PER_ROW a
// call and SPINE_PER_BLOCK a distinct block (the projection's `d` lines). This bound cannot tell held fold state from columns (both fit
// SPINE_PER_ROW); the 0.3 s / 40 MB figure of ③ is measured on real and generated sessions. Each step in a
// child of its own at the worker's heap (single-threaded, as spine-heap reads): 'build' extracts and folds as the worker does
// (writer, asked until no `pending`) and answers warm; a fresh 'open' answers cold.
const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
const OPEN = `
const fs = await import('node:fs')
const { runQuery } = await import(${at('../../src/query/named/index.mjs')})
const { SPINE_PER_ROW, SPINE_PER_BLOCK } = await import(${at('../../src/query/named/session.mjs')})
const { projectionFile } = await import(${at('../../src/query/projection.mjs')})
const { indexRows } = await import(${at('../../src/query/rows.mjs')})
const { bigSession } = await import(${at('./big-session.mjs')})
const defs = (b) => { let n = 0; for (let i = b.indexOf('\\n{"d":'); i >= 0; i = b.indexOf('\\n{"d":', i + 1)) n++; return n }
const [home, mode, calls] = [process.argv[1], process.argv[2], Number(process.argv[3])]
const s = bigSession({ home, wire: 'threads', growth: 1_500, subEvery: 3, subLanes: 3, late: 2, compactAt: 60_000, cc: 4 })
if (mode === 'build') { s.append(calls); for (let i = 0; i < 2_000; i++) if (!(await runQuery('session', { id: s.id, limit: '60' }, { home, writer: true })).pending) break }
await indexRows({ home, errors: [] }) // the segment index's rows: the bound's steady caches, not the session's columns
global.gc(); global.gc()
const before = process.memoryUsage().heapUsed
// asked in a function of its own, its answers' bytes written out before the measure: the top-level frame's registers keep nothing
const ask = async () => {
  const doc = await runQuery('session', { id: s.id, limit: '60' }, { home, writer: true })
  const lane = await runQuery('lane', { id: s.id, lane: doc.lanes.find((l) => l.kind === 'main').lane }, { home, writer: true })
  fs.writeFileSync(home + '.' + mode + '.session', JSON.stringify(doc)); fs.writeFileSync(home + '.' + mode + '.lane', JSON.stringify(lane))
  return { pending: doc.pending ?? null, calls: doc.stats.calls }
}
const out = await ask()
global.gc(); global.gc()
const retained = process.memoryUsage().heapUsed - before
console.log(JSON.stringify({ ...out, retained, blocks: defs(fs.readFileSync(projectionFile(home, s.id))), SPINE_PER_ROW, SPINE_PER_BLOCK }))`
const child = (home, mode, calls) => ({ ...JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, '--expose-gc', '--single-threaded', ...heapFlags(), '--input-type=module', '-e', OPEN, home, mode, String(calls)],
  { encoding: 'utf8', maxBuffer: 1 << 20 })), session: fs.readFileSync(`${home}.${mode}.session`, 'utf8'), lane: fs.readFileSync(`${home}.${mode}.lane`, 'utf8') })

test('3.5 后台抽取与归约: a worker with no state answers a projected session from its fold log, the warm bytes, holding columns not a fold', { timeout: 300_000 }, () => {
  const N = 500, got = [] // 2N and 4N, as spine-heap: the fixed caches full at both sizes, so what grows is per call and per block
  for (const calls of [2 * N, 4 * N]) {
    const dir = tmpDir('trocar-coldopen-'), home = path.join(dir, '.trocar')
    try {
      const warm = child(home, 'build', calls), cold = child(home, 'open', calls)
      assert.equal(warm.pending, null, 'the builder folded every member')
      assert.equal(cold.session, warm.session, `${calls} calls: the cold session answer is the warm one`)
      assert.equal(cold.lane, warm.lane, `${calls} calls: the cold main-lane tail page is the warm one`)
      got.push(cold)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }
  const [two, four] = got, { SPINE_PER_ROW, SPINE_PER_BLOCK } = two
  assert.ok(four.calls > two.calls)
  const grew = four.retained - two.retained, bound = (four.calls - two.calls) * SPINE_PER_ROW + (four.blocks - two.blocks) * SPINE_PER_BLOCK
  assert.ok(grew <= bound, `kept ${grew} B more for ${four.calls - two.calls} more calls and ${four.blocks - two.blocks} more blocks: past ${bound} B`)
})
