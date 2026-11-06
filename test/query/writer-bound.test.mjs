// test/query/writer-bound.test.mjs — after the fold, the answer-file writer (src/query/ctx-files.mjs writeFiles) holds at most the
// open span's memo (memoBytes()) and the one span it renders, and that fits in half of the heap the read side's budget leaves (RFC
// 3.5 §内存有界): the other half is the young generation's and the GC's.
// A span's text goes into Buffers line by line (outside the heap); what it holds in the heap is the definitions it reads, each block
// once a span, so the span's rendered bytes bound it, and a span is at most PACK_MEMBERS calls.
// The extreme shape: past-room.mjs's session past a 112 MB reader, every call a new ~16 KB tool name (spine-heap.test.mjs PAST), so the
// fold stops at the heap line and the writer works on top of it. The child folds it as requests do (no file written), then writes the
// answer files a unit at a time (a deadline already passed), the live heap (a full collection) after each unit against the live heap the fold left.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROLES } from '../../src/query/warm.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { TICK, once } from '../helpers/ticking.mjs'
import { pastRoom, readerFlags, readerBudget } from './past-room.mjs'

const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
const PAST = { heapMb: 112, shape: { wire: 'threads', growth: 150, compactAt: 3_000, subEvery: 4, subLanes: 3, subLen: 12, names: 16_000 } }
const WRITE = `${TICK}
await import(${at('../../src/query/named/index.mjs')}) // first: the registry imports session.mjs
const { gunzipSync } = await import('node:zlib')
const fs = (await import('node:fs')).default
const { sessionState } = await import(${at('../../src/query/named/session.mjs')})
const { writeFiles, memoBytes, packFile, tailFile } = await import(${at('../../src/query/ctx-files.mjs')})
const { liveHeap, usedHeap } = await import(${at('../../src/query/warm.mjs')})
const [home, id] = process.argv.slice(1)
const state = () => sessionState({ home, writer: true, progress: tick }, id)
while ((await state()).pending) tick() // no state held across a fold: one from scratch would sit beside it
const s = await state()
const base = liveHeap()
// what it holds: the live heap after each unit (its garbage is the young generation's and the GC's half); the used heap said beside it
let peak = base, used = base, f
while (!(f = writeFiles({ home, fs }, s, 0))) { used = Math.max(used, usedHeap()); peak = Math.max(peak, liveHeap()); tick() }
// the largest span's rendered bytes, its two parts together
const size = (n) => ['main', 'rest'].reduce((a, p) => a + (n == null ? fs.statSync(tailFile(home, id, p)).size : gunzipSync(fs.readFileSync(packFile(home, id, n, p))).length), 0)
const span = Math.max(size(null), ...f.packs.map((p) => size(p.n)))
console.log(JSON.stringify({ base, peak, used, span, memo: memoBytes(), packs: f.packs.length, truncated: s.truncated }))`

test('the answer-file writer holds at most memoBytes() and one span, in half of the heap the budget leaves', async (t) => {
  const dir = tmpDir('trocar-writer-'), home = path.join(dir, '.trocar')
  try {
    const id = pastRoom({ home, ...PAST })
    const out = await once([...readerFlags(PAST.heapMb), '--single-threaded', '--input-type=module', '-e', WRITE, home, id], 'the answer files written')
    assert.ok(out.truncated && out.packs > 0, `the fold stopped at the heap line and packs were written: ${JSON.stringify(out)}`)
    const bound = out.memo + out.span, added = out.peak - out.base
    t.diagnostic(JSON.stringify({ ...out, added, bound }))
    assert.ok(added <= bound, `the writer added ${added} B to the ${out.base} B the fold left, past memoBytes() ${out.memo} B + its largest span ${out.span} B`)
    for (const [role, { capMb }] of Object.entries(ROLES).filter(([, r]) => r.writes)) {
      const half = (capMb * 2 ** 20 - readerBudget(capMb)) / 2 // the heap a writing role of `capMb` leaves past the read side's budget, halved
      assert.ok(bound <= half, `${role}: ${bound} B (memo ${out.memo} B + span ${out.span} B) past half of the ${capMb} MB heap's reserved part (${half} B)`)
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
