// test/netenv/topology-win32.test.mjs — RFC 4.8 §10.2 (W29): every row a–s drawn from facts, literally (the node kinds, the verdict, the compact text — the row's own NetFacts is in
// fixtures/rows-win32.mjs, written by hand), and the machinery those rows share driven through the REAL gatherNetFacts path (archFacts = gatherWin32Facts) with injected readers:
// the entry edge (the manifest's record and the file's read-back), the elevated detector (integrity, or a token that will not open while the image path reads — the latter inferred),
// the 「不知道 · env-unreadable」 of a proxy that lives only in the starting terminal, the host set of an opted-in Kimi VS Code extension and the VPN the probe saw. Nothing here
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
import { readManifest } from '../../src/off/manifest.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { ROWS } from './fixtures/rows-win32.mjs'
import { squash } from './fixtures/rows.mjs'

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

test('W29 the one line about the user\'s VPN per-process rules: in `status <h>` for every row whose machine has a VPN / proxy product (a–e), absent for row f — and it is a line of the detail view, not a note of the topology, so `on`\'s plan (which renders the notes) never prints it', () => {
  const LINE = (h) => `你的 VPN 按进程分流时,看到的来源是 asight,不是 ${h}`
  for (const row of ROWS) {
    const t = buildTopology(row.facts)[row.h]
    const detail = renderDetail(t, { now: NOW }).join('\n')
    assert.equal(detail.includes(LINE(row.h)), row.vpnLine === true, `row ${row.n}: the line is ${row.vpnLine ? 'there' : 'not there'}`)
    assert.ok(!t.notes.some((n) => /按进程分流/.test(n)), `row ${row.n}: it is not a note, so nothing else renders it`)
  }
  assert.ok(ROWS.filter((r) => r.vpnLine).length >= 5, 'a–e are covered')
})

test('W29 row e (v2rayN) names the product the probe gave and nothing else about it: no rule, no secret, no node name of the user\'s', () => {
  const row = ROWS.find((r) => r.n === 'e'), t = buildTopology(row.facts).codex
  const hop = t.nodes.find((n) => n.kind === 'proxy')
  assert.deepEqual([hop.product, hop.port], ['v2rayn', 10808])
  assert.equal(renderCompact(t)[0].includes('v2rayN :10808'), true)
  for (const n of t.nodes) assert.ok(!/password|secret|HK-|proxies:/i.test(JSON.stringify(n)), 'nothing of the user\'s VPN but the product, mode and port')
})

// ---------- the machinery of those rows, through gatherNetFacts (archFacts = gatherWin32Facts) with injected readers ----------
/** A fake resident helper: the read verbs the facts ask, each answer shaped as the real one gives it (the ps rows carry the elevation facts of 4.8 §1). */
const helperOf = ({ procs = [], listen = [], established = [], ifaces = [{ name: 'Ethernet', description: 'Intel(R) Ethernet', up: true }], defaultIface = 'Ethernet', internet = { ProxyEnable: { kind: 'REG_DWORD', value: 0 } }, loginEnv = {} } = {}) => {
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
        if (args.key.endsWith('Internet Settings')) return { keyExists: true, values: internet }
        if (args.key === 'Environment') return { keyExists: true, values: loginEnv }
        throw Object.assign(new Error(`forbidden-key: ${args.key}`), { code: 'helper-forbidden-key' })
      }
      throw Object.assign(new Error(`not in the fake: ${verb}`), { code: 'helper-verb-error' })
    },
    close: async () => {},
  }
}
const statusOf = (ids, { agents = [], desired = 'on' } = {}) => ({
  daemon: { state: 'running', pid: 4121, reply: { engine: { port: 17990 }, links: [], negatives: [], agents }, lock: { engine_port: 17990 } },
  link: { attached: null, helper: 'ok', ids: [] },
  harnesses: ids.map((id) => ({ id, installed: true, desired, entry: { state: 'intact' }, installedAt: '2026-10-09T09:00:00.000Z', procs: [] })),
})
const gather = (home, { helper, ids = ['claude-code'], env = {}, agents = [], desired = 'on', manifest = null, netenv = { result: { products: [], unknown: [] } } } = {}) =>
  gatherNetFacts({ platform: 'win32', home, env, harnesses: all, status: { ...statusOf(ids, { agents, desired }), ...(manifest ? { manifest: { value: manifest, error: null } } : {}) }, netenv, archFacts: gatherWin32Facts, adopted: null, now: () => NOW, deps: { helper } })
const KERNEL_URL = 'http://claude-code.settings:s3-listener-token@127.0.0.1:17991'
/** The collector dir of an installed proxy mode: the kernel's lock, the ports of ingress.json, and the manifest's record of the entry that was written over the user's own proxy. */
function collectorOf(home, { url = KERNEL_URL, prior = 'http://proxy.corp:8080' } = {}) {
  const dir = path.join(home, '.asight', 'collector')
  put(path.join(dir, 'forwarder.lock'), `${JSON.stringify({ pid: 6120, startedAt: 1760000000000, endpoint: 'tcp:127.0.0.1:19001', config: path.join(dir, 'forwarder', 'config.json') })}\n`)
  put(path.join(dir, 'ingress.json'), `${JSON.stringify({ enginePort: 17990, groupPorts: { 'claude-code.settings': 17991 }, ingressToken: 'a'.repeat(32), listenerToken: 's3-listener-token' })}\n`)
  const settings = path.join(home, '.claude', 'settings.json')
  if (prior != null) put(settings, `${JSON.stringify({ env: { HTTPS_PROXY: prior } }, null, 2)}\n`)
  const manifest = newManifest()
  applyJsonKey({ dir, manifest, harness: 'claude-code', file: settings, keys: ['env', 'HTTPS_PROXY'], value: url, home, now: new Date('2026-10-09T09:00:00Z'), fs })
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
  assert.deepEqual(f.forwarder, { pid: 6120, up: true, forms: { 'claude-code.cli': { h: 'claude-code', port: 17991, state: 'forward-only', upstream: 'http://proxy.corp:8080', source: 'agent', clients: [] }, 'claude-code.vscode': { h: 'claude-code', port: 17991, state: 'forward-only', upstream: 'http://proxy.corp:8080', source: 'agent', clients: [] } } }, 'the daemon read back nothing on (links empty): said, and the plan says the group is wired')
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
  assert.ok(t.notes.includes('还有 1 个 agent 连着 asight 的内核,重启它们之后 asight 就完全退出'), t.notes.join(' / '))
  const lines = renderCompact(t)
  assert.ok(lines.some((l) => l.includes('claude 4121 → asight 自带内核 :17991(只转发) →')), lines.join(' / '))
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

test('the VPN of the machine, through the 4.7 probe over the helper\'s reads and the adapter\'s facts: the product names the listener, the per-process line\'s data is a fact of the topology (and none of it is a rule, a secret or a node of the user\'s)', async () => {
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
  const adapter = { fields: {}, running: true, runtime: { version: '2.5.7', mode: 'rule', mixedPort: 7897, tun: false }, controller: {} }
  const f = await gatherNetFacts({ platform: 'win32', home, env: {}, harnesses: all, status: statusOf(['claude-code']), netenv: { result: { products: [], unknown: [] } }, archFacts: gatherWin32Facts, adopted: null, now: () => NOW, deps: { helper, adapter } })
  assert.deepEqual(f.vpn, { product: 'clash-verge-rev', version: '2.5.7', pid: null, port: 7897, mode: 'rule', tun: false })
  assert.equal(f.listeners.find((l) => l.port === 7897).product, 'clash-verge-rev', 'the product names its own listener')
  const detail = renderDetail(buildTopology(f)['claude-code'], { now: NOW }).join('\n')
  assert.ok(detail.includes('你的 VPN 按进程分流时,看到的来源是 asight,不是 claude-code'), 'the one line, from the fact')
  const none = await gather(home, { helper: helperOf({ procs: [KERNEL_ROW, claudeRow(4121)] }) })
  assert.equal(none.vpn, null, 'no product running: no VPN is claimed')
})

test('the host set of an opted-in Kimi VS Code extension (4.8 §3.5, read-only): the defaults plus the relay of the extension\'s own settings, said when they cannot be read, and the names the kernel cannot meet are dropped — `status` changes nothing', async () => {
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

test('a helper that cannot be started, and one that answers nothing: every read it owned is an unknown with its reason, the routing stays proxy and nothing is invented (R11)', async () => {
  const home = tmpDir('asight-wf-dead-')
  collectorOf(home)
  const broken = { call: async () => { throw Object.assign(new Error('helper-down'), { code: 'helper-down' }) }, close: async () => {} }
  const f = await gather(home, { helper: broken, ids: ['codex'] })
  assert.equal(f.routing, 'proxy')
  assert.ok(f.unknowns.length >= 3, `the processes, the listeners and the interfaces are each said: ${JSON.stringify(f.unknowns)}`)
  for (const u of f.unknowns) assert.ok(['denied', 'timeout', 'absent', 'unparseable'].includes(u.reason), `${JSON.stringify(u)}: a reason of the closed set`)
  assert.deepEqual(f.listeners, [])
  assert.equal(f.forwarder.up, null, 'the kernel\'s lock is there, whether its pid lives is not: said, not guessed')
  assert.equal(f.harnesses.codex.systemProxy.unknown.reason, 'absent', 'the registry read did not happen (a harness that follows the OS proxy carries it: codex)')
})
