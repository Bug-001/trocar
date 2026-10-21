// test/query/projection.test.mjs — the context projection's store (RFC 4.3 §4, D69): a rebuildable
// NDJSON file per session under index/ctx/, its torn-tail and corrupt-file rules, its D38 notes, and its GC.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { snapshot } from './raw-home.mjs'
import { PROJECTION_NOTES } from '../../src/health/codes.mjs'
import { PROJ_V, projectionFile, openProjection, posCmp, gcProjections } from '../../src/query/projection.mjs'

const KEY = 'session-a'
const defs = [{ bid: 'b1', text: 'alpha' }, { bid: 'b2', text: 'β\nwith a newline', n: [1, 2] }]
const rows = [{ rid: '20261021T054349Z:3', bids: ['b1'] }, { rid: '20261021T054349Z:7', bids: ['b1', 'b2'] }]
const brks = [{ brk: ['b1', 'b2'], cause: 'edit', byteOffset: 12 }]

function filled(home, key = KEY) {
  const s = openProjection({ home, fs, key, errors: [] })
  s.append({ defs, rows, brks })
  return s
}
const view = (s) => ({
  defs: defs.map((d) => s.hasDef(d.bid) && s.readDef(d.bid)),
  rows: Object.fromEntries(s.rows),
  brk: s.brk('b1', 'b2'),
})
const expected = { defs, rows: Object.fromEntries(rows.map((r) => [r.rid, r])), brk: brks[0] }

test('(a) a reopened store answers the same definitions, rows and breaks', () => {
  const home = tmpDir('trocar-proj-')
  filled(home)
  const errors = []
  const again = openProjection({ home, fs, key: KEY, errors })
  assert.deepEqual(view(again), expected)
  assert.deepEqual(errors, [])
  assert.ok(projectionFile(home, KEY).startsWith(path.join(home, 'index', 'ctx') + path.sep))
})

test('(b) a torn last line, cut at every position, reopens to the complete lines; the next append is clean', () => {
  const home = tmpDir('trocar-proj-')
  const file = projectionFile(home, KEY)
  filled(home)
  const whole = fs.readFileSync(file)
  const base = whole.subarray(0, whole.lastIndexOf(10, whole.length - 2) + 1) // every line but the last
  const extra = { rid: '20261021T054349Z:9', bids: ['b2'] }
  for (let cut = 1; cut < whole.length - base.length; cut++) {
    fs.writeFileSync(file, whole.subarray(0, base.length + cut))
    const errors = []
    const s = openProjection({ home, fs, key: KEY, errors })
    const want = openProjection({ home: tmpDir('trocar-proj-'), fs, key: KEY, write: false, errors: [] })
    for (const l of base.toString('utf8').split('\n').slice(1, -1)) {
      const o = JSON.parse(l)
      want.append({ defs: o.d ? [o.d] : [], rows: o.c ? [o.c] : [], brks: o.b ? [o.b] : [] })
    }
    assert.deepEqual(view(s), view(want), `cut ${cut}`)
    s.append({ rows: [extra] })
    const re = openProjection({ home, fs, key: KEY, errors })
    assert.deepEqual(re.rows.get(extra.rid), extra, `cut ${cut}`)
    assert.deepEqual(view(re).defs, view(want).defs, `cut ${cut}`)
    assert.deepEqual(errors, [], `cut ${cut}`)
  }
})

test('(c) a corrupt middle line or a PROJ_V mismatch empties the file with one projection-rebuilt note', () => {
  const lines = (home) => fs.readFileSync(projectionFile(home, KEY), 'utf8').split('\n')
  const damage = {
    corrupt: (l) => { l[2] = '{"d":{"bid":'; return l },
    version: (l) => { l[0] = JSON.stringify({ v: PROJ_V + 1 }); return l },
  }
  for (const [name, f] of Object.entries(damage)) {
    const home = tmpDir('trocar-proj-')
    filled(home)
    fs.writeFileSync(projectionFile(home, KEY), f(lines(home)).join('\n'))
    const errors = []
    const s = openProjection({ home, fs, key: KEY, errors })
    assert.equal(s.rows.size, 0, name)
    assert.equal(s.hasDef('b1'), false, name)
    assert.deepEqual(errors.map(({ where, code, level }) => ({ where, code, level })), [{ where: 'projection', code: 'projection-rebuilt', level: 'note' }], name)
    assert.ok(PROJECTION_NOTES.includes(errors[0].code))
    assert.equal(typeof errors[0].reason, 'string', name)
    s.append({ rows: [rows[0]] })
    const re = openProjection({ home, fs, key: KEY, errors: [] })
    assert.deepEqual([...re.rows.keys()], [rows[0].rid], name)
  }
})

test('(d) a disk that refuses writes keeps the items in memory and says so once per episode', () => {
  const home = tmpDir('trocar-proj-')
  let full = true
  const enospc = () => Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
  const stub = {
    ...fs,
    appendFileSync: (...a) => { if (full) throw enospc(); return fs.appendFileSync(...a) },
    writeFileSync: (...a) => { if (full) throw enospc(); return fs.writeFileSync(...a) },
  }
  const errors = []
  const s = openProjection({ home, fs: stub, key: KEY, errors })
  s.append({ defs: [defs[0]], rows: [rows[0]] })
  s.append({ defs: [defs[1]], rows: [rows[1]], brks })
  assert.deepEqual(view(s), expected)
  const notes = () => errors.filter((e) => e.code === 'projection-write-failed')
  assert.equal(notes().length, 1)
  assert.equal(notes()[0].level, 'note')
  assert.ok(PROJECTION_NOTES.includes('projection-write-failed'))
  full = false
  s.append({ rows: [{ rid: '20261021T054349Z:9' }] })
  full = true
  s.append({ rows: [{ rid: '20261021T054349Z:10' }] })
  assert.equal(notes().length, 2) // the successful write ended the first episode
})

test('(e) GC deletes projections of sessions that are gone, then the least recently opened over the cap', () => {
  const home = tmpDir('trocar-proj-')
  for (const k of ['old', 'mid', 'new', 'dead']) filled(home, k)
  const t0 = Date.now() / 1000
  for (const [k, age] of [['old', 300], ['mid', 200], ['new', 100], ['dead', 0]]) fs.utimesSync(projectionFile(home, k), t0 - age, t0 - age)
  openProjection({ home, fs, key: 'old', errors: [] }) // opening it makes it the most recently opened
  const size = fs.statSync(projectionFile(home, 'mid')).size
  gcProjections({ home, fs, liveKeys: ['old', 'mid', 'new'], rawBytes: size * 25, now: Date.now() }) // cap = 2.5 files
  const left = ['old', 'mid', 'new', 'dead'].filter((k) => fs.existsSync(projectionFile(home, k)))
  assert.deepEqual(left, ['old', 'new'])
})

test('(f) write:false leaves the home byte-identical', () => {
  const home = tmpDir('trocar-proj-')
  filled(home)
  fs.appendFileSync(projectionFile(home, KEY), '{"c":{"rid":"20261021T054349Z:9"') // a torn tail it must not truncate
  fs.writeFileSync(projectionFile(home, 'bad'), '{"v":-1}\n') // a mismatch it must not delete
  const before = snapshot(home)
  for (const key of [KEY, 'bad', 'fresh']) {
    const s = openProjection({ home, fs, key, write: false, errors: [] })
    s.append({ defs, rows, brks })
    assert.deepEqual(view(s), expected, key)
  }
  assert.deepEqual(snapshot(home), before)
})

test('posCmp orders record ids by segment, collision suffix, then line', () => {
  const ids = ['20261021T054349Z:2', '20261021T054349Z:10', '20261021T054349Z-2:1', '20261021T054349Z-10:1', '20261022T000000Z:1']
  const shuffled = [ids[3], ids[4], ids[1], ids[2], ids[0]]
  assert.deepEqual(shuffled.sort(posCmp), ids)
})
