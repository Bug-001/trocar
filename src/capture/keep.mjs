// keep.mjs — `asight keep` (RFC 4.6 §记录「保存级别」·修改, D40): show and set what is kept of each call, per harness × traffic class.
//   asight keep                                   the table: every harness × class, `full` or `log`
//   asight keep <harness|all> <class|all> <full|log>   set cells (one change-log line each); `all` expands
// It reads and writes the settings file directly (setRetention, the same function the board's POST /control/retention calls):
// no daemon has to be running, and nothing already stored is touched (invariant 2). Exit 0 = done, 2 = a name that is not in the
// closed sets (the file is untouched), 1 = the file could not be read or written. The sizes beside each cell are the board's
// 「保存什么」 view and need the DuckDB projection; this command only says what is set.
// Pure over its inputs (argv, files, a writer), so the test runs it without a process; bin/asight.mjs is the thin caller.
import { readRetentionFile, setRetention, RetentionArgError, TRAFFIC_CLASSES, retentionFile, retentionLog } from './retention.mjs'

const USAGE = `usage:
  asight keep                                       show what is kept of each call, per harness × traffic class
  asight keep <harness|all> <class|all> <full|log>  set it: full = the body verbatim (64 MiB cap), log = one line per call (headers and sizes, no body)
  classes: ${TRAFFIC_CLASSES.join(' · ')}`

/** formatKeep({levels, problems, file, harnesses}) → the table as text. */
export function formatKeep({ levels, problems = [], file, harnesses }) {
  const w = Math.max(...harnesses.map((h) => h.length), 7)
  const cw = TRAFFIC_CLASSES.map((c) => Math.max(c.length, 4))
  const lines = [`what is kept of each call · ${file}`]
  if (problems.length) lines.push(`⚠ ${problems.map((p) => p.reason).join('\n⚠ ')}`)
  lines.push('', ['harness'.padEnd(w), ...TRAFFIC_CLASSES.map((c, i) => c.padEnd(cw[i]))].join('  ').trimEnd())
  for (const h of harnesses) lines.push([h.padEnd(w), ...TRAFFIC_CLASSES.map((c, i) => ((levels[h] && levels[h][c]) || 'full').padEnd(cw[i]))].join('  ').trimEnd())
  lines.push('', 'full = the body verbatim (64 MiB cap) · log = one line per call: headers and sizes, no body',
    'A change reaches the calls that start after it (within a second, no restart). What is already stored is never deleted or rewritten.')
  return lines.join('\n')
}

/**
 * runKeep(argv, {out, err, file, logFile, harnesses}) → exit code. `argv` = the arguments after `keep`.
 * `harnesses` = the ids the settings may name (the read-side table's, plus `unknown`), from the caller: this module names none.
 */
export function runKeep(argv, { out = (s) => console.log(s), err = (s) => console.error(s), file = retentionFile(), logFile = retentionLog(), harnesses = [], source = 'cli' } = {}) {
  const args = argv.filter((a) => !a.startsWith('--'))
  if (argv.includes('--help') || argv.includes('-h')) { out(USAGE); return 0 }
  if (args.length === 0) {
    const r = readRetentionFile(file)
    out(formatKeep({ levels: r.levels, problems: r.problems, file, harnesses }))
    return 0
  }
  if (args.length !== 3) { err(`asight keep: expected <harness|all> <class|all> <full|log>, got ${args.length} argument(s)\n${USAGE}`); return 2 }
  const [harness, cls, level] = args
  try {
    const res = setRetention({ file, logFile, harness, class: cls, level, source, harnesses })
    if (!res.changed.length) out(`no change: ${harness === 'all' ? 'every harness' : harness} · ${cls === 'all' ? 'every class' : cls} is already ${level}`)
    else {
      for (const c of res.changed) out(`${c.harness} · ${c.class}: ${c.from} → ${c.to}`)
      out('applies to the calls that start from now on (within a second); what is already stored is not changed')
    }
    if (res.logError) err(`asight keep: the change was made, but its record in ${logFile} could not be written (${res.logError})`)
    return 0
  } catch (e) {
    if (e instanceof RetentionArgError || (e && e.code === 'bad-args')) { err(`asight keep: ${e.message}\n${USAGE}`); return 2 }
    err(`asight keep: ${(e && e.message) || e}`)
    return 1
  }
}
