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

// 5.1 §匹配条件, row by row: request, response (with or without whole), ws-client, ws-server.
const MATCH_ROWS = [
  ['yyyyy', { host: '*.a.test' }], ['yyyyy', { path: '/v1/*' }], ['yyyyy', { method: 'POST' }], ['yyyyy', { class: 'llm' }],
  ['yyyyy', { pid: 42 }], ['yyyyy', { harness: ['codex', 'kimi'] }], ['yyyyy', { harness: 'any' }],
  ['yyyyy', { header: { 'x-claude-code-session-id': 'abc' } }], ['yyyyy', { body: 'ALPHA' }],
  ['nyynn', { req_header: { 'x-a': 'b' } }],
  ['ynnyn', { blocks: { role: 'system', min_bytes: 10 } }],
  ['nyynn', { status: 429 }],
  ['nyyyy', { event_index: 0 }],
]

test('every match key in every position: the table of 5.1', () => {
  for (const [cells, extra] of MATCH_ROWS) {
    const allowed = yes(cells), key = Object.keys(extra)[0]
    for (const column of COLUMNS) {
      const r = withMatch(extra, POSITIONS[column])
      if (allowed[column]) passes(r, `${key} @ ${column}`)
      else refused(r, `match.${key}`, `${key} @ ${column}`)
    }
  }
})

test('the fields: required ones, closed values, known keys only', () => {
  const dropKey = (key) => { const { [key]: _, ...r } = rule(); return r }
  for (const key of ['name', 'match', 'do', 'on_error']) refused(dropKey(key), key)
  for (const name of ['add', 'test', 'enable', 'disable', 'rm', 'off', 'max-delay', 'Upper', 'a b', '', 'é', 7]) refused(rule({ name }), 'name')
  for (const name of ['a', 'a-b', '0-9', 'adds']) passes(rule({ name }))
  refused(rule({ on: 'sideways' }), 'on')
  refused(rule({ on_error: 'retry' }), 'on_error')
  refused(rule({ note: 7 }), 'note')
  refused(rule({ whole: true }), 'whole')
  refused(rule({ on: 'ws-server', whole: true }), 'whole')
  refused(rule({ on: 'response', whole: 'yes' }), 'whole')
  refused(rule({ do: [] }), 'do')
  refused(rule({ do: [{ teleport: true }] }), 'do.0')
  for (const limit of [{ times: 0 }, { times: 1.5 }, { until: 'soon' }, { after: 1 }, 7]) refused(rule({ limit }), 'limit')
  passes(rule({ limit: { times: 5, until: '2026-11-05T12:00:00Z' }, note: 'n' }))
})

test('an action carries exactly the keys of its form', () => {
  for (const action of [
    { replace: '', with: 'b' }, { replace: 'a' }, { replace: 'a', with: 'b', in: 'head' }, { replace: 'a', with: 'b', literal: 1 }, { replace: 'a', with: 'b', blocks: { colour: 'red' } },
    { header: 'x-a' }, { header: 'x-a', set: 'v', remove: true }, { header: 'x-a', remove: false },
    { json: 'model', set: 1 }, { json: '/a~2', set: 1 }, { json: '/a' }, { json: '/a', set: 1, add: 2 },
    { blocks: {} }, { blocks: {}, remove: true, truncate: 1 }, { blocks: {}, truncate: 0 }, { blocks: { newest: -1 }, remove: true }, { blocks: { role: 7 }, remove: true },
    { script: 'relative.mjs' }, { script: './relative.mjs' }, { script: '' },
    { drop: false }, { drop: true, delay_ms: 1 }, { hold: false, release_after_ms: 1 }, { inject: '' },
  ]) refused(rule({ do: [action] }), 'do.0', JSON.stringify(action))
  refused(rule({ do: [{ replace: 'x'.repeat(LIMITS.regexBytes + 1), with: '' }] }), 'do.0')
  passes(rule({ do: [{ replace: 'x'.repeat(LIMITS.regexBytes + 1), with: '', literal: true }] }))
  passes(rule({ do: [{ replace: 'x'.repeat(LIMITS.regexBytes), with: '' }] }))
})

test('a rule has at most one script: it carries one script_sha256', () => {
  refused(rule({ do: [{ script: '/a.mjs' }, { script: '/b.mjs' }] }), 'do.1')
})

test('hold, drop and reply end the list; nothing follows them', () => {
  for (const last of [{ hold: true, release_after_ms: 1 }, { drop: true }, { reply: { status: 200 } }]) {
    passes(rule({ do: [{ delay_ms: 1 }, last] }))
    refused(rule({ do: [last, { delay_ms: 1 }] }), 'do.0')
  }
})

test('hard rule: harness or pid is required, and "any" is written out', () => {
  refused(rule({ match: { host: 'a.test' } }), 'match.harness')
  passes(rule({ match: { harness: 'any', host: 'a.test' } }))
  passes(rule({ match: { pid: 1234, host: 'a.test' } }))
  for (const pid of [0, -1, 1.5, '12', null]) refused(rule({ match: { pid, host: 'a.test' } }), 'match.pid')
  for (const harness of ['nobody', [], ['any'], ['codex', 'any'], [['codex']], 7, null]) refused(rule({ match: { harness, host: 'a.test' } }), 'match.harness')
  for (const harness of ['claude', 'claude-code', ['kimi', 'codex', 'kimi']]) passes(rule({ match: { harness, host: 'a.test' } }))
})

test('hard rule: a rule that reads the body needs host, path or class', () => {
  const readers = [
    [{ body: 'ALPHA' }, [{ delay_ms: 1 }]], [{ blocks: { role: 'user' } }, [{ delay_ms: 1 }]],
    [{}, [{ replace: 'a', with: 'b' }]], [{}, [{ json: '/a', set: 1 }]], [{}, [{ blocks: {}, remove: true }]], [{}, [{ script: '/s.mjs' }]],
  ]
  for (const [extra, actions] of readers) {
    const match = { harness: 'codex', ...extra }
    const r = rule({ match, do: actions })
    assert.equal(readsBody(r), true)
    refused(r, 'match')
    for (const scope of [{ host: 'a.test' }, { path: '/v1/*' }, { class: 'llm' }]) passes(rule({ match: { ...match, ...scope }, do: actions }))
  }
  for (const actions of [[{ delay_ms: 1 }], [{ header: 'x-a', set: 'v' }], [{ drop: true }], [{ reply: { status: 200 } }]]) {
    assert.equal(readsBody(rule({ do: actions })), false)
    passes(rule({ match: { harness: 'codex' }, do: actions }))
  }
})

test('hard rule: on_error drop needs host, and "*" writes out everything', () => {
  refused(rule({ on_error: 'drop', match: { harness: 'codex', path: '/v1/*' } }), 'match.host')
  passes(rule({ on_error: 'drop', match: { harness: 'codex', host: '*' } }))
  passes(rule({ on_error: 'drop', match: { harness: 'codex', host: 'a.test' } }))
})

test('hard rule: a script rule decides nothing from the body and nothing in the rule process', () => {
  const script = { do: [{ script: '/s.mjs' }] }
  passes(withMatch({ path: '/v1/*', header: { 'x-a': ['b', { not: 'c' }] } }, script))
  refused(withMatch({ body: 'ALPHA' }, script), 'match.body')
  refused(withMatch({ blocks: { role: 'user' } }, script), 'match.blocks')
  for (const cond of [{ re: 'a' }, ['a', { re: 'a' }], { not: { re: 'a' } }, { not: ['a', { not: { re: 'a' } }] }]) {
    refused(withMatch({ path: cond }, script), 'match.path')
    refused(withMatch({ header: { 'x-a': cond } }, script), 'match.header')
    passes(withMatch({ path: cond }))
  }
  refused(withMatch({ path: 'p'.repeat(LIMITS.literalBytes + 1) }, script), 'match.path')
})

test('hard rule: armed, armed_at and script_sha256 are the enable step\'s: refused in input, fine in the file', () => {
  const written = { armed: { off: 3, rules: 1 }, armed_at: '2026-11-05T12:00:00Z', script_sha256: 'a'.repeat(64) }
  for (const [key, value] of Object.entries(written)) {
    refused(rule({ [key]: value }), key)
    assert.deepEqual(checkRule(rule({ [key]: value }), { input: false }), [])
  }
  assert.deepEqual(checkRule(rule({ armed: 'yes' }), { input: false }).map((p) => p.path), ['armed'])
  assert.deepEqual(checkRule(rule({ script_sha256: 'short' }), { input: false }).map((p) => p.path), ['script_sha256'])
})

test('replies: the status range, no body on 204 and 304, no framing headers', () => {
  for (const status of [100, 101, 199, 600, 200.5, '200', undefined]) refused(rule({ do: [{ reply: { status } }] }), 'do.0')
  for (const status of [200, 429, 599]) passes(rule({ do: [{ reply: { status, body: 'x' } }] }))
  for (const status of [204, 304]) {
    passes(rule({ do: [{ reply: { status } }] }))
    refused(rule({ do: [{ reply: { status, body: 'x' } }] }), 'do.0')
    refused(rule({ do: [{ reply: { status, body: '' } }] }), 'do.0')
  }
  for (const name of ['content-length', 'Transfer-Encoding']) refused(rule({ do: [{ reply: { status: 200, headers: { [name]: '1' } } }] }), 'do.0')
  refused(rule({ do: [{ reply: { status: 200, extra: 1 } }] }), 'do.0')
  refused(rule({ do: [{ reply: { status: 200, body: 7 } }] }), 'do.0')
})

test('hold needs release_after_ms; it and delay_ms stay in their ranges', () => {
  refused(rule({ do: [{ hold: true }] }), 'do.0')
  for (const ms of [0, -1, 1.5, '60', 86_400_001]) refused(rule({ do: [{ hold: true, release_after_ms: ms }] }), 'do.0')
  for (const ms of [1, 86_400_000]) passes(rule({ do: [{ hold: true, release_after_ms: ms }] }))
  for (const ms of [0, 60_001, '1']) refused(rule({ do: [{ delay_ms: ms }] }), 'do.0')
  passes(rule({ do: [{ delay_ms: 60_000 }] }))
})

test('header injection is refused wherever a header is written, by `rules add` and in a hand-edited file', () => {
  const names = ['a\r\nb', 'Content-Length ', 'x\r\ncontent-length']
  const values = ['a\r\nb', 'a\nb', 'v'.repeat(20 * 1024)]
  const places = [
    (n, v) => [rule({ do: [{ header: n, set: v }] }), 'do'],
    (n, v) => [rule({ do: [{ reply: { status: 200, headers: { [n]: v } } }] }), 'do.0'],
    (n, v) => [withMatch({ header: { [n]: v } }), 'match.header'],
    (n, v) => [withMatch({ header: { [n]: ['ok', { not: `*${v}*` }] } }), 'match.header'],
    (n, v) => [withMatch({ req_header: { [n]: v } }, { on: 'response' }), 'match.req_header'],
  ]
  for (const place of places) {
    for (const n of names) refusedBothWays(...place(n, 'ok'))
    for (const v of values) refusedBothWays(...place('x-a', v))
    passes(place('x-a', 'ok')[0])
  }
  refused(rule({ do: [{ header: 'x-a', set: 'v'.repeat(5000) }, { header: 'x-b', set: 'v'.repeat(5000) }] }), 'do')
  for (const action of [{ header: 'Connection', set: 'x' }, { header: 'UPGRADE', remove: true }]) refused(rule({ do: [action] }), 'do.0')
  passes(withMatch({ header: { 'content-length': '12' } }))
})

test('lists are capped wherever they are written', () => {
  const list = (n, f = (i) => `v${i}`) => Array.from({ length: n }, (_, i) => f(i))
  const n = LIMITS.list
  for (const key of ['host', 'path', 'method', 'class', 'status', 'body']) {
    passes(withMatch({ [key]: list(n) }, key === 'status' ? { on: 'response' } : {}))
    refused(withMatch({ [key]: list(n + 1) }, key === 'status' ? { on: 'response' } : {}), `match.${key}`)
  }
  refused(withMatch({ header: { 'x-a': list(n + 1) } }), 'match.header')
  refused(withMatch({ path: { not: list(n + 1) } }), 'match.path')
  refused(withMatch({ harness: list(n + 1, () => 'codex') }), 'match.harness')
  refused(rule({ do: list(n + 1, () => ({ delay_ms: 1 })) }), 'do')
  passes(rule({ do: list(n, () => ({ delay_ms: 1 })) }))
})

test('a condition\'s shape and its regex bound', () => {
  for (const cond of [{}, { re: '' }, { re: 7 }, { re: 'a', not: 'b' }, { any: ['a'] }, [], null, true]) refused(withMatch({ path: cond }), 'match.path')
  refused(withMatch({ path: { re: 'x'.repeat(LIMITS.regexBytes + 1) } }), 'match.path')
  refused(withMatch({ path: { re: '中'.repeat(LIMITS.regexBytes / 2) } }), 'match.path')
  passes(withMatch({ path: { re: 'x'.repeat(LIMITS.regexBytes) } }))
})

test('the ways of writing a condition: 5.1 §条件的写法', () => {
  const cases = [
    ['POST', 'path', { t: 'eq', v: 'POST' }], ['/v1/messages*', 'path', { t: 'prefix', v: '/v1/messages' }], ['*.anthropic.com', 'host', { t: 'suffix', v: '.anthropic.com' }],
    ['*telemetry*', 'path', { t: 'contains', v: 'telemetry' }], ['*', 'host', { t: 'all' }], ['a*b', 'path', { t: 'eq', v: 'a*b' }], ['*a*b', 'path', { t: 'suffix', v: 'a*b' }],
    [429, 'status', { t: 'eq', v: '429' }], ['*', 'body', { t: 'contains', v: '*' }], ['ab*', 'body', { t: 'contains', v: 'ab*' }], [7, 'body', { t: 'contains', v: '7' }],
    [{ re: 'x' }, 'path', { t: 're', v: 'x' }],
    [['a', { not: 'b' }], 'path', { t: 'any', of: [{ t: 'eq', v: 'a' }, { t: 'not', of: [{ t: 'eq', v: 'b' }] }] }],
  ]
  for (const [value, key, ast] of cases) assert.deepEqual(parseCondition(value, { key }), ast)
  assert.equal(leaves(parseCondition(['a', ['b', { not: 'c' }]], { key: 'path' })), 3)
})

test('which tier a condition runs in', () => {
  const tier = (value, key) => tierOf(parseCondition(value, { key }), { key })
  const edge = 'x'.repeat(LIMITS.literalBytes)
  for (const [value, key, want] of [
    ['POST', 'method', 1], ['<a>', 'path', 1], ['*', 'host', 1], [edge, 'path', 1], [`${edge}x`, 'path', 2], [`*${edge}x*`, 'path', 2], ['中'.repeat(100), 'path', 2],
    ['ALPHA beta_1-2.3:4', 'body', 1], [edge, 'body', 1], [`${edge}x`, 'body', 2], ['<system-reminder>', 'body', 2], ['a/b', 'body', 2], ['中', 'body', 2], ['', 'body', 2],
    [{ re: 'x' }, 'path', 2], [['a', { re: 'x' }], 'path', 2], [{ not: { re: 'x' } }, 'path', 2], [['a', { not: 'b' }], 'path', 1],
  ]) assert.equal(tier(value, key), want, `${JSON.stringify(value).slice(0, 40)} under ${key}`)
  assert.equal(FAST_LITERAL.test('a\n'), false)
})

test('unknown keys do nothing: __proto__ is refused at every level, read as data', () => {
  const proto = (json) => JSON.parse(json)
  const shapes = [
    [proto('{"name":"r","__proto__":{"on_error":"drop"},"match":{"harness":"codex"},"do":[{"drop":true}],"on_error":"forward"}'), '__proto__'],
    [proto('{"name":"r","match":{"harness":"codex","__proto__":{"host":"a"}},"do":[{"drop":true}],"on_error":"forward"}'), 'match.__proto__'],
    [proto('{"name":"r","match":{"harness":"codex","header":{"__proto__":"a"}},"do":[{"drop":true}],"on_error":"forward"}'), 'match.header'],
    [proto('{"name":"r","match":{"harness":"codex"},"do":[{"drop":true,"__proto__":{}}],"on_error":"forward"}'), 'do.0'],
    [proto('{"name":"r","match":{"harness":"codex"},"do":[{"reply":{"status":200,"__proto__":1}}],"on_error":"forward"}'), 'do.0'],
    [proto('{"name":"r","match":{"harness":"codex"},"do":[{"reply":{"status":200,"headers":{"__proto__":"a"}}}],"on_error":"forward"}'), 'do.0'],
    [proto('{"name":"r","match":{"harness":"codex"},"do":[{"delay_ms":1}],"on_error":"forward","limit":{"__proto__":1}}'), 'limit'],
    [proto('{"name":"r","match":{"harness":"codex","blocks":{"__proto__":1},"host":"a"},"do":[{"delay_ms":1}],"on_error":"forward"}'), 'match.blocks'],
  ]
  for (const [r, at] of shapes) refused(r, at)
  assert.ok(checkFile(proto('{"rules":[],"__proto__":{}}')).some((p) => p.path === '__proto__'))
})

test('normalizeRule: aliases to code ids, pid alone means any harness, the input untouched and the result stable', () => {
  const input = { name: 'r', match: { harness: ['kimi', 'claude', 'kimi'], host: 'a.test' }, do: [{ drop: true }], on_error: 'forward' }
  const frozen = structuredClone(input)
  const out = normalizeRule(input)
  assert.deepEqual(input, frozen)
  assert.deepEqual(out.match.harness, ['claude-code', 'kimi-code'])
  assert.equal(out.on, 'request')
  assert.deepEqual(normalizeRule(out), out)
  assert.deepEqual(checkRule(out, { input: true }), [])
  assert.equal(normalizeRule({ ...input, match: { pid: 7 } }).match.harness, 'any')
  assert.equal(normalizeRule({ ...input, match: { harness: 'any' } }).match.harness, 'any')
  for (const junk of [null, 7, 'x', { name: 'r' }, { match: 7 }, { match: { harness: 'nobody' } }]) normalizeRule(junk)
})

test('actionKind and scriptOf read an action by its form', () => {
  for (const [kind, action] of [['replace', { replace: 'a', with: 'b', blocks: {} }], ['header', { header: 'x', remove: true }], ['json', { json: '/a', remove: true }], ['blocks', { blocks: {}, remove: true }],
    ['script', { script: '/s.mjs' }], ['hold', { hold: true, release_after_ms: 1 }], ['drop', { drop: true }], ['delay', { delay_ms: 1 }], ['reply', { reply: { status: 200 } }], ['inject', { inject: 'x' }]]) {
    assert.equal(actionKind(action), kind)
  }
  assert.equal(scriptOf(rule({ do: [{ delay_ms: 1 }, { script: '/s.mjs' }] })), '/s.mjs')
  assert.equal(scriptOf(rule()), null)
})

test('the rule file: top-level keys, max_delay_ms, unique names', () => {
  assert.deepEqual(checkFile({ rules: [] }), [])
  assert.deepEqual(checkFile({ max_delay_ms: 60_000, rules: [rule()] }), [])
  assert.deepEqual(checkFile({ max_delay_ms: 1, rules: [] }), [])
  assert.equal(DEFAULT_MAX_DELAY_MS, 200)
  for (const max_delay_ms of [0, 60_001, 1.5, '200']) assert.ok(checkFile({ max_delay_ms, rules: [] }).some((p) => p.path === 'max_delay_ms'))
  for (const doc of [null, [], 7, {}, { rules: {} }]) assert.notEqual(checkFile(doc).length, 0)
  assert.ok(checkFile({ rules: [], extra: 1 }).some((p) => p.path === 'extra'))
  assert.ok(checkFile({ rules: [rule(), rule()] }).some((p) => p.path === 'rules.1.name'))
  assert.ok(checkFile({ rules: [rule(), 7] }).some((p) => p.path.startsWith('rules.1')))
})

const many = (n, f) => Array.from({ length: n }, (_, i) => f(i))
const named = (rules) => rules.map((r, i) => ({ ...r, name: `r${i}` }))
const listOf = (n, tag) => many(n, (i) => `/${tag}/${i}`)

test('a file over the rule count is refused whole', () => {
  assert.deepEqual(checkFile({ rules: named(many(LIMITS.rules, () => rule())) }), [])
  assert.deepEqual(checkFile({ rules: named(many(10_000, () => rule())) }).map((p) => p.path), ['rules'])
})

test('the tier-1 conditions one connection can reach are capped, however they reach it', () => {
  const cap = LIMITS.tier1Conditions, lists = cap / LIMITS.list
  const fill = (over, n = lists) => many(n, (i) => rule({ ...over(i), match: { ...over(i).match, path: listOf(LIMITS.list, i) } }))
  const shared = () => ({ match: { harness: 'codex', host: 'a.test' } })
  const extra = (match, on = 'request') => rule({ on, match: { ...match, path: '/one' } })
  const reachesOverCap = {
    'one bucket': [...fill(shared), extra(shared().match)],
    'a bucket and the any bucket of its host': [...fill(shared), extra({ harness: 'any', host: 'a.test' })],
    'a bucket and the wildcard table': [...fill(shared), rule({ match: { harness: 'codex', host: '*.b.test' } })],
    'a bucket and any\'s wildcard table': [...fill(shared), rule({ match: { harness: 'any', path: '/one' } })],
    'a host in no bucket': [...fill(() => ({ match: { harness: 'any' } })), rule({ match: { harness: 'codex', host: '*.b.test' } })],
    'across positions': [...fill(shared), extra(shared().match, 'ws-client')],
    'an alias of the same harness': [...fill(() => ({ match: { harness: 'kimi-code', host: 'a.test' } })), extra({ harness: 'kimi', host: 'A.TEST' })],
  }
  for (const [label, rules] of Object.entries(reachesOverCap)) {
    assert.ok(checkFile({ rules: named(rules) }).some((p) => p.path === 'rules'), label)
  }
  const apart = {
    'exactly the cap': fill(shared),
    'other hosts': [...fill(shared), extra({ harness: 'codex', host: 'b.test' })],
    'other harnesses': [...fill(shared), extra({ harness: 'hermes', host: 'a.test' })],
    'tier-2 conditions': [...fill(shared), withMatch({ path: { re: 'x' } })],
  }
  for (const [label, rules] of Object.entries(apart)) assert.deepEqual(checkFile({ rules: named(rules) }), [], label)
})

test('a full legal file passes: 500 rules of 64 exact hosts and 500 wildcard rules, all on any harness', () => {
  for (const hostOf of [(r, i) => `h${r}-${i}.test`, (r, i) => `h${i}.test`]) {
    const exact = many(500, (r) => rule({ match: { harness: 'any', host: many(LIMITS.list, (i) => hostOf(r, i)) } }))
    const wild = many(500, (r) => rule({ match: { harness: 'any', host: `*.w${r}.test` } }))
    assert.deepEqual(checkFile({ rules: named([...exact, ...wild]) }), [])
  }
})

test('the index is counted before it is built: harnesses × exact hosts, summed', () => {
  const harness = ['claude-code', 'codex', 'opencode', 'kimi-code']
  const rules = (n) => many(n, (r) => rule({ match: { harness, host: many(LIMITS.list, (i) => `h${r}-${i}.test`) } }))
  const fits = Math.floor(LIMITS.indexEntries / (harness.length * LIMITS.list))
  assert.deepEqual(checkFile({ rules: named(rules(fits)) }), [])
  assert.deepEqual(checkFile({ rules: named(rules(fits + 1)) }).map((p) => p.path), ['rules'])
})

test('at most four armed script files: the same file counts once, a rule that is off not at all', () => {
  const scripted = (i, armed) => rule({ do: [{ script: `/s${i}.mjs` }], ...(armed ? { armed: { off: 0, rules: 0 } } : {}) })
  assert.deepEqual(checkFile({ rules: named(many(LIMITS.armedScripts, (i) => scripted(i, true))) }), [])
  assert.deepEqual(checkFile({ rules: named(many(LIMITS.armedScripts + 1, (i) => scripted(i, true))) }).map((p) => p.path), ['rules'])
  assert.deepEqual(checkFile({ rules: named(many(LIMITS.armedScripts + 1, (i) => scripted(i, i < 4))) }), [])
  assert.deepEqual(checkFile({ rules: named(many(LIMITS.armedScripts + 3, (i) => scripted(i % LIMITS.armedScripts, true))) }), [])
})

test('parseRulesBytes: too big, too deep and not JSON, each with its code, depth counted outside strings', () => {
  const code = (b) => parseRulesBytes(Buffer.isBuffer(b) ? b : Buffer.from(b)).problem?.code
  assert.equal(code(Buffer.alloc(LIMITS.fileBytes + 1, 0x20)), 'too-big')
  assert.equal(code(Buffer.alloc(LIMITS.fileBytes, 0x20)), 'not-json')
  const deep = (n, open, close) => open.repeat(n) + close.repeat(n)
  assert.equal(code('['.repeat(1_000_000)), 'too-deep')
  assert.equal(code('{"a":'.repeat(40) + '1' + '}'.repeat(40)), 'too-deep')
  assert.equal(code(deep(LIMITS.jsonDepth + 1, '[', ']')), 'too-deep')
  assert.deepEqual(parseRulesBytes(Buffer.from(deep(LIMITS.jsonDepth, '[', ']'))).problem, undefined)
  for (const s of ['{"a":"' + '['.repeat(100) + '"}', '{"a":"\\"' + '['.repeat(100) + '"}', '{"a":"\\\\","b":[]}']) assert.equal(code(s), undefined, s.slice(0, 12))
  assert.equal(code('{"a":"\\\\"' + '['.repeat(40)), 'too-deep')
  for (const s of ['', '{', 'nope', '{"a":1}}']) assert.equal(code(s), 'not-json')
  assert.equal(code(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])), 'not-json')
  assert.deepEqual(parseRulesBytes(Buffer.from('{"rules":[]}')).doc, { rules: [] })
})

test('where the rule files live (1.6 §1.7)', () => {
  const home = path.join(path.sep, 'h')
  assert.equal(rulesFile(home), path.join(home, 'rules.json'))
  assert.equal(rulesLock(home), path.join(home, 'rules.lock'))
  assert.equal(rulesLog(home), path.join(home, 'logs', 'rules.ndjson'))
  assert.equal(rulesStats(home), path.join(home, 'collector', 'rules-stats.json'))
  assert.equal(rulesState(home), path.join(home, 'collector', 'rules-state.json'))
})
