// test/query/fold-log.test.mjs — the fold log's store (RFC 4.3 §4 折叠日志 · 4.3 #7): a content-blind, append-only NDJSON file beside
// the projection, read back by offset. Lines are generated over the axes the store tells apart (kind, rid / lane key, a line's
// bytes with multi-byte and escaped characters, how many lines a fold step holds); expected answers come from a model of the lines
// as written (their offsets, the previous line of the same rid / lane key), never from the store.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { snapshot } from './raw-home.mjs'
import { PROJECTION_NOTES } from '../../src/health/codes.mjs'
import { projectionFile, openProjection, gcProjections } from '../../src/query/projection.mjs'
import { FOLD_V, foldLogFile, openFoldLog } from '../../src/query/fold-log.mjs'

const KEY = 'session-a'
const RIDS = ['20261021T054349Z:1', '20261021T054349Z:2', '20261021T054349Z:3', '20261022T000000Z:1']
const LANES = ['20261021T054349Z:1', 'lane-b', 'lane-ç']
const CHAIN = { c: 'rid', g: 'rid', l: 'lane', lg: 'lane' }
const PROJ = { id: 'proj-1', bytes: 1e9 }
const PB = 100 // fold step i (from 0) ends in a frontier with pb = PB × (i + 1)

function rng(seed) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 } }
/** `count` fold steps from step `from`: each some lines of every kind, then its frontier line. */
function steps(seed, count, from = 0) {
  const r = rng(seed), pick = (a) => a[Math.floor(r() * a.length)]
  return Array.from({ length: count }, (_, s) => {
    const out = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, j) => {
      const k = pick(['c', 'c', 'g', 'l', 'lg', 'i', 'x'])
      return { [k]: pick(CHAIN[k] === 'lane' ? LANES : RIDS), body: 'é\n"'.repeat(Math.floor(r() * 4)) + `${s}.${j}`, n: [s, j] }
    })
    return [...out, { f: pick(RIDS), n: from + s + 1, pb: PB * (from + s + 1) }]
  })
}

/** What a log holding `entries` ([{off, line}], in order, `line` as given) answers, `p` set by the model. */
function model(entries) {
  const last = new Map(), lines = [], frontierAt = {}
  let frontier
  for (const { off, line } of entries) {
    const k = Object.keys(line)[0], chain = CHAIN[k] && `${CHAIN[k]}:${line[k]}`
    const full = chain ? { ...line, p: last.get(chain)?.off ?? null } : line
    if (chain) last.set(chain, { off, line: full })
    if (k === 'f') { frontier = off; frontierAt[line.f] = off }
    lines.push({ off, chain, line: full })
  }
  const probes = [-1, ...entries.map((e) => e.off)]
  return {
    latest: RIDS.map((r) => last.get(`rid:${r}`)?.line ?? null),
    lanes: LANES.map((l) => last.get(`lane:${l}`)?.line ?? null),
    own: ['i', 'x'].map((k) => RIDS.map((r) => entries.filter((e) => Object.keys(e.line)[0] === k && e.line[k] === r).at(-1)?.line ?? null)),
    versions: probes.map((o) => RIDS.map((r) => lines.filter((e) => e.chain === `rid:${r}` && e.off <= o).at(-1)?.off ?? null)),
    changed: probes.map((o) => [RIDS.filter((r) => last.get(`rid:${r}`)?.off > o), LANES.filter((l) => last.get(`lane:${l}`)?.off > o)]),
    frontier: frontier ?? null,
    frontierAt: RIDS.map((r) => frontierAt[r] ?? null),
  }
}
/** The same questions asked of a store, at the probes of `entries`. */
function view(log, entries) {
  const at = (p) => (p ? log.read(p[0], p[1]) : null)
  const probes = [-1, ...entries.map((e) => e.off)]
  return {
    latest: RIDS.map((r) => at(log.latest(r))),
    lanes: LANES.map((l) => at(log.lane(l))),
    own: [log.items, log.failures].map((idx) => RIDS.map((r) => at(idx.get(r)))),
    versions: probes.map((o) => RIDS.map((r) => log.versionAt(r, o)?.[0] ?? null)),
    changed: probes.map((o) => { const c = log.changedSince(o); return [RIDS.filter((r) => c.rids.includes(r)), LANES.filter((l) => c.lanes.includes(l))] }),
    frontier: log.frontier ?? null,
    frontierAt: RIDS.map((r) => log.frontierAt(r) ?? null),
  }
}
/** Appends `ss` one step per append; returns the entries with the offsets the store gave. */
function write(log, ss, opts) {
  const out = []
  for (const s of ss) log.append(s, opts).forEach((off, i) => out.push({ off, line: s[i] }))
  return out
}
const open = (home, o = {}) => openFoldLog({ home, fs, key: KEY, projection: PROJ, errors: [], ...o })
const notes = (errors) => errors.map(({ where, code, level }) => ({ code, level, where: typeof where }))
const REBUILT = [{ code: 'projection-rebuilt', level: 'note', where: 'string' }]

test('4.3 #7 fold log: its file sits beside the projection in the session directory (0700), mode 0600', () => {
  const home = tmpDir('trocar-fold-')
  write(open(home), steps(1, 2))
  const dir = path.join(home, 'index', 'ctx', createHash('sha256').update(KEY).digest('hex').slice(0, 32))
  assert.equal(foldLogFile(home, KEY), path.join(dir, 'fold.0.ndjson'))
  assert.equal(projectionFile(home, KEY), path.join(dir, 'extract.0.ndjson'))
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(foldLogFile(home, KEY)).mode & 0o777, 0o600)
})

test('4.3 #7 fold log: a reopened log gives the same latest lines, item and failed lines by rid, versionAt answers and frontiers', () => {
  for (const seed of [1, 2, 3, 4]) {
    const home = tmpDir('trocar-fold-'), log = open(home)
    const entries = write(log, steps(seed, 6))
    const errors = []
    const again = open(home, { errors })
    assert.deepEqual(view(log, entries), model(entries), `seed ${seed}: the writer`)
    assert.deepEqual(view(again, entries), model(entries), `seed ${seed}: reopened`)
    assert.deepEqual(errors, [])
  }
})

test('4.3 #7 fold log: a file cut at every byte reopens to its whole fold steps, and the next append is clean', () => {
  const home = tmpDir('trocar-fold-'), file = foldLogFile(home, KEY)
  const entries = write(open(home), steps(5, 3))
  const whole = fs.readFileSync(file)
  const more = steps(6, 1, 3)
  for (let cut = 0; cut < whole.length; cut++) {
    fs.writeFileSync(file, whole.subarray(0, cut))
    const errors = [], log = open(home, { errors })
    // a frontier line ends a step: what survives is every step whose frontier line is whole
    const kept = entries.slice(0, entries.findLastIndex((e) => e.line.f && e.off + Buffer.byteLength(JSON.stringify({ ...e.line })) < cut) + 1)
    assert.deepEqual(view(log, kept), model(kept), `cut ${cut}`)
    const added = write(log, more)
    const re = open(home, { errors })
    assert.deepEqual(view(re, [...kept, ...added]), model([...kept, ...added]), `cut ${cut}: after the next append`)
    assert.deepEqual(errors, [], `cut ${cut}`)
  }
})

test('4.3 #7 fold log: FOLD_V of another version, a pid not the projection id, or a corrupt middle line → empty, one projection-rebuilt note', () => {
  const damage = {
    version: (l) => { l[0] = JSON.stringify({ v: FOLD_V + 1, pid: PROJ.id }); return PROJ },
    pid: () => ({ ...PROJ, id: 'proj-2' }),
    corrupt: (l) => { l[3] = '{"c":"20261021T054349Z:1","body":'; return PROJ },
  }
  for (const [name, f] of Object.entries(damage)) {
    const home = tmpDir('trocar-fold-'), file = foldLogFile(home, KEY)
    write(open(home), steps(7, 4))
    const l = fs.readFileSync(file, 'utf8').split('\n')
    const projection = f(l)
    fs.writeFileSync(file, l.join('\n'))
    const errors = [], log = open(home, { projection, errors })
    assert.deepEqual(view(log, []), model([]), name)
    assert.deepEqual(notes(errors), REBUILT, name)
    assert.ok(PROJECTION_NOTES.includes(errors[0].code))
    const added = write(log, steps(8, 2))
    const re = open(home, { projection, errors: [] })
    assert.deepEqual(view(re, added), model(added), `${name}: rebuilt from empty`)
  }
})

test('4.3 #7 fold log: a projection reopened shorter than a frontier\'s pb drops that frontier and every line after it', () => {
  for (const bytes of [0, PB - 1, PB, 2.5 * PB, 4 * PB]) {
    const home = tmpDir('trocar-fold-')
    const entries = write(open(home), steps(9, 4))
    const errors = [], log = open(home, { projection: { ...PROJ, bytes }, errors })
    const kept = entries.slice(0, entries.findLastIndex((e) => e.line.f && e.line.pb <= bytes) + 1)
    assert.deepEqual(view(log, kept), model(kept), `bytes ${bytes}`)
    const added = write(log, steps(10, 1, 4))
    assert.deepEqual(view(open(home), [...kept, ...added]), model([...kept, ...added]), `bytes ${bytes}: the dropped lines are gone from the file`)
    assert.deepEqual(errors, [])
  }
})

test('4.3 #7 fold log: write:false leaves the home byte-identical', () => {
  const home = tmpDir('trocar-fold-')
  const entries = write(open(home), steps(11, 2))
  fs.appendFileSync(foldLogFile(home, KEY), '{"c":"20261021T054349Z:1"') // a torn tail it must not truncate
  write(openFoldLog({ home, fs, key: 'other', projection: { ...PROJ, id: 'proj-x' }, errors: [] }), steps(12, 1)) // a log of another projection
  const before = snapshot(home)
  for (const key of [KEY, 'other', 'fresh']) {
    const log = openFoldLog({ home, fs, key, write: false, projection: PROJ, errors: [] })
    const all = [...(key === KEY ? entries : []), ...write(log, steps(13, 3, 2))]
    assert.deepEqual(view(log, all), model(all), key)
  }
  assert.deepEqual(snapshot(home), before)
})

test('4.3 #7 fold log: a disk that refuses writes answers the same, with one projection-write-failed note per episode', () => {
  const ss = steps(14, 6)
  const ref = tmpDir('trocar-fold-'), want = write(open(ref), ss)
  const home = tmpDir('trocar-fold-')
  let full = true
  const stub = { ...fs, appendFileSync: (...a) => { if (full) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); return fs.appendFileSync(...a) } }
  const errors = [], log = openFoldLog({ home, fs: stub, key: KEY, projection: PROJ, errors })
  const got = []
  ss.forEach((s, i) => { full = i < 2 || i >= 4; got.push(...write(log, [s])) })
  assert.deepEqual(got.map((e) => e.off), want.map((e) => e.off))
  assert.deepEqual(view(log, got), model(want))
  assert.deepEqual(errors.map((e) => [e.code, e.level]), [['projection-write-failed', 'note'], ['projection-write-failed', 'note']])
  assert.ok(PROJECTION_NOTES.includes('projection-write-failed'))
  full = false
  const all = [...got, ...write(log, steps(15, 1, 6))]
  assert.deepEqual(view(open(home), all), model(all), 'what the failing disk held back is written by the next append that works')
})

test('4.3 #7 fold log: gcProjections removes a projection with its fold log, and the cap counts both', () => {
  const home = tmpDir('trocar-fold-')
  for (const key of ['old', 'new', 'dead']) {
    const p = openProjection({ home, fs, key, errors: [] })
    p.append({ rows: [{ rid: RIDS[0] }] })
    write(openFoldLog({ home, fs, key, projection: p, errors: [] }), steps(16, 3))
  }
  write(openFoldLog({ home, fs, key: 'orphan', projection: PROJ, errors: [] }), steps(17, 1)) // a fold log whose projection is gone
  const t0 = Date.now() / 1000
  for (const [key, age] of [['old', 300], ['new', 100]]) for (const f of [projectionFile(home, key), foldLogFile(home, key)]) fs.utimesSync(f, t0 - age, t0 - age)
  const size = (k) => fs.statSync(projectionFile(home, k)).size + fs.statSync(foldLogFile(home, k)).size
  const projOnly = fs.statSync(projectionFile(home, 'old')).size + fs.statSync(projectionFile(home, 'new')).size
  const cap = Math.max(projOnly, size('new')) // room for both projections, not for both pairs
  assert.ok(cap < size('old') + size('new'))
  gcProjections({ home, fs, liveKeys: ['old', 'new'], capBytes: cap })
  const left = (f) => ['old', 'new', 'dead', 'orphan'].filter((k) => fs.existsSync(f(home, k)))
  assert.deepEqual(left(projectionFile), ['new'])
  assert.deepEqual(left(foldLogFile), ['new'])
})
