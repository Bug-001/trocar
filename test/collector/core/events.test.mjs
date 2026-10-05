// test/collector/core/events.test.mjs — durable failure records (D38): appendEvent / recentFailures
// and the daemon's failure recorder (one line per place and error code per window; folded counts never lost).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendEvent, recentFailures, createFailureRecorder } from '../../../src/collector/core/events.mjs'

function box() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-ev-')); return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) } }

test('events: failures go to flows/<date>.ndjson (0600), never a top-level *.ndjson; recentFailures reads them back', () => {
  const b = box()
  try {
    appendEvent(b.dir, { event: 'failure', where: 'x', reason: 'r1' }, { now: new Date('2026-10-06T01:00:00Z') })
    appendEvent(b.dir, { event: 'switch', desired: 'on' }, { now: new Date('2026-10-06T01:00:01Z') })
    appendEvent(b.dir, { flow_id: 'f1', reason: 'client-rejected-leaf' }, { now: new Date('2026-10-06T01:00:02Z') })
    assert.deepEqual(fs.readdirSync(b.dir), ['flows'], 'nothing the board would read as an envelope')
    assert.equal(fs.statSync(path.join(b.dir, 'flows', '2026-10-06.ndjson')).mode & 0o777, 0o600)
    assert.deepEqual(recentFailures(b.dir).map((f) => f.where || f.reason), ['x', 'client-rejected-leaf'], 'failures only, not the switch event')
  } finally { b.done() }
})

test('failure recorder: one line per place AND error code per window; the folded count is written when the window closes and at flush', () => {
  const b = box()
  const timers = []
  const rec = createFailureRecorder(b.dir, { setTimer: (fn) => { const t = { fn, unref() {} }; timers.push(t); return t }, clearTimer: (t) => { t.cleared = true } })
  const lines = () => fs.readFileSync(path.join(b.dir, 'flows', fs.readdirSync(path.join(b.dir, 'flows'))[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  try {
    const miss = (n) => Object.assign(new Error(`miss ${n}`), { code: 'lookup-miss' })
    rec('engine', miss(1)); rec('engine', miss(2)); rec('engine', miss(3))
    rec('engine', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE' })) // another code in the same place: its own line
    assert.deepEqual(lines().map((l) => [l.where, l.code, l.reason, l.suppressed]), [['engine', 'lookup-miss', 'miss 1', undefined], ['engine', 'EMFILE', 'accept EMFILE', undefined]])
    timers[0].fn() // the lookup-miss window closes: its folded count is written
    assert.deepEqual(lines().slice(-1).map((l) => [l.code, l.reason, l.suppressed, l.folded]), [['lookup-miss', 'miss 3', 2, true]])
    rec('engine', miss(4)); rec('engine', miss(5)) // a new window
    rec.flush() // the daemon stops: nothing folded is lost
    assert.deepEqual(lines().slice(-2).map((l) => [l.reason, l.suppressed]), [['miss 4', undefined], ['miss 5', 1]])
    assert.ok(lines().every((l) => typeof l.reason === 'string' && l.event === 'failure'), 'every record carries reason')
  } finally { b.done() }
})
