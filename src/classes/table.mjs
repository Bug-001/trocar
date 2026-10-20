// src/classes/table.mjs — the traffic class table (1.6 §4.2, D60③): WHICH class a call is and HOW MUCH of it is
// kept. A data module, not a policy engine:
//   • the builtin table is GENERATED from data that already exists elsewhere (一个外部事实只写一处):
//     `llm` / `token-count` from the endpoint lists in src/capture/envelope.mjs (the same data the read side uses to
//     tell a model call), the other four from the `traffic` entries on each harness's row in src/dissect/harnesses.mjs
//     plus the shared third-party telemetry hosts in src/dissect/traffic.mjs;
//   • the table is ORDERED and the FIRST matching rule wins; `other` is last, has no rules, and catches the rest;
//   • a rule = a host regex (matched against the WHOLE host, any case) + an optional path regex (matched from the
//     start of the path) + an optional harness. No per-harness, per-product or per-version branch lives here (过拟合必拒).
//   • copy-on-write: the first edit writes the whole table to ~/.asight/classes.json (0600); `reset` deletes it and the
//     builtin table is back. Every edit appends one line (old value, new value, time) to ~/.asight/logs/classes.ndjson.
// A bad argument (class name, regex, rule number, level) throws ClassArgError and writes NOTHING (exit 2); a file that
// cannot be written comes back as { ok: false, error } (exit 1). A user table that cannot be read is never overwritten
// and never silently ignored: the builtin table applies and `problems` says so (D38).
import nodeFs from 'node:fs'
import path from 'node:path'
import { asightHome, classesFile, classesLog } from '../paths.mjs'
import { LLM_ENDPOINT_PATHS, TOKEN_COUNT_ENDPOINT_PATHS, RETENTION_LEVELS } from '../capture/envelope.mjs'
import { HARNESSES } from '../dissect/harnesses.mjs'
import { HARNESS_IDS } from '../cli/harness-names.mjs'
import { THIRD_PARTY_TELEMETRY } from '../dissect/traffic.mjs'

// not exported: the interface is BUILTIN / readTable / classify / keepOf / plan / edit (+ ClassArgError); the CLI prints what
// those return (T8) and the collector reads them (T5).
const CLASSES_VERSION = 1
const CLASS_NAME = /^[a-z0-9-]+$/
const KEEP_LEVELS = RETENTION_LEVELS
/** The classes whose rules come from host + path data, in table order. */
const DATA_CLASSES = ['session-sync', 'telemetry', 'files', 'account']

export class ClassArgError extends Error {
  constructor(message) { super(message); this.name = 'ClassArgError'; this.code = 'bad-args' }
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// harnesses.mjs host patterns are `host` or `*.suffix`; a class rule's host is a regex over the whole host
const hostSource = (pattern) => (String(pattern).startsWith('*.') ? `(?:.*\\.)?${esc(String(pattern).slice(2))}` : esc(pattern))
const rule = (host, pathSource = null, harness = null) => ({ host, path: pathSource, harness })
const cls = (name, keep, rules) => Object.freeze({ class: name, keep, builtin: true, rules: Object.freeze(rules) })

function builtinTable() {
  const out = [
    cls('token-count', 'full', TOKEN_COUNT_ENDPOINT_PATHS.map((p) => rule('.*', p))),
    cls('llm', 'full', LLM_ENDPOINT_PATHS.map((p) => rule('.*', p))),
  ]
  for (const name of DATA_CLASSES) {
    const rules = []
    for (const row of HARNESSES) for (const e of row.traffic || []) {
      // a rule names its harness the way the CLI and the collector do (the descriptor's name), never the read side's short row id
      if (e.class === name) rules.push(rule(hostSource(e.host), e.path || null, row.agents.find((a) => HARNESS_IDS.includes(a)) || null))
    }
    if (name === 'telemetry') for (const h of THIRD_PARTY_TELEMETRY) rules.push(rule(hostSource(h)))
    out.push(cls(name, 'full', rules))
  }
  out.push(cls('other', 'full', []))
  return Object.freeze(out)
}

/** The table asight ships. Ordered; `token-count` before `llm`; `other` last with no rules. */
export const BUILTIN = builtinTable()

const errText = (e) => String((e && e.message) || e)
const compile = (source, anchorEnd, flags = '') => new RegExp(`^(?:${source})${anchorEnd ? '$' : ''}`, flags)

/**
 * readTable({home, fs}) → {classes, file, lastChange, problems}
 *   classes     the table in effect (the user's file, else BUILTIN)
 *   file        the user's file when it exists, else null
 *   lastChange  the last line of the change log, else null
 *   problems    [{code, reason, fatal?}] — a file or an entry that cannot be honoured; fatal = the whole file is
 *               unusable, the builtin table applies and no edit may overwrite it
 */
export function readTable({ home = asightHome(), fs = nodeFs } = {}) {
  const file = classesFile(home)
  const lastChange = readLastChange(classesLog(home), fs)
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    if (e && e.code === 'ENOENT') return { classes: BUILTIN, file: null, lastChange, problems: [] }
    return { classes: BUILTIN, file, lastChange, problems: [{ code: 'classes-unreadable', fatal: true, reason: `${file} cannot be read (${errText(e)}); the builtin class table applies until it can` }] }
  }
  let doc
  try { doc = JSON.parse(text) } catch (e) {
    return { classes: BUILTIN, file, lastChange, problems: [{ code: 'classes-unparsable', fatal: true, reason: `${file} cannot be parsed (${errText(e)}); the builtin class table applies until it can` }] }
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.classes)) {
    return { classes: BUILTIN, file, lastChange, problems: [{ code: 'classes-unparsable', fatal: true, reason: `${file} is not a class table ({"version":1,"classes":[…]}); the builtin class table applies until it is` }] }
  }
  const problems = []
  const classes = []
  for (const entry of doc.classes) {
    const bad = entryProblem(entry, file)
    if (bad) { problems.push(bad); continue }
    const rules = []
    for (const [i, r] of (entry.rules || []).entries()) {
      try { compile(r.host, true, 'i'); if (r.path) compile(r.path, false) } catch (e) {
        problems.push({ code: 'classes-bad-rule', reason: `${file}: rule ${i + 1} of ${entry.class} is not a usable regex (${errText(e)}); it matches nothing` })
        continue
      }
      rules.push(rule(r.host, r.path || null, r.harness || null))
    }
    classes.push({ class: entry.class, keep: entry.keep, builtin: entry.builtin === true, rules })
  }
  return { classes, file, lastChange, problems }
}

function entryProblem(entry, file) {
  if (!entry || typeof entry !== 'object') return { code: 'classes-bad-entry', reason: `${file}: an entry is not an object; it is ignored` }
  if (!CLASS_NAME.test(String(entry.class || ''))) return { code: 'classes-bad-entry', reason: `${file}: ${JSON.stringify(entry.class)} is not a class name ([a-z0-9-]+); the entry is ignored` }
  if (!KEEP_LEVELS.includes(entry.keep)) return { code: 'classes-bad-entry', reason: `${file}: ${entry.class} has keep ${JSON.stringify(entry.keep)}, not ${KEEP_LEVELS.join(' or ')}; the entry is ignored` }
  if (entry.rules != null && !Array.isArray(entry.rules)) return { code: 'classes-bad-entry', reason: `${file}: the rules of ${entry.class} are not a list; the entry is ignored` }
  return null
}

function readLastChange(file, fs) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  for (const line of text.trim().split('\n').reverse()) {
    try { return JSON.parse(line) } catch { /* a half-written line is not the last change */ }
  }
  return null
}

/** classify(table) → ({host, path, harness}) → the class name of that call. First matching rule wins, `other` is the rest. */
export function classify(table) {
  const compiled = []
  for (const c of table.classes || []) {
    for (const r of c.rules || []) {
      try { compiled.push({ class: c.class, host: compile(r.host, true, 'i'), path: r.path ? compile(r.path, false) : null, harness: r.harness || null }) } catch { /* readTable reported it */ }
    }
  }
  return function classOf({ host, path: p, harness } = {}) {
    const h = String(host || ''), ep = String(p || '').split('?')[0]
    for (const r of compiled) {
      if (r.harness && r.harness !== harness) continue
      if (!r.host.test(h)) continue
      if (r.path && !r.path.test(ep)) continue
      return r.class
    }
    return 'other'
  }
}

/** keepOf(table, class) → 'full' | 'log'. A class the table does not name keeps everything (too much loses nothing). */
export function keepOf(table, className) {
  const c = (table.classes || []).find((x) => x.class === className)
  return c && KEEP_LEVELS.includes(c.keep) ? c.keep : 'full'
}

/**
 * edit(op, {home, fs, now}) → {ok, file, written, error?}
 * op = {kind:'set', class, keep} | {kind:'add', class, host, path?, harness?} | {kind:'rm', class, rule?} | {kind:'reset'}, each with an optional
 * `source` ('cli' | 'board', default 'cli') that the change log's line carries, so a change made from the board is told apart (4.4 §控制面).
 * Throws ClassArgError (exit 2) before touching anything when the op does not make sense; comes back ok:false when the
 * file or the log cannot be written (exit 1).
 */
export function edit(op, { home = asightHome(), fs = nodeFs, now = () => new Date() } = {}) {
  const file = classesFile(home)
  const table = readTable({ home, fs })
  const error = fatalOf(table)
  if (error) return { ok: false, file, written: [], error }
  const { classes, log } = apply(op, table.classes)
  const ts = now().toISOString()
  const written = []
  try {
    if (classes === null) { fs.rmSync(file, { force: true }) } else {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.tmp-${process.pid}`
      try {
        fs.writeFileSync(tmp, JSON.stringify({ version: CLASSES_VERSION, updated_at: ts, classes }, null, 2) + '\n', { mode: 0o600 })
        fs.chmodSync(tmp, 0o600)
        fs.renameSync(tmp, file)
      } catch (e) { try { fs.rmSync(tmp, { force: true }) } catch { /* nothing to clean */ } throw e }
      written.push(file)
    }
  } catch (e) { return { ok: false, file, written: [], error: { code: (e && e.code) || 'classes-write-failed', message: `${file} could not be written (${errText(e)})` } } }
  const logFile = classesLog(home)
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 })
    fs.appendFileSync(logFile, JSON.stringify({ ts, ...log, source: op.source || 'cli' }) + '\n', { mode: 0o600 })
    written.push(logFile)
  } catch (e) {
    return { ok: false, file, written, error: { code: (e && e.code) || 'classes-log-failed', message: `the change was made but ${logFile} could not record it (${errText(e)})` } }
  }
  return { ok: true, file, written }
}

const fatalOf = (table) => {
  const fatal = table.problems.find((p) => p.fatal)
  return fatal ? { code: fatal.code, message: `${fatal.reason}; fix or remove the file first, nothing was changed` } : null
}

/**
 * plan(op, {home, fs}) → {before, after, paths} | {error} — what edit(op) would do, and nothing written: the change log's own from / to (the class's
 * whole entry, or for reset the whole table before), so a plan_id over it changes when the table does; and the files edit would write. The same refusals as edit: ClassArgError, or the unreadable table's error.
 */
export function plan(op, { home = asightHome(), fs = nodeFs } = {}) {
  const table = readTable({ home, fs })
  const error = fatalOf(table)
  if (error) return { error }
  const { classes, log } = apply(op, table.classes)
  return { before: log.from, after: log.to, paths: [...(classes || table.file ? [classesFile(home)] : []), classesLog(home)] }
}

/** Throws ClassArgError unless the op's fields are the types the CLI gives: a request body can carry any JSON (4.4 §控制面), and String()
 *  below would turn 7 or [..] into a name or a regex. */
export function checkOp(op) {
  if (!op || typeof op !== 'object') throw new ClassArgError('a change is an object')
  for (const k of ['kind', 'class', 'keep', 'host', 'path', 'harness']) {
    if (op[k] != null && typeof op[k] !== 'string') throw new ClassArgError(`${k} must be a string, not ${JSON.stringify(op[k])}`)
  }
  if (op.rule != null && typeof op.rule !== 'string' && !Number.isInteger(op.rule)) throw new ClassArgError(`rule must be a number, not ${JSON.stringify(op.rule)}`)
}

/** The pure part: the new class list (null = delete the file) and the line that records the change. */
function apply(op, current) {
  checkOp(op)
  const kind = op.kind
  const classes = current.map((c) => ({ ...c, rules: (c.rules || []).map((r) => ({ ...r })) }))
  const find = (name) => classes.find((c) => c.class === name)
  if (kind === 'reset') return { classes: null, log: { op: 'reset', class: null, from: current, to: null } }
  const name = op.class
  if (!CLASS_NAME.test(String(name || ''))) throw new ClassArgError(`${JSON.stringify(name)} is not a class name; use [a-z0-9-]+`)
  const before = find(name)
  const snapshot = before ? JSON.parse(JSON.stringify(before)) : null
  if (kind === 'set') {
    if (!before) throw new ClassArgError(`no class ${JSON.stringify(name)}; see asight classes`)
    if (!KEEP_LEVELS.includes(op.keep)) throw new ClassArgError(`unknown level ${JSON.stringify(op.keep)}; use ${KEEP_LEVELS.join(' or ')}`)
    before.keep = op.keep
    return { classes, log: { op: 'set', class: name, from: snapshot, to: JSON.parse(JSON.stringify(before)) } }
  }
  if (kind === 'add') {
    if (name === 'other') throw new ClassArgError('other is what nothing else matched; it takes no rules')
    const r = rule(String(op.host || ''), op.path ? String(op.path) : null, op.harness ? String(op.harness) : null)
    if (!r.host) throw new ClassArgError('a rule needs a host regex')
    try { compile(r.host, true, 'i') } catch (e) { throw new ClassArgError(`${JSON.stringify(r.host)} is not a usable host regex (${errText(e)})`) }
    if (r.path) try { compile(r.path, false) } catch (e) { throw new ClassArgError(`${JSON.stringify(r.path)} is not a usable path regex (${errText(e)})`) }
    // a new class goes before every builtin one, so your rules are tried first
    const target = before || { class: name, keep: 'full', builtin: false, rules: [] }
    if (!before) classes.unshift(target)
    target.rules.push(r)
    return { classes, log: { op: 'add', class: name, from: snapshot, to: JSON.parse(JSON.stringify(target)) } }
  }
  if (kind === 'rm') {
    if (!before) throw new ClassArgError(`no class ${JSON.stringify(name)}; see asight classes`)
    if (op.rule == null) {
      if (name === 'other') throw new ClassArgError('other cannot be removed: it is what nothing else matched')
      return { classes: classes.filter((c) => c.class !== name), log: { op: 'rm', class: name, from: snapshot, to: null } }
    }
    const i = Number(op.rule)
    if (!Number.isInteger(i) || i < 1 || i > before.rules.length) throw new ClassArgError(`${name} has no rule ${JSON.stringify(op.rule)}; it has ${before.rules.length} (see asight classes ${name})`)
    before.rules.splice(i - 1, 1)
    return { classes, log: { op: 'rm', class: name, rule: i, from: snapshot, to: JSON.parse(JSON.stringify(before)) } }
  }
  throw new ClassArgError(`unknown change ${JSON.stringify(kind)}; use set, add, rm or reset`)
}
