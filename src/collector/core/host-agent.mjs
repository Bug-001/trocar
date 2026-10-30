// host-agent.mjs — the host-tree rule, written once (RFC 4.8 §3, D51): a form that declares `hosts.processes` names the host program (an editor that
// carries a harness's extension) whose process is that harness's carrier. The name list does not name a host program (it is not the agent); this rule
// does, and it is passed on as `facts.hostAgent`, which whoseBy (registry.mjs) honours before the list. Its three readers ask it here: the door core
// (only for the door the connection came through, with the door's own host-set check on top), the win32 entry check and the win32 network facts.
// It names no harness and no OS: the groups (`[{ harness, forms: [{ hosts? }] }]`, the arch's groupsOf, or one door) are handed in.
// Beside it, hostSetOf: WHICH hosts of such a form's connections are the harness's (4.8 §3, OPEN 22's set, 4.11 ⑫), moved here verbatim from the deleted
// core/route-plan.mjs; the model collector's default host set for a hostTree form (core/proxymode/collector.mjs, over the descriptor's configHosts).
import { normalizeName, processNames } from '../../off/identity.mjs'
import { whoseBy } from './registry.mjs'
import { bypassRuleOf } from './upstream-shape.mjs'

/** Whether this form's `hosts.processes` names this process (its exe or argv[0], normalized the one way names are, normalizeName). */
export function hostsProcess(form, facts) {
  const names = processNames(facts || {})
  return names.length > 0 && ((form && form.hosts && form.hosts.processes) || []).some((n) => names.includes(normalizeName(String(n))))
}

/** The form whose `hosts.processes` names this process (hostsProcess) → { harness, form }, or null:
 *  no form hosts it, or forms of two harnesses do (never a guess, 0.1 §5). Two forms of one harness hosting it: the first. */
export function hostFormOf(groups, facts) {
  let hit = null
  for (const x of groups || []) {
    for (const f of (x && x.forms) || []) {
      if (!hostsProcess(f, facts)) continue
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

// ---- the host set of a host-tree form (4.8 §3, OPEN 22) -------------------------------------------------------------------------------------------------

// What the kernel's rule `DOMAIN-SUFFIX,<host>` can meet. Three kinds of name cannot: a name the generator refuses (its own check, asked through `bypassRuleOf`, so there is no copy of its pattern here); a numeric dotted quad (an address,
// or something that cannot be a name): the rule never matches a connection to an address literal; and the name `localhost`: the kernel's own hosts table has made it 127.0.0.1 by the time its rules run, so the name is gone (4.8 §3 末,
// measured on the re-entry path; OPEN 28). Each of them would be a line that looks like capture and is none, so each is said (`dropped`) and not written.
const NUMERIC_QUAD = /^\d+(\.\d+){3}$/
function matchable(name) {
  if (NUMERIC_QUAD.test(name) || name.replace(/\.$/, '') === 'localhost') return false
  try { bypassRuleOf({ kind: 'domain', value: name }); return true } catch { return false }
}

/**
 * hostSetOf({ form, readSettings, extraHosts }) → { hosts: [name], settings: 'read' | 'absent' | { unreadable: { reason, detail? } }, dropped: [name] }
 * The hosts whose connections a host-tree form (an editor that carries many extensions, whose proxy setting sends them all to the form's port) hands to the engine; every other connection of the editor is only forwarded (4.8 §3).
 * The set is the form's default hosts (its harness file), then the base-URL hosts found in the extension's own settings (`form.hosts.settings.hostsOf` over the text `readSettings()` gives: `{ text, error }`, the shape of the
 * ctx's `readTextOrError`; read-only, `on` and `status` both call this), then `extraHosts` (the operator's, state.json): each name once, lower case, in that order. A settings file that is not there is `'absent'` (nothing configured: not a failure);
 * one that cannot be read or parsed is `{ unreadable: { reason } }` (`denied` · `unparseable`, 1.6 §9.4; `detail` the errno, never a path) and the set is then the other two sources, which the caller says (D38).
 * `dropped` are the names the kernel's rule cannot meet or the generator refuses (an address literal, the name `localhost`, a wildcard, a port, a character the generator refuses): said, never written, never thrown — no input of the user's makes `on` fail.
 * A relay on this machine, configured by an address or by `localhost`, is therefore not captured by this form (4.8 OPEN 28): `dropped` and `status` are the label that says so.
 */
export function hostSetOf({ form, readSettings, extraHosts = [] } = {}) {
  const spec = form && form.hosts
  if (!spec || !Array.isArray(spec.defaults)) throw new TypeError('hostSetOf needs a form with a host set (hosts.defaults)')
  if (spec.settings && typeof readSettings !== 'function') throw new TypeError('hostSetOf needs readSettings for a form whose own settings it reads')
  let settings = 'absent'
  let found = []
  if (spec.settings) {
    let r
    try { r = readSettings() } catch (e) { r = { text: null, error: { code: e && e.code } } }
    if (r && r.error) settings = { unreadable: { reason: 'denied', ...(r.error.code ? { detail: String(r.error.code) } : {}) } }
    else if (r && typeof r.text === 'string') {
      try {
        const list = spec.settings.hostsOf(r.text)
        if (!Array.isArray(list)) throw new TypeError('hostsOf gave no list')
        found = list
        settings = 'read'
      } catch { settings = { unreadable: { reason: 'unparseable' } } }
    }
  }
  const hosts = []
  const dropped = []
  for (const h of [...spec.defaults, ...found, ...(extraHosts || [])]) {
    const name = typeof h === 'string' ? h.trim().toLowerCase() : ''
    if (name === '') continue
    const into = matchable(name) ? hosts : dropped
    if (!into.includes(name)) into.push(name)
  }
  return { hosts, settings, dropped }
}
