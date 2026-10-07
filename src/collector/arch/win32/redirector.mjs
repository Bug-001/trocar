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

const FORM_USER = /^of\.(.+)$/ // the name the kernel's outbound to the engine authenticates as (4.8 §3.1): `of.<form id>`
const untracked = (reason) => ({ not_captured: 'untracked', reason }) // the row's code for a connection whose process is not one the table can vouch for (what the tracker says for a pid it does not hold)
const msgOf = (e) => String((e && e.message) || e)

/**
 * createWin32Redirector({ helper, procWatcher, groups, home, ownerOf, routes, ingress, authOf, onFailure }) → the Redirector (an EventEmitter)
 *   helper       the started helper client (helper.mjs `startHelper`): its `ready` line and `pid` answer `start()` / `helperInfo()`, and `close()` closes it
 *   procWatcher  `createProcWatcher()`: the redirector subscribes to its events in this call, so none is lost between the two
 *   groups       `groupsOf(descriptors)` (route-plan.mjs): `[{ g, harness, group, forms, proxy }]`, the harness files' Windows data
 *   home         the user's profile directory (`%USERPROFILE%`): `form-path-unknown` masks the user's name wherever the profile is (forms.mjs `formPathShape`)
 *   ownerOf      `({ hop: { port }, candidates: [pid] }) → { pid, source, ms }` (socktable.mjs `ownerOf`, bound to the helper by the daemon): which of the candidates holds the connection to the hop; none = no pid completion, every
 *                connection is judged by its form
 *   routes       `() → planRoutes' result` ({ [group id]: { on, upstream, bypass, … } }): what the plan says NOW; the daemon re-plans when the system proxy or `desired` changes, so it is read at every lookup
 *   ingress      `() → loadIngressConfig's result` (`{ enginePort, groupPorts, ingressToken, listenerToken }`)
 *   authOf       `(auth_ref) → { username, password } | null`: the login a reference names (`prior:<group>`, `hkcu-env:<NAME>`); only this call turns a reference into a login, and only for one connection that is dialled through the proxy
 *   onFailure    the failure sink (the daemon's recorder): a record shaped `{ event: 'failure', where, code, reason }`
 * Events: 'exec' ProcFacts · 'exit' {pid, startedAt} · 'facts-update' ProcFacts (a command line that was not known yet is, or was given up on) · 'facts-error' (a process whose image cannot be read) — the watcher's, passed on after
 *   the table has taken them in, so a listener that asks the table finds the process there · 'helper-error' {reason, code, …} (the watcher's `poll-error`: the helper failed, or a listener threw) ·
 *   'form-exit' {form, neg_key} (the last process of a form is gone: the engine forgets that form's negative-cache entries, 4.8 §5.5).
 */
export function createWin32Redirector({ helper, procWatcher, groups, home = null, ownerOf = null, routes = () => ({}), ingress = () => ({}), authOf = () => null, onFailure = () => {} } = {}) {
  if (!procWatcher || typeof procWatcher.on !== 'function') throw new TypeError('createWin32Redirector needs the process watcher (procinfo.mjs createProcWatcher)')
  if (!Array.isArray(groups)) throw new TypeError('createWin32Redirector needs the groups (route-plan.mjs groupsOf)')
  const ev = new EventEmitter()
  const forms = groups.flatMap((x) => x.forms) // in the order the harness files list them: matchForm tries a shared image's forms in that order
  const procs = new Map() // pid → { exe, ppid, startedAt, elevated, match, seq }
  const verdicts = new Map() // pid → { decrypt, agent }: what the tracker judged (4.8 §5.4); a process it has not judged has none, which is "not trusted"
  const byForm = new Map(groups.flatMap((x) => x.forms.map((f) => [f.id, { form: f, g: x.g, harness: x.harness }])))
  let seq = 0
  let info = { pid: null, proto: null, build: null }

  function ingest(facts) {
    const match = matchForm(forms, { exe: facts.exe, cmdline: facts.cmdline, cmdlineState: facts.cmdlineState }, { home })
    procs.set(facts.pid, { exe: facts.exe ?? null, ppid: facts.ppid ?? null, startedAt: facts.startedAt ?? null, elevated: facts.elevated ?? null, match, seq: ++seq })
  }
  const pidsOf = (form) => [...procs].filter(([, p]) => p.match.kind === 'form' && p.match.id === form).map(([pid]) => pid)
  /** The processes a connection under `of.<form>` can be from: the form's own, and the ones whose command line is not known yet and may be (the watcher says again when it is). */
  const maybeOf = (form) => [...procs].filter(([, p]) => (p.match.kind === 'form' && p.match.id === form) || (p.match.kind === 'pending' && p.match.forms.includes(form))).map(([pid]) => pid)
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
    if (up.credentialed) {
      const auth = authOf(up.auth_ref)
      if (!auth) throw Object.assign(new Error(`the login of the upstream proxy of ${g} (${up.auth_ref}) cannot be read, so the connection cannot be dialled through it`), { why: 'upstream-credentials-unavailable' })
      out.auth = { username: auth.username, password: auth.password }
    }
    return out
  }

  /** Which process owns the connection that reached the group's port, best effort and never wrong (4.8 §5.3): one of `candidates`, or nobody. A form with a process rule in the kernel gets only its own processes there; a form with none takes
   *  every connection of its port, so it is asked against every process. A socket table that cannot be asked never costs the connection: it is no pid, and the failure is recorded. */
  async function owningPid(candidates, port) {
    const none = { pid: null, source: null, ms: null }
    if (!ownerOf || !Number.isInteger(port) || candidates.length === 0) return none
    try {
      const r = await ownerOf({ hop: { port }, candidates })
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
      const own = hit.form.processRules !== false
      const candidates = own ? maybeOf(hit.form.id) : [...procs.keys()]
      const { pid, source, ms } = await owningPid(candidates, port)
      const { decrypt, skip } = judge(hit.form, pid, candidates)
      return {
        pid, agent: hit.harness, decrypt, capture: 'proxy', form: hit.form.id, exe: pid != null && procs.has(pid) ? procs.get(pid).exe : null,
        upstream, pid_source: source, pid_ms: ms, negKey: pid != null ? String(pid) : `of.${hit.form.id}`, ...(skip ? { skip } : {}),
      }
    },

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
