// on-model.mjs — `asight on` on macOS and Windows in the collector model (RFC 1.6 §1.1, 4.11 §1 on / off, §3 ①): the CLI is the one writer.
// In order: the install record (else cert-not-installed, exit 1); the plan — the routes turnOnModel would write, nothing written (--dry-run stops here);
// R6 — a yes only for files beyond the manifest's confirmed_paths (1.6 §1.6), not a terminal and no --yes → exit 2; under op.lock: the autostart unit
// enabled and the daemon up with its endpoint answering (ensureDaemonUp, install.mjs: the one copy Linux's turnOn uses too; controlEndpointFor re-resolved
// every probe — control.json appears only at the daemon's first start); then turnOnModel (POST /on, the doors read back, the entries written).
import nodeFs from 'node:fs'
import path from 'node:path'
import { EXIT, newReceipt } from './schema.mjs'
import { isInteractive, confirm as ask } from '../off/io.mjs'
import { acquireOpLock, LOCK_BUSY } from '../off/lock.mjs'
import { opLockFile } from '../off/paths.mjs'
import { readManifest, saveManifest } from '../collector/core/trust/journal.mjs'
import { appendEvent } from '../collector/core/events.mjs'

const errText = (e) => String((e && e.message) || e)
const NEEDS_YES = '不在终端里,没有 --yes:只打印了计划,什么都没改。看过计划之后加 --yes 再跑一次'

const routeLine = (p) => `  · ${p.harness} · ${p.route}: ${p.kind}${p.paths.length ? ` ${p.paths.join(', ')}` : ''}`
const noteLine = (n) => (n.code === 'install-pending' ? `  · ${n.item}: ${n.state} — ${n.why};再跑一次 ${n.command}` : `  · ${n.harness ? `${n.harness}: ` : ''}${n.text || n.why || n.code}${n.paths && n.paths.length ? ` (${n.paths.join(', ')})` : ''}`)
const refusedLine = (r) => `  · ${r.harness} 没开:${r.reason}${r.path ? ` ${r.path}` : ''};再跑一次 ${r.command}`

/** → the exit code. `parts` is loadParts' view (its arch's unit); `deps`: backends, harnesses, which, exec, now, sleep, fs (0.1 §3). */
export async function runModelOn({ io, env, home, os, deps, parts, flags, ids, json }) {
  const fs = deps.fs || nodeFs
  const say = json ? io.err : io.out
  const dir = path.join(home, '.asight', 'collector')
  const put = (rec) => { try { if (fs.existsSync(dir)) appendEvent(dir, rec) } catch { /* the receipt carries it (R11) */ } }
  const [{ turnOnModel }, { backendsFor, sourcesCtx }, { renderHook }] = await Promise.all([import('../collector/model-on.mjs'), import('../collector/arch/model-backends.mjs'), import('../collector/harness/templates/index.mjs')])
  const b = deps.backends || (await backendsFor({ os, home, run: deps.exec || null, env, fs }))
  const ctx = sourcesCtx({ os, home, env, dirs: b.dirs, policy: b.policy, which: deps.which || null, fs })
  const args = { os, home, env, ids, harnesses: deps.harnesses || parts.harnesses, ctx, fs, renderHook, ...(deps.now ? { now: deps.now } : {}) }
  const out = (receipt, exit) => {
    if (json) io.out(JSON.stringify(receipt, null, 2))
    else io.out([`asight on ${receipt.dry_run ? '的计划(什么都没写)' : exit === 0 ? '完成' : '没有全部完成'}${receipt.harnesses.length ? `:${receipt.harnesses.join(', ')}` : ''}`,
      ...receipt.refused.map(refusedLine), ...(receipt.routes || []).map((r) => `  · ${r.harness} · ${r.route}: ${r.ok ? '入口已写' : `没写(${r.code}: ${r.reason})`}`),
      ...receipt.notes.map(noteLine), ...receipt.problems.map((p) => `  问题: ${p}`)].join('\n'))
    return exit
  }
  const receiptOf = (r, extra = {}) => ({ ...newReceipt('on'), ok: r.exit === 0, harnesses: r.on, refused: r.refused, routes: r.routes, notes: r.notes, problems: r.problems, ...(r.code ? { code: r.code } : {}), ...extra })
  const plan = await turnOnModel({ ...args, dryRun: true })
  if (plan.code) return out(receiptOf(plan), EXIT.incomplete)
  const m = readManifest(dir, fs)
  const seen = new Set(m.confirmed_paths || [])
  const fresh = [...new Set(plan.planned.flatMap((p) => p.paths))].filter((p) => !seen.has(p))
  say(['asight on 的计划:', ...plan.planned.map(routeLine), ...(fresh.length ? [`  这次新要改的文件:${fresh.join(', ')}`] : [])].join('\n'))
  if (flags.has('--dry-run')) return out(receiptOf({ ...plan, exit: 0 }, { dry_run: true, planned: plan.planned }), EXIT.ok)
  if (fresh.length && !flags.has('--yes')) {
    if (!isInteractive(io)) { io.err(NEEDS_YES); return EXIT.usage }
    if (!(await ask({ ...io, prompt: json ? io.stderr : io.stdout }, 'asight 将按上面的清单写或改这些文件。继续?'))) { io.err('没有确认:什么都没改'); return EXIT.incomplete }
  }
  let lock
  try { lock = await acquireOpLock({ file: opLockFile(home), waitMs: deps.lockWaitMs ?? 10_000, fs }) } catch (e) { if (e && e.code === LOCK_BUSY) { io.err(`asight on: ${e.message}`); return EXIT.incomplete } throw e }
  try {
    const unit = flags.has('--no-unit') || !parts.arch || !parts.arch.unit || !parts.arch.unit.userUnit ? null : parts.arch.unit.userUnit({ home, node: process.execPath, script: deps.script || process.argv[1], run: deps.exec || null, env })
    const { ensureDaemonUp } = await import('../collector/install.mjs')
    const up = await ensureDaemonUp({ osName: os, dir, env, fs, unit, autostart: !flags.has('--no-autostart'), put, ...(deps.sleep ? { pause: deps.sleep } : {}) })
    const r = up.up ? await turnOnModel(args) : { ...plan, routes: [], problems: up.problems.length ? up.problems : up.notes, exit: EXIT.incomplete }
    if (up.up) r.notes.push(...up.notes.map((text) => ({ harness: null, text })))
    if (r.on.length && up.up) { const now = readManifest(dir, fs); now.confirmed_paths = [...new Set([...(now.confirmed_paths || []), ...plan.planned.flatMap((p) => p.paths)])]; saveManifest(dir, now, fs) }
    return out(receiptOf(r, { daemon: { state: up.up ? 'running' : 'not-running', started: up.started }, doors: r.doors || {} }), r.exit)
  } finally { lock.release() }
}
