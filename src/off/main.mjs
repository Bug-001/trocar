// main.mjs (src/off) — `trocar off [harness…] [--now] [--dry-run] [--yes] [--json]` as a command line (RFC 1.6 §2, §3, R4–R7): parses the arguments,
// refuses root, resolves the harness names, runs runOff and prints its receipt. `trocar off` and the standalone `~/.trocar/bin/trocar-off` run this same file
// (R3), so it may import nothing outside src/off (0.1 §2) — the §1.6 name table is ./harness-names.mjs, which the CLI imports too. Everything the world gives
// is a `deps` entry (see orchestrate.mjs), plus `getuid`. A platform without a collector finds nothing to undo and says so (D39⑥ executed 2026-10-11: the
// old capture's off went with it; what it left on a machine is cleaned by hand, README).
// Exit codes (R4): 0 done · 1 not done or a problem · 2 usage error, nothing touched.
import nodeOs from 'node:os'
import { runOff } from './orchestrate.mjs'
import { formatOffReceipt } from './receipt.mjs'
import { EXIT, newReceipt } from './schema.mjs'
import { isInteractive, makeIo, hidingIo, printJson, asOneDocument } from './io.mjs'
import { NAME_ALIASES, resolveHarnesses } from './harness-names.mjs'

const OFF_USAGE = 'usage: trocar off [<harness>...] [--now] [--yes] [--dry-run] [--json]'
const OFF_FLAGS = new Set(['--now', '--dry-run', '--yes', '--json'])

/** → the exit code. `argv` is what follows `off`. `io` = { out, err, stdin, stdout, stderr } (src/off/io.mjs makeIo; the process's own streams when none is given, which is how the
 *  standalone `trocar-off` calls it). `standalone`: this is the single-file copy (src/off/standalone.mjs ends in a call with it): the only difference is the words of what it
 *  cannot undo — a manifest or an item of a kind it does not know is left alone and the person is sent to `trocar off` (R3, V35); the receipt is otherwise the same one. */
export async function runOffCli(argv, { io = makeIo({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }), ...opts } = {}) {
  if (!opts.standalone) return offCli(argv, { ...opts, io })
  const shown = hidingIo(io) // the copy is not run through runCli, which hides userinfo and keeps a `--json` run to one document for every command (1.6 §1.2)
  return argv.includes('--json') ? asOneDocument(shown, 'off', (quiet) => offCli(argv, { ...opts, io: quiet })) : offCli(argv, { ...opts, io: shown })
}

async function offCli(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {}, standalone = false }) {
  const flags = new Set(), names = []
  for (const a of argv) {
    if (a.startsWith('-')) {
      if (!OFF_FLAGS.has(a)) { io.err(`trocar off: unknown option '${a}'\n${OFF_USAGE}`); return EXIT.usage }
      flags.add(a)
    } else names.push(a)
  }
  const named = resolveHarnesses(names, deps.harnessIds) // this copy's own table (4.11 §3 ㉓); a test world hands in the descriptors it serves
  if (!named.ok) { io.err(`trocar off: unknown harness '${named.unknown[0]}'. Known: ${named.known.filter((n) => !Object.hasOwn(NAME_ALIASES, n)).join(', ')}`); return EXIT.usage }
  const json = flags.has('--json')
  // §1.2: under `--json` stdout holds the one document and stderr is EMPTY — so no listing on stderr and no question: an `off` with no install record
  // puts its plan in the receipt's `planned` and exits 1, the way install / on / uninstall answer a run that needs a yes (review 2026-10-18).
  const say = json ? () => {} : io.out
  if ((deps.getuid || (typeof process.getuid === 'function' ? () => process.getuid() : () => -1))() === 0) { io.err('trocar off: run this as your own user, not as root.'); return EXIT.usage } // §1.5: it refuses before it reads or writes anything
  try {
    const { receipt, exit } = await runOff({ home, env, ids: named.ids, now: flags.has('--now'), yes: flags.has('--yes'), dryRun: flags.has('--dry-run'), interactive: !json && isInteractive(io), io: { ...io, prompt: io.stdout }, say, deps: { platform, ...deps, ...(standalone ? { standalone: true } : {}) } }) // the CLI's platform is offWorld's default (deps.platform of a test's still wins): before the darwin flip a linux sandbox on a Mac host silently ran the darwin arms
    if (json) printJson(io, receipt); else io.out(formatOffReceipt(receipt, { home }))
    return exit
  } catch (e) {
    const message = String((e && e.message) || e)
    if (json) printJson(io, { ...newReceipt('off'), ok: false, notes: [message] }); else io.err(`trocar off: ${message}`)
    return EXIT.incomplete
  }
}
