// on.mjs — `asight on [harness…] [--dry-run] [--yes] [--no-autostart|--no-unit] [--json]` (RFC 1.6 §1.1, §1.6, §2, R4–R7): the front end of
// turnOn (src/collector/install.mjs). It parses the arguments, builds what turnOn needs from the platform (the descriptors, the process table,
// the autostart unit, the control socket), decides how a confirmation is asked, and prints the plan and the receipt. Everything the world gives is a
// `deps` entry a test replaces (0.1 §3): `parts` (the descriptors, `scan`, `match`, the arch), `exec` (the runner of OS tools: spawnSync-shaped),
// `request` (the control socket), `helperState`, `linger`, `now`, `freePort`, `sleep`, `roots`, `user`, `getuid`, `fs`, `script`, and `legacyOn` — the
// hook of a platform without the new collector (macOS, Windows: 1.6 §4; Task 10 fills it).
// Exit codes (R4): 0 done · 1 not done or a problem · 2 usage error / not in a terminal without --yes (nothing touched).
import os from 'node:os'
import { resolveHarnesses } from './harness-names.mjs'
import { EXIT, newReceipt } from './schema.mjs'
import { isInteractive, confirm as ask } from '../off/io.mjs'
import { formatOnReceipt, formatPlan } from './receipt.mjs'

const USAGE = 'usage: asight on [harness…] [--dry-run] [--yes] [--no-autostart | --no-unit] [--json]'
const FLAGS = new Set(['--dry-run', '--yes', '--no-autostart', '--no-unit', '--json'])
const PROXY_HINT = 'D39 之前的 `asight on --proxy` 现在是 `asight monitor on --no-autostart`(旧 CC-CLI steer 仍在 monitor 下;新的 on 不做它,它做不到 off 保证,1.6 §4)'
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)

/** → the exit code. `argv` is what follows `on`. `io` = { out, err, stdin, stdout, stderr } (src/off/io.mjs makeIo). */
export async function runOnCli(argv, { io, env = process.env, home = os.homedir(), platform = process.platform, deps = {} } = {}) {
  const flags = new Set(), names = []
  for (const a of argv) {
    if (a === '--proxy' || a.startsWith('--proxy=')) { io.err(`asight on: ${PROXY_HINT}`); return EXIT.usage }
    if (a.startsWith('-')) {
      if (!FLAGS.has(a)) { io.err(`asight on: unknown option ${a}\n${USAGE}`); return EXIT.usage }
      flags.add(a)
    } else if (!(a.startsWith('http://') || a.startsWith('https://'))) names.push(a)
    else { io.err(`asight on: ${PROXY_HINT}`); return EXIT.usage }
  }
  if (flags.has('--no-autostart') && flags.has('--no-unit')) { io.err(`asight on: --no-autostart and --no-unit exclude each other (the first writes the unit and starts it once, the second writes none)\n${USAGE}`); return EXIT.usage }
  const named = resolveHarnesses(names)
  if (!named.ok) { io.err(`asight on: unknown harness ${named.unknown.join(', ')}; the names are: ${named.known.join(', ')}`); return EXIT.usage }
  const json = flags.has('--json')
  const say = json ? io.err : io.out // stdout holds the one JSON in --json mode (R5); warnings and the plan go to stderr
  if (platform !== 'linux') {
    if (deps.legacyOn) return deps.legacyOn(argv, { io, env, home, platform, deps })
    io.err(`asight on: 本平台(${platform})没有新采集器;这里 on / off 驱动旧采集(过渡期,1.6 §4),这一步还没接上`)
    return EXIT.incomplete
  }
  if ((deps.getuid || processUid)() === 0) { io.err('asight on: 用你自己的账号跑,不要用 root / sudo(D36;只有 `sudo asight setup-helper` 要 root)'); return EXIT.incomplete }
  try {
    const parts = deps.parts || await (await (deps.daemon || import('../collector/daemon.mjs'))).loadParts({ env })
    const install = deps.install || await import('../collector/install.mjs')
    const script = deps.script || process.argv[1]
    const unit = flags.has('--no-unit') || !parts.arch || !parts.arch.unit || !parts.arch.unit.userUnit ? null : parts.arch.unit.userUnit({ home, node: process.execPath, script, run: deps.exec || null, env })
    const helperState = deps.helperState || (parts.arch && parts.arch.install && parts.arch.install.helperState ? () => parts.arch.install.helperState() : null)
    const autostart = !flags.has('--no-autostart')
    const yes = flags.has('--yes')
    const confirm = async () => {
      if (yes) return true
      if (!isInteractive(io)) return null // not a terminal: the plan is all we print (R6)
      return ask({ ...io, prompt: json ? io.stderr : io.stdout }, 'asight 将按上面的清单写或改这些文件。继续?')
    }
    const { receipt, exit } = await install.turnOn({
      home, env, ids: named.ids, osName: parts.os, harnesses: parts.harnesses, scan: parts.scan, match: parts.match, osRootsFile: parts.osRootsFile || null,
      roots: deps.roots || null, unit, autostart, freePort: deps.freePort, dryRun: flags.has('--dry-run'), confirm,
      onPlan: (plan) => say(formatPlan(plan, { home, autostart })),
      request: deps.request, now: deps.now, getuid: deps.getuid, helperState, linger: deps.linger || parts.linger || null, sleep: deps.sleep, user: deps.user, fs: deps.fs,
    })
    if (json) io.out(JSON.stringify(receipt, null, 2))
    else if (receipt.planned) for (const n of receipt.notes) io.err(n) // the plan was printed; what is left to say is why nothing was done (R6)
    else io.out(formatOnReceipt(receipt, { tense: receipt.dry_run ? 'future' : 'past', home }))
    return exit
  } catch (e) {
    const message = String((e && e.message) || e)
    if (json) io.out(JSON.stringify({ ...newReceipt('on'), ok: false, notes: [message] }, null, 2)); else io.err(`asight on: ${message}`)
    return EXIT.incomplete
  }
}
