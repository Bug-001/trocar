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
import { fit, tilde, planItems, formWords, carrierWords } from './receipt.mjs'
import { pairs, wrap } from './text.mjs'
import { appendEvent } from '../collector/core/events.mjs'
import { EVENT } from '../collector/core/codes.mjs'

const NEEDS_YES = 'Nothing was changed. Read the plan above, then run it again with --yes'
// R5 / R6: no terminal and no --yes — the plan was printed, nothing written, exit 2; with --json stdout is the one receipt, with the plan in `planned`
function needsYes(io, json, planned = []) {
  if (json) io.out(JSON.stringify({ ...newReceipt('install'), ok: false, planned, needs_yes: true, notes: [NEEDS_YES] }, null, 2)); else io.err(NEEDS_YES)
  return EXIT.usage
}
const USAGE = 'usage: asight install [--dry-run] [--yes] [--json]'
const FLAGS = new Set(['--dry-run', '--yes', '--json'])
const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1)
// 1.6 §3.2: the two lines every plan prints — what being installed costs, and on macOS / Windows the same-user residual risk
const COST = "While installed, programs you run trust certificates issued by this machine's asight root. Remove it: asight uninstall"
const RISK = 'Any program running as you can ask asight to issue a trusted certificate, but cannot copy the key. If you suspect misuse: asight uninstall, then asight install.'

export async function runInstallCli(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  const flags = new Set()
  for (const a of argv) { if (!FLAGS.has(a)) { io.err(`asight install: ${a.startsWith('-') ? `unknown option '${a.split('=')[0]}'` : 'takes no agent name: it installs for every agent found on this machine'}\n${USAGE}`); return EXIT.usage } flags.add(a) }
  const json = flags.has('--json')
  const lines = [] // §1.2: with --json stderr stays empty — the plan is a key of the one document on stdout
  const say = json ? (s) => lines.push(s) : io.out
  if ((deps.getuid || processUid)() === 0) { io.err('asight install: run this as your own user, not as root.'); return EXIT.usage }
  const fs = deps.fs || nodeFs
  const old = refuseOldManifest({ home, platform, fs })
  if (old) { if (json) io.out(JSON.stringify({ ...newReceipt('install'), ok: false, error: { code: 'older-install', message: old.message }, notes: [old.message] }, null, 2)); else io.err(`asight install: ${old.message}`); return EXIT.incomplete }
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
    const carrierOf = (r) => (r.carrier === 'root'
      ? 'reads your user trust store'
      : r.paths && r.paths.length
        ? `${r.paths.map((p) => tilde(p, home)).join(', ')}${r.keys ? `: ${r.keys.join('.')}` : ''}`
        : `path not known yet: the place of its ${r.carrier} could not be resolved on this machine`)
    const planned = [
      { what: 'root', detail: "this machine's own root certificate, trusted for your user (the system asks you once; the key cannot be exported)" },
      // one line per (agent, place): the same file reached by three forms of one agent is one line, with the forms named (D46)
      ...[...rows.reduce((by, r) => by.set(`${r.harness}|${carrierOf(r)}`, [...(by.get(`${r.harness}|${carrierOf(r)}`) || []), r]), new Map()).values()]
        .map((group) => ({ harness: group[0].harness, forms: group.map((r) => r.form), carrier: group[0].carrier, paths: group[0].paths, keys: group[0].keys, what: group[0].harness, detail: carrierOf(group[0]) })),
      { what: 'undo', detail: `${tilde(standalonePath(home), home)}: the undo that works without this source tree` },
    ]
    say(fit([`asight install will change ${planned.length} thing${planned.length === 1 ? '' : 's'}:`,
      ...pairs(planned.map((p) => [p.what, p.detail])),
      ...(rows.length ? [] : ['No agent was found on this machine: only the root is installed.']),
      ...wrap(COST), ...wrap(RISK)]).join('\n'))
    if (flags.has('--dry-run')) { if (json) io.out(JSON.stringify({ ...newReceipt('install'), dry_run: true, planned }, null, 2)); return EXIT.ok }
    if (!flags.has('--yes')) {
      if (json || !isInteractive(io)) return needsYes(io, json, planned)
      if (!(await confirm({ ...io, prompt: io.stdout }, 'Proceed?'))) { io.err('You said no: nothing was changed'); return EXIT.incomplete }
    }
    const r = await locked(() => runInstall({ os: platform, home, env, harnesses, custody: b.custody, rootStore: b.rootStore, installHelper: b.installHelper, interactive: isInteractive(io),
      wrapperKit: b.wrapperKit, facts: b.facts, ctx, unit, owns: deps.owns || ownsBy({ os: platform, home, fs }), renderHook, fs, ...(deps.now ? { now: deps.now } : {}) }))
    if (!r) return EXIT.incomplete
    // a refusal carries `error: {code, message}` (附录 C.1): the first pending item that named a code is why install could not go on
    const refusal = r.pending.find((p) => p.code)
    const receipt = { ...newReceipt('install'), ok: r.exit === 0, fp256: r.fp256, items: r.items, carriers: r.carriers, pending: r.pending, problems: r.problems, standalone: standalonePath(home), residual_risk: RISK,
      ...(refusal ? { error: { code: refusal.code, message: refusal.reason } } : {}),
      planned, commands: ['asight on', 'asight off', 'asight status', 'asight uninstall'] }
    const dir = path.join(home, '.asight', 'collector')
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
    else if (refusal) io.out(fit([`asight install stopped: ${refusal.message || refusal.reason}`, 'Nothing of yours was changed.']).join('\n'))
    else io.out(fit([receipt.ok ? "Installed. asight's root certificate is trusted by your user." : 'asight install did not finish. What is missing is below.',
      ...pairs([['Fingerprint (SHA-256)', r.fp256 || 'unknown (no root was made)']]), // the hex is one unbroken word under its label: one block, and in a block of its own, so it does not widen the rows below
      ...pairs(carrierRows),
      ...r.pending.map((p) => `Not done yet: ${p.item} is ${p.state} (${p.reason}). Run again: asight install`),
      ...r.problems.map((p) => `Problem: ${p}`),
      ...wrap(RISK),
      'Next: asight on',
      `If asight itself breaks: ${tilde(standalonePath(home), home)}`]).join('\n'))
    return r.exit
  }
}

// Linux (override #15; 1.6 §3.2 steps): the CA (ca/ca.key, 0600, made here and nowhere else), asight's own files (asight-ca.pem, the combined bundles, the
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
  try { plan = await inst.planOn(args) } catch (e) { io.err(`asight install: the plan could not be made (${String((e && e.message) || e)}). Nothing was changed`); return EXIT.incomplete } // a plan that cannot be made (an OS bundle that cannot be read, D38) is said, never a stack
  // asight-off (R3) is install's: named in the plan and the dry run when this run would write it, i.e. when it is not already what src/off generates
  const stdPath = standalonePath(home)
  let stdNew = true
  try { stdNew = fs.readFileSync(stdPath, 'utf8') !== buildStandalone({ version: OFF_VERSION, fs }) } catch { stdNew = true }
  say([formatPlan({ ...plan, adopted: [], standalone: stdNew ? stdPath : null }, { home, autostart: false, platform, command: 'install' }), ...wrap(COST)].join('\n'))
  if (flags.has('--dry-run')) { if (json) io.out(JSON.stringify({ ...newReceipt('install'), dry_run: true, planned: planItems({ ...plan, standalone: stdNew ? stdPath : null }, { home, platform }), harnesses: plan.targets, changed: plan.changed, created: [...(stdNew ? [stdPath] : []), ...plan.created] }, null, 2)); return EXIT.ok }
  if ((plan.writing || stdNew) && !flags.has('--yes')) {
    if (json || !isInteractive(io)) return needsYes(io, json, planItems({ ...plan, standalone: stdNew ? stdPath : null }, { home, platform }))
    if (!(await confirm({ ...io, prompt: io.stdout }, 'Proceed?'))) { io.err('You said no: nothing was changed'); return EXIT.incomplete }
  }
  // the undo that needs no source tree comes before the first thing it undoes (R3): a copy that cannot be written stops the install here, with a failure line (R11)
  const done = await locked(async () => {
    let stdl
    try { stdl = writeStandalone({ home, version: OFF_VERSION, fs }) } catch (e) {
      const reason = `${stdPath}, the undo that works without the source tree, could not be written (${String((e && e.message) || e)}); no file of the agents' was changed. Put that right, then run asight install again`
      try { appendEvent(path.join(home, '.asight', 'collector'), { event: EVENT.failure, where: 'install', code: (e && e.code) || 'install-error', reason }) } catch {}
      return { failed: reason }
    }
    return { stdl, r: await inst.installCollector({ ...args, onPlan: () => {} }) }
  })
  if (!done) return EXIT.incomplete
  if (done.failed) { if (json) io.out(JSON.stringify({ ...newReceipt('install'), ok: false, notes: [done.failed] }, null, 2)); else io.err(`asight install: ${done.failed}`); return EXIT.incomplete }
  const { stdl, r } = done
  const receipt = { ...newReceipt('install'), ok: true, harnesses: r.manifest.install ? r.manifest.install.harnesses : [], changed: r.already ? [] : plan.changed.map((c) => ({ ...c, backup: (r.manifest.entries.find((e) => e.path === c.path) || {}).backup ?? null })), created: [...(stdl.written ? [stdl.path] : []), ...(r.already ? [] : plan.created)], standalone: standalonePath(home), planned: planItems({ ...plan, standalone: stdNew ? stdPath : null }, { home, platform }), commands: ['asight on', 'asight off', 'asight status', 'asight uninstall'], notes: r.plan ? r.plan.notes : [] }
  if (json) io.out(JSON.stringify(receipt, null, 2))
  else io.out(fit([r.already ? 'Already installed. Nothing was changed.' : "Installed. asight's certificates are in place.",
    ...(r.already ? [] : changeLines(receipt, { home })),
    ...receipt.notes.map((n) => `Note: ${n}`),
    'Next: asight on',
    `If asight itself breaks: ${tilde(standalonePath(home), home)}`]).join('\n'))
  return EXIT.ok
}
