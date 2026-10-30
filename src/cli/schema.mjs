// schema.mjs — what `--json` prints (RFC 1.6 R5), and the check V9 runs over every command's output. The keys and the exit codes
// are src/off/schema.mjs (the undo side prints receipts too and may import nothing outside src/off); this adds validateReceipt.
import { SCHEMA_VERSION, EXIT, RECEIPT_KEYS, UNDO_LINE, newReceipt } from '../off/schema.mjs'
import { HARNESS_IDS } from '../off/harness-names.mjs'
import { STATUS_REASONS, NET_CODES } from '../health/codes.mjs'
import { FINDING_CODES } from '../netenv/findings.mjs' // the finding codes' own closed list: the cross-platform catalogue's, the Windows table's (4.8 §10.4) and the trust reasons' — one list, one place

export { SCHEMA_VERSION, EXIT, RECEIPT_KEYS, UNDO_LINE, newReceipt }

/** 附录 C.2: besides the common keys of C.1, the keys each state-changing command's receipt may carry — the list a reader of 附录 C writes a client against.
 *  A receipt with a key outside its list is drift (tested 2026-10-18: thirteen keys 附录 C named nowhere), so `validateReceipt` reports it.
 *  C.2's table and this object name the same keys (test/cli/schema.test.mjs). */
export const COMMAND_KEYS = Object.freeze({
  install: Object.freeze(['fp256', 'items', 'carriers', 'harnesses', 'pending', 'standalone', 'commands', 'residual_risk', 'daemon', 'autostart', 'notes']),
  on: Object.freeze(['harnesses', 'refused', 'routes', 'user', 'standalone', 'commands', 'unchanged', 'capture', 'daemon', 'linger', 'linger_reason', 'adopted', 'notes']),
  off: Object.freeze(['harnesses', 'all', 'outcome', 'daemon', 'daemon_stop', 'holders', 'left', 'kept_backups', 'orphan_backups', 'kept_bundles', 'still_trusting', 'residue', 'undone_by_marker', 'routing', 'install_items', 'pending', 'user_processes', 'nothing_installed', 'relayed_reason', 'notes']),
  uninstall: Object.freeze(['harnesses', 'all', 'purge_data', 'kept', 'kept_bundles', 'still_trusting', 'residue', 'dropped_backups', 'non_identical', 'entries', 'left', 'pending', 'autostart', 'daemon', 'relayed_reason', 'routing', 'user_processes', 'declined', 'notes']),
  update: Object.freeze(['from', 'to', 'harnesses', 'restarted', 'install', 'on', 'notes']),
  classes: Object.freeze(['class', 'before', 'after']),
})
/** C.1: the keys any receipt may carry besides `RECEIPT_KEYS` — a refusal's `error`, and what a run stopped before writing says (`planned`, `blocked`, `needs_yes`, `dry_run`). */
const COMMON_OPTIONAL = Object.freeze(['error', 'problems', 'planned', 'blocked', 'needs_yes', 'dry_run'])

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isString = (v) => typeof v === 'string'
const isCount = (v) => Number.isInteger(v) && v >= 0

/** Runs `check(item, 'key[i]')` over the list `r[key]`; a key that is there but not a list is a problem (a missing one is reported by the caller). */
function listOf(r, key, bad, check) {
  const list = r[key]
  if (!Array.isArray(list)) { if (key in r) bad.push(`${key}: not a list`); return }
  list.forEach((item, i) => check(item, `${key}[${i}]`))
}

/** created / removed: a path or command as a non-empty string, or an object of the command's own shape (`{path, …}`). */
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
    // 附录 C.3: `status`'s own `harnesses` is an object KEYED by the harness — the keys are ids too
    else if (k === 'harnesses' && isObject(x)) for (const id of Object.keys(x)) if (!HARNESS_IDS.includes(id)) bad.push(`${here}.${id}: ${JSON.stringify(id)} is not a harness id`)
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
  // C.1 `{path, change, backup}` for a command that changes state; C.3 `{harness, path, what, undo}` for status, whose list is null when the install record could not be read
  const status = r.command === 'status'
  if (!(status && r.changed === null)) listOf(r, 'changed', bad, (c, at) => {
    if (!isObject(c)) { bad.push(`${at}: not an object ${status ? '{harness, path, what, undo}' : '{path, change, backup}'}`); return }
    if (!isString(c.path)) bad.push(`${at}.path: not a string`)
    if (status) {
      if (!('harness' in c)) bad.push(`${at}.harness: missing`) // the id itself is checked for every `harness` key below
      for (const k of ['what', 'undo']) if (!isString(c[k])) bad.push(`${at}.${k}: not a string`)
      return
    }
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
  if ('undo' in r && !(r.undo === null || (isString(r.undo) && r.undo !== ''))) bad.push('undo: neither the one command line that undoes this command nor null')
  if (r.command in UNDO_LINE && r.undo !== null && r.undo !== UNDO_LINE[r.command]) bad.push(`undo: ${JSON.stringify(r.undo)}, expected ${JSON.stringify(UNDO_LINE[r.command])}`)
  // C.1: a problem is an English sentence, so a reader needs no code table to print it
  listOf(r, 'problems', bad, (p, at) => { if (!(isString(p) && p.trim() !== '')) bad.push(`${at}: not a sentence`) })
  const named = COMMAND_KEYS[r.command]
  if (named) {
    const allowed = new Set([...RECEIPT_KEYS, ...COMMON_OPTIONAL, ...named])
    for (const k of Object.keys(r)) if (!allowed.has(k)) bad.push(`${k}: not a key 附录 C names for ${r.command}`)
  }
  if ('relayed' in r && r.relayed !== 'unknown') {
    if (!isObject(r.relayed)) bad.push('relayed: neither "unknown" nor {closing, waiting, cut}')
    else for (const k of ['closing', 'waiting', 'cut']) if (!isCount(r.relayed[k])) bad.push(`relayed.${k}: not a non-negative integer`)
  }
  if ('log' in r && !(r.log === null || isString(r.log))) bad.push('log: neither a path nor null')
  if ('linger' in r && !(r.linger === true || r.linger === false || r.linger === 'unknown')) bad.push('linger: not true, false or "unknown"')
  if ('agent_list' in r) bad.push(...validateAgentList(r.agent_list))
  if (Array.isArray(r.harnesses)) r.harnesses.forEach((h, i) => { if (isObject(h) && h.identity !== undefined) bad.push(...validateIdentity(h.identity).map((x) => `harnesses[${i}].${x}`)) })
  else if (isObject(r.harnesses)) for (const [h, x] of Object.entries(r.harnesses)) if (isObject(x) && x.identity !== undefined) bad.push(...validateIdentity(x.identity).map((y) => `harnesses.${h}.${y}`))
  // `update`'s `install` / `on` are the receipts of the two steps the new code ran (C.2), not `status`'s install / cert pair
  if (r.command === 'update') { for (const k of ['install', 'on']) if (r[k] != null) bad.push(...validateReceipt(r[k]).map((x) => `${k}.${x}`)) }
  else if ('install' in r || 'cert' in r) bad.push(...validateInstallCert(r))
  if ('forms' in r) bad.push(...validateForms(r.forms))
  checkHarnessIds(r, '', bad, new WeakSet())
  return bad
}

// ── the name list of `status --json` (RFC 1.6 §9.7, D51③⑤): `harnesses[].identity` ──────────────────────────────────────────────────────────────────────────
const AGENT_LIST_STATES = Object.freeze(['absent', 'ok', 'unreadable', 'unparsable'])
const NAME_SOURCES = Object.freeze(['preset', 'custom'])
/** Problems with `agent_list` (the user's agents.json, once per receipt): { path, state, problems: [{ index, code, detail }] } — a problem's index an item number
 *  or null (the whole file). */
function validateAgentList(f) {
  if (!isObject(f)) return ['agent_list: not an object']
  const bad = []
  if (!isId(f.path)) bad.push('agent_list.path: empty')
  if (!AGENT_LIST_STATES.includes(f.state)) bad.push(`agent_list.state: ${JSON.stringify(f.state)} is not one of ${AGENT_LIST_STATES.join(' ')}`)
  if (!Array.isArray(f.problems)) bad.push('agent_list.problems: not a list')
  else listOf(f, 'problems', bad, (p, at) => {
    if (!isObject(p) || !(p.index === null || isCount(p.index)) || !isId(p.code) || !isId(p.detail)) bad.push(`agent_list.${at}: needs index (an item number or null), code and detail`)
  })
  return bad
}

/** Problems with one harness's `identity` block (`[]` = valid): { names / ignored: [{ name, args?, entry?, source }], unknown: [{ name, wide, named, pid, door }] } —
 *  the closed sets above, an unknown's name null only when the door could not read it. */
function validateIdentity(x) {
  if (!isObject(x)) return ['identity: not an object']
  const bad = []
  for (const key of ['names', 'ignored']) {
    if (!Array.isArray(x[key])) { bad.push(`identity.${key}: not a list`); continue }
    x[key].forEach((n, i) => {
      if (!isObject(n) || !isId(n.name) || !NAME_SOURCES.includes(n.source) || !(n.args === undefined || isId(n.args)) || !(n.entry === undefined || isId(n.entry))) bad.push(`identity.${key}[${i}]: needs name, source (${NAME_SOURCES.join(' | ')}) and args / entry only as a pattern`)
    })
  }
  if (!Array.isArray(x.unknown)) bad.push('identity.unknown: not a list')
  else x.unknown.forEach((u, i) => {
    if (!isObject(u) || !(u.name === null || isId(u.name)) || typeof u.wide !== 'boolean' || typeof u.named !== 'boolean' || !(u.pid === null || Number.isInteger(u.pid)) || !(u.door === null || isId(u.door))) bad.push(`identity.unknown[${i}]: needs name, wide, named, pid and door`)
  })
  return bad
}

// ── `install` and `cert` (RFC 1.6 §9.4, D55): the closed sets of the certificate axis ──────────────────────────────────────────────────────────────────────────
const INSTALL_STATES = Object.freeze(['complete', 'partial', null])
const ROOT_STATES = Object.freeze(['in-place', 'pending', 'declined', 'missing', 'orphan', 'none', 'unknown'])
const KEY_STATES = Object.freeze(['present', 'missing', 'unavailable', 'unknown'])
const INTERMEDIATE_STATES = Object.freeze(['current', 'unavailable', 'unknown'])
const isCodeOrNull = (c) => c === null || isId(c)
function validateInstallCert({ install: i, cert: c }) {
  const bad = []
  if (!isObject(i) || !INSTALL_STATES.includes(i.state) || !Array.isArray(i.harnesses) || !Array.isArray(i.pending) || !(i.at === null || isId(i.at))) bad.push('install: not {state ∈ complete|partial|null, at, harnesses[], pending[]}')
  if (!isObject(c)) return [...bad, 'cert: not an object']
  if (!(c.fp256 === null || isId(c.fp256))) bad.push('cert.fp256: neither a fingerprint nor null')
  if (!isObject(c.root) || !ROOT_STATES.includes(c.root.state) || !isCodeOrNull(c.root.code) || (c.root.state === 'unknown' && !isId(c.root.reason))) bad.push(`cert.root: state ${JSON.stringify(c.root && c.root.state)} is not in ${ROOT_STATES.join('|')}, or a bad code, or unknown without a reason`)
  if (!isObject(c.key) || !KEY_STATES.includes(c.key.state) || !isCodeOrNull(c.key.code) || (c.key.state === 'unknown' && !isId(c.key.reason))) bad.push(`cert.key: state ${JSON.stringify(c.key && c.key.state)} is not in ${KEY_STATES.join('|')}, or unknown without a reason`)
  if (!(c.intermediate === null || (isObject(c.intermediate) && INTERMEDIATE_STATES.includes(c.intermediate.state) && isCodeOrNull(c.intermediate.code) && (c.intermediate.state !== 'unknown' || isId(c.intermediate.reason))))) bad.push('cert.intermediate: not null or {state ∈ current|unavailable|unknown (with a reason), code}')
  if (!Array.isArray(c.bundles)) bad.push('cert.bundles: not a list')
  return bad
}

const CARRIERS = Object.freeze(['root', 'config-key', 'wrapper', 'plugin', null])
const USER_FILE_STATES = Object.freeze(['intact', 'changed', 'not-users-file'])
const UPSTREAM_SOURCES = Object.freeze(['hook', 'config-prior', 'process-env', 'system-proxy', 'direct', 'unknown'])
const redacted = (v) => v === null || (typeof v === 'string' && !/\/\/[^/@]*:(?!\*\*\*@)[^/@]*@/.test(v) && !/\/\/(?!\*\*\*@)[^/:@]+@/.test(v)) // no user or password left in a URL
/** status --json `forms` (1.6 §9.4): per harness, per form, `certificate` and `proxy` with their closed sets; every URL redacted. */
function validateForms(forms) {
  if (!isObject(forms)) return ['forms: not an object']
  const bad = []
  for (const [h, list] of Object.entries(forms)) (Array.isArray(list) ? list : [null]).forEach((x, i) => {
    const at = `forms.${h}[${i}]`, c = x && x.certificate, p = x && x.proxy, u = p && p.upstream
    if (!isObject(x) || !isId(x.form)) return bad.push(`${at}: not {form, certificate, proxy}`)
    if (!isObject(c) || typeof c.in_effect !== 'boolean' || !CARRIERS.includes(c.carrier) || !isCodeOrNull(c.code) || (c.in_effect === false && !isId(c.command)) || !(c.user_file === null || (isObject(c.user_file) && USER_FILE_STATES.includes(c.user_file.state)))) bad.push(`${at}.certificate: not in the closed sets`)
    if (!isObject(p) || !['connected', 'entry_intact', 'door_up'].every((k) => typeof p[k] === 'boolean') || !isObject(u) || !UPSTREAM_SOURCES.includes(u.source) || ![u.url_redacted, p.written, p.prior].every(redacted)) bad.push(`${at}.proxy: not in the closed sets, or a URL not redacted`)
  })
  return bad
}

// ── the network topology (RFC 1.6 §9.4: `status --json` key `topology`, the board's `/api/capture-health` `netenv.topology`) ──────────────────────────────────────────────────────────────────────────
// The closed sets are written here once, so the Windows branch (4.8 §10) adds none: its proxy-mode values (`routing: 'proxy'`, `trocar-forwarder`, `forward`, `branches[].form`, the edge's `trocar` /
// `entry`, `env-unreadable`) are already members.
/** How the platform steers an agent's connections to trocar (D43: one mode per platform; there is no `mixed`). */
export const ROUTING = Object.freeze(['driver', 'proxy', 'legacy', 'none', 'unknown'])
export const TOPOLOGY_KINDS = Object.freeze(['agent', 'proxy', 'trocar-engine', 'trocar-forwarder', 'legacy-mitm', 'upstream', 'egress', 'unknown'])
export const TOPOLOGY_VIA = Object.freeze(['direct', 'proxy-http', 'proxy-socks', 'proxy-https', 'system-proxy', 'ebpf', 'forward', 'egress', 'unknown'])
/** Why a hop is 「不知道」 (R11: a hop that could not be read is said, with its reason, never left out and never 「无」). */
export const UNKNOWN_REASONS = Object.freeze(['denied', 'timeout', 'absent', 'unparseable', 'owner-unreadable', 'pac', 'kernel-filter-invisible', 'env-unreadable'])
export const BRANCH_NAMES = Object.freeze(['all', 'http', 'ws'])
/** What a running process's line says about it: it still goes by the setting it started with, or trocar is not on its path. */
export const RUNNING_NOTES = Object.freeze(['start-time-settings', 'not-steered'])
export const FINDING_CLASSES = Object.freeze(['problem', 'expected', 'note']) // 附录 B

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
        if (e.entry !== undefined && !(isObject(e.entry) && isId(e.entry.where) && typeof e.entry.opt_in === 'boolean' && e.trocar === true)) bad.push(`${w}.entry: needs { where, opt_in } and trocar: true`)
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
/** Problems with one finding of `doctor --json` (1.6 附录 B, V49; `[]` = valid): a code, a class, a what and a why that say something, every command a whole line with its shell and no `<…>` left to fill in, a verify.
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
    if (f.class !== 'note' && f.commands.length === 0) bad.push('commands: a problem or an expected finding says what to do')
    f.commands.forEach((c, i) => {
      if (!isObject(c) || !isString(c.run) || c.run.trim() === '') bad.push(`commands[${i}].run: empty`)
      else if (/<[^<>\n]+>/.test(c.run)) bad.push(`commands[${i}].run: has a <…> placeholder left`)
      if (isObject(c) && !SHELLS.includes(c.shell)) bad.push(`commands[${i}].shell: not one of ${SHELLS.join(' ')}`)
    })
  }
  if (f.places !== undefined) { // the user's own places a finding asks them to edit by hand (1.6 附录 B): file+key, a variable, or the OS's proxy
    if (!Array.isArray(f.places)) bad.push('places: not a list')
    else f.places.forEach((p, i) => {
      if (!isObject(p)) { bad.push(`places[${i}]: not an object`); return }
      if (p.kind === 'env') { if (!isString(p.name) || !p.name.trim()) bad.push(`places[${i}].name: empty`) }
      else if (p.kind === 'file') { if (!isString(p.path) || !p.path.trim()) bad.push(`places[${i}].path: empty`); if (!isString(p.key) || !p.key.trim()) bad.push(`places[${i}].key: empty`) }
      else if (p.kind !== 'system') bad.push(`places[${i}].kind: ${JSON.stringify(p.kind)} is not file, env or system`)
    })
  }
  return bad
}

/** `status` and `doctor`: `ok` is the command's own verdict (1.6 §3.5, §3.7 — nothing is wrong), not 「everything was read」. For every
 *  other name a thing it could not read (an `errors` entry without `level`; a `level:'note'` one is not that, C.5) is the only reason a document is not ok. */
const VERDICT = Object.freeze(['status', 'doctor'])

/** Problems with a `query` document against 附录 C.5 (`[]` = valid): every document, whatever the name, has
 *  `schema` · `command` · `ok` · `errors:[{where, reason}]`, and one paged by `--after` (it says `has_more`) has `next` agreeing with it;
 *  `lane`'s `next` / `prev` are rids of its neighbour pages (3.5 §会话读), no `--after`. */
export function validateQueryDoc(doc, name = doc && doc.command) {
  if (!isObject(doc)) return ['document: not an object']
  const bad = []
  if (doc.schema !== SCHEMA_VERSION) bad.push(`schema: ${JSON.stringify(doc.schema)}, expected the integer ${SCHEMA_VERSION}`)
  if (doc.command !== name) bad.push(`command: ${JSON.stringify(doc.command)}, expected ${JSON.stringify(name)} (C.5: the query's own name, and no second \`query\` key)`)
  if ('query' in doc) bad.push('query: C.5 allows no such key — the name is `command`')
  if (typeof doc.ok !== 'boolean') bad.push('ok: not a boolean')
  if (!Array.isArray(doc.errors)) bad.push('errors: not a list')
  else doc.errors.forEach((e, i) => {
    if (!isObject(e)) { bad.push(`errors[${i}]: not an object {where, reason}`); return }
    for (const k of ['where', 'reason']) if (!isString(e[k]) || e[k].trim() === '') bad.push(`errors[${i}].${k}: empty`)
  })
  if (doc.ok !== (Array.isArray(doc.errors) && !doc.errors.some((e) => !isObject(e) || !e.level)) && !VERDICT.includes(doc.command)) bad.push('ok: says something else than `errors` does')
  if ('has_more' in doc) {
    if (typeof doc.has_more !== 'boolean') bad.push('has_more: not a boolean')
    if (!(doc.next === null || isString(doc.next))) bad.push('next: neither the next --after nor null')
    if (doc.has_more !== (doc.next !== null)) bad.push('next: says something else than `has_more` does')
  }
  return bad
}
