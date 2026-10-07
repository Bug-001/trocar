// route-plan.mjs — which groups get a proxy entry, and what each one's upstream and bypass table are (RFC 4.8 §2.2, §2.3, §3.5; acceptance W5, W72).
//
// `upstream.mjs` answers one group at a time from the facts it is handed; this file hands it those facts for every group of every harness — the user's own proxy (the manifest once asight has written the entry,
// else the file the agent reads), the system proxy and the login environment as they were read, asight's own ports — and puts the answers beside the gates that decide whether the entry is written
// (`forms.mjs`): the harness is on, the user named an opt-in form, the upstream is something asight can dial. It reads, through the ctx it is given, the files the agents read; it writes nothing, opens no socket
// and names no harness: the groups and forms it is given are the harness files' data (arch/ never imports harness/, the daemon hands them in).
import { parseDotenv, parseJsonc } from '../../core/config-read.mjs'

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
// A Windows path is the same path in either slash and any case; the journal records the path as the group's `files(ctx)` gave it, and the same call gives it back.
const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase()
const getIn = (data, keys) => keys.reduce((cur, k) => (cur !== null && typeof cur === 'object' && !Array.isArray(cur) ? cur[k] : undefined), data)
const sameKeys = (a, b) => Array.isArray(a) && a.length === b.length && a.every((k, i) => k === b[i])

/** The manifest's record of this group's proxy entry in this file, or null: the entry asight wrote there (not the trust entry of the same file: that one has other keys or other variables). */
function recordOf(manifest, e, file) {
  for (const rec of (manifest && Array.isArray(manifest.entries) ? manifest.entries : [])) {
    if (!rec || typeof rec.path !== 'string' || norm(rec.path) !== norm(file)) continue
    if (e.format === 'json-key') { if (sameKeys(rec.keys, e.key)) return rec } else if (rec.kind === 'text' && rec.format === 'dotenv-block' && rec.vars && Object.hasOwn(rec.vars, e.block.urlVar)) return rec
  }
  return null
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
 * priorOf({ group, ctx, manifest }) → { value, noProxy, source: 'manifest' | 'file' | null, unknown?: [{ what: 'agent-proxy', reason, detail? }] }
 * The proxy the agent has in this group's entry before asight (4.8 §2.2 ①): the text of it (`value`) and of its NO_PROXY (`noProxy`, for a group whose harness names that key). Asight's own entry replaces the
 * value in the file, so once the manifest holds a record of the entry (the journal's `prior_value`) that is the answer, even a null one (the user had none, and the file now holds asight's own address); a file
 * with no record is read as it is. With several files (one per Codex home, per Hermes profile) the first that has a proxy answers, in the order the group lists its files. A file that cannot be read or parsed
 * is `unknown` with a reason from 1.6 §9.4's closed set, and the others are still read.
 * `value` MAY CARRY THE USER'S CREDENTIALS (`http://user:password@host`): it is for `upstreamFor` and for whoever resolves its `auth_ref` (`proxyAuthOf`), and for nothing that prints or records.
 * Only a group whose entry is a file asight writes (`proxyEntry.kind:'file'`) has a prior here: the entry of an opt-in item (a policy value, a shim, a launcher, an app setting) is recorded by the step that writes it (Task 14).
 */
export function priorOf({ group, ctx, manifest = null } = {}) {
  if (!group || typeof group !== 'object' || !group.proxyEntry) throw new TypeError('priorOf needs the group')
  if (!ctx || typeof ctx.readTextOrError !== 'function') throw new TypeError('priorOf needs the ctx (readTextOrError) that says where the files are')
  const e = group.proxyEntry
  if (e.kind !== 'file') return { ...none, source: null }
  let source = null
  const unknown = []
  for (const file of e.files(ctx)) {
    const rec = recordOf(manifest, e, file)
    const got = rec ? fromRecord(rec, group) : readLive(group, ctx, file)
    if (got.unknown) { unknown.push(got.unknown); continue }
    if (rec) source = 'manifest'
    if (got.value) return { value: got.value, noProxy: got.noProxy, source: rec ? 'manifest' : 'file', ...(unknown.length ? { unknown } : {}) }
  }
  return { ...none, source, ...(unknown.length ? { unknown } : {}) }
}
