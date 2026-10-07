// test/netenv/topology.test.mjs — RFC 1.6 §9.2–§9.4: the path each harness's traffic takes, drawn from facts (V41 the table of §9.3 · V42 each hop concrete, an unreadable one said · V45 the way out of asight
// leaves the route as it was). Every row of test/netenv/fixtures/rows.mjs is one NetFacts and the topology it must give, written out literally; the facts are injected, nothing here reads the machine.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTopology, renderCompact, renderDetail } from '../../src/netenv/topology.mjs'
import { validateTopology, UNKNOWN_REASONS } from '../../src/cli/schema.mjs'
import { ROWS, facts, harness, proc, proxyOf, none, mihomoVpn, MIHOMO, pfacts, form, fwForm } from './fixtures/rows.mjs'

const kindOf = (t, id) => t.nodes.find((x) => x.id === id).kind

for (const row of ROWS) {
  test(`V41 row ${row.n}: ${row.title}`, () => {
    const topo = buildTopology(row.facts), t = topo[row.h]
    assert.deepEqual(t.branches.map((b) => b.path.map((id) => kindOf(t, id))), row.kinds, 'the kinds of the nodes on each branch')
    assert.deepEqual([t.on_path, t.captured, t.reason], [row.on_path, row.captured, row.reason], 'the verdict')
    for (const b of t.branches) assert.deepEqual([b.on_path, b.captured, b.reason], [row.on_path, row.captured, row.reason], 'every branch says the same of the harness')
    assert.deepEqual(validateTopology(topo), [], 'and the object is one the schema accepts (V43)')
  })
}

test('V42: every node has a kind and a name; an agent with a process has its pid; a proxy has its port and says what it is or that it does not know', () => {
  for (const row of ROWS) {
    const t = buildTopology(row.facts)[row.h]
    const running = row.facts.harnesses[row.h].procs.length > 0
    for (const n of t.nodes) {
      assert.ok(n.kind && n.name, `row ${row.n}: ${JSON.stringify(n)}`)
      if (n.kind === 'agent' && running) assert.ok(Number.isInteger(n.pid), `row ${row.n}: the agent has its pid`)
      if (n.kind === 'proxy') assert.ok(Number.isInteger(n.port) && (n.product || n.unknown || n.remote), `row ${row.n}: ${JSON.stringify(n)}`)
    }
  }
})

test('V42: an owner that cannot be read, a PAC and a controller that cannot be read are nodes with an unknown reason from the closed set, the hop is kept, and nothing says 「无」', () => {
  const ownerUnreadable = ROWS.find((r) => r.n === 21), pac = ROWS.find((r) => r.n === 22)
  const controllerDown = facts('claude-code', { listeners: [MIHOMO], vpn: mihomoVpn({ mode: 'unknown', tun: 'unknown', unknown: { reason: 'controller-unreadable', detail: 'ECONNREFUSED' } }) }, { setting: proxyOf('http://127.0.0.1:7890') })
  for (const [f, h, reason] of [[ownerUnreadable.facts, 'hermes', 'owner-unreadable'], [pac.facts, 'codex', 'pac'], [controllerDown, 'claude-code', 'controller-unreadable']]) {
    const t = buildTopology(f)[h]
    const n = t.nodes.find((x) => x.unknown)
    assert.equal(n.unknown.reason, reason)
    assert.ok(UNKNOWN_REASONS.includes(reason))
    assert.ok(t.branches.some((b) => b.path.includes(n.id)), 'the hop is on a path: not left out')
    assert.deepEqual(validateTopology({ [h]: t }), [])
  }
})

test('V42: a listener list that could not be read gives the proxy its reason, and one that was read and holds nobody gives 「没人在听」, never an unknown owner', () => {
  const setting = proxyOf('http://127.0.0.1:7890')
  const unread = buildTopology(facts('claude-code', { unknowns: [{ fact: 'listeners', reason: 'denied', detail: 'ss: EPERM' }] }, { setting }))['claude-code']
  assert.deepEqual(unread.nodes.find((n) => n.kind === 'proxy').unknown, { reason: 'denied', detail: 'ss: EPERM' })
  const nobody = buildTopology(facts('claude-code', {}, { setting }))['claude-code']
  const p = nobody.nodes.find((n) => n.kind === 'proxy')
  assert.deepEqual([p.down, p.unknown], [true, undefined])
})

test('running processes: one that still goes by the setting it started with, or that asight is not on the path of, is listed apart with the chain it really takes; the branch is drawn for the steered current one', () => {
  const f = facts('claude-code', { listeners: [MIHOMO], vpn: mihomoVpn() }, {
    setting: proxyOf('http://127.0.0.1:7890'),
    procs: [proc(4121), proc(3990, { startedAt: '2026-10-07T08:00:00.000Z', watched: 'no-decrypt', trusted: false, reason: 'config-after-start', startSetting: { value: 'http://proxy.corp:8080', scheme: 'http', host: 'proxy.corp', port: 8080, source: [{ kind: 'env', where: 'HTTPS_PROXY' }] } })],
  })
  const t = buildTopology(f)['claude-code']
  assert.deepEqual(t.branches[0].path.map((id) => kindOf(t, id)), ['agent', 'asight-engine', 'proxy', 'egress'])
  assert.equal(t.nodes.find((n) => n.id === t.branches[0].path[0]).pid, 4121)
  assert.equal(t.running.length, 1)
  assert.deepEqual([t.running[0].pid, t.running[0].note, t.running[0].reason], [3990, 'start-time-settings', 'config-after-start'])
  assert.deepEqual(t.running[0].path.map((id) => kindOf(t, id)), ['agent', 'proxy', 'egress'], 'it never went through asight: its chain has none')
  assert.equal(t.nodes.find((n) => n.id === t.running[0].path[1]).name, 'proxy.corp:8080', 'and goes to the proxy it started with')
  assert.deepEqual(validateTopology({ 'claude-code': t }), [])
  // only stale processes: nothing to draw the branch for, so it is a new process's: no pid, asight on the path
  const stale = buildTopology(facts('claude-code', {}, { procs: [proc(3990, { startSetting: { value: null, scheme: null, host: null, port: null, source: [] } })] }))['claude-code']
  assert.equal(stale.nodes.find((n) => n.kind === 'agent' && n.pid === undefined).name, 'claude-code')
  assert.equal(stale.on_path, true)
})

test('a harness with no process, no proxy and everything up is on the path, and one whose entry is gone is not (a new process would not be trusted)', () => {
  const up = buildTopology(facts('kimi-code', {}, { procs: [] }))['kimi-code']
  assert.deepEqual([up.on_path, up.captured, up.reason], [true, true, null])
  const gone = buildTopology(facts('kimi-code', {}, { procs: [], entry: { state: 'missing' } }))['kimi-code']
  assert.deepEqual([gone.on_path, gone.captured, gone.reason], [false, false, 'entry-missing'])
  assert.deepEqual(gone.branches[0].path.map((id) => kindOf(gone, id)), ['agent', 'upstream'])
})

test('every value of the NetFacts the builder reads can be null / unknown without it throwing: a topology that cannot be drawn says so and keeps the verdict unknown', () => {
  const t = buildTopology({ ...facts('claude-code'), harnesses: { 'claude-code': null } })['claude-code']
  assert.equal(t.captured, null)
  assert.equal(t.on_path, null)
  assert.match(t.notes.join(' '), /could not be worked out/)
  assert.deepEqual(validateTopology({ 'claude-code': t }), [])
  void harness; void none
})

test('rows with a note: what the chain cannot say by itself (the agents still on the kernel after `off`, the entry to ask for, the filters nobody can see) is a note of the topology, rendered under 「说明」', () => {
  const noted = ROWS.filter((r) => r.notes)
  assert.deepEqual(noted.map((r) => r.n), [14, 15, 23])
  for (const r of noted) assert.deepEqual(buildTopology(r.facts)[r.h].notes, r.notes, `row ${r.n}`)
  for (const r of ROWS.filter((x) => !x.notes)) assert.deepEqual(buildTopology(r.facts)[r.h].notes, [], `row ${r.n} has nothing to add`)
})

test('proxy mode: one branch per form, a form with HTTP and WebSocket apart gets two that share the path with asight and differ in the way out (Codex, the OS proxy on)', () => {
  const row = ROWS.find((r) => r.n === 9), t = buildTopology(row.facts).codex
  assert.deepEqual(t.branches.map((b) => [b.name, b.form]), [['http', 'codex.cli'], ['ws', 'codex.cli']])
  assert.deepEqual(t.branches[0].path, t.branches[1].path)
  assert.notDeepEqual(t.branches[0].off_path, t.branches[1].off_path)
  assert.deepEqual(t.branches[0].off_path.map((id) => kindOf(t, id)), ['agent', 'proxy', 'egress'], 'HTTP goes through the OS proxy without asight')
  assert.deepEqual(t.branches[1].off_path.map((id) => kindOf(t, id)), ['agent', 'upstream'], 'the WebSocket goes direct')
  const entry = t.edges.find((e) => e.entry)
  assert.deepEqual([entry.via, entry.asight, entry.entry], ['proxy-http', true, { where: '.env HTTPS_PROXY', opt_in: false }], 'the entry edge says who wrote it')
  const off = buildTopology(ROWS.find((r) => r.n === 14).facts).codex.edges.find((e) => e.entry)
  assert.equal(off.entry.opt_in, false)
})

test('the old capture\'s chain is distinct nodes (the VPN twice, as two nodes), and a harness the facts cannot be drawn from says why instead of throwing', () => {
  const t = buildTopology(ROWS.find((r) => r.n === 20).facts)['claude-code']
  const vpn = t.nodes.filter((n) => n.kind === 'proxy')
  assert.equal(vpn.length, 2)
  assert.deepEqual(vpn.map((n) => n.port), [7897, 7897])
  assert.equal(new Set(t.branches[0].path).size, 5)
  assert.equal(t.branches[0].off_path.length, 3, 'without the capture: Claude → the VPN → out')
  const broken = buildTopology({ ...ROWS.find((r) => r.n === 20).facts, harnesses: { 'claude-code': { ...ROWS.find((r) => r.n === 20).facts.harnesses['claude-code'], systemProxy: null } } })['claude-code']
  assert.equal(broken.captured, null)
  assert.match(broken.notes[0], /could not be worked out/)
})

test('a scheme the agent cannot speak and does not fail on (dsh, SOCKS) is a direct path, with the path the agent would have taken said as inferred unless the behaviour was measured on this OS', () => {
  const socks = { setting: proxyOf('socks5://127.0.0.1:1080', [{ kind: 'env', where: 'ALL_PROXY' }]) }
  const t = buildTopology(facts('deepseek-dsh', {}, socks))['deepseek-dsh']
  assert.deepEqual(t.branches[0].off_path.map((id) => kindOf(t, id)), ['agent', 'upstream'], 'without asight it goes straight out: the proxy is not on its path')
  assert.ok(!t.nodes.some((n) => n.kind === 'proxy'), 'and no proxy hop is drawn for a value it ignores')
  const into = t.edges.find((e) => e.to === t.branches[0].off_path[1])
  assert.deepEqual([into.via, into.inferred, into.evidence], ['direct', true, ['unsupported-scheme:socks5']])
  assert.match(renderCompact(t)[0], /:443\(直连 · 推断\)$/, 'and the words say it')
  const lab = buildTopology(facts('deepseek-dsh', {}, { ...socks, behaviour: { ...harness('deepseek-dsh').behaviour, measured: 'lab' } }))['deepseek-dsh']
  assert.equal(lab.edges.find((e) => e.to === lab.branches[0].off_path[1]).inferred, undefined, 'measured: not said to be inferred')
  assert.ok(!/推断/.test(renderCompact(lab).join()))
  const fails = buildTopology(facts('claude-code', { listeners: [MIHOMO], vpn: mihomoVpn() }, { setting: proxyOf('socks5://127.0.0.1:7890', [{ kind: 'env', where: 'ALL_PROXY' }]) }))['claude-code']
  assert.ok(fails.nodes.some((n) => n.kind === 'proxy'), 'a scheme the agent fails on keeps the hop: it is where the agent tries to go')
  assert.deepEqual(validateTopology({ 'deepseek-dsh': t }), [])
})

test('proxy mode verdicts the platform\'s facts can ask for: a form it refused to wire (route-loop), an upstream the engine cannot dial (upstream-unreachable, asight is on the path and the connection fails), an opt-in waiting for administrator rights (not-routed: the finding `needs-admin` says what to run)', () => {
  const pf = (fm, fw) => buildTopology(pfacts('codex', fm, fw)).codex
  const loop = pf(form('codex.cli', { routeLoop: true, entry: null, procs: [proc(5530, { name: 'codex app-server' })] }), fwForm(17992))
  assert.deepEqual([loop.on_path, loop.captured, loop.reason], [false, false, 'route-loop'])
  const up = pf(form('codex.cli', { setting: proxyOf('http://proxy.corp:8080'), procs: [proc(5530, { name: 'codex app-server' })] }), fwForm(17992, { upstream: 'http://proxy.corp:8080', source: 'agent', upstream_error: 'ECONNREFUSED' }))
  assert.deepEqual([up.on_path, up.captured, up.reason], [true, false, 'upstream-unreachable'])
  for (const state of ['pending-admin', 'needs-admin']) {
    const t = pf(form('codex.cli', { entry: null, optIn: { state, code: 'needs-admin', enable: 'asight on codex --opt-in codex.machine' }, procs: [proc(5530, { name: 'codex app-server' })] }), fwForm(17992))
    assert.deepEqual([t.on_path, t.captured, t.reason], [false, false, 'not-routed'], state)
    assert.deepEqual(validateTopology({ codex: t }), [], 'a reason in the closed set of status reasons')
  }
})

// ── what the Linux reads gave and the topology dropped (4.6 「eBPF 模式下的网络拓扑」) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a default route on a TUN device with no VPN product recognised (sing-box, v2rayA …) is a hop, not nothing: [TUN] 出口(不知道 · …) after the API host, and a note says why; with no TUN, or with the product known, the path is as it was', () => {
  const t = buildTopology(facts('claude-code', { tun: true }))['claude-code']
  assert.deepEqual(t.branches[0].path.map((id) => kindOf(t, id)), ['agent', 'asight-engine', 'upstream', 'egress'])
  const egress = t.nodes.find((n) => n.kind === 'egress')
  assert.ok(egress.unknown && UNKNOWN_REASONS.includes(egress.unknown.reason), 'a hop the facts could not name: unknown, with a reason from the closed set')
  assert.equal(renderCompact(t)[0], 'claude 4121 → [eBPF] asight 引擎 :47123 → api.anthropic.com:443(直连) → [TUN] 出口(不知道 · absent)')
  assert.ok(t.notes.some((n) => /TUN/.test(n) && /没认出/.test(n)), t.notes.join('|'))
  assert.deepEqual(t.branches[0].off_path.map((id) => kindOf(t, id)), ['agent', 'upstream', 'egress'], 'and the way without asight goes the same way')
  assert.deepEqual(validateTopology({ 'claude-code': t }), [])
  for (const f of [facts('claude-code', { tun: false }), facts('claude-code', { tun: null }), facts('claude-code')]) assert.equal(renderCompact(buildTopology(f)['claude-code'])[0], 'claude 4121 → [eBPF] asight 引擎 :47123 → api.anthropic.com:443(直连)')
  assert.match(renderCompact(buildTopology(facts('claude-code', { tun: true, vpn: mihomoVpn({ tun: true }) }))['claude-code'])[0], /\[TUN\] 出口\(mihomo 选\)$/, 'the product named: as before')
  // a proxy of the agent's own decides the path: the TUN is not a hop of it
  assert.ok(!/TUN/.test(renderCompact(buildTopology(facts('claude-code', { tun: true, listeners: [MIHOMO], vpn: mihomoVpn() }, { setting: proxyOf('http://127.0.0.1:7890') }))['claude-code'])[0]))
})

test('NO_PROXY: when the environment names the API host, an agent with a proxy may not use it for that host — said as a note (whether the agent honours NO_PROXY is not measured), from the running process\'s own environment else from the shell\'s; no proxy or no match is no note', () => {
  const via = { setting: proxyOf('http://127.0.0.1:7890') }
  const base = { listeners: [MIHOMO], vpn: mihomoVpn() }
  const noteOf = (f) => buildTopology(f)['claude-code'].notes.filter((n) => /NO_PROXY/.test(n))
  const fromProc = noteOf(facts('claude-code', base, { ...via, procs: [proc(4121, { noProxy: ['api.anthropic.com'] })] }))
  assert.equal(fromProc.length, 1)
  assert.match(fromProc[0], /api\.anthropic\.com/)
  assert.match(fromProc[0], /还没.*测|没测/, 'whether it honours NO_PROXY: not claimed')
  assert.equal(noteOf(facts('claude-code', base, { ...via, procs: [proc(4121, { noProxy: [] })], noProxy: ['api.anthropic.com'] })).length, 0, 'the running process\'s own environment is what it does: it names nothing')
  assert.equal(noteOf(facts('claude-code', base, { ...via, procs: [], noProxy: ['api.anthropic.com'] })).length, 1, 'no process: what the shell that starts one has')
  assert.equal(noteOf(facts('claude-code', base, { procs: [proc(4121, { noProxy: ['api.anthropic.com'] })] })).length, 0, 'no proxy of its own: nothing to bypass')
  assert.equal(noteOf(facts('claude-code', base, via)).length, 0)
  const detail = renderDetail(buildTopology(facts('claude-code', base, { ...via, procs: [proc(4121, { noProxy: ['api.anthropic.com'] })] }))['claude-code']).join('\n')
  assert.match(detail, /^说明: NO_PROXY/m)
})

test('an https:// proxy is drawn as one: the engine ends the outer TLS of the agent\'s own https proxy and hands the CONNECT on, so the edge says 「https 代理」; a plain http proxy and a SOCKS one keep their words', () => {
  const line = (value) => renderCompact(buildTopology(facts('claude-code', { listeners: [{ ...MIHOMO, port: 8443 }], vpn: mihomoVpn({ port: 8443 }) }, { setting: proxyOf(value) }))['claude-code'])[0]
  assert.match(line('https://127.0.0.1:8443'), /→ \[CONNECT 原样转 · https 代理\] mihomo :8443/)
  assert.match(line('http://127.0.0.1:8443'), /→ \[CONNECT 原样转\] mihomo :8443/)
  assert.match(line('socks5://127.0.0.1:8443'), /→ \[SOCKS 前导原样转\] mihomo :8443/)
})

test('on_path is false — not true, not unknown — when asight cannot be on the path: wanted off with no process to read the watch table of, and wanted on with the kernel holding no link of this instance', () => {
  const off = buildTopology(facts('claude-code', { desired: { 'claude-code': 'off' } }, { procs: [] }))['claude-code']
  assert.deepEqual([off.on_path, off.captured, off.reason], [false, false, 'desired-off'])
  assert.deepEqual(off.branches[0].path.map((id) => kindOf(off, id)), ['agent', 'upstream'], 'no engine on the path')
  const noLink = buildTopology(facts('claude-code', { link: { attached: false, helper: 'ok', ids: [] } }, { procs: [] }))['claude-code']
  assert.deepEqual([noLink.on_path, noLink.captured, noLink.reason], [false, false, 'link-missing'])
  assert.deepEqual(noLink.branches[0].path.map((id) => kindOf(noLink, id)), ['agent', 'upstream'])
  const unread = buildTopology(facts('claude-code', { link: { attached: null, helper: 'ok', ids: [] } }, { procs: [] }))['claude-code']
  assert.equal(unread.on_path, null, 'a link that could not be read is not known, and not "no link"')
})
