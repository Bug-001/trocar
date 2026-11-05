// door-identity.mjs — who a connection at a door is (RFC 4.9 §5.3, 4.8 §5.3, D47 · D51): the identity half of a door's lookup, written once. The engine's
// peer 4-tuple IS the agent's outbound socket, so ONE targeted owner question (`ownerOf`) answers its pid and ONE targeted facts question (`factsOf`) that
// pid's facts, asked for every connection (the cache only remembers the last life met: door, host, unread). Then, in order: this user (`uid`) → the host tree (a form whose
// `hosts.processes` names the host program: its connections are the door harness's only for the targets on the applied host set) → the D51 name list
// (`identify`, registry.match), with `process-unknown` said once per (door group, name). The collector model's doors
// (core/proxymode/collector.mjs) ask this; nothing keeps its own copy. Names no harness and no OS; execs nothing itself.
import { ASK_HANG_MS } from '../../../off/exec.mjs'
import { processNames, WIDE } from '../../../off/identity.mjs'
import { hostFormOf } from '../host-agent.mjs'

// registry.match's reasons that are not a harness (4.8 §5.3, 4.6 §识别进程) → the door's untracked reason; args-mismatch / no-match are `not-an-agent`
const UNMATCHED = Object.freeze({ excluded: 'agent-helper', pending: 'cmdline-pending', ambiguous: 'ambiguous' })
const msgOf = (e) => String((e && e.message) || e)
/** One connection's total limit, accept to judgement (4.9 §5.3, D82③): the socket table's shared reads alone can take one wait for the read in flight and one for its own. */
export const DOOR_HANG_MS = 2 * ASK_HANG_MS
const LATE = 'door-deadline'

/**
 * createDoorIdentity({ ownerOf, factsOf, identify, ownUid, hostsOf, onFailure, onEvent, clock }) → { identityOf, owningPid, factsCached, cache }
 *   ownerOf   `({ peer }) → { pid, source, ms } | null`: the owner of the accepted socket's peer end, read targeted at accept time
 *   factsOf   `(pid) → ProcFacts | null`: the pid's facts (exe, argv, startedAt, uid where the OS gives one); null = gone or unreadable
 *   identify  `(facts) → { agent, reason, … }` — registry.match, the D51 name list
 *   ownUid    this daemon's uid: a process whose facts carry another `uid` is `other-user`
 *   hostsOf   `(form) → [host] | null`: the applied host set of a host-tree form
 * identityOf({ peer, door: { g, harness, forms }, target, within }) → { pid, source, ms, facts, facts_ms, exe, agent, hosted, why, unresolved? }: `within(ask, answer)`
 * is the connection's limit: `ask`, or `answer` when the limit came first (`door-deadline`, `unresolved` then says which question stuck). `why` is the untracked reason
 * (`door-deadline` · `pid-unresolved` · `facts-unavailable` · `other-user` · `outside-host-set` · `agent-helper` · `cmdline-pending` · `ambiguous` · `not-an-agent`), or null
 * with `agent` the harness the name list (or the host tree: `hosted`) names. With no pid, `unresolved` is the owner question's why and `facts` is
 * `{ sameUser: true }` when the socket table proved the end is this user's (else null); so is a pid whose facts could not be read (`facts-unavailable`,
 * `unresolved` then says why the facts reader failed). `cache`: pid → { startedAt, facts, door, host, unread } — the last life met; `unread`: why its
 * facts could not be read (the reader's own words, D38), null when they were.
 */
export function createDoorIdentity({ ownerOf = null, factsOf = null, identify, ownUid = process.getuid?.() ?? null, hostsOf = () => null, onFailure = () => {}, onEvent = () => {}, clock = Date.now } = {}) {
  if (typeof identify !== 'function') throw new TypeError('createDoorIdentity needs identify (registry.match): who a process is comes from the D51 name list')
  const cache = new Map() // pid → { startedAt, facts, door, host } — nothing sweeps
  const unknownSaid = new Set() // `${door group}\0${name}`: process-unknown is written once per (door group, name) in this life — bounded
  const inflight = new Map() // pid → { ask, next }: the ask running, and the one every question that arrived during it shares

  /** The facts of one pid, asked TARGETED every time: the answer is what THIS connection's process is, never a cached row a wrapped pid could have left
   *  behind (4.8 W4 — the start time in the fresh answer keys the verdict to its life). A question that arrives while an ask runs shares the NEXT ask, never
   *  the running one, which may have started before this connection and before an exec (4.9 §5.3 step 2, socktable.mjs's rule). */
  function factsCached(pid) {
    const held = inflight.get(pid)
    if (!held) return start(pid)
    return (held.next ??= held.ask.then(() => start(pid), () => start(pid)))
  }
  function start(pid) {
    let unread = null
    const entry = { next: null }
    entry.ask = Promise.resolve().then(() => (typeof factsOf === 'function' ? factsOf(pid, { onUnread: (why) => { unread = why } }) : null)).then((facts) => {
      const prev = cache.get(pid)
      const startedAt = facts && facts.startedAt != null ? facts.startedAt : null
      cache.set(pid, { door: prev ? prev.door : null, host: prev && prev.startedAt === startedAt ? prev.host : null, startedAt, facts, unread: facts ? null : unread }) // a host-tree door's harness is this life's
      return facts
    }).finally(() => { if (inflight.get(pid) === entry) inflight.delete(pid) })
    inflight.set(pid, entry)
    return entry.ask
  }

  /** The owner of the connection just accepted, from the socket itself: no row, several holders that persist, an unreadable table all give null (4.8 W4),
   *  with the owner question's `why` ('no-row' · 'shared' · 'unreadable') and, when the table proves the end is this user's, `sameUser: true`. */
  async function owningPid(peer) {
    const none = { pid: null, source: null, ms: null }
    if (!ownerOf) return none
    try {
      const r = await ownerOf({ peer })
      const pid = r && r.pid != null ? r.pid : null
      return { pid, source: (r && r.source) || null, ms: r && r.ms != null ? r.ms : null, ...(pid == null && r && r.why ? { why: r.why } : {}), ...(r && r.sameUser === true ? { sameUser: true } : {}) }
    } catch (e) {
      onFailure({ event: 'failure', where: 'helper', code: 'socktable-unavailable', reason: `the owner of a connection could not be asked for (${msgOf(e)}); the connection is spliced untracked` })
      return { ...none, why: 'unreadable' }
    }
  }

  /** process-unknown (4.6 §记录, a state event): a process no item of the name list claims used the door — once per (door group, name), with its first
   *  name, whether that name is a wide one (an interpreter), and `named` (listed only with an `args` pattern its arguments missed). Never its command line. */
  function said(door, facts, pid, named) {
    const name = processNames(facts)[0] ?? null
    const key = `${door.g}\0${name}`
    if (unknownSaid.has(key)) return
    unknownSaid.add(key)
    try { onEvent({ event: 'process-unknown', where: 'engine', harness: door.harness, door: door.g, name, wide: name != null && WIDE.has(name), named, pid, reason: named
      ? `${name ?? 'a process'} (pid ${pid}) used the ${door.g} door; its name is listed only with an args pattern its arguments do not match: its connections are forwarded, not captured; to capture it, add an item with "args" to ~/.trocar/agents.json`
      : `${name ?? 'a process'} (pid ${pid}) used the ${door.g} door but is on no name list: its connections are forwarded, not captured; add it to ~/.trocar/agents.json to capture it` }) } catch { /* the sink's own failure is the sink's */ }
  }

  async function identityOf({ peer, door, target, within = (p) => p }) {
    const { pid, source, ms, why: unresolved = null, sameUser } = await within(owningPid(peer), { pid: null, source: null, ms: null, why: LATE })
    const out = { pid, source, ms, facts: null, facts_ms: null, exe: null, agent: null, hosted: false, why: null }
    const proven = sameUser ? { sameUser: true } : null // the table's own-user proof holds however the questions after it end (the PAC door's only question, 4.11 P10)
    // never a guessed pid (4.8 W4); the owner question's why travels on
    if (pid == null) return { ...out, facts: proven, ...(unresolved === LATE ? { unresolved: 'waiting for the socket owner', why: LATE } : { unresolved, why: 'pid-unresolved' }) }
    const asked = clock()
    const facts = await within(factsCached(pid), LATE)
    out.facts_ms = clock() - asked
    if (facts === LATE) return { ...out, facts: proven, unresolved: 'waiting for the process facts', why: LATE }
    if (!facts) { // gone between the accept and the ask, or unreadable: not the same as "not an agent"
      const unread = (cache.get(pid) || {}).unread
      return { ...out, facts: proven, ...(unread ? { unresolved: unread } : {}), why: 'facts-unavailable' }
    }
    out.facts = facts
    out.exe = facts.exe ?? null
    const held = cache.get(pid)
    if (held) held.door = door.g
    if (facts.uid != null && ownUid != null && facts.uid !== ownUid) return { ...out, why: 'other-user' } // another user's process: never judged
    const hostForm = (hostFormOf([door], facts) || {}).form // a host-tree group (4.8 §3, core/host-agent.mjs)
    if (hostForm) {
      const set = hostsOf(hostForm)
      const host = String((target && target.address) || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
      const hit = Array.isArray(set) && set.some((h) => typeof h === 'string' && (host === h || host.endsWith(`.${h}`)))
      if (!hit) return { ...out, why: 'outside-host-set' }
      if (held) held.host = door.harness // a rescan re-tells it as the host's, never re-asks the name list
      return { ...out, agent: door.harness, hosted: true }
    }
    const m = identify(facts) || {}
    if (m.reason === 'match' && m.agent) return { ...out, agent: m.agent }
    if (UNMATCHED[m.reason]) return { ...out, why: UNMATCHED[m.reason] } // pending is not cached anywhere: the next connection asks again (W78)
    said(door, facts, pid, m.reason === 'args-mismatch')
    return { ...out, why: 'not-an-agent' }
  }

  return { identityOf, owningPid, factsCached, cache }
}
