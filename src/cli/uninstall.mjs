// uninstall.mjs — `asight uninstall [--purge-data] [--dry-run] [--yes] [--json]` (RFC 1.6 §1.1, R3, R6, R12; 4.6 §安装清单与卸载 1–5, V13): `off` for every harness, then asight's own
// files. The order is the spec's: (1) desired off for all, written under the op lock; (2) the daemon is told to exit once drained (`POST /off {exit:true}`) and is waited for
// while it closes the connections it can see the end of — 30 s at most (§1.3); (3) the autostart is disabled and the daemon stopped by systemd (SIGTERM, then SIGKILL, when it
// is not systemd's), which cuts the connections that never end by themselves and counts them; (4) the link is confirmed gone; (5) the entries are undone, both generations, by
// the manifest or by asight's marks (src/off/orchestrate.mjs undoSide, the same code `off` runs); (6) asight's own files: the unit, the CA key and certificate, the runtime
// directory, state.json, every backup (the ones kept because the user edited the file too, each listed), `~/.asight/bin/asight-off`, and the manifest LAST. The captures
// stay (4.6 §安装清单与卸载 3) unless `--purge-data`. A daemon that cannot be stopped, a manifest this build does not read and marks that nobody confirmed remove nothing of
// asight's own: what `off` could do is done, exit 1. Nothing here signals an agent or restarts anything (R8). The world is `deps` (see src/off/orchestrate.mjs).
import nodeOs from 'node:os'
import path from 'node:path'
import { newReceipt, EXIT } from '../off/schema.mjs'
import { offWorld, desiredOff, switchRoutingOff, undoSide, harnessIdsOf, flowWriter, userProcessesOf, OFF_LOCK_WAIT_MS } from '../off/orchestrate.mjs'
import { acquireOpLock, LOCK_BUSY } from '../off/lock.mjs'
import { readManifest, saveManifest, manifestPath } from '../off/manifest.mjs'
import { disableAutostart, unitFilePath, removeWantsLinks } from '../off/autostart.mjs'
import { standalonePath, backupDir, opLockFile, asightHome } from '../off/paths.mjs'
import { dropBackup, orphanBackups } from '../off/backup.mjs'
import { removeOwnedFile } from '../off/journal.mjs'
import { removeEmptyDirs, sweepTemps } from '../off/fsutil.mjs'
import { execTool } from '../off/exec.mjs'
import { confirm, isInteractive } from '../off/io.mjs'
import { CODE_OFF } from '../off/names.mjs'
import { formatUninstallReceipt } from './receipt.mjs'

const DRAIN_MS = 30_000 // 1.6 §1.1: how long the daemon is given to close the connections it can see the end of
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)
const errText = (e) => String((e && e.message) || e)
const relayedOf = (r) => (r && ['closing', 'waiting', 'cut'].every((k) => Number.isInteger(r[k]) && r[k] >= 0) ? r : null)

// The daemon was asked to exit once drained: wait until the connections it can see the end of are closed (`closing` is 0), it has gone, or `boundMs` is up.
// → { rel: the last counts read (null: never read), gone: the daemon had exited by itself when last looked }.
async function waitForDrain(w, first, boundMs) {
  let rel = relayedOf(first), gone = false
  for (const end = w.ms() + boundMs; rel && rel.closing > 0 && w.ms() < end;) {
    await w.sleep(200)
    try { rel = relayedOf((await w.request({ socketPath: w.socketPath, method: 'GET', path: '/status', timeoutMs: 2000 })).relayed) || rel } catch (e) {
      gone = !!e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') // exited by itself (it drained), or not answering: nothing more to wait for
      break
    }
  }
  return { rel, gone }
}

/** What `uninstall --dry-run` would do (and what is printed when a yes is missing), read and written nowhere → the receipt fields. */
function planUninstall(w, m) {
  const usable = m && !m.unsupported
  const entries = usable ? m.entries.filter((e) => e.kind === 'json-key' || e.kind === 'text') : []
  return {
    changed: entries.map((e) => ({ path: e.path, change: `去掉 ${e.kind === 'text' ? 'asight 加的文字' : (e.keys || []).join('.')}`, backup: e.backup ?? null, ...(typeof e.harness === 'string' ? { harness: e.harness } : {}) })),
    removed: [...(usable ? m.files.map((f) => f.path) : []), path.join(w.dir, 'state.json'), backupDir(w.home), standalonePath(w.home), ...(m ? [manifestPath(w.dir)] : [])],
    notes: usable || !m ? [] : [`the install manifest is version ${JSON.stringify(m.version)}, which this build does not read: no entry would be touched`],
    autostart: { planned: true },
  }
}

/** `asight uninstall` (see the header). Refuses root by throwing (R7). → `{ receipt, exit }`: 0 done · 1 not done or a problem · 2 `--purge-data` without a terminal and
 *  without `--yes` (nothing was done, the plan is in the receipt). */
export async function runUninstall({ home = nodeOs.homedir(), env = process.env, purgeData = false, yes = false, dryRun = false, interactive = false, io = null, say = null, deps = {} } = {}) {
  if ((deps.getuid || processUid)() === 0) throw new Error('asight uninstall: run it as the user whose agents you capture, not as root (D36); 用你自己的账号跑')
  const w = offWorld({ home, env, deps })
  const fs = w.fs
  const run = w.clock().toISOString()
  const receipt = { ...newReceipt('uninstall'), all: true, harnesses: [], purge_data: purgeData, kept_captures: !purgeData, undo: ['asight on'], log: path.join(w.dir, 'flows'), left: [], kept_bundles: [], still_trusting: [], residue: [], dropped_backups: [], non_identical: [], entries: [], pending: [], user_processes: [], notes: [], problems: [] }
  const put = flowWriter(w, run, receipt.notes, { event: 'uninstall-note', where: 'uninstall' })
  const read = () => { try { return { m: readManifest(w.dir, fs), merr: null } } catch (e) { return { m: null, merr: e } } }
  let { m, merr } = read()
  receipt.harnesses = harnessIdsOf(m)
  const plan = () => Object.assign(receipt, { dry_run: true, planned: true }, planUninstall(w, m))
  if (dryRun) { plan(); return { receipt, exit: EXIT.ok } }
  if (purgeData && !yes) { // R6: `--purge-data` deletes what nothing else can bring back: a yes is asked for, or given
    const ok = interactive && io ? await confirm(io, '--purge-data 会删掉全部采集数据(capture-*.ndjson、flows/、audit/、replays/),删了就没有了。继续?') : null
    if (ok !== true) {
      plan()
      receipt.ok = false
      if (ok === null) { receipt.needs_yes = true; receipt.notes.push('不在终端里,没有 --yes:只打印了计划,什么都没动。确认要删采集数据,就加 --yes 再跑一次') }
      else { receipt.declined = true; receipt.notes.push('没有确认:什么都没动') }
      return { receipt, exit: ok === null ? EXIT.usage : EXIT.incomplete }
    }
  }
  const tryOff = () => { try { return { r: desiredOff(w, null, harnessIdsOf(m)), error: null } } catch (e) { return { r: null, error: e } } }
  let early = null, lock = null
  if (fs.existsSync(w.dir)) {
    try { lock = await acquireOpLock({ file: opLockFile(home), identity: w.identity, alive: w.alive, waitMs: deps.lockWaitMs ?? OFF_LOCK_WAIT_MS, offFirst: () => { early = tryOff() }, fs, now: w.ms, sleep: w.sleep }) } catch (e) {
      if (!e || e.code !== LOCK_BUSY) throw e
      receipt.ok = false; receipt.problems.push(`${errText(e)}. ${early && early.error ? `The desired state could not be written either (${errText(early.error)})` : 'The desired state is already off for every harness'}; run asight uninstall again afterwards`)
      put({ kind: 'result', outcome: 'failed', reason: `uninstall could not get the op lock: ${errText(e)}` })
      return { receipt, exit: EXIT.incomplete }
    }
  }
  const failed = [] // failure events, written after any purge so they survive it
  const rm = (p) => { sweepTemps(p, fs); if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); receipt.removed.push(p) } }
  try {
    ;({ m, merr } = read()) // read AGAIN under the lock: an `on` that held it has written to the manifest since
    receipt.harnesses = harnessIdsOf(m)
    // 1 · the desired state
    const again = tryOff()
    const wrote = [early && early.r, again.r].find((x) => x && x.wrote) || null
    const stateFailed = again.error || (early && early.error && !again.r ? early.error : null)
    if (stateFailed) { receipt.problems.push(`state.json could not be written (${errText(stateFailed)}); a daemon that reads it again may switch back on`); failed.push({ code: (stateFailed && stateFailed.code) || 'state-unparsable', reason: `uninstall could not write ${w.stateF}: ${errText(stateFailed)}` }) }
    if (wrote) put({ kind: 'desired-off', harnesses: wrote.ids, reason: `desired state off for ${wrote.ids.join(', ')}${wrote.unreadable ? ` (the state file could not be read: ${wrote.unreadable}; it was written again with everything off)` : ''}` })
    if (w.deps.releaseHeld) await w.deps.releaseHeld(null) // 5.1: held requests are released unchanged (a seam; 5.1 is not built)

    // 2 · 3 · 4: the daemon is asked to go and drains, the autostart is disabled, the daemon is stopped, the link is confirmed gone
    const routing = await switchRoutingOff(w, { ids: null, now: false, exit: true })
    receipt.routing = { confirmed: routing.confirmed, state: routing.state, how: routing.how }
    receipt.daemon = routing.daemon; receipt.relayed = routing.relayed
    if (routing.relayed_reason) receipt.relayed_reason = routing.relayed_reason
    receipt.problems.push(...routing.problems)
    for (const ev of routing.events) put(ev)
    for (const f of routing.failures) failed.push(f)
    let drained = null
    if (routing.confirmed && routing.how === 'daemon-reply') drained = await waitForDrain(w, routing.relayed, deps.drainMs ?? DRAIN_MS)
    receipt.autostart = disableAutostart({ home, exec: w.exec, env, fs })
    receipt.removed.push(...(receipt.autostart.removed || []))
    if (!receipt.autostart.note || receipt.autostart.error) put({ kind: 'autostart', disabled: receipt.autostart.disabled, reason: `autostart ${receipt.autostart.disabled ? 'disabled' : 'NOT disabled'}${receipt.autostart.error ? ` (${receipt.autostart.error})` : ''}` }) // nothing to say when there was no unit
    if (receipt.autostart.error) { receipt.notes.push(receipt.autostart.error); failed.push({ code: 'unit-not-disabled', reason: receipt.autostart.error }) }
    let stop = routing.stop || null
    if (!stop && routing.confirmed) {
      stop = await w.stopDaemon({ unitManaged: w.unitManaged() })
      if (stop.signals.length || !stop.stopped) put({ kind: 'daemon-stop', how: stop.how, signals: stop.signals, stopped: stop.stopped, pid: stop.pid, reason: stop.stopped ? `the daemon was stopped (${stop.signals.join(', ') || 'it had exited'})` : `the daemon was NOT stopped${stop.error ? `: ${stop.error}` : ''}` })
      receipt.daemon = stop.stopped ? { pid: stop.pid ?? routing.daemon.pid, state: 'stopped' } : { pid: stop.pid, state: 'unresponsive' }
      if (!stop.stopped) { receipt.problems.push(`the daemon (pid ${stop.pid}) could not be stopped${stop.error ? ` (${stop.error})` : ''}; stop it by hand: kill -9 ${stop.pid}, then run asight uninstall again`); failed.push({ code: 'stop-failed', reason: receipt.problems.at(-1) }) }
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

    // 5 · the entries, both generations
    const u = await undoSide(w, { ids: null, manifest: m, manifestError: merr, yes, interactive, io, say, dropCa: true })
    for (const k of ['changed', 'removed', 'skipped', 'left']) receipt[k].push(...u[k])
    Object.assign(receipt, { kept_bundles: u.kept_bundles, still_trusting: u.still_trusting, residue: u.residue, pending: u.pending, entries: u.results || [] })
    receipt.problems.push(...u.problems); receipt.notes.push(...u.notes)
    for (const f of u.failures) failed.push(f)
    if (w.deps.legacyUndo) { // the old capture's leftovers (Task 10)
      const l = await w.deps.legacyUndo({ home, env, ids: null, yes, interactive, io, say, dryRun: false, exec: w.exec, fs, now: w.clock, request: w.request })
      if (l) { for (const k of ['changed', 'removed', 'skipped', 'left']) receipt[k].push(...(l[k] || [])); receipt.problems.push(...(l.problems || [])); receipt.notes.push(...(l.notes || [])); if (l.ok === false && !(l.problems || []).length) receipt.problems.push('the old capture could not be fully undone') }
    }
    const noted = u.events.filter((e) => e.kind !== CODE_OFF.backupKept) // the backup an edited file kept is dropped below, listed in the receipt as non-identical: "kept" would be untrue
    const blocked = !gone || u.mode === 'unsupported' || u.pending.length > 0
    if (blocked) receipt.problems.push(gone ? 'asight\'s own files were left in place (the entries above are not all undone): run asight uninstall again' : 'asight\'s own files were left in place: the daemon is still running')

    // 6 · asight's own files — only when nothing above is still open
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
            const r = execTool('systemctl', ['--user', 'daemon-reload'], { run: w.exec, env })
            if (r.code !== 0) receipt.notes.push(`systemctl --user daemon-reload failed (${r.err || `exit ${r.code}`}); run it once systemd --user runs`)
          }
        } catch (err) {
          unitLeft = true; receipt.left.push({ path: file.path, result: 'error', reason: `${file.path} could not be removed: ${errText(err)}` }); failed.push({ code: 'entry-not-undone', path: file.path, reason: `${file.path} could not be removed: ${errText(err)}` })
        }
        receipt.removed.push(...removeWantsLinks(home, { onError: (p, err) => failed.push({ code: 'unit-not-disabled', path: p, reason: `${p}, the autostart link, could not be removed: ${errText(err)}` }), fs }))
      }
      // the CA, the runtime state (with the plugins' trust markers), the lock files, the single-file undo program
      for (const f of m && !m.unsupported ? m.files.filter((x) => x.role === 'ca-key') : []) rm(f.path)
      if (!m) rm(path.join(w.dir, 'ca'))
      const runtime = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'asight') : null
      for (const p of [path.join(w.dir, 'run'), w.lockFile, w.stateF, runtime, standalonePath(home)]) if (p) rm(p)
      removeEmptyDirs([path.dirname(standalonePath(home))], fs)
    }
    for (const n of noted) if (!receipt.notes.includes(n.reason)) receipt.notes.push(n.reason) // the command prints every one of them
    // then the data the operator asked to drop — also after an earlier plain uninstall left the captures behind
    if (purgeData) {
      for (const n of (() => { try { return fs.readdirSync(w.dir) } catch { return [] } })()) if (/^capture-.*\.ndjson$/.test(n)) rm(path.join(w.dir, n))
      for (const sub of ['flows', 'audit', 'replays']) rm(path.join(w.dir, sub))
    }
    // after the purge, so --purge-data never deletes what this run could not undo; a line that cannot be written is said in the output, never dropped, and never stops the uninstall
    for (const f of failed) put({ event: 'failure', ...f })
    const left = receipt.left.length
    if (!(purgeData && !left && !blocked)) {
      for (const n of noted) put(n)
      put({ kind: 'result', outcome: blocked ? 'failed' : left ? 'left' : 'uninstalled', counts: { entries: (u.results || []).length, left, still_trusting: u.still_trusting.length, notes: noted.length }, reason: blocked ? `uninstall did not finish: ${receipt.problems[0]}` : left ? `uninstalled, except ${left} item(s) that could not be undone; the install manifest is kept` : `uninstalled: ${(u.results || []).length} trust entr${(u.results || []).length === 1 ? 'y' : 'ies'} undone, ${noted.length} note(s)` })
    }
    if (!blocked) {
      if (m && (left || receipt.kept_bundles.length)) { // keep exactly what is left; the next uninstall finds it (4.6: the manifest goes last)
        const files = m.files.filter((f) => f.role !== 'ca-key' && f.role !== 'ca-cert' && (f !== unitFile || unitLeft))
        saveManifest(w.dir, { ...m, complete: false, ...(left ? { uninstall_left: receipt.left.map((l) => ({ path: l.path, harness: l.harness ?? null, result: l.result })), uninstalled_at: w.clock().toISOString() } : {}), ...(receipt.kept_bundles.length ? { pending_bundles: true } : {}), planned: [], watched: [], files }, fs)
      } else {
        if (lock) lock.release() // its file is in the directory that may go with the manifest
        if (m) {
          removeEmptyDirs(m.dirs.filter((d) => d !== w.dir), fs) // e.g. ca/
          fs.rmSync(manifestPath(w.dir), { force: true }) // the manifest goes last: a second run still finds what the first left
          sweepTemps(manifestPath(w.dir), fs)
          receipt.removed.push(manifestPath(w.dir))
          removeEmptyDirs(m.dirs, fs)
        }
        removeEmptyDirs([asightHome(home), w.dir], fs) // `on` made them before the manifest listed any directory; gone only when empty (the captures keep them)
      }
    }
    let list = []
    try { list = await w.procs() } catch (e) { receipt.notes.push(`the process table could not be read (${errText(e)}), so the asight processes you started yourself are not listed`) }
    receipt.user_processes = userProcessesOf(list)
    receipt.ok = receipt.problems.length === 0 && left === 0
    if (!receipt.ok && !receipt.problems.length) receipt.problems.push(`${left} item(s) could not be undone; the install manifest is kept — fix them, then run asight uninstall again`)
    return { receipt, exit: receipt.ok ? EXIT.ok : EXIT.incomplete }
  } catch (e) { // an error that is not a step's own: recorded where status finds it, then thrown (4.6: a failed run ends with outcome 'failed')
    try { if (fs.existsSync(w.dir)) { put({ event: 'failure', code: (e && e.code) || 'uninstall-error', reason: errText(e) }); put({ kind: 'result', outcome: 'failed', reason: `uninstall failed: ${errText(e)}` }) } } catch { /* the original error is the one that matters */ }
    throw e
  } finally { if (lock) lock.release() }
}

const USAGE = 'usage: asight uninstall [--purge-data] [--dry-run] [--yes] [--json]'
const FLAGS = new Set(['--purge-data', '--dry-run', '--yes', '--json'])

/** → the exit code. `argv` is what follows `uninstall`. `io` = { out, err, stdin, stdout, stderr } (src/off/io.mjs makeIo). */
export async function runUninstallCli(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  const flags = new Set()
  for (const a of argv) {
    if (!a.startsWith('-')) { io.err(`asight uninstall: takes no harness name (${a}): uninstall removes asight for every harness\n${USAGE}`); return EXIT.usage }
    if (!FLAGS.has(a)) { io.err(`asight uninstall: unknown option ${a}\n${USAGE}`); return EXIT.usage }
    flags.add(a)
  }
  const json = flags.has('--json')
  if ((deps.getuid || processUid)() === 0) { io.err('asight uninstall: 用你自己的账号跑,不要用 root / sudo(D36)'); return EXIT.incomplete }
  if (platform !== 'linux') {
    if (deps.legacyUninstall) return deps.legacyUninstall(argv, { io, env, home, platform, deps })
    io.err(`asight uninstall: 本平台(${platform})没有新采集器;这里 uninstall 要补全旧采集的撤销(过渡期,1.6 §4),这一步还没接上`)
    return EXIT.incomplete
  }
  try {
    const { receipt, exit } = await runUninstall({ home, env, purgeData: flags.has('--purge-data'), yes: flags.has('--yes'), dryRun: flags.has('--dry-run'), interactive: isInteractive(io), io: { ...io, prompt: json ? io.stderr : io.stdout }, say: json ? io.err : io.out, deps })
    if (json) io.out(JSON.stringify(receipt, null, 2))
    else if (receipt.needs_yes || receipt.declined) { io.out(formatUninstallReceipt({ ...receipt, notes: [] }, { home, tense: 'future' })); for (const n of receipt.notes) io.err(n) } // the plan, then why nothing was done (R6)
    else io.out(formatUninstallReceipt(receipt, { home }))
    return exit
  } catch (e) {
    const message = errText(e)
    if (json) io.out(JSON.stringify({ ...newReceipt('uninstall'), ok: false, notes: [message] }, null, 2)); else io.err(`asight uninstall: ${message}`)
    return EXIT.incomplete
  }
}
