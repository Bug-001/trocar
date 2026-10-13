// door-redirector.mjs — the SHARED engine-as-proxy Redirector (RFC 4.9 §1 · §5, D47's seam, and 4.8 §5's contract underneath; the win32 twin of D47 closed the
// duplication: this core is what both arch adapters now only dress). The ENGINE is the only local proxy on the machine: it listens on one loopback door per
// entry group (ingress.json's group ports, engine.mjs `listen({groups})`), the agents' entries point straight at those doors, and the engine dials each
// connection's upstream itself — no forwarder process, no kernel config, no read-back anywhere (the machinery that existed to feed a kernel is deleted).
//
// What is OS-neutral lives HERE, and only here:
//   · the doors' lifecycle is `attach()` / `detach()`: a group that is ON (or carried — installed, once on, or opted in — so an agent that outlives `off`
//     has a port to come back to) gets its door opened on the engine through the injected `doors` half (the wiring's `bindDoors`, which the daemon binds to
//     `engine.listen({groups})` / `engine.closeGroups`); a group that is off and not carried has NO listener at all (audit F7: a loopback door nobody is
//     behind is an opening, and the desktop door takes no credentials). ONLY THEN are the on groups' proxy entries written (the entry is the pointing
//     itself: written before the door stands, an agent would point at a dead port); `off` undoes the entries and leaves the carried doors forward-only.
//   · identity is read FROM THE SOCKET AT ACCEPT TIME (4.9 §5.3, D47): the agent connects to the door itself, so the engine's peer 4-tuple IS the agent's
//     outbound socket — ONE targeted owner question (`ownerOf`, the arch backend: lsof on darwin, GetExtendedTcpTable through the resident helper on win32)
//     answers its pid, ONE targeted facts question (`factsOf`) answers that pid's facts for the form, cached per process life. No scan, no poll, no debounce:
//     the peer process is alive by definition — it just connected.
//   · the splice/decrypt decision (lookupIngress below) and the verdict announce-and-wait seam to the tracker ('exec' → `watch(pid, …)`).
// What each arch injects: `matchForm` (its forms module), `ownerOf` / `factsOf` (its targeted identity backends), `directCount` (its established-connections
// table), and an optional resident `companion` (win32's read-only PowerShell helper: its ready line is `start()`'s, its close is `close()`'s, its protocol
// `expectedProto`; darwin has none — ps, lsof and scutil are plain CLIs, run on demand).
//
// This file names no harness (core never imports arch/ or harness/: the daemon hands the groups in) and names no OS: the adapters in arch/<os>/redirector.mjs
// are the only places that do. Node built-ins and the injected questions only; nothing here execs anything itself.
import { EventEmitter } from 'node:events'
import { bypassHit } from '../upstream-shape.mjs'

const untracked = (reason) => ({ not_captured: 'untracked', reason }) // the row's code for a connection whose process is not one the table can vouch for
const msgOf = (e) => String((e && e.message) || e)

/** How long a lookup waits for the tracker's verdict of a pid it just met: the judge is file reads (fast); the cap only bites when the judge never answers
 *  (a harness turned off mid-lookup, a descriptor that threw), and what it leaves is a tombstone — one wait per pid, never one per connection. */
export const VERDICT_WAIT_MS = 5000

/** The login a proxy reference names, for one use: the connection the ingress dials through the proxy. Not readable is an error with no login in it. */
function loginOf(g, up, authOf) {
  const auth = authOf(up.auth_ref)
  if (!auth) throw Object.assign(new Error(`the login of the upstream proxy of ${g} (${up.auth_ref}) cannot be read, so nothing can be dialled through that proxy`), { code: 'upstream-unavailable', why: 'upstream-credentials-unavailable' })
  return { username: auth.username, password: auth.password }
}

/**
 * createDoorRedirector({ groups, home, ownerOf, factsOf, routes, ingress, authOf, onFailure, doors, entries, gate, carried, matchForm, directCount, companion, now, verdictWaitMs })
 *   → the Redirector (an EventEmitter) — what arch/<os>/redirector.mjs returns after it dressed this core with its backends.
 *   groups    `groupsOf(descriptors)` (the arch's route-plan.mjs): `[{ g, harness, group, forms, proxy }]`, the harness files' OS data
 *   home      the user's home directory: `form-path-unknown` masks the user's name wherever the home is (the arch forms.mjs `formPathShape`)
 *   ownerOf   `({ peer: { address, port } }) → { pid, source, ms } | null` (the arch socktable's `ownerOfSocket`, bound to the arch's runner by the wiring):
 *             the owner of the accepted socket's peer end — the AGENT's own socket — read targeted at accept time; no candidates, no known table (D47)
 *   factsOf   `(pid) → ProcFacts | null` (the arch procinfo's `factsOfPid`, bound the same way): the pid's facts — its real executable, command line and start
 *             time — for the form match and the tracker's judgement; null = the pid is gone (not an error)
 *   routes    `() → planRoutes' result` ({ [group id]: { on, upstream, bypass, … } }): what the plan says NOW; the daemon re-plans when the system proxy or
 *             `desired` changes, so it is read at every lookup and every attach
 *   ingress   `() → loadIngressConfig's result` (`{ enginePort, groupPorts, ingressToken, listenerToken }`)
 *   authOf    `(auth_ref) → { username, password } | null`: the login a reference names
 *   onFailure the failure sink (the daemon's recorder): a record shaped `{ event: 'failure', where, code, reason }`
 *   doors     `{ open(list), close(ids) }` — the engine's door half, LATE-BOUND by the wiring's `bindDoors` (the daemon owns the engine and calls it after
 *             both exist): `open([{ id, port, auth, token? }])` binds one loopback listener per group (idempotent per id, engine.mjs), `close(ids)` stops
 *             accepting on those doors (connections in flight drain). Both may be absent (the lazy shell): `attach()` then refuses with its own TypeError.
 *   entries   the proxy entries of the agents, which only this file's order decides WHEN: `write(groups)` / `undo(groups)` / `check(groups)`; a group is
 *             `{ g, harness, entry }` ('auto' or 'opt-in' for a group that is on, null in the undo / check lists of a group the plan has off)
 *   gate      `({ g, harness, entry }) → { ok: true } | { ok: false, reason }`, required by `attach()`: asked for each group about to be written; a group it
 *             refuses is not handed to `entries.write` (Codex's and Hermes's W19 line — the wiring says so, the writer does not have to know)
 *   carried   `() → Iterable<group id> | null` (default: none): the groups whose entries may still exist and may therefore keep a forward-only door while the
 *             plan has them off (audit F7's other side: the wiring that knows the manifest says which ones; not saying is "no group")
 *   hostsOf   `(form) → [host] | null` (default: null): the APPLIED host set of a host-tree form (route-plan.mjs hostSetOf — the plan's last answer). A form that
 *             declares `hosts` lives in a host process tree (an editor carrying many extensions): its door reaches the engine ONLY for the targets on that set,
 *             every other connection of the program is forwarded, untracked — the arm the kernel's per-host rules used to hold (4.8 §3), moved into the door.
 *   matchForm the arch's own `(forms, { exe, cmdline }, { home }) → { kind: 'form', id } | { kind: 'none' } | …` (its forms.mjs) — which form a door's
 *             process is (the tracker then judges it by the D51 name list; the door takes registry.match in T7). Required: the core knows no OS's forms.
 *   directCount the arch's own `async (pid) → { count, error }` — how many of the process's established connections do not go to a group's door on loopback,
 *             what `status` shows as "still going direct". `{ count: null, error }` when it cannot be told — unknown, never 0 (D-17).
 *   companion `{ ready: async () => { pid?, proto?, build? }, close: async () => {}, proto } | null` — the arch's resident read-only helper (win32's), whose
 *             ready line `start()` waits for and whose close `close()` runs; `proto` is `expectedProto` (the daemon's protocol check). null = no companion
 *             (darwin: the CLIs run on demand and nothing resident exists to wait for or close).
 * Events: 'exec' ProcFacts — a pid met at a door (source 'accept'), told so the daemon's tracker judges it and answers through `watch()`. Nothing is swept:
 *   a process that dies simply stops connecting; its verdict row stays until the pid is met again with another start time (a wrapped pid is a new life,
 *   asked again — the facts cache keys by pid + startedAt).
 */
export function createDoorRedirector({ groups, home = null, ownerOf = null, factsOf = null, routes = () => ({}), ingress = () => ({}), authOf = () => null, onFailure = () => {}, doors = null, entries = null, gate = null, carried = () => null, hostsOf = () => null, matchForm = null, directCount = null, companion = null, now = Date.now, verdictWaitMs = VERDICT_WAIT_MS } = {}) {
  if (!Array.isArray(groups)) throw new TypeError('createDoorRedirector needs the groups (the arch route-plan.mjs groupsOf)')
  if (typeof matchForm !== 'function') throw new TypeError('createDoorRedirector needs the arch\'s matchForm (its forms.mjs): which form a process is has no OS-neutral answer')
  if (typeof directCount !== 'function') throw new TypeError('createDoorRedirector needs the arch\'s directCount (its established-connections table): how many of a process\'s connections still go direct has no OS-neutral answer')
  const ev = new EventEmitter()
  const forms = groups.flatMap((x) => x.forms) // in the order the harness files list them: matchForm tries a shared image's forms in that order
  const byGroup = new Map(groups.map((x) => [x.g, x]))
  const byForm = new Map(groups.flatMap((x) => x.forms.map((f) => [f.id, { form: f, g: x.g, harness: x.harness }])))
  let info = { pid: null, proto: null, build: null } // the companion's ready line (a resident helper's pid, protocol, build), or the all-null answer of an arch without one; set by start()

  // ---- identity: the socket at accept time (D47) ------------------------------------------------------------------------------------------------------
  const factsCache = new Map() // pid → { startedAt, facts } — the last life this pid was met in (for scan() and procs()); nothing sweeps
  const factsInflight = new Map() // pid → Promise<facts | null> — concurrent lookups of one new pid share the ask
  const verdicts = new Map() // pid → { decrypt, agent, startedAt }: what the tracker judged (4.8 §5.4), keyed to the life it judged; a process it has not judged has none, which is "not trusted"
  const waiting = new Map() // pid → { promise, answer(v) } — the lookups waiting for the tracker's watch() of a pid just met
  const doorsOpen = new Set() // the group ids whose door the engine holds

  /** The facts of one pid, asked TARGETED every time (the arch backend's ask — nothing sweeps the machine): the answer is what THIS connection's process is,
   *  never a cached row a wrapped pid could have left behind (a wrong pid must never happen, 4.8 W4 — the start time in the fresh answer is what keys the
   *  verdict to the life it belongs to). Concurrent lookups of the same pid share the one ask. */
  function factsCached(pid) {
    if (factsInflight.has(pid)) return factsInflight.get(pid)
    const ask = Promise.resolve().then(() => (typeof factsOf === 'function' ? factsOf(pid) : null)).then((facts) => {
      factsCache.set(pid, { startedAt: facts && facts.startedAt != null ? facts.startedAt : null, facts })
      return facts
    }).finally(() => { factsInflight.delete(pid) })
    factsInflight.set(pid, ask)
    return ask
  }

  /** The tracker's verdict of a pid, announced and waited for: a life the verdict table does not hold (never met, or the pid wrapped into a new life — another
   *  start time) is told as 'exec' (the daemon's tracker judges — the registry's name list, the trust layers — and answers through `watch(pid, …)`); this lookup waits
   *  up to verdictWaitMs. A verdict that never comes is a TOMBSTONE ({ decrypt: false }): one wait per life, never one per connection — and a later `watch()`
   *  (the tracker judged it after all, a harness came on) overwrites it as ever. */
  function verdictOf(pid, facts) {
    const at = facts && facts.startedAt != null ? facts.startedAt : null
    const held = verdicts.get(pid)
    if (held && (held.startedAt == null || at == null || held.startedAt === at)) return Promise.resolve(held)
    let w = waiting.get(pid)
    if (!w) {
      let answer
      const promise = new Promise((resolve) => { answer = resolve })
      const timer = setTimeout(() => { if (waiting.get(pid) === w) { waiting.delete(pid); verdicts.set(pid, { decrypt: false, agent: null, startedAt: at, none: true }); answer(verdicts.get(pid)) } }, verdictWaitMs) // NOT unref'd: a verdict wait is real pending work (a connection is waiting on it); an unref'd timer lets an otherwise-empty loop drain out from under the lookup
      w = { promise, answer: (v) => { clearTimeout(timer); if (waiting.get(pid) === w) waiting.delete(pid); answer(v) } }
      waiting.set(pid, w)
      ev.emit('exec', facts) // the tracker's seam, unchanged: it judges and calls watch()
    }
    return w.promise
  }

  /** The group's upstream for one connection: the hop the agent would have used without asight, with its login resolved (4.8 §2.2, §5.2).
   *  A target the group's bypass table hits goes direct, as the agent's did — `bypassHit`, the one matcher both arches' upstream rules and this core share
   *  (core/upstream-shape.mjs: the row shape is shared by construction, route-plan.mjs's `bypass`). */
  function upstreamFor(g, route, host) {
    if (bypassHit(route.bypass, host)) return { kind: 'direct' }
    const up = route.upstream
    if (!up || typeof up.kind !== 'string') throw Object.assign(new Error(`the group ${g} has no upstream to dial`), { code: 'upstream-unavailable', why: 'no-upstream' })
    if (up.kind === 'direct') return { kind: 'direct' }
    const out = { kind: up.kind, host: up.host, port: up.port }
    if (up.credentialed) out.auth = loginOf(g, up, authOf)
    return out
  }

  /** The owner of the connection the engine just accepted, read from the socket itself (the arch socktable, targeted): never wrong — no row, several rows, a
   *  slow or unreadable table all give null, and the connection is judged untracked and spliced (4.8 W4). */
  async function owningPid(peer) {
    const none = { pid: null, source: null, ms: null }
    if (!ownerOf) return none
    try {
      const r = await ownerOf({ peer })
      return { pid: r && r.pid != null ? r.pid : null, source: (r && r.source) || null, ms: r && r.ms != null ? r.ms : null }
    } catch (e) {
      onFailure({ event: 'failure', where: 'helper', code: 'socktable-unavailable', reason: `the owner of a connection could not be asked for (${msgOf(e)}); the connection is spliced untracked` })
      return none
    }
  }

  const entryOf = (g) => ({ g, harness: byGroup.get(g).harness, entry: ((routes() || {})[g] || {}).entry ?? null })

  /** The doors the engine should hold for the plan as it is now: a group that is on, or carried while off, with a port, a supported form and an upstream —
   *  and no login on a door whose entry takes none (4.8 §3). `skipped` says every group the plan has ON that none of this holds, with its reason, so a
   *  group left out is said by whoever asked, never silently. */
  function doorPlan() {
    const table = routes() || {}
    const ing = ingress() || {}
    const mayCarry = new Set(carried() || [])
    const skipped = []
    const wanted = []
    for (const x of groups) {
      const r = table[x.g]
      if (!r) continue // the plan has no answer yet: nothing to hold and nothing to say
      if (r.on !== true && !mayCarry.has(x.g)) continue // off and never installed or opted in: no door at all (audit F7)
      const port = (ing.groupPorts || {})[x.g]
      const supported = x.forms.some((f) => f.supported === true && f.match)
      const why = !r.upstream ? 'no-upstream' : !Number.isInteger(port) ? 'no-port' : !supported ? 'no-supported-form' : x.group.auth === false && r.upstream.credentialed ? 'login-on-open-port' : null
      if (why) { skipped.push({ g: x.g, reason: why }); continue }
      wanted.push({ g: x.g, port, on: r.on === true, auth: x.group.auth !== false })
    }
    return { ing, wanted, skipped }
  }

  return Object.assign(ev, {
    /** What the engine's doors ask for each connection a client handed over on purpose (4.8 §5.2, core/redirector.mjs — the engine's ingress calls this
     *  with the DOOR's group as `user` and the accepted socket's peer as `peer`, D47): the flow's meta; null for a group the plan has no answer for, a door
     *  nobody holds, or a target on this machine's own loopback (a loop through the door, not a flow — nothing legitimate asks a door to reach itself).
     *  An AGENT's connection of a group that is not on (the plan flipped before the doors followed) is served, not refused: a spliced meta, no identity
     *  asked for, the group's upstream, `skip` = `untracked` · `group-off`.
     *  The meta: `pid` (or null) · `agent` the door's harness · `decrypt` (the tracker's verdict of the pid this socket belongs to — never a process the
     *  door's own form does not claim) · `capture: 'proxy'` · `form` · `exe` · `upstream` (`{kind:'direct'}`, or the group's with its login: the ingress
     *  uses it for this one connection and keeps only whether there was one) · `pid_source` · `pid_ms` · `negKey` (the pid, or the door's group when there
     *  is none: forms must not poison one another's negative cache, 4.8 §5.5) · `skip`, only when it is not decrypted and the table has no verdict to say why.
     *  Rejects, with `code: 'upstream-unavailable'`, a `why` (`no-upstream`, `upstream-credentials-unavailable`) and no login in the message, when the
     *  upstream cannot be dialled: the ingress then writes its own `upstream-unavailable` failure and answers 502. */
    async lookupIngress({ peer, user, target }) {
      const door = byGroup.get(typeof user === 'string' ? user : '')
      const route = door && (routes() || {})[door.g]
      if (!door || !route || !target) return null
      const ownPort = ((ingress() || {}).groupPorts || {})[door.g]
      if ((target.address === '127.0.0.1' || target.address === 'localhost') && Number.isInteger(ownPort) && target.port === ownPort) return null // a CONNECT at the door's own address is a loop through the door, not a flow — nothing legitimate asks a door to reach itself. Any other loopback target (a local model server) is a flow like any other
      if (route.on !== true) { // the plan has this group off: an agent's connection that still arrives is the plan flipped before the doors followed, and is served
        if (!route.upstream) return null // nothing to serve it with: refused
        return { pid: null, agent: door.harness, decrypt: false, capture: 'proxy', form: null, exe: null, upstream: upstreamFor(door.g, route, target.address), pid_source: null, pid_ms: null, negKey: door.g, skip: untracked('group-off') }
      }
      const upstream = upstreamFor(door.g, route, target.address) // before the identity is asked: a connection that cannot be dialled should not wait on it (and one with nothing to dial is refused with its own why)
      const { pid, source, ms } = await owningPid(peer)
      let form = null
      let exe = null
      let decrypt = false
      if (pid != null) {
        const facts = await factsCached(pid)
        if (facts) {
          exe = facts.exe // the row says whose connection it was, whichever way it is judged
          const m = matchForm(forms, { exe: facts.exe, cmdline: facts.cmdline }, { home })
          const row = m.kind === 'form' ? byForm.get(m.id) : null
          if (row && row.g === door.g) { // this door's own form: the connection is this process's to decrypt (another group's form at this door — the open desktop door's shape — is forwarded, untracked)
            form = row.form
            if (form.hosts) { // a host-tree form (4.8 §3): only the connections to its host set reach the engine, the program's others are forwarded — the arm the kernel's per-host rules used to hold
              const set = hostsOf(form)
              const host = String(target.address || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
              const hit = Array.isArray(set) && set.some((h) => typeof h === 'string' && (host === h || host.endsWith(`.${h}`)))
              if (!hit) return { pid, agent: door.harness, decrypt: false, capture: 'proxy', form: null, exe, upstream, pid_source: source, pid_ms: ms, negKey: pid != null ? String(pid) : door.g, skip: untracked('outside-host-set') }
            } else {
              const v = await verdictOf(pid, facts)
              decrypt = !!(v && v.decrypt === true)
            }
          }
        }
      }
      // a connection this door's own form owns but its process does not trust is spliced with the tracker's own reason (the engine's policy arm, flow.mjs
      // skipOf): only a connection with no pid to vouch for, or one whose process is not this door's form, carries the table's untracked code here
      const why = pid == null ? 'pid-unresolved' : form ? null : 'not-a-process-of-form'
      return {
        pid, agent: door.harness, decrypt, capture: 'proxy',
        ...(form ? { form: form.id } : {}), exe,
        upstream, pid_source: source, pid_ms: ms, negKey: pid != null ? String(pid) : door.g,
        ...(!decrypt && why ? { skip: untracked(why) } : {}),
      }
    },

    /** `on`: the doors first, then the entries (the pointing itself — written before the door stands, an agent would point at a port with nothing behind it,
     *  4.8 §2.1). A door the engine cannot bind (the port is held) rejects with its code and NOT ONE entry was written or undone. A crash between the doors
     *  and the entries is `on` again: the same doors (idempotent per group), the same entries (the writer is idempotent). The groups the plan has off are
     *  undone, and a door nobody carries any more (its group went off and its records went with an uninstall) is closed. Resolves `{ ok, doors, entries:
     *  { written, undone, skipped } }`; an entry that could not be written is that group's `{ ok: false, reason }`, not an exception: the doors and the other
     *  groups stand. A group the plan has ON that gets no door (no port, no form it can carry, no upstream, a login on a port that takes none) is not written
     *  either, and is said: `entries.skipped: [{ g, reason }]` and `ok: false`. */
    async attach() {
      if (!doors || !entries) throw new TypeError('attach needs the doors and the entries')
      if (typeof gate !== 'function') throw new TypeError('attach needs the gate: which groups may have their proxy entry written is the wiring\'s to say, and not saying is not "all of them" (a proxy line that joins a block the trust entry wrote may not be written before the W19 conditions of 4.8 hold)')
      const plan = doorPlan()
      const table = routes() || {}
      const wantIds = new Set(plan.wanted.map((x) => x.g))
      const toClose = [...doorsOpen].filter((g) => !wantIds.has(g))
      if (toClose.length) { await doors.close(toClose); for (const g of toClose) doorsOpen.delete(g) }
      if (plan.wanted.length) {
        await doors.open(plan.wanted.map((x) => ({ id: x.g, port: x.port, auth: x.auth, ...(x.auth ? { token: plan.ing.listenerToken } : {}) })))
        for (const x of plan.wanted) doorsOpen.add(x.g)
      }
      const open = []
      const refused = []
      for (const e of plan.wanted.filter((x) => x.on).map((x) => entryOf(x.g))) {
        let v
        try { v = await gate(e) } catch (err) { v = { ok: false, reason: `the gate could not say: ${msgOf(err)}` } }
        if (v && v.ok === true) open.push(e)
        else refused.push({ g: e.g, ok: false, gated: true, reason: (v && v.reason) || 'the gate did not allow it' })
      }
      const off = groups.filter((x) => table[x.g] && table[x.g].on !== true).map((x) => entryOf(x.g))
      const written = [...(open.length ? (await entries.write(open)) || [] : []), ...refused]
      const undone = off.length ? (await entries.undo(off)) || [] : []
      const left = plan.skipped.filter((x) => (table[x.g] || {}).on === true) // the plan says on, no door carries it: not written, not undone, and said (D38)
      return { ok: [...written, ...undone].every((x) => x.ok !== false) && left.length === 0, doors: { open: [...doorsOpen], closed: toClose }, entries: { written, undone, skipped: left } }
    },

    /** `off`, the other way (4.8 §4.1): every group's proxy entry undone — the planned or not, the writer undoes only what asight wrote — and the doors
     *  brought to the carried set: a group whose records may still exist keeps its door FORWARD-ONLY (an agent that outlives `off` — its env still points
     *  here — keeps flowing to the upstream, nothing decrypted, nothing recorded); a door nobody carries is closed (connections in flight drain in the engine). */
    async detach() {
      if (!doors || !entries) throw new TypeError('detach needs the doors and the entries')
      const undone = (await entries.undo(groups.map((x) => entryOf(x.g)))) || []
      const mayCarry = new Set(carried() || [])
      const toClose = [...doorsOpen].filter((g) => !mayCarry.has(g))
      if (toClose.length) { await doors.close(toClose); for (const g of toClose) doorsOpen.delete(g) }
      return { ok: undone.every((x) => x.ok !== false), doors: { open: [...doorsOpen], closed: toClose }, entries: { undone } }
    },

    /** What stands now (4.6 §开关语义): the doors of the groups the plan has on, and the entries' own check against the same plan. `attached` is true when
     *  at least one such door is open — told by the only proxy there is. */
    async status() {
      if (!entries) throw new TypeError('status needs the entries')
      const table = routes() || {}
      const live = groups.filter((x) => table[x.g] && table[x.g].on === true && doorsOpen.has(x.g))
      const should = groups.filter((x) => table[x.g] && table[x.g].on === true).map((x) => entryOf(x.g))
      return { attached: live.length > 0, links: live.map((x) => ({ name: x.g })), hb_age_ms: null, drops: null, doors: [...doorsOpen], entries: typeof entries.check === 'function' ? await entries.check(should) : null }
    },

    /** How many of the process's established connections do not go to a group's door on loopback — the arch's own table read, injected (`directCount`):
     *  unknown is `{ count: null, error }`, never 0 (D-17). */
    directCount: (pid) => directCount(pid),

    /** The daemon's `redirector.configure(enginePort)` (core/redirector.mjs): the port the engine listens on. The doors' ports come from `ingress()`
     *  (ingress.json: groupPorts), so there is nothing to tell the engine here; accepted so that the daemon's call is not a TypeError at the first `on`. */
    async configure() {},
    /** Nothing to start but the companion (the arch's resident helper, when there is one): its ready line is the answer, and no door comes with it — the
     *  doors come with the first attach (the switch's `on` or its restore). */
    async start() {
      if (companion && typeof companion.ready === 'function') {
        const r = await companion.ready()
        info = { pid: (r && r.pid) ?? null, proto: (r && r.proto) ?? null, build: (r && (r.build ?? r.ps)) ?? null }
      }
      return { ...info }
    },
    /** Stops the companion (an arch without one has nothing resident to stop): the daemon's own stop closes the engine (the doors go with it) and the
     *  wiring's netenv watcher (its own close). */
    async close() {
      if (companion && typeof companion.close === 'function') await companion.close()
    },
    heartbeat() {}, // nothing is gated on a heartbeat: the engine is the proxy, and when it is gone the doors are gone with it (the OS's supervisor restarts the daemon, 4.9 §7)
    setBeatGate() {}, // the daemon's per-harness gate (1.6 §1.5) is asked before each automatic heartbeat; there are none here
    helperInfo: () => ({ ...info }), // the companion's ready line ({ pid, proto, build }), or the all-null answer of an arch without one
    expectedProto: companion ? companion.proto ?? null : null, // the resident companion's protocol, when there is one; null = nothing to compare and the daemon's check passes

    /** The live processes the doors have MET, as facts — the table is what connections taught (nothing is swept, D47): a rescan re-judges exactly the pids
     *  that are still connecting, and a pid nobody meets anymore is forgotten by the same rule. */
    async scan() {
      return [...factsCache.values()].map((x) => x.facts).filter(Boolean)
    },
    unreadable: () => [], // no table of unreadable rows exists any more: the targeted ask either answers a row or the pid is gone

    /** The tracker's verdict for a process (4.8 §5.4: the decrypt table): `decrypt` true only for one it confirmed trusts asight's CA. The row carries the
     *  start time it was judged for, so a wrapped pid (another life) is judged again instead of inheriting a dead process's verdict. */
    watch(pid, verdict) {
      const held = verdicts.get(pid)
      verdicts.set(pid, { decrypt: !!(verdict && verdict.decrypt === true), agent: (verdict && verdict.agent) || null, ...(held && held.startedAt != null ? { startedAt: held.startedAt } : {}) })
      const w = waiting.get(pid)
      if (w) w.answer(verdicts.get(pid))
    },
    unwatch(pid) { verdicts.delete(pid) },
    verdictOf: (pid) => (verdicts.has(pid) ? { ...verdicts.get(pid) } : null),

    /** The pids of the processes that are `form`, and what `planRoutes` takes as `procs`: `[{ pid, match, elevated }]` for every process the doors have met
     *  that is, or might be, a form's. */
    pidsOf: (form) => [...factsCache.entries()].filter(([, x]) => { const m = x.facts ? matchForm(forms, { exe: x.facts.exe, cmdline: x.facts.cmdline }, { home }) : null; return m && m.kind === 'form' && m.id === form }).map(([pid]) => pid),
    procs: () => [...factsCache.entries()].map(([pid, x]) => ({ pid, match: x.facts ? matchForm(forms, { exe: x.facts.exe, cmdline: x.facts.cmdline }, { home }) : { kind: 'none' }, elevated: x.facts ? x.facts.elevated : null })).filter((p) => p.match.kind !== 'none'),
  })
}
