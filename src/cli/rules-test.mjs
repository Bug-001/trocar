// rules-test.mjs — `trocar rules test <name>` (RFC 1.6 §4.4, 附录 C.2; 5.1 验收 9): the rule on captured records, in a one-shot rule process. Sends nothing and writes nothing:
// the record's bytes go to the process and an account of them comes back. Credential values stop here, on the way in, so neither the rules nor the output has them.
import { errorDoc } from './json.mjs'
import { EXIT, newReceipt } from './schema.mjs'
import { columns, wrap } from './text.mjs'
import { isSecretHeader } from '../capture/redact.mjs'
import { parseRecordId } from '../collector/core/record/segments.mjs'
import { isContinuationOf } from '../dissect/registry.mjs'
import { readFlows, WINDOW_MS } from '../health/flows.mjs'
import { HARNESS_REGISTRY, readIdOf } from '../off/harness-names.mjs'
import { collectorHome } from '../paths.mjs'
import { readRecord, recordsAt } from '../query/records.mjs'
import { indexRows } from '../query/rows.mjs'
import { byteBudget } from '../rules/budget.mjs'
import { compileRules } from '../rules/compile.mjs'
import { readRules } from '../rules/file.mjs'
import { openOneShot } from '../rules/launch.mjs'
import { readRuleFacts, ruleState } from '../rules/state.mjs'
import { unitsOf } from '../rules/units.mjs'
import { normalizeRule, scriptOf } from '../rules/validate.mjs'

const DEFAULT_LAST = 20
const MOST_LAST = 500
const RECORD_MS = 2000
const COMMAND = 'rules test'
const RESULT_WORDS = Object.freeze({ change: 'change', 'no-match': 'no match', 'cannot-test': 'cannot test', untested: 'untested', error: 'error' })
const CANNOT_WORDS = Object.freeze({
  'log-only': 'kept as log only', truncated: 'cut at the capture cap', partial: 'never received whole', 'no-response': 'no response was recorded',
  'not-restorable': 'the agent\'s bytes do not check out', 'message-not-kept': 'a message was not kept', 'no-record': 'no such record',
})

const refused = (code, message) => ({ doc: errorDoc(COMMAND, code, `trocar ${COMMAND}: ${message}`) })
const records = (n) => `${n} record${n === 1 ? '' : 's'}`

/** A filter by the rule's own `keys` conditions: facts a condition cannot settle here pass, as tier 2 conditions do. */
function passes(rule, keys) {
  const match = Object.fromEntries(keys.filter((key) => Object.hasOwn(rule.match, key)).map((key) => [key, rule.match[key]]))
  const [{ judge }] = compileRules({ rules: [{ ...rule, match: { ...match, harness: 'any' } }] }).rules
  return (facts) => judge(facts, byteBudget()) !== 'miss'
}

function rowFilter(rule) {
  const { harness } = rule.match
  const reads = harness === 'any' ? null : HARNESS_REGISTRY.filter(({ id }) => harness.includes(id)).map(readIdOf)
  const conditions = passes(rule, ['host', 'class'])
  return (row) => (!reads || reads.includes(row.harness_id)) && conditions(row)
}

/** `--last`'s rows, newest first → `[{ref, rec}]`. */
async function lastRecords(c, rule, last, notes) {
  const errors = []
  const rows = (await indexRows({ home: c.home, errors })).filter(rowFilter(rule)).slice(-last).reverse()
  const found = recordsAt({ home: c.home, rows, errors, remember: false })
  for (const { where, reason } of errors) notes.push(`Could not read ${where}: ${reason}`)
  return found.map((rec) => ({ ref: rec.id, rec }))
}

async function namedRecord(c, ref) {
  try { return { ref, rec: await readRecord({ home: c.home, ...parseRecordId(ref) }) } } catch { return { ref, rec: null } }
}

const blanked = (pairs) => pairs.map(([name, value]) => [name, isSecretHeader(name) ? '' : value])
const masked = (unit) => ({ ...unit, headers: blanked(unit.headers), req_headers: blanked(unit.req_headers) })

// One unit of a record. `run` throws when the process cannot even be started: the script is gone, say.
const ask = (one, unit) => one.run(masked(unit)).catch(() => ({ died: 'load-failed' }))

/** The rule set on one record → a row of `records`. `times` keeps the slowest unit of each rule. */
async function testRecord(one, { ref, rec }, { rule, rules, asSent, times }) {
  if (!rec) return { ref, result: 'cannot-test', why: 'no-record', ms: 0 }
  const { units, cannot } = unitsOf(rec, rule, { asSent })
  if (cannot) return { ref, result: 'cannot-test', why: cannot, ms: 0 }
  const begun = performance.now(), would = new Set(), edits = []
  let why = null, changed = false, untested = false, exact = true, ms = 0, shift = 0, printed = ''
  for (const [index, unit] of units.entries()) {
    const started = performance.now()
    const answer = await ask(one, unit), spent = performance.now() - started
    if ('died' in answer || 'why' in answer) {
      why = answer.died ?? answer.why
      const name = rules[answer.rule]?.name
      if (name) times[name] = Math.max(times[name], spent)
      ms += spent
      break
    }
    for (const [name, taken] of Object.entries(answer.rule_ms)) {
      times[name] = Math.max(times[name], taken)
      ms += taken
    }
    printed += answer.console
    why = answer.skipped[0]?.why ?? null
    for (const { text } of answer.would) {
      if (text === 'script') untested = true
      else would.add(text)
    }
    const touched = Boolean(answer.bytes || answer.headers)
    changed ||= touched
    if (answer.bytes && !answer.edits.length) exact = false
    // Each unit's edits count from its own start; together they are one list over the record's bytes, or per message on a WebSocket.
    edits.push(...answer.edits.map((edit) => (rule.on.startsWith('ws-') ? { ...edit, message: index } : { ...edit, at: edit.at + shift })))
    shift += (answer.bytes ?? unit.body)?.length ?? 0
    why ??= performance.now() - begun > RECORD_MS ? 'timeout' : null
    if (why) break
  }
  const result = why ? 'error' : untested ? 'untested' : changed || would.size ? 'change' : 'no-match'
  return {
    ref, result, ...(why ? { why } : {}), ...(would.size ? { would: [...would].join('; ') } : {}), ...(exact && edits.length ? { edits } : {}),
    ms: Math.ceil(ms), ...(printed ? { console: printed } : {}),
  }
}

function passthroughHosts(c, rule, notes) {
  try {
    const { records: rows } = readFlows({ dir: collectorHome(c.home) }), host = passes(rule, ['host']), since = c.now() - WINDOW_MS
    const uncaptured = rows.filter((row) => row.not_captured != null && row.host && Date.parse(row.ts) >= since)
    return [...new Set(uncaptured.map((row) => row.host))].filter((name) => host({ host: name }))
  } catch (e) {
    notes.push(`Could not read which connections pass through: ${e.message}`)
    return []
  }
}

// The rule process has one script, and each script file has a process of its own on the live path: a rule on another file cannot be stacked here.
function scriptSet(set, rule, runScript) {
  const script = runScript ? scriptOf(rule) ?? set.map(scriptOf).find(Boolean) ?? null : null
  const rules = runScript ? set.filter((r) => [null, script].includes(scriptOf(r))) : set
  return { script, rules, left: set.filter((r) => !rules.includes(r)).map((r) => r.name) }
}

function hiddenHeaders(rules) {
  return rules.flatMap(({ match }) => [...Object.keys(match.header ?? {}), ...Object.keys(match.req_header ?? {})]).filter(isSecretHeader)
}

const countOf = (rows, result) => rows.filter((row) => row.result === result).length

function textOf(doc, { name, last, maxDelay }) {
  const seen = doc.records.length
  const what = last === null ? `of ${records(seen)}` : `of the last ${records(seen)}`
  const rows = doc.records.map((r) => [r.ref, RESULT_WORDS[r.result], r.would ?? CANNOT_WORDS[r.why] ?? r.why?.replaceAll('-', ' ') ?? (r.edits ? `${r.edits.length} edit${r.edits.length === 1 ? '' : 's'}` : ''), r.result === 'cannot-test' ? '' : `${r.ms} ms`])
  const table = columns([['RECORD', 'RESULT', 'WOULD', 'TIME'], ...rows]).map((line) => `  ${line}`)
  const body = table.flatMap((line, i) => [line, ...(doc.records[i - 1]?.console?.trimEnd().split('\n').map((text) => `    ${text}`) ?? [])])
  const slowest = Math.max(0, ...Object.values(doc.rule_ms))
  return [
    ...wrap(`${name} would change ${doc.counts.change} ${what}. Nothing was sent.`), ...(seen ? ['', ...body] : []), '',
    ...doc.notes.flatMap((note) => wrap(note)),
    ...doc.over_max_delay.flatMap((rule) => wrap(`${rule} took ${doc.rule_ms[rule]} ms: once live it would run out of its max delay.`)),
    `Slowest: ${slowest} ms. Max delay is ${maxDelay} ms.`,
  ]
}

function picksOf({ ref = [], last }) {
  if (ref.some((one) => !parseRecordId(one))) return { problem: 'a record is <segment>:<line>.' }
  if (last !== undefined && !(/^[1-9]\d*$/.test(last) && Number(last) <= MOST_LAST)) return { problem: `--last takes a number from 1 to ${MOST_LAST}.` }
  return { refs: ref, last: last !== undefined ? Number(last) : ref.length ? null : DEFAULT_LAST }
}

/** The `test` verb of src/cli/rules.mjs: `{doc, lines, exit}`, or a refusal. */
export async function testRule(c, [name]) {
  const { problem, refs, last } = picksOf(c.flags)
  if (problem) return refused('usage', problem)
  const read = readRules({ home: c.home })
  if (read.state === 'bad') return refused('rule-invalid', `rules.json cannot be read: ${read.problem.reason}`)
  const written = read.doc.rules.find((r) => r.name === name)
  if (!written) return refused('rule-unknown', `there is no rule called ${name}.`)

  const rule = normalizeRule(written), withLive = c.flags['with-live'] === true, runScript = c.flags['run-script'] === true, asSent = c.flags['as-sent'] === true
  const facts = withLive ? readRuleFacts({ home: c.home }).facts : null
  const set = read.doc.rules.filter((r) => r === written || (withLive && ruleState(r, facts) === 'live')).map(normalizeRule)
  const { script, rules, left } = scriptSet(set, rule, runScript)
  const notes = []
  const picked = [...await Promise.all(refs.map((ref) => namedRecord(c, ref))), ...(last === null ? [] : await lastRecords(c, rule, last, notes))]

  const times = Object.fromEntries(rules.map((r) => [r.name, 0]))
  const one = openOneShot({ script: script ?? undefined, rules, maxTaskMs: RECORD_MS })
  const rows = []
  try { for (const entry of picked) rows.push(await testRecord(one, entry, { rule, rules, asSent, times })) } finally { await one.close() }

  const counts = { change: countOf(rows, 'change'), no_match: countOf(rows, 'no-match'), cannot_test: countOf(rows, 'cannot-test'), untested: countOf(rows, 'untested') }
  const errors = countOf(rows, 'error'), tested = counts.change + counts.no_match + errors
  const continuations = picked.filter(({ rec }) => rec && isContinuationOf(rec)).length
  const hosts = passthroughHosts(c, rule, notes), hidden = hiddenHeaders(rules)
  if (continuations) notes.push(`${continuations === 1 ? '1 of them is a continuation: it holds' : `${continuations} of them are continuations: they hold`} only the new part of the conversation.`)
  if (hosts.length) notes.push(`Connections to ${hosts.join(', ')} pass through without a record, so no rule reaches them.`)
  if (hidden.length) notes.push(`A rule reads ${[...new Set(hidden)].join(', ')}. Its value is hidden here, so that condition sees an empty value.`)
  if (left.length) notes.push(`Left out, because a run has one script: ${left.join(', ')}.`)
  if (counts.untested) notes.push('Scripts did not run: they can fetch, so they may have side effects. Add --run-script to run them.')

  const over = Object.keys(times).filter((n) => times[n] > read.doc.max_delay_ms)
  const exit = !tested || errors ? EXIT.incomplete : EXIT.ok
  const doc = {
    ...newReceipt(COMMAND), ok: exit === EXIT.ok, rule: name, input: asSent ? 'as-sent' : 'default', with_live: withLive, run_script: runScript,
    counts: { tested, ...counts, continuations }, records: rows, rule_ms: Object.fromEntries(Object.entries(times).map(([n, ms]) => [n, Math.ceil(ms)])), over_max_delay: over,
    passthrough_hosts: hosts, notes,
  }
  return { doc, exit, lines: textOf(doc, { name, last, maxDelay: read.doc.max_delay_ms }) }
}
