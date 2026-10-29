// test/query/fold-stop.test.mjs — a background fold that stops is a persistent fact in the session's head (RFC 3.5 §会话读
// 「`session --head`」 pending.stopped, 验收 #37; D38②). The real service and the real worker over a temp HOME: a worker whose heap holds
// no room for any row of the session stops the kicked fold with heap-no-room; a worker with the service's own heap then folds the
// session and the stop is gone from its head.
//
// No room, from the session and not from a heap tuned to one node build: the plan of a session read holds every member, never cut
// (src/query/named/session.mjs PLAN_PER_MEMBER), so a session of enough small calls leaves a small worker's measured bound no room
// for one folded row, however the worker's own start-up heap or the node build moves. The member count is a fixed share of the
// worker's budget at PLAN_PER_MEMBER a member. Measured 2026-10-29 (node 22, a 64 MB worker, these one-turn calls) as the share
// N × PLAN_PER_MEMBER / budget: 0.12 and 0.16 fold a cut of the newest 96–240 calls, 0.23 and 0.47 stop with heap-no-room, 0.67 and
// 0.95 die of the heap; a third sits inside the shares that stopped, about 1.4× from the nearest one that did not. A single large
// call cannot do it: the fold's measured bound sees a call only after it is read, and one call that grows the live heap past the
// line costs more than the whole heap to read (one 16 MB call folds in that worker, an 18 MB one kills it).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { createQueryService } from '../../src/query/service.mjs'
import { heapFlags, workerEnv } from '../../src/query/warm.mjs'
import { headFile } from '../../src/query/ctx-files.mjs'
import { recordId } from '../../src/collector/core/record/segments.mjs'
import { runQuery } from '../../src/query/named/index.mjs' // first: the named queries' registry imports session.mjs
import { PLAN_PER_MEMBER } from '../../src/query/named/session.mjs'
import { FOLD_STOPS } from '../../src/health/codes.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { within } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { readerBudget } from './past-room.mjs'

const WORKER = fileURLToPath(new URL('../../src/query/worker.mjs', import.meta.url))
const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const HEAP_MB = 64
const small = (h, ...argv) => fork(WORKER, [h, ...argv], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: ['--require', NO_REAL_OS, ...heapFlags(HEAP_MB)], env: workerEnv() })

const headOf = (home, id) => { try { return JSON.parse(gunzipSync(fs.readFileSync(headFile(home, id))).toString('utf8')) } catch { return null } }
async function until(home, id, ok, what) {
  return within((async () => { for (;;) { const h = headOf(home, id); if (h && ok(h)) return h; await new Promise((d) => setTimeout(d, 50)) } })(), 120_000, what)
}

test('3.5 #37: a kicked fold the heap holds no room for writes pending.stopped into the head; a fold that then succeeds clears it', { timeout: 240_000 }, async () => {
  const home = path.join(tmpDir('trocar-foldstop-'), '.trocar'), segment = '20261020T164737Z'
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const calls = Math.ceil(readerBudget(HEAP_MB) / PLAN_PER_MEMBER / 3)
  bigSession({ home, segment, wire: 'chat', growth: 20, compactAt: 0, subEvery: 0 }).append(calls)
  const [session] = (await runQuery('sessions', {}, { home })).sessions
  const id = session.session_id
  const died = []
  let svc = createQueryService({ home, fork: small, idleMs: 20_000, failure: (w, e) => died.push(`${e.code}: ${e.message}`) })
  try {
    svc.kick([recordId(segment, calls)])
    const h = await until(home, id, (d) => d.pending && d.pending.stopped, 'the stopped fold wrote its head')
    assert.equal(h.pending.stopped.code, 'heap-no-room')
    assert.ok(FOLD_STOPS.includes(h.pending.stopped.code), 'a FOLD_STOPS code')
    assert.equal(typeof h.pending.stopped.reason, 'string')
    assert.ok(h.pending.stopped.reason.length > 0 && !h.pending.stopped.reason.includes('\n'), 'the reason is one line')
    assert.deepEqual(died, [], 'the worker did not die: the fold stopped')
  } finally { svc.stop() }
  svc = createQueryService({ home, fork: workerFork, idleMs: 20_000 })
  try {
    svc.kick([recordId(segment, calls)])
    const h = await until(home, id, (d) => d.tier === 1 && d.pending === null, 'the fold that fits wrote a head at its frontier')
    assert.equal(h.pending, null, 'no stop is left in the head')
  } finally { svc.stop() }
})
