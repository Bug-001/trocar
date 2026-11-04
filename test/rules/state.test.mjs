// test/rules/state.test.mjs — the state of a rule (RFC 5.1 §规则活着的定义, §序号; 1.6 C.5) and the facts it is judged on. Asserts the closed values and
// the files as written; a clock never decides an off.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ruleState, armedKey, readRuleFacts } from '../../src/rules/state.mjs'
import { RULE_STATES } from '../../src/rules/closed.mjs'
import { rulesState, rulesStats } from '../../src/paths.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const NOW = Date.parse('2026-11-05T12:00:00.000Z')
const LATER = '2026-11-05T12:00:30.000Z'
const EARLIER = '2026-11-05T11:59:30.000Z'
const armed = (over = {}) => ({
  name: 'r', on: 'request', match: { harness: ['claude-code'] }, do: [{ drop: true }], on_error: 'forward',
  armed: { off: 5, rules: 2 }, armed_at: '2026-11-05T10:00:00.000Z', ...over,
})
const facts = (over = {}) => ({ recording: new Set(['claude-code']), offSeq: { 'claude-code': 5 }, rulesOffSeq: 2, tripped: false, stats: {}, now: NOW, ...over })
const stat = (rule, entry) => ({ [rule.name]: { armed_key: armedKey(rule), ...entry } })

const r = armed()
const CASES = [
  ['live', r, facts()],
  ['resting', r, facts({ stats: stat(r, { resting_until: LATER }) })],
  ['live', r, facts({ stats: stat(r, { resting_until: EARLIER }) })],
  ['waiting', r, facts({ recording: new Set() })],
  ['stopped-by-off', r, facts({ offSeq: { 'claude-code': 6 } })],
  ['limit-reached', armed({ limit: { times: 3 } }), facts({ stats: stat(armed(), { limit_used: 3 }) })],
  ['live', armed({ limit: { times: 3 } }), facts({ stats: stat(armed(), { limit_used: 2 }) })],
  ['limit-reached', armed({ limit: { until: EARLIER } }), facts()],
  ['live', armed({ limit: { until: LATER } }), facts()],
  ['process-gone', r, facts({ stats: stat(r, { process_gone: true }) })],
  ['load-failed', r, facts({ stats: stat(r, { load_failed: true }) })],
  ['disabled', armed({ armed: undefined }), facts()],
  ['disabled', armed({ armed: null }), facts()],
  ['disabled', r, facts({ rulesOffSeq: 3 })],
  ['tripped', r, facts({ tripped: true })],
]
for (const [state, rule, f] of CASES) {
  test(`state ${state}: ${JSON.stringify({ armed: rule.armed, limit: rule.limit, stats: f.stats[rule.name], tripped: f.tripped, recording: [...f.recording] })}`, () => {
    assert.equal(ruleState(rule, f), state)
    assert.ok(RULE_STATES.includes(ruleState(rule, f)))
  })
}
test('every state of the closed set is reachable', () => {
  assert.deepEqual([...new Set(CASES.map(([state]) => state))].sort(), [...RULE_STATES].sort())
})

test('the sequence numbers decide, the clock does not: equal is live, behind is stopped, at any time', () => {
  for (const now of [0, NOW, NOW * 2]) {
    assert.equal(ruleState(r, facts({ now })), 'live')
    assert.equal(ruleState(r, facts({ now, offSeq: { 'claude-code': 6 } })), 'stopped-by-off')
    assert.equal(ruleState(r, facts({ now, rulesOffSeq: 3 })), 'disabled')
  }
  // armed_at later than everything does not bring it back
  assert.equal(ruleState(armed({ armed_at: '2099-01-01T00:00:00.000Z' }), facts({ offSeq: { 'claude-code': 6 } })), 'stopped-by-off')
})

test('armed.off may name a number per harness', () => {
  const rule = armed({ armed: { off: { 'claude-code': 5 }, rules: 2 } })
  assert.equal(ruleState(rule, facts()), 'live')
  assert.equal(ruleState(rule, facts({ offSeq: { 'claude-code': 6 } })), 'stopped-by-off')
})

test('a rule on many harnesses lives where it was not stopped (5.1: per harness)', () => {
  const on = (harness) => armed({ match: { harness } })
  const both = { recording: new Set(['claude-code', 'codex']) }
  assert.equal(ruleState(on(['claude-code', 'codex']), facts({ ...both, offSeq: { 'claude-code': 6, codex: 5 } })), 'live')
  assert.equal(ruleState(on(['claude-code', 'codex']), facts({ ...both, offSeq: { 'claude-code': 6, codex: 6 } })), 'stopped-by-off')
  // recording only where it was stopped: it waits for the other one's on
  assert.equal(ruleState(on(['claude-code', 'codex']), facts({ recording: new Set(['claude-code']), offSeq: { 'claude-code': 6, codex: 5 } })), 'waiting')
  assert.equal(ruleState(on('any'), facts({ ...both, offSeq: { 'claude-code': 6, codex: 5 } })), 'live')
  assert.equal(ruleState(on('any'), facts({ ...both, offSeq: { 'claude-code': 6, codex: 6 } })), 'stopped-by-off')
  assert.equal(ruleState(on('any'), facts({ recording: new Set(['opencode']), offSeq: {} })), 'live')
  assert.equal(ruleState(on('any'), facts({ recording: new Set(), offSeq: {} })), 'waiting')
})

test('counts from before the last rules enable do not stand against the rule', () => {
  const stale = { [r.name]: { armed_key: 'an earlier enable', load_failed: true, process_gone: true, limit_used: 9, resting_until: LATER } }
  assert.equal(ruleState(armed({ limit: { times: 3 } }), facts({ stats: stale })), 'live')
})

test('a rule named as an Object member reads no inherited stats', () => {
  assert.equal(ruleState(armed({ name: 'constructor' }), facts()), 'live')
})

const homeWith = (files) => {
  const home = tmpDir('trocar-rule-facts-')
  fs.mkdirSync(path.join(home, 'collector'), { recursive: true })
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(file === 'state' ? path.join(home, 'collector', 'state.json') : file === 'rules-state' ? rulesState(home) : rulesStats(home), text)
  return home
}

test('the facts as the files say them: on is recording, off_seq per harness, no sequence yet is 0', () => {
  const home = homeWith({
    state: JSON.stringify({ version: 2, harnesses: { 'claude-code': { desired: 'on', off_seq: 4 }, codex: { desired: 'off', off_seq: 7 }, opencode: { desired: 'on' } } }),
    'rules-state': JSON.stringify({ rules_off_seq: 3, unclean_stops: 2, live: true, boot_id: 'b' }),
    stats: JSON.stringify({ at: LATER, rules: { r: { armed_key: 'k', changes: 4, not_applied_by: { timeout: 2 } } } }),
  })
  const { facts: f, errors } = readRuleFacts({ home, fs, now: () => NOW })
  assert.deepEqual(errors, [])
  assert.deepEqual([...f.recording].sort(), ['claude-code', 'opencode'])
  assert.deepEqual(f.offSeq, { 'claude-code': 4, codex: 7, opencode: 0 })
  assert.equal(f.rulesOffSeq, 3)
  assert.equal(f.tripped, true)
  assert.equal(f.now, NOW)
  assert.equal(f.stats.r.changes, 4)
})

test('one unclean stop does not trip', () => {
  const home = homeWith({ 'rules-state': JSON.stringify({ unclean_stops: 1 }) })
  assert.equal(readRuleFacts({ home, fs }).facts.tripped, false)
})

test('no files at all: all zero, nothing recording, nothing wrong', () => {
  const { facts: f, errors } = readRuleFacts({ home: tmpDir('trocar-rule-facts-'), fs, now: () => NOW })
  assert.deepEqual(errors, [])
  assert.deepEqual({ recording: [...f.recording], offSeq: f.offSeq, rulesOffSeq: f.rulesOffSeq, tripped: f.tripped, stats: f.stats }, { recording: [], offSeq: {}, rulesOffSeq: 0, tripped: false, stats: {} })
})

test('a rules-state.json that cannot be read counts as rules off (5.1: 读不了走 rules off 同一个函数), and says so', () => {
  const home = homeWith({ 'rules-state': '{not json' })
  const { facts: f, errors } = readRuleFacts({ home, fs, now: () => NOW })
  assert.equal(errors.length, 1)
  assert.equal(ruleState(r, { ...facts(), rulesOffSeq: f.rulesOffSeq }), 'disabled')
})

test('a state.json that cannot be read says so and records nothing', () => {
  const home = homeWith({ state: '{not json' })
  const { facts: f, errors } = readRuleFacts({ home, fs, now: () => NOW })
  assert.equal(errors.length, 1)
  assert.deepEqual([...f.recording], [])
})
