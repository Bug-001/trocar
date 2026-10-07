// test/collector/arch/win32/redirector.test.mjs — the Windows Redirector (RFC 4.8 §1 contract, §5.2 lookupIngress, §5.4 trust; acceptance W16, W72 lookup half, W12 order of the entries).
// Nothing here runs Windows: the process snapshots come from a watcher whose helper is an object with a `call`, the socket table is a list of rows, the kernel is a recorder. The harness files' real Windows data is used for the
// forms (arch/ never imports harness/; a test may, to pin the rule to the real data), so a form whose path or command line is changed in the data changes what this file sees.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createWin32Redirector } from '../../../../src/collector/arch/win32/redirector.mjs'
import { createProcWatcher } from '../../../../src/collector/arch/win32/procinfo.mjs'
import { HELPER_PROTO } from '../../../../src/collector/arch/win32/helper.mjs'
import { groupsOf } from '../../../../src/collector/arch/win32/route-plan.mjs'
import claudeCode from '../../../../src/collector/harness/win32/claude-code.mjs'
import codex from '../../../../src/collector/harness/win32/codex.mjs'
import deepseekDsh from '../../../../src/collector/harness/win32/deepseek-dsh.mjs'

const GROUPS = groupsOf([{ name: 'claude-code', win32: claudeCode }, { name: 'codex', win32: codex }, { name: 'deepseek-dsh', win32: deepseekDsh }])
const HOME = String.raw`C:\Users\u`
const IMG = {
  ccCli: String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`,
  ccVscode: String.raw`C:\Users\u\.vscode\extensions\anthropic.claude-code-2.1.289-win32-x64\resources\native-binary\claude.exe`,
  ccElsewhere: String.raw`D:\tools\claude\claude.exe`,
  codexApp: String.raw`C:\Users\u\AppData\Local\OpenAI\Codex\bin\0123456789abcdef\codex.exe`,
  node: String.raw`C:\Program Files\nodejs\node.exe`,
  dshDesktop: String.raw`C:\Users\u\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe`,
  svchost: String.raw`C:\Windows\System32\svchost.exe`,
}
const DSH_CMD = String.raw`"C:\Program Files\nodejs\node.exe" C:\Users\u\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\bin\dsh.js`
const OTHER_NODE_CMD = String.raw`"C:\Program Files\nodejs\node.exe" C:\work\server.js`

/** What procinfo's `exec` carries (the fields the redirector reads, and the ones around them). */
const facts = (pid, exe, extra = {}) => ({ os: 'win32', pid, ppid: 1, name: exe.split('\\').pop(), exe, argv: [], cmdline: `"${exe}"`, env: null, cwd: null, startedAt: 1000 + pid, startTicks: String(1000 + pid), sessionId: 2, integrity: 'medium', tokenDenied: false, elevated: false, elevationInferred: false, cmdlineState: 'ok', source: 'exec', ...extra })

/** A stand-in for createProcWatcher(): the events the redirector subscribes to, and a scan the test sets. */
function watcher() {
  const w = Object.assign(new EventEmitter(), {
    live: [], stopped: false, started: false,
    scan() { return Promise.resolve(typeof w.live === 'function' ? w.live() : w.live) },
    start() { w.started = true; return Promise.resolve(true) },
    stop() { w.stopped = true },
    unreadable: () => [{ pid: 99, comm: 'x.exe', errno: null, argv: [] }],
  })
  return w
}
const made = (over = {}) => {
  const w = watcher()
  const r = createWin32Redirector({ procWatcher: w, groups: GROUPS, home: HOME, ...over })
  return { r, w }
}
const collect = (r, names) => { const got = []; for (const n of names) r.on(n, (x) => got.push([n, x])); return got }

// ---------- the process table (4.8 §1: scan() · exec / exit) ----------

test('the table takes in every process and says which form each is: forms by their own paths, a path nobody measured with the user\'s name masked, the rest as none', () => {
  const { r, w } = made()
  for (const f of [facts(10, IMG.ccCli), facts(11, IMG.ccVscode), facts(12, IMG.codexApp), facts(13, IMG.svchost), facts(14, IMG.ccElsewhere, { elevated: true })]) w.emit('exec', f)
  assert.deepEqual(r.pidsOf('claude-code.cli'), [10])
  assert.deepEqual(r.pidsOf('claude-code.vscode'), [11], 'two forms of one image, told apart by path')
  assert.deepEqual(r.pidsOf('codex.app'), [12])
  assert.deepEqual(r.procs(), [
    { pid: 10, match: { kind: 'form', id: 'claude-code.cli' }, elevated: false },
    { pid: 11, match: { kind: 'form', id: 'claude-code.vscode' }, elevated: false },
    { pid: 12, match: { kind: 'form', id: 'codex.app' }, elevated: false },
    { pid: 14, match: { kind: 'path-unknown', forms: ['claude-code.cli', 'claude-code.vscode', 'claude-code.desktop'], shape: String.raw`D:\tools\claude\claude.exe` }, elevated: true },
  ], 'what planRoutes takes as `procs`: forms and the images only an agent has; svchost is nobody\'s')
  w.emit('exec', facts(15, String.raw`C:\Users\u\AppData\Local\Programs\Claude\claude.exe`))
  assert.equal(r.procs().find((p) => p.pid === 15).match.shape, String.raw`C:\Users\<user>\AppData\Local\Programs\Claude\claude.exe`)
  const moved = made({ home: String.raw`D:\profiles\alice` }) // a redirected profile: only the home the daemon gave says where the user's name is
  moved.w.emit('exec', facts(16, String.raw`D:\profiles\alice\AppData\Local\Programs\Claude\claude.exe`))
  assert.equal(moved.r.procs()[0].match.shape, String.raw`D:\profiles\<user>\AppData\Local\Programs\Claude\claude.exe`, 'the home the daemon gave masks the profile name wherever the profile is')
})

test('a command line that arrives late: the process is pending (not a form, not "not an agent") until the watcher says it again, and then it is the form or nothing', () => {
  const { r, w } = made()
  w.emit('exec', facts(20, IMG.node, { cmdline: null, argv: [], cmdlineState: 'pending' }))
  w.emit('exec', facts(21, IMG.node, { cmdline: null, argv: [], cmdlineState: 'cim-backoff' }))
  assert.deepEqual(r.procs().map((p) => [p.pid, p.match.kind, p.match.forms]), [[20, 'pending', ['deepseek-dsh.cli']], [21, 'pending', ['deepseek-dsh.cli']]])
  assert.deepEqual(r.pidsOf('deepseek-dsh.cli'), [], 'a pending process is not yet any form\'s')
  const got = collect(r, ['facts-update'])
  w.emit('facts-update', facts(20, IMG.node, { cmdline: DSH_CMD, argv: [], cmdlineState: 'ok', source: 'update' }))
  w.emit('facts-update', facts(21, IMG.node, { cmdline: OTHER_NODE_CMD, cmdlineState: 'ok', source: 'update' }))
  assert.deepEqual(r.pidsOf('deepseek-dsh.cli'), [20])
  assert.deepEqual(r.procs().map((p) => p.pid), [20], 'a Node program that is not dsh is no one\'s, once its command line is known')
  assert.deepEqual(got.map(([n, x]) => [n, x.pid]), [['facts-update', 20], ['facts-update', 21]], 'the tracker is told as well: it judges by command line too')
})

test('exit takes a process out of the table with its verdict and says so; the last process of a form leaving is `form-exit` with the negative cache\'s key, not one before it', () => {
  const { r, w } = made()
  const got = collect(r, ['exit', 'form-exit'])
  w.emit('exec', facts(10, IMG.ccCli)); w.emit('exec', facts(11, IMG.ccCli, { startedAt: 5000 })); w.emit('exec', facts(12, IMG.ccVscode))
  r.watch(10, { decrypt: true, agent: 'claude-code' }); r.watch(11, { decrypt: false, agent: 'claude-code' })
  w.emit('exit', { pid: 10, startedAt: 1010 })
  assert.deepEqual(r.pidsOf('claude-code.cli'), [11])
  assert.equal(r.verdictOf(10), null, 'a verdict does not outlive its process: the pid will be somebody else\'s')
  assert.deepEqual(got.map(([n]) => n), ['exit'], 'a second process of the form is still there')
  w.emit('exit', { pid: 11, startedAt: 5000 })
  assert.deepEqual(got.map(([n, x]) => [n, x.pid ?? x.form]), [['exit', 10], ['exit', 11], ['form-exit', 'claude-code.cli']])
  assert.equal(got[2][1].neg_key, 'of.claude-code.cli', 'the key the engine\'s negative cache holds a form with no pid under (4.8 §5.5)')
  w.emit('exit', { pid: 99, startedAt: 1 })
  w.emit('exit', { pid: 12, startedAt: 1012 })
  assert.deepEqual(got.slice(3).map(([n, x]) => [n, x.pid ?? x.form]), [['exit', 99], ['exit', 12], ['form-exit', 'claude-code.vscode']], 'a pid the table never had is passed on and ends nothing')
})

test('the watcher\'s other events are passed on after the table has taken them in: facts-error as it is, poll-error as helper-error with the cause as its code', () => {
  const { r, w } = made()
  const seen = []
  r.on('exec', () => seen.push(r.pidsOf('claude-code.cli')))
  w.emit('exec', facts(10, IMG.ccCli))
  assert.deepEqual(seen, [[10]], 'a listener that asks the table about the process it is told of finds it')
  const got = collect(r, ['facts-error', 'helper-error'])
  w.emit('facts-error', { os: 'win32', pid: 7, comm: 'x.exe', code: null, argv: [], reason: 'its image path cannot be read' })
  w.emit('poll-error', { code: 'helper-error', cause: 'helper-timeout', reason: 'the ps verb timed out' })
  w.emit('poll-error', { code: 'helper-error', cause: null, reason: 'no list' })
  assert.deepEqual(got.map(([n]) => n), ['facts-error', 'helper-error', 'helper-error'])
  assert.deepEqual([got[1][1].code, got[1][1].reason, got[2][1].code], ['helper-timeout', 'the ps verb timed out', 'helper-error'])
})

test('scan() gives the live processes as facts and takes the table from them: what is no longer there goes, what the scan found is in, and a process that started while it ran stays', async () => {
  const { r, w } = made()
  w.emit('exec', facts(10, IMG.ccCli)); w.emit('exec', facts(11, IMG.ccCli, { startedAt: 5000 })); w.emit('exec', facts(12, IMG.ccVscode))
  const got = collect(r, ['form-exit'])
  w.live = () => { w.emit('exec', facts(13, IMG.codexApp)); return [facts(11, IMG.ccCli, { startedAt: 5000, source: 'scan' }), facts(14, IMG.ccVscode, { source: 'scan' })] }
  const live = await r.scan()
  assert.deepEqual(live.map((f) => f.pid), [11, 14])
  assert.deepEqual(r.pidsOf('claude-code.cli'), [11], '10 is gone, 11 is there')
  assert.deepEqual(r.pidsOf('claude-code.vscode'), [14], '12 is gone (its form has 14 now), 14 was found')
  assert.deepEqual(r.pidsOf('codex.app'), [13], 'a process that exec\'d while the scan was taken is not "gone": the scan\'s snapshot was older than it')
  assert.deepEqual(got, [], 'no form lost its last process')
  w.live = []
  await r.scan()
  assert.deepEqual(r.procs(), [], 'a scan that finds nobody empties the table of what was there before it')
  assert.deepEqual(got.map(([, x]) => x.form).sort(), ['claude-code.cli', 'claude-code.vscode', 'codex.app'])
  assert.deepEqual(r.unreadable().map((u) => u.pid), [99], 'the watcher\'s own list of images it could not read')
})

test('watch and unwatch are the tracker\'s verdict table (4.8 §5.4): decrypt only when the verdict says exactly true, nothing for a process it has not judged', () => {
  const { r } = made()
  assert.equal(r.verdictOf(10), null)
  r.watch(10, { decrypt: true, agent: 'claude-code' }); r.watch(11, { decrypt: false, agent: 'claude-code' }); r.watch(12, { decrypt: 'yes' }); r.watch(13, undefined)
  assert.deepEqual([10, 11, 12, 13].map((p) => r.verdictOf(p).decrypt), [true, false, false, false], 'a verdict that is not the boolean true is not trust')
  r.unwatch(10)
  assert.equal(r.verdictOf(10), null)
  assert.doesNotThrow(() => r.unwatch(404))
})

test('start() waits for the helper\'s ready line and takes the baseline; helperInfo() and expectedProto say what daemon.ensureReady compares; close() stops the watcher and closes the helper', async () => {
  let closed = 0
  const helper = { pid: 4242, ready: Promise.resolve({ ready: true, proto: HELPER_PROTO, pid: 4242, ps: '5.1.22631.4602', native: true }), close: async () => { closed++ } }
  const { r, w } = made({ helper })
  assert.deepEqual(r.helperInfo(), { pid: null, proto: null, build: null }, 'before start there is nothing to say')
  const i = await r.start()
  assert.deepEqual(i, { pid: 4242, proto: HELPER_PROTO, build: '5.1.22631.4602' })
  assert.deepEqual(r.helperInfo(), i)
  assert.equal(w.started, true)
  assert.equal(r.expectedProto, HELPER_PROTO)
  assert.equal(r.heartbeat(), undefined, 'a heartbeat gates nothing here')
  await r.close()
  assert.deepEqual([w.stopped, closed], [true, 1])
  const dead = made({ helper: { ready: Promise.reject(Object.assign(new Error('never ready'), { code: 'helper-start-failed' })), close: async () => {} } })
  await assert.rejects(dead.r.start(), /never ready/)
  assert.equal(dead.w.started, false, 'no baseline is taken from a helper that did not start')
})

test('with the real process watcher: a snapshot the helper answers reaches the table, and a late command line turns a pending node.exe into dsh', async () => {
  const rows = (cmd, state) => [{ pid: 30, ppid: 1, name: 'node.exe', exe: IMG.node, cmdline: cmd, cmdlineState: state, startedAt: 7000, sessionId: 2, integrity: 'medium', tokenDenied: false }]
  const snapshots = [[], rows(null, 'pending'), rows(DSH_CMD, 'ok')]
  let i = 0
  const helper = { async call() { return { sessionId: 2, procs: snapshots[Math.min(i++, snapshots.length - 1)] } } }
  const procWatcher = createProcWatcher({ helper, timers: { setInterval: () => 0, clearInterval() {} } })
  const r = createWin32Redirector({ procWatcher, groups: GROUPS, home: HOME })
  await procWatcher.poll() // the baseline: nothing running
  await procWatcher.poll()
  assert.deepEqual(r.procs().map((p) => [p.pid, p.match.kind]), [[30, 'pending']])
  await procWatcher.poll()
  assert.deepEqual(r.pidsOf('deepseek-dsh.cli'), [30])
})

test('the redirector asks for what it needs: the watcher and the groups', () => {
  assert.throws(() => createWin32Redirector({ groups: GROUPS }), /process watcher/)
  assert.throws(() => createWin32Redirector({ procWatcher: watcher() }), /groups/)
})
