// test/query/read-beside-fold.test.mjs — 3.5 #62「一场正被读的会话不被后台折叠挤出」: two sessions that do not fit the budget together, one read
// by requests, the other folded in background slices between them, as the worker's scheduler does, in a process of its own with a small heap
// (test/query/cut-fits.test.mjs). The reader's fold log is opened again only if its state went. The folded one has grown since its checkpoint,
// so its first slice thaws it beside the reader's state: that thaw once took the process to V8's limit (SIGABRT, 2026-11-05).
//   The axis: which session was folded last, and so which state is warm when the reading starts; and how the reading ends. The reader leaves,
// and at idle the heap counts as having room, however large the state it left, so the other folds to its end; or the other is opened while
// the first is still read: it is the reader then and answers, and the first gives way by the ledger.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { child, TICK } from '../helpers/ticking.mjs'
import { grower, pastRoom, readerFlags } from './past-room.mjs'

const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
const HEAP_MB = 192, SHARE = 0.275 // each a fold of more than half the budget (growPast grows to twice its share)
const SHAPE = { wire: 'threads', growth: 150, compactAt: 3_000, subEvery: 4, subLanes: 3, subLen: 12, names: 16_000 }
const READ = `${TICK}
const { runQuery } = await import(${at('../../src/query/named/index.mjs')}) // first: the registry imports session.mjs
const { READING_MS, extendSession, heapHasRoom, saveIndexes, sealParts } = await import(${at('../../src/query/named/session.mjs')})
const { sessionDir } = await import(${at('../../src/query/projection.mjs')})
const { readHead } = await import(${at('../../src/query/ctx-files.mjs')})
const { drain } = await import(${at('../helpers/bounded.mjs')})
const nodeFs = (await import('node:fs')).default, path = (await import('node:path')).default
const [home, read, folded, last, then] = process.argv.slice(1)
const log = path.join(sessionDir(home, read), 'fold.idx')
let opens = 0
const ctx = { home, writer: true, persist: () => {}, progress: tick, fs: Object.assign(Object.create(nodeFs), { openSync: (f, ...a) => { if (f === log) opens++; return nodeFs.openSync(f, ...a) } }) }
for (const id of last === read ? [folded, read] : [read, folded]) await drain(() => { tick(); return extendSession(ctx, id, 50) }, id)
saveIndexes(performance.now() + 50) // sealed in slices, as the worker's idle save: whole, it is seconds with no tick
await drain(() => { tick(); return sealParts(performance.now() + 50) }, 'the seal')
console.log('{}')
for await (const _ of (await import('node:readline')).createInterface({ input: process.stdin })) {
  const page = async () => { const d = await runQuery('session', { id: read }, ctx); tick(); return d }
  await page(); await page() // a cold state opens here: the count starts once it is warm
  opens = 0
  let stopped = null, errors = []
  await drain(async () => {
    errors.push(...(await page()).errors.filter((e) => !e.level))
    try { return await extendSession(ctx, folded, 50) } catch (e) { stopped = e.code; return false }
  }, 'beside the reader')
  const reopens = opens
  let room = null
  if (then === 'left') {
    await new Promise((r) => setTimeout(r, READING_MS + 50))
    room = heapHasRoom()
    await drain(() => { tick(); return extendSession(ctx, folded, 50) }, 'the reader gone')
  } else {
    await drain(async () => { const d = await runQuery('session', { id: folded }, ctx); tick(); errors.push(...d.errors.filter((e) => !e.level)); return d.pending }, 'the other opened')
    errors.push(...(await page()).errors.filter((e) => !e.level))
  }
  const h = readHead(home, folded)
  console.log(JSON.stringify({ reopens, errors, stopped, room, tier: h.tier, pending: h.pending ?? null, truncated: h.truncated ?? null }))
  break
}`

for (const [last, then] of [['read', 'left'], ['folded', 'opened']]) {
  test(`3.5 #62: a session being read keeps its state beside a background fold, ${last === 'read' ? 'itself' : 'the other'} folded last, and then the other is ${then === 'left' ? 'folded when the reader leaves' : 'opened'}`, { timeout: 600_000 }, async () => {
    const home = path.join(tmpDir('trocar-beside-'), '.trocar'), o = { home, heapMb: HEAP_MB, share: SHARE }
    const read = pastRoom({ ...o, shape: { ...SHAPE, id: 'aaa00000-4a1b-9c2d-000000000001', segment: '20261020T164737Z' } })
    const g = await grower({ ...o, shape: { ...SHAPE, seed: 11, id: 'bbb00000-4a1b-9c2d-000000000002', segment: '20261020T164738Z' } })
    const r = child([...readerFlags(HEAP_MB), '--input-type=module', '-e', READ, home, read, g.id, last === 'read' ? read : g.id, then], 'the reader')
    try {
      await r.next()
      await g.more() // past its checkpoint: its next slice thaws it
      r.send('')
      const end = await r.next()
      assert.equal(end.reopens, 0, 'the read session kept its state')
      assert.deepEqual(end.errors, [], 'every page answered whole')
      assert.ok(end.stopped === null || end.stopped === 'heap-no-room', `the fold gave way, if at all, for lack of room: ${end.stopped}`)
      if (then === 'left') assert.equal(end.room, true, 'at idle what the reader left is no lack of room')
      assert.deepEqual([end.tier, end.pending, end.truncated], [1, null, null], 'the fold ends whole')
    } finally {
      await r.stop(); await g.stop()
      fs.rmSync(path.dirname(home), { recursive: true, force: true }) // hundreds of MB on disk
    }
  })
}
