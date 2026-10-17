// test/collector/core/proxymode/collector.test.mjs — the collector model's daemon half (spec 4.11 §3 ① ② ③ ⑥, P2, P7, P10, P11, P12; plan §E.6 ruling 1).
// CM22 at the door: over every descriptor form and the verdict generator's axes (verdict-world.mjs), meta.decrypt equals verdictOf. CM20 / ⑥: meta.upstream
// equals upstreamFor over env × system proxy × prior × identified, and the X-Asight-Upstream gate. CM19 / CM33: the PAC door. CM23: an idle holder keeps
// its door forward-only. CM6: no custody / no key. ① / G4: no writes; restore reuses the recorded ports; a taken port is engine-port-taken and no door.
// The world is injected (no real OS, no socket): the door half, the owner / facts readers, the process table, the timers.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createModelCollector } from '../../../../src/collector/core/proxymode/collector.mjs'
import { verdictOf } from '../../../../src/collector/core/proxymode/verdict.mjs'
import { upstreamFor } from '../../../../src/collector/core/proxymode/chain.mjs'
import { certPem } from '../../../../src/collector/core/tls/cert.mjs'
import { TEMPLATES } from '../../../../src/collector/harness/templates/index.mjs'
import { loadIngressConfig } from '../../../../src/collector/core/ingress-config.mjs'
import { emptyState, setDesired, writeStateAtomic } from '../../../../src/off/state.mjs'
import { newManifest, saveManifest } from '../../../../src/off/manifest.mjs'
import { checkRecord } from '../../../../src/health/codes.mjs'
import { custodyStub } from '../../../helpers/custody-stub.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { ROOT, INSTALLED, descs, newWorld, ctxOf, worldOf, combos, makeRoot } from './verdict-world.mjs'
import { CERT_VARS } from '../../../../src/collector/core/proxymode/upstream-trust.mjs'

const TOKEN = 'ab'.repeat(16)
const iso = (ms) => new Date(ms).toISOString()
const PEER = { address: '127.0.0.1', port: 50000 }
const proxyOf = (u) => { const x = new URL(u); return { kind: x.protocol.startsWith('socks') ? 'socks5' : 'http', host: x.hostname, port: Number(x.port) } }
const dialOf = (up, host) => (up.url == null || (up.bypass || []).some((b) => b.value === host) ? { kind: 'direct' } : proxyOf(up.url))
const stub = custodyStub(); stub.create()
const STUB_PEM = certPem(stub.rootDer)
const STUB_FP = new crypto.X509Certificate(STUB_PEM).fingerprint256
const ready = { state: () => 'ready' }
const manifestOf = (h, { on = [], liveness = {} } = {}) => ({ ...newManifest(), entries: [{ phase: 'install', harness: h, kind: 'json-key', path: '/x', installed_at: iso(INSTALLED) }, { phase: 'install', harness: null, kind: 'system-root', installed_at: iso(INSTALLED) }, ...on], liveness })

/** One collector over one harness: `w` is what the injected readers answer now (facts, env, cwd, verdict ctx, manifest, process table). */
async function rig({ desc, os = 'darwin', custody = stub, rootPem = STUB_PEM, w = {}, opened = [], taken = new Set(), timers, ingress, upstreamRoots = null, others = [] } = {}) {
  const records = [], ctx = { os, home: '/h', dirs: {}, join: path.posix.join, readFile: (p) => w.ctx.readFile(p), readdir: (d) => w.ctx.readdir(d), exists: (p) => w.ctx.exists(p), policy: (s) => w.ctx.policy(s) }
  w.ctx ||= ctxOf(newWorld(os))
  const c = createModelCollector({ harnesses: [desc, ...others], dir: '/nowhere', ctx, custody, rootPem, proxyOf, upstreamRoots, templates: TEMPLATES, ownUid: 501, timers, record: (r) => records.push(r),
    identify: (f) => (f.agent ? { reason: 'match', agent: f.agent } : { reason: 'no-match' }), ownerOf: async () => ({ pid: w.pid, source: 'socket-table', ms: 1 }), factsOf: async () => w.facts,
    proc: { envOf: async (_, names) => (w.env == null ? null : (w.asked && w.asked.push(...names), Object.fromEntries(Object.entries(w.env).filter(([k]) => names.includes(k))))), cwdOf: async () => w.cwd ?? null, parentOf: async () => null }, systemProxy: () => w.sp ?? null, hostsOf: () => w.hostSet ?? null,
    readState: () => w.state, readIngress: () => ingress || { groupPorts: {}, listenerToken: TOKEN }, readManifest: () => w.manifest || manifestOf(desc.name), procTable: async () => w.procs || [], clock: () => w.now ?? INSTALLED + 5 })
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
    const axes = [{}, { known: false }, { verified: { reason: 'not-measured' } }, { start: 'before' }, { start: 'unknown' }, { issuer: false }, { envNull: true }, { cwdNull: true },
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

test('CM20 · X-Asight-Upstream counts only from a form whose hook sends it; from anyone else it is ignored and recorded without its value', async () => {
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
test('CM19 / CM33 · the PAC door: this user\'s process gets the PAC (door leg while on, own leg after off); another uid is refused and recorded', async () => {
  const opened = []
  const { c, w, records } = await rig({ desc: pacDesc, opened, w: { pid: 77, facts: { uid: 501, startedAt: INSTALLED + 1 }, sp: { url: 'http://sys.corp:8080', bypass: [] } } })
  const { doors } = await c.on({ harnesses: [pacDesc.name], groups: { [pacG]: 18103 } })
  assert.equal(doors[pacG], 'http://127.0.0.1:18103', 'an auth:false door takes no credentials')
  assert.equal(opened[0].auth, false); assert.equal('token' in opened[0], false)
  for (const address of ['127.0.0.1', 'LocalHost', 'door.localhost', '127.0.0.2', '::1']) assert.equal(await c.lookupIngress({ peer: PEER, user: pacG, target: { address, port: 18103 } }), null, `${address}: a loop through the door (chain.mjs isLoopbackHost), not a flow`)
  const on = await c.servePac({ peer: PEER, user: pacG, path: '/asight.pac' })
  assert.equal(on.status, 200); assert.match(on.body, /PROXY 127\.0\.0\.1:18103; PROXY sys\.corp:8080/)
  w.facts = { uid: 502, startedAt: INSTALLED + 1 }
  assert.equal(await c.servePac({ peer: PEER, user: pacG, path: '/asight.pac' }), null)
  assert.equal(await c.lookupIngress({ peer: PEER, user: pacG, target: { address: 'api.example', port: 443 } }), null, 'a CONNECT from another user is refused too')
  assert.deepEqual(records.filter((r) => r.code === 'pac-peer-refused').length, 2)
  w.facts = { uid: 501, agent: pacDesc.name, startedAt: INSTALLED + 1 }
  w.manifest = manifestOf(pacDesc.name, { liveness: { [pacDesc.name]: { on_at: iso(INSTALLED), off_at: iso(INSTALLED + 10) } } })
  w.procs = [{ pid: 77, startedAt: INSTALLED + 1 }]
  await c.servePac({ peer: PEER, user: pacG, path: '/asight.pac' }) // the app took the PAC: it read the entry, a holder after off (P12)
  await c.off({ harnesses: [pacDesc.name] })
  const after = await c.servePac({ peer: PEER, user: pacG, path: '/asight.pac' })
  assert.match(after.body, /return "PROXY sys\.corp:8080"/, 'after off only the app\'s own way')
  assert.equal((await c.servePac({ peer: PEER, user: pacG, path: '/other' })).status, 404)
  c.close()
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
  for (let i = 0; i < 3 && Object.keys(c.doors()).length; i++) { await pending.shift()?.(); await new Promise((r) => setImmediate(r)) }
  assert.deepEqual(c.doors(), {}, 'the holder left: the door closes')
  assert.ok(opened.some((x) => x.closed === g))
  assert.equal(c.mayExit(), true)
  c.close()
})

// ---- CM6: the issuer over the custody -------------------------------------------------------------------------------------------------------------
const rootForm = CASES.find(({ f, os }) => f.trust === 'root' && f.verified[os] === true && !f.hostTree && !(f.forwardOnlyHosts || []).length)
for (const [what, custody, code] of [['custody unavailable', 'unavailable', 'cert-intermediate-unavailable'], ['the root key not in its custody', null, 'cert-key-missing']]) {
  test(`CM6 · ${what} → forward only, ${code}`, async () => {
    const { d, f, os } = rootForm
    let cus = custody
    if (cus === null) { cus = custodyStub(); cus.create(); cus.switches.keyLost = true }
    const g = `${d.name}:${f.route}`
    const { c, records } = await rig({ desc: { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }, os, custody: cus, w: { pid: ++pid, facts: { agent: d.name, uid: 501, startedAt: INSTALLED + 1 }, env: {}, cwd: '/' } })
    await c.on({ harnesses: [d.name], groups: { [g]: 18105 } })
    const meta = await c.lookupIngress({ peer: PEER, user: g, target: { address: d.hosts[0], port: 443 } })
    assert.equal(meta.decrypt, false)
    assert.ok(records.some((r) => r.code === code && r.pid === pid), JSON.stringify(records))
    assert.throws(() => c.issuer.secureContextFor('a.test'), /no intermediate/)
    c.close()
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
    const { c, records } = await rig({ desc: { ...d, proxyMode: { ...d.proxyMode, forms: [f] } }, os, timers, w: { pid: ++pid, facts: { agent: d.name, uid: 501, startedAt: INSTALLED + 1 }, env: {}, cwd: '/' } })
    await c.on({ harnesses: [d.name], groups: { [g]: 18106 } })
    const ask = async () => (await c.lookupIngress({ peer: PEER, user: g, target: { address: d.hosts[0], port: 443 } })).decrypt
    assert.equal(await ask(), false); assert.equal(await ask(), false)
    assert.equal(records.filter((r) => r.code === 'cert-key-missing' && r.pid === pid).length, 1, 'recorded once per pid + host')
    stub.switches.keyLost = false
    for (const fn of pending.splice(0)) await fn() // the issuer's hourly retry, once: it signs a new intermediate
    assert.equal(c.issuer.state(), 'ready')
    assert.equal(await ask(), true)
    c.close()
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
  for (let i = 0; i < 3 && Object.keys(c.doors()).length; i++) { await pending.shift()?.(); await new Promise((r) => setImmediate(r)) }
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

// ---- ① / G4: no writes; the recorded ports; a taken port ----------------------------------------------------------------------------------------
test('4.11 ① · on / off / restore / lookup write nothing: a recording fs over the real state, ingress and manifest files sees zero writes', async () => {
  const dir = tmpDir()
  const d = descs[0], f = d.proxyMode.forms.find((x) => x.os.includes('darwin')), g = `${d.name}:${f.route}`
  await loadIngressConfig({ dir, groups: [g], isFree: async () => true })
  writeStateAtomic(path.join(dir, 'state.json'), setDesired(emptyState(), [d.name], 'on'))
  saveManifest(dir, manifestOf(d.name))
  const writes = []
  const rec = new Proxy(fs, { get: (t, k) => (typeof t[k] === 'function' && /write|rename|mkdir|unlink|rm|copy|chmod|append|truncate|symlink|utimes/i.test(String(k)) ? (...a) => { writes.push(k); return t[k](...a) } : t[k]) })
  const c = createModelCollector({ harnesses: [d], dir, fs: rec, ctx: { os: 'darwin', home: '/h', dirs: {}, readFile: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) }, readdir: () => [] }, custody: 'unavailable', proxyOf,
    identify: () => ({ reason: 'match', agent: d.name }), ownerOf: async () => ({ pid: 9 }), factsOf: async () => ({ startedAt: INSTALLED + 1 }) })
  c.bindDoors({ open: async () => {}, close: async () => {} })
  const port = JSON.parse(fs.readFileSync(path.join(dir, 'ingress.json'), 'utf8')).groupPorts[g]
  assert.deepEqual(Object.keys((await c.start()).doors), [g], 'restore reopened the desired harness\'s door')
  await c.on({ harnesses: [d.name], groups: { [g]: port } })
  await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
  await c.off({ harnesses: [d.name] })
  assert.deepEqual(writes, [])
  c.close()
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
