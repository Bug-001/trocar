// orchestrate.mjs (src/off) — `asight off`, from the first line to the receipt (RFC 1.6 §1.4, §1.5, R3, R12, 「asight 自己坏了时」; 4.6 §开关语义,
// §撤销顺序). Nothing here needs the daemon, the repository or node_modules: the standalone `~/.asight/bin/asight-off` runs this same code (R3).
//   1  the op lock, with off priority: when it is held, `desired:'off'` is written for these harnesses BEFORE the wait, so a mid-way `on` stops (R12)
//   2  `state.json`: desired off for the harnesses asked for, atomically; it is not rewritten when they are all off already (a second off changes nothing)
//   3  the routing is taken off and CONFIRMED, before one entry is touched (an agent whose bundle lost the CA while its connection was still steered
//      would be refused, §1.5): a daemon that answers is told `POST /off` and its reply is the confirmation; a stuck or starting one is stopped first (step
//      5 of §1.4) and the helper is checked gone; an absent one needs its helper gone. Unconfirmed → the entries are left alone, exit 1 — except a daemon
//      that cannot be stopped: its entries are undone all the same (the new connections are direct by its stale heartbeat), exit 1, the pid is given
//   4  the entries: by the manifest (undoHarnesses), or, with no readable manifest, by asight's own marks (planByMarker) after a yes (R3);
//      5.1's held requests through `deps.releaseHeld` (5.1 is not built: a seam)
//   5  with no names: the autostart is disabled and the daemon was asked to exit once drained — systemd's disable on Linux (src/off/autostart.mjs), the LaunchAgent's undo on
//      darwin (src/off/darwin.mjs disableAgent: launchctl disable, never a bootout of a draining daemon), nothing on win32 (the task and Run value are manifest entries)
//   6  the receipt (R1) and the `off-note` lines of `flows/`, the last of them `kind:'result'`; exit 0 only when the routing is confirmed off and every
//      entry is undone (connections that are still draining do not count against it)
// Everything the world gives is a `deps` entry a test replaces (0.1 §3): `fs` `exec` `request` `socketPath` `alive` `identity` `kill` `isHelper` `sleep` `ms`
// `now` `procs` `roots` `tls` (the getCACertificates the OS-roots reader asks, os-roots.mjs) `daemonState` `stopDaemon` `lockWaitMs` `releaseHeld`. Imports only node:* and src/off.
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import nodeTls from 'node:tls'
import path from 'node:path'
import { newReceipt, EXIT } from './schema.mjs'
import { collectorDir, stateFile, opLockFile } from './paths.mjs'
import { readStateFile, setDesired, writeStateAtomic, emptyState } from './state.mjs'
import { acquireOpLock, LOCK_BUSY } from './lock.mjs'
import { readManifest, refuseOldManifest, unknownItems, undoByHand, MANIFEST_VERSION, OFF_VERSION } from './manifest.mjs'
import { undoHarnesses, undoRootKeys } from './undo.mjs'
import { planByMarker, undoByMarker } from './marker.mjs'
import { daemonState, stopDaemon, helperGone, isRedirectorHelper, clearStaleSupervisorLock } from './daemon-stop.mjs'
import { controlRequest, controlEndpointFor } from './control-client.mjs'
import { disableAutostart, unitFilePath, UNIT_FILE_NAME } from './autostart.mjs'
import { plistFilePath, AGENT_LABEL, agentState, disableAgent } from './darwin.mjs'
import { execTool } from './exec.mjs'
import { listProcs, identityFor, pidAlive } from './proc.mjs'
import { refuseElevatedByWhoami, disableScheduledTask } from './win32.mjs'
import { rootStore } from './root-store.mjs'
import { runEventWriter } from './events.mjs'
import { confirm } from './io.mjs'
import { describeEntry } from './journal.mjs'
import { orphanBackups } from './backup.mjs'
import { osRootsFor } from './os-roots.mjs'
import { WHERE_OFF, EVENT_OFF_NOTE, CODE_OFF } from './names.mjs'

export const OFF_LOCK_WAIT_MS = 10_000 // 1.6 R12: the lock is waited for at most this long
const OFF_ASK_MS = 5000 // a daemon that does not answer this fast is stuck (1.6 §1.4 第 2 步)
const errMessage = (e) => String((e && e.message) || e)

/** The world one run of `off` / `uninstall` sees, every part of it replaceable by `deps`. */
export function offWorld({ home = nodeOs.homedir(), env = process.env, deps = {} } = {}) {
  const dir = collectorDir(home)
  const platform = deps.platform || process.platform
  // The daemon's endpoint, resolved the one way every caller resolves it (controlEndpointFor): Windows finds it in <collector>\control.json —
  // the pipe name AND the token every request must carry (4.8 §7 控制面); darwin's daemon writes the same control.json (a random socket under
  // $TMPDIR plus the token, 4.9 §7); Linux keeps the $XDG_RUNTIME_DIR unix socket, which the file modes keep to the operator. An off on
  // win32/darwin with no control.json (or one that names no endpoint) has no socket path of its own: daemonState still asks the one the
  // daemon's lock names, unauthenticated — a POST /off that 401s is then the control-error the receipt shows, not a silent miss.
  const endpoint = deps.socketPath === undefined ? controlEndpointFor({ platform, dir, env, fs: deps.fs || nodeFs }) : null
  const w = {
    home, env, dir, fs: deps.fs || nodeFs, exec: deps.exec || null, platform,
    request: deps.request || (endpoint && endpoint.request) || controlRequest,
    clock: deps.now || (() => new Date()), ms: deps.ms || Date.now, sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    alive: deps.alive || pidAlive, identity: deps.identity || identityFor({ platform, exec: deps.exec || null, env }), isHelper: deps.isHelper || isRedirectorHelper, kill: deps.kill,
    lockFile: path.join(dir, 'lock'), stateF: stateFile(home), deps, standalone: deps.standalone === true, // the single-file asight-off passes `standalone`: it words what it cannot do as "run asight off" (R3, V35)
    socketPath: deps.socketPath !== undefined ? deps.socketPath : (endpoint && endpoint.socketPath) || null,
  }
  const once = (fn) => { let p; return () => p || (p = Promise.resolve().then(fn)) } // the process table is read once per run
  w.procs = once(deps.procs || (() => listProcs({ exec: w.exec, platform, env })))
  w.daemonState = deps.daemonState || (() => daemonState({ lockFile: w.lockFile, socketPath: w.socketPath, request: w.request, identity: w.identity, alive: w.alive, now: w.ms, fs: w.fs, timeoutMs: OFF_ASK_MS, platform }))
  w.stopDaemon = deps.stopDaemon || ((o = {}) => stopDaemon({ lockFile: w.lockFile, socketPath: w.socketPath, exec: w.exec, kill: w.kill, alive: w.alive, identity: w.identity, isHelper: w.isHelper, sleep: w.sleep, now: w.ms, fs: w.fs, env, platform, ...o }))
  // The autostart the off-side knows: Linux's systemd unit, or darwin's LaunchAgent plist (4.9 §4; the flip checklist ① — before it, step 5 asked systemd
  // on darwin unconditionally). win32 has none to ask about: its task and Run value are manifest entries, undone with the rest (4.8 §4.2).
  w.unitManaged = () => w.fs.existsSync(platform === 'darwin' ? plistFilePath(home) : unitFilePath(home))
  return w
}

/** What the user does when a daemon that answers cannot be made to confirm that its routing is off (1.6 §1.5 「确认不了就不撤」 leaves the entries alone, so the way out is said, audit semantics 5):
 *  stopping the daemon takes its helper and the links with it, and then the command is run again. On darwin the agent is booted out first — a daemon stopped under a loaded LaunchAgent is pulled right back by KeepAlive (4.9 §4). */
const wayOut = (w, pid) => w.unitManaged()
  ? (w.platform === 'darwin' ? `To go on, stop the autostart (launchctl bootout gui/${typeof process.getuid === 'function' ? process.getuid() : -1}/${AGENT_LABEL}), so the daemon is not started again, then run the command again` : `To go on, stop the daemon (systemctl --user stop asight-collector.service), which takes its links off with it, then run the command again`)
  : `To go on, stop the daemon (${Number.isInteger(pid) ? `kill ${pid}` : "no pid is on record: find it with pgrep -f 'asight.* (daemon|collector start)'"}), which takes its links off with it, then run the command again`

/** Is the autostart going to bring the daemon back the moment it is stopped — systemd's Restart=on-failure mid-wait, or launchd's KeepAlive with the agent still loaded (4.9 §4)? A tool that cannot be asked says no: the lock decides. */
const unitIsUp = (w) => {
  if (w.platform === 'darwin') {
    const q = agentState({ exec: w.exec, env: w.env, uid: typeof process.getuid === 'function' ? process.getuid() : -1 })
    return q.state === 'present'
  }
  const a = execTool('systemctl', ['--user', 'is-active', UNIT_FILE_NAME], { run: w.exec, env: w.env })
  return a.out === 'active' || a.out === 'activating' || a.out === 'reloading'
}

/** The harness ids a manifest names (entries and files). */
export const harnessIdsOf = (m) => [...new Set([...((m && m.entries) || []), ...((m && m.files) || [])].map((x) => x.harness).filter((h) => typeof h === 'string'))]

/** Step 2: `desired:'off'` for `ids` (null: every harness the state file or the manifest names). Writes only what is on; a file that cannot be read is replaced
 *  by one with everything off (the daemon reads such a file as all off already, 1.6 §1.5). → `{ wrote, ids, unreadable? }`; a failed write throws. */
export function desiredOff(w, ids, installed) {
  let read
  try { read = readStateFile(w.stateF, { fs: w.fs, installed, now: w.clock() }) } catch (e) { read = { error: e } }
  if (read.error) {
    const target = ids || installed
    writeStateAtomic(w.stateF, setDesired(emptyState(), target, 'off', w.clock()), { fs: w.fs })
    return { wrote: true, ids: target, unreadable: errMessage(read.error) }
  }
  const target = ids || [...new Set([...Object.keys(read.state.harnesses), ...installed])]
  const flips = target.filter((id) => read.state.harnesses[id] && read.state.harnesses[id].desired === 'on')
  if (!flips.length) return { wrote: false, ids: target }
  writeStateAtomic(w.stateF, setDesired(read.state, flips, 'off', w.clock()), { fs: w.fs })
  return { wrote: true, ids: flips }
}

const counts = (r) => (r && ['closing', 'waiting', 'cut'].every((k) => Number.isInteger(r[k]) && r[k] >= 0) ? { closing: r.closing, waiting: r.waiting, cut: r.cut } : null)

/** Step 3: take the routing off and confirm it (see the header). `exit`: the whole daemon is to go once drained (no names). → `{ confirmed, unstoppable, state,
 *  how, socket (the control socket a daemon was found on, or the one that was to be asked), daemon: {pid, state}, relayed, relayed_reason?, stop?, problems: [],
 *  notes: [], failures: [{code, reason}], events: [{kind, reason, …}] }`. */
export async function switchRoutingOff(w, { ids = null, now = false, exit = false } = {}) {
  const r = { confirmed: false, unstoppable: false, state: null, how: null, socket: null, daemon: { pid: null, state: 'none' }, relayed: 'unknown', problems: [], notes: [], failures: [], events: [] }
  const st = await w.daemonState()
  r.state = st.state
  r.socket = st.socket || w.socketPath || null // the one a daemon was found on (the lock names it when XDG_RUNTIME_DIR is unset): the caller asks the same one again
  const lock = st.lock || null
  const fail = (code, reason) => { r.problems.push(reason); r.failures.push({ code, reason }) }
  const stopIt = async (why) => {
    const s = await w.stopDaemon({ unitManaged: w.unitManaged() })
    r.stop = s; r.how = s.how
    r.events.push({ kind: 'daemon-stop', how: s.how, signals: s.signals, stopped: s.stopped, pid: s.pid, reason: `the daemon ${why}; ${s.stopped ? `stopped (${s.signals.join(', ') || 'nothing to signal'})` : `NOT stopped${s.error ? `: ${s.error}` : ''}`}` })
    if (s.stopped) {
      r.confirmed = true; r.daemon = { pid: s.pid, state: 'stopped' }
      r.relayed = 'unknown'; r.relayed_reason = `the daemon ${why}, so it could not say how many connections it relayed; it was stopped and they went with it`
    } else {
      r.unstoppable = true; r.daemon = { pid: s.pid, state: 'unresponsive' }; r.relayed_reason = 'the daemon does not answer'
      fail('stop-failed', `the daemon (pid ${s.pid}) ${why} and could not be stopped${s.error ? ` (${s.error})` : ''}; the entries are undone all the same, new connections are direct while its heartbeat is stale; stop it by hand: kill -9 ${s.pid}`)
    }
  }
  if (st.state === 'running') {
    try {
      const reply = await w.request({ socketPath: r.socket, method: 'POST', path: '/off', body: { ...(ids ? { harnesses: ids } : {}), ...(now ? { now: true } : {}), ...(exit ? { exit: true } : {}) }, timeoutMs: OFF_ASK_MS })
      r.relayed = counts(reply && reply.relayed) || 'unknown'
      if (r.relayed === 'unknown') r.relayed_reason = 'the daemon\'s reply did not carry the connection counts'
      r.daemon = { pid: Number.isInteger(reply && reply.pid) ? reply.pid : (lock && lock.pid) ?? null, state: exit ? 'draining' : 'running' }
      r.confirmed = exit ? reply.actual === 'off' && reply.confirmed !== false : reply.confirmed === true
      r.how = 'daemon-reply'
      if (!r.confirmed) fail('state-mismatch', `the daemon did not confirm that the kernel's watch table${exit ? ' and links' : ''} are off (actual: ${reply && reply.actual}, confirmed: ${reply && reply.confirmed}); the entries are left as they are. ${wayOut(w, r.daemon.pid)}`)
    } catch (e) {
      if (e && e.status) fail('control-error', `the daemon refused the off request (${errMessage(e)}); the entries are left as they are. ${wayOut(w, lock && lock.pid)}`)
      else await stopIt(`did not answer the off request (${errMessage(e)})`)
    }
  } else if (st.state === 'unresponsive' || st.state === 'starting') await stopIt(st.reason || 'does not answer')
  else if (st.state === 'none' || st.state === 'stale') {
    r.relayed = { closing: 0, waiting: 0, cut: 0 } // there is no engine: nothing is relayed
    if (st.state === 'stale' && !lock && st.reason) { r.notes.push(st.reason); r.events.push({ kind: 'note', reason: st.reason }) } // a lock cut short: said, not hidden
    const helperGoneNow = () => helperGone(lock, { alive: w.alive, isHelper: w.isHelper })
    for (const end = w.ms() + 2000; lock && !helperGoneNow() && w.ms() < end;) await w.sleep(25) // a helper that is only now noticing its daemon died
    if (lock && !helperGoneNow()) await stopIt('is not running, but its helper still is')
    else if (exit && w.unitManaged() && unitIsUp(w)) { // the autostart would bring a daemon back the moment this ends — systemd after RestartSec (Restart=on-failure), launchd at once (KeepAlive, the agent still loaded, 4.9 §4) — so it is stopped, as `uninstall` does (§1.4 第 5 步, audit semantics 4)
      const s = await w.stopDaemon({ unitManaged: true })
      r.stop = s; r.how = s.how
      r.events.push({ kind: 'daemon-stop', how: s.how, signals: s.signals, stopped: s.stopped, pid: s.pid, reason: `no daemon is running, but the autostart would bring one back (${w.platform === 'darwin' ? 'the LaunchAgent is loaded: launchd KeepAlive' : 'the unit is up or about to restart: systemd Restart=on-failure'}); ${s.stopped ? (w.platform === 'darwin' ? 'booted out (launchctl bootout)' : 'stopped (systemctl stop, reset-failed)') : `NOT stopped${s.error ? `: ${s.error}` : ''}`}` })
      if (s.stopped) { r.confirmed = true; r.daemon = { pid: null, state: 'none' } } // there was no engine: nothing was relayed, and what the stop did is on `stop`
      else { r.unstoppable = true; fail('stop-failed', w.platform === 'darwin' ? `the LaunchAgent could not be booted out${s.error ? ` (${s.error})` : ''}; the entries are undone all the same, but launchd may bring a daemon back with nothing attached; run: launchctl bootout gui/${typeof process.getuid === 'function' ? process.getuid() : -1}/${AGENT_LABEL}, then run asight off again` : `systemd keeps the autostart unit up or restarting${s.error ? ` (${s.error})` : ''}; the entries are undone all the same, but a daemon may come back with nothing attached; stop it: systemctl --user stop asight-collector.service, then run asight off again`) }
    } else { r.confirmed = true; r.how = 'no-daemon'; r.daemon = { pid: null, state: 'none' } }
  } else fail('control-error', `${st.reason || 'whether a daemon runs is not known'}; the entries are left as they are. If no asight daemon runs (pgrep -f 'asight.* (daemon|collector start)' finds none), delete ${w.lockFile} and run asight off again; if one does, stop it by hand first`)
  return r
}

const USER_VERBS = { serve: 'a read-only dashboard, not on any agent path', capture: 'capturing in the foreground, it may be relaying agent traffic', mitm: 'capturing in the foreground, it may be relaying agent traffic' }
/** The asight processes the user started themselves (`asight serve`, a foreground `capture` / `mitm`): listed, never killed (1.6 §1.4). */
export function userProcessesOf(list, selfPid = process.pid) {
  const out = []
  for (const p of list || []) {
    const argv = Array.isArray(p.argv) ? p.argv : []
    const i = argv.findIndex((a) => /(^|\/)asight(\.mjs)?$/.test(String(a)))
    const verb = i >= 0 ? argv[i + 1] : null
    if (verb && Object.hasOwn(USER_VERBS, verb) && p.pid !== selfPid) out.push({ pid: p.pid, command: `asight ${verb}`, note: USER_VERBS[verb] })
  }
  return out
}

// What a row of the receipt says an entry lost (1.6 §7): the key, the block, the line.
function offChangeText(e, result) {
  if (!e) return "asight's lines removed"
  if (e.kind === 'text') return e.vars ? `asight's block removed (${Object.keys(e.vars).join(', ')})` : e.format === 'pem-block' ? "asight's certificate block removed" : `one line removed (${String(e.line).split(' # ')[0].trim()})`
  const keys = (e.keys || []).join('.')
  return e.prior_value != null && result !== 'left-user-value' ? `${keys} set back to your own value` : `${keys} removed`
}
const UNDO_NOTE = { // what each undo result other than a plain restore means for the user (4.6 撤销结果)
  'already-restored': 'already back as it was before install: nothing to undo',
  'reverted-not-identical': 'asight\'s key was removed, but the file is not byte for byte what it was before install (it was edited since)',
  missing: 'the file is gone: nothing of asight\'s is left in it',
  'left-user-value': 'the key now holds a value the user set: left as it is',
}
const UNTIL_REASON = { restart: 'until it restarts', 'next-connection': 'until its next new connection (it re-reads the bundle)', 'next-handshake': 'until its next TLS handshake (it re-reads the bundle)', 'session-end': 'until its current session ends' }
const MARKER_TEXT = { block: "asight's block removed", line: 'the line asight added removed', 'json-value': "asight's value removed (the old one taken from the copy of the file as it was)", 'owned-file': 'the file asight created deleted' }
const SKIP_REASON = { 'already-restored': 'already as it was before install', missing: 'the file is gone; nothing of asight is in it', 'left-user-value': 'this key now holds a value you set, so it was left as it is', 'already-removed': "asight's text is no longer in this file" }
const SKIP_CODE = { 'already-restored': 'already-restored', missing: 'missing', 'left-user-value': 'left-user-value' } // the results that are in the closed set of codes (src/health/codes.mjs)
const withHarness = (h) => (typeof h === 'string' ? { harness: h } : {})
// The roots a gone bundle is rebuilt from (4.6 撤销顺序 第 2 步): Node's and this platform's OS roots, read by the reader the collector composes the bundles with
// (os-roots.mjs osRootsFor — darwin: Node's set, the keychain's anchors and Apple's export, never /etc/ssl/cert.pem, 4.9 §6.2; win32: the system store, with no helper
// here, 4.8 §6.2; Linux: the first OS PEM bundle of the one list). undo.mjs asks only for a bundle it rebuilds, once. None read → `missing`, a source that could not be read →
// `partial`, certificates that do not parse → `dropped`: the rebuilt bundle's note says each (D38), in the shape of the collector's bundleRoots. The sandbox's refusal
// of a real tool (ESANDBOX) is a test's missing injection, not a missing root: it is thrown.
const rebuildRoots = async (w) => {
  const node = [...nodeTls.rootCertificates]
  let got
  try { got = await osRootsFor(w.platform)({ tls: w.deps.tls, exec: w.exec, read: (f) => w.fs.readFileSync(f, 'utf8') }) } catch (e) {
    if (e && e.code === 'ESANDBOX') throw e
    return { node, osText: '', missing: errMessage(e), dropped: 0, partial: null }
  }
  return { node, osText: got.pem || '', missing: got.missing || null, dropped: got.dropped || 0, partial: got.tried && got.tried.length ? got.tried.join('; ') : null }
}

/** Step 4: the entries, by the manifest or by asight's own marks. `dropCa`: only `uninstall` removes asight-ca.pem. → one object of what was undone and what was left
 *  (`changed`, `removed`, `skipped`, `left`, `kept_bundles`, `still_trusting`, `residue`, `kept_backups`, `dropped_backups`, `pending`, `orphan_backups`, `problems`,
 *  `notes`, `failures`, `events`, `stopped` (an error ended the undoing part-way; what it had done is in the other fields), `mode`: 'manifest' | 'marker' | 'none' |
 *  'unsupported'). */
export async function undoSide(w, opts = {}) {
  const u = { mode: 'none', install_items: [], changed: [], removed: [], skipped: [], left: [], kept_bundles: [], still_trusting: [], residue: [], kept_backups: [], dropped_backups: [], pending: [], planned: [], orphan_backups: [], problems: [], notes: [], failures: [], events: [], undone_by_marker: false, procs_error: null, stopped: false }
  try { return await undoBody(w, opts, u) } catch (e) { // whatever throws here (a manifest of a shape nobody foresaw, a file that vanishes) must not cost the receipt: the routing is already off and files may already be written (R1, R11)
    u.stopped = true
    if (u.raw && !u.changed.length && !u.removed.length) { // the files were written before it threw: the receipt lists them, as the plain undo would have
      for (const r of u.raw.results) if (r.result === 'restored' || r.result === 'reverted-not-identical') u.changed.push({ path: r.path, change: "asight's lines removed", backup: r.backup_kept || null, result: r.result, ...withHarness(r.harness) })
      u.removed.push(...u.raw.removed)
      if (!u.left.length) u.left = u.raw.left.map((l) => ({ path: l.path, result: l.result, reason: l.reason, ...withHarness(l.harness) }))
    }
    u.problems.push(`undoing the entries stopped: ${errMessage(e)}; what was done before it is listed here, the rest is as it was: run asight off again, or undo the rest by hand (the install manifest names each file)`)
    u.failures.push({ code: 'entry-not-undone', reason: `undoing the entries stopped: ${errMessage(e)}` })
    return u
  }
}

async function undoBody(w, { ids = null, manifest, manifestError = null, yes = false, interactive = false, io = null, say = null, dropCa = false, phases = undefined } = {}, u) {
  if (manifest && manifest.unsupported) {
    u.mode = 'unsupported'
    u.problems.push(w.standalone
      ? `the install manifest is version ${JSON.stringify(manifest.version)}, which this asight-off (version ${OFF_VERSION}, it reads manifest version ${MANIFEST_VERSION}) does not read; no entry was touched. Run \`asight off\`: the asight that wrote the manifest reads it`
      : `the install manifest is version ${JSON.stringify(manifest.version)}, which this build does not read; no entry was touched. Use the asight that wrote it (or the asight-off it wrote)`)
    return u
  }
  if (manifest) {
    u.mode = 'manifest'
    const at = w.clock()
    const label = (e) => { try { return `${e.harness}\0${e.path}\0${describeEntry(e)}` } catch { return `${e.harness}\0${e.path}` } }
    const before = new Map(manifest.entries.map((e) => [label(e), { ...e }]))
    let out, stopped = null
    try {
      const roots = w.deps.roots || (manifest.files.some((f) => f.role === 'bundle') ? () => rebuildRoots(w) : null)
      out = await undoHarnesses({ dir: w.dir, home: w.home, manifest, ids, procs: w.procs, roots, now: at, dropCa, phases, fs: w.fs, exec: w.exec, env: w.env })
    } catch (e) {
      if (!e || !e.partial) { // it stopped before one entry was touched
        u.stopped = true; u.problems.push(`undoing the entries stopped: ${errMessage(e)}`); u.failures.push({ code: 'entry-not-undone', reason: errMessage(e) })
        return u
      }
      out = e.partial; stopped = e // it stopped after the files were changed (the last write of the manifest): what it did is in the receipt all the same, below
    }
    const note = (code, extra, reason) => u.events.push({ kind: code, code, ...extra, reason }) // `kind` = `code`: one line per thing the operator should know (4.6 安装 / 卸载不静默)
    u.raw = out // what the undo did, for a receipt if what follows throws (undoSide)
    u.results = out.results
    u.install_items = out.install_items || []
    u.notes.push(...(out.notes || [])) // the undo's own notes (e.g. a kernel copy kept while it drains)
    for (const r of out.results) {
      const e = before.get(`${r.harness}\0${r.path}\0${r.what}`)
      if (r.backup && !r.backup_kept) u.dropped_backups.push(r.backup)
      if (r.result === 'restored' || r.result === 'reverted-not-identical') {
        const gone = !w.fs.existsSync(r.real_path || r.path)
        if (gone) u.removed.push(r.path)
        else u.changed.push({ path: r.path, change: offChangeText(e, r.result), backup: r.backup_kept || null, result: r.result, ...(r.backup && !r.backup_kept ? { backup_dropped: true } : {}), ...(r.result === 'reverted-not-identical' ? { not_identical: true } : {}), ...(r.prior_left ? { prior_left: r.prior_left } : {}), ...withHarness(r.harness) })
      } else if (SKIP_REASON[r.result]) u.skipped.push({ what: r.path, reason: SKIP_REASON[r.result] })
      if (r.result === 'reverted-not-identical') note('reverted-not-identical', { ...withHarness(r.harness), path: r.path }, `${r.path} was edited after install: only asight's ${r.what} was taken out${r.deleted ? ' and the file, holding nothing else, removed' : ''}; the file is not byte for byte what it was before install, the rest is as the user left it${r.backup_kept ? `; the file as it was is kept at ${r.backup_kept}` : ''}`)
      else if (!['restored', 'left-unparsable', 'left-unreadable', 'left-link', 'left-text', 'error'].includes(r.result)) note(SKIP_CODE[r.result] || 'harness-note', { ...withHarness(r.harness), path: r.path }, UNDO_NOTE[r.result] || r.result)
    }
    u.removed.push(...out.removed)
    // an item whose kind this build does not know is left alone; the copy says who knows it (R3, V35)
    const hint = w.standalone ? ` — this asight-off (version ${OFF_VERSION}) does not know that kind; run \`asight off\`, the asight that wrote the manifest, to take it out` : ''
    u.left = out.left.map((l) => ({ path: l.path, result: l.result, reason: l.result === 'unknown-kind' ? `${l.reason}${hint}` : l.reason, ...(l.backup ? { backup: l.backup, restore: l.restore } : {}), ...withHarness(l.harness) }))
    for (const l of u.left) u.failures.push({ code: ['error', 'unknown-kind', 'left-text', 'left-unreadable'].includes(l.result) ? 'entry-not-undone' : l.result, ...withHarness(l.harness), path: l.path, reason: l.reason })
    u.kept_bundles = out.kept_bundles
    for (const k of out.kept_bundles.filter((x) => !x.holds_ca && !x.unjudged && !x.error)) {
      const entry = k.entry_left ? `${k.entry_left.join(', ')}, which could not be undone, still points at it` : null // an agent's next start reads the bundle through it
      const again = `run it again once ${k.pids.length ? 'they exit' : 'that is fixed'}`
      note(k.rebuilt ? 'harness-note' : 'bundle-kept', { harness: k.harness, path: k.path }, k.rebuilt
        ? `${k.path} was gone while ${[...(k.pids.length ? [`a running process may use it (pid ${k.pids.join(', ')})`] : []), ...(entry ? [entry] : [])].join(' and ')}; it was rebuilt without the asight CA${k.lost_fps ? `, but without ${k.lost_fps.length} user CA(s) its source files no longer hold` : ''}${k.os_roots_missing ? `, with Node's roots only (${k.os_roots_missing})` : ''}${k.os_roots_partial ? `, with the OS roots short of what could not be read (${k.os_roots_partial})` : ''}${k.os_roots_dropped ? `, without ${k.os_roots_dropped} OS root certificate(s) that do not parse` : ''}; ${again}`
        : `${k.path} is kept, without the asight CA, ${[...(k.pids.length ? [`for running processes that may have loaded it (pid ${k.pids.join(', ')})`] : []), ...(entry ? [`because ${entry}`] : [])].join(' and ')}; ${again}`)
    }
    for (const c of out.changed) { note('harness-note', { harness: c.harness, path: c.path }, `${c.path}, asight's ${c.role}, had been changed since install; it was removed all the same`); u.notes.push(`${c.path}, asight's ${c.role}, had been changed since asight wrote it; it was removed all the same`) }
    u.residue = out.residue
    for (const x of out.residue) note('residue-not-removed', { harness: x.harness, path: x.path }, `${x.path} appeared after install (${x.why}); it may serve the user's own plugins too, so asight did not remove it`)
    u.still_trusting = out.still_trusting
    u.holders = out.holders // P12: who may still use a door (null: the table could not be read)
    for (const p of out.still_trusting) note('still-trusting', { harness: p.harness, pid: p.pid }, `pid ${p.pid} (${p.harness}) trusts the asight CA ${UNTIL_REASON[p.until] || UNTIL_REASON.restart}`)
    if (out.procs_error) { note('harness-note', {}, `which agents still trust the asight CA is not known: the process table could not be read (${out.procs_error})`); u.notes.push(`which agents still trust the asight CA is not known: the process table could not be read (${out.procs_error})`) }
    for (const x of out.trust_unknown || []) { const why = `which running ${x.harness} processes still trust the asight CA is not known: ${x.why}`; note('harness-note', { harness: x.harness }, why); u.notes.push(why) }
    u.procs_error = out.procs_error
    u.kept_backups = (manifest.kept_backups || []).map((k) => ({ ...k }))
    for (const k of u.kept_backups.filter((x) => x.at === at.toISOString())) note(CODE_OFF.backupKept, { path: k.path, backup: k.backup }, `${k.path}: ${k.reason}`)
    u.orphan_backups = orphanBackups({ home: w.home, manifest, fs: w.fs })
    if (u.orphan_backups.length) u.notes.push(`backups that no manifest entry names (leave them, or delete them if you do not need them): ${u.orphan_backups.join(', ')}`)
    // the root in the user's OS store (D55, 4.11 P3): only a whole-machine uninstall takes it out, by its fingerprint — `off` never touches a
    // certificate (1.6 §1.1). It goes before the root's key below (4.11 卸载「最后删根的密钥」); one that could not be removed is a left item (D38)
    const roots = dropCa && ids == null ? manifest.entries.filter((e) => e && e.kind === 'system-root') : []
    if (roots.length) {
      const store = w.deps.rootStore || rootStore({ platform: w.platform, run: w.exec, home: w.home, env: w.env, fs: w.fs })
      for (const e of roots) {
        const id = { fp256: e.fp256, sha1: e.thumbprint }
        let r
        try { r = await store.remove(id) } catch (err) { r = { ok: false, reason: String((err && err.message) || err) } }
        // a removal that reports success is confirmed against the store: removing a root asks the operator, and a prompt that is never
        // answered (or is declined) can still leave the tool exiting 0 — the certificate would stay trusted with nothing said (a Windows test machine
        // 2026-10-18). A store that cannot be read afterwards is not "removed" either (D38).
        let unconfirmed = null
        if (r.ok && !r.absent) {
          let h
          try { h = await store.has(id) } catch (err) { h = { error: String((err && err.message) || err) } }
          if (h && h.error) unconfirmed = `whether it is still in your trust store could not be read (${h.error})`
          else if (h && h.present) unconfirmed = 'it is still in your trust store: removing a root asks you first, and that question was not answered with yes'
        }
        if (r.ok && r.absent) u.skipped.push({ what: e.path, reason: "asight's root certificate is no longer in your trust store" })
        else if (r.ok && !unconfirmed) u.changed.push({ path: e.path, change: "asight's root certificate removed from your trust store", result: 'restored' })
        else {
          const why = unconfirmed || r.reason
          const byHand = undoByHand(e)
          const reason = `asight's root certificate was NOT taken out of your trust store: ${why}. By hand: ${byHand}`
          u.left.push({ path: e.path, result: 'failed', reason })
          u.still_trusting.push({ what: 'root', store: e.store ?? null, fp256: e.fp256 ?? null, reason: why, command: byHand })
          u.problems.push(`${reason} Your machine still trusts asight's certificate; the install record is kept, so \`asight uninstall\` tries again`)
          u.failures.push({ code: CODE_OFF.rootNotRemoved, path: e.path, reason }) // its one D38 line; a `note` here would write a second
        }
      }
    }
    if (dropCa && ids == null && !stopped) { // last: the root's key, after the trust store's root above (4.11 卸载「最后删根的密钥」)
      const k = await undoRootKeys({ dir: w.dir, manifest, custody: w.deps.custody || null, fs: w.fs })
      u.removed.push(...k.removed)
      for (const l of k.left) { u.left.push({ path: l.path, result: l.result, reason: l.reason }); u.failures.push({ code: 'entry-not-undone', path: l.path, reason: l.reason }) }
    }
    if (stopped) {
      u.stopped = true
      u.problems.push(`undoing the entries stopped: ${errMessage(stopped)}; what it did before is listed above, but the install manifest on disk still names those entries: run it again (an entry that is back as it was reads as already restored)`)
      u.failures.push({ code: 'entry-not-undone', reason: `the install manifest could not be saved after the entries were undone: ${errMessage(stopped)}` })
    }
    return u
  }
  // no manifest (or one that cannot be read): asight's own marks, listed first and undone only after a yes (R3)
  if (manifestError) u.notes.push(`the install manifest cannot be read (${errMessage(manifestError)}); asight's own marks are used instead`)
  const plan = planByMarker({ home: w.home, ids, fs: w.fs })
  u.orphan_backups = orphanBackups({ home: w.home, manifest: null, fs: w.fs })
  if (!plan.length) { u.mode = manifestError ? 'marker' : 'none'; return u }
  u.mode = 'marker'
  const items = plan.map((p) => ({ path: p.path, how: p.how, change: MARKER_TEXT[p.how], ...withHarness(p.harness) }))
  const listing = ["There is no install record to go by. By asight's own marks, these would be undone:", ...plan.map((p) => `  ${p.harness}  ${p.path}`), ...[...new Set(plan.map((p) => `    ${MARKER_TEXT[p.how]}`))]].join('\n')
  let go = yes
  if (!go && interactive && io) { (say || io.out)(listing); go = await confirm(io, 'Proceed?') }
  if (!go) {
    u.pending = items
    u.planned = items // 附录 C.2: what a run that stopped before writing WOULD do — the key install / on / uninstall put it under too, and the only answer `--json` has (no question is asked there)
    u.problems.push(`asight's own record of what it wrote ${manifestError ? 'cannot be read' : 'is missing'}, so the ${items.length} file${items.length === 1 ? '' : 's'} above ${items.length === 1 ? 'was' : 'were'} left as ${items.length === 1 ? 'it is' : 'they are'}.`, `Undo ${items.length === 1 ? 'it' : 'them'} by the marks asight left in ${items.length === 1 ? 'it' : 'them'}: asight off --yes`)
    return u
  }
  for (const r of undoByMarker(plan, { home: w.home, fs: w.fs })) {
    if (r.result === CODE_OFF.undoneByMarker) {
      u.undone_by_marker = true
      if (r.how === 'owned-file') u.removed.push(r.path)
      else u.changed.push({ path: r.path, change: MARKER_TEXT[r.how], backup: r.restored_from || r.backup || null, result: r.result, ...(r.prior_left ? { prior_left: r.prior_left } : {}), ...withHarness(r.harness) })
      u.events.push({ kind: CODE_OFF.undoneByMarker, code: CODE_OFF.undoneByMarker, ...withHarness(r.harness), path: r.path, reason: `${r.path}: ${MARKER_TEXT[r.how]} (found by asight's mark; there is no manifest to say what it was before)` })
    } else if (r.result === 'already-clean') u.skipped.push({ what: r.path, reason: "asight's mark is no longer in this file" })
    else { u.left.push({ path: r.path, result: r.result, reason: r.reason || `${r.path}: ${r.result}`, ...withHarness(r.harness) }); u.failures.push({ code: r.result === 'left-unparsable' ? 'left-unparsable' : 'entry-not-undone', ...withHarness(r.harness), path: r.path, reason: r.reason || `${r.path}: asight cannot read it; asight's value may still be in it` }) }
  }
  if (u.orphan_backups.length) u.notes.push(`the backups of the files above (JSON values taken back from them), and any others, are left in place: ${u.orphan_backups.join(', ')}`)
  return u
}

/** The writer of a run's `flows/` lines: `put(rec)` appends `{ts, event, where, run, …rec}` (a rec may bring its own `event`, e.g. 'failure'); a line that cannot be
 *  written is added to `notes`, never dropped and never fatal (D38); nothing is written when there is no collector directory (nothing installed: the command's own
 *  output is the only report). `event` / `where` default to `off`'s names; `uninstall` passes its own. */
export function flowWriter(w, run, notes, { event = EVENT_OFF_NOTE, where = WHERE_OFF } = {}) {
  const write = runEventWriter({ dir: w.dir, base: { event, where, run }, notes, now: w.clock, fs: w.fs, ...(w.deps.log ? { log: w.deps.log } : {}) }) // stderr first, then a `log-gap` once a line can be written again (R11)
  return (rec) => {
    if (!w.fs.existsSync(w.dir)) return
    write(rec)
  }
}

// a manifest holding an item of a kind this build does not know was written by a newer asight. Undoing the rest would turn the routing off and stop
// the daemon while that item stays, half an off: the whole off is refused instead, before the desired state and the routing (step 2 / 3) — the receipt
// names each such item and kind and says which asight-off undoes it. → true when it refused (receipt filled), false otherwise.
function refuseUnknownKinds(manifest, receipt, standalone) {
  const unknown = manifest && !manifest.unsupported ? unknownItems(manifest) : []
  if (!unknown.length) return false
  const kinds = [...new Set(unknown.map((u) => JSON.stringify(u.kind)))].join(', ')
  // the copy sends the person to `asight off` (the asight that wrote the manifest); `asight off` itself cannot send anyone to itself (V35)
  const who = standalone ? 'run `asight off`, from the asight that wrote it' : 'use the asight-off of the newer asight that wrote it'
  receipt.left.push(...unknown.map((u) => ({ path: u.path ?? null, result: 'unknown-kind', reason: `an item of kind ${JSON.stringify(u.kind)}, which this asight-off does not know: ${who}` })))
  receipt.problems.push(`the install manifest holds ${unknown.length} item(s) of a kind this asight-off (version ${OFF_VERSION}) does not know (${kinds}): a newer asight wrote it, and only a newer asight-off can undo it — ${who}. Nothing was changed: the routing is as it was, the daemon was not asked to stop`)
  receipt.ok = false
  receipt.log = null
  return true
}

// The receipt's own shape, the one appendix C.2 of 1.6 names, written once for every way off can end: `harnesses` becomes one object per harness (what was undone
// for it, what was left and why, the backups kept), `outcome` says `done` or `partial`, and every left item says what it is and how to undo it by hand.
// The id list the text and the flows record go by is `receipt.harnesses` until this runs, so it is called at the return.
function shapeReceipt(receipt) {
  const ids = (receipt.harnesses || []).map((h) => (typeof h === 'string' ? h : h && h.harness)).filter(Boolean)
  receipt.left = (receipt.left || []).map((l) => ({ what: l.what ?? (l.result === 'unknown-kind' ? 'an item this asight does not know' : 'something asight wrote'), ...l, undo_by_hand: l.undo_by_hand ?? l.restore ?? null }))
  receipt.outcome = receipt.ok ? 'done' : 'partial'
  receipt.harnesses = ids.map((id) => {
    const left = (receipt.left || []).filter((l) => l.harness === id)
    const undone = [...new Set([...(receipt.changed || []), ...(receipt.removed || [])].filter((x) => x && typeof x === 'object' && x.harness === id).map((x) => x.path))]
    return { harness: id, ok: left.length === 0, reason: left.length ? left[0].reason || null : null, undone, kept_backups: (receipt.kept_backups || []).filter((k) => k.harness === id) }
  })
  return receipt
}

/** `asight off [harness…]` (1.6 §1.1, §1.4, §1.5): see the header. `ids`: harness code ids, or null for every one; `now`: cut the connections still relayed (`--now`);
 *  `yes` / `interactive` / `io`: the one confirmation, for undoing by marks when the manifest is lost (R6); `say`: where the list goes before the question.
 *  → `{ receipt, exit }`; the receipt is src/off/schema.mjs's plus `harnesses` · `routing` · `daemon` · `autostart` · `still_trusting` · `kept_backups` · `kept_bundles` ·
 *  `user_processes` · `left` · `problems` · `notes`. */
export async function runOff({ home = nodeOs.homedir(), env = process.env, ids = null, now = false, yes = false, dryRun = false, interactive = false, io = null, say = null, deps = {} } = {}) {
  const w = offWorld({ home, env, deps })
  const run = w.clock().toISOString()
  const receipt = { ...newReceipt('off'), harnesses: ids || [], all: ids === null, now, undo: ['asight on'], log: path.join(w.dir, 'flows'), left: [], kept_bundles: [], still_trusting: [], residue: [], kept_backups: [], orphan_backups: [], pending: [], planned: [], user_processes: [], notes: [], problems: [] }
  const put = flowWriter(w, run, receipt.notes)
  // 4.11 ⑰: a manifest of version 1 / 2 is refused before any write — no lock, no state, no flows record; the receipt names the tools that undo it
  const old = refuseOldManifest({ home, platform: w.platform, fs: w.fs })
  if (old) { receipt.problems.push(old.message); receipt.ok = false; Object.assign(receipt, { error: { code: 'older-install', message: old.message } }); receipt.log = null; return { receipt: shapeReceipt(receipt), exit: EXIT.incomplete } }
  // R7 on Windows (4.8 §7): off never runs with an elevated token — asked before anything is touched, and a token that cannot be read is
  // not a refusal (an undo that stopped on a broken whoami is not an undo).
  if ((deps.platform || process.platform) === 'win32') {
    const refusal = refuseElevatedByWhoami({ run: w.exec, env })
    if (refusal) { receipt.problems.push(refusal.reason); receipt.ok = false; put({ event: 'failure', ...refusal }); return { receipt: shapeReceipt(receipt), exit: EXIT.incomplete } }
  }
  const read = () => { try { return { manifest: readManifest(w.dir, w.fs), manifestError: null } } catch (e) { return { manifest: null, manifestError: e } } }
  let { manifest, manifestError } = read() // what the plan and the first desired-off go by; read AGAIN under the lock: an `on` that held it has written to the manifest since
  let installed = harnessIdsOf(manifest)
  if (ids === null) receipt.harnesses = installed
  const hadAnything = w.fs.existsSync(w.dir) || w.unitManaged() || manifest != null || manifestError != null // no collector directory, no unit, no manifest: asight was never installed here (or is uninstalled, and purged)
  if (dryRun) { // R6: the same receipt in the future tense, nothing written, nothing asked of the daemon, exit 0
    const mine = (x) => x.phase === 'on' && (ids == null || ids.includes(x.harness)) // off spares what install wrote (D55①), so its plan does too
    const items = manifest && !manifest.unsupported ? manifest : { entries: [], files: [] }
    const gone = items.files.filter((f) => mine(f) && ['plugin', 'shim', 'bundle', 'trust-file'].includes(f.role)).map((f) => f.path)
    const marks = manifest && !manifest.unsupported ? [] : planByMarker({ home, ids, fs: w.fs })
    receipt.dry_run = true
    receipt.changed = [...items.entries.filter((e) => mine(e) && (e.kind === 'json-key' || e.kind === 'text')).map((e) => ({ path: e.path, change: offChangeText(e), backup: e.backup ?? null, ...withHarness(e.harness) })), ...marks.filter((p) => p.how !== 'owned-file').map((p) => ({ path: p.path, change: MARKER_TEXT[p.how], backup: null, ...withHarness(p.harness) }))]
    receipt.removed = [...gone, ...marks.filter((p) => p.how === 'owned-file').map((p) => p.path)]
    if (manifest && manifest.unsupported) receipt.notes.push(`the install manifest is version ${JSON.stringify(manifest.version)}, which this build does not read: no entry would be touched`)
    else if (!manifest) receipt.notes.push(`there is no usable install manifest${manifestError ? ` (${errMessage(manifestError)})` : ''}: ${marks.length ? `${marks.length} file(s) would be undone by asight's own marks, after a yes` : 'no file holds asight\'s marks'}`)
    for (const id of ids || []) if (manifest && !installed.includes(id)) receipt.skipped.push({ what: id, reason: 'asight has nothing on its path (it was never set up, or it is already off)' })
    receipt.autostart = ids === null ? { planned: true } : null
    receipt.daemon = { pid: null, state: ids === null ? 'draining' : 'running' }
    if (!hadAnything && !receipt.changed.length && !receipt.removed.length) { receipt.nothing_installed = true; receipt.log = null } // said as it is (audit semantics 7); nothing would be written, so there is no log to point at
    return { receipt: shapeReceipt(receipt), exit: EXIT.ok }
  }

  if (refuseUnknownKinds(manifest, receipt, w.standalone)) return { receipt: shapeReceipt(receipt), exit: EXIT.incomplete } // before the lock, the desired state and the routing
  // 1 · the lock, off first: the desired state is written before the wait when the lock is held, so an `on` that is mid-way stops (R12)
  const tryOff = () => { try { return { r: desiredOff(w, ids, installed), error: null } } catch (e) { return { r: null, error: e } } }
  let early = null
  let lock = null
  if (w.fs.existsSync(w.dir)) {
    try { lock = await acquireOpLock({ file: opLockFile(home), identity: w.identity, alive: w.alive, waitMs: deps.lockWaitMs ?? OFF_LOCK_WAIT_MS, offFirst: () => { early = tryOff() }, fs: w.fs, now: w.ms, sleep: w.sleep }) } catch (e) {
      if (!e || e.code !== LOCK_BUSY) throw e
      receipt.problems.push(`${errMessage(e)}. ${early && early.error ? `The desired state could not be written either (${errMessage(early.error)})` : `The desired state is already off for ${ids ? ids.join(', ') : 'every harness'}: the command that holds the lock stops at its next write`}; run asight off again afterwards`)
      receipt.ok = false
      put({ kind: 'result', outcome: 'failed', reason: `off could not get the op lock: ${errMessage(e)}` })
      return { receipt: shapeReceipt(receipt), exit: EXIT.incomplete }
    }
  }
  try {
    ({ manifest, manifestError } = read()); installed = harnessIdsOf(manifest)
    if (refuseUnknownKinds(manifest, receipt, w.standalone)) return { receipt: shapeReceipt(receipt), exit: EXIT.incomplete } // read again under the lock: a newer asight may have written since (the lock is released by finally)
    if (ids === null) receipt.harnesses = installed
    // 2 · the desired state
    const again = tryOff()
    const wrote = [early && early.r, again.r].find((x) => x && x.wrote) || null
    const failed = again.error || (early && early.error && !again.r ? early.error : null)
    if (failed) { receipt.problems.push(`state.json could not be written (${errMessage(failed)}); a daemon that reads it again may switch back on`); put({ event: 'failure', code: (failed && failed.code) || 'state-unparsable', reason: `off could not write ${w.stateF}: ${errMessage(failed)}` }) }
    if (wrote) put({ kind: 'desired-off', harnesses: wrote.ids, reason: `desired state off for ${wrote.ids.join(', ')}${wrote.unreadable ? ` (the state file could not be read: ${wrote.unreadable}; it was written again with everything off)` : ''}` })
    if (w.deps.releaseHeld) await w.deps.releaseHeld(ids) // 5.1: held requests are released unchanged (a seam; 5.1 is not built)

    // 3 · the routing
    const routing = await switchRoutingOff(w, { ids, now, exit: ids === null })
    receipt.routing = { confirmed: routing.confirmed, state: routing.state, how: routing.how }
    receipt.daemon = routing.daemon && routing.daemon.state === 'draining' ? { ...routing.daemon, exits_after: routing.relayed && routing.relayed !== 'unknown' ? routing.relayed.closing : null } : routing.daemon // C.2 `daemon:{state, pid, exits_after}`
    receipt.relayed = routing.relayed
    if (routing.relayed_reason) receipt.relayed_reason = routing.relayed_reason
    if (routing.stop) receipt.daemon_stop = { how: routing.stop.how, signals: routing.stop.signals, stopped: routing.stop.stopped }
    receipt.problems.push(...routing.problems); receipt.notes.push(...routing.notes)
    for (const ev of routing.events) put(ev)
    if ((deps.platform || process.platform) === 'win32') { // a supervisor.lock whose holder is gone (killed: it never removed its own) does not outlive off
      const c = clearStaleSupervisorLock({ lockFile: w.lockFile, exec: w.exec, env, fs: w.fs })
      if (c.removed) put({ kind: 'note', reason: `removed ${path.join(w.dir, 'supervisor.lock')}: the supervisor it named is gone` })
    }
    for (const f of routing.failures) put({ event: 'failure', ...f })
    put({ kind: 'routing', confirmed: routing.confirmed, state: routing.state, reason: `routing ${routing.confirmed ? 'off, confirmed' : 'NOT confirmed off'} (${routing.how || routing.state})` })

    // 4 · the entries — only when the routing is confirmed (or the daemon could not be stopped)
    let outcome = 'off'
    if ((deps.platform || process.platform) === 'win32' && routing.state !== 'running') receipt.notes.push('No asight daemon is running: the local port it listened on is gone with it, so no connection is draining.')
    if (routing.confirmed || routing.unstoppable) {
      const u = await undoSide(w, { ids, manifest, manifestError, yes, interactive, io, say })
      for (const k of ['changed', 'removed', 'skipped', 'left']) receipt[k].push(...u[k])
      for (const k of ['kept_bundles', 'still_trusting', 'residue', 'kept_backups', 'orphan_backups', 'pending', 'planned', 'install_items']) receipt[k] = u[k]
      if (u.holders !== undefined) receipt.holders = u.holders
      receipt.problems.push(...u.problems); receipt.notes.push(...u.notes)
      receipt.undone_by_marker = u.undone_by_marker
      for (const ev of u.events) put(ev)
      for (const f of u.failures) put({ event: 'failure', ...f })
      if (u.mode === 'marker' && u.undone_by_marker && !u.left.length) outcome = CODE_OFF.undoneByMarker
      if (u.pending.length) outcome = 'partial'
      else if (u.left.length || u.mode === 'unsupported') outcome = 'left'
      if (u.mode !== 'marker') for (const id of ids || []) if (!installed.includes(id)) receipt.skipped.push({ what: id, reason: 'asight has nothing on its path (it was never set up, or it is already off)' })
      // (The Windows kernel arm that stood here — a daemon that did not answer left the kernel preferring its dead engine, so the standalone off made it
      // forward-only or stopped it through its controller — went with the kernel itself, D47's win32 twin: the engine's doors die with the daemon, nothing
      // outlives them to be steered, and uninstall's purge list still cleans kernel-era residue: kernel\, kernel-archive\, forwarder\.)
      // 5 · no names: the autostart goes too (the daemon was asked to exit once drained in step 3). Windows' task is disabled HERE, by the off itself — the
      // registration survives any manifest (an on whose ledger is gone, a task registered from asight's file by hand), so claiming "disabled" without asking
      // schtasks left the task enabled at every login while the receipt said otherwise; the Run value stays a manifest entry and goes with the rest in step 4
      // (undoRunKey). darwin's LaunchAgent is undone through the launchd arm (the flip checklist ①, 4.9 §4): the agent booted out FIRST (KeepAlive does not pull
      // the daemon back), then the plist out of ~/Library/LaunchAgents (launchd scans it at every login: a file left there undoes the off).
      if (ids === null) {
        if ((deps.platform || process.platform) === 'win32') {
          const t = disableScheduledTask({ run: w.exec, env })
          receipt.autostart = { disabled: t.ok, removed: [], ...(t.ok ? { note: 'the task is disabled now; the Run value is a ledger entry, undone with the rest (4.8 §4.2)' } : { error: t.reason || `the task is ${t.task}` }) }
          put({ kind: 'autostart', disabled: t.ok, reason: `autostart ${t.ok ? 'disabled' : 'NOT disabled'} (schtasks: the task is ${t.task})${t.reason ? ` (${t.reason})` : ''}` })
          if (receipt.autostart.error) { receipt.notes.push(receipt.autostart.error); put({ event: 'failure', code: 'unit-not-disabled', reason: receipt.autostart.error }) }
        }
        else if ((deps.platform || process.platform) === 'darwin') {
          const u = disableAgent({ exec: w.exec, env }) // disable, never bootout — the daemon drains and exits itself; the plist stays (an install item)
          receipt.autostart = { disabled: u.code === 0, removed: [], ...(u.code !== 0 ? { error: u.err || 'launchctl disable was refused' } : {}) }
          put({ kind: 'autostart', disabled: receipt.autostart.disabled, reason: `autostart ${receipt.autostart.disabled ? 'disabled' : 'NOT disabled'} (launchctl disable${u.code === 0 ? '' : `: exit ${u.code}`})${u.err ? ` (${u.err})` : ''}` })
          if (receipt.autostart.error) { receipt.notes.push(receipt.autostart.error); put({ event: 'failure', code: 'unit-not-disabled', reason: receipt.autostart.error }) }
        }
        else {
          receipt.autostart = disableAutostart({ home, exec: w.exec, env, fs: w.fs })
          put({ kind: 'autostart', disabled: receipt.autostart.disabled, reason: `autostart ${receipt.autostart.disabled ? 'disabled' : 'NOT disabled'}${receipt.autostart.error ? ` (${receipt.autostart.error})` : ''}` })
          if (receipt.autostart.error) { receipt.notes.push(receipt.autostart.error); put({ event: 'failure', code: 'unit-not-disabled', reason: receipt.autostart.error }) }
        }
      }
    } else outcome = 'failed'
    let list = []
    try { list = await w.procs() } catch (e) { receipt.notes.push(`the process table could not be read (${errMessage(e)}), so the asight processes you started yourself are not listed`) }
    receipt.user_processes = userProcessesOf(list)
    for (const p of receipt.user_processes) put({ kind: 'note', reason: `${p.command} (pid ${p.pid}) is still running: ${p.note}; off does not stop it` })

    // 6 / 7 · the receipt and its result line
    if (!w.fs.existsSync(w.dir)) receipt.log = null // nothing was written to flows/: there is no log to point at (R1)
    if (!hadAnything && !receipt.changed.length && !receipt.removed.length && !receipt.left.length && !receipt.problems.length && !(receipt.pending || []).length && !((receipt.autostart && receipt.autostart.removed) || []).length) receipt.nothing_installed = true // an `off` of a machine asight is not on: it says so, instead of "asight 已关闭采集" (audit semantics 7)
    receipt.ok = receipt.problems.length === 0 && receipt.left.length === 0 // an item that was not undone is a not-done off (1.6 R3, R4), whatever else went well
    if (!receipt.ok && !receipt.problems.length) receipt.problems.push(`${receipt.left.length} item(s) were left as they are (listed above, with why); put that right, then run asight off again`)
    const n = { changed: receipt.changed.length, removed: receipt.removed.length, left: receipt.left.length, still_trusting: (receipt.still_trusting || []).length }
    put({ kind: 'result', outcome: receipt.ok ? outcome : outcome === 'off' ? 'failed' : outcome, counts: n, reason: receipt.ok ? `off: ${receipt.harnesses.join(', ') || 'nothing installed'}${outcome === CODE_OFF.undoneByMarker ? ' (undone by their marks: there was no manifest)' : ''}` : `off did not finish: ${receipt.problems[0]}` })
    return { receipt: shapeReceipt(receipt), exit: receipt.ok ? EXIT.ok : EXIT.incomplete }
  } finally { if (lock) lock.release() }
}
