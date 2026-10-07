// legacy-uninstall.mjs — `asight uninstall [--purge-data] [--dry-run] [--yes] [--json]` where the old capture is what `on` / `off` drive (RFC 1.6 §4, §1.1, R2, R6): `off` for the old capture
// (src/off/legacy.mjs `undoLegacy`, the same code), then asight's own files — every backup (the ones kept because the file was edited since, each listed), the ledger, the CA that `on`
// made in ~/.asight/ca, the single-file undo `~/.asight/bin/asight-off`. When something could not be undone, none of that is removed: what `off` could do is done, exit 1, and the ledger and
// its backups stay for the next run. The captures stay unless `--purge-data` (then the capture files at the top of ~/.asight; it needs a confirmation, R6: without a terminal and without
// `--yes` the plan is printed and nothing is done, exit 2). v0's leftovers (~/.atrace, com.atrace.serve) are reported, never touched . Nothing here restarts anything (R8).
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import path from 'node:path'
import { EXIT, newReceipt } from './schema.mjs'
import { isInteractive, confirm } from '../off/io.mjs'
import { acquireOpLock, LOCK_BUSY } from '../off/lock.mjs'
import { asightHome, backupDir, legacyLockPath, legacyEventsFile, legacyManifestPath, standalonePath } from '../off/paths.mjs'
import { readManifestAt } from '../off/manifest.mjs'
import { dropBackup, orphanBackups } from '../off/backup.mjs'
import { removeEmptyDirs } from '../off/fsutil.mjs'
import { legacyArtifacts, undoLegacy, LEGACY_NOTE } from '../off/legacy.mjs'
import { legacyPlan } from '../off/legacy-cli.mjs'
import { appendLegacyEvent } from '../capture/events.mjs'
import { formatUninstallReceipt, tilde } from './receipt.mjs'

const errText = (e) => String((e && e.message) || e)
const DATA_FILE = /^(claude-)?capture([-.].*)?\.ndjson$/ // what the old capture writes at the top of ~/.asight (the MITM's --out and `monitor`'s): the captures `--purge-data` deletes

/** asight's own files that uninstall deletes when the old capture is out: the CA `on` made, the single-file undo, and with `purge` the capture files. Reads only. */
function ownFiles({ home, fs, purge }) {
  const dir = asightHome(home), out = { files: [], dirs: [] }
  const caDir = path.join(dir, 'ca')
  if (fs.existsSync(caDir)) out.dirs.push(caDir)
  if (fs.existsSync(standalonePath(home))) out.files.push(standalonePath(home))
  if (purge) { try { for (const n of fs.readdirSync(dir)) if (DATA_FILE.test(n)) out.files.push(path.join(dir, n)) } catch { /* no ~/.asight: no captures */ } }
  return out
}

/** → the exit code (R4). `argv` is what follows `uninstall` (runUninstallCli has validated it); `ids` is always none: uninstall takes no harness name. */
export async function legacyUninstallCli(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  const flags = new Set(argv.filter((a) => a.startsWith('-')))
  const json = flags.has('--json'), purge = flags.has('--purge-data')
  const say = json ? io.err : io.out // stdout holds the one JSON in --json mode (R5)
  say(LEGACY_NOTE)
  const fs = deps.fs || nodeFs, ms = deps.ms || Date.now, now = deps.now || (() => new Date())
  const sleep = deps.sleep || ((n) => new Promise((resolve) => setTimeout(resolve, n)))
  const world = { home, platform, exec: deps.exec || null, fs, env, mihomo: deps.mihomo || {} }
  const dataNote = purge ? '采集数据(~/.asight/ 顶层的 capture*.ndjson)将删(--purge-data)。' : `采集数据保留在 ${tilde(asightHome(home), home)}/(capture*.ndjson、sessions/、flows/ 等);--purge-data 才删旧采集写的 capture*.ndjson。`
  const receipt = { ...newReceipt('uninstall'), all: true, harnesses: ['claude-code'], undo: ['asight on'], log: legacyEventsFile(home), legacy: true, purge_data: purge, left: [], kept_backups: [], problems: [], notes: [], dropped_backups: [], non_identical: [] }
  const print = (r, o = {}) => io.out(json ? JSON.stringify(r, null, 2) : formatUninstallReceipt(r, { home, dataNote, ...o }))
  try {
    const own = ownFiles({ home, fs, purge })
    if (flags.has('--dry-run') || (purge && !flags.has('--yes'))) {
      const art = await legacyArtifacts(world)
      Object.assign(receipt, legacyPlan(art), { planned: true })
      receipt.removed.push(...own.files, ...own.dirs, backupDir(home), legacyManifestPath(home))
      if (flags.has('--dry-run')) { receipt.dry_run = true; print(receipt); return EXIT.ok }
      if (!isInteractive(io)) { receipt.needs_yes = true; receipt.ok = false; receipt.notes.push('不在终端里,没有 --yes:只打印了计划,什么都没动。确认要删采集数据,就加 --yes 再跑一次'); if (json) print(receipt); else { print({ ...receipt, notes: [] }, { tense: 'future' }); for (const n of receipt.notes) io.err(n) } return EXIT.usage }
      say(formatUninstallReceipt({ ...receipt, notes: [] }, { home, tense: 'future', dataNote }))
      if (!(await confirm({ ...io, prompt: json ? io.stderr : io.stdout }, 'asight 将按上面的计划卸载并删采集数据。继续?'))) { receipt.declined = true; receipt.ok = false; receipt.notes.push('没有确认:什么都没动'); if (json) print(receipt); else for (const n of receipt.notes) io.err(n); return EXIT.incomplete }
      Object.assign(receipt, { changed: [], removed: [], skipped: [], notes: [], planned: false })
    }
    let lock = null
    try { lock = await acquireOpLock({ file: legacyLockPath(home), waitMs: deps.lockWaitMs ?? 10_000, alive: deps.alive, fs, now: ms, sleep }) } catch (e) {
      if (!e || e.code !== LOCK_BUSY) throw e
      receipt.ok = false; receipt.problems.push(errText(e)); receipt.relayed = 'unknown'; receipt.relayed_reason = 'nothing was done'; print(receipt); return EXIT.incomplete
    }
    try {
      const r = await undoLegacy({ ...world, clock: { ms, sleep }, now: deps.now || null, alive: deps.alive || undefined, procs: deps.procs || null, drainMs: deps.drainMs ?? 10000 })
      for (const k of ['changed', 'removed', 'skipped', 'left', 'problems', 'notes', 'restart']) receipt[k] = r[k]
      if (typeof r.cut === 'number') receipt.relayed = { closing: 0, waiting: 0, cut: r.cut }
      else { receipt.relayed = 'unknown'; receipt.relayed_reason = r.cut_reason || '读不到' }
      if (!r.ok) { // 4.6: what could not be undone keeps the ledger and its backups, and asight's own files stay for the next run
        receipt.kept_backups = r.kept_backups
        receipt.problems.push("asight's own files were left in place (the old capture is not all undone): run asight uninstall again")
      } else {
        const rm = (p) => { try { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); receipt.removed.push(p) } } catch (e) { receipt.left.push({ path: p, result: 'error', reason: `${p} could not be removed: ${errText(e)}` }); receipt.problems.push(`${p} could not be removed (${errText(e)}); remove it by hand`) } }
        let ledger = null
        try { ledger = readManifestAt(legacyManifestPath(home), fs) } catch (e) { receipt.notes.push(`the ledger ${legacyManifestPath(home)} could not be read (${errText(e)}); its backups are removed by name, the file is left`) }
        const kept = ledger && !ledger.unsupported ? ledger.kept_backups || [] : []
        for (const k of kept) { try { if (dropBackup(k.backup, fs)) { receipt.dropped_backups.push(k.backup); receipt.non_identical.push({ path: k.path, backup: k.backup, reason: k.reason }) } } catch (e) { receipt.problems.push(`${k.backup}, the backup of ${k.path}, could not be removed (${errText(e)}); remove it by hand`) } }
        for (const b of orphanBackups({ home, manifest: null, fs })) { try { if (dropBackup(b, fs)) receipt.dropped_backups.push(b) } catch (e) { receipt.problems.push(`${b} could not be removed (${errText(e)}); remove it by hand`) } }
        if (!receipt.problems.length) rm(legacyManifestPath(home))
        for (const f of [...own.files, ...own.dirs]) rm(f)
        removeEmptyDirs([backupDir(home), path.dirname(standalonePath(home))], fs)
        if (!receipt.problems.length) removeEmptyDirs([asightHome(home)], fs) // `on` made it; gone only when nothing else lives in it (the captures, the logs)
      }
      receipt.ok = r.ok && !receipt.problems.length && !receipt.left.length
      const outcome = receipt.ok ? 'uninstalled' : 'failed'
      appendLegacyEvent({ event: 'uninstall-note', where: 'uninstall', kind: 'result', outcome, reason: receipt.ok ? `uninstalled: the old capture is out, ${receipt.dropped_backups.length} backup(s) removed` : `uninstall did not finish: ${receipt.problems[0] || 'the old capture is not all undone'}` }, { file: legacyEventsFile(home), now: now(), log: (m) => io.err(m) })
    } finally { lock.release() }
    print(receipt)
    return receipt.ok ? EXIT.ok : EXIT.incomplete
  } catch (e) {
    if (e && e.code === 'ESANDBOX') throw e // a refusal of the test guard is a bug of the test, never "uninstall failed" (0.1 §3)
    if (json) io.out(JSON.stringify({ ...newReceipt('uninstall'), ok: false, notes: [errText(e)] }, null, 2)); else io.err(`asight uninstall: ${errText(e)}`)
    return EXIT.incomplete
  }
}
