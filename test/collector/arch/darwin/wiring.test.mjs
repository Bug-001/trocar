// test/collector/arch/darwin/wiring.test.mjs — the daemon's macOS half (RFC 4.9 §1 接线 · §2.2 · §5; the case list is 4.8 §1's W39 W71, plan Task 8(c), with the lazy rule's own case).
// createDarwinCollector is what loadArch('darwin') hands the daemon: the watcher, ingress config, kernel, entries writer and route plan in one Redirector, plus the darwin bag
// the daemon reaches (osMatch, replan, carried, the applied host sets). Everything is injected: a fake scutil, kernel and process watcher — no real ps, lsof or scutil runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { loadArch } from '../../../../src/collector/arch/index.mjs'
import { createDarwinCollector, prepare, ensureKernel } from '../../../../src/collector/arch/darwin/wiring.mjs'
import { loadPin, KERNEL_EXE } from '../../../../src/collector/arch/darwin/forwarder.mjs'
import { checkRecord } from '../../../../src/health/codes.mjs'
import { groupsOf } from '../../../../src/collector/arch/darwin/route-plan.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { installCollector } from '../../../../src/collector/install.mjs'
import { readManifest } from '../../../../src/collector/core/trust/journal.mjs'
import { MARKER_TOLERANCE_MS } from '../../../../src/collector/core/trust/confirm.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const ALL = await loadHarnesses()
const one = (name) => ALL.find((d) => d.name === name)
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
const sha = (b) => createHash('sha256').update(b).digest('hex')
const EXE = Buffer.from('feedface fake asight-forwarder, sixty kilobytes of nothing '.repeat(8))
const GZ = gzipSync(EXE) // the darwin release's shape: a .gz single binary, unpacked by node:zlib for real
const GROUPS = groupsOf(ALL)
/** The scutil dictionary of a machine whose https traffic follows a local proxy (the VERGE of the win32 test, in scutil's own key names). */
const VERGE = { HTTPSEnable: '1', HTTPSProxy: '127.0.0.1', HTTPSPort: '7897', HTTPEnable: '0', HTTPProxy: '', HTTPPort: '0', SOCKSEnable: '0', SOCKSProxy: '', SOCKSPort: '0', ProxyAutoConfigEnable: '0', ExceptionsList: ['localhost', '<local>'] }

/** A fake scutil: `exec` (execTool's `run`, spawnSync-shaped) answering `scutil --proxy` from a mutable dictionary; `fail` makes the read fail the named way. */
function fakeScutil(initial = VERGE) {
  const box = { dict: { ...initial, ...(initial.ExceptionsList ? { ExceptionsList: [...initial.ExceptionsList] } : {}) }, fail: null }
  const text = () => {
    const lines = ['<dictionary> {']
    for (const [k, v] of Object.entries(box.dict)) {
      if (Array.isArray(v)) { lines.push(`${k} : <array> {`); v.forEach((item, i) => lines.push(`${i} : ${item}`)); lines.push('}') } else lines.push(`${k} : ${v}`)
    }
    lines.push('}')
    return lines.join('\n')
  }
  const exec = (file, args) => {
    if (box.fail) return { status: null, stdout: '', stderr: box.fail }
    if (file === 'scutil' && args[0] === '--proxy') return { status: 0, stdout: `${text()}\n`, stderr: '' }
    return { status: 1, stdout: '', stderr: `the fake scutil does not answer ${file} ${JSON.stringify(args)}` }
  }
  return { box, exec }
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
      async drain() { return { stopped: false, cancelled: false } },
      async stopNow() { return { stopped: true, now: true } },
    },
  }
}

/** A sandbox home with the harnesses' trust entries really installed, the fake scutil, and a collector wiring over it all — started, as the daemon starts one (the LAZY RULE:
 *  construction builds, start() reads the network and plans; the first plan exists only after it). */
async function rigged(names, { proxyDict = VERGE, desired = {}, rels = [], optIns = [], over = {} } = {}) {
  const home = tmpDir('asight-wiring-')
  for (const [rel, text = ''] of rels) { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  const ds = names.map(one)
  await installCollector({ home, env: { HOME: home }, osName: 'darwin', harnesses: ds, freePort: async () => 47011, roots: { node: [], osText: '' } })
  const dir = path.join(home, '.asight', 'collector')
  const scutil = fakeScutil(proxyDict)
  const kernel = fakeKernel()
  const events = []
  const failures = []
  let ports = 18800
  const timers = fakeTimers()
  const deps = {
    exec: scutil.exec, procWatcher: fakeWatcher(), forwarder: kernel.forwarder,
    loadIngress: async () => ({ enginePort: 18790, groupPorts: Object.fromEntries(GROUPS.map((x) => [x.g, ++ports])), ingressToken: 'a'.repeat(32), listenerToken: 'b'.repeat(32) }),
    controller: { port: 19001, secret: 's' }, isFree: async () => true, random: (n) => Buffer.alloc(n, 7),
    timers: timers.timers,
    ...over.deps,
  }
  const state = { desired }
  const redirector = await createDarwinCollector({
    env: { HOME: home }, dir, home, harnesses: ds,
    failure: (where, e, extra) => failures.push({ where, reason: String((e && e.message) || e), ...(extra || {}) }),
    event: (rec) => events.push(rec),
    manifest: () => readManifest(dir), desired: () => state.desired, optIns: () => optIns,
    deps,
  })
  await redirector.start()
  return { home, dir, box: scutil.box, kernel, events, failures, redirector, timers, deps, state }
}

test('W39 loadArch("darwin") returns the darwin arch on any OS, with the pieces the CLI and daemon reach', async () => {
  const A = await loadArch('darwin')
  assert.equal(A.os, 'darwin')
  assert.equal(A.install, null, 'the machine-wide helper is a Linux thing; darwin needs none (4.9 §1)')
  assert.equal(A.osRootsFile, undefined, 'the darwin roots are read through osRoots(), not a file (4.9 §6.2)')
  assert.equal(typeof A.unit.userUnit, 'function', 'the autostart unit (launchd, 4.9 §4)')
  assert.equal(typeof A.controlEndpoint, 'function')
  assert.equal(typeof A.refuseElevated, 'function')
  assert.equal(typeof A.nodePreflight, 'function')
  assert.equal(typeof A.prepare, 'function', 'the read-only hook `asight on` calls (W27 ⑥, W74)')
  assert.equal(typeof A.ensureKernel, 'function', 'D44: the kernel\'s download+verify+place, the first write-phase step of a real `on`')
  assert.equal(typeof A.osRoots, 'function')
  assert.equal(typeof A.createRedirector, 'function')
  assert.equal(typeof A.netFacts, 'function', 'darwin\'s netFacts is this unit\'s (1.6 §9.7 archFacts, 4.9 §10) — not the win line\'s open Task 10')
  assert.equal(A.runSupervisor, undefined, 'launchd KeepAlive really respawns: no supervisor parent on darwin (4.9 §4)')
  const linux = await loadArch('linux')
  assert.equal(linux.prepare, undefined, 'the Linux arch has no prepare and its on is unchanged')
  assert.equal(linux.ensureKernel, undefined, 'and no kernel to download: driver mode (D44)')
})

test('prepare (W27 ⑥, D44, darwin\'s half — the pin is ALWAYS its own): the three states on an empty HOME — the download line, never the unsupported-arch refusal the missing-pin bug gave every real-machine on; the refusal states carry the manual alternative (none for an architecture nobody pins)', async () => {
  const home = tmpDir('asight-prepare-')
  const p = await prepare({ home, arch: process.arch === 'arm64' || process.arch === 'x64' ? process.arch : 'arm64' })
  if (p.refuse) {
    assert.equal(p.refuse.code, 'forwarder-binary-missing')
    assert.doesNotMatch(p.refuse.reason, /architecture/, 'the real machine\'s architecture is in the pin: not the unsupported-arch refusal the missing-pin bug gave')
    return // a pin whose exe digest is null is a legitimate not-pinned refusal
  }
  assert.equal(p.kernel.state, 'will-download', 'an empty HOME holds no kernel and no cache: the download line')
  assert.match(p.kernel.host, /^github\.com$/)
  assert.match(p.notes[0], /^asight's kernel: not there yet — mihomo v1\.19\.32 will be downloaded \(archive \d+(\.\d+)? MB, sha256 pinned, from github\.com\) once you confirm/)
  // the run location and the cache are READY; a refusal carries the alternative
  const ready = await prepare({ home, locate: async () => ({ found: { at: 'run', exe: path.join(home, 'kernel', KERNEL_EXE), sha256: 'a'.repeat(64), size: 1 } }), arch: 'arm64' })
  assert.deepEqual([ready.kernel.state, ready.kernel.at], ['ready', 'run'])
  assert.match(ready.notes[0], /in kernel\//)
  const cached = await prepare({ home, locate: async () => ({ found: { at: 'cache', archive: 'x', sha256: 'b'.repeat(64), size: 2 } }), arch: 'arm64' })
  assert.match(cached.notes[0], /in the archive cache/)
  const missing = await prepare({ home, locate: async () => ({ missing: { reason: 'not-pinned', alternative: '把 x 放进 kernel-archive/ 再跑 asight on' } }), arch: 'arm64' })
  assert.deepEqual(missing, { refuse: { code: 'forwarder-binary-missing', reason: 'the pin carries no exe digest, so nothing can be verified against it', commands: ['把 x 放进 kernel-archive/ 再跑 asight on'] } })
  const bare = await prepare({ home, locate: async () => ({ missing: { reason: 'unsupported-arch', alternative: null } }), arch: 'ia32' })
  assert.equal('commands' in bare.refuse, false)
  await assert.rejects(() => prepare({ locate: async () => ({ found: { at: 'run', exe: 'x', sha256: 'a'.repeat(64), size: 1 } }), arch: 'arm64' }), /prepare needs home/)
})

test('ensureKernel (D44, darwin\'s half): download (one curl, the .gz gunzipped by zlib, the two events in flows/), run (nothing done), failure (not-ok with the manual alternative, the failure event on disk)', async () => {
  const pin = JSON.parse(JSON.stringify(loadPin()))
  pin.assets.arm64.sha256 = sha(GZ); pin.assets.arm64.size = GZ.length
  pin.assets.arm64.exe = { name: KERNEL_EXE, size: EXE.length, sha256: sha(EXE) }
  const mk = ({ curl = true } = {}) => {
    const home = tmpDir('asight-ensure-')
    const calls = []
    const execFile = (cmd, args, opts, cb) => {
      calls.push([cmd, ...args])
      if (cmd !== 'curl') return cb(new Error(`not in the fake: ${cmd}`)) // darwin's unpack is zlib: curl is the only exec
      if (args[0] === '--version') return cb(null, 'curl 8.7.1', '')
      if (typeof curl === 'number') return cb(Object.assign(new Error('x'), { code: curl }), '', 'boom')
      fs.writeFileSync(args[args.indexOf('-o') + 1], GZ)
      cb(null, '', '')
    }
    return { home, calls, execFile }
  }
  const dl = mk()
  const r0 = await ensureKernel({ home: dl.home, arch: 'arm64', execFile: dl.execFile, pin })
  assert.deepEqual([r0.ok, r0.from, r0.sha256], [true, 'download', sha(EXE)])
  assert.equal(dl.calls.filter((c) => c[0] === 'curl' && c.includes(pin.assets.arm64.url)).length, 1, 'exactly one curl against the pinned URL')
  assert.equal(fs.statSync(r0.path).mode & 0o777, 0o755, 'the placed binary is executable')
  const recordsOf = (home) => fs.readdirSync(path.join(home, '.asight', 'collector', 'flows')).flatMap((f) => fs.readFileSync(path.join(home, '.asight', 'collector', 'flows', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
  assert.deepEqual(recordsOf(dl.home).map((r) => r.event), ['forwarder-download-started', 'forwarder-download-ok'], 'the download\'s records are in flows/ (D38)')
  assert.deepEqual(recordsOf(dl.home).flatMap(checkRecord), [], 'and they are in the closed sets')
  const again = await ensureKernel({ home: dl.home, arch: 'arm64', execFile: dl.execFile, pin })
  assert.deepEqual([again.ok, again.from, again.note], [true, 'run', null], 'no note: nothing happened an operator must be told')
  const bad = mk({ curl: 22 })
  const r1 = await ensureKernel({ home: bad.home, arch: 'arm64', execFile: bad.execFile, pin })
  assert.equal(r1.ok, false)
  assert.match(r1.reason, /^curl exited 22: boom; nothing was changed\. 手动替代\(asight 不替你跑\): 把 mihomo-darwin-arm64-v1\.19\.32\.gz 放进 /)
  assert.deepEqual(recordsOf(bad.home).map((r) => [r.event, r.code ?? null]), [['forwarder-download-started', null], ['failure', 'forwarder-download-failed']], 'the failure is on disk, not only in the receipt (D38)')
})

test('the lazy rule: a construction without the dir (loadParts\' { env } one) builds the shell and touches nothing — no ingress.json anywhere, scan works, attach refuses, osMatch judges', async () => {
  const home = tmpDir('asight-wiring-shell-')
  const box = fakeScutil()
  const redirector = await createDarwinCollector({ env: { HOME: home }, harnesses: ALL, deps: { exec: box.exec, procWatcher: fakeWatcher() } })
  assert.deepEqual(fs.readdirSync(home), [], 'nothing was written into the home of a read-only command')
  assert.equal(typeof redirector.scan, 'function')
  await assert.rejects(redirector.attach(), /attach needs the forwarder and the entries/, 'the shell cannot attach: there is no kernel and no entries writer to attach with')
  assert.equal(redirector.darwin.osMatch.darwin({ exe: '/Users/x/.local/bin/claude', cmdline: '/Users/x/.local/bin/claude' }), 'claude-code', 'the forms of the descriptors it was handed are judged (the registry\'s second key)')
  assert.equal(redirector.darwin.osMatch.darwin({ exe: '/usr/bin/curl', cmdline: 'curl https://example.com' }), null, 'a non-agent process is no harness\'s')
})

test('the wiring plans from the daemon\'s own ctx and serves an `of.<form>` lookup with capture:"proxy" and the group\'s upstream', async () => {
  const r = await rigged(['claude-code', 'codex'], { desired: { 'claude-code': { desired: 'on' }, codex: { desired: 'on' } } })
  assert.equal(r.redirector.darwin.netenv().systemProxy.ok, true)
  assert.equal(r.redirector.darwin.netenv().systemProxy.HTTPSProxy, '127.0.0.1')
  assert.equal(r.redirector.darwin.netenv().systemProxy.HTTPSPort, 7897)
  const meta = await r.redirector.lookupIngress({ user: 'of.claude-code.cli', target: { address: 'api.example.com', port: 443 } })
  assert.equal(meta.capture, 'proxy')
  assert.equal(meta.agent, 'claude-code')
  assert.equal(meta.form, 'claude-code.cli')
  assert.equal(meta.upstream.kind, 'direct', 'claude-code does not follow the system proxy (its own files hold no proxy here): direct')
  const codex = await r.redirector.lookupIngress({ user: 'of.codex.cli', target: { address: 'api.example.com', port: 443 } })
  assert.deepEqual([codex.upstream.kind, codex.upstream.host, codex.upstream.port], ['http', '127.0.0.1', 7897], 'codex follows the system proxy (scutil, 4.9 §2.2)')
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
  await r.redirector.darwin.replan({ reload: true })
  const last = r.kernel.reloads[r.kernel.reloads.length - 1]
  assert.match(last.text, /asight-l-codex\.env/, 'the off group keeps its listener (carried): forward-only, its port does not go away')
  assert.equal(JSON.stringify(last.forms).includes('"on":true'), false, 'no form of it is on')
  const undone = fs.readFileSync(f, 'utf8')
  assert.equal([...undone.matchAll(/^HTTPS_PROXY=/gm)].length, 0, 'and its proxy entry is undone (the plan says off)')
})

test('ownImages are the daemon\'s node and the kernel\'s binary, and the host sets of a host-tree form are applied at on and kept for status', async () => {
  // no darwin form declares a host tree yet (the kimi VS Code shape is not-measured until MA4), so this case pins the wiring's machinery with a hand-made descriptor of the same
  // shape — a form whose hosts are a settings file plus defaults, the way the win32 kimi form declares them
  const home = tmpDir('asight-wiring-hosts-')
  fs.mkdirSync(path.join(home, 'relay'), { recursive: true })
  fs.writeFileSync(path.join(home, 'relay', 'settings.json'), '{"api_base": "https://from-settings.relay.example/v1"}\n')
  const made = {
    name: 'made-up',
    proxy: { env: ['HTTPS_PROXY'], files: [], systemProxy: { http: false, ws: false }, schemes: ['http'], unsupported: {}, branches: ['all'], measured: { win32: 'inferred', linux: 'inferred', darwin: 'inferred' }, restart: { hint: 'restart it', processes: ['made-up'] } },
    darwin: {
      groups: [{ g: 'made-up.settings', proxyEntry: { kind: 'file', format: 'json-key', files: (ctx) => [path.join(ctx.home, 'relay', 'settings.json')], key: ['HTTPS_PROXY'] }, auth: true, followsSystemProxy: { http: false, ws: false } }],
      forms: [{ id: 'made-up.cli', g: 'made-up.settings', match: { image: 'made-up' }, nameRule: false, processRules: true, supported: true, hosts: { defaults: ['api.made-up.example'], settings: { file: (ctx) => path.join(ctx.home, 'relay', 'settings.json'), hostsOf: (text) => { const j = JSON.parse(text); return typeof j.api_base === 'string' ? [new URL(j.api_base).hostname] : [] } } } }],
      proxy: { env: ['HTTPS_PROXY'], files: [], systemProxy: { http: false, ws: false }, schemes: ['http'], unsupported: {}, branches: ['all'], measured: { darwin: 'inferred' }, restart: { hint: 'restart it', processes: ['made-up'] } },
      inject: () => ({ entries: [] }),
    },
  }
  const box = fakeScutil()
  const kernel = fakeKernel()
  let ports = 18800
  const redirector = await createDarwinCollector({
    env: { HOME: home }, dir: path.join(home, '.asight', 'collector'), home, harnesses: [made],
    failure: () => {}, event: () => {}, desired: () => ({ 'made-up': { desired: 'on', extra_hosts: ['extra.relay.example'] } }), optIns: () => [],
    deps: { exec: box.exec, procWatcher: fakeWatcher(), forwarder: kernel.forwarder, loadIngress: async () => ({ enginePort: 18790, groupPorts: { 'made-up.settings': ++ports }, ingressToken: 'a'.repeat(32), listenerToken: 'b'.repeat(32) }), controller: { port: 19001, secret: 's' }, isFree: async () => true, random: (n) => Buffer.alloc(n, 7), timers: fakeTimers().timers, watchSystemProxy: false },
  })
  await redirector.start()
  assert.deepEqual(redirector.darwin.kernelExe, path.join(home, '.asight', 'collector', 'kernel', 'asight-forwarder'))
  assert.deepEqual(redirector.darwin.ownImages ?? null, null, 'ownImages is the redirector\'s, not the bag\'s (the win32 bag\'s shape has no ownImages either)')
  const applied = redirector.darwin.appliedHosts()
  const set = applied['made-up.cli']
  assert.ok(set, 'the host-tree form\'s set is applied (the group is on)')
  assert.ok(set.hosts.includes('from-settings.relay.example'), 'the settings\' relay is in the set')
  assert.ok(set.hosts.includes('extra.relay.example'), 'the operator\'s extra_hosts is in the set')
  assert.ok(set.hosts.includes('api.made-up.example'), 'the defaults are in the set')
})

test('W71 a system-proxy change (the https hop, or ExceptionsList alone) gives one reload, one netenv-change, zero failures; a change whose answers equal the group\'s last reloads nothing', async () => {
  const r = await rigged(['codex'], { desired: { codex: { desired: 'on' } }, rels: [[path.join('.codex', '.env'), 'API_KEY=1\n']] })
  await r.redirector.attach()
  const reloads0 = r.kernel.reloads.length
  r.box.dict.HTTPSPort = '7890' // the port moved: codex's upstream moves with it
  await r.timers.tick()
  assert.equal(r.kernel.reloads.length - reloads0, 1, 'one reload')
  const changes = r.events.filter((e) => e.event === 'netenv-change')
  assert.equal(changes.length, 1)
  assert.equal(changes[0].from, '127.0.0.1:7897')
  assert.equal(changes[0].to, '127.0.0.1:7890')
  assert.deepEqual(r.failures, [], 'zero failures')
  r.box.dict.ExceptionsList = ['localhost', '10.*', '<local>'] // the bypass table alone moves it too (W72)
  await r.timers.tick()
  assert.equal(r.kernel.reloads.length - reloads0, 2)
  assert.equal(r.events.filter((e) => e.event === 'netenv-change').length, 2)
  // a read that fails and comes back with the same answers: two changes, zero reloads (4.8 §2.2, carried by 4.9 §2.2)
  const before = r.kernel.reloads.length
  r.box.fail = 'scutil timed out'
  await r.timers.tick()
  r.box.fail = null
  await r.timers.tick()
  assert.equal(r.events.filter((e) => e.event === 'netenv-change').length, 4, 'each change is one event (the group stays on its last upstream, said)')
  assert.equal(r.kernel.reloads.length, before, 'zero reloads: the answers did not move')
  assert.deepEqual(r.failures, [])
})

test('W71 the watcher stops with the collector: close() stops it (no timer left)', async () => {
  const r = await rigged(['codex'], { desired: { codex: { desired: 'on' } } })
  await r.redirector.darwin.close()
  r.box.dict.HTTPSPort = '1'
  await r.timers.tick()
  assert.equal(r.events.filter((e) => e.event === 'netenv-change').length, 0)
})

// ---------- the two seams the close-out review found dead (F1, F2) — these tests run them through the REAL callers ----------

test('review F1: the daemon\'s own loadParts on darwin lands the shell whole — osMatch alive through the registry, not a Promise behind the guard (the pre-fix line awaited nothing)', { skip: process.platform !== 'darwin' }, async () => {
  const { loadParts } = await import('../../../../src/collector/daemon.mjs')
  const parts = await loadParts({ env: { HOME: '/Users/x' }, harnesses: ALL })
  assert.equal(parts.os, 'darwin')
  assert.equal(parts.match({ os: 'darwin', pid: 10, exe: '/Users/x/.local/bin/claude', cmdline: '/Users/x/.local/bin/claude' }).agent, 'claude-code',
    'the registry judged darwin facts through osMatch: with the Promise, redirector.darwin read undefined, osMatch fell to null and this answer was null — nothing on macOS matched anything')
  assert.equal(parts.match({ os: 'darwin', pid: 11, exe: '/usr/bin/curl', cmdline: 'curl https://example.com' }).agent, null, 'and a non-agent still matches nothing')
})

test('review F2: start() claims a kernel a previous daemon left running BEFORE it reads the network or plans — a KeepAlive-restarted daemon adopts, it does not run into port-taken', async () => {
  const calls = []
  const kernel = fakeKernel()
  const withAdopt = Object.assign(kernel.forwarder, { async adopt() { calls.push('adopt'); return { adopted: false } } })
  const scutil = fakeScutil(VERGE)
  const exec = (file, args) => { if (file === 'scutil' && args[0] === '--proxy') calls.push('scutil'); return scutil.exec(file, args) }
  await rigged(['claude-code'], { desired: { 'claude-code': { desired: 'on' } }, over: { deps: { forwarder: withAdopt, exec } } })
  assert.equal(calls[0], 'adopt', 'the claim comes first')
  assert.ok(calls.indexOf('scutil') > calls.indexOf('adopt'), 'then the network is read and the first plan is made')
})
