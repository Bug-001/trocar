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
// A worker that answers one query (the warm-up's) and then dies on the next, which is how a caller WAITING for a
// document meets a worker that goes: the frame reader has a pending request and nothing will ever finish it.
const dead = () => spawn(process.execPath, ['-e', `let n = 0
process.stdin.on('data', (d) => { for (const l of String(d).split('\\n').filter(Boolean)) {
  if (++n > 1) process.exit(3)
  const b = Buffer.from(JSON.stringify({ segments: [] })); process.stdout.write(\`200 \${b.length}\\n\`); process.stdout.write(b)
} })`], { stdio: ['pipe', 'pipe', 'pipe'] })
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

/** The service answers a cold caller 503 and warms a worker behind it (D63, the cold path): drive that until a
 *  worker is there, and hand back what the warm-up answered to. */
async function warmed(svc, name = 'segments') {
  for (let i = 0; i < 20; i++) {
    const res = recorder()
    const r = await svc.route({ query: new URLSearchParams({ name }), res })
    if (res.status !== 503) return { res, r }
    await new Promise((d) => setTimeout(d, 50)) // the warm-up query is running; nobody waits for its answer
  }
  throw new Error('no worker ever answered')
}

test('a worker that dies is recorded with a closed-set code, the caller is told, and the next query gets a new worker', async () => {
  const home = rawHome('asight-qsvc-')
  const said = []
  let forks = 0
  const svc = createQueryService({ home, failure: (where, e) => said.push({ where, code: e.code, reason: e.message }), fork: (h) => (++forks === 1 ? dead() : alive(h)) })
  try {
    // The first caller is cold (503) and the worker it warms is the one that dies, so the second caller is the one
    // waiting on a document when it goes: that is who must be told, and the record is written either way.
    const cold = recorder()
    assert.equal(await svc.route({ query: new URLSearchParams({ name: 'segments' }), res: cold }), undefined)
    assert.equal(cold.status, 503, 'no worker yet: said at once, not after a fork and a cold query')
    await assert.rejects(svc.route({ query: new URLSearchParams({ name: 'segments' }), res: recorder() }), /query worker/, 'the caller is told, so it can read locally')
    assert.equal(said.length, 1)
    assert.equal(said[0].where, 'daemon')
    assert.equal(said[0].code, 'query-failed')
    assert.ok(isWhere(said[0].where) && isCode(said[0].code), 'the where and the code are in the closed sets (D38)')
    assert.match(said[0].reason, /code 3/, 'the record says how the worker ended')

    const { res } = await warmed(svc)
    assert.equal(res.status, 200, 'the handler answered the response itself')
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

test('no worker: the caller is told at once and the worker is warmed with that same query (D63, the cold path)', async () => {
  const home = rawHome('asight-qsvc-')
  const svc = createQueryService({ home, fork: alive })
  try {
    const cold = recorder()
    assert.equal(await svc.route({ query: new URLSearchParams({ name: 'segments' }), res: cold }), undefined)
    assert.equal(cold.status, 503, 'a cold read is refused at once, so the caller answers locally at local speed')
    const { res } = await warmed(svc)
    assert.equal(res.status, 200, 'and the query it was refused warmed a worker, which answers the next one')
    assert.deepEqual(JSON.parse(res.text()).segments, [])
  } finally {
    svc.stop()
  }
})

test('a name outside the closed set is refused before any worker is forked', async () => {
  let forks = 0
  const svc = createQueryService({ home: rawHome('asight-qsvc-'), fork: (h) => (forks++, alive(h)) })
  try {
    await assert.rejects(() => svc.route({ query: new URLSearchParams({ name: 'rm -rf' }), res: recorder() }), (e) => e.status === 400)
    assert.equal(forks, 0, 'an arbitrary name must not fork a process')
  } finally {
    svc.stop()
  }
})
