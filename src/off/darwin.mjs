// darwin.mjs (src/off) — what `asight off` and `asight uninstall` do on macOS that no other OS needs (RFC 4.9 §4 · §7; 1.6 R3, R7). It imports Node's own modules and files of src/off and
// nothing else: the standalone `asight-off` is made of the files of this directory alone, so it cannot reach the collector or the source tree (0.1 §2). Two things live here: the root
// refusal and the launchd undo.
//
// R7 on darwin (4.9 §7): asight never runs as root, so `on`, `daemon`, `off` and `uninstall` refuse to. `on` and `daemon` ask the arch module (arch/darwin/autostart.mjs `refuseElevated`);
// `off` and `uninstall` cannot reach it (the standalone has no source tree), and on darwin they need no tool for it either: the uid is this process's own, read in-process — where Windows
// has to ask `whoami /groups` (src/off/win32.mjs), darwin asks nobody.
//
// The undo (`undoAutostart`) is the standalone copy of the arch module's disable / remove, the way src/off/autostart.mjs is the linux unit's (1.6 R3; the win32 side's `undoWin32` is still
// a plan). launchd's agent is booted out FIRST — KeepAlive would pull a stopped daemon right back, so the autostart goes before the daemon process is stopped (the off order, 4.9 §4) —
// then the plist leaves ~/Library/LaunchAgents: launchd scans that directory at every login, and a file left there brings the agent back at the next one, which would undo the off (D39).
// The label and the plist path are written here too (src/off imports nothing outside itself), and test/collector/arch/darwin/autostart.test.mjs holds them equal to the arch module's and
// the undo's launchctl calls equal to userUnit.disable's and remove's, in the same order. launchctl runs through execTool, so a test injects the runner.
import nodeFs from 'node:fs'
import path from 'node:path'
import { execTool } from './exec.mjs'

export const AGENT_LABEL = 'com.asight.collector' // the launchd job's label (the arch module's own copy is held equal by test)
export const PLIST_FILE_NAME = 'com.asight.collector.plist'
/** ~/Library/LaunchAgents/com.asight.collector.plist — launchd scans this directory at every login, so the file IS the registration. */
export const plistFilePath = (home) => path.join(home, 'Library', 'LaunchAgents', PLIST_FILE_NAME)

const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1) // -1: a platform without getuid (a test on Windows) — never 0, so never a refusal

/** → null (go on) or `{ code: 'root-token', reason }` — the same refusal the arch module's `refuseElevated` gives `on` and `daemon` (R7, 4.9 §7 · §12). The uid is this process's own, so
 *  there is no unreadable case: an undo that stopped on a uid it could not read is not an undo (the reason there is no `whoami`-style unknown here, as there is on Windows). */
export function refuseElevatedByUid({ getuid = processUid, geteuid = processUid } = {}) {
  const uid = getuid()
  const euid = geteuid()
  if (uid !== 0 && euid !== 0) return null
  return { code: 'root-token', reason: 'run this as your own user, not as root' }
}

/** Is the agent loaded in this user's session? The arch module's rule (never a localised error text): `launchctl print gui/<uid>/<label>` — exit 0 = there, any other exit = not there,
 *  a print that did not run at all (code null) is NOT "not there": nothing was asked of launchd, and an undo that took it for gone would report success while the agent stays loaded.
 *  Exported for the off orchestration's own questions (daemon-stop.mjs's stop, orchestrate.mjs's unitIsUp — the flip checklist ①, 4.9 §4): the same three answers, one rule. */
export function agentState({ exec, env, uid }) {
  const r = launchctl(['print', `gui/${uid}/${AGENT_LABEL}`], { run: exec, env })
  if (r.code === 0) return { state: 'present' }
  if (r.code === null) return { state: 'unknown', err: `launchctl print did not run (${r.err || 'no reason given'})` }
  return { state: 'absent' }
}

/** `launchctl <args>`, with the ONE argument-shape rule this macOS forces (measured on macOS 26.6.2 arm64, 2026-10-11,
 *  measured against a plain dummy KeepAlive agent too): `bootout gui/<uid> <label>` — the domain and the label as two
 *  arguments — answers `Boot-out failed: 5: Input/output error` and leaves the job loaded, while the slash form
 *  `bootout gui/<uid>/<label>` takes it out; `print` behaves either way. So every target here is the slash form, and an
 *  `asight off` that quietly left the daemon to KeepAlive (exit 0, a fresh pid seconds later) is what this rule ends. */
export const launchctl = (args, { run, env } = {}) => execTool('launchctl', args, { run, env })

// the two parts of an undo as one answer; a tool that did not run (code null) is code 1, a failure that a caller's `if (r.code)` sees (the same rule as the arch module's)
const settle = (agent, plist) => ({ code: (agent.code !== 0 ? agent.code : plist.code) ?? 1, out: [agent.out, plist.out].filter(Boolean).join('\n'), err: [agent.err, plist.err].filter(Boolean).join('; '), agent: agent.state, plist: plist.state })

/** No autostart any more: `launchctl bootout gui/<uid> com.asight.collector` — FIRST (4.9 §4: the autostart off the hook before the daemon is stopped, so KeepAlive does not pull it
 *  back; the caller stops the daemon process after this returns, never before) — and then the plist out of ~/Library/LaunchAgents (launchd scans that directory at every login: a file
 *  left there brings the agent back at the next one). An agent that is not there is already as asked, not an error; a print that did not run is a failure (`agent: 'failed'`, code 1) and
 *  nothing is booted out on a guess — the plist is a separate part of the undo and still goes (its removal is safe whatever launchd answered: it only prevents the next login's load).
 *  → `{ code, out, err, agent: 'booted-out' | 'absent' | 'failed', plist: 'removed' | 'absent' | 'failed' }` — the same shape, calls and answers as the arch module's disable / remove. */
export function undoAutostart({ home, exec = null, env = process.env, fs = nodeFs, uid = null } = {}) {
  const tools = { exec, env, uid: uid ?? processUid() }
  const file = plistFilePath(home)
  // No retry: the original failure this undo could not survive was NOT launchd flakiness but the directly-spawned-bootout
  // I/O error (see `launchctl` above) — the sh route fixes it at the source, and a same-calls-every-time undo is what the
  // standalone/arch equality test holds (a retry loop made the two sequences diverge for no remaining reason).
  const q = agentState(tools)
  const a = q.state === 'present' ? (() => { const r = launchctl(['bootout', `gui/${tools.uid}/${AGENT_LABEL}`], { run: exec, env }); return { ...r, state: r.code === 0 ? 'booted-out' : 'failed' } })()
    : q.state === 'absent' ? { code: 0, out: '', err: '', state: 'absent' }
    : { code: 1, out: '', err: q.err, state: 'failed' } // not known to be gone: a failure, and nothing is changed on a guess
  let p
  try {
    if (!fs.existsSync(file)) p = { code: 0, out: '', err: '', state: 'absent' }
    else { fs.rmSync(file, { force: true }); p = { code: 0, out: '', err: '', state: 'removed' } }
  } catch (e) { p = { code: 1, out: '', err: `the plist ${file} could not be removed (${(e && e.code) || (e && e.message) || e})`, state: 'failed' } }
  return settle(a, p)
}
