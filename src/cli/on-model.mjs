// on-model.mjs — `asight on` on macOS and Windows in the collector model (RFC 1.6 §1.1, 4.11 §1 on / off, §3 ①): the CLI is the one writer.
// In order: the install record (else cert-not-installed, exit 1); the plan — the routes turnOnModel would write, nothing written (--dry-run stops here);
// R6 — a yes only for files beyond the manifest's confirmed_paths (1.6 §1.6), not a terminal and no --yes → exit 2; under op.lock: the autostart unit
// enabled and the daemon up with its endpoint answering (the old on's unit / probe mechanism: unit.enable / unit.start, controlEndpointFor re-resolved
// every probe — control.json appears only at the daemon's first start); then turnOnModel (POST /on, the doors read back, the entries written).
import nodeFs from 'node:fs'
import path from 'node:path'
import { EXIT, newReceipt } from './schema.mjs'
import { isInteractive, confirm as ask } from '../off/io.mjs'
import { controlEndpointFor } from '../off/control-client.mjs'
import { acquireOpLock, LOCK_BUSY } from '../off/lock.mjs'
import { opLockFile } from '../off/paths.mjs'
import { readManifest, saveManifest } from '../collector/core/trust/journal.mjs'
import { appendEvent } from '../collector/core/events.mjs'
import { EVENT } from '../collector/core/codes.mjs'

const errText = (e) => String((e && e.message) || e)
const NEEDS_YES = '不在终端里,没有 --yes:只打印了计划,什么都没改。看过计划之后加 --yes 再跑一次'
const START = 'asight daemon'

/** The daemon up with its endpoint answering (1.6 §1.1「启用自启并拉起守护进程」; 拉起不是重启, R8). → { ok, started, why?, warn? } */
async function ensureDaemon({ unit, autostart, os, dir, env, fs, sleep, put }) {
  let why = null
  const probe = async () => {
    const ep = controlEndpointFor({ platform: os, dir, env, fs })
    if (!ep.socketPath) { why = ep.why; return { up: false } }
    try { await ep.request({ socketPath: ep.socketPath, method: 'GET', path: '/status', timeoutMs: 2000 }); return { up: true } } catch (e) { why = errText(e); return { up: false, stuck: !(e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED')) } }
  }
  const was = await probe()
  if (was.up) { if (unit && autostart) unit.enable({ now: false }); return { ok: true, started: false } }
  if (was.stuck) return { ok: false, why: `a daemon holds the control endpoint but does not answer (${why}); run "asight off", then "asight on"` }
  if (!unit) return { ok: false, why: `没有自启单元,守护进程没在跑:运行 ${START}${why ? `;${why}` : ''}` }
  const rr = autostart ? unit.enable({ now: true }) : unit.start()
  if (rr && rr.code !== 0) {
    const reason = rr.event ? rr.event.reason : `the autostart unit ${unit.path} could not be ${autostart ? 'enabled' : 'started'} (${rr.err || `exit ${rr.code}`}); start the daemon with "${START}"`
    put(rr.event || { event: EVENT.failure, where: 'install', code: 'unit-not-enabled', reason })
    return { ok: false, why: reason }
  }
  for (let i = 0; i < 60; i++) { if ((await probe()).up) return { ok: true, started: true, ...(rr && rr.warn ? { warn: rr.warn } : {}) }; await sleep(250) }
  const reason = `the unit was started, but no daemon answers (${why}); look at ${os === 'darwin' ? 'launchctl print gui/$(id -u)/com.asight.collector' : 'schtasks /Query /TN \\asight\\collector'} and the board's capture health`
  put({ event: EVENT.failure, where: 'start', code: 'start-failed', reason })
  return { ok: false, why: reason }
}

const routeLine = (p) => `  · ${p.harness} · ${p.route}: ${p.kind}${p.paths.length ? ` ${p.paths.join(', ')}` : ''}`
const noteLine = (n) => (n.code === 'install-pending' ? `  · ${n.item}: ${n.state} — ${n.why};再跑一次 ${n.command}` : `  · ${n.harness ? `${n.harness}: ` : ''}${n.text || n.why || n.code}${n.paths && n.paths.length ? ` (${n.paths.join(', ')})` : ''}`)
const refusedLine = (r) => `  · ${r.harness} 没开:${r.reason}${r.path ? ` ${r.path}` : ''};再跑一次 ${r.command}`

/** → the exit code. `parts` is loadParts' view (its arch's unit); `deps`: backends, harnesses, which, exec, now, sleep, fs (0.1 §3). */
export async function runModelOn({ io, env, home, os, deps, parts, flags, ids, json, optIn }) {
  if (optIn.length) { io.err('asight on: --opt-in 在 macOS / Windows 上还没接上集中模型;什么都没改'); return EXIT.usage }
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
    const up = await ensureDaemon({ unit, autostart: !flags.has('--no-autostart'), os, dir, env, fs, sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))), put })
    const r = up.ok ? await turnOnModel(args) : { ...plan, routes: [], problems: [up.why], exit: EXIT.incomplete }
    if (up.warn) r.notes.push({ harness: null, text: up.warn })
    if (r.on.length && up.ok) { const now = readManifest(dir, fs); now.confirmed_paths = [...new Set([...(now.confirmed_paths || []), ...plan.planned.flatMap((p) => p.paths)])]; saveManifest(dir, now, fs) }
    return out(receiptOf(r, { daemon: { state: up.ok ? 'running' : 'not-running', started: !!up.started }, doors: r.doors || {} }), r.exit)
  } finally { lock.release() }
}
