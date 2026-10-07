// main.mjs (src/off) — `asight off [harness…] [--now] [--dry-run] [--yes] [--json] [--remove-ca]` as a command line (RFC 1.6 §2, §3, R4–R7): parses the arguments,
// refuses root, resolves the harness names, runs runOff and prints its receipt. `asight off` and the standalone `~/.asight/bin/asight-off` run this same file
// (R3), so it may import nothing outside src/off (0.1 §2) — which is why the §3 name table is written here too (OFF_NAMES) and test/cli/harness-names.test.mjs
// holds it equal to src/cli/harness-names.mjs. Everything the world gives is a `deps` entry (see orchestrate.mjs), plus `getuid` and `legacyOff`: the hook of a
// platform without the new collector (macOS, Windows: 1.6 §4; Task 10 fills it). Exit codes (R4): 0 done · 1 not done or a problem · 2 usage error, nothing touched.
import nodeOs from 'node:os'
import { runOff } from './orchestrate.mjs'
import { formatOffReceipt } from './receipt.mjs'
import { EXIT, newReceipt } from './schema.mjs'
import { isInteractive, makeIo } from './io.mjs'

/** 1.6 §3: the harness code ids (in the order commands list them) and the short names accepted as input. A copy of src/cli/harness-names.mjs. */
export const OFF_NAMES = Object.freeze({
  ids: Object.freeze(['claude-code', 'codex', 'hermes', 'opencode', 'deepseek-dsh', 'kimi-code', 'z-code']),
  aliases: Object.freeze({ claude: 'claude-code', dsh: 'deepseek-dsh', kimi: 'kimi-code', zcode: 'z-code' }),
})

const OFF_USAGE = 'usage: asight off [harness…] [--now] [--dry-run] [--yes] [--json]'
const OFF_FLAGS = new Set(['--now', '--dry-run', '--yes', '--json', '--remove-ca'])
const REMOVE_CA_NOTE = '--remove-ca 照收,可以不写:off 本来就撤旧采集的 CA(旧的 monitor off --remove-ca 就是这个意思)'

/** `[harness…]` as typed → `{ ok: true, ids }` (null = none named = all; else code ids in table order, a repeat once) or `{ ok: false, unknown, known }`. Case is not folded. */
export function resolveOffNames(names) {
  if (!names || names.length === 0) return { ok: true, ids: null }
  const chosen = new Set(), unknown = []
  for (const raw of names) {
    const name = String(raw)
    const id = Object.hasOwn(OFF_NAMES.aliases, name) ? OFF_NAMES.aliases[name] : OFF_NAMES.ids.includes(name) ? name : null
    if (id) chosen.add(id)
    else if (!unknown.includes(name)) unknown.push(name)
  }
  if (unknown.length) return { ok: false, unknown, known: [...OFF_NAMES.ids, ...Object.keys(OFF_NAMES.aliases)] }
  return { ok: true, ids: OFF_NAMES.ids.filter((id) => chosen.has(id)) }
}

/** → the exit code. `argv` is what follows `off`. `io` = { out, err, stdin, stdout, stderr } (src/off/io.mjs makeIo; the process's own streams when none is given, which is how the
 *  standalone `asight-off` calls it). */
export async function runOffCli(argv, { io = makeIo({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }), env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  const flags = new Set(), names = []
  for (const a of argv) {
    if (a.startsWith('-')) {
      if (!OFF_FLAGS.has(a)) { io.err(`asight off: unknown option ${a}\n${OFF_USAGE}`); return EXIT.usage }
      flags.add(a)
    } else names.push(a)
  }
  const named = resolveOffNames(names)
  if (!named.ok) { io.err(`asight off: unknown harness ${named.unknown.join(', ')}; the names are: ${named.known.join(', ')}`); return EXIT.usage }
  const json = flags.has('--json')
  const say = json ? io.err : io.out // stdout holds the one JSON in --json mode (R5): the list and the question go to stderr
  if ((deps.getuid || (typeof process.getuid === 'function' ? () => process.getuid() : () => -1))() === 0) { io.err('asight off: 用你自己的账号跑,不要用 root / sudo(D36)'); return EXIT.incomplete }
  if (platform !== 'linux') {
    if (deps.legacyOff) return deps.legacyOff(argv, { io, env, home, platform, deps })
    io.err(`asight off: 本平台(${platform})没有新采集器;这里 on / off 驱动旧采集(过渡期,1.6 §4),这一步还没接上`)
    return EXIT.incomplete
  }
  try {
    const { receipt, exit } = await runOff({ home, env, ids: named.ids, now: flags.has('--now'), yes: flags.has('--yes'), dryRun: flags.has('--dry-run'), interactive: isInteractive(io), io: { ...io, prompt: json ? io.stderr : io.stdout }, say, deps })
    if (flags.has('--remove-ca')) receipt.notes.unshift(REMOVE_CA_NOTE)
    io.out(json ? JSON.stringify(receipt, null, 2) : formatOffReceipt(receipt, { home }))
    return exit
  } catch (e) {
    const message = String((e && e.message) || e)
    if (json) io.out(JSON.stringify({ ...newReceipt('off'), ok: false, notes: [message] }, null, 2)); else io.err(`asight off: ${message}`)
    return EXIT.incomplete
  }
}
