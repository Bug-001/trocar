// keep.mjs — `asight keep` (RFC 4.6 §记录「保存级别」·修改, D40): show and set what is kept of each call, per harness × traffic class.
//   asight keep                                   the table: every harness × class, `full` or `log`
//   asight keep <harness|all> <class|all> <full|log>   set cells (one change-log line each); `all` expands
// It reads and writes the settings file directly (setRetention, the same function the board's POST /control/retention calls):
// no daemon has to be running, and nothing already stored is touched (invariant 2). Exit 0 = done, 2 = a name that is not in the
// closed sets (the file is untouched), 1 = the file could not be read or written. The sizes (formatKeepSizes) need the DuckDB
// projection: bin/asight.mjs builds the report (src/query/retention.mjs, the same function the board's /api/retention calls) and hands it
// here as DATA, so this module stays a leaf that imports nothing of the read side.
// Pure over its inputs (argv, files, a writer), so the test runs it without a process; bin/asight.mjs is the thin caller.
import { readRetentionFile, setRetention, RetentionArgError, TRAFFIC_CLASSES, retentionFile, retentionLog } from './retention.mjs'

const USAGE = `usage:
  asight keep                                       show what is kept of each call, per harness × traffic class, and what each takes
                                                    (--db <store> reads the sizes from another analytics store; --json prints the whole report)
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

const KiB = 1024;
export const fmtBytes = (n) => (n < KiB ? `${n} B` : n < KiB ** 2 ? `${(n / KiB).toFixed(1)} KiB` : n < KiB ** 3 ? `${(n / KiB ** 2).toFixed(1)} MiB` : `${(n / KiB ** 3).toFixed(2)} GiB`);
const WINDOW_NAMES = { '24h': 'last 24 h', '7d': 'last 7 d', all: 'all' };
const KEPT = { full: 'full', log: 'log', 'legacy-meta': 'before D40 (length only)' };

/**
 * formatKeepSizes(report) → the size view as text lines: per window, per (harness, class, kept) the calls, the body bytes that went over the
 * wire (request + response) and the bytes stored; then what ~/.asight takes. Every number says where it comes from; what is not known is
 * said, never 0: no store → 「需要先跑 asight etl」, a response size never recorded → 「未记录」, the sealed size → 「估计」.
 */
export function formatKeepSizes(report) {
  const out = [''];
  const s = report.sizes;
  if (!s) {
    out.push(`sizes: ${report.sizes_reason || '需要先跑 asight etl'}`);
  } else {
    out.push(`sizes · from the analytics store as of ${s.as_of || '(it is empty)'} (the last asight etl) — not live; windows end ${s.windows_end}`);
    for (const [win, label] of Object.entries(WINDOW_NAMES)) {
      const rows = s.rows.filter((r) => r.windows[win].calls > 0);
      out.push('', `  ${label}`);
      if (!rows.length) { out.push('    (no calls)'); continue; }
      const w = Math.max(...rows.map((r) => `${r.harness} · ${r.class}`.length), 8);
      out.push(`    ${'harness · class'.padEnd(w)}  ${'kept'.padEnd(23)}  ${'calls'.padStart(7)}  ${'wire bytes'.padStart(24)}  ${'stored'.padStart(10)}${s.estimate && s.estimate.estimate ? '  once sealed (估计)' : ''}`);
      for (const r of rows) {
        const x = r.windows[win];
        const unrec = x.response_unrecorded ? ` + 响应未记录 ×${x.response_unrecorded}` : '';
        const stored = x.stored_unrecorded ? `${fmtBytes(x.stored_bytes)}+?` : fmtBytes(x.stored_bytes);
        out.push(`    ${`${r.harness} · ${r.class}`.padEnd(w)}  ${(KEPT[r.retention] || r.retention).padEnd(23)}  ${String(x.calls).padStart(7)}  ${(fmtBytes(x.request_bytes + x.response_bytes) + unrec).padStart(24)}  ${stored.padStart(10)}${x.sealed_estimate_bytes != null ? `  ~${fmtBytes(x.sealed_estimate_bytes)}` : ''}`);
      }
    }
    out.push('', 'wire bytes = request + response bodies as they went over the wire (cut at the 64 MiB cap or not); stored = the NDJSON lines, before sealing.',
      s.estimate && s.estimate.estimate ? `once sealed (估计) = stored × ${s.estimate.ratio.toFixed(3)}, the sealed files\' overall ratio: one global number, so a guess for any one class.` : 'once sealed: no readable sealed file to estimate from.');
  }
  const d = report.disk;
  if (d) {
    const g = d.groups, names = { captures: 'captures', sealed: 'sealed', sessions: 'sessions/', duckdb: 'duckdb', logs: 'logs', other: 'other' };
    out.push('', `~/.asight on disk (lstat sizes, live): ${fmtBytes(d.total_bytes)} in ${d.files} files — ${Object.keys(names).map((k) => `${names[k]} ${fmtBytes(g[k].bytes)}`).join(' · ')}`);
    if (d.unreadable.length) out.push(`⚠ ${d.unreadable.length} path(s) could not be read, so this total is a floor: ${d.unreadable.slice(0, 3).map((u) => `${u.path} (${u.error})`).join('; ')}`);
  }
  if (report.db && report.db.bytes != null) out.push(`analytics store: ${report.db.path} (${fmtBytes(report.db.bytes)}; it holds no bodies)`);
  return out;
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
