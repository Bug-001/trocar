// schema.mjs — what `--json` prints (RFC 1.6 R5), and the check V9 runs over every command's output. The keys and the exit codes
// are src/off/schema.mjs (the undo side prints receipts too and may import nothing outside src/off); this adds validateReceipt.
import { SCHEMA_VERSION, EXIT, RECEIPT_KEYS, newReceipt } from '../off/schema.mjs'
import { HARNESS_IDS } from './harness-names.mjs'
import { STATUS_REASONS, NET_CODES } from '../health/codes.mjs'

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
    if (x.findings !== undefined && !(Array.isArray(x.findings) && x.findings.every((c) => NET_CODES.includes(c) || STATUS_REASONS.includes(c)))) bad.push(`${at}.findings: not a list of finding codes`)
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
  if (!(NET_CODES.includes(f.code) || STATUS_REASONS.includes(f.code))) bad.push(`code: ${JSON.stringify(f.code)} is not a finding code`)
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
