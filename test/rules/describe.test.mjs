// test/rules/describe.test.mjs — what `trocar query rules` says about one rule (RFC 1.6 C.5, 5.1 §三档开销). Expected tiers and buffers are written by
// hand from those two tables, along the action kinds and the positions; every rule here passes checkRule first, so none is a shape the file cannot hold.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { summaryOf, ruleSha256, tierOfRule, buffersOf, resendOk } from '../../src/rules/describe.mjs'
import { checkRule } from '../../src/rules/validate.mjs'
import { BUFFERS } from '../../src/rules/closed.mjs'

const HOST = { harness: 'claude-code', host: 'api.anthropic.com' }
const make = (actions, { on = 'request', match = HOST, whole } = {}) => {
  const rule = { name: 'r', on, ...(whole === undefined ? {} : { whole }), match, do: [].concat(actions), on_error: 'forward' }
  assert.deepEqual(checkRule(rule), [], JSON.stringify(rule))
  return rule
}

const ACTIONS = {
  'regex replace': [{ replace: 'a+', with: 'b' }, 2],
  'literal replace of fast characters': [{ replace: 'alpha', with: 'beta', literal: true }, 1],
  'literal replace with nothing': [{ replace: 'alpha', with: '', literal: true }, 1],
  'literal replace that needs escaping': [{ replace: '<tag>', with: 'x', literal: true }, 2],
  'literal replace of a value that needs escaping': [{ replace: 'alpha', with: 'a"b', literal: true }, 2],
  'literal replace on the raw body': [{ replace: '<tag>', with: 'a"b', literal: true, in: 'body' }, 1],
  'literal replace over 256 bytes': [{ replace: 'a'.repeat(257), with: 'x', literal: true, in: 'body' }, 2],
  'literal replace inside blocks': [{ replace: 'alpha', with: 'beta', literal: true, blocks: { role: 'user' } }, 2],
  json: [{ json: '/model', set: 'm' }, 2],
  blocks: [{ blocks: { role: 'user' }, remove: true }, 2],
  script: [{ script: '/abs/s.mjs' }, 2],
  header: [{ header: 'x-a', set: 'b' }, 0],
  hold: [{ hold: true, release_after_ms: 1000 }, 0],
  drop: [{ drop: true }, 0],
  delay: [{ delay_ms: 10 }, 0],
  reply: [{ reply: { status: 429 } }, 0],
}

for (const [label, [action, tier]] of Object.entries(ACTIONS)) {
  test(`tier of a rule on the index alone: ${label} is ${tier}`, () => assert.equal(tierOfRule(make(action)), tier))
}

const CONDITIONS = [
  ['harness only', { harness: 'any' }, 0],
  ['an exact host list', { harness: 'any', host: ['a.example', 'b.example'] }, 0],
  ['a wildcard host', { harness: 'any', host: '*.example' }, 1],
  ['a regex host', { harness: 'any', host: { re: 'a.*' } }, 2],
  ['a pid', { pid: 7 }, 1],
  ['a path', { ...HOST, path: '/v1/*' }, 1],
  ['a header', { ...HOST, header: { 'x-a': 'b' } }, 1],
  ['a regex header', { ...HOST, header: { 'x-a': { re: 'b+' } } }, 2],
  ['a fast body literal', { ...HOST, body: 'alpha' }, 1],
  ['a body literal off the fast path', { ...HOST, body: '<tag>' }, 2],
  ['a literal over 256 bytes', { ...HOST, path: `/${'a'.repeat(256)}` }, 2],
  ['a block selector', { ...HOST, blocks: { role: 'user' } }, 2],
]
for (const [label, match, tier] of CONDITIONS) {
  test(`tier of a rule whose costliest condition is ${label}: ${tier}`, () => assert.equal(tierOfRule(make({ drop: true }, { match })), tier))
}
test('a rule is as dear as its dearest step, whichever side it is on', () => {
  assert.equal(tierOfRule(make([{ header: 'x-a', set: 'b' }, { json: '/m', set: 1 }], { match: { ...HOST, path: '/v1' } })), 2)
  assert.equal(tierOfRule(make({ json: '/m', set: 1 }, { match: { ...HOST, path: '/v1' } })), 2)
  assert.equal(tierOfRule(make({ replace: 'alpha', with: 'beta', literal: true }, { match: { ...HOST, path: { re: 'a' } } })), 2)
})

const BODY = { ...HOST, body: 'alpha' }
const BUFFER_CASES = [
  ['request, head only', make({ header: 'x-a', set: 'b' }), 'none'],
  ['request, delay', make({ delay_ms: 10 }), 'none'],
  ['request, body condition', make({ drop: true }, { match: BODY }), 'request'],
  ['request, block condition', make({ drop: true }, { match: { ...HOST, blocks: { role: 'user' } } }), 'request'],
  ['request, replace', make({ replace: 'a', with: 'b' }), 'request'],
  ['request, json', make({ json: '/m', set: 1 }), 'request'],
  ['request, blocks', make({ blocks: { role: 'user' }, remove: true }), 'request'],
  ['request, script', make({ script: '/abs/s.mjs' }), 'request'],
  ['request, reply', make({ reply: { status: 429 } }), 'request'],
  ['request, hold', make({ hold: true, release_after_ms: 1000 }), 'request'],
  ['response, head only', make({ header: 'x-a', set: 'b' }, { on: 'response' }), 'none'],
  ['response, body condition', make({ drop: true }, { on: 'response', match: BODY }), 'stream'],
  ['response, replace', make({ replace: 'a', with: 'b' }, { on: 'response' }), 'stream'],
  ['response, inject (a position in the events)', make({ inject: 'data: x\n\n' }, { on: 'response' }), 'stream'],
  ['response, event_index (a position in the events)', make({ delay_ms: 10 }, { on: 'response', match: { ...HOST, event_index: 0 } }), 'stream'],
  ['response whole, head only', make({ header: 'x-a', set: 'b' }, { on: 'response', whole: true }), 'response'],
  ['response whole, replace', make({ replace: 'a', with: 'b' }, { on: 'response', whole: true }), 'response'],
  ['response whole, hold', make({ hold: true, release_after_ms: 1000 }, { on: 'response', whole: true }), 'response'],
  ['ws-client, replace', make({ replace: 'a', with: 'b' }, { on: 'ws-client' }), 'message'],
  ['ws-client, drop', make({ drop: true }, { on: 'ws-client' }), 'message'],
  ['ws-server, inject', make({ inject: 'x' }, { on: 'ws-server' }), 'message'],
]
for (const [label, rule, buffers] of BUFFER_CASES) {
  test(`buffers of ${label}: ${buffers}`, () => {
    assert.equal(buffersOf(rule), buffers)
    assert.ok(BUFFERS.includes(buffersOf(rule)))
  })
}

test('resend takes a request rule whose actions are all modifications, and no other', () => {
  const modify = [{ replace: 'a', with: 'b' }, { header: 'x-a', set: 'b' }, { json: '/m', set: 1 }, { blocks: { role: 'user' }, remove: true }, { script: '/abs/s.mjs' }]
  for (const action of modify) assert.equal(resendOk(make(action)), true, JSON.stringify(action))
  assert.equal(resendOk(make(modify.slice(0, 4))), true)
  for (const action of [{ hold: true, release_after_ms: 1000 }, { drop: true }, { delay_ms: 10 }, { reply: { status: 429 } }]) {
    assert.equal(resendOk(make(action)), false, JSON.stringify(action))
    assert.equal(resendOk(make([{ header: 'x-a', set: 'b' }, action])), false, JSON.stringify(action))
  }
  assert.equal(resendOk(make({ replace: 'a', with: 'b' }, { on: 'response' })), false)
  assert.equal(resendOk(make({ replace: 'a', with: 'b' }, { on: 'ws-client' })), false)
})

test('the rule\'s hash leaves out what rules enable writes, and nothing else', () => {
  const rule = make({ drop: true })
  const hash = createHash('sha256').update(JSON.stringify(rule)).digest('hex')
  assert.equal(ruleSha256(rule), hash)
  const enabled = { ...rule, armed: { off: 3, rules: 1 }, armed_at: '2026-11-05T00:00:00.000Z', script_entry_sha256: 'a'.repeat(64) }
  assert.equal(ruleSha256(enabled), hash)
  assert.notEqual(ruleSha256({ ...rule, on_error: 'drop' }), hash)
})

test('every kind of rule gets a sentence', () => {
  const rules = [...Object.values(ACTIONS).map(([action]) => make(action)), ...BUFFER_CASES.map(([, rule]) => rule), make({ drop: true }, { match: { pid: 7 } })]
  for (const rule of rules) assert.match(summaryOf(rule), /\S/, JSON.stringify(rule))
})
