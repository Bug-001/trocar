// collector.mjs (core/proxymode) — the collector model's daemon half (RFC 4.11 §1 on / off, §3 ① ② ③ ⑥, P2, P7, P10, P11, P12; 4.6 §代理模式的门;
// plan §E.6 ruling 1): one OS-neutral collector the darwin / win32 daemon runs. It opens a door per entry group from `POST /on`'s
// `{ harnesses, groups: { '<h>:<route>': port } }`, judges each connection at the door — identity (door-identity.mjs, D51), the upstream per connection
// (chain.mjs P7; an unidentified process uses steps 2, 4, 5 only, ⑥; an auth:false door dials its PAC's own leg, pac.mjs pacLeg, P10), decrypt by verdict.mjs P11 keyed by pid + start — serves the PAC on the
// auth:false door (P10), keeps doors forward-only while holders live after `off` (P12), and signs leaves through the issuer over the key custody (P2).
// It never writes an agent file or ingress.json (§3 ①): ports and the token are read from ingress.json, never picked. Names no harness and no OS;
// every reader of the world is injected (0.1 §3).
import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { createDoorIdentity } from '../engine/door-identity.mjs'
import { verdictOf, judgedForms, carrierAt } from './verdict.mjs'
import { upstreamFor, isTrocarDoorUrl, isLoopbackHost, HOOK_ENV } from './chain.mjs'
import { pacHandler, pacLeg, peerAllowed } from './pac.mjs'
import { createDoorSeen, createHolderPoll, mayExit, HOLDER_POLL_MS } from './holders.mjs'
import { notCapturedClass } from '../../../health/codes.mjs'
import { holdersOf } from '../../../off/holders.mjs'
import { itemsOfPhase, readManifest as readManifestAt } from '../../../off/manifest.mjs'
import { readStateFile } from '../../../off/state.mjs'
import { readIngressConfig } from '../ingress-config.mjs'
import { holdersRoute } from '../control.mjs'
import { makeIssuer } from '../tls/issuer.mjs'
import { bypassHit } from '../upstream-shape.mjs'
import { hostSetOf } from '../host-agent.mjs'
import { CODE } from '../codes.mjs'
import { agentTrustSet, createAgentTrust, CERT_VARS } from './upstream-trust.mjs'
import { redactProxyUrl } from '../../../netenv/redact.mjs'

const untracked = (reason) => ({ not_captured: 'untracked', reason })
const split = (g) => { const i = String(g).lastIndexOf(':'); return { harness: g.slice(0, i), routeId: g.slice(i + 1) } }
const safe = async (f) => { try { return (await f()) ?? null } catch { return null } }
const ISSUER_CODES = new Set([CODE.certIntermediateUnavailable, CODE.certKeyMissing]) // verdicts on the issuer's state, which changes (P2)
const CACHE_MAX = 4096 // every per-process map is bounded, the oldest entry goes first (the arch's caches' bound)
const keep = (m, k, v) => { m.delete(k); m.set(k, v); if (m.size > CACHE_MAX) m.delete(m.keys().next().value) }
const PID_KEY = /^(\d+)(?:@(.+))?$/ // a negative-cache key of a process: "<pid>@<start>", or "<pid>" when the start time was not read
/** Every env name a descriptor's proxy-mode data reads (trust sources, blockers, directory overrides), its proxy variables, the hook's and the
 *  certificate variables the union reads (⑭, CERT_VARS): what
 *  `proc.envOf` is asked for — never the whole environment (4.9 §5.2). */
function envNamesOf(desc) {
  const out = new Set([...((desc.proxy && desc.proxy.env) || []), HOOK_ENV, ...CERT_VARS])
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (k === 'env' && typeof x === 'string' ? out.add(x) : walk(x)) }
  walk(desc.proxyMode)
  return [...out]
}

/**
 * createModelCollector({ harnesses, dir, identify, ownerOf, factsOf, proc, ctx, systemProxy, custody, rootPem, procTable, record, event, clock, timers,
 *   readState, readIngress, readManifest, proxyOf, templates, hostsOf, ownUid, ownSid, agentList, openConns, drain, pid, fs, upstreamRoots })
 *   upstreamRoots = { os: async () => PEM, node: PEM[], extra: PEM[] }: the bases the door verifies an upstream with (4.11 §3 ⑭; upstream-trust.mjs); absent → the engine's own union
 *   readState / readIngress / readManifest  default: state.json, ingress.json and the install manifest in `dir`, read through `fs` — never written
 *   proc       { envOf(pid, names) → {} | null, cwdOf(pid) → text | null, parentOf(pid) → { ppid, startedAt } | null }: read once per pid + start (P7)
 *   ctx        sources.mjs's ctx for the verdict (os, home, dirs, readFile, readdir, policy, join)
 *   proxyOf    (proxy text) → { kind: 'http' | 'socks5', host, port, auth? } | null: the arch's reading of a proxy address (parseProxyText + proxyAuthOf)
 *   templates  the hook templates (harness/templates TEMPLATES): a form whose cert's template says `sendsUpstreamHeader` may send X-Trocar-Upstream
 *   custody    the key custody, or 'unavailable' (no backend): then no issuer, every verdict forward-only (P2)
 *   forget     (negKey, pid | null) → void: the engine's entries of a key whose process exited, or whose door closed, are to go (4.8 §5.5); the daemon
 *              calls engine.forgetNegKey and records negative-cache-cleared. The keys come from `noteHeld(record)`, the engine's own failure records.
 * → { bindDoors, start, restore, on, off, lookupIngress, servePac, issuer, holders, mayExit, doors, attached }
 */
export function createModelCollector({ harnesses, dir, identify, ownerOf = null, factsOf = null, proc = {}, ctx, systemProxy = () => null, custody = null, rootPem = null,
  procTable = async () => [], record = () => {}, event = () => {}, clock = Date.now, timers = globalThis, readState = null, readIngress = null, readManifest = null,
  proxyOf, templates = {}, hostsOf = () => null, ownUid = process.getuid?.() ?? null, ownSid = null, agentList = () => null, openConns = () => 0, drain = null, pid = process.pid, fs = nodeFs, upstreamRoots = null, forget = () => {} } = {}) {
  if (typeof proxyOf !== 'function') throw new TypeError('createModelCollector needs proxyOf: how a proxy address is dialled is the arch\'s reading')
  const byName = new Map(harnesses.map((d) => [d.name, d]))
  const readSt = readState || (() => readStateFile(path.join(dir, 'state.json'), { fs }).state)
  const readIng = readIngress || (() => readIngressConfig({ dir, fs }))
  const readMan = readManifest || (() => readManifestAt(dir, fs))
  const doors = new Map() // g → { g, harness, routeId, port, auth, url }
  const onSet = new Set()
  let bound = null, iss = null
  // a hostTree form's host set (4.8 §3 OPEN 22, 4.11 ⑫): the injected reader's, else host-agent's hostSetOf over the harness's hosts, the base URLs its own
  // settings name (the descriptor's configHosts over the sources ctx: files only, never the daemon's env) and the operator's extra_hosts. Settings there but
  // unreadable leave the other two and are said once (D38) — never none, which would forward every host. Read at most once a second, like the manifest.
  const treeOf = new Map(harnesses.flatMap((d) => d.proxyMode.forms.filter((f) => f.hostTree).map((f) => [f, { d, at: -Infinity, hosts: null }])))
  const treeHosts = (f) => {
    const t = treeOf.get(f)
    if (!t || clock() - t.at <= 1000) return t ? t.hosts : null
    const errs = [], readText = (p) => { try { return ctx.readFile(p) } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e && e.code)) errs.push(`${p}: ${(e && e.code) || e}`); return null } }
    let found = []
    try { found = (t.d.configHosts && t.d.configHosts({ ...ctx, env: new Map(), readText, listDir: (p) => { try { return ctx.readdir(p) } catch { return [] } } })) || [] } catch (e) { errs.push(String((e && e.message) || e)) }
    let extra = []
    try { extra = ((readSt().harnesses || {})[t.d.name] || {}).extra_hosts || [] } catch { /* no state: no extra hosts */ }
    if (errs.length && once(`config-unreadable\0${f.id}`)) { record({ event: 'failure', where: 'harness', code: CODE.configUnreadable, harness: t.d.name, form: f.id, reason: `${f.id}'s own settings could not be read (${errs.join('; ')}); its host set is ${t.d.name}'s hosts and the extra hosts only, so a relay they name is forwarded, not decrypted` }) }
    Object.assign(t, { at: clock(), hosts: hostSetOf({ form: { hosts: { defaults: [...(t.d.hosts || []), ...(errs.length ? [] : found)] } }, extraHosts: extra }).hosts })
    return t.hosts
  }
  const hostSetFor = (f) => hostsOf(f) || treeHosts(f)
  const ident = createDoorIdentity({ ownerOf, factsOf, identify, ownUid, hostsOf: hostSetFor, onFailure: record, onEvent: event })
  const seen = createDoorSeen({ clock })
  const pcache = new Map(), vcache = new Map(), said = new Map()
  const once = (key) => { if (said.has(key)) return false; keep(said, key, true); return true } // one record per key, bounded like the caches
  const answers = new Map() // door → Map(pid → { pid, source, url_redacted }): the upstream the door chose per process, status's per-form `proxy.upstream` (1.6 §9.4)
  const answered = (g, pid, up) => { const a = answers.get(g) || new Map(); a.delete(pid); a.set(pid, { pid, source: up.source, url_redacted: up.url ? redactProxyUrl(up.url) : null }); if (a.size > 32) a.delete(a.keys().next().value); answers.set(g, a) }
  const rootFp256 = rootPem ? new crypto.X509Certificate(rootPem).fingerprint256 : null
  const agentTrust = upstreamRoots ? createAgentTrust({ roots: upstreamRoots, rootFp256, readFile: ctx.readFile }) : null
  const fail = (code, reason, extra = {}) => record({ event: 'failure', where: 'engine', code, ...extra, reason })
  // the CLI writes it; read at most once a second. A read that fails keeps the last good one and is said once per spell (D38: unreadable is not
  // "no carrier installed"); `man.err` with no good one yet keeps the verdicts it gave out of the cache (4.11 P11)
  let man = { at: -Infinity, m: null, err: null }
  const manifest = (fresh = false) => {
    if (fresh || clock() - man.at > 1000) {
      try { man = { at: clock(), m: readMan(), err: null } } catch (e) {
        if (!man.err) record({ event: 'failure', where: 'daemon', code: 'manifest-unreadable', reason: `the install manifest could not be read (${(e && e.code) || (e && e.message) || e}); ${man.m ? 'the last one read is used' : 'no carrier is known until it reads'}` })
        man = { at: clock(), m: man.m, err: e }
      }
    }
    return man.m
  }
  const formsOn = (desc, routeId) => desc.proxyMode.forms.filter((f) => f.os.includes(ctx.os) && (routeId == null || f.route === routeId))
  const sendsHeader = (desc, f) => { const c = (desc.proxyMode.certs || {})[f.cert]; return !!(c && c.template && templates[c.template] && templates[c.template].sendsUpstreamHeader === true) }
  const doorOf = (d) => ({ g: d.g, harness: d.harness, forms: formsOn(byName.get(d.harness), d.routeId) })
  const self = ownSid ? { sid: ownSid } : { uid: ownUid }

  const priorOf = (d) => { const e = itemsOfPhase(manifest(), 'on').find((i) => i.harness === d.harness && i.route === d.routeId && typeof i.prior_value === 'string'); return e ? e.prior_value : null }

  /** The process's env, cwd and parent walk, read once per pid + start when read (P7, 4.9 §5.2). An answer with env or cwd unread, or of a process
   *  whose start time is unknown (a pid alone can be reused), is asked again on a later connection, at most once a second (4.11 P7, D38). The start
   *  time goes to the readers too, so a later life of the pid is never answered for this one. Concurrent connections share the read in flight. */
  function procFacts(p, start, desc) {
    const names = envNamesOf(desc)
    const of = (q, s) => {
      const k = `${q}\0${s ?? ''}\0${desc.name}`
      const hit = pcache.get(k)
      if (hit && (hit.at == null || clock() - hit.at <= 1000)) return hit.answer
      const o = s != null ? { startedAt: s } : {}, entry = { at: null, answer: null }
      entry.answer = (async () => {
        const env = await safe(() => proc.envOf && proc.envOf(q, names, o)), cwd = await safe(() => proc.cwdOf && proc.cwdOf(q, o))
        if (s == null || env == null || cwd == null) entry.at = clock()
        return { pid: q, start: s, env, cwd, parentOf: async () => { const up = await safe(() => proc.parentOf && proc.parentOf(q, o)); return up && up.ppid != null ? of(up.ppid, up.startedAt ?? null) : null } }
      })()
      keep(pcache, k, entry)
      return entry.answer
    }
    return of(p, start)
  }

  /** P11 for one process at one host, judged once per pid + start + host: every form the process may be must decrypt; the first that does not gives
   *  the code (D38, recorded once). The forms it may be: its harness's forms on this OS (on its own harness's door, those of that route), and of
   *  those only the ones verified here when any is — D51 names a harness, not a form, and an unmeasured or out-of-scope sibling cannot be told apart
   *  by name, so it must not veto the verified ones; with none verified the answer is the first one's `not-verified`. A verdict that hangs on the
   *  issuer's state (it changes: retries, rotation, expiry; P2) is not cached, so the process decrypts once a new intermediate is signed; nor is one
   *  whose evidence was not read (`unread`, an unknown start time, no manifest read yet): the next connection judges again (D38). A code that is
   *  forwarding by design (`notCapturedClass` expected) lives in the row only; the others are said once per key and code (4.6 §连接行). */
  async function judge(id, d, host) {
    const k = `${id.pid}\0${id.facts.startedAt ?? ''}\0${d.g}\0${host}`
    if (vcache.has(k)) return noted(id, vcache.get(k))
    const desc = byName.get(id.agent)
    const pf = await procFacts(id.pid, id.facts.startedAt ?? null, desc)
    const facts = { name: id.agent, pid: id.pid, startedAt: id.facts.startedAt ?? null, env: pf.env, cwd: pf.cwd }
    const forms = judgedForms(desc, ctx.os, id.agent === d.harness ? d.routeId : null)
    let v = forms.length ? { decrypt: true } : { decrypt: false, code: 'not-verified', detail: `${id.agent} has no form on ${ctx.os}` }
    for (const f of forms) {
      const r = verdictOf({ desc, form: f, facts, record: { carrierInstalledAt: carrierAt(manifest(), desc, f), rootFp256 }, issuer: iss ? issuer : null, host, hostSet: hostSetFor(f) || undefined, ctx })
      if (!r.decrypt) { v = r; break }
    }
    if (!v.decrypt && notCapturedClass('untrusted', v.code) !== 'expected' && once(`${k}\0${v.code}`)) { fail(v.code, `pid ${id.pid} (${id.agent}) at ${host} is forwarded, not decrypted: ${v.detail}`, { harness: id.agent, pid: id.pid, door: d.g }) }
    if (v.decrypt && agentTrust) { const f0 = forms[0], t = f0.trust !== 'root' && desc.proxyMode.trusts && desc.proxyMode.trusts[f0.trust]; v = { ...v, upstreamTrust: await agentTrust.contextFor(agentTrustSet({ trust: t || null, ctx, facts })) } } // ⑭: this agent's own set, minus the trocar root
    if (!ISSUER_CODES.has(v.code) && !v.unread && id.facts.startedAt != null && !(man.err && !man.m)) keep(vcache, k, v)
    return noted(id, v)
  }
  /** The door's latest verdict per process life (pid + start), GET /status's `agents` rows (4.11 P11 status): `status` takes them, so the one rule
   *  judges. A code forwarded by design (an outside host of a host tree) says nothing of the process and is not listed. */
  const verdicts = new Map()
  function noted(id, v) {
    if (id.pid != null && (v.decrypt || notCapturedClass('untrusted', v.code) !== 'expected')) keep(verdicts, `${id.pid}\0${id.facts.startedAt ?? ''}`, { pid: id.pid, start: id.facts.startedAt ?? null, agent: id.agent, trusted: v.decrypt === true, decrypt: v.decrypt === true, reason: v.decrypt ? null : v.code }) // the driver row's shape: `decrypt` is what the netfacts' `watched` reads
    return v
  }

  async function lookupIngress({ peer, user, target, header = null }) {
    const d = doors.get(user)
    if (!d || !target) return null
    if (isLoopbackHost(target.address) && target.port === d.port) return null // a loop through the door, not a flow
    const id = await ident.identityOf({ peer, door: doorOf(d), target })
    if (!d.auth) { // the PAC door takes no credentials: this user's processes only (P10); a refusal is an answer of its own, the ingress writes its one record and closes
      const a = peerAllowed({ ...(id.facts || {}), pid: id.pid }, self)
      if (!a.ok) return { refuse: { code: a.code, reason: `trocar's proxy settings file (PAC) refused a connection: ${a.detail}${id.unresolved ? ` (owner ${id.unresolved})` : ''}; it takes no credentials, so it forwards only this user's processes` } }
    }
    const known = !id.why && byName.has(id.agent)
    if (known && onSet.has(id.agent)) seen.add({ harness: id.agent, pid: id.pid, start: id.facts.startedAt ?? null })
    const desc = byName.get(d.harness) // the upstream is the door group's (4.8 §5.3, D51⑥)
    const pf = known ? await procFacts(id.pid, id.facts.startedAt ?? null, desc) : null
    const own = known ? formsOn(byName.get(id.agent), id.agent === d.harness ? d.routeId : null) : []
    const allowed = own.length > 0 && own.every((f) => sendsHeader(byName.get(id.agent), f)) // only a form whose hook sends the header (P7 step 1)
    const ports = [...doors.values()].map((x) => x.port)
    const isTrocarDoor = (v) => isTrocarDoorUrl(v, { ports })
    const up = d.auth ? await upstreamFor({ desc, facts: pf, recordedPrior: priorOf(d), systemProxy: systemProxy(), header, headerAllowed: allowed, isTrocarDoor })
      : await pacLeg({ systemProxy: systemProxy(), header, isTrocarDoor }) // an auth:false door is a PAC's: it dials the own leg that PAC names (P10)
    if (known) answered(d.g, id.pid, up)
    if ((up.notes || []).some((n) => n.note === 'header-ignored')) fail(CODE.upstreamHeaderIgnored, `pid ${id.pid ?? '?'} sent X-Trocar-Upstream at the ${d.g} door, but no hook of its form sends it: ignored (its value is not recorded)`, { door: d.g, pid: id.pid })
    if (up.code && once(`${up.code}\0${id.pid}\0${(id.facts && id.facts.startedAt) ?? ''}\0${d.g}`)) { fail(up.code, `the proxy pid ${id.pid ?? '?'} would have used without trocar could not be recovered; the door dials ${up.url ? 'the system proxy' : 'direct'}`, { door: d.g, pid: id.pid }) }
    let dial = { kind: 'direct' }
    if (up.url != null && !bypassHit(up.bypass, target.address)) {
      dial = proxyOf(up.url)
      if (!dial) throw Object.assign(new Error(`the upstream of ${d.g} is not a proxy address trocar can dial`), { code: 'upstream-unavailable', why: 'upstream-unparseable' })
    }
    const base = { pid: id.pid, agent: known ? id.agent : d.harness, decrypt: false, capture: 'proxy', door: d.g, exe: id.exe, upstream: dial, pid_source: id.source, pid_ms: id.ms, negKey: id.pid != null ? (id.facts && id.facts.startedAt != null ? `${id.pid}@${id.facts.startedAt}` : String(id.pid)) : d.g } // per process life: a reused pid inherits nothing (4.8 §5.5)
    if (!known) return { ...base, skip: untracked(id.why || 'not-an-agent') }
    if (!onSet.has(d.harness)) return { ...base, skip: untracked('group-off') } // a door kept for its holders: forward only
    if (!onSet.has(id.agent)) return { ...base, skip: untracked('harness-off') }
    const v = await judge(id, d, String(target.address).toLowerCase())
    return { ...base, decrypt: v.decrypt === true, ...(v.upstreamTrust ? { upstreamTrust: v.upstreamTrust } : {}), ...(v.decrypt === true ? {} : { skip: { not_captured: 'untrusted', reason: v.code } }) } // P11's closed code on the row (D38)
  }

  /** GET /trocar.pac on the auth:false door (P10): the door leg for this user's processes while its harness is on; a requester whose owner could not
   *  be read, and every requester after off, gets only the app's own way — never an empty answer, which would send the app direct around the user's
   *  system proxy; another user's process is refused. */
  async function servePac({ peer, user, path: p }) {
    const d = doors.get(user)
    if (!d || d.auth) return null
    const { pid: q, why, sameUser } = await ident.owningPid(peer)
    const facts = q != null ? await ident.factsCached(q) : sameUser ? { sameUser: true } : null
    const a = peerAllowed({ ...(facts || {}), pid: q }, self), mine = a.ok
    if (!mine && facts && (facts.uid != null || facts.sid || facts.sameUser === false)) { // another user's, for certain: refused (P10)
      record({ event: 'failure', where: 'ingress', code: a.code, peer, reason: `a request for trocar's proxy settings file (PAC) was refused: ${a.detail}` })
      return null
    }
    // an owner that could not be read gets the door-less PAC (the app's own way): an empty answer would send the app direct around the system proxy
    if (!mine) record({ event: 'failure', where: 'ingress', code: CODE.pacOwnerUnread, peer, reason: `served trocar's proxy settings file (PAC) without routing through trocar: ${a.detail}${why ? ` (owner ${why})` : ''}; the app keeps its own way until it fetches the PAC again` })
    const m = (facts && identify(facts)) || {}
    if (mine && m.reason === 'match' && onSet.has(m.agent)) seen.add({ harness: m.agent, pid: q, start: facts.startedAt ?? null }) // taking the PAC is reading the entry (P12)
    const leg = await pacLeg({ systemProxy: systemProxy(), isTrocarDoor: (v) => isTrocarDoorUrl(v, { ports: [...doors.values()].map((x) => x.port) }) }) // what this door dials too
    let res = { status: 404, headers: {}, body: '' }
    pacHandler({ state: () => ({ door: mine && onSet.has(d.harness) ? `127.0.0.1:${d.port}` : null, ownLeg: leg.url, bypass: leg.bypass }) })({ method: 'GET', url: p }, { writeHead: (status, headers) => { res = { status, headers, body: '' } }, end: (b) => { res.body = b } })
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
      record({ event: 'failure', where: taken ? 'ingress' : 'engine', code: taken ? CODE.enginePortTaken : 'engine-error', door: g, reason: taken ? `trocar cannot open its local proxy port ${port} for ${g}: another socket holds it; nothing listens for ${g}, and no other port is picked (trocar on picks a free one and rewrites the entry)` : `trocar could not open its local proxy port ${port} for ${g}: ${(e && e.message) || e}` })
      return { reason: taken ? CODE.enginePortTaken : 'engine-error' }
    }
    const d = { g, harness, routeId, port, auth, url: auth ? `http://${encodeURIComponent(g)}:${token}@127.0.0.1:${port}` : `http://127.0.0.1:${port}` }
    doors.set(g, d)
    return { door: d }
  }
  const tokenOf = () => { const c = readIng(); if (!c || c.error || c.missing) throw Object.assign(new Error(`ingress.json is not readable (${(c && c.error) || 'missing'}): trocar on writes it before it asks`), { status: 409 }); return c }

  /** The off time the daemon knows (§3 ②): `off` reaches the daemon before the CLI writes the manifest's `off_at` (orchestrate's step 3 before
   *  undo), so a harness turned off here whose liveness has `on_at` and no `off_at` yet is judged with this time; once the CLI's own lands it rules. */
  const offAt = new Map()
  const withOffAt = (m) => {
    if (!m || !m.liveness || !offAt.size) return m
    const lv = Object.fromEntries(Object.entries(m.liveness).map(([h, l]) => [h, l && l.on_at != null && l.off_at == null && offAt.has(h) ? { ...l, off_at: offAt.get(h) } : l]))
    return { ...m, liveness: lv }
  }
  const holdersNow = async () => holdersOf({ manifest: withOffAt(manifest(true)), procs: await procTable(), doorSeen: seen.list(), agentList: agentList() })
  const kept = () => [...doors.values()].filter((d) => !onSet.has(d.harness))
  /** Doors of harnesses that are off: closed once no holder of theirs lives (P12); the poll stops when none is left. */
  async function settle(rows) {
    const gone = kept().filter((d) => !rows.some((r) => r.harness === d.harness)).map((d) => d.g)
    if (gone.length) { await bound.close(gone); for (const g of gone) doors.delete(g) }
    if (!kept().length) poll.stop()
  }
  const poll = createHolderPoll({ list: holdersNow, timers, onChange: (rows) => settle(rows), onError: (e) => fail(CODE.holdersUnreadable, `the process table could not be read (${(e && e.message) || e}); the doors kept for holders stay`) })

  /** The engine's negative-cache keys this daemon must clear (4.8 §5.5): each key the engine wrote a trust-rejected or negative-cache record for. Every
   *  HOLDER_POLL_MS while any is held, one read of the process table (none while nothing is held, none overlapping): a "<pid>@<start>" key whose
   *  process is gone, a "<pid>" key whose pid is gone, a group key whose door closed → `forget`. An unreadable table clears nothing (unknown). */
  const held = new Set()
  let sweepT = null, closed = false
  const arm = () => { if (held.size && !sweepT && !closed) { sweepT = timers.setTimeout(sweep, HOLDER_POLL_MS); if (sweepT && sweepT.unref) sweepT.unref() } }
  async function sweep() {
    let rows = null
    if ([...held].some((w) => PID_KEY.test(w))) { try { rows = await procTable() } catch { rows = null } }
    for (const who of [...held]) {
      const m = PID_KEY.exec(who)
      const gone = m ? Array.isArray(rows) && !rows.some((r) => String(r.pid) === m[1] && (m[2] == null || String(r.startedAt) === m[2])) : !doors.has(who)
      if (gone) { held.delete(who); forget(who, m ? Number(m[1]) : null) }
    }
    sweepT = null
    arm()
  }

  /** The engine's { secureContextFor(host), issue(host) } over the issuer (P2): leaf + intermediate; nothing to sign with → a throw (flow.mjs steps aside). */
  const contexts = new Map()
  const issuer = {
    state: () => (iss ? iss.state() : 'unavailable'),
    expires: () => (iss && iss.expires ? iss.expires() : null),
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
    /** The door's upstream per process, latest last: { '<h>:<route>': [{ pid, source, url_redacted }] } (status's per-form `proxy.upstream`). */
    upstreams: () => Object.fromEntries([...answers].filter(([g]) => doors.has(g)).map(([g, a]) => [g, [...a.values()]])),
    /** Is `h`'s path into trocar up (1.6 V32 `attached`)? Every group ingress.json records for it has its door listening; none recorded = no; unreadable = null. */
    attached(h) { const c = readIng(); if (!c || c.error) return null; const g = Object.keys((!c.missing && c.groupPorts) || {}).filter((k) => split(k).harness === h); return g.length > 0 && g.every((k) => doors.has(k)) }, // no ingress.json: nothing recorded, so no
    async start() {
      if (!custody || custody === 'unavailable' || custody.kind === 'unavailable') fail(CODE.certIntermediateUnavailable, 'no key custody answers: no issuer, every door forwards only')
      else iss = await makeIssuer({ custody, root: rootPem, clock, timers, record })
      return this.restore()
    },
    /** At start: the harnesses desired on get their groups reopened on ingress.json's RECORDED ports, never another (§3 ①). */
    async restore() {
      let st, ing
      // a state.json that cannot be read starts every harness off, and says so (4.6 §开关 proxy mode, D38): never a quiet off
      try { st = readSt() } catch (e) { record({ event: 'failure', where: 'state', code: (e && e.code) || 'state-unparsable', reason: `state.json could not be read at start (${(e && e.message) || e}); every harness starts off until trocar on` }); return { doors: {}, problems: [String((e && e.message) || e)] } }
      try { ing = tokenOf() } catch (e) { return { doors: {}, problems: [String((e && e.message) || e)] } }
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
      for (const h of hs) if (byName.has(h)) { onSet.add(h); offAt.delete(h) }
      const out = {}, skipped = []
      for (const [g, port] of Object.entries(groups)) { const r = await openDoor(g, port, ing.listenerToken); if (r.door) out[g] = r.door.url; else skipped.push({ g, reason: r.reason }) }
      return { doors: out, ...(skipped.length ? { skipped } : {}) }
    },
    /** off (§3 ②): the harnesses leave the on set; a door with a holder stays forward-only, the others close; the poll watches what is kept. */
    async off({ harnesses: hs = null, now = false, exit = false } = {}) {
      const ids = exit || !hs || !hs.length ? [...onSet] : hs
      for (const h of ids) { if (onSet.delete(h)) offAt.set(h, clock()) }
      let rows = null
      try { rows = await holdersNow() } catch { rows = null } // unreadable: unknown, every door stays
      if (rows) await settle(rows)
      if (kept().length) poll.start(rows) // this off's own table: never the last watch's answer
      const relayed = drain ? await drain({ harnesses: ids, now: !!now }) : null
      return { pid, actual: onSet.size ? 'on' : 'off', confirmed: true, relayed, holders: rows ? rows.length : null }
    },
    lookupIngress,
    servePac,
    /** Is `h` on in this daemon? The one switch both decryption (lookupIngress) and recording (the engine's isRecording) read (4.6 §开关). */
    isOn: (h) => onSet.has(h),
    /** An engine failure record: a trust-rejected / negative-cache one names a key to clear when its process or door is gone (4.8 §5.5). */
    noteHeld(rec) { if (rec && (rec.code === 'trust-rejected' || rec.code === 'negative-cache') && rec.neg_key != null) { held.add(String(rec.neg_key)); arm() } },
    holders: holdersRoute({ holders: async () => poll.now() ?? holdersNow() }),
    /** The holder count the poll last saw, or null when nothing is watched: GET /status's number, which never reads the process table itself
     *  (on Windows that is a PowerShell each; `on` asks /status twice before POST /on, a Windows test machine 2026-10-17). GET /holders is the fresh answer. */
    polledHolders: () => { const r = poll.now(); return Array.isArray(r) ? r.length : null },
    /** The door's verdicts, latest last (bounded; from memory, never the process table: a row may name a process that has exited since). */
    verdicts: () => [...verdicts.values()],
    mayExit: () => mayExit({ harnessesOn: [...onSet], holders: kept().length ? poll.now() : [], openConns: openConns() }),
    close() { closed = true; if (sweepT) timers.clearTimeout(sweepT); sweepT = null; poll.stop(); if (iss) iss.close() },
  }
}
