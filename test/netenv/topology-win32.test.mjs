// test/netenv/topology-win32.test.mjs — RFC 4.8 §10.2 (W29): every row a–s drawn from facts, literally (the node kinds, the verdict, the compact text — the row's own NetFacts is in
// fixtures/rows-win32.mjs, written by hand), and the machinery those rows share driven through the REAL gatherNetFacts path (archFacts = gatherWin32Facts) with injected readers:
// the entry edge (the manifest's record and the file's read-back), the elevated detector (integrity, or a token that will not open while the image path reads — the latter inferred),
// the 「不知道 · env-unreadable」 of a proxy that lives only in the starting terminal, the host set of an opted-in Kimi VS Code extension and the proxy hop named by its process. Nothing here
// runs Windows or reads the machine: the helper is a fake that answers the read verbs, the collector dir is a sandbox's, the clock is fixed (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildTopology, renderCompact, renderDetail } from '../../src/netenv/topology.mjs'
import { validateTopology } from '../../src/cli/schema.mjs'
import { gatherNetFacts } from '../../src/netenv/facts.mjs'
import { gatherWin32Facts } from '../../src/collector/arch/win32/netfacts.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { newManifest, applyJsonKey } from '../../src/collector/core/trust/journal.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { readManifest, saveManifest } from '../../src/off/manifest.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { ROWS } from './fixtures/rows-win32.mjs'
import { squash, pfacts, form, fwForm, proc } from './fixtures/rows.mjs'

const all = await loadHarnesses()
const kindOf = (t, id) => t.nodes.find((x) => x.id === id).kind
const NOW = Date.parse('2026-10-10T10:00:00.000Z')
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

// ---------- W29: the rows of 4.8 §10.2, drawn literally ----------
for (const row of ROWS) {
  test(`W29 row ${row.n}: ${row.title}`, () => {
    const topo = buildTopology(row.facts), t = topo[row.h]
    assert.deepEqual(t.branches.map((b) => [b.name, b.form]), row.names.map((n, i) => [n, row.forms[i]]), 'one branch per form (and per way of a form)')
    assert.deepEqual(t.branches.map((b) => b.path.map((id) => kindOf(t, id))), row.kinds, 'the kinds of the nodes on each branch')
    assert.deepEqual([t.on_path, t.captured, t.reason], [row.on_path, row.captured, row.reason], 'the verdict')
    for (const b of t.branches) assert.deepEqual([b.on_path, b.captured, b.reason], [row.on_path, row.captured, row.reason], 'every branch says the same of the form')
    assert.deepEqual(renderCompact(t).map(squash), row.compact.map(squash), 'the compact line, written out')
    assert.deepEqual(t.notes, row.notes || [], 'the notes the row adds')
    assert.deepEqual(validateTopology(topo), [], 'and the object is one the schema accepts (V43)')
  })
}

test('W29/D49 the one line about per-process rules of a VPN / proxy: in `status <h>` for every row where asight is on the path, whatever the machine has (a–f, h, i, k, m, q, r), absent where it is not — and it is a line of the detail view, not a note of the topology, so `on`\'s plan (which renders the notes) never prints it', () => {
  const LINE = (h) => `若你的 VPN / 代理按进程分流,它看到的来源是 asight,不是 ${h}`
  for (const row of ROWS) {
    const t = buildTopology(row.facts)[row.h]
    const detail = renderDetail(t, { now: NOW }).join('\n')
    assert.equal(detail.includes(LINE(row.h)), row.on_path === true, `row ${row.n}: the line is ${row.on_path === true ? 'there' : 'not there'}`)
    assert.ok(!t.notes.some((n) => /按进程分流/.test(n)), `row ${row.n}: it is not a note, so nothing else renders it`)
  }
  assert.ok(ROWS.some((r) => r.on_path === true) && ROWS.some((r) => r.on_path === false), 'both sides are covered')
})

test('W29 row e (v2rayN) is a proxy hop named by its executable and its port, and nothing else about it (D49: no product, no mode, no rule, no secret, no node name of the user\'s)', () => {
  const row = ROWS.find((r) => r.n === 'e'), t = buildTopology(row.facts).codex
  const hop = t.nodes.find((n) => n.kind === 'proxy')
  assert.deepEqual(hop, { id: hop.id, kind: 'proxy', name: 'v2rayN.exe', addr: '127.0.0.1', port: 10808, pid: 23001 })
  assert.equal(renderCompact(t)[0].includes('v2rayN.exe :10808'), true)
  for (const n of t.nodes) assert.ok(!/password|secret|HK-|proxies:/i.test(JSON.stringify(n)))
})

// ---------- the machinery of those rows, through gatherNetFacts (archFacts = gatherWin32Facts) with injected readers ----------
/** A fake resident helper: the read verbs the facts ask, each answer shaped as the real one gives it (the ps rows carry the elevation facts of 4.8 §1). */
const helperOf = ({ procs = [], listen = [], established = [], ifaces = [{ name: 'Ethernet', description: 'Intel(R) Ethernet', up: true }], defaultIface = 'Ethernet', internet = { ProxyEnable: { kind: 'REG_DWORD', value: 0 } }, internetFail = false, loginEnv = {} } = {}) => {
  const asked = []
  return {
    asked,
    call: async (verb, args = {}) => {
      asked.push([verb, args])
      if (verb === 'ps') return { sessionId: 1, procs }
      if (verb === 'tcp-table') return { rows: [...listen, ...established].filter((r) => !args.states || args.states.includes(r.state)) }
      if (verb === 'net-if') return { interfaces: ifaces }
      if (verb === 'route') return { dest: '1.1.1.1', ifIndex: 12, iface: ifaces.find((i) => i.name === defaultIface) || null }
      if (verb === 'reg-read') {
        if (args.key.endsWith('Internet Settings')) { if (internetFail) throw Object.assign(new Error('helper-error'), { code: 'helper-error' }); return { keyExists: true, values: internet } }
        if (args.key === 'Environment') return { keyExists: true, values: loginEnv }
        throw Object.assign(new Error(`forbidden-key: ${args.key}`), { code: 'helper-forbidden-key' })
      }
      throw Object.assign(new Error(`not in the fake: ${verb}`), { code: 'helper-verb-error' })
    },
    close: async () => {},
  }
}
const statusOf = (ids, { agents = [], desired = 'on', appliedHosts = null } = {}) => ({
  daemon: { state: 'running', pid: 4121, reply: { engine: { port: 17990 }, links: [], negatives: [], agents, ...(appliedHosts ? { applied_hosts: appliedHosts } : {}) }, lock: { engine_port: 17990 } },
  link: { attached: null, helper: 'ok', ids: [] },
  harnesses: ids.map((id) => ({ id, installed: true, desired, entry: { state: 'intact' }, installedAt: '2026-10-09T09:00:00.000Z', procs: [] })),
})
const gather = (home, { helper, ids = ['claude-code'], env = {}, agents = [], desired = 'on', manifest = null, appliedHosts = null, netenv = { result: { products: [], unknown: [] } } } = {}) =>
  gatherNetFacts({ platform: 'win32', home, env, harnesses: all, status: { ...statusOf(ids, { agents, desired, appliedHosts }), ...(manifest ? { manifest: { value: manifest, error: null } } : {}) }, netenv, archFacts: gatherWin32Facts, adopted: null, now: () => NOW, deps: { helper } })
const KERNEL_URL = 'http://claude-code.settings:s3-listener-token@127.0.0.1:17991'
/** The collector dir of an installed proxy mode: the kernel's lock, the ports of ingress.json, and the manifest's record of the entry that was written over the user's own proxy. */
function collectorOf(home, { url = KERNEL_URL, prior = 'http://proxy.corp:8080', groupPorts = { 'claude-code.settings': 17991 } } = {}) {
  const dir = path.join(home, '.asight', 'collector')
  put(path.join(dir, 'ingress.json'), `${JSON.stringify({ enginePort: 17990, groupPorts, ingressToken: 'a'.repeat(32), listenerToken: 's3-listener-token' })}\n`)
  const settings = path.join(home, '.claude', 'settings.json')
  if (prior != null) put(settings, `${JSON.stringify({ env: { HTTPS_PROXY: prior } }, null, 2)}\n`)
  const manifest = newManifest()
  applyJsonKey({ phase: 'on', dir, manifest, harness: 'claude-code', file: settings, keys: ['env', 'HTTPS_PROXY'], value: url, home, now: new Date('2026-10-09T09:00:00Z'), fs })
  return { dir, settings }
}
const CLAUDE_EXE = 'C:\\Users\\someone\\.local\\bin\\claude.exe'
const claudeRow = (pid, over = {}) => ({ pid, name: 'claude.exe', exe: CLAUDE_EXE, startedAt: 1760000001000, sessionId: 1, integrity: 'medium', tokenDenied: false, cmdline: null, cmdlineState: 'not-asked', ...over })
const KERNEL_ROW = { pid: 6120, name: 'asight-forwarder.exe', exe: 'C:\\Users\\someone\\.asight\\collector\\kernel\\asight-forwarder.exe', startedAt: 1760000000000, sessionId: 1, integrity: 'medium', tokenDenied: false, cmdline: null, cmdlineState: 'not-asked' }

test('gatherNetFacts on win32: the entry edge comes from the manifest\'s record and the file\'s read-back (intact while it holds the kernel\'s address, a changed field is not), the setting is the prior value, the kernel is up and the group\'s upstream is what it dials', async () => {
  const home = tmpDir('asight-wf-')
  const { settings } = collectorOf(home)
  const helper = helperOf({ procs: [KERNEL_ROW, claudeRow(4121)], listen: [{ pid: 6120, state: 'listen', localAddr: '127.0.0.1', localPort: 17991, remoteAddr: '0.0.0.0', remotePort: 0 }] })
  const f = await gather(home, { helper, agents: [{ pid: 4121, agent: 'claude-code', trusted: true, decrypt: true, reason: null }] })
  assert.equal(f.routing, 'proxy')
  assert.equal(f.unknowns.length, 0, `nothing left unread: ${JSON.stringify(f.unknowns)}`)
  const forms = f.harnesses['claude-code'].forms
  assert.deepEqual(forms.map((x) => x.id), ['claude-code.cli', 'claude-code.vscode', 'claude-code.desktop'], 'one entry per form of the harness\'s groups')
  const cli = forms[0]
  assert.deepEqual(cli.entry, { where: 'settings env.HTTPS_PROXY', asight: true, opt_in: false, intact: true }, 'the entry edge: the file still holds the kernel\'s address')
  assert.deepEqual([cli.setting.value, cli.setting.host, cli.setting.port, cli.setting.scheme], ['http://proxy.corp:8080', 'proxy.corp', 8080, 'http'], 'the prior value, as the agent had it')
  assert.deepEqual(cli.setting.source, [{ kind: 'file', where: settings, key: 'env.HTTPS_PROXY' }])
  assert.ok(!JSON.stringify(f).includes('s3-listener-token'.slice(0, 8)), 'the listener token of the kernel\'s address is not in the facts')
  assert.equal(forms[2].entry, null, 'the desktop\'s policy entry is an opt-in nobody named')
  assert.equal(forms[2].optIn.state, 'needed')
  assert.deepEqual(f.forwarder, { pid: 4121, up: true, forms: { 'claude-code.cli': { h: 'claude-code', port: 17991, state: 'forward-only', upstream: 'http://proxy.corp:8080', source: 'agent', clients: [] }, 'claude-code.vscode': { h: 'claude-code', port: 17991, state: 'forward-only', upstream: 'http://proxy.corp:8080', source: 'agent', clients: [] } } }, 'the daemon read back nothing on (links empty): said, and the plan says the group is wired; the local proxy hop is the engine\'s door itself (pid = the daemon\'s)')
  // and the topology built from those facts carries the entry edge (W29 row c\'s shape, this time from the real facts path)
  const t = buildTopology(f)['claude-code']
  const edge = t.edges.find((e) => e.entry)
  assert.deepEqual([edge.asight, edge.entry, edge.via], [true, { where: 'settings env.HTTPS_PROXY', opt_in: false }, 'proxy-http'])
  assert.ok(renderCompact(t).some((l) => l.includes('[CONNECT 原样转] proxy.corp:8080')), renderCompact(t).join(' / '))
  // the user changes the field: the entry is no longer asight's
  fs.writeFileSync(settings, `${JSON.stringify({ env: { HTTPS_PROXY: 'http://proxy.new:3128' } }, null, 2)}\n`)
  const changed = await gather(home, { helper })
  assert.deepEqual(changed.harnesses['claude-code'].forms[0].entry, { where: 'settings env.HTTPS_PROXY', asight: true, opt_in: false, intact: false })
  assert.equal(buildTopology(changed)['claude-code'].reason, 'proxy-changed', 'the row l verdict, from the real facts path')
})

test('the post-off drain window (row k), through the REAL facts path: a real undoHarnesses takes the entry record out of the manifest and puts the user\'s own proxy back, so the entry honestly says null — the agent\'s live connection to the kernel\'s port is what wires the hop, the verdict is desired-off and the note says how asight finally leaves', async () => {
  const home = tmpDir('asight-wf-drain-')
  const { dir, settings } = collectorOf(home)
  // what `asight off claude-code` leaves behind while the kernel drains: the file work is the real off side's (undo.mjs), the kernel's lock and ingress.json stay
  const undone = await undoHarnesses({ dir, home, manifest: readManifest(dir, fs), ids: ['claude-code'], procs: async () => [], env: {}, fs })
  assert.ok(undone.results.some((r) => r.result === 'restored'), 'the real off side restored the entry file')
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).env.HTTPS_PROXY, 'http://proxy.corp:8080', 'the user\'s own proxy is back in it')
  assert.equal(readManifest(dir, fs).entries.length, 0, 'and the entry record is gone from the manifest')
  const helper = helperOf({
    procs: [KERNEL_ROW, claudeRow(4121)],
    listen: [{ pid: 6120, state: 'listen', localAddr: '127.0.0.1', localPort: 17991, remoteAddr: '0.0.0.0', remotePort: 0 }],
    established: [{ pid: 4121, state: 'established', localAddr: '127.0.0.1', localPort: 51234, remoteAddr: '127.0.0.1', remotePort: 17991 }],
  })
  const f = await gather(home, { helper, desired: 'off', agents: [{ pid: 4121, agent: 'claude-code', trusted: false, decrypt: false, off: true, reason: 'off' }] })
  const fm = f.harnesses['claude-code'].forms[0]
  assert.equal(fm.entry, null, 'no manifest record: the entry edge says the form is not wired through a file')
  assert.deepEqual(f.forwarder.forms['claude-code.cli'].clients, [4121], 'the agent started while on is still connected to the kernel\'s port')
  assert.equal(f.forwarder.forms['claude-code.cli'].state, 'forward-only', 'and the kernel only forwards for it')
  const t = buildTopology(f)['claude-code']
  assert.deepEqual([t.on_path, t.captured, t.reason], [true, false, 'desired-off'], 'the row k verdict, from the facts a real off produces (before the 2026-10-10 fix the entry check fired first and this said not-routed)')
  assert.ok(t.notes.includes('还有 1 个 agent 连着 asight 的门,重启它们之后 asight 就完全退出'), t.notes.join(' / '))
  const lines = renderCompact(t)
  assert.ok(lines.some((l) => l.includes('claude 4121 → asight 本地代理 :17991(只转发) →')), lines.join(' / '))
  assert.ok(!lines.some((l) => l.includes('asight 写的') || l.includes('你点名的')), 'the hop\'s edge names no entry: the file no longer points at the kernel (the agent holds the address it read at startup)')
  assert.ok(lines.some((l) => l.includes('proxy.corp:8080')), 'the kernel forwards to the user\'s own proxy, the upstream re-planned for the drain')
  assert.deepEqual(validateTopology({ 'claude-code': t }), [], 'and the object is one the schema accepts (V43)')
  // the drain over: no client on the port, the same off leaves nothing on the path (1.6 §9.2's 「不在 · 否 · desired-off」 shape)
  const gone = await gather(home, { helper: helperOf({ procs: [KERNEL_ROW, claudeRow(4121)], listen: [{ pid: 6120, state: 'listen', localAddr: '127.0.0.1', localPort: 17991, remoteAddr: '0.0.0.0', remotePort: 0 }] }), desired: 'off' })
  const t2 = buildTopology(gone)['claude-code']
  assert.deepEqual([t2.on_path, t2.captured, t2.reason], [false, false, 'desired-off'], 'no live connection: asight is not on the path, said with the same reason')
  assert.ok(!t2.notes.some((n) => /连着 asight 的内核/.test(n)), 'and the drain note is gone (the opt-in form\'s 「要采它」 note stays: it is that form\'s own, not the drain\'s)')
})

test('the elevated detector (4.8 §10.1): integrity ≥ High is elevated; a token that will not open while the image path reads is elevated and marked inferred; neither is null, and the words say so', async () => {
  const home = tmpDir('asight-wf-elev-')
  collectorOf(home)
  const rows = [KERNEL_ROW, claudeRow(4121, { integrity: 'high' }), claudeRow(4122, { integrity: null, tokenDenied: true }), claudeRow(4123, { integrity: null, tokenDenied: false })]
  const f = await gather(home, { helper: helperOf({ procs: rows }) })
  const procs = f.harnesses['claude-code'].forms[0].procs
  const byPid = Object.fromEntries(procs.map((p) => [p.pid, p]))
  assert.deepEqual([byPid[4121].elevated, byPid[4121].elevatedInferred], [true, undefined], 'integrity High: elevated, a fact')
  assert.deepEqual([byPid[4122].elevated, byPid[4122].elevatedInferred], [true, true], 'the token unopenable, the image readable: elevated, inferred')
  assert.equal(byPid[4123].elevated, null, 'neither: not known, never a guess')
  const t = buildTopology(f)['claude-code']
  assert.match(renderCompact(t).join('\n'), /claude 4121\(提权\)/, 'the words of the fact (the form\'s drawn agent is the elevated one it found)')
  assert.equal(t.reason, 'elevated-agent', 'the row h verdict: the kernel cannot tell an elevated process, it only forwards')
  // and alone, the inference is drawn with its mark (a form draws one agent: the elevated one it found)
  const inferred = await gather(home, { helper: helperOf({ procs: [KERNEL_ROW, claudeRow(4122, { integrity: null, tokenDenied: true })] }) })
  assert.match(renderCompact(buildTopology(inferred)['claude-code']).join('\n'), /claude 4122\(提权 · 推断\)/, 'the words of the inference')
})

test('an env-only proxy is 「不知道 · env-unreadable」 (inferred): Windows reads no other process\'s environment, so the hop the agent would take without asight is said, not guessed (4.8 §10.1)', async () => {
  const home = tmpDir('asight-wf-env-')
  collectorOf(home, { prior: null }) // the user had no proxy in any file
  const f = await gather(home, { helper: helperOf({ procs: [KERNEL_ROW] }), ids: ['opencode'], env: { HTTPS_PROXY: 'http://terminal.proxy:3128' } })
  const fm = f.harnesses.opencode.forms[0]
  assert.equal(fm.setting.unknown.reason, 'env-unreadable')
  assert.match(fm.setting.unknown.detail, /HTTPS_PROXY/)
  assert.equal(fm.setting.inferred, true)
  const line = renderCompact(buildTopology(f).opencode).join('\n')
  assert.match(line, /opencode → 代理设置\(不知道 · env-unreadable · 推断\)/, 'the off-path\'s first hop, said with its reason and marked inferred (the agent is named by its harness: no process of it runs)')
  // and with no such variable anywhere the hop is simply not there: nothing is invented
  const clean = await gather(home, { helper: helperOf({ procs: [KERNEL_ROW] }), ids: ['opencode'], env: {} })
  assert.deepEqual(clean.harnesses.opencode.forms[0].setting, { value: null, scheme: null, host: null, port: null, source: [], sha256: null })
})

test('the proxy of the machine, through the real facts path over the helper\'s reads: the system proxy\'s listener is a hop named by its executable (D49: no product), and the per-process line is there because asight is on the path', async () => {
  const home = tmpDir('asight-wf-vpn-')
  collectorOf(home)
  const verge = { pid: 11800, name: 'verge-mihomo.exe', exe: 'C:\\Program Files\\Clash Verge\\verge-mihomo.exe', startedAt: 1759000000000, sessionId: 1, integrity: 'medium', tokenDenied: false, cmdline: null, cmdlineState: 'not-asked' }
  const helper = helperOf({
    procs: [KERNEL_ROW, claudeRow(4121), verge],
    listen: [
      { pid: 6120, state: 'listen', localAddr: '127.0.0.1', localPort: 17991, remoteAddr: '0.0.0.0', remotePort: 0 },
      { pid: 11800, state: 'listen', localAddr: '127.0.0.1', localPort: 7897, remoteAddr: '0.0.0.0', remotePort: 0 },
    ],
    internet: { ProxyEnable: { kind: 'REG_DWORD', value: 1 }, ProxyServer: { kind: 'REG_SZ', value: '127.0.0.1:7897' } },
  })
  const f = await gatherNetFacts({ platform: 'win32', home, env: {}, harnesses: all, status: statusOf(['claude-code']), netenv: { result: { products: [], unknown: [] } }, archFacts: gatherWin32Facts, adopted: null, now: () => NOW, deps: { helper } })
  const detail = renderDetail(buildTopology(f)['claude-code'], { now: NOW }).join('\n')
  assert.ok(detail.includes('若你的 VPN / 代理按进程分流,它看到的来源是 asight,不是 claude-code'), 'the one line')
})

test('the host set of an opted-in Kimi VS Code extension (4.8 §3, read-only): the defaults plus the relay of the extension\'s own settings, said when they cannot be read, and the names the kernel cannot meet are dropped — `status` changes nothing', async () => {
  const home = tmpDir('asight-wf-hosts-')
  put(path.join(home, '.asight', 'collector', 'ingress.json'), `${JSON.stringify({ enginePort: 17990, groupPorts: { 'kimi-code.vscode': 17995 }, ingressToken: 'a'.repeat(32), listenerToken: 's3-listener-token' })}\n`)
  const toml = (base) => path.join(home, '.kimi-code', 'config.toml')
  const withRelay = () => { put(toml(), 'base_url = "https://relay.corp.example/api"\nX_BASE_URL = "http://10.1.2.3:8080"\n'); return toml() }
  const f = await gather(home, { helper: helperOf({ procs: [KERNEL_ROW] }), ids: ['kimi-code'] })
  const vscode = f.harnesses['kimi-code'].forms.find((x) => x.id === 'kimi-code.vscode')
  assert.equal(vscode.hosts.settings, 'absent', 'no settings file: nothing configured, not a failure')
  assert.ok(vscode.hosts.hosts.length > 0, 'the defaults are the set')
  withRelay()
  const read = await gather(home, { helper: helperOf({ procs: [KERNEL_ROW] }), ids: ['kimi-code'] })
  const hs = read.harnesses['kimi-code'].forms.find((x) => x.id === 'kimi-code.vscode').hosts
  assert.equal(hs.settings, 'read')
  assert.ok(hs.hosts.includes('relay.corp.example'), 'the relay of the extension\'s own settings is in the set')
  assert.ok(hs.dropped.includes('10.1.2.3'), 'an address literal cannot be met by the kernel\'s rule: dropped, said')
  const before = fs.readFileSync(toml(), 'utf8')
  fs.chmodSync(toml(), 0o000)
  try {
    const denied = await gather(home, { helper: helperOf({ procs: [KERNEL_ROW] }), ids: ['kimi-code'] })
    const d = denied.harnesses['kimi-code'].forms.find((x) => x.id === 'kimi-code.vscode').hosts
    assert.deepEqual(d.settings, { unreadable: { reason: 'denied', detail: 'EACCES' } })
    assert.ok(!d.hosts.includes('relay.corp.example'), 'only the defaults and extra_hosts remain')
  } finally { fs.chmodSync(toml(), 0o644); assert.equal(fs.readFileSync(toml(), 'utf8'), before, 'nothing was written or taken away') }
})

test('W69 the operator\'s extra_hosts reach the set through the REAL facts path (state.json\'s per-harness list), and the daemon\'s reply carries the set it applied: `status` compares the two — and the read changes nothing (the settings file and the kernel\'s config are byte for byte what they were)', async () => {
  const home = tmpDir('asight-w69-extra-')
  put(path.join(home, '.asight', 'collector', 'ingress.json'), `${JSON.stringify({ enginePort: 17990, groupPorts: { 'kimi-code.vscode': 17995 }, ingressToken: 'a'.repeat(32), listenerToken: 's3-listener-token' })}\n`)
  put(path.join(home, '.asight', 'collector', 'state.json'), `${JSON.stringify({ version: 2, updated_at: '2026-10-09T09:00:00.000Z', harnesses: { 'kimi-code': { desired: 'on', extra_hosts: ['relay.extra.example'], updated_at: '2026-10-09T09:00:00.000Z' } } })}\n`)
  const toml = path.join(home, '.kimi-code', 'config.toml')
  put(toml, 'base_url = "https://relay.corp.example/api"\n')
  const before = { toml: fs.readFileSync(toml) }
  const helper = helperOf({ procs: [KERNEL_ROW] })
  const of = (f) => f.harnesses['kimi-code'].forms.find((x) => x.id === 'kimi-code.vscode')
  const bare = await gather(home, { helper, ids: ['kimi-code'] })
  const b = of(bare)
  assert.equal(b.hosts.settings, 'read')
  assert.ok(b.hosts.hosts.includes('relay.corp.example'), 'the relay of the extension\'s own settings')
  assert.ok(b.hosts.hosts.includes('relay.extra.example'), 'the operator\'s extra_hosts, from state.json\'s per-harness list — the one source the machine test of (a) did not carry')
  assert.equal(b.hosts.applied, undefined, 'no daemon answer here: nothing to compare, and no vacuous「旧的」 line either')
  // the daemon reports the set it applied — one the fresh read does not give back (the user added the relay after `on`)
  const withApplied = await gather(home, { helper, ids: ['kimi-code'], appliedHosts: { 'kimi-code.vscode': { hosts: ['api.kimi.com', 'api.kimi.ai', 'api.moonshot.ai', 'api.moonshot.cn', 'relay.extra.example'], settings: 'read', dropped: [] } } })
  assert.deepEqual(of(withApplied).hosts.applied, ['api.kimi.com', 'api.kimi.ai', 'api.moonshot.ai', 'api.moonshot.cn', 'relay.extra.example'], 'the applied set, as the reply carries it (the wiring\'s win32 bag, relayed by /status)')
  assert.deepEqual(fs.readFileSync(toml), before.toml, 'the settings file is byte for byte what it was: the read, the compare and the line change nothing')
})

test('W69 the host-set lines of `status` (4.8 §3): the host program\'s other connections only forward and only the form\'s host set reaches the engine; settings that cannot be read leave the set at the defaults and extra_hosts, said with the reason and the hosts that are still captured; a fresh read that differs from the applied set says the kernel\'s is old and names the command — three notes of the detail view, none when the set is current and reads', () => {
  const hostForm = (hosts) => form('kimi-code.vscode', { entry: { where: 'settings.json http.proxy', asight: true, opt_in: true, intact: true }, optIn: { state: 'done' }, procs: [proc(8100, { name: 'Code', exe: 'C:\\Program Files\\Microsoft VS Code\\Code.exe', version: null })], hosts })
  const DEFAULTS = ['api.kimi.com', 'api.kimi.ai', 'api.moonshot.ai', 'api.moonshot.cn']
  const tree = 'VS Code 别的连接经 asight 的门(只转发),只有到 Kimi 的 host 集的连接进引擎'
  // a read that agrees with the applied set: only the host-tree line
  const current = buildTopology(pfacts('kimi-code', hostForm({ program: 'VS Code', extension: 'Kimi', defaults: [...DEFAULTS], hosts: [...DEFAULTS, 'relay.corp.example'], settings: 'read', dropped: [], applied: [...DEFAULTS, 'relay.corp.example'] }), fwForm(17995)))['kimi-code']
  assert.deepEqual(current.notes, [tree], 'the set is current: no line of「旧的」')
  // the settings changed after `on`: the kernel's set is old, the command that recomputes it is named — `status` itself changes nothing
  const stale = buildTopology(pfacts('kimi-code', hostForm({ program: 'VS Code', extension: 'Kimi', defaults: [...DEFAULTS], hosts: [...DEFAULTS, 'relay.corp.example'], settings: 'read', dropped: [], applied: [...DEFAULTS] }), fwForm(17995)))['kimi-code']
  assert.deepEqual(stale.notes, [tree, '门里的 host 集是旧的(你 on 之后改过 Kimi 的设置): 跑 asight on kimi-code 重算集;status 只读,不改任何东西'])
  const staleDetail = renderDetail(stale, { now: NOW }).join('\n')
  assert.ok(staleDetail.includes('门里的 host 集是旧的') && staleDetail.includes('asight on kimi-code'), 'the detail view prints it, with the command')
  // the settings cannot be read: only the defaults and extra_hosts are captured — said with the reason and the hosts that are, never silent
  const unreadable = buildTopology(pfacts('kimi-code', hostForm({ program: 'VS Code', extension: 'Kimi', defaults: [...DEFAULTS], hosts: [...DEFAULTS, 'relay.extra.example'], settings: { unreadable: { reason: 'denied', detail: 'EACCES' } }, dropped: [] }), fwForm(17995)))['kimi-code']
  assert.deepEqual(unreadable.notes, [tree, `读不到 Kimi 扩展的设置(denied:EACCES):只采默认 host(${DEFAULTS.join('、')})与 extra_hosts;到你在那里配的中转站 host 的连接不采`])
  const detail = renderDetail(unreadable, { now: NOW }).join('\n')
  assert.ok(detail.includes('读不到 Kimi 扩展的设置(denied:EACCES)') && detail.includes(DEFAULTS.join('、')), 'the detail view prints the reason and the hosts that are still captured')
  // a settings file that is simply not there: nothing configured, not a failure — no line of「读不到」
  const absent = buildTopology(pfacts('kimi-code', hostForm({ program: 'VS Code', extension: 'Kimi', defaults: [...DEFAULTS], hosts: [...DEFAULTS], settings: 'absent', dropped: [] }), fwForm(17995)))['kimi-code']
  assert.deepEqual(absent.notes, [tree], 'absent is not unreadable: no line')
})

test('a helper that cannot be started, and one that answers nothing: every read it owned is an unknown with its reason, the routing stays proxy and nothing is invented (R11)', async () => {
  const home = tmpDir('asight-wf-dead-')
  collectorOf(home)
  const broken = { call: async () => { throw Object.assign(new Error('helper-down'), { code: 'helper-down' }) }, close: async () => {} }
  const f = await gather(home, { helper: broken, ids: ['codex'] })
  assert.equal(f.routing, 'proxy')
  assert.ok(f.unknowns.length >= 2, `the processes and the listeners are each said: ${JSON.stringify(f.unknowns)}`)
  for (const u of f.unknowns) assert.ok(['denied', 'timeout', 'absent', 'unparseable'].includes(u.reason), `${JSON.stringify(u)}: a reason of the closed set`)
  assert.deepEqual(f.listeners, [])
  assert.equal(f.forwarder.up, true, 'the local proxy hop is the engine\'s door: up = the daemon answered (the helper being down does not make the daemon gone)')
  assert.equal(f.harnesses.codex.systemProxy.unknown.reason, 'absent', 'the registry read did not happen (a harness that follows the OS proxy carries it: codex)')
})


// ---------- W36: the Windows doctor commands (4.8 §10.4) ----------
// The catalogue is `src/netenv/findings-win32.mjs` (one entry per code row of the §10.4 table, the commands filled from the facts); `diagnose` picks it on win32 (findings.mjs's `make`). Nothing here
// runs anything: the literals are what `doctor` PRINTS (R8), compared against hand-written expected lines — the values filled, a value that cannot be read 「不知道 · <原因>」, never a placeholder.
import { diagnose, FINDINGS, FINDING_CODES } from '../../src/netenv/findings.mjs'
import { FINDINGS_WIN32 } from '../../src/netenv/findings-win32.mjs'
import { validateFinding } from '../../src/cli/schema.mjs'
import { groupsOf } from '../../src/collector/arch/win32/route-plan.mjs'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SEVEN = ['claude-code', 'codex', 'hermes', 'kimi-code', 'opencode', 'deepseek-dsh', 'z-code']
/** A finding's context, filled the way `diagnose` fills it (`fm` = the form facts of the branch that carries the reason, the extras what the daemon's records will hand over). */
const CTX = (over = {}) => ({ F: {}, h: 'codex', hf: null, t: null, user: 'u', sh: 'powershell', platform: 'win32', setting: null, ...over })
const cmd = (run, shell = 'powershell') => ({ run, shell })
const A = (run) => cmd(run) // asight's own, in the platform's shell

test('W36 one entry per code row of §10.4 — no more, no less — and each entry\'s own output is a finding the schema accepts (a win-only code defines every field; no run holds a placeholder)', () => {
  assert.deepEqual(Object.keys(FINDINGS_WIN32), [
    'not-routed', 'opt-in-needed', 'shim-not-on-path', 'not-via-entry', 'entry-changed', 'needs-admin', 'egress-differs', 'elevated-agent', 'proxy-dead',
    'upstream-unreachable', 'engine-port-taken', 'forwarder-down', 'form-unsupported', 'proxy-unsupported',
    'system-proxy-pac', 'other-redirector', 'socktable-unavailable', 'cause-unknown',
  ])
  for (const [code, entry] of Object.entries(FINDINGS_WIN32)) {
    assert.equal(typeof entry.commands, 'function', `${code}: the commands are a function of the context`)
    const own = !FINDINGS[code]
    if (own) for (const f of ['cls', 'what', 'why', 'verify']) assert.ok(entry[f] !== undefined, `${code}: a code the cross-platform catalogue does not have defines ${f} itself`)
    const c = CTX({ h: 'codex', code, F: {}, dead: { addr: '127.0.0.1', port: 7890 }, enginePort: 17990, upPort: 7897, port: 17992, reason: 'port-taken', protocol: 'socks4',
      fm: { id: 'codex.app', entryPlace: { kind: 'file', file: 'C:\\Users\\u\\.codex\\.env', format: 'dotenv', key: 'HTTPS_PROXY' }, route: { reason: 'not-routed', why: 'system-proxy-pac' }, setting: null, systemProxy: null, procs: [] },
      hf: { forms: [], behaviour: {}, systemProxy: null }, setting: { scheme: 'socks4' } })
    const cls = typeof entry.cls === 'function' ? entry.cls(c) : entry.cls
    const finding = { code, class: cls === undefined ? 'failure' : cls, harness: 'codex',
      what: entry.what ? entry.what(c) : '(the cross-platform catalogue\'s own words)', why: entry.why ? entry.why(c) : '(the cross-platform catalogue\'s own words)',
      commands: entry.commands(c), verify: entry.verify ? entry.verify(c) : '(the cross-platform catalogue\'s own words)' }
    assert.deepEqual(validateFinding(finding), [], `${code}: the schema accepts the entry's own output`)
    for (const x of finding.commands) assert.ok(!/<[^>\n]+>/.test(x.run), `${code}: ${x.run} holds a placeholder`)
    if (entry.asightFirst && finding.commands.some((x) => x.shell !== 'gui')) assert.ok(finding.commands[0].run.startsWith('asight '), `${code}: the first command is asight's`)
    assert.ok(FINDING_CODES.includes(code), `${code}: is in the finding codes' own list`)
  }
})

/** Every §10.4 row's commands with a filled context, as literals. `not-routed` and `forwarder-start-failed` have a variant each per their `why` / `reason`; the `reason` / `port` / `of` extras and the facts' `reinstall`
 *  lines are what the daemon's failure records will hand `diagnose` once /status relays them. */
const LITERALS = {
  'not-routed': {
    pac: { ctx: CTX({ h: 'codex', pac: true, fm: { id: 'codex.app', route: { reason: 'not-routed', why: 'system-proxy-pac' }, entryPlace: { kind: 'file', file: 'C:\\Users\\u\\.codex\\.env', format: 'dotenv', key: 'HTTPS_PROXY' } } }),
      what: 'codex 的形态 codex.app 的新连接不经过 asight', why: '这个形态跟随的系统代理是 PAC,asight 不执行 PAC,所以没接这个形态',
      commands: [cmd('在你的代理软件里看它的本地端口,把 codex 的代理设成它:C:\\Users\\u\\.codex\\.env 里写一行 HTTPS_PROXY=不知道 · pac(你的代理地址)', 'gui'), A('asight on codex')], verify: 'asight status codex:那一支「在路径上 · 是」' },
    'system-proxy-unreadable': { ctx: CTX({ h: 'codex', fm: { id: 'codex.app', route: { reason: 'not-routed', why: 'system-proxy-unreadable', detail: 'denied' } } }),
      why: '助手这一次没读到系统代理(denied),asight 不猜它是不是开着,所以没接这个形态(on 之后读不到的是提示,不是失败:留在上一次的上游)',
      commands: [A('asight on codex'), A('asight doctor codex'), cmd('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable')] },
    'upstream-unparseable': { ctx: CTX({ h: 'claude-code', fm: { id: 'claude-code.cli', route: { reason: 'not-routed', why: 'upstream-unparseable' }, entryPlace: { kind: 'file', file: 'C:\\Users\\u\\.claude\\settings.json', format: 'json', key: 'env.HTTPS_PROXY' } } }),
      why: '这个形态原来的代理值 asight 读不懂,所以没接这个形态(asight status 印出它的入口文件与那一行,值里的用户名与口令打码)',
      commands: [cmd('把它改成一个 asight 读得懂的写法(http://host:port 或 socks5://host:port):', 'gui'), cmd('用记事本打开 C:\\Users\\u\\.claude\\settings.json,把 env.HTTPS_PROXY 写成 "不知道 · absent(你的代理地址)"', 'gui'), A('asight on claude-code'), A('asight off claude-code')] },
    'credentials-in-system-proxy': { ctx: CTX({ h: 'codex', fm: { id: 'codex.app', route: { reason: 'not-routed', why: 'upstream-unparseable', detail: 'credentials-in-system-proxy' }, entryPlace: { kind: 'file', file: 'C:\\Users\\u\\.codex\\.env', format: 'dotenv', key: 'HTTPS_PROXY' } } }),
      why: '系统代理的 ProxyServer 里带了用户名口令,WinINET 本来就不从这个值取凭据,asight 不照读,所以没接这个形态',
      commands: [cmd('在系统代理设置里把用户名口令从代理地址里去掉(WinINET 本来就不取它们);要凭据的代理写进这个 agent 自己的代理设置:', 'gui'), cmd('C:\\Users\\u\\.codex\\.env 里写一行 HTTPS_PROXY=不知道 · absent(你的代理地址)', 'gui'), A('asight on codex'), A('asight off codex')] },
    'no-why': { ctx: CTX({ h: 'kimi-code', fm: null }),
      why: '这个形态没有 asight 能用的入口',
      commands: [cmd('kimi-code 的这个形态没有入口:改用它的 CLI 形态', 'gui'), A('asight status kimi-code')] },
  },
  'opt-in-needed': { ctx: CTX({ h: 'kimi-code', form: 'kimi-code.cli', enable: 'asight on kimi-code --opt-in kimi-code.cli' }),
    commands: [A('asight on kimi-code --opt-in kimi-code.cli')], verify: 'asight status kimi-code:该支「是」' },
  'shim-not-on-path': { ctx: CTX({ h: 'kimi-code', form: 'kimi-code.cli', enable: 'asight on kimi-code --opt-in kimi-code.machine', fm: { entryPlace: { kind: 'shim', command: 'kimi' } } }),
    commands: [cmd('where.exe kimi'), A('asight on kimi-code --opt-in kimi-code.machine'), cmd('或卸掉机器级的那一份,改用用户级安装', 'gui')], verify: 'where.exe kimi 第一个是 asight 的 shim' },
  'not-via-entry': { ctx: CTX({ h: 'opencode' }),
    commands: [cmd('退出它,从开始菜单(asight 改过的快捷方式)或新开的终端启动', 'gui'), cmd('任务栏固定的:取消固定,再从开始菜单固定一次', 'gui')], verify: 'asight status opencode:新 pid「是」' },
  'entry-changed': { ctx: CTX({ h: 'z-code' }), commands: [A('asight on z-code')], verify: 'asight status z-code' },
  'needs-admin': { ctx: CTX({ h: 'kimi-code', elevated: 'Start-Process powershell -Verb RunAs -ArgumentList "…"' }),
    commands: [cmd('正常路径:asight 先确认、再弹 UAC,你点「是」;没有提示可弹时才用下面那一整行,在你自己开的管理员 PowerShell 里跑', 'gui'), A('Start-Process powershell -Verb RunAs -ArgumentList "…"')], verify: 'asight status:不再列' },
  'egress-differs': { ctx: CTX({ h: 'codex' }), commands: [A('asight off codex')], verify: '—' },
  'fallback-active': { ctx: CTX({ h: 'codex', enginePort: 17990 }),
    what: '引擎不在,内核把 agent 的连接只转发到上游(回退)', why: '引擎死了或没起来;内核自己活着,连接不断但不再被采集',
    commands: [A('asight on'), cmd('netstat -ano -p TCP | findstr ":17990"')], verify: 'asight status:那一形态不再报' },
  'elevated-agent': { ctx: CTX({ h: 'claude-code' }),
    commands: [cmd('关掉它,不用「以管理员身份运行」重新打开 claude-code', 'gui'), cmd('whoami /groups | findstr /i "Mandatory"')], verify: 'asight status claude-code' },
  'proxy-dead': { ctx: CTX({ h: 'claude-code', dead: { addr: '127.0.0.1', port: 7890 } }),
    commands: [cmd('netstat -ano -p TCP | findstr ":7890"'), cmd('打开你的代理软件(它应该监听 127.0.0.1:7890)', 'gui'), cmd('或者关掉指着它的系统代理', 'gui')], verify: '同一条命令看到 LISTENING' },
  'upstream-unreachable': { ctx: CTX({ h: 'codex', upPort: 7897 }),
    commands: [cmd('netstat -ano -p TCP | findstr ":7897"'), cmd('打开你的代理软件,或关掉指着它的系统代理', 'gui')], verify: 'asight status codex:那一跳有属主' },
  'engine-port-taken': { ctx: CTX({ h: 'codex', enginePort: 17990 }),
    what: '引擎的入口端口被别的进程占了', why: '引擎因此起不来;asight on 会重选端口、重载内核配置',
    commands: [cmd('netstat -ano -p TCP | findstr ":17990"'), A('asight off'), A('asight on')], verify: 'asight status:引擎「在跑」' },
  'forwarder-down': { ctx: CTX({ h: 'codex' }),
    commands: [A('asight on'), A('asight off codex'), cmd('马上要用:上一步之后重启 codex,它就不经 asight 了', 'gui')], verify: 'asight status:内核「在跑」' },
  'form-unsupported': { ctx: CTX({ h: 'claude-code', fm: { id: 'claude-code.desktop' } }),
    what: 'claude-code 的形态 claude-code.desktop 收不了带凭据的上游', why: '它的入口没有口令(免鉴权的端口),asight 不把带用户名口令的代理接给它',
    commands: [cmd('改用 claude-code 的 CLI 或编辑器扩展形态', 'gui')], verify: '—' },
  'proxy-unsupported': { ctx: CTX({ h: 'deepseek-dsh', protocol: 'socks4', fm: { entryPlace: { kind: 'file', file: 'C:\\Users\\u\\.dsh\\.env', format: 'dotenv', key: 'HTTPS_PROXY' } } }),
    what: 'deepseek-dsh 的代理协议接不上(socks4)', why: '这个形态原来的代理是 socks4 的,asight 的上游还不支持,on 因此不接这个形态',
    commands: [cmd('把它改成 http://host:port 或 socks5://host:port 的写法', 'gui'), cmd('C:\\Users\\u\\.dsh\\.env 里写一行 HTTPS_PROXY=不知道 · absent(你的代理地址)', 'gui'), A('asight on deepseek-dsh'), A('asight off deepseek-dsh')], verify: 'asight status deepseek-dsh:那一支「在路径上 · 是」' },
  'system-proxy-pac': { ctx: CTX({}),
    commands: [cmd("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name AutoConfigURL")], verify: '—' },
  'other-redirector': { ctx: CTX({}), commands: [cmd('netsh winsock show catalog')], verify: '—' },
  'socktable-unavailable': { ctx: CTX({}),
    what: '连接属主的套接字表读不到,按形态判信任', why: 'asight 宁可不知道也不猜属主;同形态的新进程要等旧进程退出才分得开',
    commands: [cmd('无需操作:按形态判信任,同形态的新进程要等旧进程退出后分开', 'gui')], verify: '—' },
  'cause-unknown': { ctx: CTX({ h: 'codex' }), commands: [A('asight off codex'), cmd('再试 codex:仍连不上 → 与 asight 无关', 'gui')], verify: '再试 codex' },
}

test('W36 each §10.4 command equals its literal (the values filled: the entry file and its key, the ports of the facts — no placeholder, no download address)', () => {
  const one = (name, spec, entry, ctx) => {
    assert.deepEqual(entry.commands(ctx), spec.commands, `${name}: the commands, as literals`)
    if (spec.verify) assert.equal(entry.verify(ctx), spec.verify, `${name}: how to check`)
    if (spec.why) assert.equal(entry.why(ctx), spec.why, `${name}: the why`)
    if (spec.what) assert.equal(entry.what(ctx), spec.what, `${name}: the what`)
  }
  for (const [code, spec] of Object.entries(LITERALS)) {
    const entry = FINDINGS_WIN32[code]
    for (const [variant, half] of Object.entries(spec)) {
      if (!half || !half.ctx) continue
      one(variant === 'ctx' ? code : `${code}(${variant})`, half, entry, { ...half.ctx, ...(code === 'forwarder-start-failed' ? { reason: variant } : {}) })
    }
  }
})

test('W36 the not-routed 「set it to your proxy app\'s port」 step is table-driven over every groups[].proxyEntry of the seven harnesses, none missing (4.8 §10.4 row 1)', async () => {
  const home = tmpDir('asight-w36-places-')
  // the homes the entries live in, so every group's place resolves to a real path (an inject whose home is absent returns no entries, and the place would be empty)
  for (const [file, text] of [[path.join(home, '.codex', '.env'), ''], [path.join(home, 'AppData', 'Local', 'hermes', '.env'), ''], [path.join(home, '.zcode', 'cli', 'config.json'), '{}\n']]) put(file, text)
  const f = await gather(home, { helper: helperOf({ procs: [KERNEL_ROW] }), ids: SEVEN })
  const EXPECT = {
    'claude-code.settings': { kind: 'file', file: path.join(home, '.claude', 'settings.json'), format: 'json', key: 'env.HTTPS_PROXY' },
    'claude-code.desktop': { kind: 'policy', path: 'HKCU\\SOFTWARE\\Policies\\Claude', name: 'egressProxyUrl' },
    'codex.env': { kind: 'file', file: path.join(home, '.codex', '.env'), format: 'dotenv', key: 'HTTPS_PROXY' },
    'hermes.cli': { kind: 'file', file: path.join(home, 'AppData', 'Local', 'hermes', '.env'), format: 'dotenv', key: 'HTTPS_PROXY' },
    'deepseek-dsh.env': { kind: 'file', file: path.join(home, '.dsh', '.env'), format: 'dotenv', key: 'HTTPS_PROXY' },
    'kimi-code.cli': { kind: 'shim', command: 'kimi' },
    'kimi-code.vscode': { kind: 'file', file: path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json'), format: 'json', key: 'http.proxy' },
    'opencode.cli': { kind: 'shim', command: 'opencode' },
    'opencode.desktop': { kind: 'launcher', shortcut: 'OpenCode.lnk' },
    'z-code.cli': { kind: 'file', file: path.join(home, '.zcode', 'cli', 'config.json'), format: 'json', key: 'network.httpProxy' },
    'z-code.desktop': { kind: 'file', file: path.join(home, '.zcode', 'v2', 'setting.json'), format: 'json', key: 'httpProxy' },
  }
  const groups = groupsOf(all)
  assert.deepEqual([...new Set(groups.map((x) => x.g))].sort(), Object.keys(EXPECT).sort(), 'every group of every harness has its place written out — none missing')
  const stepText = (place) => {
    if (place.kind === 'file') return place.format === 'json' ? `用记事本打开 ${place.file},把 ${place.key} 写成 "不知道 · pac(你的代理地址)"` : `${place.file} 里写一行 ${place.key}=不知道 · pac(你的代理地址)`
    if (place.kind === 'policy') return `在注册表策略 ${place.path} 里把 ${place.name} 写成 不知道 · pac(你的代理地址)(regedit)`
    if (place.kind === 'shim') return `${place.command} 的代理入口是 asight 的 shim(${place.command}.cmd 设 HTTPS_PROXY):没有你可以改的自己的代理项`
    return '这个形态的代理入口是 asight 的启动器:没有你可以改的自己的代理项(不经它启动的连接 asight 不在路径上)'
  }
  for (const x of groups) {
    const mine = (f.harnesses[x.harness].forms || []).filter((fm) => x.forms.some((y) => y.id === fm.id))
    assert.ok(mine.length >= 1, `${x.g}: its forms are in the facts`)
    for (const fm of mine) assert.deepEqual(fm.entryPlace, EXPECT[x.g], `${fm.id}: the entry place, as the real facts path fills it`)
    const step = FINDINGS_WIN32['not-routed'].commands(CTX({ h: x.harness, pac: true, fm: { id: x.forms[0].id, entryPlace: EXPECT[x.g] } }))[0]
    assert.equal(step.shell, 'gui')
    assert.equal(step.run, `在你的代理软件里看它的本地端口,把 ${x.harness} 的代理设成它:${stepText(EXPECT[x.g])}`, `${x.g}: the step, generated from the group's own proxyEntry`)
  }
})

test('W36 not-routed by why, through the REAL facts path: a PAC, a registry the helper could not read, an unparseable prior and credentials in the system proxy each give their own why and commands — and the credentials never appear', async () => {
  const verge = { pid: 11800, name: 'verge-mihomo.exe', exe: 'C:\\Program Files\\Clash Verge\\verge-mihomo.exe', startedAt: 1759000000000, sessionId: 1, integrity: 'medium', tokenDenied: false, cmdline: null, cmdlineState: 'not-asked' }
  // a PAC, with a proxy app listening on its own port in the facts: the value of the step is still said unknown (D49)
  const pacHome = tmpDir('asight-w36-pac-')
  put(path.join(pacHome, '.codex', '.env'), '')
  const pacHelper = helperOf({ procs: [KERNEL_ROW, verge], listen: [{ pid: 11800, state: 'listen', localAddr: '127.0.0.1', localPort: 7897, remoteAddr: '0.0.0.0', remotePort: 0 }],
    internet: { ProxyEnable: { kind: 'REG_DWORD', value: 1 }, AutoConfigURL: { kind: 'REG_SZ', value: 'http://pad.example/proxy.pac' } } })
  const pacFacts = await gatherNetFacts({ platform: 'win32', home: pacHome, env: {}, harnesses: all, status: statusOf(['codex']), netenv: { result: { products: [], unknown: [] } }, archFacts: gatherWin32Facts, adopted: null, now: () => NOW,
    deps: { helper: pacHelper } })
  const fm = pacFacts.harnesses.codex.forms.find((x) => x.id === 'codex.app')
  assert.deepEqual(fm.route, { reason: 'not-routed', code: 'not-routed', why: 'system-proxy-pac' }, 'the group\'s plan, on the form (the doctor rows read it)')
  assert.equal(pacFacts.reinstall, null, 'no reinstall line any more: the kernel is gone and nothing of asight downloads (D47\'s twin)')
  const pac = diagnose({ facts: pacFacts, topology: buildTopology(pacFacts), harnesses: ['codex'], user: 'u' }).find((x) => x.code === 'not-routed')
  assert.match(pac.why, /PAC/)
  assert.deepEqual(pac.commands, [
    { run: `在你的代理软件里看它的本地端口,把 codex 的代理设成它:${path.join(pacHome, '.codex', '.env')} 里写一行 HTTPS_PROXY=不知道 · pac(你的代理地址)`, shell: 'gui' },
    { run: 'asight on codex', shell: 'powershell' },
  ], 'the value to write is said unknown (D49: asight does not know the proxy app\'s port), never a placeholder')
  assert.equal(pac.verify, 'asight status codex:那一支「在路径上 · 是」')
  assert.deepEqual(validateFinding(pac), [])
  // the helper could not read the registry: retry, the doctor's helper line, and the hand-read
  const deadHome = tmpDir('asight-w36-deadreg-')
  const deadFacts = await gather(deadHome, { helper: helperOf({ procs: [KERNEL_ROW], internetFail: true }), ids: ['codex'] })
  const unreadable = diagnose({ facts: deadFacts, topology: buildTopology(deadFacts), harnesses: ['codex'], user: 'u' }).find((x) => x.code === 'not-routed')
  assert.ok(unreadable, 'the follower is not routed when the registry cannot be read')
  assert.match(unreadable.why, /助手这一次没读到系统代理\(absent\)/, 'the detail reason is shown (a helper error reads as absent: the helper is not there to ask)')
  assert.ok(unreadable.commands.some((c) => c.run === 'asight on codex' && c.shell === 'powershell') && unreadable.commands.some((c) => c.run === 'asight doctor codex'), 'retry, and the helper\'s own line in the doctor')
  assert.deepEqual(unreadable.commands[unreadable.commands.length - 1], { run: 'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable', shell: 'powershell' }, 'the hand-read')
  // an unparseable prior: the entry file and the line to write, then on — or off, not to capture it
  const badHome = tmpDir('asight-w36-badprior-')
  put(path.join(badHome, '.codex', '.env'), 'HTTPS_PROXY=http://a,b:3128\n')
  const badFacts = await gather(badHome, { helper: helperOf({ procs: [KERNEL_ROW] }), ids: ['codex'] })
  const unparseable = diagnose({ facts: badFacts, topology: buildTopology(badFacts), harnesses: ['codex'], user: 'u' }).find((x) => x.code === 'not-routed')
  assert.match(unparseable.why, /读不懂/, 'the unparseable prior')
  assert.ok(unparseable.commands.some((c) => c.shell === 'gui' && c.run.includes(`${path.join(badHome, '.codex', '.env')} 里写一行 HTTPS_PROXY=`)), 'the entry file and the line to write')
  assert.ok(unparseable.commands.some((c) => c.run === 'asight off codex'), '不想改就 off,不采它')
  // credentials in the system proxy: WinINET takes no login from that value — and the credentials themselves never appear
  const credHome = tmpDir('asight-w36-cred-')
  const credFacts = await gather(credHome, { helper: helperOf({ procs: [KERNEL_ROW], internet: { ProxyEnable: { kind: 'REG_DWORD', value: 1 }, ProxyServer: { kind: 'REG_SZ', value: 'http://alice:pw@127.0.0.1:7897' } } }), ids: ['codex'] })
  const inSys = diagnose({ facts: credFacts, topology: buildTopology(credFacts), harnesses: ['codex'], user: 'u' }).find((x) => x.code === 'not-routed')
  assert.match(inSys.why, /WinINET 本来就不从这个值取凭据/, 'the credentials-in-system-proxy detail says it')
  assert.ok(inSys.commands[0].run.includes('把用户名口令从代理地址里去掉'), 'the step takes them out of the system proxy')
  assert.ok(!JSON.stringify(inSys).includes('alice') && !JSON.stringify(inSys).includes(':pw@'), 'the credentials are never printed')
  assert.ok(!JSON.stringify(credFacts).includes('alice') && !JSON.stringify(credFacts).includes(':pw@'), 'nor are they anywhere in the facts')
})

test('W36 upstream-protocol through the REAL facts path: a socks4 prior in the entry file leaves the group unwired (the branch still says not-routed — upstream-protocol is not a status reason of its own), and diagnose swaps that not-routed for the one proxy-unsupported finding with the protocol filled (4.8 §10.4)', async () => {
  const home = tmpDir('asight-w36-proto-')
  put(path.join(home, '.dsh', '.env'), 'HTTPS_PROXY=socks4://proxy.corp:1080\n') // never a manifest record: `on` refuses to wire the group, so there is nothing to record
  const f = await gather(home, { helper: helperOf({ procs: [KERNEL_ROW] }), ids: ['deepseek-dsh'] })
  const fm = f.harnesses['deepseek-dsh'].forms[0]
  assert.deepEqual(fm.route, { reason: 'not-routed', code: 'proxy-unsupported', why: 'upstream-protocol', protocol: 'socks4' }, "the plan's own words on the form (planRoutes → routeOf): the doctor's name for the reason, the protocol it refused")
  const t = buildTopology(f)['deepseek-dsh']
  assert.deepEqual([t.on_path, t.captured, t.reason], [false, false, 'not-routed'], "the verdict stays not-routed: upstream-protocol is not in the status reasons' closed set — the doctor's table is where the protocol is said")
  const found = diagnose({ facts: f, topology: buildTopology(f), harnesses: ['deepseek-dsh'], user: 'u' })
  assert.ok(!found.some((x) => x.code === 'not-routed'), 'the not-routed the swap replaces is not also said (before this test, replacing diagnose\'s protoForm with null kept every suite green)')
  const one = found.find((x) => x.code === 'proxy-unsupported')
  assert.ok(one, 'the proxy-unsupported finding')
  assert.equal(one.what, 'deepseek-dsh 的代理协议接不上(socks4)', 'the protocol, filled from the plan')
  assert.equal(one.why, '这个形态原来的代理是 socks4 的,asight 的上游还不支持,on 因此不接这个形态', "the upstream-side why — not the agent's own unsupported-scheme words")
  assert.deepEqual(one.commands, [
    { run: '把它改成 http://host:port 或 socks5://host:port 的写法', shell: 'gui' },
    { run: `${path.join(home, '.dsh', '.env')} 里写一行 HTTPS_PROXY=不知道 · absent(你的代理地址)`, shell: 'gui' },
    { run: 'asight on deepseek-dsh', shell: 'powershell' },
    { run: 'asight off deepseek-dsh', shell: 'powershell' },
  ], 'the step names the group\'s own entry file and the line to write (no VPN on this machine: the value to write is said unknown, never a placeholder)')
  assert.equal(one.verify, 'asight status deepseek-dsh:那一支「在路径上 · 是」')
  assert.deepEqual(validateFinding(one), [])
})

test('W36 form-unsupported: the plan\'s own reason is the branch\'s verdict (a status reason), and the finding says which form to use instead', () => {
  const f = pfacts('claude-code', form('claude-code.desktop', { entry: null, route: { reason: 'form-unsupported' }, procs: [proc(8801, { name: 'Claude', exe: 'C:\\Program Files\\Claude\\Claude.exe', version: null })] }), fwForm(17996))
  const t = buildTopology(f)['claude-code']
  assert.deepEqual([t.on_path, t.captured, t.reason], [false, false, 'form-unsupported'], 'the plan\'s reason names the verdict (not the generic not-routed)')
  assert.deepEqual(validateTopology({ 'claude-code': t }), [], 'and it is a status reason the schema accepts')
  const found = diagnose({ facts: f, topology: { 'claude-code': t }, harnesses: ['claude-code'], user: 'u' }).find((x) => x.code === 'form-unsupported')
  assert.equal(found.what, 'claude-code 的形态 claude-code.desktop 收不了带凭据的上游')
  assert.deepEqual(found.commands, [{ run: '改用 claude-code 的 CLI 或编辑器扩展形态', shell: 'gui' }])
})

test('W36 form-unsupported through the REAL facts path: a named Claude Desktop (its ledger records) with a credentialed login-environment proxy — planRoutes leaves the group unwired, routeOf carries the reason on the form, the verdict says it (not the unknown of an unchecked policy entry) and diagnose emits the row; the settings group of the same harness stays wired (4.8 §2.2 · §6.4)', async () => {
  const home = tmpDir('asight-w36-form-')
  const { dir } = collectorOf(home, { groupPorts: { 'claude-code.settings': 17991, 'claude-code.desktop': 17996 } })
  // what a real `on --opt-in claude-code.desktop` leaves in the ledger: the item's two records (the certificate and the policy value — Task 14's apply writes both)
  const manifest = readManifest(dir, fs)
  for (const kind of ['optin-cert-user', 'optin-claude-policy']) manifest.entries.push({ phase: 'on', kind, harness: 'claude-code', form: 'claude-code.desktop', item: 'cert-store-current-user', scope: 'user', path: 'claude-code.desktop:cert-store-current-user' })
  saveManifest(dir, manifest, fs)
  // the desktop group's upstream: the login environment's proxy with the user's login in it — the policy value takes an address only (auth:false, 4.8 §3)
  const f = await gather(home, { helper: helperOf({ procs: [KERNEL_ROW], loginEnv: { HTTPS_PROXY: { kind: 'REG_SZ', value: 'http://alice:pw@corp.example:3128' } } }), ids: ['claude-code'] })
  const desktop = f.harnesses['claude-code'].forms.find((x) => x.id === 'claude-code.desktop')
  assert.deepEqual(desktop.route, { reason: 'form-unsupported', code: 'form-unsupported' }, "the plan's own reason on the form (planRoutes → routeOf)")
  assert.equal(desktop.optIn.state, 'done', 'the ledger says the item was applied')
  assert.deepEqual(desktop.entry, { where: '策略 egressProxyUrl', asight: true, opt_in: true, intact: null }, "the entry edge is the ledger's word — the policy value's read-back is checkEntries' (Task 14), so intact is unknown")
  assert.equal(desktop.setting.value, 'http://***@corp.example:3128', 'the upstream the plan refused is the login environment\'s proxy, redacted of the login')
  const t = buildTopology(f)['claude-code']
  const branch = t.branches.find((b) => b.form === 'claude-code.desktop')
  assert.deepEqual([branch.on_path, branch.captured, branch.reason], [false, false, 'form-unsupported'], "the verdict names the plan's reason (before the fix the unknown-intact entry masked it and this said [null, null, null], so the doctor could never emit the row)")
  assert.deepEqual(branch.path.map((id) => kindOf(t, id)), ['agent', 'proxy', 'egress'], 'the gated group draws no kernel hop — the agent and the proxy it would have used')
  assert.ok(t.branches.find((b) => b.form === 'claude-code.cli').path.some((id) => kindOf(t, id) === 'asight-forwarder'), 'the settings group of the same harness is wired: the gate is this group\'s own, not the harness\'s')
  assert.deepEqual(validateTopology({ 'claude-code': t }), [], 'form-unsupported is a status reason the schema accepts (1.6 §9.6)')
  const found = diagnose({ facts: f, topology: buildTopology(f), harnesses: ['claude-code'], user: 'u' }).find((x) => x.code === 'form-unsupported')
  assert.ok(found, 'the doctor row (before the fix, diagnose read the reason off the branches and no branch carried it)')
  assert.equal(found.what, 'claude-code 的形态 claude-code.desktop 收不了带凭据的上游')
  assert.deepEqual(found.commands, [{ run: '改用 claude-code 的 CLI 或编辑器扩展形态', shell: 'gui' }])
  assert.ok(!JSON.stringify(f).includes('alice') && !JSON.stringify(f).includes(':pw@'), 'the login of the login-environment proxy is nowhere in the facts')
  assert.ok(!JSON.stringify(found).includes('alice'), 'nor in the finding')
})

test('W36 the static scans (4.8 E6): findings-win32.mjs has no command that changes Smart App Control, and the port check is always the netstat + findstr form', () => {
  const src = fs.readFileSync(path.join(REPO, 'src/netenv/findings-win32.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '') // the code, not its comments (which say why each of these is absent)
  for (const bad of ['Set-ItemProperty', 'reg add', 'CI\\Policy', 'Get-NetTCPConnection']) assert.ok(!src.includes(bad), `${bad} is not in the Windows doctor table`)
  assert.ok((src.match(/netstat -ano -p TCP \| findstr/g) || []).length >= 1, 'the port check is the netstat + findstr form')
})
