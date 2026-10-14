// test/collector/core/door-identity.test.mjs — the door asks the D51 name list who a process is (RFC 4.8 §5.3, 4.9 §5.3, 4.6 §识别进程 R7): the order
// pid → facts → this user → host tree → name list → desired state → the tracker's verdict, and what each step leaves on the row (`skip`), on `agent` /
// `door`, and as events (`exec` to the tracker, `process-unknown` to the recorder). The facts are real-shaped (0.1 §3 convention 3): darwin's come out
// of procinfo's factsOfPid fed recorded `ps` / `lsof` output through an injected runner, win32's out of factsOfRow fed helper `ps` rows. The name list
// is the real one (createRegistry over the real descriptors), the same function the tracker judges by.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createDoorRedirector } from '../../../src/collector/core/engine/door-redirector.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'
import { createTracker } from '../../../src/collector/core/tracker.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { groupsOf as darwinGroupsOf } from '../../../src/collector/arch/darwin/route-plan.mjs'
import { groupsOf as win32GroupsOf } from '../../../src/collector/arch/win32/route-plan.mjs'
import { factsOfPid } from '../../../src/collector/arch/darwin/procinfo.mjs'
import { factsOfRow } from '../../../src/collector/arch/win32/procinfo.mjs'
import { checkRecord, UNTRACKED_REASONS } from '../../../src/health/codes.mjs'
import { createEngine } from '../../../src/collector/core/engine/engine.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { within, closeWithin } from '../../helpers/bounded.mjs'

const ALL = await loadHarnesses()
const REG = createRegistry(ALL)
const W = String.raw`C:\Users\u`
const OWN_UID = 501

/** darwin's targeted facts, as procinfo gives them: one `ps -p` row and one `lsof -p -Fn` txt record, recorded shapes, through the injected runner. */
function darwinFacts(pid, { exe, cmdline, uid = OWN_UID }) {
  const exec = (file) => {
    if (file === 'ps') return { status: 0, stdout: `${pid}     1   ${uid} ${cmdline.split(' ')[0]}  Tue Oct 14 10:00:0${pid % 10} 2026     ${cmdline}\n`, stderr: '' }
    if (file === 'lsof') return { status: 0, stdout: `p${pid}\nfcwd\nn/Users/u\nftxt\nn${exe}\nftxt\nn/usr/lib/dyld\n`, stderr: '' }
    return { status: 1, stdout: '', stderr: 'not in the fake' }
  }
  return factsOfPid(pid, { exec, env: {} })
}
/** win32's targeted facts, as procinfo gives them from the helper's `ps` row. */
const winRow = (pid, exe, cmdline, over = {}) => ({ pid, ppid: 1, name: exe.split('\\').pop(), exe, cmdline, startedAt: 1760000000000 + pid, sessionId: 1, integrity: 'medium', tokenDenied: false, ...over })
const win32Facts = (row) => factsOfRow(row)

const ROUTE = { entry: 'auto', on: true, upstream: { kind: 'direct', source: 'direct' }, bypass: [] }
const target = (address = 'api.anthropic.com') => ({ address, port: 443 })

/** A door core over the given OS's real groups, every group on, the peer owned by whatever pid `owner.pid` says, the facts from `store`. */
function door(os, { store = new Map(), identify = REG.match, isOn = () => true, ownUid = OWN_UID, routes = null, hostsOf = () => null, verdictWaitMs = 60 } = {}) {
  const groups = os === 'darwin' ? darwinGroupsOf(ALL) : win32GroupsOf(ALL)
  const owner = { pid: null }
  const events = []
  const execs = []
  const r = createDoorRedirector({
    groups, identify, isOn, ownUid, hostsOf, verdictWaitMs,
    ownerOf: async () => ({ pid: owner.pid, source: 'socket-table', ms: 1 }),
    factsOf: (pid) => (store.has(pid) ? store.get(pid) : null),
    routes: () => routes || Object.fromEntries(groups.map((x) => [x.g, { g: x.g, ...ROUTE }])),
    ingress: () => ({ enginePort: 18790, groupPorts: Object.fromEntries(groups.map((x, i) => [x.g, 18800 + i])), ingressToken: 'a'.repeat(32), listenerToken: 'b'.repeat(32) }),
    onEvent: (e) => events.push(e), directCount: async () => ({ count: 0, error: null }),
  })
  r.on('exec', (f) => execs.push(f))
  const ask = async (pid, user, t = target()) => { owner.pid = pid; return r.lookupIngress({ peer: { address: '127.0.0.1', port: 50000 + (pid || 0) }, user, target: t }) }
  return { r, store, events, execs, ask, owner }
}

test('the door needs identify and isOn: who a process is and whether its harness is on have no default answer', () => {
  const groups = darwinGroupsOf(ALL)
  assert.throws(() => createDoorRedirector({ groups, isOn: () => true, directCount: async () => ({}) }), /identify/)
  assert.throws(() => createDoorRedirector({ groups, identify: REG.match, directCount: async () => ({}) }), /isOn/)
})

test('W76 one rule: the facts the door met are judged by the tracker with the same name list — the harness on the row is the harness of the verdict (darwin and win32 shapes)', async () => {
  const cases = [
    ['darwin', 'claude-code.settings', darwinFacts(11, { exe: '/Users/u/.local/share/claude/versions/2.1.296', cmdline: 'claude -p hi' }), 'claude-code'],
    ['darwin', 'z-code.cli', darwinFacts(12, { exe: '/Applications/ZCode.app/Contents/MacOS/ZCode', cmdline: 'zcode-cli' }), 'z-code'],
    ['win32', 'deepseek-dsh.env', win32Facts(winRow(13, String.raw`C:\Program Files\nodejs\node.exe`, `"C:\\Program Files\\nodejs\\node.exe" ${W}\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`)), 'deepseek-dsh'],
  ]
  for (const [os, user, facts, harness] of cases) {
    const d = door(os, { store: new Map([[facts.pid, facts]]) })
    const tracker = createTracker({ redirector: d.r, registry: REG, trust: { check: () => ({ trusted: false, reason: 'var-missing', var: null, via: null }) }, home: '/nonexistent', alive: () => true, readFile: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) } })
    tracker.start()
    const m = await d.ask(facts.pid, user)
    assert.equal(REG.match(facts).agent, harness, `${os} ${facts.exe}: the name list names ${harness}`)
    assert.deepEqual([m.agent, m.door, m.decrypt, m.skip, 'form' in m], [harness, user, false, undefined, false], `${os}: the row names the list's harness and the door; no form any more`)
    assert.equal(d.r.verdictOf(facts.pid).agent, harness, `${os}: the tracker judged the same facts as the same harness`)
    tracker.stop?.()
  }
})

test('W78 a win32 command line still pending is `cmdline-pending`, not cached anywhere: the same pid\'s next connection, its command line arrived, is dsh and goes to the verdict', async () => {
  const node = String.raw`C:\Program Files\nodejs\node.exe`
  const d = door('win32')
  d.store.set(21, win32Facts(winRow(21, node, null, { cmdlineState: 'pending' })))
  const first = await d.ask(21, 'deepseek-dsh.env')
  assert.deepEqual([first.agent, first.skip], ['deepseek-dsh', { not_captured: 'untracked', reason: 'cmdline-pending' }], 'pending: forwarded, never guessed')
  assert.deepEqual([d.events, d.execs, d.r.verdictOf(21)], [[], [], null], 'no process-unknown, nothing told to the tracker, no verdict row')
  d.store.set(21, win32Facts(winRow(21, node, `node ${W}\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`)))
  d.r.on('exec', (f) => d.r.watch(f.pid, { decrypt: true, agent: 'deepseek-dsh' }))
  const next = await d.ask(21, 'deepseek-dsh.env')
  assert.deepEqual([next.agent, next.decrypt, next.skip], ['deepseek-dsh', true, undefined], 'the next connection asks again and is judged')
  assert.deepEqual(d.execs.map((f) => f.pid), [21])
})

test('W79 an agent on the list at another harness\'s door is its own harness (D51⑥): codex at the claude door is codex, judged by codex\'s verdict, through the claude group\'s upstream', async () => {
  const facts = darwinFacts(31, { exe: '/Users/u/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex', cmdline: 'codex exec hi' })
  const groups = darwinGroupsOf(ALL)
  const routes = Object.fromEntries(groups.map((x) => [x.g, { g: x.g, ...ROUTE }]))
  routes['claude-code.settings'] = { ...ROUTE, upstream: { kind: 'http', host: 'corp.proxy', port: 3128, source: 'agent' } }
  const d = door('darwin', { store: new Map([[31, facts]]), routes })
  d.r.on('exec', (f) => d.r.watch(f.pid, { decrypt: true, agent: REG.match(f).agent }))
  const m = await d.ask(31, 'claude-code.settings')
  assert.deepEqual([m.agent, m.door, m.decrypt, m.upstream], ['codex', 'claude-code.settings', true, { kind: 'http', host: 'corp.proxy', port: 3128 }])
})

test('FD-W3 the Z Code desktop\'s app-server (ZCode.exe running zcode.cjs app-server) at the z-code.desktop door is z-code and goes to the verdict', async () => {
  const exe = `${W}\\AppData\\Local\\Programs\\ZCode\\ZCode.exe`
  const d = door('win32', { store: new Map([[41, win32Facts(winRow(41, exe, `"${exe}" ${W}\\AppData\\Local\\Programs\\ZCode\\resources\\app\\resources\\glm\\zcode.cjs app-server --stdio`))]]) })
  d.r.on('exec', (f) => d.r.watch(f.pid, { decrypt: true, agent: 'z-code' }))
  const m = await d.ask(41, 'z-code.desktop', target('open.bigmodel.cn'))
  assert.deepEqual([m.agent, m.door, m.decrypt, m.skip], ['z-code', 'z-code.desktop', true, undefined])
  assert.deepEqual(d.execs.map((f) => f.pid), [41], 'the pid was told to the tracker')
})

test('a renamed binary on no list: three connections are `not-an-agent`, and ONE process-unknown names it — no command line in it, the closed set holds it', async () => {
  const facts = darwinFacts(51, { exe: '/Users/u/bin/claude-nightly', cmdline: 'claude-nightly -p --api-key sk-ant-SECRET' })
  const d = door('darwin', { store: new Map([[51, facts]]) })
  for (let i = 0; i < 3; i++) {
    const m = await d.ask(51, 'claude-code.settings')
    assert.deepEqual([m.agent, m.door, m.decrypt, m.skip, m.exe], ['claude-code', 'claude-code.settings', false, { not_captured: 'untracked', reason: 'not-an-agent' }, '/Users/u/bin/claude-nightly'], 'forwarded; the row still says whose it was')
  }
  assert.equal(d.events.length, 1, 'once per (door group, name)')
  const [e] = d.events
  assert.deepEqual([e.event, e.where, e.harness, e.door, e.name, e.wide, e.pid], ['process-unknown', 'engine', 'claude-code', 'claude-code.settings', 'claude-nightly', false, 51])
  assert.deepEqual(checkRecord(e), [], 'a name of the closed sets')
  assert.equal(JSON.stringify(e).includes('SECRET'), false, 'the command line (it may carry a key) is never written')
  assert.deepEqual(d.execs, [], 'never told to the tracker')
  await d.ask(51, 'codex.env', target('api.openai.com'))
  assert.equal(d.events.length, 2, 'another door group is another (door group, name)')
  const node = darwinFacts(52, { exe: '/usr/local/bin/node', cmdline: 'node /Users/u/work/mcp-server.js' })
  d.store.set(52, node)
  await d.ask(52, 'claude-code.settings')
  assert.deepEqual([d.events[2].name, d.events[2].wide], ['node', true], 'an interpreter is said as wide: the user\'s entry needs an args pattern')
})

test('a preset name whose args miss (the Z Code GUI main ZCode.exe without zcode.cjs) is `not-an-agent`; its process-unknown says `named`, so doctor gives no bare line that would claim every zcode', async () => {
  const exe = `${W}\\AppData\\Local\\Programs\\ZCode\\ZCode.exe`
  const d = door('win32', { store: new Map([[61, win32Facts(winRow(61, exe, `"${exe}"`))]]) })
  const m = await d.ask(61, 'z-code.desktop', target('open.bigmodel.cn'))
  assert.deepEqual([m.decrypt, m.skip], [false, { not_captured: 'untracked', reason: 'not-an-agent' }], 'forwarded, never decrypted')
  assert.deepEqual(d.execs, [], 'never told to the tracker')
  assert.deepEqual(d.events.map((e) => [e.event, e.name, e.wide, e.named]), [['process-unknown', 'zcode', false, true]])
  assert.deepEqual(checkRecord(d.events[0]), [])
  const renamed = darwinFacts(62, { exe: '/Users/u/bin/claude-nightly', cmdline: 'claude-nightly' })
  d.store.set(62, renamed)
  await d.ask(62, 'claude-code.settings')
  assert.equal(d.events[1].named, false, 'a name on no list is not `named`')
})

test('a harness\'s own helper (kimi __plugin_run_node, win32 and darwin facts) is `agent-helper`: forwarded, no process-unknown', async () => {
  const exe = `${W}\\.kimi-code\\bin\\kimi.exe`
  const d = door('win32', { store: new Map([[61, win32Facts(winRow(61, exe, `"${exe}" __plugin_run_node C:\\x\\plugin.js`))]]) })
  const m = await d.ask(61, 'kimi-code.cli', target('api.kimi.com'))
  assert.deepEqual([m.skip, d.events, d.execs], [{ not_captured: 'untracked', reason: 'agent-helper' }, [], []])
  const mac = door('darwin', { store: new Map([[62, darwinFacts(62, { exe: '/Users/u/.kimi-code/bin/kimi', cmdline: '/Users/u/.kimi-code/bin/kimi __plugin_run_node /Users/u/.kimi-code/plugins/x.js' })]]) })
  const n = await mac.ask(62, 'kimi-code.cli', target('api.kimi.com'))
  assert.deepEqual([n.skip, mac.events, mac.execs], [{ not_captured: 'untracked', reason: 'agent-helper' }, [], []], 'darwin facts read the exclude items too (mac plugin-shim F10)')
})

test('no facts (gone between accept and ask, or unreadable) is `facts-unavailable`, not `not-an-agent`; no pid is `pid-unresolved`', async () => {
  const d = door('darwin')
  const m = await d.ask(71, 'claude-code.settings')
  assert.deepEqual([m.pid, m.skip, m.negKey, d.events], [71, { not_captured: 'untracked', reason: 'facts-unavailable' }, '71', []])
  const n = await d.ask(null, 'claude-code.settings')
  assert.deepEqual([n.pid, n.skip.reason, n.negKey], [null, 'pid-unresolved', 'claude-code.settings'])
})

test('another user\'s process (darwin ps uid) is `other-user`: never named, never judged, even when its name is on the list', async () => {
  const facts = darwinFacts(81, { exe: '/Users/v/.local/bin/claude', cmdline: 'claude', uid: OWN_UID + 1 })
  assert.equal(facts.uid, OWN_UID + 1, 'procinfo carries the ps uid column into the facts')
  const d = door('darwin', { store: new Map([[81, facts]]) })
  const m = await d.ask(81, 'claude-code.settings')
  assert.deepEqual([m.skip, m.decrypt, d.execs, d.events], [{ not_captured: 'untracked', reason: 'other-user' }, false, [], []])
  const mine = darwinFacts(82, { exe: '/Users/u/.local/bin/claude', cmdline: 'claude' })
  d.store.set(82, mine)
  d.r.on('exec', (f) => d.r.watch(f.pid, { decrypt: true, agent: 'claude-code' }))
  assert.equal((await d.ask(82, 'claude-code.settings')).decrypt, true, 'this user\'s own claude is judged as ever')
})

test('a harness whose desired state is off is `harness-off`: named, not judged — the door\'s harness on or not', async () => {
  const facts = darwinFacts(91, { exe: '/Users/u/.local/bin/claude', cmdline: 'claude' })
  const d = door('darwin', { store: new Map([[91, facts]]), isOn: (h) => h !== 'claude-code' })
  const m = await d.ask(91, 'codex.env', target('api.openai.com'))
  assert.deepEqual([m.agent, m.skip, d.execs], ['claude-code', { not_captured: 'untracked', reason: 'harness-off' }, []])
})

test('a host-tree door (win32 kimi-code.vscode): Code.exe — on no list, named by the group\'s hosts.processes — is Kimi\'s for the host set, told to the tracker as hostAgent; off the set `outside-host-set`; at another door it is nobody', async () => {
  const code = String.raw`C:\Program Files\Microsoft VS Code\Code.exe`
  const d = door('win32', { store: new Map([[101, win32Facts(winRow(101, code, `"${code}"`))]]), hostsOf: (f) => (f.id === 'kimi-code.vscode' ? ['api.kimi.com'] : null) })
  d.r.on('exec', (f) => d.r.watch(f.pid, { decrypt: true, agent: f.hostAgent }))
  const inSet = await d.ask(101, 'kimi-code.vscode', target('api.kimi.com'))
  assert.deepEqual([inSet.agent, inSet.door, inSet.decrypt, inSet.skip], ['kimi-code', 'kimi-code.vscode', true, undefined])
  assert.deepEqual(d.execs.map((f) => [f.pid, f.hostAgent]), [[101, 'kimi-code']], 'the tracker hears it as the host\'s, not the name list\'s to say')
  const out = await d.ask(101, 'kimi-code.vscode', target('marketplace.visualstudio.com'))
  assert.deepEqual([out.agent, out.decrypt, out.skip], ['kimi-code', false, { not_captured: 'untracked', reason: 'outside-host-set' }])
  const elsewhere = await d.ask(101, 'claude-code.settings')
  assert.equal(elsewhere.skip.reason, 'not-an-agent', 'the host rule belongs to its own door group')
  assert.deepEqual(d.r.procs().map((p) => [p.pid, p.agent, p.door]), [[101, 'kimi-code', 'claude-code.settings']], 'procs: the host\'s agent, the door it last came through')
})

test('the tracker takes a host-tree door\'s hostAgent as the harness: it never asks the name list, which names nobody', async () => {
  const code = String.raw`C:\Program Files\Microsoft VS Code\Code.exe`
  const facts = { ...win32Facts(winRow(111, code, `"${code}"`)), hostAgent: 'kimi-code' }
  assert.equal(REG.match(facts).agent, null, 'Code is on no list')
  const verdicts = []
  const redirector = Object.assign(new (await import('node:events')).EventEmitter(), { watch: (pid, v) => verdicts.push([pid, v.agent]), unwatch: () => {}, scan: async () => [] })
  const tracker = createTracker({ redirector, registry: REG, trust: { check: () => ({ trusted: false, reason: 'var-missing', var: null, via: null }) }, home: '/nonexistent', alive: () => true, readFile: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) } })
  tracker.start()
  redirector.emit('exec', facts)
  for (let i = 0; i < 20 && !verdicts.length; i++) await new Promise((x) => setImmediate(x))
  assert.deepEqual(verdicts, [[111, 'kimi-code']])
})

test('4.9 MA1 (unit half): curl holding the door\'s token is not an agent — forwarded `not-an-agent`, never decrypted', async () => {
  const d = door('darwin', { store: new Map([[121, darwinFacts(121, { exe: '/usr/bin/curl', cmdline: 'curl -x http://claude-code.settings:token@127.0.0.1:18800 https://api.anthropic.com' })]]) })
  d.r.watch(121, { decrypt: true, agent: 'claude-code' }) // even a verdict row in the table does not make curl an agent
  const m = await d.ask(121, 'claude-code.settings')
  assert.deepEqual([m.decrypt, m.skip, d.events.map((e) => e.name)], [false, { not_captured: 'untracked', reason: 'not-an-agent' }, ['curl']])
})

// ── the door's why on the connection row, through the daemon's own wiring ──────────────────────────────────────────────────────────────────────
// A real engine ingress over the door core, its policy wired exactly as daemon.mjs wires it (`(meta, host) => tracker.policy(meta, host)`, a
// real tracker on the same door), one plain HTTP exchange per connection, and the flows/ row it leaves (RFC 4.6 §记录 连接行怎么落码, item 7).
const NO_TRUST = { check: () => ({ trusted: false, reason: 'var-missing', var: null, via: null }) }
const ENOENT = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }
const engineCa = createCa()
async function wired(t, d) {
  const tracker = createTracker({ redirector: d.r, registry: REG, trust: NO_TRUST, home: '/nonexistent', alive: () => true, readFile: ENOENT })
  tracker.start()
  const echo = net.createServer((s) => { s.on('error', () => {}); s.pipe(s) })
  await new Promise((r) => echo.listen(0, '127.0.0.1', r))
  const flows = []
  const engine = createEngine({
    redirector: d.r, issuer: createLeafIssuer(loadCa(engineCa)), ingressToken: 'a'.repeat(32),
    connectUpstream: () => net.connect(echo.address().port, '127.0.0.1'), // every target lands on the local echo: the row, not the network, is under test
    policy: (meta, host) => tracker.policy(meta, host), // daemon.mjs's line, verbatim
    store: { envelope: () => true, flow: (f) => { flows.push(structuredClone(f)); return true } }, onFailure: () => {},
  })
  const { ingressPort } = await engine.listen({ ingress: { port: 0 } })
  t.after(async () => { echo.close(); tracker.stop?.(); await closeWithin(engine) })
  /** one connection of `pid` through door group `user` to `host`: CONNECT, a plain request echoed back, closed → its flows/ row */
  return async (pid, user, host = 'api.anthropic.com') => {
    d.owner.pid = pid
    const n = flows.length
    const sock = net.connect(ingressPort, '127.0.0.1'); sock.on('error', () => {})
    const req = `GET /v1/models HTTP/1.1\r\nHost: ${host}\r\n\r\n`
    sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Authorization: Basic ${Buffer.from(`${user}:${'a'.repeat(32)}`).toString('base64')}\r\n\r\n`)
    await within(new Promise((res) => { let got = ''; let sent = false; sock.on('data', (b) => { got += b.toString('latin1'); if (!sent && got.includes('\r\n\r\n')) { sent = true; got = ''; sock.write(req) } else if (sent && got.length >= req.length) res() }) }), 4000, 'the echoed request', () => sock.destroy())
    sock.end()
    for (let i = 0; i < 400 && flows.length <= n; i++) await new Promise((x) => setTimeout(x, 10))
    return flows[n]
  }
}

test('item 7 wired: every untracked why the door gives lands on the flows/ row through the daemon\'s policy — `not-an-agent` (unlisted, args-mismatch), agent-helper, facts-unavailable, pid-unresolved, other-user, harness-off, cmdline-pending, ambiguous, group-off, outside-host-set even when the host\'s pid has a table row', async (t) => {
  const seen = []
  const expect = (row, reason, what) => { seen.push(reason); assert.deepEqual([row && row.not_captured, row && row.reason], ['untracked', reason], what) }

  const mac = door('darwin', { isOn: (h) => h !== 'codex', store: new Map([
    [51, darwinFacts(51, { exe: '/Users/u/bin/claude-nightly', cmdline: 'claude-nightly -p hi' })],
    [62, darwinFacts(62, { exe: '/Users/u/.kimi-code/bin/kimi', cmdline: '/Users/u/.kimi-code/bin/kimi __plugin_run_node /Users/u/.kimi-code/plugins/x.js' })],
    [81, darwinFacts(81, { exe: '/Users/v/.local/bin/claude', cmdline: 'claude', uid: OWN_UID + 1 })],
    [91, darwinFacts(91, { exe: '/Users/u/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex', cmdline: 'codex exec hi' })],
  ]) })
  const viaMac = await wired(t, mac)
  expect(await viaMac(51, 'claude-code.settings'), 'not-an-agent', 'a renamed binary on no list')
  expect(await viaMac(62, 'kimi-code.cli', 'api.kimi.com'), 'agent-helper', 'a harness\'s own helper')
  expect(await viaMac(71, 'claude-code.settings'), 'facts-unavailable', 'no facts for the pid')
  expect(await viaMac(null, 'claude-code.settings'), 'pid-unresolved', 'no pid at all')
  expect(await viaMac(81, 'claude-code.settings'), 'other-user', 'another user\'s claude')
  expect(await viaMac(91, 'claude-code.settings'), 'harness-off', 'codex, whose desired state is off')

  const zexe = `${W}\\AppData\\Local\\Programs\\ZCode\\ZCode.exe`
  const code = String.raw`C:\Program Files\Microsoft VS Code\Code.exe`
  const win = door('win32', { hostsOf: (f) => (f.id === 'kimi-code.vscode' ? ['api.kimi.com'] : null), store: new Map([
    [21, win32Facts(winRow(21, String.raw`C:\Program Files\nodejs\node.exe`, null, { cmdlineState: 'pending' }))],
    [41, win32Facts(winRow(41, zexe, `"${zexe}"`))],
    [101, win32Facts(winRow(101, code, `"${code}"`))],
  ]) })
  const viaWin = await wired(t, win)
  expect(await viaWin(21, 'deepseek-dsh.env', 'api.deepseek.com'), 'cmdline-pending', 'a win32 command line not read yet')
  expect(await viaWin(41, 'z-code.desktop', 'open.bigmodel.cn'), 'not-an-agent', 'a preset name whose args miss (args-mismatch)')
  const inSet = await viaWin(101, 'kimi-code.vscode', 'api.kimi.com') // the host program, judged as Kimi's: a tracker row for pid 101 now exists
  assert.deepEqual([inSet.not_captured, inSet.reason], ['untrusted', 'var-missing'], 'inside the host set it is judged, with the resolver\'s why')
  expect(await viaWin(101, 'kimi-code.vscode', 'marketplace.visualstudio.com'), 'outside-host-set', 'off the host set: the door\'s why for this connection, not the row the pid has from another')

  // ambiguous: no two presets overlap today, so a name list that answers it stands in; group-off: the plan has the group off while a connection still arrives
  const groups = darwinGroupsOf(ALL)
  const routes = Object.fromEntries(groups.map((x) => [x.g, { g: x.g, ...ROUTE }]))
  routes['codex.env'] = { ...ROUTE, on: false }
  const odd = door('darwin', { routes, identify: () => ({ reason: 'ambiguous', agent: null }), store: new Map([[131, darwinFacts(131, { exe: '/Users/u/bin/both', cmdline: 'both' })]]) })
  const viaOdd = await wired(t, odd)
  expect(await viaOdd(131, 'claude-code.settings'), 'ambiguous', 'a process two lists both claim')
  expect(await viaOdd(131, 'codex.env', 'api.openai.com'), 'group-off', 'a group the plan has off')

  assert.deepEqual(UNTRACKED_REASONS.filter((r) => !seen.includes(r)), [], 'every reason of the closed set reached a row through the wiring')
})
