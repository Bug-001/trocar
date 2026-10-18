// test/query/query-service.test.mjs — a query worker that dies is said, not silent (RFC 4.6 §事件与码 `query-failed`, 3.5 验收 9; D38 · D63).
//
// The contract: the daemon records the failure with a code from the closed set (src/health/codes.mjs), the caller is told (so it reads
// locally instead of hanging), and the next query gets a new worker — one bad answer never turns the read side off.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fork, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createQueryService } from '../../src/query/service.mjs'
import { isCode, isWhere } from '../../src/health/codes.mjs'
import { rawHome } from './raw-home.mjs'

const WORKER = fileURLToPath(new URL('../../src/query/worker.mjs', import.meta.url))
const dead = () => spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['pipe', 'pipe', 'pipe'] })
const alive = (home) => fork(WORKER, [home], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })

/** A response that records what was written to it. */
const recorder = () => {
  const r = { status: null, chunks: [], ended: false, headersSent: false }
  return Object.assign(r, {
    writeHead: (s) => { r.status = s; r.headersSent = true },
    write: (b) => { r.chunks.push(b); return true },
    end: () => { r.ended = true },
    once: () => {},
    text: () => Buffer.concat(r.chunks).toString('utf8'),
  })
}

test('a worker that dies is recorded with a closed-set code, the caller is told, and the next query gets a new worker', async () => {
  const home = rawHome('asight-qsvc-')
  const said = []
  let first = true
  const svc = createQueryService({ home, failure: (where, e) => said.push({ where, code: e.code, reason: e.message }), fork: (h) => (first ? (first = false, dead()) : alive(h)) })
  try {
    await assert.rejects(svc.route({ query: new URLSearchParams({ name: 'segments' }), res: recorder() }), /query worker/, 'the caller is told, so it can read locally')
    assert.equal(said.length, 1)
    assert.equal(said[0].where, 'daemon')
    assert.equal(said[0].code, 'query-failed')
    assert.ok(isWhere(said[0].where) && isCode(said[0].code), 'the where and the code are in the closed sets (D38)')
    assert.match(said[0].reason, /code 3/, 'the record says how the worker ended')

    const res = recorder()
    assert.equal(await svc.route({ query: new URLSearchParams({ name: 'segments' }), res }), undefined, 'the handler answered the response itself')
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text()).segments, [], 'the next query is answered by a new worker')
    assert.equal(said.length, 1, 'a worker that answers adds no failure')
  } finally {
    svc.stop()
  }
})

test('GET /query without a name is the caller\'s mistake, not a failure', async () => {
  const said = []
  const svc = createQueryService({ home: rawHome('asight-qsvc-'), failure: (w, e) => said.push([w, e.code]) })
  try {
    await assert.rejects(() => svc.route({ query: new URLSearchParams({}), res: recorder() }), (e) => e.status === 400)
    assert.deepEqual(said, [])
  } finally {
    svc.stop()
  }
})
