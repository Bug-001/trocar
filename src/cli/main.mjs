// main.mjs — `asight <command> …` from the argument list to the exit code (RFC 1.6 §1.2, §1.3, §1.5, §2): the dispatch over the one table of
// commands (src/cli/commands.mjs). It answers help and `--version` itself, refuses an unknown command or option in one line, refuses root for
// the commands that change your own state and a non-root caller for setup-helper BEFORE anything is read or written, parses the options the
// command declares, and turns anything the command throws into exit 70. With `--json` anywhere in the arguments every one of those answers is
// one JSON document on stdout and nothing on stderr. What a command returns is the exit code; this file never exits the process (bin/asight.mjs does).
//   runCli(argv, { io, env, home, platform, uid, deps }) → Promise<exit code>
//     io        { out, err, stdin, stdout, stderr } (src/off/io.mjs makeIo); the process's own streams when none is given
//     uid       who runs it (default: the process's); `deps.getuid` follows it, so a command's own root refusal agrees with this one
//     deps      what the world gives (0.1 §3), passed to the command as it is; `deps.commands` = { <name>: async (argv, ctx) → exit } replaces
//               what a command runs (a test's spy: what was dispatched, not what it does)
//   The command gets `(argv, ctx)`; `ctx.args` is the parsed form of argv ({ positionals, flags }) and `ctx.json` whether `--json` was asked.
import os from 'node:os'
import { makeIo } from '../off/io.mjs'
import { commandNamed, helpText, usageLine } from './commands.mjs'
import { parseArgs } from './args.mjs'
import { wrap, WIDTH } from './text.mjs'
import { printJson, errorDoc } from './json.mjs'
import { EXIT } from './schema.mjs'
import { codeId } from '../version.mjs'

const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)
const REPORT = 'Please report it with what you ran: https://github.com/Bug-001/asight/issues'

export async function runCli(argv, { io = makeIo({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }), env = process.env, home = os.homedir(), platform = process.platform, uid = processUid(), deps = {} } = {}) {
  const json = argv.includes('--json')
  /** One answer that is not an answer: a JSON document on stdout, or a line (and the usage line, when there is one) on stderr. */
  const refuse = (command, code, message, { usage = null, detail = null, exit = EXIT.usage } = {}) => {
    if (json) printJson(io, errorDoc(command, code, message, detail))
    else { io.err(message); if (usage) for (const line of wrap(usage, WIDTH, '  ')) io.err(line) } // §1.1⑥: the usage line folds like help's, it does not pass 80 columns
    return exit
  }
  const [first, ...rest] = argv
  if (first === undefined || first === '--help' || first === '-h') { io.out(helpText()); return EXIT.ok } // `asight` with nothing = `asight help` (§2)
  if (first === '--version') { io.out(`asight ${codeId()}`); return EXIT.ok } // §2, D67⑤: the version, with HEAD's first 7 in a git checkout
  const cmd = commandNamed(first)
  if (!cmd) return refuse(first, 'usage', `asight: unknown command '${first}'. Run: asight help`)
  if (rest.includes('--help') || rest.includes('-h')) { io.out(helpText(cmd.name)); return EXIT.ok }
  // §1.5: the commands that change your own state refuse root, and the one that needs root refuses everyone else — before anything is read or written.
  if (cmd.needsRoot && platform !== 'linux') return refuse(cmd.name, 'usage', `asight ${cmd.name}: not needed on this platform.`)
  if (cmd.needsRoot && uid !== 0) return refuse(cmd.name, 'usage', `asight ${cmd.name}: run it with sudo: sudo asight ${cmd.name}`)
  // `mutates` may be a function of the parsed args: `classes set` and `raw seal` change state, `classes` shown and `raw cat` do not. Parsing reads and writes nothing, so it comes first.
  const args = parseArgs(cmd, rest)
  if ((typeof cmd.mutates === 'function' ? cmd.mutates(args) : cmd.mutates) && uid === 0) return refuse(cmd.name, 'usage', `asight ${cmd.name}: run this as your own user, not as root.`)
  if (args.error) return refuse(cmd.name, args.error.code, args.error.message, { usage: args.error.usage })
  const run = (deps.commands && deps.commands[cmd.name]) || cmd.run
  try {
    return await run(rest, { io, env, home, platform, uid, json, args, deps: { getuid: () => uid, ...deps } })
  } catch (e) {
    // §1.3: 70 is asight's own fault. The message is one line; the stack belongs in `--json` and in a report, never on a person's screen.
    const message = `asight: internal error: ${(e && e.message) || e}`
    if (json) { printJson(io, errorDoc(cmd.name, 'internal', message, (e && e.stack) || String(e))); return EXIT.crash }
    io.err(message); io.err(REPORT)
    return EXIT.crash
  }
}
