// test/query/cut-grows.test.mjs — a cut session that keeps growing never shows fewer than half of the calls that fit, nor more than
// fit (RFC 3.5 §内存有界: the segment index rows, the distinct blocks, the plan's members and K, never cut, count at their bytes; the
// cut only moves forward and stays while it shows the fit less two steps; no room for one row is a non-2xx error, never a sliver).
//
// The blocks and the members grow with every call, so the room for the cut's rows shrinks as the session grows. Charged in whole
// steps of a tenth of the budget, the blocks crossing a step took a step (8.9 MB in a 128 MB reader) out of a room of ~3 MB and the
// session showed 1 call of 12,429 while 14,290 fit (2026-10-23). The cut is the plan's (planOf, src/query/named/session.mjs): what
// a read shows is the plan's `bound`, and a fold of rows that cost what the plan reckons does not cut further (cut-fits.test.mjs
// case 1), so the plan is grown here without records: members as index rows, the store's distinct blocks as its count. The blocks
// take all but a few MB of this process's budget, so the room is a cut session's room in a small reader; each growth adds calls
// and blocks until no row fits, and each plan is held against the fit the spec's formula gives at that moment.
import test from 'node:test'
import assert from 'node:assert/strict'
import '../../src/query/named/index.mjs' // first: the named queries' registry imports session.mjs
import { planOf, working, SPINE_PER_ROW, SPINE_PER_BLOCK, PLAN_PER_MEMBER, CACHES } from '../../src/query/named/session.mjs'
import { heapBudget, steadyBytes } from '../../src/query/warm.mjs'

const MB = 1048576
const T0 = Date.parse('2026-10-20T16:47:37Z')
const call = (i) => ({ id: `20261020T164737Z:${i + 1}`, ts: new Date(T0 + i * 1000).toISOString(), is_llm: true, stored_bytes: 2_000 + (i % 7) * 900, path: '/v1/messages' })

test('3.5 §内存有界: a growing cut session never shows fewer than half of the calls that fit, nor more', () => {
  const store = { plan: null, defCount: 0 }, step = heapBudget() / 10
  let members = Array.from({ length: 8_000 }, (_, i) => call(i))
  // the fit at this moment: (budget − work − index rows − blocks × SPINE_PER_BLOCK − members × PLAN_PER_MEMBER − K) / SPINE_PER_ROW
  const fit = () => Math.floor((heapBudget() - working(members) - steadyBytes() - store.defCount * SPINE_PER_BLOCK - members.length * PLAN_PER_MEMBER - CACHES) / SPINE_PER_ROW)
  // blocks enough to leave a room of 5 MB: 6,600 calls fit of 8,000
  store.defCount = Math.floor((heapBudget() - working(members) - steadyBytes() - members.length * PLAN_PER_MEMBER - CACHES - 5 * MB) / SPINE_PER_BLOCK)
  const starts = new Set(), seen = []
  // 100 calls and 80 blocks a growth (~49 KB of room), 120 growths: from 6,600 calls that fit to none
  for (let g = 0; g < 120; g++) {
    const f = fit()
    let p = null, error = null
    try { p = planOf(members, 'cut-grows', store, 'big-0000-4a1b-9c2d-000000000001') } catch (e) { error = e }
    if (error) assert.ok(f < 1, `growth ${g}: "${error.message}" while ${f} calls fit`)
    else {
      const shown = p.bound ? p.bound.shown : members.length
      assert.ok(f >= 1, `growth ${g}: ${shown} calls shown where none fit (no room is an error)`)
      assert.ok(shown >= Math.min(members.length, Math.floor(f / 2)), `growth ${g}: ${shown} / ${members.length} calls shown, fewer than half of the ${f} that fit`)
      assert.ok(shown <= f, `growth ${g}: ${shown} calls shown, each at ${SPINE_PER_ROW} B, past the ${f} that fit`)
      if (p.bound) starts.add(p.read[0].id)
    }
    seen.push({ f, error: !!error })
    const n = members.length
    members = members.concat(Array.from({ length: 100 }, (_, i) => call(n + i)))
    store.defCount += 80
  }
  // else this test proves nothing: cut on every read with room, the cut moved more than once, and reads with no room at the end
  assert.ok(starts.size > 2, `the cut moved ${starts.size - 1} times`)
  assert.ok(seen.some((r) => r.error) && seen.some((r) => !r.error), `${seen.filter((r) => r.error).length} of ${seen.length} reads had no room`)
  assert.ok(step > 5 * MB, 'the room is under one step of the budget (the whole-step rounding took it all)')
})
