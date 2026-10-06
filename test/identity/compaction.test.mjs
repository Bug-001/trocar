import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markCompaction, forkOf, compactionVerdict, hasCompactionPreamble } from '../../src/identity/session-identity.mjs'
import { rec } from './fixtures.mjs'

test('markCompaction: a sharp message-count drop flags compaction with from/to', () => {
  assert.deepEqual(markCompaction(42, 6), { compaction: true, compaction_from: 42, compaction_to: 6 })
  assert.deepEqual(markCompaction(55, 4), { compaction: true, compaction_from: 55, compaction_to: 4 }, 'the real CC compaction')
})

test('markCompaction: growth (normal turn) is NOT compaction', () => {
  assert.deepEqual(markCompaction(6, 8), { compaction: false, compaction_from: null, compaction_to: null })
})

test('markCompaction: equal count (retry, same length) is NOT compaction', () => {
  assert.deepEqual(markCompaction(10, 10), { compaction: false, compaction_from: null, compaction_to: null })
})

test('compaction is NOT a fork: forkOf stays null regardless of drop', () => {
  // Compaction marks calls.compaction; it MUST NOT populate sessions.fork_of (RFC 3.4 "关键区分").
  assert.deepEqual(forkOf(rec('s')), { fork_of_session_id: null, forked_at_seq: null })
})

test('compactionVerdict: hint first, a marker on its rising edge only, else the drop; no predecessor → from NULL', () => {
  const v = (prev, cur) => { const { compaction, compaction_from, compaction_to, basis } = compactionVerdict(prev, cur); return [compaction, compaction_from, compaction_to, basis] }
  assert.deepEqual(v(null, { hint: true, msgCount: 3 }), [true, null, 3, 'hint'], 'a hint on a lane\'s first call: compaction, from unknown')
  assert.deepEqual(v({ msgCount: 3, marker: false }, { hint: true, msgCount: 5 }), [true, 3, 5, 'hint'], 'a hint needs no drop')
  assert.deepEqual(v(null, { marker: true, msgCount: 4 }), [false, null, null, null], 'no predecessor, no rising edge')
  assert.deepEqual(v({ msgCount: 4, marker: false }, { marker: true, msgCount: 5 }), [true, 4, 5, 'marker'])
  assert.deepEqual(v({ msgCount: 5, marker: true }, { marker: true, msgCount: 6 }), [false, null, null, null], 'the marker stays in the history')
  assert.deepEqual(v({ msgCount: 9, marker: false }, { msgCount: 2 }), [true, 9, 2, 'msg-count-drop'], 'a sharp drop')
  assert.deepEqual(v({ msgCount: 9, marker: false }, { msgCount: 8 }), [false, null, null, null], 'a small one is no evidence')
  assert.deepEqual(v(null, { msgCount: 2 }), [false, null, null, null])
})

// 3.4 「骤降」: without a harness marker or request only a SHARP drop counts — at least 6 fewer AND
// under 70% of the lane's count — one rule for the ETL and the board. On a real CC session the main lane goes 58 → 55
// (not a compaction) before the real 55 → 4.
test('markCompaction: a small drop is not a compaction, a sharp one is; the edges of "sharp"', () => {
  const is = (from, to, cur) => markCompaction(from, to, cur).compaction
  assert.equal(is(58, 55), false, 'the real CC 58 → 55')
  assert.equal(is(55, 4), true, 'the real CC 55 → 4')
  assert.equal(is(10, 5), false, 'exactly 5 fewer is not enough')
  assert.equal(is(10, 4), true, '6 fewer and under 70%')
  assert.equal(is(100, 71), false, '29 fewer but 71% is not under 70%')
  assert.equal(is(100, 69), true)
  assert.equal(is(3, 2), false, 'a drop of one is never sharp')
  assert.deepEqual(markCompaction(58, 55), { compaction: false, compaction_from: null, compaction_to: null }, 'no evidence: from / to stay NULL')
})

// Review (3.4): the stated rule is "only a sharp drop"; CC's preamble is a refinement on top
// of it, and the preamble stays in the first messages of EVERY later call of a compacted lane. Counted on every call it
// carries, any one-message dip after a compaction (30 → 27 on a lane that already holds 30) would be a compaction too. So
// it counts on its rising edge only, like the text marker: the call that brings it in, not the calls that carry it.
test('compactionVerdict: CC\'s preamble lets a small drop count on its rising edge only; carried in the history it is no evidence', () => {
  const v = (prev, cur) => { const { compaction, compaction_from, compaction_to, basis } = compactionVerdict(prev, cur); return [compaction, compaction_from, compaction_to, basis] }
  const none = [false, null, null, null]
  assert.deepEqual(v({ msgCount: 58, marker: false, preamble: false }, { msgCount: 55, preamble: true }), [true, 58, 55, 'msg-count-drop'], 'the call that brings the preamble in: a small drop counts')
  assert.deepEqual(v({ msgCount: 58, marker: false }, { msgCount: 55, preamble: true }), [true, 58, 55, 'msg-count-drop'], 'a predecessor that says nothing about a preamble had none')
  assert.deepEqual(v({ msgCount: 30, marker: false, preamble: true }, { msgCount: 27, preamble: true }), none, 'carried: 30 → 27 long after a compaction is no compaction')
  assert.deepEqual(v({ msgCount: 8, marker: false, preamble: true }, { msgCount: 7, preamble: true }), none, 'carried: a single message fewer')
  assert.deepEqual(v({ msgCount: 8, marker: false, preamble: true }, { msgCount: 6 }), none, 'a drop that takes the preamble away is no evidence either')
  assert.deepEqual(v({ msgCount: 30, marker: false, preamble: true }, { msgCount: 4, preamble: true }), [true, 30, 4, 'msg-count-drop'], 'a second compaction is a sharp drop and needs no preamble')
  assert.deepEqual(v({ msgCount: 30, marker: false, preamble: true }, { hint: true, msgCount: 27, preamble: true }), [true, 30, 27, 'hint'], 'a harness hint is judged first, whatever the preamble does')
})

test('markCompaction: any drop that carries CC\'s own preamble counts; growth never does', () => {
  assert.equal(markCompaction(8, 6, { preamble: true }).compaction, true)
  assert.equal(markCompaction(8, 6, { preamble: false }).compaction, false)
  assert.equal(markCompaction(6, 6, { preamble: true }).compaction, false, 'a preamble with no drop is not a compaction')
  assert.equal(markCompaction(6, 8, { preamble: true }).compaction, false)
})

test('hasCompactionPreamble: CC\'s "continued from a previous conversation" in the first four messages, text or blocks', () => {
  const P = 'This session is being continued from a previous conversation that ran out of context.'
  assert.equal(hasCompactionPreamble([{ role: 'user', content: P }]), true)
  assert.equal(hasCompactionPreamble([{ role: 'user', content: [{ type: 'text', text: 'x' }] }, { role: 'assistant', content: [{ type: 'text', text: P }] }]), true)
  assert.equal(hasCompactionPreamble([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'user', content: 'c' }, { role: 'user', content: 'd' }, { role: 'user', content: P }]), false, 'only the first four')
  assert.equal(hasCompactionPreamble([{ role: 'user', content: [{ type: 'tool_result', content: P }] }]), false, 'a block that is not text')
  assert.equal(hasCompactionPreamble(undefined), false)
  assert.equal(hasCompactionPreamble([null, {}]), false)
})

test('compactionVerdict is one rule: the same prev and cur give the same answer for the ETL and the board (no second drop rule to pass)', () => {
  const prev = { msgCount: 58, marker: false }
  assert.equal(compactionVerdict.length, 2, 'two parameters: prev, cur — the drop rule is not injectable')
  assert.equal(compactionVerdict(prev, { msgCount: 55 }).compaction, false, 'a small drop alone is not enough')
  assert.equal(compactionVerdict(prev, { msgCount: 55, preamble: true }).compaction, true, 'unless CC says it continued a conversation')
  assert.deepEqual(compactionVerdict({ msgCount: 55, marker: false }, { msgCount: 4 }), { compaction: true, compaction_from: 55, compaction_to: 4, basis: 'msg-count-drop' })
  assert.equal(compactionVerdict(prev, { hint: true, msgCount: 60 }).basis, 'hint', 'a hint never consults the drop rule')
  assert.equal(compactionVerdict({ msgCount: 4, marker: false }, { marker: true, msgCount: 5 }).basis, 'marker', 'a marker on its rising edge needs no drop')
})
