// test/collector/arch/win32/redirector.test.mjs — the Windows Redirector (RFC 4.8 §1 contract, §5.2 lookupIngress, §5.4 trust; acceptance W16, W72 lookup half, W12 order of the entries).
// Nothing here runs Windows: the process snapshots come from a watcher whose helper is an object with a `call`, the socket table is a list of rows, the kernel is a recorder. The harness files' real Windows data is used for the
// forms (arch/ never imports harness/; a test may, to pin the rule to the real data), so a form whose path or command line is changed in the data changes what this file sees.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import tls from 'node:tls'
import { createWin32Redirector } from '../../../../src/collector/arch/win32/redirector.mjs'
import { createProcWatcher } from '../../../../src/collector/arch/win32/procinfo.mjs'
import { HELPER_PROTO } from '../../../../src/collector/arch/win32/helper.mjs'
import { groupsOf } from '../../../../src/collector/arch/win32/route-plan.mjs'
import { createEngine } from '../../../../src/collector/core/engine/engine.mjs'
import { createCa, loadCa } from '../../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../../src/collector/core/tls/leaf.mjs'
import { within, closeWithin } from '../../../helpers/bounded.mjs'
import claudeCode from '../../../../src/collector/harness/win32/claude-code.mjs'
import codex from '../../../../src/collector/harness/win32/codex.mjs'
import deepseekDsh from '../../../../src/collector/harness/win32/deepseek-dsh.mjs'
import zCode from '../../../../src/collector/harness/win32/z-code.mjs'

const GROUPS = groupsOf([{ name: 'claude-code', win32: claudeCode }, { name: 'codex', win32: codex }, { name: 'deepseek-dsh', win32: deepseekDsh }, { name: 'z-code', win32: zCode }])
const HOME = String.raw`C:\Users\u`
const IMG = {
  ccCli: String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`,
  ccVscode: String.raw`C:\Users\u\.vscode\extensions\anthropic.claude-code-2.1.289-win32-x64\resources\native-binary\claude.exe`,
  ccElsewhere: String.raw`D:\tools\claude\claude.exe`,
  codexApp: String.raw`C:\Users\u\AppData\Local\OpenAI\Codex\bin\0123456789abcdef\codex.exe`,
  node: String.raw`C:\Program Files\nodejs\node.exe`,
  dshDesktop: String.raw`C:\Users\u\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe`,
  zcode: String.raw`C:\Users\u\AppData\Local\Programs\ZCode\ZCode.exe`,
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

// ---------- lookupIngress (4.8 §5.2 · §5.4): who the connection is, whether it is decrypted, where it goes on ----------

const TOKEN = '0123456789abcdef0123456789abcdef'
const PORTS = { 'claude-code.settings': 18801, 'codex.env': 18802, 'deepseek-dsh.env': 18803, 'z-code.cli': 18804 }
const INGRESS = { enginePort: 18790, groupPorts: PORTS, ingressToken: TOKEN, listenerToken: 'fedcba9876543210fedcba9876543210' }
const route = (over = {}) => ({ entry: 'auto', on: true, reason: null, upstream: { kind: 'direct', source: 'direct' }, bypass: [], ...over })
const HTTP_PROXY = { kind: 'http', host: '127.0.0.1', port: 7897, credentialed: true, auth_ref: 'prior:codex.env', source: 'agent' }
const CRED = { username: 'u1', password: 'pw-SECRET' }
const BYPASS = [{ kind: 'local' }, { kind: 'domain-suffix', value: 'corp.example.com' }, { kind: 'ip-cidr', value: '10.0.0.0/8' }, { kind: 'domain', value: 'gateway.internal' }]
const target = (address, port = 443) => ({ address, port })

/** An ownerOf that answers what the test says (a list, one per call; then nobody) and remembers what it was asked. */
function owner(...answers) {
  const calls = []
  const fn = async (q) => { calls.push({ hop: q.hop, candidates: [...q.candidates], known: [...(q.known || [])] }); const a = answers.length ? answers.shift() : null; if (a instanceof Error) throw a; return a ?? { pid: null, source: null, ms: 3 } }
  fn.calls = calls
  return fn
}

/** The redirector with a populated process table: Claude Code cli 10 and 11, its VS Code form 12, codex.app 13, dsh 20 (node.exe with the dsh command line), a Node child 21, dsh's desktop 22, svchost 30. */
function bed(over = {}) {
  const ctx = made({ routes: () => ({ 'claude-code.settings': route(), 'codex.env': route(), 'deepseek-dsh.env': route() }), ingress: () => INGRESS, authOf: () => CRED, ...over })
  const { w } = ctx
  for (const f of [facts(10, IMG.ccCli), facts(11, IMG.ccCli, { startedAt: 5000 }), facts(12, IMG.ccVscode), facts(13, IMG.codexApp), facts(20, IMG.node, { cmdline: DSH_CMD }), facts(21, IMG.node, { cmdline: OTHER_NODE_CMD }), facts(22, IMG.dshDesktop), facts(30, IMG.svchost)]) w.emit('exec', f)
  return ctx
}
const trust = (r, ...pids) => { for (const p of pids) r.watch(p, { decrypt: true, agent: 'x' }) }
const distrust = (r, ...pids) => { for (const p of pids) r.watch(p, { decrypt: false, agent: 'x' }) }
const ask = (r, user, t = target('api.anthropic.com')) => r.lookupIngress({ peer: { address: '127.0.0.1', port: 50000 }, user, target: t })

test('an unknown route is null (the ingress answers it as an auth failure): not an `of.<form>` user, a form nobody lists, a re-entry user, a group the plan has no answer for', async () => {
  const { r } = bed({ routes: () => ({ 'claude-code.settings': route(), 'codex.env': route({ on: false, entry: null, reason: 'desired-off' }), 'z-code.cli': route() }) })
  for (const u of [undefined, null, '', 'of.', 'of.nobody', 'claude-code.cli', 're.claude-code.settings', 're.z-code.cli', 'asight', 'of.deepseek-dsh.cli', 'OF.claude-code.cli']) assert.equal(await ask(r, u), null, `${u}: the re-entry user of a group whose id is also a form's (re.z-code.cli) is not that form's`)
  assert.equal(await ask(r, 'of.hermes.desktop'), null, 'a form that is in no group')
  assert.notEqual(await ask(r, 'of.claude-code.cli'), null)
})

test('a probe is a CONNECT to the group\'s own re-entry point 127.0.0.1:<its port>: {health:true, group:<the form>} for each form of the group; the same address on another port, or another address on the port, is an agent\'s connection', async () => {
  const { r } = bed({ ownerOf: owner() })
  assert.deepEqual(await ask(r, 'of.claude-code.cli', target('127.0.0.1', 18801)), { health: true, group: 'claude-code.cli' })
  assert.deepEqual(await ask(r, 'of.claude-code.vscode', target('127.0.0.1', 18801)), { health: true, group: 'claude-code.vscode' }, 'the probe path is the form\'s: /asight-health/<f>')
  for (const t of [target('127.0.0.1', 18802), target('127.0.0.1', 443), target('localhost', 18801), target('::1', 18801), target('api.anthropic.com', 18801)]) assert.equal((await ask(r, 'of.claude-code.cli', t)).health, undefined, `${t.address}:${t.port}`)
})

test('a probe of a group that is not on is refused too: the kernel then keeps the re-entry, which is the way a connection still arriving goes upstream, and not the engine that has nothing to do with it', async () => {
  const { r } = bed({ routes: () => ({ 'claude-code.settings': route({ on: false, entry: null, reason: 'desired-off' }) }) })
  assert.equal(await ask(r, 'of.claude-code.cli', target('127.0.0.1', 18801)), null)
})

test('a connection of a group the plan has turned off before the kernel caught up is served, not refused: a spliced meta with the group\'s upstream and a code that says why, so the agent never sees an authentication failure; the probe is still refused', async () => {
  const o = owner()
  const off = (over = {}) => route({ on: false, entry: null, reason: 'desired-off', ...over })
  const { r } = bed({ routes: () => ({ 'claude-code.settings': off(), 'codex.env': off({ upstream: HTTP_PROXY, bypass: BYPASS }), 'deepseek-dsh.env': off({ upstream: null }) }), ownerOf: o })
  const m = await ask(r, 'of.claude-code.cli', target('api.anthropic.com'))
  assert.deepEqual(m, { pid: null, agent: 'claude-code', decrypt: false, capture: 'proxy', form: 'claude-code.cli', exe: null, upstream: { kind: 'direct' }, pid_source: null, pid_ms: null, negKey: 'of.claude-code.cli', skip: { not_captured: 'untracked', reason: 'group-off' } })
  assert.equal(o.calls.length, 0, 'a connection that is spliced anyway does not wait for the socket table')
  assert.deepEqual((await ask(r, 'of.codex.app', target('api.openai.com'))).upstream, { kind: 'http', host: '127.0.0.1', port: 7897, auth: CRED }, 'it goes where the agent\'s own proxy leads, with the login, as for any connection')
  assert.deepEqual((await ask(r, 'of.codex.app', target('gateway.internal'))).upstream, { kind: 'direct' }, 'and the bypass table applies')
  assert.equal(await ask(r, 'of.claude-code.cli', target('127.0.0.1', 18801)), null, 'the kernel\'s probe of a group that is off is refused: its fallback keeps the re-entry')
  assert.equal(await ask(r, 'of.deepseek-dsh.cli'), null, 'an off group with nothing to dial has nothing to serve either: refused as before')
})

test('W16 a pid known and judged trusted: decrypt, the form, the harness, the image, how the pid was found; the table was asked about the form\'s own processes and the group\'s port', async () => {
  const o = owner({ pid: 10, source: 'socket-table', ms: 7 })
  const { r } = bed({ ownerOf: o })
  trust(r, 10)
  assert.deepEqual(await ask(r, 'of.claude-code.cli'), { pid: 10, agent: 'claude-code', decrypt: true, capture: 'proxy', form: 'claude-code.cli', exe: IMG.ccCli, upstream: { kind: 'direct' }, pid_source: 'socket-table', pid_ms: 7, negKey: '10' })
  assert.deepEqual([o.calls[0].hop, o.calls[0].candidates], [{ port: 18801 }, [10, 11]], 'the cli\'s processes only, not the VS Code form\'s that shares the port, nor anyone\'s else')
  assert.deepEqual(o.calls[0].known.sort((a, b) => a - b), [10, 11, 12, 13, 20, 21, 22, 30], 'and the whole table is what the redirector can account for: a holder outside it is a process nobody has seen')
})

test('W16 a pid known and judged untrusted (or not judged at all): not decrypted, with no code of ours — the tracker answers for a pid, with the resolver\'s own reason', async () => {
  const { r } = bed({ ownerOf: owner({ pid: 10, source: 'socket-table', ms: 2 }, { pid: 11, source: 'socket-table', ms: 2 }) })
  distrust(r, 10)
  const a = await ask(r, 'of.claude-code.cli'), b = await ask(r, 'of.claude-code.cli')
  assert.deepEqual([a.pid, a.decrypt, a.skip, b.pid, b.decrypt, b.skip], [10, false, undefined, 11, false, undefined])
})

test('W16 with no pid, the form is judged as a whole: all of its processes trusted → decrypt; one untrusted, or one nobody judged, or one still pending → splice with `pid-unresolved-mixed`; none known → splice, untracked', async () => {
  const { r, w } = bed({ ownerOf: owner() })
  trust(r, 10, 11)
  const all = await ask(r, 'of.claude-code.cli')
  assert.deepEqual([all.pid, all.decrypt, all.skip, all.negKey, all.pid_source, all.exe], [null, true, undefined, 'of.claude-code.cli', null, null])
  distrust(r, 11)
  const mixed = await ask(r, 'of.claude-code.cli')
  assert.deepEqual([mixed.decrypt, mixed.skip], [false, { not_captured: 'untrusted', reason: 'pid-unresolved-mixed' }])
  r.unwatch(11)
  assert.deepEqual((await ask(r, 'of.claude-code.cli')).skip, { not_captured: 'untrusted', reason: 'pid-unresolved-mixed' }, 'a process the tracker has not judged is not trusted')
  r.watch(11, { decrypt: true }); w.emit('exec', facts(14, IMG.node, { cmdline: null, cmdlineState: 'pending' }))
  assert.equal((await ask(r, 'of.claude-code.cli')).decrypt, true, 'a pending node.exe could be dsh, not a form of this group')
  w.emit('exec', facts(15, String.raw`C:\Users\u\.local\bin\claude.exe`, { cmdlineState: 'pending', cmdline: null }))
  assert.equal((await ask(r, 'of.claude-code.cli')).skip.reason, 'pid-unresolved-mixed', 'claude.exe needs no command line: it is a form at once, and until the tracker has judged it the form is not all trusted')
  trust(r, 15)
  assert.equal((await ask(r, 'of.claude-code.cli')).decrypt, true)
  w.emit('exit', { pid: 13, startedAt: 1013 }) // codex.app's only process is gone
  const none = await ask(r, 'of.codex.app')
  assert.deepEqual([none.decrypt, none.skip], [false, { not_captured: 'untracked', reason: 'no-process-of-form' }], 'a connection from a process the table has not seen (it started less than a poll ago): spliced and recorded, not guessed at')
})

test('W16 two forms of one group (`of.claude-code.cli`, `of.claude-code.vscode`) resolve to their own forms with no pid: each its own processes, its own negative-cache key, its own verdict', async () => {
  const o = owner()
  const { r } = bed({ ownerOf: o })
  trust(r, 10, 11); distrust(r, 12)
  const cli = await ask(r, 'of.claude-code.cli'), vs = await ask(r, 'of.claude-code.vscode')
  assert.deepEqual([cli.form, cli.negKey, cli.decrypt, cli.agent], ['claude-code.cli', 'of.claude-code.cli', true, 'claude-code'])
  assert.deepEqual([vs.form, vs.negKey, vs.decrypt, vs.skip.reason], ['claude-code.vscode', 'of.claude-code.vscode', false, 'pid-unresolved-mixed'])
  assert.deepEqual(o.calls.map((c) => c.candidates), [[10, 11], [12]], 'no process of one form is a candidate of the other, though they share a port')
})

test('W16 a process whose command line is not known yet may be the form\'s: it is a candidate for the pid and, until the tracker has judged it, keeps the form from being all trusted', async () => {
  const o = owner()
  const { r, w } = bed({ ownerOf: o, routes: () => ({ 'z-code.cli': route() }) })
  w.emit('exec', facts(40, IMG.zcode, { cmdline: null, cmdlineState: 'pending' }))
  assert.deepEqual(r.pidsOf('z-code.cli'), [], 'not yet a process of the form')
  const m = await ask(r, 'of.z-code.cli')
  assert.deepEqual([o.calls[0].candidates, m.decrypt, m.skip], [[40], false, { not_captured: 'untrusted', reason: 'pid-unresolved-mixed' }], 'one candidate and it is not judged: not decrypted, not "no process"')
  w.emit('facts-update', facts(40, IMG.zcode, { cmdline: String.raw`"C:\Users\u\AppData\Local\Programs\ZCode\ZCode.exe" resources\glm\zcode.cjs app-server --stdio`, source: 'update' }))
  trust(r, 40)
  assert.deepEqual([r.pidsOf('z-code.cli'), (await ask(r, 'of.z-code.cli')).decrypt], [[40], true])
})

test('W16 the real socket-table answer through the redirector: one candidate is that process when it holds the connection (the table is read for it too); two with one holding it is that one; two holding it is nobody, and the form is judged', async () => {
  const { ownerOf } = await import('../../../../src/collector/arch/win32/socktable.mjs')
  const row = (pid, remotePort, extra = {}) => ({ pid, state: 'established', family: 4, localAddr: '127.0.0.1', localPort: 50000 + pid, remoteAddr: '127.0.0.1', remotePort, ...extra })
  let rows = [], reads = 0
  const asked = []
  const helper = { call: async (verb, args) => { reads++; asked.push(args); return { rows } } }
  const { r } = bed({ ownerOf: (q) => ownerOf({ helper, ...q }) })
  trust(r, 10, 11)
  rows = [row(13, 18802)]
  const only = await ask(r, 'of.codex.app') // codex.app has a single process: 13
  assert.deepEqual([only.pid, only.pid_source, reads], [13, 'single-process', 1])
  rows = [row(10, 18801), row(11, 443)]
  assert.deepEqual([(await ask(r, 'of.claude-code.cli')).pid, reads], [10, 2])
  assert.deepEqual(asked[1], { remotePort: 18801 }, 'every holder of the group\'s port is asked for: the candidates\' rows alone could not show a process nobody has seen')
  rows = [row(10, 18801), row(11, 18801)]
  const two = await ask(r, 'of.claude-code.cli')
  assert.deepEqual([two.pid, two.pid_source, two.decrypt], [null, null, true], 'two hold it: not guessed; both trusted, so the form is')
  distrust(r, 11)
  assert.equal((await ask(r, 'of.claude-code.cli')).skip.reason, 'pid-unresolved-mixed')
})

test('W16 / W43 a connection from a process the table has not seen yet is nobody\'s, whoever else of the form holds a tunnel: not attributed to a known process, and the form is judged (the process table lags a poll)', async () => {
  const { ownerOf } = await import('../../../../src/collector/arch/win32/socktable.mjs')
  const row = (pid, remotePort, extra = {}) => ({ pid, state: 'established', family: 4, localAddr: '127.0.0.1', localPort: 50000 + pid, remoteAddr: '127.0.0.1', remotePort, ...extra })
  let rows = []
  const { r } = bed({ ownerOf: (q) => ownerOf({ helper: { call: async () => ({ rows }) }, ...q }) })
  trust(r, 10) // pid 11 of the cli form is the second terminal; pid 99 is a third, started a second ago, in nobody's table
  rows = [row(10, 18801), row(99, 18801)]
  const m = await ask(r, 'of.claude-code.cli')
  assert.deepEqual([m.pid, m.pid_source, m.exe, m.negKey, m.decrypt, m.skip], [null, null, null, 'of.claude-code.cli', false, { not_captured: 'untrusted', reason: 'pid-unresolved-mixed' }], 'not 10 (which trusts asight\'s CA and would have been "the one holder"): the form has a process that is not trusted, so this connection is not decrypted')
  trust(r, 11)
  const judged = await ask(r, 'of.claude-code.cli')
  assert.deepEqual([judged.pid, judged.decrypt], [null, true], 'every process the table knows is trusted: judged by form, with no pid')
  // the form's only known process, an unseen one connecting: not "the single process"
  rows = [row(77, 18802)]
  const single = await ask(r, 'of.codex.app') // codex.app has the one process 13
  assert.deepEqual([single.pid, single.pid_source, single.exe, single.negKey], [null, null, null, 'of.codex.app'])
  rows = [row(13, 18802), row(77, 18802)]
  assert.equal((await ask(r, 'of.codex.app')).pid, null, 'holding a connection of its own does not make the known one the owner')
  // a known process of another form of the group is not an unseen one: the VS Code form's claude.exe (12) holds a tunnel on the shared port, the cli's 11 connects
  rows = [row(12, 18801), row(11, 18801)]
  const shared = await ask(r, 'of.claude-code.cli')
  assert.deepEqual([shared.pid, shared.pid_source], [11, 'socket-table'])
  rows = [row(11, 18801), row(0, 18801, { state: 'time-wait' }), row(30, 443)]
  assert.equal((await ask(r, 'of.claude-code.cli')).pid, 11, 'the end of an earlier connection has no owner and is no process connecting now')
})

test('W16 a form with no process rule takes every connection of its port, so the owner is looked for among ALL processes: its own trusted process decrypts, any other process (a child) is spliced and named, nobody found is spliced', async () => {
  const o = owner({ pid: 20, source: 'socket-table', ms: 4 }, { pid: 21, source: 'socket-table', ms: 4 }, { pid: 30, source: 'socket-table', ms: 4 }, null, { pid: 20, source: 'socket-table', ms: 4 })
  const { r } = bed({ ownerOf: o })
  trust(r, 20, 22)
  const own = await ask(r, 'of.deepseek-dsh.cli')
  assert.deepEqual([own.pid, own.decrypt, own.skip, own.exe], [20, true, undefined, IMG.node])
  assert.deepEqual(o.calls[0].candidates.sort((a, b) => a - b), [10, 11, 12, 13, 20, 21, 30], 'every process the table has but the group\'s other forms\': a child of dsh is not a dsh process, and only the whole table can say whose connection this is')
  assert.deepEqual(o.calls[0].known.sort((a, b) => a - b), [10, 11, 12, 13, 20, 21, 22, 30], 'the whole table is what the redirector can account for')
  assert.equal(o.calls[0].hop.port, 18803)
  const child = await ask(r, 'of.deepseek-dsh.cli')
  assert.deepEqual([child.pid, child.decrypt, child.skip, child.negKey], [21, false, { not_captured: 'untracked', reason: 'not-a-process-of-form' }, '21'], 'a Node child of dsh: spliced, and the row says whose it was')
  const other = await ask(r, 'of.deepseek-dsh.cli')
  assert.deepEqual([other.pid, other.decrypt, other.exe], [30, false, IMG.svchost])
  const nobody = await ask(r, 'of.deepseek-dsh.cli')
  assert.deepEqual([nobody.pid, nobody.decrypt, nobody.skip], [null, false, { not_captured: 'untracked', reason: 'pid-unresolved' }], 'no pid on a dedicated port: nothing says it is dsh\'s, so it is not decrypted')
  distrust(r, 20)
  const untrusted = await ask(r, 'of.deepseek-dsh.cli')
  assert.deepEqual([untrusted.pid, untrusted.decrypt, untrusted.skip], [20, false, undefined], 'dsh\'s own process the tracker judged untrusted: the tracker gives the reason')
  const o2 = owner(); const desk = bed({ ownerOf: o2 }).r
  await ask(desk, 'of.deepseek-dsh.desktop')
  assert.deepEqual(o2.calls[0].candidates, [22], 'the desktop app has a process rule: only its own processes are candidates, as for any other form')
})
test('W16 on the dedicated port the group\'s other forms are not candidates: dsh\'s Desktop shares the group\'s port, is handed to its own form by its process rule, and holding a connection of its own does not make dsh CLI\'s process unfindable', async () => {
  const { ownerOf } = await import('../../../../src/collector/arch/win32/socktable.mjs')
  const row = (pid, remotePort) => ({ pid, state: 'established', family: 4, localAddr: '127.0.0.1', localPort: 50000 + pid, remoteAddr: '127.0.0.1', remotePort })
  let rows = [row(20, 18803), row(22, 18803)] // the CLI's own connection and the Desktop's, one port
  const { r } = bed({ ownerOf: (q) => ownerOf({ helper: { call: async () => ({ rows }) }, ...q }) })
  trust(r, 20, 22)
  const m = await ask(r, 'of.deepseek-dsh.cli')
  assert.deepEqual([m.pid, m.decrypt, m.skip], [20, true, undefined], 'dsh CLI is decrypted while the Desktop app has a connection open')
  rows = [row(20, 18803), row(21, 18803)] // dsh and one of its Node children: two candidates hold the port
  assert.equal((await ask(r, 'of.deepseek-dsh.cli')).pid, null)
  rows = [row(21, 18803), row(22, 18803)]
  const child = await ask(r, 'of.deepseek-dsh.cli') // the child connects while the Desktop holds one
  assert.deepEqual([child.pid, child.skip], [21, { not_captured: 'untracked', reason: 'not-a-process-of-form' }], 'and its connection is still known for what it is')
})

test('W72 (lookup half) a CONNECT target that hits the group\'s bypass table is {kind:"direct"}, any other the group\'s upstream; each kind of row, and the user\'s login stays out of a direct connection', async () => {
  const refs = []
  const { r } = bed({ routes: () => ({ 'claude-code.settings': route(), 'codex.env': route({ upstream: HTTP_PROXY, bypass: BYPASS }), 'deepseek-dsh.env': route() }), authOf: (ref) => { refs.push(ref); return CRED }, ownerOf: owner() })
  for (const host of ['intranet', 'a.corp.example.com', 'corp.example.com', '10.1.2.3', 'gateway.internal', 'GATEWAY.internal']) assert.deepEqual((await ask(r, 'of.codex.app', target(host))).upstream, { kind: 'direct' }, host)
  assert.deepEqual(refs, [], 'a direct connection never asks for the proxy\'s login')
  for (const host of ['api.openai.com', 'x.gateway.internal', '11.0.0.1', 'evilcorp.example.com', '2001:db8::1']) assert.deepEqual((await ask(r, 'of.codex.app', target(host))).upstream, { kind: 'http', host: '127.0.0.1', port: 7897, auth: CRED }, host)
  assert.deepEqual(refs.slice(0, 1), ['prior:codex.env'])
})

test('W72 a form of another group never borrows this group\'s table: the same targets through `of.claude-code.cli` (no table, an upstream of its own) all go to its upstream', async () => {
  const socks = { kind: 'socks5', host: '127.0.0.1', port: 1080, source: 'system-proxy' }
  const { r } = bed({ routes: () => ({ 'claude-code.settings': route({ upstream: socks }), 'codex.env': route({ upstream: HTTP_PROXY, bypass: BYPASS }), 'deepseek-dsh.env': route() }), ownerOf: owner() })
  for (const host of ['intranet', 'a.corp.example.com', '10.1.2.3', 'gateway.internal']) {
    assert.deepEqual((await ask(r, 'of.claude-code.cli', target(host))).upstream, { kind: 'socks5', host: '127.0.0.1', port: 1080 }, `${host} is codex's bypass, not claude code's`)
    assert.deepEqual((await ask(r, 'of.codex.app', target(host))).upstream, { kind: 'direct' }, host)
  }
})

test('the upstream\'s login is resolved from its reference for this one connection and is not in anything else the lookup says; one that cannot be read, or a group that is on with nothing to dial, fails the lookup with a reason that has no login in it', async () => {
  const o = owner()
  const { r } = bed({ routes: () => ({ 'codex.env': route({ upstream: HTTP_PROXY }) }), ownerOf: o })
  const meta = await ask(r, 'of.codex.app')
  assert.deepEqual(meta.upstream.auth, CRED)
  assert.equal(JSON.stringify({ ...meta, upstream: { ...meta.upstream, auth: undefined } }).includes('pw-SECRET'), false)
  const noLogin = bed({ routes: () => ({ 'codex.env': route({ upstream: HTTP_PROXY, bypass: BYPASS }) }), authOf: () => null, ownerOf: o }).r
  await assert.rejects(ask(noLogin, 'of.codex.app'), (e) => { assert.deepEqual([e.why, e.code], ['upstream-credentials-unavailable', 'upstream-unavailable']); assert.match(e.message, /prior:codex\.env/); assert.equal(e.message.includes('pw-'), false); return true })
  assert.deepEqual((await ask(noLogin, 'of.codex.app', target('gateway.internal'))).upstream, { kind: 'direct' }, 'a bypassed target needs no login')
  assert.equal(o.calls.length, 2, 'the connection that was dialled and the bypassed one asked the table; the one that could not be dialled did not wait for it')
  const nothing = bed({ routes: () => ({ 'codex.env': route({ upstream: null }) }) }).r
  await assert.rejects(ask(nothing, 'of.codex.app'), (e) => e.why === 'no-upstream' && e.code === 'upstream-unavailable')
})

test('a socket table that throws never costs the agent its connection: no pid, the form judged, and one `socktable-unavailable` failure that passes checkRecord', async () => {
  const { checkRecord } = await import('../../../../src/health/codes.mjs')
  const failures = []
  const { r } = bed({ ownerOf: owner(new Error('the helper died')), onFailure: (f) => failures.push(f) })
  trust(r, 10, 11)
  const m = await ask(r, 'of.claude-code.cli')
  assert.deepEqual([m.pid, m.decrypt, m.pid_source], [null, true, null])
  assert.equal(failures.length, 1)
  assert.deepEqual([failures[0].where, failures[0].code, checkRecord(failures[0])], ['helper', 'socktable-unavailable', []])
  assert.match(failures[0].reason, /the helper died/)
  const without = bed({}).r // no socket table wired at all: pid completion is off, the form is judged
  trust(without, 10, 11)
  assert.deepEqual([(await ask(without, 'of.claude-code.cli')).pid_ms, (await ask(without, 'of.claude-code.cli')).decrypt], [null, true])
})

// ---------- W16 end to end: the real engine and ingress, this redirector's lookup, a TLS origin, an agent that does not trust asight's CA ----------

const asightCa = createCa()
const privCa = createCa({ commonName: 'private origin CA' })
const REQ = 'GET /v1/models HTTP/1.1\r\nhost: upstream.test\r\n\r\n'
const RESP = 'HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\nok'

async function wired(t, { ownerOf, ...over } = {}) {
  const issuer = createLeafIssuer(loadCa(privCa))
  const origin = tls.createServer({ SNICallback: (n, cb) => cb(null, issuer.secureContextFor(n)), ALPNProtocols: ['http/1.1'] }, (s) => { s.on('data', () => s.write(RESP)); s.on('error', () => {}) })
  await new Promise((r) => origin.listen(0, '127.0.0.1', r))
  const { r, w } = bed({ ownerOf, ...over })
  const flows = [], envelopes = [], failures = []
  const engine = createEngine({
    redirector: r, issuer: createLeafIssuer(loadCa(asightCa)), upstreamCa: privCa.certPem, ingressToken: TOKEN,
    policy: (meta) => (meta.decrypt ? true : meta.skip), // what the daemon's policy does with a meta that has no pid: the code lookupIngress gave it
    store: { envelope: (e) => { envelopes.push(e); return true }, flow: (f) => { flows.push(structuredClone(f)); return true } }, onFailure: (f) => failures.push(f),
  })
  const { ingressPort } = await engine.listen({ ingress: { port: 0 } })
  t.after(async () => { origin.close(); await closeWithin(engine) })
  const settled = async ({ envelope = false } = {}) => { for (let i = 0; i < 400 && (flows.length < 1 || (envelope && envelopes.length < 1)); i++) await new Promise((x) => setTimeout(x, 10)) }
  /** An agent's connection as the kernel hands it over (CONNECT as `of.<form>`), then TLS to the origin trusting `ca`: → { issuer, got } or 'closed' */
  async function agent(user, ca) {
    const sock = net.connect(ingressPort, '127.0.0.1'); sock.on('error', () => {})
    const head = `CONNECT 127.0.0.1:${origin.address().port} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Basic ${Buffer.from(`${user}:${TOKEN}`).toString('base64')}\r\n\r\n`
    sock.write(head)
    await within(new Promise((res) => { let b = ''; const on = (d) => { b += d.toString('latin1'); if (b.includes('\r\n\r\n')) { sock.removeListener('data', on); res() } }; sock.on('data', on) }), 4000, 'the 200', () => sock.destroy())
    return within(new Promise((resolve) => {
      let issuerOf = null, got = ''
      const c = tls.connect({ socket: sock, servername: 'upstream.test', ca, ALPNProtocols: ['http/1.1'] }, () => { issuerOf = c.getPeerX509Certificate().issuer; c.write(REQ) })
      c.on('data', (d) => { got += d.toString('latin1'); if (got.length >= RESP.length) c.end() })
      c.on('error', () => {}); c.on('close', () => resolve(issuerOf ? { issuer: issuerOf, got } : 'closed'))
    }), 6000, 'the TLS exchange', () => sock.destroy())
  }
  return { r, w, flows, envelopes, failures, settled, agent }
}

test('W16 end to end, no pid, one process of the form untrusted: the connection is spliced, the agent meets the origin\'s own certificate and its answer with zero errors, and the row says why', async (t) => {
  const E = await wired(t, { ownerOf: owner() })
  trust(E.r, 10) // pid 11 of the same form has no verdict
  const got = await E.agent('of.claude-code.cli', privCa.certPem)
  assert.equal(got.got, RESP, 'the agent got its answer')
  assert.match(got.issuer, /private origin CA/, 'from the origin: asight\'s CA never signed anything the agent saw')
  await E.settled()
  const [row] = E.flows
  assert.deepEqual([row.decision, row.not_captured, row.reason, row.pid, row.agent], ['splice', 'untrusted', 'pid-unresolved-mixed', null, 'claude-code'])
  assert.deepEqual([row.ingress, row.upstream], [{ route: 'of', group: 'claude-code.cli' }, { kind: 'direct' }])
  assert.equal(E.envelopes.length, 0)
  assert.deepEqual(E.failures, [], 'the agent saw no error and nothing was recorded as a failure')
})

test('W16 end to end, no pid, every process of the form trusted: the same connection is decrypted, the agent sees asight\'s leaf, the envelope names the form\'s agent and has no pid', async (t) => {
  const E = await wired(t, { ownerOf: owner() })
  trust(E.r, 10, 11)
  const got = await E.agent('of.claude-code.cli', asightCa.certPem)
  assert.equal(got.got, RESP)
  assert.match(got.issuer, /asight/i, 'decrypted: the leaf is asight\'s')
  await E.settled({ envelope: true })
  assert.deepEqual([E.flows[0].decision, E.flows[0].not_captured ?? null], ['decrypt', null])
  assert.deepEqual([E.envelopes[0].proc.agent, E.envelopes[0].proc.pid, E.envelopes[0].proc.exe], ['claude-code', null, null], 'no pid was found: the envelope says so rather than guessing')
  assert.deepEqual(E.failures, [])
})

test('end to end, a group the plan has just turned off: the agent\'s connection is spliced to the origin and answered with zero errors, the row says `untracked` · `group-off` (not an authentication failure at the kernel\'s outbound)', async (t) => {
  const E = await wired(t, { routes: () => ({ 'claude-code.settings': route({ on: false, entry: null, reason: 'desired-off' }) }) })
  trust(E.r, 10, 11) // even trusted: the plan says this group is off
  const got = await E.agent('of.claude-code.cli', privCa.certPem)
  assert.equal(got.got, RESP, 'the agent got its answer')
  assert.match(got.issuer, /private origin CA/)
  await E.settled()
  assert.deepEqual([E.flows[0].decision, E.flows[0].not_captured, E.flows[0].reason, E.flows[0].pid, E.flows[0].agent], ['splice', 'untracked', 'group-off', null, 'claude-code'])
  assert.deepEqual([E.envelopes.length, E.failures], [0, []])
})

test('end to end, an upstream that cannot be dialled (its login cannot be read): the agent gets a 502, and the failure is `upstream-unavailable` at the ingress with the reason, not `loader-down` (which sends a reader to restart the helper); it passes the closed set', async (t) => {
  const { checkRecord } = await import('../../../../src/health/codes.mjs')
  const E = await wired(t, { routes: () => ({ 'codex.env': route({ upstream: HTTP_PROXY }) }), authOf: () => null })
  assert.equal(await E.agent('of.codex.app', privCa.certPem), 'closed', 'a 502, then nothing')
  for (let i = 0; i < 100 && E.failures.length < 1; i++) await new Promise((x) => setTimeout(x, 10))
  assert.equal(E.failures.length, 1)
  const [f] = E.failures
  assert.deepEqual([f.event, f.where, f.code, f.why], ['failure', 'ingress', 'upstream-unavailable', 'upstream-credentials-unavailable'])
  assert.match(f.reason, /prior:codex\.env/)
  assert.equal(JSON.stringify(f).includes('pw-'), false, 'no login in the record')
  assert.deepEqual(checkRecord(f), [])
  assert.equal(E.flows.length, 0, 'no flow: the connection never got an upstream')
})

// ---------- attach · detach · status (4.8 §2.1, §4.1, §4.2: the kernel first, the proxy entries only after it reads back; W12 order) ----------

const SECRET = 'abcdef0123456789abcdef0123456789'
const OWN_IMAGES = [IMG.node, String.raw`C:\Users\u\.asight\collector\kernel\asight-forwarder.exe`]
const readBack = (forms) => ({ ok: forms.every((f) => (f.on ? 'on' : 'off') === (f.state ?? (f.on ? 'on' : 'off'))), forms: Object.fromEntries(forms.map((f) => [f.f, { state: f.state ?? (f.on ? 'on' : 'off') }])) })

/** The kernel as the redirector sees it: reload({build, forms}) builds the config text for a controller and answers what the test says (a list, one per call; then "read back as asked"). `log` is shared with the entries. */
function kernel(log, { phase = 'running', results = [] } = {}) {
  const k = {
    phase, calls: [], checked: null,
    state: () => ({ phase: k.phase }),
    async reload({ build, forms }) {
      const text = build({ port: 18899, secret: SECRET })
      k.calls.push({ forms, text })
      log.push('kernel')
      const r = results.length ? results.shift() : { ok: true, readBack: readBack(forms) }
      if (r instanceof Error) throw r
      return r
    },
    async check() { return k.checked ?? { ok: true, forms: {} } },
  }
  return k
}
/** The proxy-entry writer: what it was asked for, in order with the kernel's calls; `fail` makes the n-th write throw (a crash between the read-back and the entries). */
function entriesLog(log, { writeResult = null, throwOnWrite = 0 } = {}) {
  let writes = 0
  const e = {
    written: [], undone: [], checked: [],
    async write(list) { log.push('write'); writes++; e.written.push(list); if (writes === throwOnWrite) throw new Error('crashed'); return writeResult ? writeResult(list) : list.map((x) => ({ g: x.g, ok: true })) },
    async undo(list) { log.push('undo'); e.undone.push(list); return list.map((x) => ({ g: x.g, ok: true })) },
    async check(list) { e.checked.push(list); return list.map((x) => ({ g: x.g, ok: true })) },
  }
  return e
}
const ROUTES = () => ({ 'claude-code.settings': route(), 'codex.env': route({ upstream: HTTP_PROXY, bypass: BYPASS }), 'deepseek-dsh.env': route({ on: false, entry: null, reason: 'desired-off' }) })
function wiredKernel(over = {}) {
  const log = []
  const k = kernel(log, over.kernel)
  const e = entriesLog(log, over.entries)
  const ctx = bed({ forwarder: k, entries: e, routes: ROUTES, ownImages: OWN_IMAGES, gate: () => ({ ok: true }), ...over.redirector })
  return { ...ctx, k, e, log }
}
const parse = (text) => JSON.parse(text)
const listenersOf = (text) => parse(text).listeners.map((l) => l.name)

test('attach(): the kernel gets one config for every planned group (on groups with the engine outbound and a fallback group per form, the off group forward only) and the forms to read back; the login comes from its reference', async () => {
  const { r, k } = wiredKernel()
  const out = await r.attach()
  assert.equal(out.ok, true)
  assert.deepEqual(k.calls[0].forms, [
    { f: 'claude-code.cli', on: true }, { f: 'claude-code.vscode', on: true },
    { f: 'codex.cli', on: true }, { f: 'codex.vscode', on: true }, { f: 'codex.app', on: true },
    { f: 'deepseek-dsh.cli', on: false }, { f: 'deepseek-dsh.desktop', on: false },
  ], 'the groups the plan has an answer for: claude-code.desktop and z-code have none, so they are not in the kernel')
  const cfg = parse(k.calls[0].text)
  assert.deepEqual(cfg.listeners.map((l) => [l.name, l.port]), [['asight-l-claude-code.settings', 18801], ['asight-l-codex.env', 18802], ['asight-l-deepseek-dsh.env', 18803]])
  const names = cfg.proxies.map((p) => p.name)
  assert.ok(names.includes('asight-in-claude-code.cli') && names.includes('asight-in-codex.app'), 'the engine outbound of a form that is on')
  assert.ok(!names.includes('asight-in-deepseek-dsh.cli'), 'a group that is off has none: the engine is not on its path')
  const up = cfg.proxies.find((p) => p.name === 'asight-up-codex.env')
  assert.deepEqual([up.type, up.server, up.port, up.username, up.password], ['http', '127.0.0.1', 7897, 'u1', 'pw-SECRET'], 'the login is written where the kernel needs it, and nowhere else')
  assert.deepEqual([cfg.proxies.find((p) => p.name === 'asight-in-codex.app').port, cfg.proxies.find((p) => p.name === 'asight-in-codex.app').password], [18790, TOKEN])
  assert.deepEqual(cfg['external-controller'], '127.0.0.1:18899')
  const rules = cfg['sub-rules']
  assert.ok(rules['in-codex.env'].includes('DOMAIN-SUFFIX,corp.example.com,DIRECT') && rules['in-codex.env'].includes('IP-CIDR,10.0.0.0/8,DIRECT,no-resolve'), 'the group\'s own bypass table is in its sub-rule (4.8 §3.1 ⑤)')
  assert.equal(rules['in-claude-code.settings'].some((l) => /DIRECT/.test(l) && !/DST-PORT/.test(l)), false, 'and not in another group\'s')
})

test('W12 order: the proxy entries of the groups that are on are written only after the kernel read the forms back as on; the groups the plan says are off have theirs undone after the kernel switched', async () => {
  const { r, e, log } = wiredKernel()
  const out = await r.attach()
  assert.deepEqual(log, ['kernel', 'write', 'undo'])
  assert.deepEqual(e.written, [[{ g: 'claude-code.settings', harness: 'claude-code', entry: 'auto' }, { g: 'codex.env', harness: 'codex', entry: 'auto' }]])
  assert.deepEqual(e.undone[0].map((x) => x.g), ['deepseek-dsh.env'], 'only a group the plan names as off: one it knows nothing about keeps whatever entry it has')
  assert.deepEqual(out.entries.written.map((x) => [x.g, x.ok]), [['claude-code.settings', true], ['codex.env', true]])
})

test('W12 a kernel that cannot start leaves zero proxy entries: attach() rejects with the forwarder\'s own code and reason, and nothing is written or undone', async () => {
  for (const [result, code, why] of [
    [{ ok: false, where: 'forwarder', code: 'forwarder-start-failed', reason: 'port-taken', port: 18801 }, 'forwarder-start-failed', /port-taken/],
    [{ ok: false, where: 'forwarder', code: 'forwarder-binary-missing', reason: 'package-not-installed' }, 'forwarder-binary-missing', /package-not-installed/],
    [{ ok: false, where: 'forwarder', code: 'forwarder-digest-mismatch', reason: 'the kernel copy is not the pinned exe', of: 'copy' }, 'forwarder-digest-mismatch', /pinned exe/],
    [{ ok: false, readBack: null, error: { status: 400, text: 'Body invalid' } }, 'forwarder-start-failed', /refused the new configuration \(status 400\)/],
  ]) {
    const { r, e, log } = wiredKernel({ kernel: { results: [result] } })
    await assert.rejects(r.attach(), (err) => { assert.equal(err.code, code); assert.match(err.message, why); assert.match(err.message, /no proxy entry was written/); return true })
    assert.deepEqual([log, e.written, e.undone], [['kernel'], [], []], code)
  }
})

test('W12 a read-back that does not say on is not on: the engine unreachable (the kernel keeps the re-entry) is fallback-active, anything else it cannot say plainly is not either — no entry in any case', async () => {
  for (const [states, code] of [
    [{ 'claude-code.cli': 'fallback' }, 'fallback-active'],
    [{ 'codex.app': 'missing' }, 'forwarder-start-failed'],
    [{ 'claude-code.vscode': 'unknown' }, 'forwarder-start-failed'],
    [{ 'deepseek-dsh.cli': 'still-on' }, 'forwarder-start-failed'],
  ]) {
    const mk = (forms) => ({ ok: false, readBack: readBack(forms.map((f) => ({ ...f, state: states[f.f] }))) })
    const log = []
    const k = kernel(log); k.reload = async ({ build, forms }) => { build({ port: 18899, secret: SECRET }); log.push('kernel'); return mk(forms) }
    const e = entriesLog(log)
    const { r } = bed({ forwarder: k, entries: e, routes: ROUTES, ownImages: OWN_IMAGES, gate: () => ({ ok: true }) })
    await assert.rejects(r.attach(), (err) => { assert.equal(err.code, code, JSON.stringify(states)); assert.ok(err.readBack && err.readBack.forms, 'the read-back is on the error: the receipt says which form'); return true })
    assert.deepEqual([log, e.written, e.undone], [['kernel'], [], []])
  }
})

test('W12 a crash between the read-back and the entries, then `on` again, completes: the second attach() reloads again and writes the same entries', async () => {
  const { r, e, log } = wiredKernel({ entries: { throwOnWrite: 1 } })
  await assert.rejects(r.attach(), /crashed/)
  assert.deepEqual(log, ['kernel', 'write'])
  const again = await r.attach()
  assert.deepEqual([log.slice(2), again.ok], [['kernel', 'write', 'undo'], true])
  assert.deepEqual(e.written[1], e.written[0], 'the same groups the first time asked for')
})

test('an entry that could not be written is that group\'s result, not an exception: the kernel and the other groups are as they were, and attach() says which group and why', async () => {
  const { r } = wiredKernel({ entries: { writeResult: (list) => list.map((x) => (x.g === 'codex.env' ? { g: x.g, ok: false, reason: 'the file cannot be read' } : { g: x.g, ok: true })) } })
  const out = await r.attach()
  assert.equal(out.ok, false)
  assert.deepEqual(out.entries.written.map((x) => [x.g, x.ok, x.reason ?? null]), [['claude-code.settings', true, null], ['codex.env', false, 'the file cannot be read']])
  assert.equal(out.kernel.ok, true)
})

test('attach() with nothing planned does not touch the kernel and undoes nothing it was not told is off', async () => {
  const { r, e, k, log } = wiredKernel({ redirector: { routes: () => ({}) } })
  const out = await r.attach()
  assert.deepEqual([log, e.undone, out.ok, out.kernel], [[], [], true, null])
  assert.equal(k.calls.length, 0)
})

test('attach() refuses before any write what it cannot build: a login it cannot read, a process rule that would match asight\'s own image (route-loop), and ownImages left out', async () => {
  const noLogin = wiredKernel({ redirector: { authOf: () => null } })
  await assert.rejects(noLogin.r.attach(), /prior:codex\.env/)
  assert.deepEqual([noLogin.log], [[]], 'neither the kernel nor an entry was touched')
  const loop = wiredKernel({ redirector: { ownImages: [String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`] } })
  await assert.rejects(loop.r.attach(), (e) => e.code === 'route-loop')
  assert.deepEqual(loop.log, [])
  const bare = wiredKernel({ redirector: { ownImages: undefined } })
  await assert.rejects(bare.r.attach(), /ownImages is required/)
  assert.deepEqual(bare.log, [])
})

test('W12 detach() is the other way: the kernel switched to forward only and read back first (no engine outbound, no fallback group, every form off), then every group\'s proxy entry undone', async () => {
  const { r, k, e, log } = wiredKernel()
  const out = await r.detach()
  assert.deepEqual(log, ['kernel', 'undo'])
  assert.ok(k.calls[0].forms.every((f) => f.on === false))
  const cfg = parse(k.calls[0].text)
  assert.deepEqual([cfg.proxies.some((p) => p.name.startsWith('asight-in-')), (cfg['proxy-groups'] || []).length], [false, 0])
  assert.deepEqual(listenersOf(k.calls[0].text), ['asight-l-claude-code.settings', 'asight-l-codex.env', 'asight-l-deepseek-dsh.env'], 'the listeners stay: an agent that outlives `off` still points at them')
  assert.deepEqual(e.undone[0].map((x) => x.g).sort(), ['claude-code.desktop', 'claude-code.settings', 'codex.env', 'deepseek-dsh.env', 'z-code.cli', 'z-code.desktop'], 'every group, planned or not: off undoes what asight wrote, and only that (the writer knows what that is)')
  assert.equal(out.ok, true)
})

test('detach() with no kernel running leaves it alone (nothing can point at it) and only undoes the entries; a kernel that cannot be switched, or a plan that cannot be built, still gets every entry undone and then fails', async () => {
  const stopped = wiredKernel({ kernel: { phase: 'stopped' } })
  const out = await stopped.r.detach()
  assert.deepEqual([stopped.log, out.ok, out.kernel], [['undo'], true, null])
  const stuck = wiredKernel({ kernel: { results: [{ ok: false, readBack: null, error: { status: 500, text: '' } }] } })
  await assert.rejects(stuck.r.detach(), (err) => { assert.equal(err.code, 'forwarder-start-failed'); assert.match(err.message, /entries were undone/); return true })
  assert.deepEqual(stuck.log, ['kernel', 'undo'], 'off always undoes by hand: the kernel failing does not keep the entries')
  const broken = wiredKernel({ redirector: { authOf: () => null } })
  await assert.rejects(broken.r.detach(), /prior:codex\.env/)
  assert.deepEqual(broken.log, ['undo'])
  const threw = wiredKernel({ kernel: { results: [new Error('the controller is gone')] } })
  await assert.rejects(threw.r.detach(), /controller is gone/)
  assert.deepEqual(threw.log, ['kernel', 'undo'])
})

test('status() is the kernel\'s read-back: attached when it says a form is on, the links are those forms, and the entries\' own check rides along', async () => {
  const { r, k, e } = wiredKernel()
  k.checked = { ok: true, forms: { 'claude-code.cli': { state: 'on', now: 'asight-in-claude-code.cli' }, 'codex.app': { state: 'on' }, 'deepseek-dsh.cli': { state: 'off' } } }
  const s = await r.status()
  assert.deepEqual([s.attached, s.links, s.hb_age_ms, s.drops], [true, [{ name: 'claude-code.cli' }, { name: 'codex.app' }], null, null])
  assert.deepEqual(e.checked[0].map((x) => x.g), ['claude-code.settings', 'codex.env'], 'the entries that should be there: the groups that are on')
  assert.deepEqual(s.entries.map((x) => [x.g, x.ok]), [['claude-code.settings', true], ['codex.env', true]])
  k.checked = { ok: true, forms: { 'claude-code.cli': { state: 'off' } } }
  assert.equal((await r.status()).attached, false, 'a kernel with nothing on is forward only: not attached')
  k.checked = { ok: false, forms: { 'claude-code.cli': { state: 'on' }, 'codex.app': { state: 'fallback' } } }
  assert.equal((await r.status()).attached, false, 'a read-back that is not ok is not on, whichever form says it is')
  k.checked = { ok: false, forms: {}, reason: 'not-running' }
  assert.deepEqual([(await r.status()).attached, (await r.status()).kernel.reason], [false, 'not-running'])
})

// ---------- the gate on the entries, and the groups the plan has on that nothing carries (review 2026-10-08) ----------

test('W19 gate: attach() asks `gate` for each group about to be written and does not hand a refused one to the writer — the kernel is on, the refused group says why, and the others are written; without a gate attach() does not run', async () => {
  const refuse = (e) => (e.harness === 'codex' ? { ok: false, reason: 'the proxy line cannot join the trust block yet (4.8 W19)' } : { ok: true })
  const { r, e, k, log } = wiredKernel({ redirector: { gate: refuse } })
  const out = await r.attach()
  assert.deepEqual(e.written, [[{ g: 'claude-code.settings', harness: 'claude-code', entry: 'auto' }]], 'codex is not handed to the writer')
  assert.deepEqual(out.entries.written, [{ g: 'claude-code.settings', ok: true }, { g: 'codex.env', ok: false, gated: true, reason: 'the proxy line cannot join the trust block yet (4.8 W19)' }])
  assert.deepEqual([out.ok, out.kernel.ok, k.calls.length, log], [false, true, 1, ['kernel', 'write', 'undo']], 'the kernel stands and `ok` says a group is not pointed at it')
  const asked = []
  const spy = wiredKernel({ redirector: { gate: (x) => { asked.push(x); return { ok: true } } } })
  await spy.r.attach()
  assert.deepEqual(asked, [{ g: 'claude-code.settings', harness: 'claude-code', entry: 'auto' }, { g: 'codex.env', harness: 'codex', entry: 'auto' }], 'asked for the groups that are on, with the entry the plan chose; not for the one that is off')
  const all = wiredKernel({ redirector: { gate: () => ({ ok: false, reason: 'closed' }) } })
  const none = await all.r.attach()
  assert.deepEqual([all.e.written, none.entries.written.map((x) => x.g), none.ok], [[], ['claude-code.settings', 'codex.env'], false], 'a gate that refuses everything: no write call at all')
  const thrown = wiredKernel({ redirector: { gate: () => { throw new Error('the journal cannot join a block') } } })
  const t = await thrown.r.attach()
  assert.deepEqual([thrown.e.written, t.ok, /the journal cannot join a block/.test(t.entries.written[0].reason)], [[], false, true], 'a gate that throws is a refusal, never a write')
  const bare = wiredKernel({ redirector: { gate: undefined } })
  await assert.rejects(bare.r.attach(), /needs the gate/)
  assert.deepEqual(bare.log, [], 'neither the kernel nor an entry was touched: the wiring has to say which groups may be written')
})

test('an entry list says `entry` only for a group that is on: null for the groups the plan has off (undo and check lists)', async () => {
  const { r, e } = wiredKernel()
  await r.attach()
  assert.deepEqual(e.undone[0], [{ g: 'deepseek-dsh.env', harness: 'deepseek-dsh', entry: null }])
  await r.status()
  assert.deepEqual(e.checked[0].map((x) => [x.g, x.entry]), [['claude-code.settings', 'auto'], ['codex.env', 'auto']])
})

test('D38 a group the plan has on that the kernel does not carry is said, not skipped: `entries.skipped` names it with why, `ok` is false, the others are as they were — no port, no supported form, no upstream, a login on a port that takes none', async () => {
  const one = (over) => wiredKernel({ redirector: over })
  const noPort = one({ ingress: () => ({ ...INGRESS, groupPorts: { 'codex.env': 18802 } }) })
  const a = await noPort.r.attach()
  assert.deepEqual([a.ok, a.entries.skipped], [false, [{ g: 'claude-code.settings', reason: 'no-port' }]])
  assert.deepEqual(noPort.e.written[0].map((x) => x.g), ['codex.env'], 'the carried group is written; the one nothing carries is not asked of the writer')
  const unsupported = GROUPS.map((x) => (x.g === 'claude-code.settings' ? { ...x, forms: x.forms.map((f) => ({ ...f, supported: { reason: 'not-measured' } })) } : x))
  const b = await one({ groups: unsupported }).r.attach()
  assert.deepEqual([b.ok, b.entries.skipped], [false, [{ g: 'claude-code.settings', reason: 'no-supported-form' }]])
  const c = await one({ routes: () => ({ ...ROUTES(), 'claude-code.settings': route({ upstream: null }) }) }).r.attach()
  assert.deepEqual([c.ok, c.entries.skipped], [false, [{ g: 'claude-code.settings', reason: 'no-upstream' }]])
  const open = GROUPS.map((x) => (x.g === 'claude-code.settings' ? { ...x, group: { ...x.group, auth: false } } : x))
  const d = await one({ groups: open, routes: () => ({ ...ROUTES(), 'claude-code.settings': route({ upstream: HTTP_PROXY }) }) }).r.attach()
  assert.deepEqual([d.ok, d.entries.skipped], [false, [{ g: 'claude-code.settings', reason: 'login-on-open-port' }]])
  const fine = await one({}).r.attach()
  assert.deepEqual([fine.ok, fine.entries.skipped], [true, []], 'nothing skipped, nothing said')
  const off = await one({ ingress: () => ({ ...INGRESS, groupPorts: { 'claude-code.settings': 18801, 'codex.env': 18802 } }) }).r.attach()
  assert.deepEqual(off.entries.skipped, [], 'a group the plan has off and nothing carries (deepseek-dsh.env has no port here) is not a gap: nobody asked for it')
})

// ---------- kernelGroupsOf: the plan as the kernel's config takes it, on the real data of all seven harnesses ----------

test('kernelGroupsOf on the real harness data: every group with a plan, a port and an upstream is carried, its forms with their own process rules, and the whole of it is a config the generator builds', async () => {
  const { loadHarnesses } = await import('../../../../src/collector/harness/index.mjs')
  const { kernelGroupsOf } = await import('../../../../src/collector/arch/win32/redirector.mjs')
  const { buildForwarderConfig, processRulesOf } = await import('../../../../src/netenv/mihomo/rules.mjs')
  const all = groupsOf(await loadHarnesses())
  const ids = all.map((x) => x.g)
  const routes = Object.fromEntries(ids.map((g) => [g, route({ on: g !== 'hermes.cli' })]))
  const groupPorts = Object.fromEntries(ids.map((g, i) => [g, 18900 + i]))
  const hostsOf = (f) => ['api.kimi.com', 'relay.example.net']
  const carried = kernelGroupsOf({ groups: all, routes, groupPorts, authOf: () => CRED, hostsOf })
  assert.deepEqual(carried.map((x) => x.g), ids, 'all seven harnesses\' groups; hermes.desktop has no group and is in none')
  const cc = carried.find((x) => x.g === 'claude-code.settings')
  assert.deepEqual(cc.forms.map((f) => f.f), ['claude-code.cli', 'claude-code.vscode'])
  assert.deepEqual(cc.forms[0].rules, processRulesOf({ pathPatterns: all.find((x) => x.g === 'claude-code.settings').forms[0].match.path, names: [] }), 'the form\'s own path patterns, no image name (claude.exe is two programs)')
  const dsh = carried.find((x) => x.g === 'deepseek-dsh.env')
  assert.deepEqual([dsh.forms[0].f, dsh.forms[0].rules, dsh.forms[1].rules.length > 0], ['deepseek-dsh.cli', [], true], 'the form with no process rule has none: it takes every connection of its port')
  assert.deepEqual(carried.find((x) => x.g === 'kimi-code.vscode').forms[0].hosts, ['api.kimi.com', 'relay.example.net'], 'a host-tree form carries its host set')
  assert.deepEqual(carried.map((x) => [x.g, x.auth]).filter(([, a]) => !a), [['claude-code.desktop', false]], 'an entry that takes no login has a port without users')
  assert.equal(carried.find((x) => x.g === 'hermes.cli').on, false)
  const ing = { enginePort: 18790, token: TOKEN, listenerToken: INGRESS.listenerToken }
  assert.doesNotThrow(() => buildForwarderConfig({ groups: carried, ...ing, controller: { port: 18899, secret: SECRET }, ownImages: OWN_IMAGES }))
})

test('kernelGroupsOf leaves out what the kernel must not carry: no plan, no port, no upstream, no form it can carry, and a login on a port that takes none', async () => {
  const { kernelGroupsOf } = await import('../../../../src/collector/arch/win32/redirector.mjs')
  const g = (id) => GROUPS.filter((x) => x.g === id)
  const run = (over) => kernelGroupsOf({ groups: GROUPS, routes: { 'claude-code.settings': route(), ...over.routes }, groupPorts: { 'claude-code.settings': 18801, ...over.ports }, authOf: () => CRED })
  assert.deepEqual(run({}).map((x) => x.g), ['claude-code.settings'])
  assert.deepEqual(kernelGroupsOf({ groups: GROUPS, routes: {}, groupPorts: PORTS }), [], 'no plan yet')
  assert.deepEqual(kernelGroupsOf({ groups: GROUPS, routes: { 'claude-code.settings': route() }, groupPorts: {} }), [], 'no port: ingress.json has none for it')
  const nameless = groupsOf([{ name: 'k', win32: { groups: [{ g: 'k.a', proxyEntry: { kind: 'file' }, auth: true }], forms: [{ id: 'k.a', g: 'k.a', match: { image: 'node.exe', path: ['anything'] }, nameRule: true, processRules: false, supported: true }] } }])
  assert.deepEqual(kernelGroupsOf({ groups: nameless, routes: { 'k.a': route() }, groupPorts: { 'k.a': 18900 } })[0].forms, [{ f: 'k.a', rules: [] }], 'a form with no process rule has none, whatever else its data says')
  assert.deepEqual(run({ routes: { 'codex.env': route({ upstream: null, on: false }) }, ports: { 'codex.env': 18802 } }).map((x) => x.g), ['claude-code.settings'], 'nothing to forward to: not carried, rather than forwarded direct round the proxy the agent needs')
  const desktop = { 'claude-code.desktop': route({ upstream: HTTP_PROXY }) }
  assert.deepEqual(run({ routes: desktop, ports: { 'claude-code.desktop': 18805 } }).map((x) => x.g), ['claude-code.settings'], 'a port with no users and a login in its upstream: any process could use it')
  const bare = [{ ...g('claude-code.settings')[0], forms: g('claude-code.settings')[0].forms.map((f) => ({ ...f, supported: { reason: 'not-measured' } })) }]
  assert.deepEqual(kernelGroupsOf({ groups: bare, routes: { 'claude-code.settings': route() }, groupPorts: PORTS }), [], 'no form it can carry')
  const socks = run({ routes: { 'claude-code.settings': route({ upstream: { kind: 'socks5', host: '10.0.0.2', port: 1080, credentialed: true, auth_ref: 'hkcu-env:HTTPS_PROXY', source: 'agent' } }) } })
  assert.deepEqual(socks[0].upstream, { type: 'socks5', host: '10.0.0.2', port: 1080, ...CRED })
  assert.throws(() => kernelGroupsOf({ groups: GROUPS, routes: { 'claude-code.settings': route({ upstream: HTTP_PROXY }) }, groupPorts: PORTS, authOf: () => null }), (e) => e.why === 'upstream-credentials-unavailable')
  assert.throws(() => kernelGroupsOf({ groups: groupsOf([{ name: 'k', win32: { groups: [{ g: 'k.vs', proxyEntry: { kind: 'file' }, auth: true }], forms: [{ id: 'k.vs', g: 'k.vs', match: { image: 'Code.exe', path: ['x'] }, processRules: true, supported: true, hosts: { defaults: ['a.example'] } }] } }]), routes: { 'k.vs': route() }, groupPorts: { 'k.vs': 18900 }, hostsOf: () => [] }), /host tree/)
})

// ---------- directCount · what this file may touch ----------

test('directCount(pid): the process\'s established connections that are not to a group\'s listener on loopback; a table that cannot be read is null and why, never 0', async () => {
  const rowOf = (pid, addr, port, state = 'established') => ({ pid, state, family: 4, localAddr: '127.0.0.1', localPort: 50000, remoteAddr: addr, remotePort: port })
  let rows = [rowOf(10, '127.0.0.1', 18801), rowOf(10, '104.18.0.1', 443), rowOf(10, '127.0.0.1', 7897), rowOf(10, '::1', 18802), rowOf(10, '1.1.1.1', 443, 'time-wait'), rowOf(11, '1.1.1.1', 443)]
  const calls = []
  const helper = { async call(verb, args, opts) { calls.push([verb, args, opts.timeoutMs]); if (rows instanceof Error) throw rows; return rows && { rows } } }
  const { r } = made({ helper, ingress: () => INGRESS })
  assert.deepEqual(await r.directCount(10), { count: 2, error: null }, 'the one to the internet and the one to a local proxy; not the two to asight\'s listeners, not the one closing, not another process\'s')
  assert.deepEqual(calls[0], ['tcp-table', { pids: [10], states: ['established'] }, 2000])
  rows = new Error('the helper died'); rows.code = 'helper-down'
  assert.deepEqual(await r.directCount(10), { count: null, error: 'helper-down' })
  rows = null
  assert.deepEqual(await r.directCount(10), { count: null, error: 'no-rows' })
  assert.deepEqual(await made({}).r.directCount(10), { count: null, error: 'no-helper' })
})

// ---------- the Redirector contract the callers hold it to ----------

test('the Windows redirector has every call the daemon, the tracker and the switch make on a Redirector (core/redirector.mjs): one it lacks is a TypeError at the first `on`, and a method the daemon calls only behind a `typeof` guard is optional', async () => {
  const fs = await import('node:fs')
  const strip = (f) => fs.readFileSync(new URL(`../../../../src/collector/${f}`, import.meta.url), 'utf8').replace(/\/\*[^]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')
  const sources = ['daemon.mjs', 'core/tracker.mjs', 'core/switch.mjs'].map(strip)
  const called = new Set(sources.flatMap((code) => [...code.matchAll(/\bredirector\.([A-Za-z]+)/g)].map((m) => m[1])))
  const guarded = (name) => sources.some((code) => code.includes(`typeof redirector.${name}`))
  // what Windows does not have, and why: the daemon opens no transparent listener there (4.8 §1: no transparent rewrite), so the engine never calls `lookup`; Task 8(c) takes the call out of the daemon's
  // transparent path. An entry here that the callers stop making is a stale entry, and this test says so.
  const NOT_ON_WINDOWS = { lookup: 'Windows has no transparent rewrite: Task 8(c) makes the daemon open no transparent listener there' }
  const { r } = made({})
  const missing = [...called].filter((name) => !guarded(name) && !(name in r) && !(name in NOT_ON_WINDOWS))
  assert.deepEqual(missing, [], `the callers need ${missing.join(', ')} of a Redirector and createWin32Redirector gives none`)
  for (const name of Object.keys(NOT_ON_WINDOWS)) assert.ok(called.has(name) && !(name in r), `${name} is still called and still absent on Windows: ${NOT_ON_WINDOWS[name]}`)
  for (const name of ['configure', 'directCount']) assert.ok(called.has(name) && typeof r[name] === 'function', `the two calls the review found missing or synchronous: ${name}`)
  assert.equal(await r.configure(18790), undefined, 'configure is accepted and tells the kernel nothing: its config has the engine port from ingress.json')
  assert.ok(called.has('setBeatGate') && typeof r.setBeatGate === 'function', 'the daemon sets the beat gate (1.6 §1.5) on any redirector')
  assert.equal(r.setBeatGate(() => false), undefined, 'and a redirector with no heartbeat accepts it and gates nothing')
})

test('what the redirector may do (static): it imports only the modules that read or plan, opens no socket, runs nothing, writes no file or registry key, names no harness, and the user\'s login is read in one place', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../../../../src/collector/arch/win32/redirector.mjs', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[^]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')
  const imports = [...code.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort()
  assert.deepEqual(imports, ['../../../netenv/mihomo/rules.mjs', './forms.mjs', './helper.mjs', './upstream.mjs', 'node:events'])
  assert.equal(/\b(writeFile\w*|appendFile\w*|mkdir\w*|rename\w*|unlink\w*|rmSync|spawn\w*|execFile\w*|execSync|fork|createServer|fetch|child_process|process\.platform|reg add|setx)\b|\.connect\(/.test(code), false, 'no write, no process, no socket, no platform branch')
  assert.equal(/\b(claude|codex|opencode|kimi|dsh|deepseek|hermes|zcode|z-code)\b/i.test(code), false, 'arch names no harness: the groups it is given say it')
  assert.equal([...code.matchAll(/authOf\(/g)].length, 1, 'the reference to a login is turned into one in a single function')
})

test('W16 end to end on the dedicated port: a connection of a child of the agent (a process that is not the form\'s) is spliced and leaves exactly one metadata row, the agent\'s child meets the origin\'s own certificate, and no envelope or failure is written (D40: cannot decrypt → splice and record)', async (t) => {
  const E = await wired(t, { ownerOf: owner({ pid: 21, source: 'socket-table', ms: 5 }, { pid: 20, source: 'socket-table', ms: 5 }) })
  trust(E.r, 20, 21) // even a trusted child is no dsh: the table says whose connection it is, and it is not dsh's
  const child = await E.agent('of.deepseek-dsh.cli', privCa.certPem)
  assert.equal(child.got, RESP)
  assert.match(child.issuer, /private origin CA/)
  await E.settled()
  assert.equal(E.flows.length, 1, 'one row')
  assert.deepEqual([E.flows[0].decision, E.flows[0].not_captured, E.flows[0].pid, E.flows[0].agent, E.flows[0].reason], ['splice', 'untracked', 21, 'deepseek-dsh', 'not-a-process-of-form'])
  assert.deepEqual([E.envelopes.length, E.failures.length], [0, 0])
  const own = await E.agent('of.deepseek-dsh.cli', asightCa.certPem) // dsh's own process, trusted: decrypted
  assert.match(own.issuer, /asight/i)
})
