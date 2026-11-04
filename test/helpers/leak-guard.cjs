// test/helpers/leak-guard.cjs — `--require` preload for `npm test`: the run fails if its tests leave something behind — a temp
// entry, or a child process still running.
//
// The test runner's own process loads `--require` preloads and not `--import` ones, which is why this is CommonJS. It makes a
// temp directory that belongs to this run alone and points TMPDIR (and TMP / TEMP) at it, so every test file's `os.tmpdir()` — the
// children inherit the environment — is inside it. When the run ends, whatever is still there is something a test made and did
// not remove: it is named on stderr, removed, and the exit code becomes 1. Because the directory is private, another `npm test`
// running at the same time, or old leftovers from before, are never counted against this run — which a before / after listing
// of the shared OS temp dir cannot promise.
//
// A leak is a directory, or an entry named like ours (`trocar-…`, `as-…`, `atrace-…`); a stray file some library drops in TMPDIR is
// removed with the rest and not blamed on a test. The fix for a leak is `tmpDir()` from test/helpers/tmp.mjs, which removes the
// directory when the test process ends, pass or fail.
//
// Children: `npm test` runs with `--test-force-exit`, so a child a test file started and did not end outlives the file as an
// orphan (two `node -e … setInterval(…)` stubs were found alive 12–14 hours later). In a test file's process this preload tracks
// every child started through `ChildProcess.prototype.spawn` (spawn, fork, exec and execFile all go through it; the sync calls
// finish before they return), product code's children included. When the file's process exits, every one still running is
// SIGKILLed. One that would have lived on is also blamed: a marker `trocar-child-<pid>-<command>` holding the test file and the
// full command is left in the run's directory, and the runner names it and fails the run. Not blamed: a child that has exited
// and was not reaped yet (a zombie), one the test sent a signal, and one with an IPC channel — the product's forked workers exit
// when the channel closes, and a full run in report-only mode (2026-10-22) found nothing else: of 8 children alive at their file's end, 6
// were zombies and 2 were seal workers. The fix for a blamed child is to end it in a `finally` and await its 'exit' event.
//
// Leftovers of killed runs: a runner that is killed (SIGKILL, a parent process ending, a crash) never gets to 'exit', and its directory
// stays — with whole fresh HOMEs inside, 2.4 GB from twelve runs found on 2026-10-24. So a runner, at start, records its pid and its
// start time in `.runner` inside its directory, and removes every sibling `trocar-run-*` whose recorded runner is no longer running
// (same pid and same start time, so a reused pid is no owner). Another `npm test` running at the same time keeps its directory; one
// without the record (left by an older guard, or just made) is removed only once it is a day old.
//
// The cwd: `npm test` runs in the repo root, and a test that writes or binds a RELATIVE path leaves it there (2026-10-29: win32 pipe names
// `\\.\pipe\trocar-<hex>`, served as unix sockets on a Mac, piled up in the repo root). The runner lists its cwd when it
// starts and again after every test file has ended; a name in the second listing and not in the first fails the run and is named. Only the
// runner compares, and only the end state counts, so a file's temp entry that another file sees while files run in parallel, made and removed
// before the end, is no leak; an entry that was there before the run is never blamed. Nothing found there is removed: the cwd is a working
// tree, and the name says what to look for.
//
// Guard: test/helpers/leak-guard.test.mjs.
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { removeTree } = require('./rm-tree.cjs')

const OURS = /^(trocar|as|atrace)-/
const CHILD = 'trocar-child-'
const RUN = 'trocar-run-'
const RUNNER = '.runner'
const DAY = 24 * 3600 * 1000

/** True for a directory; false for anything else, and for an entry that has gone since it was listed (it must not end the check). */
function isDir(p) {
  try { return fs.lstatSync(p).isDirectory() } catch { return false }
}

/** What of `entries` (names inside the run's directory) counts as a leak. */
function leaked(dir, entries) {
  return entries.filter((name) => OURS.test(name) || isDir(path.join(dir, name)))
}

/** The marker a test file's process leaves for a child it killed: `trocar-child-<pid>-<first 40 chars of the command>`. */
function childMarker(pid, command) {
  return `${CHILD}${pid}-${command.slice(0, 40).replace(/[^A-Za-z0-9._-]+/g, '_')}`
}

/** The runner's side: this run's private TMPDIR, swept of dead runs; at exit, leftovers and blamed children fail it. Once per process. */
function guardRun() {
  if (guardRun.on) return
  guardRun.on = true
  const root = process.cwd()
  const before = new Set(names(root))
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), RUN))
  sweep(runDir)
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = runDir
  process.on('exit', () => {
    let left = []
    try { left = leaked(runDir, fs.readdirSync(runDir)) } catch { /* the run's directory was taken away: nothing to blame */ }
    const children = left.filter((name) => name.startsWith(CHILD))
    const entries = left.filter((name) => !name.startsWith(CHILD))
    if (children.length) {
      const shown = children.map((name) => {
        let what = name
        try { const m = JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8')); what = `pid ${m.pid} from ${m.file}: ${m.command}` } catch { /* a marker cut short: its name says enough */ }
        return `  ${what}`
      })
      fs.writeSync(2, `\nleak-guard: ${children.length} child ${children.length === 1 ? 'process was' : 'processes were'} still running when the test file that started ${children.length === 1 ? 'it' : 'them'} ended (killed now):\n${shown.join('\n')}\n` +
        "  end each child in a finally and await its 'exit' event\n")
      process.exitCode = 1
    }
    if (entries.length) {
      const shown = entries.map((name) => `  ${name}${isDir(path.join(runDir, name)) ? '/' : ''}`)
      const many = entries.length === 1
      fs.writeSync(2, `\nleak-guard: ${entries.length} temp ${many ? 'entry' : 'entries'} made by this test run ${many ? 'was' : 'were'} not removed (removed now):\n${shown.join('\n')}\n` +
        `  find the test that made one with: grep -rn "'${entries[0].replace(/[A-Za-z0-9]{6}$/, '')}" test\n` +
        '  make test directories with tmpDir() from test/helpers/tmp.mjs; it removes them when the test process ends, pass or fail\n')
      process.exitCode = 1
    }
    removeTree(runDir)
    const added = names(root).filter((name) => !before.has(name))
    if (added.length) {
      fs.writeSync(2, `\nleak-guard: ${added.length} ${added.length === 1 ? 'entry' : 'entries'} appeared in ${root} during this run and ${added.length === 1 ? 'is' : 'are'} still there (left in place):\n` +
        `${added.map((name) => `  ${name}`).join('\n')}\n  a test wrote or bound a relative path; give it an absolute one under tmpDir() from test/helpers/tmp.mjs\n`)
      process.exitCode = 1
    }
  })
}

/** The names in `dir`, or none when it cannot be listed (a cwd taken away is nothing to blame). */
function names(dir) {
  try { return fs.readdirSync(dir) } catch { return [] }
}

/** pid → start time of the process running under it now, for those of `pids` that run; without `process.pid` in it, nothing is
 *  known. Windows has no `ps`: a running pid is taken as the same process. */
function started(pids) {
  if (process.platform === 'win32') return new Map(pids.filter((pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }).map((pid) => [pid, '']))
  const r = require('node:child_process').spawnSync('/bin/ps', ['-o', 'pid=', '-o', 'lstart=', '-p', pids.join(',')], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  return new Map(String(r.stdout ?? '').split('\n').map((l) => l.trim().split(/\s+/)).filter(([pid]) => pid).map(([pid, ...t]) => [Number(pid), t.join(' ')]))
}

/** Records this runner in `runDir`, then removes the sibling run directories of runners that are gone (see the top of the file). */
function sweep(runDir) {
  const tmp = path.dirname(runDir)
  let names = []
  try { names = fs.readdirSync(tmp).filter((n) => n.startsWith(RUN) && n !== path.basename(runDir)) } catch { /* nothing to sweep */ }
  const owners = new Map(names.map((n) => {
    try { const m = JSON.parse(fs.readFileSync(path.join(tmp, n, RUNNER), 'utf8')); return [n, Number.isInteger(m.pid) ? m : null] } catch { return [n, null] }
  }))
  const running = started([process.pid, ...[...owners.values()].filter(Boolean).map((m) => m.pid)])
  try { fs.writeFileSync(path.join(runDir, RUNNER), JSON.stringify({ pid: process.pid, start: running.get(process.pid) ?? null })) } catch { /* not recorded: swept once a day old */ }
  for (const [n, owner] of owners) {
    const dir = path.join(tmp, n)
    const gone = owner && running.has(process.pid) && (!running.has(owner.pid) || (owner.start !== null && running.get(owner.pid) !== owner.start))
    if (owner ? gone : old(dir)) removeTree(dir)
  }
}

function old(dir) {
  try { return Date.now() - fs.lstatSync(dir).mtimeMs > DAY } catch { return false }
}

/** Of `pids`, the ones that have exited and wait to be reaped: their 'exit' had not been seen yet, which is no leak. On Windows an
 *  exited process makes process.kill throw, so none is listed there. `/bin/ps` because a test may point PATH at its stubs. */
function zombies(pids) {
  if (process.platform === 'win32' || !pids.length) return new Set()
  const r = require('node:child_process').spawnSync('/bin/ps', ['-o', 'pid=', '-o', 'stat=', '-p', pids.join(',')], { encoding: 'utf8' })
  return new Set(String(r.stdout ?? '').split('\n').map((l) => l.trim().split(/\s+/)).filter(([, stat]) => stat?.startsWith('Z')).map(([pid]) => Number(pid)))
}

/** A test file's side: every child it starts and leaves running is killed at exit, and one that would have lived on leaves a marker
 *  for the runner. Once per process; returns that end-of-file check, for a runner whose workers do not reach 'exit' (Vitest). */
function guardChildren() {
  if (guardChildren.end) return guardChildren.end
  const { ChildProcess } = require('node:child_process')
  const runDir = os.tmpdir() // now, before a test points TMPDIR somewhere else
  const running = new Map() // child → it was started with an IPC channel
  const spawn = ChildProcess.prototype.spawn
  ChildProcess.prototype.spawn = function (...args) {
    const result = spawn.apply(this, args)
    if (this.pid) {
      running.set(this, Boolean(this.channel))
      this.once('exit', () => running.delete(this))
    }
    return result
  }
  const end = (file = process.argv[1]) => {
    const left = [...running.keys()].filter((child) => child.exitCode === null && child.signalCode === null)
    const dead = zombies(left.map((child) => child.pid))
    for (const child of left) {
      const ipc = running.get(child)
      running.delete(child) // a second call (Vitest's afterAll, then 'exit') looks at it once
      try { process.kill(child.pid, 'SIGKILL') } catch { continue } // gone already
      // blamed: a child that would have lived on. Not one that has exited already, one the test signalled, or one with an IPC
      // channel (fork's children here exit when the channel closes: src/collector/seal-worker.mjs, src/query/worker.mjs)
      if (dead.has(child.pid) || child.killed || ipc) continue
      const command = child.spawnargs.join(' ')
      try { fs.writeFileSync(path.join(runDir, childMarker(child.pid, command)), JSON.stringify({ pid: child.pid, file, command })) } catch { /* the run's directory is gone */ }
    }
  }
  process.on('exit', () => end())
  guardChildren.end = end
  return end
}

// `npm test`: the runner is the process started with --test; a test file's process has NODE_TEST_CONTEXT, a plain `node file` neither.
// Vitest (`npm run test:web`) calls the two itself: web/vitest.config.mjs in its main process, web/vitest.setup.mjs in each worker.
if (process.execArgv.includes('--test') && !process.env.NODE_TEST_CONTEXT) guardRun()
if (process.env.NODE_TEST_CONTEXT) guardChildren()

module.exports = { leaked, guardRun, guardChildren }
