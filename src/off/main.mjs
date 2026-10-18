// main.mjs (src/off) — `asight off [harness…] [--now] [--dry-run] [--yes] [--json]` as a command line (RFC 1.6 §2, §3, R4–R7): parses the arguments,
// refuses root, resolves the harness names, runs runOff and prints its receipt. `asight off` and the standalone `~/.asight/bin/asight-off` run this same file
// (R3), so it may import nothing outside src/off (0.1 §2) — which is why the §3 name table is written here too (OFF_NAMES) and test/cli/harness-names.test.mjs
// holds it equal to src/cli/harness-names.mjs. Everything the world gives is a `deps` entry (see orchestrate.mjs), plus `getuid`. A platform without a collector
// finds nothing to undo and says so (D39⑥ executed 2026-10-11: the old capture's off went with it; what it left on a machine is cleaned by hand, README).
// Exit codes (R4): 0 done · 1 not done or a problem · 2 usage error, nothing touched.
import nodeOs from 'node:os'
import { runOff } from './orchestrate.mjs'
import { formatOffReceipt } from './receipt.mjs'
import { EXIT, newReceipt } from './schema.mjs'
import { isInteractive, makeIo } from './io.mjs'
import { readManifest } from './manifest.mjs'
import { collectorDir } from './paths.mjs'

/** 1.6 §3: the harness code ids (in the order commands list them) and the short names accepted as input. A copy of src/cli/harness-names.mjs. */
export const OFF_NAMES = Object.freeze({
  ids: Object.freeze(['claude-code', 'codex', 'hermes', 'opencode', 'deepseek-dsh', 'kimi-code', 'z-code']),
  aliases: Object.freeze({ claude: 'claude-code', dsh: 'deepseek-dsh', kimi: 'kimi-code', zcode: 'z-code' }),
})

const OFF_USAGE = 'usage: asight off [<harness>...] [--now] [--yes] [--dry-run] [--json]'
const OFF_FLAGS = new Set(['--now', '--dry-run', '--yes', '--json'])

/** `[harness…]` as typed → `{ ok: true, ids }` (null = none named = all; else code ids in table order, a repeat once) or `{ ok: false, unknown, known }`. Case is not folded.
 *  `installed`: the harness ids the install manifest names; each is a name too, so a harness added as descriptor data alone can be turned off (CM27). */
export function resolveOffNames(names, installed = []) {
  if (!names || names.length === 0) return { ok: true, ids: null }
  const chosen = new Set(), unknown = []
  for (const raw of names) {
    const name = String(raw)
    const id = Object.hasOwn(OFF_NAMES.aliases, name) ? OFF_NAMES.aliases[name] : OFF_NAMES.ids.includes(name) || installed.includes(name) ? name : null
    if (id) chosen.add(id)
    else if (!unknown.includes(name)) unknown.push(name)
  }
  const extra = [...new Set(installed)].filter((id) => !OFF_NAMES.ids.includes(id))
  if (unknown.length) return { ok: false, unknown, known: [...OFF_NAMES.ids, ...extra, ...Object.keys(OFF_NAMES.aliases)] }
  return { ok: true, ids: [...OFF_NAMES.ids, ...extra].filter((id) => chosen.has(id)) }
}

/** The harness ids the install manifest names (install's list and the entries' owners); [] when there is none or it cannot be read (the fixed names still work). */
function installedIds(home) {
  try {
    const m = readManifest(collectorDir(home))
    return m ? [...((m.install && m.install.harnesses) || []), ...(m.entries || []).map((e) => e && e.harness)].filter((x) => typeof x === 'string' && x) : []
  } catch { return [] }
}

/** → the exit code. `argv` is what follows `off`. `io` = { out, err, stdin, stdout, stderr } (src/off/io.mjs makeIo; the process's own streams when none is given, which is how the
 *  standalone `asight-off` calls it). `standalone`: this is the single-file copy (src/off/standalone.mjs ends in a call with it): the only difference is the words of what it
 *  cannot undo — a manifest or an item of a kind it does not know is left alone and the person is sent to `asight off` (R3, V35); the receipt is otherwise the same one. */
export async function runOffCli(argv, { io = makeIo({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }), env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {}, standalone = false } = {}) {
  const flags = new Set(), names = []
  for (const a of argv) {
    if (a.startsWith('-')) {
      if (!OFF_FLAGS.has(a)) { io.err(`asight off: unknown option '${a}'\n${OFF_USAGE}`); return EXIT.usage }
      flags.add(a)
    } else names.push(a)
  }
  const named = resolveOffNames(names, names.length ? installedIds(home) : [])
  if (!named.ok) { io.err(`asight off: unknown harness '${named.unknown[0]}'. Known: ${named.known.filter((n) => !Object.hasOwn(OFF_NAMES.aliases, n)).join(', ')}`); return EXIT.usage }
  const json = flags.has('--json')
  // §1.2: under `--json` stdout holds the one document and stderr is EMPTY — so no listing on stderr and no question: an `off` with no install record
  // puts its plan in the receipt's `planned` and exits 1, the way install / on / uninstall answer a run that needs a yes (review 2026-10-18).
  const say = json ? () => {} : io.out
  if ((deps.getuid || (typeof process.getuid === 'function' ? () => process.getuid() : () => -1))() === 0) { io.err('asight off: run this as your own user, not as root.'); return EXIT.usage } // §1.5: it refuses before it reads or writes anything
  try {
    const { receipt, exit } = await runOff({ home, env, ids: named.ids, now: flags.has('--now'), yes: flags.has('--yes'), dryRun: flags.has('--dry-run'), interactive: !json && isInteractive(io), io: { ...io, prompt: io.stdout }, say, deps: { platform, ...deps, ...(standalone ? { standalone: true } : {}) } }) // the CLI's platform is offWorld's default (deps.platform of a test's still wins): before the darwin flip a linux sandbox on a Mac host silently ran the darwin arms
    io.out(json ? JSON.stringify(receipt, null, 2) : formatOffReceipt(receipt, { home }))
    return exit
  } catch (e) {
    const message = String((e && e.message) || e)
    if (json) io.out(JSON.stringify({ ...newReceipt('off'), ok: false, notes: [message] }, null, 2)); else io.err(`asight off: ${message}`)
    return EXIT.incomplete
  }
}
