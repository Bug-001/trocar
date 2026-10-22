// test/query/spine-heap.test.mjs — what a `session` query keeps in the heap grows with the session's calls by at most SPINE_PER_ROW
// each (≤ 1 KiB) and with its distinct blocks by at most SPINE_PER_BLOCK each, beside fixed caches (K: the store's, the reduction's,
// the fold log's), whatever the contexts' sizes and however many lanes run side by side (RFC 3.5 §内存有界; the bound `fitting()` and
// `working()` reserve with, src/query/named/session.mjs). Each read is one cold query in a process of its own, as the worker reads
// (it writes the projection and the fold log), in a heap of the worker's size, forced GC before and after: what it still holds once
// the document is let go.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import '../../src/query/named/index.mjs' // first: the named queries' registry imports session.mjs, not the other way round
import { SPINE_PER_ROW, SPINE_PER_BLOCK, extendSession } from '../../src/query/named/session.mjs'
import { STORE_HEAP } from '../../src/query/projection.mjs'
import { REDUCE_HEAP } from '../../src/view/reduce.mjs'
import { LOG_BYTES } from '../../src/query/fold-log.mjs'
import { heapFlags } from '../../src/query/warm.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession, live } from './big-session.mjs'
import { grower, readerFlags } from './past-room.mjs'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const QUERY = new URL('../../src/query/named/index.mjs', import.meta.url).href
const K = STORE_HEAP + REDUCE_HEAP + 2 * LOG_BYTES
// one cold read as the worker reads, until no member is above the extraction frontier → {calls, truncated, retained, blocks}
const READ = `
const fs = await import('node:fs')
const { runQuery } = await import(${JSON.stringify(QUERY)})
const { projectionFile } = await import(${JSON.stringify(new URL('../../src/query/projection.mjs', import.meta.url).href)})
// the projection's definition lines, counted over its bytes (a Buffer, outside the heap measured)
const defs = (b) => { let n = 0; for (let i = b.indexOf('\\n{"d":'); i >= 0; i = b.indexOf('\\n{"d":', i + 1)) n++; return n }
const { indexRows } = await import(${JSON.stringify(new URL('../../src/query/rows.mjs', import.meta.url).href)})
const [home, id] = process.argv.slice(1)
await indexRows({ home, errors: [] }) // the segment index's rows: the bound's \`steady\`, not the session's spine
global.gc(); global.gc()
const before = process.memoryUsage().heapUsed
let doc
do doc = await runQuery('session', { id, limit: '20' }, { home, writer: true }); while (doc.pending)
const calls = doc.lanes.reduce((n, l) => n + l.count, 0), truncated = doc.truncated
doc = null
global.gc(); global.gc()
const retained = process.memoryUsage().heapUsed - before
const blocks = defs(fs.readFileSync(projectionFile(home, id)))
console.log(JSON.stringify({ calls, truncated, retained, blocks }))`
// single-threaded: a concurrent compile job still in flight holds a closure and its context across the read's last GCs (+1.33 MB on
// one read in about two at live(0.12)), a V8 artefact that is not what the read keeps
const cold = (home, id) => JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, '--expose-gc', '--single-threaded', ...heapFlags(), '--input-type=module', '-e', READ, home, id],
  { encoding: 'utf8', maxBuffer: 1 << 20 }))
const read = (opts, calls) => {
  const home = path.join(tmpDir('trocar-spine-'), '.trocar'), s = bigSession({ home, ...opts })
  s.append(calls)
  const out = cold(home, s.id)
  fs.rmSync(path.dirname(home), { recursive: true, force: true }) // a live-shaped session is hundreds of MB on disk
  assert.ok(out.calls > 0.99 * calls, `${out.calls} of ${calls} calls read`)
  assert.equal(out.truncated, null)
  return out
}

// The call term: a session of the user's live session's shape (test/query/big-session.mjs live: a dozen subagent lanes side by side,
// late calls, paths in tool results, written files, long first prompts with reminders, shared system prompts, clusters of MB-sized
// records) read cold at 2N and at 4N calls: each read holds at most its calls × SPINE_PER_ROW and its blocks × SPINE_PER_BLOCK beside
// K, and what 4N holds more than 2N is at most 2N × SPINE_PER_ROW beside what its new blocks measure, BLOCK_COLUMNS each. The fixed
// caches are not full at N (from N to 2N the projection's shared-value cache grows ~1 MB and the reduction's list LRU ~0.5 MB, ~1 KB a
// call); by 2N the LRU is full and what the shared-value cache still fills up to 4N (~300 B a call) stays inside the slope, and 2N → 4N
// doubles every per-call and per-block table once, as a step of the session's growth does. The session is extracted between the reads
// as the worker extracts it in the background, so each read is the cold open of a projected session (a worker that went idle and was
// forked again).
// What a distinct block of this shape keeps in the heap measured (heapUsed: the store's bid index and block columns, not their typed
// arrays' backing stores), measured 2026-10-22 single-threaded at live(0.12) with 2 against 12 tools a call (15,003 → 29,993 blocks,
// one table doubling, the same calls).
const BLOCK_COLUMNS = 77
test('what a session read keeps grows by at most SPINE_PER_ROW a call', { timeout: 240_000 }, async () => {
  const { calls: N, ...opts } = live(0.12)
  const home = path.join(tmpDir('trocar-spine-'), '.trocar'), s = bigSession({ home, ...opts })
  const grow = async () => { s.append(N); while (await extendSession({ home, writer: true }, s.id, Infinity)); }
  const grown = async () => { await grow(); await grow(); return cold(home, s.id) }
  try {
    const two = await grown(), four = await grown()
    for (const [r, n] of [[two, 2 * N], [four, 4 * N]]) {
      assert.ok(r.calls > 0.99 * n && r.truncated === null, `${r.calls} of ${n} calls read, truncated ${JSON.stringify(r.truncated)}`)
      const bound = r.calls * SPINE_PER_ROW + r.blocks * SPINE_PER_BLOCK + K
      assert.ok(r.retained <= bound, `${r.retained} B retained for ${r.calls} calls and ${r.blocks} blocks, past ${bound} B`)
    }
    const per = (four.retained - two.retained - (four.blocks - two.blocks) * BLOCK_COLUMNS) / (four.calls - two.calls)
    assert.ok(SPINE_PER_ROW <= 1024, `SPINE_PER_ROW ${SPINE_PER_ROW} B: past 3.5's 1 KiB a call`)
    assert.ok(per <= SPINE_PER_ROW, `${Math.round(per)} B a call (${two.retained} → ${four.retained} B, ${two.blocks} → ${four.blocks} blocks, ${two.calls} → ${four.calls} calls), SPINE_PER_ROW ${SPINE_PER_ROW}`)
  } finally { fs.rmSync(path.dirname(home), { recursive: true, force: true }) } // a live-shaped session is hundreds of MB on disk
})

// Long contexts and lanes side by side: on two axes, the wire (a whole context per request, Message Threads, Codex over WebSocket,
// Chat Completions) and how many subagents run side by side, every call a subagent's with a context of hundreds of KB, so the lanes'
// last contexts together are far past calls × SPINE_PER_ROW: the read holds the spine and its fixed caches, never every lane's last context.
for (const wire of ['http', 'chat', 'threads', 'ws']) for (const subLanes of [1, 40]) {
  test(`a ${wire} session with ${subLanes} subagent lane(s) of long contexts keeps the spine beside fixed caches, not the lanes' contexts`, () => {
    // ~400 KB of fresh text a turn, a new subagent after two turns: ~120 lanes whose last contexts sum to ~60 MB
    const out = read({ wire, growth: 1_600_000, subEvery: 1, subLanes, subLen: 5 }, 240)
    const room = out.calls * SPINE_PER_ROW + out.blocks * SPINE_PER_BLOCK + K
    assert.ok(out.retained <= room, `${Math.round(out.retained / 1024)} KiB retained for ${out.calls} calls and ${out.blocks} blocks (≤ ${Math.round(room / 1024)} KiB)`)
  })
}

// The blocks axis (3.5 §内存有界, SPINE_PER_BLOCK): the same calls with fresh tool definitions on every call or none (unique texts
// either way): what the read still holds grows by at most SPINE_PER_BLOCK a distinct block (the projection's `d` lines).
test('what a session read keeps grows by at most SPINE_PER_BLOCK a distinct block', { timeout: 120_000 }, () => {
  const few = read({ tools: 0 }, 40), many = read({ tools: 1_500 }, 40)
  const per = (many.retained - few.retained) / (many.blocks - few.blocks)
  assert.ok(per <= SPINE_PER_BLOCK, `${Math.round(per)} B retained a distinct block (${few.blocks} → ${many.blocks} blocks, ${few.retained} → ${many.retained} B), SPINE_PER_BLOCK ${SPINE_PER_BLOCK}`)
})

// A session past the heap bound that goes on growing (a live one, followed): the cut moves in steps, not with every new row, so the
// spine is folded on with the new rows instead of from scratch on every poll (3.5 §内存有界). Twenty one-call growths in a worker-sized
// heap smaller than the session (a quarter more rows than its room for the spine holds at SPINE_PER_ROW, test/query/past-room.mjs):
// the shown calls grow with the session between steps, and the cut moves at most once.
// The session is grown and extracted in a process of its own (grower: growing it is not what is measured); the reader, one process
// with a small heap kept across the reads (readerFlags), reads it on each line it is sent and answers with what it showed.
const GROWING = `
const { runQuery } = await import(${JSON.stringify(QUERY)})
const [home, id] = process.argv.slice(1)
for await (const _ of (await import('node:readline')).createInterface({ input: process.stdin })) {
  // as the worker reads it (it writes the projection), until no member is above the extraction frontier
  let doc
  do doc = await runQuery('session', { id, limit: '20' }, { home, writer: true }); while (doc.pending)
  console.log(JSON.stringify(doc.truncated && doc.truncated.shown))
}`
test('a session past the heap bound that keeps growing keeps its cut between steps, so it is folded on, not from scratch', { timeout: 120_000 }, async () => {
  const home = path.join(tmpDir('trocar-spine-'), '.trocar')
  // Message Threads, subagents side by side
  const s = await grower({ home, heapMb: 128, shape: { wire: 'threads', growth: 150, compactAt: 3_000, subEvery: 4, subLanes: 3, subLen: 12 } })
  const reader = spawn(process.execPath, [...readerFlags(128), '--input-type=module', '-e', GROWING, home, s.id], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: reader.stdout })[Symbol.asyncIterator]()
  const answer = async () => { const { value, done } = await lines.next(); assert.ok(!done, 'the reader ended'); return JSON.parse(value) }
  try {
    const shown = []
    for (let i = 0; i < 20; i++) { reader.stdin.write('read\n'); shown.push(await answer()); await s.more() }
    assert.ok(shown.every((x) => x > 0), `cut every time: ${shown}`)
    const moves = shown.slice(1).filter((x, i) => x !== shown[i] + 1).length
    assert.ok(moves <= 1, `the cut moved ${moves} times in 20 one-call growths: ${shown}`)
  } finally { reader.stdin.end(); reader.kill(); s.stop(); fs.rmSync(path.dirname(home), { recursive: true, force: true }) }
})

// A reduction from scratch (subagents told apart by order alone, and a record that ends late among them: the session is reduced
// again, 3.5 §缓存按依赖失效) lets the state it replaces go first: sampled with a forced collection as it folds, the live heap
// never holds more than one state and the work (working()), never two states (paths in every tool result keep the state past the work).
const AGAIN = `
const fs = await import('node:fs')
const { runQuery } = await import(${JSON.stringify(QUERY)})
const { working } = await import(${JSON.stringify(new URL('../../src/query/named/session.mjs', import.meta.url).href)})
const { indexRows, sessionGroups } = await import(${JSON.stringify(new URL('../../src/query/rows.mjs', import.meta.url).href)})
const { bigSession } = await import(${JSON.stringify(new URL('./big-session.mjs', import.meta.url).href)})
const [home] = process.argv.slice(1)
const s = bigSession({ home, growth: 120, subEvery: 2, subLanes: 3, subLen: 6, late: 6, compactAt: 1_200, paths: 8 })
// subagents named by neither agent id nor thread (a legacy Claude Code): their lanes are told apart by order alone
const legacy = () => fs.writeFileSync(s.file, fs.readFileSync(s.file, 'utf8').trim().split('\\n').map((l) => {
  const r = JSON.parse(l), { 'x-claude-code-agent-id': agent, ...req_headers } = r.req_headers
  return agent ? JSON.stringify({ ...r, req_headers, req_body: JSON.stringify({ ...JSON.parse(r.req_body), system: [{ type: 'text', text: 'cc_is_subagent=true' }] }) }) : l
}).join('\\n') + '\\n')
// as many calls as keep the state past the work, then on until a subagent's call that ended late is still to be written: the next
// growth writes it among calls already folded
s.append(12_000); while (!s.held) s.append(1)
legacy()
const live = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed }
const before = live()
await runQuery('session', { id: s.id, limit: '20' }, { home })
const state = live() - before
s.append(7); legacy()
let peak = 0, folded = 0
await runQuery('session', { id: s.id, limit: '20' }, { home, progress: () => { if (++folded % 200 === 0) peak = Math.max(peak, live() - before) } })
const rows = sessionGroups(await indexRows({ home, errors: [] })).get(s.id)
console.log(JSON.stringify({ state, peak, folded, rows: rows.length, working: working(rows) }))`
test('a reduction from scratch never holds two states', { timeout: 300_000 }, () => {
  const home = path.join(tmpDir('trocar-spine-'), '.trocar')
  const out = JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, '--expose-gc', '--input-type=module', '-e', AGAIN, home],
    { encoding: 'utf8', maxBuffer: 1 << 20 }))
  assert.ok(out.state > out.working, `a state of ${out.state} B is past the work's ${out.working} B (else this test proves nothing)`)
  assert.ok(out.folded >= out.rows, 'the second read reduced the session from scratch')
  assert.ok(out.peak <= out.state + out.working, `peak ${out.peak} B: more than one state (${out.state} B) and the work (${out.working} B)`)
})
