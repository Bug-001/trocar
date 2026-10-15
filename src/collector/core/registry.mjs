// registry.mjs — which harness a running process is, by NAME (RFC 4.6 §身份与信任, D51, D31②, D37; plan 2026-10-14-d51-name-allowlist §2.3).
// It knows no harness and no OS. Each descriptor in src/collector/harness/ carries its preset list as DATA (`processes: { names, exclude,
// longLived }`, one for every OS); the user's ~/.asight/agents.json adds or ignores items (D51③, handed in as `agentList` / replaceAgentList).
// Both compile once (src/off/identity.mjs compileIdentity) into patterns over the derived facts `names` / `name0` / `rest` (identityView), so
// the tracker, the doors, `status` and `off` judge with one matcher. A process is judged on its own facts at exec time, never by its parent
// (§子进程与嵌套 agent). Unknown or ambiguous means no agent: an unrecognised process is never folded into a known identity (0.1 §5, D25).
//
// match(facts) → { agent, descriptor, reason, harness?, candidates? }; reason (4.6 「按名单认」, plan §2.3):
//   match          exactly one harness claims it and none of its exclude items holds
//   excluded       a name of `harness` and one of its exclude items holds (a helper of that harness)
//   pending        a command line not known yet (win32 cmdlineState pending / cim-backoff) and the name is on a list: its args, its exclusions and
//                  its Chromium role read the command line, so it is never `match` before it came (review R17; not cached, 4.8 W78)
//   args-mismatch  the name is on some list, but none of those items' `args` holds
//   no-match       the name is on no list
//   ambiguous      two harnesses claim it (`candidates`)
// Exclude items may read `env`, which may be a lazy read of the process: it is reached only once a name of that harness hit.
import { holds, matchPattern, identityView, serializeSignature } from '../../off/signature.mjs'
import { compileIdentity, mergeAgentList } from '../../off/identity.mjs'
import { UNTIL_TEXT } from './codes.mjs'

export { matchPattern }

const RUNTIMES = new Set(['node', 'rust', 'python'])
const NAME_RE = /^[a-z][a-z0-9-]*$/
const PENDING = new Set(['pending', 'cim-backoff'])

const anyOf = (patterns, facts) => (patterns || []).some((p) => matchPattern(p, facts))
// an item's argument patterns: `rest` over the whole argument string, `entry` over the program an interpreter runs (identity.mjs entryOf)
const argsHold = (p, view) => (!p.rest || holds(p.rest, view.rest)) && (!p.entry || holds(p.entry, view.entry))
// an exclude item that reads the command line (its `rest`, argv[0]'s `name0`)
const READS_ARGV = (x) => x.rest != null || x.name0 != null || x.entry != null
const compileOf = (d) => compileIdentity({ harness: d.name, ...d.processes })

export function validateDescriptor(d) {
  const where = `harness descriptor ${JSON.stringify(d && d.name)}`
  if (!d || typeof d.name !== 'string' || !NAME_RE.test(d.name)) throw new Error(`${where}: name must be kebab-case`)
  if (!RUNTIMES.has(d.runtime)) throw new Error(`${where}: runtime must be one of ${[...RUNTIMES].join(', ')}`)
  const p = d.processes
  if (!p || typeof p !== 'object' || !Array.isArray(p.names) || p.names.length === 0) throw new Error(`${where}: processes.names must be a non-empty array of { name, args? }`)
  compileOf(d) // throws on a wide name without args, a stateful RegExp, an exclude item naming no name of this harness
  if (!Array.isArray(d.hosts)) throw new Error(`${where}: hosts must be an array`)
  if (!d.trust || !Array.isArray(d.trust.chain) || d.trust.chain.length === 0) throw new Error(`${where}: trust.chain must be a non-empty array`)
  const au = d.trust.afterUninstall
  if (au !== undefined && typeof au !== 'function' && !(typeof au === 'string' && Object.hasOwn(UNTIL_TEXT, au))) throw new Error(`${where}: trust.afterUninstall must be one of ${Object.keys(UNTIL_TEXT).join(', ')} (or a function of the process): ${JSON.stringify(au)}`)
  if (d.trust.untilEnviron !== undefined && (typeof d.trust.untilEnviron !== 'string' || d.trust.untilEnviron === '')) throw new Error(`${where}: trust.untilEnviron must be the name of an environment variable`)
  return d
}

/** What `off` needs to judge, from the install manifest alone, which live process may hold what asight wrote for this harness (4.6 撤销顺序
 *  第 2 / 5 步; manifest `liveness.<harness>`): `identity`, the harness's name list compiled — its presets with the user's `agentList` additions for it
 *  merged in (its `ignore` items not applied) (the same on every OS, D51) — as JSON; whether the harness re-reads its entry while running; and until when a running one still trusts
 *  asight after `off` — the data form of `trust.afterUninstall` ('restart' when it declares none, and when it is a function of the process, which a
 *  manifest cannot hold: Hermes). With `trust.untilEnviron` (Kimi), only a process whose environment names that variable at a file of asight's is
 *  reported at all. */
export function livenessOf(d, { agentList = [], os = null } = {}) {
  const t = d.trust || {}
  // proxy mode (4.11 §2.3; `os` given = the model's install): the routes of this OS's forms say it as data — a route that `rereads` is read again
  // by a running process (any process alive at off_at may hold it); `perRequest`, read on every request (the next one after off goes direct, so
  // none holds it) — only when EVERY form here routes that way, else one more holder, never one less (holders.mjs)
  const pm = os && d.proxyMode ? d.proxyMode : null
  const routes = pm ? pm.forms.filter((f) => f.os.includes(os)).map((f) => pm.routes[f.route] || {}) : []
  return {
    // `ignore` items are not applied: they stop capture, not trust — the entry is per harness, so an ignored name still loads its bundle and must
    // stay a holder for `off` (D50; off's withAgentList adds only the additions too)
    identity: serializeSignature(compileAll(new Map([[d.name, d]]), (agentList || []).filter((e) => !e.ignore)).get(d.name)),
    rereads: !!t.rereadsEntry || routes.some((r) => r.rereads === true),
    ...(routes.length && routes.every((r) => r.perRequest === true) ? { per_request: true } : {}),
    until: typeof t.afterUninstall === 'string' ? t.afterUninstall : 'restart',
    ...(typeof t.untilEnviron === 'string' ? { until_environ: t.untilEnviron } : {}),
  }
}

// The presets with the user's entries merged in (mergeAgentList), for the registered harnesses only. An `ignore` that drops a name also drops it
// from the exclude items that named it (an item left naming nothing could never hold: a helper is excluded only under one of its harness's names).
// A user's item the compiler refuses is dropped here, alone: readAgentList reports it as that item's problem (agent-list-invalid), and one bad item must
// never stop the registry — the daemon's start, `on`'s liveness, the 5 s swap — for the presets and the good items (4.6 R6, D38).
const compiles = (h, e) => { try { compileIdentity({ harness: h, names: [e.args == null ? { name: e.name } : { name: e.name, args: e.args }] }); return true } catch { return false } }

function compileAll(byName, entries) {
  const presets = Object.fromEntries([...byName.values()].map((d) => [d.name, d.processes]))
  const merged = mergeAgentList(presets, (entries || []).filter((e) => byName.has(e.harness) && (e.ignore || compiles(e.harness, e))))
  const out = new Map()
  for (const [h, m] of Object.entries(merged)) {
    if (!byName.has(h)) continue
    const left = new Set(m.names.map((n) => n.name))
    const exclude = (m.exclude || []).flatMap((x) => {
      if (x.name == null) return [x]
      const names = (Array.isArray(x.name) ? x.name : [x.name]).filter((n) => left.has(n))
      return names.length ? [{ ...x, name: names }] : []
    })
    out.set(h, compileIdentity({ harness: h, names: m.names, exclude, longLived: m.longLived || [] }))
  }
  return out
}

/** whoseBy(match, get?) → (facts) → match's answer shape: whose process this is. A host-tree door already said (`facts.hostAgent`: the editor carrying the
 *  harness's extension, named by the form's hosts.processes, 4.8 §3) — that harness, as a match; else the name list (`match`). With `get` (name →
 *  descriptor) a hostAgent no descriptor has falls back to the list. The one place this rule is written: the tracker, its rejudge, the doors, the entry check. */
export function whoseBy(match, get = null) {
  return (facts) => {
    const h = facts && facts.hostAgent
    if (h && (!get || get(h))) return { agent: h, descriptor: get ? get(h) : null, reason: 'match' }
    return match(facts)
  }
}

export function createRegistry(descriptors, { agentList = [] } = {}) {
  const byName = new Map()
  for (const d of descriptors) {
    validateDescriptor(d)
    if (byName.has(d.name)) throw new Error(`harness descriptor ${d.name} registered twice`)
    byName.set(d.name, d)
  }
  let lists = compileAll(byName, agentList)

  /** Swap the user's list in place (D51③: agents.json changed): every closure over `match` sees the new lists at once. */
  function replaceAgentList(entries) { lists = compileAll(byName, entries) }

  function match(facts) {
    const view = identityView(facts)
    const unknownArgs = PENDING.has(facts && facts.cmdlineState)
    const claims = []
    let excludedBy = null, argsMiss = false, pending = false
    for (const [h, sig] of lists) {
      if (!sig.match.some((p) => holds(p.names, view.names))) continue
      if (unknownArgs) {
        // the command line is not known yet: whether an item's args hold, whether an exclusion (args, name0) holds and which Chromium process it is
        // (core/trust/confirm.mjs chromium-child, every harness) all read it, so a name on this list is not yet an answer — only an exclusion that
        // reads no argv (env) may already hold (review R17; 4.8 W78: not cached, the next connection asks again)
        if (anyOf(sig.exclude.filter((x) => !READS_ARGV(x)), view)) excludedBy = excludedBy || h
        else pending = true
        continue
      }
      let claimed = false
      for (const p of sig.match) if (holds(p.names, view.names) && argsHold(p, view)) { claimed = true; break }
      if (anyOf(sig.exclude, view)) { excludedBy = excludedBy || h; continue }
      if (claimed) claims.push(h)
      else argsMiss = true
    }
    if (claims.length === 1) return { agent: claims[0], descriptor: byName.get(claims[0]), reason: 'match' }
    if (claims.length > 1) return { agent: null, descriptor: null, reason: 'ambiguous', candidates: claims }
    if (pending) return { agent: null, descriptor: null, reason: 'pending' }
    if (excludedBy) return { agent: null, descriptor: null, reason: 'excluded', harness: excludedBy }
    return { agent: null, descriptor: null, reason: argsMiss ? 'args-mismatch' : 'no-match' }
  }

  // Which harnesses COULD claim a process whose exe (and env) cannot be read, judged on what is readable (review B-1, 4.6 `exe-unreadable`): the
  // name comes from argv[0] alone, `args` from the rest; an exclude item excludes when it holds on those facts (one that needs the environment
  // cannot hold: env is unreadable here). → [harness names]
  function couldMatch(facts) {
    const view = identityView({ os: facts.os, argv: facts.argv, exe: null, env: null })
    const out = []
    for (const [h, sig] of lists) {
      if (!sig.match.some((p) => holds(p.names, view.names) && argsHold(p, view))) continue
      if (anyOf(sig.exclude, view)) continue
      out.push(h)
    }
    return out
  }

  const isLongLived = (d, facts) => { const sig = lists.get(d.name); return !!sig && anyOf(sig.longLived, identityView(facts)) }

  const get = (name) => byName.get(name) || null
  return { match, whose: whoseBy(match, get), couldMatch, isLongLived, replaceAgentList, get, names: () => [...byName.keys()] }
}
