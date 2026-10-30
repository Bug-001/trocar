// install.mjs — `trocar install [--dry-run] [--yes] [--json]` (RFC 1.6 §1.1, §1.6; 4.11 §1 install; D55). The order is the spec's: refuse root
// before anything is read; refuse a version 1 / 2 manifest before any write (4.11 ⑰); hold op.lock; print the plan and wait for a yes (not a terminal
// and no --yes: the plan only, exit 2); run the install; print the receipt and record it as an `install-note` (R1, D38). Exit 0 all placed · 1 part of
// it, or a refusal · 2 usage, or no terminal without --yes. macOS / Windows run the collector model (src/collector/model-install.mjs); Linux keeps
// its own install. The world is `deps` (0.1 §3): getuid, fs, exec, backends, harnesses, which, now, lockWaitMs.
import nodeOs from 'node:os'
import nodeFs from 'node:fs'
import path from 'node:path'
import { EXIT, newReceipt, UNDO_LINE } from '../off/schema.mjs'
import { refuseOldManifest } from '../off/manifest.mjs'
import { acquireOpLock, LOCK_BUSY } from '../off/lock.mjs'
import { opLockFile, standalonePath } from '../off/paths.mjs'
import { isInteractive, confirm } from '../off/io.mjs'
import { fit, tilde, planItems, formWords, carrierWords } from './receipt.mjs'
import { pairs, wrap } from './text.mjs'
import { appendEvent } from '../collector/core/events.mjs'
import { EVENT } from '../collector/core/codes.mjs'
import { codeId, packageRoot } from '../version.mjs'
import { CUT, daemonCode, replaceDaemon } from './replace-daemon.mjs'

const NEEDS_YES = 'Nothing was changed. Read the plan above, then run it again with --yes'
// R5 / R6: no terminal and no --yes — the plan was printed, nothing written, exit 2; with --json stdout is the one receipt, with the plan in `planned`
function needsYes(io, json, planned = []) {
  if (json) io.out(JSON.stringify({ ...newReceipt('install'), ok: false, planned, needs_yes: true, notes: [NEEDS_YES] }, null, 2)); else io.err(NEEDS_YES)
  return EXIT.usage
}
const USAGE = 'usage: trocar install [--dry-run] [--yes] [--json]'
const FLAGS = new Set(['--dry-run', '--yes', '--json'])
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)
// 1.6 §3.2: the two lines every plan prints — what being installed costs, and on macOS / Windows the same-user residual risk
const COST = "While installed, programs you run trust certificates issued by this machine's trocar root. Remove it: trocar uninstall"
const RISK = 'Any program running as you can ask trocar to issue a trusted certificate, but cannot copy the key. If you suspect misuse: trocar uninstall, then trocar install.'

// 1.6 §3.2 step 5: the code the answering collector names when it is not this copy's (`root`), else null — a collector that names none is a build
// from before the first release (D67④) and is left
async function staleDaemon({ platform, home, env, fs, deps, root }) {
  const running = await daemonCode({ platform, dir: path.join(home, '.trocar', 'collector'), env, fs, deps })
  return typeof running === 'string' && running !== codeId(root) ? running : null
}

export async function runInstallCli(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  const flags = new Set()
  for (const a of argv) { if (!FLAGS.has(a)) { io.err(`trocar install: ${a.startsWith('-') ? `unknown option '${a.split('=')[0]}'` : 'takes no agent name: it installs for every agent found on this machine'}\n${USAGE}`); return EXIT.usage } flags.add(a) }
  return install({ io, env, home, platform, deps, flags })
}

/**
 * install({ io, env, home, platform, deps, flags, only }) → exit — the body of `trocar install` after its arguments, for the CLI and the board.
 * `only: <harness>` is the board's Set up (4.4 §控制面, D65④): the plan is that harness's missing carriers, and the run places that harness's
 * carriers only; the root, its custody, trocar-off and the login entry are install's own steps, read back when in place (V67). The CLI never passes it.
 */
export async function install({ io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {}, flags, only = null }) {
  const json = flags.has('--json')
  const lines = [] // §1.2: with --json stderr stays empty — the plan is a key of the one document on stdout
  const say = json ? (s) => lines.push(s) : io.out
  if ((deps.getuid || processUid)() === 0) { io.err('trocar install: run this as your own user, not as root.'); return EXIT.usage }
  const fs = deps.fs || nodeFs
  const old = refuseOldManifest({ home, platform, fs })
  if (old) { if (json) io.out(JSON.stringify({ ...newReceipt('install'), ok: false, error: { code: 'older-install', message: old.message }, notes: [old.message] }, null, 2)); else io.err(`trocar install: ${old.message}`); return EXIT.incomplete }
  const { isModelOs } = await import('../collector/model-install.mjs')
  const model = isModelOs(platform)
  // R12: the writes run under op.lock, taken after the yes (a plan that is only printed takes nothing and writes nothing)
  const locked = async (fn) => {
    let lock
    try { lock = await acquireOpLock({ file: opLockFile(home), waitMs: deps.lockWaitMs ?? 10_000, fs }) } catch (e) {
      if (e && e.code === LOCK_BUSY) { io.err(`trocar install: ${e.message}`); return null }
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
    const need = await missingOf(only, { platform, harnesses, ctx, home, rootStore: b.rootStore, fs })
    const rows = planInstall({ os: platform, harnesses, ctx }).filter(need.row)
    // the login entry is install's (D61: registered AND started here, 4.11 §1 install 7; 4.9 §4, 4.8 §7): the arch's unit, or the test's `deps.unit`
    const unit = deps.unit !== undefined ? deps.unit : (await (await import('../collector/daemon.mjs')).loadArch(platform)).unit.userUnit({ home, node: process.execPath, script: deps.script || process.argv[1], run: deps.exec || null, env, ...(deps.spawn ? { spawn: deps.spawn } : {}) })
    const root = deps.root || packageRoot()
    // 1.6 §3.2 step 5: a collector on another copy's code is replaced (not by the board's Set up: it is not an install, and the board hangs on that daemon)
    const stale = unit && !only ? await staleDaemon({ platform, home, env, fs, deps, root }) : null
    const carrierOf = (r) => (r.carrier === 'root'
      ? 'reads your user trust store'
      : r.paths && r.paths.length
        ? `${r.paths.map((p) => tilde(p, home)).join(', ')}${r.keys ? `: ${r.keys.join('.')}` : ''}`
        : `path not known yet: the place of its ${r.carrier} could not be resolved on this machine`)
    const planned = [
      ...(only && !need.root ? [] : [{ what: 'root', detail: "this machine's own root certificate, trusted for your user (the system asks you once; the key cannot be exported)" }]),
      // one line per (agent, place): the same file reached by three forms of one agent is one line, with the forms named (D46)
      ...[...rows.reduce((by, r) => by.set(`${r.harness}|${carrierOf(r)}`, [...(by.get(`${r.harness}|${carrierOf(r)}`) || []), r]), new Map()).values()]
        .map((group) => ({ harness: group[0].harness, forms: group.map((r) => r.form), carrier: group[0].carrier, paths: group[0].paths, keys: group[0].keys, what: group[0].harness, detail: carrierOf(group[0]) })),
      // V85: trocar's own tree is ONE line (uninstall takes all of it back); every file of yours outside it is its own line, above
      ...(only ? [] : [{ what: 'trocar', detail: `${tilde(path.join(home, '.trocar'), home)}${platform === 'win32' ? '\\' : '/'}: trocar's own files (its root certificate and key, the install record, and ${tilde(standalonePath(home), home)}, the undo that works without this source tree)` }]),
      // D61 (1.6 §3.2 step 5, 4.11 §1 install 7): the login entry is a file of YOURS outside trocar's tree, so it is its own line (V85), and the plan says a daemon runs from now on
      ...(stale ? [{ what: 'daemon', detail: `the collector runs ${stale}, so it is stopped and started again on ${codeId(root)}` }] : []),
      ...(unit && !only ? [{ what: 'autostart', detail: `${platform === 'win32' ? 'the scheduled task \\trocar\\collector' : tilde(unit.path, home)}: a collector daemon starts at every login from now on, and is started now (trocar uninstall takes it out again)` }] : []),
    ]
    say(fit([`trocar install will change ${planned.length} thing${planned.length === 1 ? '' : 's'}:`,
      ...pairs(planned.map((p) => [p.what, p.detail])),
      ...(only ? (planned.length ? [] : [`${only} has every certificate carrier it needs: there is nothing to set up.`]) : rows.length ? [] : ['No agent was found on this machine: only the root is installed.']),
      ...wrap(COST), ...wrap(RISK), ...(stale ? wrap(CUT) : [])]).join('\n'))
    if (flags.has('--dry-run')) { if (json) io.out(JSON.stringify({ ...newReceipt('install'), dry_run: true, planned, ...(only && !planned.length ? { notes: [`${only}: nothing to set up`] } : {}) }, null, 2)); return EXIT.ok }
    if (!flags.has('--yes')) {
      if (json || !isInteractive(io)) return needsYes(io, json, planned)
      if (!(await confirm({ ...io, prompt: io.stdout }, 'Proceed?'))) { io.err('You said no: nothing was changed'); return EXIT.incomplete }
    }
    const r = await locked(async () => {
      const r = await runInstall({ os: platform, home, env, harnesses, custody: b.custody, rootStore: b.rootStore, installHelper: b.installHelper, interactive: isInteractive(io),
        wrapperKit: b.wrapperKit, facts: b.facts, ctx, unit: only ? null : unit, only, code: codeId(root), owns: deps.owns || ownsBy({ os: platform, home, fs }), renderHook, fs, ...(deps.now ? { now: deps.now } : {}) })
      const { row } = await boardPortRow(home, fs) // before the daemon starts below: it reads the port, never picks one
      if (row) { r.pending.push(row); r.exit = 1 }
      return r
    })
    if (!r) return EXIT.incomplete
    // D61: the login registration and the daemon, through the one seam every command uses (ensureDaemonUp, src/collector/install.mjs)
    // Set up (only): the login entry is not in its plan, so it is neither rewritten above nor registered here (4.4 #13); the daemon asking is up, this only reads it
    const dmn = unit ? await (await import('../collector/install.mjs')).ensureDaemonUp({ osName: platform, dir: path.join(home, '.trocar', 'collector'), env, fs, unit, register: !only, ...(deps.request ? { request: deps.request } : {}), ...(deps.sleep ? { pause: deps.sleep } : {}) }) : { up: false, started: false, notes: [], problems: [] }
    r.problems.push(...dmn.problems)
    const dmnNotes = dmn.notes.filter((n) => !r.problems.includes(n)) // 附录 C.1: `problems` is the failure channel; what trocar could not do but said is `notes` (M-2)
    if (dmn.problems.length) r.exit = 1
    const dir = path.join(home, '.trocar', 'collector')
    // 1.6 §3.2 step 5: the daemon that answers runs another copy's code → replaced through the routine update uses; routing is not touched (D61②)
    let rep = null
    if (unit && !only && dmn.up && (await staleDaemon({ platform, home, env, fs, deps, root }))) {
      const before = r.problems.length
      rep = await replaceDaemon({ by: 'install', env, home, platform, deps: { ...deps, unit }, dir, root, fs, problems: r.problems })
      dmnNotes.push(...rep.notes)
      rep.replaced = rep.restarted && !rep.elsewhere && r.problems.length === before
      if (r.problems.length > before) r.exit = 1
    }
    // a refusal carries `error: {code, message}` (附录 C.1): the first pending item that named a code is why install could not go on
    const refusal = r.pending.find((p) => p.code)
    const receipt = { ...newReceipt('install'), ok: r.exit === 0, undo: UNDO_LINE.install, fp256: r.fp256, items: r.items, carriers: r.carriers, pending: only ? r.pending.map((p) => ({ ...p, command: 'trocar install' })) : r.pending, problems: r.problems, notes: [...r.notes, ...dmnNotes], standalone: standalonePath(home), residual_risk: RISK, daemon: { state: (rep && rep.stopped ? rep.restarted : dmn.up) ? 'running' : 'not-running', started: dmn.started, replaced: !!(rep && rep.replaced) }, ...(unit && !only ? { autostart: { entry: platform === 'win32' ? '\\trocar\\collector' : unit.path, enabled: !dmn.unitFailed } } : {}),
      ...(refusal ? { error: { code: refusal.code, message: refusal.reason } } : {}),
      planned, commands: ['trocar on', 'trocar off', 'trocar status', 'trocar uninstall'] }
    try { appendEvent(dir, { event: EVENT.installNote, where: 'install', kind: 'result', outcome: receipt.ok ? 'installed' : 'partial', reason: `install: root ${r.fp256 || 'not made'}; ${r.carriers.length} carrier row(s); ${r.pending.length} pending` }) } catch (e) { r.problems.push(`the install-note could not be written (${e.message})`) }
    // §1.1: no two rows of a receipt are the same line. One carrier reached through five forms of one agent was five identical rows (a Windows test machine
    // 2026-10-18: `codex root` five times): the rows are the DISTINCT (agent, carrier, state, file) facts, and when the forms of an
    // agent do not all share one, the row names the forms it is about, in words (formWords).
    const formsOf = (h) => r.carriers.filter((c) => c.harness === h && c.form).map((c) => c.form)
    const groups = [...r.carriers.reduce((by, c) => {
      const k = [c.harness || 'root', c.carrier, c.state || '', c.path || '', c.why || ''].join('|')
      return by.set(k, [...(by.get(k) || []), c])
    }, new Map()).values()]
    const carrierRows = groups.map((g) => {
      const c = g[0]
      const forms = g.map((x) => x.form).filter(Boolean)
      const all = formsOf(c.harness)
      const which = forms.length && forms.length < all.length ? ` (${forms.map(formWords).join(', ')})` : ''
      return [c.harness || 'root', `${carrierWords(c.carrier)}${c.state ? `, ${c.state}` : ''}${c.path ? `: ${tilde(c.path, home)}` : ''}${c.why ? ` (${c.why})` : ''}${which}`]
    })
    if (json) io.out(JSON.stringify(receipt, null, 2))
    // a refusal installed nothing: the fingerprint, the risk of an installed root and "Next" would all be untrue, so the stop and its reason are the whole receipt
    else if (refusal) io.out(fit([`trocar install stopped: ${refusal.message || refusal.reason}`, 'Nothing of yours was changed.']).join('\n'))
    else io.out(fit([receipt.ok ? "Installed. trocar's root certificate is trusted by your user." : 'trocar install did not finish. What is missing is below.',
      ...pairs([['Fingerprint (SHA-256)', r.fp256 || 'unknown (no root was made)']]), // the hex is one unbroken word under its label: one block, and in a block of its own, so it does not widen the rows below
      // the login entry install registered, confirmed like every other row (a Windows test machine 2026-10-18: the receipt said nothing about it) — in the carriers' own pairs() call, so its label column lines up with theirs (a Windows test machine 2026-10-19)
      ...pairs([...carrierRows, ...(rep && rep.replaced ? [['collector', `replaced: it ran ${rep.from}, it now runs ${codeId(root)}`]] : []), ...(receipt.autostart ? [['autostart', `${receipt.autostart.entry}: ${receipt.autostart.enabled ? 'enabled, and a collector starts at every login' : 'NOT enabled (see the problem below): no collector starts at login'}`]] : [])]),
      ...r.pending.map((p) => `Not done yet: ${p.item} is ${p.state} (${p.reason}). Run again: trocar install`),
      ...receipt.notes.map((n) => `Note: ${n}`),
      ...r.problems.map((p) => `Problem: ${p}`),
      // the residual risk (RISK) is the last line of the plan printed just above in this same run (§3.2 prints it there, and the
      // receipt sample does not carry it); printing it again put the paragraph on the screen twice (a macOS test machine 2026-10-18).
      // `--json` keeps it as `residual_risk`, because a document has no plan above it.
      'Next: trocar on',
      `If trocar itself breaks: ${tilde(standalonePath(home), home)}`]).join('\n'))
    return r.exit
  }
}

// Linux (override #15; 1.6 §3.2 steps): the CA (ca/ca.key, 0600, made here and nowhere else), trocar's own files (trocar-ca.pem, the combined bundles, the
// (d)-level plugins) and the (c)-level config keys — every item phase 'install', as `on` wrote them before — plus trocar-off and the liveness record.
// No unit, no state, no daemon: those are `on`'s. The plan printed is the one `on` used to print (formatPlan) with D55's cost line.
async function linuxInstall({ io, env, home, platform, deps, flags, json, say, fs, locked }) {
  const { readAgentList } = await import('../off/identity.mjs')
  const { writeStandalone, buildStandalone } = await import('../off/standalone.mjs')
  const { formatPlan, changeLines } = await import('./receipt.mjs')
  const { OFF_VERSION } = await import('../off/manifest.mjs')
  const parts = deps.parts || await (await import('../collector/daemon.mjs')).loadParts({ env, agentList: readAgentList({ home, fs }).entries })
  const inst = await import('../collector/install.mjs')
  // D61: the login entry is install's — written here and enabled with `--now`, so the daemon is up from install until uninstall
  const unit = deps.unit !== undefined ? deps.unit : (!parts.arch || !parts.arch.unit || !parts.arch.unit.userUnit ? null : parts.arch.unit.userUnit({ home, node: process.execPath, script: deps.script || process.argv[1], run: deps.exec || null, env, ...(deps.spawn ? { spawn: deps.spawn } : {}) }))
  const args = { home, env, osName: parts.os, harnesses: parts.harnesses, scan: parts.scan, match: parts.match, arch: parts.arch || null, roots: deps.roots || null, unit, fs, ...(deps.freePort ? { freePort: deps.freePort } : {}), ...(deps.now ? { now: deps.now } : {}), ...(deps.request ? { request: deps.request } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}) } // request / sleep: installCollector's ensureDaemonUp seam (D61), so a test's daemon is the one asked
  let plan
  const ingressPath = path.join(home, '.trocar', 'collector', 'ingress.json')
  try { plan = await inst.planOn(args) } catch (e) { io.err(`trocar install: the plan could not be made (${String((e && e.message) || e)}). Nothing was changed`); return EXIT.incomplete } // a plan that cannot be made (an OS bundle that cannot be read, D38) is said, never a stack
  if (plan.created && (await import('../collector/core/ingress-config.mjs')).readIngressConfig({ dir: path.dirname(ingressPath), fs }).boardPort === undefined) plan.created.push(ingressPath) // the board's port, recorded below (V85: the plan names what the run writes)
  // trocar-off (R3) is install's: named in the plan and the dry run when this run would write it, i.e. when it is not already what src/off generates
  const stdPath = standalonePath(home)
  let stdNew = true
  try { stdNew = fs.readFileSync(stdPath, 'utf8') !== buildStandalone({ version: OFF_VERSION, fs }) } catch { stdNew = true }
  say([formatPlan({ ...plan, adopted: [], standalone: stdNew ? stdPath : null }, { home, platform, command: 'install' }), ...wrap(COST)].join('\n'))
  if (flags.has('--dry-run')) { if (json) io.out(JSON.stringify({ ...newReceipt('install'), dry_run: true, planned: planItems({ ...plan, standalone: stdNew ? stdPath : null }, { home, platform }), harnesses: plan.targets, changed: plan.changed, created: [...(stdNew ? [stdPath] : []), ...plan.created] }, null, 2)); return EXIT.ok }
  if ((plan.writing || stdNew) && !flags.has('--yes')) {
    if (json || !isInteractive(io)) return needsYes(io, json, planItems({ ...plan, standalone: stdNew ? stdPath : null }, { home, platform }))
    if (!(await confirm({ ...io, prompt: io.stdout }, 'Proceed?'))) { io.err('You said no: nothing was changed'); return EXIT.incomplete }
  }
  // the undo that needs no source tree comes before the first thing it undoes (R3): a copy that cannot be written stops the install here, with a failure line (R11)
  const done = await locked(async () => {
    let stdl
    try { stdl = writeStandalone({ home, version: OFF_VERSION, fs }) } catch (e) {
      const reason = `${stdPath}, the undo that works without the source tree, could not be written (${String((e && e.message) || e)}); no file of the agents' was changed. Put that right, then run trocar install again`
      try { appendEvent(path.join(home, '.trocar', 'collector'), { event: EVENT.failure, where: 'install', code: (e && e.code) || 'install-error', reason }) } catch {}
      return { failed: reason }
    }
    const { row: board, written } = await boardPortRow(home, fs) // before installCollector starts the daemon: it reads the port, never picks one
    return { stdl, board, written, r: await inst.installCollector({ ...args, onPlan: () => {} }) }
  })
  if (!done) return EXIT.incomplete
  if (done.failed) { if (json) io.out(JSON.stringify({ ...newReceipt('install'), ok: false, notes: [done.failed] }, null, 2)); else io.err(`trocar install: ${done.failed}`); return EXIT.incomplete }
  const { stdl, r, board, written } = done
  // D61 (1.6 §3.2 step 5): the login entry is an item of the install like any other — one that could not be registered is a problem and exit 1, never only a note
  const dmn = r.daemon || { up: false, started: false, problems: [], unitFailed: null }
  const problems = dmn.problems
  const receipt = { ...newReceipt('install'), ok: !board && !problems.length, ...(problems.length ? { problems } : {}), ...(board ? { pending: [board] } : {}), undo: UNDO_LINE.install, harnesses: r.manifest.install ? r.manifest.install.harnesses : [], changed: r.already ? [] : plan.changed.map((c) => ({ ...c, backup: (r.manifest.entries.find((e) => e.path === c.path) || {}).backup ?? null })), created: [...new Set([...(stdl.written ? [stdl.path] : []), ...(r.already ? [] : plan.created), ...(written ? [ingressPath] : [])])], standalone: standalonePath(home), planned: planItems({ ...plan, standalone: stdNew ? stdPath : null }, { home, platform }), commands: ['trocar on', 'trocar off', 'trocar status', 'trocar uninstall'], notes: r.plan ? r.plan.notes : [],
    // `enabled` is the entry asked again after the run (1.6 §3.3: no claim without evidence), not "nothing failed": a run that halted on a stuck daemon never enabled anything
    ...(r.daemon ? { daemon: { state: dmn.up ? 'running' : 'not-running', started: dmn.started }, autostart: { entry: args.unit.path, enabled: !dmn.unitFailed && (typeof args.unit.registered !== 'function' || args.unit.registered().state === 'present') } } : {}) }
  if (json) io.out(JSON.stringify(receipt, null, 2))
  else io.out(fit([problems.length ? 'trocar install did not finish. What is missing is below.' : r.already && ((r.entryBefore && r.entryBefore !== 'present') || dmn.started) ? 'Installed. The certificates were in place; the login entry and the collector are up again.' : r.already ? 'Already installed. Nothing was changed.' : "Installed. trocar's certificates are in place.",
    ...(r.already ? [] : changeLines(receipt, { home })),
    ...receipt.notes.map((n) => `Note: ${n}`),
    ...(board ? [`Not done yet: the board's port is pending (${board.reason}). Run again: trocar install`] : []),
    ...problems.map((p) => `Problem: ${p}`),
    ...(problems.length ? [] : ['Next: trocar on']), // on refuses without the login entry (1.6 §3.3): it is no next step until install has finished
    `If trocar itself breaks: ${tilde(standalonePath(home), home)}`]).join('\n'))
  return board || problems.length ? EXIT.incomplete : EXIT.ok
}

// Set up (only): a row of the plan is one of that harness's forms whose own carrier install has not placed (setupOf's `missing`, the judgement
// status and on read, with the root read as on reads it: `root` when it is gone from the user's store, so install's run asks for it again); without
// `only`, every row → { row, root }
async function missingOf(only, { platform, harnesses, ctx, home, rootStore, fs }) {
  if (!only) return { row: () => true, root: true }
  const [{ setupOf }, { readManifest }, { rootOf }] = await Promise.all([import('../collector/core/proxymode/status-facts.mjs'), import('../collector/core/trust/journal.mjs'), import('../collector/model-on.mjs')])
  const dir = path.join(home, '.trocar', 'collector'), manifest = readManifest(dir, fs)
  const root = manifest && manifest.install ? await rootOf({ dir, m: manifest, rootStore, fs }) : null
  const missing = setupOf(harnesses.find((d) => d.name === only), { os: platform, manifest, ctx, root, fs }).missing
  const forms = new Set(missing.map((x) => x.form))
  return { row: (r) => r.harness === only && forms.has(r.form), root: missing.some((x) => x.what === 'root-missing') }
}

/** The board's port (4.4 §Plan 「端口」), chosen once by install: none free (or the file cannot be written) is a pending row with the reason, never a throw. */
async function boardPortRow(home, fs) {
  const { ensureBoardPort } = await import('../collector/core/ingress-config.mjs')
  const b = await ensureBoardPort({ dir: path.join(home, '.trocar', 'collector'), fs })
  return b.error ? { row: { item: 'board', state: 'pending', reason: b.error }, written: false } : { row: null, written: b.created }
}
