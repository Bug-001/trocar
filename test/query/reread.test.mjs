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
import { dirUse, gcProjections } from '../../src/query/projection.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { runQuery } from '../../src/query/named/index.mjs' // first: the named queries' registry imports session.mjs
import { extendSession } from '../../src/query/named/session.mjs'
import { answer } from '../../src/query/answers.mjs'
import { saveTitles, titlesFile } from '../../src/query/titles.mjs'
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
// the old answer as a re-read keeps it: every pack and tail by its bytes, the head but for `pending`
const oldAnswer = (home, id) => ({ files: Object.fromEntries(Object.entries(filesOf(home, id)).filter(([n]) => !n.startsWith('head'))), head: { ...readHead(home, id), pending: null } })
const CONTRACT = JSON.parse(fs.readFileSync(new URL('../fixtures/session-read-contract.json', import.meta.url), 'utf8'))
const inWorker = (home, f = fs) => ({ home, fs: f, writer: true })
const toTheEnd = async (ctx, id) => { while (await extendSession(ctx, id, 1_000)); }

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
    const old = oldAnswer(home, id), { r, svc } = serviceOf(home)
    try {
      assert.ok((await ask(svc, 'session', { id })).pending, 'the first answer stops at the frontier')
      assert.ok(rereads(home, id), 'reread is there')
      let mid = 0
      await whileMoving(async () => {
        const now = oldAnswer(home, id), a = await ask(svc, 'session', { id }) // pending short of the end after the read: the fold was not at its end at it. The read comes first: a fold log's re-read is short
        if (a.pending?.done < a.pending?.total) { mid++; assert.deepEqual(now, old, 'the packs and tails are the old ones, and the head but for pending') } // the answer files change once it is at its end
        await ask(svc, 'session', { id, head: '' }) // the document of `--head` is an answer too: it writes nothing
        return !rereads(home, id)
      }, () => r.n, 'the re-read ended')
      assert.ok(mid > 0, 'sampled before the end')
      assert.deepEqual(readHead(home, id), freshHead, 'the head is a fresh fold\'s, at the last member')
      assert.deepEqual(filesOf(home, id), fresh, 'and so is every pack and tail')
    } finally { svc.stop() }
  })
}

for (const axis of ['PROJ_V changed', 'FOLD_V changed']) {
  test(`${axis}, no new member: from the first slice the head is the one the daemon follows, the old one but for a pending whose read only grows (#43)`, async () => {
    const home = homeOf(), { id } = sessionIn(home, 1, 600), ctx = inWorker(home)
    await foldAll(home, [id])
    lastVersion(home, id)
    AXES[axis](home, id)
    const old = oldAnswer(home, id), total = sessionGroups(await indexRows({ home })).get(id).length
    let read = 0, n = 0
    for (;;) {
      await extendSession(ctx, id, 5)
      const a = await runQuery('session', { id }, ctx)
      if (!(a.pending?.done < total)) break // at its end the answer files change
      const { pending } = readHead(home, id)
      assert.ok(fs.existsSync(headFile(home, id, true)) && !fs.existsSync(headFile(home, id)))
      assert.deepEqual({ ...pending, read: 0 }, { done: total, total, seen: true, calls: 0, read: 0 })
      assert.ok(pending.read >= read, 'read never falls')
      assert.deepEqual(oldAnswer(home, id), old)
      read = pending.read; n++
    }
    assert.ok(n > 0, 'seen before the end')
    await toTheEnd(ctx, id)
    assert.equal(rereads(home, id), false)
    assert.equal(readHead(home, id).pending, null)
  })
}

test('with no new member `read` follows the frontier in steps of a pack: one head at the first slice, one past each multiple, none between (#43)', async () => {
  const home = homeOf(), { id } = sessionIn(home), ctx = inWorker(home), spans = (n) => Math.floor(n / PACK_MEMBERS)
  await foldAll(home, [id])
  AXES['PROJ_V changed'](home, id)
  const reads = []
  for (;;) { // background slices alone: a request's slice would jump the frontier past what the head says
    await extendSession(ctx, id, 1)
    if (!rereads(home, id)) break
    const { read } = readHead(home, id).pending
    if (read !== reads.at(-1)) reads.push(read)
  }
  assert.ok(reads.at(-1) >= PACK_MEMBERS, `read passed a multiple of a pack: ${reads}`)
  reads.slice(1).forEach((r, i) => assert.ok(spans(r) > spans(reads[i]), `each new read is in a later span: ${reads}`))
})

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
    await whileMoving(() => { d = readHead(home, id); return d?.pending?.total > total || !rereads(home, id) }, () => r.n, 'the head says the new members')
    assert.ok(d.pending.read > past, 'read is the frontier')
    assert.deepEqual({ ...d.pending, read: 0 }, { done: total, total: total + 3, seen: true, calls: 3, read: 0 })
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
  const old = oldAnswer(home, id), { t } = dirUse(sessionDir(home, id)), a = serviceOf(home)
  try {
    await ask(a.svc, 'session', { id })
    a.r.kids[0].kill('SIGKILL')
    await whileMoving(() => gone(a.r.kids[0]), () => a.r.n, 'the worker died')
  } finally { a.svc.stop() }
  assert.ok(rereads(home, id), 'reread is on disk')
  assert.deepEqual(oldAnswer(home, id), old, 'the old answer stands')
  const b = serviceOf(home)
  try {
    b.svc.sweep()
    await whileMoving(() => { const on = rereads(home, id); if (on) assert.equal(Number(fs.readFileSync(rereadFile(home, id), 'utf8')), t, 'the marker keeps its t'); return !on }, () => b.r.n, 'the next worker finished it')
    assert.deepEqual(filesOf(home, id), fresh)
    assert.ok(Math.abs(fs.statSync(headFile(home, id)).mtimeMs - (t + 1)) < 1, 'the first worker\'s t is the one that ends it')
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

// A member that is no model call, as a session's own telemetry is captured.
const telemetry = (s, n) => {
  const last = JSON.parse(fs.readFileSync(s.file, 'utf8').trim().split('\n').at(-1))
  for (let i = 0; i < n; i++) fs.appendFileSync(s.file, `${JSON.stringify({ ...last, id: `telemetry_${i}`, endpoint: '/api/event_logging/batch', is_llm_call: false, traffic_class: 'telemetry' })}\n`)
}

test('calls counts no telemetry row, and starts where the tails reach, past the head\'s mark (#43)', async () => {
  const home = homeOf(), s = sessionIn(home, 1, 300), { id } = s, ctx = inWorker(home), behind = 10
  await foldAll(home, [id])
  const rows = sessionGroups(await indexRows({ home })).get(id), total = rows.length
  fs.writeFileSync(headFile(home, id), gzipSync(Buffer.from(JSON.stringify({ ...readHead(home, id), mark: String(rows.at(-1 - behind).id) }), 'utf8'))) // the tail ran past the head
  AXES['PROJ_V changed'](home, id)
  telemetry(s, 5)
  await extendSession(ctx, id, 1)
  const { pending } = readHead(home, id)
  assert.deepEqual({ ...pending, read: 0 }, { done: total - behind, total: total + 5, seen: true, calls: 0, read: 0 })
  assert.equal((await runQuery('session', { id }, ctx)).pending.calls, 0)
  s.append(2)
  assert.equal((await runQuery('session', { id }, ctx)).pending.calls, 2)
  await extendSession(ctx, id, 1)
  assert.equal(readHead(home, id).pending.calls, 2, 'calls left 0: the head says it at once')
  await toTheEnd(ctx, id)
  assert.equal(readHead(home, id).pending, null)
  assert.equal(rereads(home, id), false)
})

test('calls of a session past its first read start where the writer\'s tails reach, round after round, the head\'s mark behind them, and count no telemetry row (#43)', async () => {
  const home = homeOf(), s = sessionIn(home, 1, 30), { id } = s, ctx = inWorker(home)
  await foldAll(home, [id])
  await toTheEnd(ctx, id)
  for (const k of [40, 60, 50]) {
    telemetry(s, 3)
    s.append(k)
    assert.equal(await extendSession(ctx, id, 0), true, 'the slice leaves members past the frontier')
    assert.equal(readHead(home, id).pending.calls, k, 'the calls of this round alone')
    await toTheEnd(ctx, id) // the tails reach them; a mark that moved alone leaves the head where it was
  }
})

test('a lane answers with pending during a re-read, at the frontier, in the contract\'s closed set, and with none after it, at an unchanged version too (#43)', async () => {
  const home = homeOf(), { id } = sessionIn(home, 1, 120)
  await foldAll(home, [id])
  lastVersion(home, id)
  AXES['PROJ_V changed'](home, id)
  const lane = readHead(home, id).axis, was = readHead(home, id), set = (d) => Object.keys(d).sort()
  let refuse = true
  const f = Object.assign(Object.create(fs), { renameSync: (a, b) => { if (refuse && b === headFile(home, id)) throw Object.assign(new Error('injected: no room'), { code: 'ENOSPC' }); return fs.renameSync(a, b) } })
  const ctx = inWorker(home, f), ask = async (key = lane) => JSON.parse((await answer({ name: 'lane', params: { id, lane: key } }, ctx)).bytes)
  assert.equal(await extendSession(ctx, id, 0), true, 'the slice leaves members past the frontier: the head says pending')
  const first = await ask()
  assert.deepEqual(set(first), set(CONTRACT.lane_ops))
  assert.deepEqual(set(first.pending), set(CONTRACT.lane_ops.pending))
  assert.deepEqual(set((await ask('no-such-lane')).pending), set(CONTRACT.lane_ops.pending), 'an empty lane says it too')
  await toTheEnd(ctx, id) // to the last member and the files: the head alone is refused, so the re-read is not over
  assert.ok(rereads(home, id))
  assert.ok(fs.existsSync(headFile(home, id, true)), 'the head that failed left the one there was')
  assert.equal(readHead(home, id).pending.seen, true)
  assert.deepEqual({ ...readHead(home, id), pending: null }, { ...was, pending: null })
  const end = await ask()
  assert.equal(end.pending.done, end.pending.total, 'nothing above the mark, and pending all the same')
  refuse = false
  await toTheEnd(ctx, id)
  assert.equal(rereads(home, id), false)
  const after = await ask(), { pending, ...plain } = CONTRACT.lane_ops
  assert.deepEqual(set(after), set(plain))
  assert.equal('pending' in await ask('no-such-lane'), false)
  assert.equal(after.mark, end.mark, 'the same frontier')
})

test('after the switch a client that starts its ledger over on the tag change walks to the bytes of a one-shot fold (#43)', async () => {
  const home = homeOf(), id = 'big-0000-4a1b-9c2d-000000000001', s = bigSession({ home, id, segment: '20261020T164731Z', growth: 120, compactAt: 6_000, paths: 8, reads: 6 }), ctx = inWorker(home)
  s.append(600)
  await foldAll(home, [id])
  const was = readHead(home, id)
  fs.writeFileSync(headFile(home, id), gzipSync(Buffer.from(JSON.stringify({ ...was, packs: was.packs.map((p) => ({ ...p, tag: 'last' })) }), 'utf8')))
  AXES['PROJ_V changed'](home, id)
  const walk = async (c) => {
    const all = { resources: [], seen: [] }
    for (let ledger, p; ledger !== null; ledger = p.ledger_next) {
      p = await runQuery('lane', { id, lane: was.axis, ...(ledger ? { ledger } : null) }, c)
      all.resources.push(...p.resources); all.seen.push(...p.seen)
      assert.ok(p.pending || c !== ctx || !rereads(home, id), 'a ledger page says pending too')
    }
    return all
  }
  const during = await walk(ctx)
  await toTheEnd(ctx, id)
  assert.notDeepEqual(readHead(home, id).packs.map((p) => p.tag), was.packs.map(() => 'last'), 'the tags changed')
  const after = await walk(ctx), other = homeOf()
  fs.cpSync(path.join(home, 'raw'), path.join(other, 'raw'), { recursive: true })
  const once = await walk({ home: other })
  assert.ok(during.seen.length < once.seen.length, 'the walk during the re-read stopped at the frontier')
  assert.ok(once.resources.length && once.seen.length)
  assert.equal(JSON.stringify(after), JSON.stringify(once))
})

test('three sessions re-read in another order keep the order of 4.3 §4 回收, past the idle save (#43)', async () => {
  const home = homeOf(), [newest, middle, oldest] = [1, 2, 3].map((n) => sessionIn(home, n, 120).id), ids = [newest, middle, oldest]
  await foldAll(home, ids)
  for (const id of ids) AXES['PROJ_V changed'](home, id)
  aged(home, newest, 60); aged(home, middle, 600); aged(home, oldest, 3600)
  const before = ids.map((id) => dirUse(sessionDir(home, id)).t), { r, svc } = serviceOf(home)
  try {
    for (const id of [oldest, newest, middle]) {
      await ask(svc, 'session', { id })
      await whileMoving(() => !staleNow(home, id) && !rereads(home, id) && isDone(home, id), () => r.n, 'it ended')
    }
    await quiet(r)
  } finally { svc.stop() }
  await whileMoving(() => r.kids.every(gone), () => r.n, 'the worker left')
  const after = ids.map((id) => dirUse(sessionDir(home, id)))
  after.forEach((u, i) => assert.ok(Math.abs(u.t - (before[i] + 1)) < 1, 'its newest mtime is t + 1 ms'))
  const { deleted } = gcProjections({ home, liveKeys: ids, capBytes: after.reduce((a, u) => a + u.size, 0) - 1 })
  assert.deepEqual(deleted, [sessionDir(home, oldest)])
})

test('4.4 §人类标题的来源: an unread title alone changes no head: the bytes on disk stay through a slice, and the answer says it', async () => {
  const home = homeOf(), { id } = sessionIn(home, 1, 30), file = headFile(home, id)
  await foldAll(home, [id])
  const bytes = fs.readFileSync(file), said = readHead(home, id).meta
  assert.equal(said.title_source, 'wire')
  fs.rmSync(titlesFile(home), { force: true })
  const raw = path.join(home, 'raw'), f = Object.assign(Object.create(fs), { broken: false, openSync: (p, ...a) => { if (f.broken && String(p).startsWith(raw)) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); return fs.openSync(p, ...a) } }), ctx = inWorker(home, f)
  await runQuery('segments', {}, { home, fs: f })
  f.broken = true
  await extendSession(ctx, id, 1_000)
  assert.deepEqual(fs.readFileSync(file), bytes)
  const doc = await runQuery('session', { id }, ctx)
  assert.deepEqual([doc.meta.title, doc.meta.title_source], [null, 'unread'])
  assert.ok(doc.errors.some((e) => e.code === 'record-unreadable'))
  assert.deepEqual(fs.readFileSync(file), bytes)
})

test('4.4 §人类标题的来源: past a head this worker wrote, a mark that moved and an unread title write no head', async () => {
  const home = homeOf(), s = sessionIn(home, 1, 30), { id } = s, file = headFile(home, id), raws = new Set()
  const f = Object.assign(Object.create(fs), {
    below: 0, // the raw bytes under this offset read as lost
    openSync: (p, ...a) => { const fd = fs.openSync(p, ...a); if (String(p).startsWith(path.join(home, 'raw'))) raws.add(fd); return fd },
    readSync: (fd, b, o, n, at, ...a) => { if (raws.has(fd) && at < f.below) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); return fs.readSync(fd, b, o, n, at, ...a) },
  }), ctx = inWorker(home, f)
  await foldAll(home, [id])
  await toTheEnd(ctx, id)
  await saveTitles({ home, fs: f })
  fs.rmSync(titlesFile(home))
  const bytes = fs.readFileSync(file), { mark } = readHead(home, id)
  s.append(2)
  await runQuery('segments', {}, { home, fs: f })
  f.below = fs.readFileSync(s.file, 'utf8').indexOf('\n') // the first call alone: the new members fold whole, the title is what is lost
  await toTheEnd(ctx, id)
  const doc = await runQuery('session', { id }, ctx)
  assert.notEqual(doc.mark, mark, 'the mark moved')
  assert.deepEqual([doc.meta.title, doc.meta.title_source], [null, 'unread'])
  assert.deepEqual(fs.readFileSync(file), bytes)
})

test('4.4 §人类标题的来源: a head at one mark takes a title the table has since: the next slice writes it', async () => {
  const home = homeOf(), { id } = sessionIn(home, 1, 3), ctx = inWorker(home)
  await toTheEnd(ctx, id)
  const { mark } = readHead(home, id)
  await saveTitles({ home, fs })
  const table = JSON.parse(fs.readFileSync(titlesFile(home), 'utf8'))
  table.titles[id].t = 'a title found since'
  fs.writeFileSync(titlesFile(home), JSON.stringify(table))
  await extendSession(ctx, id, 1_000)
  const { meta, mark: now } = readHead(home, id)
  assert.equal(now, mark)
  assert.deepEqual([meta.title, meta.title_source], ['a title found since', 'wire'])
})

test('a marker with no t leaves the mtimes as they are (#43)', async () => {
  const home = homeOf(), { id } = sessionIn(home, 1, 600), ctx = inWorker(home), pack = path.join(sessionDir(home, id), 'p0.main.ndjson.gz')
  await foldAll(home, [id])
  AXES['PROJ_V changed'](home, id)
  fs.writeFileSync(rereadFile(home, id), '')
  const { mtimeMs } = fs.statSync(pack)
  await toTheEnd(ctx, id)
  assert.equal(rereads(home, id), false)
  assert.equal(fs.statSync(pack).mtimeMs, mtimeMs)
})

test('a head of the old size written after a re-read has another `<size>-<mtimeMs>`, the head having been the newest file (#43, 4.4 §答案文件)', async () => {
  const home = homeOf(), { id } = sessionIn(home, 1, 120), ctx = inWorker(home), file = headFile(home, id)
  await foldAll(home, [id])
  AXES['PROJ_V changed'](home, id)
  const soon = Date.now() / 1000 + 5
  fs.utimesSync(file, soon, soon)
  const tagOf = () => { const st = fs.statSync(headFile(home, id)); return `${st.size}-${st.mtimeMs}` }, old = tagOf(), { size } = fs.statSync(file)
  await toTheEnd(ctx, id)
  assert.equal(fs.statSync(file).size, size)
  assert.notEqual(tagOf(), old)
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
