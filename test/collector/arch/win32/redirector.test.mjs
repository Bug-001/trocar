// test/collector/arch/win32/redirector.test.mjs — the Windows Redirector adapter over the SHARED door core (RFC 4.8 §1 contract, §5.2 lookupIngress, §5.4 trust; acceptance W12, W16, W72).
// Nothing here runs Windows: the helper is an object with a `call` (its answers are shaped as the real one gives them), the doors are a recorder the daemon's
// binding would have filled, the entries writer is a recorder. The harness files' real Windows data is used for the forms (arch/ never imports harness/;
// a test may, to pin the rule to the real data), so a form whose path or command line is changed in the data changes what this file sees.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createWin32Redirector } from '../../../../src/collector/arch/win32/redirector.mjs'
import { ownerOfSocket } from '../../../../src/collector/arch/win32/socktable.mjs'
import { factsOfPid } from '../../../../src/collector/arch/win32/procinfo.mjs'
import { HELPER_PROTO } from '../../../../src/collector/arch/win32/helper.mjs'
import { groupsOf } from '../../../../src/collector/arch/win32/route-plan.mjs'
import claudeCode from '../../../../src/collector/harness/win32/claude-code.mjs'
import codex from '../../../../src/collector/harness/win32/codex.mjs'
import deepseekDsh from '../../../../src/collector/harness/win32/deepseek-dsh.mjs'
import zCode from '../../../../src/collector/harness/win32/z-code.mjs'
import kimiCode from '../../../../src/collector/harness/win32/kimi-code.mjs'

const GROUPS = groupsOf([{ name: 'claude-code', win32: claudeCode }, { name: 'codex', win32: codex }, { name: 'deepseek-dsh', win32: deepseekDsh }, { name: 'z-code', win32: zCode }, { name: 'kimi-code', win32: kimiCode }])
const HOME = String.raw`C:\Users\u`
const IMG = {
  ccCli: String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`,
  codexApp: String.raw`C:\Users\u\AppData\Local\OpenAI\Codex\bin\0123456789abcdef\codex.exe`,
  node: String.raw`C:\Program Files\nodejs\node.exe`,
  code: String.raw`C:\Program Files\Microsoft VS Code\Code.exe`,
}
const PORTS = { 'claude-code.settings': 17991, 'codex.env': 17992, 'deepseek-dsh.env': 17993, 'z-code.cli': 17994, 'z-code.desktop': 17995, 'kimi-code.vscode': 17996 }
const ING = { enginePort: 17990, groupPorts: PORTS, ingressToken: 'i'.repeat(32), listenerToken: 's3-listener-token' }
const DIRECT = { kind: 'direct' }

/** A helper whose ps and tcp-table answers are whatever the ask needs (the two verbs the door backends use). */
function helperOf({ procs = [], tcp = [] } = {}) {
  const asked = []
  return {
    asked,
    ready: Promise.resolve({ ready: true, proto: HELPER_PROTO, pid: 77, ps: '5.1', native: true }),
    pid: 77,
    call: async (verb, args = {}) => {
      asked.push([verb, args])
      if (verb === 'ps') return { sessionId: 1, procs }
      if (verb === 'tcp-table') return { rows: tcp.filter((r) => !args.states || args.states.includes(r.state)) }
      throw new Error(`not in the fake: ${verb}`)
    },
    close: async () => {},
  }
}
/** The row the helper's ps would answer for a process of `exe`. */
const psRow = (pid, exe, cmdline = null, over = {}) => ({ pid, ppid: 1, name: path.win32.basename(exe), exe, cmdline, startedAt: 1760000000000 + pid, sessionId: 1, integrity: 'medium', tokenDenied: false, cmdlineState: cmdline != null ? 'ok' : 'empty', ...over })
/** The established row whose local end is the peer the engine accepted. */
const peerRow = (pid, port) => ({ pid, state: 'established', family: 4, localAddr: '127.0.0.1', localPort: port, remoteAddr: '127.0.0.1', remotePort: 17991 })
/** The doors the daemon would bind to the engine: a recorder. */
const doorsOf = () => {
  const log = []
  const open = new Set()
  return { log, open: async (list) => { log.push(['open', list]); for (const g of list) open.add(g.id) }, close: async (ids) => { log.push(['close', ids]); for (const g of ids) open.delete(g) }, isOpen: (g) => open.has(g) }
}
/** The entries writer: a recorder (W19's gate is the wiring's, tested in wiring.test.mjs). */
const entriesOf = () => {
  const log = []
  return { log, write: async (list) => { for (const e of list) log.push(['write', e]); return list.map((e) => ({ g: e.g, ok: true })) }, undo: async (list) => { for (const e of list) log.push(['undo', e]); return list.map((e) => ({ g: e.g, ok: true })) }, check: async () => [] }
}
/** A route table the plan would answer: every group on with a direct upstream unless said otherwise. */
const routesOf = (over = {}) => Object.fromEntries(Object.keys(PORTS).map((g) => [g, over[g] ?? { g, entry: 'auto', on: true, upstream: { kind: 'direct', source: 'direct' }, bypass: [] }]))

/** The construction under test: the REAL backends (socktable, procinfo) bound to the fake helper, so the adapter is exercised end to end. */
const makeRedirector = ({ helper, routes = routesOf(), doors = doorsOf(), entries = entriesOf(), gate = () => ({ ok: true }), carried = () => [], hostsOf = () => null, verdictWaitMs = 60 } = {}) => createWin32Redirector({
  helper, groups: GROUPS, home: HOME,
  ownerOf: (q) => ownerOfSocket({ helper, peer: q.peer }),
  factsOf: (pid) => factsOfPid(pid, { helper }),
  routes: () => routes, ingress: () => ING, doors, entries, gate, carried, hostsOf, verdictWaitMs,
})
const CC = { peer: { address: '127.0.0.1', port: 5010 }, user: 'claude-code.settings', target: { address: 'api.anthropic.com', port: 443 } }

test('W16 the adapter\'s shape: start() waits for the helper\'s ready line and answers it; helperInfo and expectedProto say the helper; directCount is the adapter\'s own', async () => {
  const helper = helperOf()
  const r = makeRedirector({ helper })
  assert.deepEqual(await r.start(), { pid: 77, proto: HELPER_PROTO, build: '5.1' })
  assert.deepEqual(r.helperInfo(), { pid: 77, proto: HELPER_PROTO, build: '5.1' })
  assert.equal(r.expectedProto, HELPER_PROTO)
  await r.close()
  assert.equal(r.directCount(11).constructor, Promise, 'directCount reads the helper\'s table: a promise the caller awaits')
})

test('W16 lookupIngress: the door\'s group is the user — identity comes from the socket (one targeted tcp-table by local port, one ps ask per pid life)', async () => {
  const helper = helperOf({ procs: [psRow(4121, IMG.ccCli, 'claude')], tcp: [peerRow(4121, 5010)] })
  const r = makeRedirector({ helper })
  const meta = await r.lookupIngress(CC)
  assert.deepEqual([meta.agent, meta.pid, meta.exe, meta.form, meta.capture, meta.pid_source, meta.negKey], ['claude-code', 4121, IMG.ccCli, 'claude-code.cli', 'proxy', 'socket-table', '4121'])
  assert.equal(meta.decrypt, false, 'nobody pushed a verdict: not trusted, fail-safe')
  assert.equal(meta.skip, undefined, 'the form is this door\'s own: the engine\'s policy arm says the why of an untrusted form, not the table\'s untracked code')
  assert.deepEqual(meta.upstream, DIRECT)
  assert.equal(typeof meta.pid_ms, 'number')
  assert.deepEqual(helper.asked.map(([v, a]) => [v, a.localPort ?? null]), [['tcp-table', 5010], ['ps', null]], 'exactly the two targeted asks')
  r.watch(4121, { decrypt: true, agent: 'claude-code' })
  helper.asked.length = 0
  const again = await r.lookupIngress(CC)
  assert.equal(again.decrypt, true)
  assert.equal(again.skip, undefined)
  assert.deepEqual(helper.asked, [['tcp-table', { localPort: 5010, states: ['established'] }], ['ps', {}]], 'the two targeted asks again: the answer is what THIS connection\'s process is, never a cached row (a wrong pid must never happen, 4.8 W4)')
  r.unwatch(4121)
})

test('W16 lookupIngress: a process of another group\'s form at this door is forwarded untracked (the open door\'s security arm); no pid at all is untracked too', async () => {
  const helper = helperOf({ procs: [psRow(4121, IMG.codexApp, 'codex')], tcp: [peerRow(4121, 5010)] })
  const r = makeRedirector({ helper })
  const m = await r.lookupIngress(CC)
  assert.deepEqual([m.skip.not_captured, m.skip.reason], ['untracked', 'not-a-process-of-form'], 'codex.exe at the claude door: forwarded')
  const none = helperOf({ procs: [psRow(4121, IMG.ccCli, 'claude')], tcp: [] })
  const r2 = makeRedirector({ helper: none })
  const m2 = await r2.lookupIngress(CC)
  assert.equal(m2.pid, null)
  assert.deepEqual([m2.skip.not_captured, m2.skip.reason], ['untracked', 'pid-unresolved'])
})

test('W16 lookupIngress: the group the plan has off serves an arriving agent (the plan flipped before the doors followed) — a spliced meta with the group\'s upstream, no identity asked', async () => {
  const helper = helperOf({ procs: [psRow(4121, IMG.ccCli, 'claude')], tcp: [peerRow(4121, 5010)] })
  const routes = routesOf()
  routes['claude-code.settings'] = { g: 'claude-code.settings', entry: null, on: false, reason: 'desired-off', upstream: { kind: 'http', host: 'proxy.corp', port: 8080, source: 'agent' }, bypass: [] }
  const r = makeRedirector({ helper, routes })
  const m = await r.lookupIngress(CC)
  assert.deepEqual([m.pid, m.form, m.exe], [null, null, null])
  assert.deepEqual(m.upstream, { kind: 'http', host: 'proxy.corp', port: 8080 })
  assert.deepEqual([m.skip.not_captured, m.skip.reason], ['untracked', 'group-off'])
  assert.equal(m.negKey, 'claude-code.settings')
  assert.deepEqual(helper.asked, [], 'no identity question: nothing is asked for a connection that is only forwarded')
  routes['claude-code.settings'].upstream = null
  assert.equal(await r.lookupIngress(CC), null, 'a group with nothing to serve it with is refused')
})

test('W72 lookupIngress: a CONNECT target that hits the group\'s bypass table goes direct; the rest get the group\'s upstream with its login, resolved for this one connection', async () => {
  const helper = helperOf({ procs: [psRow(4121, IMG.ccCli, 'claude')], tcp: [peerRow(4121, 5010)] })
  const routes = routesOf()
  routes['claude-code.settings'] = { g: 'claude-code.settings', entry: 'auto', on: true, upstream: { kind: 'http', host: 'proxy.corp', port: 8080, credentialed: true, auth_ref: 'prior:claude-code.settings', source: 'agent' }, bypass: [{ kind: 'domain-suffix', value: 'corp.example' }] }
  const r = makeRedirector({ helper, routes, gate: () => ({ ok: true }) })
  const r2 = makeRedirector({ helper, routes, gate: () => ({ ok: true }) })
  const hit = await makeRedirector({ helper, routes }).lookupIngress({ peer: CC.peer, user: CC.user, target: { address: 'intranet.corp.example', port: 443 } })
  assert.deepEqual(hit.upstream, { kind: 'direct' }, 'the bypass row: the target went direct, as the agent\'s own proxy setting would have')
  const r3 = makeRedirector({ helper, routes })
  r3.authOf = () => ({ username: 'u', password: 'p' })
  // the authOf of the wiring is not on the adapter's surface: re-make with the real construction and a route whose login resolves
  const withAuth = createWin32Redirector({
    helper, groups: GROUPS, home: HOME,
    ownerOf: (q) => ownerOfSocket({ helper, peer: q.peer }),
    factsOf: (pid) => factsOfPid(pid, { helper }),
    routes: () => routes, ingress: () => ING, doors: doorsOf(), entries: entriesOf(), gate: () => ({ ok: true }),
    authOf: () => ({ username: 'u', password: 'p' }), verdictWaitMs: 30,
  })
  const miss = await withAuth.lookupIngress(CC)
  assert.deepEqual(miss.upstream, { kind: 'http', host: 'proxy.corp', port: 8080, auth: { username: 'u', password: 'p' } })
  assert.ok(r2 && r, 'unused')
})

test('W16 a group the plan has no answer for, an unknown user, a target that is the door itself: null (the ingress answers an auth failure / closes)', async () => {
  const helper = helperOf()
  const r = makeRedirector({ helper, routes: {} })
  assert.equal(await r.lookupIngress(CC), null, 'no plan answer yet')
  const r2 = makeRedirector({ helper })
  assert.equal(await r2.lookupIngress({ peer: CC.peer, user: 'of.nobody', target: CC.target }), null, 'the kernel\'s of.<form> users are gone: a door is named by its group')
  assert.equal(await r2.lookupIngress({ peer: CC.peer, user: CC.user, target: { address: '127.0.0.1', port: 17991 } }), null, 'a CONNECT at the door\'s own address is a loop through the door, not a flow')
  assert.equal(await r2.lookupIngress({ peer: CC.peer, user: CC.user, target: { address: 'localhost', port: 17991 } }), null, 'the name spelling of the same loop')
})

test('W69 the host-tree arm: a form that declares hosts decrypts only the connections to its applied set (the door holds the arm the kernel\'s per-host rules used to hold)', async () => {
  const helper = helperOf({ procs: [psRow(8100, IMG.code, 'code')], tcp: [peerRow(8100, 5010)] })
  const routes = routesOf({ 'kimi-code.vscode': { g: 'kimi-code.vscode', entry: 'opt-in', on: true, upstream: { kind: 'direct', source: 'direct' }, bypass: [] } })
  const r = makeRedirector({ helper, routes, hostsOf: () => ['api.kimi.com', 'relay.corp.example'] })
  const K = { peer: { address: '127.0.0.1', port: 5010 }, user: 'kimi-code.vscode' }
  const inSet = await r.lookupIngress({ ...K, target: { address: 'api.kimi.com', port: 443 } })
  assert.equal(inSet.form, 'kimi-code.vscode', 'a target on the set: the form\'s connection (trusted verdicts aside)')
  const sub = await r.lookupIngress({ ...K, target: { address: 'eu.api.kimi.com', port: 443 } })
  assert.equal(sub.form, 'kimi-code.vscode', 'a subdomain of a set entry is on the set')
  const out = await r.lookupIngress({ ...K, target: { address: 'marketplace.visualstudio.com', port: 443 } })
  assert.deepEqual([out.form, out.skip?.reason, out.decrypt], [null, 'outside-host-set', false], 'the host program\'s other connections are forwarded, untracked')
})

test('W12 attach(): the doors first (carried included), then the on groups\' entries; the gate refuses a group without writing it; the off group is undone; a group the plan has on with nothing to carry it is said', async () => {
  const helper = helperOf()
  const routes = routesOf()
  routes['z-code.desktop'] = { g: 'z-code.desktop', entry: null, on: false, reason: 'opt-in-needed', upstream: { kind: 'direct', source: 'direct' }, bypass: [] }
  routes['codex.env'].upstream = null
  const doors = doorsOf()
  const entries = entriesOf()
  const gate = (e) => (e.g === 'z-code.cli' ? { ok: false, reason: 'the gate says no' } : { ok: true })
  const r = makeRedirector({ helper, routes, doors, entries, gate, carried: () => ['z-code.desktop'] })
  const res = await r.attach()
  assert.equal(res.ok, false, 'the gated group and the skipped group each say so')
  const opened = doors.log[0][1].map((g) => g.id).sort()
  assert.deepEqual(opened, ['claude-code.settings', 'deepseek-dsh.env', 'kimi-code.vscode', 'z-code.cli', 'z-code.desktop'].sort(), 'codex.env has no upstream: no door; z-code.desktop is carried while off')
  assert.deepEqual(doors.log[0][1].find((g) => g.id === 'z-code.desktop'), { id: 'z-code.desktop', port: 17995, auth: true, token: ING.listenerToken }, 'the door half takes no on flag (on/off is the plan\'s and the entries\' business); its token is the listener token the entry writes')
  const wrote = entries.log.filter(([op]) => op === 'write').map(([, e]) => e.g).sort()
  assert.deepEqual(wrote, ['claude-code.settings', 'deepseek-dsh.env', 'kimi-code.vscode'].sort(), 'the on groups with a door the gate allowed')
  assert.deepEqual(entries.log.filter(([op]) => op === 'undo').map(([, e]) => e.g), ['z-code.desktop'], 'the off group is undone (the planned or not: the writer undoes only what asight wrote)')
  assert.deepEqual(res.entries.skipped, [{ g: 'codex.env', reason: 'no-upstream' }], 'said, never silent (D38)')
  const gated = res.entries.written.find((x) => x.g === 'z-code.cli')
  assert.deepEqual([gated.g, gated.ok, gated.gated, gated.reason], ['z-code.cli', false, true, 'the gate says no'])
  doors.log.length = 0
  entries.log.length = 0
  await r.attach()
  assert.equal(doors.log.length, 1, 'the doors half is asked again (idempotent per group in the engine)')
  assert.ok(entries.log.some(([op, e]) => op === 'write' && e.g === 'claude-code.settings'))
})

test('W12 detach(): every entry undone, the doors brought to the carried set — a carried door stays (forward-only), a door nobody carries is closed', async () => {
  const helper = helperOf()
  const doors = doorsOf()
  const entries = entriesOf()
  const r = makeRedirector({ helper, routes: routesOf(), doors, entries, carried: () => ['claude-code.settings'] })
  await r.attach()
  doors.log.length = 0
  entries.log.length = 0
  const res = await r.detach()
  assert.equal(res.ok, true)
  assert.deepEqual([...new Set(entries.log.map(([op]) => op))], ['undo'], 'every group\'s entry is undone')
  const closed = doors.log[0][1]
  assert.ok(closed.includes('codex.env') && closed.includes('z-code.desktop') && !closed.includes('claude-code.settings'), `the carried door stays, the others close: ${JSON.stringify(closed)}`)
})

test('W16 status(): attached = at least one on group has its door; links name the door groups', async () => {
  const helper = helperOf()
  const doors = doorsOf()
  const r = makeRedirector({ helper, routes: routesOf(), doors })
  assert.equal((await r.status()).attached, false, 'nothing attached yet')
  await r.attach()
  const st = await r.status()
  assert.equal(st.attached, true)
  assert.deepEqual(st.links.map((l) => l.name).sort(), Object.keys(PORTS).sort())
  assert.deepEqual([st.hb_age_ms, st.drops], [null, null])
})

test('W16 the verdict seam: a pid met at a door is announced as exec, the lookup waits for the tracker\'s watch; a verdict that never comes is a tombstone (one wait per life), a late watch overwrites it', async () => {
  const helper = helperOf({ procs: [psRow(4121, IMG.ccCli, 'claude')], tcp: [peerRow(4121, 5010)] })
  const r = makeRedirector({ helper, verdictWaitMs: 40 })
  const met = []
  r.on('exec', (facts) => met.push(facts.pid))
  const asked = r.lookupIngress(CC)
  await new Promise((res) => setTimeout(res, 10))
  assert.deepEqual(met, [4121], 'the tracker was told the pid the door met')
  const m = await asked
  assert.equal(m.decrypt, false, 'no verdict arrived in time: a tombstone, not a hang')
  r.watch(4121, { decrypt: true, agent: 'claude-code' })
  const again = await r.lookupIngress(CC)
  assert.equal(again.decrypt, true)
  assert.deepEqual(met, [4121], 'the announce happens once per life, not per connection')
})

test('W4/directCount: the helper\'s established rows that do not go to a group\'s door; unreadable is count:null with the reason, never 0', async () => {
  const helper = helperOf({ tcp: [
    { pid: 4121, state: 'established', family: 4, localAddr: '127.0.0.1', localPort: 5010, remoteAddr: '127.0.0.1', remotePort: 17991 },
    { pid: 4121, state: 'established', family: 4, localAddr: '127.0.0.1', localPort: 5011, remoteAddr: '93.1.1.1', remotePort: 443 },
    { pid: 4121, state: 'established', family: 6, localAddr: '::1', localPort: 5012, remoteAddr: '2001:db8::1', remotePort: 443 },
  ] })
  const r = makeRedirector({ helper })
  assert.deepEqual(await r.directCount(4121), { count: 2, error: null })
  const dead = helperOf()
  dead.call = async () => { throw Object.assign(new Error('helper is down'), { code: 'helper-down' }) }
  const r2 = makeRedirector({ helper: dead })
  const d = await r2.directCount(4121)
  assert.equal(d.count, null)
  assert.equal(d.error, 'helper-down')
})

test('W16 scan() and procs(): the table is what connections taught — the pids the doors met, as facts; nothing is swept', async () => {
  const helper = helperOf({ procs: [psRow(4121, IMG.ccCli, 'claude'), psRow(9, IMG.node, 'node dsh')], tcp: [peerRow(4121, 5010)] })
  const r = makeRedirector({ helper })
  await r.lookupIngress(CC)
  const scan = await r.scan()
  assert.deepEqual(scan.map((f) => f.pid), [4121], 'the pid the door met is in the table; pid 9 never connected and is not')
  assert.equal(scan[0].source, 'accept')
  assert.deepEqual(r.procs().map((p) => p.pid), [4121])
  assert.deepEqual(r.unreadable(), [])
})

test('what the redirector may do (static): it imports only the door core, its forms and the helper contract — no engine, no harness, no plan module, opens no socket, names no harness', () => {
  const src = fs.readFileSync(new URL('../../../../src/collector/arch/win32/redirector.mjs', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/^import .*?from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['../../core/engine/door-redirector.mjs', './helper.mjs', './forms.mjs'])
  assert.ok(!/require\(|node:net|createServer|spawn\(/.test(src), 'no socket, no process, no file: the doors are the engine\'s, the helper the wiring\'s')
  for (const h of ['claude-code', 'codex', 'hermes', 'kimi-code', 'opencode', 'deepseek-dsh', 'z-code']) assert.ok(!src.includes(h), `names no harness: ${h}`)
})

test('the door core is OS-neutral (static): no platform branch in core/engine/door-redirector.mjs, and both arch adapters dress the same core', () => {
  const core = fs.readFileSync(new URL('../../../../src/collector/core/engine/door-redirector.mjs', import.meta.url), 'utf8')
  const code = core.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n') // comments may name the arches; code may not
  for (const os of ['win32', 'darwin', 'linux', 'process.platform']) assert.ok(!code.includes(os), `the core names no platform: ${os}`)
  const darwin = fs.readFileSync(new URL('../../../../src/collector/arch/darwin/redirector.mjs', import.meta.url), 'utf8')
  assert.ok(darwin.includes('createDoorRedirector'), 'the darwin twin dresses the same core')
  assert.ok(darwin.length < 8000, `the adapter stays thin (${darwin.length} bytes)`)
})
