// test/query/state-gone.test.mjs — 3.5 §内存有界「账本让出一场会话的状态时,状态真的放掉」: a state the ledger let go is read-only to whoever
// still holds it, its fold log's descriptor goes with it, the session comes back whole from its checkpoint, and the slice whose write
// job went with a state does something all the same (#39).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import v8 from 'node:v8'
import { tmpDir } from '../helpers/tmp.mjs'
import { drain } from '../helpers/bounded.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs' // first: the named queries' registry imports session.mjs
import { extendSession, files, sessionState } from '../../src/query/named/session.mjs'
import { readHead, writeInFlight } from '../../src/query/ctx-files.mjs'
import { sessionDir } from '../../src/query/projection.mjs'
import { titlesFile } from '../../src/query/titles.mjs'
import { heapBudget, hold, liveHeap, yieldCaches } from '../../src/query/warm.mjs'

const SHAPE = { growth: 120, compactAt: 6_000, subEvery: 3, subLanes: 2, late: 3 }
const SPENT = 1e-6 // a budget spent before any unit of work ends
const SEGMENT = '20261020T164731Z'
let ids = 0
const nextId = () => `gone${String(++ids).padStart(4, '0')}-4a1b-9c2d-000000000001`
function homeWith(calls, id = nextId()) {
  const home = path.join(tmpDir('trocar-gone-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const a = bigSession({ home, id, segment: SEGMENT, ...SHAPE })
  a.append(calls)
  return { home, id, a, failures: [], ctx: { home, fs: { ...fs }, writer: true } }
}
const whole = (s) => drain(() => extendSession(s.ctx, s.id, Infinity), 'the whole session', 50)
// the bytes of a session's files whose names match, by name
function bytesOf({ home, id }, names) {
  const d = sessionDir(home, id), o = {}
  for (const n of fs.readdirSync(d)) if (names.test(n)) o[n] = createHash('sha256').update(fs.readFileSync(path.join(d, n))).digest('hex')
  return o
}
const ANSWERS = /^(head|p\d|open\.)/, WRITTEN = /^(fold\.|head|p\d|open\.)/
// a write of many units under way, with members landed that wait for it → the log it is on
async function inWrite(s) {
  await whole(s)
  s.a.append(600) // a pack to seal
  const log = (await sessionState(s.ctx, s.id)).V.log
  await drain(async () => { await extendSession(s.ctx, s.id, SPENT); return !writeInFlight(log) }, 'until a write is in flight', 50_000)
  s.a.append(3)
  return log
}

test('a state let go folds and writes no more: its holder goes on through files() and the disk is the new state\'s', async () => {
  const s = homeWith(30)
  await whole(s)
  s.a.append(10)
  let held
  await drain(async () => { held = await sessionState(s.ctx, s.id); return held.pending }, 'a request', 50)
  const frontier = held.V.log.frontier
  yieldCaches()
  s.a.append(10)
  await whole(s)
  const left = bytesOf(s, WRITTEN)
  files(s.ctx, held)
  assert.deepEqual(bytesOf(s, WRITTEN), left)
  assert.equal(held.V.log.frontier, frontier, 'its log never moved: only a state out of the cache is grown')
})

for (const [name, params] of [['session --head', { head: true }], ['lane --tail', { tail: 'main' }], ['lane --pack', { pack: '0.main' }]]) {
  test(`${name}, let go half way through its answer, writes nothing and fails nothing`, async () => {
    const s = homeWith(520), failures = [], query = name.split(' ')[0]
    await whole(s)
    const was = bytesOf(s, ANSWERS)
    s.a.append(5)
    // the answer's title is looked at between the fold and the files: the state is back in the cache by then
    s.ctx.fs.statSync = (f, ...r) => { if (f === titlesFile(s.home)) yieldCaches(); return fs.statSync(f, ...r) }
    const got = await runQuery(query, { id: s.id, ...params }, { ...s.ctx, persist: (r) => failures.push(r) })
    assert.deepEqual(bytesOf(s, ANSWERS), was)
    assert.deepEqual(failures, [])
    if (params.head) {
      assert.deepEqual(got, readHead(s.home, s.id))
    } else assert.ok(got.$text.length > 0)
  })
}

for (const [name, letGo] of [['the ledger making room', () => hold(heapBudget())()], ['yieldCaches', yieldCaches]]) {
  test(`a write in flight let go by ${name}: the files end as those of a home never let go`, async () => {
    const id = nextId(), cut = homeWith(300, id), kept = homeWith(903, id)
    const log = await inWrite(cut)
    assert.equal(writeInFlight(log), true)
    letGo()
    await whole(cut)
    assert.deepEqual([readHead(cut.home, id).tier, readHead(cut.home, id).pending], [1, null])
    await whole(kept)
    assert.deepEqual(bytesOf(cut, ANSWERS), bytesOf(kept, ANSWERS))
  })
}

test('the descriptors do not grow with the times a state is let go', { skip: process.platform === 'win32' }, async () => {
  const s = homeWith(30), open = () => fs.readdirSync('/dev/fd').length
  const round = async () => { s.a.append(1); await whole(s); yieldCaches() }
  await round()
  await round() // a log's read descriptor opens at its first read past the open
  const first = open()
  for (let i = 0; i < 6; i++) await round()
  // the registry's callback comes some time after the collection that finds the log gone: a descriptor kept is one no collection frees
  await drain(async () => { liveHeap(); await new Promise(setImmediate); return open() > first }, 'the descriptors of the states let go', 50)
})

test('a state let go while its head waits in lagging leaves the heap', async () => {
  const s = homeWith(30)
  await whole(s)
  s.a.append(1)
  await whole(s) // the head is not due: this state waits for the next write of it
  const ref = new WeakRef((await sessionState(s.ctx, s.id)).st)
  await whole(s) // sessionState let go of the wait: this puts it back
  yieldCaches()
  let rounds = 0 // no deref in here: it would keep the state to the end of the job
  await drain(async () => { liveHeap(); await new Promise(setImmediate); return ++rounds < 4 }, 'the collections after the state is let go', 10)
  assert.equal(ref.deref(), undefined)
})

// what a slice leaves on disk: the bytes of the projection and the fold log, and every pack and tail as it is
function disk({ home, id }) {
  const d = sessionDir(home, id), o = { extract: 0, fold: 0 }
  for (const n of fs.readdirSync(d)) if (/^(extract|fold)\.(\d+\.ndjson$|.*\.br$)/.test(n)) o[n.split('.')[0]] += fs.statSync(path.join(d, n)).size
  return { ...o, files: bytesOf({ home, id }, /^(p\d|open\.)/) }
}
// the next slice is said more, and has grown the projection or the fold log or moved a pack or a tail
async function slice(s) {
  const was = disk(s), more = await extendSession(s.ctx, s.id, SPENT), now = disk(s)
  assert.equal(more, true)
  assert.ok(now.extract > was.extract || now.fold > was.fold || JSON.stringify(now.files) !== JSON.stringify(was.files), 'a slice that says more has done something')
}
// the live heap past the ceiling for advance()'s one look (usedHeap, heapCeiling, liveHeap, heapCeiling) of the end of grow()
function past(f) {
  const real = v8.getHeapStatistics
  let over = 4
  v8.getHeapStatistics = () => { const h = real(); return over-- > 0 ? { ...h, used_heap_size: h.heap_size_limit } : h }
  return Promise.resolve().then(f).finally(() => { v8.getHeapStatistics = real })
}

test('#39: the slice whose write went with the state in the heap retry does something', async () => {
  const s = homeWith(300)
  await inWrite(s)
  await past(() => slice(s))
})

test('#39: the slice whose write went with the state when the cut moved does something', async () => {
  const s = homeWith(300)
  await whole(s)
  s.a.append(600)
  await past(() => extendSession(s.ctx, s.id, Infinity))
  await whole(s)
  s.a.append(600)
  const log = (await sessionState(s.ctx, s.id)).V.log
  await drain(async () => { await extendSession(s.ctx, s.id, SPENT); return !writeInFlight(log) }, 'until a write is in flight', 50_000)
  s.a.append(150) // past the next step of the grid
  await slice(s)
})
