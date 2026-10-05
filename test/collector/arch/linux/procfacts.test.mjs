// test/collector/arch/linux/procfacts.test.mjs — ProcFacts from a synthetic /proc tree (no root).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStatus, readCwd, readStartTime, readFacts } from '../../../../src/collector/arch/linux/procinfo.mjs'
import { fakeProc } from './fixtures/fake-proc.mjs'

test('procinfo: status, cwd and start time come from /proc; a vanished pid is null, not a throw', () => {
  const p = fakeProc()
  try {
    p.add(321, { ppid: 7, uid: 1000, exe: '/opt/alpha', argv: ['alpha', 'run'], cwd: '/work', startTicks: 250 })
    assert.deepEqual(readStatus(321, { root: p.root }), { ppid: 7, uid: 1000 })
    assert.equal(readCwd(321, { root: p.root }), '/work')
    assert.equal(readStartTime(321, { root: p.root }), (p.btime + 2.5) * 1000)
    for (const fn of [readStatus, readCwd, readStartTime]) assert.equal(fn(999, { root: p.root }), null)
  } finally { p.done() }
})

test('procinfo: readFacts builds OS-neutral facts; environ is read on first access only', () => {
  const p = fakeProc()
  try {
    p.add(42, { ppid: 1, uid: 1000, exe: '/home/u/.kimi-code/bin/kimi', argv: ['kimi-code'], cwd: '/w', startTicks: 100, comm: 'kimi (x) y' })
    const f = readFacts(42, { root: p.root, source: 'exec' })
    const keys = ['os', 'pid', 'ppid', 'uid', 'exe', 'argv', 'cwd', 'startedAt', 'source'] // not `env`: reading it is the access under test
    assert.deepEqual(Object.fromEntries(keys.map((k) => [k, f[k]])), { os: 'linux', pid: 42, ppid: 1, uid: 1000, exe: '/home/u/.kimi-code/bin/kimi', argv: ['kimi-code'], cwd: '/w', startedAt: (p.btime + 1) * 1000, source: 'exec' })
    assert.ok(Object.keys(f).includes('env'))
    fs.writeFileSync(path.join(p.root, '42', 'environ'), 'A=1\0B=two\0') // written after readFacts, before first access
    assert.equal(f.env.get('B'), 'two')
    fs.writeFileSync(path.join(p.root, '42', 'environ'), 'B=changed\0')
    assert.equal(f.env.get('B'), 'two', 'memoised')
    assert.equal(readFacts(4242, { root: p.root, source: 'scan' }), null)
  } finally { p.done() }
})
