// read-fail.test.mjs — 1.5 K-29: a failed /api read says, in the board's own words, what could not be read and the cause class;
// the server's `error` text and thrown messages live only in the collapsed technical details (escaped). Invariants only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFailure } from '../../src/web/v2/core/ui.mjs'
import { hidesReason, reasonsWith } from './visible.mjs'

let n = 0
const tok = () => `tok-${++n}-q7`

test('AC-1 readFailure: the visible line holds none of the reason; the reason is escaped in collapsed technical details', () => {
  for (const status of [0, 404, 500, 503, undefined, 'bare']) {
    for (const make of [0, 1, 2, 3]) {
      const t = tok(), reason = reasonsWith(t)[make]
      const r = status === 'bare' ? reason : { ok: false, status, error: reason }
      const { line, tech } = readFailure('Stats', r, { id: `f-${n}` })
      const where = `${status} · ${make}`
      assert.equal(typeof line, 'string', where)
      assert.ok(line.trim(), where)
      assert.ok(!line.includes('\n'), where)
      assert.ok(!line.includes(t), where)
      assert.ok(/<div class="disc-b"[^>]*\shidden>/.test(tech), `${where}: details are collapsed`)
      hidesReason(tech, t, reason !== '', where)
    }
  }
  const none = readFailure('Stats', null)
  assert.ok(none.line.trim() && !none.line.includes('\n'))
})
