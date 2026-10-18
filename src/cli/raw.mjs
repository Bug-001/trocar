// raw.mjs — `asight raw <segment>[:<from>[-<to>]]` (RFC 1.6 §5.1, D60): print captured records byte for byte. Sealing is the daemon's
// alone. The reader is being written on the data-format branch; this is the table entry's run function, with the signature every
// command module has.
import { EXIT } from './schema.mjs'

/** → the exit code. `argv` is what follows `raw`; the parsed form is `ctx.args` ({ positionals, flags }). */
export async function run(argv, { io }) {
  io.err('asight raw: not implemented yet. It arrives with the data-format update.')
  return EXIT.incomplete
}
