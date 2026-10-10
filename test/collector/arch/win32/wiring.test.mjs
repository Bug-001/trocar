// test/collector/arch/win32/wiring.test.mjs — the daemon's Windows half (RFC 4.8 §1 接线 · §2.2 · §3.5; W39 W71; plan Task 8(c)).
// createWin32Collector is what loadArch('win32') hands the daemon: the helper, watcher, ingress config, kernel, entries writer and route plan in one Redirector,
// plus the win32 bag the daemon reaches (osMatch, replan, carried, the applied host sets). Everything is injected: a fake helper, kernel and process watcher.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { loadArch } from '../../../../src/collector/arch/index.mjs'
import { createWin32Collector, prepare } from '../../../../src/collector/arch/win32/wiring.mjs'
import { groupsOf } from '../../../../src/collector/arch/win32/route-plan.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { installCollector } from '../../../../src/collector/install.mjs'
import { readManifest } from '../../../../src/collector/core/trust/journal.mjs'
import { readText, readTextOrError } from '../../../../src/collector/core/config-read.mjs'
import { regReadAllowed } from '../../../../src/collector/arch/win32/helper.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const ALL = await loadHarnesses()
const one = (name) => ALL.find((d) => d.name === name)
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

/** A stand-in process watcher: the events are the test's to emit; scan/start/stop are the shapes the redirector asks for. */
const fakeWatcher = () => Object.assign(new EventEmitter(), { scan: async () => [], start: async () => true, stop() {}, poll: async () => false, unreadable: () => [] })

function fakeKernel() {
  const reloads = []
  return {
    reloads,
    forwarder: {
      async reload({ build, forms }) { reloads.push({ forms: JSON.parse(JSON.stringify(forms)), text: build ? build({ port: 19001, secret: 'control-secret-0123456789' }) : null }); return { ok: true, readBack: { forms: {} } } },
      async check() { return { ok: true, forms: {} } },
      state: () => ({ phase: 'running' }),
      controller: () => ({ port: 19001, secret: 'control-secret-0123456789' }),
      async drain() { return { stopped: false, cancelled: false } },
      async stopNow() { return { stopped: true, now: true } },
    },
  }
}

/** A sandbox %USERPROFILE% with the harnesses' trust entries really installed, the fake registry's helper, and a collector wiring over it all. */
async function rigged(names, { internet = VERGE, desired = {}, rels = [], optIns = [], over = {} } = {}) {
  const home = tmpDir('asight-wiring-')
  for (const [rel, text = ''] of rels) { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  const ds = names.map(one)
  await installCollector({ home, env: { HOME: home, USERPROFILE: home }, osName: 'win32', harnesses: ds, freePort: async () => 47011, roots: { node: [], osText: '' } })
  const dir = path.join(home, '.asight', 'collector')
  const box = fakeRegistry(internet)
  const kernel = fakeKernel()
  const events = []
  const failures = []
  let ports = 18800
  const deps = {
    helper: box.helper, procWatcher: fakeWatcher(), forwarder: kernel.forwarder,
    loadIngress: async () => ({ enginePort: 18790, groupPorts: Object.fromEntries(GROUPS.map((x) => [x.g, ++ports])), ingressToken: 'a'.repeat(32), listenerToken: 'b'.repeat(32) }),
    controller: { port: 19001, secret: 's' }, isFree: async () => true, random: (n) => Buffer.alloc(n, 7),
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
    manifest: () => readManifest(dir), desired: () => state.desired, optIns: () => optIns,
    deps,
  })
  return { home, dir, box, kernel, events, failures, redirector, timers, deps, state }
}


test('W39 loadArch("win32") returns the Windows arch on any OS (imported and built here on darwin: no top-level Windows call), with the pieces the CLI and daemon reach', async () => {
  const A = await loadArch('win32')
  assert.equal(A.os, 'win32')
  assert.equal(A.install, null, 'the machine-wide helper is a Linux thing; Windows needs none')
  assert.equal(A.osRootsFile, undefined, 'the Windows roots are read through osRoots(), not a file')
  assert.equal(typeof A.unit.userUnit, 'function', 'the autostart unit (Task 9(a))')
  assert.equal(typeof A.controlEndpoint, 'function')
  assert.equal(typeof A.refuseElevated, 'function')
  assert.equal(typeof A.nodePreflight, 'function')
  assert.equal(typeof A.runSupervisor, 'function')
  assert.equal(typeof A.prepare, 'function', 'the read-only hook `asight on` calls (W27 ⑥, W74)')
  assert.equal(typeof A.osRoots, 'function')
  assert.equal(typeof A.createRedirector, 'function')
  assert.equal(typeof A.netFacts, 'function', 'the platform\'s part of the network facts (Task 10(a), 4.8 §10.1): gatherNetFacts reaches it as archFacts, it reads the collector dir\'s files and the resident helper — no second daemon API')
  const linux = await loadArch('linux')
  assert.equal(linux.prepare, undefined, 'the Linux arch has no prepare and its on is unchanged')
})


test('the wiring plans from the daemon\'s own ctx and serves an `of.<form>` lookup with capture:"proxy" and the group\'s upstream', async () => {
  const r = await rigged(['claude-code', 'codex'], { desired: { 'claude-code': { desired: 'on' }, codex: { desired: 'on' } } })
  assert.equal(r.redirector.win32.netenv().systemProxy.ok, true)
  assert.equal(r.redirector.win32.netenv().systemProxy.server, '127.0.0.1:7897')
  const meta = await r.redirector.lookupIngress({ user: 'of.claude-code.cli', target: { address: 'api.example.com', port: 443 } })
  assert.equal(meta.capture, 'proxy')
  assert.equal(meta.agent, 'claude-code')
  assert.equal(meta.form, 'claude-code.cli')
  assert.equal(meta.upstream.kind, 'direct', 'claude-code does not follow the system proxy (its own files hold no proxy here): direct')
  const codex = await r.redirector.lookupIngress({ user: 'of.codex.app', target: { address: 'api.example.com', port: 443 } })
  assert.deepEqual([codex.upstream.kind, codex.upstream.host, codex.upstream.port], ['http', '127.0.0.1', 7897], 'codex follows the system proxy')
})

test('attach() (through the wiring\'s own gate) writes Codex\'s proxy lines into the ONE block its trust entry wrote, and a group the manifest records is carried while off (audit F7)', async () => {
  const r = await rigged(['codex'], { desired: { codex: { desired: 'on' } }, rels: [[path.join('.codex', '.env'), 'API_KEY=1\n']] })
  const out = await r.redirector.attach()
  assert.equal(out.ok, true, JSON.stringify(out))
  const f = path.join(r.home, '.codex', '.env')
  const text = fs.readFileSync(f, 'utf8')
  assert.equal([...text.matchAll(/^# >>> asight/gm)].length, 1, 'one sentinel block')
  assert.match(text, /^HTTPS_PROXY=http:\/\/codex\.env:/m, 'the proxy line, written through the wiring (the W19 gate lets it: the four conditions hold)')
  assert.match(text, /^NO_PROXY=localhost,127\.0\.0\.1,::1/m, 'the fixed NO_PROXY line beside it')
  // the record now exists: the group stays in the kernel while it is off (its port comes back for an agent that outlives `off`, audit F7)
  r.state.desired = { codex: { desired: 'off' } }
  await r.redirector.win32.replan({ reload: true })
  const last = r.kernel.reloads[r.kernel.reloads.length - 1]
  assert.match(last.text, /asight-l-codex\.env/, 'the off group keeps its listener (carried): forward-only, its port does not go away')
  assert.equal(JSON.stringify(last.forms).includes('"on":true'), false, 'no form of it is on')
  const undone = fs.readFileSync(f, 'utf8')
  assert.equal([...undone.matchAll(/^HTTPS_PROXY=/gm)].length, 0, 'and its proxy entry is undone (the plan says off)')
})

test('ownImages are the daemon\'s node.exe and the kernel\'s exe, and the host sets of a host-tree form are applied at on and kept for status', async () => {
  const r = await rigged(['kimi-code', 'claude-code'], { optIns: ['kimi-code.vscode'], desired: { 'kimi-code': { desired: 'on', extra_hosts: ['extra.relay.example'] }, 'claude-code': { desired: 'on' } }, rels: [[path.join('.kimi-code', 'config.toml'), 'base_url = "https://from-settings.relay.example/v1"\n']] })
  assert.deepEqual(r.redirector.win32.kernelExe, path.join(r.dir, 'kernel', 'asight-forwarder.exe'))
  const applied = r.redirector.win32.appliedHosts()
  const set = applied['kimi-code.vscode']
  assert.ok(set, 'the host-tree form\'s set is applied (the group is on)')
  assert.ok(set.hosts.includes('from-settings.relay.example'), 'the settings\' relay is in the set')
  assert.ok(set.hosts.includes('extra.relay.example'), 'the operator\'s extra_hosts is in the set')
  assert.ok(set.hosts.some((h) => h.endsWith('.moonshot.cn')), 'the defaults are in the set')
  assert.equal(applied['kimi-code.cli'], undefined, 'a form that is not of a host tree has no set')
})


test('W71 a system-proxy change (ProxyServer, or ProxyOverride alone) gives one reload, one netenv-change, zero failures; a change whose answers equal the group\'s last reloads nothing', async () => {
  const r = await rigged(['codex'], { desired: { codex: { desired: 'on' } }, rels: [[path.join('.codex', '.env'), 'API_KEY=1\n']] })
  await r.redirector.attach()
  const reloads0 = r.kernel.reloads.length
  r.box.reg.internet.ProxyServer = sz('127.0.0.1:7890') // the port moved: codex's upstream moves with it
  await r.timers.tick()
  assert.equal(r.kernel.reloads.length - reloads0, 1, 'one reload')
  const changes = r.events.filter((e) => e.event === 'netenv-change')
  assert.equal(changes.length, 1)
  assert.equal(changes[0].from, '127.0.0.1:7897')
  assert.equal(changes[0].to, '127.0.0.1:7890')
  assert.deepEqual(r.failures, [], 'zero failures')
  r.box.reg.internet.ProxyOverride = sz('localhost;10.*;<local>') // the bypass table alone moves it too (W72)
  await r.timers.tick()
  assert.equal(r.kernel.reloads.length - reloads0, 2)
  assert.equal(r.events.filter((e) => e.event === 'netenv-change').length, 2)
  // a read that fails and comes back with the same answers: two changes, zero reloads (4.8 §2.2)
  const before = r.kernel.reloads.length
  r.box.reg.fail = 'helper-timeout'
  await r.timers.tick()
  r.box.reg.fail = null
  await r.timers.tick()
  assert.equal(r.events.filter((e) => e.event === 'netenv-change').length, 4, 'each change is one event (the group stays on its last upstream, said)')
  assert.equal(r.kernel.reloads.length, before, 'zero reloads: the answers did not move')
  assert.deepEqual(r.failures, [])
})

test('W71 the watcher stops with the collector: close() stops it (no timer left)', async () => {
  const r = await rigged(['codex'], { desired: { codex: { desired: 'on' } } })
  await r.redirector.win32.close()
  r.box.reg.internet.ProxyServer = sz('127.0.0.1:1')
  await r.timers.tick()
  assert.equal(r.events.filter((e) => e.event === 'netenv-change').length, 0)
})

test('refreshProbes (4.8 §3.3 「引擎(重)启动之后」): every on-form\'s fallback group is health-tested NOW through the kernel\'s own controller, with the group\'s own probe address (mihomo remembers health per address); nobody else is asked, and a kernel that is not running is said, not thrown', async () => {
  const asked = []
  const r = await rigged(['claude-code', 'codex', 'hermes'], {
    desired: { 'claude-code': { desired: 'on' }, codex: { desired: 'on' }, hermes: { desired: 'off' } },
    over: { deps: { probeController: (creds) => ({ async get(p) { asked.push([creds, p]); return /codex/.test(p) ? { ok: false, status: 0 } : { ok: true, status: 200 } } }) } },
  })
  assert.deepEqual(await r.redirector.win32.refreshProbes(), { ok: true, asked: [
    { f: 'claude-code.cli', ok: true, status: 200 },
    { f: 'claude-code.vscode', ok: true, status: 200 },
    { f: 'codex.cli', ok: false, status: 0 },
    { f: 'codex.vscode', ok: false, status: 0 },
    { f: 'codex.app', ok: false, status: 0 },
  ] }, 'each on-form\'s answer is carried, the failed ones included (the daemon records them)')
  const ports = r.redirector.win32.ingress().groupPorts
  const want = (f, g) => `/group/asight-fb-${f}/delay?url=${encodeURIComponent(`http://127.0.0.1:${ports[g]}/asight-health/${f}`)}&timeout=2000`
  assert.deepEqual(asked, [
    [{ port: 19001, secret: 'control-secret-0123456789' }, want('claude-code.cli', 'claude-code.settings')],
    [{ port: 19001, secret: 'control-secret-0123456789' }, want('claude-code.vscode', 'claude-code.settings')],
    [{ port: 19001, secret: 'control-secret-0123456789' }, want('codex.cli', 'codex.env')],
    [{ port: 19001, secret: 'control-secret-0123456789' }, want('codex.vscode', 'codex.env')],
    [{ port: 19001, secret: 'control-secret-0123456789' }, want('codex.app', 'codex.env')],
  ], 'the kernel\'s own controller (its credentials), every supported form of an on group and nobody else: hermes is off, an opt-in group is not on without its record')
  // a kernel that is not running (its supervisor between attempts), or a forwarder with no controller, is an answer — never a throw
  const down = await rigged(['codex'], { desired: { codex: { desired: 'on' } }, over: { deps: { forwarder: { state: () => ({ phase: 'backoff' }), controller: () => ({ port: 19001, secret: 's' }) } } } })
  assert.deepEqual(await down.redirector.win32.refreshProbes(), { ok: false, reason: 'no kernel' })
  const bare = await rigged(['codex'], { desired: { codex: { desired: 'on' } }, over: { deps: { forwarder: { state: () => ({ phase: 'running' }), controller: () => null } } } })
  assert.deepEqual(await bare.redirector.win32.refreshProbes(), { ok: false, reason: 'no kernel' })
  // the production path borrows the forwarder's ONE client (N15 (a): createController({own:true}) lives in forwarder.mjs alone; the wiring must not make its own)
  const borrowed = []
  const own = await rigged(['codex'], {
    desired: { codex: { desired: 'on' } },
    over: { deps: { forwarder: { state: () => ({ phase: 'running' }), controller: () => ({ port: 19001, secret: 's' }), client: () => ({ async get(p) { borrowed.push(p); return { ok: true, status: 200 } } }) } } },
  })
  const ownR = await own.redirector.win32.refreshProbes()
  assert.equal(ownR.ok, true)
  assert.equal(ownR.asked.length, 3)
  assert.ok(borrowed.length === 3 && borrowed.every((p) => p.startsWith('/group/asight-fb-codex.')), 'every ask went through the forwarder\'s client, none anywhere else')
  const noClient = await rigged(['codex'], { desired: { codex: { desired: 'on' } }, over: { deps: { forwarder: { state: () => ({ phase: 'running' }), controller: () => ({ port: 19001, secret: 's' }) } } } })
  assert.deepEqual(await noClient.redirector.win32.refreshProbes(), { ok: false, reason: 'no kernel' }, 'a forwarder without a client is an answer, not a crash')
})

test('prepare (W27 ⑥): a missing or mismatched kernel is a refusal whose commands are the two reinstall lines (reinstallCommands gives {npm, release}; an array passes through) and whose mismatch says `of`; without commands there is no key', async () => {
  const cmds = { npm: 'npm install --global asight@0.0.0 --include=optional', release: 'npm install --global asight-0.0.0.tgz asight-kernel-win32-x64-0.0.0.tgz' }
  const off = async () => 'off'
  assert.deepEqual(await prepare({ locate: async () => ({ missing: { reason: 'package-not-installed', commands: cmds } }), sac: off }), {
    refuse: { code: 'forwarder-binary-missing', reason: 'the pinned kernel package was not found (package-not-installed)', commands: [cmds.npm, cmds.release] },
  })
  assert.deepEqual(await prepare({ locate: async () => ({ mismatch: { of: 'package', commands: cmds } }), sac: off }), {
    refuse: { code: 'forwarder-digest-mismatch', reason: "the pinned kernel package holds an exe whose digest is not the pin's", of: 'package', commands: [cmds.npm, cmds.release] },
  })
  assert.deepEqual(await prepare({ locate: async () => ({ missing: { reason: 'not-pinned', commands: ['one line'] } }), sac: off }), {
    refuse: { code: 'forwarder-binary-missing', reason: 'the pinned kernel package was not found (not-pinned)', commands: ['one line'] },
  }, 'an array of commands passes through as it is')
  const bare = await prepare({ locate: async () => ({ missing: { reason: 'unsupported-arch' } }), sac: off })
  assert.equal('commands' in bare.refuse, false)
})

test('prepare (W74): the kernel line, and the Smart App Control line only when it is on or evaluating (off lacks it, unknown says so with its reason); an injected sac gets the helper it was given (none if none), the real reader starts a helper of its own only when none is given', async () => {
  const found = () => ({ found: { sha256: 'a'.repeat(64), packageDir: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\asight-kernel-win32-x64' } })
  const kernelLine = `asight's kernel: found and verified (${'a'.repeat(12)}… in ${found().found.packageDir})`
  const starts = []
  const start = (o) => { starts.push(o); return { async call() { return { keyExists: true, values: { VerifiedAndReputablePolicyState: { kind: 'REG_DWORD', value: 2 } } } }, async close() {} } }
  const seen = []
  const sacOf = (state) => async (a) => { seen.push(a); return state }
  // the same two reads as data, for the Windows plan's own kernel and Smart App Control lines (4.8 §11): the pin this build carries (version and the platform package of the architecture asked) and the digest that was verified
  const KERNEL64 = { version: 'v1.19.32', package: 'asight-kernel-win32-x64', exe: 'asight-forwarder.exe', sha256: 'a'.repeat(64) }
  // an injected sac: no helper of its own is started for it — it gets the helper it was given, none if none
  const p1 = await prepare({ locate: found, sac: sacOf('off'), start, arch: 'x64' })
  assert.deepEqual(starts, [])
  assert.deepEqual(seen, [{ helper: null }])
  assert.deepEqual(p1, { notes: [kernelLine], kernel: KERNEL64, sac: 'off' }, 'Smart App Control off: no line of it')
  const p2 = await prepare({ locate: found, sac: sacOf('evaluation'), start, arch: 'x64' })
  assert.equal(p2.notes.length, 2)
  assert.match(p2.notes[1], /^Smart App Control 开着/)
  assert.deepEqual([p2.kernel, p2.sac], [KERNEL64, 'evaluation'], 'the data of the two lines the plan draws')
  const unknown = await prepare({ locate: found, sac: sacOf({ unknown: { reason: 'timeout' } }), start, arch: 'x64' })
  assert.match(unknown.notes[1], /^Smart App Control 的状态读不到\(timeout\)/, 'an unreadable state says 不知道, not a guess')
  assert.deepEqual(unknown.sac, { unknown: { reason: 'timeout' } }, 'and the data says it the same way')
  const h = { async call() { return { keyExists: false, values: {} } }, async close() {} }
  await prepare({ helper: h, locate: found, sac: sacOf('on'), start, arch: 'x64' })
  assert.deepEqual(seen[seen.length - 1], { helper: h }, 'a helper passed in reaches the injected sac as it was given')
  assert.deepEqual(starts, [], 'and asight still started none for it')
  // the real reader (sacState): a helper of its own is started when none is given, and closed after
  const real = await prepare({ locate: found, start, arch: 'x64' })
  assert.equal(starts.length, 1, 'the real reader gets a helper of its own')
  assert.equal(real.notes.length, 2)
  assert.match(real.notes[1], /^Smart App Control 开着/, 'the fake helper answers evaluation (2)')
  const broken = await prepare({ locate: found, start: () => { throw new Error('policy blocked the script') }, arch: 'x64' })
  assert.match(broken.notes[1], /^Smart App Control 的状态读不到\(denied:no helper\)/, 'a helper that cannot be started is said, not thrown')
})
