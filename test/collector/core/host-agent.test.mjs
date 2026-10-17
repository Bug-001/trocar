// test/collector/core/host-agent.test.mjs — the host-tree rule (RFC 4.8 §3, D51), written once in core/host-agent.mjs: a form's `hosts.processes` names
// the host program (an editor carrying a harness's extension) whose process is that harness's. Its three readers — the door core (at the hosting door,
// for a target on the host set), the win32 entry check (checkEntries' agents half) and the win32 network facts (`status` / `doctor`) — must say the same
// harness for the same process facts. The process row is a real-shaped helper `ps` row; the name list is the real one over the real descriptors.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { hostFormOf, whoseWithHosts } from '../../../src/collector/core/host-agent.mjs'
import { createDoorRedirector } from '../../../src/collector/core/engine/door-redirector.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { groupsOf } from '../../../src/collector/arch/win32/route-plan.mjs'
import { factsOfRow } from '../../../src/collector/arch/win32/procinfo.mjs'
import { checkEntries } from '../../../src/collector/arch/win32/optin.mjs'
import { gatherWin32Facts } from '../../../src/collector/arch/win32/netfacts.mjs'
import { rig, nativeKimi, realCmd, writeShortcut } from '../arch/win32/fixtures/optin-world.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

const ALL = await loadHarnesses()
const hostAgentOf = (groups, facts) => (hostFormOf(groups, facts) || {}).harness ?? null
const REG = createRegistry(ALL)
const winJoin = path.win32.join

// The descriptors with the host form's hosts.processes spelled the way a user sees the program (`Code.exe`): the rule normalizes it like any name (normalizeName)
const spelled = (list, spelling) => list.map((d) => (d.win32 && d.win32.forms.some((f) => f.hosts)
  ? { ...d, win32: { ...d.win32, forms: d.win32.forms.map((f) => (f.hosts ? { ...f, hosts: { ...f.hosts, processes: spelling } } : f)) } }
  : d))
const hostForm = groupsOf(ALL).flatMap((x) => x.forms.map((f) => ({ x, f }))).find(({ f }) => f.hosts)

test('hostFormOf: a name in hosts.processes, in any spelling normalizeName folds (Code.exe, a path), names its form; nobody hosts it → null; two harnesses host it → null (no guess)', () => {
  const g = (harness, processes) => ({ harness, forms: [{ id: `${harness}.f`, hosts: { processes } }] })
  const facts = { os: 'win32', exe: String.raw`C:\Program Files\Microsoft VS Code\Code.exe`, argv: ['Code.exe'] }
  for (const spelling of [['code'], ['Code.exe'], [String.raw`C:\x\CODE.EXE`]]) assert.equal(hostAgentOf([g('a', spelling)], facts), 'a', JSON.stringify(spelling))
  assert.equal(hostFormOf([g('a', ['code'])], facts).form.id, 'a.f')
  assert.equal(hostAgentOf([g('a', ['notepad'])], facts), null)
  assert.equal(hostAgentOf([g('a', ['code']), g('b', ['Code.exe'])], facts), null, 'two harnesses host the name: nobody')
  assert.equal(hostAgentOf([g('a', ['code']), { harness: 'a', forms: [{ id: 'a.g', hosts: { processes: ['code'] } }] }], facts), 'a', 'two forms of one harness: still that harness')
  assert.equal(hostAgentOf([{ harness: 'a', forms: [{ id: 'a.f' }] }], facts), null, 'a form without hosts hosts nothing')
  const whose = whoseWithHosts(REG.match, [g('a', ['code'])])
  assert.deepEqual([whose(facts).agent, whose(facts).reason], ['a', 'match'])
  assert.equal(whose({ ...facts, hostAgent: 'b' }).agent, 'b', 'a facts that already says its host keeps it')
})

/** The three readers' answer for one host-program process, over the given descriptors. */
async function threeSay(descriptors, { pid = 52 }) {
  const groups = groupsOf(descriptors)
  const code = String.raw`C:\Users\alice\AppData\Local\Programs\Microsoft VS Code\Code.exe`
  const row = { pid, ppid: 20, name: 'Code.exe', exe: code, cmdline: `"${code}"`, cmdlineState: 'ok', startedAt: 1760000000000 + pid, sessionId: 1, integrity: 'medium', tokenDenied: false }
  const explorer = { pid: 20, ppid: 4, name: 'explorer.exe', exe: String.raw`C:\Windows\explorer.exe`, cmdline: 'explorer.exe', cmdlineState: 'ok', startedAt: 1760000000000, sessionId: 1, integrity: 'medium', tokenDenied: false }

  // ① the door: the host form's door, a target on its host set
  const door = createDoorRedirector({
    groups, identify: REG.match, isOn: () => true, ownUid: null, verdictWaitMs: 30, hostsOf: (f) => (f.id === hostForm.f.id ? ['api.kimi.com'] : null),
    ownerOf: async () => ({ pid, source: 'socket-table', ms: 1 }), factsOf: (p) => (p === pid ? factsOfRow(row) : null),
    routes: () => Object.fromEntries(groups.map((x) => [x.g, { g: x.g, entry: 'auto', on: true, upstream: { kind: 'direct', source: 'direct' }, bypass: [] }])),
    ingress: () => ({ enginePort: 18790, groupPorts: Object.fromEntries(groups.map((x, i) => [x.g, 18800 + i])), ingressToken: 'a'.repeat(32), listenerToken: 'b'.repeat(32) }),
    onEvent: () => {}, directCount: async () => ({ count: 0, error: null }),
  })
  const m = await door.lookupIngress({ peer: { address: '127.0.0.1', port: 50052 }, user: hostForm.x.g, target: { address: 'api.kimi.com', port: 443 } })
  const byDoor = m && !(m.skip && m.skip.reason === 'not-an-agent') ? m.agent : null

  // ② the entry check: both forms of the hosting harness opted in, the host program started around the launcher → not-via-entry names its harness
  const r = await rig({ form: 'kimi-code.cli', item: 'user-path-shim', forms: ['kimi-code.cli', hostForm.f.id] })
  nativeKimi(r)
  realCmd(r, 'kimi')
  assert.equal((await r.apply()).state, 'done')
  writeShortcut(r, winJoin(r.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Visual Studio Code.lnk'), code)
  assert.equal((await r.applyAs(hostForm.f.id, 'vscode-settings-and-launcher')).state, 'done')
  const found = checkEntries({ manifest: r.manifest, procs: [explorer, row], identify: REG.match, groups, deps: { run: r.w.run, env: r.env, fs: r.wfs } })
  const byCheck = (found.find((f) => f.code === 'not-via-entry' && f.detail.includes(`pid ${pid} `)) || {}).harness ?? null

  // ③ the network facts `status` / `doctor` read: which harness's processes the row is listed under
  const home = tmpDir('asight-host-agent-')
  const helper = { call: async (verb) => (verb === 'ps' ? { sessionId: 1, procs: [explorer, row] } : verb === 'tcp-table' ? { rows: [] } : verb === 'net-if' ? { interfaces: [] } : verb === 'route' ? { iface: null } : verb === 'reg-read' ? { keyExists: false, values: {} } : null), close: async () => {} }
  const status = { daemon: { state: 'not-running', reply: null }, link: { attached: null, helper: 'ok' }, harnesses: descriptors.map((d) => ({ id: d.name, installed: false, desired: 'off', entry: { state: 'missing' }, procs: [] })) }
  const facts = await gatherWin32Facts({ status, harnesses: descriptors, env: { USERPROFILE: home }, home }, { helper })
  const byFacts = Object.entries(facts.procs).filter(([, list]) => list.some((p) => p.pid === pid)).map(([h]) => h)

  return { byDoor, byCheck, byFacts }
}

for (const [label, descriptors] of [['the presets', ALL], ['hosts.processes spelled Code.exe', spelled(ALL, ['Code.exe'])]]) {
  test(`R3 one host-tree rule: the door, the entry check and the network facts put the host program under the same harness (${label})`, async () => {
    const { byDoor, byCheck, byFacts } = await threeSay(descriptors, { pid: 52 })
    assert.equal(byDoor, hostForm.x.harness, 'the door')
    assert.equal(byCheck, hostForm.x.harness, 'the entry check')
    assert.deepEqual(byFacts, [hostForm.x.harness], 'the network facts (status / doctor): listed under its harness, and only there')
  })
}
