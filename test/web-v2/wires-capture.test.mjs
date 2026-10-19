// wires-capture.test.mjs — the capture verdict, the capture page's rows and the capture log read the C.3 `status` document
// (1.6 C.3, 1.5 §采集状态, 1.9 §采集服务行 · §每个 agent 一行 · §采集记录). `health` and a group's `where` are read by field
// presence (K-28): every assertion holds with and without them. Expected values come from the spec's own sample and table.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { logRowsOf } from '../../src/web/v2/capture/capture-log.mjs'
import { failureBrief } from '../../src/cli/words.mjs'

const SPEC = fs.readFileSync(new URL('../../spec/01-asight-rfc/1.6-cli.md', import.meta.url), 'utf8')
const C3 = SPEC.slice(SPEC.indexOf('### C.3'))
const sample = () => JSON.parse(/```json\n([\s\S]*?)```/.exec(C3)[1])
test('(3) the capture log: one row per failures.groups[] entry, worded by failureBrief; a group without where is reason-unknown', () => {
  const s = sample()
  const { rows } = logRowsOf(s)
  assert.equal(rows.length, s.failures.groups.length)
  for (const r of rows) {
    assert.ok(s.failures.groups.includes(r.g))
    assert.equal(r.s.text, failureBrief(r.g))
    assert.equal(r.s.unknown, false)
  }
  const bare = sample(); for (const g of bare.failures.groups) delete g.where
  const out = logRowsOf(bare)
  assert.equal(out.rows.length, bare.failures.groups.length)
  for (const r of out.rows) {
    assert.equal(r.s.unknown, true)
    assert.equal(r.s.code, r.g.code)
    assert.ok(out.html.includes(r.g.code), 'the code is in the technical details')
  }
})

