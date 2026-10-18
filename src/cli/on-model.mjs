// on-model.mjs — `asight on` on macOS and Windows in the collector model (RFC 1.6 §1.1, 4.11 §1 on / off, §3 ①): the CLI is the one writer.
// In order: the install record (else cert-not-installed, exit 1); the plan — the routes turnOnModel would write, nothing written (--dry-run stops here);
// R6 — a yes only for files beyond the manifest's confirmed_paths (1.6 §1.6), not a terminal and no --yes → exit 2; under op.lock: the autostart unit
// enabled and the daemon up with its endpoint answering (ensureDaemonUp, install.mjs: the one copy Linux's turnOn uses too; controlEndpointFor re-resolved
// every probe — control.json appears only at the daemon's first start); then turnOnModel (POST /on, the doors read back, the entries written).
import nodeFs from 'node:fs'
import path from 'node:path'
import { EXIT, newReceipt, UNDO_LINE } from './schema.mjs'
import { isInteractive, confirm as ask } from '../off/io.mjs'
import { acquireOpLock, LOCK_BUSY } from '../off/lock.mjs'
import { opLockFile } from '../off/paths.mjs'
import { readManifest, saveManifest } from '../collector/core/trust/journal.mjs'
import { appendEvent } from '../collector/core/events.mjs'
import { fit, tilde, formWords } from './receipt.mjs'
import { pairs } from './text.mjs'

const errText = (e) => String((e && e.message) || e)
const NEEDS_YES = 'Nothing was changed. Read the plan above, then run it again with --yes'

// §1.4「计划写全」: every planned route by the full path (and key) it will write; a route that writes no file of yours says why instead
const planLine = (p, home) => [p.harness, `${p.paths.length ? p.paths.map((x) => tilde(x, home)).join(', ') : `no file of yours: asight hands ${p.harness} the setting as it starts`}${p.keys && p.keys.length ? `: ${p.keys.join('.')}` : ''}`]
const noteLine = (n) => (n.code === 'install-pending' ? `Not done yet: ${n.item} is ${n.state} (${n.why}). Run again: ${n.command}` : `Note: ${n.harness ? `${n.harness}: ` : ''}${n.text || n.why || n.code}${n.paths && n.paths.length ? ` (${n.paths.join(', ')})` : ''}`)
const refusedLine = (r) => `${r.harness} was not turned on: ${r.reason}${r.path ? ` (${r.path})` : ''}. Run: ${r.command}`

/** → the exit code. `parts` is loadParts' view (its arch's unit); `deps`: backends, harnesses, which, exec, now, sleep, fs (0.1 §3). */
export async function runModelOn({ io, env, home, os, deps, parts, flags, ids, json }) {
  const fs = deps.fs || nodeFs
  const say = json ? () => {} : io.out // §1.2: with --json stderr stays empty and the plan is the `planned` key of the one document on stdout (a macOS test machine 2026-10-18: it went to stderr)
  const dir = path.join(home, '.asight', 'collector')
  const put = (rec) => { try { if (fs.existsSync(dir)) appendEvent(dir, rec) } catch { /* the receipt carries it (R11) */ } }
  const [{ turnOnModel }, { backendsFor, sourcesCtx }, { renderHook }] = await Promise.all([import('../collector/model-on.mjs'), import('../collector/arch/model-backends.mjs'), import('../collector/harness/templates/index.mjs')])
  const b = deps.backends || (await backendsFor({ os, home, run: deps.exec || null, env, fs }))
  const ctx = sourcesCtx({ os, home, env, dirs: b.dirs, policy: b.policy, which: deps.which || null, fs })
  const args = { os, home, env, ids, harnesses: deps.harnesses || parts.harnesses, ctx, fs, renderHook, ...(deps.now ? { now: deps.now } : {}) }
  const out = (receipt, exit) => {
    if (json) io.out(JSON.stringify(receipt, null, 2))
    else io.out(fit([receipt.dry_run ? `asight on would start capturing ${receipt.harnesses.join(', ') || 'no agent'}. Nothing was written.`
      : exit === 0 ? `Capturing ${receipt.harnesses.join(', ') || 'no agent'}.${receipt.daemon && receipt.daemon.state === 'running' ? ' The collector is running.' : ''}`
        : `asight on did not finish${receipt.harnesses.length ? ` for all of ${receipt.harnesses.join(', ')}` : ''}. What stopped it is below.`,
      ...receipt.refused.map(refusedLine),
      // §1.1: no two rows the same. One agent with several routes (Claude Code's settings and its config library) said "the setting is in place"
      // twice (a Windows test machine 2026-10-18): the row names the file the setting is in, so each row is the fact it reports
      ...pairs([...new Map((receipt.routes || []).map((r) => {
        const where = r.at ? tilde(r.at, home) : r.route ? formWords(`.${r.route}`) : ''
        return [`${r.harness}|${where}|${r.ok}|${r.reason || ''}`, [r.harness, `${where ? `${where}: ` : ''}${r.ok ? 'the setting is in place' : `not written (${r.reason})`}`]]
      })).values()]),
      ...receipt.notes.map(noteLine), ...receipt.problems.map((p) => `Problem: ${p}`)]).join('\n'))
    return exit
  }
  const receiptOf = (r, extra = {}) => ({ ...newReceipt('on'), ok: r.exit === 0, ...(extra.dry_run || r.code ? {} : { undo: UNDO_LINE.on }), harnesses: r.on, refused: r.refused, routes: r.routes, notes: r.notes, problems: r.problems, ...extra })
  const plan = await turnOnModel({ ...args, dryRun: true })
  // 附录 C.2: a `--dry-run` goes as expected even when the real run would stop before writing — it exits 0, and what would stop it is `blocked`
  // (a Windows test machine 2026-10-18: with nothing installed it exited 1 with a top-level `code` and no `planned`)
  if (plan.code) {
    const blocked = (plan.problems.length ? plan.problems : [plan.code]).map((reason) => ({ what: 'asight on', reason }))
    if (flags.has('--dry-run')) return out(receiptOf({ ...plan, exit: 0 }, { dry_run: true, planned: plan.planned || [], blocked }), EXIT.ok)
    // 附录 C.1: the refusal's code lives in `error` and nowhere else (a dry run carries none: nothing went wrong)
    return out(receiptOf(plan, { blocked, error: { code: plan.code, message: plan.problems[0] || plan.code } }), EXIT.incomplete)
  }
  const m = readManifest(dir, fs)
  const seen = new Set(m.confirmed_paths || [])
  const fresh = [...new Set(plan.planned.flatMap((p) => p.paths))].filter((p) => !seen.has(p))
  say(fit([`asight on will change ${plan.planned.length} setting${plan.planned.length === 1 ? '' : 's'}:`,
    ...pairs(plan.planned.map((p) => planLine(p, home))),
    ...(fresh.length ? [`New since you last said yes: ${fresh.map((x) => tilde(x, home)).join(', ')}`] : [])]).join('\n'))
  if (flags.has('--dry-run')) return out(receiptOf({ ...plan, exit: 0 }, { dry_run: true, planned: plan.planned }), EXIT.ok)
  if (fresh.length && !flags.has('--yes')) {
    if (json || !isInteractive(io)) { if (json) io.out(JSON.stringify({ ...receiptOf({ ...plan, exit: 2 }), ok: false, planned: plan.planned, needs_yes: true, notes: [NEEDS_YES] }, null, 2)); else io.err(NEEDS_YES); return EXIT.usage }
    if (!(await ask({ ...io, prompt: io.stdout }, 'Proceed?'))) { io.err('You said no: nothing was changed'); return EXIT.incomplete }
  }
  let lock
  try { lock = await acquireOpLock({ file: opLockFile(home), waitMs: deps.lockWaitMs ?? 10_000, fs }) } catch (e) { if (e && e.code === LOCK_BUSY) { io.err(`asight on: ${e.message}`); return EXIT.incomplete } throw e }
  try {
    const unit = !parts.arch || !parts.arch.unit || !parts.arch.unit.userUnit ? null : parts.arch.unit.userUnit({ home, node: process.execPath, script: deps.script || process.argv[1], run: deps.exec || null, env, ...(deps.spawn ? { spawn: deps.spawn } : {}) })
    const { ensureDaemonUp } = await import('../collector/install.mjs')
    const up = await ensureDaemonUp({ osName: os, dir, env, fs, unit, autostart: !flags.has('--no-autostart'), put, ...(deps.sleep ? { pause: deps.sleep } : {}) })
    const r = up.up ? await turnOnModel(args) : { ...plan, routes: [], problems: up.problems.length ? up.problems : up.notes, exit: EXIT.incomplete }
    if (up.up) r.notes.push(...up.notes.map((text) => ({ harness: null, text })))
    if (r.on.length && up.up) { const now = readManifest(dir, fs); now.confirmed_paths = [...new Set([...(now.confirmed_paths || []), ...plan.planned.flatMap((p) => p.paths)])]; saveManifest(dir, now, fs) }
    return out(receiptOf(r, { planned: plan.planned, daemon: { state: up.up ? 'running' : 'not-running', started: up.started }, doors: r.doors || {} }), r.exit)
  } finally { lock.release() }
}
