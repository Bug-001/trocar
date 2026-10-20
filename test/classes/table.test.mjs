// V82 (1.6 §4.2, D60③): the class table is DATA — ordered, first match wins, `other` last; the user's copy is
// written whole on the first edit, logged line by line, and a bad argument writes nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { HARNESS_IDS } from '../../src/cli/harness-names.mjs'
import { BUILTIN, readTable, classify, keepOf, edit, ClassArgError } from '../../src/classes/table.mjs'
import { LLM_ENDPOINT_PATHS, TOKEN_COUNT_ENDPOINT_PATHS } from '../../src/capture/envelope.mjs'

const home = () => tmpDir('trocar-classes-')
const classesFile = (h) => path.join(h, 'classes.json')
const logFile = (h) => path.join(h, 'logs', 'classes.ndjson')
const now = () => new Date('2026-10-18T07:00:00.000Z')
const names = (t) => t.classes.map((c) => c.class)

test('内置表:有序、other 在末尾且没有规则、token-count 在 llm 前', () => {
  assert.equal(BUILTIN.at(-1).class, 'other')
  assert.deepEqual(BUILTIN.at(-1).rules, [])
  assert.ok(names({ classes: BUILTIN }).indexOf('token-count') < names({ classes: BUILTIN }).indexOf('llm'))
  for (const c of BUILTIN) assert.equal(c.builtin, true)
  for (const c of BUILTIN) assert.ok(['full', 'log'].includes(c.keep), `${c.class} keep`)
})

test('内置的 llm 规则来自 envelope 的端点表', () => {
  const llm = BUILTIN.find((c) => c.class === 'llm')
  const tc = BUILTIN.find((c) => c.class === 'token-count')
  assert.deepEqual(llm.rules.map((r) => r.path), [...LLM_ENDPOINT_PATHS])
  assert.deepEqual(tc.rules.map((r) => r.path), [...TOKEN_COUNT_ENDPOINT_PATHS])
})

test('归类:首个匹配、host 整串、path 从开头、harness 限定,都不中归 other', () => {
  const of = classify({ classes: BUILTIN })
  assert.equal(of({ host: 'api.anthropic.com', path: '/v1/messages' }), 'llm')
  assert.equal(of({ host: 'api.anthropic.com', path: '/v1/messages/count_tokens' }), 'token-count')
  assert.equal(of({ host: 'api.anthropic.com', path: '/v1/messages?beta=1' }), 'llm')
  assert.equal(of({ host: 'api.anthropic.com', path: '/api/event_logging/x', harness: 'claude-code' }), 'telemetry')
  // one name for a harness (D58): the built-in rules name it as the CLI and the collector do, so `--harness` and the engine meet
  assert.deepEqual(BUILTIN.flatMap((c) => c.rules).filter((r) => r.harness !== null && !HARNESS_IDS.includes(r.harness)), [])
  // the same path under a harness the rule does not name is not that class
  assert.equal(of({ host: 'api.anthropic.com', path: '/api/event_logging/x', harness: 'codex' }), 'other')
  assert.equal(of({ host: 'oastify.sentry.io', path: '/x' }), 'telemetry') // shared table: any harness
  assert.equal(of({ host: 'evil-api.anthropic.com.example', path: '/v1/files' }), 'other') // host matches whole
  assert.equal(of({ host: 'example.com', path: '/x' }), 'other')
  assert.ok(BUILTIN.every((c) => c.keep === 'full'), 'every built-in class keeps everything (D40: the default is full; log is the user\'s choice)')
  assert.equal(keepOf({ classes: BUILTIN }, 'nope'), 'full')
})

test('第一次修改整份写出 0600,新类别排在内置之前,修改追一行旧值+新值+时间', () => {
  const h = home()
  const r = edit({ kind: 'add', class: 'catalog', host: 'models\\.opencode\\.ai', path: '/api\\.json' }, { home: h, fs, now })
  assert.equal(r.ok, true)
  assert.equal(r.file, classesFile(h))
  assert.deepEqual(r.written, [classesFile(h), logFile(h)])
  assert.equal(fs.statSync(classesFile(h)).mode & 0o777, 0o600)
  const t = readTable({ home: h, fs })
  assert.deepEqual(t.problems, [])
  assert.equal(t.file, classesFile(h))
  assert.deepEqual(names(t), ['catalog', ...names({ classes: BUILTIN })])
  const added = t.classes[0]
  assert.equal(added.keep, 'full')
  assert.equal(added.builtin, false)
  assert.deepEqual(added.rules, [{ host: 'models\\.opencode\\.ai', path: '/api\\.json', harness: null }])
  // the user's rule wins over the builtin ones
  assert.equal(classify(t)({ host: 'models.opencode.ai', path: '/api.json' }), 'catalog')
  const lines = fs.readFileSync(logFile(h), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].ts, now().toISOString())
  assert.equal(lines[0].op, 'add')
  assert.equal(lines[0].from, null)
  assert.equal(lines[0].to.class, 'catalog')
  assert.equal(t.lastChange.op, 'add')

  edit({ kind: 'set', class: 'catalog', keep: 'log' }, { home: h, fs, now })
  const t2 = readTable({ home: h, fs })
  assert.equal(keepOf(t2, 'catalog'), 'log')
  const l2 = fs.readFileSync(logFile(h), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(l2.length, 2)
  assert.equal(l2[1].from.keep, 'full')
  assert.equal(l2[1].to.keep, 'log')
})

test('rm 删一条规则或整个类别;reset 删文件回到内置表', () => {
  const h = home()
  edit({ kind: 'add', class: 'catalog', host: 'a\\.example' }, { home: h, fs, now })
  edit({ kind: 'add', class: 'catalog', host: 'b\\.example' }, { home: h, fs, now })
  edit({ kind: 'rm', class: 'catalog', rule: 1 }, { home: h, fs, now })
  assert.deepEqual(readTable({ home: h, fs }).classes[0].rules.map((r) => r.host), ['b\\.example'])
  edit({ kind: 'rm', class: 'catalog' }, { home: h, fs, now })
  assert.deepEqual(names(readTable({ home: h, fs })), names({ classes: BUILTIN }))
  const r = edit({ kind: 'reset' }, { home: h, fs, now })
  assert.equal(r.ok, true)
  assert.equal(fs.existsSync(classesFile(h)), false)
  assert.equal(readTable({ home: h, fs }).file, null)
  assert.equal(readTable({ home: h, fs }).lastChange.op, 'reset')
})

test('other 删不掉也加不了规则', () => {
  const h = home()
  for (const op of [{ kind: 'rm', class: 'other' }, { kind: 'add', class: 'other', host: 'x\\.example' }]) {
    assert.throws(() => edit(op, { home: h, fs, now }), ClassArgError)
  }
  assert.equal(fs.existsSync(classesFile(h)), false) // 零写入
  assert.equal(fs.existsSync(logFile(h)), false)
  // but its level is settable
  assert.equal(edit({ kind: 'set', class: 'other', keep: 'log' }, { home: h, fs, now }).ok, true)
})

test('正则非法、类名非法、规则号不存在、级别非法 → 抛 ClassArgError 且零写入', () => {
  const h = home()
  edit({ kind: 'add', class: 'catalog', host: 'a\\.example' }, { home: h, fs, now })
  const before = fs.readFileSync(classesFile(h), 'utf8')
  const logBefore = fs.readFileSync(logFile(h), 'utf8')
  const bad = [
    { kind: 'add', class: 'catalog', host: '[' },
    { kind: 'add', class: 'catalog', host: 'a\\.example', path: '(' },
    { kind: 'add', class: 'Catalog_2', host: 'a\\.example' },
    { kind: 'rm', class: 'catalog', rule: 9 },
    { kind: 'rm', class: 'nope' },
    { kind: 'set', class: 'catalog', keep: 'some' },
    { kind: 'set', class: 'nope', keep: 'log' },
    { kind: 'wat', class: 'catalog' },
  ]
  for (const op of bad) assert.throws(() => edit(op, { home: h, fs, now }), ClassArgError, JSON.stringify(op))
  assert.equal(fs.readFileSync(classesFile(h), 'utf8'), before)
  assert.equal(fs.readFileSync(logFile(h), 'utf8'), logBefore)
})

test('读不懂的用户表 → 内置表 + 一条 problem,不静默(D38)', () => {
  const h = home()
  fs.writeFileSync(classesFile(h), '{not json')
  const t = readTable({ home: h, fs })
  assert.deepEqual(names(t), names({ classes: BUILTIN }))
  assert.equal(t.problems.length, 1)
  assert.match(t.problems[0].reason, /classes\.json/)
  // and an edit refuses to overwrite it rather than losing the operator's other classes
  const r = edit({ kind: 'set', class: 'other', keep: 'log' }, { home: h, fs, now })
  assert.equal(r.ok, false)
  assert.equal(fs.readFileSync(classesFile(h), 'utf8'), '{not json')
})

test('写不进去 → ok:false 带 error,不抛', () => {
  const h = home()
  const boom = Object.assign(new Error('nope'), { code: 'EACCES' })
  const stub = { ...fs, writeFileSync: () => { throw boom } }
  const r = edit({ kind: 'set', class: 'other', keep: 'log' }, { home: h, fs: stub, now })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'EACCES')
  assert.deepEqual(r.written, [])
})
