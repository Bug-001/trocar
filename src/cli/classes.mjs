// classes.mjs — `asight classes …` (RFC 1.6 §4.2, D60): your traffic classes and how much of each is kept. The class table and its editing
// are being written on another branch; this is the table entry's run function, with the signature every command module has.
import { EXIT } from './schema.mjs'
import { printJson, errorDoc } from './json.mjs'

const MESSAGE = 'asight classes: not implemented yet. It arrives with the data-format update.'

/** → the exit code. `argv` is what follows `classes`; the parsed form is `ctx.args` ({ positionals, flags }). */
export async function run(argv, { io, json }) {
  if (json) printJson(io, errorDoc('classes', 'not-implemented', MESSAGE))
  else io.err(MESSAGE)
  return EXIT.incomplete
}
