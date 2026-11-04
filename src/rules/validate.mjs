// validate.mjs (src/rules) — the one validator of a rule and a rule file (RFC 5.1 §规则长什么样, §动作和位置, §隔离): `rules add`, `edit()` and the
// daemon loading rules all go through it, and nothing here compiles a regex, because the daemon does too. Problems are `[{path, reason}]`: `path` is
// dot-separated from the rule (`match.host`, `do.0`), or from the file (`rules.3.match.host`), '' for the thing itself. Reads keys only with
// Object.keys and Object.hasOwn, so `__proto__` is an unknown key like any other.
import path from 'node:path'
import { resolveHarnesses } from '../off/harness-names.mjs'
import { POSITIONS, ON_ERROR, LIMITS, DEFAULT_MAX_DELAY_MS } from './closed.mjs'
import { parseCondition, tierOf, leaves, literals, exactValues } from './conditions.mjs'
import { checkHeaderName, checkHeaderValue, checkHeaderSet } from './headers.mjs'

export { LIMITS, DEFAULT_MAX_DELAY_MS }

const has = Object.hasOwn
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isString = (v) => typeof v === 'string'
const isFilled = (v) => isString(v) && v !== ''
const isBool = (v) => typeof v === 'boolean'
const isTrue = (v) => v === true
const isAny = () => true
const inRange = (lo, hi) => (v) => Number.isSafeInteger(v) && v >= lo && v <= hi
const isCount = inRange(0, Number.MAX_SAFE_INTEGER)
const isPositive = inRange(1, Number.MAX_SAFE_INTEGER)
// A key may be as long as the file: a problem quotes the start of it.
const QUOTED_CHARS = 200
const at = (base, key) => {
  const written = /^[\w-]+$/.test(key) ? key : JSON.stringify(key)
  const seg = written.length > QUOTED_CHARS ? `${written.slice(0, QUOTED_CHARS)}...` : written
  return base ? `${base}.${seg}` : seg
}

// Where a thing may stand: the columns of 5.1's two tables, the manual's among them. `response-whole` is `on: response` with `whole`.
const positionOf = (rule) => {
  const on = has(rule, 'on') ? rule.on : 'request'
  if (!POSITIONS.includes(on)) return null
  return on === 'response' && rule.whole === true ? 'response-whole' : on
}
export const PLACES = ['request', 'response-whole', 'response', 'ws-client', 'ws-server']
const RESPONSES = ['response-whole', 'response']
export const ACTION_POSITIONS = {
  replace: PLACES,
  header: ['request', ...RESPONSES],
  json: PLACES,
  blocks: ['request', 'ws-client'],
  script: PLACES,
  hold: ['request', 'response-whole', 'ws-client', 'ws-server'],
  drop: PLACES,
  delay: PLACES,
  reply: ['request'],
  inject: ['response', 'ws-server'],
}
const MATCH_PLACES = {
  harness: PLACES, pid: PLACES, host: PLACES, path: PLACES, method: PLACES, class: PLACES, header: PLACES, body: PLACES,
  req_header: RESPONSES,
  blocks: ['request', 'ws-client'],
  status: RESPONSES,
  event_index: [...RESPONSES, 'ws-client', 'ws-server'],
}

const RULE_KEYS = new Set(['name', 'note', 'on', 'whole', 'match', 'do', 'on_error', 'limit'])
const ENABLE_KEYS = ['armed', 'armed_at', 'script_entry_sha256']
const RESERVED_NAMES = new Set(['add', 'test', 'enable', 'disable', 'rm', 'off', 'max-delay'])
const isName = (v) => isString(v) && v.length <= LIMITS.nameBytes && /^[a-z0-9][a-z0-9-]*$/.test(v) && !RESERVED_NAMES.has(v)
// Date.parse alone takes "Jan 1", and carries the 31st of February over into March.
const ZONED_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
function isZonedTime(v) {
  const [, year, month, day] = (isString(v) && ZONED_TIME.exec(v)) || []
  return day !== undefined && Number.isFinite(Date.parse(v)) && new Date(Date.UTC(year, month - 1, day)).getUTCMonth() === month - 1
}

// An action's form: `need` every key, `one` exactly one of them, `may` any of them, nothing else. The key that names the kind comes first in `need`.
const SELECTOR_KEYS = { section: isString, kind: isString, role: isString, name: isString, text: isString, min_bytes: isCount, max_bytes: isCount, newest: isCount, skip_newest: isCount }
const isPointer = (v) => isString(v) && /^(\/([^~/]|~[01])*)+$/.test(v)
const FORMS = {
  replace: { need: { replace: isFilled, with: isString }, may: { in: (v) => v === 'text' || v === 'body', literal: isBool, blocks: isObject } },
  header: { need: { header: isString }, one: { set: isString, remove: isTrue } },
  json: { need: { json: isPointer }, one: { set: isAny, add: isAny, remove: isTrue } },
  script: { need: { script: (v) => isFilled(v) && path.isAbsolute(v) } },
  hold: { need: { hold: isTrue, release_after_ms: inRange(1, LIMITS.releaseAfterMs) } },
  drop: { need: { drop: isTrue } },
  delay: { need: { delay_ms: inRange(1, LIMITS.delayMs) } },
  reply: { need: { reply: isObject } },
  inject: { need: { inject: isFilled } },
  blocks: { need: { blocks: isObject }, one: { remove: isTrue, truncate: isPositive, set_text: isString, append_text: isString } },
}
const KINDS = Object.entries(FORMS).map(([kind, form]) => [kind, Object.keys(form.need)[0]])

/** The kind of an action, by the key that names it: `replace` `header` `json` `blocks` `script` `hold` `drop` `delay` `reply` `inject`; null when none. */
export function actionKind(action) {
  if (!isObject(action)) return null
  const found = KINDS.find(([, key]) => has(action, key))
  return found ? found[0] : null
}

const matchOf = (rule) => (isObject(rule) && isObject(rule.match) ? rule.match : {})
const actionsOf = (rule) => (isObject(rule) && Array.isArray(rule.do) ? rule.do : [])

/** Does the rule read the body (5.1 §四条硬规定)? */
export function readsBody(rule) {
  const match = matchOf(rule)
  return has(match, 'body') || has(match, 'blocks') || actionsOf(rule).some((a) => ['replace', 'json', 'blocks', 'script'].includes(actionKind(a)))
}

/** The script file of the rule, or null. */
export function scriptOf(rule) {
  const action = actionsOf(rule).find((a) => actionKind(a) === 'script')
  return action ? action.script : null
}

/** The rule as it is stored: `on` written out, harness aliases as code ids, a lone `pid` on `"any"`. A copy; names it cannot resolve stay for checkRule. */
export function normalizeRule(rule) {
  if (!isObject(rule)) return rule
  const out = { ...rule, on: has(rule, 'on') ? rule.on : 'request' }
  if (!isObject(rule.match)) return out
  const match = { ...rule.match }
  if (has(match, 'harness')) {
    const ids = match.harness === 'any' ? null : resolveHarnesses([].concat(match.harness)).ids
    if (ids) match.harness = ids
  } else if (has(match, 'pid')) match.harness = 'any'
  out.match = match
  return out
}

/** Every condition of a match that is one, with the path and the key it is parsed under: a header's conditions one by one. */
export function* conditionsOf(match) {
  for (const key of Object.keys(match)) {
    if (key === 'harness' || key === 'pid' || key === 'blocks' || !has(MATCH_PLACES, key)) continue
    if (key === 'header' || key === 'req_header') {
      if (isObject(match[key])) for (const name of Object.keys(match[key])) yield { path: at(`match.${key}`, name), key, value: match[key][name] }
    } else yield { path: `match.${key}`, key, value: match[key] }
  }
}

function checkKeys(object, known, base, bad) {
  for (const key of Object.keys(object)) if (!has(known, key)) bad(at(base, key), 'unknown key')
}

function checkSelector(selector, base, bad) {
  if (!isObject(selector)) return bad(base, 'a block selector is an object')
  checkKeys(selector, SELECTOR_KEYS, base, bad)
  for (const key of Object.keys(selector)) if (has(SELECTOR_KEYS, key) && !SELECTOR_KEYS[key](selector[key])) bad(at(base, key), 'not a value of this selector key')
}

function checkHarness(harness, bad) {
  if (harness === 'any') return
  const names = [].concat(harness)
  if (!names.length || names.length > LIMITS.list || !names.every(isString) || !resolveHarnesses(names).ok) {
    bad('match.harness', `a harness name, a list of at most ${LIMITS.list} names, or "any"`)
  }
}

function checkMatch(match, position, script, bad) {
  for (const key of Object.keys(match)) {
    if (!has(MATCH_PLACES, key)) bad(at('match', key), 'unknown key')
    else if (position && !MATCH_PLACES[key].includes(position)) bad(at('match', key), `not a condition at this position`)
  }
  if (has(match, 'harness')) checkHarness(match.harness, bad)
  if (has(match, 'pid') && !isPositive(match.pid)) bad('match.pid', 'a process id')
  if (has(match, 'blocks')) checkSelector(match.blocks, 'match.blocks', bad)
  for (const key of ['header', 'req_header']) {
    if (!has(match, key)) continue
    if (!isObject(match[key])) bad(`match.${key}`, 'an object of header names and conditions')
    else for (const name of Object.keys(match[key])) if (name === '__proto__' || checkHeaderName(name).length) bad(at(`match.${key}`, name), 'not a header name')
  }
  for (const { path: where, key, value } of conditionsOf(match)) {
    const node = parseCondition(value, { key })
    if (!node) { bad(where, `not a condition, or over its limit: lists ${LIMITS.list} items, regexes ${LIMITS.regexBytes} bytes`); continue }
    if (key === 'header' || key === 'req_header') {
      const bytesOk = (v) => Buffer.byteLength(v) <= LIMITS.headerGrowthBytes
      if (!literals(node).every((v) => bytesOk(v) && !checkHeaderValue(v).length)) bad(where, 'not a header value')
    }
    if (key === 'method' && literals(node).some((v) => v !== v.toUpperCase())) bad(where, 'a method is upper case: the lower case never matches')
    if (script && tierOf(node, { key }) === 2) bad(where, 'a script rule decides this in the script')
  }
  if (script) for (const key of ['body', 'blocks']) if (has(match, key)) bad(`match.${key}`, 'a script rule reads the body in the script')
}

function checkForm(action, kind, base, bad) {
  const { need, one = {}, may = {} } = FORMS[kind]
  checkKeys(action, { ...need, ...one, ...may }, base, bad)
  for (const key of Object.keys(need)) if (!has(action, key) || !need[key](action[key])) bad(at(base, key), 'missing or not a value of this key')
  for (const key of Object.keys(may)) if (has(action, key) && !may[key](action[key])) bad(at(base, key), 'not a value of this key')
  const chosen = Object.keys(one).filter((key) => has(action, key))
  for (const key of chosen) if (!one[key](action[key])) bad(at(base, key), 'not a value of this key')
  if (Object.keys(one).length && chosen.length !== 1) bad(base, `exactly one of: ${Object.keys(one).join(' ')}`)
}

function checkReply(reply, base, bad) {
  checkKeys(reply, { status: 1, headers: 1, body: 1 }, base, bad)
  if (!inRange(200, 599)(reply.status)) bad(at(base, 'status'), 'a status from 200 to 599')
  if (has(reply, 'body') && !isString(reply.body)) bad(at(base, 'body'), 'a string')
  if (has(reply, 'body') && (reply.status === 204 || reply.status === 304)) bad(at(base, 'body'), `a ${reply.status} has no body`)
  if (!has(reply, 'headers')) return
  if (!isObject(reply.headers)) return bad(at(base, 'headers'), 'an object of header names and values')
  const names = Object.keys(reply.headers)
  for (const p of checkHeaderSet(names.map((n) => [n, String(reply.headers[n])]))) bad(p.at === null ? at(base, 'headers') : at(at(base, 'headers'), names[p.at]), p.reason)
  for (const n of names) if (n === '__proto__' || !isString(reply.headers[n])) bad(at(at(base, 'headers'), n), 'not a header')
}

function checkDo(actions, position, bad) {
  if (!Array.isArray(actions) || !actions.length || actions.length > LIMITS.list) return bad('do', `a list of 1 to ${LIMITS.list} actions`)
  const sets = [], setAt = []
  let scripts = 0
  actions.forEach((action, i) => {
    const base = `do.${i}`, kind = actionKind(action)
    if (!kind) return bad(base, 'not an action')
    checkForm(action, kind, base, bad)
    const row = kind === 'replace' && has(action, 'blocks') ? 'blocks' : kind
    if (position && !ACTION_POSITIONS[row].includes(position)) bad(base, 'not an action at this position')
    if ((kind === 'hold' || kind === 'drop' || kind === 'reply') && i !== actions.length - 1) bad(base, `${kind} ends the list`)
    if (has(action, 'blocks')) checkSelector(action.blocks, at(base, 'blocks'), bad)
    if (kind === 'reply' && isObject(action.reply)) checkReply(action.reply, at(base, 'reply'), bad)
    if (kind === 'replace' && action.literal !== true && isString(action.replace) && Buffer.byteLength(action.replace) > LIMITS.regexBytes) bad(at(base, 'replace'), `a regex is at most ${LIMITS.regexBytes} bytes`)
    if (kind === 'script' && ++scripts > 1) bad(base, 'a rule has one script')
    if (kind === 'header') { sets.push([action.header, has(action, 'remove') ? null : action.set]); setAt.push(i) }
  })
  for (const p of checkHeaderSet(sets)) bad(p.at === null ? 'do' : `do.${setAt[p.at]}.header`, p.reason)
}

function checkEnableKeys(rule, input, bad) {
  for (const key of ENABLE_KEYS) if (input && has(rule, key)) bad(key, 'written by rules enable')
  if (input) return
  const isSeq = (v) => isCount(v) || (isObject(v) && Object.values(v).every(isCount))
  if (has(rule, 'armed') && rule.armed !== null) {
    const a = rule.armed
    if (!isObject(a) || Object.keys(a).some((k) => k !== 'off' && k !== 'rules') || !isSeq(a.off) || !isCount(a.rules)) bad('armed', 'the two off sequence numbers')
  }
  if (has(rule, 'armed_at') && rule.armed_at !== null && !isString(rule.armed_at)) bad('armed_at', 'a time')
  if (has(rule, 'script_entry_sha256') && !/^[0-9a-f]{64}$/.test(String(rule.script_entry_sha256))) bad('script_entry_sha256', 'a sha256')
}

/** Everything wrong with one rule, `[]` when nothing is. `input`: the rule comes from the operator (`rules add`), so what `rules enable` writes is refused. */
export function checkRule(rule, { input = false } = {}) {
  if (!isObject(rule)) return [{ path: '', reason: 'a rule is an object' }]
  const out = [], bad = (where, reason) => { out.push({ path: where, reason }) }
  for (const key of Object.keys(rule)) if (!RULE_KEYS.has(key) && !ENABLE_KEYS.includes(key)) bad(at('', key), 'unknown key')
  checkEnableKeys(rule, input, bad)

  if (!isName(rule.name)) bad('name', `lowercase letters, digits and -, starting with a letter or digit, at most ${LIMITS.nameBytes} bytes, not a reserved word`)
  if (has(rule, 'note') && !isString(rule.note)) bad('note', 'a string')
  const position = positionOf(rule)
  if (!position) bad('on', `one of: ${POSITIONS.join(' ')}`)
  if (has(rule, 'whole') && (rule.on !== 'response' || !isBool(rule.whole))) bad('whole', 'true or false, on a response rule')
  if (!ON_ERROR.includes(rule.on_error)) bad('on_error', `required, one of: ${ON_ERROR.join(' ')}`)
  if (has(rule, 'limit')) {
    if (!isObject(rule.limit)) bad('limit', 'an object')
    else {
      checkKeys(rule.limit, { times: 1, until: 1 }, 'limit', bad)
      if (has(rule.limit, 'times') && !isPositive(rule.limit.times)) bad('limit.times', 'a whole number of changes')
      if (has(rule.limit, 'until') && !isZonedTime(rule.limit.until)) bad('limit.until', 'an ISO 8601 time with its zone, like 2026-11-05T12:00:00Z')
    }
  }

  checkDo(rule.do, position, bad)
  if (!isObject(rule.match)) { bad('match', 'an object of conditions'); return out }
  const match = rule.match, script = scriptOf(rule) !== null
  checkMatch(match, position, script, bad)
  if (!has(match, 'harness') && !has(match, 'pid')) bad('match.harness', 'name a harness or a pid; "any" means every harness')
  if (readsBody(rule) && !['host', 'path', 'class'].some((key) => has(match, key))) bad('match', 'a rule that reads the body needs host, path or class')
  if (rule.on_error === 'drop' && !has(match, 'host')) bad('match.host', 'a rule that drops on error needs host; "*" means every host')
  return out
}

// The harnesses and exact hosts a rule sits under, and the tier-1 comparisons it costs a connection that reaches it (5.1 §分派): an exact host is the
// index's lookup, not a comparison. Host names fold case, as DNS does.
function reachOf(rule) {
  const match = matchOf(normalizeRule(rule))
  const harnesses = Array.isArray(match.harness) ? match.harness : ['any']
  const hostNode = has(match, 'host') ? parseCondition(match.host, { key: 'host' }) : null
  const exact = hostNode && exactValues(hostNode)
  const hosts = exact ? [...new Set(exact.map((h) => h.toLowerCase()))] : null
  let conditions = has(match, 'pid') ? 1 : 0
  for (const { key, value } of conditionsOf(match)) {
    const node = parseCondition(value, { key })
    if (node && !(key === 'host' && hosts) && tierOf(node, { key }) === 1) conditions += leaves(node)
  }
  return { harnesses, hosts, conditions }
}

// The most tier-1 conditions any connection can reach, all four `on` together: for a harness and a host, that bucket, the same host under `any`, and
// the two wildcard tables; a host in no bucket and a harness no rule names cost the wildcard tables alone.
function checkReach(rules, bad) {
  const reaches = rules.map(reachOf)
  const entries = reaches.reduce((n, r) => n + r.harnesses.length * (r.hosts ? r.hosts.length : 0), 0)
  if (entries > LIMITS.indexEntries) return bad('rules', `the host index would have ${entries} entries, the limit is ${LIMITS.indexEntries}`)
  const buckets = new Map(), wild = new Map()
  for (const { harnesses, hosts, conditions } of reaches) {
    for (const harness of harnesses) {
      if (!hosts) { wild.set(harness, (wild.get(harness) || 0) + conditions); continue }
      if (!buckets.has(harness)) buckets.set(harness, new Map())
      const bucket = buckets.get(harness)
      for (const host of hosts) bucket.set(host, (bucket.get(host) || 0) + conditions)
    }
  }
  const anyHosts = buckets.get('any') || new Map(), anyWild = wild.get('any') || 0
  let worst = 0
  for (const harness of new Set([...buckets.keys(), ...wild.keys(), 'any'])) {
    const own = buckets.get(harness) || new Map(), base = anyWild + (harness === 'any' ? 0 : wild.get(harness) || 0)
    worst = Math.max(worst, base)
    for (const host of new Set([...own.keys(), ...anyHosts.keys()])) {
      worst = Math.max(worst, base + (anyHosts.get(host) || 0) + (harness === 'any' ? 0 : own.get(host) || 0))
    }
  }
  if (worst > LIMITS.tier1Conditions) bad('rules', `one connection can reach ${worst} conditions, the limit is ${LIMITS.tier1Conditions}`)
}

/** Everything wrong with a parsed rule file: each rule, then the limits only the whole file can break. */
export function checkFile(doc) {
  if (!isObject(doc)) return [{ path: '', reason: 'the rule file is an object' }]
  const out = [], bad = (where, reason) => { out.push({ path: where, reason }) }
  checkKeys(doc, { max_delay_ms: 1, rules: 1 }, '', bad)
  if (has(doc, 'max_delay_ms') && !inRange(1, LIMITS.maxDelayMs)(doc.max_delay_ms)) bad('max_delay_ms', `1 to ${LIMITS.maxDelayMs}`)
  if (!Array.isArray(doc.rules)) { bad('rules', 'a list of rules'); return out }
  if (doc.rules.length > LIMITS.rules) { bad('rules', `at most ${LIMITS.rules} rules`); return out }
  const names = new Set()
  doc.rules.forEach((rule, i) => {
    for (const p of checkRule(rule)) bad(p.path ? `rules.${i}.${p.path}` : `rules.${i}`, p.reason)
    if (!isObject(rule)) return
    if (names.has(rule.name)) bad(`rules.${i}.name`, 'a name is used once')
    names.add(rule.name)
  })
  const scripts = new Set(doc.rules.filter((r) => isObject(r) && isObject(r.armed)).map(scriptOf).filter(Boolean))
  if (scripts.size > LIMITS.armedScripts) bad('rules', `at most ${LIMITS.armedScripts} script files on at once`)
  checkReach(doc.rules, bad)
  return out
}

/** The bytes of a rule file → `{doc}`, or `{problem:{code,reason}}` with `code` too-big, too-deep or not-json. Depth is counted byte by byte before
 *  parsing, outside strings: a deep file costs the parser far more than this scan. `doc` is not yet checked: that is checkFile. */
export function parseRulesBytes(buf) {
  if (buf.length > LIMITS.fileBytes) return { problem: { code: 'too-big', reason: `over ${LIMITS.fileBytes} bytes` } }
  let depth = 0, inString = false
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (inString) {
      if (b === 0x5c) i++
      else if (b === 0x22) inString = false
    } else if (b === 0x22) inString = true
    else if (b === 0x5b || b === 0x7b) {
      if (++depth > LIMITS.jsonDepth) return { problem: { code: 'too-deep', reason: `nested over ${LIMITS.jsonDepth} levels` } }
    } else if (b === 0x5d || b === 0x7d) depth--
  }
  try {
    return { doc: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf)) }
  } catch (e) {
    return { problem: { code: 'not-json', reason: e.message } }
  }
}
