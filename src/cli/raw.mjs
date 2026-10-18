// raw.mjs — `asight raw seal | verify | cat` (RFC 1.6 §5.1, D60): hand maintenance of the captured segments, which the collector normally
// seals by itself. The three subcommands are being written on another branch (src/raw/ holds the engine); this is the table entry's run
// function, with the signature every command module has.
import { EXIT } from './schema.mjs'
import { printJson, errorDoc } from './json.mjs'

const MESSAGE = 'asight raw: not implemented yet. It arrives with the data-format update.'

/** → the exit code. `argv` is what follows `raw`; the parsed form is `ctx.args` ({ positionals, flags }). */
export async function run(argv, { io, json }) {
  if (json) printJson(io, errorDoc('raw', 'not-implemented', MESSAGE))
  else io.err(MESSAGE)
  return EXIT.incomplete
}
