// test/classes/source.test.mjs — createClassSource: WHEN the capture re-reads the class table (D60③, 4.6 §记录「保存级别」·生效).
// Acceptance: an edit of classes.json reaches the calls that START within 1 s of it; a call already in flight keeps the
// level it started with; a file that cannot be read never costs a call its bytes (one failure event, builtin table).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createClassSource } from '../../src/classes/source.mjs'
import { BUILTIN } from '../../src/classes/table.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const CALL = { host: 'api.example.test', path: '/v1/messages', harness: 'claude-code' }
const write = (home, keep) => fs.writeFileSync(path.join(home, 'classes.json'), JSON.stringify({ version: 1, classes: BUILTIN.map((c) => (c.class === 'llm' ? { ...c, keep } : c)) }))
// a call samples class + level once, at its start — exactly what the engine does
const sample = (src) => { const cls = src.classOf(CALL); return { class: cls, level: src.keepOf(cls) } }

test('an edit applies within 1 s and only to calls that start after it; a call already in flight keeps its level', () => {
  const home = tmpDir('trocar-cs-')
  let t = 1_000_000
  const src = createClassSource({ home, now: () => t })
  assert.deepEqual(sample(src), { class: 'llm', level: 'full' }, 'no file: the builtin table, every class full')
  const inFlight = sample(src) // this call is now open: its level is the one it started with
  write(home, 'log')
  t += 500
  assert.deepEqual(sample(src), { class: 'llm', level: 'full' }, 'within the recheck window the file is not re-read')
  t += 600
  assert.deepEqual(sample(src), { class: 'llm', level: 'log' }, 'the next call after the recheck gets the new level')
  assert.deepEqual(inFlight, { class: 'llm', level: 'full' }, 'the in-flight call keeps what it started with')
})

test('an unparsable classes.json falls back to the builtin table with ONE failure event per state change, and classifying goes on', () => {
  const home = tmpDir('trocar-cs-')
  write(home, 'log')
  let t = 1_000_000
  const recs = []
  const src = createClassSource({ home, now: () => t, onFailure: (r) => recs.push(r), onOk: (r) => recs.push(r) })
  assert.equal(sample(src).level, 'log')
  fs.writeFileSync(path.join(home, 'classes.json'), '{ torn')
  t += 1100
  assert.deepEqual(sample(src), { class: 'llm', level: 'full' }, 'the builtin table applies: nothing is dropped and nothing is kept less than full')
  t += 1100; sample(src) // a second call over the same bad file
  assert.deepEqual(recs.map((r) => [r.event, r.where, r.code]), [['failure', 'classes', 'classes-unparsable']], 'one event per state change, not one per call')
  assert.match(recs[0].reason, /builtin class table applies/)
  write(home, 'log'); t += 1100
  assert.equal(sample(src).level, 'log', 'readable again: the file applies from the next call')
  assert.deepEqual(recs.map((r) => r.event), ['failure', 'classes-ok'])
})

test('a rule that does not compile is `pattern-invalid` (4.6 §记录), the rest of the table still classifies', () => {
  const home = tmpDir('trocar-cs-')
  fs.writeFileSync(path.join(home, 'classes.json'), JSON.stringify({ version: 1, classes: [{ class: 'mine', keep: 'log', rules: [{ host: '(' }, { host: 'api\\.example\\.test' }] }] }))
  const recs = []
  const src = createClassSource({ home, onFailure: (r) => recs.push(r) })
  assert.deepEqual(sample(src), { class: 'mine', level: 'log' })
  assert.deepEqual(recs.map((r) => [r.where, r.code]), [['classes', 'pattern-invalid']])
})
