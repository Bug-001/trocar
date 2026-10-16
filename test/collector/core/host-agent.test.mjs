// test/collector/core/host-agent.test.mjs — the host-tree rule (RFC 4.8 §3, D51), written once in core/host-agent.mjs: a form's `hosts.processes` names
// the host program (an editor carrying a harness's extension) whose process is that harness's. Its readers — the door's identity (createDoorIdentity,
// at the hosting door of the model, for a target on the host set) and the win32 entry check (checkEntries' agents half) — must say the same harness for
// the same process facts. The process row is a real-shaped helper `ps` row; the name list is the real one over the real descriptors.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { hostFormOf, whoseWithHosts } from '../../../src/collector/core/host-agent.mjs'
import { createDoorIdentity } from '../../../src/collector/core/engine/door-identity.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { factsOfRow } from '../../../src/collector/arch/win32/procinfo.mjs'
import { checkEntries } from '../../../src/collector/arch/win32/optin.mjs'
import { rig, nativeKimi, realCmd, writeShortcut, GROUPS } from '../arch/win32/fixtures/optin-world.mjs'

const ALL = await loadHarnesses()
const hostAgentOf = (groups, facts) => (hostFormOf(groups, facts) || {}).harness ?? null
const REG = createRegistry(ALL)
const winJoin = path.win32.join

// The host form's hosts.processes spelled the way a user sees the program (`Code.exe`): the rule normalizes it like any name (normalizeName)
const spell = (f, spelling) => (f.hosts ? { ...f, hosts: { ...f.hosts, processes: spelling } } : f)
const spelled = (list, spelling) => list.map((d) => ({ ...d, proxyMode: { ...d.proxyMode, forms: d.proxyMode.forms.map((f) => spell(f, spelling)) } }))
const spelledGroups = (groups, spelling) => groups.map((x) => ({ ...x, forms: x.forms.map((f) => spell(f, spelling)) }))
/** The host-tree form and its door, as the model's collector builds the door (collector.mjs doorOf: `<harness>:<route>`, the route's forms on the OS). */
const hostDoorOf = (descriptors) => {
  const d = descriptors.find((x) => x.proxyMode.forms.some((f) => f.hostTree && f.os.includes('win32')))
  const f = d.proxyMode.forms.find((x) => x.hostTree && x.os.includes('win32'))
  return { harness: d.name, form: f, door: { g: `${d.name}:${f.route}`, harness: d.name, forms: d.proxyMode.forms.filter((x) => x.os.includes('win32') && x.route === f.route) } }
}
const hostForm = hostDoorOf(ALL)

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

/** The readers' answer for one host-program process, over the given descriptors (the door) and win32 groups (the entry check). */
async function bothSay(descriptors, groups, { pid = 52 }) {
  const host = hostDoorOf(descriptors)
  const code = String.raw`C:\Users\alice\AppData\Local\Programs\Microsoft VS Code\Code.exe`
  const row = { pid, ppid: 20, name: 'Code.exe', exe: code, cmdline: `"${code}"`, cmdlineState: 'ok', startedAt: 1760000000000 + pid, sessionId: 1, integrity: 'medium', tokenDenied: false }
  const explorer = { pid: 20, ppid: 4, name: 'explorer.exe', exe: String.raw`C:\Windows\explorer.exe`, cmdline: 'explorer.exe', cmdlineState: 'ok', startedAt: 1760000000000, sessionId: 1, integrity: 'medium', tokenDenied: false }

  // ① the door: the host form's door, a target on its host set
  const ident = createDoorIdentity({
    identify: REG.match, ownUid: null, hostsOf: (f) => (f.id === host.form.id ? ['api.kimi.com'] : null),
    ownerOf: async () => ({ pid, source: 'socket-table', ms: 1 }), factsOf: (p) => (p === pid ? factsOfRow(row) : null),
  })
  const m = await ident.identityOf({ peer: { address: '127.0.0.1', port: 50052 }, door: host.door, target: { address: 'api.kimi.com', port: 443 } })
  const byDoor = m.why ? null : m.agent

  // ② the entry check: both forms of the hosting harness opted in, the host program started around the launcher → not-via-entry names its harness
  const r = await rig({ form: 'kimi-code.cli', item: 'user-path-shim', forms: ['kimi-code.cli', host.form.id] })
  nativeKimi(r)
  realCmd(r, 'kimi')
  assert.equal((await r.apply()).state, 'done')
  writeShortcut(r, winJoin(r.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Visual Studio Code.lnk'), code)
  assert.equal((await r.applyAs(host.form.id, 'vscode-settings-and-launcher')).state, 'done')
  const found = checkEntries({ manifest: r.manifest, procs: [explorer, row], identify: REG.match, groups, deps: { run: r.w.run, env: r.env, fs: r.wfs } })
  const byCheck = (found.find((f) => f.code === 'not-via-entry' && f.detail.includes(`pid ${pid} `)) || {}).harness ?? null

  return { byDoor, byCheck }
}

for (const [label, descriptors, groups] of [['the presets', ALL, GROUPS], ['hosts.processes spelled Code.exe', spelled(ALL, ['Code.exe']), spelledGroups(GROUPS, ['Code.exe'])]]) {
  test(`R3 one host-tree rule: the door and the entry check put the host program under the same harness (${label})`, async () => {
    const { byDoor, byCheck } = await bothSay(descriptors, groups, { pid: 52 })
    assert.equal(byDoor, hostForm.harness, 'the door')
    assert.equal(byCheck, hostForm.harness, 'the entry check')
  })
}
