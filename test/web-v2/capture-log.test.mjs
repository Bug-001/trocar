// capture-log.test.mjs — the 采集记录 page (1.9 §采集记录, item 18): the metadata sentence is said once per page, the row's technical
// details write first / latest in the row's own local-time form, and the by-design list in the page foot has one heading. The
// documents are the C.3 sample of spec 1.6 with the failure groups each axis varies.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pageLogHtml } from '../../web/legacy/capture/capture-log.mjs'
import { failureSentence } from '../../web/legacy/core/capture-verdict.mjs'
import { fmtWhen } from '../../web/legacy/core/fmt.mjs'
import { LOG } from '../../web/legacy/labels/capture.mjs'

const SPEC = fs.readFileSync(new URL('../../spec/01-trocar-rfc/1.6-cli.md', import.meta.url), 'utf8')
const C3 = SPEC.slice(SPEC.indexOf('### C.3'))
const sample = () => JSON.parse(/```json\n([\s\S]*?)```/.exec(C3)[1])
const T = '2026-10-20T09:00:00Z'

function doc(groups) {
  const d = sample()
  d.failures = { since: T, groups }; d.errors = []
  return d
}
const at = (i) => new Date(Date.parse(T) + i * 60e3).toISOString()
const problem = (i) => ({ level: i % 2 ? 'note' : 'problem', where: 'flow', code: `code-${i}`, count: i + 1, first_ts: at(i), last_ts: at(i + 1), harness: 'codex', reason: `r${i}` })
const expected = (i) => ({ level: 'expected', where: 'flow', code: `expected-${i}`, count: i + 2, first_ts: at(i), last_ts: at(i + 3), reason: `e${i}` })
const count = (s, needle) => s.split(needle).length - 1

test('item 18 / L1: the metadata sentence is said once per page whatever the row count, and not at all on an empty log', () => {
  for (const n of [1, 4]) assert.equal(count(pageLogHtml(doc(Array.from({ length: n }, (_, i) => problem(i)))), LOG.metadataOnly), 1, `${n} rows`)
  assert.equal(count(pageLogHtml(doc([])), LOG.metadataOnly), 0)
})

test('item 18 / L2: the by-design foot has one heading and one line per expected group; no expected group, no heading', () => {
  for (const n of [1, 3]) {
    const gs = Array.from({ length: n }, (_, i) => expected(i))
    const html = pageLogHtml(doc([problem(0), ...gs]))
    assert.equal(count(html, LOG.expectedTitle), 1, `${n} expected groups`)
    for (const g of gs) assert.equal(count(html, failureSentence(g).text), 1, g.code)
  }
  assert.equal(count(pageLogHtml(doc([problem(0)])), LOG.expectedTitle), 0)
})

test('item 18 / L3: a row\'s technical details write first / latest as the row\'s time column does, never the raw ISO', () => {
  const g = problem(0)
  const html = pageLogHtml(doc([g]))
  const i = html.indexOf('<div class="tech">'), tech = html.slice(i, html.indexOf('</div>', i))
  assert.ok(i >= 0)
  for (const ts of [g.first_ts, g.last_ts]) {
    assert.ok(!tech.includes(ts), ts)
    assert.ok(tech.includes(fmtWhen(ts)), fmtWhen(ts))
  }
})
