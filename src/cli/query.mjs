// query.mjs — `asight query <name> [--<param> <value>...]` (RFC 1.6 §4.1, D59): the one way to read what was captured. This file parses,
// calls src/query/named/index.mjs and prints; every answer a query gives is that module's, so the CLI and the board cannot disagree.
// With no name it lists the names and their parameters. The document itself is always JSON (§4.1), so `--json` changes only what an
// error looks like: the JSON error document instead of one English line (§1.2).
import { EXIT } from './schema.mjs'
import { printJson, errorDoc } from './json.mjs'
import { columns, wrap } from './text.mjs'
import { asightHome } from '../off/paths.mjs'
import { QUERIES, runQuery, QueryArgError } from '../query/named/index.mjs'

const errText = (e) => String((e && e.message) || e)

/** The name list (§4.1): every query and the parameters it takes. */
export const queryList = () => columns([['NAME', 'PARAMETERS'],
  ...Object.entries(QUERIES).map(([name, q]) => [name, q.params.length ? q.params.map((p) => `--${p}`).join(' ') : 'none'])])

/** → the exit code. `argv` is what follows `query`; the parsed form is `ctx.args` ({ positionals, flags }). */
export async function run(argv, { io, json, args, home, env, platform, deps }) {
  const [name, ...extra] = args.positionals
  const refuse = (code, message, exit) => {
    if (json) printJson(io, errorDoc(name || 'query', code, message))
    else for (const line of wrap(message)) io.err(line) // §1.1⑥: it folds under itself instead of passing 80 columns
    return exit
  }
  if (name === undefined) {
    for (const line of queryList()) io.out(line)
    return EXIT.ok
  }
  if (extra.length) return refuse('usage', `asight query: one query at a time, and its parameters as --name value. Run: asight query`, EXIT.usage)
  const { json: _json, ...params } = args.flags // `--json` is the CLI's, never a query's parameter
  try {
    printJson(io, await runQuery(name, params, { home: asightHome(home), userHome: home, env, platform, deps }))
    return EXIT.ok
  } catch (e) {
    if (e instanceof QueryArgError) return refuse('usage', errText(e), EXIT.usage)
    return refuse('unreadable', `asight query ${name}: no document could be produced: ${errText(e)}`, EXIT.incomplete)
  }
}
