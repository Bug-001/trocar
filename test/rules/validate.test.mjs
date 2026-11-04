// test/rules/validate.test.mjs — the one validator of a rule and a rule file (RFC 5.1 §规则长什么样, §隔离). Asserts whether problems come back and
// their `path`, never their words. The two position tables are copied by hand from 5.1, not derived from the code.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { checkRule, checkFile, normalizeRule, actionKind, readsBody, scriptOf, parseRulesBytes, LIMITS, DEFAULT_MAX_DELAY_MS } from '../../src/rules/validate.mjs'
import { parseCondition, tierOf, leaves, FAST_LITERAL } from '../../src/rules/conditions.mjs'
import { rulesFile, rulesLock, rulesLog, rulesStats, rulesState } from '../../src/paths.mjs'

const rule = (over = {}) => ({ name: 'r', match: { harness: 'codex', host: 'a.test' }, do: [{ delay_ms: 1 }], on_error: 'forward', ...over })
const withMatch = (extra, over = {}) => rule({ match: { harness: 'codex', host: 'a.test', ...extra }, ...over })
const pathsOf = (r, opts = { input: true }) => checkRule(r, opts).map((p) => p.path)
const passes = (r, label) => assert.deepEqual(checkRule(r, { input: true }), [], label)
const refused = (r, at, label) => {
  const paths = pathsOf(r)
  assert.notEqual(paths.length, 0, label ?? JSON.stringify(r).slice(0, 200))
  if (at) assert.ok(paths.some((p) => p === at || p.startsWith(`${at}.`)), `${label ?? ''} wanted ${at}, got ${paths}`)
}
// One rule, the two ways a rule reaches the validator: `rules add` and a hand-edited file.
const refusedBothWays = (r, at) => {
  refused(r, at)
  const paths = checkFile({ rules: [r] }).map((p) => p.path)
  assert.ok(paths.some((p) => p.startsWith(`rules.0.${at}`)), `file: wanted ${at}, got ${paths}`)
}

const POSITIONS = {
  request: { on: 'request' }, 'response + whole': { on: 'response', whole: true }, response: { on: 'response' },
  'ws-client': { on: 'ws-client' }, 'ws-server': { on: 'ws-server' },
}
const COLUMNS = Object.keys(POSITIONS)
const yes = (cells) => Object.fromEntries(COLUMNS.map((c, i) => [c, cells[i] === 'y']))

// 5.1 §动作和位置, row by row: request, response + whole, response, ws-client, ws-server.
const ACTION_ROWS = [
  ['yyyyy', [{ replace: 'a', with: 'b' }, { replace: 'a', with: 'b', in: 'body', literal: true }]],
  ['yyynn', [{ header: 'x-a', set: 'v' }, { header: 'x-a', remove: true }]],
  ['yyyyy', [{ json: '/model', set: 'm' }, { json: '/messages/-', add: { a: 1 } }, { json: '/tools/3', remove: true }]],
  ['ynnyn', [{ blocks: { role: 'system' }, remove: true }, { blocks: {}, truncate: 4000 }, { blocks: { newest: 1 }, set_text: 't' }, { blocks: { kind: 'text' }, append_text: 't' },
    { replace: 'a', with: 'b', blocks: { role: 'user' } }]],
  ['yyyyy', [{ script: path.resolve('/abs/surgery.mjs') }]],
  ['yynyy', [{ hold: true, release_after_ms: 60000 }]],
  ['yyyyy', [{ drop: true }]],
  ['yyyyy', [{ delay_ms: 3000 }]],
  ['ynnnn', [{ reply: { status: 429, headers: { 'x-a': 'b' }, body: 'no' } }]],
  ['nnyny', [{ inject: 'data: x\n\n' }]],
]

test('every action in every position: the table of 5.1, and `on` left out is `request`', () => {
  for (const [cells, actions] of ACTION_ROWS) {
    for (const action of actions) {
      const allowed = yes(cells)
      for (const column of COLUMNS) {
        const r = rule({ ...POSITIONS[column], do: [action] })
        if (allowed[column]) passes(r, `${JSON.stringify(action)} @ ${column}`)
        else refused(r, 'do.0', `${JSON.stringify(action)} @ ${column}`)
      }
      if (allowed.request) passes(rule({ do: [action] }))
      else refused(rule({ do: [action] }), 'do.0')
    }
  }
})
