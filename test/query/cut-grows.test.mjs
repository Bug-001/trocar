// test/query/cut-grows.test.mjs — a session is cut only by what a fold of it measured, and a cut session that keeps growing never shows
// fewer than half of the calls that fit, nor more (RFC 3.5 §内存有界「截断只是兜底,按实测的堆截」: no cut and no refusal by the
// estimate; the cut on a grid of a tenth of the rows that fit, only forward, staying while it shows the fit less two steps).
//
// The cut is the plan's (planOf, src/query/named/session.mjs): what a read shows is the plan's `bound`. So the plan is grown here
// without records: members as index rows, the store's distinct blocks as its count, the rows that fit as a fold would have measured.
import test from 'node:test'
import assert from 'node:assert/strict'
import '../../src/query/named/index.mjs' // first: the named queries' registry imports session.mjs
import { planOf } from '../../src/query/named/session.mjs'

const T0 = Date.parse('2026-10-20T16:47:37Z')
const call = (i) => ({ id: `20261020T164737Z:${i + 1}`, ts: new Date(T0 + i * 1000).toISOString(), is_llm: true, stored_bytes: 2_000 + (i % 7) * 900, path: '/v1/messages' })
const ID = 'big-0000-4a1b-9c2d-000000000001'
const grown = (n) => Array.from({ length: n }, (_, i) => call(i))

test('3.5 §内存有界: a session no fold measured is read whole, however many members and blocks it has', () => {
  const store = { plan: null, defCount: 0 }
  let members = grown(1_000)
  for (let g = 0; g < 6; g++) {
    const p = planOf(members, 'cut-grows-whole', store, ID)
    assert.equal(p.bound, null, `${members.length} members, ${store.defCount} blocks: cut by no measurement`)
    assert.equal(p.read.length, members.length)
    members = members.concat(grown(4 * members.length).slice(members.length)) // 1,000 → 1,024,000 members
    store.defCount = 3 * members.length
  }
})

test('3.5 §内存有界: a growing measured cut never shows fewer than half of the calls that fit, nor more, and only moves forward', () => {
  const store = { plan: null, defCount: 0 }, FIT = 6_600
  let members = grown(8_000)
  const starts = []
  // 100 calls a growth, 120 growths: from 8,000 members to 20,000 with 6,600 that fit
  for (let g = 0; g < 120; g++) {
    const p = planOf(members, 'cut-grows', store, ID, FIT)
    const shown = p.bound ? p.bound.shown : members.length
    assert.ok(shown <= FIT, `growth ${g}: ${shown} calls shown, past the ${FIT} that fit`)
    assert.ok(shown >= Math.min(members.length, FIT / 2), `growth ${g}: ${shown} / ${members.length} calls shown, fewer than half of the ${FIT} that fit`)
    assert.ok(p.bound, `growth ${g}: ${members.length} members, ${FIT} fit, not cut`)
    const first = Number(p.read[0].id.split(':')[1])
    if (starts.length) assert.ok(first >= starts.at(-1), `growth ${g}: the cut moved back from call ${starts.at(-1)} to ${first}`)
    if (first !== starts.at(-1)) starts.push(first)
    const n = members.length
    members = members.concat(Array.from({ length: 100 }, (_, i) => call(n + i)))
    store.defCount += 80
  }
  // else this test proves nothing: the cut moved more than once, and stayed between moves
  assert.ok(starts.length > 2 && starts.length < 120, `the cut moved ${starts.length - 1} times in 120 growths`)
})
