// test/query/cold-fit.test.mjs — a session cut by nothing but the read side's estimate is folded whole from the first slice and never
// refused (RFC 3.5 §内存有界「截断只是兜底,按实测的堆」, §后台抽取与归约「从第一片起归约前沿就往前走」, 验收 #11).
//
// The real service and the real worker fork with a small heap, over a temp HOME, read the way the board follows a session. The
// session's estimate (its members at PLAN_PER_MEMBER, its rows at SPINE_PER_ROW, beside the work W and the fixed caches K) is past the
// worker's budget, while what its fold really holds is not: a cut by that estimate would show the newest few calls, or no call at
// all, of a session the heap holds whole (e.g. a 210,000-call session in a 384 MB worker answered 500 "no room" with 100 MB
// live; 5,000 calls in a 130 MB worker answered 500 at the first read with 47 MB resident).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createQueryService } from '../../src/query/service.mjs'
import { heapFlags, workerEnv } from '../../src/query/warm.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import '../../src/query/named/index.mjs' // first: the named queries' registry imports session.mjs
import { SPINE_PER_ROW, PLAN_PER_MEMBER, CACHES, working } from '../../src/query/named/session.mjs'
import { within } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'

const WORKER = fileURLToPath(new URL('../../src/query/worker.mjs', import.meta.url))
const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const MB = 1 << 20, HEAP_MB = 130

const recorder = () => {
  const r = { status: null, chunks: [] }
  return Object.assign(r, { writeHead: (s) => { r.status = s }, write: (b) => { r.chunks.push(b); return true }, end: () => {}, once: () => {}, text: () => Buffer.concat(r.chunks).toString('utf8') })
}

test('3.5 §内存有界: a session past the estimate whose fold fits is folded from the first slice, answered 200 every time and shown whole', { timeout: 240_000 }, async () => {
  const home = path.join(tmpDir('trocar-coldfit-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  // many subagent lanes side by side, small bodies, the main context compacted: many members, each cheap
  const s = bigSession({ home, growth: 60, subEvery: 2, subLanes: 12, subLen: 54, late: 6, compactAt: 18_000 })
  s.append(5_000)
  const members = sessionGroups(await indexRows({ home, errors: [] })).get(s.id)
  // else this test proves nothing: the estimate's room in this heap holds fewer rows than the session has
  const room = (HEAP_MB * MB * 2) / 3 - working(members) - members.length * PLAN_PER_MEMBER - CACHES
  assert.ok(room < members.length * SPINE_PER_ROW, `the estimate's room (${(room / MB).toFixed(1)} MB) holds the ${members.length} calls`)
  const failed = []
  const svc = createQueryService({ home, failure: (w, e) => failed.push(`${e.code}: ${e.message}`),
    fork: (h, ...argv) => fork(WORKER, [h, ...argv], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: ['--require', NO_REAL_OS, ...heapFlags(HEAP_MB)], env: workerEnv() }) })
  try {
    const answers = []
    for (const t0 = Date.now(); ;) {
      const res = recorder()
      await within(svc.relay({ name: 'session', params: { id: s.id, limit: '60' }, res }), 60_000, 'the session answered')
      const text = res.text(), doc = res.status === 200 ? JSON.parse(text) : null
      answers.push({ status: res.status, error: doc ? null : text.slice(0, 300), mark: doc && doc.mark, done: doc && doc.pending ? doc.pending.done : null, doc })
      assert.equal(res.status, 200, `answer ${answers.length}: ${text.slice(0, 300)}`)
      if (!doc.pending) break
      assert.ok(Date.now() - t0 < 180_000, 'the session folded within 180 s')
      await new Promise((d) => setTimeout(d, 100))
    }
    // the first answer is at a reduction frontier already (its request's slice folded what it extracted), and the frontier moved on
    // while extraction went on: not held until extraction passed a cut
    assert.ok(answers[0].mark != null, `the first answer has no frontier (pending ${JSON.stringify(answers[0].doc.pending)})`)
    const last = answers.at(-1).doc
    assert.equal(last.truncated, null, `the session is shown whole, not cut by the estimate: ${JSON.stringify(last.truncated)}`)
    assert.equal(last.lanes.reduce((n, l) => n + l.count, 0), members.length, 'the lanes count every call of the session')
    assert.deepEqual(failed, [], 'no query worker died')
  } finally { svc.stop() }
})
