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
import { primeProcQuestions, listProcs } from '../off/proc.mjs'
import { harnessesOf } from '../off/signature.mjs'
import { opLockFile } from '../off/paths.mjs'
import { daemonReader } from '../off/daemon-read.mjs'
import { readManifest, saveManifest } from '../collector/core/trust/journal.mjs'
import { appendEvent } from '../collector/core/events.mjs'
import { fit, tilde, formWords, routeWords, refusedLines, setupBlocked, setupError, routeReason, ownTreeItem, commandLine, restartLine } from './receipt.mjs'
import { pairs, andList } from './text.mjs'
import { printJson } from './json.mjs'
import { routeRefusal } from '../netenv/findings.mjs'

const errText = (e) => String((e && e.message) || e)
const NEEDS_YES = 'Nothing was changed. Read the plan above, then run it again with --yes'

// §1.4「计划写全」: every planned route by the full path (and key) it will write; a route that writes no file of yours says why instead
const planLine = (p, home) => [p.harness, p.paths.length ? `${p.paths.map((x) => tilde(x, home)).join(', ')}: ${routeWords(p)}` : `no file of yours: trocar hands ${p.harness} the setting as it starts`] // 1.6 §3.3: path: what changes there
const noteLine = (n) => (n.code === 'install-pending' ? `Not done yet: ${n.item} is ${n.state} (${n.why}). Run again: ${n.command}` : `Note: ${n.harness ? `${n.harness}: ` : ''}${n.text || n.why || n.code}${n.paths && n.paths.length ? ` (${n.paths.join(', ')})` : ''}`)
// 1.6 §1.1: the headline of a run that did not finish names the harnesses that did not: refused, or a route of theirs not written
const unfinished = (r) => [...new Set([...r.refused.map((x) => x.harness), ...(r.routes || []).filter((x) => !x.ok).map((x) => x.harness)])]
// 1.6 §3.3 · §1.1 ④: the notes the default text says — a step left to do (install pending), a fact not read (D38), a form that only forwards (invariant 4).
// The rest (loopback, a registered side effect, a launch that skips the hook, a port moved) is said once elsewhere, and --details prints it.
const saysNow = (n) => n.code === 'install-pending' || !!n.form || /could not be (told|read)/.test(n.text || '')
function shortReceipt(r, exit, home) {
  const failed = [...new Map((r.routes || []).filter((x) => !x.ok).map((x) => [`${x.harness}|${x.at || x.route}|${x.reason}`, x])).values()].map((x) => {
    const at = x.at ? tilde(x.at, home) : x.route ? formWords(`.${x.route}`) : ''
    const w = routeRefusal({ h: x.harness, reason: x.reason, at })
    if (!w) return [`${x.harness}${at ? ` (${at})` : ''} was not turned on: ${routeReason(x)}.`]
    const said = w.steps.filter((t) => !t.startsWith('run: ')), runs = w.steps.filter((t) => t.startsWith('run: ')).map((t) => t.slice(5))
    return [`${x.harness}${at ? ` (${at})` : ''} was not turned on. ${w.why} ${[...said, ...(runs.length ? ['run:'] : [])].join(', then ')}${runs.length ? '' : '.'}`, ...runs.map(commandLine)]
  })
  return [r.dry_run ? `trocar on would start capturing ${andList(r.harnesses) || 'no agent'}. Nothing was written.`
    : exit === 0 && !r.harnesses.length ? 'Nothing to capture: no agent trocar covers is set up on this machine.'
      : exit === 0 ? `Capturing ${andList(r.harnesses)}.`
        : `trocar on did not finish${unfinished(r).length ? ` for ${andList(unfinished(r))}` : ''}. What stopped it is below.`,
  ...restartLine(r), ...r.refused.flatMap(refusedLines), ...failed.flat(), ...r.notes.filter((n) => saysNow(n) || !r.harnesses.length).map(noteLine), ...r.problems.map((p) => `Problem: ${p}`)]
}
/** The full text of a macOS / Windows `on` (`--details`): every route, note and problem. */
export function formatModelOnReceipt(receipt, exit, home) {
  return fit([receipt.dry_run ? `trocar on would start capturing ${receipt.harnesses.join(', ') || 'no agent'}. Nothing was written.`
    : exit === 0 && !receipt.harnesses.length ? 'Nothing to capture: no agent trocar covers is set up on this machine.'
    : exit === 0 ? `Capturing ${receipt.harnesses.join(', ')}.${receipt.daemon && receipt.daemon.state === 'running' ? ' The collector is running.' : ''}`
      : `trocar on did not finish${unfinished(receipt).length ? ` for ${unfinished(receipt).join(', ')}` : ''}. What stopped it is below.`,
    ...receipt.refused.flatMap(refusedLines),
    // §1.1: no two rows the same. One agent with several routes (Claude Code's settings and its config library) said "the setting is in place"
    // twice (a Windows test machine 2026-10-18): the row names the file the setting is in, so each row is the fact it reports
    ...pairs([...new Map((receipt.routes || []).map((r) => {
      const where = r.at ? tilde(r.at, home) : r.route ? formWords(`.${r.route}`) : ''
      const w = r.ok ? null : routeRefusal({ h: r.harness, reason: r.reason, at: r.at ? tilde(r.at, home) : where }) // the doctor's words and steps: never a bare code
      return [`${r.harness}|${where}|${r.ok}|${r.reason || ''}`, [r.harness, `${where ? `${where}: ` : ''}${r.ok ? 'the setting is in place' : w ? `not written. ${w.why} ${w.steps.join(', then ')}.` : `not written: ${routeReason(r)}`}`]]
    })).values()], { home }),
    ...((receipt.restart || []).length ? [`  ! Restart to capture: ${receipt.restart.map((x) => `${x.harness} (pid ${x.pid})`).join(', ')}: started before capture was on. Until then they connect as they do now.`] : []),
    ...receipt.notes.map(noteLine), ...receipt.problems.map((p) => `Problem: ${p}`)], { home }).join('\n')
}
/** The default text of a macOS / Windows `on` (1.6 §3.3): the conclusion, the Restart line, and what the user must act on, each with its way out. */
export const formatModelOnText = (r, exit, home) => fit(shortReceipt(r, exit, home), { home }).join('\n')
/** 1.6 §3.3「之后的效果」: the processes of the agents this on just turned on that were already running — `restart:[{harness, pid}]`, as Linux's.
 *  Read from the table this command's scope already holds (listProcs; on Windows the daemon's answer), judged by the manifest's liveness record:
 *  a route that is read again while running, or on every request, needs no restart. A table that cannot be read is said (D38). */
async function restartOf({ m, ids, os, exec, env, procs }) {
  const live = ids.map((h) => [h, (m.liveness || {})[h]]).filter(([, l]) => l && l.on_at && !l.rereads && !l.per_request)
  if (!live.length) return { restart: [] }
  let list
  try { list = await (procs ? procs() : listProcs({ platform: os, exec, env })) } catch (e) { return { restart: [], note: { harness: null, text: `which running agents need a restart could not be read (${errText(e)})` } } }
  return { restart: live.flatMap(([h, l]) => list.filter((p) => (p.startedAt == null || p.startedAt < Date.parse(l.on_at)) && harnessesOf({ [h]: l }, p).includes(h)).map((p) => ({ harness: h, pid: p.pid }))) }
}
const noFormError = (r) => { const x = r.refused.find((y) => y.reason === 'not-routed'); return x ? { code: 'not-routed', message: `${x.harness} was not turned on: ${x.why}` } : null }

/** → the exit code. `source`: added to each flows/ record this run writes (the board's 'board'). `parts` is loadParts' view (its arch's unit); `deps`: backends, harnesses, which, exec, now, sleep, fs (0.1 §3). */
export async function runModelOn({ io, env, home, os, deps, parts, flags, ids, json, source }) {
  const fs = deps.fs || nodeFs
  const say = json ? () => {} : io.out // §1.2: with --json stderr stays empty and the plan is the `planned` key of the one document on stdout (a macOS test machine 2026-10-18: it went to stderr)
  const dir = path.join(home, '.trocar', 'collector')
  const run = new Date().toISOString() // on every line this run writes, so the board's "last on" is this run's lines (as install's, 1.6 §1)
  const put = (rec) => { try { if (fs.existsSync(dir)) appendEvent(dir, { ...rec, run, ...(source ? { source } : {}) }) } catch { /* the receipt carries it (R11) */ } }
  const [{ turnOnModel, offSince, offWords, STOPPED_BY_OFF }, { backendsFor, sourcesCtx, systemProxyNow }, { renderHook }] = await Promise.all([import('../collector/model-on.mjs'), import('../collector/arch/model-backends.mjs'), import('../collector/harness/templates/index.mjs')])
  const b = deps.backends || (await backendsFor({ os, home, run: deps.exec || null, env, fs }))
  const ctx = deps.ctx || sourcesCtx({ os, home, env, dirs: b.dirs, policy: b.policy, which: deps.which || null, fs })
  const args = { os, home, env, ids, harnesses: deps.harnesses || parts.harnesses, ctx, fs, renderHook, rootStore: b.rootStore || null, persistentEnv: (b.facts && b.facts.persistentEnv) || null, source, ...(deps.now ? { now: deps.now } : {}) }
  const details = flags.has('--details')
  const out = (receipt, exit) => {
    if (json) printJson(io, receipt)
    else io.out((details ? formatModelOnReceipt : formatModelOnText)(receipt, exit, home))
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
  // 附录 C.1: `undo` is the one line that undoes THIS run, and `null` when nothing was changed — no harness turned on, a refusal (its code in `error`, or `r.code`) changed nothing, and neither did a dry run (tested on macOS and Windows 2026-10-19)
  const receiptOf = (r, extra = {}) => ({ ...newReceipt('on'), ok: r.exit === 0, ...(extra.dry_run || r.code || extra.error || !r.on.length ? {} : { undo: UNDO_LINE.on }), harnesses: r.on, refused: r.refused, ...(r.restart ? { restart: r.restart } : {}), routes: r.routes, notes: r.notes, problems: r.problems, ...extra })
  const { autostartBlock, AUTOSTART_MISSING, ensureDaemonUp } = await import('../collector/install.mjs')
  const plan = await turnOnModel({ ...args, dryRun: true })
  // a planned route whose entry hands the app a PAC (`value: 'pac-url'`): the one write the system proxy decides (4.11 §3 ③, the forms that follow it)
  const readsSystemProxy = (p) => { const d = args.harnesses.find((x) => x.name === p.harness); return d.proxyMode.routes[p.route].value === 'pac-url' }
  // nothing to turn on and nothing to set up (4.11 CM43): nothing is written and no daemon started, so the login entry is not this run's question
  if (!plan.code && !plan.on.length && !flags.has('--dry-run') && !setupBlocked(plan).length) { const error = noFormError(plan); return done(receiptOf(plan, { undo: null, ...(error ? { error } : {}) }), plan.exit) }
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
  // 1.6 §3.3: each setting is one row; a row new since an earlier yes says so on itself — with no earlier yes there is no "last" to speak of
  const isNew = (p) => seen.size > 0 && p.paths.some((x) => fresh.includes(x))
  // V85: trocar's own tree (the record, the desired state, ingress.json) is one more row; it is no setting of yours, so no yes is asked for it
  const own = ownTreeItem(home, os), planned = [...plan.planned, own]
  // 1.6 §3.3「要确认时」: the default plan is printed when a yes is asked (or for --dry-run): one line per agent and file of yours, `new` on a file
  // not confirmed last time, then each registered side effect of a route this on adds, once. --details prints the full plan on every run.
  if (plan.on.length && !details && (flags.has('--dry-run') || (fresh.length && !flags.has('--yes')))) {
    const newOnes = new Set(plan.planned.filter((p) => !p.paths.length || p.paths.some((x) => fresh.includes(x))).map((p) => p.harness))
    const effects = [...new Map(args.harnesses.filter((d) => newOnes.has(d.name)).flatMap((d) => ((d.proxyMode || {}).effects || []).map((e) => [e.id, `${d.name}: ${e.when}.`]))).values()]
    say(fit(['trocar on will point these agents at trocar:', ...pairs(plan.planned.flatMap((p) => (p.paths.length ? p.paths.map((x) => [p.harness, `${tilde(x, home)}${seen.size && fresh.includes(x) ? '  new' : ''}`]) : [[p.harness, 'no file of yours']])), { home }), ...effects], { home }).join('\n'))
  } else if (plan.on.length && details) say(fit([`trocar on will change ${plan.planned.length} setting${plan.planned.length === 1 ? '' : 's'}:`,
    ...pairs([...plan.planned.map((p) => { const [h, v] = planLine(p, home); return [h, isNew(p) ? `${v} (new since you last said yes)` : v] }), [own.what, own.detail]], { home })], { home }).join('\n'))
  const blockedSetup = setupBlocked(plan)
  if (flags.has('--dry-run')) return out(receiptOf({ ...plan, exit: 0 }, { dry_run: true, planned, ...(blockedSetup.length ? { blocked: blockedSetup } : {}) }), EXIT.ok)
  if (!plan.on.length && blockedSetup.length) return done(receiptOf(plan, { blocked: blockedSetup, error: setupError(blockedSetup, plan) }), EXIT.incomplete) // nothing to turn on: no daemon started
  if (fresh.length && !flags.has('--yes')) {
    if (json || !isInteractive(io)) { if (json) printJson(io, { ...receiptOf({ ...plan, exit: 2 }), ok: false, planned, needs_yes: true, notes: [NEEDS_YES] }); else io.err(NEEDS_YES); return EXIT.usage }
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
    // 1.6 §1.6 (R12): what was on when the lock was taken; an off that comes in meanwhile marks one of these off, and on stops at its next look
    const stateF = path.join(dir, 'state.json')
    const notOn = offSince(stateF, plan.on, { fs })
    const wasOn = plan.on.filter((h) => !notOn.includes(h))
    let offCame = []
    const halted = () => (offCame = offSince(stateF, wasOn, { fs })).length > 0
    const up = await ensureDaemonUp({ osName: os, dir, env, fs, unit, put, halted, ...(deps.sleep ? { pause: deps.sleep } : {}) })
    if (up.halt && offCame.length) { const message = offWords(offCame, stateF); return done(receiptOf({ ...plan, routes: [], problems: [message], exit: EXIT.incomplete }, { error: { code: STOPPED_BY_OFF, message } }), EXIT.incomplete) }
    // 4.11 §3 ③: a PAC system proxy, or an own leg with a login, keeps a PAC route unwritten — read once, and only when such a route is planned
    // (D62: an on with none pays nothing); on Windows through the daemon's warm helper, up by now
    const sys = up.up && plan.planned.some(readsSystemProxy) ? await systemProxyNow({ os, env, io: os === 'darwin' ? { exec: deps.exec || null } : { helper: deps.daemonReader !== undefined ? deps.daemonReader : daemonReader({ platform: os, dir, env, fs }) } }) : null
    const r = up.up ? await turnOnModel({ ...args, root: plan.root, wasOn, systemProxy: sys }) : { ...plan, routes: [], problems: up.problems.length ? up.problems : up.notes, exit: EXIT.incomplete }
    if (up.up) r.notes.push(...up.notes.map((text) => ({ harness: null, text })))
    if (fresh.length && r.on.length && up.up) { // nothing new: nothing to save. A failure here is this run's problem, not a throw that loses its receipt (V104)
      try { const now = readManifest(dir, fs); now.confirmed_paths = [...new Set([...(now.confirmed_paths || []), ...plan.planned.flatMap((p) => p.paths)])]; saveManifest(dir, now, fs) } catch (e) { r.problems.push(`trocar could not record the files you said yes to (${errText(e)}); the next trocar on asks again`); r.exit = EXIT.incomplete }
    }
    if (up.up && (r.turnedOn || []).length) { // the processes started before capture was on (§3.3): only of the agents this run turned on
      const rs = await restartOf({ m: readManifest(dir, fs), ids: r.turnedOn.filter((h) => notOn.includes(h)), os, exec: deps.exec || null, env, procs: deps.procs })
      r.restart = rs.restart
      if (rs.note) r.notes.push(rs.note)
    }
    const b = setupBlocked(r)
    // an on that an off stopped: its code is the receipt's error, and the harnesses it wrote before are undone by `trocar off` (附录 C.1)
    const offErr = r.error && r.error.code === STOPPED_BY_OFF ? { error: r.error, ...((r.turnedOn || []).length ? { undo: UNDO_LINE.on } : {}) } : {}
    return done(receiptOf(r, { planned, daemon: { state: up.state, started: up.started }, ...offErr, ...(b.length ? { blocked: b, error: setupError(b, r), ...(r.on.length && up.up ? { undo: UNDO_LINE.on } : {}) } : {}) }), r.exit, up.up ? (r.turnedOn || []) : [])
  } catch (e) { // a throw under the lock is a failed run too: its result line names what turned on before the throw (turnOnModel attaches it; none when it is not known), then the error goes on
    put({ event: 'install-note', where: 'install', kind: 'result', outcome: 'failed', harnesses: Array.isArray(e && e.turnedOn) ? e.turnedOn : [], refused: [], reason: `on did not finish: ${errText(e)}` })
    throw e
  } finally { lock.release() }
  } finally { closeProcs() }
}
