// route-plan.mjs — which groups get a proxy entry, and what each one's upstream and bypass table are (RFC 4.8 §2.2, §2.3, §3.5; acceptance W5, W72).
//
// `upstream.mjs` answers one group at a time from the facts it is handed; this file hands it those facts for every group of every harness — the user's own proxy (the manifest once asight has written the entry,
// else the file the agent reads), the system proxy and the login environment as they were read, asight's own ports — and puts the answers beside the gates that decide whether the entry is written
// (`forms.mjs`): the harness is on, the user named an opt-in form, the upstream is something asight can dial. It reads, through the ctx it is given, the files the agents read; it writes nothing, opens no socket
// and names no harness: the groups and forms it is given are the harness files' data (arch/ never imports harness/, the daemon hands them in).
import { parseDotenv, parseJsonc } from '../../core/config-read.mjs'
import { bypassRuleOf } from '../../../netenv/mihomo/rules.mjs'
import { entryGate } from './forms.mjs'
import { proxyAuthOf, upstreamFor } from './upstream.mjs'

/** The Windows groups of the harness descriptors (`loadHarnesses()`), flat: `[{ g, harness, group, forms, proxy }]` — `group` is the harness file's group (entry, auth, optIn, followsSystemProxy), `forms` the forms in it,
 *  `proxy` the harness's proxy behaviour (the variables it reads, its branches). A form with no group (one that was not measured) is in none. A descriptor with no Windows data gives none. */
export function groupsOf(descriptors) {
  const out = []
  for (const d of descriptors || []) {
    const w = d && d.win32
    if (!w) continue
    for (const group of w.groups || []) out.push({ g: group.g, harness: d.name, group, forms: (w.forms || []).filter((f) => f.g === group.g), proxy: w.proxy })
  }
  return out
}

// ---- the user's own proxy: the entry's value before asight (4.8 §2.2 ①) ---------------------------------------------------------------------------------

const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const none = { value: null, noProxy: null }
// A Windows path is the same path in either slash and any case: the journal records the path as `files(ctx)` gave it at install, and a later ctx may spell it otherwise.
const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase()
const getIn = (data, keys) => keys.reduce((cur, k) => (cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? cur[k] : undefined), data)
const sameKeys = (a, b) => Array.isArray(a) && a.length === b.length && a.every((k, i) => k === b[i])

/** Is this manifest row the record of the proxy entry `e` that `harness` has (not the trust entry of the same file: that one has other keys or other variables)? */
const isProxyRecord = (rec, e, harness) => !!rec && typeof rec === 'object' && rec.harness === harness && typeof rec.path === 'string'
  && (e.format === 'json-key' ? sameKeys(rec.keys, e.key) : rec.kind === 'text' && rec.format === 'dotenv-block' && rec.vars != null && Object.hasOwn(rec.vars, e.block.urlVar))

/** The manifest's records of this harness's proxy entry, one per file, the OLDEST (the manifest keeps them in the order asight wrote them: the first holds what the user had, a later one holds asight's own earlier address): a Map from
 *  the normalised path to the record. Which files these are does not depend on any `files(ctx)`: that list follows the env of whoever asks (CODEX_HOME, CLAUDE_CONFIG_DIR, a running codex), and the install shell's is not the daemon's. */
function recordsOf(manifest, e, harness) {
  const out = new Map()
  for (const rec of (manifest && Array.isArray(manifest.entries) ? manifest.entries : [])) {
    if (isProxyRecord(rec, e, harness) && !out.has(norm(rec.path))) out.set(norm(rec.path), rec)
  }
  return out
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
export function priorOf({ harness, group, ctx, manifest = null } = {}) {
  if (!group || typeof group !== 'object' || !group.proxyEntry) throw new TypeError('priorOf needs the group')
  if (typeof harness !== 'string' || harness === '') throw new TypeError("priorOf needs the group's harness: the manifest's records say which harness wrote them, and two harnesses have the same kind of entry")
  if (!ctx || typeof ctx.readTextOrError !== 'function') throw new TypeError('priorOf needs the ctx (readTextOrError) that says where the files are')
  const e = group.proxyEntry
  if (e.kind !== 'file') return { ...none, source: null }
  const records = recordsOf(manifest, e, harness)
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
 * read (`readHkcuEnv`). The text goes through `proxyAuthOf`, the one place a proxy's credentials are read from. null is every way of not finding it (a reference of another shape, a group that is not
 * there, a file that cannot be read, a text with no login): the caller decides what that means, and it is never a guess. The result is a secret: for the kernel config and for nothing that prints or records.
 */
export function resolveLogin(ref, { groups = [], ctx, manifest = null, hkcuEnv = null } = {}) {
  const m = /^(prior|hkcu-env):(.+)$/.exec(typeof ref === 'string' ? ref : '')
  if (!m) return null
  let text = null
  if (m[1] === 'prior') {
    const x = groups.find((y) => y.g === m[2])
    if (!x) return null
    try { text = priorOf({ harness: x.harness, group: x.group, ctx, manifest }).value } catch { return null }
  } else if (hkcuEnv && hkcuEnv.ok && hkcuEnv.values) text = hkcuEnv.values[m[2]]
  return typeof text === 'string' ? proxyAuthOf(text) : null
}

// ---- the plan (4.8 §2.1 · §2.2 · §2.3) -------------------------------------------------------------------------------------------------------------------

/** The part of an upstream answer that says where it dials, with no `hint` and no table: what the daemon compares with the group's previous one, and what `status` draws. No credentials: `auth_ref` says where they live. */
const dialOf = (a) => (a.kind ? Object.fromEntries(['kind', 'host', 'port', 'credentialed', 'auth_ref', 'source'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) : null)

/** What the running processes say about the forms: `procs` is `[{ pid, match, elevated }]`, `match` the answer of `matchForm` for that process. An elevated process of a known form is a fact about that form (the kernel cannot tell it
 *  from another process of the same user and only forwards it, 4.8 §10.2 row h); a process of an image only an agent has, at a path nobody measured, could be any form of that image, so each of them carries its path shape (already
 *  masked of the user's name by `matchForm`). A form whose command line is not known yet (`pending`) and a process that is no agent are nothing yet. `elevated` that is not `true` (null: not readable) is not counted. */
function observe(procs) {
  const seen = new Map()
  const at = (id) => { if (!seen.has(id)) seen.set(id, { elevated: new Set(), unknown: new Set() }); return seen.get(id) }
  for (const p of procs || []) {
    const m = p && p.match
    if (!m) continue
    if (m.kind === 'form' && p.elevated === true && Number.isInteger(p.pid)) at(m.id).elevated.add(p.pid)
    else if (m.kind === 'path-unknown') for (const id of m.forms || []) at(id).unknown.add(m.shape)
  }
  return seen
}

/**
 * planRoutes({ netenv, groups, desired, optIns, manifest, ctx, procs, last }) → { [group id]: result } (4.8 §2.2, §2.3; W5)
 *   netenv    the network as it was read now: `{ systemProxy, hkcuEnv, ownPorts }` — `readSystemProxy()`'s answer, `readHkcuEnv()`'s, and asight's own ports (the kernel's listeners, the engine's, the controller's: an
 *             upstream on one is a loop; REQUIRED, a plan that cannot see a loop is not a plan). Not 4.7's `netenv.json`: that does not copy `ProxyOverride`, and the bypass table is made of it.
 *   groups    `groupsOf(descriptors)` · desired  `state.json` v2's `harnesses` (`{ <harness>: { desired: 'on' | 'off' } }`, or the string): a harness not in it is off
 *   optIns    the groups or forms the user named (`--opt-in`) and asight has the record of · manifest the install manifest (`priorOf`) · ctx where the files are (`priorOf`)
 *   procs     what is running, `[{ pid, match, elevated }]` (`observe`)
 *   last      the plan before, `{ [group id]: that group's result }` (planRoutes' own return value will do): what a system proxy that became a PAC or unreadable leaves a follower on (4.8 OPEN 17). Only a group whose result then
 *             had `on: true` has an upstream to stay on: the `answer` of a group that was off or not routed is what it would have dialled, not what it did, and `asight on` after the user moved to a PAC must not connect it to a hop they no longer use
 * A group's result: `{ g, harness, entry, on, reason, code?, why?, detail?, protocol?, upstream, bypass, untranslated, envUnreadable, egressDiffers?, hint?, unknown?, forms, answer }`
 *   entry     'auto' (asight writes it: a file of the agent's own), 'opt-in' (the user named it), or null (no entry: `reason` says why) · on  the group's forms go through the engine (entry is not null), which is what the kernel's
 *             `on` is · reason  the first that holds of `desired-off` · `opt-in-needed` · `not-routed` (`why`: `system-proxy-pac` · `system-proxy-unreadable` · `upstream-protocol` (`protocol`) · `upstream-unparseable`) · `route-loop`
 *             (`detail`: the address) · `form-unsupported`; null when the group is connected. `code` is the doctor's name for it (`proxy-unsupported` for an `upstream-protocol`).
 *   upstream  where the group's connections go on from, `{ kind, host?, port?, credentialed?, auth_ref?, source }`, or null when there is none to dial. It is worked out for a group that is off as well: the kernel forwards to it
 *             what an agent that outlives `off` sends. `bypass` the targets that hop is left direct for, `untranslated` how many entries asight could not read, `egressDiffers` (a connected group whose WebSocket did not follow the
 *             system proxy), `hint` (`system-proxy-pac` / `system-proxy-unreadable`: kept on the last upstream), `unknown` what could not be read (1.6 §9.4's reasons), `envUnreadable` (a proxy in the user's terminal alone is invisible).
 *   forms     `{ [form id]: { reason, elevatedPids?, unknownPaths? } }` — the group's reason for each form, else `elevated-agent` or `form-path-unknown` when a process says so
 *   answer    the raw `upstreamFor` answer, with the bypass table and without any login: what the next call keeps from `last[g]` (when the group is `on`), and what is compared to know whether the system proxy moved the group's upstream
 * Nothing here writes. The order of the reasons is the order in which a user can act: switch the harness on, name the item, fix the proxy, and only then the entry that takes no login.
 */
export function planRoutes({ netenv, groups, desired = null, optIns = [], manifest = null, ctx, procs = [], last = null } = {}) {
  if (!Array.isArray(groups)) throw new TypeError('planRoutes needs the groups (groupsOf)')
  if (!netenv || typeof netenv !== 'object') throw new TypeError('planRoutes needs the network as it was read: { systemProxy, hkcuEnv, ownPorts }')
  if (!Array.isArray(netenv.ownPorts)) throw new TypeError("planRoutes needs asight's own ports (netenv.ownPorts): without them a loop cannot be seen")
  if (!ctx) throw new TypeError('planRoutes needs the ctx that says where the files are')
  const named = new Set(optIns || [])
  const wanted = (h) => { const d = desired && desired[h]; return (typeof d === 'string' ? d : d && d.desired) === 'on' }
  const seen = observe(procs)
  const stayOn = (g) => { // the answer a group that WAS connected is left on; a group that was off or not routed has none, whoever passes `last`
    const prev = last && last[g]
    if (prev == null) return null
    if (typeof prev !== 'object' || typeof prev.on !== 'boolean') throw new TypeError("planRoutes `last` is the previous result of each group (the return value of planRoutes), not its upstream answer: whether the group was connected is in the result")
    return prev.on ? prev.answer || null : null
  }
  const out = {}
  for (const { g, harness, group, forms, proxy } of groups) {
    const prior = priorOf({ harness, group, ctx, manifest })
    const answer = upstreamFor({ group, prior: prior.value, noProxy: prior.noProxy, systemProxy: netenv.systemProxy, hkcuEnv: netenv.hkcuEnv, ownPorts: netenv.ownPorts, envNames: (proxy && proxy.env) || [], branches: (proxy && proxy.branches) || [], last: stayOn(g) })
    const gate = entryGate(group, { optedIn: named.has(g) || forms.some((f) => named.has(f.id)), upstreamCredentialed: answer.credentialed === true })
    let reason = null
    let why = {}
    if (!wanted(harness)) reason = 'desired-off'
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
        const own = s && s.elevated.size ? 'elevated-agent' : s && s.unknown.size ? 'form-path-unknown' : null
        return [f.id, { reason: reason ?? own, ...(s && s.elevated.size ? { elevatedPids: [...s.elevated].sort((a, b) => a - b) } : {}), ...(s && s.unknown.size ? { unknownPaths: [...s.unknown].sort() } : {}) }]
      })),
      answer,
    }
  }
  return out
}

// ---- the host set of a host-tree form (4.8 §3.5, OPEN 22) -------------------------------------------------------------------------------------------------

// What the kernel's rule `DOMAIN-SUFFIX,<host>` can meet. Three kinds of name cannot: a name the generator refuses (its own check, asked through `bypassRuleOf`, so there is no copy of its pattern here); a numeric dotted quad (an address,
// or something that cannot be a name): the rule never matches a connection to an address literal; and the name `localhost`: the kernel's own hosts table has made it 127.0.0.1 by the time its rules run, so the name is gone (4.8 §3.1 末,
// measured on the re-entry path; OPEN 28). Each of them would be a line that looks like capture and is none, so each is said (`dropped`) and not written.
const NUMERIC_QUAD = /^\d+(\.\d+){3}$/
function matchable(name) {
  if (NUMERIC_QUAD.test(name) || name.replace(/\.$/, '') === 'localhost') return false
  try { bypassRuleOf({ kind: 'domain', value: name }); return true } catch { return false }
}

/**
 * hostSetOf({ form, readSettings, extraHosts }) → { hosts: [name], settings: 'read' | 'absent' | { unreadable: { reason, detail? } }, dropped: [name] }
 * The hosts whose connections a host-tree form (an editor that carries many extensions, whose proxy setting sends them all to the form's port) hands to the engine; every other connection of the editor is only forwarded (4.8 §3.5).
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
