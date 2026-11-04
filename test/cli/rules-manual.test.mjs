// test/cli/rules-manual.test.mjs — `trocar help rules` is the manual (1.6 §4.4, §5.4): what it shows is held to the validator, not to its wording.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sandbox } from './fixtures/dispatch-ctx.mjs'
import { assertEnglish } from '../helpers/english.mjs'
import { GROUPS, commandNamed, helpText } from '../../src/cli/commands.mjs'
import { QUERY_NAMES } from '../../src/query/client.mjs'
import { rulesManual } from '../../src/cli/rules-manual.mjs'
import { actionKind, checkFile, checkRule, normalizeRule, ACTION_POSITIONS, PLACES } from '../../src/rules/validate.mjs'

const manual = rulesManual()

// one action of each kind of 5.1 §动作
const ACTIONS = {
  replace: { replace: 'a', with: 'b' }, header: { header: 'x-a', set: 'b' }, json: { json: '/a', set: 1 }, blocks: { blocks: { role: 'user' }, remove: true },
  script: { script: '/abs/s.mjs' }, hold: { hold: true, release_after_ms: 1000 }, drop: { drop: true }, delay: { delay_ms: 1 }, reply: { reply: { status: 429 } }, inject: { inject: 'data: x\n\n' },
}
const at = (place) => (place === 'response-whole' ? { on: 'response', whole: true } : { on: place })
const ruleOf = (action, place) => ({ name: 'r', ...at(place), match: { harness: 'any', class: 'llm' }, do: [action], on_error: 'forward' })

test('1.6 §4.4: each complete example is a rule `rules add` takes, and all of them together are a rule file', () => {
  const rules = (manual.match(/^ {4}\{\n[\s\S]*?^ {4}\}$/gm) ?? []).map((block) => JSON.parse(block))
  assert.ok(rules.length >= 3, 'three complete examples')
  for (const rule of rules) assert.deepEqual(checkRule(rule, { input: true }), [], rule.name)
  assert.deepEqual(checkFile({ rules: rules.map(normalizeRule) }), [])
})

test('1.6 §4.4: each action form the manual prints is an action the validator takes at some position', () => {
  const forms = (manual.match(/^ {11}\{ .* \}$/gm) ?? []).map((line) => JSON.parse(line))
  assert.deepEqual([...new Set(forms.map(actionKind))].sort(), Object.keys(ACTIONS).sort())
  for (const form of forms) assert.ok(PLACES.some((place) => !checkRule(ruleOf(form, place)).length), JSON.stringify(form))
})

test('5.1 §动作和位置: the table lists the ten actions, and each cell says what the validator does at that position', () => {
  const rows = new Map([...manual.matchAll(/^ +([a-z]+) +((?:(?:yes|no) *){5})$/gm)].map(([, kind, cells]) => [kind, cells.trim().split(/ +/)]))
  assert.deepEqual([...rows.keys()].sort(), Object.keys(ACTIONS).sort())
  assert.deepEqual(Object.keys(ACTION_POSITIONS).sort(), Object.keys(ACTIONS).sort())
  for (const [kind, action] of Object.entries(ACTIONS)) {
    assert.equal(actionKind(action), kind)
    PLACES.forEach((place, i) => assert.equal(rows.get(kind)[i], checkRule(ruleOf(action, place)).length ? 'no' : 'yes', `${kind} at ${place}`))
  }
})

test('1.6 §4.4: the manual names every field, condition and block selector of a rule', () => {
  const words = new Set(manual.split(/[^a-z_]+/))
  const named = ['name', 'note', 'on', 'whole', 'match', 'do', 'on_error', 'limit', 'times', 'until', 'harness', 'pid', 'host', 'path', 'method', 'class', 'header', 'req_header', 'body',
    'blocks', 'status', 'event_index', 'section', 'kind', 'role', 'text', 'min_bytes', 'max_bytes', 'newest', 'skip_newest', 'forward', 'drop', 'request', 'response', 're', 'not']
  for (const word of named) assert.ok(words.has(word), word)
})

test('1.6 §1.1: the manual only names commands that exist', () => {
  const lines = [...manual.matchAll(/^ {4}trocar ([a-z-]+)(?: ([a-z-]+))?/gm)]
  assert.ok(lines.length)
  const verbs = ['add', 'test', 'enable', 'disable', 'rm', 'off', 'max-delay', 'swap-alpha'] // 1.6 §4.4, and the first example's name
  for (const [line, command, next] of lines) {
    assert.ok(commandNamed(command), line)
    if (command === 'rules' && next) assert.ok(verbs.includes(next), line)
    if (command === 'query') assert.ok(QUERY_NAMES.includes(next), line)
  }
})

test('1.6 §1.1: the manual is English, inside 80 columns', () => {
  assertEnglish(helpText('rules'), 'trocar help rules', { placeholders: true })
})

test('1.6 §5.4: help rules and rules --help print the manual, the overview does not, and Intervene sits between Data and Maintenance', async () => {
  const s = await sandbox()
  const text = async (...argv) => (await s.run(argv)).io.stdoutText()
  const overview = await text('help'), one = await text('help', 'rules')
  assert.ok(one.includes(manual))
  assert.equal(await text('rules', '--help'), one)
  assert.ok(!overview.includes(manual.split('\n')[0]))
  const heads = overview.split('\n').filter((line) => GROUPS.includes(line))
  assert.deepEqual(heads, ['Capture', 'Data', 'Intervene', 'Maintenance'])
})
