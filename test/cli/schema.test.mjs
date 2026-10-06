// test/cli/schema.test.mjs — RFC 1.6 R5 (`--json`): the keys every receipt carries, the exit codes of R4, and validateReceipt, the
// check V9 runs over every command's output. Each rule has a bad input that makes it say so (0.1 §3: a check must be able to fail).
import test from 'node:test'
import assert from 'node:assert/strict'
import { SCHEMA_VERSION, EXIT, RECEIPT_KEYS, newReceipt, validateReceipt } from '../../src/cli/schema.mjs'
import * as off from '../../src/off/schema.mjs'

const mutate = (fn, command = 'off') => { const r = newReceipt(command); fn(r); return r }
const problems = (fn) => validateReceipt(mutate(fn))

test('receipt schema: the keys, the exit codes and the version are the 1.6 R5 / R4 ones, and src/cli re-exports src/off', () => {
  assert.equal(SCHEMA_VERSION, 1)
  assert.deepEqual(RECEIPT_KEYS, ['schema', 'command', 'ok', 'changed', 'created', 'removed', 'skipped', 'restart', 'relayed', 'undo', 'log'])
  assert.deepEqual({ ...EXIT }, { ok: 0, incomplete: 1, usage: 2, unknown: 3, crash: 70 })
  assert.ok(Object.isFrozen(EXIT))
  assert.equal(off.EXIT, EXIT); assert.equal(off.newReceipt, newReceipt); assert.equal(off.RECEIPT_KEYS, RECEIPT_KEYS); assert.equal(off.SCHEMA_VERSION, SCHEMA_VERSION)
})

test('receipt schema: newReceipt is the empty receipt in key order, a fresh object each time, and it validates', () => {
  const r = newReceipt('off')
  assert.deepEqual(r, { schema: 1, command: 'off', ok: true, changed: [], created: [], removed: [], skipped: [], restart: [], relayed: { closing: 0, waiting: 0, cut: 0 }, undo: [], log: null })
  assert.deepEqual(Object.keys(r), RECEIPT_KEYS)
  assert.notEqual(newReceipt('off').changed, r.changed, 'no list shared between receipts')
  assert.notEqual(newReceipt('off').relayed, r.relayed)
  assert.deepEqual(validateReceipt(r), [])
  for (const c of ['on', 'off', 'status', 'uninstall', 'doctor']) assert.deepEqual(validateReceipt(newReceipt(c)), [], c)
})

test('receipt schema: a missing key is named', () => {
  for (const key of RECEIPT_KEYS) {
    const r = newReceipt('off'); delete r[key]
    const p = validateReceipt(r)
    assert.ok(p.some((s) => s.includes(key)), `${key}: ${JSON.stringify(p)}`)
  }
})

test('receipt schema: not an object at all', () => {
  for (const v of [null, undefined, 'receipt', 7, [], [newReceipt('off')]]) assert.ok(validateReceipt(v).length > 0, JSON.stringify(v))
})

test('receipt schema: schema is the current integer, command a non-empty string, ok a boolean', () => {
  assert.ok(problems((r) => { r.schema = 2 }).some((s) => s.includes('schema')))
  assert.ok(problems((r) => { r.schema = '1' }).some((s) => s.includes('schema')))
  assert.ok(problems((r) => { r.command = '' }).some((s) => s.includes('command')))
  assert.ok(problems((r) => { r.command = 7 }).some((s) => s.includes('command')))
  assert.ok(problems((r) => { r.ok = 'yes' }).some((s) => s.includes('ok')))
  assert.ok(problems((r) => { r.ok = 0 }).some((s) => s.includes('ok')))
  assert.deepEqual(problems((r) => { r.ok = false }), [])
})

test('receipt schema: changed[] items are {path, change, backup: string|null}', () => {
  assert.deepEqual(problems((r) => { r.changed.push({ path: '/h/.codex/.env', change: 'adds the asight block', backup: '/h/.asight/backup/ab-1' }, { path: '/h/.bashrc', change: 'x', backup: null }) }), [])
  assert.ok(problems((r) => { r.changed.push({ path: '/h/a', change: 'x' }) }).some((s) => s.includes('changed[0].backup')), 'backup must be there, null when there is none')
  assert.ok(problems((r) => { r.changed.push({ path: '/h/a', change: 'x', backup: 3 }) }).some((s) => s.includes('changed[0].backup')))
  assert.ok(problems((r) => { r.changed.push({ change: 'x', backup: null }) }).some((s) => s.includes('changed[0].path')))
  assert.ok(problems((r) => { r.changed.push({ path: '/h/a', change: 7, backup: null }) }).some((s) => s.includes('changed[0].change')))
  assert.ok(problems((r) => { r.changed.push('/h/a') }).some((s) => s.includes('changed[0]')))
  assert.ok(problems((r) => { r.changed = {} }).some((s) => s.includes('changed')))
})

test('receipt schema: skipped[] items are {what, reason} strings', () => {
  assert.deepEqual(problems((r) => { r.skipped.push({ what: 'hermes', reason: '~/.hermes does not exist' }) }), [])
  assert.ok(problems((r) => { r.skipped.push({ what: 'hermes' }) }).some((s) => s.includes('skipped[0].reason')))
  assert.ok(problems((r) => { r.skipped.push({ what: 3, reason: 'x' }) }).some((s) => s.includes('skipped[0].what')))
  assert.ok(problems((r) => { r.skipped.push('hermes') }).some((s) => s.includes('skipped[0]')))
})

test('receipt schema: restart[] items are {harness: canonical id, pid: integer}; an alias is not an id', () => {
  assert.deepEqual(problems((r) => { r.restart.push({ harness: 'claude-code', pid: 4121 }) }), [])
  assert.ok(problems((r) => { r.restart.push({ harness: 'claude', pid: 1 }) }).some((s) => s.includes('restart[0].harness')))
  assert.ok(problems((r) => { r.restart.push({ harness: 'nope', pid: 1 }) }).some((s) => s.includes('restart[0].harness')))
  assert.ok(problems((r) => { r.restart.push({ harness: 'codex', pid: '12' }) }).some((s) => s.includes('restart[0].pid')))
  assert.ok(problems((r) => { r.restart.push({ harness: 'codex', pid: 1.5 }) }).some((s) => s.includes('restart[0].pid')))
  assert.ok(problems((r) => { r.restart.push({ harness: 'codex' }) }).some((s) => s.includes('restart[0].pid')))
})

test('receipt schema: relayed is "unknown" or three non-negative integers', () => {
  assert.deepEqual(problems((r) => { r.relayed = 'unknown' }), [])
  assert.deepEqual(problems((r) => { r.relayed = { closing: 2, waiting: 1, cut: 0 } }), [])
  assert.ok(problems((r) => { r.relayed = 'none' }).some((s) => s.includes('relayed')), 'only "unknown" is a word for not knowing')
  assert.ok(problems((r) => { r.relayed = null }).some((s) => s.includes('relayed')))
  assert.ok(problems((r) => { r.relayed = 0 }).some((s) => s.includes('relayed')))
  for (const k of ['closing', 'waiting', 'cut']) {
    assert.ok(problems((r) => { delete r.relayed[k] }).some((s) => s.includes(`relayed.${k}`)), `${k} missing`)
    assert.ok(problems((r) => { r.relayed[k] = -1 }).some((s) => s.includes(`relayed.${k}`)), `${k} negative`)
    assert.ok(problems((r) => { r.relayed[k] = 1.5 }).some((s) => s.includes(`relayed.${k}`)), `${k} fractional`)
    assert.ok(problems((r) => { r.relayed[k] = '2' }).some((s) => s.includes(`relayed.${k}`)), `${k} a string`)
    assert.ok(problems((r) => { r.relayed[k] = null }).some((s) => s.includes(`relayed.${k}`)), `${k} null (not 0: R11)`)
  }
})

test('receipt schema: linger is optional, and true | false | "unknown" when there', () => {
  for (const v of [true, false, 'unknown']) assert.deepEqual(problems((r) => { r.linger = v }), [], String(v))
  for (const v of ['maybe', null, 0, 1, 'true', {}]) assert.ok(problems((r) => { r.linger = v }).some((s) => s.includes('linger')), JSON.stringify(v))
})

test('receipt schema: created, removed and undo are lists; log is a path or null', () => {
  assert.deepEqual(problems((r) => { r.created.push('/h/.asight/bin/asight-off'); r.removed.push('/h/.config/systemd/user/asight-collector.service'); r.undo.push('asight on'); r.log = '/h/.asight/collector/flows/' }), [])
  for (const key of ['created', 'removed', 'undo']) {
    assert.ok(problems((r) => { r[key] = 'x' }).some((s) => s.includes(key)), key)
    assert.ok(problems((r) => { r[key] = [3] }).some((s) => s.includes(`${key}[0]`)), `${key} item`)
    assert.ok(problems((r) => { r[key] = [''] }).some((s) => s.includes(`${key}[0]`)), `${key} empty item`)
  }
  assert.ok(problems((r) => { r.log = 7 }).some((s) => s.includes('log')))
  assert.ok(problems((r) => { r.log = {} }).some((s) => s.includes('log')))
})

test('receipt schema: a harness field anywhere in the receipt is a canonical id (1.6 R5: harness 印代码 id)', () => {
  assert.deepEqual(problems((r) => { r.still_trusting = [{ harness: 'z-code', pid: 9 }]; r.daemon = { pid: 1, state: 'draining' } }), [], 'extra keys are allowed: R5 lists the least a receipt has')
  assert.ok(problems((r) => { r.still_trusting = [{ harness: 'dsh', pid: 9 }] }).some((s) => s.includes('still_trusting[0].harness')))
  assert.ok(problems((r) => { r.status = { agents: { x: [{ harness: 'zcode' }] } } }).some((s) => s.includes('status.agents.x[0].harness')))
  assert.ok(problems((r) => { r.harness = 'kimi' }).some((s) => s.includes('harness')))
  assert.ok(problems((r) => { r.harnesses = ['claude-code', 'kimi'] }).some((s) => s.includes('harnesses[1]')), 'a list of names too')
  assert.deepEqual(problems((r) => { r.harnesses = ['claude-code', 'codex'] }), [])
})

test('receipt schema: a receipt that went through JSON.stringify and back still validates (what --json prints)', () => {
  const r = newReceipt('status'); r.linger = 'unknown'; r.relayed = 'unknown'; r.restart.push({ harness: 'codex', pid: 1 })
  assert.deepEqual(validateReceipt(JSON.parse(JSON.stringify(r))), [])
})
