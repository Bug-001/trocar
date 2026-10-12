// test/collector/arch/darwin/wiring.test.mjs — the daemon's macOS half (RFC 4.9 §1 接线 · §2.2 · §5, as D47 wrote it; the case list is 4.8 §1's W39 W71, plan Task 8(c), with the lazy rule's own case).
// createDarwinCollector is what loadArch('darwin') hands the daemon: the ingress config, the entries writer and the route plan in one Redirector, plus the darwin bag the daemon
// reaches (bindDoors, osMatch, replan, carried, the applied host sets). There is no kernel any more (D47: the engine's doors are the only proxy) and no process watcher (the scan
// is deleted; identity is the door's own targeted questions). Everything is injected: a fake scutil and a doors recorder — no real ps, lsof or scutil runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadArch } from '../../../../src/collector/arch/index.mjs'
import { createDarwinCollector } from '../../../../src/collector/arch/darwin/wiring.mjs'
import { groupsOf } from '../../../../src/collector/arch/darwin/route-plan.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { installCollector } from '../../../../src/collector/install.mjs'
import { readManifest } from '../../../../src/collector/core/trust/journal.mjs'
import { saveManifest } from '../../../../src/off/manifest.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const ALL = await loadHarnesses()
const one = (name) => ALL.find((d) => d.name === name)
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

/** The engine's door half as a recorder: what was opened and closed, and with which credentials. */
function fakeDoors() {
  const opened = []
  const closed = []
  return {
    opened, closed,
    open: async (list) => { opened.push(list.map(({ id, port, auth, token }) => ({ id, port, auth, token: token ? 'listener' : null }))); return list.map((x) => ({ [x.id]: x.port })) },
    close: async (ids) => { closed.push([...ids]) },
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
  const doors = fakeDoors()
  const events = []
  const failures = []
  let ports = 18800
  const timers = fakeTimers()
  const deps = {
    exec: scutil.exec,
    loadIngress: async () => ({ enginePort: 18790, groupPorts: Object.fromEntries(GROUPS.map((x) => [x.g, ++ports])), ingressToken: 'a'.repeat(32), listenerToken: 'b'.repeat(32) }),
    isFree: async () => true, random: (n) => Buffer.alloc(n, 7),
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
  redirector.darwin.bindDoors(doors) // what the daemon does the moment the engine exists (daemon.mjs's bindDoors arm)
  await redirector.start()
  return { home, dir, box: scutil.box, doors, events, failures, redirector, timers, deps, state }
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
  assert.equal(A.prepare, undefined, 'no kernel to preflight: the engine\'s doors are the only proxy (D47), `on` needs no download')
  assert.equal(A.ensureKernel, undefined, 'and nothing to ensure: the first write-phase step of a real `on` is the CA, as on Linux')
  assert.equal(typeof A.osRoots, 'function')
  assert.equal(typeof A.createRedirector, 'function')
  assert.equal(typeof A.netFacts, 'function', 'darwin\'s netFacts is this unit\'s (1.6 §9.7 archFacts, 4.9 §10) — not the win line\'s open Task 10')
  assert.equal(A.runSupervisor, undefined, 'launchd KeepAlive really respawns: no supervisor parent on darwin (4.9 §4)')
  const linux = await loadArch('linux')
  assert.equal(linux.prepare, undefined, 'the Linux arch has no prepare and its on is unchanged')
  assert.equal(linux.ensureKernel, undefined, 'and no kernel to download: driver mode (D44)')
})



test('the lazy rule: a construction without the dir (loadParts\' { env } one) builds the shell and touches nothing — no ingress.json anywhere, scan works, attach refuses, osMatch judges', async () => {
  const home = tmpDir('asight-wiring-shell-')
  const box = fakeScutil()
  const redirector = await createDarwinCollector({ env: { HOME: home }, harnesses: ALL, deps: { exec: box.exec } })
  assert.deepEqual(fs.readdirSync(home), [], 'nothing was written into the home of a read-only command')
  assert.equal(typeof redirector.scan, 'function')
  await assert.rejects(redirector.attach(), /attach needs the doors and the entries/, 'the shell cannot attach: there is no entries writer to attach with')
  assert.equal(redirector.darwin.osMatch.darwin({ exe: '/Users/x/.local/bin/claude', cmdline: '/Users/x/.local/bin/claude' }), 'claude-code', 'the forms of the descriptors it was handed are judged (the registry\'s second key)')
  assert.equal(redirector.darwin.osMatch.darwin({ exe: '/usr/bin/curl', cmdline: 'curl https://example.com' }), null, 'a non-agent process is no harness\'s')
})

test('the wiring plans from the daemon\'s own ctx and serves a door\'s lookup with capture:"proxy" and the group\'s upstream (the door names its group — D47; no identity questions are wired here, so no pid)', async () => {
  const r = await rigged(['claude-code', 'codex'], { desired: { 'claude-code': { desired: 'on' }, codex: { desired: 'on' } } })
  assert.equal(r.redirector.darwin.netenv().systemProxy.ok, true)
  assert.equal(r.redirector.darwin.netenv().systemProxy.HTTPSProxy, '127.0.0.1')
  assert.equal(r.redirector.darwin.netenv().systemProxy.HTTPSPort, 7897)
  const meta = await r.redirector.lookupIngress({ user: 'claude-code.settings', target: { address: 'api.example.com', port: 443 } })
  assert.equal(meta.capture, 'proxy')
  assert.equal(meta.agent, 'claude-code')
  assert.equal(meta.form, undefined, 'no owner question is wired here: no pid, no form — the fail-safe splice meta')
  assert.equal(meta.upstream.kind, 'direct', 'claude-code does not follow the system proxy (its own files hold no proxy here): direct')
  const codex = await r.redirector.lookupIngress({ user: 'codex.env', target: { address: 'api.example.com', port: 443 } })
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
  // the record now exists: the group keeps its DOOR while it is off (its port comes back for an agent that outlives `off`, audit F7)
  r.state.desired = { codex: { desired: 'off' } }
  await r.redirector.darwin.replan({ reload: true })
  const last = r.doors.opened[r.doors.opened.length - 1]
  assert.deepEqual(last, [{ id: 'codex.env', port: r.doors.opened[0][0].port, auth: true, token: 'listener' }], 'the off group keeps its door (carried): forward-only, its port does not go away')
  assert.deepEqual(r.doors.closed, [], 'nobody closed it')
  const undone = fs.readFileSync(f, 'utf8')
  assert.equal([...undone.matchAll(/^HTTPS_PROXY=/gm)].length, 0, 'and its proxy entry is undone (the plan says off)')
})

// 4.9 §6.4's wiring arm (2026-10-12): the launcher's ledger entry is what names the group after the CLI run is gone — nobody passes optIns here
// (the rig passes () => [], the daemon passes nothing), so the manifest's confirmed optin-* record is the only naming there is. Without this arm
// a daemon that starts after `on … --opt-in claude-code.desktop` re-plans the group as unnamed and the launcher points at a port with no listener.
test('a manifest-recorded desktop-launcher re-plans the group on with nobody passing optIns; an unconfirmed record names nothing; off keeps the listener (carried)', async () => {
  const r = await rigged(['claude-code'], { desired: { 'claude-code': { desired: 'on' } } })
  const entry = { kind: 'optin-desktop-launcher', harness: 'claude-code', form: 'claude-code.desktop', item: 'desktop-launcher', scope: 'user', path: path.join(r.dir, 'bin', 'claude-desktop-asight'), values: { launcher: path.join(r.dir, 'bin', 'claude-desktop-asight') }, confirmed: true, installed_at: new Date().toISOString() }
  const m = readManifest(r.dir)
  m.entries.push(entry)
  saveManifest(r.dir, m)
  const { plan } = await r.redirector.darwin.replan()
  const d = plan['claude-code.desktop']
  assert.deepEqual([d.entry, d.on, d.reason], ['opt-in', true, null], 'the recorded item is the naming: the group is connected')
  await r.redirector.attach()
  assert.ok(r.doors.opened.at(-1).some((d) => d.id === 'claude-code.desktop' && d.auth === false), 'the desktop door is open on the engine, credential-less — the launcher has a port to point at')
  // an UNCONFIRMED record (a write whose read-back failed) names nothing: the group waits to be named again, never half-on
  const m2 = readManifest(r.dir)
  m2.entries.find((e) => e.kind === 'optin-desktop-launcher').confirmed = false
  saveManifest(r.dir, m2)
  const again = (await r.redirector.darwin.replan()).plan['claude-code.desktop']
  assert.deepEqual([again.entry, again.on, again.reason], [null, false, 'opt-in-needed'], 'an unconfirmed entry is re-offered, not treated as in effect')
  // confirmed again, the harness OFF: the launcher is still in the ledger, so the group is carried — its port does not go away (audit F7's third leg)
  const m3 = readManifest(r.dir)
  m3.entries.find((e) => e.kind === 'optin-desktop-launcher').confirmed = true
  saveManifest(r.dir, m3)
  r.state.desired = { 'claude-code': { desired: 'off' } }
  await r.redirector.darwin.replan({ reload: true })
  assert.ok(r.doors.opened.at(-1).some((d) => d.id === 'claude-code.desktop'), 'carried while the harness is off — the launcher\'s door does not go away')
  assert.ok(!r.doors.closed.includes('claude-code.desktop'), 'nobody closed it (forward only)')
})

test('the host sets of a host-tree form are applied at on and kept for status (the bag has no kernel exe any more — D47 retired it)', async () => {
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
  let ports = 18800
  const redirector = await createDarwinCollector({
    env: { HOME: home }, dir: path.join(home, '.asight', 'collector'), home, harnesses: [made],
    failure: () => {}, event: () => {}, desired: () => ({ 'made-up': { desired: 'on', extra_hosts: ['extra.relay.example'] } }), optIns: () => [],
    deps: { exec: box.exec, loadIngress: async () => ({ enginePort: 18790, groupPorts: { 'made-up.settings': ++ports }, ingressToken: 'a'.repeat(32), listenerToken: 'b'.repeat(32) }), isFree: async () => true, random: (n) => Buffer.alloc(n, 7), timers: fakeTimers().timers, watchSystemProxy: false },
  })
  await redirector.start()
  assert.equal(redirector.darwin.kernelExe, undefined, 'the bag names no kernel any more: the engine\'s doors are the only proxy (D47)')
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
  const opens0 = r.doors.opened.length
  r.box.dict.HTTPSPort = '7890' // the port moved: codex's upstream moves with it
  await r.timers.tick()
  assert.equal(r.doors.opened.length - opens0, 1, 'one attach: the doors and the entries were brought to the moved plan')
  const changes = r.events.filter((e) => e.event === 'netenv-change')
  assert.equal(changes.length, 1)
  assert.equal(changes[0].from, '127.0.0.1:7897')
  assert.equal(changes[0].to, '127.0.0.1:7890')
  assert.deepEqual(r.failures, [], 'zero failures')
  r.box.dict.ExceptionsList = ['localhost', '10.*', '<local>'] // the bypass table alone moves it too (W72)
  await r.timers.tick()
  assert.equal(r.doors.opened.length - opens0, 2)
  assert.equal(r.events.filter((e) => e.event === 'netenv-change').length, 2)
  // a read that fails and comes back with the same answers: two changes, zero reloads (4.8 §2.2, carried by 4.9 §2.2)
  const before = r.doors.opened.length
  r.box.fail = 'scutil timed out'
  await r.timers.tick()
  r.box.fail = null
  await r.timers.tick()
  assert.equal(r.events.filter((e) => e.event === 'netenv-change').length, 4, 'each change is one event (the group stays on its last upstream, said)')
  assert.equal(r.doors.opened.length, before, 'zero reloads: the answers did not move')
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

test('review F2 (as D47 left it): there is no kernel to claim any more — start() reads the network and plans, and a KeepAlive-restarted daemon\'s doors bind or fail with EADDRINUSE said (the engine\'s own listen), never an adopted stranger', async () => {
  const calls = []
  const scutil = fakeScutil(VERGE)
  const exec = (file, args) => { if (file === 'scutil' && args[0] === '--proxy') calls.push('scutil'); return scutil.exec(file, args) }
  await rigged(['claude-code'], { desired: { 'claude-code': { desired: 'on' } }, over: { deps: { exec } } })
  assert.deepEqual(calls, ['scutil'], 'start() reads the network and makes the first plan; nothing is claimed, nothing adopted — the doors bind at the first attach or the engine says why')
})

test('osLayers hands the layers ctx the keychain door (4.9 §6.4): open only for the harness whose CONFIRMED optin-keychain-cert entry names it, and only while that entry\'s fingerprint is this build\'s CA — read live off the manifest, so an item that lands after the daemon started opens the door without a restart; the cli form\'s settings door is untouched either way', async () => {
  const r = await rigged(['claude-code', 'codex'], { desired: { 'claude-code': { desired: 'on' }, codex: { desired: 'on' } } })
  const { X509Certificate } = await import('node:crypto')
  const caFile = path.join(r.dir, 'ca', 'asight-ca.pem')
  const fp256 = new X509Certificate(fs.readFileSync(caFile)).fingerprint256
  const helper = '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper'
  const cli = `${r.home}/.local/share/claude/versions/2.1.289/claude`
  fs.mkdirSync(path.join(r.home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(r.home, '.claude', 'settings.json'), `${JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: caFile } }, null, 2)}\n`) // the CLI form's own door, open
  const ctx = (argv) => ({
    os: 'darwin', environ: new Map(), env: new Map(), home: r.home, cwd: '/', argv, startedAt: null,
    readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } },
    readTextOrError: (f) => { try { return { text: fs.readFileSync(f, 'utf8'), error: null } } catch (e) { return { text: null, error: e.code === 'ENOENT' ? null : { code: e.code, message: e.message } } } },
    mtimeOf: (f) => { try { return fs.statSync(f).mtimeMs } catch { return null } },
    listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } }, unparsable: () => {},
  })
  const cc = r.redirector.darwin.osLayers.darwin(one('claude-code'))
  assert.deepEqual(cc(ctx([helper, '--type=utility'])), [], 'no keychain entry: the desktop family gets no layer — the engine only forwards')
  assert.ok(cc(ctx([cli, '-p', 'hi'])).some((l) => l.vars && l.vars.NODE_EXTRA_CA_CERTS === caFile), 'the cli form reads the settings file through the base layers all along')

  const m = readManifest(r.dir)
  m.entries.push({ kind: 'optin-keychain-cert', harness: 'codex', form: 'codex.app', item: 'keychain-login', scope: 'user', path: `login-keychain:${fp256}`, installed_at: new Date().toISOString(), values: { fp256, certFile: caFile } })
  saveManifest(r.dir, m) // another harness's entry, and unconfirmed (the dialog was never answered)
  assert.deepEqual(cc(ctx([helper, '--type=utility'])), [], 'an entry of another harness — unconfirmed at that — opens nothing')

  const t0 = Date.now()
  m.entries.push({ kind: 'optin-keychain-cert', harness: 'claude-code', form: 'claude-code.desktop', item: 'keychain-login', scope: 'user', path: `login-keychain:${fp256}`, installed_at: new Date(t0).toISOString(), confirmed: true, values: { fp256, certFile: caFile } })
  saveManifest(r.dir, m)
  const door = cc(ctx([helper, '--type=utility']))
  assert.equal(door.length, 1, 'exactly the keychain layer')
  assert.equal(door[0].vars.NODE_EXTRA_CA_CERTS, caFile)
  assert.equal(door[0].since, t0, 'config-after-start is judged against the item\'s installed_at')
  assert.equal(door[0].live, false)

  m.entries = m.entries.filter((e) => !(e.kind === 'optin-keychain-cert' && e.harness === 'claude-code'))
  m.entries.push({ kind: 'optin-keychain-cert', harness: 'claude-code', form: 'claude-code.desktop', item: 'keychain-login', scope: 'user', path: 'login-keychain:AA:BB:CC:DD', installed_at: new Date(t0).toISOString(), confirmed: true, values: { fp256: 'AA:BB:CC:DD', certFile: caFile } })
  saveManifest(r.dir, m)
  assert.deepEqual(cc(ctx([helper, '--type=utility'])), [], 'a fingerprint of a CA this build no longer holds: the keychain trusts a certificate asight cannot decrypt with — the door stays shut')

  const codex = r.redirector.darwin.osLayers.darwin(one('codex'))
  assert.deepEqual(codex(ctx(['/opt/homebrew/bin/codex'])), [null], 'the wrapper is a no-op for a harness with no darwin layers of its own (its base layers ran as ever and answered their absent-files [null] — the tracker filters it; the door\'s keys were simply ignored)')
})
