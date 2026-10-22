// test/query/sidecar.test.mjs — the sidecars of the context projection and its fold log (4.3 §4 旁索引, 4.3 #7): a cold open through
// a sidecar answers what a scan answers, a stale or foreign sidecar is never used, the GC takes a sidecar with its pair, and the
// local path writes none. Over test/query/big-session.mjs on every wire, late records and subagents side by side, as
// projection.test.mjs. The expected answers come from a copy of the same home with no sidecar.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { saveIndexes, extendSession } from '../../src/query/named/session.mjs'
import { openProjection, projectionFile, gcProjections } from '../../src/query/projection.mjs'
import { openFoldLog, foldLogFile } from '../../src/query/fold-log.mjs'

const SEG = '20261020T164737Z'
const FIRST = 8, MORE = 6
const WIRES = ['http', 'threads', 'ws', 'chat']
const ARRIVALS = [{ late: 0, subLanes: 1 }, { late: 3, subLanes: 1 }, { late: 0, subLanes: 4 }, { late: 3, subLanes: 4 }]
const homeOf = (p) => path.join(tmpDir(p), '.trocar')
const ctxDir = (home) => path.join(home, 'index', 'ctx')
const sidecars = (home) => { try { return fs.readdirSync(ctxDir(home)).filter((n) => n.endsWith('.idx')) } catch (e) { if (e.code === 'ENOENT') return []; throw e } }
const q = (name, home, params, ctx = {}) => runQuery(name, params, { home, fs, ...ctx })

// The worker's background slices until nothing is left, then its answer.
async function settled(home, id) {
  for (let i = 0; i < 500 && await extendSession({ home, fs, writer: true }, id, Infinity); i++);
  const doc = await q('session', home, { id }, { writer: true })
  assert.equal(doc.pending, undefined, 'settled')
  return doc
}
// The worker's home: FIRST calls projected and folded, the sidecars saved, then MORE calls (late rows, new lanes) projected and folded
// past them.
async function written(wire, arrival) {
  const home = homeOf('trocar-side-')
  const s = bigSession({ home, wire, growth: 200, subEvery: 3, compactAt: 1_500, segment: SEG, ...arrival })
  s.append(FIRST)
  await settled(home, s.id)
  saveIndexes()
  assert.deepEqual(sidecars(home).sort(), [path.basename(projectionFile(home, s.id)).replace(/\.ndjson$/, '.idx'),
    path.basename(foldLogFile(home, s.id)).replace(/\.ndjson$/, '.idx')].sort(), 'the worker wrote both sidecars')
  s.append(MORE)
  await settled(home, s.id)
  return { home, id: s.id }
}
// A copy of the home (a new path: a store of its own in this process), with or without the sidecars.
function copy(home, keep = true) {
  const to = homeOf('trocar-side-copy-')
  fs.cpSync(home, to, { recursive: true, filter: (f) => keep || !f.endsWith('.idx') })
  return to
}
// What the board reads first: the session's newest page whole, each lane's tail; and the stores read straight.
async function answers(home, id) {
  const doc = await settled(home, id)
  const lanes = []
  for (const l of doc.lanes) lanes.push(await q('lane', home, { id, lane: l.lane }, { writer: true }))
  return { doc, lanes }
}
function stores(home, id) {
  const p = openProjection({ home, fs, key: id, write: false, errors: [] })
  const log = openFoldLog({ home, fs, key: id, write: false, projection: { id: p.id, bytes: p.bytes }, errors: [] })
  const { rids, lanes } = log.changedSince(-1)
  const rows = [...p.rows.keys()]
  const out = {
    rows: rows.map((rid) => [rid, p.rows.slotOf(rid), p.rows.get(rid)]),
    defs: Array.from({ length: p.defCount }, (_, i) => [p.defBid(i), p.readDef(p.defBid(i))]),
    rids, lanes, frontier: log.frontier,
    latest: rids.map((r) => log.latest(r)), lane: lanes.map((k) => log.lane(k)), at: rows.map((r) => log.frontierAt(r)),
    items: [...log.items.keys()].map((k) => log.items.get(k)), failures: [...log.failures.keys()].map((k) => log.failures.get(k)),
  }
  p.close(); log.close()
  return out
}
async function agree(withSide, without, id, tag) {
  assert.deepEqual(stores(withSide, id), stores(without, id), `${tag}: the stores`)
  const a = await answers(withSide, id), b = await answers(without, id)
  assert.equal(JSON.stringify(a), JSON.stringify(b), `${tag}: the answers`)
  for (const d of [a.doc, ...a.lanes]) assert.ok(d.errors.every((e) => e.level), `${tag}: no error without a level`)
}

test('4.3 #7: a cold open through the sidecars answers what a scan answers, byte for byte', { timeout: 600_000 }, async () => {
  for (const wire of WIRES) for (const arrival of ARRIVALS) {
    const tag = `${wire} late=${arrival.late} subLanes=${arrival.subLanes}`
    const { home, id } = await written(wire, arrival)
    await agree(copy(home), copy(home, false), id, tag)
  }
})

// what a sidecar's header says (4.3 §4: its first line)
const sideHead = (file) => { const b = fs.readFileSync(file); return JSON.parse(b.toString('utf8', 0, b.indexOf(10))) }
const lineStartBelow = (file, n) => fs.readFileSync(file).lastIndexOf(10, n - 2) + 1 // the last line that ends at or before n begins here
const DAMAGE = {
  // the projection and its log rebuilt (another id) beside the old sidecars
  async rebuilt(home, id) {
    fs.rmSync(projectionFile(home, id)); fs.rmSync(foldLogFile(home, id))
    const fresh = copy(home, false)
    await settled(fresh, id)
    for (const f of [projectionFile(home, id), foldLogFile(home, id)]) fs.copyFileSync(f.replace(home, fresh), f)
  },
  // each file cut (mid-line) shorter than its sidecar covers
  cut(home, id) {
    for (const f of [projectionFile(home, id), foldLogFile(home, id)]) fs.truncateSync(f, Math.floor(fs.statSync(f).size / 3))
  },
  // sidecar bytes that are not one: noise, and a sidecar cut short
  garbage(home, id, both) {
    if (!both) return
    let seed = 7
    for (const n of sidecars(home)) {
      const f = path.join(ctxDir(home), n), len = fs.statSync(f).size
      fs.writeFileSync(f, Buffer.from(Array.from({ length: len }, () => (seed = (seed * 1103515245 + 12345) >>> 0) & 0xff)))
    }
  },
  short(home, id, both) {
    if (both) for (const n of sidecars(home)) { const f = path.join(ctxDir(home), n); fs.truncateSync(f, fs.statSync(f).size - 3) }
  },
  // the projection cut back to below the fold log sidecar's frontier: its `pb` lies past the projection's bytes
  pb(home, id, _both, pb) {
    const f = projectionFile(home, id)
    fs.truncateSync(f, lineStartBelow(f, pb))
  },
}

test('4.3 #7: a sidecar that is stale or foreign is never used: the answers are the scan\'s, with no error', { timeout: 600_000 }, async () => {
  for (const wire of WIRES) {
    const arrival = ARRIVALS[3], { home, id } = await written(wire, arrival)
    const pb = sideHead(foldLogFile(home, id).replace(/\.ndjson$/, '.idx')).pb
    for (const [name, f] of Object.entries(DAMAGE)) {
      const tag = `${wire} ${name}`, a = copy(home), b = copy(home, false)
      await f(a, id, true, pb); await f(b, id, false, pb)
      await agree(a, b, id, tag)
    }
  }
})

test('4.3 #7: the GC deletes a sidecar with its pair and counts its bytes', () => {
  const home = homeOf('trocar-side-gc-'), keys = ['old', 'new']
  for (const key of keys) {
    const p = openProjection({ home, fs, key, errors: [] })
    p.append({ defs: [{ bid: `b-${key}`, text: 'x'.repeat(200) }], rows: [{ rid: '20261021T054349Z:1', bids: [`b-${key}`] }] })
    const log = openFoldLog({ home, fs, key, projection: { id: p.id, bytes: p.bytes }, errors: [] })
    log.append([{ c: '20261021T054349Z:1', s: 1 }, { f: '20261021T054349Z:1', n: 1, pb: p.bytes }])
    assert.ok(p.saveIndex() && log.saveIndex(), `${key}: the sidecars are written`)
    p.close(); log.close()
  }
  const files = (key) => [projectionFile(home, key), foldLogFile(home, key)].flatMap((f) => [f, f.replace(/\.ndjson$/, '.idx')])
  for (const [i, key] of keys.entries()) for (const f of files(key)) { assert.ok(fs.existsSync(f), f); fs.utimesSync(f, 1_000 + i, 1_000 + i) }
  const all = keys.flatMap(files).reduce((a, f) => a + fs.statSync(f).size, 0)
  // a cap one byte under the total: met only when the sidecars are counted, by deleting the least recently opened pair whole
  const { deleted } = gcProjections({ home, fs, liveKeys: keys, capBytes: all - 1 })
  assert.deepEqual(deleted.sort(), files('old').sort())
  assert.ok(files('new').every((f) => fs.existsSync(f)) && files('old').every((f) => !fs.existsSync(f)), 'on disk')
  assert.deepEqual(gcProjections({ home, fs, liveKeys: [] }).deleted.sort(), files('new').sort(), 'a session gone takes its sidecars')
})

test('4.3 #7: the local path writes no sidecar', async () => {
  const { home, id } = await written('http', ARRIVALS[3])
  const local = copy(home, false)
  const doc = await q('session', local, { id })
  assert.equal(doc.pending, undefined)
  await q('lane', local, { id, lane: doc.lanes[0].lane })
  saveIndexes()
  assert.deepEqual(sidecars(local), [])
})
