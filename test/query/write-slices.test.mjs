// test/query/write-slices.test.mjs — no long slice at the end of a re-read or at a checkpoint (3.5 后台抽取与归约, §谁执行它「答案文件」,
// D78): the scan for what changed gives way like the rest of the write and loses no rid, whatever happens while it is cut; the
// step-order columns come to the frontier a background slice at a time and read back whole from any checkpoint.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import '../../src/query/named/index.mjs' // first: the cycle through session.mjs is entered here
import { extendSession, saveIndexes, sessionState } from '../../src/query/named/session.mjs'
import { writeFiles } from '../../src/query/ctx-files.mjs'
import { openProjection, sessionDir } from '../../src/query/projection.mjs'
import { openFoldLog } from '../../src/query/fold-log.mjs'
import { columns, dumpColumns, loadColumns, sync } from '../../src/query/session-doc.mjs'

const SHAPE = { growth: 120, compactAt: 6_000, subEvery: 3, subLanes: 2, late: 3 }
const homeOf = () => { const home = path.join(tmpDir('trocar-slices-'), '.trocar'); fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 }); return home }
// The worker keeps what it last wrote of a head by session id alone, so two homes compared in this process have ids of their own.
let ids = 0
const nextId = () => `big-0000-4a1b-9c2d-${String(++ids).padStart(12, '0')}`
// A home with session `id` and a small session `other` beside it; two homes of one `shape` hold the same bytes but for the ids.
function homeWith(calls, shape = SHAPE, id = nextId()) {
  const home = homeOf(), other = nextId(), a = bigSession({ home, id, segment: '20261020T164731Z', ...shape }), b = bigSession({ home, id: other, segment: '20261020T164732Z', growth: 120 })
  a.append(calls); b.append(20)
  return { home, id, other, a, ctx: { home, fs, writer: true } }
}
const toTheEnd = async (ctx, id) => { while (await extendSession(ctx, id, Infinity)); }
// the state folded to the end by requests, which write no answer file; a state answering from its log folds in a background slice first
async function folded(ctx, id) {
  for (;;) {
    const s = await sessionState(ctx, id)
    if (!s.pending) return s
    if (s.st.target != null) await extendSession(ctx, id, 1)
  }
}
// the deadline already passed at every call: a unit of the write a call, `units` of them at most
const cut = (ctx, s, units = Infinity) => { for (let i = 0; i < units; i++) if (writeFiles(ctx, s, 0)) return }
// the session's files written a unit at a time from the state as it is now, the head after them
const cutToTheEnd = async (ctx, id) => { cut(ctx, await folded(ctx, id)); await toTheEnd(ctx, id) }

const answerNames = (home, id) => fs.readdirSync(sessionDir(home, id)).filter((n) => /^(p\d+\.\w+\.ndjson\.gz|open\.\w+\.ndjson|head(\.pending)?\.json\.gz)$/.test(n)).sort()
// the text of each answer file, its session's id taken out, and with it the head's pack tags (hashes of packs compared as they are)
const textsOf = ({ home, id }, keep = () => true) => Object.fromEntries(answerNames(home, id).filter(keep).map((n) => {
  const b = fs.readFileSync(path.join(sessionDir(home, id), n))
  return [n, (n.endsWith('.gz') ? gunzipSync(b) : b).toString('utf8').replaceAll(id, 'S').replace(/"tag":"\w+"/g, '"tag":""')]
}))
// What a tail says once read (3.5 `--tail`): appends and a fresh render differ in how they say it (a step's parent, a row said twice),
// not in what it comes to: the doc head, the latest row and lane header of each, the step of each rid, the members, the failures.
function tailSays(text) {
  const [doc, ...lines] = text.trimEnd().split('\n').map((l) => JSON.parse(l))
  const rows = new Map(), heads = new Map(), steps = new Set(), records = new Set(), fails = new Set()
  for (const o of lines) {
    if (o.c) rows.set(o.c.id ?? o.c.rid, o.c)
    else if (o.l) heads.set(o.l.lane, o.l)
    else if (o.s) steps.add(o.s.rid)
    else if (o.r) records.add(o.r.id)
    else if (o.x) fails.add(o.x.where)
    else if (o.g) { rows.delete(o.g); steps.delete(o.g) }
  }
  const sorted = (x) => [...x].sort((p, q) => String(p[0] ?? p).localeCompare(String(q[0] ?? q)))
  return { doc, rows: sorted(rows), heads: sorted(heads), steps: sorted(steps), records: sorted(records), fails: sorted(fails) }
}
// two homes' files come to the same: every pack and the head (`keep`) byte for byte, what each tail says
function sameFiles(sliced, whole, what, keep = () => true) {
  const open = (n) => n.startsWith('open.'), a = textsOf(sliced, keep), b = textsOf(whole, keep)
  assert.deepEqual(Object.keys(a), Object.keys(b), `${what}: the same files`)
  for (const n of Object.keys(b)) assert.deepEqual(open(n) ? tailSays(a[n]) : a[n], open(n) ? tailSays(b[n]) : b[n], `${what}: ${n}`)
}

test('a write cut at every unit ends with the bytes of one write with no deadline, in every pack, tail and head', async () => {
  const whole = homeWith(1100), sliced = homeWith(1100)
  await toTheEnd(whole.ctx, whole.id)
  await cutToTheEnd(sliced.ctx, sliced.id)
  saveIndexes()
  assert.ok(answerNames(whole.home, whole.id).some((n) => n.startsWith('p1.')), 'past two packs')
  assert.deepEqual(textsOf(sliced), textsOf(whole))
})

test('a unit of the write does not scan every changed rid: the deadline reaches the scan', async () => {
  const { id, ctx } = homeWith(1100), s = await folded(ctx, id), log = s.V.log, latest = log.latest
  let read = 0
  log.latest = (...a) => { read++; return latest(...a) }
  assert.equal(writeFiles(ctx, s, 0), null, 'cut')
  log.latest = latest
  assert.ok(read > 0 && read < log.changedSince(-1).rids.length, 'stopped part way through what changed')
})

// Round after round: calls arrive, the write is cut after `units` units, then a record lands and the fold moves on, or the worker takes
// up another session; it goes on to the end. The same calls in a home whose writes are never cut come to the same files.
for (const between of ['a record of the session lands', 'the worker takes up another session']) {
  test(`a write cut while ${between} loses no rid`, async () => {
    const sliced = homeWith(300), whole = homeWith(300)
    await toTheEnd(sliced.ctx, sliced.id); await toTheEnd(whole.ctx, whole.id)
    for (const units of [1, 3, 40, 400]) {
      sliced.a.append(280); whole.a.append(280)
      cut(sliced.ctx, await folded(sliced.ctx, sliced.id), units)
      if (between.startsWith('a record')) { sliced.a.append(3); whole.a.append(3) } else await toTheEnd(sliced.ctx, sliced.other)
      await cutToTheEnd(sliced.ctx, sliced.id); await toTheEnd(whole.ctx, whole.id)
      saveIndexes()
      sameFiles(sliced, whole, `cut after ${units} units`)
    }
  })
}

test('the first write of a worker that starts from a checkpoint, cut in its scan while the fold moves on, loses no rid', async () => {
  const first = homeWith(700), { id } = first
  await toTheEnd(first.ctx, id)
  saveIndexes()
  const started = () => {
    const h = homeWith(700, SHAPE, id)
    fs.rmSync(path.join(h.home, 'index'), { recursive: true, force: true })
    fs.cpSync(path.join(first.home, 'index'), path.join(h.home, 'index'), { recursive: true })
    return h
  }
  const sliced = started(), whole = started()
  sliced.a.append(600); whole.a.append(600)
  cut(sliced.ctx, await folded(sliced.ctx, id), 1)
  sliced.a.append(3); whole.a.append(3)
  await cutToTheEnd(sliced.ctx, id); await toTheEnd(whole.ctx, id)
  sameFiles(sliced, whole, 'from a checkpoint', (n) => !n.startsWith('head')) // one id in both homes: what the worker keeps of a head is shared
})

// The columns as they read: a lane by its key (its int is only the order it was met in), slots with no row left out, the live lanes as a set.
function said(parts) {
  const p = Object.fromEntries(parts), row = (k) => p['s.tk'][k] !== 0, by = (a) => Array.from(a, (v, k) => (row(k) ? v : null))
  return { at: p['s.at'][0], tk: [...p['s.tk']], ts: p['s.ts'], ln: Array.from(p['s.ln'], (v, k) => (row(k) ? p['s.keys'][v] : null)), uc: by(p['s.uc']), cs: by(p['s.cs']), cx: by(p['s.cx']), cb: by(p['s.cb']), fl: by(p['s.fl']), order: [...p['s.order']], lanes: [...p['s.lanes']].sort() }
}
function opened(home, id) {
  const p = openProjection({ home, fs, key: id, write: false, errors: [] })
  const log = openFoldLog({ home, fs, key: id, write: false, projection: { id: p.id, bytes: p.bytes }, errors: [] })
  return { p, log, close() { p.close(); log.close() } }
}

for (const [name, shape] of [['rows arriving in order', { growth: 120, subEvery: 3 }], ['late rows, lanes side by side, compactions', SHAPE]]) {
  test(`a checkpoint at any slice of a fold reads back the columns of a full recompute at its frontier: ${name}`, async () => {
    const { home, id, ctx } = homeWith(300, shape)
    let checked = 0
    for (let more = true; more;) {
      more = await extendSession(ctx, id, 5)
      saveIndexes() // what a killed worker leaves
      const o = opened(home, id), cols = o.log.saved && loadColumns(o.p.rows, o.log.saved.parts)
      if (cols) {
        assert.equal(cols.at, o.log.frontier, 'the columns stand at the frontier')
        assert.deepEqual(said(dumpColumns(cols)), said(dumpColumns(sync(columns(o.p.rows.slotOf), o.log))))
        checked++
      }
      o.close()
    }
    assert.ok(checked > 1, 'more than one checkpoint')
  })
}

test('a background slice leaves the columns at its frontier: a checkpoint has only its own slice to bring', async () => {
  const { id, ctx } = homeWith(600), seen = new Set(), { st } = await sessionState(ctx, id)
  while (await extendSession(ctx, id, 2)) {
    assert.equal(st.target, null, 'a reduction writing into its log')
    if (st.log.frontier == null) continue
    assert.equal(st.cols.at, st.log.frontier)
    seen.add(st.log.frontier)
  }
  assert.ok(seen.size > 1, 'the frontier moved between slices')
})

test('sync walking oldest to newest gives what newest to oldest gave', async () => {
  const { home, id, ctx } = homeWith(700)
  await toTheEnd(ctx, id)
  const o = opened(home, id)
  const other = Object.create(o.log, { changedSince: { value: (off) => { const c = o.log.changedSince(off); return { ...c, rids: [...c.rids].reverse() } } } })
  const one = sync(columns(o.p.rows.slotOf), o.log), two = sync(columns(o.p.rows.slotOf), other)
  assert.deepEqual(said(dumpColumns(one)), said(dumpColumns(two)))
  assert.deepEqual([...one.lanes].sort(), [...two.lanes].sort())
  for (const key of one.keys.keys()) assert.deepEqual(one.by[one.keys.get(key)], { ...two.by[two.keys.get(key)], v: one.keys.get(key) }, `lane ${key}`)
  o.close()
})

test('a whole sync says it is working while it runs, here and on a cold read with no columns saved', async () => {
  const { home, id, ctx } = homeWith(700)
  await toTheEnd(ctx, id)
  saveIndexes()
  const o = opened(home, id)
  let said1 = 0
  sync(columns(o.p.rows.slotOf), o.log, () => { said1++ })
  o.close()
  assert.ok(said1 > 0, 'sync reports through the progress it is given')
  const coldRead = async (drop) => {
    const to = path.join(tmpDir('trocar-slices-cold-'), '.trocar')
    fs.cpSync(home, to, { recursive: true, filter: (f) => !(drop && path.basename(f) === 'fold.idx') })
    let n = 0
    await sessionState({ home: to, fs, writer: true, progress: () => { n++ } }, id)
    return n
  }
  assert.ok(await coldRead(true) > await coldRead(false), 'columns made from the log are heard, columns read from the sidecar need not be')
})
