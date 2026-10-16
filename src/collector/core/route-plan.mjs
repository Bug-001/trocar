// route-plan.mjs — which groups get a proxy entry, and what each one's upstream and bypass table are (RFC 4.8 §2.2 · §2.3 · §3, carried by 4.9 §1 · §2.1 · §2.2;
// acceptance W5, W72, MA6's plan half). The one copy for both proxy-mode arches: `arch/<os>/route-plan.mjs` is `routePlanOf` called with what its OS has —
//   os           the descriptor field its data is under (`d.win32`, which the loader attaches; macOS has no overlay)
//   norm         when two spellings are the same path (Windows: either slash, any case; darwin: any case — APFS is case-insensitive by default): the journal records
//                the path as `files(ctx)` gave it at install, and a later ctx may spell it otherwise
//   upstreamFor  its upstream rule (`arch/<os>/upstream.mjs`): what it reads of the network is its own (Windows' login environment; darwin has none — a proxy set only
//                in the user's terminal gets 4.8 §2.2's cannot-read-your-terminal hint, `envUnreadable`)
//   proxyAuthOf  the one place a proxy text's credentials are read from (the same file)
//
// The arch's `upstream.mjs` answers one group at a time from the facts it is handed; this file hands it those facts for every group of every harness — the user's own proxy
// (the manifest once asight has written the entry, else the file the agent reads), the network as the arch read it, asight's own ports — and puts the answers beside the
// gates that decide whether the entry is written (`entry-forms.mjs`): the harness is on, the user named an opt-in form, the upstream is something asight can dial. It reads,
// through the ctx it is given, the files the agents read; it writes nothing, opens no socket and names no harness or OS: the groups and forms it is given are the harness
// files' data (the daemon hands them in). Beside the plan sit the four small rules both wirings ask of it (`isDesiredOn` · `movedRoute` · `optedInOf` · `carriedOf`).
import { parseDotenv, parseJsonc } from './config-read.mjs'
import { bypassRuleOf } from './upstream-shape.mjs'
import { entryGate } from './entry-forms.mjs'

/** routePlanOf({ os, norm, upstreamFor, proxyAuthOf }) → `{ groupsOf, priorOf, proxyRecordsOf, resolveLogin, planRoutes, hostSetOf }`, the arch's route-plan (the header). */
export function routePlanOf(arch) {
  const { os, norm, upstreamFor, proxyAuthOf } = arch || {}
  if (typeof os !== 'string' || typeof norm !== 'function' || typeof upstreamFor !== 'function' || typeof proxyAuthOf !== 'function') throw new TypeError('routePlanOf needs the arch\'s os, norm, upstreamFor and proxyAuthOf')
  return {
    groupsOf: (descriptors) => groupsOf(descriptors, os),
    priorOf: (o) => priorOf(o, arch),
    resolveLogin: (ref, o) => resolveLogin(ref, o, arch),
    planRoutes: (o) => planRoutes(o, arch),
    proxyRecordsOf, hostSetOf,
  }
}

/** The arch's groups of the harness descriptors (`loadHarnesses()`), flat: `[{ g, harness, group, forms, proxy }]` — `group` is the harness file's group (entry, auth, optIn, followsSystemProxy), `forms` the forms in it,
 *  `proxy` the harness's proxy behaviour (the variables it reads, its branches). A form with no group (one that was not measured) is in none. A descriptor with no data for `os` gives none. */
function groupsOf(descriptors, os) {
  const out = []
  for (const d of descriptors || []) {
    const w = d && d[os]
    if (!w) continue
    for (const group of w.groups || []) out.push({ g: group.g, harness: d.name, group, forms: (w.forms || []).filter((f) => f.g === group.g), proxy: w.proxy })
  }
  return out
}

// ---- the rules both wirings ask (4.8 §2.2 · §3; 4.9 §2.2 · §6.4) ------------------------------------------------------------------------------------------

/** Is this harness on? `desired` is `state.json` v2's `harnesses` (`{ <harness>: { desired: 'on' | 'off' } }`, or the bare string): a harness not in it is off. The plan's
 *  `desired-off` and the door's `isOn` are this one question. */
export const isDesiredOn = (desired, harness) => { const d = desired && desired[harness]; return (typeof d === 'string' ? d : d && d.desired) === 'on' }

/** Whether a re-plan moved this group in a way the doors and the entries must be told: its upstream, its bypass table, or on/off (4.8 §2.2, carried by 4.9 §2.2: a change whose
 *  recomputed answers equal the group's `last` reloads nothing — a system-proxy read that timed out and the read back are two changes with the same upstream). */
export const movedRoute = (a, b) => !a || !b || a.on !== b.on || JSON.stringify(a.upstream ?? null) !== JSON.stringify(b.upstream ?? null) || JSON.stringify(a.bypass ?? null) !== JSON.stringify(b.bypass ?? null)

/** The manifest's opt-in records of one group's forms (`x` a `groupsOf` row). Confirmed only: an entry whose write failed is re-offered, not treated as in effect (planOptIns' own 'done' rule). */
const optinRecordsOf = (m, x) => (m && Array.isArray(m.entries) ? m.entries : []).filter((e) => e && typeof e.kind === 'string' && e.kind.startsWith('optin-') && e.confirmed !== false && e.harness === x.harness && x.forms.some((f) => f.id === e.form))

/** The groups and forms the manifest says the user named (its `optin-*` records): what a re-plan treats as opted in when the caller brought no list of its own — so a daemon that
 *  restarts after `on … --opt-in <form>` still re-plans that group as on (4.9 §6.4's wiring arm, 2026-10-12). */
export const optedInOf = (groups, m) => groups.filter((x) => optinRecordsOf(m, x).length > 0).flatMap((x) => [x.g, ...x.forms.map((f) => f.id)])

/** The groups a door is carried for while off (audit F7): installed once (a proxy-entry record) or opted in (the opt-in's own record — the desktop launcher's arm, 4.9 §6.4). */
export const carriedOf = (groups, m) => new Set(groups.filter((x) => proxyRecordsOf(m, x.group, x.harness).length > 0 || optinRecordsOf(m, x).length > 0).map((x) => x.g))

// ---- the user's own proxy: the entry's value before asight (4.8 §2.2 ①) ---------------------------------------------------------------------------------

const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const none = { value: null, noProxy: null }
const getIn = (data, keys) => keys.reduce((cur, k) => (cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? cur[k] : undefined), data)
const sameKeys = (a, b) => Array.isArray(a) && a.length === b.length && a.every((k, i) => k === b[i])

/** Is this manifest row the record of the proxy entry `e` that `harness` has (not the trust entry of the same file: that one has other keys or other variables)? */
const isProxyRecord = (rec, e, harness) => !!rec && typeof rec === 'object' && rec.harness === harness && typeof rec.path === 'string'
  && (e.format === 'json-key' ? sameKeys(rec.keys, e.key) : rec.kind === 'text' && rec.format === 'dotenv-block' && rec.vars != null && Object.hasOwn(rec.vars, e.block.urlVar))

/** The manifest's records of this harness's proxy entry, one per file, the OLDEST (the manifest keeps them in the order asight wrote them: the first holds what the user had, a later one holds asight's own earlier address): a Map from
 *  the normalised path to the record. Which files these are does not depend on any `files(ctx)`: that list follows the env of whoever asks (CODEX_HOME, CLAUDE_CONFIG_DIR, a running codex), and the install shell's is not the daemon's. */
function recordsOf(manifest, e, harness, norm) {
  const out = new Map()
  for (const rec of (manifest && Array.isArray(manifest.entries) ? manifest.entries : [])) {
    if (isProxyRecord(rec, e, harness) && !out.has(norm(rec.path))) out.set(norm(rec.path), rec)
  }
  return out
}

/** The manifest's records of this group's PROXY entry (4.8 §2.3), in the manifest's order: what the entries writer undoes (Task 8(c)) and what says a group is installed for the kernel's `carried` list (audit F7).
 *  `group` is the group as the harness file declares it (the `group` of a `groupsOf` row), `harness` its harness: found by harness and entry — the same rule `priorOf` reads by — never the trust entry of the same file
 *  (other keys, other variables), never a record of another harness. An entry kind that is not a file (a policy value, a shim: Task 14's) has none. */
function proxyRecordsOf(manifest, group, harness) {
  if (!group || typeof group !== 'object' || !group.proxyEntry) throw new TypeError('proxyRecordsOf needs the group (the harness file\'s group, with its proxyEntry)')
  if (group.proxyEntry.kind !== 'file') return []
  return (manifest && Array.isArray(manifest.entries) ? manifest.entries : []).filter((rec) => isProxyRecord(rec, group.proxyEntry, harness))
}

/** What the journal recorded as the value asight put out of effect: a string for a JSON key, `{ VAR: value }` for a dotenv block. Anything else is that the user had none. */
function fromRecord(rec, group) {
  const p = rec.prior_value
  if (group.proxyEntry.format === 'json-key') return { value: text(p), noProxy: null }
  const o = p !== null && typeof p === 'object' ? p : {}
  return { value: text(o[group.proxyEntry.block.urlVar]), noProxy: group.noProxyKey ? text(o[group.noProxyKey]) : null }
}

/** One entry file as it is now: `{ value, noProxy }`, or `{ unknown }` when it is there and cannot be read or understood (never folded into "none", D38; the reason has no path in it: a user name may be). */
function readLive(group, ctx, file) {
  const { text: body, error } = ctx.readTextOrError(file)
  if (error) return { unknown: { what: 'agent-proxy', reason: 'denied', detail: String((error && error.code) || 'error') } }
  if (body == null) return none
  const e = group.proxyEntry
  if (e.format === 'json-key') {
    const { data, errors } = parseJsonc(body)
    if (errors || data === null) return { unknown: { what: 'agent-proxy', reason: 'unparseable' } }
    return { value: text(getIn(data, e.key)), noProxy: null }
  }
  const vars = parseDotenv(body)
  return { value: text(vars.get(e.block.urlVar)), noProxy: group.noProxyKey ? text(vars.get(group.noProxyKey)) : null }
}

/**
 * priorOf({ harness, group, ctx, manifest }) → { value, noProxy, source: 'manifest' | 'file' | null, unknown?: [{ what: 'agent-proxy', reason, detail? }] }
 * The proxy the agent has in this group's entry before asight (4.8 §2.2 ①): the text of it (`value`) and of its NO_PROXY (`noProxy`, for a group whose harness names that key). Asight's own entry replaces the
 * value in the file, so for every file the manifest holds a record of the entry in (the journal's `prior_value`) that is the answer, even a null one (the user had none, and the file now holds asight's own address);
 * a file with no record is read as it is. The records are looked up by harness and entry, NOT by `files(ctx)`: that list follows the env of the process that asks, and the daemon that re-plans is not the shell that ran `on`.
 * The records come first, in the order the manifest holds them (the order asight wrote them), then the files of `files(ctx)` that have none, in the order the group lists them; the first that has a proxy answers.
 * A file that cannot be read or parsed is `unknown` with a reason from 1.6 §9.4's closed set, and the others are still read.
 * `value` MAY CARRY THE USER'S CREDENTIALS (`http://user:password@host`): it is for `upstreamFor` and for whoever resolves its `auth_ref` (`proxyAuthOf`), and for nothing that prints or records.
 * Only a group whose entry is a file asight writes (`proxyEntry.kind:'file'`) has a prior here: the entry of an opt-in item (a policy value, a shim, a launcher, an app setting) is recorded by the step that writes it (Task 14).
 */
function priorOf({ harness, group, ctx, manifest = null } = {}, { norm }) {
  if (!group || typeof group !== 'object' || !group.proxyEntry) throw new TypeError('priorOf needs the group')
  if (typeof harness !== 'string' || harness === '') throw new TypeError("priorOf needs the group's harness: the manifest's records say which harness wrote them, and two harnesses have the same kind of entry")
  if (!ctx || typeof ctx.readTextOrError !== 'function') throw new TypeError('priorOf needs the ctx (readTextOrError) that says where the files are')
  const e = group.proxyEntry
  if (e.kind !== 'file') return { ...none, source: null }
  const records = recordsOf(manifest, e, harness, norm)
  const live = []
  for (const file of e.files(ctx)) if (!records.has(norm(file)) && !live.some((f) => norm(f) === norm(file))) live.push(file)
  let source = null
  const unknown = []
  for (const { rec, file } of [...[...records.values()].map((rec) => ({ rec })), ...live.map((file) => ({ file }))]) {
    const got = rec ? fromRecord(rec, group) : readLive(group, ctx, file)
    if (got.unknown) { unknown.push(got.unknown); continue }
    if (rec) source = 'manifest'
    if (got.value) return { value: got.value, noProxy: got.noProxy, source: rec ? 'manifest' : 'file', ...(unknown.length ? { unknown } : {}) }
  }
  return { ...none, source, ...(unknown.length ? { unknown } : {}) }
}

/**
 * resolveLogin(ref, { groups, ctx, manifest, hkcuEnv }) → `{ username, password }` | null: the login an upstream answer's `auth_ref` names (4.8 §2.2). `prior:<group>` is the user's proxy text of that group
 * (`priorOf`, the manifest's prior_value once asight has written the entry, so the first `on` and every later one give one answer); `hkcu-env:<NAME>` is that value of the login environment as it was
 * read (Windows' `readHkcuEnv`; darwin has no login-environment registry and hands none, so there such a reference is a way of not finding it, 4.9 §1). The text goes through `proxyAuthOf`, the one place a proxy's credentials are read from. null is every way of not finding it (a reference of another shape, a group that is not
 * there, a file that cannot be read, a text with no login): the caller decides what that means, and it is never a guess. The result is a secret: for the kernel config and for nothing that prints or records.
 */
function resolveLogin(ref, { groups = [], ctx, manifest = null, hkcuEnv = null } = {}, arch) {
  const m = /^(prior|hkcu-env):(.+)$/.exec(typeof ref === 'string' ? ref : '')
  if (!m) return null
  let text = null
  if (m[1] === 'prior') {
    const x = groups.find((y) => y.g === m[2])
    if (!x) return null
    try { text = priorOf({ harness: x.harness, group: x.group, ctx, manifest }, arch).value } catch { return null }
  } else if (hkcuEnv && hkcuEnv.ok && hkcuEnv.values) text = hkcuEnv.values[m[2]]
  return typeof text === 'string' ? arch.proxyAuthOf(text) : null
}

// ---- the plan (4.8 §2.1 · §2.2 · §2.3) -------------------------------------------------------------------------------------------------------------------

/** The part of an upstream answer that says where it dials, with no `hint` and no table: what the daemon compares with the group's previous one, and what `status` draws. No credentials: `auth_ref` says where they live. */
const dialOf = (a) => (a.kind ? Object.fromEntries(['kind', 'host', 'port', 'credentialed', 'auth_ref', 'source'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) : null)

/** What the running processes say about the forms: `procs` is the door's `[{ pid, agent, names, door, elevated }]` (core/engine/door-redirector.mjs procs()).
 *  An elevated process is a fact about the forms of the door group it came through, when that group is its own harness's (4.8 §10.2 row h: the door
 *  cannot tell it from another process of the same user and only forwards it); an agent at another harness's door says nothing about that door's forms.
 *  `elevated` that is not `true` (null: not readable) is not counted. The name list decides who a process is (D51), so no path shape is reported here. */
function observe(procs, groups) {
  const seen = new Map()
  const at = (id) => { if (!seen.has(id)) seen.set(id, { elevated: new Set() }); return seen.get(id) }
  const byG = new Map((groups || []).map((x) => [x.g, x]))
  for (const p of procs || []) {
    const x = p && byG.get(p.door)
    if (!x || x.harness !== p.agent || p.elevated !== true || !Number.isInteger(p.pid)) continue
    for (const f of x.forms) at(f.id).elevated.add(p.pid)
  }
  return seen
}

/**
 * planRoutes({ netenv, groups, desired, optIns, manifest, ctx, procs, last }) → { [group id]: result } (4.8 §2.2, §2.3; W5)
 *   netenv    the network as it was read now: `{ systemProxy, hkcuEnv?, ownPorts }` — the arch's `readSystemProxy()` answer, Windows' `readHkcuEnv()` (darwin has none), and asight's own ports (the kernel's
 *             listeners, the engine's, the controller's: an upstream on one is a loop; REQUIRED, a plan that cannot see a loop is not a plan). Not 4.7's `netenv.json`: that does not copy the bypass list, and the
 *             bypass table is made of it. The whole of it goes to the arch's `upstreamFor`, which takes the facts its OS has.
 *   groups    `groupsOf(descriptors)` · desired  `state.json` v2's `harnesses` (`{ <harness>: { desired: 'on' | 'off' } }`, or the string): a harness not in it is off
 *   optIns    the groups or forms the user named (`--opt-in`) and asight has the record of · manifest the install manifest (`priorOf`) · ctx where the files are (`priorOf`)
 *   procs     what the doors met, `[{ pid, agent, names, door, elevated }]` (`observe`)
 *   last      the plan before, `{ [group id]: that group's result }` (planRoutes' own return value will do): what a system proxy that became a PAC or unreadable leaves a follower on (4.8 OPEN 17). Only a group whose result then
 *             had `on: true` has an upstream to stay on: the `answer` of a group that was off or not routed is what it would have dialled, not what it did, and `asight on` after the user moved to a PAC must not connect it to a hop they no longer use
 * A group's result: `{ g, harness, entry, on, reason, code?, why?, detail?, protocol?, upstream, bypass, untranslated, envUnreadable, egressDiffers?, hint?, unknown?, forms, answer }`
 *   entry     'auto' (asight writes it: a file of the agent's own), 'opt-in' (the user named it), or null (no entry: `reason` says why) · on  the group's forms go through the engine (entry is not null), which is what the kernel's
 *             `on` is · reason  the first that holds of `desired-off` · `opt-in-needed` · `not-routed` (`why`: `system-proxy-pac` · `system-proxy-unreadable` · `upstream-protocol` (`protocol`) · `upstream-unparseable`) · `route-loop`
 *             (`detail`: the address) · `form-unsupported`; null when the group is connected. `code` is the doctor's name for it (`proxy-unsupported` for an `upstream-protocol`).
 *   upstream  where the group's connections go on from, `{ kind, host?, port?, credentialed?, auth_ref?, source }`, or null when there is none to dial. It is worked out for a group that is off as well: the kernel forwards to it
 *             what an agent that outlives `off` sends. `bypass` the targets that hop is left direct for, `untranslated` how many entries asight could not read, `egressDiffers` (a connected group whose WebSocket did not follow the
 *             system proxy), `hint` (`system-proxy-pac` / `system-proxy-unreadable`: kept on the last upstream), `unknown` what could not be read (1.6 §9.4's reasons), `envUnreadable` (a proxy in the user's terminal alone is invisible).
 *   forms     `{ [form id]: { reason, elevatedPids? } }` — the group's reason for each form, else `elevated-agent` when a process says so
 *   answer    the raw `upstreamFor` answer, with the bypass table and without any login: what the next call keeps from `last[g]` (when the group is `on`), and what is compared to know whether the system proxy moved the group's upstream
 * Nothing here writes. The order of the reasons is the order in which a user can act: switch the harness on, name the item, fix the proxy, and only then the entry that takes no login.
 */
function planRoutes({ netenv, groups, desired = null, optIns = [], manifest = null, ctx, procs = [], last = null } = {}, arch) {
  if (!Array.isArray(groups)) throw new TypeError('planRoutes needs the groups (groupsOf)')
  if (!netenv || typeof netenv !== 'object') throw new TypeError('planRoutes needs the network as it was read (netenv: the system proxy and asight\'s own ports)')
  if (!Array.isArray(netenv.ownPorts)) throw new TypeError("planRoutes needs asight's own ports (netenv.ownPorts): without them a loop cannot be seen")
  if (!ctx) throw new TypeError('planRoutes needs the ctx that says where the files are')
  const named = new Set(optIns || [])
    const seen = observe(procs, groups)
  const stayOn = (g) => { // the answer a group that WAS connected is left on; a group that was off or not routed has none, whoever passes `last`
    const prev = last && last[g]
    if (prev == null) return null
    if (typeof prev !== 'object' || typeof prev.on !== 'boolean') throw new TypeError("planRoutes `last` is the previous result of each group (the return value of planRoutes), not its upstream answer: whether the group was connected is in the result")
    return prev.on ? prev.answer || null : null
  }
  const out = {}
  for (const { g, harness, group, forms, proxy } of groups) {
    const prior = priorOf({ harness, group, ctx, manifest }, arch)
    const answer = arch.upstreamFor({ group, prior: prior.value, noProxy: prior.noProxy, systemProxy: netenv.systemProxy, hkcuEnv: netenv.hkcuEnv, ownPorts: netenv.ownPorts, envNames: (proxy && proxy.env) || [], branches: (proxy && proxy.branches) || [], last: stayOn(g) })
    const gate = entryGate(group, { optedIn: named.has(g) || forms.some((f) => named.has(f.id)), upstreamCredentialed: answer.credentialed === true })
    let reason = null
    let why = {}
    if (!isDesiredOn(desired, harness)) reason = 'desired-off'
    else if (!gate.ok && gate.reason === 'opt-in-needed') reason = 'opt-in-needed'
    else if (answer.reason) {
      reason = answer.reason
      why = answer.reason === 'route-loop' ? { detail: `${answer.host}:${answer.port}` } : Object.fromEntries(['why', 'detail', 'protocol'].filter((k) => answer[k] !== undefined).map((k) => [k, answer[k]]))
    } else if (!gate.ok) reason = gate.reason
    const entry = reason ? null : group.optIn && group.optIn.length ? 'opt-in' : 'auto'
    const unknown = [...(answer.unknown || []), ...(prior.unknown || [])]
    out[g] = {
      g, harness, entry, on: entry !== null, reason,
      ...(reason ? { code: reason === 'not-routed' && why.why === 'upstream-protocol' ? 'proxy-unsupported' : reason } : {}), ...why,
      upstream: dialOf(answer), bypass: answer.bypass, untranslated: answer.untranslated, envUnreadable: answer.envUnreadable,
      ...(answer.egressDiffers && entry !== null ? { egressDiffers: true } : {}), ...(answer.hint ? { hint: answer.hint } : {}), ...(unknown.length ? { unknown } : {}),
      forms: Object.fromEntries(forms.map((f) => {
        const s = seen.get(f.id)
        const own = s && s.elevated.size ? 'elevated-agent' : null
        return [f.id, { reason: reason ?? own, ...(s && s.elevated.size ? { elevatedPids: [...s.elevated].sort((a, b) => a - b) } : {}) }]
      })),
      answer,
    }
  }
  return out
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
function hostSetOf({ form, readSettings, extraHosts = [] } = {}) {
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
