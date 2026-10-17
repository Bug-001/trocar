// host-agent.mjs — the host-tree rule, written once (RFC 4.8 §3, D51): a form that declares `hosts.processes` names the host program (an editor that
// carries a harness's extension) whose process is that harness's carrier. The name list does not name a host program (it is not the agent); this rule
// does, and it is passed on as `facts.hostAgent`, which whoseBy (registry.mjs) honours before the list. Its three readers ask it here: the door core
// (only for the door the connection came through, with the door's own host-set check on top), the win32 entry check and the win32 network facts.
// It names no harness and no OS: the groups (`[{ harness, forms: [{ hosts? }] }]`, the arch's groupsOf, or one door) are handed in.
import { normalizeName, processNames } from '../../off/identity.mjs'
import { whoseBy } from './registry.mjs'

/** The form whose `hosts.processes` names this process (its exe or argv[0], normalized the one way names are, normalizeName) → { harness, form }, or null:
 *  no form hosts it, or forms of two harnesses do (never a guess, 0.1 §5). Two forms of one harness hosting it: the first. */
export function hostFormOf(groups, facts) {
  const names = processNames(facts || {})
  if (!names.length) return null
  let hit = null
  for (const x of groups || []) {
    for (const f of (x && x.forms) || []) {
      const hosts = (f && f.hosts && f.hosts.processes) || []
      if (!hosts.some((n) => names.includes(normalizeName(String(n))))) continue
      if (hit && hit.harness !== x.harness) return null
      if (!hit) hit = { harness: x.harness, form: f }
    }
  }
  return hit
}

/** The harness hosting this process (hostFormOf), or null. */
const hostAgentOf = (groups, facts) => (hostFormOf(groups, facts) || {}).harness ?? null

/** whoseBy over the name list with the host-tree rule applied first: (facts) → match's answer shape. A facts that already carries `hostAgent` keeps it. */
export function whoseWithHosts(identify, groups, get = null) {
  const whose = whoseBy(identify, get)
  return (facts) => {
    if (facts && facts.hostAgent) return whose(facts)
    const h = hostAgentOf(groups, facts)
    return whose(h ? { ...facts, hostAgent: h } : facts)
  }
}
