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
import { saveIndexes, extendSession, sessionState } from '../../src/query/named/session.mjs'
import { dumpColumns, loadColumns } from '../../src/query/session-doc.mjs'
import { openProjection, projectionFile, gcProjections, sessionDir } from '../../src/query/projection.mjs'
import { openFoldLog, foldLogFile } from '../../src/query/fold-log.mjs'
import { loadSidecar, saveSidecar, FIRST_CHUNK, lineFile } from '../../src/query/line-file.mjs'

const SEG = '20261020T164737Z'
const FIRST = 8, MORE = 6
const WIRES = ['http', 'threads', 'ws', 'chat']
const ARRIVALS = [{ late: 0, subLanes: 1 }, { late: 3, subLanes: 1 }, { late: 0, subLanes: 4 }, { late: 3, subLanes: 4 }]
const homeOf = (p) => path.join(tmpDir(p), '.trocar')
const ctxDir = (home) => path.join(home, 'index', 'ctx')
const sidecars = (home) => { try { return fs.readdirSync(ctxDir(home), { recursive: true }).filter((n) => n.endsWith('.idx')) } catch (e) { if (e.code === 'ENOENT') return []; throw e } }
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
  assert.deepEqual(sidecars(home).sort(), ['extract.idx', 'fold.idx'].map((n) => path.relative(ctxDir(home), path.join(sessionDir(home, s.id), n))),
    'the worker wrote both sidecars')
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
// What a cold open reads of the projection and the fold log (4.3 §4: the header line, then only the lines past what the sidecar
// covers), against that bound: the header line in the scan's first read (FIRST_CHUNK), the newline that ends what a sidecar covers,
// and the lines of the breaks (`b`) a projection's sidecar names by offset, each with the line ends around it (4.3 §4 分片: a line
// read by its index is a whole line of the file)
function openRead(home, id) {
  const fds = new Set(), files = [projectionFile(home, id), foldLogFile(home, id)]
  let read = 0
  const own = { ...fs,
    openSync(p, ...a) { const fd = fs.openSync(p, ...a); if (files.includes(String(p))) fds.add(fd); else fds.delete(fd); return fd },
    closeSync(fd) { fds.delete(fd); return fs.closeSync(fd) },
    readSync(fd, ...a) { const n = fs.readSync(fd, ...a); if (fds.has(fd)) read += n; return n },
    readFileSync(p, ...a) { const b = fs.readFileSync(p, ...a); if (files.includes(String(p))) read += b.length; return b },
  }
  const p = openProjection({ home, fs: own, key: id, write: false, errors: [] })
  const log = openFoldLog({ home, fs: own, key: id, write: false, projection: { id: p.id, bytes: p.bytes }, errors: [] })
  p.close(); log.close()
  const bound = files.reduce((a, f) => {
    const b = fs.readFileSync(f), sc = loadSidecar({ fs, file: f })
    return a + b.length - sc.head.bytes + Math.max(FIRST_CHUNK, b.indexOf(10) + 1) + 1 + (sc.parts['b.l'] || []).reduce((x, y) => x + y + 2, 0)
  }, 0)
  return { read, bound }
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
    const { read, bound } = openRead(copy(home), id)
    assert.ok(read <= bound, `${tag}: a cold open read ${read} bytes of the projection and the fold log, past the header and what the sidecars cover ${bound}`)
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
    const pb = sideHead(path.join(sessionDir(home, id), 'fold.idx')).pb
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
  const files = (key) => ['extract.0.ndjson', 'extract.idx', 'fold.0.ndjson', 'fold.idx'].map((n) => path.join(sessionDir(home, key), n))
  for (const [i, key] of keys.entries()) for (const f of files(key)) { assert.ok(fs.existsSync(f), f); fs.utimesSync(f, 1_000 + i, 1_000 + i) }
  const all = keys.flatMap(files).reduce((a, f) => a + fs.statSync(f).size, 0)
  // a cap one byte under the total: met only when the sidecars are counted, by deleting the least recently opened pair whole
  const { deleted } = gcProjections({ home, fs, liveKeys: keys, capBytes: all - 1 })
  assert.deepEqual(deleted, [sessionDir(home, 'old')])
  assert.ok(files('new').every((f) => fs.existsSync(f)) && files('old').every((f) => !fs.existsSync(f)), 'on disk')
  assert.deepEqual(gcProjections({ home, fs, liveKeys: [] }).deleted, [sessionDir(home, 'new')], 'a session gone takes its sidecars')
  assert.ok(files('new').every((f) => !fs.existsSync(f)))
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

// A member that is no call, written after the calls: a request of no LLM on the session's own headers (the last call's).
function nonCall(file, n) {
  const last = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l)).reverse().find((r) => r.req_headers)
  if (!last) return false
  const ts = new Date(Date.parse(last.ts_request) + 1_000).toISOString()
  fs.appendFileSync(file, JSON.stringify({ ...last, ts, ts_request: ts, ts_response_start: ts, ts_response_end: ts, id: `noncall-${n}`, endpoint: `/api/other/${n}`,
    method: 'GET', req_body: '', resp: { status: 200, kind: 'json', body: { ok: true } }, is_llm_call: false, traffic_class: 'other' }) + '\n')
  return true
}
// The line of the first call of a lane other than the main one that has two calls or more, taken out of the file (its rid is
// `<segment>:<line>`): written back later, it sorts before that lane's first row, so the lane's key moves.
async function holdFirst(home, file, id) {
  const { doc } = await answers(copy(home), id)
  const lane = doc.lanes.find((l) => l.kind !== 'main' && doc.calls.filter((c) => c.lane === l.lane).length > 1)
  const lines = fs.readFileSync(file, 'utf8').split('\n'), at = Number(lane.lane.split(':').pop()) - 1, held = lines[at]
  lines.splice(at, 1)
  fs.writeFileSync(file, lines.join('\n'))
  return held
}
// What a reader asks of a cold open: the session whole, its newest page, the change since a mark kept from before, each lane's tail
// and its page ending before its second step (the compaction and summarize events of the steps after it ride along).
async function reads(home, id, kept) {
  const doc = await settled(home, id), out = [doc]
  for (const p of [{ limit: 2 }, { since: kept }]) out.push(await q('session', home, { id, ...p }, { writer: true }))
  for (const l of doc.lanes) {
    const second = doc.calls.filter((c) => c.lane === l.lane)[1]
    for (const p of [{}, ...(second ? [{ to: second.rid }] : [])]) out.push(await q('lane', home, { id, lane: l.lane, ...p }, { writer: true }))
  }
  return out
}

test('4.3 §4 旁索引: a cold open seeded from the step-order columns in the fold log\'s sidecar answers session and lane as one without, with lines past them', { timeout: 600_000 }, async () => {
  let nonCalls = 0
  for (const wire of WIRES) {
    const home = homeOf('trocar-side-cols-'), s = bigSession({ home, wire, growth: 200, subEvery: 3, compactAt: 1_500, segment: SEG, late: 3, subLanes: 4 })
    s.append(3 * FIRST) // enough for a subagent lane of two calls
    const held = await holdFirst(home, s.file, s.id)
    const before = await settled(home, s.id)
    saveIndexes()
    // past the saved columns: late rows that sort before the tip, a lane whose first row comes back (its key moves), a member no call
    s.append(MORE)
    fs.appendFileSync(s.file, held + '\n')
    if (nonCall(s.file, 1)) nonCalls++
    const after = await settled(home, s.id)
    assert.ok(before.lanes.some((l) => after.lanes.every((m) => m.lane !== l.lane)), `${wire}: a lane key moved`)
    const a = await reads(copy(home), s.id, before.mark), b = await reads(copy(home, false), s.id, before.mark)
    assert.equal(JSON.stringify(a), JSON.stringify(b), wire)
  }
  assert.ok(nonCalls > 0, 'a member that is no call was written')
})

// 3.5:42 (a restarted worker carries on from the checkpoint): a resume cuts what lies past the lines it keeps, then appends. The
// sidecar covers [0, its bytes); a cut at or past them keeps that prefix byte for byte, so the next append keeps the sidecar; a cut
// below them drops bytes it covers, so the append removes it. Over every line end as the sidecar's bytes and every line end (with
// and without a torn tail) as the cut.
test('3.5:42: a cut that keeps what the sidecar covers keeps the sidecar through the next append; a cut below it removes it', () => {
  const lines = ['a\n', 'bé\n', 'ccc\n', '中中\n', 'e\n'], ends = lines.map((_, i) => Buffer.byteLength(lines.slice(0, i + 1).join('')))
  for (const covers of ends) for (const at of ends) for (const torn of [false, true]) {
    const dir = tmpDir('trocar-side-cut-'), base = path.join(dir, 'x')
    let lf = lineFile({ fs, base })
    for (const l of lines) lf.append(l)
    if (torn) lf.append('half')
    lf.saveSidecar({ head: { bytes: covers }, parts: [['k', ['s']]] })
    lf.close()
    lf = lineFile({ fs, base })
    assert.equal(lf.loadSidecar()?.head.bytes, covers)
    lf.cut(at)
    lf.append('f\n')
    lf.close()
    const kept = loadSidecar({ fs, file: `${base}.ndjson`, endsLine: () => true })
    assert.equal(kept?.head.bytes, at >= covers ? covers : undefined, `sidecar at ${covers}, cut at ${at}${torn ? ' past a torn tail' : ''}`)
  }
})

test('4.3 §4 旁索引: a sidecar loads back every part it was saved with, str parts of any length and script included', () => {
  const dir = tmpDir('trocar-sidecar-'), file = path.join(dir, 'x.ndjson')
  fs.writeFileSync(file, 'a\n')
  for (const n of [0, 1, 4095, 4096, 4097, 9000]) {
    const strs = Array.from({ length: n }, (_, i) => (i % 7 === 3 ? '' : i % 5 === 0 ? `键${i}·é😀` : `k${i}`))
    const parts = [['s', strs], ['f', Float64Array.from({ length: n }, (_, i) => i / 3)], ['t', ['only']]]
    saveSidecar({ file, head: { bytes: 2 }, parts })
    const got = loadSidecar({ file })
    assert.ok(got, `n=${n}: loads`)
    assert.deepEqual(got.parts.s, strs, `n=${n}: the str part`)
    assert.deepEqual([...got.parts.f], [...parts[1][1]], `n=${n}: the f64 part`)
    assert.deepEqual(got.parts.t, ['only'])
  }
})

test('4.3 #55: analysis answers the same documents over the sidecar\'s columns and over columns synced from the fold log', async () => {
  const { home, id } = await written('http', ARRIVALS[3])
  saveIndexes()
  const file = path.join(tmpDir('trocar-side-p-'), 'pricing.json')
  fs.writeFileSync(file, JSON.stringify({ claude: [3, 15, 4, 0.5] }))
  const docs = async (h) => {
    const ctx = { env: { TROCAR_PRICING: file } }
    return { doc: await q('analysis', h, { id }, ctx), win: await q('analysis', h, { id, from: 'not-a-step' }, ctx) }
  }
  const kept = await docs(copy(home)), scanned = await docs(copy(home, false))
  assert.deepEqual(kept, scanned)
  const { counted, uncomputable } = kept.doc.totals.breakCost
  assert.ok(counted + uncomputable > 0, 'the session has breaks')
})

test('4.3 #55: s.rf reads back equal; one that is missing, of another type, short or past the rows loads no columns', async () => {
  const { home, id } = await written('http', ARRIVALS[0])
  const { cols } = (await sessionState({ home, fs, writer: true }, id)).V
  const parts = Object.fromEntries(dumpColumns(cols)), rf = parts['s.rf'], { rows } = cols
  assert.ok(rf.some((v) => v >= 0), 'a step names its comparison step')
  assert.deepEqual(loadColumns(rows, parts).rf, rf)
  const { 's.rf': _rf, ...missing } = parts, past = rf.slice()
  past[0] = rows.size
  for (const bad of [missing, { ...parts, 's.rf': Uint8Array.from(rf) }, { ...parts, 's.rf': rf.slice(1) }, { ...parts, 's.rf': past }]) assert.equal(loadColumns(rows, bad), null)
})
