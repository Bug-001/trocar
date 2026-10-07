// test/off/proc.test.mjs — src/off/proc.mjs (RFC 4.6 撤销顺序第 2 / 5 步, 1.6 R3): the process table `off` reads for itself. The old capture's
// daemon is stopped and the entries are undone by then, so "which agents are alive" comes from /proc (Linux) or `ps` (macOS) read here, with
// no daemon and no collector code. A table that cannot be read is an error, never an empty table: an empty one would say "nobody holds the
// bundle" and delete it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { listProcs, procIdentity, pidAlive, psIdentity, identityFor } from '../../src/off/proc.mjs'
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

// audit rule-b 2: `ps` prints lstart in the user's language. Under LC_ALL=zh_CN.UTF-8 or ja_JP.UTF-8 not one of 593 rows parsed, with no error: `off`, `status` and `uninstall`
// then reported no asight processes and no steer-era claude processes, which is "nobody is alive" said about a table that was never read (R11).
const PS_C = ['  501     1   501 Wed Oct  7 04:27:00 2026 /Applications/Claude.app/Contents/MacOS/claude --flag x', '  502   501   501 Wed Oct  7 05:00:00 2026 /usr/local/bin/codex app-server', ''].join('\n')
const PS_ZH = ['  501     1   501 三 10月  7 04:27:00 2026 /Applications/Claude.app/Contents/MacOS/claude --flag x', '  502   501   501 三 10月  7 05:00:00 2026 /usr/local/bin/codex app-server', ''].join('\n')
const PS_JA = PS_ZH.replace(/三 10月/g, '水 10月')

test('listProcs on macOS runs ps in the C locale: the runner is handed LC_ALL=C over whatever the user\'s own environment says, and a ps that honours the locale gives the table it would give in English', async () => {
  const seen = []
  const exec = (file, args, opts) => { seen.push(opts.env); return { status: 0, stdout: opts.env.LC_ALL === 'C' ? PS_C : PS_ZH, stderr: '' } } // a ps that localizes unless told not to
  for (const loc of ['zh_CN.UTF-8', 'ja_JP.UTF-8', 'C', undefined]) {
    const got = await listProcs({ uid: 501, platform: 'darwin', exec, env: { ...process.env, LC_ALL: loc, LANG: loc, LC_TIME: loc } })
    assert.deepEqual(got.map((f) => [f.pid, f.startedAt]), [[501, new Date(2026, 9, 7, 4, 27, 0).getTime()], [502, new Date(2026, 9, 7, 5, 0, 0).getTime()]], `LC_ALL=${loc}`)
  }
  assert.ok(seen.every((e) => e.LC_ALL === 'C'), 'every run was in the C locale')
})

test('listProcs on macOS: a ps whose lines cannot be read is an error that says so — never an empty table, which would read as "nobody is alive" — while a table with a few odd lines among readable ones is read as far as it goes', async () => {
  for (const out of [PS_ZH, PS_JA]) {
    await assert.rejects(listProcs({ uid: 501, platform: 'darwin', exec: () => ({ status: 0, stdout: out, stderr: '' }) }), /ps printed 2 line\(s\) and none could be read \(the first: .*10月.*\), so which agents are alive is not known/)
  }
  const mixed = await listProcs({ uid: 501, platform: 'darwin', exec: () => ({ status: 0, stdout: `${PS_C}  503     1   501 三 10月  7 06:00:00 2026 /x/odd\n`, stderr: '' }) })
  assert.deepEqual(mixed.map((f) => f.pid), [501, 502], 'the lines that parse are used')
  assert.deepEqual(await listProcs({ uid: 501, platform: 'darwin', exec: () => ({ status: 0, stdout: '\n', stderr: '' }) }), [], 'a ps that printed nothing at all is an empty table: there were no rows to misread')
  const other = await listProcs({ uid: 999, platform: 'darwin', exec: () => ({ status: 0, stdout: PS_C, stderr: '' }) })
  assert.deepEqual(other, [], 'rows that parse but belong to another user are a table with no row of this user\'s, not a failure')
})

test('psIdentity: the start time of a pid from `ps -o lstart= -p` in the C locale, blanks collapsed; null for a pid ps does not know; no boot id; identityFor picks /proc or ps by platform', () => {
  const calls = []
  const exec = (file, args, opts) => { calls.push([file, ...args, opts.env.LC_ALL]); return args.includes('4242') ? { status: 0, stdout: 'Wed Oct  7 04:27:00 2026\n', stderr: '' } : { status: 1, stdout: '', stderr: '' } }
  assert.deepEqual(psIdentity(4242, { exec }), { start_time: 'Wed Oct 7 04:27:00 2026', boot_id: null })
  assert.deepEqual(psIdentity(1, { exec }), { start_time: null, boot_id: null })
  assert.deepEqual(calls, [['ps', '-o', 'lstart=', '-p', '4242', 'C'], ['ps', '-o', 'lstart=', '-p', '1', 'C']])
  assert.deepEqual(identityFor({ platform: 'darwin', exec })(4242), { start_time: 'Wed Oct 7 04:27:00 2026', boot_id: null })
  const before = calls.length
  const p = fakeProc()
  try {
    p.add(7, { uid: 1000, exe: '/x', argv: ['x'], startTicks: 90 })
    assert.deepEqual(identityFor({ platform: 'linux', root: p.root })(7).start_time, '90', 'Linux: field 22 of /proc/<pid>/stat')
    assert.equal(calls.length, before, 'and no ps was run for it')
  } finally { p.done() }
  assert.throws(() => identityFor({ platform: 'darwin' })(4242), { code: 'ESANDBOX' }, 'a real ps under npm test is refused (0.1 §3)')
  takeRefusals()
})
