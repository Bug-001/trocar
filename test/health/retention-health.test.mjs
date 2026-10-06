// test/health/retention-health.test.mjs — D40 (RFC 4.6 §记录「保存级别」热读, acceptance K3): a retention.json that cannot be
// read or parsed is a current CONDITION on the collector (the top bar ⚠) until `retention-ok`; a traffic pattern that does
// not compile is a failure of its own, not that condition; the old MITM's line shows as a legacy failure. From disk only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { captureHealth } from '../../src/health/read.mjs'
import { foldFlows } from '../../src/health/flows.mjs'
import { checkRecord, isFailure } from '../../src/health/codes.mjs'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const at = (secAgo) => new Date(NOW - secAgo * 1000).toISOString()
const start = { ts: at(600), event: 'daemon-start', pid: 1 }

test('fold: a retention failure is a condition until retention-ok; pattern-invalid and classify-failed are failures but not that condition', () => {
  const bad = { ts: at(300), event: 'failure', where: 'retention', code: 'retention-unparsable', reason: '/h/.asight/retention.json cannot be parsed (x); every call is kept in full until it can' }
  const f1 = foldFlows([start, bad], { now: NOW })
  assert.deepEqual(f1.conditions.map((c) => [c.kind, c.code, c.failure]), [['retention', 'retention-unparsable', true]])
  assert.deepEqual(f1.groups.map((g) => g.key), ['retention/retention-unparsable'])
  const f2 = foldFlows([start, bad, { ts: at(100), event: 'retention-ok', where: 'retention', reason: 'reads cleanly again' }], { now: NOW })
  assert.deepEqual(f2.conditions, [], 'retention-ok clears it')
  assert.equal(f2.groups.length, 1, 'the failure itself stays in the last 24 h, like every other failure')
  for (const code of ['pattern-invalid', 'classify-failed', 'retention-log-failed']) {
    const f = foldFlows([start, { ts: at(300), event: 'failure', where: 'retention', code, reason: 'r' }], { now: NOW })
    assert.deepEqual([f.conditions.length, f.groups.length], [0, 1], code)
  }
  // an errno from the OS (EACCES) is a retention condition too
  assert.equal(foldFlows([start, { ts: at(50), event: 'failure', where: 'retention', code: 'EACCES', reason: 'denied' }], { now: NOW }).conditions[0].code, 'EACCES')
})

test('every line the retention writes is in the closed sets (src/health/codes.mjs), and only the failures turn the indicator', () => {
  const lines = [
    { event: 'failure', where: 'retention', code: 'retention-unparsable', reason: 'r' }, { event: 'failure', where: 'retention', code: 'retention-unreadable', reason: 'r' },
    { event: 'failure', where: 'retention', code: 'classify-failed', reason: 'r' }, { event: 'failure', where: 'retention', code: 'pattern-invalid', reason: 'r' }, { event: 'failure', where: 'retention', code: 'EACCES', reason: 'r' },
    { event: 'failure', where: 'retention', code: 'retention-log-failed', reason: 'r' },
    { event: 'retention-ok', where: 'retention', reason: 'r' }, { event: 'retention-set', harness: 'cc', class: 'files', from: 'full', to: 'log', source: 'cli' },
    { event: 'retention-set', harness: 'cc', class: 'files', from: 'log', to: 'full', source: 'file', file_sig: '1:2:3' },
  ]
  for (const l of lines) assert.deepEqual(checkRecord({ ts: 't', ...l }), [], JSON.stringify(l))
  assert.deepEqual(lines.map((l) => isFailure(l)), [true, true, true, true, true, true, false, false, false])
})

test('captureHealth over a real collector dir: the condition shows, the state is failing, and retention-ok takes the condition away; the old MITM\'s line is a legacy failure', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-rh-'))
  try {
    const c = path.join(h, 'collector'); fs.mkdirSync(path.join(c, 'flows'), { recursive: true })
    fs.writeFileSync(path.join(c, 'install-manifest.json'), JSON.stringify({ version: 1, complete: true, created_at: at(9999), entries: [], files: [] }))
    fs.writeFileSync(path.join(c, 'lock'), JSON.stringify({ pid: 4242, start_time: '900', boot_id: 'b1' })); const t = new Date(NOW); fs.utimesSync(path.join(c, 'lock'), t, t)
    const day = at(0).slice(0, 10), flow = path.join(c, 'flows', `${day}.ndjson`)
    const write = (...recs) => fs.appendFileSync(flow, recs.map((r) => JSON.stringify(r) + '\n').join(''))
    const health = () => captureHealth({ home: h, now: NOW, alive: () => true, identity: () => ({ start_time: '900', boot_id: 'b1' }) })
    write(start, { ts: at(200), event: 'failure', where: 'retention', code: 'retention-unparsable', reason: 'torn' })
    const bad = health()
    assert.deepEqual(bad.collector.conditions.map((x) => x.kind), ['retention']); assert.equal(bad.summary.state, 'failing')
    write({ ts: at(100), event: 'retention-ok', where: 'retention', reason: 'ok' })
    assert.deepEqual(health().collector.conditions, [])
    // the old capture: one line in logs/mitm-events.ndjson
    fs.mkdirSync(path.join(h, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(h, 'logs', 'mitm-events.ndjson'), [{ ts: at(500), event: 'mitm-start', source: 'mitm', pid: process.pid, port: 1, out: '/x' }, { ts: at(60), event: 'failure', where: 'retention', code: 'retention-unparsable', reason: 'torn' }].map((r) => JSON.stringify(r)).join('\n') + '\n')
    const legacy = health().legacy
    assert.deepEqual([legacy.summary.state, legacy.failures.map((g) => g.key)], ['failing', ['retention/retention-unparsable']])
  } finally { fs.rmSync(h, { recursive: true, force: true }) }
})
