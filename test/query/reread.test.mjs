// test/query/reread.test.mjs — a version change re-reads a session behind the answer it has (RFC 3.5 §访问模式「版本变更的重读」, #43 #44; 4.3 §4):
// the real service and the real worker fork over a temp HOME. The answer files are made recognisably the last version's before the
// re-read, so a file written early shows and the end state is the first fold's.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createQueryService } from '../../src/query/service.mjs'
import { projectionFile, projectionStale, sessionDir, PROJ_V } from '../../src/query/projection.mjs'
import { foldLogFile, foldStale, FOLD_V } from '../../src/query/fold-log.mjs'
import { lineFile } from '../../src/query/line-file.mjs'
import { headFile, readHead, rereadFile, PACK_MEMBERS } from '../../src/query/ctx-files.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import '../../src/query/named/index.mjs' // first: the named queries' registry imports session.mjs
import { extendSession } from '../../src/query/named/session.mjs'
import { workerFork, workerForkIn } from '../helpers/worker-fork.mjs'
import { within, whileMoving, reporting } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'

const SCAN_DEPS = fileURLToPath(new URL('./worker-scan-deps.mjs', import.meta.url))
const CALLS = 1300 // past two packs, far past a slice
const homeOf = () => { const home = path.join(tmpDir('trocar-reread-'), '.trocar'); fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 }); return home }
const sessionIn = (home, n = 1, calls = CALLS) => {
  const s = bigSession({ home, id: `big-0000-4a1b-9c2d-00000000000${n}`, segment: `20261020T16473${n}Z`, growth: 120, compactAt: 6_000 })
  s.append(calls)
  return s
}
const recorder = () => {
  const r = { status: null, chunks: [] }
  return Object.assign(r, { writeHead: (s) => { r.status = s }, write: (b) => { r.chunks.push(b); return true }, end: () => {}, once: () => {}, text: () => Buffer.concat(r.chunks).toString('utf8') })
}
const ask = async (svc, name, params) => {
  const res = recorder()
  await within(svc.relay({ name, params, res }), 60_000, `${name} answered`)
  assert.equal(res.status, 200, `${name} answers 200`)
  return JSON.parse(res.text())
}
const serviceOf = (home) => { const r = reporting(workerFork); return { r, svc: createQueryService({ home, fork: r.fork }) } }
const gone = (kid) => kid.exitCode !== null || kid.signalCode !== null
const isDone = (home, id) => { const h = readHead(home, id); return !!h && h.tier === 1 && h.pending === null }
const rereads = (home, id) => fs.existsSync(rereadFile(home, id))
const answerNames = (home, id) => fs.readdirSync(sessionDir(home, id)).filter((n) => /^(p\d+\.\w+\.ndjson\.gz|open\.\w+\.ndjson|head(\.pending)?\.json\.gz)$/.test(n)).sort()
// every answer file, by the sha1 of its bytes
const filesOf = (home, id) => Object.fromEntries(answerNames(home, id).map((n) => [n, createHash('sha1').update(fs.readFileSync(path.join(sessionDir(home, id), n))).digest('hex')]))
const packsOf = (home, id) => Object.fromEntries(Object.entries(filesOf(home, id)).filter(([n]) => n.startsWith('p')))

/** Folds these sessions to their end in one worker, which then leaves: the first read's files, on disk. */
async function foldAll(home, ids) {
  const { r, svc } = serviceOf(home)
  try {
    for (const id of ids) {
      await ask(svc, 'session', { id })
      await whileMoving(() => isDone(home, id), () => r.n, 'the first fold reached the end')
    }
  } finally { svc.stop() }
  await whileMoving(() => r.kids.every(gone), () => r.n, 'the worker left')
}
/** The answer files made the last version's: each still whole and of CTX_V, and none what a fold writes. */
function lastVersion(home, id) {
  for (const n of answerNames(home, id)) {
    const f = path.join(sessionDir(home, id), n)
    if (n.startsWith('p')) fs.writeFileSync(f, gzipSync(Buffer.concat([gunzipSync(fs.readFileSync(f)), Buffer.from('{"last":1}\n')])))
    else if (n.startsWith('open')) fs.appendFileSync(f, '{"last":1}\n')
  }
  fs.writeFileSync(headFile(home, id), gzipSync(Buffer.from(JSON.stringify({ ...readHead(home, id), last: 1 }), 'utf8')))
}
const wipe = (home, id, base) => { for (const n of fs.readdirSync(sessionDir(home, id))) if (n.startsWith(`${base}.`)) fs.rmSync(path.join(sessionDir(home, id), n)) }
const AXES = {
  'PROJ_V changed': (home, id) => { wipe(home, id, 'extract'); fs.writeFileSync(projectionFile(home, id), `${JSON.stringify({ v: PROJ_V + 1 })}\n`) },
  'FOLD_V changed': (home, id) => { wipe(home, id, 'fold'); fs.writeFileSync(foldLogFile(home, id), `${JSON.stringify({ v: FOLD_V + 1, pid: 'x' })}\n`) },
  'a projection broken in the middle': (home, id) => {
    const lines = fs.readFileSync(projectionFile(home, id), 'utf8').split('\n')
    lines[Math.floor(lines.length / 2)] = '{broken'
    wipe(home, id, 'extract')
    fs.writeFileSync(projectionFile(home, id), lines.join('\n'))
  },
}

for (const [axis, stale] of Object.entries(AXES)) {
  test(`${axis}: the old answer files stay until the fold is at its end, the session answers at the frontier, then the files are a fresh fold's and reread is gone (#43)`, async () => {
    const home = homeOf(), { id } = sessionIn(home)
    await foldAll(home, [id])
    const fresh = filesOf(home, id), freshHead = readHead(home, id)
    lastVersion(home, id)
    stale(home, id)
    const old = filesOf(home, id), { r, svc } = serviceOf(home)
    try {
      assert.ok((await ask(svc, 'session', { id })).pending, 'the first answer stops at the frontier')
      assert.ok(rereads(home, id), 'reread is there')
      let mid = 0
      await whileMoving(async () => {
        const now = filesOf(home, id), a = await ask(svc, 'session', { id }) // pending after the read: the fold was not at its end at it. The read comes first: a fold log's re-read is short
        if (a.pending) { mid++; assert.deepEqual(now, old, 'the files are the old ones, with no new member the head too') }
        await ask(svc, 'session', { id, head: '' }) // the document of `--head` is an answer too: it writes nothing
        return !rereads(home, id)
      }, () => r.n, 'the re-read ended')
      assert.ok(mid > 0, 'sampled before the end')
      assert.deepEqual(readHead(home, id), freshHead, 'the head is a fresh fold\'s, at the last member')
      assert.deepEqual(filesOf(home, id), fresh, 'and so is every pack and tail')
    } finally { svc.stop() }
  })
}

test('a new member past the last multiple of a pack: the head says done at the old mark, total, seen at once, the rest of it as it was (#43)', async () => {
  const home = homeOf(), s = sessionIn(home), { id } = s
  s.append(200) // a wide last span: the frontier is in it when the member comes
  await foldAll(home, [id])
  lastVersion(home, id)
  const was = readHead(home, id), packs = packsOf(home, id)
  AXES['PROJ_V changed'](home, id)
  const { r, svc } = serviceOf(home)
  try {
    const { total } = (await ask(svc, 'session', { id })).pending, past = Math.floor(total / PACK_MEMBERS) * PACK_MEMBERS
    assert.ok(total - past > 300, 'the last span is wide')
    await whileMoving(async () => (await ask(svc, 'session', { id })).pending.done > past, () => r.n, 'the frontier passed the last multiple')
    s.append(3)
    await ask(svc, 'session', { id })
    let d
    await whileMoving(() => { d = readHead(home, id); return d?.pending != null || !rereads(home, id) }, () => r.n, 'the head says the new members')
    assert.deepEqual(d.pending, { done: total, total: total + 3, seen: true })
    assert.deepEqual({ ...d, pending: null }, was, 'nothing else of the head moved')
    assert.deepEqual(packsOf(home, id), packs, 'nor any pack')
    await whileMoving(() => isDone(home, id) && !rereads(home, id), () => r.n, 'the re-read ended')
    assert.notEqual(readHead(home, id).mark, was.mark, 'at the new members')
  } finally { svc.stop() }
})

test('a worker killed in the re-read: reread stays, and the next worker folds it to its end with nobody asking (#43)', async () => {
  const home = homeOf(), { id } = sessionIn(home)
  await foldAll(home, [id])
  const fresh = filesOf(home, id)
  lastVersion(home, id)
  AXES['PROJ_V changed'](home, id)
  const old = filesOf(home, id), a = serviceOf(home)
  try {
    await ask(a.svc, 'session', { id })
    a.r.kids[0].kill('SIGKILL')
    await whileMoving(() => gone(a.r.kids[0]), () => a.r.n, 'the worker died')
  } finally { a.svc.stop() }
  assert.ok(rereads(home, id), 'reread is on disk')
  assert.deepEqual(filesOf(home, id), old, 'the old answer stands')
  const b = serviceOf(home)
  try {
    b.svc.sweep()
    await whileMoving(() => !rereads(home, id), () => b.r.n, 'the next worker finished it')
    assert.deepEqual(filesOf(home, id), fresh)
  } finally { b.svc.stop() }
})

test('a head of tier 0 leaves no marker: the session folds as a first read (#43)', async () => {
  const home = homeOf(), { id } = sessionIn(home)
  await foldAll(home, [id])
  fs.writeFileSync(headFile(home, id), gzipSync(Buffer.from(JSON.stringify({ ...readHead(home, id), tier: 0, mark: null }), 'utf8')))
  AXES['PROJ_V changed'](home, id)
  const { r, svc } = serviceOf(home)
  try {
    assert.ok((await ask(svc, 'session', { id })).pending)
    let folding = 0
    await whileMoving(() => {
      const h = readHead(home, id)
      assert.equal(rereads(home, id), false, 'no marker')
      if (h?.pending) { folding++; assert.equal(h.pending.seen, undefined, 'the board is told a first read') }
      return isDone(home, id)
    }, () => r.n, 'the session folded to its end')
    assert.ok(folding > 0, 'seen while it folded')
  } finally { svc.stop() }
})

const staleNow = (home, id) => { try { return JSON.parse(fs.readFileSync(projectionFile(home, id), 'utf8').split('\n')[0]).v !== PROJ_V } catch { return true } }
// the files of a session's directory `age` seconds old
const aged = (home, id, age) => { const t = Date.now() / 1000 - age; for (const n of fs.readdirSync(sessionDir(home, id))) fs.utimesSync(path.join(sessionDir(home, id), n), t, t) }

test('with no session opened the stale sessions are folded to their end, the newest directory first (#44)', async () => {
  const home = homeOf(), [newer, older] = [sessionIn(home, 1).id, sessionIn(home, 2).id] // the older directory has the newest rows
  await foldAll(home, [newer, older])
  for (const id of [newer, older]) AXES['PROJ_V changed'](home, id)
  aged(home, newer, 60); aged(home, older, 3600)
  const { r, svc } = serviceOf(home)
  try {
    svc.sweep()
    await whileMoving(() => {
      const oldOn = !staleNow(home, older)
      if (oldOn) assert.ok(!rereads(home, newer) && !staleNow(home, newer), 'the newer one ended before the older one began')
      return oldOn && !rereads(home, older) && isDone(home, older)
    }, () => r.n, 'both ended')
  } finally { svc.stop() }
})

test('a session asked for in the middle of the queue is folded next, ahead of the stale ones behind it (#44)', async () => {
  const home = homeOf(), [a, b, c] = [1, 2, 3].map((n) => sessionIn(home, n).id)
  await foldAll(home, [a, b, c])
  for (const id of [a, b, c]) AXES['PROJ_V changed'](home, id)
  aged(home, a, 60); aged(home, b, 600); aged(home, c, 3600)
  const { r, svc } = serviceOf(home)
  try {
    svc.sweep()
    await whileMoving(() => rereads(home, a), () => r.n, 'the queue began')
    await ask(svc, 'session', { id: c })
    await whileMoving(() => !staleNow(home, c) && !rereads(home, c) && isDone(home, c), () => r.n, 'the one asked for ended')
    assert.ok(staleNow(home, b), 'the one behind it is still stale')
  } finally { svc.stop() }
})

test('a followed session goes before the queue built while it was followed (#44)', async () => {
  const home = homeOf(), [older, newer] = [sessionIn(home, 1).id, sessionIn(home, 2).id], gate = path.join(home, 'scan') // the scan looks at the older one first, so it does not see the follow
  await foldAll(home, [newer, older])
  for (const id of [newer, older]) AXES['PROJ_V changed'](home, id)
  aged(home, newer, 60); aged(home, older, 3600)
  const fork = workerForkIn({ TROCAR_TEST_SCAN_GATE: gate, TROCAR_TEST_SCAN_AT: path.basename(sessionDir(home, newer)) }), r = reporting((h) => fork(h, SCAN_DEPS)), svc = createQueryService({ home, fork: r.fork })
  try {
    svc.sweep()
    await whileMoving(() => fs.existsSync(`${gate}.held`), () => r.n, 'the scan began')
    r.kids[0].send({ follow: older })
    fs.writeFileSync(gate, '')
    await whileMoving(() => {
      if (!staleNow(home, newer)) assert.ok(!rereads(home, older) && !staleNow(home, older), 'the followed one ended before the queue began')
      return !staleNow(home, newer) && !rereads(home, newer) && isDone(home, newer)
    }, () => r.n, 'both ended')
  } finally { svc.stop() }
})

test('an answer that cannot be written ends that session\'s turn: reread stays, the queue goes on, and the next request finishes it (#43)', async () => {
  const home = homeOf(), [broken, next] = [sessionIn(home, 1).id, sessionIn(home, 2).id]
  await foldAll(home, [broken, next])
  const freshHead = readHead(home, broken), tail = path.join(sessionDir(home, broken), 'open.main.ndjson')
  for (const id of [broken, next]) AXES['PROJ_V changed'](home, id)
  aged(home, broken, 60); aged(home, next, 3600)
  fs.rmSync(tail)
  fs.mkdirSync(path.join(tail, 'in-the-way'), { recursive: true })
  // what the two folds have written: the worker's reports would go on through a loop on the failed write, this stops
  const folded = () => [broken, next].flatMap((id) => { const d = sessionDir(home, id); return fs.readdirSync(d).filter((n) => /^(extract|fold)\./.test(n)).map((n) => fs.statSync(path.join(d, n)).size) }).reduce((a, b) => a + b, 0)
  const { r, svc } = serviceOf(home)
  try {
    svc.sweep()
    await whileMoving(() => !staleNow(home, next) && !rereads(home, next) && isDone(home, next), folded, 'the session behind it ended')
    assert.ok(rereads(home, broken), 'reread stays')
    fs.rmSync(tail, { recursive: true })
    await ask(svc, 'session', { id: broken })
    await whileMoving(() => !rereads(home, broken), () => r.n, 'the request finished it')
    assert.deepEqual(readHead(home, broken), freshHead)
  } finally { svc.stop() }
})

// A worker that spins on a failed write reports every 100 ms: a stretch with no report, past the idle save, says it is quiet. A worker starved for that
// long only lets a fault pass.
const QUIET_MS = 3_000
async function quiet(r) {
  await within((async () => { for (let n = -1; n !== r.n;) { n = r.n; await new Promise((d) => setTimeout(d, QUIET_MS)) } })(), 60_000, 'the worker went quiet')
}

test('an answer that cannot be written: the worker goes quiet with one record for the episode, the marker kept, and one request finishes it (#43)', async () => {
  const home = homeOf(), { id } = sessionIn(home)
  await foldAll(home, [id])
  const freshHead = readHead(home, id), tail = path.join(sessionDir(home, id), 'open.main.ndjson')
  AXES['PROJ_V changed'](home, id)
  fs.rmSync(tail)
  fs.mkdirSync(path.join(tail, 'in-the-way'), { recursive: true })
  const said = [], r = reporting(workerFork), svc = createQueryService({ home, fork: r.fork, failure: (w, e) => said.push(e.code) })
  try {
    svc.sweep()
    await whileMoving(() => said.length > 0, () => r.n, 'the write failed')
    await quiet(r)
    r.kids[0].send({ follow: id }) // tried again: the same episode
    await quiet(r)
    assert.deepEqual(said, ['projection-write-failed'])
    assert.ok(rereads(home, id), 'reread stays')
    fs.rmSync(tail, { recursive: true })
    await ask(svc, 'session', { id })
    await whileMoving(() => !rereads(home, id), () => r.n, 'the request finished it')
    assert.deepEqual(readHead(home, id), freshHead)
  } finally { svc.stop() }
})

test('a head that cannot be written ends the turn the same way: one record, the marker kept, the next try finishes it (#43)', async () => {
  const home = homeOf(), { id } = sessionIn(home, 1, 120)
  await foldAll(home, [id])
  const freshHead = readHead(home, id)
  lastVersion(home, id)
  AXES['PROJ_V changed'](home, id)
  const said = [], refusing = { ...fs, renameSync: (a, b) => { if (b === headFile(home, id)) throw Object.assign(new Error('injected: no room'), { code: 'ENOSPC' }); return fs.renameSync(a, b) } }
  const turn = async (f) => { while (await extendSession({ home, fs: f, writer: true, persist: (e) => said.push(e.code) }, id, 1_000)); }
  await turn(refusing)
  await turn(refusing)
  assert.deepEqual(said, ['projection-write-failed'])
  assert.ok(rereads(home, id), 'reread stays')
  await turn(fs)
  assert.equal(rereads(home, id), false)
  assert.deepEqual(readHead(home, id), freshHead)
})

test('a kill between the marker and the rebuild loses no re-read: reread is on disk first, and a worker ends it (#43)', async () => {
  const home = homeOf(), { id } = sessionIn(home)
  await foldAll(home, [id])
  const fresh = filesOf(home, id), freshHead = readHead(home, id)
  AXES['PROJ_V changed'](home, id)
  const fork = workerForkIn({ TROCAR_TEST_KILL_AT: 'extract.' }), k = reporting((h) => fork(h, SCAN_DEPS)), killed = createQueryService({ home, fork: k.fork })
  try {
    killed.sweep()
    await whileMoving(() => k.kids[0] && gone(k.kids[0]), () => k.n, 'the worker died at the rebuild')
  } finally { killed.stop() }
  assert.equal(k.kids[0].signalCode, 'SIGKILL')
  assert.ok(rereads(home, id), 'the marker came before the rebuild')
  const { r, svc } = serviceOf(home)
  try {
    svc.sweep()
    await whileMoving(() => !rereads(home, id) && !staleNow(home, id), () => r.n, 'a worker ended it')
    assert.deepEqual(readHead(home, id), freshHead)
    assert.equal(readHead(home, id).tier, 1)
    assert.deepEqual(filesOf(home, id), fresh)
  } finally { svc.stop() }
})

test('a kicked session reaches its frontier in the middle of a re-read, which then goes on (#44)', async () => {
  const home = homeOf(), { id } = sessionIn(home)
  await foldAll(home, [id])
  AXES['PROJ_V changed'](home, id)
  const { r, svc } = serviceOf(home)
  try {
    svc.sweep()
    await whileMoving(() => rereads(home, id), () => r.n, 'the re-read began')
    const live = sessionIn(home, 2, 30), rows = sessionGroups(await indexRows({ home })).get(live.id)
    svc.kick([String(rows.at(-1).id)])
    await whileMoving(() => isDone(home, live.id), () => r.n, 'the kicked session is at its frontier')
    assert.ok(rereads(home, id), 'with the re-read not over')
    await whileMoving(() => !rereads(home, id), () => r.n, 'the re-read went on')
  } finally { svc.stop() }
})

test('a session followed in the middle of another\'s background re-read ends first, and the one that gave way goes back to the head of the queue (#44)', async () => {
  const home = homeOf(), [first, second, followed] = [1, 2, 3].map((n) => sessionIn(home, n).id)
  await foldAll(home, [first, second, followed])
  for (const id of [first, second, followed]) AXES['PROJ_V changed'](home, id)
  aged(home, first, 60); aged(home, second, 600); aged(home, followed, 3600)
  const { r, svc } = serviceOf(home)
  try {
    svc.sweep()
    await whileMoving(() => rereads(home, first), () => r.n, 'the queue began')
    r.kids[0].send({ follow: followed })
    await whileMoving(() => !staleNow(home, followed) && !rereads(home, followed) && isDone(home, followed), () => r.n, 'the followed one ended')
    assert.ok(rereads(home, first), 'ahead of the one it stopped')
    await whileMoving(() => {
      if (!staleNow(home, second)) assert.ok(!rereads(home, first), 'that one ended before the rest of the queue began')
      return !rereads(home, first)
    }, () => r.n, 'that one went on')
  } finally { svc.stop() }
})

test('a re-read a request opened gives way to a kick, goes back among the followed, and ends ahead of the one it stopped and the queue (#44)', async () => {
  const home = homeOf(), [first, second, asked] = [1, 2, 3].map((n) => sessionIn(home, n).id)
  await foldAll(home, [first, second, asked])
  for (const id of [first, second, asked]) AXES['PROJ_V changed'](home, id)
  aged(home, first, 60); aged(home, second, 600); aged(home, asked, 3600)
  const { r, svc } = serviceOf(home)
  try {
    svc.sweep()
    await whileMoving(() => rereads(home, first), () => r.n, 'the queue began')
    await ask(svc, 'session', { id: asked })
    const live = sessionIn(home, 4, 30), rows = sessionGroups(await indexRows({ home })).get(live.id)
    svc.kick([String(rows.at(-1).id)])
    await whileMoving(() => isDone(home, live.id), () => r.n, 'the kicked session is at its frontier')
    assert.ok(rereads(home, asked), 'the one asked for gave way to it')
    await whileMoving(() => !staleNow(home, asked) && !rereads(home, asked) && isDone(home, asked), () => r.n, 'the one asked for ended')
    assert.ok(rereads(home, first), 'ahead of the one it stopped, which nobody opened')
    assert.ok(staleNow(home, second), 'and of the rest of the queue')
  } finally { svc.stop() }
})

/** The bytes of a session's projection and fold log, their sidecars left out: the idle save writes those for every session that grew. */
const foldedOf = (home, id) => {
  const d = sessionDir(home, id)
  return fs.readdirSync(d).filter((n) => /^(extract|fold)\./.test(n) && !n.endsWith('.idx')).reduce((sum, n) => { try { return sum + fs.statSync(path.join(d, n)).size } catch { return sum } }, 0)
}

test('two re-reads, both followed, never alternate: one folds in one run, the other stands still, then the other way round (#44)', async () => {
  const home = homeOf(), ids = [1, 2].map((n) => sessionIn(home, n).id)
  await foldAll(home, ids)
  for (const id of ids) AXES['PROJ_V changed'](home, id)
  aged(home, ids[0], 60); aged(home, ids[1], 3600)
  const { r, svc } = serviceOf(home)
  try {
    svc.sweep()
    await whileMoving(() => rereads(home, ids[0]), () => r.n, 'the queue began')
    for (const id of ids) r.kids[0].send({ follow: id })
    const runs = []
    let was = ids.map((id) => foldedOf(home, id))
    await whileMoving(() => {
      const now = ids.map((id) => foldedOf(home, id)), moved = ids.filter((id, i) => now[i] !== was[i])
      const ended = ids.every((id) => !staleNow(home, id) && !rereads(home, id)) // read after the sizes: what moved was still the re-reads unless both are over, and then the idle save may seal them
      was = now
      if (!ended && moved.length === 1 && runs.at(-1) !== moved[0]) runs.push(moved[0])
      return ended
    }, () => r.n, 'both ended')
    assert.deepEqual(runs, ids)
  } finally { svc.stop() }
})

for (const [name, stale, base, V] of [['projectionStale', projectionStale, 'extract', PROJ_V], ['foldStale', foldStale, 'fold', FOLD_V]]) {
  test(`${name} reads the first line alone: current, stale, absent, unreadable, sealed into parts`, () => {
    const home = homeOf(), key = 'k-0000', file = path.join(sessionDir(home, key), base), put = (first) => {
      fs.rmSync(sessionDir(home, key), { recursive: true, force: true })
      const lf = lineFile({ base: file })
      lf.append(`${first}\n{"c":1}\n`)
      return lf
    }
    assert.equal(stale({ home, key }), false, 'no file')
    put(JSON.stringify({ v: V, id: 'x' })).close()
    assert.equal(stale({ home, key }), false, 'current')
    put(JSON.stringify({ v: V + 1, id: 'x' })).close()
    assert.equal(stale({ home, key }), true, 'another version')
    put('{broken').close()
    assert.equal(stale({ home, key }), true, 'does not parse')
    for (const [v, want] of [[V, false], [V + 1, true]]) {
      const lf = put(JSON.stringify({ v, id: 'x' }))
      assert.ok(lf.seal({ partBytes: 1 }))
      lf.close()
      assert.ok(fs.readdirSync(sessionDir(home, key)).some((n) => n.endsWith('.br')), 'in a part')
      assert.equal(stale({ home, key }), want, 'sealed')
    }
  })
}
