// daemon.mjs — `trocar daemon` (RFC 1.6 §2, R4, R7; 4.6 §控制面): the per-user collector daemon in the foreground until SIGTERM / SIGINT / SIGHUP / SIGQUIT, or until it has stopped itself (after an `off` with no
// names, once nothing is relayed). `--supervise` (win32, 4.8 §7) is the other mode: the scheduled task runs it — the supervisor parent that pulls the real `node <trocar> daemon` and re-pulls it on a non-zero
// exit; it owns no crash records (stderr only), so that mode returns as soon as arch.runSupervisor does. The autostart unit's ExecStart is this command; `trocar collector start` is its old name (a hidden alias, §2: units already installed run it). Exit codes (R4): 0 stopped
// cleanly, or another daemon already answers on the control channel (D62 ⑥: already as asked; a non-zero exit would be retried by the platform for as long as that one lives) · 1 it could not start, or a step of the stop failed · 2 a usage error, root included (V76) · 70 an uncaught exception or rejection, recorded as a
// `crash` first. Everything the world gives is a `deps` entry a test replaces (0.1 §3): `daemon` (the module with `startDaemon`; the real one is src/collector/daemon.mjs) or `startDaemon` itself, `waitForStop`,
// `proc` (the process whose uncaught errors are caught), `exit`, `getuid`.
import os from 'node:os'
import path from 'node:path'
import { EXIT } from './schema.mjs'
import { appendEvent } from '../collector/core/events.mjs'
import { collectorHome } from '../paths.mjs'
import nodeFs from 'node:fs'
import { daemonMayStart, readManifest as readInstallManifest } from '../off/manifest.mjs'
import { DAEMON_ALREADY_UP, DAEMON_ENDPOINT_BUSY } from '../collector/core/control.mjs'


const USAGE = 'usage: trocar daemon [--supervise]'
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
  // `--supervise` (4.8 §7): the scheduled task starts THIS supervisor parent, which runs the real `node <trocar> daemon` and re-pulls it on a
  // non-zero exit. Exactly the lone flag — a second one would be a second parent; anything else is still a usage error.
  const supervise = argv.length === 1 && argv[0] === '--supervise'
  if (argv.length && !supervise) { io.err(`trocar daemon: takes no arguments (${argv.join(' ')})\n${USAGE}`); return EXIT.usage }
  if ((deps.getuid || processUid)() === 0) { io.err('trocar daemon: run this as your own user, not as root.'); return EXIT.usage }
  const proc = deps.proc || process
  const dir = collectorHome(path.join(home, '.trocar'))
  if (supervise) { // the supervisor owns no crash records of its own (4.8 §7: stderr only — under conhost --headless, nowhere), so the branch below is untouched
    const D = deps.daemon || (await import('../collector/daemon.mjs')) // the CLI reaches arch only through daemon.mjs (layering rule 5)
    const run = (await D.loadArch(platform)).runSupervisor // a platform whose arch has no supervisor (linux) refuses here, so the CLI holds no platform list
    if (typeof run !== 'function') { io.err(`trocar daemon: --supervise is for Windows only, where a parent keeps the collector running.\n${USAGE}`); return EXIT.usage }
    return run({ trocar: deps.script || process.argv[1], dir, proc, env, log: (line) => io.err(`[supervise] ${line}`) })
  }
  // 1.6 §5.2: no install, no daemon — it is refused before anything of trocar's is made or written (an empty collector directory and a netenv.json
  // left behind by a daemon that could not run is residue of a run that never should have begun). The gate is the daemon's own (daemonMayStart):
  // an install that left a root but could not finish (a root store still pending) routes, and this daemon starts, as src/collector/daemon.mjs does.
  const D = await (deps.daemon || import('../collector/daemon.mjs'))
  // V14 first: a platform with no collector is refused before anything starts or is written — loadArch's own error, so the CLI holds no platform list
  // (ahead of the install gate: on such a platform "not supported yet" is the honest answer, installing would not help)
  if (typeof D.loadArch === 'function') { try { await D.loadArch(platform) } catch (e) { io.err(`trocar daemon: ${e.message}`); return EXIT.incomplete } } // an injected daemon without one answers for the platform itself
  if (!daemonMayStart(readInstallManifest(dir, deps.fs || nodeFs))) { io.err('trocar daemon: certificates are not installed. Run: trocar install'); return EXIT.incomplete }
  let crashed
  const crashedFirst = new Promise((resolve) => { crashed = resolve })
  // An uncaught exception or rejection: one `crash` record with the first line of the stack, then a non-zero exit — the next start's "no clean stop" then has a reason on disk (D-5).
  const crash = (e) => {
    const first = String((e && e.stack) || e).split('\n').slice(0, 2).join(' | ')
    try { appendEvent(dir, { event: 'failure', where: 'daemon', code: 'crash', reason: first }) } catch (w) { io.err(`[events] ${String((w && w.message) || w)}`) }
    io.err(`trocar daemon: crashed: ${first}`)
    ;(deps.exit || ((c) => process.exit(c)))(EXIT.crash)
    crashed(EXIT.crash) // a real exit never returns here; a test's spy does, and the run reports the code
  }
  proc.on('uncaughtException', crash); proc.on('unhandledRejection', crash)
  const foreground = !env.INVOCATION_ID && !!(proc.stdin && proc.stdin.isTTY) // not under systemd, at a terminal: closing it stops the daemon
  const start = deps.startDaemon || D.startDaemon
  let d
  try { d = await start({ dir, env, foreground, log: (where, e) => io.err(`[${where}] ${e && e.message ? e.message : e}`) }) } catch (e) {
    io.err(`trocar daemon: ${e.message}`)
    // D62 ⑥: a daemon that finds another one answering is already as asked, not a failure. It says so once (the line above goes to the daemon log, D46)
    // and exits 0, because the platform retries a non-zero exit for as long as the other daemon lives — launchd's KeepAlive {SuccessfulExit: false} every
    // ThrottleInterval, the Windows supervisor on its backoff (4.8 §7: 0 = it was asked to stop, do not re-pull) — which is a loop nobody sees.
    if (e && e[DAEMON_ALREADY_UP]) return EXIT.ok
    // An endpoint held by something that does NOT answer is the opposite case (D38): exiting 0 here would leave the machine with no working collector
    // until the next login, and no record of why. One failure record naming the pid the lock claims, then a non-zero exit, so the platform retries at
    // its own throttle and `trocar status` / `trocar doctor` show it.
    if (e && e[DAEMON_ENDPOINT_BUSY]) {
      const held = (() => { try { return JSON.parse((deps.fs || nodeFs).readFileSync(D.collectorPaths(dir).lock, 'utf8')).pid ?? null } catch { return null } })()
      try { appendEvent(dir, { event: 'failure', where: 'start', code: 'control-endpoint-held', reason: `${e.message}; ${held == null ? 'no pid is on record' : `the lock says pid ${held} holds it`}` }) } catch (w) { io.err(`[events] ${String((w && w.message) || w)}`) }
      return EXIT.incomplete
    }
    return EXIT.incomplete
  }
  // the readiness line (whatever script starts the daemon waits for it): a port or an endpoint that is not known is left out, never printed as `null` (§1.1)
  io.out(`trocar collector: ${[d.port ? `engine 127.0.0.1:${d.port}` : 'engine: no port of its own', d.socketPath ? `control ${d.socketPath}` : null].filter(Boolean).join(', ')}`)
  // a signal, or the daemon stopping itself (after `off` with no names, once nothing is relayed: 1.6 §1.4 5; exit 0 so systemd does not restart it)
  const signal = await Promise.race([(deps.waitForStop || waitForSignal)(), d.exited ? d.exited.then(() => null) : new Promise(() => {}), crashedFirst])
  const r = await d.stop({ signal: typeof signal === 'string' ? signal : null }) // stops once: when the daemon has stopped itself this is its result
  if (signal === EXIT.crash) return EXIT.crash
  if (r && r.failed && r.failed.length) { io.err(`trocar daemon: stopped, but ${r.failed.join(', ')} failed while stopping (recorded in flows/)`); return EXIT.incomplete }
  return EXIT.ok
}
