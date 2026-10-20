// update.mjs — `asight update [--yes] [--dry-run] [--json]` (RFC 1.6 §5.5, 附录 C.2; D67).
//
// One command takes this machine to the newest code and leaves it the way it was: installed, and capturing whatever was being captured.
// The line D67① draws is「pulling the code」: the OLD code runs the checks, switches off the harnesses that are on (who wrote an entry
// undoes it) and pulls; then it starts a NEW process on the new code, which finishes (the daemon, `install`, `on`). The handover is one
// public command, one file that holds nothing but harness names (`~/.asight/collector/update.json`), and the daemon's `code`.
// After the merge this process loads nothing: everything it may need is imported above, and all it does is spawn the child and wait.
//   runUpdateCli(argv, { io, env, home, platform, deps }) → exit (0 updated or already up to date · 1 not updated / not finished · 2 usage, no git checkout, root, nobody to confirm)
//   deps (0.1 §3): `exec` (the spawnSync-shaped runner of git / npm), `child` (what runs the new code's `asight update`), `off` / `on` /
//   `install` (the three commands this one runs), `daemonCode` (what the daemon answers on its control channel), `unit`, `fs`, `root`.
import nodeOs from 'node:os'
import nodeFs from 'node:fs'
import path from 'node:path'
import { EXIT, newReceipt } from './schema.mjs'
import { codeId, codeIdOf, packageRoot, gitDir } from '../version.mjs'
import { execTool, runAsync } from '../off/exec.mjs'
import { collectorDir, stateFile } from '../off/paths.mjs'
import { readStateFile } from '../off/state.mjs'
import { controlEndpointFor } from '../off/control-client.mjs'
import { isInteractive, confirm } from '../off/io.mjs'
import { commandNamed, usageLine } from './commands.mjs'
import { pairs, wrap } from './text.mjs'
import { runOffCli } from '../off/main.mjs'
import { runOnCli } from './on.mjs'
import { runInstallCli } from './install.mjs'

const USAGE = usageLine(commandNamed('update'))
const FLAGS = new Set(['--yes', '--dry-run', '--json'])
const NOT_GIT = 'this asight is not a git checkout, so it cannot update itself. Update it the way you installed it.'
const NEEDS_YES = 'Nothing was changed. Read the plan above, then run it again with --yes'
const AGAIN = 'Fix that, then run asight update again'
const CUT = 'Connections the collector still holds are cut when it is replaced.'
const COST = `While it runs those agents are not captured; connections they make still work. ${CUT}`

/** → the exit code. `argv` is what follows `update`. */
export async function runUpdateCli(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  const flags = new Set()
  for (const a of argv) {
    if (!FLAGS.has(a)) { io.err(`asight update: ${a.startsWith('-') ? `unknown option '${a.split('=')[0]}'` : 'takes no agent name: the harnesses it switches off and on again are the ones that are on'}\n${USAGE}`); return EXIT.usage }
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
  /** A reason nothing was done: `asight update: <why>`, exit 1 (the receipt carries it as its error). */
  const no = (code, why, exit = EXIT.incomplete) => {
    r.error = { code, message: why }
    r.notes.push(why)
    if (!json) io.err(`asight update: ${why}`)
    r.ok = false
    if (json) io.out(JSON.stringify(r, null, 2))
    return exit
  }

  // §5.5: a checkout is the only way asight is installed today (D67②). Anything else is told how it was installed, and nothing is touched.
  if (!gitDir(root)) return no('not-a-checkout', NOT_GIT, EXIT.usage)

  const git = (...args) => execTool('git', ['-C', root, ...args], { run: deps.exec || null, env })
  // 先查,查不过什么都不改 (§5.5): your own changes first — a merge would carry them, and asight does not touch what you wrote.
  const dirty = git('status', '--porcelain', '--untracked-files=no')
  if (dirty.code !== 0) return no('checkout-unreadable', `this checkout could not be read (${dirty.err || `git exit ${dirty.code}`})`)
  if (dirty.out) return no('local-changes', 'this checkout has changes of your own. Commit or put them aside, then run asight update again')
  const upstream = git('rev-parse', '--abbrev-ref', '@{u}')
  if (upstream.code !== 0) return no('no-upstream', 'the branch this checkout is on has no upstream, so there is nothing to update from')
  const fetched = git('fetch')
  if (fetched.code !== 0) return no('fetch-failed', `the newest code could not be fetched (${fetched.err || `git exit ${fetched.code}`})`)
  const head = git('rev-parse', 'HEAD').out
  const target = git('rev-parse', '@{u}').out
  if (head !== target && git('merge-base', '--is-ancestor', 'HEAD', '@{u}').code !== 0) {
    return no('not-fast-forward', `this checkout has commits ${upstream.out} does not have, so it cannot be fast-forwarded. Push or put them aside, then run asight update again`)
  }

  // §1.4: the plan, then `--dry-run` / `--yes` / the question — EVERY phase goes through this one gate, the finish and the daemon-only
  // step included: they stop a daemon and write to the agents' files too, and `--dry-run` writes nothing. → an exit code when nothing
  // is to be done, null to go on.
  const gate = async (rows, planned, cost) => {
    lines.push('Plan', ...pairs(rows), '', ...wrap(cost))
    if (!json) for (const l of lines.splice(0)) io.out(l) // the plan is read before the question, and before any refusal (§1.4)
    if (dry) return done(EXIT.ok, { planned })
    if (yes) return null // the answer is given on the command line
    if (json || !isInteractive(io)) { if (!json) io.err(NEEDS_YES); return done(EXIT.usage, { planned, blocked: [NEEDS_YES] }) }
    if (!(await confirm(io, 'Proceed? [y/N] '))) { io.out('Nothing was changed.'); return done(EXIT.usage, { planned, blocked: ['you answered no'] }) }
    return null
  }

  // the handover file (D67①) = an update of a moment ago that did not finish: this run is its step 4, whatever the commits say
  const waiting = readHandover(handover, fs, deps.harnessIds || (await (await import('../collector/harness/index.mjs')).loadHarnesses()).map((h) => h.name))
  if (waiting) {
    if (waiting.dropped.length) r.notes.push(`${waiting.dropped.join(', ')}: this update's note names ${waiting.dropped.length > 1 ? 'agents' : 'an agent'} this asight has no descriptor for, so capture is not switched on for ${waiting.dropped.length > 1 ? 'them' : 'it'}`)
    const to = codeId(root)
    const g = await gate([['Code', `${waiting.from || r.from} -> ${to}`], ['Switched on again', waiting.on.join(', ') || 'nothing was being captured']],
      [{ what: 'finish', detail: `an update to ${to} is waiting to be finished: the collector is replaced, install runs again${waiting.on.length ? `, and capture is switched on again for ${waiting.on.join(', ')}` : ''}`, harnesses: waiting.on }], CUT)
    if (g !== null) return g
    return finish({ io, env, home, platform, deps, dir, handover, root, fs, r, lines, done, no, waiting })
  }

  if (head === target) {
    const running = await daemonCode({ platform, dir, env, fs, deps })
    r.to = r.from
    if (running === r.from) { lines.push(`asight update: already up to date (${r.from}).`); return done(EXIT.ok) }
    // the code is the newest, the daemon runs another one (or says none): only the one step that replaces it (§5.5)
    const runs = running || 'code it does not name'
    const g = await gate([['Code', `${r.from} (already the newest)`], ['Collector', `runs ${runs}, so it is replaced by ${r.from}`]],
      [{ what: 'daemon', detail: `the collector runs ${runs}, so it is stopped and started again on ${r.from}` }], CUT)
    if (g !== null) return g
    return finish({ io, env, home, platform, deps, dir, handover, root, fs, r, lines, done, no, waiting: { from: r.from, on: [] }, only: 'daemon' })
  }

  // §1.4: the plan — from which commit to which, and which harnesses go off and on again
  const on = harnessesOn({ home, fs })
  // D38 / §5.5 「先查,查不过什么都不改」: which agents are being captured is a check like any other. A state.json that cannot be read is
  // never "none is on" — that would leave those harnesses switched off, with asight's entries in their files, and nothing to switch back on.
  if (on.error) return no('state-unreadable', on.error)
  r.harnesses = on.ids
  r.to = codeIdOf(upstreamVersion(git, root, fs), target) // the version the NEW code carries: the upstream's own package.json, not the one on disk
  const planned = [
    { what: 'code', detail: `the code of this machine's asight goes from ${r.from} to ${r.to}` },
    { what: 'harnesses', detail: on.ids.length ? `${on.ids.join(', ')}: switched off before the code changes and on again after it` : 'no agent is being captured, so none is switched off', harness: null, harnesses: on.ids },
  ]
  const g = await gate([['Code', `${r.from} -> ${r.to}`], ['Off and on again', on.ids.join(', ') || 'nothing is being captured']], planned, COST)
  if (g !== null) return g

  // 1 · (old code) off, and the names into the handover file — the new code switches on what this file names, nothing else (D67①)
  const offExit = on.ids.length ? await step(deps.off || runOffCli, [...on.ids, '--yes', '--json'], { io, env, home, platform, deps }) : { exit: EXIT.ok, doc: null }
  if (offExit.exit !== EXIT.ok) return no('off-failed', `the agents being captured could not be switched off (asight off exit ${offExit.exit}), so the code was left as it is`)
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
  const argv = ['update', '--yes', ...(json ? ['--json'] : [])]
  // a process killed by a signal has no exit code to copy: `child` answers `{signal}` for that, and anything else is its exit code
  const child = deps.child || ((file, args) => runAsync(file, args, { quiet: true, inherit: true, env }).then((x) => (x.status === null ? { signal: x.signal } : x.status)))
  const ended = await child(process.execPath, [path.join(root, 'bin', 'asight.mjs'), ...argv])
  if (!Number.isInteger(ended)) {
    return no('child-crashed', `the code is now ${r.to}, but the process that was to finish this update was killed${ended && ended.signal ? ` by ${ended.signal}` : ''} before it could. This update is written down, so run asight update again to finish it`)
  }
  return ended
}

/** 4 · (the new code) the daemon, `install` and `on`, and the handover file gone when all three are done (§5.5). `only: 'daemon'`: the
 *  code is already the newest and only the daemon runs another one — the one step of this phase the spec asks for then. */
async function finish({ io, env, home, platform, deps, dir, handover, root, fs, r, lines, done, no, waiting, only = null }) {
  r.from = waiting.from || r.from
  r.to = codeId(root)
  r.harnesses = waiting.on
  const problems = []
  const replaced = await replaceDaemon({ env, home, platform, deps, dir, root, fs, problems })
  r.restarted = replaced.restarted
  if (replaced.notes.length) r.notes.push(...replaced.notes)
  if (only === 'daemon') {
    if (problems.length) return no('daemon-not-replaced', problems[0])
    lines.push(`asight is now running ${r.to}.`)
    return done(EXIT.ok)
  }
  const installed = await step(deps.install || runInstallCli, ['--yes', '--json'], { io, env, home, platform, deps })
  r.install = installed.doc
  if (installed.exit !== EXIT.ok) problems.push(`the new code could not finish installing itself (asight install exit ${installed.exit}). ${AGAIN}`)
  if (!problems.length && waiting.on.length) {
    const back = await step(deps.on || runOnCli, [...waiting.on, '--yes', '--json'], { io, env, home, platform, deps })
    r.on = back.doc
    if (back.exit !== EXIT.ok) problems.push(`${waiting.on.join(', ')}: capture could not be switched on again (asight on exit ${back.exit}). ${AGAIN}`)
  }
  if (problems.length) { r.problems = problems; return no('not-finished', problems[0]) } // the file stays: the next run goes on from here
  try { fs.rmSync(handover, { force: true }) } catch (e) { return no('handover-not-removed', `this update finished, but it could not be written off (${(e && e.message) || e})`) }
  lines.push(`asight is now ${r.to} (it was ${r.from}).`,
    ...pairs([['Collector', r.restarted ? 'running the new code' : 'already running this code'], ['Capturing again', waiting.on.join(', ') || 'nothing was being captured']]))
  return done(EXIT.ok)
}

/** The daemon on this code: one that runs another (or answers no `code`) is taken out of the way the way `uninstall` takes it — the same
 *  drain-then-stop path (`drainDaemon`: `POST /off {exit:true}`, then the wait, §5.2) and the same `stopDaemon` — and pulled up again
 *  through the login entry install registered (a stopped LaunchAgent is booted out, so this bootstraps it, 4.9 §4).
 *  → `{ restarted, notes }`; what went wrong is pushed on `problems`. The three modules of this step are the new code's: they are loaded
 *  here, in the process that finishes, never in the one that merged. */
async function replaceDaemon({ env, home, platform, deps, dir, root, fs, problems }) {
  const notes = []
  const running = await daemonCode({ platform, dir, env, fs, deps })
  if (running === codeId(root)) return { restarted: false, notes }
  const { offWorld, drainDaemon } = await import('../off/orchestrate.mjs')
  const w = offWorld({ home, env, deps: { ...deps, platform } })
  const { routing } = await drainDaemon(w, { drainMs: deps.drainMs })
  notes.push(...routing.notes)
  const stopped = routing.stop || (routing.confirmed ? await w.stopDaemon({ unitManaged: w.unitManaged() }) : null)
  if (!stopped || (!stopped.stopped && stopped.pid != null)) { problems.push(`the collector (pid ${stopped ? stopped.pid : routing.daemon.pid}) could not be stopped${stopped && stopped.error ? ` (${stopped.error})` : routing.problems[0] ? ` (${routing.problems[0]})` : ''}, so it still runs ${running || 'code of its own'}. ${AGAIN}`); return { restarted: false, notes } }
  const { ensureDaemonUp } = await import('../collector/install.mjs')
  const unit = deps.unit !== undefined ? deps.unit : await loginUnit({ home, env, platform, deps })
  if (!unit) { problems.push('this platform has no login entry to start the collector through, so it was not replaced'); return { restarted: false, notes } }
  const up = await ensureDaemonUp({ osName: platform, dir, env, fs, unit, register: true, put: (e) => { if (e && e.reason) notes.push(e.reason) }, ...(deps.request ? { request: deps.request } : {}), ...(deps.socketPath ? { socketPath: deps.socketPath } : {}), ...(deps.sleep ? { pause: deps.sleep } : {}) })
  notes.push(...up.notes)
  if (!up.up) { problems.push(`the collector did not come back up (${up.problems[0] || 'it does not answer'}). ${AGAIN}`); return { restarted: false, notes } }
  return { restarted: true, notes }
}

const loginUnit = async ({ home, env, platform, deps }) => {
  const arch = await (await import('../collector/daemon.mjs')).loadArch(platform)
  if (!arch || !arch.unit || !arch.unit.userUnit) return null
  return arch.unit.userUnit({ home, node: process.execPath, script: deps.script || process.argv[1], run: deps.exec || null, env })
}

/** Which code the collector runs, as it says on its control channel (D67⑤): null when none answers or it names none. The endpoint is
 *  resolved the one way every caller resolves it (the 2026-10-11 incident): nothing platform-specific here. */
async function daemonCode({ platform, dir, env, fs, deps }) {
  if (deps.daemonCode) return await deps.daemonCode()
  const ep = controlEndpointFor({ platform, dir, env, fs })
  if (!ep.socketPath) return null
  try {
    const answer = await ep.request({ socketPath: ep.socketPath, method: 'GET', path: '/status', timeoutMs: 5000 })
    return (answer && typeof answer.code === 'string' && answer.code) || null
  } catch { return null }
}

/** `~/.asight/collector/update.json` as written: `{ from, on: [harness…] }`, or null when there is none (or it holds no list of names).
 *  Only ids this code has a descriptor for are kept — the names go to `asight on`, and one this code does not know (a harness dropped
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

/** The handover file, 0600 — it is asight's own note to itself (D27: everything of asight's is the operator's alone). */
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
 *  own output is held, not printed: one run of `asight update` prints one receipt. stdout and stderr are held APART — §1.2: the document
 *  is stdout's alone, and a line of stderr mixed into it would make it unparsable. */
async function step(run, argv, { io, env, home, platform, deps }) {
  const out = [], err = []
  const quiet = { ...io, out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) }
  const exit = await run(argv, { io: quiet, env, home, platform, deps, json: true })
  let doc = null
  try { doc = JSON.parse(out.join('\n')) } catch { /* a command that printed no document says so by its exit code */ }
  return { exit, doc }
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
