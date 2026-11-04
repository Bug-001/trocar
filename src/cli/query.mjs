// query.mjs — `trocar query <name> [--<param> <value>...]` (RFC 1.6 §4.1, D59 · D63): the one way to read what was captured. This file parses,
// asks src/query/client.mjs for the document and prints it; every answer a query gives is the query core's, whether the daemon's warm worker
// computed it or this process did, so the CLI and the board cannot disagree. With no name it lists the names and their parameters, and
// `query <name> --help` describes one (topicHelp); both come from each query's own `about`. The answer itself is always JSON (§4.1), so with a
// name `--json` changes only what an error looks like: the JSON error document instead of one English line (§1.2).
import { EXIT, SCHEMA_VERSION } from './schema.mjs'
import { commandNamed, page } from './commands.mjs'
import { printJson, errorDoc } from './json.mjs'
import { wrap, WIDTH } from './text.mjs'
import { trocarHome, collectorDir } from '../off/paths.mjs'
import { queryDocument } from '../query/client.mjs'

const errText = (e) => String((e && e.message) || e)

/** A refusal of the query `name`: the error document, or the message on stderr. */
const refuser = ({ io, json }, name) => (code, message, exit) => {
  if (json) printJson(io, errorDoc(name || 'query', code, message))
  else for (const line of wrap(message)) io.err(line) // §1.1⑥: it folds under itself instead of passing 80 columns
  return exit
}

/** One query as C.6 gives it. */
const queryEntry = (name, { summary, params }) => ({ name, summary, params: Object.entries(params).map(([param, text]) => ({ name: param, text })) })

/** Every query as C.6 gives it. */
export const queriesDoc = async () => {
  const { QUERIES } = await import('../query/named/index.mjs')
  return Object.entries(QUERIES).map(([name, q]) => queryEntry(name, q.about))
}

/** `trocar query <name> --help` (§4.1): that query's page, or under `json` its C.6 document. The name is refused as running it would be. → the exit code. */
export async function topicHelp(_argv, { io, json, args }) {
  const [name] = args.positionals
  const { queryNamed } = await import('../query/named/index.mjs')
  let q
  try { q = queryNamed(name) } catch (e) { return refuser({ io, json }, name)('usage', errText(e), EXIT.usage) }
  const entry = queryEntry(name, q.about)
  if (json) printJson(io, { schema: SCHEMA_VERSION, command: 'help', ok: true, queries: [entry] })
  else {
    const usage = `trocar query ${name}${entry.params.length ? ' [--<param> <value>...]' : ''} [--json]`
    io.out(page({ usage, summary: entry.summary, title: 'Parameters', rows: entry.params.map((p) => [`--${p.name}`, p.text]), exits: commandNamed('query').exits }))
  }
  return EXIT.ok
}

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
  const refuse = refuser({ io, json }, name)
  if (name === undefined) {
    if (json) { printJson(io, { schema: SCHEMA_VERSION, command: 'query', ok: true, queries: await queriesDoc() }); return EXIT.ok }
    for (const line of await queryList()) io.out(line)
    return EXIT.ok
  }
  if (extra.length) return refuse('usage', `trocar query: one query at a time, and its parameters as --name value. Run: trocar query`, EXIT.usage)
  const { json: _json, ...params } = args.flags // `--json` is the CLI's, never a query's parameter
  try {
    // The same two spacings printJson gives: indented for a person at a terminal, one line into a pipe (§1.2) —
    // asked of whoever computes the document, so its bytes are written on as they came (D63②: the two paths print the same bytes).
    // What it is doing goes to stderr in plain words, never under --json (§1.2: stderr carries nothing then).
    const { text } = await queryDocument(name, params, { home: trocarHome(home), userHome: home, dir: collectorDir(home), platform, env, deps, indent: io.stdout && io.stdout.isTTY ? 2 : 0, ...(json ? {} : { say: io.err }) })
    io.out(text.endsWith('\n') ? text.slice(0, -1) : text) // NDJSON ends with its newline; out() writes one
    return EXIT.ok
  } catch (e) {
    if (e && e.name === 'QueryArgError') return refuse('usage', errText(e), EXIT.usage)
    return refuse('unreadable', `trocar query ${name}: no document could be produced: ${errText(e)}`, EXIT.incomplete)
  }
}
