// commands.mjs — the one table of commands (RFC 1.6 §2, §5.4, D58): one list that `asight help` prints, src/cli/main.mjs dispatches over,
// src/cli/args.mjs parses by, and test/cli/{commands,dispatch}.test.mjs holds equal. One feature has one name: there are no hidden aliases
// and no test-only public option (D58⑤).
//   COMMANDS  [{ name, group, usage, summary, options, exits, mutates, needsRoot?, openOptions?, run(argv, ctx) → exit }]
//     group       'Capture' | 'Data' | 'Maintenance' — the three sections of help, in that order.
//     usage       one or more lines, each beginning `asight <name>` or `sudo asight <name>` (the first is the one a usage error prints).
//     summary     two or three sentences of English a user understands: no section numbers, decision numbers, source paths or internal code names.
//     options     [['--name' | '--name <value>', 'one line of help']] — the declaration src/cli/args.mjs parses by (nothing is guessed).
//     exits       [[code, 'what it means']], out of the five codes of §1.3.
//     mutates     changes the user's own state, so it refuses root (§1.5): true, or a function of the parsed args when only some subcommands do
//                 (`classes set|add|rm|reset` refuse root; `classes` shown does not). needsRoot: setup-helper, the one command that must be root.
//     run         gets the argv after the name and the context of runCli: { io, env, home, platform, uid, args: { positionals, flags }, deps }.
//   helpText    the help, made from the table: the three sections, or one command when named.
import { optionsOf } from './args.mjs'
import { wrap, WIDTH } from './text.mjs'

export const GROUPS = Object.freeze(['Capture', 'Data', 'Maintenance'])
const via = (file, fn) => async (argv, c) => (await import(file))[fn](argv, c)
const HARNESS = '[<harness>...]'
const JSON_OPT = ['--json', 'print one JSON document instead of text, and nothing on stderr']
const YES = ['--yes', 'answer the confirmation, for a run that is not in a terminal']
const DRY = ['--dry-run', 'print what it would do and write nothing']

async function help(argv, c) {
  const [topic, ...rest] = argv
  if (rest.length) { c.io.err('asight help: one command at a time. Run: asight help'); return 2 }
  if (topic !== undefined && !commandNamed(topic)) { c.io.err(`asight help: unknown command '${topic}'. Run: asight help`); return 2 }
  c.io.out(helpText(topic))
  return 0
}

export const COMMANDS = Object.freeze([
  { name: 'install',
    group: 'Capture', mutates: true, run: via('./install.mjs', 'runInstallCli'),
    usage: 'asight install [--yes] [--dry-run] [--json]',
    summary: 'Sets up the certificates, once per machine. It makes this machine\'s own root, trusts it for your user, and places the certificate each agent reads for itself. It prints the plan and waits for you to confirm; it never turns capture on.',
    options: [YES, DRY, JSON_OPT],
    exits: [[0, 'everything is installed'], [1, 'some of it is not'], [2, 'nothing ran: a usage error, root, or a confirmation nobody could give']] },
  { name: 'on',
    group: 'Capture', mutates: true, run: via('./on.mjs', 'runOnCli'),
    usage: `asight on ${HARNESS} [--no-autostart] [--no-unit] [--yes] [--dry-run] [--json]`,
    summary: 'Starts capturing the named agents, or every agent install knows when you name none. It only points each agent at asight and starts the collector; it touches no certificate and restarts no agent. Run asight install first.',
    // shortcut: --no-unit is still its own option, to be merged into --no-autostart with the on/off rewrite of the next branch
    options: [['--no-autostart', 'start the collector now but do not have it start at login'], ['--no-unit', 'do not write the autostart entry at all'], YES, DRY, JSON_OPT],
    exits: [[0, 'every named agent is being captured'], [1, 'some of them are not'], [2, 'nothing ran: a usage error, an unknown agent, root, or a confirmation nobody could give']] },
  { name: 'off',
    group: 'Capture', mutates: true, run: via('../off/main.mjs', 'runOffCli'),
    usage: `asight off ${HARNESS} [--now] [--yes] [--dry-run] [--json]`,
    summary: 'Takes away everything asight does to the named agents, or to all of them when you name none. Then the agents see the real upstream again and asight writes no new records. It works even when asight itself is broken.',
    options: [['--now', 'cut the connections still in flight instead of letting them finish'], YES, DRY, JSON_OPT],
    exits: [[0, 'asight is out of the way'], [1, 'a step did not finish'], [2, 'nothing ran: a usage error, an unknown agent, or root']] },
  { name: 'status',
    group: 'Capture', mutates: false, run: via('./status.mjs', 'runStatusCli'),
    usage: `asight status ${HARNESS} [--failures] [--json]`,
    summary: 'Says which agents are being captured and why not, for the ones that are not. With no name it is one screen: the collector, the agents, the connections still going through asight, and what failed in the last day. Name an agent for its details.',
    options: [['--failures', 'list every failure of the last day, not just the newest'], JSON_OPT],
    exits: [[0, 'every agent is being captured'], [1, 'some are not'], [2, 'a usage error, or an unknown agent'], [3, 'it could not be read; the reason is in the output']] },
  { name: 'uninstall',
    group: 'Capture', mutates: true, run: via('./uninstall.mjs', 'runUninstallCli'),
    usage: 'asight uninstall [--purge-data] [--yes] [--dry-run] [--json]',
    summary: 'Removes what install put on this machine: the root, the certificates the agents read, and the records of both. Capture must be off first. Your captured data stays unless you ask for it to go.',
    options: [['--purge-data', 'also delete the captured records'], YES, DRY, JSON_OPT],
    exits: [[0, 'all of it is gone'], [1, 'capture is still on, or some of it is still there'], [2, 'nothing ran: a usage error, root, or a confirmation nobody could give']] },
  { name: 'doctor',
    group: 'Capture', mutates: false, run: via('./doctor.mjs', 'runDoctor'),
    usage: `asight doctor ${HARNESS} [--json]`,
    summary: 'Finds what keeps capture or the network from working and says how to fix it. It looks at the agents, your proxy, the certificates, who can read the captured files, and the backups nothing claims. It changes nothing.',
    options: [JSON_OPT],
    exits: [[0, 'nothing is wrong'], [1, 'something is wrong, and it says what'], [2, 'a usage error, or an unknown agent'], [3, 'it could not judge; it says what it could not read']] },

  { name: 'query',
    group: 'Data', mutates: false, openOptions: true, run: via('./query.mjs', 'run'),
    usage: 'asight query <name> [--<param> <value>...]',
    summary: 'The one way to read what was captured. Each query has a name and its own parameters; the board asks the same queries over HTTP. Run it with no name to list them.',
    options: [],
    exits: [[0, 'the answer is on stdout'], [1, 'no document could be produced'], [2, 'nothing ran: the query name or one of its parameters is not known']] },
  { name: 'classes',
    group: 'Data', mutates: (args) => ['set', 'add', 'rm', 'reset'].includes(args.positionals[0]), run: via('./classes.mjs', 'run'),
    usage: 'asight classes [<class>] [--json]\nasight classes set <class> full|log\nasight classes add <class> <host-regex> [<path-regex>] [--harness <harness>]\nasight classes rm <class> [<rule>]\nasight classes reset',
    summary: 'Shows and edits your traffic classes: which hosts belong to which class, and how much of each class is kept. Editing takes effect for calls made afterwards; what is already stored does not change.',
    options: [['--harness <harness>', 'the rule applies to this agent only'], JSON_OPT],
    exits: [[0, 'done, or shown'], [1, 'the class or rule could not be read or written'], [2, 'nothing ran: a usage error, an unknown class, or root']] },
  { name: 'serve',
    group: 'Data', mutates: false, run: via('./serve.mjs', 'run'),
    usage: 'asight serve [--port <port>]',
    summary: 'Serves the board on the loopback address, read only. It answers the same queries asight query does. Stop it with Ctrl-C.',
    options: [['--port <port>', 'the loopback port to listen on (9800 by default)']],
    exits: [[0, 'it stopped when you asked'], [1, 'it could not listen, and it says why'], [2, 'a usage error']] },

  { name: 'raw',
    group: 'Maintenance', mutates: false, run: via('./raw.mjs', 'run'),
    usage: 'asight raw <segment>[:<from>[-<to>]]',
    summary: 'Prints captured records byte for byte; a sealed segment is decoded first. <from> and <to> are record numbers, both included. Sealing itself is the daemon\'s job.',
    options: [],
    exits: [[0, 'the records are on stdout'], [1, 'the segment or a record number does not exist, or could not be read'], [2, 'a usage error']] },
  { name: 'daemon',
    group: 'Maintenance', mutates: true, run: via('./daemon.mjs', 'runDaemonCli'),
    usage: 'asight daemon [--supervise]',
    summary: 'Runs the collector in the foreground. This is what starts at login, so you do not normally type it. It drains what is in flight before it stops.',
    options: [['--supervise', 'on Windows: the parent the scheduled task starts, which keeps the collector running']],
    exits: [[0, 'it stopped cleanly'], [1, 'it could not start, and it says why'], [2, 'nothing ran: a usage error or root'], [70, 'it crashed']] },
  { name: 'setup-helper',
    group: 'Maintenance', mutates: false, needsRoot: true, run: via('./setup-helper.mjs', 'run'),
    usage: 'sudo asight setup-helper [--remove] [--binary <path>]',
    summary: 'Installs the kernel helper asight needs on Linux, once per machine. This is the only command that needs root, and it is not needed on macOS or Windows.',
    options: [['--remove', 'remove the helper instead of installing it'], ['--binary <path>', 'install this helper binary, one you built yourself']],
    exits: [[0, 'the helper is in place, or gone'], [1, 'it could not be installed, and it says why'], [2, 'nothing ran: a usage error, not root, or not Linux']] },
  // `help` is the trailer of the first screen, not an entry of a section (§2).
  { name: 'help',
    group: null, mutates: false, run: help,
    usage: 'asight help [<command>]',
    summary: 'The list of commands, or one command: its usage, what it does, its options and its exit codes. `asight <command> --help` prints the same page.',
    options: [],
    exits: [[0, 'printed'], [2, 'there is no such command']] },
])

/** The command called `name`, or undefined. */
export const commandNamed = (name) => COMMANDS.find((c) => c.name === name)

/** The first line of a command's usage — what a usage error prints under its message. */
export const usageLine = (cmd) => cmd.usage.split('\n')[0]

/** A usage line split into what a reader scans for (`asight raw seal`) and the arguments after it (`[--json]`). */
const split = (line) => {
  const at = line.search(/ [[<]/)
  return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)]
}

/** The listed usage lines of the three sections, aligned on one column (the `sudo` line is longer than the rest and keeps one space, §2).
 *  A line that would pass 80 columns goes on as a second line indented to that column, never ragged at the margin (§1.1⑥). */
function listing() {
  const rows = COMMANDS.filter((c) => c.group).flatMap((c) => c.usage.split('\n').map((l) => [c.group, ...split(l)]))
  const width = Math.max(...rows.filter(([, head]) => !head.startsWith('sudo')).map(([, head]) => head.length))
  const hang = ' '.repeat(width + 3)
  return (group) => rows.filter((r) => r[0] === group).flatMap(([, head, rest]) => {
    const [first = '', ...more] = wrap(rest, WIDTH - hang.length)
    return [`  ${head.padEnd(width)} ${first}`.trimEnd(), ...more.map((l) => hang + l)]
  })
}

/** An indented two-column block (`  --json  what it does`) whose second column folds under itself instead of passing 80 columns (§1.1⑥). */
const block = (rows) => {
  const head = Math.max(0, ...rows.map(([h]) => h.length))
  const hang = ' '.repeat(head + 4)
  return rows.flatMap(([h, text]) => {
    const [first = '', ...more] = wrap(text, WIDTH - hang.length)
    return [`  ${h.padEnd(head)}  ${first}`.trimEnd(), ...more.map((l) => hang + l)]
  })
}

/** The help (§2, §5.4): the three sections, or `helpText('on')` for one command. A name that is no command throws. */
export function helpText(name) {
  if (name !== undefined) {
    const cmd = commandNamed(name)
    if (!cmd) throw new RangeError(`no command named ${name}`)
    const out = [...cmd.usage.split('\n').flatMap((l) => wrap(l, WIDTH, '  ')), '', ...wrap(cmd.summary)]
    const options = [...optionsOf(cmd).values()]
    if (options.length) out.push('', 'Options', ...block(options.map((o) => [o.value ? `${o.name} <${o.value}>` : o.name, o.help])))
    out.push('', 'Exit codes', ...block(cmd.exits.map(([c, what]) => [String(c), what])))
    return out.join('\n')
  }
  const out = [...wrap('asight - see every byte your agents really send to a model: captured as it is, replayed and taken apart'), '']
  const lines = listing()
  for (const group of GROUPS) out.push(group, ...lines(group), '')
  out.push('asight help [<command>]   asight <command> --help   asight --version')
  return out.join('\n')
}
