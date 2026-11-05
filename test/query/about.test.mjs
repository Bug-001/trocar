// test/query/about.test.mjs — every named query describes itself beside its declaration (RFC 1.6 §4.1, V121): a summary and one line per
// parameter, in the words a reader of `--help` gets (§1.1). Generated over the one table, so a query added later is held to the same rule.
import test from 'node:test'
import assert from 'node:assert/strict'
import { QUERIES } from '../../src/query/named/index.mjs'
import { assertEnglish } from '../helpers/english.mjs'

const filled = (v) => typeof v === 'string' && v.trim() !== ''

test('every query has a summary and one line per parameter, in the order of its parameters', () => {
  for (const [name, q] of Object.entries(QUERIES)) {
    assert.ok(filled(q.about?.summary), `${name}: no summary`)
    for (const p of q.params) assert.ok(filled(q.about.params[p]), `${name} --${p}: no line`)
    assert.deepEqual(Object.keys(q.about.params), [...q.params], `${name}: the lines are not its parameters`)
  }
})

test('every line of every description is text a person can read', () => {
  for (const [name, q] of Object.entries(QUERIES)) {
    assertEnglish(q.about.summary, `${name}'s summary`, { width: false })
    for (const [p, line] of Object.entries(q.about.params)) assertEnglish(line, `${name} --${p}`, { width: false })
  }
})
