// test/collector/core/events.test.mjs — durable failure records (D38): appendEvent / recentFailures
// and the daemon's failure recorder (one line per place and error code per window; folded counts never lost).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendEvent, recentFailures, createFailureRecorder } from '../../../src/collector/core/events.mjs'
import { readFlows, foldFlows } from '../../../src/health/flows.mjs'

function box() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-ev-')); return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) } }

test('events: failures go to flows/<date>.ndjson (0600), never a top-level *.ndjson; recentFailures reads them back', () => {
  const b = box()
  try {
    appendEvent(b.dir, { event: 'failure', where: 'x', reason: 'r1' }, { now: new Date('2026-10-06T01:00:00Z') })
    appendEvent(b.dir, { event: 'switch', desired: 'on' }, { now: new Date('2026-10-06T01:00:01Z') })
    appendEvent(b.dir, { flow_id: 'f1', reason: 'client-rejected-leaf' }, { now: new Date('2026-10-06T01:00:02Z') })
    appendEvent(b.dir, { flow_id: 'f2', decision: 'splice', not_captured: 'policy' }, { now: new Date('2026-10-06T01:00:03Z') }) // expected, not a failure (D38)
    appendEvent(b.dir, { flow_id: 'f3', decision: 'splice', not_captured: 'negative-cache' }, { now: new Date('2026-10-06T01:00:04Z') })
    assert.deepEqual(fs.readdirSync(b.dir), ['flows'], 'nothing the board would read as an envelope')
    assert.equal(fs.statSync(path.join(b.dir, 'flows', '2026-10-06.ndjson')).mode & 0o777, 0o600)
    assert.deepEqual(recentFailures(b.dir).map((f) => f.where || f.reason || f.not_captured), ['x', 'client-rejected-leaf', 'negative-cache'], 'failures only, not the switch event nor an expected not_captured row')
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

// D-1: a line that cannot be written is never silent — stderr each time, a count status reports, and once writing
// works again the first line on disk is a log-gap with the window and the count.
test('failure recorder: lines it cannot write go to stderr and the lost count; the next written line is a log-gap (D-1)', () => {
  const b = box()
  const logged = []
  let broken = 2
  const append = (dir, rec) => { if (broken > 0) { broken--; throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) } appendEvent(dir, rec) }
  const t = ['2026-10-06T01:00:00.000Z', '2026-10-06T01:00:05.000Z', '2026-10-06T01:00:09.000Z']
  const rec = createFailureRecorder(b.dir, { append, log: (w, e) => logged.push([w, e.code]), setTimer: () => ({}), clearTimer: () => {}, now: () => new Date(t.shift() || '2026-10-06T01:00:10.000Z') })
  try {
    rec.write({ event: 'switch', desired: 'on', actual: 'on' })
    rec('helper', Object.assign(new Error('ringbuf poll failed'), { code: 'helper-error' }))
    assert.deepEqual(rec.health(), { lost: 2, losing_since: '2026-10-06T01:00:00.000Z', lost_now: 2, last_error: 'ENOSPC: no space left on device' })
    assert.deepEqual(logged.filter(([w]) => w === 'events').map(([, c]) => c), ['ENOSPC', 'ENOSPC'], 'stderr has each')
    rec.write({ event: 'switch', desired: 'off', actual: 'off' })
    const lines = fs.readFileSync(path.join(b.dir, 'flows', fs.readdirSync(path.join(b.dir, 'flows'))[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(lines.map((l) => [l.event, l.lost ?? null, l.from ?? null, l.to ?? null]), [['log-gap', 2, '2026-10-06T01:00:00.000Z', '2026-10-06T01:00:09.000Z'], ['switch', null, null, null]])
    assert.match(lines[0].reason, /2 event line\(s\) could not be written \(ENOSPC/)
    assert.deepEqual(rec.health(), { lost: 2 }, 'the gap is closed; the total stays for status')
    assert.equal(recentFailures(b.dir)[0].event, 'log-gap', 'a log-gap is a failure status lists')
  } finally { b.done() }
})

// D-2: only a missing flows/ is "nothing recorded"; an unreadable directory throws, never "no failures" (the reader is
// src/health/flows.mjs, tested in full in test/health/flows.test.mjs).
test('recentFailures reads through the health reader: no flows/ is nothing yet, an unreadable flows/ throws (D-2)', () => {
  const b = box()
  try {
    assert.deepEqual(recentFailures(b.dir), [], 'no flows/ yet: nothing recorded')
    fs.writeFileSync(path.join(b.dir, 'flows'), 'not a directory')
    assert.throws(() => recentFailures(b.dir), /ENOTDIR|not a directory/)
  } finally { b.done() }
})

test('the failure recorder never goes back a day when the clock does (4.6 §记录)', () => {
  const calls = []
  let clock = '2026-10-06T00:00:10.000Z'
  const rec = createFailureRecorder('/d', { append: (dir, r, o) => calls.push(o && o.day), now: () => new Date(clock), setTimer: () => null, clearTimer: () => {} })
  rec.write({ event: 'switch' })
  clock = '2026-10-05T23:50:00.000Z'
  rec.write({ event: 'switch' })
  clock = '2026-10-07T00:00:00.000Z'
  rec.write({ event: 'switch' })
  assert.deepEqual(calls, ['2026-10-06', '2026-10-06', '2026-10-07'])
})

// D1-1 (4.6 §事件与码): a negative-cache write is a condition per (pid, host). Folding it by where + code kept only the
// first and the last pair of a window: the ones between were on neither the disk nor the board.
test('failure recorder: negative-cache writes are never folded — every (pid, host) inside one window is its own line and its own condition (D1-1)', () => {
  const b = box()
  const rec = createFailureRecorder(b.dir, { setTimer: () => ({}), clearTimer: () => {} })
  try {
    rec.write({ event: 'daemon-start', pid: 1 })
    const pairs = [[42, 'a.example'], [42, 'b.example'], [42, 'c.example'], [43, 'a.example']]
    for (const [pid, host] of pairs) rec.event({ where: 'engine', code: 'negative-cache', pid, host, cause: 'client-rejected-leaf', reason: `${host} no longer decrypted for pid ${pid}` })
    rec('engine', Object.assign(new Error('miss 1'), { code: 'lookup-miss' })); rec('engine', Object.assign(new Error('miss 2'), { code: 'lookup-miss' })) // other codes still fold
    rec.flush()
    const lines = fs.readFileSync(path.join(b.dir, 'flows', fs.readdirSync(path.join(b.dir, 'flows'))[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const neg = lines.filter((l) => l.code === 'negative-cache')
    assert.deepEqual(neg.map((l) => [l.pid, l.host, l.suppressed ?? 0, !!l.folded]), pairs.map(([p, h]) => [p, h, 0, false]), 'one unfolded line per pair')
    assert.deepEqual(lines.filter((l) => l.code === 'lookup-miss').map((l) => l.suppressed ?? 0), [0, 1], 'lookup-miss is still folded per window')
    const f = foldFlows(readFlows({ dir: b.dir }).records)
    assert.deepEqual(f.conditions.filter((c) => c.kind === 'negative-cache').map((c) => [c.pid, c.host]), pairs, 'the board lists every (pid, host)')
    assert.equal(f.groups.find((g) => g.key === 'engine/negative-cache').count, 4, 'counted once each')
  } finally { b.done() }
})
