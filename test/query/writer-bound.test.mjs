// test/query/writer-bound.test.mjs — after the fold, the answer-file writer (src/query/ctx-files.mjs writeFiles) adds at most
// memoBytes() + DEF_BYTES + its lane and written terms to the live heap the fold left, and that fits in half of the heap the read side's budget
// leaves a role that writes (RFC 3.5 §内存有界): the other half is the young generation's and the GC's.
// What it holds: the open span's memo (memoBytes()); one definitions cache (DEF_BYTES) its lane steppers share; per lane with a
// step in the span it renders, a stepper that keeps one step's list (`bids` and `toks`) past release — the lane term, here the
// largest over the spans of the sum over their lanes of `weigh` of the list each lane would keep (its longest in the span); and each
// tail's set of the blocks it has written, kept for the whole open span — the written term. The text goes into Buffers, outside the heap.
// Three shapes: past-room.mjs's session past a 112 MB reader, every call a new ~16 KB tool name (spine-heap.test.mjs PAST), so the
// fold stops at the heap line and the writer works on top of it; many lanes side by side sharing blocks (tool definitions every
// request carries, a reminder every lane's first prompt starts with); and that shape again after a worker that wrote its files stops,
// so the next one carries its tails on and appends a whole open span's calls to them (the restart-append path). The child folds with
// no file written, then writes the answer files a unit at a time (a deadline already passed), the live heap (a full collection) after
// each unit against the live heap the fold left. The used heap is printed beside it, not asserted. A state reopened from a checkpoint
// is never rebuilt in a worker's request (session.mjs grow: its background does, and that writes the files), so that shape folds on the
// local path, which rebuilds in the request; a fold that stops advancing fails here, it does not spin.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROLES } from '../../src/query/warm.mjs'
import { tailFile } from '../../src/query/ctx-files.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { TICK, once } from '../helpers/ticking.mjs'
import { bigSession } from './big-session.mjs'
import { pastRoom, readerFlags, readerBudget } from './past-room.mjs'

const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
const PAST = { heapMb: 112, shape: { wire: 'threads', growth: 150, compactAt: 3_000, subEvery: 4, subLanes: 3, subLen: 12, names: 16_000 } }
const TOOLS = Array.from({ length: 30 }, (_, k) => ({ name: `T${k}`, description: `tool ${k} `.repeat(40), input_schema: { type: 'object', properties: { a: { type: 'string' } } } }))
const LANES = { wire: 'threads', tools: TOOLS, subLanes: 32, subEvery: 2, subLen: 12, growth: 300, compactAt: 20_000, prompt: 400 }
const MAIN_MB = ROLES.main.capMb
// tens of MB of open span, so lines kept on the heap would show past what the bound's unfilled caches leave
const RESTART = { ...LANES, names: PAST.shape.names }

// A worker that writes its files to the end and saves its checkpoint (the tails it wrote), then stops.
const WORKER = `
await import(${at('../../src/query/named/index.mjs')})
const { extendSession, saveIndexes } = await import(${at('../../src/query/named/session.mjs')})
const { drain } = await import(${at('../helpers/bounded.mjs')})
const [home, id] = process.argv.slice(1)
await drain(() => extendSession({ home, writer: true }, id, 1e9))
saveIndexes()
console.log('{}')`

const WRITE = `${TICK}
await import(${at('../../src/query/named/index.mjs')}) // first: the registry imports session.mjs
const { gunzipSync } = await import('node:zlib')
const fs = (await import('node:fs')).default
const { sessionState } = await import(${at('../../src/query/named/session.mjs')})
const { writeFiles, memoBytes, packFile, tailFile, PACK_MEMBERS } = await import(${at('../../src/query/ctx-files.mjs')})
const { DEF_BYTES, laneStepper, weigh } = await import(${at('../../src/query/named/lane.mjs')})
const { placeIn } = await import(${at('../../src/query/session-doc.mjs')})
const { liveHeap, usedHeap } = await import(${at('../../src/query/warm.mjs')})
const [home, id, how] = process.argv.slice(1)
const state = () => sessionState({ home, ...(how === 'local' ? {} : { writer: true }), progress: tick }, id)
// no state held across a fold: one from scratch would sit beside it
for (let was = -1, same = 0, p; (p = (await state()).pending); tick()) {
  same = p.done === was ? same + 1 : 0
  was = p.done
  if (same >= 2_000) throw new Error('the fold stopped advancing at ' + p.done + ' of ' + p.total)
}
const s = await state()
const base = liveHeap()
let appends = 0
const counted = new Proxy(fs, { get: (t, k) => (k === 'appendFileSync' ? (...a) => { appends++; return t.appendFileSync(...a) } : t[k]) })
// what it holds: the live heap after each unit (its garbage is the young generation's and the GC's half); the used heap said beside it
let peak = base, used = base, f
while (!(f = writeFiles({ home, fs: counted }, s, 0))) { used = Math.max(used, usedHeap()); peak = Math.max(peak, liveHeap()); tick() }
// the largest span's rendered bytes, its two parts together (a diagnostic)
const size = (n) => ['main', 'rest'].reduce((a, p) => a + (n == null ? fs.statSync(tailFile(home, id, p)).size : gunzipSync(fs.readFileSync(packFile(home, id, n, p))).length), 0)
const span = Math.max(size(null), ...f.packs.map((p) => size(p.n)))
// the lane term: per span, per lane with a step in it, the list its stepper would keep (its longest in the span), weighed; the largest span's sum
const { cols, log } = s.V, upTo = s.mark == null ? 0 : s.pos(s.mark) + 1, kept = new Map(), steppers = new Map()
for (let q = 0; q < upTo; q++) {
  const r = s.plan.members[q], rid = String(r.id), k = cols.slotOf(rid)
  if (!s.cut(r) || k === undefined || cols.ts[k] === undefined) continue
  const key = log.read(...log.latest(rid)).r.lane, S = steppers.get(key) || steppers.set(key, laneStepper(s, key)).get(key), i = placeIn(cols, S.L, rid)
  const n = Math.floor(q / PACK_MEMBERS), lanes = kept.get(n) || kept.set(n, new Map()).get(n)
  lanes.set(key, Math.max(lanes.get(key) || 0, weigh(S.listAt(i))))
  S.release(-1)
  tick()
}
// the written term: the blocks each tail wrote, each a string in a Set
const written = ['main', 'rest'].reduce((a, p) => a + fs.readFileSync(tailFile(home, id, p), 'utf8').split('\\n').reduce((b, l) => (l.startsWith('{"d":') ? b + weigh(JSON.parse(l).d.bid) : b), 0), 0)
let lanes = 0, laneTerm = 0
for (const m of kept.values()) { const t = [...m.values()].reduce((a, w) => a + w, 0); if (t > laneTerm) { laneTerm = t; lanes = m.size } }
console.log(JSON.stringify({ base, peak, used, span, memo: memoBytes(), defs: DEF_BYTES, laneTerm, written, lanes, appends, packs: f.packs.length, truncated: s.truncated }))`

const tails = (home, id) => ['main', 'rest'].map((p) => fs.readFileSync(tailFile(home, id, p)))
const SHAPES = {
  'past the heap line': { heapMb: PAST.heapMb, make: (home) => pastRoom({ home, ...PAST }), check: (out) => assert.ok(out.truncated && out.packs > 0, `the fold stopped at the heap line and packs were written: ${JSON.stringify(out)}`) },
  'many lanes sharing blocks': { heapMb: MAIN_MB, make: (home) => { const s = bigSession({ home, ...LANES }); s.append(3_000); return s.id }, check: (out) => assert.ok(out.packs > 0 && out.lanes >= 32, `packs and many lanes in a span: ${JSON.stringify(out)}`) },
  'a worker that starts again appends a whole open span': {
    heapMb: MAIN_MB,
    how: 'local',
    make: async (home) => {
      const s = bigSession({ home, ...RESTART })
      s.append(560) // one sealed pack, an open span of a few calls
      await once([...readerFlags(MAIN_MB), '--input-type=module', '-e', WORKER, home, s.id], 'the first worker')
      const before = tails(home, s.id)
      s.append(440) // the open span's calls, all past the checkpoint: no seal between
      return { id: s.id, before }
    },
    check: (out, { home, id, before }) => {
      assert.ok(out.appends > 0, 'it appended, it did not write the tails afresh')
      tails(home, id).forEach((t, i) => assert.ok(t.length > before[i].length && t.subarray(0, before[i].length).equals(before[i]), `tail ${i}: carried on and appended to`))
      assert.ok(out.span > out.defs, 'the open span is larger than what the caches can hide')
    },
  },
}

for (const [name, shape] of Object.entries(SHAPES)) {
  test(`the answer-file writer adds at most memoBytes() + DEF_BYTES + its lane and written terms, in half of the heap the budget leaves a writing role: ${name}`, { timeout: 600_000 }, async (t) => {
    const dir = tmpDir('trocar-writer-'), home = path.join(dir, '.trocar')
    try {
      fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
      const made = await shape.make(home), id = typeof made === 'string' ? made : made.id
      const out = await once([...readerFlags(shape.heapMb), '--single-threaded', '--input-type=module', '-e', WRITE, home, id, shape.how || ''], 'the answer files written')
      shape.check(out, { home, id, ...made })
      const bound = out.memo + out.defs + out.laneTerm + out.written, added = out.peak - out.base
      t.diagnostic(JSON.stringify({ shape: name, ...out, added, bound }))
      assert.ok(added <= bound, `the writer added ${added} B to the ${out.base} B the fold left, past memoBytes() ${out.memo} B + DEF_BYTES ${out.defs} B + the lane term ${out.laneTerm} B (${out.lanes} lanes) + the written term ${out.written} B`)
      const writing = Object.entries(ROLES).filter(([, r]) => r.writes)
      assert.ok(writing.length > 0, 'a role writes answer files')
      for (const [role, { capMb }] of writing) {
        const half = (capMb * 2 ** 20 - readerBudget(capMb)) / 2 // the heap a writing role of `capMb` leaves past the read side's budget, halved
        assert.ok(bound <= half, `${role}: ${bound} B (memo ${out.memo} B + defs ${out.defs} B + lanes ${out.laneTerm} B + written ${out.written} B) past half of the ${capMb} MB heap's reserved part (${half} B)`)
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
}
