// read-fail.test.mjs — 1.5 K-29: a failed /api read says, in the board's own words, what could not be read and the cause class;
// the server's `error` text and thrown messages live only in the collapsed technical details (escaped). Invariants only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFailure } from '../../src/web/v2/core/ui.mjs'
import { statsCardHtml, recentCardHtml, capCardHtml } from '../../src/web/v2/overview/overview.mjs'
import { capHealthPatch } from '../../src/web/v2/core/capture-verdict.mjs'
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

test('AC-3 overview cards: stats and recent read failures, the price line and a 503 capture card keep the reason out of the visible text', () => {
  const NOW = Date.parse('2026-10-20T12:00:00Z')
  const stats = { as_of: new Date(NOW - 3600e3).toISOString(), sessions: { total: 1 }, calls: { llm: 2 }, harnesses: [], usage: { rows: [], coverage: {} } }
  for (const status of [0, 500, 503]) {
    for (const make of [0, 1, 2, 3]) {
      const t = tok(), reason = reasonsWith(t)[make], given = reason !== ''
      const ans = { ok: false, status, error: reason }
      const where = (card) => `${card} · ${status} · ${make}`
      const st = statsCardHtml({ w: '24h', stats: { data: null, ok: false, err: ans } }, NOW)
      hidesReason(st, t, given, where('stats'))
      assert.ok(st.includes('data-act="retry"'), where('stats'))
      const rc = recentCardHtml({ sessions: { data: null, ok: false, err: ans } }, NOW)
      hidesReason(rc, t, given, where('recent'))
      assert.ok(rc.includes('data-act="retry"'), where('recent'))
      const pr = statsCardHtml({ w: '24h', stats: { data: stats, ok: true, err: null, w: '24h' }, pricing: { data: null, ok: false, err: ans } }, NOW)
      hidesReason(pr, t, given, where('price line'))
      if (status === 503 && given) {
        const p = capHealthPatch(ans, NOW)
        const cap = capCardHtml({ caph: { data: p.capH, okAt: p.capHOkAt, err: null, ok: true } }, NOW)
        hidesReason(cap, t, true, where('capture'))
      }
    }
  }
})
