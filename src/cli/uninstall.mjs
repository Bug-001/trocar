// uninstall.mjs — `trocar uninstall [--purge-data] [--dry-run] [--yes] [--json]` (RFC 1.6 §1.1, R3, R6, R12; 4.6 §安装清单与卸载 1–5, V13): `off` for every harness, then trocar's own
// files. The order is the spec's: (1) desired off for all, written under the op lock; (2) the daemon is told to exit once drained (`POST /off {exit:true}`) and is waited for
// while it closes the connections it can see the end of — 30 s at most (§1.3); (3) the autostart is disabled and the daemon stopped by systemd (SIGTERM, then SIGKILL, when it
// is not systemd's), which cuts the connections that never end by themselves and counts them; (4) the link is confirmed gone; (5) the entries are undone, by
// the manifest or by trocar's marks (src/off/orchestrate.mjs undoSide, the same code `off` runs); (6) trocar's own files: the unit, the CA key and certificate, the runtime
// directory, state.json, every backup (the ones kept because the user edited the file too, each listed), `~/.trocar/bin/trocar-off`, and the manifest LAST. The captures
// stay (4.6 §安装清单与卸载 3) unless `--purge-data`. A daemon that cannot be stopped, a manifest this build does not read and marks that nobody confirmed remove nothing of
// trocar's own: what `off` could do is done, exit 1. Nothing here signals an agent or restarts anything (R8). The world is `deps` (see src/off/orchestrate.mjs).
import nodeOs from 'node:os'
import path from 'node:path'
import { newReceipt, EXIT, UNDO_LINE } from '../off/schema.mjs'
import { offWorld, desiredOff, drainDaemon, undoSide, harnessIdsOf, flowWriter, OFF_LOCK_WAIT_MS } from '../off/orchestrate.mjs'
import { userProcessesOf } from '../off/user-procs.mjs'
import { acquireOpLock, LOCK_BUSY } from '../off/lock.mjs'
import { readManifest, saveManifest, manifestPath, refuseOldManifest } from '../off/manifest.mjs'
import { disableAutostart, unitFilePath, removeWantsLinks } from '../off/autostart.mjs'
import { undoAutostart, plistFilePath } from '../off/darwin.mjs'
import { findingFor } from '../netenv/findings.mjs'
import { standalonePath, backupDir, opLockFile, trocarHome, COLLECTOR_STATE_FILES } from '../off/paths.mjs'
import { rawHome, indexHome, classesLog } from '../paths.mjs' // D60: the records are segments under ~/.trocar/raw, the index trocar builds from them under ~/.trocar/index
import { netenvFile } from '../netenv/index.mjs'
import { dropBackup, orphanBackups } from '../off/backup.mjs'
import { removeOwnedFile } from '../off/journal.mjs'
import { removeEmptyDirs, sweepTemps, strictlyInside } from '../off/fsutil.mjs'
import { execTool } from '../off/exec.mjs'
import { confirm, isInteractive } from '../off/io.mjs'
import { CODE_OFF } from '../off/names.mjs'
import { formatUninstallReceipt } from './receipt.mjs'
import { removeIngressConfig } from '../collector/core/ingress-config.mjs'
import { refuseElevatedByWhoami, disableScheduledTask, TASK_NAME } from '../off/win32.mjs'
import { holdersOf } from '../off/holders.mjs'
import { readDoorSeen } from '../off/door-seen.mjs'
import { readStateFile } from '../off/state.mjs'
import { readAgentList } from '../off/identity.mjs'
import { signHelperPath } from '../collector/arch/model-backends.mjs'
import { NATIVE } from '../collector/arch/darwin/native.mjs'
import { daemonLogPaths } from '../collector/arch/daemon-logs.mjs'
import { isModelOs } from '../collector/model-install.mjs' // macOS / Windows run the collector model (4.11): uninstall never does off — it refuses while capture is online (1.6 §1.1, CM24)

/** Is capture online (1.6 §1.1 「下线」)? → null when offline, else { on, holders, unknown } — `on`: harnesses whose desired state is on or that still have
 *  phase-on items; `holders`: P12's table, from the daemon (GET /holders) when it answers, else judged here from the manifest's liveness and the
 *  process table (src/off/holders.mjs, the same judge); `unknown`: why the holders could not be told (a daemon that does not answer, an unreadable
 *  table) — never read as "nobody". */
async function captureOnline(w, m, notes = []) {
  let st = null
  try { st = readStateFile(w.stateF, { fs: w.fs, installed: harnessIdsOf(m), now: w.clock() }).state } catch { st = null }
  const on = [...new Set([...Object.entries((st && st.harnesses) || {}).filter(([, v]) => v && v.desired === 'on').map(([h]) => h),
    ...[...((m && m.entries) || []), ...((m && m.files) || [])].filter((x) => x.phase === 'on' && typeof x.harness === 'string').map((x) => x.harness)])].sort()
  let holders = null, unknown = null
  try {
    if (!w.socketPath) throw Object.assign(new Error('no endpoint'), { code: 'ENOENT' })
    const r = await w.request({ socketPath: w.socketPath, method: 'GET', path: '/holders', timeoutMs: 2000 })
    if (r && Array.isArray(r.holders)) holders = r.holders; else unknown = 'the daemon does not know its holders yet'
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED')) { // the daemon is down: the CLI judges, by the same rule
      const ds = readDoorSeen({ dir: w.dir, fs: w.fs }) // the door's durable rows (P12); unreadable (rows null): every live process of h holds
      if (ds.rows == null) notes.push(`${ds.error}, so every running program of a harness that was on is counted as still connected`)
      try { holders = holdersOf({ manifest: m, procs: await w.procs(), doorSeen: ds.rows, agentList: readAgentList({ home: w.home, fs: w.fs }) }) } catch (t) { unknown = `the process table could not be read (${errText(t)})` }
    } else unknown = `a daemon holds the control endpoint but did not answer (${errText(e)})`
  }
  return on.length || unknown || (holders && holders.length) ? { on, holders: holders || [], unknown } : null
}

// What a plain uninstall keeps, and `--purge-data` deletes: the records themselves and the index built from them (D60). `flows/`, where trocar
// says what it did and what failed (D38), stays either way: this very run writes its own last line there. The class-change log is data too (1.6 §3.6).
const KEEPS = [[rawHome, 'your captured records'], [indexHome, 'the index trocar built from them'], [classesLog, 'the log of your traffic class changes']]
const bytesUnder = (p, fs) => { // the size of a directory (or of a file), for the receipt; what cannot be read counts 0 rather than failing an uninstall
  let n = 0
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, e.name); if (e.isDirectory()) walk(q); else try { n += fs.lstatSync(q).size } catch { /* gone while we looked */ } } } // lstat: a link counts as the link, never as what it points at outside ~/.trocar
  try { if (fs.lstatSync(p).isDirectory()) walk(p); else n = fs.lstatSync(p).size } catch { /* unreadable: the path is still named, with what could be counted */ }
  return n
}
/** 附录 C.2 `kept`: what is still on disk under the home now, named, with its size. */
const keptOf = (home, fs) => KEEPS.map(([dir, what]) => ({ what, path: dir(trocarHome(home)), bytes: 0 })).filter((k) => fs.existsSync(k.path)).map((k) => ({ ...k, bytes: bytesUnder(k.path, fs) }))
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)
const errText = (e) => String((e && e.message) || e)

/** What `uninstall --dry-run` would do (and what is printed when a yes is missing), read and written nowhere → the receipt fields. */
function planUninstall(w, m, purgeData = false) {
  const usable = m && !m.unsupported
  const entries = usable ? m.entries.filter((e) => e.kind === 'json-key' || e.kind === 'text') : []
  return {
    changed: entries.map((e) => ({ path: e.path, change: `${e.kind === 'text' ? "trocar's own lines" : (e.keys || []).join('.')} taken out`, backup: e.backup ?? null, ...(typeof e.harness === 'string' ? { harness: e.harness } : {}) })),
    removed: [...(usable ? m.files.map((f) => f.path) : []), ...COLLECTOR_STATE_FILES.map((n) => path.join(w.dir, n)).filter((p) => w.fs.existsSync(p)), ...(w.fs.existsSync(path.join(w.dir, 'ingress.json')) ? [path.join(w.dir, 'ingress.json')] : []), backupDir(w.home), standalonePath(w.home), ...(w.fs.existsSync(netenvFile(w.home)) ? [netenvFile(w.home)] : []), ...(purgeData ? keptOf(w.home, w.fs).map((k) => k.path) : []), ...(m ? [manifestPath(w.dir)] : [])],
    kept: purgeData ? [] : keptOf(w.home, w.fs),
    notes: usable || !m ? [] : [`the install manifest is version ${JSON.stringify(m.version)}, which this build does not read: no entry would be touched`],
    autostart: { planned: true },
  }
}

/** `trocar uninstall` (see the header). Refuses root by throwing (R7). → `{ receipt, exit }`: 0 done · 1 not done or a problem · 2 `--purge-data` without a terminal and
 *  without `--yes` (nothing was done, the plan is in the receipt). */
export async function runUninstall({ home = nodeOs.homedir(), env = process.env, purgeData = false, yes = false, dryRun = false, interactive = false, io = null, say = null, deps = {} } = {}) {
  if ((deps.getuid || processUid)() === 0) throw new Error('trocar uninstall: run this as your own user, not as root.')
  const w = offWorld({ home, env, deps })
  const fs = w.fs
  const run = w.clock().toISOString()
  const receipt = { ...newReceipt('uninstall'), all: true, harnesses: [], purge_data: purgeData, kept: [], undo: UNDO_LINE.uninstall, log: path.join(w.dir, 'flows'), left: [], kept_bundles: [], still_trusting: [], residue: [], dropped_backups: [], non_identical: [], entries: [], pending: [], user_processes: [], notes: [], problems: [] }
  const put = flowWriter(w, run, receipt.notes, { event: 'uninstall-note', where: 'uninstall' })
  // 4.11 ⑰: a manifest of version 1 / 2 is refused before any write (no lock, no state, no record); the receipt names the tools that undo it
  const old = refuseOldManifest({ home, platform: w.platform, fs })
  if (old) { receipt.problems.push(old.message); receipt.ok = false; Object.assign(receipt, { error: { code: 'older-install', message: old.message } }); receipt.log = null; return { receipt, exit: EXIT.incomplete } }
  // R7 on Windows (4.8 §7), the same refusal `off` has, before anything is touched; a token that cannot be read is not a refusal.
  if ((deps.platform || process.platform) === 'win32') {
    const refusal = refuseElevatedByWhoami({ run: w.exec, env })
    if (refusal) { receipt.problems.push(refusal.reason); receipt.ok = false; put({ event: 'failure', ...refusal }); return { receipt, exit: EXIT.incomplete } }
  }
  const read = () => { try { return { m: readManifest(w.dir, fs), merr: null } } catch (e) { return { m: null, merr: e } } }
  let { m, merr } = read()
  receipt.harnesses = harnessIdsOf(m)
  // §1.4 / appendix C: the plan itself is a key of the JSON document — every file by its full path and what would happen to it
  const plannedItems = (p) => [...p.changed.map((c) => ({ path: c.path, change: c.change, harness: c.harness ?? null })), ...p.removed.map((x) => ({ path: x, change: 'removed' }))]
  const plan = () => { const p = planUninstall(w, m, purgeData); return Object.assign(receipt, { dry_run: true }, p, { planned: plannedItems(p) }) }
  if (dryRun) { plan(); return { receipt, exit: EXIT.ok } }
  // §3.6: uninstall always prints its plan and asks — it takes certificates out of your trust settings and removes files of yours. Not a terminal
  // and no --yes: the plan only, nothing changed, exit 2 (§1.4).
  if (!yes) {
    if (say) say(formatUninstallReceipt({ ...receipt, ...planUninstall(w, m, purgeData), notes: [] }, { home, tense: 'future' }))
    const ok = interactive && io ? await confirm(io, purgeData ? 'This also deletes every captured record, for good. Proceed?' : 'Proceed?') : null
    if (ok !== true) {
      plan()
      receipt.ok = false
      if (ok === null) { receipt.needs_yes = true; receipt.notes.push('Nothing was changed. Read the plan above, then run it again with --yes') }
      else { receipt.declined = true; receipt.notes.push('You said no: nothing was changed') }
      return { receipt, exit: ok === null ? EXIT.usage : EXIT.incomplete }
    }
  }
  const tryOff = () => { try { return { r: desiredOff(w, null, harnessIdsOf(m)), error: null } } catch (e) { return { r: null, error: e } } }
  let early = null, lock = null
  if (fs.existsSync(w.dir)) {
    const model = isModelOs(w.platform)
    try { lock = await acquireOpLock({ file: opLockFile(home), identity: w.identity, alive: w.alive, waitMs: deps.lockWaitMs ?? OFF_LOCK_WAIT_MS, offFirst: model ? null : () => { early = tryOff() }, fs, now: w.ms, sleep: w.sleep }) } catch (e) {
      if (!e || e.code !== LOCK_BUSY) throw e
      receipt.ok = false; receipt.problems.push(`${errText(e)}. ${early && early.error ? `The desired state could not be written either (${errText(early.error)})` : 'The desired state is already off for every harness'}; run trocar uninstall again afterwards`)
      put({ kind: 'result', outcome: 'failed', reason: `uninstall could not get the op lock: ${errText(e)}` })
      return { receipt, exit: EXIT.incomplete }
    }
  }
  const failed = [] // failure events, written after any purge so they survive it
  const rm = (p) => { sweepTemps(p, fs); if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); receipt.removed.push(p) } }
  try {
    ;({ m, merr } = read()) // read AGAIN under the lock: an `on` that held it has written to the manifest since
    receipt.harnesses = harnessIdsOf(m)
    // CM24: on macOS / Windows uninstall never does off — capture online (a harness on, a holder, or not knowable) is named and nothing changes
    const online = isModelOs(w.platform) && m && !m.unsupported ? await captureOnline(w, m, receipt.notes) : null
    if (online) {
      const why = [online.on.length ? `capture is still on for ${online.on.join(', ')}` : null, online.holders.length ? `these processes still have trocar in their environment: ${online.holders.map((x) => `${x.harness} (pid ${x.pid})`).join(', ')}` : null, online.unknown ? `whether any process still has trocar in its environment is unknown (${online.unknown})` : null].filter(Boolean).join('; ') + '. Nothing was changed. Run: trocar off, wait for those processes to quit, then run trocar uninstall again'
      // 附录 C.1: the refusal's code lives in `error` and nowhere else; `message` is the sentence the text form prints
      receipt.ok = false; receipt.error = { code: 'collectors-online', message: why }; receipt.purge_data = false; receipt.kept = keptOf(home, fs) // nothing changed: --purge-data deleted nothing either
      receipt.problems.push(why)
      receipt.problems.push(`Run: ${findingFor('collectors-online', { platform: w.platform }).commands.map((c) => c.run).join(', then: ')}`) // the doctor's own steps for the code (1.6 附录 B)
      put({ event: 'failure', code: 'collectors-online', reason: receipt.problems.at(-2) })
      put({ kind: 'result', outcome: 'failed', reason: `uninstall refused: ${receipt.problems.at(-2)}` })
      return { receipt, exit: EXIT.incomplete }
    }
    // 1 · the desired state
    const again = tryOff()
    const wrote = [early && early.r, again.r].find((x) => x && x.wrote) || null
    const stateFailed = again.error || (early && early.error && !again.r ? early.error : null)
    if (stateFailed) { receipt.problems.push(`state.json could not be written (${errText(stateFailed)}); a daemon that reads it again may switch back on`); failed.push({ code: (stateFailed && stateFailed.code) || 'state-unparsable', reason: `uninstall could not write ${w.stateF}: ${errText(stateFailed)}` }) }
    if (wrote) put({ kind: 'desired-off', harnesses: wrote.ids, reason: `desired state off for ${wrote.ids.join(', ')}${wrote.unreadable ? ` (the state file could not be read: ${wrote.unreadable}; it was written again with everything off)` : ''}` })
    if (w.deps.releaseHeld) await w.deps.releaseHeld(null) // 5.1: held requests are released unchanged (a seam; 5.1 is not built)

    // 2 · 3 · 4: the daemon is asked to go and drains, the autostart is disabled, the daemon is stopped, the link is confirmed gone
    const { routing, drained } = await drainDaemon(w, { drainMs: deps.drainMs, by: 'uninstall' }) // the one drain-then-stop path; `update`'s daemon replacement takes it too (D67①)
    receipt.routing = { confirmed: routing.confirmed, state: routing.state, how: routing.how }
    receipt.daemon = routing.daemon; receipt.relayed = routing.relayed
    if (routing.relayed_reason) receipt.relayed_reason = routing.relayed_reason
    receipt.problems.push(...routing.problems); receipt.notes.push(...routing.notes)
    for (const ev of routing.events) put(ev)
    for (const f of routing.failures) failed.push(f)
    // the platform's own way out: darwin boots the LaunchAgent out and removes the plist (the same arm `off` uses, 4.9 §4 flip checklist ①),
    // Windows' task is DELETED here by the uninstall itself (the registration survives any manifest, so claiming it without asking schtasks left
    // the task registered at every login while the receipt said otherwise; the Run value stays a ledger entry), Linux disables the systemd unit
    if (w.platform === 'win32') {
      const t = disableScheduledTask({ uninstall: true, run: w.exec, env })
      // what it did, in the keys C.2 names: the task is DELETED here, so the entry belongs in `removed` the way macOS puts its plist there (a Windows test machine 2026-10-19 read `removed: []` as "nothing was taken away")
      receipt.autostart = { disabled: t.ok, removed: t.task === 'deleted' ? [TASK_NAME] : [], ...(t.ok ? {} : { error: t.reason || `the task is ${t.task}` }) }
    }
    else if (w.platform === 'darwin') {
      const u = undoAutostart({ home, exec: w.exec, env, fs })
      receipt.autostart = { disabled: u.code === 0, removed: u.plist === 'removed' ? [plistFilePath(home)] : [], ...(u.code !== 0 ? { error: u.err || `the LaunchAgent was ${u.agent} and the plist ${u.plist}` } : {}) }
    }
    else receipt.autostart = disableAutostart({ home, exec: w.exec, env, fs })
    receipt.removed.push(...(receipt.autostart.removed || []))
    if (!receipt.autostart.note || receipt.autostart.error) put({ kind: 'autostart', disabled: receipt.autostart.disabled, reason: `autostart ${receipt.autostart.disabled ? 'disabled' : 'NOT disabled'}${receipt.autostart.error ? ` (${receipt.autostart.error})` : ''}` }) // nothing to say when there was no unit
    if (receipt.autostart.error) { receipt.notes.push(receipt.autostart.error); failed.push({ code: 'unit-not-disabled', reason: receipt.autostart.error }) }
    let stop = routing.stop || null
    if (!stop && routing.confirmed) {
      stop = await w.stopDaemon({ unitManaged: w.unitManaged() })
      if (stop.signals.length || !stop.stopped) put({ kind: 'daemon-stop', how: stop.how, signals: stop.signals, stopped: stop.stopped, pid: stop.pid, reason: stop.stopped ? `the daemon was stopped (${stop.signals.join(', ') || 'it had exited'})` : `the daemon was NOT stopped${stop.error ? `: ${stop.error}` : ''}` })
      // nothing to stop (no lock, no unit that was running, no pid known from the daemon's own reply) is not "the daemon (pid null) was stopped": the receipt says no daemon was there
      receipt.daemon = !stop.stopped ? { pid: stop.pid, state: 'unresponsive' } : stop.pid == null && routing.daemon.pid == null && (routing.state === 'none' || routing.state === 'stale') ? { pid: null, state: 'none' } : { pid: stop.pid ?? routing.daemon.pid, state: 'stopped' }
      if (!stop.stopped) { receipt.problems.push(`the daemon (pid ${stop.pid}) could not be stopped${stop.error ? ` (${stop.error})` : ''}; stop it by hand: kill -9 ${stop.pid}, then run trocar uninstall again`); failed.push({ code: 'stop-failed', reason: receipt.problems.at(-1) }) }
      else if (routing.relayed !== 'unknown') { // what the daemon was still holding went with it, counted (1.6 §1.1)
        const last = drained && drained.rel ? drained.rel : routing.relayed
        receipt.relayed = { closing: 0, waiting: 0, cut: drained && drained.gone ? 0 : last.closing + last.waiting }
      }
    }
    const gone = routing.confirmed && (!stop || stop.stopped)
    if (!routing.confirmed && !routing.unstoppable) {
      for (const f of failed) put({ event: 'failure', ...f })
      put({ kind: 'result', outcome: 'failed', reason: `uninstall stopped: ${routing.problems[0] || 'the routing was not confirmed off'}` })
      receipt.ok = false
      return { receipt, exit: EXIT.incomplete }
    }

    // 5 · the entries
    const u = await undoSide(w, { ids: null, manifest: m, manifestError: merr, yes, interactive, io, say, dropCa: true })
    for (const k of ['changed', 'removed', 'skipped', 'left']) receipt[k].push(...u[k])
    Object.assign(receipt, { kept_bundles: u.kept_bundles, still_trusting: u.still_trusting, residue: u.residue, pending: u.pending, entries: u.results || [] })
    receipt.problems.push(...u.problems); receipt.notes.push(...u.notes)
    for (const f of u.failures) failed.push(f)
    const noted = u.events.filter((e) => e.kind !== CODE_OFF.backupKept) // the backup an edited file kept is dropped below, listed in the receipt as non-identical: "kept" would be untrue
    const blocked = !gone || u.mode === 'unsupported' || u.pending.length > 0 || u.stopped // `stopped`: the manifest on disk is not what the entries now are: it and the CA stay
    if (blocked) receipt.problems.push(gone ? 'trocar\'s own files were left in place (the entries above are not all undone): run trocar uninstall again' : 'trocar\'s own files were left in place: the daemon is still running')

    // 6 · trocar's own files — only when nothing above is still open
    const unitFile = m && !m.unsupported ? m.files.find((f) => f.role === 'unit') : null
    let unitLeft = false
    if (!blocked) {
      if (!m && u.mode === 'none') receipt.notes.push('nothing is installed for this user')
      if (m) {
        // every backup goes (zero residue, 1.6 R2): the ones undo dropped, the ones it kept because the user edited the file since — each listed — and any no entry names;
        // the backup of an entry that could not be undone stays with it, for the next run
        m.kept_backups = (m.kept_backups || []).filter((k) => {
          try { if (dropBackup(k.backup, fs)) { receipt.dropped_backups.push(k.backup); receipt.non_identical.push({ path: k.path, backup: k.backup, reason: k.reason }) } return false } catch (err) { noted.push({ kind: 'residue-not-removed', code: 'residue-not-removed', path: k.backup, reason: `${k.backup}, the backup of ${k.path}, could not be removed (${errText(err)}); remove it by hand` }); return true }
        })
      }
      receipt.dropped_backups.push(...u.dropped_backups)
      for (const b of orphanBackups({ home, manifest: m, fs })) { try { if (dropBackup(b, fs)) receipt.dropped_backups.push(b) } catch (err) { noted.push({ kind: 'residue-not-removed', code: 'residue-not-removed', path: b, reason: `${b} could not be removed (${errText(err)}); remove it by hand` }) } }
      removeEmptyDirs([backupDir(home)], fs)
      // the unit file and its links (4.6 order: after the entries, before the CA key); systemd is told it is gone
      if (unitFile || fs.existsSync(unitFilePath(home))) {
        const file = unitFile || { path: unitFilePath(home) }
        try {
          if (removeOwnedFile(file, fs).result === 'removed') {
            receipt.removed.push(file.path)
            // systemd is told the unit file is gone; darwin's launchd scans ~/Library/LaunchAgents at login and needs no reload
            if (w.platform !== 'win32' && w.platform !== 'darwin') {
              const r = execTool('systemctl', ['--user', 'daemon-reload'], { run: w.exec, env })
              if (r.code !== 0) receipt.notes.push(`systemctl --user daemon-reload failed (${r.err || `exit ${r.code}`}); run it once systemd --user runs`)
            }
          }
        } catch (err) {
          unitLeft = true; receipt.left.push({ path: file.path, result: 'error', reason: `${file.path} could not be removed: ${errText(err)}` }); failed.push({ code: 'entry-not-undone', path: file.path, reason: `${file.path} could not be removed: ${errText(err)}` })
        }
        receipt.removed.push(...removeWantsLinks(home, { onError: (p, err) => failed.push({ code: 'unit-not-disabled', path: p, reason: `${p}, the autostart link, could not be removed: ${errText(err)}` }), fs }))
      }
      // the CA, the runtime state (with the plugins' trust markers), the lock files, the single-file undo program
      for (const f of m && !m.unsupported ? m.files.filter((x) => x.role === 'ca-key') : []) {
        if (!strictlyInside(trocarHome(home), f.path, fs)) { // a manifest that names the CA key somewhere else is damaged or edited: that file is not trocar's
          const reason = `${f.path}, named as the CA key, is not inside ${trocarHome(home)}, so it is not trocar's to remove; correct that item in ${manifestPath(w.dir)} by hand`
          receipt.left.push({ path: f.path, result: 'error', reason }); failed.push({ code: 'entry-not-undone', path: f.path, reason })
        } else rm(f.path)
      }
      if (!m) rm(path.join(w.dir, 'ca'))
      const runtime = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'trocar') : null
      // `netenv.json` is the adopted records and the topology, for the board: trocar's own file, written outside collector/, so zero residue is not met without it
      // `logs/` is the daemon's own console (D46, 0.2:130): trocar's own, removed whole now that the daemon has stopped — its manifest entries (role 'daemon-log', Linux)
      // first so the receipt names the files, then the directory, which on macOS no entry names (launchd writes the LaunchAgent's StandardOutPath / StandardErrorPath itself)
      for (const f of m && !m.unsupported ? m.files.filter((x) => x.role === 'daemon-log') : []) rm(f.path)
      rm(daemonLogPaths(home).dir)
      // the darwin key custody's signing helper (install put it there, 4.11 P1): it goes once no root key is left for it to remove — after undoRootKeys, which needs it
      const helper = w.platform === 'darwin' && !(m && !m.unsupported && m.entries.some((e) => e.kind === 'root-key')) ? signHelperPath(home, NATIVE.signHelper) : null
      for (const p of [path.join(w.dir, 'run'), ...COLLECTOR_STATE_FILES.map((n) => path.join(w.dir, n)), w.lockFile, runtime, standalonePath(home), netenvFile(home), helper]) if (p) rm(p) // update.json: an update that never finished is trocar's own note, and goes with the rest of its state (§5.5); door-seen.json: the holder check above has read it
      removeEmptyDirs([path.dirname(standalonePath(home))], fs)
      // the door ports and their tokens (decision #16): the next install and on choose them again
      const ing = removeIngressConfig({ dir: w.dir, fs })
      if (!ing.removed) noted.push({ kind: 'residue-not-removed', code: 'residue-not-removed', path: path.join(w.dir, 'ingress.json'), reason: `${path.join(w.dir, 'ingress.json')} could not be removed (${ing.reason}); remove it by hand` })
    }
    for (const n of noted) if (!receipt.notes.includes(n.reason)) receipt.notes.push(n.reason) // the command prints every one of them
    // then the data the operator asked to drop — also after an earlier plain uninstall left the captures behind. `--purge-data` is "nothing of the captures stays", so the
    // collector's own machine goes with it: the kernel's copy (kernel/) and its verified-archive cache (kernel-archive/), the kernel's config and home with the controller
    // secret and tokens (forwarder/) — the endpoint files control.json and ingress.json went above, with every uninstall — a plain uninstall
    // keeps them (a kernel may still be draining; the next on reuses the cache), the purge leaves the collector directory empty of everything trocar can rebuild nothing of.
    // Only when every step above succeeded (invariant 2; 1.6 §1.1): a run that leaves an item, has a problem or a failure keeps every capture
    // and says so — the captures are what nothing brings back, and the next uninstall can still purge them.
    const purgeHeld = purgeData && (blocked || receipt.left.length > 0 || receipt.problems.length > 0 || failed.length > 0)
    if (purgeHeld) { receipt.purge_data = false; receipt.notes.push('This run did not finish, so not one captured record was deleted (--purge-data deletes them only when every other step succeeded). Fix what is above, then run: trocar uninstall --purge-data') }
    if (purgeData && !purgeHeld) {
      for (const n of (() => { try { return fs.readdirSync(w.dir) } catch { return [] } })()) if (/^capture-.*\.ndjson$/.test(n)) rm(path.join(w.dir, n))
      for (const sub of ['flows', 'audit', 'replays', 'kernel', 'kernel-archive', 'forwarder']) rm(path.join(w.dir, sub))
      for (const k of keptOf(home, fs)) rm(k.path) // the records themselves and the index built from them (D60): a purge that left them would leave every record on disk
    }
    // after the purge, so --purge-data never deletes what this run could not undo; a line that cannot be written is said in the output, never dropped, and never stops the uninstall
    for (const f of failed) put({ event: 'failure', ...f })
    const left = receipt.left.length
    // the outcome follows the exit code (as `off`'s does): an item that could not be undone is 'left'; any other problem — a blocked run, a state.json that could not be
    // written — is 'failed'; 'uninstalled' only when the run is clean
    const failedRun = blocked || (receipt.problems.length > 0 && !left)
    if (!(purgeData && !purgeHeld)) { // a purge took flows/ with it: nothing to append to
      for (const n of noted) put(n)
      put({ kind: 'result', outcome: failedRun ? 'failed' : left ? 'left' : 'uninstalled', counts: { entries: (u.results || []).length, left, still_trusting: u.still_trusting.length, notes: noted.length }, reason: failedRun ? `uninstall did not finish: ${receipt.problems[0]}` : left ? `uninstalled, except ${left} item(s) that could not be undone; the install manifest is kept` : `uninstalled: ${(u.results || []).length} trust entr${(u.results || []).length === 1 ? 'y' : 'ies'} undone, ${noted.length} note(s)` })
    }
    if (!blocked) {
      if (m && (left || receipt.kept_bundles.length)) { // keep exactly what is left; the next uninstall finds it (4.6: the manifest goes last)
        const files = m.files.filter((f) => f.role !== 'ca-key' && f.role !== 'ca-cert' && (f !== unitFile || unitLeft))
        saveManifest(w.dir, { ...m, install: null, ...(left ? { uninstall_left: receipt.left.map((l) => ({ path: l.path, harness: l.harness ?? null, result: l.result })), uninstalled_at: w.clock().toISOString() } : {}), ...(receipt.kept_bundles.length ? { pending_bundles: true } : {}), planned: [], watched: [], files }, fs)
      } else {
        if (lock) lock.release() // its file is in the directory that may go with the manifest
        if (m) {
          removeEmptyDirs(m.dirs.filter((d) => d !== w.dir), fs) // e.g. ca/
          fs.rmSync(manifestPath(w.dir), { force: true }) // the manifest goes last: a second run still finds what the first left
          sweepTemps(manifestPath(w.dir), fs)
          receipt.removed.push(manifestPath(w.dir))
          removeEmptyDirs(m.dirs, fs)
        }
        removeEmptyDirs([trocarHome(home), w.dir, path.dirname(classesLog(trocarHome(home)))], fs) // `on` made them before the manifest listed any directory; gone only when empty (the captures keep them)
      }
    }
    let list = []
    try { list = await w.procs() } catch (e) { receipt.notes.push(`the process table could not be read (${errText(e)}), so the trocar processes you started yourself are not listed`) }
    receipt.user_processes = userProcessesOf(list)
    receipt.kept = keptOf(home, fs) // what is still there now this run is done: after a purge, nothing
    receipt.ok = receipt.problems.length === 0 && left === 0
    if (!receipt.ok && !receipt.problems.length) receipt.problems.push(`${left} item(s) could not be undone; the install manifest is kept. Fix them, then run trocar uninstall again`)
    return { receipt, exit: receipt.ok ? EXIT.ok : EXIT.incomplete }
  } catch (e) { // an error that is not a step's own: recorded where status finds it, then thrown (4.6: a failed run ends with outcome 'failed')
    try { if (fs.existsSync(w.dir)) { put({ event: 'failure', code: (e && e.code) || 'uninstall-error', reason: errText(e) }); put({ kind: 'result', outcome: 'failed', reason: `uninstall failed: ${errText(e)}` }) } } catch { /* the original error is the one that matters */ }
    throw e
  } finally { if (lock) lock.release() }
}

const USAGE = 'usage: trocar uninstall [--purge-data] [--dry-run] [--yes] [--json]'
const FLAGS = new Set(['--purge-data', '--dry-run', '--yes', '--json'])

/** → the exit code. `argv` is what follows `uninstall`. `io` = { out, err, stdin, stdout, stderr } (src/off/io.mjs makeIo). */
export async function runUninstallCli(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  const flags = new Set()
  for (const a of argv) {
    if (!a.startsWith('-')) { io.err(`trocar uninstall: takes no harness name (${a}): uninstall removes trocar for every harness\n${USAGE}`); return EXIT.usage }
    if (!FLAGS.has(a)) { io.err(`trocar uninstall: unknown option ${a}\n${USAGE}`); return EXIT.usage }
    flags.add(a)
  }
  const json = flags.has('--json')
  if ((deps.getuid || processUid)() === 0) { io.err('trocar uninstall: run this as your own user, not as root.'); return EXIT.usage }
  try {
    // a platform without a collector reaches runUninstall the same way and finds nothing to undo (D39⑥ executed 2026-10-11: the old capture's own uninstall went with it)
    // the root's key goes last through its custody (4.11 P13): the platform's backend unless a test hands one in
    if (deps.custody === undefined && isModelOs(platform)) deps = { ...deps, custody: (await (await import('../collector/arch/model-backends.mjs')).backendsFor({ os: platform, home, run: deps.exec || null, env })).custody }
    const { receipt, exit } = await runUninstall({ home, env, purgeData: flags.has('--purge-data'), yes: flags.has('--yes'), dryRun: flags.has('--dry-run'), interactive: !json && isInteractive(io), io: { ...io, prompt: io.stdout }, say: json ? null : io.out, deps: { platform, ...deps } }) // the CLI's platform is offWorld's default (deps.platform of a test's still wins) — the same seam `off` has
    if (json) io.out(JSON.stringify(receipt, null, 2))
    else if (receipt.needs_yes || receipt.declined) { for (const n of receipt.notes) io.err(n) } // the plan went out before the question was asked; what is left to say is why nothing was done (R6)
    else io.out(formatUninstallReceipt(receipt, { home }))
    return exit
  } catch (e) {
    const message = errText(e)
    if (json) io.out(JSON.stringify({ ...newReceipt('uninstall'), ok: false, notes: [message] }, null, 2)); else io.err(`trocar uninstall: ${message}`)
    return EXIT.incomplete
  }
}
