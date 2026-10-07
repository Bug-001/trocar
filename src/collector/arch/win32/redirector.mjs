// redirector.mjs — the Windows implementation of the Redirector contract (RFC 4.8 §1; core/redirector.mjs says what core asks of an arch adapter). Windows has no kernel that steers connections to the engine
// and no event for "a process started", so what the Linux adapter gets from the kernel this one has from three places: the process snapshot (`procinfo.mjs`: `exec` / `exit` by difference, `facts-update` when a
// command line arrives late), the form tables of the harness files (`forms.mjs`: which form a process is), and the verdicts the tracker pushes through `watch(pid, { decrypt })` (the table 4.8 §5.4 judges by).
// This file is the first part: the process table. It reads the helper's answers through the watcher it is given and writes nothing; it names no harness (arch/ never imports harness/: the daemon hands the groups in).
//
// The table holds EVERY process of this session, not only the agents': a form with no process rule in the kernel (a program that is every Node program of the machine) takes every connection of its port, and the
// connection's owner may be any process (4.8 §3.5), so who owns it can only be told against all of them. What the table says about each is the answer of `matchForm`:
//   { kind: 'form', id }                 a process of that form · { kind: 'pending', forms }   its command line is not known yet (the watcher says again, `facts-update`) · { kind: 'path-unknown', forms, shape } · { kind: 'none' }
import { EventEmitter } from 'node:events'
import { HELPER_PROTO } from './helper.mjs'
import { matchForm } from './forms.mjs'
import { bypassHit } from './upstream.mjs'
import { buildForwarderConfig, processRulesOf } from '../../../netenv/mihomo/rules.mjs'

const FORM_USER = /^of\.(.+)$/ // the name the kernel's outbound to the engine authenticates as (4.8 §3.1): `of.<form id>`
const untracked = (reason) => ({ not_captured: 'untracked', reason }) // the row's code for a connection whose process is not one the table can vouch for (what the tracker says for a pid it does not hold)
const msgOf = (e) => String((e && e.message) || e)

/** The login a proxy reference names, for one use: the connection the ingress dials through the proxy, or the kernel's own outbound to it. Not readable is an error with no login in it. */
function loginOf(g, up, authOf) {
  const auth = authOf(up.auth_ref)
  if (!auth) throw Object.assign(new Error(`the login of the upstream proxy of ${g} (${up.auth_ref}) cannot be read, so nothing can be dialled through that proxy`), { why: 'upstream-credentials-unavailable' })
  return { username: auth.username, password: auth.password }
}

/** A form as the kernel's config takes it: its process rules (the path patterns, and the image name when the data says the name is the form's alone; none for a form that takes every connection of its port) and, for a form of a host tree,
 *  the hosts whose connections are handed to the engine (4.8 §3.5). A host-tree form with no host would hand the engine every connection of the program: that is refused, not written. */
function kernelForm(f, hostsOf) {
  const rules = f.processRules === false ? [] : processRulesOf({ pathPatterns: f.match.path || [], names: f.nameRule ? [f.match.image] : [] })
  if (!f.hosts) return { f: f.id, rules }
  const hosts = hostsOf(f)
  if (!Array.isArray(hosts) || hosts.length === 0) throw new TypeError(`${f.id} is a form of a host tree and has no host to hand to the engine; without them every connection of the program would be handed over (4.8 §3.5): hostsOf(form) gives the set`)
  return { f: f.id, rules, hosts }
}

/**
 * kernelGroupsOf({ groups, routes, groupPorts, authOf, hostsOf, skipped }) → the `groups` of `buildForwarderConfig` (rules.mjs, 4.8 §3.1): `[{ g, port, on, upstream, bypass, auth, forms: [{ f, rules, hosts? }] }]`.
 * `groups` is `groupsOf(descriptors)`, `routes` planRoutes' result, `groupPorts` ingress.json's. A group is in the kernel when the plan has an answer for it, it has a port, it has a form that can be carried (`supported`) and there is an upstream to
 * forward to — a group with none has no hop to forward an agent that outlives `off` to, and sending it direct would go round the proxy the user's agent needs; and not when its entry takes no login (`auth: false`) while its upstream
 * needs one (a port any process could use must not carry the user's login, 4.8 §3.2). `on` is the plan's. The login of a credentialed upstream is resolved here, by `authOf`, into the config: the one place besides the manifest it is written.
 * `skipped` (an array, optional): every group the plan has an answer for and the kernel does not carry is pushed as `{ g, reason }` (`no-upstream` · `no-port` · `no-supported-form` · `login-on-open-port`), so that a group left out is said by whoever
 * asked (`attach()`), never silently.
 */
export function kernelGroupsOf({ groups, routes, groupPorts, authOf = () => null, hostsOf = () => null, skipped = [] } = {}) {
  const out = []
  for (const { g, group, forms } of groups) {
    const r = routes && routes[g]
    const port = groupPorts && groupPorts[g]
    const carried = forms.filter((f) => f.supported === true && f.match)
    if (!r) continue // the plan has no answer yet: nothing to carry and nothing to say
    const why = !r.upstream ? 'no-upstream' : !Number.isInteger(port) ? 'no-port' : carried.length === 0 ? 'no-supported-form' : group.auth === false && r.upstream.credentialed ? 'login-on-open-port' : null
    if (why) { skipped.push({ g, reason: why }); continue }
    const up = r.upstream
    const upstream = up.kind === 'direct' ? 'direct' : { type: up.kind, host: up.host, port: up.port, ...(up.credentialed ? loginOf(g, up, authOf) : {}) }
    out.push({ g, port, on: r.on === true, upstream, bypass: r.bypass || [], auth: group.auth !== false, forms: carried.map((f) => kernelForm(f, hostsOf)) })
  }
  return out
}

/** What a kernel that did not do what was asked says, as a code from 4.8 §12 and a reason: the forwarder's own record when it could not start (it has written the failure already), a configuration the kernel refused, or a read-back
 *  that is not the one asked for (a form selecting the re-entry is `fallback-active`; anything else it did not say plainly is not on either). */
function refusalOf(r) {
  if (r.code) return { code: r.code, reason: r.reason || r.code }
  if (r.error) return { code: 'forwarder-start-failed', reason: `the kernel refused the new configuration (status ${r.error.status})` }
  const forms = r.readBack && r.readBack.forms ? r.readBack.forms : {}
  const bad = Object.entries(forms).filter(([, v]) => v && v.state !== 'on' && v.state !== 'off')
  const names = bad.map(([f, v]) => `${f} (${v.state})`).join(', ') || 'the forms'
  if (bad.some(([, v]) => v.state === 'fallback')) return { code: 'fallback-active', reason: `the kernel selects its re-entry, not the engine, for ${names}: the engine is not reachable from it` }
  return { code: 'forwarder-start-failed', reason: `the kernel did not read back ${names} as asked` }
}

/**
 * createWin32Redirector({ helper, procWatcher, groups, home, ownerOf, routes, ingress, authOf, onFailure, forwarder, entries, gate, ownImages, hostsOf }) → the Redirector (an EventEmitter)
 *   helper       the started helper client (helper.mjs `startHelper`): its `ready` line and `pid` answer `start()` / `helperInfo()`, and `close()` closes it
 *   procWatcher  `createProcWatcher()`: the redirector subscribes to its events in this call, so none is lost between the two
 *   groups       `groupsOf(descriptors)` (route-plan.mjs): `[{ g, harness, group, forms, proxy }]`, the harness files' Windows data
 *   home         the user's profile directory (`%USERPROFILE%`): `form-path-unknown` masks the user's name wherever the profile is (forms.mjs `formPathShape`)
 *   ownerOf      `({ hop: { port }, candidates: [pid], known: [pid] }) → { pid, source, ms }` (socktable.mjs `ownerOf`, bound to the helper by the daemon): which of the candidates holds the connection to the hop, none when a process
 *                the table has no row for holds one too (`known` = the whole table); none given = no pid completion, every connection is judged by its form
 *   routes       `() → planRoutes' result` ({ [group id]: { on, upstream, bypass, … } }): what the plan says NOW; the daemon re-plans when the system proxy or `desired` changes, so it is read at every lookup
 *   ingress      `() → loadIngressConfig's result` (`{ enginePort, groupPorts, ingressToken, listenerToken }`)
 *   authOf       `(auth_ref) → { username, password } | null`: the login a reference names (`prior:<group>`, `hkcu-env:<NAME>`); only this call turns a reference into a login, and only for one connection that is dialled through the proxy
 *   onFailure    the failure sink (the daemon's recorder): a record shaped `{ event: 'failure', where, code, reason }`
 *   forwarder    `createForwarder()` (forwarder.mjs): `reload({ build, forms })` → `{ ok, readBack, code?, reason? }`, `check()`, `state()`; the kernel's process, config and read-back are its
 *   entries      the proxy entries of the agents, which only this file's order decides WHEN: `write(groups)` / `undo(groups)` → `[{ g, ok, reason? }]`, `check(groups)` → the same; a group is `{ g, harness, entry }` (`entry`: 'auto' or 'opt-in' for a group
 *                that is on, which is what `write` gets; null in the `undo` and `check` lists of a group the plan has off)
 *   gate         `({ g, harness, entry }) → { ok: true } | { ok: false, reason }`, required by `attach()` (a TypeError without it): asked for each group about to be written; a group it refuses is not handed to `entries.write` and is that group's
 *                `{ g, ok: false, gated: true, reason }` in `entries.written`; one that throws is a refusal. Codex's and Hermes's proxy lines join a block the trust entry wrote and may not be written before 4.8 W19's four conditions hold (plan Task 8): the wiring
 *                (daemon.mjs, the one place that knows the harnesses and what the journal can do) says so here, and `entries` is a writer that does not have to know it
 *   ownImages    asight's own images (the engine's node.exe, the kernel's exe), for the loop check of the config (rules.mjs: required, `undefined` is a TypeError) · hostsOf  `(form) → [host]`: the host set of a host-tree form (route-plan.mjs `hostSetOf`)
 * Events: 'exec' ProcFacts · 'exit' {pid, startedAt} · 'facts-update' ProcFacts (a command line that was not known yet is, or was given up on) · 'facts-error' (a process whose image cannot be read) — the watcher's, passed on after
 *   the table has taken them in, so a listener that asks the table finds the process there · 'helper-error' {reason, code, …} (the watcher's `poll-error`: the helper failed, or a listener threw) ·
 *   'form-exit' {form, neg_key} (the last process of a form is gone: the engine forgets that form's negative-cache entries, 4.8 §5.5).
 */
export function createWin32Redirector({ helper, procWatcher, groups, home = null, ownerOf = null, routes = () => ({}), ingress = () => ({}), authOf = () => null, onFailure = () => {}, forwarder = null, entries = null, gate = null, ownImages, hostsOf = () => null } = {}) {
  if (!procWatcher || typeof procWatcher.on !== 'function') throw new TypeError('createWin32Redirector needs the process watcher (procinfo.mjs createProcWatcher)')
  if (!Array.isArray(groups)) throw new TypeError('createWin32Redirector needs the groups (route-plan.mjs groupsOf)')
  const ev = new EventEmitter()
  const forms = groups.flatMap((x) => x.forms) // in the order the harness files list them: matchForm tries a shared image's forms in that order
  const procs = new Map() // pid → { exe, ppid, startedAt, elevated, match, seq }
  const verdicts = new Map() // pid → { decrypt, agent }: what the tracker judged (4.8 §5.4); a process it has not judged has none, which is "not trusted"
  const byForm = new Map(groups.flatMap((x) => x.forms.map((f) => [f.id, { form: f, g: x.g, harness: x.harness }])))
  const harnessOf = new Map(groups.map((x) => [x.g, x.harness]))
  let seq = 0
  let info = { pid: null, proto: null, build: null }

  function ingest(facts) {
    const match = matchForm(forms, { exe: facts.exe, cmdline: facts.cmdline, cmdlineState: facts.cmdlineState }, { home })
    procs.set(facts.pid, { exe: facts.exe ?? null, ppid: facts.ppid ?? null, startedAt: facts.startedAt ?? null, elevated: facts.elevated ?? null, match, seq: ++seq })
  }
  const pidsOf = (form) => [...procs].filter(([, p]) => p.match.kind === 'form' && p.match.id === form).map(([pid]) => pid)
  /** The processes a connection under `of.<form>` can be from: the form's own, and the ones whose command line is not known yet and may be (the watcher says again when it is). */
  const maybeOf = (form) => [...procs].filter(([, p]) => (p.match.kind === 'form' && p.match.id === form) || (p.match.kind === 'pending' && p.match.forms.includes(form))).map(([pid]) => pid)
  /** The processes a connection to a form with no process rule can be from: every process of the session but the ones of the group's other forms, which their own process rules hand to those forms (dsh's Desktop shares dsh CLI's port, and its
   *  connection held open must not make the CLI's own unfindable). A process of a form of ANOTHER group stays: nothing hands it to its form here, and it is judged for what it is (`not-a-process-of-form`). */
  function takenBy({ form, g }) {
    const elsewhere = ([, p]) => p.match.kind === 'form' && p.match.id !== form.id && byForm.get(p.match.id).g === g
    return [...procs].filter((e) => !elsewhere(e)).map(([pid]) => pid)
  }
  /** Forgets a process and its verdict; says `form-exit` when it was the last process of its form (after any `exit` the caller passes on, so a listener of both sees the process leave first). */
  function drop(pid, { then = () => {} } = {}) {
    const p = procs.get(pid)
    procs.delete(pid)
    verdicts.delete(pid)
    then()
    if (p && p.match.kind === 'form' && pidsOf(p.match.id).length === 0) ev.emit('form-exit', { form: p.match.id, neg_key: `of.${p.match.id}` })
  }

  procWatcher.on('exec', (facts) => { ingest(facts); ev.emit('exec', facts) })
  procWatcher.on('facts-update', (facts) => { ingest(facts); ev.emit('facts-update', facts) })
  procWatcher.on('exit', (x) => drop(x.pid, { then: () => ev.emit('exit', x) }))
  procWatcher.on('facts-error', (x) => ev.emit('facts-error', x))
  procWatcher.on('poll-error', (x) => ev.emit('helper-error', { ...x, code: x.cause ?? x.code ?? 'helper-error' }))

  /** The group's upstream for one connection: the hop the agent would have used without asight, with its login resolved (4.8 §2.2, §5.2). A target the group's bypass table hits goes direct, as the agent's did. */
  function upstreamFor(g, route, host) {
    if (bypassHit(route.bypass, host)) return { kind: 'direct' }
    const up = route.upstream
    if (!up || typeof up.kind !== 'string') throw Object.assign(new Error(`the group ${g} is on but has no upstream to dial`), { why: 'no-upstream' })
    if (up.kind === 'direct') return { kind: 'direct' }
    const out = { kind: up.kind, host: up.host, port: up.port }
    if (up.credentialed) out.auth = loginOf(g, up, authOf)
    return out
  }

  /** Which process owns the connection that reached the group's port, best effort and never wrong (4.8 §5.3): one of `candidates`, or nobody. A form with a process rule in the kernel gets only its own processes there; a form with none takes
   *  every connection of its port, so it is asked against every process but the other forms' of its group. The table lags the real world by a poll, so a process that started a moment ago has no row here: `known` is every process the table
   *  has, and the owner is answered only when no process outside it holds a connection to the port (socktable.mjs). A socket table that cannot be asked never costs the connection: it is no pid, and the failure is recorded. */
  async function owningPid(candidates, port) {
    const none = { pid: null, source: null, ms: null }
    if (!ownerOf || !Number.isInteger(port) || candidates.length === 0) return none
    try {
      const r = await ownerOf({ hop: { port }, candidates, known: [...procs.keys()] })
      return { pid: r && r.pid != null ? r.pid : null, source: (r && r.source) || null, ms: r && r.ms != null ? r.ms : null }
    } catch (e) {
      onFailure({ event: 'failure', where: 'helper', code: 'socktable-unavailable', reason: `the owner of a connection could not be asked for (${msgOf(e)}); the connection is judged by its form` })
      return none
    }
  }

  /** Whether the connection is decrypted (4.8 §5.4), and the code its row carries when it is not and the tracker cannot say it by pid. */
  function judge(form, pid, candidates) {
    const trusted = (p) => { const v = verdicts.get(p); return !!v && v.decrypt === true }
    if (form.processRules === false) { // the form's port is every process's: only a process that is positively this form's, and trusted, is decrypted
      if (pid == null) return { decrypt: false, skip: untracked('pid-unresolved') }
      const p = procs.get(pid)
      if (!p || p.match.kind !== 'form' || p.match.id !== form.id) return { decrypt: false, skip: untracked('not-a-process-of-form') }
      return { decrypt: trusted(pid) }
    }
    if (pid != null) return { decrypt: trusted(pid) } // the tracker holds this pid's row and its reason
    if (candidates.length === 0) return { decrypt: false, skip: untracked('no-process-of-form') }
    // no pid: the connection is some process of the form's. Decrypting it when one of them does not trust asight's CA would break that process (D31), so only when all of them are trusted
    return candidates.every(trusted) ? { decrypt: true } : { decrypt: false, skip: { not_captured: 'untrusted', reason: 'pid-unresolved-mixed' } }
  }

  /** The kernel's side of the plan as it is now: the groups it carries, and which of their forms are on. */
  function kernelPlan() {
    const ing = ingress() || {}
    const skipped = []
    const planned = kernelGroupsOf({ groups, routes: routes() || {}, groupPorts: ing.groupPorts, authOf, hostsOf, skipped })
    return { ing, groups: planned, skipped, forms: planned.flatMap((x) => x.forms.map((f) => ({ f: f.f, on: x.on }))) }
  }
  const configOf = (planned, ing, controller) => buildForwarderConfig({ groups: planned, enginePort: ing.enginePort, token: ing.ingressToken, listenerToken: ing.listenerToken, controller, ownImages })
  const entryOf = (g) => ({ g, harness: harnessOf.get(g), entry: ((routes() || {})[g] || {}).entry ?? null })

  return Object.assign(ev, {
    /** What the proxy ingress asks for each connection a client hands over on purpose (4.8 §5.2, core/redirector.mjs): `user` is `of.<form>` (the ingress has checked the token already), `target` what it asked to reach.
     *  → the flow's meta; `{ health: true, group }` for the group's own re-entry point (the kernel's probe: the ingress answers it, nothing is dialled or recorded); null for a user it does not know, or a group that is not on
     *  (the ingress then answers it as an authentication failure, and the kernel's fallback group, which does not get the probe through, keeps the re-entry: the way to the upstream that needs no engine).
     *  The meta: `pid` (or null) · `agent` the harness · `decrypt` · `capture: 'proxy'` · `form` · `exe` · `upstream` (`{kind:'direct'}`, or the group's with its login: the ingress uses it for this one connection and keeps only whether there was
     *  one) · `pid_source` · `pid_ms` · `negKey` (the pid, or `of.<form>` when there is none: forms must not poison one another's negative cache, 4.8 §5.5) · `skip`, only when it is not decrypted and the tracker has no row to say why: the code
     *  the row carries (`untrusted` + `pid-unresolved-mixed`, or `untracked`). Rejects, with a `why` (`no-upstream`, `upstream-credentials-unavailable`) and no login in the message, when the upstream cannot be dialled: the ingress then writes the engine's own `loader-down` failure with the message and answers 502. */
    async lookupIngress({ user, target }) {
      const m = FORM_USER.exec(typeof user === 'string' ? user : '')
      const hit = m ? byForm.get(m[1]) : null
      const route = hit && (routes() || {})[hit.g]
      if (!route || route.on !== true || !target) return null
      const port = ((ingress() || {}).groupPorts || {})[hit.g]
      if (Number.isInteger(port) && target.address === '127.0.0.1' && target.port === port) return { health: true, group: hit.form.id }
      const upstream = upstreamFor(hit.g, route, target.address) // before the table is asked: a connection that cannot be dialled should not wait on it
      const candidates = hit.form.processRules !== false ? maybeOf(hit.form.id) : takenBy(hit)
      const { pid, source, ms } = await owningPid(candidates, port)
      const { decrypt, skip } = judge(hit.form, pid, candidates)
      return {
        pid, agent: hit.harness, decrypt, capture: 'proxy', form: hit.form.id, exe: pid != null && procs.has(pid) ? procs.get(pid).exe : null,
        upstream, pid_source: source, pid_ms: ms, negKey: pid != null ? String(pid) : `of.${hit.form.id}`, ...(skip ? { skip } : {}),
      }
    },

    /** `on`: the kernel gets the whole config for the plan as it is now (the groups that are on with the engine outbound and a fallback group per form, the others forward only) and the read-back says whether each form is on; ONLY THEN are the
     *  proxy entries of the groups that are on written, and the entries of the groups the plan says are off undone (the entry is the pointing itself: written before the kernel is on, an agent would point at a port with nothing behind it, 4.8 §2.1).
     *  A kernel that cannot start or does not read back as asked: rejects with its code (`forwarder-start-failed` · `forwarder-binary-missing` · `forwarder-digest-mismatch` · `fallback-active`) and `readBack`, and not one entry was
     *  written or undone. A crash between the read-back and the entries is `on` again: the same reload, the same entries (the writer is idempotent). Resolves `{ ok, kernel, entries: { written, undone, skipped } }`; an entry that could not be written is
     *  that group's `{ ok: false, reason }`, not an exception: the kernel and the other groups stand. A group the plan has no answer for is neither written nor undone: a plan that is not there yet must not take entries away; a group the plan has ON that the kernel does not carry (no port, no form it can carry, no
     *  upstream, a login on a port that takes none) is not written either, and is said: `entries.skipped: [{ g, reason }]` and `ok: false`. */
    async attach() {
      if (!forwarder || !entries) throw new TypeError('attach needs the forwarder and the entries')
      if (typeof gate !== 'function') throw new TypeError('attach needs the gate: which groups may have their proxy entry written is the wiring\'s to say, and not saying is not "all of them" (a proxy line that joins a block the trust entry wrote may not be written before the W19 conditions of 4.8 hold)')
      const plan = kernelPlan()
      const table = routes() || {}
      let kernel = null
      if (plan.groups.length > 0) {
        kernel = await forwarder.reload({ build: (controller) => configOf(plan.groups, plan.ing, controller), forms: plan.forms })
        if (!kernel.ok) { const why = refusalOf(kernel); throw Object.assign(new Error(`${why.reason}; no proxy entry was written`), { code: why.code, readBack: kernel.readBack ?? null }) }
      }
      const open = []
      const refused = []
      for (const e of plan.groups.filter((x) => x.on).map((x) => entryOf(x.g))) {
        let v
        try { v = await gate(e) } catch (err) { v = { ok: false, reason: `the gate could not say: ${msgOf(err)}` } }
        if (v && v.ok === true) open.push(e)
        else refused.push({ g: e.g, ok: false, gated: true, reason: (v && v.reason) || 'the gate did not allow it' })
      }
      const off = groups.filter((x) => table[x.g] && table[x.g].on !== true).map((x) => entryOf(x.g))
      const written = [...(open.length ? (await entries.write(open)) || [] : []), ...refused]
      const undone = off.length ? (await entries.undo(off)) || [] : []
      const left = plan.skipped.filter((x) => (table[x.g] || {}).on === true) // the plan says on, nothing carries it: not written, not undone, and said (D38)
      return { ok: [...written, ...undone].every((x) => x.ok !== false) && left.length === 0, kernel, entries: { written, undone, skipped: left } }
    },
    /** `off`, the other way (4.8 §4.1): the kernel switched to forward only and read back, THEN every group's proxy entry undone — the planned or not, the writer undoes only what asight wrote. A kernel that is not running is left alone (nothing
     *  can point at it); one that cannot be switched, or a plan that cannot be built, does not keep the entries: they are undone anyway and then this rejects with the kernel's code (`off` always undoes by hand, 4.3). */
    async detach() {
      if (!forwarder || !entries) throw new TypeError('detach needs the forwarder and the entries')
      let kernel = null
      let refusal = null
      try {
        const plan = kernelPlan()
        if (plan.groups.length > 0 && forwarder.state().phase !== 'stopped') {
          const forward = plan.groups.map((x) => ({ ...x, on: false }))
          kernel = await forwarder.reload({ build: (controller) => configOf(forward, plan.ing, controller), forms: plan.forms.map((f) => ({ f: f.f, on: false })) })
          if (!kernel.ok) refusal = { ...refusalOf(kernel), readBack: kernel.readBack ?? null }
        }
      } catch (e) { refusal = { code: e && e.code, reason: msgOf(e), error: e } }
      const undone = (await entries.undo(groups.map((x) => entryOf(x.g)))) || []
      if (refusal) throw Object.assign(new Error(`${refusal.reason}; the proxy entries were undone anyway`), { code: refusal.code, readBack: refusal.readBack ?? null, entries: undone })
      return { ok: undone.every((x) => x.ok !== false), kernel, entries: { undone } }
    },
    /** What the kernel says now (forwarder.check(): each form read back) and the entries' own check: expected against actual (4.6 §开关语义). `attached` is the kernel's: some form reads back on and the read-back is the one asked for. */
    async status() {
      if (!forwarder) throw new TypeError('status needs the forwarder')
      const kernel = await forwarder.check()
      const live = Object.entries((kernel && kernel.forms) || {}).filter(([, v]) => v && v.state === 'on').map(([f]) => f)
      const table = routes() || {}
      const should = groups.filter((x) => table[x.g] && table[x.g].on === true).map((x) => entryOf(x.g))
      return { attached: !!kernel && kernel.ok === true && live.length > 0, links: live.map((name) => ({ name })), hb_age_ms: null, drops: null, kernel, forwarder: forwarder.state(), entries: entries && typeof entries.check === 'function' ? await entries.check(should) : null }
    },
    /** How many of the process's established connections do not go to a group's listener on loopback — what `status` shows as "still going direct" (4.6 §开关语义); async here, the table is read through the helper.
     *  `{ count, error }`: a table that cannot be read is `count: null` and why, never 0. */
    async directCount(pid) {
      if (!helper || typeof helper.call !== 'function') return { count: null, error: 'no-helper' }
      const ports = new Set(Object.values((ingress() || {}).groupPorts || {}))
      try {
        const t = await helper.call('tcp-table', { pids: [pid], states: ['established'] }, { timeoutMs: 2000 })
        if (!t || !Array.isArray(t.rows)) return { count: null, error: 'no-rows' }
        const toAsight = (row) => (row.remoteAddr === '127.0.0.1' || row.remoteAddr === '::1') && ports.has(row.remotePort)
        return { count: t.rows.filter((row) => row.pid === pid && row.state === 'established' && !toAsight(row)).length, error: null }
      } catch (e) { return { count: null, error: (e && e.code) || msgOf(e) } }
    },

    /** The daemon's `redirector.configure(enginePort)` (core/redirector.mjs): the port the engine listens on. The kernel's config gets it from `ingress()` (ingress.json: `enginePort`, which the daemon listens on), so there is nothing to tell the
     *  kernel here; accepted so that the daemon's call is not a TypeError at the first `on`. */
    async configure() {},
    /** Waits for the helper's ready line (its protocol, its PowerShell), then takes the process baseline. Rejects when the helper never starts: that failure is already recorded by the helper's own sink. */
    async start() {
      const ready = helper && helper.ready ? await helper.ready : null
      info = { pid: (helper && helper.pid) ?? (ready && ready.pid) ?? null, proto: ready ? ready.proto ?? null : null, build: ready ? ready.ps ?? null : null }
      await procWatcher.start()
      return info
    },
    /** Stops the watcher and closes the helper (the daemon's stop). Nothing is steered on Windows, so there is nothing to leave direct: closing the helper is all of it. */
    async close() {
      procWatcher.stop()
      if (helper && typeof helper.close === 'function') await helper.close()
    },
    heartbeat() {}, // nothing is gated on a heartbeat: when the engine is gone the kernel falls back on its own health check (4.8 §3.3)
    helperInfo: () => ({ ...info }),
    expectedProto: HELPER_PROTO,

    /** The live processes of this session as facts; the table is taken from them: a process that was in it, is not in the scan, and was not seen after the scan began has gone (a process that started after the
     *  scan's own snapshot is an `exec` and stays). */
    async scan() {
      const begun = seq
      const live = await procWatcher.scan()
      const seen = new Set()
      for (const f of live) { seen.add(f.pid); ingest(f) }
      for (const [pid, p] of [...procs]) if (!seen.has(pid) && p.seq <= begun) drop(pid)
      return live
    },
    unreadable: () => procWatcher.unreadable(),

    /** The tracker's verdict for a process (4.8 §5.4: the decrypt table): `decrypt` true only for one it confirmed trusts asight's CA. */
    watch(pid, verdict) { verdicts.set(pid, { decrypt: !!(verdict && verdict.decrypt === true), agent: (verdict && verdict.agent) || null }) },
    unwatch(pid) { verdicts.delete(pid) },
    verdictOf: (pid) => (verdicts.has(pid) ? { ...verdicts.get(pid) } : null),

    /** The pids of the processes that are `form` (the live ones the table has taken in), and what `planRoutes` takes as `procs`: `[{ pid, match, elevated }]` for every process that is, or might be, a form's. */
    pidsOf,
    procs: () => [...procs].filter(([, p]) => p.match.kind !== 'none').map(([pid, p]) => ({ pid, match: p.match, elevated: p.elevated })),
  })
}
