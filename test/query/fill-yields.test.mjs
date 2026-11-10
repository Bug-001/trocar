// test/query/fill-yields.test.mjs — the usage fill gives way to session work (RFC 3.5 §后台抽取与归约, `overview.usage`): after an
// `overview`, the fill of the sidecars it found missing waits at a chunk's edge while a session is read for a user, and goes on once it is
// read; a session read to its end, opened and followed, holds nothing, nor does the newest session's read a request cut off; another query
// waits for no more than the chunk in flight. The real service and the real worker over a temp HOME: one session of a few thousand small
// calls, and segments of other sessions' calls, each segment one chunk of the fill (USAGE_CHUNK_BYTES), so a sidecar lands per chunk.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { createQueryService } from '../../src/query/service.mjs'
import { ROLES, heapFlags, workerEnv } from '../../src/query/warm.mjs'
import { sessionDir } from '../../src/query/projection.mjs'
import { readHead } from '../../src/query/ctx-files.mjs'
import { usageFile, USAGE_CHUNK_BYTES } from '../../src/query/usage.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { whileMoving, reporting } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { listed } from '../helpers/head-done.mjs'

const SEGMENTS = 24, CALLS = 60, ASK = 30_000, SESSION_CALLS = 3_000
const line = (seg, n) => JSON.stringify({ ts: '2026-11-05T09:00:00.000Z', endpoint: '/v1/chat/completions', method: 'POST',
  req_headers: { 'content-type': 'application/json' }, req_body: JSON.stringify({ model: 'm', prompt_cache_key: `fill-${seg}`, messages: [{ role: 'user', content: `${n} `.repeat(ASK / 4) }] }),
  resp: { status: 200, kind: 'json', body: { choices: [{ message: { role: 'assistant', content: `answer ${n}` } }], usage: { prompt_tokens: 10, completion_tokens: 2 } } },
  id: `req_${seg}_${n}`, ts_request: '2026-11-05T09:00:00.000Z', is_llm_call: true, capture: 'transparent', host: 'api.example.test', traffic_class: 'llm',
  proc: { pid: 9, exe: '/x/kimi', agent: 'kimi' } })
assert.ok(CALLS * ASK < USAGE_CHUNK_BYTES, 'a segment is one chunk of the fill')

/** A home: the session of SESSION_CALLS calls in `segment`, and SEGMENTS segments of other sessions' calls; the session's id, every segment and
 *  the id of a session of one of the others. */
async function homeOf(prefix, segment = '20261020T164737Z') {
  const home = path.join(tmpDir(prefix), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  bigSession({ home, segment, wire: 'chat', growth: 20, compactAt: 0, subEvery: 0 }).append(SESSION_CALLS)
  const segments = [segment]
  for (let i = 0; i < SEGMENTS; i++) {
    const seg = `20261105T09${String(i).padStart(2, '0')}00Z`
    fs.writeFileSync(path.join(home, 'raw', `${seg}.ndjson`), Array.from({ length: CALLS }, (_, n) => line(seg, n)).join('\n') + '\n', { mode: 0o600 })
    segments.push(seg)
  }
  const { sessions } = await runQuery('sessions', {}, { home })
  return { home, id: sessions.find((s) => s.calls >= SESSION_CALLS).session_id, segments, small: sessions.find((s) => s.calls === CALLS).session_id }
}
const answer = () => ({ status: 0, writeHead(s) { this.status = s }, write: () => true, end() {}, once() {} })
const sidecars = (home, segments) => segments.filter((s) => fs.existsSync(usageFile(home, s))).length
const folded = (home, id) => { const h = readHead(home, id); return h?.tier === 1 && h.pending === null && listed(h) }
const service = (home) => { const r = reporting(workerFork); return { r, svc: createQueryService({ home, fork: r.fork, idleMs: 60_000 }) } }
const ready = async (svc) => { const a = answer(); await svc.relay({ name: 'sessions', params: {}, res: a }); assert.equal(a.status, 200) }

test('3.5 §后台抽取与归约: the usage fill waits while a session is first read, and goes on once it is read', { timeout: 300_000 }, async () => {
  const { home, id, segments } = await homeOf('trocar-fill-first-')
  const { r, svc } = service(home)
  try {
    await ready(svc)
    await svc.relay({ name: 'overview', params: {}, res: answer() }) // its answer written, the fill starts
    const asked = svc.relay({ name: 'session', params: { id, head: true }, res: answer() })
    let first = null, end = null
    await whileMoving(() => {
      if (first == null && readHead(home, id)?.pending) first = sidecars(home, segments)
      if (folded(home, id)) end = sidecars(home, segments)
      return end != null
    }, () => r.n, 'the session read to its end')
    await asked
    assert.ok(first != null && first < segments.length, `the head said pending while the session was read, before the fill ended: ${first} of ${segments.length}`)
    assert.ok(end - first <= 1, `at most the sidecar in flight lands during the read: ${first} → ${end} of ${segments.length}`)
    await whileMoving(() => sidecars(home, segments) === segments.length, () => sidecars(home, segments) + r.n, 'the fill finished')
  } finally { svc.stop() }
})

test('3.5 §后台抽取与归约: a session read to its end holds no fill, opened and followed', { timeout: 300_000 }, async () => {
  const { home, id, segments } = await homeOf('trocar-fill-done-')
  const { r, svc } = service(home)
  try {
    await ready(svc)
    await svc.relay({ name: 'session', params: { id, head: true }, res: answer() })
    await whileMoving(() => folded(home, id), () => r.n, 'the session read to its end')
    await svc.relay({ name: 'overview', params: {}, res: answer() })
    svc.follow(id)
    await svc.relay({ name: 'session', params: { id }, res: answer() })
    await whileMoving(() => sidecars(home, segments) === segments.length, () => sidecars(home, segments) + r.n, 'the fill wrote every sidecar')
  } finally { svc.stop() }
})

test('3.5 §后台抽取与归约: the newest session\'s read that a request cut off holds no fill', { timeout: 300_000 }, async () => {
  const { home, id, segments, small } = await homeOf('trocar-fill-newest-', '20261201T000000Z') // the big session is the newest
  const { r, svc } = service(home)
  try {
    await ready(svc)
    await svc.relay({ name: 'session', params: { id: small, head: true }, res: answer() })
    await whileMoving(() => folded(home, small), () => r.n, 'the asked session read to its end')
    // after the request, the worker reads the newest session (not for a user): its fold log appears
    await whileMoving(() => fs.existsSync(sessionDir(home, id)) && fs.readdirSync(sessionDir(home, id)).some((f) => f.startsWith('fold.')), () => r.n, 'the newest session read')
    await svc.relay({ name: 'session', params: { id: small }, res: answer() }) // it cuts the newest's read off
    await svc.relay({ name: 'overview', params: {}, res: answer() })
    const fill = segments.slice(1)
    await whileMoving(() => sidecars(home, fill) > 0 || folded(home, id), () => r.n, 'a sidecar landed or the newest session was read')
    assert.ok(!folded(home, id), 'a sidecar landed while the newest session was still read: its read is not one for a user')
  } finally { svc.stop() }
})

// The fill's chunks stall STALL_MS each while a flag file exists (the worker's preload: the chunk's write of its sidecar), so a query asked
// as one begins (gzipped, as the board takes it: a turn of the event loop) waits for that chunk, and for another only if the fill does not give way: the bound is the stall's, not a sample of the load.
const WORKER = fileURLToPath(new URL('../../src/query/worker.mjs', import.meta.url))
const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const STALL_MS = 1000, BIG = 450 // a segment of BIG calls is several chunks of the fill
test('3.5 §后台抽取与归约: a query asked while the fill runs waits for the chunk in flight, no more', { timeout: 300_000 }, async () => {
  const dir = tmpDir('trocar-fill-stall-'), home = path.join(dir, '.trocar'), flag = path.join(dir, 'stall'), starts = path.join(dir, 'starts'), preload = path.join(dir, 'stall.cjs')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const segments = ['20261105T090000Z', '20261105T090100Z']
  for (const seg of segments) fs.writeFileSync(path.join(home, 'raw', `${seg}.ndjson`), Array.from({ length: BIG }, (_, n) => line(seg, n)).join('\n') + '\n', { mode: 0o600 })
  assert.ok(BIG * ASK > 2 * USAGE_CHUNK_BYTES, 'a segment is several chunks of the fill')
  fs.writeFileSync(starts, '')
  fs.writeFileSync(preload, `const fs = require('node:fs'), openSync = fs.openSync, renameSync = fs.renameSync
const usage = (f) => /\\.usage\\.json$/.test(String(f))
const stall = () => { if (!fs.existsSync(${JSON.stringify(flag)})) return; fs.appendFileSync(${JSON.stringify(starts)}, 'x'); for (const end = Date.now() + ${STALL_MS}; Date.now() < end;); }
fs.renameSync = (a, b) => { if (usage(b)) stall(); return renameSync(a, b) }
fs.openSync = (f, ...a) => { if (usage(f) && a[0] === 'r+') stall(); return openSync(f, ...a) }
`)
  const r = reporting((h, ...argv) => fork(WORKER, [h, ...argv.filter((a) => a != null)], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: ['--require', NO_REAL_OS, '--require', preload, ...heapFlags(ROLES.main.capMb)], env: workerEnv() }))
  const svc = createQueryService({ home, fork: r.fork, idleMs: 60_000 }), size = () => fs.statSync(starts).size
  try {
    await ready(svc)
    let alone = 0
    for (let i = 0; i < 3; i++) { const t = performance.now(); await svc.relay({ name: 'segments', params: {}, res: answer(), gzip: true }); alone = Math.max(alone, performance.now() - t) }
    fs.writeFileSync(flag, '')
    await svc.relay({ name: 'overview', params: {}, res: answer() }) // its answer written, the fill starts
    const s0 = size()
    for (const end = Date.now() + 60_000; size() === s0; await sleep(5)) assert.ok(Date.now() < end, 'a chunk of the fill began')
    const t = performance.now()
    await svc.relay({ name: 'segments', params: {}, res: answer(), gzip: true })
    const took = performance.now() - t
    assert.ok(sidecars(home, segments) < segments.length, 'asked while the fill ran')
    assert.ok(took < alone + 1.5 * STALL_MS, `answered within its own time and the chunk in flight: ${Math.round(took)} ms, alone ${Math.round(alone)} ms, a chunk's stall ${STALL_MS} ms`)
  } finally { svc.stop() }
})
