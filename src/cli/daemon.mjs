// daemon.mjs — `asight daemon` (RFC 1.6 §2, R4, R7; 4.6 §控制面): the per-user collector daemon in the foreground until SIGTERM / SIGINT / SIGHUP / SIGQUIT, or until it has stopped itself (after an `off` with no
// names, once nothing is relayed). `--supervise` (win32, 4.8 §7) is the other mode: the scheduled task runs it — the supervisor parent that pulls the real `node <asight> daemon` and re-pulls it on a non-zero
// exit; it owns no crash records (stderr only), so that mode returns as soon as arch.runSupervisor does. The autostart unit's ExecStart is this command; `asight collector start` is its old name (a hidden alias, §2: units already installed run it). Exit codes (R4): 0 stopped
// cleanly · 1 refused (as root, on a platform without the new collector, the daemon would not start) or a step of the stop failed · 2 a usage error · 70 an uncaught exception or rejection, recorded as a
// `crash` first. Everything the world gives is a `deps` entry a test replaces (0.1 §3): `daemon` (the module with `startDaemon`; the real one is src/collector/daemon.mjs) or `startDaemon` itself, `waitForStop`,
// `proc` (the process whose uncaught errors are caught), `exit`, `getuid`.
import os from 'node:os'
import path from 'node:path'
import { EXIT } from './schema.mjs'
import { appendEvent } from '../collector/core/events.mjs'
import { collectorHome } from '../paths.mjs'
import { hasNewCollector } from '../off/legacy.mjs'

const USAGE = 'usage: asight daemon [--supervise]'
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)

// SIGHUP (the terminal closed, SSH dropped, logout) and SIGQUIT stop it cleanly like SIGTERM / SIGINT — Node's default
// for SIGHUP is to exit at once, leaving the lock behind and the next start recording a crash that never was (D-27).
export const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']
const waitForSignal = () => new Promise((resolve) => {
  const on = (sig) => { for (const s of STOP_SIGNALS) process.removeListener(s, handlers[s]); resolve(sig) }
  const handlers = Object.fromEntries(STOP_SIGNALS.map((s) => [s, () => on(s)]))
  for (const s of STOP_SIGNALS) process.once(s, handlers[s])
})

/** → the exit code. `argv` is what follows `daemon`; `io` = { out, err } (src/off/io.mjs makeIo). */
export async function runDaemonCli(argv, { io, env = process.env, home = os.homedir(), platform = process.platform, deps = {} } = {}) {
  // `--supervise` (4.8 §7): the scheduled task starts THIS supervisor parent, which runs the real `node <asight> daemon` and re-pulls it on a
  // non-zero exit. Exactly the lone flag — a second one would be a second parent; anything else is still a usage error.
  const supervise = argv.length === 1 && argv[0] === '--supervise'
  if (argv.length && !supervise) { io.err(`asight daemon: takes no arguments (${argv.join(' ')})\n${USAGE}`); return EXIT.usage }
  if ((deps.getuid || processUid)() === 0) { io.err('asight daemon: 用你自己的账号跑,不要用 root / sudo(D36)'); return EXIT.incomplete }
  if (!(deps.hasNewCollector || hasNewCollector)(platform)) { io.err(`asight daemon: 本平台未实现(${platform}):按进程采集器只有 Linux(4.6)、Windows(4.8)和 macOS(4.9)有;本平台旧采集的 on / off 照旧(1.6 §4)`); return EXIT.incomplete }
  const proc = deps.proc || process
  const dir = collectorHome(path.join(home, '.asight'))
  if (supervise) { // the supervisor owns no crash records of its own (4.8 §7: stderr only — under conhost --headless, nowhere), so the branch below is untouched
    const D = deps.daemon || (await import('../collector/daemon.mjs')) // the CLI reaches arch only through daemon.mjs (layering rule 5)
    const run = (await D.loadArch(platform)).runSupervisor // a platform whose arch has no supervisor (linux) refuses here, so the CLI holds no platform list
    if (typeof run !== 'function') { io.err(`asight daemon: --supervise 是 Windows 监管父进程的事(4.8 §7);本平台(${platform})的 arch 没有它\n${USAGE}`); return EXIT.usage }
    return run({ asight: deps.script || process.argv[1], dir, proc, env, log: (line) => io.err(`[supervise] ${line}`) })
  }
  let crashed
  const crashedFirst = new Promise((resolve) => { crashed = resolve })
  // An uncaught exception or rejection: one `crash` record with the first line of the stack, then a non-zero exit — the next start's "no clean stop" then has a reason on disk (D-5).
  const crash = (e) => {
    const first = String((e && e.stack) || e).split('\n').slice(0, 2).join(' | ')
    try { appendEvent(dir, { event: 'failure', where: 'daemon', code: 'crash', reason: first }) } catch (w) { io.err(`[events] ${String((w && w.message) || w)}`) }
    io.err(`asight daemon: crashed: ${first}`)
    ;(deps.exit || ((c) => process.exit(c)))(EXIT.crash)
    crashed(EXIT.crash) // a real exit never returns here; a test's spy does, and the run reports the code
  }
  proc.on('uncaughtException', crash); proc.on('unhandledRejection', crash)
  const foreground = !env.INVOCATION_ID && !!(proc.stdin && proc.stdin.isTTY) // not under systemd, at a terminal: closing it stops the daemon
  const start = deps.startDaemon || (await (deps.daemon || import('../collector/daemon.mjs'))).startDaemon
  let d
  try { d = await start({ dir, env, foreground, log: (where, e) => io.err(`[${where}] ${e && e.message ? e.message : e}`) }) } catch (e) { io.err(`asight daemon: ${e.message}`); return EXIT.incomplete }
  io.out(`asight collector: engine 127.0.0.1:${d.port}, control ${d.socketPath}`) // this line is the daemon's readiness signal (the script that starts the daemon waits for it)
  // a signal, or the daemon stopping itself (after `off` with no names, once nothing is relayed: 1.6 §1.4 5; exit 0 so systemd does not restart it)
  const signal = await Promise.race([(deps.waitForStop || waitForSignal)(), d.exited ? d.exited.then(() => null) : new Promise(() => {}), crashedFirst])
  const r = await d.stop({ signal: typeof signal === 'string' ? signal : null }) // stops once: when the daemon has stopped itself this is its result
  if (signal === EXIT.crash) return EXIT.crash
  if (r && r.failed && r.failed.length) { io.err(`asight daemon: stopped, but ${r.failed.join(', ')} failed while stopping (recorded in flows/)`); return EXIT.incomplete }
  return EXIT.ok
}
