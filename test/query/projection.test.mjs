// test/query/projection.test.mjs — the context projection's store (RFC 4.3 §4, D69): a rebuildable
// NDJSON file per session under index/ctx/, its torn-tail and corrupt-file rules, its D38 notes, and its GC; and
// 3.5 #15 end to end: whatever order the projection was built in, it reduces to the document of a fresh extraction.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { snapshot, rawHome } from './raw-home.mjs'
import { bigSession } from './big-session.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { recordsAt } from '../../src/query/records.mjs'
import { extractMembers, blockAt } from '../../src/view/extract.mjs'
import { reduce, listOf } from '../../src/view/reduce.mjs'
import { parseTextRef } from '../../src/raw/refs.mjs'
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
  gcProjections({ home, fs, liveKeys: ['old', 'mid', 'new'], capBytes: size * 2.5 })
  const left = ['old', 'mid', 'new', 'dead'].filter((k) => fs.existsSync(projectionFile(home, k)))
  assert.deepEqual(left, ['old', 'new'])
})

test('(e) GC never evicts a session that is open or followed, and needs to be told which sessions live', () => {
  const keys = ['a', 'b', 'c']
  for (const cap of [0, 1, 1e9]) for (const open of keys) {
    const home = tmpDir('trocar-proj-')
    for (const k of keys) filled(home, k)
    gcProjections({ home, fs, liveKeys: keys.filter((k) => k !== open), keepKeys: [open], capBytes: cap })
    assert.ok(fs.existsSync(projectionFile(home, open)), `cap ${cap}: the open session ${open} stays, even when not listed live and over the cap`)
    const total = keys.filter((k) => k !== open && fs.existsSync(projectionFile(home, k))).length
    if (cap === 0) assert.equal(total, 0, 'over the cap: every other one goes')
  }
  const home = tmpDir('trocar-proj-')
  filled(home, 'a')
  assert.throws(() => gcProjections({ home, fs }), TypeError)
  assert.ok(fs.existsSync(projectionFile(home, 'a')), 'no list of live sessions deletes nothing')
})

test('(g) a value that recurs across rows is written once and read back as one shared object', () => {
  const big = { text: 'a lane\'s first prompt '.repeat(40) }
  const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ rid: `20261021T054349Z:${i + 1}`, x: { facts: { first: big, own: `call ${i}` }, wire: { state: 'complete', vendor: 'v'.repeat(60) } },
    attrs: { 0: { volatile: true, note: 'n'.repeat(60) } } }))
  // a value of a reference's own shape, at every depth, stays itself
  const tricky = { rid: '20261021T054349Z:99', x: { $s: 'k', y: { $s: 'not-a-key' }, z: { w: { $s: 'deep' } } }, attrs: { $s: 'x' } }
  for (const split of [1, 3, 10]) {
    const home = tmpDir('trocar-proj-'), rs = [...rowsOf(10), tricky]
    const s = openProjection({ home, fs, key: KEY, errors: [] })
    for (let i = 0; i < rs.length; i += split) s.append({ rows: rs.slice(i, i + split) })
    const once = fs.readFileSync(projectionFile(home, KEY), 'utf8')
    assert.equal(once.split(big.text).length - 1, 2, `split ${split}: the recurring value is on disk twice (its first row, its shared line)`)
    const again = openProjection({ home, fs, key: KEY, errors: [] })
    assert.deepEqual(Object.fromEntries(again.rows), Object.fromEntries(rs.map((r) => [r.rid, r])), `split ${split}: rows read back as written`)
    const r5 = again.rows.get('20261021T054349Z:5'), r6 = again.rows.get('20261021T054349Z:6')
    assert.equal(r5.x.facts.first, r6.x.facts.first, `split ${split}: one object for every row that holds it`)
    assert.deepEqual(Object.fromEntries(s.rows), Object.fromEntries(rs.map((r) => [r.rid, r])), `split ${split}: the writing store holds the rows as given`)
    // a reference whose shared line is gone: the file is rebuilt, never read with a hole
    fs.writeFileSync(projectionFile(home, KEY), once.split('\n').filter((l) => !l.startsWith('{"s"')).join('\n'))
    const errors = [], lost = openProjection({ home, fs, key: KEY, errors })
    assert.equal(lost.rows.size, 0, `split ${split}`)
    assert.deepEqual(errors.map((e) => e.code), ['projection-rebuilt'], `split ${split}`)
  }
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

// ── 3.5 #15: a projection built in any arrival order reduces to the document of a fresh extraction ──────────────────────────────
// End to end over the real pieces: records in a temp home's raw (big-session), the segment index, recordsAt, the store, the
// extraction driver and the reduction. Axes, one at a time: the wire; late records (in their own lane, in another) and subagents side
// by side ('chat' tells its subagents apart by order only); and how the projection was built — grown, cut by a budget and reopened,
// its last line torn, deleted, a middle line corrupt, a PROJ_V of another version. The expected document comes only from one pass
// over a copy of the same raw in a new home.
const SEG = '20261020T164737Z'
const FIRST = 8, MORE = 6
const ARRIVALS = [{ late: 0, subLanes: 1 }, { late: 3, subLanes: 1 }, { late: 0, subLanes: 4 }, { late: 3, subLanes: 4 }]
const docBytes = (doc) => JSON.stringify(doc, (k, v) => (v instanceof Map ? [...v] : v))

function sessionOf(home, wire, arrival) {
  return bigSession({ home, wire, growth: 200, subEvery: 3, compactAt: 1_500, segment: SEG, ...arrival })
}
/** The session as the index sees it: its members, a records reader that notes the ids asked, a resolver over the raw. */
async function indexed(home, id, rfs = fs) {
  const rows = await indexRows({ home, fs: rfs, errors: [] })
  const members = sessionGroups(rows).get(id)
  assert.ok(members && members.length, `session ${id} is in the index`)
  const byId = new Map(members.map((m) => [String(m.id), m]))
  const asked = []
  const read = (rs) => { asked.push(...rs.map((r) => String(r.id))); return recordsAt({ home, fs: rfs, rows: rs, errors: [] }) }
  const resolve = (ref) => blockAt(recordsAt({ home, fs: rfs, rows: [byId.get(parseTextRef(ref).recordId)], errors: [] })[0], ref)
  return { members, read, asked, resolve }
}
const openAt = (home, id, errors) => openProjection({ home, fs, key: id, errors })
async function build(home, id, errors, budget = null) {
  const s = await indexed(home, id), store = openAt(home, id, errors)
  let now = 0
  const r = extractMembers({ store, members: s.members, recordsAt: s.read, sessionId: id, ...(budget == null ? {} : { budgetMs: budget, clock: () => now++ }) })
  return { ...s, store, r, doc: reduce(store, s.members, { resolve: s.resolve }) }
}
function everyListDefined(store, members, at) {
  for (const m of members) {
    const l = listOf(store, m.id)
    if (l) for (const bid of l.bids) assert.equal(store.hasDef(bid) && store.readDef(bid).bid, bid, `${at} ${m.id}`)
  }
}
const lastLineCut = (file) => {
  const b = fs.readFileSync(file), start = b.lastIndexOf(10, b.length - 2) + 1
  fs.truncateSync(file, start + Math.ceil((b.length - start) / 2))
}
const BETWEEN = {
  grown: () => {},
  torn: lastLineCut,
  deleted: (file) => fs.rmSync(file),
  corrupt: (file) => { const l = fs.readFileSync(file, 'utf8').split('\n'); l[Math.floor(l.length / 2)] = '{"c":{"rid":'; fs.writeFileSync(file, l.join('\n')) },
  version: (file) => { const l = fs.readFileSync(file, 'utf8').split('\n'); l[0] = JSON.stringify({ v: PROJ_V + 1 }); fs.writeFileSync(file, l.join('\n')) },
}
const NOTES = { corrupt: 1, version: 1 }

test('3.5 #15: a projection built in any arrival order reduces to the fresh extraction\'s document, byte for byte', async (t) => {
  for (const wire of ['http', 'threads', 'ws', 'chat']) for (const arrival of ARRIVALS) {
    const tag = `${wire} late=${arrival.late} subLanes=${arrival.subLanes}`
    await t.test(tag, async () => {
      let fresh = null
      const want = async (raw, id) => {
        if (fresh) return fresh
        const home = rawHome('trocar-proj15-')
        fs.copyFileSync(raw, path.join(home, 'raw', path.basename(raw)))
        fresh = docBytes((await build(home, id, [])).doc)
        return fresh
      }
      const cases = { ...Object.fromEntries(Object.keys(BETWEEN).map((k) => [k, 'between'])), restart: 'restart' }
      for (const [name, how] of Object.entries(cases)) {
        const home = rawHome('trocar-proj15-'), s = sessionOf(home, wire, arrival), errors = []
        s.append(FIRST)
        const file = projectionFile(home, s.id)
        if (how === 'restart') {
          s.append(MORE)
          const cut = await build(home, s.id, errors, 4)
          assert.ok(cut.r.done > 0 && cut.r.done < cut.r.total, `${tag} ${name}: the budget stopped the build midway`)
        } else {
          await build(home, s.id, errors)
          BETWEEN[name](file)
          s.append(MORE)
        }
        const got = await build(home, s.id, errors)
        assert.equal(got.r.done, got.r.total, `${tag} ${name}`)
        assert.equal(docBytes(got.doc), await want(s.file, s.id), `${tag} ${name}`)
        const notes = errors.filter((e) => e.code === 'projection-rebuilt')
        assert.equal(notes.length, NOTES[name] || 0, `${tag} ${name}: projection-rebuilt notes`)
        everyListDefined(got.store, got.members, `${tag} ${name}`)
        // the reopened projection says the same, built or not
        const again = openAt(home, s.id, errors)
        assert.equal(docBytes(reduce(again, got.members, { resolve: got.resolve })), fresh, `${tag} ${name}: reopened`)
        everyListDefined(again, got.members, `${tag} ${name}: reopened`)
      }
    })
  }
})

test('3.5 #15: after a restart, extraction reads only the records the projection lacks; a reduce reads no record file', async () => {
  for (const wire of ['http', 'threads', 'ws', 'chat']) {
    const home = rawHome('trocar-proj15-'), s = sessionOf(home, wire, { late: 3, subLanes: 4 })
    s.append(FIRST + MORE)
    const cut = await build(home, s.id, [], 4)
    assert.ok(cut.r.done > 0 && cut.r.done < cut.r.total, `${wire}: the budget stopped the build midway`)
    const reopened = openAt(home, s.id, [])
    const lacking = cut.members.map((m) => String(m.id)).filter((rid) => !reopened.rows.has(rid))
    assert.ok(lacking.length < cut.members.length, `${wire}: the reopened projection kept the cut build's rows`)
    const go = await indexed(home, s.id)
    extractMembers({ store: reopened, members: go.members, recordsAt: go.read, sessionId: s.id })
    assert.deepEqual(go.asked.slice().sort(posCmp), lacking.slice().sort(posCmp), `${wire}: only the members not yet projected are read`)
    const doc = docBytes(reduce(reopened, go.members, { resolve: go.resolve })) // the break details it needed are now in the projection
    // a store opened afresh, its resolver over an fs that notes every record file opened
    const opened = []
    const rawDir = path.join(home, 'raw')
    const spy = new Proxy({ ...fs }, {
      get: (o, k) => (typeof o[k] === 'function'
        ? (...a) => { if (typeof a[0] === 'string' && a[0].startsWith(rawDir) && /\.ndjson|\.sealed/.test(a[0])) opened.push(`${String(k)} ${a[0]}`); return o[k](...a) }
        : o[k]),
    })
    const quiet = await indexed(home, s.id, spy)
    opened.length = 0 // the index read the segment; the reduction must not
    assert.equal(docBytes(reduce(openAt(home, s.id, []), quiet.members, { resolve: quiet.resolve })), doc, wire)
    assert.deepEqual(opened, [], `${wire}: the reduction opened no record file`)
  }
})
