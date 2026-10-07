// main.mjs — `asight <command> …` from the argument list to the exit code (RFC 1.6 §2, R4, R7, R10): the dispatch over the one table of commands (src/cli/commands.mjs). It resolves a hidden alias, says one
// command's help for `--help` / `-h`, refuses root for the per-user commands that change state and a non-root caller for `setup-helper` BEFORE anything is read or written, then hands the command its
// context. An unknown command is a usage error on stderr, exit 2 (it used to print the usage and exit 0). What a command returns is the exit code; this file never exits the process (bin/asight.mjs does).
//   runCli(argv, { io, env, home, platform, uid, deps }) → Promise<exit code>
//     io        { out, err, stdin, stdout, stderr } (src/off/io.mjs makeIo); the process's own streams when none is given
//     uid       who runs it (default: the process's); `deps.getuid` follows it, so a command's own root refusal agrees with this one
//     deps      what the world gives (0.1 §3), passed to the command as it is; `deps.commands` = { <name>: async (argv, ctx) → exit } replaces what a command runs (a test's spy: what was dispatched, not what it does)
import fs from 'node:fs'
import os from 'node:os'
import { makeIo } from '../off/io.mjs'
import { commandNamed, resolveAlias, helpText } from './commands.mjs'
import { EXIT } from './schema.mjs'

const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)
const version = () => JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

export async function runCli(argv, { io = makeIo({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }), env = process.env, home = os.homedir(), platform = process.platform, uid = processUid(), deps = {} } = {}) {
  const [first] = argv
  if (first === undefined || first === '--help' || first === '-h') { io.out(helpText(undefined, { platform })); return EXIT.ok }
  if (first === '--version' || first === '-v' || first === 'version') { io.out(version()); return EXIT.ok }
  const { argv: resolved } = resolveAlias(argv)
  const [name, ...rest] = resolved
  const cmd = commandNamed(name)
  if (!cmd) {
    io.err(first === 'collector' ? (await import('../collector/cli.mjs')).collectorHint(argv[1]) : `asight: 没有这个命令 '${first}'\n\n${helpText(undefined, { platform })}`)
    return EXIT.usage
  }
  if (rest.includes('--help') || rest.includes('-h')) { io.out(helpText(cmd.name, { platform })); return EXIT.ok }
  if (cmd.mutates && uid === 0) { io.err(`asight ${cmd.name}: 用你自己的账号跑,不要用 root / sudo(D36;只有 \`sudo asight setup-helper\` 要 root)`); return EXIT.incomplete }
  if (cmd.needsRoot && uid !== 0) { io.err(`asight ${cmd.name}: 要以 root 跑(给助手加能力位、放进 root 所有的路径,D36):sudo asight ${cmd.name}`); return EXIT.incomplete }
  const run = (deps.commands && deps.commands[cmd.name]) || cmd.run
  return run(rest, { io, env, home, platform, uid, deps: { getuid: () => uid, ...deps } })
}
