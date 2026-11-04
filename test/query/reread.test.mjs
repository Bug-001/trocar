// test/query/reread.test.mjs — a version change re-reads a session behind the answer it has (RFC 3.5 §访问模式「版本变更的重读」, #43 #44; 4.3 §4):
// the real service and the real worker fork over a temp HOME. The answer files are made recognisably the last version's before the
// re-read, so a file written early shows and the end state is the first fold's.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createQueryService } from '../../src/query/service.mjs'
import { projectionFile, projectionStale, sessionDir, PROJ_V } from '../../src/query/projection.mjs'
import { foldLogFile, foldStale, FOLD_V } from '../../src/query/fold-log.mjs'
import { lineFile } from '../../src/query/line-file.mjs'
import { headFile, readHead, rereadFile } from '../../src/query/ctx-files.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { within, whileMoving, reporting } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'

const CALLS = 1300 // past two packs, far past a slice
const homeOf = () => { const home = path.join(tmpDir('trocar-reread-'), '.trocar'); fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 }); return home }
const sessionIn = (home, n = 1) => {
  const s = bigSession({ home, id: `big-0000-4a1b-9c2d-00000000000${n}`, segment: `20261020T16473${n}Z`, growth: 120, compactAt: 6_000 })
  s.append(CALLS)
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
        const now = filesOf(home, id), a = await ask(svc, 'session', { id }) // pending after the read: the fold was not at its end at it
        if (a.pending) { mid++; assert.deepEqual(now, old, 'the files are the old ones, with no new member the head too') }
        return !rereads(home, id)
      }, () => r.n, 'the re-read ended')
      assert.ok(mid > 0, 'sampled before the end')
      assert.deepEqual(readHead(home, id), freshHead, 'the head is a fresh fold\'s, at the last member')
      assert.deepEqual(filesOf(home, id), fresh, 'and so is every pack and tail')
    } finally { svc.stop() }
  })
}

test('a new member during the re-read: the head says done at the old mark, total, seen, the rest of it as it was (#43)', async () => {
  const home = homeOf(), s = sessionIn(home), { id } = s
  await foldAll(home, [id])
  lastVersion(home, id)
  const was = readHead(home, id), packs = packsOf(home, id)
  AXES['PROJ_V changed'](home, id)
  const { r, svc } = serviceOf(home)
  try {
    const { total } = (await ask(svc, 'session', { id })).pending
    s.append(3)
    await ask(svc, 'session', { id })
    await whileMoving(() => readHead(home, id)?.pending != null, () => r.n, 'the head says the new members')
    const d = readHead(home, id)
    assert.ok(rereads(home, id), 'still re-reading')
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
