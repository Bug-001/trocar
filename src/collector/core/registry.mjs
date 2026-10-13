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
//   pending        a command line not known yet (win32 cmdlineState pending / cim-backoff) and an item with that name needs `args`
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
 *  第 2 / 5 步; manifest `liveness.<harness>`): `identity`, the harness's name list compiled — its presets with the user's `agentList` items for it
 *  merged in (the same on every OS, D51) — as JSON; whether the harness re-reads its entry while running; and until when a running one still trusts
 *  asight after `off` — the data form of `trust.afterUninstall` ('restart' when it declares none, and when it is a function of the process, which a
 *  manifest cannot hold: Hermes). With `trust.untilEnviron` (Kimi), only a process whose environment names that variable at a file of asight's is
 *  reported at all. */
export function livenessOf(d, { agentList = [] } = {}) {
  const t = d.trust || {}
  return {
    identity: serializeSignature(compileAll(new Map([[d.name, d]]), agentList).get(d.name)),
    rereads: !!t.rereadsEntry,
    until: typeof t.afterUninstall === 'string' ? t.afterUninstall : 'restart',
    ...(typeof t.untilEnviron === 'string' ? { until_environ: t.untilEnviron } : {}),
  }
}

// The presets with the user's entries merged in (mergeAgentList), for the registered harnesses only. An `ignore` that drops a name also drops it
// from the exclude items that named it (an item left naming nothing could never hold: a helper is excluded only under one of its harness's names).
function compileAll(byName, entries) {
  const presets = Object.fromEntries([...byName.values()].map((d) => [d.name, d.processes]))
  const merged = mergeAgentList(presets, (entries || []).filter((e) => byName.has(e.harness)))
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
      let named = false, claimed = false, waits = false
      for (const p of sig.match) {
        if (!holds(p.names, view.names)) continue
        named = true
        if (!p.rest) { claimed = true; break }
        if (unknownArgs) { waits = true; continue }
        if (holds(p.rest, view.rest)) { claimed = true; break }
      }
      if (!named) continue
      if (anyOf(sig.exclude, view)) { excludedBy = excludedBy || h; continue }
      if (claimed) claims.push(h)
      else if (waits) pending = true
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
      if (!sig.match.some((p) => holds(p.names, view.names) && (!p.rest || holds(p.rest, view.rest)))) continue
      if (anyOf(sig.exclude, view)) continue
      out.push(h)
    }
    return out
  }

  const isLongLived = (d, facts) => { const sig = lists.get(d.name); return !!sig && anyOf(sig.longLived, identityView(facts)) }

  return { match, couldMatch, isLongLived, replaceAgentList, get: (name) => byName.get(name) || null, names: () => [...byName.keys()] }
}
