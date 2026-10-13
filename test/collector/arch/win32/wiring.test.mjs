// test/collector/arch/win32/wiring.test.mjs — the daemon's Windows half (RFC 4.8 §1 接线 · §2.2 · §3.5; W39 W71; plan Task 8(c)).
// createWin32Collector is what loadArch('win32') hands the daemon: the helper, watcher, ingress config, kernel, entries writer and route plan in one Redirector,
// plus the win32 bag the daemon reaches (replan, carried, the applied host sets). Everything is injected: a fake helper, kernel and process watcher.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { loadArch } from '../../../../src/collector/arch/index.mjs'
import { createWin32Collector } from '../../../../src/collector/arch/win32/wiring.mjs'
import { checkRecord } from '../../../../src/health/codes.mjs'
import { groupsOf } from '../../../../src/collector/arch/win32/route-plan.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { createRegistry } from '../../../../src/collector/core/registry.mjs'
import { installCollector } from '../../../../src/collector/install.mjs'
import { readManifest } from '../../../../src/collector/core/trust/journal.mjs'
import { saveManifest } from '../../../../src/off/manifest.mjs'
import { readText, readTextOrError } from '../../../../src/collector/core/config-read.mjs'
import { regReadAllowed } from '../../../../src/collector/arch/win32/helper.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const ALL = await loadHarnesses()
const ID = createRegistry(ALL).match // what the daemon hands the collector: registry.match, built first (D51)
const one = (name) => ALL.find((d) => d.name === name)
const sha = (b) => createHash('sha256').update(b).digest('hex')
const EXE = Buffer.from('MZ fake asight-forwarder.exe, sixty kilobytes of nothing '.repeat(8))
const ARCHIVE = Buffer.from('PK fake mihomo zip, twenty-two megabytes of nothing '.repeat(4))
const GROUPS = groupsOf(ALL)
const sz = (value) => ({ kind: 'REG_SZ', value })
const dword = (value) => ({ kind: 'REG_DWORD', value })
const VERGE = { ProxyEnable: dword(1), ProxyServer: sz('127.0.0.1:7897'), ProxyOverride: sz('localhost;<local>') }

/** A fake helper that answers reg-read from an in-memory registry (the four Internet Settings values and the login environment) and nothing else. */
function fakeRegistry(initial = {}) {
  const reg = { internet: { ...initial }, env: {}, fail: null, answer: null }
  const calls = []
  const helper = {
    calls, ready: Promise.resolve({ ready: true, proto: 1, pid: 4242, native: true }), pid: 4242, abandoned: () => 0,
    async call(verb, args) {
      calls.push([verb, args])
      if (reg.fail) throw Object.assign(new Error('the helper failed'), { code: reg.fail })
      if (verb !== 'reg-read') return { rows: [] }
      if (regReadAllowed(args) === null) throw Object.assign(new Error('outside the allow-list'), { code: 'helper-forbidden-key' })
      const src = /Environment$/i.test(args.key) ? reg.env : reg.internet
      const values = {}
      for (const n of args.names || []) if (n in src && src[n] !== undefined) values[n] = src[n]
      return reg.answer ?? { keyExists: true, values }
    },
    async close() {},
  }
  return { reg, helper }
}

function fakeTimers() {
  const live = new Map()
  const set = []
  let n = 0
  return { set, timers: { setInterval(fn, ms) { const id = ++n; live.set(id, fn); set.push(ms); return { id, unref() {} } }, clearInterval(t) { live.delete(t.id) }, setTimeout(fn, ms) { const id = ++n + 1000; live.set(id, fn); set.push(ms); return { id, unref() {} } }, clearTimeout(t) { live.delete(t.id) } }, async tick() { for (const fn of [...live.values()]) await fn() } }
}

/** A sandbox %USERPROFILE% with the harnesses' trust entries really installed, the fake registry's helper, and a collector wiring over it all. */
async function rigged(names, { internet = VERGE, desired = {}, rels = [], optIns = [], over = {} } = {}) {
  const home = tmpDir('asight-wiring-')
  for (const [rel, text = ''] of rels) { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  const ds = names.map(one)
  await installCollector({ home, env: { HOME: home, USERPROFILE: home }, osName: 'win32', harnesses: ds, freePort: async () => 47011, roots: { node: [], osText: '' } })
  const dir = path.join(home, '.asight', 'collector')
  const box = fakeRegistry(internet)
  const events = []
  const failures = []
  let ports = 18800
  const deps = {
    helper: box.helper,
    loadIngress: async () => ({ enginePort: 18790, groupPorts: Object.fromEntries(GROUPS.map((x) => [x.g, ++ports])), ingressToken: 'a'.repeat(32), listenerToken: 'b'.repeat(32) }),
    isFree: async () => true, random: (n) => Buffer.alloc(n, 7),
    timers: null, systemProxy: undefined, hkcuEnv: undefined, watchSystemProxy: undefined,
    ...over.deps,
  }
  const timers = fakeTimers()
  if (!over.deps || !over.deps.timers) deps.timers = timers.timers
  const state = { desired }
  const redirector = await createWin32Collector({
    env: { HOME: home, USERPROFILE: home }, dir, home, harnesses: ds,
    failure: (where, e, extra) => failures.push({ where, reason: String((e && e.message) || e), ...(extra || {}) }),
    event: (rec) => events.push(rec),
    manifest: () => readManifest(dir), desired: () => state.desired, optIns: () => optIns, identify: ID,
    deps,
  })
  // the daemon owns the engine: bind the wiring's door slot to a recorder of listen({groups}) / closeGroups, as daemon.mjs does once both exist
  const doorLog = []
  const doorsOpen = new Set()
  redirector.win32.bindDoors({
    open: async (list) => { doorLog.push(['open', list]); for (const g of list) doorsOpen.add(g.id) },
    close: async (ids) => { doorLog.push(['close', ids]); for (const g of ids) doorsOpen.delete(g) },
  })
  return { home, dir, box, events, failures, redirector, timers, deps, state, doorLog, doorsOpen }
}


test('W39 loadArch("win32") returns the Windows arch on any OS (imported and built here on darwin: no top-level Windows call), with the pieces the CLI and daemon reach', async () => {
  const A = await loadArch('win32')
  assert.equal(A.os, 'win32')
  assert.equal(A.install, null, 'the machine-wide helper is a Linux thing; Windows needs none')
  assert.equal(typeof A.unit.userUnit, 'function', 'the autostart unit (Task 9(a))')
  assert.equal(typeof A.controlEndpoint, 'function')
  assert.equal(typeof A.refuseElevated, 'function')
  assert.equal(typeof A.nodePreflight, 'function')
  assert.equal(typeof A.runSupervisor, 'function')
  assert.equal(A.prepare, undefined, 'no preflight: the engine is the only local proxy, `on` downloads nothing (D47\'s twin; darwin\'s wiring.test pins its own absence the same way)')
  assert.equal(A.ensureKernel, undefined, 'no kernel to ensure either')
  assert.equal(typeof A.osRoots, 'function', 'the Windows roots are read (4.8 §6.2)')
  assert.equal(typeof A.createRedirector, 'function')
  assert.equal(typeof A.netFacts, 'function', 'the platform\'s part of the network facts (Task 10(a), 4.8 §10.1): gatherNetFacts reaches it as archFacts, it reads the collector dir\'s files and the resident helper — no second daemon API')
  const linux = await loadArch('linux')
  assert.equal(linux.prepare, undefined, 'the Linux arch has no prepare and its on is unchanged')
})


test('the wiring plans from the daemon\'s own ctx and serves a door lookup (the group id is the user) with capture:"proxy" and the group\'s upstream', async () => {
  const r = await rigged(['claude-code', 'codex'], { desired: { 'claude-code': { desired: 'on' }, codex: { desired: 'on' } } })
  await r.redirector.start() // the netenv half (the first read, the first plan, the watcher) is start()'s, as on darwin
  assert.equal(r.redirector.win32.netenv().systemProxy.ok, true)
  assert.equal(r.redirector.win32.netenv().systemProxy.server, '127.0.0.1:7897')
  const meta = await r.redirector.lookupIngress({ peer: { address: '127.0.0.1', port: 5010 }, user: 'claude-code.settings', target: { address: 'api.example.com', port: 443 } })
  assert.equal(meta.capture, 'proxy')
  assert.equal(meta.agent, 'claude-code')
  assert.equal(meta.form, undefined, 'no pid behind the peer (the registry fake answers no ps): forwarded untracked, the door\'s fail-safe')
  assert.equal(meta.upstream.kind, 'direct', 'claude-code does not follow the system proxy (its own files hold no proxy here): direct')
  const codex = await r.redirector.lookupIngress({ peer: { address: '127.0.0.1', port: 5010 }, user: 'codex.env', target: { address: 'api.example.com', port: 443 } })
  assert.deepEqual([codex.upstream.kind, codex.upstream.host, codex.upstream.port], ['http', '127.0.0.1', 7897], 'codex follows the system proxy')
})

test('attach() (through the wiring\'s own gate) writes Codex\'s proxy lines into the ONE block its trust entry wrote, and a group the manifest records is carried while off (audit F7)', async () => {
  const r = await rigged(['codex'], { desired: { codex: { desired: 'on' } }, rels: [[path.join('.codex', '.env'), 'API_KEY=1\n']] })
  await r.redirector.start() // the netenv half is start()'s (the first read, the first plan, the watcher)
  const out = await r.redirector.attach()
  assert.equal(out.ok, true, JSON.stringify(out))
  const f = path.join(r.home, '.codex', '.env')
  const text = fs.readFileSync(f, 'utf8')
  assert.equal([...text.matchAll(/^# >>> asight/gm)].length, 1, 'one sentinel block')
  assert.match(text, /^HTTPS_PROXY=http:\/\/codex\.env:/m, 'the proxy line, written through the wiring (the W19 gate lets it: the four conditions hold)')
  assert.match(text, /^NO_PROXY=localhost,127\.0\.0\.1,::1/m, 'the fixed NO_PROXY line beside it')
  // the record now exists: the group keeps its DOOR while it is off (its port comes back for an agent that outlives `off`, audit F7) — forward-only
  r.state.desired = { codex: { desired: 'off' } }
  await r.redirector.win32.replan({ reload: true })
  const st = await r.redirector.status()
  assert.ok(st.doors.includes('codex.env'), 'the off group keeps its door (carried): forward-only, its port does not go away')
  assert.equal(st.attached, false, 'attached is the ON groups\' doors: this one is carried, not attached')
  const served = await r.redirector.lookupIngress({ peer: { address: '127.0.0.1', port: 5010 }, user: 'codex.env', target: { address: 'api.example.com', port: 443 } })
  assert.deepEqual([served.skip?.reason, served.decrypt], ['group-off', false], 'an agent that still arrives is served, not refused (the splice carries the reason)')
  const undone = fs.readFileSync(f, 'utf8')
  assert.equal([...undone.matchAll(/^HTTPS_PROXY=/gm)].length, 0, 'and its proxy entry is undone (the plan says off)')
})



test('W71 a system-proxy change (ProxyServer, or ProxyOverride alone) gives one replan-and-attach, one netenv-change, zero failures; a change whose answers equal the group\'s last moves nothing', async () => {
  const r = await rigged(['codex'], { desired: { codex: { desired: 'on' } }, rels: [[path.join('.codex', '.env'), 'API_KEY=1\n']] })
  await r.redirector.start()
  await r.redirector.attach()
  let attaches = 0
  const inner = r.redirector.attach.bind(r.redirector)
  r.redirector.attach = async (...a) => { attaches++; return inner(...a) }
  r.box.reg.internet.ProxyServer = sz('127.0.0.1:7890') // the port moved: codex's upstream moves with it
  await r.timers.tick()
  assert.equal(attaches, 1, 'one replan that moved the answers brought the doors and the entries to it (the entries re-write the same address: a no-op)')
  const changes = r.events.filter((e) => e.event === 'netenv-change')
  assert.equal(changes.length, 1)
  assert.equal(changes[0].from, '127.0.0.1:7897')
  assert.equal(changes[0].to, '127.0.0.1:7890')
  assert.deepEqual(r.failures, [], 'zero failures')
  r.box.reg.internet.ProxyOverride = sz('localhost;10.*;<local>') // the bypass table alone moves it too (W72)
  await r.timers.tick()
  assert.equal(attaches, 2)
  assert.equal(r.events.filter((e) => e.event === 'netenv-change').length, 2)
  // a read that fails and comes back with the same answers: two changes, zero attaches (4.8 §2.2)
  r.box.reg.fail = 'helper-timeout'
  await r.timers.tick()
  r.box.reg.fail = null
  await r.timers.tick()
  assert.equal(r.events.filter((e) => e.event === 'netenv-change').length, 4, 'each change is one event (the group stays on its last upstream, said)')
  assert.equal(attaches, 2, 'zero attaches: the answers did not move')
  assert.deepEqual(r.failures, [])
})


test('W71 the watcher stops with the collector: close() stops it (no timer left)', async () => {
  const r = await rigged(['codex'], { desired: { codex: { desired: 'on' } } })
  await r.redirector.win32.close()
  r.box.reg.internet.ProxyServer = sz('127.0.0.1:1')
  await r.timers.tick()
  assert.equal(r.events.filter((e) => e.event === 'netenv-change').length, 0)
})






test('osLayers hands the layers ctx the desktop door (D51④): claude-code\'s CONFIRMED optin-cert-user only while its thumbprint is this build\'s CA, z-code\'s CONFIRMED optin-zcode; read live off the manifest; the CLI\'s settings door untouched', async () => {
  const r = await rigged(['claude-code', 'z-code'], { desired: { 'claude-code': { desired: 'on' }, 'z-code': { desired: 'on' } } })
  const { X509Certificate } = await import('node:crypto')
  const caFile = path.join(r.dir, 'ca', 'asight-ca.pem')
  const thumbprint = createHash('sha1').update(new X509Certificate(fs.readFileSync(caFile)).raw).digest('hex').toUpperCase()
  const NS = ['--type=utility', '--utility-sub-type=network.mojom.NetworkService']
  const ctx = (argv) => ({ os: 'win32', environ: new Map(), env: new Map(), home: r.home, cwd: r.home, argv, startedAt: null, readText, readTextOrError,
    mtimeOf: (f) => { try { return fs.statSync(f).mtimeMs } catch { return null } }, listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } }, unparsable: () => {} })
  const cc = r.redirector.win32.osLayers.win32(one('claude-code'))
  const zc = r.redirector.win32.osLayers.win32(one('z-code'))
  assert.deepEqual(cc(ctx(['claude.exe', ...NS])), [], 'no item: the network service gets no layer')
  const m = readManifest(r.dir)
  const t0 = Date.now()
  const cert = (tp, confirmed = true) => ({ kind: 'optin-cert-user', harness: 'claude-code', form: 'claude-code.desktop', item: 'cert-store-current-user', scope: 'user', path: `CurrentUser\\Root\\${tp}`, installed_at: new Date(t0).toISOString(), confirmed, values: { thumbprint: tp, certFile: caFile } })
  m.entries.push(cert(thumbprint, false)); saveManifest(r.dir, m)
  assert.deepEqual(cc(ctx(['claude.exe', ...NS])), [], 'unconfirmed (the box was declined): shut')
  m.entries.push(cert('AABBCCDD')); saveManifest(r.dir, m)
  assert.deepEqual(cc(ctx(['claude.exe', ...NS])), [], 'a thumbprint of a CA this build no longer holds: shut')
  assert.deepEqual(zc(ctx(['ZCode.exe', ...NS])), [], 'another harness\'s item opens nothing')
  m.entries.push(cert(thumbprint)); saveManifest(r.dir, m)
  const door = cc(ctx(['claude.exe', ...NS]))
  assert.deepEqual([door.length, door[0].vars.NODE_EXTRA_CA_CERTS, door[0].since, door[0].live], [1, caFile, t0, false])
  assert.match(door[0].name, /CurrentUser\\Root/)
  assert.ok(cc(ctx(['claude.exe'])).every((l) => /settings/.test(l.name)), 'claude.exe with no --type= reads settings (the CA `on` wrote there), not the door')

  const setting = path.join(r.home, '.zcode', 'v2', 'setting.json')
  fs.mkdirSync(path.dirname(setting), { recursive: true }); fs.writeFileSync(setting, JSON.stringify({ httpProxyCaCertPath: caFile }))
  assert.deepEqual(zc(ctx(['ZCode.exe', ...NS])), [], 'the setting without the confirmed optin-zcode item: shut')
  m.entries.push({ kind: 'optin-zcode', harness: 'z-code', form: 'z-code.desktop', item: 'zcode-app-settings', scope: 'user', path: setting, installed_at: new Date(t0).toISOString(), confirmed: true, values: {} }); saveManifest(r.dir, m)
  const z = zc(ctx(['ZCode.exe', ...NS]))
  assert.deepEqual([z.length, z[0].vars.ZCODE_AGENT_CA_CERT, z[0].since], [1, caFile, t0])
})
