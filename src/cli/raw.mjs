// raw.mjs — `asight raw <segment>[:<from>[-<to>]]` (RFC 1.6 §5.1, D60): the captured records byte for byte, a sealed segment decoded
// first. It parses the record range, reads the lines through src/query/records.mjs (the one place a segment is read back) and prints
// them as they were captured. Read-only, root included; sealing is the daemon's alone. A segment or a record number that is not there
// is exit 1 with the reason on stderr, a usage error exit 2.
import { EXIT } from './schema.mjs'
import { wrap } from './text.mjs'
import { usageLine, commandNamed } from './commands.mjs'
import { asightHome } from '../off/paths.mjs'
import { segmentLines } from '../query/records.mjs'

const TARGET = /^([^:]+)(?::(\d+)(?:-(\d+))?)?$/

/** → the exit code. `argv` is what follows `raw`; the parsed form is `ctx.args` ({ positionals, flags }). */
export async function run(argv, { io, args, home }) {
  // §1.1⑤⑥: the home directory is `~`, and the message folds instead of passing 80 columns (a path longer than a line keeps its own)
  const say = (message) => { for (const line of wrap(String(message).split(home).join('~'))) io.err(line) }
  const usage = (message) => { say(message); io.err(usageLine(commandNamed('raw'))); return EXIT.usage }
  const [target, ...extra] = args.positionals
  if (target === undefined) return usage('asight raw: name the segment to print.')
  if (extra.length) return usage('asight raw: one segment at a time.')
  const m = TARGET.exec(target)
  if (!m) return usage(`asight raw: ${target} is not a segment with record numbers after it.`)
  const [, segment, fromText, toText] = m
  const from = fromText ? Number(fromText) : 1
  const to = toText ? Number(toText) : fromText ? from : Infinity
  if (to < from) return usage(`asight raw: ${target} ends before it begins.`)
  let printed = 0
  try {
    // the stored bytes as they are: nothing added (a half line a crash left has no newline, and gets none).
    // The range goes INTO the reader: a sealed segment then decodes only the frames these records sit in (D62 A1).
    for (const [, bytes] of segmentLines({ home: asightHome(home), segment, from, to })) {
      io.stdout.write(bytes); printed++
    }
  } catch (e) {
    say(`asight raw: ${String((e && e.message) || e)}`)
    return EXIT.incomplete
  }
  if (!printed) {
    say(`asight raw: ${segment} has no record ${fromText ? (toText ? `${from} to ${to}` : String(from)) : 'in it'}.`)
    return EXIT.incomplete
  }
  return EXIT.ok
}
