// The Windows probe (RFC 4.7 §2 · §6; plan Task 6 (c)): N1 the probe reads and keeps nothing secret, and its fields are the §2 table's; N2 a LISTEN owner nobody recognises is 「不知道 · 未适配」 with its
// image name, never 「无」. `detect` is a pure function of facts, so the facts here are built by hand, except Verge's, which come from the real adapter reading a sandbox Verge and a fake core.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { detect, PROBE_UNKNOWN_REASONS } from '../../src/netenv/probe.mjs'
import { startWorld, LEAKS, VERGE_YAML } from './fixtures/verge-world.mjs'
import { vergeProcs, proc } from './fixtures/win-facts.mjs'

const CLOSED_1_6 = ['denied', 'timeout', 'absent', 'unparseable', 'owner-unreadable', 'pac', 'controller-unreadable', 'kernel-filter-invisible', 'env-unreadable', 'not-adapted'] // 1.6 §9.4 and 4.7 §6
const ok = (rows, more = {}) => ({ ok: true, rows, ...more })
const base = (over = {}) => ({
  procs: ok(vergeProcs()),
  listeners: ok([{ pid: 4101, port: 7897, addr: '127.0.0.1' }]),
  systemProxy: { ok: true, enable: true, server: '127.0.0.1:7897', autoConfigUrl: '' },
  interfaces: ok([], { defaultIface: 'Ethernet' }),
  focusPorts: [],
  verge: null,
  ...over,
})
const unknownOf = (r, what) => r.unknown.filter((u) => u.what === what)

test('N1: a Verge whose files hold a secret, a subscription, a node and a group → the probe has only the §2 fields, and none of those strings', async (t) => {
  const w = await startWorld(t)
  const r = detect(base({ verge: await w.adapter.facts(), focusPorts: [7897] }))
  assert.deepEqual(r.products, [{
    id: 'clash-verge-rev', name: 'Clash Verge Rev', writable: true, running: true, version: 'v1.19.32', mode: 'rule', findProcessMode: 'strict', tun: false, systemProxy: true,
    mixedPort: 7897, controller: 'writable', scriptWritable: true, serviceMode: false,
  }])
  assert.deepEqual(r.systemProxy, { enabled: true, host: '127.0.0.1', port: 7897, pac: false })
  assert.deepEqual(r.listeners, [{ port: 7897, product: 'clash-verge-rev', image: 'verge-mihomo.exe' }])
  assert.deepEqual(r.unknown, [])
  const text = JSON.stringify(r)
  for (const s of [...LEAKS, 'pipe', '\\\\.\\', 'Bearer', 'token']) assert.ok(!text.includes(s), `the probe's result has ${JSON.stringify(s)}`)
})

test('N1: only the keys of the §2 table leave a product entry (a field a reader adds does not reach netenv.json by itself)', async (t) => {
  const w = await startWorld(t)
  const f = await w.adapter.facts()
  f.fields.subscriptionUrl = 'https://sub.example/xyz?token=abc' // a reader that over-reaches
  f.runtime.proxies = ['node-hk-01']
  const r = detect(base({ verge: f }))
  assert.deepEqual(Object.keys(r.products[0]).sort(), ['controller', 'findProcessMode', 'id', 'mixedPort', 'mode', 'name', 'running', 'scriptWritable', 'serviceMode', 'systemProxy', 'tun', 'version', 'writable'])
  assert.ok(!JSON.stringify(r).includes('sub.example') && !JSON.stringify(r).includes('node-hk-01'))
})

test('N1: the fields follow the facts (service mode, TUN, a controller that is not readable, a Script.js the user cannot write)', async (t) => {
  fs.chmodSync // (the writable check below is by the file mode; Windows ACLs are 4.8 W-checks)
  const w = await startWorld(t, { verge: VERGE_YAML('').replace('enable_tun_mode: false', 'enable_tun_mode: true').replace('enable_service_mode: false', 'enable_service_mode: true').replace('enable_system_proxy: true', 'enable_system_proxy: false'), core: { tun: true, mode: 'global', findProcessMode: 'off', mixedPort: 7899 } })
  fs.chmodSync(w.file('profiles/Script.js'), 0o444)
  const f = await w.adapter.facts()
  const r = detect(base({ verge: f, procs: ok(vergeProcs({ service: true })) }))
  const v = r.products[0]
  assert.equal(v.tun, true); assert.equal(v.mode, 'global'); assert.equal(v.findProcessMode, 'off'); assert.equal(v.mixedPort, 7899); assert.equal(v.serviceMode, true)
  assert.equal(v.systemProxy, false); assert.equal(v.scriptWritable, false); assert.equal(v.controller, 'writable')
  // the controller cannot be read: the runtime fields are the files', the controller is `unreadable`, and the probe says so
  const down = await startWorld(t, {})
  await down.core.stop()
  const g = detect(base({ verge: await down.adapter.facts() })).products[0]
  assert.equal(g.controller, 'unreadable'); assert.equal(g.version, null); assert.equal(g.mode, 'rule'); assert.equal(g.mixedPort, 7897) // from the runtime file
  assert.ok(detect(base({ verge: await down.adapter.facts() })).unknown.some((u) => u.what === 'controller' && u.reason === 'controller-unreadable'))
})

test('N1: a data file Verge has that cannot be read is an unknown with the file name and a reason in the closed set, not a guess', async (t) => {
  const w = await startWorld(t)
  fs.rmSync(w.file('verge.yaml'))
  const r = detect(base({ verge: await w.adapter.facts() }))
  assert.deepEqual(r.unknown.filter((u) => u.what === 'product-file'), [{ what: 'product-file', product: 'clash-verge-rev', reason: 'absent', detail: 'verge.yaml' }])
  assert.equal(r.products[0].serviceMode, null)
})

test('N2: a LISTEN owner no product claims is 「不知道 · 未适配」 with its image name, never 「无」', () => {
  const r = detect(base({ procs: ok([proc({ pid: 5000, name: 'weirdproxy.exe', exe: 'C:\\x\\weirdproxy.exe' })]), listeners: ok([{ pid: 5000, port: 7890 }]), systemProxy: { ok: true, enable: true, server: '127.0.0.1:7890' } }))
  assert.deepEqual(r.listeners, [{ port: 7890, product: null, image: 'weirdproxy.exe' }])
  assert.deepEqual(unknownOf(r, 'listener'), [{ what: 'listener', port: 7890, reason: 'not-adapted', detail: 'weirdproxy.exe' }])
  assert.equal(r.products.length, 0) // an unknown owner is not a product of the table
  assert.ok(!JSON.stringify(r).includes('"none"') && !JSON.stringify(r).includes('无'))
})

test('N2: an owner whose process the snapshot does not have is owner-unreadable; a port nobody listens on is absent; both are unknown, neither is 「无」', () => {
  const gone = detect(base({ procs: ok([]), listeners: ok([{ pid: 777, port: 7897 }]), focusPorts: [7897] }))
  assert.deepEqual(unknownOf(gone, 'listener'), [{ what: 'listener', port: 7897, reason: 'owner-unreadable' }])
  const none = detect(base({ listeners: ok([]), focusPorts: [7897] }))
  assert.deepEqual(unknownOf(none, 'listener'), [{ what: 'listener', port: 7897, reason: 'absent' }])
})

test('N2: a focus port also comes from an agent setting, and the owner is looked up the same way', () => {
  const r = detect(base({ procs: ok([...vergeProcs(), proc({ pid: 5000, name: 'mystery.exe' })]), listeners: ok([{ pid: 4101, port: 7897 }, { pid: 5000, port: 9000 }]), systemProxy: { ok: true, enable: false, server: '', autoConfigUrl: '' }, focusPorts: [9000] }))
  assert.deepEqual(r.listeners, [{ port: 9000, product: null, image: 'mystery.exe' }])
  assert.deepEqual(unknownOf(r, 'listener'), [{ what: 'listener', port: 9000, reason: 'not-adapted', detail: 'mystery.exe' }])
})

test('products: a recognised read-only product is named, with 「未适配」 for its settings when nobody reads them, and its TUN comes from the adapter list and the default route', () => {
  const r = detect(base({
    procs: ok([proc({ pid: 6000, name: 'FlClashCore.exe' })]), listeners: ok([{ pid: 6000, port: 7890 }]), systemProxy: { ok: true, enable: true, server: '127.0.0.1:7890', autoConfigUrl: '' },
    interfaces: ok([{ name: 'FlClash', description: 'FlClash Tunnel', up: true }, { name: 'Ethernet', description: 'Intel', up: true }], { defaultIface: 'FlClash' }),
  }))
  assert.equal(r.products.length, 1)
  assert.deepEqual({ id: r.products[0].id, writable: r.products[0].writable, tun: r.products[0].tun, controller: r.products[0].controller, scriptWritable: r.products[0].scriptWritable }, { id: 'flclash', writable: false, tun: true, controller: 'not-applicable', scriptWritable: null })
  assert.deepEqual(unknownOf(r, 'product-settings'), [{ what: 'product-settings', product: 'flclash', reason: 'not-adapted' }])
  assert.deepEqual(r.listeners, [{ port: 7890, product: 'flclash', image: 'FlClashCore.exe' }])
  // the adapter is there but the default route does not take it: not TUN
  const off = detect(base({ procs: ok([proc({ pid: 6000, name: 'FlClash.exe' })]), interfaces: ok([{ name: 'FlClash', description: 'FlClash Tunnel', up: true }], { defaultIface: 'Ethernet' }) }))
  assert.equal(off.products[0].tun, false)
  const down = detect(base({ procs: ok([proc({ pid: 6000, name: 'FlClash.exe' })]), interfaces: ok([{ name: 'FlClash', description: 'FlClash Tunnel', up: false }], { defaultIface: 'FlClash' }) })) // the adapter is down
  assert.equal(down.products[0].tun, false)
})

test('products: sing-box.exe alone is GUI.for.SingBox or v2rayN, so it is not named; with the product\'s own image running it is that product\'s', () => {
  const alone = detect(base({ procs: ok([proc({ pid: 6100, name: 'sing-box.exe' })]), listeners: ok([{ pid: 6100, port: 7890 }]), focusPorts: [7890], systemProxy: { ok: true, enable: false, server: '127.0.0.1:7897', autoConfigUrl: '' } }))
  assert.equal(alone.products.length, 0)
  assert.ok(alone.unknown.some((u) => u.what === 'product' && u.reason === 'not-adapted' && u.detail === 'sing-box.exe' && u.candidates.includes('gui-for-singbox') && u.candidates.includes('v2rayn')))
  assert.deepEqual(unknownOf(alone, 'listener'), [{ what: 'listener', port: 7890, reason: 'not-adapted', detail: 'sing-box.exe' }])
  const both = detect(base({ procs: ok([proc({ pid: 6100, name: 'sing-box.exe' }), proc({ pid: 6101, name: 'GUI.for.SingBox.exe' }), proc({ pid: 6102, name: 'v2rayN.exe' })]), listeners: ok([{ pid: 6100, port: 7890 }]), focusPorts: [7890], systemProxy: { ok: true, enable: false, server: '' } }))
  assert.deepEqual(both.listeners, [{ port: 7890, product: null, image: 'sing-box.exe' }]) // both run: whose core it is is not known
  assert.ok(both.unknown.some((u) => u.what === 'product' && u.detail === 'sing-box.exe' && u.candidates.length === 2))
  const named = detect(base({ procs: ok([proc({ pid: 6100, name: 'sing-box.exe' }), proc({ pid: 6101, name: 'GUI.for.SingBox.exe' })]), listeners: ok([{ pid: 6100, port: 7890 }]), focusPorts: [7890], systemProxy: { ok: true, enable: false, server: '', autoConfigUrl: '' } }))
  assert.deepEqual(named.products.map((p) => p.id), ['gui-for-singbox'])
  assert.deepEqual(named.listeners, [{ port: 7890, product: 'gui-for-singbox', image: 'sing-box.exe' }])
})

test('products: Clash Party is recognised by mihomo-party.exe and by a mihomo*.exe core, image names without case', () => {
  assert.deepEqual(detect(base({ procs: ok([proc({ pid: 1, name: 'MIHOMO-PARTY.EXE' })]) })).products.map((p) => p.id), ['clash-party'])
  assert.deepEqual(detect(base({ procs: ok([proc({ pid: 1, name: 'mihomo-alpha.exe' })]) })).products.map((p) => p.id), ['clash-party'])
  assert.deepEqual(detect(base({ procs: ok([proc({ pid: 1, name: 'verge-mihomo.exe' })]) })).products.map((p) => p.id), ['clash-verge-rev']) // the Verge core is not Clash Party's mihomo*.exe
})

test('the system proxy: a PAC script is 「不知道 · pac」; a server in the per-protocol form is read by its http entry; garbage is unparseable; a read that failed is its own reason', () => {
  const pac = detect(base({ systemProxy: { ok: true, enable: true, server: '', autoConfigUrl: 'http://wpad.corp.example/proxy.pac' } }))
  assert.deepEqual(unknownOf(pac, 'system-proxy'), [{ what: 'system-proxy', reason: 'pac' }])
  assert.ok(!JSON.stringify(pac).includes('wpad.corp.example')) // the script's address is the user's
  const multi = detect(base({ systemProxy: { ok: true, enable: true, server: 'socks=127.0.0.1:7898;http=127.0.0.1:7897;https=127.0.0.1:7897', autoConfigUrl: '' } }))
  assert.deepEqual(multi.systemProxy, { enabled: true, host: '127.0.0.1', port: 7897, pac: false })
  assert.deepEqual(detect(base({ systemProxy: { ok: true, enable: true, server: 'socks=127.0.0.1:7898;ftp=127.0.0.1:7899', autoConfigUrl: '' } })).systemProxy.port, 7898) // no http entry: the first
  assert.deepEqual(detect(base({ systemProxy: { ok: true, enable: true, server: 'https://127.0.0.1:7897/', autoConfigUrl: '' } })).systemProxy, { enabled: true, host: '127.0.0.1', port: 7897, pac: false })
  for (const bad of ['not a proxy', '127.0.0.1:99999', '127.0.0.1:0', '127.0.0.1']) assert.deepEqual(unknownOf(detect(base({ systemProxy: { ok: true, enable: true, server: bad } })), 'system-proxy'), [{ what: 'system-proxy', reason: 'unparseable' }], bad)
  assert.deepEqual(unknownOf(detect(base({ systemProxy: { ok: false, reason: 'denied' } })), 'system-proxy'), [{ what: 'system-proxy', reason: 'denied' }])
  const off = detect(base({ systemProxy: { ok: true, enable: false, server: '', autoConfigUrl: '' } }))
  assert.deepEqual(off.systemProxy, { enabled: false, host: null, port: null, pac: false }); assert.deepEqual(unknownOf(off, 'system-proxy'), [])
})

test('what cannot be read is unknown, not empty: a process snapshot that failed is products null (not []), with the reason; a reason outside the closed set is unparseable with what it said', () => {
  const r = detect(base({ procs: { ok: false, reason: 'denied' }, focusPorts: [7897] }))
  assert.equal(r.products, null)
  assert.deepEqual(unknownOf(r, 'products'), [{ what: 'products', reason: 'denied' }])
  assert.deepEqual(unknownOf(r, 'listeners'), [{ what: 'listeners', reason: 'denied' }])
  assert.deepEqual(unknownOf(detect(base({ procs: { ok: false, reason: 'E_WEIRD' } })), 'products'), [{ what: 'products', reason: 'unparseable', detail: 'E_WEIRD' }])
  assert.deepEqual(detect(base({ procs: ok([]) })).products, []) // read, and none of the table runs: that is [], not null
  assert.deepEqual(detect({}).unknown.map((u) => u.what).sort(), ['products', 'system-proxy']) // no facts at all
})

test('a TUN that neither the product nor the adapter list says is unknown with the list\'s reason', () => {
  const r = detect(base({ procs: ok([proc({ pid: 6000, name: 'FlClash.exe' })]), interfaces: { ok: false, reason: 'timeout' } }))
  assert.equal(r.products[0].tun, null)
  assert.deepEqual(unknownOf(r, 'tun'), [{ what: 'tun', product: 'flclash', reason: 'timeout' }])
})

test('every reason the probe emits is in the closed set of 1.6 §9.4 (plus not-adapted), and the facts it is given are not changed', async (t) => {
  assert.deepEqual([...PROBE_UNKNOWN_REASONS].filter((x) => !CLOSED_1_6.includes(x)), [])
  const w = await startWorld(t)
  fs.rmSync(w.file('config.yaml')); fs.rmSync(w.file('profiles.yaml'))
  const facts = base({ verge: await w.adapter.facts(), procs: ok([...vergeProcs(), proc({ pid: 5000, name: 'mystery.exe' })]), listeners: ok([{ pid: 5000, port: 9000 }]), focusPorts: [9000], systemProxy: { ok: true, enable: true, server: '', autoConfigUrl: 'x' } })
  const before = JSON.stringify(facts)
  const r = detect(facts)
  assert.equal(JSON.stringify(facts), before)
  assert.ok(r.unknown.length >= 3)
  for (const u of r.unknown) assert.ok(PROBE_UNKNOWN_REASONS.includes(u.reason), `${u.what}: ${u.reason}`)
})
