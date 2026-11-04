// commands.mjs — the one table of commands (RFC 1.6 §2, §5.4, D58): one list that `trocar help` prints, src/cli/main.mjs dispatches over,
// src/cli/args.mjs parses by, and test/cli/{commands,dispatch}.test.mjs holds equal. One feature has one name: there are no hidden aliases
// and no test-only public option (D58⑤).
//   COMMANDS  [{ name, group, usage, summary, options, exits, details?, mutates, needsRoot?, openOptions?, run(argv, ctx) → exit }]
//     group       'Capture' | 'Data' | 'Intervene' | 'Maintenance' — the four sections of help, in that order.
//     usage       one or more lines, each beginning `trocar <name>` or `sudo trocar <name>` (the first is the one a usage error prints).
//     summary     two or three sentences of English a user understands: no section numbers, decision numbers, source paths or internal code names.
//     options     [['--name' | '--name <value>', 'one line of help', { repeat: true }?]] — the declaration src/cli/args.mjs parses by (nothing is guessed).
//     exits       [[code, 'what it means']], out of the five codes of §1.3.
//     details     the command's long manual: a string, or a function returning one so it loads only when asked for. Printed after the exit
//                 codes in that command's own help (§2, §5.4), never in `trocar help`.
//     mutates     changes the user's own state, so it refuses root (§1.5): true, or a function of the parsed args when only some subcommands do
//                 (`classes set|add|rm|reset` refuse root; `classes` shown does not). needsRoot: setup-helper, the one command that must be root.
//     hidden      not in help or the README: `place`, which only the install scripts and `trocar update` run (§2).
//     run         gets the argv after the name and the context of runCli: { io, env, home, platform, uid, args: { positionals, flags }, deps }.
//   helpText    the help, made from the table: the four sections, or one command when named.
import { createRequire } from 'node:module'
import { optionsOf } from './args.mjs'
import { wrap, WIDTH } from './text.mjs'

export const GROUPS = Object.freeze(['Capture', 'Data', 'Intervene', 'Maintenance'])
const require = createRequire(import.meta.url) // help is synchronous, and a manual is only read when asked for
const via = (file, fn) => async (argv, c) => (await import(file))[fn](argv, c)
const HARNESS = '[<harness>...]'
const JSON_OPT = ['--json', 'print one JSON document instead of text, and nothing on stderr']
const YES = ['--yes', 'answer the confirmation, for a run that is not in a terminal']
const DRY = ['--dry-run', 'print what it would do and write nothing']

async function help(argv, c) {
  const [topic, ...rest] = argv
  if (rest.length) { c.io.err('trocar help: one command at a time. Run: trocar help'); return 2 }
  if (topic !== undefined && !commandNamed(topic)) { c.io.err(`trocar help: unknown command '${topic}'. Run: trocar help`); return 2 }
  c.io.out(helpText(topic))
  return 0
}

export const COMMANDS = Object.freeze([
  { name: 'install',
    group: 'Capture', mutates: true, run: via('./install.mjs', 'runInstallCli'),
    usage: 'trocar install [--yes] [--dry-run] [--json]',
    summary: 'Sets up the certificates, once per machine. It makes this machine\'s own root, trusts it for your user, and places the certificate each agent reads for itself. It prints the plan and waits for you to confirm; it never turns capture on.',
    options: [YES, DRY, JSON_OPT],
    exits: [[0, 'everything is installed'], [1, 'some of it is not'], [2, 'nothing ran: a usage error, root, or a confirmation nobody could give']] },
  { name: 'on',
    group: 'Capture', mutates: true, run: via('./on.mjs', 'runOnCli'),
    usage: `trocar on ${HARNESS} [--yes] [--dry-run] [--json]`,
    summary: 'Starts capturing the named agents, or every agent install knows when you name none. It only points each agent at trocar and starts the collector; it touches no certificate and restarts no agent. Run trocar install first.',
    options: [YES, DRY, JSON_OPT],
    exits: [[0, 'every named agent is being captured'], [1, 'some of them are not'], [2, 'nothing ran: a usage error, an unknown agent, root, or a confirmation nobody could give']] },
  { name: 'off',
    group: 'Capture', mutates: true, run: via('../off/main.mjs', 'runOffCli'),
    usage: `trocar off ${HARNESS} [--now] [--yes] [--dry-run] [--json]`,
    summary: 'Takes away everything trocar does to the named agents, or to all of them when you name none. Then the agents see the real upstream again and trocar writes no new records. It works even when trocar itself is broken.',
    options: [['--now', 'cut the connections still in flight instead of letting them finish'], YES, DRY, JSON_OPT],
    exits: [[0, 'trocar is out of the way'], [1, 'a step did not finish'], [2, 'nothing ran: a usage error, an unknown agent, or root']] },
  { name: 'status',
    group: 'Capture', mutates: false, run: via('./status.mjs', 'runStatusCli'),
    usage: `trocar status ${HARNESS} [--failures] [--json]`,
    summary: 'Says which agents are being captured and why not, for the ones that are not. With no name it is one screen: the collector, the agents, the connections still going through trocar, and what failed in the last day. Name an agent for its details.',
    options: [['--failures', 'list every failure of the last day, not just the newest'], JSON_OPT],
    exits: [[0, 'every agent is being captured'], [1, 'some are not'], [2, 'a usage error, or an unknown agent'], [3, 'it could not be read; the reason is in the output']] },
  { name: 'uninstall',
    group: 'Capture', mutates: true, recordsPath: false, run: via('./uninstall.mjs', 'runUninstallCli'), // 4.11 present: it deletes the recorded PATH
    usage: 'trocar uninstall [--purge-data] [--yes] [--dry-run] [--json]',
    summary: 'Removes what install put on this machine: the root, the certificates the agents read, and the records of both. Capture must be off first. Your captured data stays unless you ask for it to go.',
    options: [['--purge-data', 'also delete the captured records'], YES, DRY, JSON_OPT],
    exits: [[0, 'all of it is gone'], [1, 'capture is still on, or some of it is still there'], [2, 'nothing ran: a usage error, root, or a confirmation nobody could give']] },
  { name: 'doctor',
    group: 'Capture', mutates: false, run: via('./doctor.mjs', 'runDoctor'),
    usage: `trocar doctor ${HARNESS} [--json]`,
    summary: 'Finds what keeps capture or the network from working and says how to fix it. It looks at the agents, your proxy, the certificates, who can read the captured files, and the backups nothing claims. It changes nothing.',
    options: [JSON_OPT],
    exits: [[0, 'nothing is wrong'], [1, 'something is wrong, and it says what'], [2, 'a usage error, or an unknown agent'], [3, 'it could not judge; it says what it could not read']] },

  { name: 'query',
    group: 'Data', mutates: false, openOptions: true, run: via('./query.mjs', 'run'),
    usage: 'trocar query <name> [--<param> <value>...]',
    summary: 'The one way to read what was captured. Each query has a name and its own parameters; the board asks the same queries over HTTP. Run it with no name to list them.',
    options: [],
    exits: [[0, 'the answer is on stdout'], [1, 'no document could be produced'], [2, 'nothing ran: the query name or one of its parameters is not known']] },
  { name: 'classes',
    group: 'Data', mutates: (args) => ['set', 'add', 'rm', 'reset'].includes(args.positionals[0]), run: via('./classes.mjs', 'run'),
    usage: 'trocar classes [<class>] [--json]\ntrocar classes set <class> full|log\ntrocar classes add <class> <host-regex> [<path-regex>] [--harness <harness>]\ntrocar classes rm <class> [<rule>]\ntrocar classes reset',
    summary: 'Shows and edits your traffic classes: which hosts belong to which class, and how much of each class is kept. Editing takes effect for calls made afterwards; what is already stored does not change.',
    options: [['--harness <harness>', 'the rule applies to this agent only'], JSON_OPT],
    exits: [[0, 'done, or shown'], [1, 'the class or rule could not be read or written'], [2, 'nothing ran: a usage error, an unknown class, or root']] },
  { name: 'board',
    group: 'Data', mutates: false, run: via('./board.mjs', 'run'),
    usage: 'trocar board',
    summary: 'Opens the board in your browser. The board is served by the collector from install on, so there is nothing to start; this prints its address with your key and opens it.',
    options: [],
    exits: [[0, 'the address is printed'], [1, 'the board is not there: trocar is not installed, the collector did not start, or its port is taken'], [2, 'a usage error']] },

  { name: 'rules',
    group: 'Intervene', mutates: (args) => ['add', 'enable', 'disable', 'rm', 'off'].includes(args.positionals[0]) || (args.positionals[0] === 'max-delay' && args.positionals.length > 1), run: via('./rules.mjs', 'run'),
    usage: 'trocar rules [<name>] [--json]\ntrocar rules add <file|-> [--replace] [--dry-run] [--json]\ntrocar rules enable|disable|rm <name>... [--json]\ntrocar rules off [--json]\ntrocar rules max-delay [<ms>] [--json]\ntrocar rules test <name> [--ref <record>]... [--last <n>] [--with-live] [--as-sent] [--run-script] [--json]',
    summary: 'Shows and edits your rules: what trocar changes in the traffic it sees, and only what you wrote down. A rule is added switched off. trocar rules off stops them all at any time, from any terminal.',
    options: [['--replace', 'with add: change the rule of that name, which switches it off'], ['--dry-run', 'with add: check the rule and print what would happen, writing nothing'],
      ['--ref <record>', 'with test: try it on this record; give it again for more', { repeat: true }], ['--last <n>', 'with test: try it on the newest n records its conditions pass, at most 500; the default is 20'],
      ['--with-live', 'with test: stack it on the live rules, in file order'], ['--as-sent', 'with test: show request rules the bytes that went out, not what the agent sent'],
      ['--run-script', 'with test: run scripts too; a script can fetch, so it may have side effects'], JSON_OPT],
    details: () => require('./rules-manual.mjs').rulesManual(),
    exits: [[0, 'done, shown, or tested, however many records it changed'], [1, 'it could not be done, the collector did not answer `rules off`, or `rules test` could test nothing or failed on a record; it says what is still true'], [2, 'nothing ran: a usage error, a rule that is not valid, an unknown rule, or root']] },

  { name: 'update',
    group: 'Maintenance', mutates: true, run: via('./update.mjs', 'runUpdateCli'),
    usage: 'trocar update [--yes] [--dry-run] [--json]',
    summary: 'Takes this trocar to the newest code and leaves the machine as it was: installed, and capturing whatever it was capturing. The agents it captures are switched off while the code changes and switched on again after it.',
    options: [YES, DRY, JSON_OPT],
    exits: [[0, 'it is up to date'], [1, 'it was not updated, or not finished; it says why'], [2, 'nothing ran: a usage error, an npm copy with nothing to finish, this trocar is not a git checkout, root, or a confirmation nobody could give']] },
  { name: 'raw',
    group: 'Maintenance', mutates: false, run: via('./raw.mjs', 'run'),
    usage: 'trocar raw <segment>[:<from>[-<to>]]',
    summary: 'Prints captured records byte for byte; a sealed segment is decoded first. <from> and <to> are record numbers, both included. Sealing itself is the daemon\'s job.',
    options: [],
    exits: [[0, 'the records are on stdout'], [1, 'the segment or a record number does not exist, or could not be read'], [2, 'a usage error']] },
  { name: 'daemon',
    group: 'Maintenance', mutates: true, recordsPath: false, run: via('./daemon.mjs', 'runDaemonCli'), // 4.11 present: the login service's PATH is not the user's
    usage: 'trocar daemon [--supervise]',
    summary: 'Runs the collector in the foreground. This is what starts at login, so you do not normally type it. It drains what is in flight before it stops.',
    options: [['--supervise', 'on Windows: the parent the scheduled task starts, which keeps the collector running']],
    exits: [[0, 'it stopped cleanly'], [1, 'it could not start, and it says why'], [2, 'nothing ran: a usage error or root'], [70, 'it crashed']] },
  { name: 'setup-helper',
    group: 'Maintenance', mutates: false, needsRoot: true, run: via('./setup-helper.mjs', 'run'),
    usage: 'sudo trocar setup-helper [--remove] [--binary <path>]',
    summary: 'Installs the capability helper trocar needs on Linux, once per machine. This is the only command that needs root, and it is not needed on macOS or Windows.',
    options: [['--remove', 'remove the helper instead of installing it'], ['--binary <path>', 'install this helper binary, one you built yourself']],
    exits: [[0, 'the helper is in place, or gone'], [1, 'it could not be installed, and it says why'], [2, 'nothing ran: a usage error, not root, or not Linux']] },
  // not in help (§2): only the install scripts and `trocar update` run it
  { name: 'place', hidden: true,
    group: null, mutates: true, run: via('./place.mjs', 'runPlaceCli'),
    usage: 'trocar place <dir>',
    summary: 'Switches this machine to a version the install script has put in ~/.trocar/app. Old versions nothing can still run are removed.',
    options: [],
    exits: [[0, 'that version is the one the trocar command runs'], [1, 'it could not be switched to, and it says why'], [2, 'a usage error or root']] },
  // `help` is the trailer of the first screen, not an entry of a section (§2).
  { name: 'help',
    group: null, mutates: false, run: help,
    usage: 'trocar help [<command>]',
    summary: 'The list of commands, or one command: its usage, what it does, its options and its exit codes. `trocar <command> --help` prints the same page.',
    options: [],
    exits: [[0, 'printed'], [2, 'there is no such command']] },
])

/** The command called `name`, or undefined. */
export const commandNamed = (name) => COMMANDS.find((c) => c.name === name)

/** The first line of a command's usage — what a usage error prints under its message. */
export const usageLine = (cmd) => cmd.usage.split('\n')[0]

/** A usage line split into what a reader scans for (`trocar raw seal`) and the arguments after it (`[--json]`). */
const split = (line) => {
  const at = line.search(/ [[<]/)
  return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)]
}

/** The listed usage lines of the sections, aligned on one column (the `sudo` line is longer than the rest and keeps one space, §2).
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

/** The help (§2, §5.4): the four sections, or `helpText('on')` for one command. A name that is no command throws. */
export function helpText(name) {
  if (name !== undefined) {
    const cmd = commandNamed(name)
    if (!cmd) throw new RangeError(`no command named ${name}`)
    const out = [...cmd.usage.split('\n').flatMap((l) => wrap(l, WIDTH, '  ')), '', ...wrap(cmd.summary)]
    const options = [...optionsOf(cmd).values()]
    if (options.length) out.push('', 'Options', ...block(options.map((o) => [o.value ? `${o.name} <${o.value}>` : o.name, o.help])))
    out.push('', 'Exit codes', ...block(cmd.exits.map(([c, what]) => [String(c), what])))
    if (cmd.details) out.push('', typeof cmd.details === 'function' ? cmd.details() : cmd.details)
    return out.join('\n')
  }
  const out = [...wrap('trocar - see every byte your agents really send to a model: captured as it is, replayed and taken apart'), '']
  const lines = listing()
  for (const group of GROUPS) out.push(group, ...lines(group), '')
  out.push('trocar help [<command>]   trocar <command> --help   trocar --version')
  return out.join('\n')
}
