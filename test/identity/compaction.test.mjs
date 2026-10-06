import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markCompaction, forkOf, compactionVerdict } from '../../src/identity/session-identity.mjs'
import { boardCompactionDrop } from '../../src/view/analyze.mjs'
import { rec } from './fixtures.mjs'

test('markCompaction: message-count drop within a session flags compaction with from/to', () => {
  assert.deepEqual(markCompaction(42, 6), { compaction: true, compaction_from: 42, compaction_to: 6 })
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
  assert.deepEqual(v({ msgCount: 9, marker: false }, { msgCount: 2 }), [true, 9, 2, 'msg-count-drop'])
  assert.deepEqual(v(null, { msgCount: 2 }), [false, null, null, null])
})

test('compactionVerdict: a drop rule replaces only the last step (the board passes its own threshold)', () => {
  const prev = { msgCount: 58, marker: false }
  assert.equal(compactionVerdict(prev, { msgCount: 55 }).compaction, true, 'the ETL: any drop')
  assert.equal(compactionVerdict(prev, { msgCount: 55 }, boardCompactionDrop).compaction, false, 'the board: a small drop alone is not enough')
  assert.equal(compactionVerdict(prev, { msgCount: 55, preamble: true }, boardCompactionDrop).compaction, true, 'unless CC says it continued a conversation')
  assert.equal(compactionVerdict({ msgCount: 55, marker: false }, { msgCount: 4 }, boardCompactionDrop).compaction, true)
  assert.equal(compactionVerdict(prev, { hint: true, msgCount: 60 }, boardCompactionDrop).basis, 'hint', 'a hint never consults the drop rule')
})

