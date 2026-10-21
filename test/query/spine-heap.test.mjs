// test/query/spine-heap.test.mjs — what a `session` query keeps in the heap grows with the session's calls by at most SPINE_PER_ROW
// each, beside the open projection store's caches (STORE_HEAP), whatever the contexts' sizes and however many lanes run side by side
// (RFC 3.5 §内存有界; the bound `fitting()` and `working()` reserve with, src/query/named/session.mjs).
//
// Generated sessions (test/query/big-session.mjs) on two axes: the wire (a whole context per request, Message Threads, Codex over
// WebSocket, Chat Completions) and how many subagents run side by side, every call a subagent's with a context of hundreds of KB, so
// the lanes' last contexts together are far past calls × SPINE_PER_ROW. One cold query in a process of its own (forced GC before and after):
// what it still holds once the document is let go is the spine (and the caches it fills), never every lane's last context.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import '../../src/query/named/index.mjs' // first: the named queries' registry imports session.mjs, not the other way round
import { SPINE_PER_ROW, SPINE_PER_BLOCK } from '../../src/query/named/session.mjs'
import { STORE_HEAP } from '../../src/query/projection.mjs'
import { WORKER_MEMORY_MB } from '../../src/query/warm.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const QUERY = new URL('../../src/query/named/index.mjs', import.meta.url).href
const CHILD = `
const { runQuery } = await import(${JSON.stringify(QUERY)})
const [home, id] = process.argv.slice(1)
global.gc(); global.gc()
const before = process.memoryUsage().heapUsed
let doc = await runQuery('session', { id, limit: '60' }, { home })
const calls = doc.lanes.reduce((n, l) => n + l.count, 0), truncated = doc.truncated
doc = null
global.gc(); global.gc()
console.log(JSON.stringify({ calls, truncated, retained: process.memoryUsage().heapUsed - before }))`

for (const wire of ['http', 'chat', 'threads', 'ws']) for (const subLanes of [1, 40]) {
  test(`a ${wire} session with ${subLanes} subagent lane(s) of long contexts keeps at most SPINE_PER_ROW a call beside its projection store's caches`, () => {
    const home = path.join(tmpDir('trocar-spine-'), '.trocar')
    // every call a subagent's (subEvery 1) with ~400 KB of fresh text a turn, a new subagent after two turns: ~120 lanes whose last
    // contexts sum to ~60 MB, past calls × SPINE_PER_ROW
    const s = bigSession({ home, wire, growth: 1_600_000, subEvery: 1, subLanes, subLen: 5 })
    s.append(240)
    const out = JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, '--expose-gc', '--input-type=module', '-e', CHILD, home, s.id],
      { encoding: 'utf8', maxBuffer: 1 << 20 }))
    assert.equal(out.calls, 240)
    assert.equal(out.truncated, null)
    assert.ok(out.retained <= out.calls * SPINE_PER_ROW + STORE_HEAP,
      `${Math.round(out.retained / 1024)} KiB retained for ${out.calls} calls (≤ ${SPINE_PER_ROW / 1024} KiB each + the store's ${STORE_HEAP / 1048576} MiB)`)
  })
}

// The blocks axis (3.5 §内存有界, SPINE_PER_BLOCK): the same calls with fresh tool definitions on every call or none (unique texts
// either way), read as the worker reads them (it writes the projection) in a heap of the worker's size: what the read still holds
// once the document is let go grows by at most SPINE_PER_BLOCK a distinct block (the projection's `d` lines).
const BLOCKS = `
const fs = await import('node:fs')
const { runQuery } = await import(${JSON.stringify(QUERY)})
const { projectionFile } = await import(${JSON.stringify(new URL('../../src/query/projection.mjs', import.meta.url).href)})
// the projection's definition lines, counted over its bytes (a Buffer, outside the heap measured)
const defs = (b) => { let n = 0; for (let i = b.indexOf('\\n{"d":'); i >= 0; i = b.indexOf('\\n{"d":', i + 1)) n++; return n }
const [home, id] = process.argv.slice(1)
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
test('what a session read keeps grows by at most SPINE_PER_BLOCK a distinct block', { timeout: 120_000 }, () => {
  const read = (tools) => {
    const home = path.join(tmpDir('trocar-spine-'), '.trocar'), s = bigSession({ home, tools })
    s.append(40)
    const out = JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, '--expose-gc', `--max-old-space-size=${WORKER_MEMORY_MB}`, '--input-type=module', '-e', BLOCKS, home, s.id],
      { encoding: 'utf8', maxBuffer: 1 << 20 }))
    assert.equal(out.calls, 40)
    assert.equal(out.truncated, null)
    return out
  }
  const few = read(0), many = read(1_500)
  const per = (many.retained - few.retained) / (many.blocks - few.blocks)
  assert.ok(per <= SPINE_PER_BLOCK, `${Math.round(per)} B retained a distinct block (${few.blocks} → ${many.blocks} blocks, ${few.retained} → ${many.retained} B), SPINE_PER_BLOCK ${SPINE_PER_BLOCK}`)
})

// A session past the heap bound that goes on growing (a live one, followed): the cut moves in steps, not with every new row, so the
// spine is folded on with the new rows instead of from scratch on every poll (3.5 §内存有界). Twenty one-call growths in a worker-sized
// heap far smaller than the session (as many rows as the whole budget holds at SPINE_PER_ROW, more than its room for the spine):
// the shown calls grow with the session between steps, and the cut moves at most once.
const GROWING = `
const { runQuery } = await import(${JSON.stringify(QUERY)})
const { SPINE_PER_ROW } = await import(${JSON.stringify(new URL('../../src/query/named/session.mjs', import.meta.url).href)})
const { heapBudget } = await import(${JSON.stringify(new URL('../../src/query/warm.mjs', import.meta.url).href)})
const { bigSession } = await import(${JSON.stringify(new URL('./big-session.mjs', import.meta.url).href)})
const [home] = process.argv.slice(1)
const s = bigSession({ home, growth: 300, compactAt: 6_000, subEvery: 4, subLanes: 3, subLen: 4 })
s.append(Math.ceil(heapBudget() / SPINE_PER_ROW))
const shown = []
for (let i = 0; i < 20; i++) {
  // as the worker reads it (it writes the projection), until no member is above the extraction frontier
  let doc
  do doc = await runQuery('session', { id: s.id, limit: '20' }, { home, writer: true }); while (doc.pending)
  shown.push(doc.truncated && doc.truncated.shown)
  s.append(1)
}
console.log(JSON.stringify(shown))`
test('a session past the heap bound that keeps growing keeps its cut between steps, so it is folded on, not from scratch', () => {
  const home = path.join(tmpDir('trocar-spine-'), '.trocar')
  const shown = JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, '--max-old-space-size=128', '--input-type=module', '-e', GROWING, home],
    { encoding: 'utf8', maxBuffer: 1 << 20 }))
  assert.ok(shown.every((x) => x > 0), `cut every time: ${shown}`)
  const moves = shown.slice(1).filter((x, i) => x !== shown[i] + 1).length
  assert.ok(moves <= 1, `the cut moved ${moves} times in 20 one-call growths: ${shown}`)
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
s.append(5_000); legacy()
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
