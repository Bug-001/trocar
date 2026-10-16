// test/collector/core/door-identity.test.mjs — who a connection at a door is (RFC 4.8 §5.3, 4.9 §5.3, 4.6 §识别进程 R7), written once in
// core/engine/door-identity.mjs (createDoorIdentity): the order pid → facts → this user → host tree → name list, the untracked `why` each step leaves,
// the harness it names, and `process-unknown` to the recorder. The facts are real-shaped (0.1 §3 convention 3): darwin's come out of procinfo's
// factsOfPid fed recorded `ps` / `lsof` output through an injected runner, win32's out of factsOfRow fed helper `ps` rows. The name list is the real
// one (createRegistry over the real descriptors), the same function the tracker judges by; the doors are the model's (collector.mjs doorOf) over the
// descriptors' proxyMode data. Whether a harness is on, the verdict's decrypt and the upstream are the collector's (test/collector/core/proxymode/).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createDoorIdentity } from '../../../src/collector/core/engine/door-identity.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'
import { createTracker } from '../../../src/collector/core/tracker.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { factsOfPid } from '../../../src/collector/arch/darwin/procinfo.mjs'
import { factsOfRow } from '../../../src/collector/arch/win32/procinfo.mjs'
import { checkRecord } from '../../../src/health/codes.mjs'

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

const target = (address = 'api.anthropic.com') => ({ address, port: 443 })

/** A door of the model (collector.mjs doorOf): `<harness>:<route>`, its forms the harness's proxyMode forms of that route on `os`. */
function doorOf(harness, route, os = 'win32') {
  const d = ALL.find((x) => x.name === harness)
  const forms = d.proxyMode.forms.filter((f) => f.os.includes(os) && f.route === route)
  assert.ok(forms.length > 0, `${harness} has a ${route} route on ${os}`)
  return { g: `${harness}:${route}`, harness, forms }
}
const CC = doorOf('claude-code', 'settings')
const CODEX = doorOf('codex', 'env')
const DSH = doorOf('deepseek-dsh', 'switch')
const ZCODE = doorOf('z-code', 'cli-config')
const KIMI = doorOf('kimi-code', 'switch')
const KIMI_VSCODE = doorOf('kimi-code', 'vscode')

/** createDoorIdentity over a pid → facts store, the peer owned by whatever pid `owner.pid` says. */
function door({ store = new Map(), identify = REG.match, ownUid = OWN_UID, hostsOf = () => null } = {}) {
  const owner = { pid: null }
  const events = []
  const id = createDoorIdentity({
    identify, ownUid, hostsOf,
    ownerOf: async () => ({ pid: owner.pid, source: 'socket-table', ms: 1 }),
    factsOf: (pid) => (store.has(pid) ? store.get(pid) : null),
    onEvent: (e) => events.push(e),
  })
  const ask = async (pid, at, t = target()) => { owner.pid = pid; return id.identityOf({ peer: { address: '127.0.0.1', port: 50000 + (pid || 0) }, door: at, target: t }) }
  return { id, store, events, ask, owner }
}

/** The harness the tracker's verdict names for these facts, told to it the way a door tells it (`exec`), with the same name list. */
async function judged(facts) {
  const verdicts = []
  const redirector = Object.assign(new EventEmitter(), { watch: (pid, v) => verdicts.push(v.agent), unwatch: () => {}, scan: async () => [] })
  const tracker = createTracker({ redirector, registry: REG, trust: { check: () => ({ trusted: false, reason: 'var-missing', var: null, via: null }) }, home: '/nonexistent', alive: () => true, readFile: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) } })
  tracker.start()
  redirector.emit('exec', facts)
  for (let i = 0; i < 20 && !verdicts.length; i++) await new Promise((x) => setImmediate(x))
  tracker.stop?.()
  return verdicts[0] ?? null
}

test('the door needs identify: who a process is has no default answer', () => {
  assert.throws(() => createDoorIdentity({}), /identify/)
  assert.throws(() => createDoorIdentity({ ownerOf: async () => null, factsOf: () => null }), /identify/)
})

test('W76 one rule: the facts the door met are judged by the tracker with the same name list — the harness the door names is the harness of the verdict (darwin and win32 shapes)', async () => {
  const cases = [
    ['darwin', CC, darwinFacts(11, { exe: '/Users/u/.local/share/claude/versions/2.1.296', cmdline: 'claude -p hi' }), 'claude-code'],
    ['darwin', ZCODE, darwinFacts(12, { exe: '/Applications/ZCode.app/Contents/MacOS/ZCode', cmdline: 'zcode-cli' }), 'z-code'],
    ['win32', DSH, win32Facts(winRow(13, String.raw`C:\Program Files\nodejs\node.exe`, `"C:\\Program Files\\nodejs\\node.exe" ${W}\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`)), 'deepseek-dsh'],
  ]
  for (const [os, at, facts, harness] of cases) {
    const d = door({ store: new Map([[facts.pid, facts]]) })
    const m = await d.ask(facts.pid, at)
    assert.equal(REG.match(facts).agent, harness, `${os} ${facts.exe}: the name list names ${harness}`)
    assert.deepEqual([m.pid, m.agent, m.why, m.hosted, m.exe], [facts.pid, harness, null, false, facts.exe], `${os}: the door names the list's harness`)
    assert.equal(await judged(facts), harness, `${os}: the tracker judged the same facts as the same harness`)
  }
})

test('W78 a win32 command line still pending is `cmdline-pending`, not cached anywhere: the same pid\'s next connection, its command line arrived, is dsh', async () => {
  const node = String.raw`C:\Program Files\nodejs\node.exe`
  const d = door()
  d.store.set(21, win32Facts(winRow(21, node, null, { cmdlineState: 'pending' })))
  const first = await d.ask(21, DSH)
  assert.deepEqual([first.agent, first.why], [null, 'cmdline-pending'], 'pending: forwarded, never guessed')
  assert.deepEqual(d.events, [], 'no process-unknown')
  d.store.set(21, win32Facts(winRow(21, node, `node ${W}\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`)))
  const next = await d.ask(21, DSH)
  assert.deepEqual([next.agent, next.why], ['deepseek-dsh', null], 'the next connection asks again and is named')
})

test('W79 an agent on the list at another harness\'s door is its own harness (D51⑥): codex at the claude door is codex', async () => {
  const facts = darwinFacts(31, { exe: '/Users/u/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex', cmdline: 'codex exec hi' })
  const d = door({ store: new Map([[31, facts]]) })
  const m = await d.ask(31, CC)
  assert.deepEqual([m.agent, m.why], ['codex', null])
  assert.equal(d.id.cache.get(31).door, CC.g, 'the cache keeps the door it last came through')
})

test('FD-W3 the Z Code desktop\'s app-server (ZCode.exe running zcode.cjs app-server) at the z-code door is z-code', async () => {
  const exe = `${W}\\AppData\\Local\\Programs\\ZCode\\ZCode.exe`
  const d = door({ store: new Map([[41, win32Facts(winRow(41, exe, `"${exe}" ${W}\\AppData\\Local\\Programs\\ZCode\\resources\\app\\resources\\glm\\zcode.cjs app-server --stdio`))]]) })
  const m = await d.ask(41, ZCODE, target('open.bigmodel.cn'))
  assert.deepEqual([m.agent, m.why], ['z-code', null])
})

test('a renamed binary on no list: three connections are `not-an-agent`, and ONE process-unknown names it — no command line in it, the closed set holds it', async () => {
  const facts = darwinFacts(51, { exe: '/Users/u/bin/claude-nightly', cmdline: 'claude-nightly -p --api-key sk-ant-SECRET' })
  const d = door({ store: new Map([[51, facts]]) })
  for (let i = 0; i < 3; i++) {
    const m = await d.ask(51, CC)
    assert.deepEqual([m.agent, m.why, m.exe], [null, 'not-an-agent', '/Users/u/bin/claude-nightly'], 'forwarded; the row still says which program it was')
  }
  assert.equal(d.events.length, 1, 'once per (door group, name)')
  const [e] = d.events
  assert.deepEqual([e.event, e.where, e.harness, e.door, e.name, e.wide, e.pid], ['process-unknown', 'engine', 'claude-code', CC.g, 'claude-nightly', false, 51])
  assert.deepEqual(checkRecord(e), [], 'a name of the closed sets')
  assert.equal(JSON.stringify(e).includes('SECRET'), false, 'the command line (it may carry a key) is never written')
  await d.ask(51, CODEX, target('api.openai.com'))
  assert.equal(d.events.length, 2, 'another door group is another (door group, name)')
  d.store.set(52, darwinFacts(52, { exe: '/usr/local/bin/node', cmdline: 'node /Users/u/work/mcp-server.js' }))
  await d.ask(52, CC)
  assert.deepEqual([d.events[2].name, d.events[2].wide], ['node', true], 'an interpreter is said as wide: the user\'s entry needs an args pattern')
})

test('a preset name whose args miss (the Z Code GUI main ZCode.exe without zcode.cjs) is `not-an-agent`; its process-unknown says `named`, so doctor gives no bare line that would claim every zcode', async () => {
  const exe = `${W}\\AppData\\Local\\Programs\\ZCode\\ZCode.exe`
  const d = door({ store: new Map([[61, win32Facts(winRow(61, exe, `"${exe}"`))]]) })
  const m = await d.ask(61, ZCODE, target('open.bigmodel.cn'))
  assert.deepEqual([m.agent, m.why], [null, 'not-an-agent'], 'forwarded, never named')
  assert.deepEqual(d.events.map((e) => [e.event, e.name, e.wide, e.named]), [['process-unknown', 'zcode', false, true]])
  assert.deepEqual(checkRecord(d.events[0]), [])
  d.store.set(62, darwinFacts(62, { exe: '/Users/u/bin/claude-nightly', cmdline: 'claude-nightly' }))
  await d.ask(62, CC)
  assert.equal(d.events[1].named, false, 'a name on no list is not `named`')
})

test('a harness\'s own helper (kimi __plugin_run_node, win32 and darwin facts) is `agent-helper`: forwarded, no process-unknown', async () => {
  const exe = `${W}\\.kimi-code\\bin\\kimi.exe`
  const d = door({ store: new Map([[61, win32Facts(winRow(61, exe, `"${exe}" __plugin_run_node C:\\x\\plugin.js`))]]) })
  const m = await d.ask(61, KIMI, target('api.kimi.com'))
  assert.deepEqual([m.agent, m.why, d.events], [null, 'agent-helper', []])
  const mac = door({ store: new Map([[62, darwinFacts(62, { exe: '/Users/u/.kimi-code/bin/kimi', cmdline: '/Users/u/.kimi-code/bin/kimi __plugin_run_node /Users/u/.kimi-code/plugins/x.js' })]]) })
  const n = await mac.ask(62, doorOf('kimi-code', 'switch', 'darwin'), target('api.kimi.com'))
  assert.deepEqual([n.agent, n.why, mac.events], [null, 'agent-helper', []], 'darwin facts read the exclude items too (mac plugin-shim F10)')
})

test('no facts (gone between accept and ask, or unreadable) is `facts-unavailable`, not `not-an-agent`; no pid is `pid-unresolved`; an owner read that throws is one failure and no pid', async () => {
  const d = door()
  const m = await d.ask(71, CC)
  assert.deepEqual([m.pid, m.why, d.events], [71, 'facts-unavailable', []])
  const n = await d.ask(null, CC)
  assert.deepEqual([n.pid, n.why], [null, 'pid-unresolved'])
  const failures = []
  const broken = createDoorIdentity({ identify: REG.match, ownerOf: async () => { throw new Error('table gone') }, factsOf: () => null, onFailure: (f) => failures.push(f) })
  const o = await broken.identityOf({ peer: { address: '127.0.0.1', port: 1 }, door: CC, target: target() })
  assert.deepEqual([o.pid, o.why, failures.map((f) => f.code)], [null, 'pid-unresolved', ['socktable-unavailable']])
  assert.deepEqual(checkRecord(failures[0]), [])
})

test('another user\'s process (darwin ps uid) is `other-user`: never named, even when its name is on the list', async () => {
  const facts = darwinFacts(81, { exe: '/Users/v/.local/bin/claude', cmdline: 'claude', uid: OWN_UID + 1 })
  assert.equal(facts.uid, OWN_UID + 1, 'procinfo carries the ps uid column into the facts')
  const d = door({ store: new Map([[81, facts]]) })
  const m = await d.ask(81, CC)
  assert.deepEqual([m.agent, m.why, d.events], [null, 'other-user', []])
  d.store.set(82, darwinFacts(82, { exe: '/Users/u/.local/bin/claude', cmdline: 'claude' }))
  assert.deepEqual([(await d.ask(82, CC)).agent], ['claude-code'], 'this user\'s own claude is named as ever')
})

test('a host-tree door (kimi-code:vscode): Code.exe — on no list, named by the form\'s hosts.processes — is Kimi\'s for the host set; off the set `outside-host-set`; at another door it is nobody', async () => {
  const code = String.raw`C:\Program Files\Microsoft VS Code\Code.exe`
  const facts = win32Facts(winRow(101, code, `"${code}"`))
  assert.equal(REG.match(facts).agent, null, 'Code is on no list')
  const d = door({ store: new Map([[101, facts]]), hostsOf: (f) => (f.id === 'kimi-code.vscode' ? ['api.kimi.com'] : null) })
  const inSet = await d.ask(101, KIMI_VSCODE, target('api.kimi.com'))
  assert.deepEqual([inSet.agent, inSet.hosted, inSet.why], ['kimi-code', true, null])
  assert.equal(d.id.cache.get(101).host, 'kimi-code', 'the life is the host\'s: a rescan re-tells it as Kimi\'s, never re-asks the name list')
  const sub = await d.ask(101, KIMI_VSCODE, target('eu.api.kimi.com.'))
  assert.deepEqual([sub.agent, sub.hosted], ['kimi-code', true], 'a name under a host of the set, in any spelling the target arrives in')
  const out = await d.ask(101, KIMI_VSCODE, target('marketplace.visualstudio.com'))
  assert.deepEqual([out.agent, out.hosted, out.why], [null, false, 'outside-host-set'])
  const elsewhere = await d.ask(101, CC)
  assert.deepEqual([elsewhere.agent, elsewhere.why], [null, 'not-an-agent'], 'the host rule belongs to its own door')
  assert.equal(d.id.cache.get(101).door, CC.g, 'the door it last came through')
  const darwinCode = darwinFacts(102, { exe: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)', cmdline: 'Code Helper (Plugin)' })
  const mac = door({ store: new Map([[102, darwinCode]]), hostsOf: () => ['api.kimi.com'] })
  assert.deepEqual([(await mac.ask(102, doorOf('kimi-code', 'vscode', 'darwin'), target('api.kimi.com'))).agent], ['kimi-code'], 'the macOS extension host, by the same rule')
})

test('a host-tree door with no host set forwards every target: nothing is decrypted on a guess', async () => {
  const code = String.raw`C:\Program Files\Microsoft VS Code\Code.exe`
  const d = door({ store: new Map([[103, win32Facts(winRow(103, code, `"${code}"`))]]) })
  const m = await d.ask(103, KIMI_VSCODE, target('api.kimi.com'))
  assert.deepEqual([m.agent, m.why], [null, 'outside-host-set'])
})

test('the tracker takes a host-tree door\'s hostAgent as the harness: it never asks the name list, which names nobody', async () => {
  const code = String.raw`C:\Program Files\Microsoft VS Code\Code.exe`
  const facts = { ...win32Facts(winRow(111, code, `"${code}"`)), hostAgent: 'kimi-code' }
  assert.equal(REG.match(facts).agent, null, 'Code is on no list')
  assert.equal(await judged(facts), 'kimi-code')
})

test('4.9 MA1 (unit half): curl holding the door\'s token is not an agent — `not-an-agent`, named in one process-unknown', async () => {
  const d = door({ store: new Map([[121, darwinFacts(121, { exe: '/usr/bin/curl', cmdline: 'curl -x http://claude-code.settings:token@127.0.0.1:18800 https://api.anthropic.com' })]]) })
  const m = await d.ask(121, CC)
  assert.deepEqual([m.agent, m.why, d.events.map((e) => e.name)], [null, 'not-an-agent', ['curl']])
})
