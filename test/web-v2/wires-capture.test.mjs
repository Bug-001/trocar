// wires-capture.test.mjs — the capture verdict, the capture page's rows and the capture log read the C.3 `status` document
// (1.6 C.3, 1.5 §采集状态, 1.9 §采集服务行 · §每个 agent 一行 · §采集记录). `health` and a group's `where` are read by field
// presence (K-28): every assertion holds with and without them. Expected values come from the spec's own sample and table.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { captureVerdict, capHealthPatch, agentVerdicts, AGENT_TIER } from '../../src/web/v2/core/capture-verdict.mjs'
import { harnessKey } from '../../src/web/v2/core/chips.mjs'
import { logRowsOf } from '../../src/web/v2/capture/capture-log.mjs'
import { pageHtml } from '../../src/web/v2/capture/capture-view.mjs'
import { failureBrief } from '../../src/cli/words.mjs'
import { boardHome, serveBoard } from './real-face.mjs'

const SPEC = fs.readFileSync(new URL('../../spec/01-asight-rfc/1.6-cli.md', import.meta.url), 'utf8')
const C3 = SPEC.slice(SPEC.indexOf('### C.3'))
const sample = () => JSON.parse(/```json\n([\s\S]*?)```/.exec(C3)[1])
// the closed set of health.state, read off the C.3 table's `health` row (one fact, one place)
const HEALTH_STATES = (() => {
  const row = C3.split('\n').find((l) => l.startsWith('| `health` |'))
  const seg = row.slice(row.indexOf('`state` ∈'), row.indexOf('另带'))
  return [...seg.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).filter((s) => s !== 'state')
})()
const NOT_KNOWN = 'unknown' // K-28: health absent → 不知道 = the closed set's `unknown`

test('(1) the real status document: the verdict is doc.health.state, or not known when health is absent', async () => {
  const face = await serveBoard(boardHome())
  try {
    const { status, doc } = await face.get('status')
    assert.equal(status, 200)
    const v = captureVerdict(doc)
    assert.equal(v.state, doc.health ? doc.health.state : NOT_KNOWN)
  } finally { await face.close() }
})

test('(2) the spec sample: health.state is the verdict; absent → not known; every closed state words a non-empty sentence', () => {
  const s = sample()
  assert.equal(captureVerdict(s).state, s.health.state)
  const noHealth = sample(); delete noHealth.health
  assert.equal(captureVerdict(noHealth).state, NOT_KNOWN)
  assert.ok(HEALTH_STATES.length >= 8, `the C.3 table names the closed set: ${HEALTH_STATES}`)
  for (const state of HEALTH_STATES) {
    for (const health of [{ ...s.health, state }, { state }]) {
      const v = captureVerdict({ ...sample(), health })
      assert.equal(typeof v.text, 'string', state)
      assert.ok(v.text.trim().length > 0 && !/undefined|NaN/.test(v.text), `${state}: ${v.text}`)
    }
  }
})

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

test('(4) agent rows are the union of the five C.3 sources through harnessKey; a stopped daemon puts no row in the capturing tier', () => {
  const s = sample()
  const ids = new Set([
    ...Object.keys(s.harnesses), ...s.critical.map((c) => c.harness), ...s.failures.groups.map((g) => g.harness),
    ...s.changed.map((c) => c.harness), ...Object.keys(s.topology),
  ].filter((x) => x != null).map(harnessKey))
  assert.deepEqual(new Set(agentVerdicts(s).map((r) => r.harness)), ids)
  const down = sample(); down.daemon.running = false
  for (const h of Object.values(down.harnesses)) h.captured = true
  for (const t of Object.values(down.topology)) t.captured = true
  assert.ok(agentVerdicts(down).every((r) => r.tier !== AGENT_TIER.fine))
})

test('(5) capHealthPatch: a 200 status document without health is a good answer', () => {
  const doc = sample(); delete doc.health
  const p = capHealthPatch({ ok: true, status: 200, data: doc }, 1)
  assert.equal(p.capHErr, null)
  assert.equal(p.capH, doc)
})

test('(6) before the status document answers, the page states no fact about agents (D38: never an invented empty)', () => {
  const reading = pageHtml(null, captureVerdict(null, {}))
  const answered = pageHtml({}, captureVerdict({}, {})) // a document that names no agent
  assert.equal(/class="capfoot"/.test(reading), false)
  assert.equal(/class="capfoot"/.test(answered), true) // the same predicate draws it once there is an empty answer
})
