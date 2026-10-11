// procinfo.mjs — process facts for the macOS collector and exec / exit by snapshot difference (RFC 4.9 §1; the poll-to-diff state machine, its tolerances and its event shapes
// are the Windows collector's, RFC 4.8 §1, §10.1, W2 — carried over from arch/win32/procinfo.mjs unchanged. What 4.9 §1 replaces is everything the resident helper used to do:
// the data source (one `ps` per question, run when asked through execTool — no helper process, no CIM command-line dance), and the scoping the helper did server-side. The win32
// file is the shape donor; where this file differs from it, the diff is one 4.9 §1 names).
//
// Linux hears exec and exit from the kernel; macOS has no such event for a user-mode collector, so the watcher asks `ps` every `intervalMs` (2 s) and compares with the last
// answer. A process is its pid AND its start time: the same pid with another start time (or, when the start time cannot be read, another image path) is an exit followed by an
// exec — the rule carries from Windows (which reuses pids quickly); darwin wraps its pids more slowly, but a wrapped pid is still an exit and an exec, not a silent replacement.
//
// ProcFacts here = the Linux contract (core/redirector.mjs) as far as one `ps` answer has the fields: { os:'darwin', pid, ppid, name, exe, argv, cmdline, env:null (envError
// 'env-unreadable': another process's environment is never read on macOS either — no privilege to, and `ps` has no such column; 4.8 §10.1) with envRead:false — the OS's rule, not
// a failure to read, so the tracker judges by the entry files instead of vetoing (4.8 §5.4, Task 8(v)) —, cwd:null, startedAt (ms since the epoch, or null), startTicks (startedAt
// as a string: the identity a per-pid marker would carry; null with it), sessionId (null: `ps` has no session question — the win32 column, kept for the shape), integrity (null),
// tokenDenied (false: no token is ever asked for), elevated, elevationInferred, cmdlineState, source:'exec'|'scan'|'update' }. `name` is `comm`, the kernel's accounting name — at
// most 16 characters (MAXCOMLEN); `exe` is the first word of the command line, the path as the program was invoked (with `args` asked for in the same command, `ps` gives the
// executable's full path in no column, so that is the best one-shot answer); `cmdline` is the raw command line and `argv` is it split on white space — `ps` joins the arguments
// with spaces, so the argument boundaries are lost (a path with a space in it splits; the same documented loss as src/off/proc.mjs's table, same command family). `cmdline` may
// hold secrets: callers keep it in memory and never write it to a record. `cmdline: null` is one thing on darwin, told by `cmdlineState`: not there (`empty` — the row has no
// command line at all; final, nothing will come). The win32 "not known YET" (`pending`, `cim-backoff`) is gone with the CIM dance: the single answer carries the command line with
// the row, so 'facts-update' never fires today — its branch and its event shape stay (the redirector subscribes to them) for the day a not-yet state is added. A consumer that
// judges by command line (node + dsh) needs no wait on darwin; a form known by its image path needs none anywhere.
//
// The one command, and the shape of its answer (measured on the darwin kernels this collector runs on, macOS 26.6.2 arm64; ps from the C locale, set below, is what keeps the
// words English):
//   ps -axo pid=,ppid=,uid=,comm=,lstart=,args=
//     42177     1     0 /opt/homebrew/Ce Tue Oct  6 17:58:06 2026     /opt/homebrew/Cellar/python@3.14/.../Python -I ...
// `pid` `ppid` `uid` are integers, right-aligned and padded; `lstart` is the process start time, five words in exactly this format: "Mon Oct  8 17:00:00 2026" — weekday and month
// as three letters, the day one or two digits (a one-digit day is preceded by TWO spaces), the time hh:mm:ss, a four-digit year; local time, to the second (so the identity is as
// fine as the source: two lives of one pid in the same second with the same exe are one process to this watcher). The column ORDER is not the RFC's listing (pid,ppid,uid,comm,
// args,lstart): with the command line in the middle, this kernel's `ps` caps every line at 128 columns and cuts the command line mid-word (measured: a 417-character command line
// came back 95; with the command column LAST it is whole — the same property src/off/proc.mjs's table relies on), and `comm` sits before `lstart` because lstart's fixed five-word
// shape is what bounds `comm` from the right (a comm with a space in it would run together with a following args column with no way to tell them apart; comm is at most 16
// characters, so it can never itself contain an lstart-shaped run and steal the anchor). The `=` on every column name asks `ps` for no header line: a header is not a process row
// and must not be noise in every poll. A `ps` that prints lines and not one parseable row is an error, not an empty machine (D38): a localized lstart or a changed format is said
// in a poll-error, never read as "nobody is running".
//
// Only this user's processes are kept (`uid`, the watcher's own by default — the win32 session default's counterpart: a process of another user is not this user's agent, and the
// Linux collector scopes the same way, arch/linux/redirector.mjs `uid = process.getuid()`; `all: true` keeps every user's rows). Everything that touches the machine is injected:
// `exec` (the runner of the one command, spawnSync-shaped — execTool's `run`; a test injects one and nothing real runs), `now`, `timers`. `env` is what `ps` runs in, with LC_ALL=C
// added here: `ps` prints dates in the user's language, and under LC_ALL=zh_CN.UTF-8 the five words of `lstart` are no longer "Mon Oct  8 17:00:00 2026" — the audit rule-b 2
// lesson of src/off/proc.mjs, the same command family.
import { EventEmitter } from 'node:events'
import { execTool } from '../../../off/exec.mjs'

/** How long the watcher waits for one `ps` answer, a poll or a scan: the Windows value carried over unchanged (4.9 §1: the tolerances carry). Generous for a whole-machine table
 *  read on a cold or busy machine — a `ps` that exceeds it is killed by execTool's timeout, the poll says so, and the next poll asks again. */
export const PS_TIMEOUT_MS = 10000
/** What a ps row's `cmdlineState` can say: `ok` the command line is there · `empty` the row has none at all (a process being born, or one whose argv is gone — final: nothing
 *  will come). The Windows `pending` and `cim-backoff` are gone with the CIM dance (4.9 §1: the command line arrives with the row), and `not-asked` with the per-process ask: the
 *  single answer always carries the column. `null` is only "not there" on darwin, never "not yet". */
export const CMDLINE_STATES = Object.freeze(['ok', 'empty'])
const NOT_YET = new Set([]) // no not-yet state exists on darwin (CMDLINE_STATES): the facts-update branch in step() can never fire today. It stays because the event's shape is the contract (the redirector subscribes), and for the day one is added.
/** The state of a row's command line; a row that does not say (a fixture): a command line is `ok`, none is `empty` (final: nothing will come). */
const cmdStateOf = (row) => (typeof row.cmdlineState === 'string' ? row.cmdlineState : row.cmdline != null ? 'ok' : 'empty')

/** Is the process elevated? { elevated: true | false | null, inferred }. Root is uid 0 — the one question darwin's `ps` answers with its `uid` column (4.9 §1: elevation is
 *  uid===0). It is never inferred (the Windows token-denied judgement has no darwin counterpart: the answer is in the row or it is not), and with no uid read the answer is
 *  null: not known. */
export function elevationOf(row) {
  if (row.uid != null) return { elevated: row.uid === 0, inferred: false }
  return { elevated: null, inferred: false }
}

/** The one command this watcher asks: every process of the machine, the three integers, the accounting name, the five words of lstart, and the command line to the end of the
 *  line (whole — see the file header for why the command column is last and comm sits before lstart). */
const PS_ARGS = ['-axo', 'pid=,ppid=,uid=,comm=,lstart=,args=']
/** A row of the answer: three integers, the accounting name (any characters — it is bounded by lstart's fixed shape to its right, and comm cannot itself contain that shape),
 *  the five words of lstart, and the command line to the end of the line. */
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*?)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/
// `ps` prints dates in the user's language: the C locale gives the same five words on every machine (see the file header).
const psEnv = (env) => ({ ...env, LC_ALL: 'C' })

/** The command line split into arguments the way `ps` left it: on white space (the argument boundaries were lost when `ps` joined them; a path with a space in it splits —
 *  the documented loss of this data source). Nothing (null, empty) is no arguments. */
const argvOf = (cmdline) => (typeof cmdline === 'string' && cmdline.trim() !== '' ? cmdline.trim().split(/\s+/) : [])

/** One process's start time, asked alone (`ps -o lstart= -p <pid>`): the same five words, the same C locale and the same clock the table's rows read — the forwarder's lock and
 *  its adopt rule compare start times with the watcher's, so there is one parser of lstart, not two. A `ps` that fails (a pid that is gone among them) throws what it threw; the
 *  caller (the wiring's procStart) answers null for that, which is the honest "not known", never a guess. */
export function startedAtOf(pid, { exec = null, env = process.env, psTimeoutMs = PS_TIMEOUT_MS } = {}) {
  const r = execTool('ps', ['-o', 'lstart=', '-p', String(pid)], { run: exec, env: psEnv(env), timeoutMs: psTimeoutMs })
  if (r.code !== 0) throw new Error(`ps failed (${r.code === null ? r.err || 'no exit: killed by its timeout or never started' : `exit ${r.code}${r.err ? `: ${r.err}` : ''}`})`)
  const text = String(r.out).trim()
  if (!text) return null
  const at = new Date(text.replace(/\s+/g, ' ')).getTime() // lstart is local time with no zone; a zone-less string is read in the machine's zone — the one that printed it
  return Number.isFinite(at) ? at : null
}

function factsOf(row, source) {
  const { elevated, inferred } = elevationOf(row)
  const facts = {
    os: 'darwin', pid: row.pid, ppid: row.ppid ?? null, name: row.name ?? null, exe: row.exe, argv: argvOf(row.cmdline), cmdline: row.cmdline ?? null,
    env: null, envRead: false, cwd: null, startedAt: row.startedAt ?? null, startTicks: row.startedAt != null ? String(row.startedAt) : null,
    sessionId: null, integrity: null, tokenDenied: false, elevated, elevationInferred: inferred, source, cmdlineState: cmdStateOf(row),
  }
  Object.defineProperty(facts, 'envError', { enumerable: false, value: 'env-unreadable' })
  return facts
}

const identity = (row) => `${row.startedAt ?? '?'}|${row.exe ?? ''}`

/** createProcWatcher({ exec, env, uid, intervalMs, psTimeoutMs, now, all, timers }) → EventEmitter with start() · stop() · poll() · scan() · unreadable() · stats().
 *  `exec` is the runner of the one `ps` command (spawnSync-shaped, execTool's `run` — injected; nothing is spawned when a test gives one), `env` the environment `ps` runs in
 *  (LC_ALL=C is added here), `uid` the user whose processes are kept (default: this process's own — a test passes one, or `all: true` to keep every user's rows).
 *  Events: 'exec' ProcFacts (source 'exec') · 'exit' {pid, startedAt} · 'facts-update' ProcFacts (source 'update': the same process, told when its command line that was `pending`
 *  / `cim-backoff` at the exec — or in the baseline — is now `ok` or `empty`; no not-yet state exists on darwin, so this never fires today; the shape stays, see the file header)
 *  · 'facts-error' {os, pid, comm, argv, code, reason} (a process with no command line, so no image path: never judged, told once) · 'poll-error' {code:'helper-error', cause,
 *  reason, …} (something went wrong in a poll — `ps` failed, the answer held rows that are not processes, or a listener of another event threw — told once per run of the same
 *  failure, never thrown: `cause` = the error's code when `ps` failed, 'listener-threw' {event, pid} when a listener of another event threw — that event is not retried, the rest
 *  of the poll is still announced — and 'malformed-rows' {count} when the answer held lines that are not process rows, which are skipped. The code is the Windows one: it is in
 *  the closed set (codes.mjs) and the daemon's record of a watcher failure, whatever failed it, is `helper-error`).
 *  The first poll() is the baseline and emits nothing: what is already running is scan()'s (startup and every `on`), exec / exit are what changes after it. scan() takes the
 *  baseline itself when none was taken (so scan-then-start and start-then-scan are both safe: a process created between the two is an exec, never in neither), then lists the
 *  live processes as facts and moves nothing the diff knows. start() returns the baseline's promise. scan() throws what `ps` throws — a daemon that cannot list processes must
 *  say so. `all` keeps every user's rows instead of `uid`'s.
 *  poll() never rejects and never throws into a timer: every failure of a poll is a 'poll-error' — except ESANDBOX (exec.mjs's rule: a test that forgot to inject the runner is
 *  a bug to fail on, not a machine condition to report). Every ps waits up to `psTimeoutMs` (10 s); a poll whose `ps` is killed by that timeout is answered (execTool's timeout
 *  kills the process), and the next poll asks again — each poll is its own `ps` process, there is no serial helper to queue behind, so nothing is deferred. */
export function createProcWatcher({ exec = null, env = process.env, uid = (typeof process.getuid === 'function' ? process.getuid() : null), intervalMs = 2000, psTimeoutMs = PS_TIMEOUT_MS, now = Date.now, all = false, timers = { setInterval, clearInterval } } = {}) {
  const ev = new EventEmitter()
  const known = new Map() // pid → { identity, startedAt, cmdState } of the processes already reported (or in the baseline); cmdState = what the consumer was last told about the command line
  const unreadable = new Map()
  let primed = false
  let inflight = null // the poll being run, so a scan can wait for the baseline instead of racing it
  let first = null // start()'s baseline poll
  let failing = false
  let malformed = false
  let timer = null
  const counters = { polls: 0, lastPollAt: null, listenerErrors: 0 }

  /** Announces one event so that a listener that throws cannot take the rest of the poll (or the timer) with it: the throw becomes a poll-error,
   *  and a poll-error listener that throws has nobody left to tell. */
  function tell(name, payload) {
    try { ev.emit(name, payload) } catch (e) {
      counters.listenerErrors++
      if (name === 'poll-error') return
      tell('poll-error', { code: 'helper-error', cause: 'listener-threw', event: name, pid: payload && payload.pid != null ? payload.pid : null, reason: `a '${name}' listener threw: ${String((e && e.message) || e).slice(0, 200)}` })
    }
  }

  /** Runs the one command and parses its answer into rows: { pid, ppid, uid, name (comm, the accounting name), exe (the command line's first word, null when there is no
   *  command line), cmdline (null when the row has none), startedAt (ms, from lstart — local time, second granularity; null when the five words do not parse),
   *  cmdlineState }. Throws when `ps` failed, or printed lines and not one parseable row; lines that are not process rows are skipped and told once per run of them (the
   *  malformed-rows poll-error, announced here). Rows of another user are dropped here (`all` keeps them) — the win32 helper filtered server-side; the diff never sees them. */
  async function snapshot() {
    const r = execTool('ps', PS_ARGS, { run: exec, env: psEnv(env), timeoutMs: psTimeoutMs })
    if (r.code !== 0) throw new Error(`ps failed (${r.code === null ? r.err || 'no exit: killed by its timeout or never started' : `exit ${r.code}${r.err ? `: ${r.err}` : ''}`})`)
    const rows = []
    let lines = 0
    let parsed = 0
    for (const line of String(r.out).split('\n')) {
      if (!line.trim()) continue
      lines++
      const m = PS_ROW.exec(line)
      if (!m) continue
      parsed++
      const cmdline = m[6].trim() !== '' ? m[6].trim() : null
      const argv = argvOf(cmdline)
      const at = new Date(m[5].replace(/\s+/g, ' ')).getTime() // lstart is local time with no zone; a zone-less string is read in the machine's zone — the one that printed it
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), name: m[4] !== '' ? m[4] : null, exe: argv.length > 0 ? argv[0] : null, cmdline, startedAt: Number.isFinite(at) ? at : null, cmdlineState: cmdline != null ? 'ok' : 'empty' })
    }
    if (lines > 0 && parsed === 0) throw new Error(`ps printed ${lines} line(s) and not one could be read (the first: ${JSON.stringify(String(r.out).split('\n').find((l) => l.trim()).slice(0, 80))}); the five words of lstart may have come in another language, or the format changed`)
    if (parsed !== lines) {
      if (!malformed) { malformed = true; tell('poll-error', { code: 'helper-error', cause: 'malformed-rows', count: lines - parsed, reason: `${lines - parsed} of ps's ${lines} lines are not process rows (pid, ppid, uid, comm, lstart, args); they are skipped` }) }
    } else malformed = false
    return all || uid == null ? rows : rows.filter((x) => x.uid === uid)
  }

  function noteUnreadable(rows) {
    const here = new Set()
    for (const r of rows) {
      if (r.exe != null) continue
      here.add(r.pid)
      const prev = unreadable.get(r.pid)
      const id = String(r.startedAt ?? '?')
      if (prev && prev.id === id) continue
      const argv = argvOf(r.cmdline)
      unreadable.set(r.pid, { id, pid: r.pid, comm: r.name ?? null, errno: null, argv })
      tell('facts-error', { os: 'darwin', pid: r.pid, comm: r.name ?? null, code: null, argv, reason: `${r.name ?? 'a process'} (pid ${r.pid}): its command line is empty, so its image path is not known; it is never judged` })
    }
    for (const pid of [...unreadable.keys()]) if (!here.has(pid)) unreadable.delete(pid)
  }

  async function step() {
    let rows
    try { rows = await snapshot() } catch (e) {
      if (e && e.code === 'ESANDBOX') throw e // exec.mjs: a caller must not catch it — a test that forgot to inject the runner fails here, it does not pass over a path it never ran
      if (!failing) { failing = true; tell('poll-error', { code: 'helper-error', cause: (e && e.code) ?? null, reason: String((e && e.message) || e) }) }
      return
    }
    failing = false
    counters.polls++
    counters.lastPollAt = now()
    noteUnreadable(rows)
    const present = new Set(rows.map((r) => r.pid))
    const exits = []
    const execs = []
    const updates = []
    for (const [pid, prev] of known) if (!present.has(pid)) { exits.push({ pid, startedAt: prev.startedAt }); known.delete(pid) }
    for (const r of rows) {
      if (r.exe == null) continue
      const prev = known.get(r.pid)
      const st = cmdStateOf(r)
      if (prev && prev.identity === identity(r)) {
        // a command line that was not known yet and now is, or is given up on: the facts a consumer judged by are stale — no not-yet state exists on darwin today, so this
        // never fires; it stays for the day one is added (the redirector subscribes to the event either way)
        if (NOT_YET.has(prev.cmdState) && st !== prev.cmdState) { prev.cmdState = st; if (!NOT_YET.has(st)) updates.push(r) }
        continue
      }
      if (prev) exits.push({ pid: r.pid, startedAt: prev.startedAt })
      known.set(r.pid, { identity: identity(r), startedAt: r.startedAt ?? null, cmdState: st })
      execs.push(r)
    }
    if (primed) {
      for (const x of exits) tell('exit', x)
      for (const r of execs) tell('exec', factsOf(r, 'exec'))
      for (const r of updates) tell('facts-update', factsOf(r, 'update'))
    }
    primed = true
  }

  /** One difference step. Resolves true when it ran, false when the previous one was still in flight. Never rejects (ESANDBOX excepted, which is a caller's bug). */
  function poll() {
    if (inflight) return Promise.resolve(false)
    inflight = (async () => {
      try { await step() } catch (e) {
        if (e && e.code === 'ESANDBOX') throw e
        tell('poll-error', { code: 'helper-error', cause: 'poll-threw', reason: `a poll threw: ${String((e && e.message) || e).slice(0, 200)}` })
      }
      return true
    })().finally(() => { inflight = null })
    return inflight
  }

  /** The live processes as facts. The baseline comes first: a scan taken before any baseline would leave a process created between the scan and the
   *  first poll in neither (the baseline takes it in silently), so with none taken yet scan() takes it (or waits for the one in flight) itself. A process
   *  created after the scan's own snapshot is then an `exec` — possibly one the scan already listed: a duplicate, never a gap (the tracker judges a pid again). */
  async function scan() {
    if (!primed) { if (inflight) await inflight; else await poll() }
    const rows = await snapshot()
    noteUnreadable(rows)
    return rows.filter((r) => r.exe != null).map((r) => factsOf(r, 'scan'))
  }

  const tick = () => { poll().catch(() => {}) } // poll() does not reject; this is the last wall before an unhandled rejection takes the daemon down

  return Object.assign(ev, {
    poll,
    scan,
    /** Polls at once and every `intervalMs`. Returns the baseline poll's promise (true once it ran): await it to know what is already running is taken in. */
    start() {
      if (timer) return first
      first = poll()
      first.catch(() => {})
      timer = timers.setInterval(tick, intervalMs)
      if (timer && timer.unref) timer.unref()
      return first
    },
    stop() { if (timer) { timers.clearInterval(timer); timer = null } },
    /** The processes of this user whose image path is unreadable and that are still there: [{pid, comm, errno, argv}] (Linux's shape; errno is null — `ps` gives none, the
     *  cause is that the row has no command line at all). */
    unreadable: () => [...unreadable.values()].map(({ pid, comm, errno, argv }) => ({ pid, comm, errno, argv })),
    stats: () => ({ ...counters, failing }), // no `deferred`: there is no serial helper to queue a poll behind on darwin (each poll is its own ps), so nothing is ever deferred
  })
}
