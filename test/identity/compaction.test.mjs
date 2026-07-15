import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markCompaction, forkOf } from '../../src/identity/session-identity.mjs'
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
