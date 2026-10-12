// test/collector/arch/darwin/redirector.test.mjs — the macOS Redirector as D47 wrote it (RFC 4.9 §1 · §5): the ENGINE's per-group doors are the only proxy, identity is read
// from the socket at accept time (a targeted ownerOfSocket + the pid's targeted facts), and the doors' lifecycle is attach/detach. Nothing here runs macOS: the owner answers and
// the facts come from injected runners, the doors are a recorder, the entries are a recorder. The harness files' real darwin data is used for the forms (arch/ never imports
// harness/; a test may, to pin the rule to the real data), so a form whose path or command line is changed in the data changes what this file sees.
// The acceptance cells this file carries: W16 (who the connection is, whether it is decrypted — the accept-time identity), W72's lookup half (the upstream and its bypass table),
// W12's order (the doors before the entries), and audit F7 (an off group nobody carries opens no door at all).
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import { createDarwinRedirector } from '../../../../src/collector/arch/darwin/redirector.mjs'
import { groupsOf } from '../../../../src/collector/arch/darwin/route-plan.mjs'
import { createEngine } from '../../../../src/collector/core/engine/engine.mjs'
import { createCa, loadCa } from '../../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../../src/collector/core/tls/leaf.mjs'
import { within, closeWithin } from '../../../helpers/bounded.mjs'
import claudeCode from '../../../../src/collector/harness/darwin/claude-code.mjs'
import codex from '../../../../src/collector/harness/darwin/codex.mjs'
import deepseekDsh from '../../../../src/collector/harness/darwin/deepseek-dsh.mjs'
import zCode from '../../../../src/collector/harness/darwin/z-code.mjs'

const GROUPS = groupsOf([{ name: 'claude-code', darwin: claudeCode }, { name: 'codex', darwin: codex }, { name: 'deepseek-dsh', darwin: deepseekDsh }, { name: 'z-code', darwin: zCode }])
const HOME = '/Users/u'
const IMG = {
  ccCli: '/Users/u/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
  ccVscode: '/Users/u/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude',
  ccElsewhere: '/Volumes/tools/claude/claude',
  codexNpm: '/Users/u/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
  node: '/usr/local/bin/node',
  helperUtility: '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper',
  syslogd: '/usr/libexec/syslogd',
}
const DSH_CMD = '/usr/local/bin/node /Users/u/.npm-global/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js'
const ZCODE_CMD = '/Applications/ZCode.app/Contents/MacOS/ZCode /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs app-server --stdio'

/** What procinfo's targeted ask carries (the fields the redirector reads, and the ones around them): the darwin ProcFacts contract, `envRead:false` included. */
const facts = (pid, exe, extra = {}) => ({ os: 'darwin', pid, ppid: 1, name: exe.split('/').pop(), exe, argv: [], cmdline: exe, env: null, envRead: false, cwd: null, startedAt: 1000 + pid, startTicks: String(1000 + pid), sessionId: null, integrity: null, tokenDenied: false, elevated: false, elevationInferred: false, cmdlineState: 'ok', source: 'accept', ...extra })

/** The facts store the test fills and factsOf answers from: the pid's facts as the targeted ask would give them. */
const factsStore = (rows = new Map()) => { const f = (pid) => (rows.has(pid) ? rows.get(pid) : null); f.rows = rows; return f }

/** The doors as a recorder: what was opened and closed, in order. */
const doorsLog = (log, { openResult = null } = {}) => {
  const opened = []
  const closed = []
  return {
    opened, closed,
    open: async (list) => { log.push('doors'); opened.push(list.map(({ id, port, auth, token }) => ({ id, port, auth, token: token ? '…' : null }))); if (openResult) return openResult(list); return list.map((x) => ({ [x.id]: x.port })) },
    close: async (ids) => { log.push('close'); closed.push([...ids]) },
  }
}
/** The proxy-entry writer: what it was asked for, in order with the doors' calls; `fail` makes the n-th write throw (a crash between the doors and the entries). */
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

const made = (over = {}) => {
  const store = factsStore()
  const r = createDarwinRedirector({ groups: GROUPS, home: HOME, factsOf: store, verdictWaitMs: 60, ...over })
  return { r, store }
}
const collect = (r, names) => { const got = []; for (const n of names) r.on(n, (x) => got.push([n, x])); return got }
// the verdict wait's timer is unref'd by design (a draining daemon must not be held alive by a lookup waiting on a judge that will never
// answer); a bare test process has no ref'd handles, so the loop would resolve under the wait — every wait holds the loop alive for itself
const withAliveLoop = async (fn) => {
  const keepAlive = setInterval(() => {}, 1 << 30)
  try { return await fn() } finally { clearInterval(keepAlive) }
}

// ---------- the verdict table (4.8 §5.4) and the seam the tracker judges on ----------

test('watch and unwatch are the tracker\'s verdict table (4.8 §5.4): decrypt only when the verdict says exactly true, nothing for a process it has not judged', () => {
  const { r } = made()
  assert.equal(r.verdictOf(10), null)
  r.watch(10, { decrypt: true, agent: 'claude-code' }); r.watch(11, { decrypt: false, agent: 'claude-code' }); r.watch(12, { decrypt: 'yes' }); r.watch(13, undefined)
  assert.deepEqual([10, 11, 12, 13].map((p) => r.verdictOf(p).decrypt), [true, false, false, false], 'a verdict that is not the boolean true is not trust')
  r.unwatch(10)
  assert.equal(r.verdictOf(10), null)
  assert.doesNotThrow(() => r.unwatch(404))
})

test('a pid met at a door is ANNOUNCED once per life (exec, its targeted facts) and the lookup waits for the tracker\'s watch(); a verdict that never comes is a tombstone — one wait per life, and a later watch() overwrites it', async () => {
  const { r, store } = made({ routes: () => ({ 'claude-code.settings': route() }), ingress: () => INGRESS, ownerOf: ownerAlways({ pid: 10, source: 'socket-table', ms: 3 }) })
  store.rows.set(10, facts(10, IMG.ccCli))
  const told = collect(r, ['exec'])
  const m = await withAliveLoop(() => r.lookupIngress({ peer: PEER, user: 'claude-code.settings', target: target('api.anthropic.com') }))
  assert.deepEqual(told.map(([, f]) => [f.pid, f.source]), [[10, 'accept']], 'the tracker was told, with the facts it judges by')
  assert.deepEqual([m.pid, m.form, m.decrypt], [10, 'claude-code.cli', false], 'no verdict: not decrypted, and no code of ours — the engine\'s policy arm says untracked for a pid the tracker holds no row of')
  assert.equal(r.verdictOf(10).none, true, 'the tombstone is in the table: the wait happened once, not per connection')
  const after = await r.lookupIngress({ peer: PEER, user: 'claude-code.settings', target: target('api.anthropic.com') })
  assert.deepEqual([after.pid, after.decrypt], [10, false], 'the second connection is answered by the tombstone at once, no new wait')
  assert.deepEqual(told.length, 1, 'the pid was told once for this life: the second connection did not re-ask')
  r.watch(10, { decrypt: true, agent: 'claude-code' }) // the tracker judged it after all (a harness came on, the file landed)
  const m2 = await r.lookupIngress({ peer: PEER, user: 'claude-code.settings', target: target('api.anthropic.com') })
  assert.deepEqual([m2.pid, m2.decrypt, m2.skip], [10, true, undefined], 'the tombstone is overwritten the moment the tracker answers')
})

test('a wrapped pid is a new life: another start time in the fresh facts drops the old verdict and tells the tracker again — a dead process\'s trust is never inherited', async () => {
  const { r, store } = made({ routes: () => ({ 'claude-code.settings': route() }), ingress: () => INGRESS, ownerOf: owner({ pid: 10, source: 'socket-table', ms: 1 }) })
  store.rows.set(10, facts(10, IMG.ccCli))
  r.watch(10, { decrypt: true, agent: 'claude-code' })
  const before = await r.lookupIngress({ peer: PEER, user: 'claude-code.settings', target: target('api.anthropic.com') })
  assert.equal(before.decrypt, true, 'the old life\'s verdict holds while the pid is that process')
  store.rows.set(10, facts(10, IMG.syslogd, { startedAt: 99000 })) // the pid wrapped: the same number, another process entirely
  r.watch(10, { decrypt: true, agent: 'claude-code' }) // …and a tracker that already answered for the old life (its row says so)
  const after = await r.lookupIngress({ peer: PEER, user: 'claude-code.settings', target: target('api.anthropic.com') })
  assert.equal(after.decrypt, false, 'the fresh facts\'s start time does not match the verdict\'s life: the verdict is not this connection\'s to use')
})

test('start() has nothing to wait for (no helper, no watcher — D47 deleted the scan); helperInfo() and expectedProto say what daemon.ensureReady compares; close() is a no-op', async () => {
  const { r } = made()
  assert.deepEqual(r.helperInfo(), { pid: null, proto: null, build: null }, 'before start there is nothing to say')
  assert.deepEqual(await r.start(), { pid: null, proto: null, build: null })
  assert.equal(r.expectedProto, null)
  assert.equal(r.heartbeat(), undefined, 'a heartbeat gates nothing here')
  await r.close()
})

test('the table is what the doors taught it: procs()/pidsOf()/scan() say which form each met process is, and a path nobody measured has the user\'s name masked', async () => {
  const store = factsStore()
  for (const f of [facts(10, IMG.ccCli), facts(12, IMG.ccVscode), facts(13, IMG.codexNpm), facts(14, IMG.ccElsewhere, { elevated: true }), facts(30, IMG.syslogd)]) store.rows.set(f.pid, f)
  const byPeer = (q) => ({ pid: q.peer.port - 50000, source: 'socket-table', ms: 1 })
  // the lookups that teach: one per pid (the store answers each time a door meets one)
  const ctx = made({ routes: () => ({ 'claude-code.settings': route(), 'codex.env': route() }), ingress: () => INGRESS, factsOf: store, ownerOf: byPeer })
  for (const pid of [10, 12, 13, 14, 30]) await withAliveLoop(() => ctx.r.lookupIngress({ peer: { ...PEER, port: 50000 + pid }, user: pid === 13 ? 'codex.env' : 'claude-code.settings', target: target('api.anthropic.com') }))
  assert.deepEqual(ctx.r.pidsOf('claude-code.cli'), [10])
  assert.deepEqual(ctx.r.pidsOf('claude-code.vscode'), [12], 'two forms of one image, told apart by path')
  assert.deepEqual(ctx.r.procs().map((p) => [p.pid, p.match.kind, p.match.id ?? null, p.elevated]), [
    [10, 'form', 'claude-code.cli', false],
    [12, 'form', 'claude-code.vscode', false],
    [13, 'form', 'codex.cli', false],
    [14, 'path-unknown', null, true],
  ], 'what planRoutes takes as `procs`: forms and the images only an agent has; syslogd is nobody\'s (it was met, and matched nothing)')
  const live = await ctx.r.scan()
  assert.deepEqual(live.map((f) => f.pid).sort((a, b) => a - b), [10, 12, 13, 14, 30], 'scan() answers the met processes as facts: a rescan re-judges exactly those')
})

test('the redirector asks for what it needs: the groups (the rest — ownerOf, factsOf, doors — are optional seams, their absence answered fail-safe)', () => {
  assert.throws(() => createDarwinRedirector({}), /needs the groups/)
})

// ---------- lookupIngress (4.8 §5.2 · §5.4, D47's shape): the door names the group, the socket names the process ----------

const TOKEN = '0123456789abcdef0123456789abcdef'
const PORTS = { 'claude-code.settings': 18801, 'codex.env': 18802, 'deepseek-dsh.env': 18803, 'z-code.cli': 18804 }
const INGRESS = { enginePort: 18790, groupPorts: PORTS, ingressToken: TOKEN, listenerToken: 'fedcba9876543210fedcba9876543210' }
const route = (over = {}) => ({ entry: 'auto', on: true, reason: null, upstream: { kind: 'direct', source: 'direct' }, bypass: [], ...over })
const HTTP_PROXY = { kind: 'http', host: '127.0.0.1', port: 7897, credentialed: true, auth_ref: 'prior:codex.env', source: 'agent' }
const CRED = { username: 'u1', password: 'pw-SECRET' }
const BYPASS = [{ kind: 'local' }, { kind: 'domain-suffix', value: 'corp.example.com' }, { kind: 'ip-cidr', value: '10.0.0.0/8' }, { kind: 'domain', value: 'gateway.internal' }]
const PEER = { address: '127.0.0.1', port: 50000 }
const target = (address, port = 443) => ({ address, port })

/** An ownerOf that answers what the test says (a list, one per call; then nobody) and remembers what it was asked. */
function owner(...answers) {
  const calls = []
  const fn = async (q) => { calls.push({ peer: { ...q.peer } }); const a = answers.length ? answers.shift() : null; if (a instanceof Error) throw a; return a ?? { pid: null, source: null, ms: 3 } }
  fn.calls = calls
  return fn
}
/** An ownerOf that answers the same thing every time (a living process holds its socket for every ask of it). */
const ownerAlways = (a) => { const calls = []; const fn = async (q) => { calls.push({ peer: { ...q.peer } }); return { ...a } }; fn.calls = calls; return fn }

/** The redirector with a populated facts store: Claude Code cli 10 and 11, its VS Code form 12, codex 13, dsh 20 (node with the dsh command line), a Node child 21, syslogd 30, the Desktop utility Helper 40. */
function bed(over = {}) {
  const store = factsStore()
  for (const f of [facts(10, IMG.ccCli), facts(11, IMG.ccCli, { startedAt: 5000 }), facts(12, IMG.ccVscode), facts(13, IMG.codexNpm), facts(20, IMG.node, { cmdline: DSH_CMD }), facts(21, IMG.node, { cmdline: '/usr/local/bin/node /Users/u/work/server.js' }), facts(30, IMG.syslogd), facts(40, IMG.helperUtility, { cmdline: `${IMG.helperUtility} --type=utility` })]) store.rows.set(f.pid, f)
  const r = createDarwinRedirector({ groups: GROUPS, home: HOME, factsOf: store, verdictWaitMs: 60, routes: () => ({ 'claude-code.settings': route(), 'codex.env': route(), 'deepseek-dsh.env': route() }), ingress: () => INGRESS, authOf: () => CRED, ...over })
  return { r, store }
}
const trust = (r, ...pids) => { for (const p of pids) r.watch(p, { decrypt: true, agent: 'x' }) }
const distrust = (r, ...pids) => { for (const p of pids) r.watch(p, { decrypt: false, agent: 'x' }) }
const ask = (r, user, t = target('api.anthropic.com'), peer = PEER) => r.lookupIngress({ peer, user, target: t })

test('a door nobody holds answers null: not a group id, a group the plan has no answer for — and a CONNECT at the door\'s OWN address is a loop through the door, refused (any other loopback target — a local model server — is a flow like any other; the kernel\'s health probe went with the kernel)', async () => {
  const { r } = bed({ routes: () => ({ 'claude-code.settings': route(), 'codex.env': route({ on: false, entry: null, reason: 'desired-off' }), 'z-code.cli': route() }) })
  for (const u of [undefined, null, '', 'of.claude-code.settings', 'claude-code.cli', 're.claude-code.settings', 'asight', 'hermes.cli', 'CLAUDE-CODE.SETTINGS']) assert.equal(await ask(r, u), null, `${u}: the door names its GROUP (D47), and nothing else is one`)
  assert.notEqual(await ask(r, 'claude-code.settings'), null)
  for (const t of [target('127.0.0.1', 18801), target('localhost', 18801)]) assert.equal(await ask(r, 'claude-code.settings', t), null, `${t.address}:${t.port}: a loop through the door is not a flow`)
  assert.notEqual((await ask(r, 'claude-code.settings', target('127.0.0.1', 11434))).upstream, undefined, 'a local model server at the loopback is served: the engine dials it like any target')
})

test('a connection of a group the plan has turned off before the doors followed is served, not refused: a spliced meta with the group\'s upstream and a code that says why, so the agent never sees a refusal; no identity is asked for; a group with nothing to dial is refused as before', async () => {
  const o = owner()
  const off = (over = {}) => route({ on: false, entry: null, reason: 'desired-off', ...over })
  const { r } = bed({ routes: () => ({ 'claude-code.settings': off(), 'codex.env': off({ upstream: HTTP_PROXY, bypass: BYPASS }), 'deepseek-dsh.env': off({ upstream: null }) }), ownerOf: o })
  const m = await ask(r, 'claude-code.settings', target('api.anthropic.com'))
  assert.deepEqual(m, { pid: null, agent: 'claude-code', decrypt: false, capture: 'proxy', form: null, exe: null, upstream: { kind: 'direct' }, pid_source: null, pid_ms: null, negKey: 'claude-code.settings', skip: { not_captured: 'untracked', reason: 'group-off' } })
  assert.equal(o.calls.length, 0, 'a connection that is spliced anyway does not wait for the owner question')
  assert.deepEqual((await ask(r, 'codex.env', target('api.openai.com'))).upstream, { kind: 'http', host: '127.0.0.1', port: 7897, auth: CRED }, 'it goes where the agent\'s own proxy leads, with the login, as for any connection')
  assert.deepEqual((await ask(r, 'codex.env', target('gateway.internal'))).upstream, { kind: 'direct' }, 'and the bypass table applies')
  assert.equal(await ask(r, 'deepseek-dsh.env'), null, 'an off group with nothing to dial has nothing to serve either: refused as before')
})

test('W16 a pid known and judged trusted: decrypt, the form, the harness, the real executable, how the pid was found — the ask is the socket\'s peer, and the form is the DOOR\'S group\'s', async () => {
  const o = owner({ pid: 10, source: 'socket-table', ms: 7 })
  const { r } = bed({ ownerOf: o })
  trust(r, 10)
  assert.deepEqual(await ask(r, 'claude-code.settings'), { pid: 10, agent: 'claude-code', decrypt: true, capture: 'proxy', form: 'claude-code.cli', exe: IMG.ccCli, upstream: { kind: 'direct' }, pid_source: 'socket-table', pid_ms: 7, negKey: '10' })
  assert.deepEqual(o.calls, [{ peer: PEER }], 'the ask is the accepted socket\'s peer 4-tuple: targeted, not a whole-table read with candidates')
})

test('W16 a pid known and judged untrusted (or not judged at all): not decrypted, with no code of ours — the tracker answers for a pid, with the resolver\'s own reason', async () => {
  const { r } = bed({ ownerOf: owner({ pid: 10, source: 'socket-table', ms: 2 }, { pid: 11, source: 'socket-table', ms: 2 }) })
  distrust(r, 10)
  const a = await ask(r, 'claude-code.settings')
  const b = await withAliveLoop(() => ask(r, 'claude-code.settings')) // pid 11 has no verdict: this is the wait the tombstone ends
  assert.deepEqual([a.pid, a.form, a.decrypt, a.skip, b.pid, b.decrypt, b.skip], [10, 'claude-code.cli', false, undefined, 11, false, undefined])
})

test('W16 wrong-pid-never, the D47 shape: no pid from the socket (no row, two rows, a slow or unreadable table) is spliced untracked and never guessed at — there is no candidate set and no form-whole decrypt any more, the process IS the answer or there is none', async () => {
  const { r } = bed({ ownerOf: owner() })
  trust(r, 10, 11)
  const m = await ask(r, 'claude-code.settings')
  assert.deepEqual([m.pid, m.decrypt, m.skip, m.negKey, m.exe], [null, false, { not_captured: 'untracked', reason: 'pid-unresolved' }, 'claude-code.settings', null], 'all of the form trusted and it does not matter: without the pid there is no process to decrypt')
})

test('W16 a process of ANOTHER form at this door (the open desktop door\'s shape) or of no form at all: forwarded, untracked, named for what it is — the door\'s own group\'s forms are the only ones it decrypts', async () => {
  const o = owner({ pid: 21, source: 'socket-table', ms: 4 }, { pid: 30, source: 'socket-table', ms: 4 }, { pid: 13, source: 'socket-table', ms: 4 })
  const { r } = bed({ ownerOf: o })
  trust(r, 21, 30, 13)
  const child = await ask(r, 'claude-code.settings')
  assert.deepEqual([child.pid, child.decrypt, child.skip, child.form ?? null, child.exe], [21, false, { not_captured: 'untracked', reason: 'not-a-process-of-form' }, null, IMG.node], 'a Node child of the agent connecting at the claude door: spliced, and the row says whose it was')
  const other = await ask(r, 'claude-code.settings')
  assert.deepEqual([other.pid, other.decrypt, other.exe], [30, false, IMG.syslogd], 'syslogd at the door: the same refusal, however trusted the table says nobody is')
  const wrongDoor = await ask(r, 'claude-code.settings')
  assert.deepEqual([wrongDoor.pid, wrongDoor.decrypt, wrongDoor.skip.reason], [13, false, 'not-a-process-of-form'], 'codex\'s own process at the claude door — trusted, even — is not claude\'s door\'s to decrypt: the desktop door is open to every process, and this is the arm that keeps that safe')
})

test('the desktop family at its own door (4.9 §2.3 · §6.4): the utility Helper that owns the model sockets is the desktop form by its real executable — spaces and all — and the main binary is the same form', async () => {
  const o = owner({ pid: 40, source: 'socket-table', ms: 6 })
  const { r } = bed({ routes: () => ({ 'claude-code.desktop': route() }), ingress: () => ({ ...INGRESS, groupPorts: { ...PORTS, 'claude-code.desktop': 18805 } }), ownerOf: o })
  r.watch(40, { decrypt: true, agent: 'claude-code' })
  const m = await ask(r, 'claude-code.desktop')
  assert.deepEqual([m.pid, m.form, m.exe, m.decrypt], [40, 'claude-code.desktop', IMG.helperUtility, true], 'the Helper\'s exe came from lsof\'s txt record (factsOf): the whole path, not the word ps\'s split would leave')
})

test('a form told by its command line is its form the moment the facts carry the command line (the targeted ask gives both in one shot): until the tracker has judged it, it is not decrypted', async () => {
  const o = ownerAlways({ pid: 41, source: 'socket-table', ms: 1 })
  const { r, store } = bed({ routes: () => ({ 'z-code.cli': route() }), ownerOf: o })
  store.rows.set(41, facts(41, IMG.syslogd.replace('syslogd', 'ZCode'), { exe: '/Applications/ZCode.app/Contents/MacOS/ZCode', cmdline: ZCODE_CMD }))
  const m = await withAliveLoop(() => ask(r, 'z-code.cli'))
  assert.deepEqual([m.pid, m.form, m.decrypt, m.skip], [41, 'z-code.cli', false, undefined], 'one process and it is not judged: not decrypted, with no code of ours — the tracker\'s reason rides the row')
  trust(r, 41)
  assert.equal((await ask(r, 'z-code.cli')).decrypt, true)
})

test('W72 (lookup half) a CONNECT target that hits the group\'s bypass table is {kind:"direct"}, any other the group\'s upstream; each kind of row, and the user\'s login stays out of a direct connection', async () => {
  const refs = []
  const { r } = bed({ routes: () => ({ 'claude-code.settings': route(), 'codex.env': route({ upstream: HTTP_PROXY, bypass: BYPASS }), 'deepseek-dsh.env': route() }), authOf: (ref) => { refs.push(ref); return CRED }, ownerOf: owner() })
  for (const host of ['intranet', 'a.corp.example.com', 'corp.example.com', '10.1.2.3', 'gateway.internal', 'GATEWAY.internal']) assert.deepEqual((await ask(r, 'codex.env', target(host))).upstream, { kind: 'direct' }, host)
  assert.deepEqual(refs, [], 'a direct connection never asks for the proxy\'s login')
  for (const host of ['api.openai.com', 'x.gateway.internal', '11.0.0.1', 'evilcorp.example.com', '2001:db8::1']) assert.deepEqual((await ask(r, 'codex.env', target(host))).upstream, { kind: 'http', host: '127.0.0.1', port: 7897, auth: CRED }, host)
  assert.deepEqual(refs.slice(0, 1), ['prior:codex.env'])
})

test('W72 a door never borrows another group\'s answers: the same targets through the claude door (an upstream of its own) all go to its upstream', async () => {
  const socks = { kind: 'socks5', host: '127.0.0.1', port: 1080, source: 'system-proxy' }
  const { r } = bed({ routes: () => ({ 'claude-code.settings': route({ upstream: socks }), 'codex.env': route({ upstream: HTTP_PROXY, bypass: BYPASS }), 'deepseek-dsh.env': route() }), ownerOf: owner() })
  for (const host of ['intranet', 'a.corp.example.com', '10.1.2.3', 'gateway.internal']) {
    assert.deepEqual((await ask(r, 'claude-code.settings', target(host))).upstream, { kind: 'socks5', host: '127.0.0.1', port: 1080 }, `${host} is codex's bypass, not claude code's`)
    assert.deepEqual((await ask(r, 'codex.env', target(host))).upstream, { kind: 'direct' }, host)
  }
})

test('the upstream\'s login is resolved from its reference for this one connection and is not in anything else the lookup says; one that cannot be read, or a group that is on with nothing to dial, fails the lookup with a reason that has no login in it', async () => {
  const o = owner()
  const { r } = bed({ routes: () => ({ 'codex.env': route({ upstream: HTTP_PROXY }) }), ownerOf: o })
  const meta = await ask(r, 'codex.env')
  assert.deepEqual(meta.upstream.auth, CRED)
  assert.equal(JSON.stringify({ ...meta, upstream: { ...meta.upstream, auth: undefined } }).includes('pw-SECRET'), false)
  const noLogin = bed({ routes: () => ({ 'codex.env': route({ upstream: HTTP_PROXY, bypass: BYPASS }) }), authOf: () => null, ownerOf: o }).r
  await assert.rejects(ask(noLogin, 'codex.env'), (e) => { assert.deepEqual([e.why, e.code], ['upstream-credentials-unavailable', 'upstream-unavailable']); assert.match(e.message, /prior:codex\.env/); assert.equal(e.message.includes('pw-'), false); return true })
  assert.deepEqual((await ask(noLogin, 'codex.env', target('gateway.internal'))).upstream, { kind: 'direct' }, 'a bypassed target needs no login')
  assert.equal(o.calls.length, 2, 'the connection that was dialled and the bypassed one asked the owner; the one that could not be dialled did not wait for it')
  const nothing = bed({ routes: () => ({ 'codex.env': route({ upstream: null }) }) }).r
  await assert.rejects(ask(nothing, 'codex.env'), (e) => e.why === 'no-upstream' && e.code === 'upstream-unavailable')
})

test('an owner question that throws never costs the agent its connection: no pid, spliced untracked, and one `socktable-unavailable` failure that passes checkRecord', async () => {
  const { checkRecord } = await import('../../../../src/health/codes.mjs')
  const failures = []
  const { r } = bed({ ownerOf: owner(new Error('the lsof read died')), onFailure: (f) => failures.push(f) })
  trust(r, 10)
  const m = await ask(r, 'claude-code.settings')
  assert.deepEqual([m.pid, m.decrypt, m.pid_source, m.skip], [null, false, null, { not_captured: 'untracked', reason: 'pid-unresolved' }])
  assert.equal(failures.length, 1)
  assert.deepEqual([failures[0].where, failures[0].code, checkRecord(failures[0])], ['helper', 'socktable-unavailable', []])
  assert.match(failures[0].reason, /the lsof read died/)
  const without = bed({}).r // no owner question wired at all: the fail-safe is the same
  trust(without, 10)
  assert.deepEqual([(await ask(without, 'claude-code.settings')).pid_ms, (await ask(without, 'claude-code.settings')).skip.reason], [null, 'pid-unresolved'])
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
  const { r } = bed({ ownerOf, ...over })
  const flows = [], envelopes = [], failures = []
  const engine = createEngine({
    redirector: r, issuer: createLeafIssuer(loadCa(asightCa)), upstreamCa: privCa.certPem, ingressToken: TOKEN,
    policy: (meta) => (meta.decrypt ? true : meta.skip), // what the daemon's policy does with a meta that has no pid: the code lookupIngress gave it
    store: { envelope: (e) => { envelopes.push(e); return true }, flow: (f) => { flows.push(structuredClone(f)); return true } }, onFailure: (f) => failures.push(f),
  })
  const { ingressPort } = await engine.listen({ ingress: { port: 0 } })
  t.after(async () => { origin.close(); await closeWithin(engine) })
  const settled = async ({ envelope = false } = {}) => { for (let i = 0; i < 400 && (flows.length < 1 || (envelope && envelopes.length < 1)); i++) await new Promise((x) => setTimeout(x, 10)) }
  /** An agent's connection as the door answers it (CONNECT, the door's group as the user, the token as the password), then TLS to the origin trusting `ca`: → { issuer, got } or 'closed' */
  async function agent(user, ca, { token = TOKEN } = {}) {
    const sock = net.connect(ingressPort, '127.0.0.1'); sock.on('error', () => {})
    const head = `CONNECT 127.0.0.1:${origin.address().port} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Basic ${Buffer.from(`${user}:${token}`).toString('base64')}\r\n\r\n`
    sock.write(head)
    await within(new Promise((res) => { let b = ''; const on = (d) => { b += d.toString('latin1'); if (b.includes('\r\n\r\n')) { sock.removeListener('data', on); res() } }; sock.on('data', on) }), 4000, 'the 200', () => sock.destroy())
    return within(new Promise((resolve) => {
      let issuerOf = null, got = ''
      const c = tls.connect({ socket: sock, servername: 'upstream.test', ca, ALPNProtocols: ['http/1.1'] }, () => { issuerOf = c.getPeerX509Certificate().issuer; c.write(REQ) })
      c.on('data', (d) => { got += d.toString('latin1'); if (got.length >= RESP.length) c.end() })
      c.on('error', () => {}); c.on('close', () => resolve(issuerOf ? { issuer: issuerOf, got } : 'closed'))
    }), 6000, 'the TLS exchange', () => sock.destroy())
  }
  return { r, flows, envelopes, failures, settled, agent }
}

test('W16 end to end, the pid untrusted: the connection is spliced, the agent meets the origin\'s own certificate and its answer with zero errors, and the row says why', async (t) => {
  const E = await wired(t, { ownerOf: owner({ pid: 10, source: 'socket-table', ms: 2 }) })
  distrust(E.r, 10)
  const got = await E.agent('claude-code.settings', privCa.certPem)
  assert.equal(got.got, RESP, 'the agent got its answer')
  assert.match(got.issuer, /private origin CA/, 'from the origin: asight\'s CA never signed anything the agent saw')
  await E.settled()
  const [row] = E.flows
  assert.equal(row.decision, 'splice')
  assert.deepEqual([row.pid, row.agent], [10, 'claude-code'])
  assert.deepEqual([row.ingress, row.upstream], [{ route: 'claude-code', group: 'settings' }, { kind: 'direct' }])
  assert.equal(E.envelopes.length, 0)
  assert.deepEqual(E.failures, [], 'the agent saw no error and nothing was recorded as a failure')
})

test('W16 end to end, the pid trusted: the same connection is decrypted, the agent sees asight\'s leaf, the envelope names the agent, the pid and the real executable', async (t) => {
  const E = await wired(t, { ownerOf: owner({ pid: 10, source: 'socket-table', ms: 2 }) })
  trust(E.r, 10)
  const got = await E.agent('claude-code.settings', asightCa.certPem)
  assert.equal(got.got, RESP)
  assert.match(got.issuer, /asight/i, 'decrypted: the leaf is asight\'s')
  await E.settled({ envelope: true })
  assert.deepEqual([E.flows[0].decision, E.flows[0].not_captured ?? null], ['decrypt', null])
  assert.deepEqual([E.envelopes[0].proc.agent, E.envelopes[0].proc.pid, E.envelopes[0].proc.exe], ['claude-code', 10, IMG.ccCli])
  assert.deepEqual(E.failures, [])
})

test('end to end, a group the plan has just turned off: the agent\'s connection is spliced to the origin and answered with zero errors, the row says `untracked` · `group-off`', async (t) => {
  const E = await wired(t, { routes: () => ({ 'claude-code.settings': route({ on: false, entry: null, reason: 'desired-off' }) }), ownerOf: owner() })
  trust(E.r, 10) // even trusted: the plan says this group is off
  const got = await E.agent('claude-code.settings', privCa.certPem)
  assert.equal(got.got, RESP, 'the agent got its answer')
  assert.match(got.issuer, /private origin CA/)
  await E.settled()
  assert.deepEqual([E.flows[0].decision, E.flows[0].not_captured, E.flows[0].reason, E.flows[0].pid, E.flows[0].agent], ['splice', 'untracked', 'group-off', null, 'claude-code'])
  assert.deepEqual([E.envelopes.length, E.failures], [0, []])
})

test('W16 end to end on the open door\'s shape: a connection of a process that is not the door\'s form (a child of the agent) is spliced and leaves exactly one metadata row, the child meets the origin\'s own certificate, and no envelope or failure is written (D40: cannot decrypt → splice and record)', async (t) => {
  const E = await wired(t, { ownerOf: owner({ pid: 21, source: 'socket-table', ms: 5 }) })
  trust(E.r, 21) // even a trusted child is not this door\'s form: the socket says whose connection it is, and the door does not decrypt another form\'s
  const child = await E.agent('claude-code.settings', privCa.certPem)
  assert.equal(child.got, RESP)
  assert.match(child.issuer, /private origin CA/)
  await E.settled()
  assert.equal(E.flows.length, 1, 'one row')
  assert.deepEqual([E.flows[0].decision, E.flows[0].not_captured, E.flows[0].pid, E.flows[0].agent, E.flows[0].reason], ['splice', 'untracked', 21, 'claude-code', 'not-a-process-of-form'])
  assert.deepEqual([E.envelopes.length, E.failures.length], [0, 0])
})

test('end to end, an upstream that cannot be dialled (its login cannot be read): the agent gets a 502, and the failure is `upstream-unavailable` at the ingress with the reason; it passes the closed set', async (t) => {
  const { checkRecord } = await import('../../../../src/health/codes.mjs')
  const E = await wired(t, { routes: () => ({ 'codex.env': route({ upstream: HTTP_PROXY }) }), authOf: () => null, ownerOf: owner() })
  assert.equal(await E.agent('codex.env', privCa.certPem), 'closed', 'a 502, then nothing')
  for (let i = 0; i < 100 && E.failures.length < 1; i++) await new Promise((x) => setTimeout(x, 10))
  assert.equal(E.failures.length, 1)
  const [f] = E.failures
  assert.deepEqual([f.event, f.where, f.code, f.why], ['failure', 'ingress', 'upstream-unavailable', 'upstream-credentials-unavailable'])
  assert.match(f.reason, /prior:codex\.env/)
  assert.equal(JSON.stringify(f).includes('pw-'), false, 'no login in the record')
  assert.deepEqual(checkRecord(f), [])
  assert.equal(E.flows.length, 0, 'no flow: the connection never got an upstream')
})

test('end to end on a REAL group door (D47): the engine listens on the group\'s port, the entry\'s credentials are the door\'s own (the group id and the listener token), the wrong password is refused, and the door of an auth:false group takes none at all', async (t) => {
  const [settingsPort, desktopPort] = await new Promise((res) => {
    const a = net.createServer(); const b = net.createServer()
    a.listen(0, '127.0.0.1', () => b.listen(0, '127.0.0.1', () => {
      const pa = a.address().port; const pb = b.address().port
      a.close(() => b.close(() => res([pa, pb])))
    }))
  })
  const { r } = bed({ routes: () => ({ 'claude-code.settings': route(), 'claude-code.desktop': route() }), ingress: () => ({ ...INGRESS, groupPorts: { 'claude-code.settings': settingsPort, 'claude-code.desktop': desktopPort } }), ownerOf: ownerAlways({ pid: 40, source: 'socket-table', ms: 1 }) })
  r.watch(40, { decrypt: true, agent: 'claude-code' })
  const flows = [], envelopes = [], failures = []
  const issuer = createLeafIssuer(loadCa(privCa))
  const origin = tls.createServer({ SNICallback: (n, cb) => cb(null, issuer.secureContextFor(n)), ALPNProtocols: ['http/1.1'] }, (s) => { s.on('data', () => s.write(RESP)); s.on('error', () => {}) })
  await new Promise((res) => origin.listen(0, '127.0.0.1', res))
  const engine = createEngine({
    redirector: r, issuer: createLeafIssuer(loadCa(asightCa)), upstreamCa: privCa.certPem, ingressToken: TOKEN,
    policy: (meta) => (meta.decrypt ? true : meta.skip),
    store: { envelope: (e) => { envelopes.push(e); return true }, flow: (f) => { flows.push(structuredClone(f)); return true } }, onFailure: (f) => failures.push(f),
  })
  const { groupPorts } = await engine.listen({ groups: [
    { id: 'claude-code.settings', port: settingsPort, auth: true, token: INGRESS.listenerToken },
    { id: 'claude-code.desktop', port: desktopPort, auth: false },
  ] })
  t.after(async () => { origin.close(); await closeWithin(engine) })
  assert.deepEqual(groupPorts, { 'claude-code.settings': settingsPort, 'claude-code.desktop': desktopPort })
  const connect = (port, user, token) => within(new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1'); sock.on('error', () => resolve('refused'))
    sock.write(`CONNECT 127.0.0.1:${origin.address().port} HTTP/1.1\r\nHost: x\r\n${token ? `Proxy-Authorization: Basic ${Buffer.from(`${user}:${token}`).toString('base64')}\r\n` : ''}\r\n`)
    let b = ''; sock.on('data', (d) => { b += d.toString('latin1'); if (b.includes('\r\n\r\n')) { sock.destroy(); resolve(b.split('\r\n')[0]) } })
  }), 4000, 'the door answer', () => sock.destroy())
  assert.match(await connect(settingsPort, 'claude-code.settings', INGRESS.listenerToken), /^HTTP\/1\.1 200/, 'the entry\'s own credentials open the door')
  assert.match(await connect(settingsPort, 'claude-code.settings', 'wrong-token-1234567890'), /^HTTP\/1\.1 407/, 'the wrong password is an auth failure')
  assert.match(await connect(settingsPort, 'whoever', TOKEN), /^HTTP\/1\.1 407/, 'the engine\'s own token is not this door\'s: the door has its own')
  assert.match(await connect(desktopPort, '', null), /^HTTP\/1\.1 200/, 'the auth:false door takes no credentials at all (the desktop-launcher shape, 4.9 §6.4)')
  engine.closeGroups(['claude-code.settings'])
  assert.equal(await connect(settingsPort, 'claude-code.settings', INGRESS.listenerToken), 'refused', 'a closed door accepts nothing any more')
  assert.match(await connect(desktopPort, '', null), /^HTTP\/1\.1 200/, 'and the other doors stand')
})

// ---------- attach · detach · status (4.8 §2.1, §4.1, §4.2: the doors first, the proxy entries only after they stand; W12 order) ----------

const ROUTES = () => ({ 'claude-code.settings': route(), 'codex.env': route({ upstream: HTTP_PROXY, bypass: BYPASS }), 'deepseek-dsh.env': route({ on: false, entry: null, reason: 'desired-off' }) })
function wiredDoors(over = {}) {
  const log = []
  const d = doorsLog(log, over.doors)
  const e = entriesLog(log, over.entries)
  const r = createDarwinRedirector({ groups: GROUPS, home: HOME, factsOf: factsStore(), verdictWaitMs: 60, entries: e, doors: d, routes: ROUTES, ingress: () => INGRESS, authOf: () => CRED, gate: () => ({ ok: true }), carried: () => ['deepseek-dsh.env'], ...over.redirector }) // dsh was on once (its entries may still exist), the plan has it off: carried, so its door stays forward-only
  return { r, d, e, log }
}

test('attach(): the doors first — every group the plan has on (or carries) with a port, a supported form and an upstream, the off group included as forward-only — and the entries of the on groups only after they stand; the off groups\' are undone', async () => {
  const { r, d, e, log } = wiredDoors()
  const out = await r.attach()
  assert.equal(out.ok, true)
  assert.deepEqual(log, ['doors', 'write', 'undo'], 'the doors before the entries (the pointing itself: written before the door stands, an agent would point at a dead port), the undo last')
  assert.deepEqual(d.opened, [[
    { id: 'claude-code.settings', port: 18801, auth: true, token: '…' },
    { id: 'codex.env', port: 18802, auth: true, token: '…' },
    { id: 'deepseek-dsh.env', port: 18803, auth: true, token: '…' },
  ]], 'the on groups with the listener token, the carried off group forward-only — the token is the entries\' own password, never in the log')
  assert.deepEqual(e.written, [[{ g: 'claude-code.settings', harness: 'claude-code', entry: 'auto' }, { g: 'codex.env', harness: 'codex', entry: 'auto' }]])
  assert.deepEqual(e.undone[0].map((x) => x.g), ['deepseek-dsh.env'], 'only a group the plan names as off: one it knows nothing about keeps whatever entry it has')
  assert.deepEqual(out.entries.written.map((x) => [x.g, x.ok]), [['claude-code.settings', true], ['codex.env', true]])
})

test('audit F7 / 4.8 §3.1: a group the plan has off and nothing carries opens NO door — not on `on`, not on `detach`; `carried` is what keeps a once-on group\'s door there (the unauthenticated Claude Desktop door is the sharpest case)', async () => {
  const off = () => ({ ...ROUTES(), 'deepseek-dsh.env': route({ on: false, entry: null, reason: 'desired-off', upstream: HTTP_PROXY }) })
  const bare = wiredDoors({ redirector: { routes: off, carried: () => null } }) // the wiring said nothing: no group may stay while off
  await bare.r.attach()
  assert.deepEqual(bare.d.opened[0].map((x) => x.id), ['claude-code.settings', 'codex.env'], 'the off group\'s door is not opened at all')
  const kept = wiredDoors({ redirector: { routes: off } }) // the default of wiredDoors: dsh is carried
  await kept.r.detach()
  assert.ok(!kept.d.closed.includes('deepseek-dsh.env'), 'a carried group keeps its door forward-only when it goes off: an agent that outlives off still points at the port')
})

test('W12 a door the engine cannot bind leaves zero proxy entries: attach() rejects with the engine\'s own code, and nothing is written or undone; a crash between the doors and the entries, then `on` again, completes (the doors are idempotent, the writer is idempotent)', async () => {
  const taken = wiredDoors({ doors: { openResult: () => { throw Object.assign(new Error('the engine\'s door of claude-code.settings (port 18801) is held by another process'), { code: 'EADDRINUSE' }) } } })
  await assert.rejects(taken.r.attach(), (e) => e.code === 'EADDRINUSE')
  assert.deepEqual([taken.log, taken.e.written, taken.e.undone], [['doors'], [], []], 'no entry was written or undone')
  const crash = wiredDoors({ entries: { throwOnWrite: 1 } })
  await assert.rejects(crash.r.attach(), /crashed/)
  assert.deepEqual(crash.log, ['doors', 'write'])
  const again = await crash.r.attach()
  assert.deepEqual([crash.log.slice(2), again.ok], [['doors', 'write', 'undo'], true])
  assert.deepEqual(crash.e.written[1], crash.e.written[0], 'the same groups the first time asked for')
})

test('an entry that could not be written is that group\'s result, not an exception: the doors and the other groups are as they were, and attach() says which group and why', async () => {
  const { r, d } = wiredDoors({ entries: { writeResult: (list) => list.map((x) => (x.g === 'codex.env' ? { g: x.g, ok: false, reason: 'the file cannot be read' } : { g: x.g, ok: true })) } })
  const out = await r.attach()
  assert.equal(out.ok, false)
  assert.deepEqual(out.entries.written.map((x) => [x.g, x.ok, x.reason ?? null]), [['claude-code.settings', true, null], ['codex.env', false, 'the file cannot be read']])
  assert.deepEqual(out.doors.open, ['claude-code.settings', 'codex.env', 'deepseek-dsh.env'], 'the doors stand')
})

test('attach() with nothing planned touches neither the doors nor the entries', async () => {
  const { r, d, e, log } = wiredDoors({ redirector: { routes: () => ({}) } })
  const out = await r.attach()
  assert.deepEqual([log, d.opened, e.undone, out.ok, out.doors.open], [[], [], [], true, []])
})

test('W12 detach() is the other way: every group\'s proxy entry undone, and the doors brought to the carried set — a carried group keeps its door (forward-only), a door nobody carries is closed', async () => {
  const { r, d, e, log } = wiredDoors()
  await r.attach()
  log.length = 0
  const out = await r.detach()
  assert.deepEqual(log, ['undo', 'close'])
  assert.deepEqual(e.undone.at(-1).map((x) => x.g).sort(), ['claude-code.desktop', 'claude-code.settings', 'codex.env', 'deepseek-dsh.env', 'z-code.cli'], 'every group, planned or not: off undoes what asight wrote, and only that (the writer knows what that is)')
  assert.deepEqual(d.closed, [['claude-code.settings', 'codex.env']], 'the doors of the groups nothing carries are closed; dsh\'s (carried) stays forward-only')
  assert.deepEqual(out.doors.open, ['deepseek-dsh.env'])
  assert.equal(out.ok, true)
})

test('a door nobody carries any more is closed on attach() too: the group went off and its records went with an uninstall — an open port with nobody behind it is an opening (F7)', async () => {
  const closed = []
  const doors = { open: async (l) => l.map((x) => ({ [x.id]: x.port })), close: async (ids) => { closed.push([...ids]) } }
  let carried = ['deepseek-dsh.env']
  const r = createDarwinRedirector({ groups: GROUPS, home: HOME, factsOf: factsStore(), verdictWaitMs: 60, doors, entries: entriesLog([]), routes: ROUTES, ingress: () => INGRESS, authOf: () => CRED, gate: () => ({ ok: true }), carried: () => carried })
  const first = await r.attach()
  assert.deepEqual([first.doors.open, closed], [['claude-code.settings', 'codex.env', 'deepseek-dsh.env'], []], 'the carried off group\'s door is forward-only')
  carried = [] // the uninstall took the records: nothing carries the group any more
  const second = await r.attach()
  assert.deepEqual(closed, [['deepseek-dsh.env']], 'the door nobody carries is closed on the next plan')
  assert.deepEqual(second.doors.open, ['claude-code.settings', 'codex.env'])
})

test('status() is the doors\' read-back: attached when a group the plan has on holds its door, the links are those groups, and the entries\' own check rides along', async () => {
  const { r, d, e } = wiredDoors()
  await r.attach()
  const s = await r.status()
  assert.deepEqual([s.attached, s.links, s.hb_age_ms, s.drops], [true, [{ name: 'claude-code.settings' }, { name: 'codex.env' }], null, null])
  assert.deepEqual(e.checked[0].map((x) => [x.g, x.entry]), [['claude-code.settings', 'auto'], ['codex.env', 'auto']], 'the entries that should be there: the groups that are on')
  assert.deepEqual(s.doors, ['claude-code.settings', 'codex.env', 'deepseek-dsh.env'])
  const allOff = wiredDoors({ redirector: { routes: () => ({ 'claude-code.settings': route({ on: false, entry: null, reason: 'desired-off' }), 'codex.env': route({ on: false, entry: null, reason: 'desired-off' }), 'deepseek-dsh.env': route({ on: false, entry: null, reason: 'desired-off' }) }) } })
  await allOff.r.attach()
  assert.equal((await allOff.r.status()).attached, false, 'doors with nothing on are forward only: not attached')
})

// ---------- the gate on the entries, and the groups the plan has on that no door carries (review 2026-10-08) ----------

test('W19 gate: attach() asks `gate` for each group about to be written and does not hand a refused one to the writer — the doors are on, the refused group says why, and the others are written; without a gate attach() does not run', async () => {
  const refuse = (e) => (e.harness === 'codex' ? { ok: false, reason: 'the proxy line cannot join the trust block yet (4.8 W19)' } : { ok: true })
  const { r, e, d, log } = wiredDoors({ redirector: { gate: refuse } })
  const out = await r.attach()
  assert.deepEqual(e.written, [[{ g: 'claude-code.settings', harness: 'claude-code', entry: 'auto' }]], 'codex is not handed to the writer')
  assert.deepEqual(out.entries.written, [{ g: 'claude-code.settings', ok: true }, { g: 'codex.env', ok: false, gated: true, reason: 'the proxy line cannot join the trust block yet (4.8 W19)' }])
  assert.deepEqual([out.ok, d.opened.length, log], [false, 1, ['doors', 'write', 'undo']], 'the doors stand and `ok` says a group is not pointed at them')
  const asked = []
  const spy = wiredDoors({ redirector: { gate: (x) => { asked.push(x); return { ok: true } } } })
  await spy.r.attach()
  assert.deepEqual(asked, [{ g: 'claude-code.settings', harness: 'claude-code', entry: 'auto' }, { g: 'codex.env', harness: 'codex', entry: 'auto' }], 'asked for the groups that are on, with the entry the plan chose; not for the one that is off')
  const all = wiredDoors({ redirector: { gate: () => ({ ok: false, reason: 'closed' }) } })
  const none = await all.r.attach()
  assert.deepEqual([all.e.written, none.entries.written.map((x) => x.g), none.ok], [[], ['claude-code.settings', 'codex.env'], false], 'a gate that refuses everything: no write call at all')
  const thrown = wiredDoors({ redirector: { gate: () => { throw new Error('the journal cannot join a block') } } })
  const tt = await thrown.r.attach()
  assert.deepEqual([thrown.e.written, tt.ok, /the journal cannot join a block/.test(tt.entries.written[0].reason)], [[], false, true], 'a gate that throws is a refusal, never a write')
  const bare = wiredDoors({ redirector: { gate: undefined } })
  await assert.rejects(bare.r.attach(), /needs the gate/)
  assert.deepEqual(bare.log, [], 'neither a door nor an entry was touched: the wiring has to say which groups may be written')
})

test('D38 a group the plan has on that no door carries is said, not skipped: `entries.skipped` names it with why, `ok` is false, the others are as they were — no port, no supported form, no upstream, a login on a door that takes none', async () => {
  const one = (over) => wiredDoors({ redirector: over })
  const noPort = one({ ingress: () => ({ ...INGRESS, groupPorts: { 'codex.env': 18802 } }) })
  const a = await noPort.r.attach()
  assert.deepEqual([a.ok, a.entries.skipped], [false, [{ g: 'claude-code.settings', reason: 'no-port' }]])
  assert.deepEqual(noPort.e.written[0].map((x) => x.g), ['codex.env'], 'the carried group is written; the one no door carries is not asked of the writer')
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

// ---------- directCount · what this file may touch ----------

test('directCount(pid): the process\'s established connections that are not to a group\'s door on loopback, read from lsof through the injected runner; a table that cannot be read is null and why, never 0', async () => {
  const table = [
    'p10', 'cnode',
    'n127.0.0.1:50000->127.0.0.1:18801',
    'n127.0.0.1:50001->104.18.0.1:443',
    'n127.0.0.1:50002->127.0.0.1:7897',
    'n[::1]:50003->[::1]:18802',
    'n*:7890',
    'p11', 'cnode',
    'n127.0.0.1:50005->1.1.1.1:443',
  ].join('\n')
  const calls = []
  let answer = { code: 0, out: table, err: '' }
  const exec = async (file, args, opts) => { calls.push([file, args, opts]); if (answer instanceof Error) throw answer; return answer && { ...answer } }
  const { r } = made({ exec, ingress: () => INGRESS })
  assert.deepEqual(await r.directCount(10), { count: 2, error: null }, 'the one to the internet and the one to a local proxy; not the two to asight\'s doors, not the listening socket, not another process\'s')
  assert.deepEqual(calls[0], ['lsof', ['-nP', '-Fpcn', '-iTCP', '-sTCP:ESTABLISHED'], { timeoutMs: 2000 }])
  answer = new Error('the lsof read died'); answer.code = 'exec-down'
  assert.deepEqual(await r.directCount(10), { count: null, error: 'exec-down' })
  answer = { code: null, out: '', err: '' }
  assert.deepEqual(await r.directCount(10), { count: null, error: 'lsof-timeout' }, 'a read killed at its timeout is unknown, never 0')
  answer = null
  assert.deepEqual(await r.directCount(10), { count: null, error: 'no-rows' })
  assert.deepEqual(await made({}).r.directCount(10), { count: null, error: 'no-exec' }, 'no runner injected: unknown is said, never guessed (D-17)')
})

// ---------- the Redirector contract the callers hold it to ----------

test('the darwin redirector has every call the daemon, the tracker and the switch make on a Redirector (core/redirector.mjs): one it lacks is a TypeError at the first `on`, and a method the daemon calls only behind a `typeof` guard is optional', async () => {
  const fs = await import('node:fs')
  const strip = (f) => fs.readFileSync(new URL(`../../../../src/collector/${f}`, import.meta.url), 'utf8').replace(/\/\*[^]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')
  const sources = ['daemon.mjs', 'core/tracker.mjs', 'core/switch.mjs'].map(strip)
  const called = new Set(sources.flatMap((code) => [...code.matchAll(/\bredirector\.([A-Za-z]+)/g)].map((m) => m[1])))
  const guarded = (name) => sources.some((code) => code.includes(`typeof redirector.${name}`))
  // what darwin does not have, and why: the daemon opens no transparent listener there either (4.9 §0: proxy mode only), so the engine never calls `lookup`; `darwin` is not a method
  // at all but the bag the WIRING adds after construction (osMatch, replan, the doors' binding — 4.9 §1 接线), which daemon.mjs loadParts reads behind a truthiness guard.
  const NOT_ON_DARWIN = {
    lookup: 'darwin has no transparent rewrite (4.9 §0: proxy mode is the only mode on macOS): the daemon opens no transparent listener there',
    darwin: 'the bag the wiring (arch/darwin/wiring.mjs) hangs on the built redirector after construction — createDarwinRedirector itself gives none, and loadParts reads it behind `redirector.darwin &&`',
  }
  const { r } = made({})
  const missing = [...called].filter((name) => !guarded(name) && !(name in r) && !(name in NOT_ON_DARWIN))
  assert.deepEqual(missing, [], `the callers need ${missing.join(', ')} of a Redirector and createDarwinRedirector gives none`)
  for (const name of Object.keys(NOT_ON_DARWIN)) assert.ok(called.has(name) && !(name in r), `${name} is still called and still absent on darwin: ${NOT_ON_DARWIN[name]}`)
  for (const name of ['configure', 'directCount']) assert.ok(called.has(name) && typeof r[name] === 'function', `the two calls the review found missing or synchronous: ${name}`)
  assert.equal(await r.configure(18790), undefined, 'configure is accepted and tells the engine nothing: the doors\' ports come from ingress.json')
  assert.ok(called.has('setBeatGate') && typeof r.setBeatGate === 'function', 'the daemon sets the beat gate (1.6 §1.5) on any redirector')
  assert.equal(r.setBeatGate(() => false), undefined, 'and a redirector with no heartbeat accepts it and gates nothing')
})

test('what the redirector may do (static): it imports only the modules that match and plan, opens no socket, runs nothing, writes no file, names no harness, and the user\'s login is read in one place', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../../../../src/collector/arch/darwin/redirector.mjs', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[^]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')
  const imports = [...code.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort()
  assert.deepEqual(imports, ['../../core/engine/door-redirector.mjs', './forms.mjs'], 'the door core (the win32 twin closed 4.9 OPEN 9: both arches dress ONE shared core) and darwin\'s forms; no rules.mjs (gone with the kernel, D47), no helper (none on darwin, 4.9 §1)')
  assert.equal(/\b(writeFile\w*|appendFile\w*|mkdir\w*|rename\w*|unlink\w*|rmSync|spawn\w*|execFile\w*|execSync|fork|createServer|fetch|child_process|process\.platform|reg add|setx)\b|\.connect\(/.test(code), false, 'no write, no process, no socket, no platform branch')
  assert.equal(/\b(claude|codex|opencode|kimi|dsh|deepseek|hermes|zcode|z-code)\b/i.test(code), false, 'arch names no harness: the groups it is given say it')
  assert.equal([...code.matchAll(/authOf\(|loginOf\(/g)].length, 0, 'the adapter itself holds no reference to a login: the one place a proxy reference is turned into a login (the core\'s loginOf) lives in the shared door core, out of every adapter')
})
