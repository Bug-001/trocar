// replace-daemon.mjs — the one routine that puts the collector on this code (RFC 1.6 §5.5 step 4): `update` and `install` both call it.
//   replaceDaemon({ by, env, home, platform, deps, dir, root, fs, problems }) → { restarted, stopped?, notes, elsewhere?, from }
//   daemonCode({ platform, dir, env, fs, deps }) → the code the collector names on its control channel, or null
//   deps (0.1 §3): `daemonCode`, `unit`, `request`, `socketPath`, `sleep`, `stopDaemon` (through offWorld), `script`, `exec`, `drainMs`.
import { codeId } from '../version.mjs'
import { controlEndpointFor } from '../off/control-client.mjs'

export const CUT = 'Connections the collector still holds are cut when it is replaced.'

/** The daemon on this code: one that runs another (or answers no `code`) is taken out of the way the way `uninstall` takes it — the same
 *  drain-then-stop path (`drainDaemon`: `POST /off {exit:true}`, then the wait, §5.2) and the same `stopDaemon` — and pulled up again
 *  through the login entry install registered (a stopped LaunchAgent is booted out, so this bootstraps it, 4.9 §4).
 *  `by` is the command that runs it ('update' | 'install'): the drain names it, and the remedy says to run it again.
 *  → `{ restarted, stopped?, notes, elsewhere?, from }` (`from`: the code the old daemon answered, null when none; `stopped`: whether the old
 *  daemon was stopped, absent when it already ran this code — so a caller knows a collector still runs after a failure); what went wrong is pushed on
 *  `problems`. The three modules of this step are the running code's: they are loaded here, in the process that finishes, never in one
 *  that merged. */
export async function replaceDaemon({ by, env, home, platform, deps, dir, root, fs, problems }) {
  const again = `Fix that, then run trocar ${by} again`
  const notes = []
  const running = await daemonCode({ platform, dir, env, fs, deps })
  if (running === codeId(root)) return { restarted: false, notes, from: running }
  const { offWorld, drainDaemon } = await import('../off/orchestrate.mjs')
  const w = offWorld({ home, env, deps: { ...deps, platform } })
  let { routing } = await drainDaemon(w, { drainMs: deps.drainMs, by })
  // a collector of an earlier build knows `by` only as the commands of its day (update and uninstall: a daemon from before install replaced
  // collectors) and refuses another value with a 400 naming `by`, changing nothing. It is asked once more as update — a value every build that
  // takes `by` accepts (one older still ignores the field), and the true one of those: the collector goes so that it runs another copy's code,
  // where an exit request without `by` would be written as the operator's own off. Any other refusal stays the failure it is (D38).
  if (by !== 'update' && routing.refused && routing.refused.status === 400 && /"by"/.test(routing.refused.message)) ({ routing } = await drainDaemon(w, { drainMs: deps.drainMs, by: 'update' }))
  notes.push(...routing.notes)
  const stopped = routing.stop || (routing.confirmed ? await w.stopDaemon({ unitManaged: w.unitManaged() }) : null)
  const pid = (stopped && Number.isInteger(stopped.pid) ? stopped.pid : null) ?? (Number.isInteger(routing.daemon.pid) ? routing.daemon.pid : null)
  if (!stopped || (!stopped.stopped && stopped.pid != null)) { problems.push(`the collector${pid == null ? '' : ` (pid ${pid})`} could not be stopped${stopped && stopped.error ? ` (${stopped.error})` : routing.problems[0] ? ` (${routing.problems[0]})` : ''}, so it still runs ${running || 'code of its own'}. ${again}`); return { restarted: false, stopped: false, notes, from: running } }
  const { ensureDaemonUp } = await import('../collector/install.mjs')
  const unit = deps.unit !== undefined ? deps.unit : await loginUnit({ home, env, platform, deps })
  if (!unit) { problems.push('this platform has no login entry to start the collector through, so it was not replaced'); return { restarted: false, stopped: true, notes, from: running } }
  const up = await ensureDaemonUp({ osName: platform, dir, env, fs, unit, register: true, put: (e) => { if (e && e.reason) notes.push(e.reason) }, ...(deps.request ? { request: deps.request } : {}), ...(deps.socketPath ? { socketPath: deps.socketPath } : {}), ...(deps.sleep ? { pause: deps.sleep } : {}) })
  notes.push(...up.notes)
  if (!up.up) { problems.push(`the collector did not come back up (${up.problems[0] || 'it does not answer'}). ${again}`); return { restarted: false, stopped: true, notes, from: running } }
  // a collector that answers is not yet one on THIS code: the login entry starts the copy install registered, and with npm another copy
  // (global, a project's, the npx cache) is common — what it runs is asked again, never assumed (§5.5)
  const now = await daemonCode({ platform, dir, env, fs, deps })
  if (now !== codeId(root)) { problems.push(`the collector came back on ${now || 'code it does not name'}, not on ${codeId(root)}: the login entry starts another copy of trocar. Run trocar install from this copy, or run trocar update from the copy the login entry starts.`); return { restarted: true, stopped: true, notes, elsewhere: true, from: running } }
  return { restarted: true, stopped: true, notes, from: running }
}

const loginUnit = async ({ home, env, platform, deps }) => {
  const arch = await (await import('../collector/daemon.mjs')).loadArch(platform)
  if (!arch || !arch.unit || !arch.unit.userUnit) return null
  return arch.unit.userUnit({ home, node: process.execPath, script: deps.script || process.argv[1], run: deps.exec || null, env })
}

/** Which code the collector runs, as it says on its control channel (D67⑤): null when none answers or it names none. The endpoint is
 *  resolved the one way every caller resolves it (the 2026-10-11 incident): nothing platform-specific here. */
export async function daemonCode({ platform, dir, env, fs, deps }) {
  if (deps.daemonCode) return await deps.daemonCode()
  const ep = controlEndpointFor({ platform, dir, env, fs })
  if (!ep.socketPath) return null
  try {
    const answer = await ep.request({ socketPath: ep.socketPath, method: 'GET', path: '/status', timeoutMs: 5000 })
    return (answer && typeof answer.code === 'string' && answer.code) || null
  } catch { return null }
}
