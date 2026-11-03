// update.mjs — `trocar update [--yes] [--dry-run] [--json]` (RFC 1.6 §5.5, 附录 C.2; D67).
//
// One command takes this machine to the newest code and leaves it the way it was: installed, and capturing whatever was being captured.
// The line D67① draws is「pulling the code」: the OLD code runs the checks, switches off the harnesses that are on (who wrote an entry
// undoes it) and pulls; then it starts a NEW process on the new code, which finishes (the daemon, `install`, `on`). The handover is one
// public command, one file that holds nothing but harness names (`~/.trocar/collector/update.json`), and the daemon's `code`.
// The collector is replaced by replace-daemon.mjs, the routine `install` runs too. A copy the install script placed (D74) is brought to the
// new version by the installer it carries (`--stage`), then `place`, and the new code is started through the launcher ~/.trocar/bin/trocar.
// After the merge this process loads nothing: everything it may need is imported above, and all it does is spawn the child and wait.
//   runUpdateCli(argv, { io, env, home, platform, deps }) → exit (0 updated or already up to date · 1 not updated / not finished · 2 usage, an npm copy with nothing to finish, no git checkout, root, nobody to confirm)
//   deps (0.1 §3): `exec` (the spawnSync-shaped runner of git / npm), `child` (what runs the new code's `trocar update`), `off` / `on` /
//   `install` (the three commands this one runs), `daemonCode` (what the daemon answers on its control channel), `unit`, `fs`, `root`.
import nodeOs from 'node:os'
import nodeFs from 'node:fs'
import path from 'node:path'
import { EXIT, newReceipt } from './schema.mjs'
import { codeId, codeIdOf, packageRoot, channelOf, packageName } from '../version.mjs'
import { execTool, runAsync } from '../off/exec.mjs'
import { collectorDir, stateFile, launcherPath } from '../off/paths.mjs'
import { readStateFile } from '../off/state.mjs'
import { readManifest } from '../off/manifest.mjs'
import { isInteractive, confirm } from '../off/io.mjs'
import { commandNamed, usageLine } from './commands.mjs'
import { pairs as pairsAt, wrap } from './text.mjs'
// every block of label-value rows an update prints (the plan, the result — maybe from another process) shares one value column
const ROW = Object.freeze({ code: 'Code', collector: 'Collector', offOn: 'Off and on again', again: 'Capturing again', switchedOn: 'Switched on again' })
const pairs = (rows) => pairsAt(rows, { label: Math.max(...Object.values(ROW).map((l) => l.length)) })
import { runOffCli } from '../off/main.mjs'
import { runOnCli } from './on.mjs'
import { runInstallCli } from './install.mjs'
import { replaceDaemon, daemonCode, CUT } from './replace-daemon.mjs'
import { runPlaceCli } from './place.mjs'
import { PS_FILE_ARGS } from '../collector/arch/win32/custody.mjs'

const USAGE = usageLine(commandNamed('update'))
const FLAGS = new Set(['--yes', '--dry-run', '--json'])
const NOT_GIT = 'this trocar is not a git checkout, so it cannot update itself. Update it the way you installed it.'
const NEEDS_YES = 'Nothing was changed. Read the plan above, then run it again with --yes'
const AGAIN = 'Fix that, then run trocar update again'
const COST = `While it runs those agents are not captured; connections they make still work. ${CUT}`
/** Set by the update that hands over (step 3) on the process that finishes it: the plan was printed and answered there, so the finish does not print it again (§1.1: one plan per command). */
export const HANDED_OVER = 'TROCAR_UPDATE_HANDED_OVER'

/** → the exit code. `argv` is what follows `update`. */
export async function runUpdateCli(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  const flags = new Set()
  for (const a of argv) {
    if (!FLAGS.has(a)) { io.err([...wrap(`trocar update: ${a.startsWith('-') ? `unknown option '${a.split('=')[0]}'` : 'takes no agent name: the harnesses it switches off and on again are the ones that are on'}`), USAGE].join('\n')); return EXIT.usage }
    flags.add(a)
  }
  return update({ io, env, home, platform, deps, flags })
}

async function update({ io, env, home, platform, deps, flags }) {
  const json = flags.has('--json'), dry = flags.has('--dry-run'), yes = flags.has('--yes')
  const fs = deps.fs || nodeFs
  const root = deps.root || packageRoot()
  const dir = collectorDir(home)
  const handover = path.join(dir, 'update.json')
  const r = { ...newReceipt('update'), from: codeId(root), to: null, harnesses: [], restarted: false, install: null, on: null, notes: [] }
  const lines = [] // §1.2: with --json stderr stays empty and stdout is the one document — the text lines are only printed without it
  /** The one way out: the receipt (--json) or the lines, and the exit code. */
  const done = (exit, { blocked = null, planned = null } = {}) => {
    r.ok = exit === EXIT.ok
    if (blocked) r.blocked = blocked
    if (planned) r.planned = planned
    if (dry) r.dry_run = true
    if (json) io.out(JSON.stringify(r, null, 2))
    else for (const l of lines) io.out(l)
    return exit
  }
  /** A reason nothing was done: `trocar update: <why>`, exit 1 (the receipt carries it as its error). `under`: a line printed below it without
   *  --json (with it, the receipt carries what that line says). */
  const no = (code, why, exit = EXIT.incomplete, under = null) => {
    r.error = { code, message: why }
    r.notes.push(why)
    // §1.1⑥: folded at 80 columns, never broken mid-word by the terminal; a reason's own lines (git's stderr) stay lines
    const fold = (text) => String(text).split('\n').flatMap((l) => wrap(l))
    if (!json) for (const l of fold(`trocar update: ${why}`)) io.err(l)
    if (!json && under) for (const l of fold(under)) io.err(l)
    r.ok = false
    if (json) io.out(JSON.stringify(r, null, 2))
    return exit
  }

  // §1.4: the plan, then `--dry-run` / `--yes` / the question — EVERY phase goes through this one gate, the finish and the daemon-only
  // step included: they stop a daemon and write to the agents' files too, and `--dry-run` writes nothing. → an exit code when nothing
  // is to be done, null to go on.
  // `cost`: what running the plan costs, said under it — null when it costs nothing worth a line
  const gate = async (rows, planned, cost, shown = false) => {
    if (!shown) lines.push('Plan', ...pairs(rows), ...(cost ? ['', ...wrap(cost)] : []))
    if (!json) for (const l of lines.splice(0)) io.out(l) // the plan is read before the question, and before any refusal (§1.4)
    if (dry) return done(EXIT.ok, { planned })
    if (yes) return null // the answer is given on the command line
    if (json || !isInteractive(io)) { if (!json) io.err(NEEDS_YES); return done(EXIT.usage, { planned, blocked: [NEEDS_YES] }) }
    if (!(await confirm(io, 'Proceed? [y/N] '))) { io.out('Nothing was changed.'); return done(EXIT.usage, { planned, blocked: ['you answered no'] }) }
    return null
  }

  /** The code is the newest and the daemon runs another one (or says none): only the one step that replaces it (§5.5). */
  const daemonOnly = async (running) => {
    const runs = running || 'code it does not name'
    const g = await gate([[ROW.code, `${r.from} (already the newest)`], [ROW.collector, `runs ${runs}, so it is replaced by ${r.from}`]],
      [{ what: 'daemon', detail: `the collector runs ${runs}, so it is stopped and started again on ${r.from}` }], CUT)
    if (g !== null) return g
    return finish({ io, env, home, platform, deps, dir, handover, root, fs, r, lines, done, no, waiting: { from: r.from, on: [] }, only: 'daemon' })
  }

  /** The handover file (D67①) = an update of a moment ago that did not finish: this run is its step 4, whatever the code says. */
  const pending = async () => readHandover(handover, fs, deps.harnessIds || (await (await import('../collector/harness/index.mjs')).loadHarnesses()).map((h) => h.name))
  const resume = async (waiting) => {
    if (waiting.dropped.length) r.notes.push(`${waiting.dropped.join(', ')}: this update's note names ${waiting.dropped.length > 1 ? 'agents' : 'an agent'} this trocar has no descriptor for, so capture is not switched on for ${waiting.dropped.length > 1 ? 'them' : 'it'}`)
    const to = codeId(root)
    r.from = waiting.from || r.from; r.to = to; r.harnesses = waiting.on // C.2: the receipt of the plan says what the finish does, --dry-run and a refused question included
    const replaced = (await daemonCode({ platform, dir, env, fs, deps })) !== to // as replaceDaemon judges it: a collector on this code is left running
    const g = await gate([[ROW.code, `${r.from} -> ${to}`], [ROW.switchedOn, waiting.on.join(', ') || 'nothing was being captured']],
      [{ what: 'finish', detail: `an update to ${to} is waiting to be finished: ${replaced ? 'the collector is replaced, ' : ''}install runs again${waiting.on.length ? `, and capture is switched on again for ${waiting.on.join(', ')}` : ''}`, harnesses: waiting.on }], replaced ? CUT : null, yes && env[HANDED_OVER] === '1')
    if (g !== null) return g
    return finish({ io, env, home, platform, deps, dir, handover, root, fs, r, lines, done, no, waiting })
  }

  /** §5.5 · D74⑧: placed by the install script and nothing to finish. The installer this code carries downloads, checks and places the newest
   *  version BEFORE anything is switched off (it writes only inside ~/.trocar/app); then off, the handover file, `place`, and the new code
   *  finishes, started through the launcher. `--dry-run` asks the installer for the latest version only. */
  async function scripted() {
    const win = platform === 'win32'
    const installer = path.join(root, 'install', win ? 'install.ps1' : 'install.sh')
    if (!fs.existsSync(installer)) return no('installer-missing', `this trocar has no ${path.basename(installer)} to download the newest version with. Run the install command again to update it.`)
    if (!json) io.err(dry ? 'Asking for the newest version of trocar...' : 'Downloading the newest version of trocar...')
    const mode = dry ? (win ? '-Check' : '--check') : (win ? '-Stage' : '--stage')
    const ran = await runAsync(win ? 'powershell.exe' : 'sh', win ? [...PS_FILE_ARGS, installer, mode] : [installer, mode], { env })
    const said = (x) => String(x || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).at(-1) || ''
    const got = /^trocar-installer: (latest|staged|up-to-date) (\S+)(?: (.+))?$/.exec(said(ran.stdout))
    if (ran.status !== 0 || !got) return no('installer-failed', `the download failed: ${said(ran.stderr) || (ran.error && ran.error.message) || `the installer exited ${ran.status}`}. Nothing changed.`)
    const [, kind, v, staged] = got
    r.to = v
    if (kind === 'up-to-date' || v === r.from) { lines.push(`trocar update: already up to date (${r.from}).`); return done(EXIT.ok) }
    const on = harnessesOn({ home, fs })
    if (on.error) return no('state-unreadable', on.error)
    r.harnesses = on.ids
    const g = await gate([[ROW.code, `${r.from} -> ${v} (installed with the install script)`], [ROW.offOn, on.ids.join(', ') || 'nothing is being captured']],
      [{ what: 'code', detail: `the code of this machine's trocar goes from ${r.from} to ${v}` },
        { what: 'harnesses', detail: on.ids.length ? `${on.ids.join(', ')}: switched off before the code changes and on again after it` : 'no agent is being captured, so none is switched off', harness: null, harnesses: on.ids }], COST)
    if (g !== null) return g
    const offExit = on.ids.length ? await step(deps.off || runOffCli, [...on.ids, '--yes', '--json'], { io, env, home, platform, deps }) : { exit: EXIT.ok }
    if (offExit.exit !== EXIT.ok) return no('off-failed', `the agents being captured could not be switched off (trocar off exit ${offExit.exit}), so the code was left as it is`)
    try { writeHandover(handover, { from: r.from, on: on.ids }, fs) } catch (e) {
      await reOn(on.ids, { io, env, home, platform, deps })
      return no('handover-unwritable', `this update could not be written down (${(e && e.message) || e}), so the code was left as it is`)
    }
    const why = []
    if ((await runPlaceCli([staged], { io: { out: () => {}, err: (x) => why.push(String(x)) }, home, platform, deps })) !== EXIT.ok) {
      await reOn(on.ids, { io, env, home, platform, deps })
      try { fs.rmSync(handover, { force: true }) } catch { /* the reason below is what matters */ }
      return no('place-failed', `trocar ${v} is downloaded but could not be switched to (${why.join(' ') || 'trocar place failed'}); the agents that were being captured are being captured again`)
    }
    // the new code finishes (step 4), started the way the user starts it: the launcher, which now names the new version
    const launcher = launcherPath(home, platform)
    const argv = ['update', '--yes', ...(json ? ['--json'] : [])]
    return spawnNew(win ? (env.ComSpec || env.COMSPEC || 'cmd.exe') : launcher, win ? ['/d', '/s', '/c', `""${launcher}" ${argv.join(' ')}"`] : argv, { windowsVerbatimArguments: win }, v)
  }

  /** Step 3: the new code's `trocar update --yes` in a process of its own; this one only waits for it and copies its exit code. */
  async function spawnNew(file, args, opts, to) {
    // a process killed by a signal has no exit code to copy: `child` answers `{signal}` for that, and anything else is its exit code
    const child = deps.child || ((f, a, e) => runAsync(f, a, { quiet: true, inherit: true, env: e, ...opts }).then((x) => (x.status === null ? { signal: x.signal } : x.status)))
    const ended = await child(file, args, { ...env, [HANDED_OVER]: '1' })
    if (!Number.isInteger(ended)) {
      return no('child-crashed', `the code is now ${to}, but the process that was to finish this update was killed${ended && ended.signal ? ` by ${ended.signal}` : ''} before it could. This update is written down, so run trocar update again to finish it`)
    }
    return ended
  }

  // §5.5 · D67②: an npm copy is updated with npm; the code npm put here is the new code, so this run is step 4 — the collector, install
  // and `on` of the harnesses being captured, the same finish a git update ends with — while the collector or the last install ran other
  // code. The install record counts as much as the collector: a collector that came back on this copy by itself (a reboot, a login) has not
  // run install or `on` on it. The handover file is written first, so a finish that does not get through is taken up by the next run.
  const channel = channelOf(root, { home, fs })
  if (channel === 'npm' || channel === 'script') {
    const waiting = await pending()
    if (waiting) return resume(waiting)
    const running = await daemonCode({ platform, dir, env, fs, deps })
    const installed = installedCode(home, fs)
    const to = r.to = r.from
    const daemonOther = typeof running === 'string' && running !== to
    if (!daemonOther && (installed === undefined || installed === to)) {
      if (channel === 'script') return scripted()
      return no('npm-package', `this trocar was installed with npm. Get the newest with npm i -g ${packageName(root, { fs })}@latest, then run trocar update to restart the collector on it.`, EXIT.usage)
    }
    const from = daemonOther ? running : installed
    const why = daemonOther ? `the collector runs ${running}, so it is replaced by ${to}, install runs again` : `install last ran on ${installed || 'code it does not name'}, so it runs again on ${to}`
    const on = harnessesOn({ home, fs })
    if (on.error) return no('state-unreadable', on.error)
    r.from = from || r.from; r.harnesses = on.ids // C.2: the receipt of the plan says what the finish does, --dry-run and a refused question included
    const g = await gate([[ROW.code, `${from || 'code it does not name'} -> ${to} (installed with ${channel === 'npm' ? 'npm' : 'the install script'})`], [ROW.switchedOn, on.ids.join(', ') || 'nothing is being captured']],
      [{ what: 'finish', detail: `${why}${on.ids.length ? `, and capture is switched on again for ${on.ids.join(', ')}` : ''}`, harnesses: on.ids }], running !== to ? CUT : null) // replaceDaemon leaves a collector on this code running
    if (g !== null) return g
    try { writeHandover(handover, { from, on: on.ids }, fs) } catch (e) { return no('handover-unwritable', `this update could not be written down (${(e && e.message) || e}), so nothing was changed`) }
    return finish({ io, env, home, platform, deps, dir, handover, root, fs, r, lines, done, no, waiting: { from, on: on.ids } })
  }
  // a git checkout is the other way (D67②); anything else is told how it was installed, and nothing is touched
  if (channel !== 'git') return no('not-a-checkout', NOT_GIT, EXIT.usage)

  const git = (...args) => execTool('git', ['-C', root, ...args], { run: deps.exec || null, env })
  // 先查,查不过什么都不改 (§5.5): your own changes first — a merge would carry them, and trocar does not touch what you wrote.
  const dirty = git('status', '--porcelain', '--untracked-files=no')
  if (dirty.code !== 0) return no('checkout-unreadable', `this checkout could not be read (${dirty.err || `git exit ${dirty.code}`})`)
  if (dirty.out) return no('local-changes', 'this checkout has changes of your own. Commit or put them aside, then run trocar update again')
  const upstream = git('rev-parse', '--abbrev-ref', '@{u}')
  if (upstream.code !== 0) return no('no-upstream', 'the branch this checkout is on has no upstream, so there is nothing to update from')
  const fetched = git('fetch')
  if (fetched.code !== 0) return no('fetch-failed', `the newest code could not be fetched (${fetched.err || `git exit ${fetched.code}`})`)
  const head = git('rev-parse', 'HEAD').out
  const target = git('rev-parse', '@{u}').out
  if (head !== target && git('merge-base', '--is-ancestor', 'HEAD', '@{u}').code !== 0) {
    return no('not-fast-forward', `this checkout has commits ${upstream.out} does not have, so it cannot be fast-forwarded. Push or put them aside, then run trocar update again`)
  }

  const waiting = await pending()
  if (waiting) return resume(waiting)

  if (head === target) {
    const running = await daemonCode({ platform, dir, env, fs, deps })
    r.to = r.from
    if (running === r.from) { lines.push(`trocar update: already up to date (${r.from}).`); return done(EXIT.ok) }
    return daemonOnly(running)
  }

  // §1.4: the plan — from which commit to which, and which harnesses go off and on again
  const on = harnessesOn({ home, fs })
  // D38 / §5.5 「先查,查不过什么都不改」: which agents are being captured is a check like any other. A state.json that cannot be read is
  // never "none is on" — that would leave those harnesses switched off, with trocar's entries in their files, and nothing to switch back on.
  if (on.error) return no('state-unreadable', on.error)
  r.harnesses = on.ids
  r.to = codeIdOf(upstreamVersion(git, root, fs), target) // the version the NEW code carries: the upstream's own package.json, not the one on disk
  const planned = [
    { what: 'code', detail: `the code of this machine's trocar goes from ${r.from} to ${r.to}` },
    { what: 'harnesses', detail: on.ids.length ? `${on.ids.join(', ')}: switched off before the code changes and on again after it` : 'no agent is being captured, so none is switched off', harness: null, harnesses: on.ids },
  ]
  const g = await gate([[ROW.code, `${r.from} -> ${r.to}`], [ROW.offOn, on.ids.join(', ') || 'nothing is being captured']], planned, COST)
  if (g !== null) return g

  // 1 · (old code) off, and the names into the handover file — the new code switches on what this file names, nothing else (D67①)
  const offExit = on.ids.length ? await step(deps.off || runOffCli, [...on.ids, '--yes', '--json'], { io, env, home, platform, deps }) : { exit: EXIT.ok, doc: null }
  if (offExit.exit !== EXIT.ok) return no('off-failed', `the agents being captured could not be switched off (trocar off exit ${offExit.exit}), so the code was left as it is`)
  try { writeHandover(handover, { from: r.from, on: on.ids }, fs) } catch (e) {
    await reOn(on.ids, { io, env, home, platform, deps })
    return no('handover-unwritable', `this update could not be written down (${(e && e.message) || e}), so the code was left as it is`)
  }

  // 2 · (old code) the merge, and `npm install` when what is installed changed with it
  const touchesDeps = git('diff', '--name-only', head, target, '--', 'package.json', 'package-lock.json').out !== ''
  const merged = git('merge', '--ff-only', target)
  if (merged.code !== 0) {
    await reOn(on.ids, { io, env, home, platform, deps })
    try { fs.rmSync(handover, { force: true }) } catch { /* the reason below is what matters */ }
    return no('merge-failed', `the new code could not be merged in (${merged.err || `git exit ${merged.code}`}); the agents that were being captured are being captured again`)
  }
  if (touchesDeps) {
    const npm = execTool('npm', ['install', '--no-audit', '--no-fund'], { run: deps.exec || null, env, timeoutMs: 600_000 })
    // the code IS replaced: the handover file stays, so the next run goes on from step 4 (§5.5)
    if (npm.code !== 0) return no('npm-failed', `the code is now ${r.to}, but what it needs could not be installed (${npm.err || `npm exit ${npm.code}`}). ${AGAIN}`)
  }

  // 3 · the new code finishes, in a process of its own. No harness name in its arguments (D67①): the file holds them.
  return spawnNew(process.execPath, [path.join(root, 'bin', 'trocar.mjs'), 'update', '--yes', ...(json ? ['--json'] : [])], {}, r.to)
}

/** 4 · (the new code) the daemon, `install` and `on`, and the handover file gone when all three are done (§5.5). `only: 'daemon'`: the
 *  code is already the newest and only the daemon runs another one — the one step of this phase the spec asks for then. */
async function finish({ io, env, home, platform, deps, dir, handover, root, fs, r, lines, done, no, waiting, only = null }) {
  r.from = waiting.from || r.from
  r.to = codeId(root)
  r.harnesses = waiting.on
  const problems = []
  const replaced = await replaceDaemon({ by: 'update', env, home, platform, deps, dir, root, fs, problems })
  r.restarted = replaced.restarted
  if (replaced.notes.length) r.notes.push(...replaced.notes)
  const daemonFailed = problems.length > 0
  // the login entry runs another copy: install here would quietly point it at this one — which copy it runs is the operator's to say
  if (only === 'daemon' || replaced.elsewhere) {
    if (daemonFailed) { r.problems = problems; return no('daemon-not-replaced', problems[0]) }
    lines.push(`trocar is now running ${r.to}.`)
    return done(EXIT.ok)
  }
  const installed = await step(deps.install || runInstallCli, ['--yes', '--json'], { io, env, home, platform, deps })
  r.install = installed.doc
  let failed = null // the step that did not finish: its own reason is printed under the problem (with --json, r.install / r.on carry it)
  if (installed.exit !== EXIT.ok) { problems.push(`the new code could not finish installing itself (trocar install exit ${installed.exit}). ${AGAIN}`); failed = { command: 'install', doc: installed.doc } }
  if (!problems.length && waiting.on.length) {
    const back = await step(deps.on || runOnCli, [...waiting.on, '--yes', '--json'], { io, env, home, platform, deps })
    r.on = back.doc
    if (back.exit !== EXIT.ok) { problems.push(`${waiting.on.join(', ')}: capture could not be switched on again (trocar on exit ${back.exit}). ${AGAIN}`); failed = { command: 'on', doc: back.doc } }
  }
  if (problems.length) { // the file stays: the next run goes on from here
    r.problems = problems
    const why = !daemonFailed && failed && reasonOf(failed.doc) // problems[0] is that step's line unless the collector's came first
    return no(daemonFailed ? 'daemon-not-replaced' : 'not-finished', problems[0], EXIT.incomplete, why ? `trocar ${failed.command}: ${why}` : null)
  }
  try { fs.rmSync(handover, { force: true }) } catch (e) { return no('handover-not-removed', `this update finished, but it could not be written off (${(e && e.message) || e})`) }
  lines.push(`trocar is now ${r.to}${waiting.from && waiting.from !== r.to ? ` (it was ${waiting.from})` : ''}.`, // no record of the code before: no "was"
    ...pairs([[ROW.collector, r.restarted ? 'running the new code' : 'already running this code'], [ROW.again, waiting.on.join(', ') || 'nothing was being captured']]))
  return done(EXIT.ok)
}

/** The code that last ran `install` here, as its record in the install manifest names it (§5.5): undefined when install never ran; null
 *  when the record names none (a build before the field) or the manifest cannot be read — not this code either way, and `install` says
 *  what is wrong with a manifest it cannot use. */
function installedCode(home, fs) {
  let m
  try { m = readManifest(collectorDir(home), fs) } catch { return null }
  if (m && m.unsupported) return null
  if (!m || !m.install || typeof m.install !== 'object') return undefined
  return typeof m.install.code === 'string' && m.install.code ? m.install.code : null
}

/** `~/.trocar/collector/update.json` as written: `{ from, on: [harness…] }`, or null when there is none (or it holds no list of names).
 *  Only ids this code has a descriptor for are kept — the names go to `trocar on`, and one this code does not know (a harness dropped
 *  since, a file edited by hand) would fail the whole finish. What is dropped is said, never silently (D38). */
function readHandover(file, fs, known) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  let o
  try { o = JSON.parse(text) } catch { return null }
  if (o === null || typeof o !== 'object' || !Array.isArray(o.on)) return null
  const named = o.on.filter((h) => typeof h === 'string' && h)
  const on = named.filter((h) => known.includes(h))
  const dropped = named.filter((h) => !known.includes(h))
  return { from: typeof o.from === 'string' ? o.from : null, on, dropped }
}

/** The handover file, 0600 — it is trocar's own note to itself (D27: everything of trocar's is the operator's alone). */
function writeHandover(file, { from, on }, fs) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify({ from, on }) + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600) // an existing file keeps its own mode through writeFileSync
}

/** The harnesses capture is on for (`state.json`), with the reason when the file could not be read: a failed check, never a silent "none" (D38). */
function harnessesOn({ home, fs }) {
  try {
    const { state } = readStateFile(stateFile(home), { fs })
    return { ids: Object.entries(state.harnesses).filter(([, e]) => e && e.desired === 'on').map(([id]) => id).sort(), error: null }
  } catch (e) {
    return { ids: [], error: `which agents are being captured could not be read (${(e && e.message) || e}), so this update was not started. ${AGAIN}` }
  }
}

/** One of the three commands this one runs, with `--json` so its receipt is this one's (C.2 `install` / `on`): → `{ exit, doc }`. Its
 *  own output is held, not printed: one run of `trocar update` prints one receipt. stdout and stderr are held APART — §1.2: the document
 *  is stdout's alone, and a line of stderr mixed into it would make it unparsable. */
async function step(run, argv, { io, env, home, platform, deps }) {
  const out = [], err = []
  const quiet = { ...io, out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) }
  const exit = await run(argv, { io: quiet, env, home, platform, deps, json: true })
  let doc = null
  try { doc = JSON.parse(out.join('\n')) } catch { /* a command that printed no document says so by its exit code */ }
  return { exit, doc }
}

/** Why a step's receipt says it did not finish (附录 C.1): its error, else the first of its problems, pending items, skipped carriers or items,
 *  notes; null when it says nothing. */
function reasonOf(doc) {
  if (!doc || typeof doc !== 'object') return null
  const rows = (k) => (Array.isArray(doc[k]) ? doc[k] : [])
  const text = (x) => (typeof x === 'string' ? x : x && typeof x === 'object' && (x.reason || x.why) ? `${x.harness ? `${x.harness}: ` : ''}${x.reason || x.why}` : null)
  const skipped = [...rows('carriers'), ...rows('items')].filter((x) => x && x.state === 'skipped')
  return (doc.error && typeof doc.error.message === 'string' && doc.error.message) || [...rows('problems'), ...rows('pending'), ...skipped, ...rows('notes')].map(text).find((x) => typeof x === 'string' && x) || null
}

/** Step 1 undone with the code that wrote it (§5.5): the harnesses it switched off are switched on again. */
const reOn = (ids, ctx) => (ids.length ? step(ctx.deps.on || runOnCli, [...ids, '--yes', '--json'], ctx) : Promise.resolve({ exit: EXIT.ok, doc: null }))

/** The version the code being updated TO says it is: `package.json` as the upstream has it (a commit that changes the version would make the
 *  old file's number a wrong promise). What cannot be read falls back to the version on disk — the commit in `to` is the fact either way. */
const upstreamVersion = (git, root, fs) => {
  const shown = git('show', '@{u}:package.json')
  try { return JSON.parse(shown.code === 0 ? shown.out : fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version }
  catch { return codeId(root).split('+')[0] }
}
