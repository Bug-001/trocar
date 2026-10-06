// schema.mjs — what `--json` prints (RFC 1.6 R5), and the check V9 runs over every command's output. The keys and the exit codes
// are src/off/schema.mjs (the undo side prints receipts too and may import nothing outside src/off); this adds validateReceipt.
import { SCHEMA_VERSION, EXIT, RECEIPT_KEYS, newReceipt } from '../off/schema.mjs'
import { HARNESS_IDS } from './harness-names.mjs'

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
