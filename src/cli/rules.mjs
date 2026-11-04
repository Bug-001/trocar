// rules.mjs — `trocar rules …` (RFC 1.6 §4.4, 附录 C.1, C.2; 5.1 §怎么写): the rule file shown and edited. This file parses, calls and prints: what is shown is
// `trocar query rules`'s own document, what is changed goes through src/rules/file.mjs `edit`, and the daemon hears of it over the control socket afterwards.
// A verb answers `{doc, lines, exit?}`: `--json` prints the doc, a person reads the lines, and both exit alike.
import nodeFs from 'node:fs'
import { EXIT, newReceipt } from './schema.mjs'
import { printJson, errorDoc } from './json.mjs'
import { colors, columns, ago, pairs, size, tilde, wrap } from './text.mjs'
import { commandNamed } from './commands.mjs'
import { testRule } from './rules-test.mjs'
import { controlEndpointFor } from '../off/control-client.mjs'
import { trocarHome } from '../off/paths.mjs'
import { collectorHome, rulesFile, rulesLog } from '../paths.mjs'
import { runQuery, QueryArgError } from '../query/named/index.mjs'
import { ENGINE_ACTIONS, LIMITS } from '../rules/closed.mjs'
import { parseCondition, patterns } from '../rules/conditions.mjs'
import { buffersOf } from '../rules/describe.mjs'
import { edit, readBounded, readRules, RuleRefused } from '../rules/file.mjs'
import { isArmed, readRuleFacts, ruleState } from '../rules/state.mjs'
import { actionKind, checkRule, conditionsOf, normalizeRule, parseRulesBytes } from '../rules/validate.mjs'

const DAEMON_TIMEOUT_MS = 3000
const WORDS = Object.freeze({ live: 'live', resting: 'resting', waiting: 'waits for on', 'stopped-by-off': 'stopped by off', 'limit-reached': 'limit reached', 'process-gone': 'process ended', 'load-failed': 'not loaded', disabled: 'off', tripped: 'not running' })
const UNIT = Object.freeze({ request: 'request', response: 'response', 'ws-client': 'message', 'ws-server': 'message' })
const READS = Object.freeze(['the head only', 'the body, by a plain scan', 'the body, parsed'])
const GATHERS = Object.freeze({ none: 'nothing', request: 'the whole request', stream: 'each event', message: 'the whole message', response: 'the whole response' })
const NO_HELD = Object.freeze({ released: 0, cut: 0 })

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const exitOf = (code) => (['usage', 'rule-invalid', 'rule-unknown'].includes(code) ? EXIT.usage : EXIT.incomplete)
const refused = (command, { code, message }) => ({ doc: errorDoc(command, code, `trocar ${command}: ${message}`) })
const failureOf = (e) => e.error ?? { code: 'rule-invalid', message: `${e.invalid[0].path}: ${e.invalid[0].reason}` }
const disarm = ({ armed: _armed, armed_at: _at, script_entry_sha256: _script, ...rule }) => rule

/** POST to the daemon → 'absent' when nobody is there or it has no such route yet, 'no-answer' when it is there and did not answer, or `{answer}`. */
async function notifyDaemon(c, route) {
  const { socketPath, request } = controlEndpointFor({ platform: c.platform, dir: collectorHome(c.home), env: c.env })
  if (!socketPath) return 'absent'
  try { return { answer: await request({ socketPath, method: 'POST', path: route, timeoutMs: DAEMON_TIMEOUT_MS }) } } catch (e) {
    return e.status === 404 || e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'absent' : 'no-answer'
  }
}

/** What a daemon's reply says it did with the held units: nothing when there is no daemon, not known when it did not say. */
const heldOf = (said) => (said === 'absent' ? { ...NO_HELD } : said.answer?.held ?? 'unknown')

function heldLines(held) {
  if (held === 'unknown') return ['What happened to held requests is not known.']
  return held.released + held.cut ? [`${plural(held.released, 'held request')} released, ${held.cut} cut.`] : []
}

/** The receipt's fields for what an edit wrote, and the lines that say so. */
function wrote(c, e) {
  const file = rulesFile(c.home), log = rulesLog(c.home)
  const changed = e.written.map((p) => ({ path: p, change: p === file ? 'written' : p === log ? 'appended' : 'renamed', backup: null }))
  const said = { written: 'Wrote', appended: 'Recorded the change in', renamed: 'Kept the old file as' }
  return {
    fields: { changed, log: e.written.includes(log) ? log : null },
    problems: e.log_failed ? [`The change could not be recorded in ${log}: ${e.log_failed}.`] : [],
    lines: changed.map((x) => `${said[x.change]} ${tilde(x.path, c.user)}`),
  }
}

/** Tells the daemon the file changed → the receipt's `loaded`, `held` and the problem when it did not hear. */
async function reload(c) {
  const said = await notifyDaemon(c, '/rules/reload')
  const heard = said !== 'no-answer'
  return { said, loaded: said === 'absent' ? null : heard, problems: heard ? [] : ['The collector did not answer, so this may not be in force yet.'] }
}

const withProblems = (receipt, problems) => (problems.length ? { ...receipt, problems } : receipt)

/** 1.6 §4.4: a reminder per way of writing a rule. `stream` and not `on: response`: a rule that only touches the head of a response gathers no body to run out of time on. */
function notesOf(rule) {
  const kinds = rule.do.map(actionKind), holds = kinds.includes('hold'), out = []
  if (rule.whole === true) out.push(`This rule delays the whole response: the agent gets no byte until it is complete, up to ${size(LIMITS.bodyBytes)} and 10 minutes.`)
  if (rule.on_error === 'drop') out.push('on_error drop: this rule cuts the connection whenever it cannot judge a request, for any reason, so write its conditions narrowly. On its hosts that includes connections trocar doesn\'t decrypt, connections that aren\'t HTTP, and connections where it can\'t see where requests start.')
  if (buffersOf(rule) === 'stream' && rule.on === 'response') out.push(`This rule does not apply to a response that isn't SSE and doesn't finish within the max delay: ${rule.on_error === 'drop' ? 'the response is cut, each time' : 'the response passes unchanged'}. Add "whole": true to wait for the whole response.`)
  if (holds) out.push('A hold longer than the upstream\'s idle timeout closes the agent\'s connection only on a tunnel or a credentialed proxy; elsewhere trocar dials again on release.')
  return out
}

/** The bytes `rules add` was pointed at. A pipe is `-`, so a named path holds to what the rule file itself holds to: a bounded read of a regular file. */
async function inputBytes(c, source) {
  if (source !== '-') return readBounded(nodeFs, source, LIMITS.fileBytes + 1)
  const chunks = []
  let got = 0
  for await (const chunk of c.io.stdin) {
    chunks.push(Buffer.from(chunk))
    if ((got += chunk.length) > LIMITS.fileBytes) break
  }
  return Buffer.concat(chunks)
}

/** The first regex of a rule that does not parse, and why. The shared check cannot tell, because the daemon goes through it and builds no regex; here building one only parses it. */
function badRegex(rule) {
  const selectors = [rule.match.blocks, ...rule.do.map((action) => action.blocks)].filter((selector) => selector?.text !== undefined)
  const written = [...conditionsOf(rule.match), ...selectors.map(({ text }) => ({ path: 'blocks.text', key: 'body', value: text }))]
    .flatMap(({ path, key, value }) => patterns(parseCondition(value, { key })).map((source) => ({ path, source })))
  written.push(...rule.do.filter((action) => actionKind(action) === 'replace' && action.literal !== true).map((action) => ({ path: 'replace', source: action.replace })))
  for (const { path, source } of written) {
    try { new RegExp(source, 'u') } catch (e) { return `${path}: ${e.message}` }
  }
  return null
}

async function parsedInput(c, source) {
  let bytes
  try { bytes = await inputBytes(c, source) } catch (e) { return { problem: `${source} cannot be read: ${e.code === 'ENOENT' ? 'there is no such file' : e.message}` } }
  const { doc, problem } = parseRulesBytes(bytes)
  if (problem) return { problem: `${source}: ${problem.reason}` }
  const rule = normalizeRule(doc), [first] = checkRule(rule, { input: true })
  if (first) return { problem: `${first.path ? `${first.path}: ` : ''}${first.reason}` }
  const bad = badRegex(rule)
  return bad ? { problem: bad } : { rule }
}

async function add(c, [source]) {
  const command = 'rules add', replace = c.flags.replace === true, dryRun = c.flags['dry-run'] === true
  const { rule, problem } = await parsedInput(c, source)
  if (problem) return refused(command, { code: 'rule-invalid', message: problem })
  let gone = null
  const e = edit((doc) => {
    const at = doc.rules.findIndex((r) => r.name === rule.name)
    if (at < 0) return { ...doc, rules: [...doc.rules, rule] }
    if (!replace) throw new RuleRefused('rule-invalid', `there is already a rule called ${rule.name}. Use --replace to change it.`)
    gone = doc.rules[at]
    return { ...doc, rules: doc.rules.with(at, rule) }
  }, { home: c.home, op: 'add', dryRun })
  if (!e.ok) return refused(command, failureOf(e))

  const notes = [...notesOf(rule), ...(gone && isArmed(gone) ? [`${rule.name} was on and is off now. Run trocar rules enable ${rule.name} to turn it back on.`] : [])]
  const base = { ...newReceipt(command), rules: [{ name: rule.name, state: 'disabled' }], notes, undo: gone ? null : `trocar rules rm ${rule.name}` }
  const change = gone ? 'replace' : 'add'
  const head = `${rule.name}: ${gone ? 'replaced' : 'added'}. It stays off until trocar rules enable ${rule.name}.`
  const told = notes.flatMap((n) => wrap(n))
  if (dryRun) return { doc: { ...base, loaded: null, dry_run: true, planned: [{ name: rule.name, change, state: 'disabled', notes }] }, lines: [`Would be ${head}`, ...told, 'Nothing was written.'] }
  const w = wrote(c, e), r = await reload(c)
  return { doc: withProblems({ ...base, ...w.fields, loaded: r.loaded }, [...w.problems, ...r.problems]), lines: [...wrap(head), ...told, ...w.lines] }
}

/** The rules `names` call for, or the edit is given up: all of them or none. */
function named(doc, names) {
  const missing = names.filter((name) => !doc.rules.some((r) => r.name === name))
  if (missing.length) throw new RuleRefused('rule-unknown', `there is no rule called ${missing.join(', ')}.`)
  return doc.rules.filter((r) => names.includes(r.name))
}

/** Until the engine carries actions out, this is where every enable ends; the part of it that turns a rule on comes with the engine (5.1 §还没实现的动作不能假装生效). */
function enable(c, names) {
  const e = edit((doc) => {
    const lacking = named(doc, names).flatMap((rule) => {
      const { on, do: actions } = normalizeRule(rule)
      return actions.map(actionKind).filter((kind) => !ENGINE_ACTIONS.includes(kind)).map((kind) => `${rule.name} needs ${kind} on ${on}`)
    })
    if (lacking.length) throw new RuleRefused('engine-unsupported', `the engine cannot run this yet, so no rule was turned on: ${lacking.join(', ')}.`)
    throw new Error('rules enable has no way to turn a rule on')
  }, { home: c.home, op: 'enable' })
  return refused('rules enable', e.error)
}

async function stop(c, names, { verb, change, past }) {
  const command = `rules ${verb}`
  let wasOn = []
  const e = edit((doc) => {
    const rules = named(doc, names)
    wasOn = rules.filter(isArmed).map((r) => r.name)
    return { ...doc, rules: doc.rules.flatMap((r) => (names.includes(r.name) ? change(r) : [r])) }
  }, { home: c.home, op: verb })
  if (!e.ok) return refused(command, failureOf(e))
  const w = wrote(c, e), r = await reload(c), held = heldOf(r.said)
  const undo = verb === 'disable' && wasOn.length ? `trocar rules enable ${wasOn.join(' ')}` : null
  const doc = { ...newReceipt(command), ...w.fields, undo, rules: names.map((name) => ({ name, state: verb === 'rm' ? null : 'disabled' })), loaded: r.loaded, held, notes: [] }
  return { doc: withProblems(doc, [...w.problems, ...r.problems]), lines: [...wrap(`${past}: ${names.join(', ')}.`), ...heldLines(held), ...w.lines] }
}

/** What a run of `rules off` amounts to, in the words of 1.6 §4.4: the line it leads with, and what is still wrong. */
function offOutcome(memory, written, seq) {
  if (written && memory !== 'no-answer') return { lead: 'All rules are off.', problems: [] }
  if (written) return { lead: 'The rule file has every rule off.', problems: ['Until the collector reads the file, rules may still be acting.'] }
  if (memory === 'stopped') return { lead: 'All rules have stopped, but the rule file was not changed.', problems: [seq.written ? 'Only trocar rules enable brings a rule back.' : 'The collector could not record the stop either, so the rules come back when it restarts.'] }
  if (memory === 'no-daemon') return { lead: 'The rule file was not changed.', problems: ['The collector is not running, and the rules come back when it starts.'] }
  return { lead: 'Rules have not stopped.', problems: ['The collector did not answer and the rule file was not changed. To take trocar out of the way: trocar off'] }
}

async function off(c) {
  const command = 'rules off'
  const said = await notifyDaemon(c, '/rules/off')
  const memory = said === 'absent' ? 'no-daemon' : said === 'no-answer' ? 'no-answer' : 'stopped'
  const e = edit((doc) => ({ ...doc, rules: doc.rules.map(disarm) }), { home: c.home, op: 'off', onBad: 'aside' })
  const seq = memory === 'stopped' ? said.answer.seq ?? { written: false, reason: 'the collector did not say' } : undefined
  const held = heldOf(said)

  const was = (e.before ?? readRules({ home: c.home }).doc).rules.filter(isArmed)
  const { facts } = readRuleFacts({ home: c.home })
  const rules = was.map((rule) => ({ name: rule.name, state: e.ok ? 'disabled' : ruleState(rule, facts) }))
  const moved = e.written.filter((p) => p !== rulesFile(c.home) && p !== rulesLog(c.home))
  const notes = [...moved.map((p) => `${rulesFile(c.home)} could not be used. It is kept as ${p}.`), ...(e.kept_delay === false ? [`The max delay could not be read from it, so it is ${e.after.max_delay_ms} ms now.`] : [])]

  const reason = e.ok ? null : failureOf(e).message
  const failure = reason ? { code: 'rules-unwritable', message: reason } : memory === 'no-answer' ? { code: 'rules-no-answer', message: 'the collector did not answer.' } : null
  const { lead, problems } = offOutcome(memory, e.ok, seq)
  const w = wrote(c, e)
  const doc = { ...newReceipt(command), ...w.fields, ok: e.ok && memory !== 'no-answer', rules, memory, file: { written: e.ok, reason },
    ...(seq ? { seq } : {}), held, notes, problems: [...problems, ...w.problems], ...(failure ? { error: { ...failure, message: `trocar ${command}: ${failure.message}` } } : {}) }
  return { doc, lines: [[lead, ...heldLines(held)].join(' '), ...notes.flatMap((n) => wrap(n))], exit: doc.ok ? EXIT.ok : EXIT.incomplete }
}

function shownDelay(c) {
  const read = readRules({ home: c.home })
  const doc = { ...newReceipt('rules max-delay'), max_delay_ms: read.doc.max_delay_ms, loaded: null }
  return { doc: withProblems(doc, read.problem ? [`${rulesFile(c.home)} cannot be used: ${read.problem.reason}.`] : []), lines: [`Max delay: ${doc.max_delay_ms} ms.`] }
}

async function maxDelay(c, [value]) {
  if (value === undefined) return shownDelay(c)
  const command = 'rules max-delay', ms = /^[0-9]+$/.test(value) ? Number(value) : NaN
  if (!(ms >= 1 && ms <= LIMITS.maxDelayMs)) return refused(command, { code: 'usage', message: `the max delay is a whole number of milliseconds from 1 to ${LIMITS.maxDelayMs}.` })
  const e = edit((doc) => ({ ...doc, max_delay_ms: ms }), { home: c.home, op: 'max-delay' })
  if (!e.ok) return refused(command, failureOf(e))
  const w = wrote(c, e), r = await reload(c), before = e.before.max_delay_ms
  const doc = { ...newReceipt(command), ...w.fields, undo: before === ms ? null : `trocar rules max-delay ${before}`, max_delay_ms: ms, before, loaded: r.loaded }
  return { doc: withProblems(doc, [...w.problems, ...r.problems]), lines: [`Max delay: ${ms} ms, was ${before} ms. It applies from the next request.`, ...w.lines] }
}

const lastChange = (r, now) => (r.last_change ? ago(r.last_change, now) : 'never')

/** The line under the table about a rule that is resting: what stopped it and when it tries again (§4.4 的样例). */
function restingLines(r, maxMs) {
  const why = r.not_applied_by.timeout === r.not_applied ? `: it took longer than ${maxMs} ms` : ''
  const again = new Date(r.resting_until).toTimeString().slice(0, 5)
  return [...wrap(`${r.name} did not apply to ${plural(r.not_applied, UNIT[r.on])}${why}. Trying again at ${again}.`), `Details: trocar query interventions --rule ${r.name} --skipped`]
}

/** `trocar rules` (§4.4): how many rules act, then a line per rule. */
function listLines(doc, { now, c }) {
  const count = (...states) => doc.rules.filter((r) => states.includes(r.state)).length
  const live = count('live', 'resting'), rest = doc.rules.length - live - count('disabled')
  const delay = `Max delay ${doc.max_delay_ms} ms.`
  if (!doc.rules.length) return [`No rules. ${delay}`, c.dim('Add one with trocar rules add <file>.')]
  const [head, ...body] = columns([['RULE', 'ON', 'STATE', 'CHANGES', 'NOT APPLIED', 'LAST CHANGE'],
    ...doc.rules.map((r) => [r.name, r.on, WORDS[r.state], String(r.changes), String(r.not_applied), lastChange(r, now)])])
  const resting = doc.rules.filter((r) => r.state === 'resting').flatMap((r) => ['', ...restingLines(r, doc.max_delay_ms)])
  return [`${plural(live, 'rule')} live, ${count('disabled')} off${rest ? `, ${rest} not running` : ''}. ${delay}`, '', `  ${c.bold(head)}`, ...body.map((l) => `  ${l}`), ...resting]
}

/** `trocar rules <name>` (§4.4): the rule's sentence, then what it costs and what it has done. */
function detailLines(doc, { now, c }) {
  const [r] = doc.rules
  const { limit } = r
  return [`${c.bold(r.name)}: ${WORDS[r.state]}`, ...wrap(r.summary), '', ...pairs([
    ...(r.note === null ? [] : [['Note', r.note]]),
    ['Reads', READS[r.tier]],
    ['Gathers', GATHERS[r.buffers]],
    ['On error', r.on_error === 'drop' ? 'cut the connection' : 'pass it unchanged'],
    ...(limit.times === null ? [] : [['Limit', `${limit.used} of ${limit.times} changes`]]),
    ...(limit.until === null ? [] : [['Until', limit.until]]),
    ...(r.stopped_on.length ? [['Stopped on', r.stopped_on.join(', ')]] : []),
    ['Changes', `${r.changes}, last ${lastChange(r, now)}`],
    ['Not applied', String(r.not_applied)],
  ])]
}

async function show(c, [name]) {
  let doc
  try { doc = await runQuery('rules', name === undefined ? {} : { rule: name }, { home: c.home }) } catch (e) {
    if (e instanceof QueryArgError) return refused('rules', { code: 'rule-unknown', message: `there is no rule called ${name}.` })
    throw e
  }
  const say = { now: c.now(), c: colors(c.io, c.env) }
  const broken = doc.errors.some((e) => e.where === 'rules.json')
  return { doc, exit: EXIT.ok, lines: broken ? [] : name === undefined ? listLines(doc, say) : detailLines(doc, say), errors: doc.errors.map((e) => `Could not read ${e.where}: ${e.reason}`) }
}

const VERBS = Object.freeze({
  add: { args: [1, 1], flags: ['replace', 'dry-run'], run: add },
  enable: { args: [1, Infinity], run: (c, names) => enable(c, [...new Set(names)]) },
  disable: { args: [1, Infinity], run: (c, names) => stop(c, [...new Set(names)], { verb: 'disable', change: (r) => [disarm(r)], past: 'Turned off' }) },
  rm: { args: [1, Infinity], run: (c, names) => stop(c, [...new Set(names)], { verb: 'rm', change: () => [], past: 'Removed' }) },
  off: { args: [0, 0], run: off },
  'max-delay': { args: [0, 1], run: maxDelay },
  test: { args: [1, 1], flags: ['ref', 'last', 'with-live', 'as-sent', 'run-script'], run: testRule },
})

/** → the exit code. `argv` is what follows `rules`; the parsed form is `ctx.args` ({ positionals, flags }). */
export async function run(argv, { io, json, args, home, env, platform, deps = {} }) {
  const [first, ...rest] = args.positionals
  const verb = Object.hasOwn(VERBS, first ?? '') ? first : null
  const given = verb ? rest : args.positionals
  const [least, most] = verb ? VERBS[verb].args : [0, 1]
  const flags = Object.keys(args.flags).filter((f) => f !== 'json')
  const c = { io, env, platform, json, flags: args.flags, user: home, home: trocarHome(home), now: deps.ms || Date.now }
  const misused = given.length < least || given.length > most || flags.some((flag) => !(verb && VERBS[verb].flags?.includes(flag)))
  const out = misused ? refused(verb ? `rules ${verb}` : 'rules', { code: 'usage', message: 'this does not take these arguments.' })
    : await (verb ? VERBS[verb].run(c, given) : show(c, given))
  const { doc, lines = [], errors = [] } = out
  if (json) printJson(io, doc)
  else {
    for (const line of lines) io.out(line)
    for (const line of errors) io.err(line)
    if (doc.error) for (const line of wrap(doc.error.message)) io.err(line)
    for (const problem of doc.problems ?? []) for (const line of wrap(problem)) io.err(line)
    if (misused) io.err(commandNamed('rules').usage.split('\n').find((l) => l.includes(` ${verb}`)) ?? commandNamed('rules').usage.split('\n')[0])
  }
  return out.exit ?? (doc.ok ? EXIT.ok : exitOf(doc.error.code))
}
