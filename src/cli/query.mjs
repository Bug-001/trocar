// query.mjs — `asight query <name> [--<param> <value>...]` (RFC 1.6 §4.1, D59 · D63): the one way to read what was captured. This file parses,
// asks src/query/client.mjs for the document and prints it; every answer a query gives is the query core's, whether the daemon's warm worker
// computed it or this process did, so the CLI and the board cannot disagree. With no name it lists the names and their parameters. The document
// itself is always JSON (§4.1), so `--json` changes only what an error looks like: the JSON error document instead of one English line (§1.2).
import { EXIT } from './schema.mjs'
import { printJson, errorDoc } from './json.mjs'
import { wrap, WIDTH } from './text.mjs'
import { asightHome, collectorDir } from '../off/paths.mjs'
import { queryDocument } from '../query/client.mjs'

const errText = (e) => String((e && e.message) || e)

/** The name list (§4.1): every query and the parameters it takes. The query core is imported here only (it is most of
 *  this command's load time, and the daemon path does not need it). */
export const queryList = async () => {
  const { QUERIES } = await import('../query/named/index.mjs')
  const rows = [['NAME', 'PARAMETERS'], ...Object.entries(QUERIES).map(([name, q]) => [name, q.params.length ? q.params.map((p) => `--${p}`).join(' ') : 'none'])]
  // the parameters fold under their own column rather than pass 80 columns (§1.1⑥)
  const w = Math.max(...rows.map(([n]) => n.length)), pad = ' '.repeat(w + 2)
  return rows.flatMap(([n, p]) => wrap(p, WIDTH - pad.length).map((l, i) => (i ? pad : n.padEnd(w + 2)) + l))
}

/** → the exit code. `argv` is what follows `query`; the parsed form is `ctx.args` ({ positionals, flags }). */
export async function run(argv, { io, json, args, home, env, platform, deps }) {
  const [name, ...extra] = args.positionals
  const refuse = (code, message, exit) => {
    if (json) printJson(io, errorDoc(name || 'query', code, message))
    else for (const line of wrap(message)) io.err(line) // §1.1⑥: it folds under itself instead of passing 80 columns
    return exit
  }
  if (name === undefined) {
    for (const line of await queryList()) io.out(line)
    return EXIT.ok
  }
  if (extra.length) return refuse('usage', `asight query: one query at a time, and its parameters as --name value. Run: asight query`, EXIT.usage)
  const { json: _json, ...params } = args.flags // `--json` is the CLI's, never a query's parameter
  try {
    // The same two spacings printJson gives: indented for a person at a terminal, one line into a pipe (§1.2) —
    // asked of whoever computes the document, so its bytes are written on as they came (D63②: the two paths print the same bytes).
    const { text } = await queryDocument(name, params, { home: asightHome(home), userHome: home, dir: collectorDir(home), platform, env, deps, indent: io.stdout && io.stdout.isTTY ? 2 : 0 })
    io.out(text)
    return EXIT.ok
  } catch (e) {
    if (e && e.name === 'QueryArgError') return refuse('usage', errText(e), EXIT.usage)
    return refuse('unreadable', `asight query ${name}: no document could be produced: ${errText(e)}`, EXIT.incomplete)
  }
}
