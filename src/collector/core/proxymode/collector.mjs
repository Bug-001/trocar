// collector.mjs (core/proxymode) — the collector model's daemon half (RFC 4.11 §1 on / off, §3 ① ② ③ ⑥, P2, P7, P10, P11, P12; 4.6 §代理模式的门;
// plan §E.6 ruling 1): one OS-neutral collector the darwin / win32 daemon runs. It opens a door per entry group from `POST /on`'s
// `{ harnesses, groups: { '<h>:<route>': port } }`, judges each connection at the door — identity (door-identity.mjs, D51), the upstream per connection
// (chain.mjs P7; an unidentified process uses steps 2, 4, 5 only, ⑥), decrypt by verdict.mjs P11 keyed by pid + start — serves the PAC on the
// auth:false door (P10), keeps doors forward-only while holders live after `off` (P12), and signs leaves through the issuer over the key custody (P2).
// It never writes an agent file or ingress.json (§3 ①): ports and the token are read from ingress.json, never picked. Names no harness and no OS;
// every reader of the world is injected (0.1 §3).
import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { createDoorIdentity } from '../engine/door-identity.mjs'
import { verdictOf } from './verdict.mjs'
import { upstreamFor, isAsightDoorUrl, HOOK_ENV } from './chain.mjs'
import { pacHandler, peerAllowed } from './pac.mjs'
import { createDoorSeen, createHolderPoll, mayExit } from './holders.mjs'
import { holdersOf } from '../../../off/holders.mjs'
import { itemsOfPhase, readManifest as readManifestAt } from '../../../off/manifest.mjs'
import { readStateFile } from '../../../off/state.mjs'
import { readIngressConfig } from '../ingress-config.mjs'
import { holdersRoute } from '../control.mjs'
import { makeIssuer } from '../tls/issuer.mjs'
import { bypassHit } from '../upstream-shape.mjs'
import { CODE } from '../codes.mjs'

const msOf = (t) => (t == null ? NaN : typeof t === 'number' ? t : Date.parse(t))
const untracked = (reason) => ({ not_captured: 'untracked', reason })
const split = (g) => { const i = String(g).lastIndexOf(':'); return { harness: g.slice(0, i), routeId: g.slice(i + 1) } }
const safe = async (f) => { try { return (await f()) ?? null } catch { return null } }
const isLoop = (a) => a === '127.0.0.1' || a === 'localhost' || a === '::1'
/** Every env name a descriptor's proxy-mode data reads (trust sources, blockers, directory overrides), its proxy variables and the hook's: what
 *  `proc.envOf` is asked for — never the whole environment (4.9 §5.2). */
function envNamesOf(desc) {
  const out = new Set([...((desc.proxy && desc.proxy.env) || []), HOOK_ENV])
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (k === 'env' && typeof x === 'string' ? out.add(x) : walk(x)) }
  walk(desc.proxyMode)
  return [...out]
}

/**
 * createModelCollector({ harnesses, dir, identify, ownerOf, factsOf, proc, ctx, systemProxy, custody, rootPem, procTable, record, event, clock, timers,
 *   readState, readIngress, readManifest, proxyOf, templates, hostsOf, ownUid, ownSid, agentList, openConns, drain, pid, fs })
 *   readState / readIngress / readManifest  default: state.json, ingress.json and the install manifest in `dir`, read through `fs` — never written
 *   proc       { envOf(pid, names) → {} | null, cwdOf(pid) → text | null, parentOf(pid) → { ppid, startedAt } | null }: read once per pid + start (P7)
 *   ctx        sources.mjs's ctx for the verdict (os, home, dirs, readFile, readdir, policy, join)
 *   proxyOf    (proxy text) → { kind: 'http' | 'socks5', host, port, auth? } | null: the arch's reading of a proxy address (parseProxyText + proxyAuthOf)
 *   templates  the hook templates (harness/templates TEMPLATES): a form whose cert's template says `sendsUpstreamHeader` may send X-Asight-Upstream
 *   custody    the key custody, or 'unavailable' (no backend): then no issuer, every verdict forward-only (P2)
 * → { bindDoors, start, restore, on, off, lookupIngress, servePac, issuer, holders, mayExit, doors }
 */
export function createModelCollector({ harnesses, dir, identify, ownerOf = null, factsOf = null, proc = {}, ctx, systemProxy = () => null, custody = null, rootPem = null,
  procTable = async () => [], record = () => {}, event = () => {}, clock = Date.now, timers = globalThis, readState = null, readIngress = null, readManifest = null,
  proxyOf, templates = {}, hostsOf = () => null, ownUid = process.getuid?.() ?? null, ownSid = null, agentList = () => null, openConns = () => 0, drain = null, pid = process.pid, fs = nodeFs } = {}) {
  if (typeof proxyOf !== 'function') throw new TypeError('createModelCollector needs proxyOf: how a proxy address is dialled is the arch\'s reading')
  const byName = new Map(harnesses.map((d) => [d.name, d]))
  const readSt = readState || (() => readStateFile(path.join(dir, 'state.json'), { fs }).state)
  const readIng = readIngress || (() => readIngressConfig({ dir, fs }))
  const readMan = readManifest || (() => readManifestAt(dir, fs))
  const doors = new Map() // g → { g, harness, routeId, port, auth, url }
  const onSet = new Set()
  let bound = null, iss = null
  const ident = createDoorIdentity({ ownerOf, factsOf, identify, ownUid, hostsOf, onFailure: record, onEvent: event })
  const seen = createDoorSeen({ clock })
  const pcache = new Map(), vcache = new Map(), said = new Set()
  const rootFp256 = rootPem ? new crypto.X509Certificate(rootPem).fingerprint256 : null
  const fail = (code, reason, extra = {}) => record({ event: 'failure', where: 'engine', code, ...extra, reason })
  let man = { at: -Infinity, m: null }
  const manifest = (fresh = false) => { if (fresh || clock() - man.at > 1000) { let m = null; try { m = readMan() } catch { m = null } man = { at: clock(), m } } return man.m } // the CLI writes it; read at most once a second
  const formsOn = (desc, routeId) => desc.proxyMode.forms.filter((f) => f.os.includes(ctx.os) && (routeId == null || f.route === routeId))
  const sendsHeader = (desc, f) => { const c = (desc.proxyMode.certs || {})[f.cert]; return !!(c && c.template && templates[c.template] && templates[c.template].sendsUpstreamHeader === true) }
  const doorOf = (d) => ({ g: d.g, harness: d.harness, forms: formsOn(byName.get(d.harness), d.routeId) })
  const self = ownSid ? { sid: ownSid } : { uid: ownUid }

  /** The carrier time of a form (P11 ③): the latest install item of its harness, or the root in the user's store for a root-trust form. Unknown → null. */
  function carrierAt(desc, f) {
    const items = itemsOfPhase(manifest(), 'install')
    const own = f.cert !== 'root' && (desc.proxyMode.certs || {})[f.cert] ? items.filter((i) => i.harness === desc.name) : []
    const t = (own.length ? own : items.filter((i) => i.kind === 'system-root')).map((i) => msOf(i.installed_at)).filter(Number.isFinite)
    return t.length ? Math.max(...t) : null
  }
  const priorOf = (d) => { const e = itemsOfPhase(manifest(), 'on').find((i) => i.harness === d.harness && i.route === d.routeId && typeof i.prior_value === 'string'); return e ? e.prior_value : null }

  /** The process's env, cwd and parent walk, read once per pid + start (P7, 4.9 §5.2). */
  function procFacts(p, start, desc) {
    const names = envNamesOf(desc)
    const of = (q, s) => {
      const k = `${q}\0${s ?? ''}\0${desc.name}`
      if (!pcache.has(k)) pcache.set(k, (async () => ({ pid: q, start: s, env: await safe(() => proc.envOf && proc.envOf(q, names)), cwd: await safe(() => proc.cwdOf && proc.cwdOf(q)),
        parentOf: async () => { const up = await safe(() => proc.parentOf && proc.parentOf(q)); return up && up.ppid != null ? of(up.ppid, up.startedAt ?? null) : null } }))())
      return pcache.get(k)
    }
    return of(p, start)
  }

  /** P11 for one process at one host, judged once per pid + start + host: every form the process may be (its harness's forms on this OS; on its own
   *  harness's door, those of that route) must decrypt; the first that does not gives the code (D38, recorded once). */
  async function judge(id, d, host) {
    const k = `${id.pid}\0${id.facts.startedAt ?? ''}\0${d.g}\0${host}`
    if (vcache.has(k)) return vcache.get(k)
    const desc = byName.get(id.agent)
    const pf = await procFacts(id.pid, id.facts.startedAt ?? null, desc)
    const facts = { name: id.agent, pid: id.pid, startedAt: id.facts.startedAt ?? null, env: pf.env, cwd: pf.cwd }
    const forms = formsOn(desc, id.agent === d.harness ? d.routeId : null)
    let v = forms.length ? { decrypt: true } : { decrypt: false, code: 'not-verified', detail: `${id.agent} has no form on ${ctx.os}` }
    for (const f of forms) {
      const r = verdictOf({ desc, form: f, facts, record: { carrierInstalledAt: carrierAt(desc, f), rootFp256 }, issuer: iss ? issuer : null, host, hostSet: hostsOf(f) || undefined, ctx })
      if (!r.decrypt) { v = r; break }
    }
    if (!v.decrypt) fail(v.code, `pid ${id.pid} (${id.agent}) at ${host} is forwarded, not decrypted: ${v.detail}`, { harness: id.agent, pid: id.pid, door: d.g })
    vcache.set(k, v)
    return v
  }

  async function lookupIngress({ peer, user, target, header = null }) {
    const d = doors.get(user)
    if (!d || !target) return null
    if (isLoop(target.address) && target.port === d.port) return null // a loop through the door, not a flow
    const id = await ident.identityOf({ peer, door: doorOf(d), target })
    if (!d.auth && !peerAllowed({ ...(id.facts || {}), pid: id.pid }, self, { record }).ok) return null // the PAC door takes no credentials: this user's processes only
    const known = !id.why && byName.has(id.agent)
    if (known) seen.add({ harness: id.agent, pid: id.pid, start: id.facts.startedAt ?? null })
    const desc = byName.get(d.harness) // the upstream is the door group's (4.8 §5.3, D51⑥)
    const pf = known ? await procFacts(id.pid, id.facts.startedAt ?? null, desc) : null
    const own = known ? formsOn(byName.get(id.agent), id.agent === d.harness ? d.routeId : null) : []
    const allowed = own.length > 0 && own.every((f) => sendsHeader(byName.get(id.agent), f)) // only a form whose hook sends the header (P7 step 1)
    const ports = [...doors.values()].map((x) => x.port)
    const up = await upstreamFor({ desc, facts: pf, recordedPrior: priorOf(d), systemProxy: systemProxy(), header, headerAllowed: allowed, isAsightDoor: (v) => isAsightDoorUrl(v, { ports }) })
    if ((up.notes || []).some((n) => n.note === 'header-ignored')) fail(CODE.upstreamHeaderIgnored, `pid ${id.pid ?? '?'} sent X-Asight-Upstream at the ${d.g} door, but no hook of its form sends it: ignored (its value is not recorded)`, { door: d.g, pid: id.pid })
    if (up.code && !said.has(`${up.code}\0${id.pid}\0${d.g}`)) { said.add(`${up.code}\0${id.pid}\0${d.g}`); fail(up.code, `the proxy pid ${id.pid ?? '?'} would have used without asight could not be recovered; the door dials ${up.url ? 'the system proxy' : 'direct'}`, { door: d.g, pid: id.pid }) }
    let dial = { kind: 'direct' }
    if (up.url != null && !bypassHit(up.bypass, target.address)) {
      dial = proxyOf(up.url)
      if (!dial) throw Object.assign(new Error(`the upstream of ${d.g} is not a proxy address asight can dial`), { code: 'upstream-unavailable', why: 'upstream-unparseable' })
    }
    const base = { pid: id.pid, agent: known ? id.agent : d.harness, decrypt: false, capture: 'proxy', door: d.g, exe: id.exe, upstream: dial, pid_source: id.source, pid_ms: id.ms, negKey: id.pid != null ? String(id.pid) : d.g }
    if (!known) return { ...base, skip: untracked(id.why || 'not-an-agent') }
    if (!onSet.has(d.harness)) return { ...base, skip: untracked('group-off') } // a door kept for its holders: forward only
    if (!onSet.has(id.agent)) return { ...base, skip: untracked('harness-off') }
    return { ...base, decrypt: (await judge(id, d, String(target.address).toLowerCase())).decrypt === true }
  }

  /** GET /asight.pac on the auth:false door (P10): this user's processes only; the door leg while its harness is on, then only the app's own way. */
  async function servePac({ peer, user, path: p }) {
    const d = doors.get(user)
    if (!d || d.auth) return null
    const { pid: q } = await ident.owningPid(peer)
    const facts = q != null ? await ident.factsCached(q) : null
    if (!peerAllowed({ ...(facts || {}), pid: q }, self, { record }).ok) return null
    const m = identify(facts) || {}
    if (m.reason === 'match' && byName.has(m.agent)) seen.add({ harness: m.agent, pid: q, start: facts.startedAt ?? null }) // taking the PAC is reading the entry (P12)
    const sp = systemProxy()
    const fixed = sp && !sp.pac && sp.ok !== false && sp.url ? sp.url : null
    let res = { status: 404, headers: {}, body: '' }
    pacHandler({ state: () => ({ door: onSet.has(d.harness) ? `127.0.0.1:${d.port}` : null, ownLeg: fixed, bypass: (sp && sp.bypass) || [] }) })({ method: 'GET', url: p }, { writeHead: (status, headers) => { res = { status, headers, body: '' } }, end: (b) => { res.body = b } })
    return res
  }

  async function openDoor(g, port, token) {
    const { harness, routeId } = split(g)
    const desc = byName.get(harness), route = desc && (desc.proxyMode.routes || {})[routeId]
    if (!route) return { reason: `${g} is no route of a harness this daemon knows` }
    const auth = route.auth !== false
    const held = doors.get(g)
    if (held && held.port === port) return { door: held }
    if (held) { await bound.close([g]); doors.delete(g) }
    try { await bound.open([{ id: g, port, auth, ...(auth ? { token } : {}) }]) } catch (e) {
      const taken = e && e.code === 'EADDRINUSE'
      record({ event: 'failure', where: taken ? 'ingress' : 'engine', code: taken ? CODE.enginePortTaken : 'engine-error', door: g, reason: taken ? `the door of ${g} cannot listen on its recorded port ${port}: another socket holds it; no door, and no other port is picked (asight on picks a free one and rewrites the entry)` : `the door of ${g} could not listen on ${port}: ${(e && e.message) || e}` })
      return { reason: taken ? CODE.enginePortTaken : 'engine-error' }
    }
    const d = { g, harness, routeId, port, auth, url: auth ? `http://${encodeURIComponent(g)}:${token}@127.0.0.1:${port}` : `http://127.0.0.1:${port}` }
    doors.set(g, d)
    return { door: d }
  }
  const tokenOf = () => { const c = readIng(); if (!c || c.error || c.missing) throw Object.assign(new Error(`ingress.json is not readable (${(c && c.error) || 'missing'}): asight on writes it before it asks`), { status: 409 }); return c }

  const holdersNow = async () => holdersOf({ manifest: manifest(true), procs: await procTable(), doorSeen: seen.list(), agentList: agentList() })
  const kept = () => [...doors.values()].filter((d) => !onSet.has(d.harness))
  /** Doors of harnesses that are off: closed once no holder of theirs lives (P12); the poll stops when none is left. */
  async function settle(rows) {
    const gone = kept().filter((d) => !rows.some((r) => r.harness === d.harness)).map((d) => d.g)
    if (gone.length) { await bound.close(gone); for (const g of gone) doors.delete(g) }
    if (!kept().length) poll.stop()
  }
  const poll = createHolderPoll({ list: holdersNow, timers, onChange: (rows) => settle(rows), onError: (e) => fail(CODE.holdersUnreadable, `the process table could not be read (${(e && e.message) || e}); the doors kept for holders stay`) })

  /** The engine's { secureContextFor(host), issue(host) } over the issuer (P2): leaf + intermediate; nothing to sign with → a throw (flow.mjs steps aside). */
  const contexts = new Map()
  const issuer = {
    state: () => (iss ? iss.state() : 'unavailable'),
    issue: (host) => (iss ? iss.leafFor(host) : null),
    secureContextFor(host) {
      const c = iss && iss.leafFor(host)
      if (!c) throw new Error('no intermediate certificate to sign leaves with')
      const hit = contexts.get(host)
      if (hit && hit.cert === c.cert) return hit.ctx
      const ctx2 = tls.createSecureContext(c)
      contexts.set(host, { cert: c.cert, ctx: ctx2 })
      return ctx2
    },
  }

  return {
    bindDoors(b) { bound = b },
    issuer,
    doors: () => Object.fromEntries([...doors.values()].map((d) => [d.g, d.port])),
    async start() {
      if (!custody || custody === 'unavailable' || custody.kind === 'unavailable') fail(CODE.certIntermediateUnavailable, 'no key custody answers: no issuer, every door forwards only')
      else iss = await makeIssuer({ custody, root: rootPem, clock, timers, record })
      return this.restore()
    },
    /** At start: the harnesses desired on get their groups reopened on ingress.json's RECORDED ports, never another (§3 ①). */
    async restore() {
      let st, ing
      try { st = readSt(); ing = tokenOf() } catch (e) { return { doors: {}, problems: [String((e && e.message) || e)] } }
      const out = {}
      for (const [h, e] of Object.entries((st && st.harnesses) || {})) {
        if (!e || e.desired !== 'on' || !byName.has(h)) continue
        onSet.add(h)
        for (const [g, port] of Object.entries(ing.groupPorts || {})) if (split(g).harness === h) { const r = await openDoor(g, port, ing.listenerToken); if (r.door) out[g] = r.door.url }
      }
      return { doors: out, problems: [] }
    },
    async on({ harnesses: hs = [], groups = {} } = {}) {
      if (!bound) throw new TypeError('on: bindDoors first (the engine\'s door half)')
      const ing = tokenOf()
      for (const h of hs) if (byName.has(h)) onSet.add(h)
      const out = {}, skipped = []
      for (const [g, port] of Object.entries(groups)) { const r = await openDoor(g, port, ing.listenerToken); if (r.door) out[g] = r.door.url; else skipped.push({ g, reason: r.reason }) }
      return { doors: out, ...(skipped.length ? { skipped } : {}) }
    },
    /** off (§3 ②): the harnesses leave the on set; a door with a holder stays forward-only, the others close; the poll watches what is kept. */
    async off({ harnesses: hs = null, now = false, exit = false } = {}) {
      const ids = exit || !hs || !hs.length ? [...onSet] : hs
      for (const h of ids) onSet.delete(h)
      let rows = null
      try { rows = await holdersNow() } catch { rows = null } // unreadable: unknown, every door stays
      if (rows) await settle(rows)
      if (kept().length) poll.start()
      const relayed = drain ? await drain({ harnesses: ids, now: !!now }) : null
      return { pid, actual: onSet.size ? 'on' : 'off', confirmed: true, relayed, holders: rows ? rows.length : null }
    },
    lookupIngress,
    servePac,
    holders: holdersRoute({ holders: async () => poll.now() ?? holdersNow() }),
    mayExit: () => mayExit({ harnessesOn: [...onSet], holders: kept().length ? poll.now() : [], openConns: openConns() }),
    close() { poll.stop(); if (iss) iss.close() },
  }
}
