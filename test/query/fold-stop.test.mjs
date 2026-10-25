// test/query/fold-stop.test.mjs — a background fold that stops is a persistent fact in the session's head (RFC 3.5 §会话读
// 「`session --head`」 pending.stopped, 验收 #37; D38②). The real service and the real worker over a temp HOME: a worker forked with a
// heap whose live heap is past its own budget before it folds a row holds no room for any row of the session, so the kicked fold
// stops with heap-no-room; a worker with the service's own heap then folds the session and the stop is gone from its head.
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
import { FOLD_STOPS } from '../../src/health/codes.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { within } from '../helpers/bounded.mjs'
import { rawHome } from './raw-home.mjs'

const WORKER = fileURLToPath(new URL('../../src/query/worker.mjs', import.meta.url))
const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
// a started worker's live heap is about 11 MB (measured 2026-10-25, node 22): in a 16 MB heap it is past the budget (two thirds of the
// limit) before a row is folded, with room left to read the index and the two records (30 of 30 runs); 15 MB died of the heap in a
// quarter of the runs, 18 MB folds the session
const tiny = (h, ...argv) => fork(WORKER, [h, ...argv], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: ['--require', NO_REAL_OS, ...heapFlags(16)], env: workerEnv() })

const line = (n) => JSON.stringify({ ts: `2026-10-25T09:00:0${n}.000Z`, endpoint: '/v1/chat/completions', method: 'POST',
  req_headers: { 'content-type': 'application/json' }, req_body: JSON.stringify({ model: 'm', prompt_cache_key: 'fold-stop-1', messages: [{ role: 'user', content: `ask ${n}` }] }),
  resp: { status: 200, kind: 'json', body: { choices: [{ message: { role: 'assistant', content: `answer ${n}` } }] } },
  id: `req_${n}`, ts_request: `2026-10-25T09:00:0${n}.000Z`, is_llm_call: true, capture: 'transparent', host: 'api.example.test', traffic_class: 'llm',
  proc: { pid: 9, exe: '/x/kimi', agent: 'kimi' } })

const headOf = (home, id) => { try { return JSON.parse(gunzipSync(fs.readFileSync(headFile(home, id))).toString('utf8')) } catch { return null } }
async function until(home, id, ok, what) {
  return within((async () => { for (;;) { const h = headOf(home, id); if (h && ok(h)) return h; await new Promise((d) => setTimeout(d, 50)) } })(), 30_000, what)
}

test('3.5 #37: a kicked fold the heap holds no room for writes pending.stopped into the head; a fold that then succeeds clears it', { timeout: 90_000 }, async () => {
  const home = rawHome('trocar-foldstop-'), segment = '20261025T090000Z'
  fs.appendFileSync(path.join(home, 'raw', `${segment}.ndjson`), [line(1), line(2)].join('\n') + '\n', { mode: 0o600 })
  const { runQuery } = await import('../../src/query/named/index.mjs')
  const [session] = (await runQuery('sessions', {}, { home })).sessions
  const id = session.session_id
  const died = []
  let svc = createQueryService({ home, fork: tiny, idleMs: 20_000, failure: (w, e) => died.push(`${e.code}: ${e.message}`) })
  try {
    svc.kick([recordId(segment, 2)])
    const h = await until(home, id, (d) => d.pending && d.pending.stopped, 'the stopped fold wrote its head')
    assert.equal(h.pending.stopped.code, 'heap-no-room')
    assert.ok(FOLD_STOPS.includes(h.pending.stopped.code), 'a FOLD_STOPS code')
    assert.equal(typeof h.pending.stopped.reason, 'string')
    assert.ok(h.pending.stopped.reason.length > 0 && !h.pending.stopped.reason.includes('\n'), 'the reason is one line')
    assert.deepEqual(died, [], 'the worker did not die: the fold stopped')
  } finally { svc.stop() }
  svc = createQueryService({ home, fork: workerFork, idleMs: 20_000 })
  try {
    svc.kick([recordId(segment, 2)])
    const h = await until(home, id, (d) => d.tier === 1 && d.pending === null, 'the fold that fits wrote a head at its frontier')
    assert.equal(h.pending, null, 'no stop is left in the head')
  } finally { svc.stop() }
})
