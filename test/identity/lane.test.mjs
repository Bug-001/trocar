import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSubagent, isMonitor, lane } from '../../src/identity/session-identity.mjs'
import { rec } from './fixtures.mjs'

const MONITOR_SYS = [{ type: 'text', text: 'You are a security monitor for autonomous AI coding agents. Review the transcript.' }]

test('isSubagent reads cc_is_subagent marker from system blocks', () => {
  assert.equal(isSubagent(rec('s', { sub: true })), true)
  assert.equal(isSubagent(rec('s')), false)
})

test('isMonitor reads the security-monitor system marker', () => {
  assert.equal(isMonitor(rec('s', { system: MONITOR_SYS })), true)
  assert.equal(isMonitor(rec('s')), false)
})

test('lane: probe (count_tokens) > subagent > main', () => {
  assert.equal(lane(rec('s', { endpoint: '/v1/messages/count_tokens?beta=true', llm: false })), 'probe')
  assert.equal(lane(rec('s', { sub: true })), 'subagent')
  assert.equal(lane(rec('s')), 'main')
})

test('lane: monitor (security-monitor system marker)', () => {
  assert.equal(lane(rec('s', { system: MONITOR_SYS })), 'monitor')
  // monitor even when it runs on a small model (marker wins over aux)
  assert.equal(lane(rec('s', { system: MONITOR_SYS, model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 't' }] })), 'monitor')
})

test('lane: aux (small background model + tiny message array: notify/titlegen/quota)', () => {
  assert.equal(lane(rec('s', { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'quota' }] })), 'aux')
  // a haiku call with a long conversation is NOT aux (guard against misclassifying a real turn)
  const longMsgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `m${i}` }))
  assert.notEqual(lane(rec('s', { model: 'claude-haiku-4-5', messages: longMsgs })), 'aux')
  // subagents run the main model, so a subagent is never misread as aux
  assert.equal(lane(rec('s', { sub: true, model: 'claude-opus-4-8' })), 'subagent')
})

test('probe precedence: a count_tokens under a subagent is still probe', () => {
  assert.equal(lane(rec('s', { sub: true, endpoint: '/v1/messages/count_tokens' })), 'probe')
})
