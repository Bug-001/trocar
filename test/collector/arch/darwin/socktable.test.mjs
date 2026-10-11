// test/collector/arch/darwin/socktable.test.mjs — the owner question's budget race as a regression (RFC 4.9 §2, the [本机] experiment ② write-back): a table that is not
// back inside its budget is SLOW, not unavailable — null with the cost said, never a failure record; the whole-table ask and the judgement of what came back are
// redirector.test's. The contrast case (a table that cannot be asked at all → one socktable-unavailable) is covered there too.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ownerOf } from '../../../../src/collector/arch/darwin/socktable.mjs'

const HOP = { port: 443 }

// the budget's timer is unref'd by design (a budget race must not keep a draining daemon alive); the real daemon's loop always has ref'd handles (its listeners),
// so the timer still fires there. A bare test process has none — the loop drains before the 20 ms budget ends and the runner cancels the test — so each budget
// test holds the loop alive for the race it is measuring. Every assertion stays: null, ms ≥ budget, no failure record.
const withAliveLoop = async (fn) => {
  const keepAlive = setInterval(() => {}, 1 << 30)
  try { return await fn() } finally { clearInterval(keepAlive) }
}

test('budget ②: a table that never answers inside its budget gives null with ms ≥ budget and writes no failure — the next connection asks again', async () => {
  const failures = []
  const r = await withAliveLoop(() => ownerOf({ exec: () => new Promise(() => {}), hop: HOP, candidates: [10], budgetMs: 20, onFailure: (rec) => failures.push(rec) }))
  assert.deepEqual([r.pid, r.source], [null, null])
  assert.ok(r.ms >= 20, `the cost says the budget was spent (${r.ms} ms)`)
  assert.deepEqual(failures, [], 'slow is not socktable-unavailable (D38 distinguishes them): no record')
})

test('budget ②: a runner that kills lsof at the budget (code:null, the answer arriving late) is the same answer — null, ms ≥ budget, no failure', async () => {
  const failures = []
  const r = await withAliveLoop(() => ownerOf({ exec: async () => ({ code: null, out: '', err: 'killed at the budget' }), hop: HOP, candidates: [10], budgetMs: 20, onFailure: (rec) => failures.push(rec) }))
  assert.deepEqual([r.pid, r.source], [null, null])
  assert.ok(r.ms >= 20, `the cost says the budget was spent (${r.ms} ms)`)
  assert.deepEqual(failures, [], 'the runner did its job: slow, not broken — no record')
})
