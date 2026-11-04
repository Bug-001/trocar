// state.mjs (src/rules) — the state of a rule (RFC 5.1 §规则活着的定义, §序号; 1.6 C.5) and the facts it is read from. `ruleState` is pure, the sequence
// numbers decide and the clock only answers `limit.until` and `resting_until`.
//
// collector/rules-stats.json, as the daemon writes it and this file reads it: { at, rules: { <name>: { armed_key, changes, last_change, not_applied_by:
// { <why>: n }, last_not_applied, resting_until, load_failed, process_gone, limit_used } } }. `changes` and `not_applied_by` are the rule's whole account;
// the rest is about one `rules enable`, the one `armed_key` names, so what an earlier enable left does not count against the rule.
import nodeFs from 'node:fs'
import { readStateFile } from '../off/state.mjs'
import { stateFileIn } from '../off/paths.mjs'
import { rulesState, rulesStats } from '../paths.mjs'
import { normalizeRule } from './validate.mjs'

// 5.1 §连续崩溃时不开规则: 到 2 就跳闸.
const TRIP_AT = 2

const has = Object.hasOwn
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0)

/** Does the file say this rule is on? */
export const isArmed = (rule) => isObject(rule.armed)

/** Which `rules enable` a rule is on: a second enable with the same sequence numbers still starts its `limit` over. */
export const armedKey = (rule) => JSON.stringify([rule.armed ?? null, rule.armed_at ?? null])

/** What the stats say of the rule, `{}` when they say nothing. */
export const statOf = (rule, stats) => (has(stats, rule.name) ? stats[rule.name] : {})

/** The part of it that belongs to the rule's latest `rules enable`. */
export function armedStatOf(rule, stats) {
  const stat = statOf(rule, stats)
  return stat.armed_key === armedKey(rule) ? stat : {}
}

const offOf = ({ off }, harness) => (isObject(off) ? (has(off, harness) ? off[harness] : 0) : off)
const seqOf = (facts, harness) => (has(facts.offSeq, harness) ? facts.offSeq[harness] : 0)

function targetsOf(rule, facts) {
  const { harness } = normalizeRule(rule).match
  return Array.isArray(harness) ? harness : [...new Set([...facts.recording, ...Object.keys(facts.offSeq)])]
}

/** The harnesses an `off` went past since the rule was enabled. */
export function stoppedOn(rule, facts) {
  return isArmed(rule) ? targetsOf(rule, facts).filter((harness) => seqOf(facts, harness) > offOf(rule.armed, harness)) : []
}

function limitReached(rule, stat, now) {
  const { times, until } = rule.limit ?? {}
  return (times !== undefined && count(stat.limit_used) >= times) || (until !== undefined && Date.parse(until) <= now)
}

/** The state of a rule: a value of RULE_STATES. facts = {recording: Set of harnesses, offSeq: {harness: n}, rulesOffSeq, tripped, stats, now}. The rule works
 *  per harness, so an `off` on one of them stops it only there: it is stopped when none is left, and waits while none of the rest records. */
export function ruleState(rule, facts) {
  if (!isArmed(rule)) return 'disabled'
  if (facts.tripped) return 'tripped'
  if (rule.armed.rules < facts.rulesOffSeq) return 'disabled'
  const stat = armedStatOf(rule, facts.stats)
  if (stat.load_failed) return 'load-failed'
  if (stat.process_gone) return 'process-gone'
  if (limitReached(rule, stat, facts.now)) return 'limit-reached'
  const targets = targetsOf(rule, facts), stopped = new Set(stoppedOn(rule, facts))
  const open = targets.filter((harness) => !stopped.has(harness))
  if (targets.length && !open.length) return 'stopped-by-off'
  if (!open.some((harness) => facts.recording.has(harness))) return 'waiting'
  return Date.parse(stat.resting_until) > facts.now ? 'resting' : 'live'
}

// A JSON object from a file, null when there is no file. Throws what could not be read.
function readObject(fs, file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  const doc = JSON.parse(text)
  if (!isObject(doc)) throw new Error('not a JSON object')
  return doc
}

const entryOf = (stat) => {
  const by = isObject(stat.not_applied_by) ? stat.not_applied_by : {}
  return { ...stat, changes: count(stat.changes), limit_used: count(stat.limit_used), not_applied_by: Object.fromEntries(Object.entries(by).map(([why, n]) => [why, count(n)])) }
}

function readStats(fs, home, errors) {
  try {
    const doc = readObject(fs, rulesStats(home))
    if (!doc) return { stats: {}, statsRead: 'absent', statsAt: null }
    if (!isObject(doc.rules)) throw new Error('no rules in it')
    const stats = Object.fromEntries(Object.entries(doc.rules).filter(([, stat]) => isObject(stat)).map(([name, stat]) => [name, entryOf(stat)]))
    return { stats, statsRead: 'ok', statsAt: typeof doc.at === 'string' ? doc.at : null }
  } catch (e) {
    errors.push({ where: 'rules-stats.json', reason: e.message })
    return { stats: {}, statsRead: 'bad', statsAt: null }
  }
}

function readSwitches(fs, home, errors) {
  try {
    const { harnesses } = readStateFile(stateFileIn(home), { fs }).state
    const ids = Object.keys(harnesses)
    return { recording: new Set(ids.filter((id) => harnesses[id].desired === 'on')), offSeq: Object.fromEntries(ids.map((id) => [id, count(harnesses[id].off_seq)])) }
  } catch (e) {
    errors.push({ where: 'state.json', reason: e.message })
    return { recording: new Set(), offSeq: {} }
  }
}

// A file that cannot be read is `rules off` (5.1): every rule enabled before now is off, whatever number it carries.
function readStops(fs, home, errors) {
  try {
    const doc = readObject(fs, rulesState(home)) ?? {}
    return { rulesOffSeq: count(doc.rules_off_seq), tripped: count(doc.unclean_stops) >= TRIP_AT }
  } catch (e) {
    errors.push({ where: 'rules-state.json', reason: e.message })
    return { rulesOffSeq: Infinity, tripped: false }
  }
}

/** The three collector files → `{facts, errors, statsRead, statsAt}`. `statsRead` is `ok`, `absent` or `bad`; `statsAt` is when the stats were written. Stats
 *  that are absent are not an error here: only a rule that is on should have left some. */
export function readRuleFacts({ home, fs = nodeFs, now = Date.now } = {}) {
  const errors = []
  const { stats, statsRead, statsAt } = readStats(fs, home, errors)
  return { facts: { ...readSwitches(fs, home, errors), ...readStops(fs, home, errors), stats, now: now() }, errors, statsRead, statsAt }
}
