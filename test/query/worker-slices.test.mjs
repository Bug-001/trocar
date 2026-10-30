// test/query/worker-slices.test.mjs — the query worker is the projection's writer and goes on extracting in background slices
// (RFC 3.5 §谁执行它 / 后台抽取, 验收 #24; 4.3 §4 写者 / 回收). The real service and the real worker fork over a temp HOME.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createQueryService } from '../../src/query/service.mjs'
import { projectionFile, PROJ_V, sessionDir } from '../../src/query/projection.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { within, whileMoving, reporting } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import zlib from 'node:zlib'
import { bigSession } from './big-session.mjs'

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
const headOf = (home, id) => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(sessionDir(home, id), 'head.json.gz')))) } catch { return null } }
const homeOf = () => { const home = path.join(tmpDir('trocar-slices-'), '.trocar'); fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 }); return home }
const sizeOf = (f) => { try { return fs.statSync(f).size } catch { return 0 } }

// The daemon's idle clock that restarts at every reported slice is query-service.test.mjs's case; here the service's own clock.
test('a never-projected session answers with pending, extraction goes on with nobody asking until the session is done, and the next worker answers it whole (3.5 #24, #32)', { timeout: 300_000 }, async () => {
  const home = homeOf()
  const s = bigSession({ home, subLanes: 4, late: 3 })
  s.growTo(128 << 20) // far more than one 50 ms slice extracts
  const said = [], r = reporting(workerFork), kids = r.kids
  const svc = createQueryService({ home, failure: (w, e) => said.push(e.code), fork: r.fork })
  try {
    // (a) the first answer stops at the frontier; another name is answered meanwhile; the session is still being extracted
    const first = await ask(svc, 'session', { id: s.id })
    assert.ok(first.pending, 'the first answer carries pending')
    assert.ok(first.mark, 'it has a frontier')
    await ask(svc, 'block', { ref: first.mark })
    const again = await ask(svc, 'session', { id: s.id })
    assert.ok(again.pending, 'a later answer still carries pending')
    // (b) with no request, the projection grows: extraction runs with nobody asking
    const file = projectionFile(home, s.id), size0 = sizeOf(file)
    await whileMoving(() => sizeOf(file) > size0, () => r.n, 'the projection grew with nobody asking')
    // (c) with no request, the session is extracted and folded to its end: the head the worker's idle period writes has nothing pending
    await whileMoving(() => { const h = headOf(home, s.id); return h != null && h.tier === 1 && h.pending === null }, () => r.n, 'the session extracted and folded with nobody asking')
    svc.stop() // the worker ends here, so the next answer is a new worker's, from what this one left on disk
    await whileMoving(() => kids[0].exitCode !== null || kids[0].signalCode !== null, () => r.n, 'the worker left')
    assert.deepEqual(said, [], 'no failure')
    const next = await ask(svc, 'session', { id: s.id })
    assert.equal(kids.length, 2, 'the next query forked a new worker')
    assert.equal(next.pending, undefined, 'no member remained when the worker left')
  } finally { svc.stop() }
})

test('after an idle period the worker collects the projection of a session the index no longer has (4.3 §4 回收)', { timeout: 120_000 }, async () => {
  const home = homeOf()
  const s = bigSession({ home })
  s.growTo(1 << 20)
  const stray = projectionFile(home, 'gone-0000-4a1b-9c2d-000000000009')
  fs.mkdirSync(path.dirname(stray), { recursive: true, mode: 0o700 })
  fs.writeFileSync(stray, '{"v":0}\n', { mode: 0o600 })
  const r = reporting(workerFork), svc = createQueryService({ home, fork: r.fork })
  try {
    await ask(svc, 'session', { id: s.id })
    await whileMoving(() => !fs.existsSync(stray), () => r.n, 'the stray projection was collected')
    assert.ok(fs.existsSync(projectionFile(home, s.id)), 'the answered session keeps its projection')
  } finally { svc.stop() }
})

test('a projection rebuilt when a background slice opened it is said on the next answer of that session, once (4.3 #7, D38)', { timeout: 120_000 }, async () => {
  const home = homeOf()
  const s = bigSession({ home })
  s.growTo(1 << 20)
  const file = projectionFile(home, s.id)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, `${JSON.stringify({ v: PROJ_V + 1 })}\n`, { mode: 0o600 }) // a version this build does not read
  const r = reporting(workerFork), svc = createQueryService({ home, fork: r.fork })
  const rebuilt = (doc) => doc.errors.filter((e) => e.code === 'projection-rebuilt').length
  try {
    await ask(svc, 'sessions', {}) // no session answered: after the idle wait the slice takes the newest index row's session
    const head = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).v } catch { return null } }
    await whileMoving(() => head() === PROJ_V, () => r.n, 'a background slice rebuilt and wrote the projection')
    assert.equal(rebuilt(await ask(svc, 'session', { id: s.id })), 1, 'the next answer says the rebuild')
    assert.equal(rebuilt(await ask(svc, 'session', { id: s.id })), 0, 'once')
  } finally { svc.stop() }
})
