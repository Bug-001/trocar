// schema.mjs — what `--json` prints (RFC 1.6 R5), and the check V9 runs over every command's output. The keys and the exit codes
// are src/off/schema.mjs (the undo side prints receipts too and may import nothing outside src/off); this adds validateReceipt.
import { SCHEMA_VERSION, EXIT, RECEIPT_KEYS, newReceipt } from '../off/schema.mjs'
import { HARNESS_IDS } from './harness-names.mjs'
import { STATUS_REASONS, NET_CODES } from '../health/codes.mjs'
import { FINDING_CODES } from '../netenv/findings.mjs' // the finding codes' own closed list: the cross-platform catalogue's, the Windows table's (4.8 §10.4) and the trust reasons' — one list, one place

export { SCHEMA_VERSION, EXIT, RECEIPT_KEYS, newReceipt }

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isString = (v) => typeof v === 'string'
const isCount = (v) => Number.isInteger(v) && v >= 0

/** Runs `check(item, 'key[i]')` over the list `r[key]`; a key that is there but not a list is a problem (a missing one is reported by the caller). */
function listOf(r, key, bad, check) {
  const list = r[key]
  if (!Array.isArray(list)) { if (key in r) bad.push(`${key}: not a list`); return }
  list.forEach((item, i) => check(item, `${key}[${i}]`))
}

/** created / removed / undo: a path or command as a non-empty string, or an object of the command's own shape (`{path, …}`). */
const stringOrObject = (bad) => (item, at) => {
  if (!((isString(item) && item !== '') || isObject(item))) bad.push(`${at}: neither a non-empty string nor an object`)
}

/** Every `harness` field, and every `harnesses` list, anywhere under `v`, must hold canonical ids (R5: harness 印代码 id). */
function checkHarnessIds(v, at, bad, seen) {
  if (v === null || typeof v !== 'object' || seen.has(v)) return
  seen.add(v)
  if (Array.isArray(v)) { v.forEach((item, i) => checkHarnessIds(item, `${at}[${i}]`, bad, seen)); return }
  for (const [k, x] of Object.entries(v)) {
    const here = at ? `${at}.${k}` : k
    if (k === 'harness' && !HARNESS_IDS.includes(x)) bad.push(`${here}: ${JSON.stringify(x)} is not a harness id (the code id is printed, never an alias)`)
    else if (k === 'harnesses' && Array.isArray(x)) x.forEach((id, i) => { if (isString(id) && !HARNESS_IDS.includes(id)) bad.push(`${here}[${i}]: ${JSON.stringify(id)} is not a harness id`) })
    checkHarnessIds(x, here, bad, seen)
  }
}

/** Problems with a receipt object against R5 (`[]` = valid). Extra keys are allowed: R5 lists the least a receipt has. */
export function validateReceipt(r) {
  if (!isObject(r)) return ['receipt: not an object']
  const bad = []
  for (const key of RECEIPT_KEYS) if (!(key in r)) bad.push(`${key}: missing`)
  if ('schema' in r && r.schema !== SCHEMA_VERSION) bad.push(`schema: ${JSON.stringify(r.schema)}, expected the integer ${SCHEMA_VERSION}`)
  if ('command' in r && !(isString(r.command) && r.command !== '')) bad.push('command: not a non-empty string')
  if ('ok' in r && typeof r.ok !== 'boolean') bad.push('ok: not a boolean')
  listOf(r, 'changed', bad, (c, at) => {
    if (!isObject(c)) { bad.push(`${at}: not an object {path, change, backup}`); return }
    if (!isString(c.path)) bad.push(`${at}.path: not a string`)
    if (!isString(c.change)) bad.push(`${at}.change: not a string`)
    if (!(c.backup === null || isString(c.backup))) bad.push(`${at}.backup: neither a path nor null`)
  })
  listOf(r, 'created', bad, stringOrObject(bad))
  listOf(r, 'removed', bad, stringOrObject(bad))
  listOf(r, 'skipped', bad, (s, at) => {
    if (!isObject(s)) { bad.push(`${at}: not an object {what, reason}`); return }
    if (!isString(s.what)) bad.push(`${at}.what: not a string`)
    if (!isString(s.reason)) bad.push(`${at}.reason: not a string`)
  })
  listOf(r, 'restart', bad, (p, at) => {
    if (!isObject(p)) { bad.push(`${at}: not an object {harness, pid}`); return }
    if (!Number.isInteger(p.pid)) bad.push(`${at}.pid: not an integer`)
    // the harness id is checked for every `harness` key below; here it only has to be there
    if (!('harness' in p)) bad.push(`${at}.harness: missing`)
  })
  listOf(r, 'undo', bad, stringOrObject(bad))
  if ('relayed' in r && r.relayed !== 'unknown') {
    if (!isObject(r.relayed)) bad.push('relayed: neither "unknown" nor {closing, waiting, cut}')
    else for (const k of ['closing', 'waiting', 'cut']) if (!isCount(r.relayed[k])) bad.push(`relayed.${k}: not a non-negative integer`)
  }
  if ('log' in r && !(r.log === null || isString(r.log))) bad.push('log: neither a path nor null')
  if ('linger' in r && !(r.linger === true || r.linger === false || r.linger === 'unknown')) bad.push('linger: not true, false or "unknown"')
  checkHarnessIds(r, '', bad, new WeakSet())
  return bad
}

// ── the network topology (RFC 1.6 §9.4: `status --json` key `topology`, the board's `/api/capture-health` `netenv.topology`) ──────────────────────────────────────────────────────────────────────────
// The closed sets are written here once, so the Windows branch (4.8 §10) adds none: its proxy-mode values (`routing: 'proxy'`, `asight-forwarder`, `forward`, `branches[].form`, the edge's `asight` /
// `entry`, `env-unreadable`) are already members.
/** How the platform steers an agent's connections to asight (D43: one mode per platform; there is no `mixed`). */
export const ROUTING = Object.freeze(['driver', 'proxy', 'legacy', 'none', 'unknown'])
export const TOPOLOGY_KINDS = Object.freeze(['agent', 'proxy', 'asight-engine', 'asight-forwarder', 'legacy-mitm', 'upstream', 'egress', 'unknown'])
export const TOPOLOGY_VIA = Object.freeze(['direct', 'proxy-http', 'proxy-socks', 'proxy-https', 'system-proxy', 'tun', 'ebpf', 'forward', 'egress', 'unknown'])
/** Why a hop is 「不知道」 (R11: a hop that could not be read is said, with its reason, never left out and never 「无」). */
export const UNKNOWN_REASONS = Object.freeze(['denied', 'timeout', 'absent', 'unparseable', 'owner-unreadable', 'pac', 'controller-unreadable', 'kernel-filter-invisible', 'env-unreadable'])
export const BRANCH_NAMES = Object.freeze(['all', 'http', 'ws'])
/** What a running process's line says about it: it still goes by the setting it started with, or asight is not on its path. */
export const RUNNING_NOTES = Object.freeze(['start-time-settings', 'not-steered'])
export const FINDING_CLASSES = Object.freeze(['failure', 'expected', 'hint'])

const TRI = [true, false, null]
const isId = (v) => typeof v === 'string' && v !== ''

/** Problems with the `topology` object of `status --json` (`{ <harness>: HarnessTopology }`) against 1.6 §9.4 (V43; `[]` = valid): closed sets, every edge between existing nodes, the first node of a path and of
 *  an off_path the agent, no node twice on a path, the verdicts true / false / null with a reason from the status reasons. */
export function validateTopology(t) {
  if (!isObject(t)) return ['topology: not an object']
  const bad = []
  for (const [h, x] of Object.entries(t)) {
    const at = `topology.${h}`
    if (!HARNESS_IDS.includes(h)) bad.push(`${at}: ${JSON.stringify(h)} is not a harness id`)
    if (!isObject(x)) { bad.push(`${at}: not an object`); continue }
    if (!ROUTING.includes(x.routing)) bad.push(`${at}.routing: ${JSON.stringify(x.routing)} is not one of ${ROUTING.join(' ')}`)
    for (const k of ['on_path', 'captured']) if (!TRI.includes(x[k])) bad.push(`${at}.${k}: not true, false or null`)
    if (!(x.reason === null || STATUS_REASONS.includes(x.reason))) bad.push(`${at}.reason: ${JSON.stringify(x.reason)} is not null or a status reason`)
    const nodes = new Map()
    const unknownOf = (o, where) => { if (o.unknown !== undefined && !(isObject(o.unknown) && UNKNOWN_REASONS.includes(o.unknown.reason))) bad.push(`${where}.unknown.reason: ${JSON.stringify(o.unknown && o.unknown.reason)} is not in the closed set`) }
    if (!Array.isArray(x.nodes) || !x.nodes.length) bad.push(`${at}.nodes: not a list with a node in it`)
    else x.nodes.forEach((n, i) => {
      const w = `${at}.nodes[${i}]`
      if (!isObject(n) || !isId(n.id)) { bad.push(`${w}: no id`); return }
      if (nodes.has(n.id)) bad.push(`${w}: id ${n.id} twice`)
      nodes.set(n.id, n)
      if (!TOPOLOGY_KINDS.includes(n.kind)) bad.push(`${w}.kind: ${JSON.stringify(n.kind)} is not in the closed set`)
      if (!isId(n.name)) bad.push(`${w}.name: empty`)
      if (n.kind === 'proxy' && !(Number.isInteger(n.port) || n.unknown)) bad.push(`${w}: a proxy node has a port`)
      unknownOf(n, w)
    })
    if (!Array.isArray(x.edges)) bad.push(`${at}.edges: not a list`)
    else x.edges.forEach((e, i) => {
      const w = `${at}.edges[${i}]`
      if (!isObject(e) || !nodes.has(e.from) || !nodes.has(e.to)) bad.push(`${w}: from / to is not a node of this topology`)
      else {
        if (!TOPOLOGY_VIA.includes(e.via)) bad.push(`${w}.via: ${JSON.stringify(e.via)} is not in the closed set`)
        unknownOf(e, w)
        if (e.entry !== undefined && !(isObject(e.entry) && isId(e.entry.where) && typeof e.entry.opt_in === 'boolean' && e.asight === true)) bad.push(`${w}.entry: needs { where, opt_in } and asight: true`)
      }
    })
    if (!Array.isArray(x.branches) || !x.branches.length) bad.push(`${at}.branches: not a list with a branch in it`)
    else x.branches.forEach((b, i) => {
      const w = `${at}.branches[${i}]`
      if (!isObject(b) || !BRANCH_NAMES.includes(b.name)) bad.push(`${w}.name: not one of ${BRANCH_NAMES.join(' ')}`)
      if (isObject(b) && b.form !== undefined && !isId(b.form)) bad.push(`${w}.form: not a form id`)
      for (const key of ['path', 'off_path']) {
        const list = isObject(b) ? b[key] : null
        if (!Array.isArray(list) || !list.length) { bad.push(`${w}.${key}: not a list with a node in it`); continue }
        const missing = list.filter((id) => !nodes.has(id))
        if (missing.length) bad.push(`${w}.${key}: ${missing.join(', ')} is not a node`)
        else if (nodes.get(list[0]).kind !== 'agent') bad.push(`${w}.${key}: the first node is not the agent`)
        if (new Set(list).size !== list.length) bad.push(`${w}.${key}: a node is on the path twice`)
      }
      for (const k of ['on_path', 'captured']) if (isObject(b) && !TRI.includes(b[k])) bad.push(`${w}.${k}: not true, false or null`)
      if (isObject(b) && !(b.reason === null || STATUS_REASONS.includes(b.reason))) bad.push(`${w}.reason: ${JSON.stringify(b.reason)} is not null or a status reason`)
    })
    if (x.findings !== undefined && !(Array.isArray(x.findings) && x.findings.every((c) => FINDING_CODES.includes(c)))) bad.push(`${at}.findings: not a list of finding codes`) // FINDING_CODES, findings.mjs's own one list: the cross-platform catalogue ∪ the Windows table (4.8 §10.4) ∪ the trust reasons (the Windows collector's ROUTE_TRUST_REASONS included)
    if (x.running !== undefined) {
      if (!Array.isArray(x.running)) bad.push(`${at}.running: not a list`)
      else x.running.forEach((r, i) => {
        const w = `${at}.running[${i}]`
        if (!isObject(r) || !Number.isInteger(r.pid) || !RUNNING_NOTES.includes(r.note)) bad.push(`${w}: needs pid and a note of ${RUNNING_NOTES.join(' | ')}`)
        else if (!Array.isArray(r.path) || r.path.some((id) => !nodes.has(id))) bad.push(`${w}.path: not a list of nodes`)
      })
    }
  }
  return bad
}

export const SHELLS = Object.freeze(['sh', 'powershell', 'gui'])
/** Problems with one finding of `doctor --json` (1.6 §9.6, V49; `[]` = valid): a code, a class, a what and a why that say something, every command a whole line with its shell and no `<…>` left to fill in, a verify.
 *  A failure or an expected finding has at least one command; a hint may have none. */
export function validateFinding(f) {
  if (!isObject(f)) return ['finding: not an object']
  const bad = []
  if (!FINDING_CODES.includes(f.code)) bad.push(`code: ${JSON.stringify(f.code)} is not a finding code`) // the same list the topology's findings use (findings.mjs's FINDING_CODES, 4.8 §10.4's codes in it)
  if (!FINDING_CLASSES.includes(f.class)) bad.push(`class: ${JSON.stringify(f.class)} is not one of ${FINDING_CLASSES.join(' ')}`)
  if (f.harness !== undefined && !HARNESS_IDS.includes(f.harness)) bad.push(`harness: ${JSON.stringify(f.harness)} is not a harness id`)
  for (const k of ['what', 'why', 'verify']) if (!isString(f[k]) || f[k].trim() === '') bad.push(`${k}: empty`)
  if (!Array.isArray(f.commands)) bad.push('commands: not a list')
  else {
    if (f.class !== 'hint' && f.commands.length === 0) bad.push('commands: a failure or an expected finding says what to do')
    f.commands.forEach((c, i) => {
      if (!isObject(c) || !isString(c.run) || c.run.trim() === '') bad.push(`commands[${i}].run: empty`)
      else if (/<[^<>\n]+>/.test(c.run)) bad.push(`commands[${i}].run: has a <…> placeholder left`)
      if (isObject(c) && !SHELLS.includes(c.shell)) bad.push(`commands[${i}].shell: not one of ${SHELLS.join(' ')}`)
    })
  }
  return bad
}

// ---- the opt-in items of `status --json` (1.6 §9.4's `opt_in`, §1.7; V56's second half, V64) ------------------------------------------------------------

export const OPTIN_STATES = Object.freeze(['needed', 'done', 'broken', 'pending-admin', 'needs-admin', 'unknown'])
/** The codes a state may carry (§9.4): `needed` names the one it is, `broken` says which way it broke, `needs-admin` names itself; the rest carry null. */
const OPTIN_CODES = Object.freeze({ needed: ['opt-in-needed'], broken: ['shim-not-on-path', 'entry-changed', 'not-via-entry'], 'needs-admin': ['needs-admin'] })

/** The opt-in rows the arch's `optIn.plan` hook returns (planOptIns' own: one row per form and item, carrying the item's kinds and impact) as
 *  `status --json`'s `opt_in` (§9.4, V56/V64): one object per (form, kind), the item's state on each of its kinds. `status` renders what it is
 *  given and adds no second truth: `implies` is the plan's own impact line, `enable` the row's own command, `undo` the agent's switch — there is
 *  no per-entry undo (§1.7「界面上没有按条撤销」). A row whose `when` does not hold (`applicable: false`) is not a thing to name. */
export function optInOf(rows) {
  const out = {}
  for (const r of rows || []) {
    if (!isObject(r) || r.applicable === false) continue
    for (const kind of Array.isArray(r.kinds) ? r.kinds : []) {
      ;(out[r.harness] || (out[r.harness] = [])).push({
        form: r.form, kind,
        scope: r.scope, admin: r.scope === 'machine',
        state: r.state,
        code: r.state === 'needed' ? 'opt-in-needed' : r.state === 'needs-admin' ? r.code ?? 'needs-admin' : r.code ?? null,
        reason: r.state === 'unknown' ? r.reason ?? null : null,
        implies: r.impact,
        enable: r.command,
        undo: `asight off ${r.harness}`,
        elevated: r.elevated ?? null, // the fallback line alone, when there is no prompt to pop; null on a machine that has one (§1.7)
      })
    }
  }
  return out
}

/** The entry check's findings folded into the plan's own rows (1.6 §1.7「入口还有没有效」: `status` re-verifies the entries every time it is
 *  asked, and these are the same rows — no second truth). A finding with a code turns its (form, item) row `broken` with that code; one without
 *  (a check that could not be told) turns it `unknown` with a reason of the closed set above; a broken finding outranks an unknown one. Only
 *  `done` rows take a finding — needed, pending-admin and never are not in effect, and a `done` row whose entry the check saw nothing wrong with
 *  stays `done`. The row also carries the finding's `detail` (which PATH entry won, which shortcut now starts what, which pids went around the
 *  entry) for the facts' own readers — doctor's steps of §9.6 are exactly that sentence; `optInOf` keeps the §9.4 object to the spec's fields. */
export function applyEntryCheck(rows, findings) {
  if (!Array.isArray(rows) || !Array.isArray(findings) || !findings.length) return rows
  const at = new Map()
  for (const f of findings) {
    if (!f || !f.form || !f.item) continue
    const prev = at.get(`${f.form}|${f.item}`)
    if (!prev || (!prev.code && f.code)) at.set(`${f.form}|${f.item}`, f) // broken outranks unknown
  }
  if (!at.size) return rows
  return rows.map((r) => {
    const f = r && at.get(`${r.form}|${r.item}`)
    if (!f || r.state !== 'done') return r
    return { ...r, ...(f.code ? { state: 'broken', code: f.code } : { state: 'unknown', code: null, reason: f.reason }), detail: f.detail }
  })
}

/** Problems with the `opt_in` object of `status --json` (`{ <harness>: [item] }`) against 1.6 §9.4 (`[]` = valid): closed sets, the code that goes
 *  with the state, admin exactly when the scope is machine, the enable line whole (it names the form), the undo the agent's switch and nothing else. */
export function validateOptIn(o) {
  if (!isObject(o)) return ['opt_in: not an object']
  const bad = []
  for (const [h, list] of Object.entries(o)) {
    const at = `opt_in.${h}`
    if (!HARNESS_IDS.includes(h)) bad.push(`${at}: ${JSON.stringify(h)} is not a harness id`)
    if (!Array.isArray(list)) { bad.push(`${at}: not a list`); continue }
    list.forEach((x, i) => {
      const w = `${at}[${i}]`
      if (!isObject(x)) { bad.push(`${w}: not an object`); return }
      if (!isId(x.form)) bad.push(`${w}.form: empty`)
      if (!isId(x.kind)) bad.push(`${w}.kind: empty`)
      if (x.scope !== 'user' && x.scope !== 'machine') bad.push(`${w}.scope: ${JSON.stringify(x.scope)} is not user or machine`)
      else if (x.admin !== (x.scope === 'machine')) bad.push(`${w}: admin: true exactly when the scope is machine`)
      if (!OPTIN_STATES.includes(x.state)) bad.push(`${w}.state: ${JSON.stringify(x.state)} is not one of ${OPTIN_STATES.join(' ')}`)
      else {
        const allowed = OPTIN_CODES[x.state] || [null]
        if (!allowed.includes(x.code)) bad.push(`${w}.code: ${JSON.stringify(x.code)} does not go with state "${x.state}" (${allowed.join(' | ')})`)
      }
      if (x.code !== null && !Object.values(OPTIN_CODES).flat().includes(x.code)) bad.push(`${w}.code: ${JSON.stringify(x.code)} is not in the closed set`)
      if (x.state === 'unknown') { if (!(isString(x.reason) && UNKNOWN_REASONS.includes(x.reason))) bad.push(`${w}.reason: not an unknown reason of ${UNKNOWN_REASONS.join(' ')}`) }
      else if (x.reason !== null) bad.push(`${w}.reason: not null (only the unknown state has one)`)
      if (!isString(x.implies) || x.implies.trim() === '') bad.push(`${w}.implies: empty`)
      if (!isString(x.enable) || !new RegExp(`^asight on ${h} --opt-in \\S+$`).test(x.enable)) bad.push(`${w}.enable: the whole line that names the form`)
      if (x.undo !== `asight off ${h}`) bad.push(`${w}.undo: ${JSON.stringify(x.undo)} is the agent's switch and nothing else (asight off ${h})`)
      if (!(x.elevated === null || isId(x.elevated))) bad.push(`${w}.elevated: neither null nor a whole line`)
    })
  }
  return bad
}
