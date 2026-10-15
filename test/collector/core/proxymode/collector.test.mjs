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
import { ROOT, INSTALLED, descs, newWorld, ctxOf, worldOf, combos } from './verdict-world.mjs'

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
async function rig({ desc, os = 'darwin', custody = stub, rootPem = STUB_PEM, w = {}, opened = [], taken = new Set(), timers, ingress } = {}) {
  const records = [], ctx = { os, home: '/h', dirs: {}, join: path.posix.join, readFile: (p) => w.ctx.readFile(p), readdir: (d) => w.ctx.readdir(d), exists: (p) => w.ctx.exists(p), policy: (s) => w.ctx.policy(s) }
  w.ctx ||= ctxOf(newWorld(os))
  const c = createModelCollector({ harnesses: [desc], dir: '/nowhere', ctx, custody, rootPem, proxyOf, templates: TEMPLATES, ownUid: 501, timers, record: (r) => records.push(r),
    identify: (f) => (f.agent ? { reason: 'match', agent: f.agent } : { reason: 'no-match' }), ownerOf: async () => ({ pid: w.pid, source: 'socket-table', ms: 1 }), factsOf: async () => w.facts,
    proc: { envOf: async () => w.env ?? null, cwdOf: async () => w.cwd ?? null, parentOf: async () => null }, systemProxy: () => w.sp ?? null, hostsOf: () => w.hostSet ?? null,
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

// ---- CM23: holders ----------------------------------------------------------------------------------------------------------------------------------
test('CM23 · an idle holder keeps the door forward-only; mayExit stays false until the injected table drops it', async () => {
  const pending = []
  const timers = { setTimeout: (fn) => { pending.push(fn); return pending.length }, clearTimeout: () => {} }
  const d = descs[0], f = d.proxyMode.forms.find((x) => x.os.includes('darwin')), g = `${d.name}:${f.route}`
  const opened = []
  const { c, w } = await rig({ desc: d, timers, opened, w: { pid: 4242, facts: { agent: d.name, startedAt: INSTALLED + 1 }, env: {}, procs: [{ pid: 4242, startedAt: INSTALLED + 1 }] } })
  await c.on({ harnesses: [d.name], groups: { [g]: 18104 } })
  await c.lookupIngress({ peer: PEER, user: g, target: { address: 'api.example', port: 443 } })
  w.manifest = manifestOf(d.name, { liveness: { [d.name]: { on_at: iso(INSTALLED), off_at: iso(INSTALLED + 10) } } })
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
