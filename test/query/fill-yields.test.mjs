// test/query/fill-yields.test.mjs — the usage fill gives way to session work (RFC 3.5 §后台抽取与归约, `overview.usage`): after an
// `overview`, the fill of the sidecars it found missing waits at a chunk's edge while a session is read for a user, and goes on once it is
// read; a session read to its end, opened and followed, holds nothing; another query waits for no more than the chunk in flight. The real
// service and the real worker over a temp HOME: one session of a few thousand small calls, and segments of other sessions' calls, each
// segment one chunk of the fill (USAGE_CHUNK_BYTES), so a sidecar lands per chunk.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createQueryService } from '../../src/query/service.mjs'
import { readHead } from '../../src/query/ctx-files.mjs'
import { usageFile, USAGE_CHUNK_BYTES } from '../../src/query/usage.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { whileMoving, reporting } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'

const SEGMENTS = 24, CALLS = 60, ASK = 30_000, SESSION_CALLS = 3_000
const line = (seg, n) => JSON.stringify({ ts: '2026-11-05T09:00:00.000Z', endpoint: '/v1/chat/completions', method: 'POST',
  req_headers: { 'content-type': 'application/json' }, req_body: JSON.stringify({ model: 'm', prompt_cache_key: `fill-${seg}`, messages: [{ role: 'user', content: `${n} `.repeat(ASK / 4) }] }),
  resp: { status: 200, kind: 'json', body: { choices: [{ message: { role: 'assistant', content: `answer ${n}` } }], usage: { prompt_tokens: 10, completion_tokens: 2 } } },
  id: `req_${seg}_${n}`, ts_request: '2026-11-05T09:00:00.000Z', is_llm_call: true, capture: 'transparent', host: 'api.example.test', traffic_class: 'llm',
  proc: { pid: 9, exe: '/x/kimi', agent: 'kimi' } })
assert.ok(CALLS * ASK < USAGE_CHUNK_BYTES, 'a segment is one chunk of the fill')

/** A home: the session of SESSION_CALLS calls, then SEGMENTS segments of other sessions' calls; the session's id and every segment. */
async function homeOf(prefix) {
  const home = path.join(tmpDir(prefix), '.trocar'), segment = '20261020T164737Z'
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  bigSession({ home, segment, wire: 'chat', growth: 20, compactAt: 0, subEvery: 0 }).append(SESSION_CALLS)
  const segments = [segment]
  for (let i = 0; i < SEGMENTS; i++) {
    const seg = `20261105T09${String(i).padStart(2, '0')}00Z`
    fs.writeFileSync(path.join(home, 'raw', `${seg}.ndjson`), Array.from({ length: CALLS }, (_, n) => line(seg, n)).join('\n') + '\n', { mode: 0o600 })
    segments.push(seg)
  }
  const id = (await runQuery('sessions', {}, { home })).sessions.find((s) => s.calls >= SESSION_CALLS).session_id
  return { home, id, segments }
}
const answer = () => ({ status: 0, writeHead(s) { this.status = s }, write: () => true, end() {}, once() {} })
const sidecars = (home, segments) => segments.filter((s) => fs.existsSync(usageFile(home, s))).length
const folded = (home, id) => { const h = readHead(home, id); return h?.tier === 1 && h.pending === null }
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
    assert.ok(first != null, 'the head said pending while the session was read')
    assert.ok(end - first <= 1, `at most the sidecar in flight lands during the read: ${first} → ${end} of ${segments.length}`)
    await whileMoving(() => sidecars(home, segments) === segments.length, () => sidecars(home, segments) + r.n, 'the fill finished')
  } finally { svc.stop() }
})

test('3.5 §后台抽取与归约: a session read to its end holds no fill, opened and followed; another query waits for at most a chunk', { timeout: 300_000 }, async () => {
  const { home, id, segments } = await homeOf('trocar-fill-done-')
  const { r, svc } = service(home)
  try {
    await ready(svc)
    await svc.relay({ name: 'session', params: { id, head: true }, res: answer() })
    await whileMoving(() => folded(home, id), () => r.n, 'the session read to its end')
    // the fill alone: a chunk's time is the longest gap between two sidecars landing
    await svc.relay({ name: 'overview', params: {}, res: answer() })
    svc.follow(id)
    await svc.relay({ name: 'session', params: { id }, res: answer() })
    await whileMoving(() => sidecars(home, segments) === segments.length, () => sidecars(home, segments) + r.n, 'the fill wrote every sidecar')
    const at = segments.map((s) => fs.statSync(usageFile(home, s)).mtimeMs).sort((a, b) => a - b)
    const chunk = Math.max(...at.slice(1).map((t, i) => t - at[i]))
    let alone = 0
    for (let i = 0; i < 3; i++) { const t = performance.now(); await svc.relay({ name: 'segments', params: {}, res: answer() }); alone = Math.max(alone, performance.now() - t) }
    // again, with a query asked while the fill runs
    for (const s of segments) fs.unlinkSync(usageFile(home, s))
    await svc.relay({ name: 'overview', params: {}, res: answer() })
    const t = performance.now()
    await svc.relay({ name: 'segments', params: {}, res: answer() })
    const took = performance.now() - t
    assert.ok(sidecars(home, segments) < segments.length, 'asked while the fill ran')
    assert.ok(took <= alone + chunk, `answered within its own time and one chunk's: ${Math.round(took)} ms, alone ${Math.round(alone)} ms, a chunk ${Math.round(chunk)} ms`)
  } finally { svc.stop() }
})
