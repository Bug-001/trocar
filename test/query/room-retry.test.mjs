// test/query/room-retry.test.mjs — a fold that finds the heap held by others is this process's heap, not the session (RFC 3.5 §后台抽取与归约
// 「堆有地方时重试」, §内存有界, §谁执行它「答案文件」 upgrade.skip; 验收 #37): no stop in its head while something else can give way, retried
// once the heap has room; when nothing else can (the ballast is memory that never lets go), its heap-no-room stop, once. Real workers over a
// temp HOME: a small worker whose heap a preload keeps filled, past the line the fold stops at, until a flag file appears. The preload counts
// the opens of the session's fold log for writing (a try at the session opens it once, and nothing else in an idle period does, so the count
// is how often the session was tried), the full collections (a look at the heap) and the writes of the session's stopped head.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { createQueryService } from '../../src/query/service.mjs'
import { heapFlags, workerEnv } from '../../src/query/warm.mjs'
import { readHead } from '../../src/query/ctx-files.mjs'
import { sessionDir } from '../../src/query/projection.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { recordId } from '../../src/collector/core/record/segments.mjs'
import { usageFile } from '../../src/query/usage.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { whileMoving, reporting } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { rawHome } from './raw-home.mjs'

const WORKER = fileURLToPath(new URL('../../src/query/worker.mjs', import.meta.url))
const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const SEGMENT = '20261105T090000Z', HEAP_MB = 128
// Filled to this before the modules load. Measured 2026-11-05 (node 22, a 128 MB heap): the query modules bring the live heap to about 87 MB, between
// the line the fold stops at (81 MB) and the ceiling (96 MB).
const BALLAST_MB = 80
// The idle branch runs IDLE_SLICE_MS (src/query/worker.mjs) after the last request, so the service's idle clock has to outlast it.
const IDLE_SLICE_MS = 2000, IDLE_MS = 6000, QUIET_MS = 1000
const ROOM_MS = 2000 // how often the worker looks at the heap for a waiting session (src/query/worker.mjs)

const line = (key, n) => JSON.stringify({ ts: `2026-11-05T09:00:0${n}.000Z`, endpoint: '/v1/chat/completions', method: 'POST',
  req_headers: { 'content-type': 'application/json' }, req_body: JSON.stringify({ model: 'm', prompt_cache_key: key, messages: [{ role: 'user', content: `ask ${n}` }] }),
  resp: { status: 200, kind: 'json', body: { choices: [{ message: { role: 'assistant', content: `answer ${n}` } }] } },
  id: `req_${key}_${n}`, ts_request: `2026-11-05T09:00:0${n}.000Z`, is_llm_call: true, capture: 'transparent', host: 'api.example.test', traffic_class: 'llm',
  proc: { pid: 9, exe: '/x/kimi', agent: 'kimi' } })
/** A home whose segment holds, in order, three calls of each session key: the id and the last record of each. */
async function homeOf(prefix, ...keys) {
  const home = rawHome(prefix)
  fs.writeFileSync(path.join(home, 'raw', `${SEGMENT}.ndjson`), keys.flatMap((k) => [1, 2, 3].map((n) => line(k, n))).join('\n') + '\n', { mode: 0o600 })
  const groups = [...sessionGroups(await indexRows({ home, errors: [] })).keys()]
  assert.equal(groups.length, keys.length)
  return { home, sessions: keys.map((_, i) => ({ id: groups[i], last: recordId(SEGMENT, (i + 1) * 3) })) }
}

/** A `fork` for createQueryService: the small worker with the ballast in its heap, `release()` to let it go, `tries()` the count above;
 *  `more`: preload code run after the ballast's. */
function ballasted(log, more = '') {
  const dir = tmpDir('trocar-ballast-'), flag = path.join(dir, 'flag'), count = path.join(dir, 'count'), preload = path.join(dir, 'ballast.cjs')
  const gcs = path.join(dir, 'gcs'), stops = path.join(dir, 'stops'), head = path.join(path.dirname(log), 'head.json.gz')
  for (const f of [count, gcs, stops]) fs.writeFileSync(f, '')
  fs.writeFileSync(preload, `const fs = require('node:fs'), v8 = require('node:v8'), vm = require('node:vm'), openSync = fs.openSync, renameSync = fs.renameSync
fs.openSync = (f, ...a) => { if (String(f) === ${JSON.stringify(log)} && a[0] === 'r+') fs.appendFileSync(${JSON.stringify(count)}, 'x'); return openSync(f, ...a) }
fs.renameSync = (a, b) => { if (String(b) === ${JSON.stringify(head)}) fs.appendFileSync(${JSON.stringify(stops)}, 'x'); return renameSync(a, b) }
v8.setFlagsFromString('--expose-gc')
const collect = vm.runInNewContext('gc')
globalThis.gc = () => { fs.appendFileSync(${JSON.stringify(gcs)}, 'x'); collect() }
let ballast = []
while (v8.getHeapStatistics().used_heap_size < ${BALLAST_MB * 1048576}) ballast.push(Array.from({ length: 1024 }, (_, i) => ({ i })))
const look = setInterval(() => { if (fs.existsSync(${JSON.stringify(flag)})) { ballast = null; clearInterval(look) } }, 50)
look.unref()
${more}`)
  return {
    fork: (h, ...argv) => fork(WORKER, [h, ...argv], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: ['--require', NO_REAL_OS, '--require', preload, ...heapFlags(HEAP_MB)], env: workerEnv() }),
    release: () => fs.writeFileSync(flag, ''),
    tries: () => fs.statSync(count).size,
    gcs: () => fs.statSync(gcs).size,
    stops: () => fs.statSync(stops).size, // head.json.gz: a head with a stop, or none (folded)
  }
}

const watched = (spawn) => {
  // `again`: the worker's 102 frames (an answer of no bytes: asked again, src/query/worker.mjs write)
  const r = reporting((...a) => { const c = spawn(...a); c.on('message', () => { r.last = Date.now() }); c.stdout.on('data', (d) => { r.again += (String(d).match(/^102 0 - /gm) || []).length }); return c })
  r.last = 0; r.again = 0
  return r
}
const until = async (r, what, ok) => { await whileMoving(ok, () => r.n, what) }
const foldLog = (home, s) => path.join(sessionDir(home, s.id), 'fold.0.ndjson')
const folded = (home, id) => { const h = readHead(home, id); return h?.tier === 1 && h.pending === null }
const quiet = (r, since = 0) => until(r, 'the worker went quiet', () => r.last >= since && Date.now() - r.last >= QUIET_MS)
const answer = () => { const a = { status: 0, chunks: [], writeHead(s) { a.status = s }, write: (b) => { a.chunks.push(Buffer.from(b)); return true }, end() {}, once() {} }; return a }
const stoppedOn = (home, id) => readHead(home, id)?.pending?.stopped?.code === 'heap-no-room'
/** One idle period, opened by a request that names no session: it has ended once the worker's report past IDLE_SLICE_MS is followed by quiet. */
async function idlePeriod(svc, r) {
  const at = Date.now()
  await svc.relay({ name: 'segments', params: {}, res: answer() })
  await quiet(r, at + IDLE_SLICE_MS)
}
/** A service over a ballasted worker, kicked at the session, once the fold was tried and the worker went quiet. */
async function parked(home, s, b, more = {}) {
  const r = watched(b.fork), svc = createQueryService({ home, fork: r.fork, idleMs: IDLE_MS, ...more })
  svc.kick([s.last])
  await until(r, 'the fold was tried', () => b.tries() > 0)
  await quiet(r)
  return { r, svc }
}

test('3.5 #37: a stop on an upgrade target leaves no upgrade.skip', { timeout: 120_000 }, async () => {
  const { home, sessions: [s] } = await homeOf('trocar-room-skip-', 'room-a')
  const d = sessionDir(home, s.id)
  let r = watched(workerFork), svc = createQueryService({ home, fork: r.fork, idleMs: 20_000 })
  try {
    svc.kick([s.last])
    await until(r, 'the fold ended', () => folded(home, s.id))
  } finally { svc.stop() }
  for (const f of fs.readdirSync(d)) if (/^open\./.test(f)) fs.unlinkSync(path.join(d, f)) // the tier-1 head stays, its pending null
  // a member past the frontier: a session folded to its end has nothing to fold, so nothing to stop on
  fs.appendFileSync(path.join(home, 'raw', `${SEGMENT}.ndjson`), `${line('room-a', 4)}\n`)

  const b = ballasted(foldLog(home, s))
  r = watched(b.fork)
  svc = createQueryService({ home, fork: r.fork, idleMs: 20_000 })
  try {
    svc.sweep()
    await until(r, 'the upgrade was tried', () => b.tries() > 0)
    await quiet(r)
    assert.equal(fs.existsSync(path.join(d, 'upgrade.skip')), false)
    const head = answer()
    await svc.relay({ name: 'session', params: { id: s.id, head: true }, res: head })
    assert.equal(head.status, 200)
    const doc = JSON.parse(Buffer.concat(head.chunks).toString('utf8'))
    assert.deepEqual([doc.tier, doc.pending?.done, doc.pending?.total, doc.pending?.stopped], [1, 3, 4, undefined], 'the head as it stands, with the member past its mark pending')
  } finally { svc.stop() }
})

test('3.5 #37: memory that never lets go: the waiting session gets its heap-no-room stop once, then is not tried nor the heap looked at for it, however many idle periods pass', { timeout: 120_000 }, async () => {
  const { home, sessions: [s] } = await homeOf('trocar-room-wait-', 'room-a')
  const b = ballasted(foldLog(home, s))
  const { r, svc } = await parked(home, s, b, { idleMs: 60_000 })
  try {
    await until(r, 'the stop was written', () => stoppedOn(home, s.id)) // nothing else in the heap gives way: no reader, no fill
    await idlePeriod(svc, r) // the worker's first: its sweep and upgrade scan
    const [tries, gcs] = [b.tries(), b.gcs()]
    assert.equal(tries, 1, 'one try: the bound let the warm entries go before it stopped the fold')
    await sleep(3 * ROOM_MS) // no request: three of the waiting timer's turns
    assert.deepEqual([b.tries(), b.gcs()], [tries, gcs], 'off the timer: no try, no look at the heap')
    for (let i = 0; i < 3; i++) await idlePeriod(svc, r)
    assert.equal(b.tries(), tries, 'an idle period with no room does not try it')
    assert.equal(b.stops(), 1, 'the stop is written once')
    assert.equal(r.kids.length, 1, 'one worker throughout')
  } finally { svc.stop() }
})

test('3.5 #37: once the heap has room the session is folded, no request or kick naming it', { timeout: 120_000 }, async () => {
  const { home, sessions: [s] } = await homeOf('trocar-room-back-', 'room-a', 'room-b') // the newest session, which a request folds, is the other one
  const b = ballasted(foldLog(home, s))
  const { r, svc } = await parked(home, s, b)
  try {
    await idlePeriod(svc, r)
    b.release()
    await idlePeriod(svc, r) // a stop written meanwhile (the ballast never let go) is retried at an idle period with room
    await until(r, 'the retry folded it', () => folded(home, s.id))
    assert.equal(readHead(home, s.id).pending, null, 'the stop is gone from the head')
    assert.equal(r.kids.length, 1, 'the same worker')
  } finally { svc.stop() }
})

test('3.5 #37: a worker that never had room leaves on its idle clock, and the next one folds the session the board opens', { timeout: 120_000 }, async () => {
  const { home, sessions: [s] } = await homeOf('trocar-room-next-', 'room-a')
  const b = ballasted(foldLog(home, s)), failed = []
  const { r, svc } = await parked(home, s, b, { failure: (_, e) => failed.push(e.code) })
  try {
    const [w] = r.kids
    await until(r, 'the worker left on its idle clock', () => w.killed) // the service drops its listeners before the kill
    assert.deepEqual(failed.filter((c) => c === 'query-failed'), [])
  } finally { svc.stop() }
  assert.ok(readHead(home, s.id).pending, 'a head still folding: the board that reads it has the daemon follow the session')
  const next = watched(workerFork), fresh = createQueryService({ home, fork: next.fork, idleMs: 20_000 })
  try {
    fresh.follow(s.id)
    await until(next, 'the next worker folded it', () => folded(home, s.id))
  } finally { fresh.stop() }
})

test('3.5 #37: while others hold the heap, `session --head` answers the head as it stands and a lane read waits for room', { timeout: 120_000 }, async () => {
  const { home, sessions: [s] } = await homeOf('trocar-room-ask-', 'room-a')
  const b = ballasted(foldLog(home, s))
  const { r, svc } = await parked(home, s, b)
  try {
    await until(r, 'the stop was written', () => stoppedOn(home, s.id)) // the head on disk says it; the answer is of now, no stop
    const head = answer()
    await svc.relay({ name: 'session', params: { id: s.id, head: true }, res: head })
    assert.equal(head.status, 200)
    const doc = JSON.parse(Buffer.concat(head.chunks).toString('utf8'))
    assert.deepEqual([doc.pending.total, doc.pending.stopped], [3, undefined], 'the head with its pending, no stop')
    const t0 = b.tries(), tail = answer(), asked = svc.relay({ name: 'lane', params: { id: s.id, tail: 'main' }, res: tail })
    await until(r, 'the lane read was tried', () => b.tries() > t0 && r.again > 0)
    const a0 = r.again
    await until(r, 'the lane read was asked again', () => r.again >= a0 + 4) // every AGAIN_MS (src/query/service.mjs)
    assert.equal(tail.status, 0, 'no answer while the heap is held: asked again (102)')
    assert.equal(b.tries(), t0 + 1, 'the session waits for room: asked again, it is answered 102 at once, no fold')
    b.release()
    await asked
    assert.equal(tail.status, 200)
  } finally { svc.stop() }
})

// The fill's chunks stall STALL_MS each while a flag file exists (the worker's preload: the chunk's write of its sidecar, as in
// fill-yields.test.mjs), so a fill of FILL segments, one chunk each, outlasts several of the waiting timer's turns.
const FILL = 24, STALL_MS = 1000
const small = (seg, n) => JSON.stringify({ ts: '2026-11-05T09:00:00.000Z', endpoint: '/v1/chat/completions', method: 'POST',
  req_headers: { 'content-type': 'application/json' }, req_body: JSON.stringify({ model: 'm', prompt_cache_key: `fill-${seg}`, messages: [{ role: 'user', content: `ask ${n}` }] }),
  resp: { status: 200, kind: 'json', body: { choices: [{ message: { role: 'assistant', content: `answer ${n}` } }], usage: { prompt_tokens: 10, completion_tokens: 2 } } },
  id: `req_${seg}_${n}`, ts_request: '2026-11-05T09:00:00.000Z', is_llm_call: true, capture: 'transparent', host: 'api.example.test', traffic_class: 'llm',
  proc: { pid: 9, exe: '/x/kimi', agent: 'kimi' } })
test('3.5 #37 §后台抽取与归约: a user\'s session waiting for room holds the usage fill, and gets its verdict before the fill ends', { timeout: 300_000 }, async () => {
  const { home, sessions: [s] } = await homeOf('trocar-room-fill-', 'room-a')
  const segments = [SEGMENT]
  for (let i = 0; i < FILL; i++) {
    const seg = `20261105T10${String(i).padStart(2, '0')}00Z`
    fs.writeFileSync(path.join(home, 'raw', `${seg}.ndjson`), Array.from({ length: 3 }, (_, n) => small(seg, n)).join('\n') + '\n', { mode: 0o600 })
    segments.push(seg)
  }
  const flag = path.join(tmpDir('trocar-room-stall-'), 'stall')
  const b = ballasted(foldLog(home, s), `const open1 = fs.openSync, rename1 = fs.renameSync
const usage = (f) => /\\.usage\\.json$/.test(String(f))
const stall = () => { if (!fs.existsSync(${JSON.stringify(flag)})) return; for (const end = Date.now() + ${STALL_MS}; Date.now() < end;); }
fs.renameSync = (a, b) => { if (usage(b)) stall(); return rename1(a, b) }
fs.openSync = (f, ...a) => { if (usage(f) && a[0] === 'r+') stall(); return open1(f, ...a) }
`)
  const r = watched(b.fork), svc = createQueryService({ home, fork: r.fork, idleMs: 120_000 })
  const sidecars = () => segments.filter((g) => fs.existsSync(usageFile(home, g))).length, total = segments.length
  const moving = () => r.n + r.again + sidecars()
  try {
    const ready = answer()
    await svc.relay({ name: 'sessions', params: {}, res: ready })
    assert.equal(ready.status, 200)
    fs.writeFileSync(flag, '')
    await svc.relay({ name: 'overview', params: {}, res: answer() }) // its answer written, the fill starts
    const asked = svc.relay({ name: 'lane', params: { id: s.id, tail: 'main' }, res: answer() }).catch(() => {}) // asked again until the stop
    await whileMoving(() => r.again > 0, moving, 'the lane read waited for room')
    const c0 = sidecars()
    await whileMoving(() => stoppedOn(home, s.id), moving, 'the stop was written')
    const c1 = sidecars()
    assert.ok(c1 - c0 <= 1, `the fill waited while the session waited for room: ${c0} → ${c1} of ${total}`)
    assert.ok(c1 < total, `the verdict came before the fill ended: ${c1} of ${total}`)
    await whileMoving(() => sidecars() === total, moving, 'the fill finished')
    void asked
  } finally { svc.stop() }
})
