// install.mjs — `asight install [--dry-run] [--yes] [--json]` (RFC 1.6 §1.1, §1.6; 4.11 §1 install; D55). The order is the spec's: refuse root
// before anything is read; refuse a version 1 / 2 manifest before any write (4.11 ⑰); hold op.lock; print the plan and wait for a yes (not a terminal
// and no --yes: the plan only, exit 2); run the install; print the receipt and record it as an `install-note` (R1, D38). Exit 0 all placed · 1 part of
// it, or a refusal · 2 usage, or no terminal without --yes. macOS / Windows run the collector model (src/collector/model-install.mjs); Linux keeps
// its own install. The world is `deps` (0.1 §3): getuid, fs, exec, backends, harnesses, which, now, lockWaitMs.
import nodeOs from 'node:os'
import nodeFs from 'node:fs'
import path from 'node:path'
import { EXIT, newReceipt } from '../off/schema.mjs'
import { refuseOldManifest } from '../off/manifest.mjs'
import { acquireOpLock, LOCK_BUSY } from '../off/lock.mjs'
import { opLockFile, standalonePath } from '../off/paths.mjs'
import { isInteractive, confirm } from '../off/io.mjs'
import { appendEvent } from '../collector/core/events.mjs'
import { EVENT } from '../collector/core/codes.mjs'

const NEEDS_YES = '不在终端里,没有 --yes:只打印了计划,什么都没改。看过计划之后加 --yes 再跑一次'
// R5 / R6: no terminal and no --yes — the plan was printed, nothing written, exit 2; with --json stdout is the one receipt that says so
function needsYes(io, json) {
  if (json) io.out(JSON.stringify({ ...newReceipt('install'), ok: false, planned: true, needs_yes: true, notes: [NEEDS_YES] }, null, 2)); else io.err(NEEDS_YES)
  return EXIT.usage
}
const USAGE = 'usage: asight install [--dry-run] [--yes] [--json]'
const FLAGS = new Set(['--dry-run', '--yes', '--json'])
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)
// 1.6 §1.6: the two lines every plan prints — D55's cost, and on macOS / Windows the same-user residual risk (4.11 §1 install)
const COST = '证书在时,本用户所有读系统信任库或读这些变量的程序都信任这张 CA,直到 `asight uninstall`'
const RISK = '本用户名下的任何程序都能借 asight 的签名助手(macOS)或直接调用这把密钥(Windows)签出被信任的证书,也能删掉它,只是拿不走私钥;怀疑被用过时,uninstall 再 install'

export async function runInstallCli(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  const flags = new Set()
  for (const a of argv) { if (!FLAGS.has(a)) { io.err(`asight install: ${a.startsWith('-') ? `unknown option ${a}` : 'install takes no harness names (it installs for every harness found, D55⑥)'}\n${USAGE}`); return EXIT.usage } flags.add(a) }
  const json = flags.has('--json')
  const say = json ? io.err : io.out
  if ((deps.getuid || processUid)() === 0) { io.err('asight install: 用你自己的账号跑,不要用 root / sudo(每一项都是用户级,D55②)'); return EXIT.incomplete }
  const fs = deps.fs || nodeFs
  const old = refuseOldManifest({ home, platform, fs })
  if (old) { if (json) io.out(JSON.stringify({ ...newReceipt('install'), ok: false, notes: [old.message] }, null, 2)); else io.err(`asight install: ${old.message}`); return EXIT.incomplete }
  const { isModelOs } = await import('../collector/model-install.mjs')
  const model = isModelOs(platform)
  // R12: the writes run under op.lock, taken after the yes (a plan that is only printed takes nothing and writes nothing)
  const locked = async (fn) => {
    let lock
    try { lock = await acquireOpLock({ file: opLockFile(home), waitMs: deps.lockWaitMs ?? 10_000, fs }) } catch (e) {
      if (e && e.code === LOCK_BUSY) { io.err(`asight install: ${e.message}`); return null }
      throw e
    }
    try { return await fn() } finally { lock.release() }
  }
  {
    if (!model) return await linuxInstall({ io, env, home, platform, deps, flags, json, say, fs, locked })
    const { backendsFor, sourcesCtx, ownsBy } = await import('../collector/arch/model-backends.mjs')
    const { runInstall, planInstall } = await import('../collector/model-install.mjs')
    const { renderHook } = await import('../collector/harness/templates/index.mjs')
    const b = deps.backends || await backendsFor({ os: platform, home, run: deps.exec || null, env, fs })
    const harnesses = deps.harnesses || await (await import('../collector/harness/index.mjs')).loadHarnesses()
    const ctx = sourcesCtx({ os: platform, home, env, dirs: b.dirs, policy: b.policy, which: deps.which || null, fs })
    const rows = planInstall({ os: platform, harnesses, ctx })
    // the autostart unit is install's, inert until `on` enables it (4.11 §1 install d; 4.9 §4, 4.8 §7): the arch's unit, or the test's `deps.unit`
    const unit = deps.unit !== undefined ? deps.unit : (await (await import('../collector/daemon.mjs')).loadArch(platform)).unit.userUnit({ home, node: process.execPath, script: deps.script || process.argv[1], run: deps.exec || null, env })
    say(['asight install 的计划:', '  · 生成本机的 asight 根(私钥不能导出),装成用户级根证书(系统会弹一次框,等 120 秒)',
      ...rows.map((r) => `  · ${r.harness} · ${r.form}: ${r.carrier === 'root' ? '靠用户级根' : `证书载体 ${r.carrier}`}`),
      ...(rows.length ? [] : ['  · 本机没找到任何 harness 的形态:只装根']),
      `  · 独立撤销程序 ${standalonePath(home)}`, `代价:${COST}`, `剩余风险:${RISK}`].join('\n'))
    if (flags.has('--dry-run')) { if (json) io.out(JSON.stringify({ ...newReceipt('install'), dry_run: true, planned: rows }, null, 2)); return EXIT.ok }
    if (!flags.has('--yes')) {
      if (!isInteractive(io)) return needsYes(io, json)
      if (!(await confirm({ ...io, prompt: json ? io.stderr : io.stdout }, 'asight 将按上面的计划安装。继续?'))) { io.err('没有确认:什么都没改'); return EXIT.incomplete }
    }
    const r = await locked(() => runInstall({ os: platform, home, env, harnesses, custody: b.custody, rootStore: b.rootStore, installHelper: b.installHelper, interactive: isInteractive(io),
      wrapperKit: b.wrapperKit, facts: b.facts, ctx, unit, owns: deps.owns || ownsBy({ os: platform, home, fs }), renderHook, fs, ...(deps.now ? { now: deps.now } : {}) }))
    if (!r) return EXIT.incomplete
    const receipt = { ...newReceipt('install'), ok: r.exit === 0, fp256: r.fp256, items: r.items, carriers: r.carriers, pending: r.pending, problems: r.problems, standalone: standalonePath(home), residual_risk: RISK,
      commands: ['asight on', 'asight off', 'asight status', 'asight uninstall'] }
    const dir = path.join(home, '.asight', 'collector')
    try { appendEvent(dir, { event: EVENT.installNote, where: 'install', kind: 'result', outcome: receipt.ok ? 'installed' : 'partial', reason: `install: root ${r.fp256 || 'not made'}; ${r.carriers.length} carrier row(s); ${r.pending.length} pending` }) } catch (e) { r.problems.push(`the install-note could not be written (${e.message})`) }
    if (json) io.out(JSON.stringify(receipt, null, 2))
    else io.out([`asight install ${receipt.ok ? '完成' : '没有全部完成'}。根的指纹 ${r.fp256 || '(没有生成)'}`,
      ...r.carriers.map((c) => `  · ${c.harness}${c.form ? ` · ${c.form}` : ''}: ${c.carrier}${c.state ? ` ${c.state}` : ''}${c.code ? ` (${c.code}: ${c.why})` : ''}${c.path ? ` ${c.path}` : ''}`),
      ...r.pending.map((p) => `  · ${p.item}: ${p.state} — ${p.reason};再跑一次 asight install`), ...r.problems.map((p) => `  问题: ${p}`),
      `剩余风险:${RISK}`, `开 asight on · 关 asight off · 状态 asight status · 卸载 asight uninstall · 独立撤销 ${standalonePath(home)}`].join('\n'))
    return r.exit
  }
}

// Linux (override #15; 1.6 §1.6 步骤): the CA (ca/ca.key, 0600, made here and nowhere else), asight's own files (asight-ca.pem, the combined bundles, the
// (d)-level plugins) and the (c)-level config keys — every item phase 'install', as `on` wrote them before — plus asight-off and the liveness record.
// No unit, no state, no daemon: those are `on`'s. The plan printed is the one `on` used to print (formatPlan) with D55's cost line.
async function linuxInstall({ io, env, home, platform, deps, flags, json, say, fs, locked }) {
  const { readAgentList } = await import('../off/identity.mjs')
  const { writeStandalone, buildStandalone } = await import('../off/standalone.mjs')
  const { formatPlan, changeLines } = await import('./receipt.mjs')
  const { OFF_VERSION } = await import('../off/manifest.mjs')
  const parts = deps.parts || await (await import('../collector/daemon.mjs')).loadParts({ env, agentList: readAgentList({ home, fs }).entries })
  const inst = await import('../collector/install.mjs')
  const args = { home, env, osName: parts.os, harnesses: parts.harnesses, scan: parts.scan, match: parts.match, arch: parts.arch || null, roots: deps.roots || null, fs, ...(deps.freePort ? { freePort: deps.freePort } : {}), ...(deps.now ? { now: deps.now } : {}) }
  let plan
  try { plan = await inst.planOn(args) } catch (e) { io.err(`asight install 没有做:${String((e && e.message) || e)}。什么都没改`); return EXIT.incomplete } // a plan that cannot be made (an OS bundle that cannot be read, D38) is said, never a stack
  // asight-off (R3) is install's: named in the plan and the dry run when this run would write it, i.e. when it is not already what src/off generates
  const stdPath = standalonePath(home)
  let stdNew = true
  try { stdNew = fs.readFileSync(stdPath, 'utf8') !== buildStandalone({ version: OFF_VERSION, fs }) } catch { stdNew = true }
  say(`${formatPlan({ ...plan, adopted: [], standalone: stdNew ? stdPath : null }, { home, autostart: false, platform, command: 'install' })}\n代价:${COST}`)
  if (flags.has('--dry-run')) { if (json) io.out(JSON.stringify({ ...newReceipt('install'), dry_run: true, harnesses: plan.targets, changed: plan.changed, created: [...(stdNew ? [stdPath] : []), ...plan.created] }, null, 2)); return EXIT.ok }
  if ((plan.writing || stdNew) && !flags.has('--yes')) {
    if (!isInteractive(io)) return needsYes(io, json)
    if (!(await confirm({ ...io, prompt: json ? io.stderr : io.stdout }, 'asight 将按上面的计划安装。继续?'))) { io.err('没有确认:什么都没改'); return EXIT.incomplete }
  }
  // the undo that needs no source tree comes before the first thing it undoes (R3): a copy that cannot be written stops the install here, with a failure line (R11)
  const done = await locked(async () => {
    let stdl
    try { stdl = writeStandalone({ home, version: OFF_VERSION, fs }) } catch (e) {
      const reason = `${stdPath}, the undo that works without the source tree, could not be written (${String((e && e.message) || e)}); no file of the agents' was changed — put that right, then run asight install again`
      try { appendEvent(path.join(home, '.asight', 'collector'), { event: EVENT.failure, where: 'install', code: (e && e.code) || 'install-error', reason }) } catch {}
      return { failed: reason }
    }
    return { stdl, r: await inst.installCollector({ ...args, onPlan: () => {} }) }
  })
  if (!done) return EXIT.incomplete
  if (done.failed) { if (json) io.out(JSON.stringify({ ...newReceipt('install'), ok: false, notes: [done.failed] }, null, 2)); else io.err(`asight install: ${done.failed}`); return EXIT.incomplete }
  const { stdl, r } = done
  const receipt = { ...newReceipt('install'), ok: true, harnesses: r.manifest.install ? r.manifest.install.harnesses : [], changed: r.already ? [] : plan.changed.map((c) => ({ ...c, backup: (r.manifest.entries.find((e) => e.path === c.path) || {}).backup ?? null })), created: [...(stdl.written ? [stdl.path] : []), ...(r.already ? [] : plan.created)], standalone: standalonePath(home), commands: ['asight on', 'asight off', 'asight status', 'asight uninstall'], notes: r.plan ? r.plan.notes : [] }
  if (json) io.out(JSON.stringify(receipt, null, 2))
  else io.out([`asight install ${r.already ? '已经装好,什么都没改' : '完成'}。`, ...(r.already ? [] : changeLines(receipt, { home })), ...receipt.notes.map((n) => `  · ${n}`), `开 asight on · 关 asight off · 状态 asight status · 卸载 asight uninstall · 独立撤销 ${standalonePath(home)}`].join('\n'))
  return EXIT.ok
}
