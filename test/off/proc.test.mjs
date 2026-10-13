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
import { darwinTools } from './fixtures/darwin-tools.mjs'

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
  await assert.rejects(listProcs({ uid: 1000, platform: 'win32' }), { code: 'ESANDBOX' }, 'win32 has a reader now (test/off/win32.test.mjs): without an injected runner the sandbox refuses the real powershell, exactly as macOS\'s `ps`')
  takeRefusals() // ours, acknowledged here: the ledger below must not see it
  await assert.rejects(listProcs({ uid: 1000, platform: 'freebsd' }), /freebsd/)
})

test('listProcs on macOS: `ps` for the table and the command line, then one `lsof` for every process\'s real executable; its environment is not readable there (envRead false)', async () => {
  const at = new Date(2026, 9, 7, 4, 27, 0)
  const helper = '/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper'
  const t = darwinTools([
    { pid: 501, at, exe: '/Applications/Claude.app/Contents/MacOS/claude', cmdline: '/Applications/Claude.app/Contents/MacOS/claude --flag x' },
    { pid: 777, uid: 0, at, exe: '/usr/sbin/mDNSResponder' },
    { pid: 502, ppid: 501, at, exe: '/Users/u/.local/share/codex/bin/codex', cmdline: 'codex app-server' }, // started through PATH: ps has the bare word
    { pid: 503, at, exe: helper, cmdline: `${helper} --type=utility zcode-cli` }, // a space in the path: ps's first word is cut there
  ])
  const got = await listProcs({ uid: 501, platform: 'darwin', exec: t.run })
  assert.deepEqual(t.calls.map((c) => c[0]), ['ps', 'lsof'], 'two questions for the whole table, whatever its size')
  assert.deepEqual(t.calls[1].slice(1), ['-a', '-u', '501', '-d', 'txt', '-Fpn'], 'lsof is asked about this user\'s processes only')
  assert.deepEqual(got.map((f) => [f.pid, f.ppid, f.uid]), [[501, 1, 501], [502, 501, 501], [503, 1, 501]])
  assert.deepEqual(got.map((f) => f.exe), ['/Applications/Claude.app/Contents/MacOS/claude', '/Users/u/.local/share/codex/bin/codex', helper], 'the executable is lsof\'s, not the word ps repeats')
  assert.deepEqual(got.map((f) => [f.argv[0], f.cmdline]), [['/Applications/Claude.app/Contents/MacOS/claude', '/Applications/Claude.app/Contents/MacOS/claude --flag x'], ['codex', 'codex app-server'], ['/Applications/ZCode.app/Contents/Frameworks/ZCode', `${helper} --type=utility zcode-cli`]])
  assert.equal(got[0].startedAt, at.getTime(), 'lstart is local time')
  assert.deepEqual([got[0].env(), got[0].envRead], [null, false], 'another process\'s environment is never readable on macOS: not a failed read')
  await assert.rejects(listProcs({ uid: 501, platform: 'darwin', exec: () => ({ status: 1, stdout: '', stderr: 'ps: nope' }) }), /ps.*nope/)
})

test('listProcs on macOS: an lsof that names no process while ps listed some, or that did not finish, is a table that cannot be read — never one whose executables are ps\'s words (a word no form path meets would read as "nobody holds it"); a table over 1 MiB is read whole', async () => {
  const t = darwinTools([{ pid: 501, at: new Date(), exe: '/x/codex' }], { lsof: false })
  await assert.rejects(listProcs({ uid: 501, platform: 'darwin', exec: t.run }), /lsof named no process \(exit 1\).*1 process\(es\).*not known/)
  const gone = darwinTools([{ pid: 501, at: new Date(), exe: '/x/codex' }, { pid: 502, at: new Date(), exe: '/x/zcode' }])
  const onlyFirst = (file, args) => (file === 'lsof' ? { status: 0, stdout: 'p501\nftxt\nn/x/real-codex\n', stderr: '' } : gone.run(file, args))
  assert.deepEqual((await listProcs({ uid: 501, platform: 'darwin', exec: onlyFirst })).map((f) => [f.pid, f.exe]), [[501, '/x/real-codex'], [502, '/x/zcode']], 'a process lsof does not name ended between the two questions: ps\'s word stays')
  // a working Mac's answer (~1.6 MB: every mapped library is a txt record) is read whole, so the newest process — the highest pid, lsof's last — has its
  // executable; an lsof cut short (more output than it may print, killed by its timeout) is not read in part: the table is not known
  const at = new Date(), many = Array.from({ length: 500 }, (_, i) => ({ pid: 1000 + i, at, exe: `/Applications/App${i}.app/Contents/MacOS/App${i}`, cmdline: `app${i}` }))
  const big = darwinTools([...many, { pid: 9999, at, exe: '/Users/u/.local/share/claude/versions/2.1.296', cmdline: 'claude' }], { libs: 40 })
  assert.equal((await listProcs({ uid: 501, platform: 'darwin', exec: big.run })).find((f) => f.pid === 9999).exe, '/Users/u/.local/share/claude/versions/2.1.296', 'the last process of a table over 1 MiB has its real executable')
  const cut = (file, args, opts) => (file === 'lsof' ? { ...big.run(file, args, { ...opts, maxBuffer: 1024 * 1024 }) } : big.run(file, args, opts)) // what an lsof that hit a 1 MiB cap answers
  await assert.rejects(listProcs({ uid: 501, platform: 'darwin', exec: cut }), /lsof did not finish \(spawnSync lsof ENOBUFS\).*not known/)
  const none = darwinTools([{ pid: 1, uid: 0, at: new Date(), exe: '/sbin/launchd' }])
  assert.deepEqual(await listProcs({ uid: 501, platform: 'darwin', exec: none.run }), [])
  assert.deepEqual(none.calls.map((c) => c[0]), ['ps'], 'a table with no process of this user asks lsof nothing (it would name none, which is not a failure)')
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
const LSOF_C = 'p501\nftxt\nn/Applications/Claude.app/Contents/MacOS/claude\np502\nftxt\nn/usr/local/bin/codex\n'
const tools = (psOut) => (file) => ({ status: 0, stdout: file === 'lsof' ? LSOF_C : psOut, stderr: '' }) // ps prints `psOut`, lsof names 501 and 502

test('listProcs on macOS runs ps in the C locale: the runner is handed LC_ALL=C over whatever the user\'s own environment says, and a ps that honours the locale gives the table it would give in English', async () => {
  const seen = []
  const exec = (file, args, opts) => { seen.push(opts.env); return tools(opts.env.LC_ALL === 'C' ? PS_C : PS_ZH)(file) } // a ps that localizes unless told not to
  for (const loc of ['zh_CN.UTF-8', 'ja_JP.UTF-8', 'C', undefined]) {
    const got = await listProcs({ uid: 501, platform: 'darwin', exec, env: { ...process.env, LC_ALL: loc, LANG: loc, LC_TIME: loc } })
    assert.deepEqual(got.map((f) => [f.pid, f.startedAt]), [[501, new Date(2026, 9, 7, 4, 27, 0).getTime()], [502, new Date(2026, 9, 7, 5, 0, 0).getTime()]], `LC_ALL=${loc}`)
  }
  assert.ok(seen.every((e) => e.LC_ALL === 'C'), 'every run was in the C locale')
})

test('listProcs on macOS: a ps whose lines cannot be read is an error that says so — never an empty table, which would read as "nobody is alive" — while a table with a few odd lines among readable ones is read as far as it goes', async () => {
  for (const out of [PS_ZH, PS_JA]) {
    await assert.rejects(listProcs({ uid: 501, platform: 'darwin', exec: tools(out) }), /ps printed 2 line\(s\) and none could be read \(the first: .*10月.*\), so which agents are alive is not known/)
  }
  const mixed = await listProcs({ uid: 501, platform: 'darwin', exec: tools(`${PS_C}  503     1   501 三 10月  7 06:00:00 2026 /x/odd\n`) })
  assert.deepEqual(mixed.map((f) => f.pid), [501, 502], 'the lines that parse are used')
  assert.deepEqual(await listProcs({ uid: 501, platform: 'darwin', exec: tools('\n') }), [], 'a ps that printed nothing at all is an empty table: there were no rows to misread')
  const other = await listProcs({ uid: 999, platform: 'darwin', exec: tools(PS_C) })
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
