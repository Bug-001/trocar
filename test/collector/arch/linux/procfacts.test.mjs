// test/collector/arch/linux/procfacts.test.mjs — ProcFacts from a synthetic /proc tree (no root).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStatus, readCwd, readStartTime, readStartTicks, readFacts } from '../../../../src/collector/arch/linux/procinfo.mjs'
import { fakeProc } from './fixtures/fake-proc.mjs'

test('procinfo: status, cwd and start time come from /proc; a vanished pid is null, not a throw', () => {
  const p = fakeProc()
  try {
    p.add(321, { ppid: 7, uid: 1000, exe: '/opt/alpha', argv: ['alpha', 'run'], cwd: '/work', startTicks: 250 })
    assert.deepEqual(readStatus(321, { root: p.root }), { ppid: 7, uid: 1000 })
    assert.equal(readCwd(321, { root: p.root }), '/work')
    assert.equal(readStartTime(321, { root: p.root }), (p.btime + 2.5) * 1000)
    assert.equal(readStartTicks(321, { root: p.root }), '250', 'field 22 verbatim: the value a trust plugin writes into its marker (4.6 「标记」)')
    for (const fn of [readStatus, readCwd, readStartTime, readStartTicks]) assert.equal(fn(999, { root: p.root }), null)
  } finally { p.done() }
})

test('procinfo: with /proc/uptime the start time is placed on the wall clock to the tick, not on whole-second btime', () => {
  const p = fakeProc()
  try {
    p.add(321, { exe: '/opt/alpha', startTicks: 250 }) // started 2.5 s after boot
    fs.writeFileSync(path.join(p.root, 'uptime'), '100.37 400.00\n') // up for 100.37 s at `now`
    const now = () => 1_800_000_000_000
    assert.equal(readStartTime(321, { root: p.root, now }), 1_800_000_000_000 - (100.37 - 2.5) * 1000)
  } finally { p.done() }
})

test('procinfo: readFacts builds OS-neutral facts; environ is read on first access only', () => {
  const p = fakeProc()
  try {
    p.add(42, { ppid: 1, uid: 1000, exe: '/home/u/.kimi-code/bin/kimi', argv: ['kimi-code'], cwd: '/w', startTicks: 100, comm: 'kimi (x) y' })
    const f = readFacts(42, { root: p.root, source: 'exec' })
    const keys = ['os', 'pid', 'ppid', 'uid', 'exe', 'argv', 'cwd', 'startedAt', 'startTicks', 'source'] // not `env`: reading it is the access under test
    assert.deepEqual(Object.fromEntries(keys.map((k) => [k, f[k]])), { os: 'linux', pid: 42, ppid: 1, uid: 1000, exe: '/home/u/.kimi-code/bin/kimi', argv: ['kimi-code'], cwd: '/w', startedAt: (p.btime + 1) * 1000, startTicks: '100', source: 'exec' })
    assert.ok(Object.keys(f).includes('env'))
    fs.writeFileSync(path.join(p.root, '42', 'environ'), 'A=1\0B=two\0') // written after readFacts, before first access
    assert.equal(f.env.get('B'), 'two')
    fs.writeFileSync(path.join(p.root, '42', 'environ'), 'B=changed\0')
    assert.equal(f.env.get('B'), 'two', 'memoised')
    assert.equal(readFacts(4242, { root: p.root, source: 'scan' }), null)
  } finally { p.done() }
})

// D-20: an environment that cannot be read is null with the reason, never an empty one a trust check would accept.
test('procinfo: readFacts env is null with envError when environ is unreadable', () => {
  const p = fakeProc()
  try {
    p.add(43, { env: { A: '1' } })
    fs.chmodSync(path.join(p.root, '43', 'environ'), 0)
    const f = readFacts(43, { root: p.root })
    assert.deepEqual([f.env, f.envError], [null, 'EACCES'])
  } finally { p.done() }
})
