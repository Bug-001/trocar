// on-model.mjs — `trocar on` on macOS and Windows in the collector model (RFC 1.6 §1.1, 4.11 §1 on / off, §3 ①): the CLI is the one writer.
// In order: the install record (else cert-not-installed, exit 1); the plan — the routes turnOnModel would write, nothing written (--dry-run stops here);
// R6 — a yes only for files beyond the manifest's confirmed_paths (1.6 §1.6), not a terminal and no --yes → exit 2; under op.lock: the daemon up with
// its endpoint answering, the login registration untouched (D61: it is install's) (ensureDaemonUp, install.mjs: the one copy Linux's turnOn uses too; controlEndpointFor re-resolved
// every probe — control.json appears only at the daemon's first start); then turnOnModel (POST /on, the doors read back, the entries written).
import nodeFs from 'node:fs'
import path from 'node:path'
import { EXIT, newReceipt, UNDO_LINE } from './schema.mjs'
import { isInteractive, confirm as ask } from '../off/io.mjs'
import { acquireOpLock, LOCK_BUSY } from '../off/lock.mjs'
import { primeProcQuestions } from '../off/proc.mjs'
import { opLockFile } from '../off/paths.mjs'
import { readManifest, saveManifest } from '../collector/core/trust/journal.mjs'
import { appendEvent } from '../collector/core/events.mjs'
import { fit, tilde, formWords, pathList } from './receipt.mjs'
import { pairs } from './text.mjs'

const errText = (e) => String((e && e.message) || e)
const NEEDS_YES = 'Nothing was changed. Read the plan above, then run it again with --yes'

// §1.4「计划写全」: every planned route by the full path (and key) it will write; a route that writes no file of yours says why instead
const planLine = (p, home) => [p.harness, `${p.paths.length ? p.paths.map((x) => tilde(x, home)).join(', ') : `no file of yours: trocar hands ${p.harness} the setting as it starts`}${p.keys && p.keys.length ? `: ${p.keys.join('.')}` : ''}`]
const noteLine = (n) => (n.code === 'install-pending' ? `Not done yet: ${n.item} is ${n.state} (${n.why}). Run again: ${n.command}` : `Note: ${n.harness ? `${n.harness}: ` : ''}${n.text || n.why || n.code}${n.paths && n.paths.length ? ` (${n.paths.join(', ')})` : ''}`)
// 1.6 §3.3: a harness that needs setup — the fix is two commands, never the code (§1.1)
const refusedLine = (r) => `${r.harness} was not turned on: ${r.why}. Run: ${r.command}, then: trocar on ${r.harness}`
/** 1.6 §3.3 (D65④): the harnesses `on` refused because their setup is needed — `blocked` of a dry run, `error` of a real one (exit 1). */
const setupBlocked = (r) => r.refused.filter((x) => x.reason === 'setup-needed').map((x) => ({ what: x.harness, reason: x.why }))
const setupError = (b) => ({ code: 'setup-needed', message: `${b.map((x) => x.what).join(', ')} ${b.length === 1 ? 'is' : 'are'} not set up for capture; run trocar install, then trocar on again` })

/** → the exit code. `source`: added to each flows/ record this run writes (the board's 'board'). `parts` is loadParts' view (its arch's unit); `deps`: backends, harnesses, which, exec, now, sleep, fs (0.1 §3). */
export async function runModelOn({ io, env, home, os, deps, parts, flags, ids, json, source }) {
  const fs = deps.fs || nodeFs
  const say = json ? () => {} : io.out // §1.2: with --json stderr stays empty and the plan is the `planned` key of the one document on stdout (a macOS test machine 2026-10-18: it went to stderr)
  const dir = path.join(home, '.trocar', 'collector')
  const run = new Date().toISOString() // on every line this run writes, so the board's "last on" is this run's lines (as install's, 1.6 §1)
  const put = (rec) => { try { if (fs.existsSync(dir)) appendEvent(dir, { ...rec, run, ...(source ? { source } : {}) }) } catch { /* the receipt carries it (R11) */ } }
  const [{ turnOnModel }, { backendsFor, sourcesCtx }, { renderHook }] = await Promise.all([import('../collector/model-on.mjs'), import('../collector/arch/model-backends.mjs'), import('../collector/harness/templates/index.mjs')])
  const b = deps.backends || (await backendsFor({ os, home, run: deps.exec || null, env, fs }))
  const ctx = sourcesCtx({ os, home, env, dirs: b.dirs, policy: b.policy, which: deps.which || null, fs })
  const args = { os, home, env, ids, harnesses: deps.harnesses || parts.harnesses, ctx, fs, renderHook, rootStore: b.rootStore || null, source, ...(deps.now ? { now: deps.now } : {}) }
  const out = (receipt, exit) => {
    if (json) io.out(JSON.stringify(receipt, null, 2))
    else io.out(fit([receipt.dry_run ? `trocar on would start capturing ${receipt.harnesses.join(', ') || 'no agent'}. Nothing was written.`
      : exit === 0 ? `Capturing ${receipt.harnesses.join(', ') || 'no agent'}.${receipt.daemon && receipt.daemon.state === 'running' ? ' The collector is running.' : ''}`
        : `trocar on did not finish${receipt.harnesses.length ? ` for all of ${receipt.harnesses.join(', ')}` : ''}. What stopped it is below.`,
      ...receipt.refused.map(refusedLine),
      // §1.1: no two rows the same. One agent with several routes (Claude Code's settings and its config library) said "the setting is in place"
      // twice (a Windows test machine 2026-10-18): the row names the file the setting is in, so each row is the fact it reports
      ...pairs([...new Map((receipt.routes || []).map((r) => {
        const where = r.at ? tilde(r.at, home) : r.route ? formWords(`.${r.route}`) : ''
        return [`${r.harness}|${where}|${r.ok}|${r.reason || ''}`, [r.harness, `${where ? `${where}: ` : ''}${r.ok ? 'the setting is in place' : `not written (${r.reason})`}`]]
      })).values()]),
      ...receipt.notes.map(noteLine), ...receipt.problems.map((p) => `Problem: ${p}`)], { home }).join('\n'))
    return exit
  }
  /** 1.6 §1: a real run leaves its receipt in flows/ — its notes, then one `kind:'result'` line with the harnesses it turned on (`on`: turnOnModel's
   *  own list, [] on every path that stops before it runs — the plan's list names what it meant to do, not what it did) and the ones it refused;
   *  a failed run too. Then the receipt goes out. (A dry run, and a run that stops for a yes, changed nothing and say so on stdout only.) */
  const done = (receipt, exit, on = []) => {
    for (const n of receipt.notes || []) put({ event: 'install-note', where: 'install', kind: 'note', harness: (n && n.harness) || null, reason: typeof n === 'string' ? n : noteLine(n) })
    const why = (receipt.error && receipt.error.message) || (receipt.problems || [])[0] || null
    put({ event: 'install-note', where: 'install', kind: 'result', outcome: exit === 0 ? 'on' : 'failed', harnesses: on, refused: (receipt.refused || []).map((x) => x.harness),
      reason: exit === 0 ? `on: ${on.join(', ') || 'no agent'}` : `on did not finish${why ? `: ${why}` : ''}` })
    return out(receipt, exit)
  }
  // 附录 C.1: `undo` is the one line that undoes THIS run, and `null` when nothing was changed — a refusal (its code in `error`, or `r.code`) changed nothing, and neither did a dry run (tested on macOS and Windows 2026-10-19)
  const receiptOf = (r, extra = {}) => ({ ...newReceipt('on'), ok: r.exit === 0, ...(extra.dry_run || r.code || extra.error ? {} : { undo: UNDO_LINE.on }), harnesses: r.on, refused: r.refused, routes: r.routes, notes: r.notes, problems: r.problems, ...extra })
  const { autostartBlock, AUTOSTART_MISSING, ensureDaemonUp } = await import('../collector/install.mjs')
  const plan = await turnOnModel({ ...args, dryRun: true })
  const unit = !parts.arch || !parts.arch.unit || !parts.arch.unit.userUnit ? null : parts.arch.unit.userUnit({ home, node: process.execPath, script: deps.script || process.argv[1], run: deps.exec || null, env, ...(deps.spawn ? { spawn: deps.spawn } : {}) })
  // 附录 C.2: a `--dry-run` goes as expected even when the real run would stop before writing — it exits 0, and what would stop it is `blocked`
  // (a Windows test machine 2026-10-18: with nothing installed it exited 1 with a top-level `code` and no `planned`)
  if (plan.code) {
    const blocked = (plan.problems.length ? plan.problems : [plan.code]).map((reason) => ({ what: 'trocar on', reason }))
    if (flags.has('--dry-run')) return out(receiptOf({ ...plan, exit: 0 }, { dry_run: true, planned: plan.planned || [], blocked }), EXIT.ok)
    // 附录 C.1: the refusal's code lives in `error` and nowhere else (a dry run carries none: nothing went wrong)
    return done(receiptOf(plan, { blocked, error: { code: plan.code, message: plan.problems[0] || plan.code } }), EXIT.incomplete)
  }
  // D61 / 1.6 §3.3: the login entry is `install`'s, and an `on` with none would point the agents at doors nobody opens after the next
  // login — so it is asked here, before the first write, and refused (exit 2, nothing written). A `--dry-run` says it in `blocked` and exits 0.
  const autostartBlk = autostartBlock({ unit, osName: os })
  if (autostartBlk) {
    const blocked = [{ what: 'trocar on', reason: autostartBlk }]
    if (flags.has('--dry-run')) return out(receiptOf({ ...plan, exit: 0 }, { dry_run: true, planned: plan.planned || [], blocked }), EXIT.ok)
    put({ event: 'failure', where: 'start', code: AUTOSTART_MISSING, reason: autostartBlk })
    return done(receiptOf({ ...plan, exit: 2, problems: [autostartBlk] }, { blocked, error: { code: AUTOSTART_MISSING, message: autostartBlk } }), EXIT.usage)
  }
  const m = readManifest(dir, fs)
  const seen = new Set(m.confirmed_paths || [])
  const fresh = [...new Set(plan.planned.flatMap((p) => p.paths))].filter((p) => !seen.has(p))
  say(fit([`trocar on will change ${plan.planned.length} setting${plan.planned.length === 1 ? '' : 's'}:`,
    ...pairs(plan.planned.map((p) => planLine(p, home))),
    ...(fresh.length ? pathList('New since you last said yes:', fresh, home) : [])], { home }).join('\n'))
  const blockedSetup = setupBlocked(plan)
  if (flags.has('--dry-run')) return out(receiptOf({ ...plan, exit: 0 }, { dry_run: true, planned: plan.planned, ...(blockedSetup.length ? { blocked: blockedSetup } : {}) }), EXIT.ok)
  if (!plan.on.length && blockedSetup.length) return done(receiptOf(plan, { blocked: blockedSetup, error: setupError(blockedSetup) }), EXIT.incomplete) // nothing to turn on: no daemon started
  if (fresh.length && !flags.has('--yes')) {
    if (json || !isInteractive(io)) { if (json) io.out(JSON.stringify({ ...receiptOf({ ...plan, exit: 2 }), ok: false, planned: plan.planned, needs_yes: true, notes: [NEEDS_YES] }, null, 2)); else io.err(NEEDS_YES); return EXIT.usage }
    if (!(await ask({ ...io, prompt: io.stdout }, 'Proceed?'))) { io.err('You said no: nothing was changed'); return EXIT.incomplete }
  }
  // D62 (1.6 §3.1): `on`'s ONE process question is op.lock's about this very process, and it is a synchronous contract (off/lock.mjs tryOpLock).
  // On Windows it was its own powershell.exe start (490 ms measured on a Windows test machine 2026-10-19) of an `on` that is meant to take 0.5 s in all.
  // This scope reads the table first — from the daemon's resident read-only helper when one answers (the normal case: D61's login start, and D62 ⑥
  // leaves it running through an off); when none answers, the first question that needs the table reads it in its own one start (proc.mjs winIdentity)
  // and the lock's question is answered out of it.
  const closeProcs = await primeProcQuestions({ platform: os, dir, env, fs, ...(deps.daemonReader !== undefined ? { reader: deps.daemonReader } : {}) })
  try {
  let lock
  // another command holds the lock: nothing was written, and the run says so like every failed run — a result line in flows/ and its receipt (1.6 §1)
  try { lock = await acquireOpLock({ file: opLockFile(home), waitMs: deps.lockWaitMs ?? 10_000, fs }) } catch (e) { if (e && e.code === LOCK_BUSY) return done(receiptOf({ ...plan, routes: [], problems: [errText(e)], exit: EXIT.incomplete }, { undo: null }), EXIT.incomplete); throw e }
  try {
    const up = await ensureDaemonUp({ osName: os, dir, env, fs, unit, put, ...(deps.sleep ? { pause: deps.sleep } : {}) })
    const r = up.up ? await turnOnModel(args) : { ...plan, routes: [], problems: up.problems.length ? up.problems : up.notes, exit: EXIT.incomplete }
    if (up.up) r.notes.push(...up.notes.map((text) => ({ harness: null, text })))
    if (r.on.length && up.up) { const now = readManifest(dir, fs); now.confirmed_paths = [...new Set([...(now.confirmed_paths || []), ...plan.planned.flatMap((p) => p.paths)])]; saveManifest(dir, now, fs) }
    const b = setupBlocked(r)
    return done(receiptOf(r, { planned: plan.planned, daemon: { state: up.state, started: up.started }, ...(b.length ? { blocked: b, error: setupError(b), ...(r.on.length && up.up ? { undo: UNDO_LINE.on } : {}) } : {}) }), r.exit, up.up ? (r.turnedOn || []) : [])
  } catch (e) { // a throw under the lock is a failed run too: its result line names what turned on before the throw (turnOnModel attaches it; none when it is not known), then the error goes on
    put({ event: 'install-note', where: 'install', kind: 'result', outcome: 'failed', harnesses: Array.isArray(e && e.turnedOn) ? e.turnedOn : [], refused: [], reason: `on did not finish: ${errText(e)}` })
    throw e
  } finally { lock.release() }
  } finally { closeProcs() }
}
