// test/query/spine-heap.test.mjs — what a `session` query keeps in the heap grows with the session's calls by at most SPINE_PER_ROW
// each, beside the lanes' baselines (BASELINE_HEAP), whatever the contexts' sizes and however many lanes run side by side
// (RFC 3.5 §内存有界; the bound `fitting()` and `working()` reserve with, src/query/named/session.mjs).
//
// Generated sessions (test/query/big-session.mjs) on two axes: the wire (a whole context per request, Message Threads, Codex over
// WebSocket, Chat Completions) and how many subagents run side by side, every call a subagent's with a context of hundreds of KB, so
// the lanes' last contexts together are far past BASELINE_HEAP. One cold query in a process of its own (forced GC before and after):
// what it still holds once the document is let go is the spine (and the caches it fills), never every lane's last context.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import '../../src/query/named/index.mjs' // first: the named queries' registry imports session.mjs, not the other way round
import { SPINE_PER_ROW, BASELINE_HEAP } from '../../src/query/named/session.mjs'
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
const calls = doc.page.total, truncated = doc.truncated
doc = null
global.gc(); global.gc()
console.log(JSON.stringify({ calls, truncated, retained: process.memoryUsage().heapUsed - before }))`

for (const wire of ['http', 'chat', 'threads', 'ws']) for (const subLanes of [1, 40]) {
  test(`a ${wire} session with ${subLanes} subagent lane(s) of long contexts keeps at most SPINE_PER_ROW a call beside its baselines`, () => {
    const home = path.join(tmpDir('trocar-spine-'), '.trocar')
    // every call a subagent's (subEvery 1) with ~400 KB of fresh text a turn, a new subagent after two turns: ~120 lanes whose last
    // contexts sum to ~60 MB, past calls × SPINE_PER_ROW + BASELINE_HEAP
    const s = bigSession({ home, wire, growth: 1_600_000, subEvery: 1, subLanes, subLen: 5 })
    s.append(240)
    const out = JSON.parse(execFileSync(process.execPath, ['--require', NO_REAL_OS, '--expose-gc', '--input-type=module', '-e', CHILD, home, s.id],
      { encoding: 'utf8', maxBuffer: 1 << 20 }))
    assert.equal(out.calls, 240)
    assert.equal(out.truncated, null)
    assert.ok(out.retained <= out.calls * SPINE_PER_ROW + BASELINE_HEAP,
      `${Math.round(out.retained / 1024)} KiB retained for ${out.calls} calls (≤ ${SPINE_PER_ROW / 1024} KiB each + ${BASELINE_HEAP / 1048576} MiB)`)
  })
}

// A session past the heap bound that goes on growing (a live one, followed): the cut moves in steps, not with every new row, so the
// spine is folded on with the new rows instead of from scratch on every poll (3.5 §内存有界). Twenty one-call growths in a worker-sized
// heap far smaller than the session: the shown calls grow with the session between steps, and the cut moves at most once.
const GROWING = `
const { runQuery } = await import(${JSON.stringify(QUERY)})
const { bigSession } = await import(${JSON.stringify(new URL('./big-session.mjs', import.meta.url).href)})
const [home] = process.argv.slice(1)
const s = bigSession({ home, growth: 300, compactAt: 6_000, subEvery: 4, subLanes: 3, subLen: 4 })
s.append(2_000)
const shown = []
for (let i = 0; i < 20; i++) {
  const doc = await runQuery('session', { id: s.id, limit: '20' }, { home })
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
