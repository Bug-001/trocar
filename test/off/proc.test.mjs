// test/off/proc.test.mjs — src/off/proc.mjs (RFC 4.6 撤销顺序第 2 / 5 步, 1.6 R3): the process table `off` reads for itself. The old capture's
// daemon is stopped and the entries are undone by then, so "which agents are alive" comes from /proc (Linux) or `ps` (macOS) read here, with
// no daemon and no collector code. A table that cannot be read is an error, never an empty table: an empty one would say "nobody holds the
// bundle" and delete it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { listProcs, procIdentity, pidAlive } from '../../src/off/proc.mjs'
import * as procinfo from '../../src/collector/arch/linux/procinfo.mjs'
import * as health from '../../src/health/read.mjs'
import { fakeProc } from '../collector/arch/linux/fixtures/fake-proc.mjs'
import { takeRefusals } from '../helpers/no-real-os.mjs'

test('listProcs on a /proc tree: this uid\'s processes with pid, start time, exe, argv and a lazy environment; other users\' and non-process entries are not in it', async () => {
  const p = fakeProc()
  try {
    p.add(100, { uid: 1000, exe: '/home/u/.local/bin/codex', argv: ['codex', 'app-server'], env: { CODEX_HOME: '/h/.codex' }, startTicks: 250 })
    p.add(101, { uid: 1000, ppid: 100, exe: '/usr/bin/bash', argv: ['bash'] }) // no environ file: cannot be read
    p.add(102, { uid: 2000, exe: '/usr/bin/other', argv: ['other'] })
    fs.writeFileSync(path.join(p.root, 'version'), 'x'); fs.mkdirSync(path.join(p.root, 'self'))
    const got = await listProcs({ uid: 1000, root: p.root, platform: 'linux' })
    assert.deepEqual(got.map((f) => f.pid).sort(), [100, 101])
    const codex = got.find((f) => f.pid === 100)
    assert.deepEqual([codex.exe, codex.argv, codex.startedAt, codex.uid], ['/home/u/.local/bin/codex', ['codex', 'app-server'], (p.btime + 2.5) * 1000, 1000])
    assert.deepEqual(got.map((f) => [f.pid, f.ppid]).sort(), [[100, 1], [101, 100]], 'who started it: a child that inherited an environment is told by its ancestors')
    assert.equal(typeof codex.env, 'function', 'the environment is read when asked for, not for every process of the machine')
    assert.deepEqual([...codex.env()], [['CODEX_HOME', '/h/.codex']])
    assert.equal(got.find((f) => f.pid === 101).env(), null, 'an environment that cannot be read is null, not an empty one')
    assert.equal((await listProcs({ uid: null, root: p.root, platform: 'linux' })).length, 3, 'no uid given: every process')
  } finally { p.done() }
})

test('listProcs fails loudly when the table cannot be read, and on a platform it has no reader for', async () => {
  await assert.rejects(listProcs({ uid: 1000, root: path.join(fakeProc().root, 'nowhere'), platform: 'linux' }), /nowhere/)
  await assert.rejects(listProcs({ uid: 1000, platform: 'win32' }), /win32/)
})

test('listProcs on macOS reads `ps` through the injected runner: pid, parent, uid, start time and the command line; its environment is unknown', async () => {
  const ps = ['  501     1   501 Wed Oct  7 04:27:00 2026 /Applications/Claude.app/Contents/MacOS/claude --flag x', '  777     1     0 Tue Oct  6 01:02:03 2026 /usr/sbin/mDNSResponder', '  502   501   501 Wed Oct  7 05:00:00 2026 /usr/local/bin/codex app-server', ''].join('\n')
  const calls = []
  const exec = (file, args) => { calls.push([file, ...args]); return { status: 0, stdout: ps, stderr: '' } }
  const got = await listProcs({ uid: 501, platform: 'darwin', exec })
  assert.deepEqual(calls, [['ps', '-Axo', 'pid=,ppid=,uid=,lstart=,command=']])
  assert.deepEqual(got.map((f) => [f.pid, f.ppid, f.uid]), [[501, 1, 501], [502, 501, 501]])
  assert.deepEqual(got.map((f) => [f.pid, f.exe, f.argv]), [[501, '/Applications/Claude.app/Contents/MacOS/claude', ['/Applications/Claude.app/Contents/MacOS/claude', '--flag', 'x']], [502, '/usr/local/bin/codex', ['/usr/local/bin/codex', 'app-server']]])
  assert.equal(got[0].startedAt, new Date(2026, 9, 7, 4, 27, 0).getTime(), 'lstart is local time')
  assert.equal(got[0].env(), null)
  await assert.rejects(listProcs({ uid: 501, platform: 'darwin', exec: () => ({ status: 1, stdout: '', stderr: 'ps: nope' }) }), /ps.*nope/)
})

test('listProcs on macOS without an injected runner does not run a real ps under npm test (0.1 §3)', async () => {
  await assert.rejects(listProcs({ uid: 501, platform: 'darwin' }), { code: 'ESANDBOX' })
  assert.deepEqual(takeRefusals().map((r) => r.tool), ['ps'])
})

test('procIdentity and pidAlive are the ones src/health/read.mjs and the Linux arch re-export (they moved here)', () => {
  assert.equal(health.procIdentity, procIdentity)
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(2 ** 22 + 12345), false, 'a pid that is not there')
})

test('the /proc readers the daemon uses are the same functions the arch re-exports (one reader, two importers)', async () => {
  const off = await import('../../src/off/proc.mjs')
  for (const n of ['readExe', 'readArgv', 'readEnviron', 'listPids', 'readStatus', 'readStartTime']) assert.equal(procinfo[n], off[n], n)
})
