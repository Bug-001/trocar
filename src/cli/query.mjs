// query.mjs — `asight query <name> [--<param> <value>...]` (RFC 1.6 §4.1, D59): the one way to read what was captured. The queries themselves
// are being written on another branch; this is the table entry's run function, with the signature every command module has.
import { EXIT } from './schema.mjs'
import { printJson, errorDoc } from './json.mjs'

const MESSAGE = 'asight query: not implemented yet. It arrives with the data-format update.'

/** → the exit code. `argv` is what follows `query`; the parsed form is `ctx.args` ({ positionals, flags }). */
export async function run(argv, { io, json }) {
  if (json) printJson(io, errorDoc('query', 'not-implemented', MESSAGE))
  else io.err(MESSAGE)
  return EXIT.incomplete
}
