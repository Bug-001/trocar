import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSubagent, lane } from '../../src/identity/session-identity.mjs'
import { rec } from './fixtures.mjs'

test('isSubagent reads cc_is_subagent marker from system blocks', () => {
  assert.equal(isSubagent(rec('s', { sub: true })), true)
  assert.equal(isSubagent(rec('s')), false)
})

test('lane: probe (count_tokens) > subagent > main', () => {
  assert.equal(lane(rec('s', { endpoint: '/v1/messages/count_tokens?beta=true', llm: false })), 'probe')
  assert.equal(lane(rec('s', { sub: true })), 'subagent')
  assert.equal(lane(rec('s')), 'main')
})

test('probe precedence: a count_tokens under a subagent is still probe', () => {
  assert.equal(lane(rec('s', { sub: true, endpoint: '/v1/messages/count_tokens' })), 'probe')
})
