// legacy-cli.mjs (src/off) — `asight off` on a platform without the new collector (RFC 1.6 §4): the old capture is what it takes out. The argument handling, the lock, the plan of `--dry-run`, the
// receipt and the exit code live here; what it does is src/off/legacy.mjs `undoLegacy`. `asight off` (src/off/main.mjs) and the standalone `~/.asight/bin/asight-off` run this same file, so it imports
// only node:* and src/off (0.1 §2). The exit codes are R4's: 0 done · 1 not done or a problem (the Clash route could not be confirmed gone, a file could not be undone) · 2 usage error, nothing touched
// (a harness other than claude-code: there is no per-harness switch here). Everything the world gives is a `deps` entry a test replaces (0.1 §3): `exec` `fs` `now` `ms` `sleep` `alive` `procs`
// `mihomo` `drainMs` `getuid`.
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import { EXIT, newReceipt } from './schema.mjs'
import { acquireOpLock, LOCK_BUSY } from './lock.mjs'
import { identityFor } from './proc.mjs'
import { legacyLockPath, legacyEventsFile, asightHome } from './paths.mjs'
import { removeEmptyDirs } from './fsutil.mjs'
import { formatOffReceipt } from './receipt.mjs'
import { legacyArtifacts, undoLegacy, LEGACY_NOTE } from './legacy.mjs'

const LEGACY_SINGLE_HARNESS = '本平台只有 claude-code 的旧采集,没有按 harness 的开关'
const LEGACY_LOCK_WAIT_MS = 10_000 // 1.6 R12

/** The harness names given to a command on a platform without the new collector, `ids` being `null` (none) or the resolved code ids → null when they are acceptable, else the message (exit 2). Only
 *  claude-code has an old capture; naming it is the same as naming nothing. */
export const legacyNamesProblem = (ids) => (ids && !(ids.length === 1 && ids[0] === 'claude-code') ? LEGACY_SINGLE_HARNESS : null)

/** What `off` would take out, from a read of the machine (`--dry-run`): the rows of a receipt in the future tense. Reads only. */
export function legacyPlan(art) {
  const rows = { changed: [], removed: [], skipped: [], notes: [] }
  const p = art.paths
  if (art.ccSteer.stash !== null) rows.changed.push({ path: p.settingsPath, change: '去掉 env.HTTPS_PROXY / NO_PROXY(旧 CC-CLI steer,按暂存值还原)', backup: null, result: 'old-command', harness: 'claude-code' })
  const cb = art.clashBlock
  if (cb.script !== false) rows.changed.push({ path: p.scriptPath, change: cb.script === null ? 'Script.js 读不出来:不知道有没有 asight 的块' : '去掉 asight 的 Clash 哨兵块', backup: null, result: 'old-command', harness: 'claude-code' })
  if (cb.runtime) rows.notes.push(`Clash 的运行时配置里有 asight 的路由:会去掉、热重载,并向 mihomo 核对`)
  if (cb.merge) rows.changed.push({ path: p.mergePath, change: '去掉旧的 prepend-proxies / prepend-rules 残留', backup: null, result: 'old-command', harness: 'claude-code' })
  for (const a of Object.values(art.agents)) if (a.installed === true || a.loaded === true) rows.removed.push(a.plistPath)
  if (art.envValue.value) rows.notes.push(`登录环境里 NODE_EXTRA_CA_CERTS = ${art.envValue.value}:只有它指向 asight 的 CA 时才 launchctl unsetenv`)
  if (art.oldCa.present === true) rows.notes.push(`用户级信任库里的旧 CA(${art.oldCa.where === 'keychain' ? '登录钥匙串' : '用户 NSS 库'})会去掉`)
  if (art.ledger && art.ledger.manifest) rows.notes.push(`asight on 记的账 ${art.ledger.path}(${(art.ledger.manifest.entries || []).length} 项)会按它撤,撤完删备份`)
  return rows
}

/** `asight off [claude-code] [--now] [--dry-run] [--json] [--yes] [--remove-ca]` where the old capture is what `on` drives. `argv` is what follows `off`; `ids` the harness names resolved by the caller
 *  (null: none given). → the exit code. */
export async function legacyOffCli(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {}, ids = null } = {}) {
  const flags = new Set(argv.filter((a) => a.startsWith('-')))
  const json = flags.has('--json')
  const say = json ? io.err : io.out // stdout holds the one JSON in --json mode (R5)
  const problem = legacyNamesProblem(ids)
  if (problem) { io.err(`asight off: ${problem}`); return EXIT.usage }
  say(LEGACY_NOTE)
  const fs = deps.fs || nodeFs
  const ms = deps.ms || Date.now
  const sleep = deps.sleep || ((n) => new Promise((resolve) => setTimeout(resolve, n)))
  const world = { home, platform, exec: deps.exec || null, fs, env, mihomo: deps.mihomo || {} }
  const receipt = { ...newReceipt('off'), all: true, harnesses: ['claude-code'], undo: ['asight on'], log: legacyEventsFile(home), legacy: true, left: [], kept_backups: [], problems: [], notes: [] }
  try {
    if (flags.has('--dry-run')) {
      const art = await legacyArtifacts(world)
      Object.assign(receipt, legacyPlan(art), { dry_run: true, planned: true })
      io.out(json ? JSON.stringify(receipt, null, 2) : formatOffReceipt(receipt, { home, tense: 'future' }))
      return EXIT.ok
    }
    const homeThere = fs.existsSync(asightHome(home)) // taking the lock makes ~/.asight; on a machine that never had asight it must not be left behind, empty
    let lock = null
    try { lock = await acquireOpLock({ file: legacyLockPath(home), waitMs: deps.lockWaitMs ?? LEGACY_LOCK_WAIT_MS, alive: deps.alive, identity: deps.identity || identityFor({ platform, exec: deps.exec || null, env }), fs, now: ms, sleep }) } catch (e) {
      if (!e || e.code !== LOCK_BUSY) throw e
      receipt.ok = false; receipt.problems.push(String(e.message)); receipt.relayed = 'unknown'; receipt.relayed_reason = 'nothing was done'
      io.out(json ? JSON.stringify(receipt, null, 2) : formatOffReceipt(receipt, { home }))
      return EXIT.incomplete
    }
    try {
      const r = await undoLegacy({ ...world, clock: { ms, sleep }, now: deps.now || null, alive: deps.alive || undefined, procs: deps.procs || null, drainMs: deps.drainMs ?? 10000 })
      for (const k of ['changed', 'removed', 'skipped', 'left', 'kept_backups', 'problems', 'notes', 'restart']) receipt[k] = r[k]
      receipt.ok = r.ok
      if (typeof r.cut === 'number') receipt.relayed = { closing: 0, waiting: 0, cut: r.cut }
      else { receipt.relayed = 'unknown'; receipt.relayed_reason = r.cut_reason || '读不到' }
      if (flags.has('--now')) receipt.notes.push('--now 在旧采集上没有用:旧 MITM 收到 SIGTERM 后自己排空,在途连接最多等 10 s,余下的切断并计数')
      if (!r.changed.length && !r.removed.length && r.ok) { receipt.notes.push('没有旧采集的东西可撤:这台机器上没有 asight 的旧 steer、Clash 块、LaunchAgent 或旧 CA'); receipt.nothing_installed = true } // and says it first, not "asight 已关闭采集" (audit semantics 7)
    } finally { lock.release(); if (!homeThere) removeEmptyDirs([asightHome(home)], fs) }
    io.out(json ? JSON.stringify(receipt, null, 2) : formatOffReceipt(receipt, { home, cutNote: '(旧 MITM:在途连接最多等 10 s,余下的随卸载切断)' }))
    return receipt.ok ? EXIT.ok : EXIT.incomplete
  } catch (e) {
    if (e && e.code === 'ESANDBOX') throw e // a refusal of the test guard is a bug of the test, never "off failed" (0.1 §3)
    const message = String((e && e.message) || e)
    if (json) io.out(JSON.stringify({ ...newReceipt('off'), ok: false, notes: [message] }, null, 2)); else io.err(`asight off: ${message}`)
    return EXIT.incomplete
  }
}

