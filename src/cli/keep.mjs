// keep.mjs — `asight keep [<harness|all> <class|all> <full|log>] [--db <store>] [--json]` (RFC 1.6 §2, 4.6 §记录「保存级别」·修改, D40): show or set what is kept of each call, per harness × traffic class.
// The command table (src/cli/commands.mjs) puts it with the data commands and marks it as one that changes state, so root is refused before anything is read (R7): a root-owned
// retention.json inside the user's ~/.asight would be a file the user's collector cannot read. What it does is src/capture/keep.mjs (the show table, the set, the closed sets, the exit codes 0 / 1 / 2)
// and src/query/retention.mjs (the sizes, the same report the board's /api/retention serves); this file is the CLI face: it reads no daemon and needs none, and it knows the one thing the
// two cannot know together — that the harness the operator types is a harness name of 1.6 §3.
//
// Names. The settings file and the sizes are keyed by the read-side table's harness ids (`cc`, `kimi`, `dsh`, `zcode`, …: src/dissect/harnesses.mjs), which the board and the old capture share. `on` / `off` / `status`
// take the CLI names of 1.6 §3 (`claude-code`, `claude`, `deepseek-dsh`, …). `keep` takes both: a CLI name or alias is translated to the read-side id of the same harness (through the `agents` the table
// declares for it, the way the collector's `proc.agent` is read), a read-side id is taken as it is, and anything else stays as typed so src/capture/keep.mjs refuses it (exit 2, the file untouched).
// What `keep` prints is the settings' own ids — the file and the board's table say `cc`, so does the CLI — not the code ids that `status` prints (1.6 §3 「输出一律印代码 id」 is for the harnesses of the
// collector; the settings are keyed by the read-side table).
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from '../cli-args.mjs'
import { EXIT } from '../off/schema.mjs'
import { resolveHarnesses } from './harness-names.mjs'

/** `name` as typed → the id the settings use: `all` and a read-side id as they are, a CLI name or alias (1.6 §3) → the read-side id of that harness, anything else as typed. */
export function settingHarness(name, { ids, idOfAgent }) {
  if (name === 'all' || ids.includes(name)) return name
  const r = resolveHarnesses([name])
  if (!r.ok) return name
  const id = idOfAgent(r.ids[0])
  return ids.includes(id) ? id : name
}

/** → the exit code. `argv` is what follows `keep`; `io` = { out, err } (src/off/io.mjs makeIo). `deps.sizes()` replaces the DuckDB read (a test's). */
export async function runKeepCli(argv, { io, home = os.homedir(), deps = {} } = {}) {
  const { runKeep, formatKeepSizes } = await import('../capture/keep.mjs')
  const { retentionHarnessIds, unmatchedClasses, harnessIdOfAgent } = await import('../dissect/traffic.mjs')
  const { retentionFile, retentionLog } = await import('../paths.mjs')
  const args = parseArgs(argv)
  const ids = retentionHarnessIds()
  const [harness, ...restWords] = args.positionals
  const words = harness === undefined ? [] : [settingHarness(harness, { ids, idOfAgent: harnessIdOfAgent }), ...restWords]
  // `--db <path>` names the analytics store the sizes are read from (default: the one `asight serve` opens), `--json` prints the report the board's /api/retention serves — both are the show mode's;
  // the three words (harness class level) are the set mode's
  const showing = words.length === 0
  const asJson = showing && argv.includes('--json')
  const base = path.join(home, '.asight')
  let code = EXIT.ok
  if (!asJson) {
    code = runKeep(words, { out: io.out, err: io.err, file: retentionFile(base), logFile: retentionLog(base), harnesses: ids, unmatched: Object.fromEntries(ids.map((h) => [h, unmatchedClasses(h)])) })
  }
  if (showing && code === EXIT.ok) {
    try {
      const report = deps.sizes ? await deps.sizes() : await (async () => {
        const { retentionReportFromStore } = await import('../query/retention.mjs')
        const { DEFAULT_DB_PATH } = await import('../db.mjs')
        return retentionReportFromStore({ dbPath: args.flag('--db', process.env.ASIGHT_DB || DEFAULT_DB_PATH) })
      })()
      io.out(asJson ? JSON.stringify(report, null, 2) : formatKeepSizes(report).join('\n'))
    } catch (e) { io.err(`asight keep: the sizes could not be read (${(e && e.message) || e})`); code = EXIT.incomplete }
  }
  return code
}
