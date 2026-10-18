// classes.mjs — `asight classes …` (RFC 1.6 §4.2, D60): your traffic classes, shown and edited. This file parses, calls and prints:
// what is shown is `asight query classes`'s own document (src/query/named/classes.mjs) and what is changed goes through
// src/classes/table.mjs `edit`, so the counts here and on the board, and the rules here and in the collector, are the same answer.
// A bad class name, regex or rule number is exit 2 with one line and nothing written (edit throws before it touches a file).
import { EXIT, newReceipt } from './schema.mjs'
import { printJson, errorDoc } from './json.mjs'
import { columns, colors, size, tilde, ago, wrap } from './text.mjs'
import { usageLine, commandNamed } from './commands.mjs'
import { resolveHarnesses } from './harness-names.mjs'
import { asightHome } from '../off/paths.mjs'
import { readTable, edit, ClassArgError } from '../classes/table.mjs'
import { runQuery } from '../query/named/index.mjs'

const EDITS = ['set', 'add', 'rm', 'reset']
const errText = (e) => String((e && e.message) || e)
/** What a class of the builtin table holds, in words, for the MATCHES column (§4.2 的样例). A class of yours is its own rules. */
const WHAT = Object.freeze({ llm: 'model API calls', 'token-count': 'token counting', 'session-sync': 'session sync', telemetry: 'telemetry', files: 'file uploads', account: 'account and billing', other: 'everything else' })

const rules = (c) => c.rules || []
/** The MATCHES cell: what the class is for, and how many rules say so; a class of yours with one rule shows that rule. */
function matches(c) {
  const n = rules(c).length, what = WHAT[c.class]
  if (c.in_table === false) return 'no longer in the table'
  if (!n) return what || 'no rules'
  if (what) return `${what}, ${n} rule${n === 1 ? '' : 's'}`
  if (n === 1) return [rules(c)[0].host, rules(c)[0].path].filter(Boolean).join(' ')
  return `${n} rules`
}
const keepOf = (c) => c.keep || 'not set'

/** `asight classes` (§4.2): one line per class with its level, what it matches and what it stored over the three windows. */
export function classesTable(doc, { home = null, colors: c } = {}) {
  const head = ['CLASS', 'KEEP', 'MATCHES', '24 H', '7 D', 'ALL']
  const rows = doc.classes.map((x) => [x.class, keepOf(x), matches(x), size(x.counts.h24.bytes), size(x.counts.d7.bytes), size(x.counts.all.bytes)])
  const [first, ...body] = columns([head, ...rows])
  return [c.bold(first), ...body, '',
    c.dim(`Sizes are what is stored. ${tilde(asightHome(home), home)} uses ${size(doc.disk.asight_bytes)} in all.`),
    c.dim('full keeps whole requests and responses; log keeps headers and sizes only.'),
    c.dim('Change what is kept with asight classes set; the rules with add or rm.')]
}

/** `asight classes <class>` (§4.2): the class, where its level comes from, and its rules by number. */
export function classDetail(doc, name, { now = Date.now(), colors: c } = {}) {
  const x = doc.classes.find((y) => y.class === name)
  const change = doc.last_change && doc.last_change.class === name ? `, changed ${ago(doc.last_change.ts, now)}` : ''
  // Whose table it is, is the table's own question, not the class's: every class of your copy is yours to change,
  // and `builtin` only records where the entry came from (src/classes/table.mjs: the first edit copies the whole table).
  const where = x.in_table === false ? 'not in the table any more' : doc.file ? 'yours' : 'as asight ships it'
  const out = [`${c.bold(name)}: keep ${keepOf(x)} (${where}${change})`]
  if (!rules(x).length) return [...out, '', `  ${matches(x)}`]
  const [head, ...body] = columns([['RULE', 'HOST', 'PATH', 'HARNESS'],
    ...rules(x).map((r, i) => [String(i + 1), r.host, r.path || 'any', r.harness || 'any'])])
  return [...out, '', `  ${c.bold(head)}`, ...body.map((l) => `  ${l}`)]
}

/** A class before and after a change, in one phrase (`keep full, 17 rules`). */
const brief = (c) => (c ? `keep ${keepOf(c)}, ${rules(c).length} rule${rules(c).length === 1 ? '' : 's'}` : 'not in the table')

/** The receipt of a change (§4.2): the class before and after, the files written, and what the change does and does not touch. */
export function changeLines(r, { home = null } = {}) {
  const said = { removed: 'Removed', written: 'Wrote', appended: 'Recorded the change in' }
  const out = [r.before === null && r.after === null
    ? 'classes: the table is as asight ships it again'
    : `${r.class || 'classes'}: ${brief(r.before)} -> ${brief(r.after)}`]
  for (const f of r.changed) out.push(`${said[f.change]} ${tilde(f.path, home)}`)
  return [...out, ...wrap('It applies to calls made from now on; what is already stored does not change.')]
}

/** C.1 `undo`: the one line that puts this edit back. A `reset` threw the whole table away and no single line writes it back, so it is `null` (R11: what is not there is not claimed). */
function undoEdit(op, before, after) {
  if (op.kind === 'set') return before && before.keep ? `asight classes set ${op.class} ${before.keep}` : null
  if (op.kind === 'add') return `asight classes rm ${op.class} ${((after && after.rules) || []).length}`
  if (op.kind === 'rm') {
    const gone = ((before && before.rules) || [])[Number(op.rule) - 1]
    return gone ? `asight classes add ${op.class} ${gone.host}${gone.path ? ` ${gone.path}` : ''}${gone.harness ? ` --harness ${gone.harness}` : ''}` : null
  }
  return null
}

/** The edit `positionals` ask for, `null` when they are not a usable change, `undefined` when they are not a change at all. */
function opOf(pos, flags) {
  const [kind, name, a, b] = pos
  if (!EDITS.includes(kind)) return undefined
  if (kind === 'reset') return pos.length === 1 ? { kind } : null
  if (kind === 'set') return pos.length === 3 ? { kind, class: name, keep: a } : null
  if (kind === 'add') return pos.length === 3 || pos.length === 4 ? { kind, class: name, host: a, path: b || null, harness: flags.harness || null } : null
  return pos.length === 2 || pos.length === 3 ? { kind: 'rm', class: name, rule: a } : null
}

/** → the exit code. `argv` is what follows `classes`; the parsed form is `ctx.args` ({ positionals, flags }). */
export async function run(argv, { io, json, args, home, deps = {} }) {
  const refuse = (code, message, { exit = EXIT.usage, usage = false } = {}) => {
    if (json) printJson(io, errorDoc('classes', code, message))
    else { for (const line of wrap(message)) io.err(line); if (usage) io.err(usageLine(commandNamed('classes'))) } // §1.1⑥: folded, never ragged past 80 columns
    return exit
  }
  const op = opOf(args.positionals, args.flags)
  if (op === null) return refuse('usage', `asight classes: ${args.positionals[0]} does not take these arguments.`, { usage: true })
  const asight = asightHome(home)
  const c = colors(io)
  if (op) {
    const named = resolveHarnesses(op.harness ? [op.harness] : [])
    if (!named.ok) return refuse('usage', `asight classes: no agent called ${named.unknown.join(', ')}. Known: ${named.known.join(', ')}`)
    if (named.ids) op.harness = named.ids[0]
    const was = readTable({ home: asight })
    const before = was.classes.find((x) => x.class === op.class) || null
    let result
    try { result = edit(op, { home: asight }) } catch (e) {
      if (e instanceof ClassArgError) return refuse('usage', `asight classes ${op.kind}: ${errText(e)}`)
      throw e
    }
    if (!result.ok) return refuse(result.error.code, `asight classes ${op.kind}: ${result.error.message}`, { exit: EXIT.incomplete })
    const after = op.kind === 'reset' ? null : readTable({ home: asight }).classes.find((x) => x.class === op.class) || null
    const changed = op.kind === 'reset' && was.file ? [{ path: result.file, change: 'removed', backup: null }] : []
    for (const p of result.written) changed.push({ path: p, change: p === result.file ? 'written' : 'appended', backup: null })
    const receipt = {
      ...newReceipt('classes'), class: op.kind === 'reset' ? null : op.class,
      before: op.kind === 'reset' ? null : before, after, changed, undo: undoEdit(op, before, after),
    }
    if (json) printJson(io, receipt)
    else for (const line of changeLines(receipt, { home })) io.out(line)
    return EXIT.ok
  }
  const [name, ...extra] = args.positionals
  if (extra.length) return refuse('usage', 'asight classes: one class at a time.', { usage: true })
  const doc = await runQuery('classes', {}, { home: asight })
  if (json) { printJson(io, doc); return EXIT.ok }
  if (name !== undefined && !doc.classes.some((x) => x.class === name)) return refuse('usage', `asight classes: there is no class ${name}. Run: asight classes`)
  const now = (deps.ms || Date.now)()
  for (const line of name === undefined ? classesTable(doc, { home, colors: c }) : classDetail(doc, name, { now, colors: c })) io.out(line)
  for (const e of doc.errors) io.err(`Could not read ${e.where}: ${e.reason}`)
  return doc.ok ? EXIT.ok : EXIT.incomplete
}
