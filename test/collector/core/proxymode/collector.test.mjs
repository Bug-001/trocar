// test/collector/core/proxymode/collector.test.mjs — the collector model's daemon half (spec 4.11 §3 ① ② ③ ⑥, P2, P7, P10, P11, P12).
// CM22 at the door: over every descriptor form and the verdict generator's axes (verdict-world.mjs), meta.decrypt equals verdictOf. CM20 / ⑥: meta.upstream
// equals upstreamFor over env × system proxy × prior × identified, and the X-Trocar-Upstream gate. CM19 / CM33: the PAC door. CM23: an idle holder keeps
// its door forward-only. CM6: no custody / no key. ① / G4: no writes; restore reuses the recorded ports; a taken port is engine-port-taken and no door.
// The world is injected (no real OS, no socket): the door half, the owner / facts readers, the process table, the timers.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createModelCollector } from '../../../../src/collector/core/proxymode/collector.mjs'
import { HOLDER_POLL_MS } from '../../../../src/collector/core/proxymode/holders.mjs'
import { verdictOf, judgedForms } from '../../../../src/collector/core/proxymode/verdict.mjs'
import { pacPath } from '../../../../src/collector/core/proxymode/entries.mjs'
import { upstreamFor, MAX_DEPTH } from '../../../../src/collector/core/proxymode/chain.mjs'
import { translateBypass } from '../../../../src/collector/arch/darwin/upstream.mjs'
import { certPem } from '../../../../src/collector/core/tls/cert.mjs'
import { TEMPLATES } from '../../../../src/collector/harness/templates/index.mjs'
import { loadIngressConfig } from '../../../../src/collector/core/ingress-config.mjs'
import { emptyState, setDesired, writeStateAtomic } from '../../../../src/off/state.mjs'
import { newManifest, saveManifest } from '../../../../src/off/manifest.mjs'
import { checkRecord, CODES } from '../../../../src/health/codes.mjs'
import { custodyStub } from '../../../helpers/custody-stub.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { readDoorSeen, DOOR_SEEN_FILE } from '../../../../src/off/door-seen.mjs'
import { compileIdentity } from '../../../../src/off/identity.mjs'
import { serializeSignature } from '../../../../src/off/signature.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { ROOT, INSTALLED, descs, newWorld, ctxOf, worldOf, combos, makeRoot } from './verdict-world.mjs'
import { CERT_VARS } from '../../../../src/collector/core/proxymode/upstream-trust.mjs'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import { pemBlock } from '../../../../src/off/text-edit.mjs'

const TOKEN = 'ab'.repeat(16)
const iso = (ms) => new Date(ms).toISOString()
const PEER = { address: '127.0.0.1', port: 50000 }
const proxyOf = (u) => { const x = new URL(u); return { kind: x.protocol.startsWith('socks') ? 'socks5' : 'http', host: x.hostname, port: Number(x.port) } }
const bypassOf = (t) => translateBypass(t, 'no-proxy').bypass
const dialOf = (up, host) => (up.url == null || (up.bypass || []).some((b) => b.value === host) ? { kind: 'direct' } : proxyOf(up.url))
const stub = custodyStub(); stub.create()
const STUB_PEM = certPem(stub.rootDer)
const STUB_FP = new crypto.X509Certificate(STUB_PEM).fingerprint256
const ready = { state: () => 'ready' }
const manifestOf = (h, { on = [], liveness = {} } = {}) => ({ ...newManifest(), entries: [{ phase: 'install', harness: h, kind: 'json-key', path: '/x', installed_at: iso(INSTALLED) }, { phase: 'install', harness: null, kind: 'system-root', installed_at: iso(INSTALLED) }, ...on], liveness })

/** One collector over one harness: `w` is what the injected readers answer now (facts, env, cwd, verdict ctx, manifest, process table). */
async function rig({ desc, os = 'darwin', custody = stub, rootPem = STUB_PEM, w = {}, opened = [], taken = new Set(), timers, ingress, upstreamRoots = null, others = [], forget, holds, drain, doorHangMs, dir = tmpDir() } = {}) {
  const asked = {}, gate = (q, x) => w.wait?.(q, x, asked[`${q}\0${x}`] = (asked[`${q}\0${x}`] ?? 0) + 1) // w.wait(question, pid, nth of that question of that pid): a promise holds it
  const of = (by, q, all) => (by && Object.hasOwn(by, q) ? by[q] : all) // a reader's answer for one pid (w.factsBy / w.envBy), else the world's one answer
  const records = [], ctx = { os, home: '/h', dirs: {}, join: path.posix.join, readFile: (p) => w.ctx.readFile(p), readdir: (d) => w.ctx.readdir(d), exists: (p) => w.ctx.exists(p), policy: (s) => w.ctx.policy(s) }
  w.ctx ||= ctxOf(newWorld(os))
  const c = createModelCollector({ harnesses: [desc, ...others], dir, ctx, custody, rootPem, proxyOf, bypassOf, upstreamRoots, templates: TEMPLATES, ownUid: 501, timers, doorHangMs, record: (r) => records.push(r),
    identify: (f) => (f.pending ? { reason: 'pending' } : f.agent ? { reason: 'match', agent: f.agent } : { reason: 'no-match' }), ownerOf: async () => { await gate('ownerOf'); return { pid: w.pid, source: 'socket-table', ms: 1, ...(w.owner || {}) } }, factsOf: async (q, o) => { await gate('factsOf', q); const f = of(w.factsBy, q, w.facts); if (f == null && w.factsWhy && o && o.onUnread) o.onUnread(w.factsWhy); return f },
    proc: { envOf: async (q, names) => { await gate('envOf', q); w.envCalls = (w.envCalls || 0) + 1; const e = of(w.envBy, q, w.env); return e == null ? null : (w.asked && w.asked.push(...names), Object.fromEntries(Object.entries(e).filter(([k]) => names.includes(k)))) }, cwdOf: async (q) => (await gate('cwdOf', q), w.cwd ?? null), parentOf: async (q) => (await gate('parentOf', q), w.parent ? w.parent(q) : null) }, systemProxy: () => w.sp ?? null, hostsOf: () => w.hostSet ?? null,
    readState: () => w.state, readIngress: () => ingress || { groupPorts: {}, listenerToken: TOKEN }, readManifest: () => { if (w.manifestErr) throw w.manifestErr; return w.manifest || manifestOf(desc.name) }, procTable: async () => w.procs || [], clock: () => w.now ?? INSTALLED + 5, ...(forget ? { forget } : {}), ...(holds ? { holds } : {}), ...(drain ? { drain } : {}) })
  c.bindDoors({ open: async (l) => { for (const x of l) { if (taken.has(x.port)) throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }); opened.push(x) } }, close: async (ids) => { opened.push(...ids.map((id) => ({ closed: id }))) } })
  await c.start()
  return { c, w, records }
}

// ---- CM22 at the door: the door's decrypt is the verdict ------------------------------------------------------------------------------------------
const CASES = descs.flatMap((d) => d.proxyMode.forms.flatMap((f) => f.os.map((os) => ({ d, f, os }))))
let pid = 1000
for (const { d, f, os } of CASES) {
  test(`CM22 at the door · ${f.id} · ${os}: meta.decrypt equals verdictOf over the generator's axes`, async () => {
    const desc = { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }
    const g = `${d.name}:${f.route}`
    const rigs = { true: await rig({ desc, os }), false: await rig({ desc, os, custody: 'unavailable' }) }
    for (const r of Object.values(rigs)) await r.c.on({ harnesses: [d.name], groups: { [g]: 18100 } })
    const t = f.trust !== 'root' && d.proxyMode.trusts[f.trust]
    const axes = [{}, { known: false }, { verified: { reason: 'not-measured' } }, { start: 'before' }, { start: 'unknown' }, { issuer: false }, { envNull: true }, { cwdNull: true }, { hookPid: 'other' },
      ...(f.forwardOnlyHosts || []).map((host) => ({ host })), { host: 'telemetry.unrelated.example' }, { hostSet: [...d.hosts, 'relay.corp.example'], host: 'relay.corp.example' },
      ...d.proxyMode.blockers.map((_, i) => ({ blocker: i })), ...(t && t.sources.length ? [...combos(t)].map((sources) => ({ sources })) : [])]
    for (const over of axes) {
      const { c: cs, w, form, facts } = worldOf(d, f, os, over)
      desc.proxyMode.forms[0] = form
      const r = rigs[cs.issuer]
      const base = ctxOf(w)
      Object.assign(r.w, { pid: ++pid, facts: { exe: '/bin/x', uid: 501, agent: cs.known ? d.name : null, startedAt: facts.startedAt }, env: w.env, cwd: w.cwd, hostSet: cs.hostSet,
        ctx: { ...base, readFile: (p) => base.readFile(p).replace(ROOT.pem, STUB_PEM) } }) // the world's root is the custody's
      const meta = await r.c.lookupIngress({ peer: PEER, user: g, target: { address: cs.host, port: 443 } })
      const want = verdictOf({ desc, form, facts: { ...facts, pid }, record: { carrierInstalledAt: INSTALLED, rootFp256: STUB_FP }, issuer: cs.issuer ? ready : null, host: cs.host, hostSet: cs.hostSet, ctx: r.w.ctx })
      assert.equal(meta.decrypt, want.decrypt, `${f.id} · ${os} · ${JSON.stringify(over)}: ${JSON.stringify(want)}`)
      if (!want.decrypt && cs.known) assert.equal(meta.skip && meta.skip.reason, want.code, `${f.id} · ${os} · ${JSON.stringify(over)}: the forward-only row carries P11's code`) // off the list: the door's own class, before P11
    }
    for (const r of Object.values(rigs)) { for (const x of r.records) assert.deepEqual(checkRecord(x), [], JSON.stringify(x)); r.c.close() }
  })
}

// The descriptors as they ship, every form on each route: a process of a verified form decrypts although an unmeasured or out-of-scope sibling form
// shares its route (D51 names a harness, not a form); the door's answer is every verified candidate's verdict, or not-verified when none is.
const real = new Set((await loadHarnesses()).map((d) => d.name))
for (const d of descs) for (const os of ['darwin', 'win32']) {
  test(`CM22 at the door · ${d.name} · ${os}, unmodified descriptor: the verified forms of the route decide, an unverified sibling does not veto`, async () => {
    const r = await rig({ desc: d, os, upstreamRoots: { os: async () => STUB_PEM, node: [STUB_PEM], extra: [] } })
    const routes = [...new Set(d.proxyMode.forms.filter((f) => f.os.includes(os)).map((f) => f.route))]
    await r.c.on({ harnesses: [d.name], groups: Object.fromEntries(routes.map((rt, i) => [`${d.name}:${rt}`, 18300 + i])) })
    let decrypted = 0
    for (const rt of routes) {
      const all = d.proxyMode.forms.filter((f) => f.os.includes(os) && f.route === rt), ok = all.filter((f) => f.verified[os] === true)
      const { c: cs, w, facts } = worldOf(d, ok[0] || all[0], os, {})
      const base = ctxOf(w)
      Object.assign(r.w, { pid: ++pid, facts: { exe: '/bin/x', uid: 501, agent: d.name, startedAt: facts.startedAt }, env: w.env, cwd: w.cwd, hostSet: cs.hostSet, ctx: { ...base, readFile: (p) => base.readFile(p).replace(ROOT.pem, STUB_PEM) } })
      const meta = await r.c.lookupIngress({ peer: PEER, user: `${d.name}:${rt}`, target: { address: cs.host, port: 443 } })
      const v = (f) => verdictOf({ desc: d, form: f, facts: { ...facts, pid }, record: { carrierInstalledAt: INSTALLED, rootFp256: STUB_FP }, issuer: ready, host: cs.host, hostSet: cs.hostSet, ctx: r.w.ctx }).decrypt
      assert.equal(meta.decrypt, (ok.length ? ok : all).every(v), `${d.name}:${rt} · ${os}`)
      if (real.has(d.name) && ok.length) assert.equal(meta.decrypt, v(ok[0]), `${d.name}:${rt} · ${os}: a process of ${ok[0].id} gets its form's verdict`)
      // 4.11 §3 ⑭ wiring: a decrypted connection carries its agent's own upstream set (what is in it: upstream-trust.test.mjs)
      if (meta.decrypt) assert.ok(meta.upstreamTrust && meta.upstreamTrust.secureContext, `${d.name}:${rt} · ${os}: a decrypted connection carries its own upstream set`)
      else assert.equal(meta.upstreamTrust, undefined)
      if (meta.decrypt) decrypted++
    }
    if (real.has(d.name) && d.proxyMode.forms.some((f) => f.verified[os] === true)) assert.ok(decrypted > 0, `${d.name} · ${os}: some route decrypts`)
    r.c.close()
  })
}

// 4.11 P11, the forms a process may be: of its route's forms, those whose `exe` names the process's program file (on macOS both Z-Code forms
// retitle to zcode-cli before they connect, so argv tells nothing there, ZCode 3.14.4), then on Windows, where both are ZCode.exe and the command
// line stays the one they were spawned with, those whose `argv` words match it (the desktop's app-server, the CLI's -p, ZCode 3.14.5); none matching →
// all of them (forwarded rather than broken). The desktop's CA setting blocks z-code.desktop only: a process the door can tell is not the desktop
// decrypts, one it cannot (the interactive CLI on Windows, with neither word) is forwarded.
const ZC = descs.find((d) => d.name === 'z-code')
const HELPER = '/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper', WIN_EXE = 'C:\\Users\\u\\AppData\\Local\\Programs\\ZCode\\ZCode.exe'
const WIN_CJS = 'C:\\Users\\u\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs', TITLE = ['zcode-cli']
const ZC_EXE = { // [program file, argv, decrypt]
  darwin: [[HELPER, TITLE, false], ['/Users/u/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper', TITLE, false],
    [HELPER, [HELPER, '/x/glm/zcode.cjs', '-p', 'hi'], false], // the exe decides on macOS: the CLI's word in a Helper's argv changes nothing
    ['/Applications/ZCode.app/Contents/MacOS/ZCode', TITLE, true], ['/opt/homebrew/bin/node', TITLE, true], ['/bin/x', TITLE, false]],
  win32: [[WIN_EXE, [WIN_EXE, WIN_CJS, '-p', 'hi'], true], [WIN_EXE, [WIN_EXE, WIN_CJS, 'app-server', '--stdio'], false],
    [WIN_EXE, [WIN_EXE, WIN_CJS], false], // the interactive CLI: neither word, judged with the desktop
    [WIN_EXE, [WIN_EXE, WIN_CJS, 'app-server', '-p', 'x'], false], // both words: both forms
    [WIN_EXE, null, false], // a command line not read: both forms
    ['C:\\Program Files\\nodejs\\node.exe', ['node', WIN_CJS, '-p', 'hi'], true], ['C:\\x\\x.exe', TITLE, false],
    ['C:\\x\\x.exe', ['x', WIN_CJS, '-p', 'hi'], false]], // a program file no form names: every form, its -p notwithstanding
}
for (const os of ['darwin', 'win32']) test(`4.11 P11 · z-code · ${os}: the desktop's CA setting keeps off only the processes the door cannot tell from the desktop, by the program file and on Windows its command line`, async () => {
  const r = await rig({ desc: ZC, os, upstreamRoots: { os: async () => STUB_PEM, node: [STUB_PEM], extra: [] } })
  await r.c.on({ harnesses: ['z-code'], groups: { 'z-code:cli-config': 18500 } })
  const i = ZC.proxyMode.blockers.findIndex((b) => b.at.keys && b.at.keys.includes('httpProxyCaCertPath'))
  const { w, facts } = worldOf(ZC, ZC.proxyMode.forms.find((f) => f.id === 'z-code.cli'), os, { blocker: i })
  const base = ctxOf(w)
  for (const [exe, argv, decrypt] of ZC_EXE[os]) {
    Object.assign(r.w, { pid: ++pid, facts: { exe, argv, uid: 501, agent: 'z-code', startedAt: facts.startedAt }, env: w.env, cwd: w.cwd, ctx: { ...base, readFile: (p) => base.readFile(p).replace(ROOT.pem, STUB_PEM) } })
    const meta = await r.c.lookupIngress({ peer: PEER, user: 'z-code:cli-config', target: { address: ZC.hosts[0], port: 443 } })
    assert.equal(meta.decrypt, decrypt, `${exe} ${JSON.stringify(argv)}: ${JSON.stringify(meta)}`)
  }
  r.c.close()
})

// CM22 at the door, the host tree (4.8 §3, W69): for every shipped hostTree form, a process named only by the form's hosts.processes (on no name list) is
// its harness's at a host of the harness's own set — the door's decrypt is then that form's verdict — and forwarded `outside-host-set` anywhere else.
// No hostsOf answer is injected: the set is the collector's own default (the descriptor's hosts), the product path.
for (const d of descs) for (const f of d.proxyMode.forms.filter((x) => x.hostTree)) for (const os of f.os) for (const name of (f.hosts && f.hosts.processes) || []) {
  test(`CM22 at the door · host tree · ${f.id} · ${os} · host program "${name}": its harness's hosts are judged, every other host is forwarded`, async () => {
    const r = await rig({ desc: { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }, os, upstreamRoots: { os: async () => STUB_PEM, node: [STUB_PEM], extra: [] } })
    await r.c.on({ harnesses: [d.name], groups: { [`${d.name}:${f.route}`]: 18400 } })
    const { w, facts } = worldOf(d, f, os, {})
    const base = ctxOf(w)
    for (const [host, inSet] of [...d.hosts.map((h) => [h, true]), ['telemetry.unrelated.example', false]]) {
      Object.assign(r.w, { pid: ++pid, facts: { exe: `/apps/${name}`, uid: 501, agent: null, startedAt: facts.startedAt }, env: w.env, cwd: w.cwd, ctx: { ...base, readFile: (p) => base.readFile(p).replace(ROOT.pem, STUB_PEM) } })
      const meta = await r.c.lookupIngress({ peer: PEER, user: `${d.name}:${f.route}`, target: { address: host, port: 443 } })
      if (!inSet) { assert.deepEqual([meta.decrypt, meta.skip && meta.skip.reason], [false, 'outside-host-set'], `${host} is outside ${f.id}'s set`); continue }
      const want = verdictOf({ desc: d, form: f, facts: { ...facts, name: d.name, pid }, record: { carrierInstalledAt: INSTALLED, rootFp256: STUB_FP }, issuer: ready, host, ctx: r.w.ctx })
      assert.equal(meta.skip, undefined, `${host}: the host program is ${d.name}'s here`)
      assert.equal(meta.decrypt, want.decrypt, `${f.id} · ${os} · ${host}: ${JSON.stringify(want)}`)
      if (f.verified[os] === true) assert.equal(meta.decrypt, true, `${f.id} is verified on ${os}: its host program's connection to ${host} is decrypted`)
    }
    r.c.close()
  })
}

// CM22 at the door, the host tree's own settings (4.8 §3 OPEN 22, 4.11 ⑫, W69): the collector's default set is host-agent's hostSetOf over the harness's
// hosts, the base URLs the harness's own settings name (its descriptor's configHosts, read through the sources ctx) and the operator's extra hosts. The
// settings are found by asking the descriptor which files it reads (a probe ctx), and each is served one format-level seed (TOML, JSON) — the first whose
// reading by the descriptor names the relay. Axes: settings naming a relay → the relay is judged like the harness's hosts; the same files unreadable →
// the relay is outside the set (forwarded outside-host-set), the harness's hosts are still judged, one config-unreadable record says why (D38).
const RELAY = 'relay.corp.example'
const SEEDS = [`base_url = "https://${RELAY}/v1"\n`, JSON.stringify({ baseURL: `https://${RELAY}/v1`, base_url: `https://${RELAY}/v1` })]
function settingsWorld(d) {
  const read = []
  try { d.configHosts && d.configHosts({ os: 'darwin', home: '/h', env: new Map(), dirs: { appSupport: '/as', localAppData: '/la' }, readText: (p) => { read.push(p); return null }, readTextOrError: (p) => { read.push(p); return { text: null, error: null } }, listDir: () => [], readdir: () => [], join: path.posix.join }) } catch { /* a reader that needs more than a probe gives none */ }
  for (const seed of SEEDS) {
    const served = Object.fromEntries(read.map((p) => [p, seed]))
    const ctx = { os: 'darwin', home: '/h', env: new Map(), dirs: { appSupport: '/as', localAppData: '/la' }, readText: (p) => served[p] ?? null, readTextOrError: (p) => ({ text: served[p] ?? null, error: null }), listDir: () => [], readdir: () => [], join: path.posix.join }
    let hosts = []; try { hosts = d.configHosts(ctx) || [] } catch { hosts = [] }
    if (hosts.includes(RELAY)) return served
  }
  return null
}
for (const d of descs) for (const f of d.proxyMode.forms.filter((x) => x.hostTree)) for (const os of f.os) for (const name of (f.hosts && f.hosts.processes) || []) {
  const served = settingsWorld(d)
  test(`CM22 at the door · host tree · ${f.id} · ${os} · host program "${name}": a base-URL host from the harness's own settings is judged; unreadable settings leave it out, said once`, async () => { // a harness whose settings name no relay in either seed (the eighth's): the relay stays outside and nothing is said
    for (const unreadable of [false, true]) {
      const r = await rig({ desc: { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }, os, upstreamRoots: { os: async () => STUB_PEM, node: [STUB_PEM], extra: [] } })
      await r.c.on({ harnesses: [d.name], groups: { [`${d.name}:${f.route}`]: 18400 } })
      const { w, facts } = worldOf(d, f, os, {})
      const base = ctxOf(w)
      const readFile = (p) => { if (served && p in served) { if (unreadable) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return served[p] } return base.readFile(p).replace(ROOT.pem, STUB_PEM) }
      for (const [host, inSet] of [[RELAY, !!served && !unreadable], [d.hosts[0], true], ['telemetry.unrelated.example', false]]) {
        Object.assign(r.w, { pid: ++pid, facts: { exe: `/apps/${name}`, uid: 501, agent: null, startedAt: facts.startedAt }, env: w.env, cwd: w.cwd, ctx: { ...base, readFile } })
        const meta = await r.c.lookupIngress({ peer: PEER, user: `${d.name}:${f.route}`, target: { address: host, port: 443 } })
        if (!inSet) { assert.deepEqual([meta.decrypt, meta.skip && meta.skip.reason], [false, 'outside-host-set'], `${host} is outside ${f.id}'s set (settings ${unreadable ? 'unreadable' : 'read'})`); continue }
        assert.equal(meta.skip, undefined, `${host}: the host program is ${d.name}'s here`)
        const want = verdictOf({ desc: d, form: f, facts: { ...facts, name: d.name, pid }, record: { carrierInstalledAt: INSTALLED, rootFp256: STUB_FP }, issuer: ready, host, hostSet: [...d.hosts, RELAY], ctx: r.w.ctx })
        assert.equal(meta.decrypt, want.decrypt, `${f.id} · ${os} · ${host}: ${JSON.stringify(want)}`)
        if (f.verified[os] === true) assert.equal(meta.decrypt, true, `${f.id} is verified on ${os}: its host program's connection to ${host} is decrypted`)
      }
      for (const x of r.records) assert.deepEqual(checkRecord(x), [], JSON.stringify(x))
      const said = r.records.filter((x) => x.code === 'config-unreadable')
      assert.equal(said.length, served && unreadable ? 1 : 0, `settings ${unreadable ? 'unreadable: said once' : 'read: nothing said'} (${JSON.stringify(said)})`)
      r.c.close()
    }
  })
}

// ---- CM20 / ⑥: the upstream per connection --------------------------------------------------------------------------------------------------------
test('CM20 · meta.upstream equals upstreamFor over env × system proxy × prior × identified; an unidentified peer uses steps 2, 4, 5 only', async () => {
  for (const d of descs.filter((x) => x.proxyMode.forms.some((f) => f.os.includes('darwin')))) {
    const f = d.proxyMode.forms.find((x) => x.os.includes('darwin'))
    const g = `${d.name}:${f.route}`
    for (const known of [true, false]) for (const env of [{}, { [d.proxy.env[0]]: 'http://env.corp:1' }]) for (const sp of [null, { url: 'http://sys.corp:2', bypass: [] }]) for (const prior of [null, 'http://prior.corp:3']) {
      const on = prior ? [{ phase: 'on', harness: d.name, route: f.route, kind: 'json-key', prior_value: prior }] : []
      const { c } = await rig({ desc: d, w: { pid: ++pid, facts: { agent: known ? d.name : null, startedAt: INSTALLED + 1 }, env, sp, manifest: manifestOf(d.name, { on }) } })
      await c.on({ harnesses: [d.name], groups: { [g]: 18101 } })
      const meta = await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
      const want = await upstreamFor({ desc: d, facts: known ? { pid, start: INSTALLED + 1, env, parentOf: async () => null } : null, recordedPrior: prior, systemProxy: sp })
      assert.deepEqual(meta.upstream, dialOf(want, 'api.example'), `${d.name} known=${known} env=${JSON.stringify(env)} sp=${!!sp} prior=${prior}`)
      if (!known) assert.notEqual(meta.upstream.host, 'env.corp', 'step 3 never runs without an identity')
      assert.deepEqual(c.upstreams()[g] || [], known ? [{ pid, source: want.source, url_redacted: want.url }] : [], 'status reads the door\'s own answer per process (1.6 §9.4); none for a peer it could not tell')
      c.close()
    }
  }
})

test('CM20 · the user\'s own NO_PROXY, recorded as the prior of its key, is never the upstream: with no proxy of theirs the door dials direct', async () => {
  for (const d of descs) for (const [rid, r] of Object.entries(d.proxyMode.routes).filter(([, x]) => x.kind === 'json-key' && x.noProxyKeys && x.auth !== false)) {
    if (!d.proxyMode.forms.some((f) => f.route === rid && f.os.includes('darwin'))) continue
    const g = `${d.name}:${rid}`
    const on = [{ phase: 'on', harness: d.name, route: rid, kind: 'json-key', keys: r.proxyKeys[0] }, ...r.noProxyKeys.map((keys) => ({ phase: 'on', harness: d.name, route: rid, kind: 'json-key', keys, prior_value: 'corp.example' }))]
    const { c } = await rig({ desc: d, w: { pid: ++pid, facts: { agent: null, startedAt: INSTALLED + 1 }, env: {}, sp: null, manifest: manifestOf(d.name, { on }) } })
    await c.on({ harnesses: [d.name], groups: { [g]: 18101 } })
    const meta = await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
    assert.deepEqual(meta.upstream, { kind: 'direct' }, g)
    c.close()
  }
})

test('CM20 / ⑥ · an unidentified process at a credentialed door (an agent\'s child that inherited a hook\'s env) dials the hook value from its own env; unread is prior-proxy-unknown, never a silent direct', async () => {
  for (const d of descs.filter((x) => x.proxyMode.forms.some((f) => f.os.includes('darwin') && x.proxyMode.routes[f.route]?.auth !== false))) {
    const f = d.proxyMode.forms.find((x) => x.os.includes('darwin') && d.proxyMode.routes[x.route]?.auth !== false)
    const g = `${d.name}:${f.route}`
    for (const [label, w, want] of [
      ['hook value', { facts: { agent: null, startedAt: INSTALLED + 1 }, env: { TROCAR_PRIOR_PROXY: 'http://corp.example:3128' } }, { kind: 'http', host: 'corp.example', port: 3128 }],
      ['env unread', { facts: { agent: null, startedAt: INSTALLED + 1 }, env: null }, null],
      ['no pid', { pid: null, facts: null, env: {} }, null],
    ]) {
      const { c, records } = await rig({ desc: d, w: { pid: ++pid, ...w } })
      await c.on({ harnesses: [d.name], groups: { [g]: 18104 } })
      const meta = await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
      if (want) assert.deepEqual(meta.upstream, want, `${d.name} · ${label}`)
      else assert.equal(records.filter((r) => r.code === 'prior-proxy-unknown').length, 1, `${d.name} · ${label}: said once (D38) — ${JSON.stringify(records)}`)
      assert.equal(meta.decrypt, false, 'an unidentified process is only forwarded')
      for (const x of records) assert.deepEqual(checkRecord(x), [], JSON.stringify(x))
      c.close()
    }
  }
})

// ⑥ / invariant 6: curl run by an agent whose proxy is only in the shell it was started from inherits the door; without trocar it would have inherited
// the agent's proxy and NO_PROXY. Generated over each credentialed darwin form × the walk's shapes; the oracle is the rule (the ancestor's value, its
// NO_PROXY direct) or, where it does not apply, the answer without an ancestor. The row stays the child's: untracked · not-an-agent, nothing in status.
test('⑥ · an unidentified child dials its nearest routed agent ancestor\'s upstream, that ancestor\'s NO_PROXY direct; anything else is as before', async () => {
  const CORP = { kind: 'http', host: 'proxy.corp', port: 3128 }, AT = INSTALLED + 1, C = 7000, S = 7100, A = 7200, B = 7300
  const plain = { exe: '/bin/sh', uid: 501, agent: null, startedAt: AT }
  for (const d of descs.filter((x) => x.proxyMode.forms.some((f) => f.os.includes('darwin') && x.proxyMode.routes[f.route]?.auth !== false))) {
    const f = d.proxyMode.forms.find((x) => x.os.includes('darwin') && d.proxyMode.routes[x.route]?.auth !== false)
    const g = `${d.name}:${f.route}`, door = `http://${g}:${TOKEN}@127.0.0.1:18105`
    const other = descs.find((x) => x.name !== d.name)
    const agentOf = (name) => ({ exe: '/bin/agent', uid: 501, agent: name, startedAt: AT })
    const agentEnv = { [d.proxy.env[0]]: 'http://proxy.corp:3128', NO_PROXY: '.intra.corp' }
    const links = (...pids) => (q) => { const i = pids.indexOf(q); return i >= 0 && i + 1 < pids.length ? { ppid: pids[i + 1], startedAt: AT } : null }
    const deep = Array.from({ length: MAX_DEPTH + 1 }, (_, i) => S + i)
    for (const [label, w, want] of [
      ['the parent is the agent', { parent: links(C, A), factsBy: { [A]: agentOf(d.name) }, envBy: { [A]: agentEnv } }, 'ancestor'],
      ['the agent two levels up', { parent: links(C, S, A), factsBy: { [S]: plain, [A]: agentOf(d.name) }, envBy: { [A]: agentEnv } }, 'ancestor'],
      ['no agent above', { parent: links(C, S), factsBy: { [S]: plain }, envBy: { [S]: agentEnv } }, 'before'],
      ['the agent above is not on', { parent: links(C, A), factsBy: { [A]: agentOf(other.name) }, envBy: { [A]: agentEnv } }, 'before'],
      ['an agent on above an agent off', { parent: links(C, B, A), factsBy: { [B]: agentOf(other.name), [A]: agentOf(d.name) }, envBy: { [B]: { [d.proxy.env[0]]: door }, [A]: agentEnv } }, 'ancestor'],
      ['the chain ends at the root', { parent: () => null, factsBy: { [A]: agentOf(d.name) }, envBy: { [A]: agentEnv } }, 'before'],
      ['the parent unread', { parent: () => { throw new Error('ps timed out') }, factsBy: { [A]: agentOf(d.name) }, envBy: { [A]: agentEnv } }, 'unknown'],
      ['an ancestor\'s facts unread', { parent: links(C, S, A), factsBy: { [S]: null, [A]: agentOf(d.name) }, envBy: { [A]: agentEnv } }, 'unknown'],
      ['the agent past the walk\'s limit', { parent: links(C, ...deep, A), factsBy: { ...Object.fromEntries(deep.map((q) => [q, plain])), [A]: agentOf(d.name) }, envBy: { [A]: agentEnv } }, 'before'],
      ['a recorded prior', { parent: links(C, A), factsBy: { [A]: agentOf(d.name) }, envBy: { [A]: agentEnv }, prior: 'http://prior.corp:3' }, 'prior'],
      ['the agent\'s environment unread', { parent: links(C, A), factsBy: { [A]: agentOf(d.name) }, envBy: { [A]: null } }, 'unknown'],
      ['the child\'s own hook value', { parent: links(C, A), factsBy: { [A]: agentOf(d.name) }, envBy: { [A]: agentEnv }, env: { TROCAR_PRIOR_PROXY: 'http://hooked.corp:9' } }, 'hook'],
    ]) {
      const on = w.prior ? [{ phase: 'on', harness: d.name, route: f.route, kind: 'json-key', prior_value: w.prior }] : []
      const { c, records } = await rig({ desc: d, others: [other], w: { pid: C, facts: plain, env: { [d.proxy.env[0]]: door }, ...w, manifest: manifestOf(d.name, { on }) } })
      await c.on({ harnesses: [d.name], groups: { [g]: 18105 } })
      const dial = async (host) => c.lookupIngress({ peer: PEER, user: g, target: { address: host, port: 443 } })
      const api = await dial('api.example'), intra = await dial('svc.intra.corp')
      const before = await upstreamFor({ desc: d, facts: { pid: C, start: AT, env: w.env || { [d.proxy.env[0]]: door }, hookOnly: true }, recordedPrior: w.prior || null })
      const expect = { ancestor: [CORP, { kind: 'direct' }], before: [dialOf(before, 'api.example'), dialOf(before, 'svc.intra.corp')], prior: [proxyOf(w.prior || 'http://x:1'), proxyOf(w.prior || 'http://x:1')], unknown: [{ kind: 'direct' }, { kind: 'direct' }], hook: [proxyOf('http://hooked.corp:9'), proxyOf('http://hooked.corp:9')] }[want]
      assert.deepEqual([api.upstream, intra.upstream], expect, `${d.name} · ${label}`)
      for (const m of [api, intra]) assert.deepEqual([m.decrypt, m.skip], [false, { not_captured: 'untracked', reason: 'not-an-agent' }], `${d.name} · ${label}: the row is the child's`)
      assert.deepEqual(c.upstreams()[g] || [], [], `${d.name} · ${label}: status lists no answer for a process it could not tell`)
      assert.deepEqual(records.map((r) => r.code), want === 'unknown' ? ['prior-proxy-unknown'] : [], `${d.name} · ${label}: ${JSON.stringify(records)}`)
      for (const x of records) assert.deepEqual(checkRecord(x), [], JSON.stringify(x))
      c.close()
    }
  }
})

// ⑥ with the registry's `pending` (a wide name whose command line is not read yet, 4.8 W78): the ancestor is unread, not "not an agent" — that
// connection is unknown (recorded), and the answer is not kept, so the next connection of the same pid + start reads the agent's proxy.
test('⑥ · a pending ancestor is unread and asked again: the next connection gets that agent\'s upstream', async () => {
  const AT = INSTALLED + 1, C = 7000, A = 7200
  const d = descs.find((x) => x.proxyMode.forms.some((f) => f.os.includes('darwin') && x.proxyMode.routes[f.route]?.auth !== false))
  const f = d.proxyMode.forms.find((x) => x.os.includes('darwin') && d.proxyMode.routes[x.route]?.auth !== false), g = `${d.name}:${f.route}`
  const w = { pid: C, facts: { exe: '/bin/sh', uid: 501, agent: null, startedAt: AT }, env: { [d.proxy.env[0]]: `http://${g}:${TOKEN}@127.0.0.1:18105` }, parent: (q) => (q === C ? { ppid: A, startedAt: AT } : null),
    factsBy: { [A]: { exe: '/bin/agent', uid: 501, agent: d.name, startedAt: AT, pending: true } }, envBy: { [A]: { [d.proxy.env[0]]: 'http://proxy.corp:3128' } } }
  const { c, records } = await rig({ desc: d, w })
  await c.on({ harnesses: [d.name], groups: { [g]: 18105 } })
  const first = await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
  assert.deepEqual([first.upstream, records.map((r) => r.code)], [{ kind: 'direct' }, ['prior-proxy-unknown']])
  w.factsBy[A] = { ...w.factsBy[A], pending: false }
  const second = await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
  assert.deepEqual(second.upstream, { kind: 'http', host: 'proxy.corp', port: 3128 })
  c.close()
})

// P12 / ⑥: after off a door stays for a live agent; a tool that agent starts inherits the door and still dials the agent's own proxy.
test('⑥ · a door kept after off: the agent\'s child still dials the agent\'s upstream', async () => {
  const AT = INSTALLED + 1, C = 7000, A = 7200
  const d = descs.find((x) => x.proxyMode.forms.some((f) => f.os.includes('darwin') && x.proxyMode.routes[f.route]?.auth !== false))
  const f = d.proxyMode.forms.find((x) => x.os.includes('darwin') && d.proxyMode.routes[x.route]?.auth !== false), g = `${d.name}:${f.route}`
  const w = { pid: A, facts: { exe: '/bin/sh', uid: 501, agent: null, startedAt: AT }, env: { [d.proxy.env[0]]: `http://${g}:${TOKEN}@127.0.0.1:18105` }, parent: (q) => (q === C ? { ppid: A, startedAt: AT } : null),
    factsBy: { [A]: { exe: '/bin/agent', uid: 501, agent: d.name, startedAt: AT } }, envBy: { [A]: { [d.proxy.env[0]]: 'http://proxy.corp:3128' } }, procs: [{ pid: A, startedAt: AT }] }
  const { c } = await rig({ desc: d, w })
  await c.on({ harnesses: [d.name], groups: { [g]: 18105 } })
  await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
  w.manifest = manifestOf(d.name, { liveness: { [d.name]: { on_at: iso(INSTALLED) } } })
  w.now = INSTALLED + 10
  assert.equal((await c.off({ harnesses: [d.name] })).holders, 1)
  w.pid = C
  const m = await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
  assert.deepEqual([m.upstream, m.skip], [{ kind: 'http', host: 'proxy.corp', port: 3128 }, { not_captured: 'untracked', reason: 'not-an-agent' }])
  c.close()
})

test('CM20 · X-Trocar-Upstream counts only from a form whose hook sends it; from anyone else it is ignored and recorded without its value', async () => {
  const hooked = descs.find((d) => d.proxyMode.forms.every((f) => TEMPLATES[(d.proxyMode.certs[f.cert] || {}).template]?.sendsUpstreamHeader))
  const plain = descs.find((d) => d !== hooked && d.proxyMode.forms.some((f) => f.os.includes('darwin')))
  for (const [d, counts] of [[hooked, true], [plain, false]]) {
    const f = d.proxyMode.forms.find((x) => x.os.includes('darwin'))
    const g = `${d.name}:${f.route}`
    const { c, records } = await rig({ desc: d, w: { pid: ++pid, facts: { agent: d.name, startedAt: INSTALLED + 1 }, env: {} } })
    await c.on({ harnesses: [d.name], groups: { [g]: 18102 } })
    const meta = await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 }, header: 'http://hook.secret:9' })
    assert.equal(meta.upstream.host === 'hook.secret', counts, `${d.name}: ${JSON.stringify(meta.upstream)}`)
    const said = records.filter((r) => r.code === 'upstream-header-ignored')
    assert.equal(said.length, counts ? 0 : 1)
    assert.ok(!JSON.stringify(records).includes('hook.secret'), 'the header value is never recorded')
    c.close()
  }
})

// ---- CM19 / CM33: the PAC door ----------------------------------------------------------------------------------------------------------------------
const pacDesc = descs.find((d) => Object.values(d.proxyMode.routes).some((r) => r.auth === false))
const pacG = `${pacDesc.name}:${Object.entries(pacDesc.proxyMode.routes).find(([, r]) => r.auth === false)[0]}`
test('CM19 / CM33 · the PAC door: this user\'s process gets the PAC (door leg while on, own leg after off); another uid is refused and recorded; a requester whose owner cannot be read gets the own leg only (never an empty answer: the app would go direct around the system proxy)', async () => {
  const opened = []
  const { c, w, records } = await rig({ desc: pacDesc, opened, w: { pid: 77, facts: { uid: 501, startedAt: INSTALLED + 1 }, sp: { url: 'http://sys.corp:8080', bypass: [] } } })
  const { doors } = await c.on({ harnesses: [pacDesc.name], groups: { [pacG]: 18103 } })
  assert.equal(doors[pacG], 'http://127.0.0.1:18103', 'an auth:false door takes no credentials')
  assert.equal(opened[0].auth, false); assert.equal('token' in opened[0], false)
  for (const address of ['127.0.0.1', 'LocalHost', 'door.localhost', '127.0.0.2', '::1']) assert.equal(await c.lookupIngress({ peer: PEER, user: pacG, target: { address, port: 18103 } }), null, `${address}: a loop through the door (chain.mjs isLoopbackHost), not a flow`)
  // what one servePac call recorded (P10: a refusal and a door-less answer are one record each, with the requester's peer; a door PAC is none)
  const wrote = async (req) => { const n = records.length, res = await c.servePac(req); const got = records.slice(n); for (const x of got) assert.deepEqual(checkRecord(x), [], JSON.stringify(x)); return { res, got } }
  const pacReq = { peer: PEER, user: pacG, path: pacPath(TOKEN) }
  const { res: on, got: onRec } = await wrote(pacReq)
  assert.deepEqual(onRec, [], 'this user\'s process gets the door PAC: nothing to record')
  // P10 · D38: this user's own app asking at an address without the key (written by an earlier version, before an update that did not turn capture off and
  // on) is refused too, but filed under its own code with its way out — not as a stranger
  const stale = await wrote({ ...pacReq, path: '/trocar.pac' })
  assert.equal(stale.res, null, 'refused: no compatibility path')
  assert.deepEqual(stale.got.map((r) => [r.event, r.code, r.peer]), [['failure', 'pac-address-stale', PEER]], 'this user\'s program: its own code')
  assert.match(stale.got[0].reason, /trocar on\b/, 'with the way out')
  assert.equal(on.status, 200); assert.match(on.body, /PROXY 127\.0\.0\.1:18103; PROXY sys\.corp:8080/)
  w.facts = { uid: 502, startedAt: INSTALLED + 1 }
  const refused = await wrote(pacReq)
  assert.equal(refused.res, null, 'another user, for certain: refused')
  assert.deepEqual(refused.got.map((r) => [r.event, r.code, r.peer]), [['failure', 'pac-peer-refused', PEER]], 'exactly one pac-peer-refused, with the peer')
  assert.deepEqual((await wrote({ ...pacReq, path: '/trocar.pac' })).got.map((r) => r.code), ['pac-peer-refused'], 'another user without the key: a stranger, not a stale address')
  const n0 = records.length
  const other = await c.lookupIngress({ peer: PEER, user: pacG, target: { address: 'api.example', port: 443 } })
  assert.equal(other && other.refuse && other.refuse.code, 'pac-peer-refused', 'a CONNECT from another user is refused — an answer of its own, not null (null is "unknown user": 407)')
  assert.equal(records.length, n0, 'the lookup writes nothing itself: the ingress writes the one record of that connection')
  w.pid = null // the owner could not be read
  // P10: the PAC is a capability, not an owner check. Without the install's key (another user cannot read the entry that holds it) a requester whose
  // owner cannot be read — which on macOS is how another user's process looks — is refused, recorded, and gets no byte of the owner's way out
  for (const path of ['/trocar.pac', `/${'0'.repeat(32)}/trocar.pac`, `${pacPath(TOKEN)}x`, pacPath(TOKEN).replace('/trocar.pac', '')]) {
    const stranger = await wrote({ ...pacReq, path })
    assert.equal(stranger.res, null, `${path}: refused`)
    assert.deepEqual(stranger.got.map((r) => [r.event, r.code, r.peer]), [['failure', 'pac-peer-refused', PEER]], `${path}: one refusal, with the peer`)
    assert.ok(!JSON.stringify(stranger.got).includes('sys.corp'), 'nothing of the way out in the record')
  }
  assert.notEqual(pacPath(TOKEN), pacPath(`${TOKEN.slice(1)}0`), 'the key is the install\'s own')
  const { res: unread, got: unreadRec } = await wrote(pacReq)
  assert.deepEqual(unreadRec.map((r) => [r.event, r.code, r.peer]), [['failure', 'pac-owner-unread', PEER]], 'exactly one record that the PAC was served without the door, with the peer')
  assert.equal(unread.status, 200); assert.doesNotMatch(unread.body, /18103/, 'no door'); assert.match(unread.body, /return "PROXY sys\.corp:8080"/, 'the app keeps the user\'s system proxy')
  assert.equal((await c.lookupIngress({ peer: PEER, user: pacG, target: { address: 'api.example', port: 443 } })).refuse.code, 'pac-peer-refused', 'not shown to be this user\'s: refused')
  const leftReq = await wrote({ ...pacReq, left: async () => true }) // the requester left while it was judged (the ingress's `left`)
  assert.deepEqual([leftReq.res, leftReq.got], [null, []], 'nobody to answer: no PAC, no pac-owner-unread')
  w.owner = { why: 'shared', sameUser: true } // the table proves the end is this user's but names no single pid (4.9 §5.3 step 1)
  const shared = await c.lookupIngress({ peer: PEER, user: pacG, target: { address: 'api.example', port: 443 } })
  assert.equal(shared.refuse, undefined, 'this user\'s, pid unknown: not refused')
  assert.deepEqual([shared.pid, shared.decrypt, shared.skip.not_captured, shared.skip.reason], [null, false, 'untracked', 'pid-unresolved'], 'forwarded untracked (4.8 §5.3 no pid)')
  const sharedPac = await wrote(pacReq)
  assert.match(sharedPac.res.body, /PROXY 127\.0\.0\.1:18103/, 'and it gets the door PAC')
  assert.deepEqual(sharedPac.got, [], 'the door PAC to this user\'s process: nothing to record')
  // a DarkWake: the table names this user's pid, but its `ps` times out (facts null) — the table's own-user proof still holds (4.11 P10, CM33)
  Object.assign(w, { pid: 63420, owner: { sameUser: true }, facts: null, factsWhy: 'ps -p 63420 did not answer within 2000 ms' })
  const dark = await c.lookupIngress({ peer: PEER, user: pacG, target: { address: 'api.example', port: 443 } })
  assert.equal(dark.refuse, undefined, 'this user\'s by the table, facts unread: not refused')
  assert.deepEqual([dark.pid, dark.decrypt, dark.skip.not_captured, dark.skip.reason], [63420, false, 'untracked', 'facts-unavailable'], 'forwarded untracked')
  const darkPac = await wrote(pacReq)
  assert.match(darkPac.res.body, /PROXY 127\.0\.0\.1:18103/, 'and it gets the door PAC')
  assert.deepEqual(darkPac.got, [], 'nothing to record')
  w.owner = null // no own-user proof (another OS's table): not shown to be this user's, and the record says why the facts were not read (D38)
  assert.match((await c.lookupIngress({ peer: PEER, user: pacG, target: { address: 'api.example', port: 443 } })).refuse.reason, /did not answer within 2000 ms/)
  assert.match((await wrote(pacReq)).got[0].reason, /did not answer within 2000 ms/)
  w.factsWhy = null
  w.pid = 77
  w.facts = { uid: 501, agent: pacDesc.name, startedAt: INSTALLED + 1 }
  w.manifest = manifestOf(pacDesc.name, { liveness: { [pacDesc.name]: { on_at: iso(INSTALLED), off_at: iso(INSTALLED + 10) } } })
  w.procs = [{ pid: 77, startedAt: INSTALLED + 1 }]
  await c.servePac({ peer: PEER, user: pacG, path: pacPath(TOKEN) }) // the app took the PAC: it read the entry, a holder after off (P12)
  await c.off({ harnesses: [pacDesc.name] })
  const after = await c.servePac({ peer: PEER, user: pacG, path: pacPath(TOKEN) })
  assert.match(after.body, /return "PROXY sys\.corp:8080"/, 'after off only the app\'s own way')
  assert.equal(await c.servePac({ peer: PEER, user: pacG, path: '/other' }), null, 'any other path is refused, this user\'s process too')
  c.close()
})

// P10 at the door: the PAC says `PROXY <door>; DIRECT` for a bypass-list host and `PROXY <door>; <own leg>` for the rest, so the door must dial exactly
// that own leg. The door group's descriptor chain is the CLI form's (it may not follow the system proxy, and it reads the process env): wrong for a PAC.
test('CM19 / P10 · the PAC door dials the own leg its PAC names: a bypass-list host direct, any other the fixed system proxy, whatever the process env holds', async () => {
  const sp = { url: 'http://sys.corp:8080', bypass: [{ kind: 'domain-suffix', value: 'corp.example' }] }
  const env = Object.fromEntries(pacDesc.proxy.env.map((n) => [n, 'http://env.corp:1']))
  for (const agent of [pacDesc.name, null]) { // a process the name list knows, and one it does not
    const { c, w } = await rig({ desc: pacDesc, w: { pid: ++pid, facts: { uid: 501, agent, startedAt: INSTALLED + 1 }, env, sp } })
    await c.on({ harnesses: [pacDesc.name], groups: { [pacG]: 18104 } })
    const dial = async (address) => (await c.lookupIngress({ peer: PEER, user: pacG, target: { address, port: 443 } })).upstream
    assert.deepEqual(await dial('gw.corp.example'), { kind: 'direct' }, `${agent}: a bypass-list host is dialled direct, never through the env's proxy`)
    assert.deepEqual(await dial('api.example'), proxyOf(sp.url), `${agent}: any other host through the user's fixed system proxy, the PAC's own leg`)
    if (agent) assert.equal(c.upstreams()[pacG][0].source, 'system-proxy', 'status reads the same answer')
    const pac = (await c.servePac({ peer: PEER, user: pacG, path: pacPath(TOKEN) })).body
    assert.match(pac, /corp\.example/); assert.match(pac, /"PROXY 127\.0\.0\.1:18104; PROXY sys\.corp:8080"/)
    w.sp = null
    assert.deepEqual(await dial('api.example'), { kind: 'direct' }, 'no system proxy: direct, as the PAC then says')
    c.close()
  }
})

// D51⑥ at the door: a process the name list names for a harness that is off, at the door of one that is on, is forwarded `harness-off` and never judged
test('harness-off · another harness\'s agent at an on harness\'s door, its own harness off: forwarded with its harness named, never judged', async () => {
  const [d, other] = descs.filter((x) => x.proxyMode.forms.some((f) => f.os.includes('darwin')))
  const f = d.proxyMode.forms.find((x) => x.os.includes('darwin')), g = `${d.name}:${f.route}`
  const { c } = await rig({ desc: d, others: [other], w: { pid: 4343, facts: { agent: other.name, startedAt: INSTALLED + 1 }, env: {} } })
  await c.on({ harnesses: [d.name], groups: { [g]: 18105 } })
  const meta = await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
  assert.deepEqual([meta.agent, meta.door, meta.decrypt, meta.skip], [other.name, g, false, { not_captured: 'untracked', reason: 'harness-off' }])
  await c.on({ harnesses: [other.name], groups: { [g]: 18105 } })
  const after = await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
  assert.notEqual(after.skip && after.skip.reason, 'harness-off', 'its harness on: it is judged')
  c.close()
})

// ---- CM23: holders ----------------------------------------------------------------------------------------------------------------------------------
test('CM23 · an idle holder keeps the door forward-only; mayExit stays false until the injected table drops it', async () => {
  const pending = []
  const timers = { setTimeout: (fn) => { pending.push(fn); return pending.length }, clearTimeout: () => {} }
  const d = descs[0], f = d.proxyMode.forms.find((x) => x.os.includes('darwin')), g = `${d.name}:${f.route}`
  const opened = []
  const { c, w } = await rig({ desc: d, timers, opened, w: { pid: 4242, facts: { agent: d.name, startedAt: INSTALLED + 1 }, env: {}, procs: [{ pid: 4242, startedAt: INSTALLED + 1 }] } })
  await c.on({ harnesses: [d.name], groups: { [g]: 18104 } })
  await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
  w.manifest = manifestOf(d.name, { liveness: { [d.name]: { on_at: iso(INSTALLED) } } }) // POST /off comes before the CLI writes off_at (orchestrate step 3 < 4)
  w.now = INSTALLED + 10
  const reply = await c.off({ harnesses: [d.name] })
  assert.equal(reply.actual, 'off'); assert.equal(reply.confirmed, true); assert.equal(reply.holders, 1)
  assert.deepEqual(c.doors(), { [g]: 18104 }, 'the door stays while its holder lives, with no connection open')
  const meta = await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
  assert.equal(meta.decrypt, false); assert.deepEqual(meta.skip, { not_captured: 'untracked', reason: 'group-off' })
  assert.equal(c.mayExit(), false)
  assert.equal((await c.holders()).count, 1)
  w.procs = []
  for (let i = 0; i < 8 && Object.keys(c.doors()).length; i++) { await pending.shift()?.(); await new Promise((r) => setImmediate(r)) }
  assert.deepEqual(c.doors(), {}, 'the holder left: the door closes')
  assert.ok(opened.some((x) => x.closed === g))
  assert.equal(c.mayExit(), true)
  c.close()
})

// ---- CM6: the issuer over the custody -------------------------------------------------------------------------------------------------------------
const acceptVerdicts = (dir) => readDoorSeen({ dir }).rows.filter((r) => r.kind === 'accept').map((r) => [r.group, r.pid, r.start, r.decrypt, r.reason ?? null])
const rootForm = CASES.find(({ f, os }) => f.trust === 'root' && f.verified[os] === true && !f.hostTree && !(f.forwardOnlyHosts || []).length)
for (const [what, custody, code] of [['custody unavailable', 'unavailable', 'cert-intermediate-unavailable'], ['the root key not in its custody', null, 'cert-key-missing']]) {
  test(`CM6 · ${what} → forward only, ${code}`, async () => {
    const { d, f, os } = rootForm
    let cus = custody
    if (cus === null) { cus = custodyStub(); cus.create(); cus.switches.keyLost = true }
    const g = `${d.name}:${f.route}`
    const dir = tmpDir()
    const { c, records } = await rig({ desc: { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }, os, dir, custody: cus, w: { pid: ++pid, facts: { agent: d.name, uid: 501, startedAt: INSTALLED + 1 }, env: {}, cwd: '/' } })
    await c.on({ harnesses: [d.name], groups: { [g]: 18105 } })
    const meta = await c.lookupIngress({ peer: PEER, user: g, target: { address: d.hosts[0], port: 443 } })
    assert.equal(meta.decrypt, false)
    assert.ok(records.some((r) => r.code === code && r.pid === pid), JSON.stringify(records))
    assert.throws(() => c.issuer.secureContextFor('a.test'), /no intermediate/)
    c.close()
    assert.deepEqual(acceptVerdicts(dir), [[g, pid, INSTALLED + 1, false, code]], 'the durable accept row carries the door\'s judgement (P12)')
  })
}

// ⑭ wiring (T24 review): the union reads the files the process's certificate variables name, so `proc.envOf` is asked for them whatever the
// descriptor walks; an env reader that answers only the names asked shows the relay CA of a trust:'root' process reaching meta.upstreamTrust.
test('⑭ · a trust:\'root\' process: proc.envOf is asked for every CERT_VARS name and a relay CA in NODE_EXTRA_CA_CERTS joins its upstream set', async () => {
  const { d, f, os } = rootForm
  const g = `${d.name}:${f.route}`, relay = makeRoot('relay test CA').pem
  const counts = []
  for (const env of [{}, { NODE_EXTRA_CA_CERTS: '/relay.pem' }]) {
    const asked = [], { w, facts } = worldOf(d, f, os, {}), base = ctxOf(w)
    assert.equal(f.trust, 'root')
    const { c } = await rig({ desc: { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }, os, upstreamRoots: { os: async () => '', node: [], extra: [] },
      w: { pid: ++pid, facts: { exe: '/bin/x', uid: 501, agent: d.name, startedAt: facts.startedAt }, env: { ...w.env, ...env }, cwd: w.cwd, asked,
        ctx: { ...base, readFile: (p) => (p === '/relay.pem' ? relay : base.readFile(p).replace(ROOT.pem, STUB_PEM)) } } })
    await c.on({ harnesses: [d.name], groups: { [g]: 18106 } })
    const meta = await c.lookupIngress({ peer: PEER, user: g, target: { address: d.hosts[0], port: 443 } })
    assert.equal(meta.decrypt, true, JSON.stringify(meta))
    counts.push(meta.upstreamTrust.count)
    for (const k of CERT_VARS) assert.ok(asked.includes(k), `proc.envOf asked for ${k}: ${asked}`)
    c.close()
  }
  assert.equal(counts[1], counts[0] + 1, `the relay CA joins the set: ${counts}`)
})

test('CM6 · a forward-only verdict on the issuer\'s state is not kept: once the issuer is ready the same pid decrypts', async () => {
  const { d, f, os } = rootForm
  const pending = []
  const timers = { setTimeout: (fn) => { pending.push(fn); return pending.length }, clearTimeout: () => {} }
  const g = `${d.name}:${f.route}`
  stub.switches.keyLost = true // the shared custody, whose root the rig installs: its key goes missing, then comes back
  try {
    const dir = tmpDir()
    const { c, records } = await rig({ desc: { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }, os, dir, timers, w: { pid: ++pid, facts: { agent: d.name, uid: 501, startedAt: INSTALLED + 1 }, env: {}, cwd: '/' } })
    await c.on({ harnesses: [d.name], groups: { [g]: 18106 } })
    const ask = async () => (await c.lookupIngress({ peer: PEER, user: g, target: { address: d.hosts[0], port: 443 } })).decrypt
    assert.equal(await ask(), false); assert.equal(await ask(), false)
    assert.equal(records.filter((r) => r.code === 'cert-key-missing' && r.pid === pid).length, 1, 'recorded once per pid + host')
    stub.switches.keyLost = false
    for (const fn of pending.splice(0)) await fn() // the issuer's hourly retry, once: it signs a new intermediate
    assert.equal(c.issuer.state(), 'ready')
    assert.equal(await ask(), true)
    c.close()
    assert.deepEqual(acceptVerdicts(dir), [[g, pid, INSTALLED + 1, true, null]], 'the durable accept row holds the latest judgement, its forward reason gone (P12)')
  } finally { stub.switches.keyLost = false }
})

test('CM23 · on → off → on → off: a live process the door recognised in the second on window holds the door at the second off', async () => {
  const pending = []
  const timers = { setTimeout: (fn) => { pending.push(fn); return pending.length }, clearTimeout: () => {} }
  const d = descs[0], f = d.proxyMode.forms.find((x) => x.os.includes('darwin')), g = `${d.name}:${f.route}`
  const T1 = INSTALLED + 100, T2 = INSTALLED + 1000
  const { c, w } = await rig({ desc: d, timers, w: { pid: 4343, facts: { agent: d.name, startedAt: T1 + 1 }, env: {}, procs: [{ pid: 4343, startedAt: T1 + 1 }] } })
  const live = (on) => { w.manifest = manifestOf(d.name, { liveness: { [d.name]: { on_at: iso(on) } } }) }
  const connect = () => c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
  live(T1); w.now = T1; await c.on({ harnesses: [d.name], groups: { [g]: 18107 } })
  w.now = T1 + 2; await connect()
  w.now = T1 + 10; assert.equal((await c.off({ harnesses: [d.name] })).holders, 1)
  w.now = T1 + 20; await connect() // through the door kept for it, while off: not a sighting of an on window
  live(T2); w.now = T2; await c.on({ harnesses: [d.name], groups: { [g]: 18107 } })
  w.now = T2 + 1; await connect()
  w.now = T2 + 10
  const reply = await c.off({ harnesses: [d.name] })
  assert.equal(reply.holders, 1, 'seen during on #2: a holder at off #2')
  assert.deepEqual(c.doors(), { [g]: 18107 }, 'its door stays')
  c.close()
})

// macOS acceptance G11 (daemon up: uninstall exited 0 with a holder): the poll that stopped after the first off kept its last answer, an empty one, and the
// second off's GET /holders and mayExit read that answer while the new poll's first table was still being read (lsof takes seconds on a real Mac). The
// table read for off is held open here, so the stale answer is all the old code had: the second off's own rows are what both must see.
test('CM23 · a second off answers GET /holders and mayExit from its own table, never the stopped poll\'s last (empty) answer', async () => {
  const pending = []
  const timers = { setTimeout: (fn) => { pending.push(fn); return pending.length }, clearTimeout: () => {} }
  const d = descs[0], f = d.proxyMode.forms.find((x) => x.os.includes('darwin')), g = `${d.name}:${f.route}`
  const T1 = INSTALLED + 100, T2 = INSTALLED + 1000
  let table = [{ pid: 51, startedAt: T1 + 1 }], hang = null, reads = 0
  const { c, w } = await rig({ desc: d, timers, w: { pid: 51, facts: { agent: d.name, startedAt: T1 + 1 }, env: {} } })
  Object.defineProperty(w, 'procs', { get: () => { reads++; return hang && reads > 1 ? hang.p : table } })
  const live = (on, off) => { w.manifest = manifestOf(d.name, { liveness: { [d.name]: { on_at: iso(on), ...(off ? { off_at: iso(off) } : {}) } } }) }
  const connect = () => c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
  live(T1); w.now = T1; await c.on({ harnesses: [d.name], groups: { [g]: 18108 } })
  w.now = T1 + 2; await connect()
  w.now = T1 + 10; live(T1, T1 + 10); assert.equal((await c.off({ harnesses: [d.name] })).holders, 1)
  table = [] // the first holder exits: the poll answers [] and stops, its door closes
  for (let i = 0; i < 8 && Object.keys(c.doors()).length; i++) { await pending.shift()?.(); await new Promise((r) => setImmediate(r)) }
  assert.deepEqual(c.doors(), {})
  // window 2: a new holder; the poll's own table read hangs (the real lsof's seconds), the off's first read answers
  table = [{ pid: 52, startedAt: T2 + 1 }]; w.pid = 52; w.facts = { agent: d.name, startedAt: T2 + 1 }
  live(T2); w.now = T2; await c.on({ harnesses: [d.name], groups: { [g]: 18108 } })
  w.now = T2 + 2; await connect()
  let release; hang = { p: new Promise((r) => { release = () => r(table) }) }; reads = 0
  w.now = T2 + 10; live(T2, T2 + 10)
  assert.equal((await c.off({ harnesses: [d.name] })).holders, 1)
  try {
    assert.equal((await c.holders()).count, 1, 'GET /holders right after the second off names its holder')
    assert.equal(c.mayExit(), false, 'and the daemon may not exit under it')
  } finally { release(); c.close() }
})

// ---- 1.6 §5.2 (D82): a daemon swap's drain is no off ----------------------------------------------------------------------------------------------
test('a stop that replaces the daemon leaves the harness on: the door still decrypts and the reply reads off, until on cancels it', async () => {
  const { d, f, os } = rootForm
  const g = `${d.name}:${f.route}`, { w, facts } = worldOf(d, f, os, {}), base = ctxOf(w)
  const { c } = await rig({ desc: { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }, os, upstreamRoots: { os: async () => '', node: [], extra: [] },
    w: { pid: ++pid, facts: { exe: '/bin/x', uid: 501, agent: d.name, startedAt: facts.startedAt }, env: w.env, cwd: w.cwd, ctx: { ...base, readFile: (p) => base.readFile(p).replace(ROOT.pem, STUB_PEM) } } })
  await c.on({ harnesses: [d.name], groups: { [g]: 18107 } })
  const reply = await c.off({ exit: true, by: 'install' })
  assert.equal(reply.actual, 'off', 'the CLI confirms a nameless off by actual (1.6 §3.1)')
  assert.equal(c.isOn(d.name), true)
  const meta = await c.lookupIngress({ peer: PEER, user: g, target: { address: d.hosts[0], port: 443 } })
  assert.equal(meta.decrypt, true, JSON.stringify(meta))
  assert.deepEqual(c.doors(), { [g]: 18107 })
  assert.equal(c.mayExit(), true, 'leaving with no connection: it may go though the harness is on')
  await c.on({ harnesses: [d.name], groups: {} })
  assert.equal(c.leaving(), false, 'POST /on cancels the exit')
  assert.equal(c.mayExit(), false, 'the on harness keeps the daemon again')
  c.close()
})

for (const by of ['uninstall', null]) {
  test(`an exit ${by ? `by ${by}` : 'with no by'} is an off: the harness leaves the on set and a kept door only forwards`, async () => {
    const { d, f } = rootForm, g = `${d.name}:${f.route}`
    const { c, w } = await rig({ desc: d, w: { pid: 4242, facts: { agent: d.name, startedAt: INSTALLED + 1 }, env: {}, procs: [{ pid: 4242, startedAt: INSTALLED + 1 }] } })
    await c.on({ harnesses: [d.name], groups: { [g]: 18108 } })
    await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
    w.manifest = manifestOf(d.name, { liveness: { [d.name]: { on_at: iso(INSTALLED) } } })
    w.now = INSTALLED + 10
    assert.equal((await c.off({ exit: true, by })).actual, 'off')
    assert.equal(c.isOn(d.name), false)
    assert.equal(c.leaving(), false)
    const meta = await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
    assert.deepEqual(meta.skip, { not_captured: 'untracked', reason: 'group-off' })
    c.close()
  })
}

// ---- 1.6 §1.1: off --now after a plain off cuts what the first off left draining -------------------------------------------------------------------
test('a nameless off --now after a plain off cuts the connections the first off left draining', async () => {
  const { d } = rootForm
  const flows = [{ agent: d.name, state: 'open' }] // one streaming connection of the harness, as the engine holds it
  const drain = async ({ harnesses, now }) => { // the engine's drain: the connections of those harnesses (null: every one) are asked to close, or cut on now
    const out = { closing: 0, waiting: 0, cut: 0 }
    for (const x of flows) if ((!harnesses || harnesses.includes(x.agent)) && x.state !== 'cut') { x.state = now ? 'cut' : 'closing'; out[x.state]++ }
    return out
  }
  const { c } = await rig({ desc: d, drain })
  await c.on({ harnesses: [d.name], groups: { [`${d.name}:${rootForm.f.route}`]: 18109 } })
  assert.deepEqual((await c.off({})).relayed, { closing: 1, waiting: 0, cut: 0 })
  assert.equal((await c.off({ now: true })).relayed.cut, 1, 'the second off cuts the stream the first one let run')
  assert.deepEqual((await c.off({ now: true })).relayed, { closing: 0, waiting: 0, cut: 0 }, 'nothing left relayed: nothing to cut, no error')
  c.close()
})

// ---- the door's durable record (P12 「门的持久记录」) ------------------------------------------------------------------------------------
const doorRows = (dir) => readDoorSeen({ dir }).rows
const fireAll = async (pending, rounds = 4) => { for (let i = 0; i < rounds; i++) { for (const fn of pending.splice(0)) await fn(); await new Promise((r) => setImmediate(r)) } }

test('a life the door accepted is a holder of a NEW collector over the same dir (a daemon restart, no new connection); without the accept it is not', async () => {
  const d = descs[0], f = d.proxyMode.forms.find((x) => x.os.includes('darwin')), g = `${d.name}:${f.route}`
  const T1 = INSTALLED + 100, P = 61, START = INSTALLED - 50, table = [{ pid: P, startedAt: START }]
  for (const accept of [true, false]) {
    const dir = tmpDir()
    const { c: c1 } = await rig({ desc: d, dir, w: { pid: P, facts: { agent: d.name, startedAt: START }, env: {}, procs: table, now: T1, manifest: manifestOf(d.name, { liveness: { [d.name]: { on_at: iso(T1) } } }) } })
    await c1.on({ harnesses: [d.name], groups: { [g]: 18110 } })
    if (accept) { await c1.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } }) }
    c1.close()
    const { c: c2 } = await rig({ desc: d, dir, w: { procs: table, now: T1 + 20, manifest: manifestOf(d.name, { liveness: { [d.name]: { on_at: iso(T1), off_at: iso(T1 + 10) } } }) } })
    const got = await c2.holders()
    assert.deepEqual(got.holders.map((h) => [h.harness, h.pid]), accept ? [[d.name, P]] : [], accept ? 'the durable accept row names the holder' : 'no door row: not a holder')
    c2.close()
  }
})

test('after a poll tick the door rows of a life that left the process table are gone; a live one stays', async () => {
  const pending = []
  const timers = { setTimeout: (fn) => { pending.push(fn); return pending.length }, clearTimeout: () => {} }
  const d = descs[0], f = d.proxyMode.forms.find((x) => x.os.includes('darwin')), g = `${d.name}:${f.route}`
  const T1 = INSTALLED + 100, dir = tmpDir()
  const { c, w } = await rig({ desc: d, dir, timers, w: { pid: 71, facts: { agent: d.name, startedAt: T1 + 1 }, env: {}, procs: [{ pid: 71, startedAt: T1 + 1 }, { pid: 72, startedAt: T1 + 1 }], now: T1, manifest: manifestOf(d.name, { liveness: { [d.name]: { on_at: iso(T1) } } }) } })
  await c.on({ harnesses: [d.name], groups: { [g]: 18111 } })
  w.now = T1 + 2
  for (const p of [71, 72]) { w.pid = p; await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } }) }
  w.now = T1 + 10; w.manifest = manifestOf(d.name, { liveness: { [d.name]: { on_at: iso(T1), off_at: iso(T1 + 10) } } })
  await c.off({ harnesses: [d.name] })
  w.procs = [{ pid: 72, startedAt: T1 + 1 }]
  await fireAll(pending)
  c.close()
  assert.deepEqual([...new Set(doorRows(dir).map((r) => r.pid))], [72])
})

test('a collector with no door traffic writes no door record', async () => {
  const d = descs[0], f = d.proxyMode.forms.find((x) => x.os.includes('darwin')), g = `${d.name}:${f.route}`, dir = tmpDir()
  const { c } = await rig({ desc: d, dir, w: { procs: [{ pid: 5, startedAt: INSTALLED + 1 }] } })
  await c.on({ harnesses: [d.name], groups: { [g]: 18112 } })
  await c.off({ harnesses: [d.name] })
  c.close()
  assert.equal(fs.existsSync(path.join(dir, DOOR_SEEN_FILE)), false)
})

test('a door record unreadable at start: said as door-record-unreadable; the record written back stays not known while a process of the harness from before lives, and is whole once none does', async () => {
  const d = descs[0], dir = tmpDir(), T1 = INSTALLED + 100
  fs.writeFileSync(path.join(dir, DOOR_SEEN_FILE), '{not json')
  const identity = serializeSignature(compileIdentity({ harness: d.name, names: [{ name: 'agentq' }] }))
  const p = (pid, startedAt) => ({ pid, ppid: 1, uid: 501, startedAt, exe: '/opt/agentq', argv: ['agentq'], env: () => null, envRead: false })
  const manifest = manifestOf(d.name, { liveness: { [d.name]: { identity, rereads: false, since: iso(INSTALLED), on_at: iso(INSTALLED + 1), off_at: iso(INSTALLED + 2) } } })
  const run = async (procs) => {
    const { c, records } = await rig({ desc: d, dir, w: { procs, now: T1, manifest } })
    const got = await c.holders()
    c.close()
    return { got, said: records.filter((r) => r.code === 'door-record-unreadable').length }
  }
  const before = await run([p(91, T1 - 50)])
  assert.equal(before.said, 1)
  assert.deepEqual(before.got.holders.map((h) => [h.pid, h.why]), [[91, 'history-unknown']])
  assert.equal(readDoorSeen({ dir }).rows, null, 'a process from before the unreadable moment lives: still not known')
  const after = await run([p(92, T1 + 500)])
  assert.deepEqual(after.got.holders, [], 'none from before: the door evidence is known again')
  assert.deepEqual(readDoorSeen({ dir }).rows, [], 'and the file says so')
})

test('PAC GETs are counted per life: two from one life are one kind:\'pac\' row with n = 2 at the latest time; a new life of the same pid gets its own row', async () => {
  const dir = tmpDir(), S1 = INSTALLED + 1, S2 = INSTALLED + 500
  const { c, w } = await rig({ desc: pacDesc, dir, w: { pid: 81, facts: { agent: pacDesc.name, uid: 501, startedAt: S1 }, now: INSTALLED + 10 } })
  await c.on({ harnesses: [pacDesc.name], groups: { [pacG]: 18113 } })
  const get = () => c.servePac({ peer: PEER, user: pacG, path: pacPath(TOKEN) })
  await get(); w.now = INSTALLED + 20; await get()
  w.facts = { ...w.facts, startedAt: S2 }; w.now = INSTALLED + 600; await get()
  c.close()
  const pac = doorRows(dir).filter((r) => r.kind === 'pac').map((r) => [r.group, r.pid, r.start, r.n, r.at]).sort((a, b) => a[2] - b[2])
  assert.deepEqual(pac, [[pacG, 81, S1, 2, INSTALLED + 20], [pacG, 81, S2, 1, INSTALLED + 600]])
})

// ---- ① / G4: no writes; the recorded ports; a taken port ----------------------------------------------------------------------------------------
test('4.11 ① · on / off / restore / lookup write none of state, ingress or the manifest: a recording fs sees writes to the door record (P12) and nothing else', async () => {
  const dir = tmpDir()
  const d = descs[0], f = d.proxyMode.forms.find((x) => x.os.includes('darwin')), g = `${d.name}:${f.route}`
  await loadIngressConfig({ dir, groups: [g], isFree: async () => true })
  writeStateAtomic(path.join(dir, 'state.json'), setDesired(emptyState(), [d.name], 'on'))
  saveManifest(dir, manifestOf(d.name))
  const writes = [], fds = new Map() // the path each write touches (an fd call: the path it was opened for writing)
  const rec = new Proxy(fs, { get: (t, k) => {
    const fn = t[k]
    if (k === 'openSync') return (p, fl = 'r', ...r) => { const fd = fn.call(t, p, fl, ...r); if (fl !== 'r') { fds.set(fd, String(p)); writes.push(String(p)) } return fd }
    if (typeof fn !== 'function' || !/write|rename|mkdir|unlink|rm|copy|chmod|append|truncate|symlink|utimes/i.test(String(k))) return fn
    return (...a) => { writes.push(typeof a[0] === 'string' ? a[0] : fds.get(a[0]) ?? `fd ${a[0]}`); return fn.apply(t, a) }
  } })
  const c = createModelCollector({ harnesses: [d], dir, fs: rec, ctx: { os: 'darwin', home: '/h', dirs: {}, readFile: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }, readdir: () => [] }, custody: 'unavailable', proxyOf, bypassOf,
    identify: () => ({ reason: 'match', agent: d.name }), ownerOf: async () => ({ pid: 9 }), factsOf: async () => ({ startedAt: INSTALLED + 1 }) })
  c.bindDoors({ open: async () => {}, close: async () => {} })
  const port = JSON.parse(fs.readFileSync(path.join(dir, 'ingress.json'), 'utf8')).groupPorts[g]
  assert.deepEqual(Object.keys((await c.start()).doors), [g], 'restore reopened the desired harness\'s door')
  await c.on({ harnesses: [d.name], groups: { [g]: port } })
  await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
  await c.off({ harnesses: [d.name] })
  c.close() // flushes the door record synchronously: what is asserted does not hang on the throttle timer
  const isDoorRecord = (p) => p === dir || (path.dirname(p) === dir && path.basename(p).startsWith(DOOR_SEEN_FILE))
  assert.deepEqual(writes.filter((p) => !isDoorRecord(p)), [], 'state.json, ingress.json and the manifest are not written')
  assert.ok(writes.some((p) => p !== dir && isDoorRecord(p)), 'the lookup\'s accept row reached the door record')
})

test('① / G4 · restore reopens the desired harnesses on ingress.json\'s recorded ports; a taken port gives engine-port-taken and no door', async () => {
  const d = descs[0], routes = Object.keys(d.proxyMode.routes)
  const groups = Object.fromEntries(routes.map((r, i) => [`${d.name}:${r}`, 18200 + i]))
  const opened = []
  const taken = new Set([18200])
  const { c, records } = await rig({ desc: d, opened, taken, ingress: { groupPorts: { ...groups, 'someone-else:x': 18299 }, listenerToken: TOKEN }, w: { state: { harnesses: { [d.name]: { desired: 'on' } } } } })
  assert.deepEqual(opened.map((x) => [x.id, x.port]), Object.entries(groups).filter(([, p]) => !taken.has(p)), 'only the recorded ports, only this harness\'s groups')
  for (const x of opened) assert.equal(x.token, x.auth ? TOKEN : undefined)
  const first = Object.keys(groups)[0]
  assert.equal(c.doors()[first], undefined)
  assert.ok(records.some((r) => r.code === 'engine-port-taken' && r.where === 'ingress' && r.door === first))
  const again = await c.on({ harnesses: [d.name], groups: { [first]: 18200 } })
  assert.deepEqual(again.doors, {}); assert.deepEqual(again.skipped, [{ g: first, reason: 'engine-port-taken' }])
  const url = (await c.on({ harnesses: [d.name], groups: { [first]: 18250 } })).doors[first]
  assert.equal(url, d.proxyMode.routes[routes[0]].auth === false ? 'http://127.0.0.1:18250' : `http://${encodeURIComponent(first)}:${TOKEN}@127.0.0.1:18250`)
  c.close()
})

test('1.6 V32 `attached` · the daemon\'s own answer: every group ingress.json records for the harness listens → true; one recorded group without its door, or none recorded → false; ingress.json unreadable → null', async () => {
  const d = descs[0], routes = Object.keys(d.proxyMode.routes)
  const groups = Object.fromEntries(routes.map((r, i) => [`${d.name}:${r}`, 18300 + i]))
  const on = { state: { harnesses: { [d.name]: { desired: 'on' } } } }
  const all = await rig({ desc: d, ingress: { groupPorts: groups, listenerToken: TOKEN }, w: { ...on } })
  assert.equal(all.c.attached(d.name), true, 'every recorded group has its door')
  assert.equal(all.c.attached('someone-else'), false, 'a harness with no recorded group is not attached')
  all.c.close()
  const oneShut = await rig({ desc: d, ingress: { groupPorts: groups, listenerToken: TOKEN }, taken: new Set([18300]), w: { ...on } })
  assert.equal(oneShut.c.attached(d.name), false, 'one recorded group without a listening door: the path in is not up')
  oneShut.c.close()
  const none = await rig({ desc: d, ingress: { groupPorts: {}, listenerToken: TOKEN }, w: { ...on } })
  assert.equal(none.c.attached(d.name), false, 'nothing recorded for it')
  none.c.close()
  const unread = await rig({ desc: d, ingress: { error: 'EACCES' }, w: { ...on } })
  assert.equal(unread.c.attached(d.name), null, 'ingress.json unreadable: not known')
  unread.c.close()
  const absent = await rig({ desc: d, ingress: { missing: true }, w: { ...on } })
  assert.equal(absent.c.attached(d.name), false, 'no ingress.json: nothing recorded for it, so no (not 不知道)')
  absent.c.close()
})

// 4.8 §5.3 W16 (trust verdict): at one door of a group with two forms (claude-code:settings), each process is judged on its own facts against
// every form of the route — one whose settings trust the root decrypts, one whose settings do not is forwarded untrusted. CM22 checks one
// process per door of the shipped descriptor; this adds a second, failing process at the same multi-form door.
test('two processes at one door of a two-form group are each judged on their own facts: the trusted one decrypts, the other is forwarded untrusted', async () => {
  const d = descs.find((x) => x.name === 'claude-code'), g = 'claude-code:settings'
  const forms = d.proxyMode.forms.filter((f) => f.route === 'settings' && f.os.includes('darwin'))
  assert.ok(forms.length >= 2, 'the group carries two forms')
  const r = await rig({ desc: d })
  await r.c.on({ harnesses: [d.name], groups: { [g]: 18400 } })
  const t = d.proxyMode.trusts[forms[0].trust]
  const ask = async (p, { c: cs, w, facts }) => {
    const base = ctxOf(w)
    Object.assign(r.w, { pid: p, facts: { exe: '/bin/x', uid: 501, agent: d.name, startedAt: facts.startedAt }, env: w.env, cwd: w.cwd, ctx: { ...base, readFile: (q) => base.readFile(q).replace(ROOT.pem, STUB_PEM) } })
    return r.c.lookupIngress({ peer: PEER, user: g, target: { address: cs.host, port: 443 } })
  }
  const trusted = await ask(7101, worldOf(d, forms[0], 'darwin', {}))
  const other = await ask(7102, worldOf(d, forms[1], 'darwin', { sources: t.sources.map(() => 'lacks') }))
  assert.deepEqual([trusted.decrypt, other.decrypt, other.skip && other.skip.not_captured], [true, false, 'untrusted'])
  r.c.close()
})

// 4.8 §3: a group gets a door only while its harness is on (or a holder of it lives: V55); the PAC group, which takes no credentials, likewise
test('a recorded group whose harness is off and has no holder gets no door; the PAC group has its door only while its harness is on', async () => {
  const cc = descs.find((x) => x.name === 'claude-code'), other = descs.find((x) => x.name === 'codex')
  const groupsOf = (d, base) => Object.fromEntries(Object.keys(d.proxyMode.routes).map((rt, i) => [`${d.name}:${rt}`, base + i]))
  const ccGroups = groupsOf(cc, 18500), otherGroups = groupsOf(other, 18520)
  const gPac = Object.keys(ccGroups).find((g) => cc.proxyMode.routes[g.split(':')[1]].auth === false)
  assert.ok(gPac, 'claude-code has a group that takes no credentials')
  const { c } = await rig({ desc: other, others: [cc], ingress: { groupPorts: { ...ccGroups, ...otherGroups }, listenerToken: TOKEN }, w: { state: { harnesses: { [other.name]: { desired: 'on' }, [cc.name]: { desired: 'off' } } } } })
  assert.deepEqual(c.doors(), otherGroups, 'at start: the on harness\'s doors only')
  await c.on({ harnesses: [cc.name], groups: { [gPac]: ccGroups[gPac] } })
  assert.equal(c.doors()[gPac], ccGroups[gPac], 'the PAC door opens with its harness')
  await c.off({ harnesses: [cc.name] })
  assert.deepEqual(c.doors(), otherGroups, 'off with no holder: the PAC door is closed, the other harness\'s doors stay')
  c.close()
})

// 4.6 §开关 proxy mode (D38): at start, a harness desired on whose ingress.json cannot be read opens no door and leaves one failure record with a known
// code; with no harness desired on, ingress.json is not needed (a never-turned-on install has none) and nothing is recorded.
for (const ingress of [{ missing: true }, { error: 'EACCES' }]) for (const anyOn of [true, false]) {
  test(`4.6 · restore · ingress.json ${ingress.missing ? 'missing' : 'unreadable'} · ${anyOn ? 'a harness desired on' : 'none desired on'}: ${anyOn ? 'one recorded failure, no door' : 'no record'}`, async () => {
    const d = descs[0], opened = []
    const state = { harnesses: anyOn ? { [d.name]: { desired: 'on' } } : { [d.name]: { desired: 'off' } } }
    const { c, records } = await rig({ desc: d, opened, ingress, w: { state } })
    const failures = records.filter((r) => r.event === 'failure')
    if (anyOn) {
      assert.equal(failures.length, 1, JSON.stringify(failures))
      assert.ok(CODES.includes(failures[0].code), failures[0].code)
      assert.deepEqual(checkRecord(failures[0]), [])
    } else assert.deepEqual(failures, [])
    assert.deepEqual(opened, [], 'no door opened')
    assert.deepEqual(c.doors(), {})
    c.close()
  })
}

// ---- evidence that was not read is never kept (4.11 P7 · P11, D38) ------------------------------------------------------------------
// Over every verified, non-host-tree form: the process env or cwd unreadable on the first connection, readable later — a connection after the
// throttle second gets the verdict the readable world gives (never the first one's pinned forward); within that second the reader is asked once.
const plain = CASES.filter(({ f, os }) => f.verified[os] === true && !f.hostTree && !(f.forwardOnlyHosts || []).length)
for (const axis of [{ envNull: true }, { cwdNull: true }]) {
  test(`4.11 P7 · P11 · ${Object.keys(axis)[0]}: an unread env / cwd is asked again after a second and its verdict is not kept`, async () => {
    let healed = 0
    for (const { d, f, os } of plain) {
      const desc = { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }, g = `${d.name}:${f.route}`
      const r = await rig({ desc, os })
      await r.c.on({ harnesses: [d.name], groups: { [g]: 18500 } })
      const put = (over) => { const x = worldOf(d, f, os, over), base = ctxOf(x.w); Object.assign(r.w, { pid: 4545, facts: { exe: '/bin/x', uid: 501, agent: d.name, startedAt: x.facts.startedAt }, env: x.w.env, cwd: x.w.cwd, ctx: { ...base, readFile: (p) => base.readFile(p).replace(ROOT.pem, STUB_PEM) } }); return x }
      const ask = async (host) => (await r.c.lookupIngress({ peer: PEER, user: g, target: { address: host, port: 443 } })).decrypt
      const x = put(axis)
      const first = await ask(x.c.host)
      const calls = r.w.envCalls
      await ask(x.c.host); await ask(x.c.host)
      if (axis.envNull) assert.equal(r.w.envCalls, calls, `${f.id} · ${os}: an env that does not read is asked at most once a second`)
      const y = put({})
      r.w.now = INSTALLED + 5 + 1001
      const want = verdictOf({ desc, form: f, facts: { ...y.facts, pid: 4545 }, record: { carrierInstalledAt: INSTALLED, rootFp256: STUB_FP }, issuer: ready, host: y.c.host, ctx: r.w.ctx })
      assert.equal(await ask(y.c.host), want.decrypt, `${f.id} · ${os}: the later connection is judged on what reads now`)
      if (!first && want.decrypt) healed++
      r.c.close()
    }
    if (axis.envNull) assert.ok(healed > 0, 'some form reads the env for its verdict, so the axis is exercised')
  })
}

test('4.11 P11 · an unreadable manifest: the last good one is used and said once; with none read yet the verdict is not kept', async () => {
  const { d, f, os } = rootForm, g = `${d.name}:${f.route}`
  const desc = { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }
  const r = await rig({ desc, os, w: { pid: 4646, facts: { agent: d.name, uid: 501, startedAt: INSTALLED + 1 }, env: {}, cwd: '/', manifestErr: Object.assign(new Error('busy'), { code: 'EBUSY' }) } })
  await r.c.on({ harnesses: [d.name], groups: { [g]: 18501 } })
  const ask = async () => (await r.c.lookupIngress({ peer: PEER, user: g, target: { address: d.hosts[0], port: 443 } })).decrypt
  assert.equal(await ask(), false, 'no manifest read yet: no carrier known')
  r.w.manifestErr = null; r.w.now = INSTALLED + 5 + 1001
  assert.equal(await ask(), true, 'it reads now: the same process decrypts')
  r.w.manifestErr = Object.assign(new Error('busy'), { code: 'EBUSY' }); r.w.now += 1001; r.w.pid = 4647
  assert.equal(await ask(), true, 'a later read that fails keeps the last good manifest')
  const said = r.records.filter((x) => x.code === 'manifest-unreadable')
  assert.equal(said.length, 2, 'once per spell of failed reads')
  for (const x of r.records) assert.deepEqual(checkRecord(x), [], JSON.stringify(x))
  r.c.close()
})

// ---- negative-cache keys per process life, cleared on exit (4.8 §5.5) ---------------------------------------------------------------
test('4.8 §5.5 · the negative-cache key is pid@start; a held key is forgotten when its process is gone from the table, a group key when its door closes', async () => {
  const { d, f, os } = rootForm, g = `${d.name}:${f.route}`
  const pending = [], forgot = []
  const timers = { setTimeout: (fn, ms) => { if (ms === HOLDER_POLL_MS) pending.push(fn); return { unref() {} } }, clearTimeout: () => {} } // the sweep's (the issuer's own timers are not this test's)
  const r = await rig({ desc: { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }, os, timers, forget: (who, p) => forgot.push([who, p]), w: { pid: 777, facts: { agent: d.name, uid: 501, startedAt: INSTALLED + 1 }, env: {}, cwd: '/' } })
  await r.c.on({ harnesses: [d.name], groups: { [g]: 18502 } })
  const ask = async () => r.c.lookupIngress({ peer: PEER, user: g, target: { address: d.hosts[0], port: 443 } })
  assert.equal((await ask()).negKey, `777@${INSTALLED + 1}`)
  r.w.facts = { ...r.w.facts, startedAt: INSTALLED + 2 }
  assert.equal((await ask()).negKey, `777@${INSTALLED + 2}`, 'a later life of the pid has a key of its own: it inherits nothing')
  assert.equal(pending.length, 0, 'nothing held: no timer, no table read')
  for (const who of [`777@${INSTALLED + 1}`, '888', g]) r.c.noteHeld(who)
  assert.equal(pending.length, 1, 'one timer while keys are held')
  r.w.procs = [{ pid: 777, startedAt: INSTALLED + 1 }, { pid: 888, startedAt: 5 }]
  await pending.shift()()
  assert.deepEqual(forgot, [], 'every process alive, the door open: nothing goes')
  r.w.procs = [{ pid: 777, startedAt: INSTALLED + 2 }]
  await pending.shift()()
  assert.deepEqual(forgot.sort(), [[`777@${INSTALLED + 1}`, 777], ['888', 888]], 'the first life of 777 exited (its pid holds another), 888 is gone')
  r.w.procs = []
  await r.c.off({ harnesses: [d.name] })
  await pending.shift()()
  assert.deepEqual(forgot.at(-1), [g, null], 'the group key goes with its door')
  assert.equal(pending.length, 0, 'nothing held: the timer stops')
  r.c.close()
})

test('4.8 §5.5 · a key the engine no longer holds anything under is dropped: no table read for it, no timer left', async () => {
  const { d, f, os } = rootForm
  const pending = [], forgot = [], holding = new Set(['999@7'])
  let reads = 0
  const timers = { setTimeout: (fn, ms) => { if (ms === HOLDER_POLL_MS) pending.push(fn); return { unref() {} } }, clearTimeout: () => {} }
  const r = await rig({ desc: { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }, os, timers, forget: (who, p) => forgot.push([who, p]), holds: (who) => holding.has(who), w: { get procs() { reads++; return [{ pid: 999, startedAt: 7 }] } } })
  r.c.noteHeld('999@7')
  assert.equal(pending.length, 1, 'a strike is held: the sweep is armed')
  holding.delete('999@7') // an acceptance cleared the strike
  reads = 0
  await pending.shift()()
  assert.deepEqual([reads, pending.length, forgot], [0, 0, []], 'nothing held under the key: no table read, no timer, nothing to forget')
  r.c.close()
})

// 4.11 P4 rule U · P11 rule 3: one block in a user certificate file serves every harness whose setting names that file, but is recorded under the
// first. For each shipped harness with an env setting among its userCertFiles, the block is recorded under another harness, later than this harness's
// own items: a process started between the two is config-after-start; one started after both is not. Over the descriptors as they ship, darwin.
for (const d of await loadHarnesses()) {
  const v = (d.proxyMode && d.proxyMode.userCertFiles || []).find((s) => typeof s.env === 'string')
  const f = v && judgedForms(d, 'darwin')[0]
  if (!f) continue
  for (const by of ['another-harness', d.name]) test(`rule U · ${d.name}, block recorded under ${by}: the shared block's install time is its carrier time too`, async () => {
    const file = '/h/certs/mine.pem', g = `${d.name}:${f.route}`
    const manifest = { ...manifestOf(d.name), entries: [...manifestOf(d.name).entries, { phase: 'install', harness: by, kind: 'text', format: 'pem-block', path: file, installed_at: iso(INSTALLED + 10) }] }
    const r = await rig({ desc: d, os: 'darwin', w: { pid: 7070, manifest, env: { [v.env]: file }, cwd: '/' } })
    await r.c.on({ harnesses: [d.name], groups: Object.fromEntries([...new Set(d.proxyMode.forms.map((x) => x.route))].map((rt, i) => [`${d.name}:${rt}`, 18600 + i])) })
    for (const [start, late] of [[INSTALLED + 5, false], [INSTALLED + 20, true]]) {
      Object.assign(r.w, { pid: r.w.pid + 1, facts: { exe: '/bin/x', uid: 501, agent: d.name, startedAt: start }, now: INSTALLED + 30 })
      const meta = await r.c.lookupIngress({ peer: PEER, user: g, target: { address: d.hosts[0], port: 443 } })
      const why = meta.skip && meta.skip.reason
      if (late) assert.notEqual(why, 'config-after-start', `${d.name}: started after the block`)
      else assert.equal(why, 'config-after-start', `${d.name}: started after its own items, before the shared block: ${JSON.stringify(meta.skip)}`)
    }
    r.c.close()
  })
}

// 4.11 P4 rule U · P11 (D38): a setting that may name rule U's file cannot be read, so whether the recorded block is this process's carrier, and its time,
// is not known — forwarded with config-unreadable and a failure record, never judged as if the setting named nothing. Every shipped harness with a file
// setting among its userCertFiles, darwin; the block recorded under another harness after this one's own items.
for (const d of await loadHarnesses()) {
  const s = (d.proxyMode && d.proxyMode.userCertFiles || []).find((x) => x.file)
  const f = s && judgedForms(d, 'darwin')[0]
  if (!f) continue
  test(`rule U · ${d.name}: a setting naming the user certificate file cannot be read — forwarded only, with config-unreadable on record`, async () => {
    const g = `${d.name}:${f.route}`
    const manifest = { ...manifestOf(d.name), entries: [...manifestOf(d.name).entries, { phase: 'install', harness: 'another-harness', kind: 'text', format: 'pem-block', path: '/h/certs/mine.pem', installed_at: iso(INSTALLED + 10) }] }
    const base = ctxOf(newWorld('darwin'))
    const blocked = new Set(resolveLoc(s.file, { os: 'darwin', home: '/h', dirs: {}, join: path.posix.join, env: {}, cwd: '/' }))
    const readFile = (p) => { if (blocked.has(p)) throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); return base.readFile(p) }
    const r = await rig({ desc: d, os: 'darwin', w: { pid: 7171, manifest, env: {}, cwd: '/', ctx: { ...base, readFile } } })
    await r.c.on({ harnesses: [d.name], groups: Object.fromEntries([...new Set(d.proxyMode.forms.map((x) => x.route))].map((rt, i) => [`${d.name}:${rt}`, 18650 + i])) })
    Object.assign(r.w, { facts: { exe: '/bin/x', uid: 501, agent: d.name, startedAt: INSTALLED + 20 }, now: INSTALLED + 30 })
    const meta = await r.c.lookupIngress({ peer: PEER, user: g, target: { address: d.hosts[0], port: 443 } })
    assert.deepEqual(meta.skip, { not_captured: 'untrusted', reason: 'config-unreadable' }, JSON.stringify(meta))
    assert.ok(r.records.some((x) => x.event === 'failure' && x.code === 'config-unreadable'), 'the forward is on record')
    r.c.close()
  })
}

// 4.11 P11 rule 4 at the door: a userCertFiles setting marked replace (as shipped: Hermes's per-route ssl_ca_cert) naming a file without the trocar root is
// forwarded on its first connection, replace-without-ca on record, never decrypted first; the verdict is kept (its evidence was read), so a second
// connection of that life reads nothing again. The same file with install's marked block decrypts. Real bytes in a tmp dir.
for (const d of (await loadHarnesses()).filter((x) => (x.proxyMode.userCertFiles || []).some((s) => s.semantics === 'replace' && s.file))) {
  const s = d.proxyMode.userCertFiles.find((x) => x.semantics === 'replace' && x.file)
  const f = judgedForms(d, 'darwin')[0]
  test(`P11 rule 4 at the door · ${d.name}: a replacing user certificate file without the root is forwarded before any decrypt; with install's block it decrypts`, async () => {
    for (const [text, want] of [[makeRoot('a corporate root').pem, 'replace-without-ca'], [pemBlock(makeRoot('a corporate root').pem, STUB_PEM).text, null]]) {
      const dir = tmpDir('trocar-door-replace-'), ca = path.join(dir, 'corp.pem')
      fs.writeFileSync(ca, text)
      const env = {}, loc = s.file.perOs ? s.file.perOs.darwin : s.file
      if (loc.env) env[loc.env] = dir
      const at = resolveLoc(s.file, { os: 'darwin', home: dir, dirs: {}, join: path.join, env, cwd: dir })[0]
      const tree = s.keys.reduceRight((v, k) => ({ [k === '*' ? 'corp' : k]: v }), ca)
      const yaml = (o, ind = '') => Object.entries(o).map(([k, v]) => (typeof v === 'object' ? `${ind}${k}:\n${yaml(v, ind + '  ')}` : `${ind}${k}: ${v}\n`)).join('')
      fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, yaml(tree))
      let reads = 0
      const base = ctxOf(newWorld('darwin'))
      const readFile = (p) => { if (!p.startsWith(dir)) return base.readFile(p); reads++; return fs.readFileSync(p, 'utf8') }
      const r = await rig({ desc: d, os: 'darwin', w: { pid: 7272, env, cwd: dir, ctx: { ...base, readFile }, facts: { exe: '/bin/x', uid: 501, agent: d.name, startedAt: INSTALLED + 20 }, now: INSTALLED + 30 } })
      await r.c.on({ harnesses: [d.name], groups: { [`${d.name}:${f.route}`]: 18700 } })
      const ask = () => r.c.lookupIngress({ peer: PEER, user: `${d.name}:${f.route}`, target: { address: d.hosts[0], port: 443 } })
      const meta = await ask()
      assert.equal(meta.decrypt, want === null, JSON.stringify(meta))
      if (want) {
        assert.equal(meta.skip && meta.skip.reason, want)
        assert.ok(r.records.some((x) => x.event === 'failure' && x.code === want), 'the forward is on record')
        const n = reads
        assert.equal((await ask()).decrypt, false)
        assert.equal(reads, n, 'the verdict from read evidence is kept: nothing read again for the same life')
      }
      for (const x of r.records) assert.deepEqual(checkRecord(x), [], JSON.stringify(x))
      r.c.close()
    }
  })
}

// ---- forwarding by design is no failure event; the switch is the in-memory one (4.6 §连接行 · §开关) -------------------------------------
test('4.6 §连接行 · a not-verified verdict writes no failure event (the row carries it); config-after-start writes one, once', async () => {
  const { d, f, os } = rootForm, g = `${d.name}:${f.route}`
  for (const [over, code, events] of [[{ verified: { reason: 'not-measured' } }, 'not-verified', 0], [{ start: 'before' }, 'config-after-start', 1]]) {
    const { form, facts } = worldOf(d, f, os, over)
    const r = await rig({ desc: { ...d, proxyMode: { ...d.proxyMode, forms: [form] } }, os, w: { pid: 5151, facts: { agent: d.name, uid: 501, startedAt: facts.startedAt }, env: {}, cwd: '/' } })
    await r.c.on({ harnesses: [d.name], groups: { [g]: 18503 } })
    for (let i = 0; i < 2; i++) assert.deepEqual((await r.c.lookupIngress({ peer: PEER, user: g, target: { address: d.hosts[0], port: 443 } })).skip, { not_captured: 'untrusted', reason: code })
    assert.equal(r.records.filter((x) => x.event === 'failure' && x.code === code).length, events, code)
    r.c.close()
  }
})

test('4.6 §开关 · isOn follows on / off; a state.json that cannot be read at start is a where:state failure, every harness off', async () => {
  const { d, f, os } = rootForm, g = `${d.name}:${f.route}`
  const r = await rig({ desc: d, os, w: { get state() { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) } } })
  assert.deepEqual(r.records.filter((x) => x.where === 'state').map((x) => [x.event, x.code]), [['failure', 'EACCES']])
  for (const x of r.records) assert.deepEqual(checkRecord(x), [], JSON.stringify(x))
  assert.equal(r.c.isOn(d.name), false)
  await r.c.on({ harnesses: [d.name], groups: { [g]: 18504 } })
  assert.equal(r.c.isOn(d.name), true, 'the state file is not asked: the daemon\'s own switch')
  await r.c.off({ harnesses: [d.name] })
  assert.equal(r.c.isOn(d.name), false)
  r.c.close()
})

// P7 step 3's files at the door (the wiring): the door reads the harness's own proxy file through ctx, at the path the process's own env gives (the
// variable that moves it is fetched from the process), once per process life; an `override` file wins over the env, a `fill` file only fills; an unread
// file is said with its errno. Every descriptor with a proxy file and a macOS form, its directory left in place and moved.
test('CM20 · the door applies the harness\'s own proxy file (ctx, the process\'s env, its directory moved), once per process life', async () => {
  const FILE = 'http://file.corp:4', ENV = 'http://env.corp:1'
  for (const d of descs.filter((x) => x.proxy.files.length && x.proxyMode.forms.some((f) => f.os.includes('darwin')))) {
    const f = d.proxyMode.forms.find((x) => x.os.includes('darwin')), g = `${d.name}:${f.route}`, f0 = d.proxy.files[0]
    const text = f0.format === 'json' ? JSON.stringify(f0.keys[0].reduceRight((v, k) => ({ [k]: v }), FILE)) : `${f0.keys[0]}=${FILE}\n`
    for (const moved of f0.env ? [{}, { [f0.env]: '/moved' }] : [{}]) for (const set of [false, true]) for (const unread of [false, true]) {
      const env = { ...moved, ...(set ? { [d.proxy.env[0]]: ENV } : {}) }, file = f0.path({ home: '/h', env })
      const base = ctxOf(newWorld('darwin')), reads = []
      const readFile = (p) => { reads.push(p); if (p !== file) return base.readFile(p); if (unread) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return text }
      const { c, records } = await rig({ desc: d, w: { pid: ++pid, facts: { agent: d.name, startedAt: INSTALLED + 1 }, env, ctx: { ...base, readFile } } })
      await c.on({ harnesses: [d.name], groups: { [g]: 18101 } })
      const label = `${d.name} ${f0.applies} env=${JSON.stringify(env)} unread=${unread}`
      const ask = () => c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
      const meta = await ask()
      if (unread && (f0.applies === 'override' || !set)) {
        assert.equal(meta.upstream.kind, 'direct', label)
        assert.ok(records.some((r) => r.event === 'failure' && r.code === 'prior-proxy-unknown' && r.reason.includes('EACCES') && r.reason.includes(file)), `${label}: the record names the file and the errno (D38)`)
      } else assert.equal(meta.upstream.host, set && f0.applies === 'fill' ? 'env.corp' : 'file.corp', label)
      if (!unread) { const before = reads.filter((p) => p === file).length; await ask(); assert.equal(reads.filter((p) => p === file).length, before, `${label}: read once per process life`) }
      c.close()
    }
  }
})

test('4.8 §5.1 · ownerOfPeer (the ingress-unknown sender): the door\'s owner and facts questions give pid + name; an owner or facts that cannot be told say why', async () => {
  const r = await rig({ desc: descs[0], w: { pid: 4321, facts: { exe: '/opt/tools/bin/codex', argv: ['/opt/tools/bin/codex', 'exec'], uid: 501, startedAt: INSTALLED + 1 } } })
  assert.deepEqual(await r.c.ownerOfPeer(PEER), { pid: 4321, process: 'codex' })
  Object.assign(r.w, { pid: null, owner: { why: 'shared' } })
  assert.deepEqual(await r.c.ownerOfPeer(PEER), { pid: null, why: 'shared' })
  Object.assign(r.w, { pid: 4322, owner: {}, facts: null, factsWhy: 'ps did not answer' })
  assert.deepEqual(await r.c.ownerOfPeer(PEER), { pid: 4322, process: null, why: 'ps did not answer' })
})

// ---- 4.9 MA17 · MA18: a door's total limit, and what the row says ---------------------------------------------------------------------------------
const NEVER = new Promise(() => {})
const HANG_MS = 50
const QUESTIONS = [ // each one asked by a connection of a known agent at another harness's door, so the verdict's own cwd read is a read of its own
  ['ownerOf', (q) => q === 'ownerOf'],
  ['factsOf', (q) => q === 'factsOf'],
  ['envOf', (q) => q === 'envOf'],
  ['parentOf, second step', (q, p) => q === 'parentOf' && p === 9002],
  ['cwdOf in the verdict', (q, p, nth) => q === 'cwdOf' && p === 9001 && nth === 2],
]
async function deadlineRig({ limit = HANG_MS, on = (d, other) => [d.name, other.name], facts = (d) => ({ agent: d.name, uid: 501, startedAt: INSTALLED + 1 }), factsWhy } = {}) {
  const { d, f, os } = rootForm
  const other = descs.find((x) => x !== d && x.proxy.env.length && x.proxyMode.forms.some((y) => y.os.includes(os) && !y.hostTree && (x.proxyMode.routes[y.route] || {}).auth !== false))
  const g = `${other.name}:${other.proxyMode.forms.find((y) => y.os.includes(os) && !y.hostTree && (other.proxyMode.routes[y.route] || {}).auth !== false).route}`
  const r = await rig({ desc: { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }, others: [other], os, doorHangMs: limit, w: { pid: 9001, facts: facts(d), factsWhy, cwd: '/',
    env: { [other.proxy.env[0]]: 'http://127.0.0.1:18107' }, parent: (q) => (q === 9001 ? { ppid: 9002, startedAt: INSTALLED } : null) } }) // the door in its env: the walk goes up (P7 step 3)
  await r.c.on({ harnesses: on(d, other), groups: { [g]: 18107 } })
  return { ...r, connect: (q) => r.c.lookupIngress({ peer: PEER, user: g, target: { address: d.hosts[0], port: 443 }, ...q }) }
}
for (const [name, held] of QUESTIONS) {
  test(`MA17 · ${name} hung: the connection is forwarded at the limit, door-deadline, never decrypted, and says where it stuck`, async () => {
    const { c, w, connect } = await deadlineRig()
    w.wait = (...a) => (held(...a) ? NEVER : undefined)
    const t0 = performance.now()
    const meta = await connect()
    assert.ok(performance.now() - t0 < 1000, 'the limit, not the ask, ends the wait')
    assert.deepEqual([meta.decrypt, meta.skip.not_captured, meta.skip.reason], [false, 'untracked', 'door-deadline'])
    assert.equal(typeof meta.skip.unread, 'string'); assert.ok(meta.skip.unread.length > 0)
    c.close()
  })

  test(`MA17 · ${name} answers after the limit: this connection stays forwarded, the next is judged as ever`, async () => {
    const { c, w, connect } = await deadlineRig()
    let release
    const late = new Promise((r) => { release = r })
    w.wait = (...a) => (held(...a) ? late : undefined)
    const meta = await connect()
    const said = JSON.stringify(meta)
    w.wait = null
    release()
    await new Promise((r) => setTimeout(r, 5))
    assert.equal(JSON.stringify(meta), said, 'nothing reaches a row already answered')
    assert.equal(meta.decrypt, false)
    assert.equal((await connect()).decrypt, true, 'the limit is no verdict: nothing of it was kept')
    c.close()
  })
}

// every process the door forwards without a verdict still has its env read first (P7 step 1): a limit that stopped that read is the row's reason, not the process's class
const UNJUDGED = [
  ['a process no harness names', 'not-an-agent', { facts: () => ({ uid: 501, startedAt: INSTALLED + 1 }) }],
  ['a process whose facts failed', 'facts-unavailable', { facts: () => null, factsWhy: 'ps could not start' }],
  ['an agent whose harness is off', 'harness-off', { on: (d, other) => [other.name] }],
  ['an agent at a door whose harness is off', 'group-off', { on: (d) => [d.name] }],
]
for (const [name, reason, world] of UNJUDGED) {
  test(`MA17 · ${name}: ${reason} when its env answers, door-deadline with the question when that read hangs`, async () => {
    const answered = await deadlineRig(world)
    assert.equal((await answered.connect()).skip.reason, reason)
    answered.c.close()
    const { c, w, connect } = await deadlineRig(world) // a process's env is read once: the hang needs a process not yet read
    w.wait = (q) => (q === 'envOf' ? NEVER : undefined)
    const meta = await connect()
    assert.deepEqual([meta.decrypt, meta.skip.not_captured, meta.skip.reason], [false, 'untracked', 'door-deadline'])
    assert.equal(typeof meta.skip.unread, 'string'); assert.ok(meta.skip.unread.length > 0)
    c.close()
  })
}

for (const spent of [0.9, 1, 2]) { // of the limit, gone before the door was asked: a slow opener's time is the connection's own (D82③)
  test(`MA17 · the limit runs from the accept: ${spent} of it spent before the lookup leaves the rest of it, not a new limit`, async () => {
    const limit = 2000, { c, w, connect } = await deadlineRig({ limit })
    w.wait = (q) => (q === 'factsOf' ? NEVER : undefined)
    const t0 = performance.now()
    const meta = await connect({ acceptedAt: INSTALLED + 5 - limit * spent })
    assert.ok(performance.now() - t0 < limit / 2, 'the time left, not the whole limit')
    assert.equal(meta.skip.reason, 'door-deadline')
    c.close()
  })
}

test('MA17 · the PAC door: an owner that hangs is refused as unread; an owner proven this user\'s whose facts hang is forwarded door-deadline', async () => {
  const { c, w } = await rig({ desc: pacDesc, doorHangMs: HANG_MS, w: { pid: 77, facts: { uid: 501, startedAt: INSTALLED + 1 } } })
  await c.on({ harnesses: [pacDesc.name], groups: { [pacG]: 18108 } })
  const connect = () => c.lookupIngress({ peer: PEER, user: pacG, target: { address: 'api.example', port: 443 } })
  w.wait = (q) => (q === 'ownerOf' ? NEVER : undefined)
  const unread = await connect()
  assert.equal(unread.refuse.unread, true)
  Object.assign(w, { owner: { sameUser: true }, wait: (q) => (q === 'factsOf' ? NEVER : undefined) })
  const mine = await connect()
  assert.equal(mine.refuse, undefined)
  assert.deepEqual([mine.decrypt, mine.skip.reason], [false, 'door-deadline'])
  c.close()
})

test('MA17 · the PAC file: an owner or facts question that hangs takes the pac-owner-unread way: the door-less PAC at the limit, one record', async () => {
  for (const q of ['ownerOf', 'factsOf']) {
    const { c, w, records } = await rig({ desc: pacDesc, doorHangMs: HANG_MS, w: { pid: 77, facts: { uid: 501, startedAt: INSTALLED + 1 }, sp: { url: 'http://sys.corp:8080', bypass: [] } } })
    await c.on({ harnesses: [pacDesc.name], groups: { [pacG]: 18109 } })
    w.wait = (x) => (x === q ? NEVER : undefined)
    const res = await c.servePac({ peer: PEER, user: pacG, path: pacPath(TOKEN) })
    assert.equal(res.status, 200); assert.doesNotMatch(res.body, /18109/, 'no door')
    assert.deepEqual(records.filter((r) => r.code === 'pac-owner-unread').map((r) => r.peer), [PEER], q)
    c.close()
  }
})

test('MA17 · the PAC file: its limit runs from the accept too', async () => {
  const limit = 2000, { c, w, records } = await rig({ desc: pacDesc, doorHangMs: limit, w: { pid: 77, facts: { uid: 501, startedAt: INSTALLED + 1 } } })
  await c.on({ harnesses: [pacDesc.name], groups: { [pacG]: 18111 } })
  w.wait = (x) => (x === 'ownerOf' ? NEVER : undefined)
  const t0 = performance.now()
  await c.servePac({ peer: PEER, user: pacG, path: pacPath(TOKEN), acceptedAt: INSTALLED + 5 - limit * 0.9 })
  assert.ok(performance.now() - t0 < limit / 2, 'the time left, not the whole limit')
  assert.equal(records.filter((r) => r.code === 'pac-owner-unread').length, 1)
  c.close()
})

test('MA18 · the row carries the reader\'s own words: facts-unavailable says why the facts failed, pid-unresolved why the owner did; facts_ms is what the facts question took', async () => {
  const { d, f, os } = rootForm
  const g = `${d.name}:${f.route}`, why = 'ps could not start: EAGAIN'
  const { c, w } = await rig({ desc: { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }, os, w: { pid: 9011, facts: null, factsWhy: why, now: INSTALLED + 5, wait: (q) => { if (q === 'factsOf') w.now += 7 } } })
  await c.on({ harnesses: [d.name], groups: { [g]: 18110 } })
  const connect = () => c.lookupIngress({ peer: PEER, user: g, target: { address: d.hosts[0], port: 443 } })
  const unread = await connect()
  assert.deepEqual([unread.skip.reason, unread.skip.unread, unread.facts_ms], ['facts-unavailable', why, 7])
  Object.assign(w, { pid: null, owner: { why: 'no-row' } })
  const nobody = await connect()
  assert.deepEqual([nobody.skip.reason, nobody.skip.unread], ['pid-unresolved', 'no-row'])
  c.close()
})
