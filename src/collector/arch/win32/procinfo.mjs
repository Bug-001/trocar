// procinfo.mjs — process facts for the Windows collector and exec / exit by snapshot difference (RFC 4.8 §1, §10.1, W2).
//
// Linux hears exec and exit from the kernel; Windows has no such event for a user-mode collector, so the watcher asks the helper's `ps`
// verb every `intervalMs` (2 s) and compares with the last answer. A process is its pid AND its start time: the same pid with another
// start time (or, when the start time cannot be read, another image path) is an exit followed by an exec — Windows reuses pids quickly.
//
// ProcFacts here = the Linux contract (core/redirector.mjs) as far as Windows has the fields: { os:'win32', pid, ppid, name, exe, argv,
// cmdline, env:null (envError 'env-unreadable': another process's environment is never read, 4.8 §10.1), cwd:null, startedAt (ms since the
// epoch, or null), startTicks (startedAt as a string: the identity a per-pid marker would carry; null with it), sessionId, integrity,
// tokenDenied, elevated, elevationInferred, cmdlineState, source:'exec'|'scan'|'update' }. `cmdline` is the raw command line (the one lossless form on
// Windows; `argv` is it split like CommandLineToArgvW). It may hold secrets: callers keep it in memory and never write it to a record. `cmdline: null` is
// two different things, told by `cmdlineState`: not known YET (`pending`, `cim-backoff`: the helper asks CIM per process, three tries, a 30 s back-off after a
// CIM failure) or not there (`empty`, `not-asked`). A consumer that judges by command line (node.exe + dsh) must wait on the first and judges again on the
// watcher's 'facts-update', which is told when a command line that was not known yet arrives or is given up on; a form known by its image path need not.
// Only this session's processes are asked for (the helper's default): a process of another session is not this user's agent.
import { EventEmitter } from 'node:events'

/** How long the watcher waits for one `ps` answer, a poll or a scan. The first ps after the helper starts has an empty command-line cache: more than 40 processes
 *  take a full Win32_Process enumeration through CIM (plus the module load), which on a cold or busy machine is more than the 2 s a table read gets. */
export const PS_TIMEOUT_MS = 10000
/** What a ps row's `cmdlineState` can say (helper.ps1 decides; a test keeps the two lists equal): `ok` the command line is there · `pending` asked, no answer
 *  yet, asked again next poll · `cim-backoff` CIM failed, not asked again for 30 s · `empty` asked three times and CIM has none (a process without one, or one CIM
 *  does not show) · `not-asked` the caller said `cmdline:false`. `pending` and `cim-backoff` are NOT "no command line": it may still come. */
export const CMDLINE_STATES = Object.freeze(['ok', 'pending', 'cim-backoff', 'empty', 'not-asked'])
const NOT_YET = new Set(['pending', 'cim-backoff'])
/** The state of a row's command line; a helper that does not say (an older one, a fixture): a command line is `ok`, none is `empty` (final: nothing will come). */
const cmdStateOf = (row) => (typeof row.cmdlineState === 'string' ? row.cmdlineState : row.cmdline != null ? 'ok' : 'empty')

const ELEVATED = new Set(['high', 'system', 'protected'])

/** Is the process elevated? { elevated: true | false | null, inferred }. Integrity High or above is elevated. A token that cannot be opened while the
 *  image path can (PROCESS_QUERY_LIMITED_INFORMATION opens across integrity levels, the token does not) is judged elevated and marked inferred
 *  (4.8 §10.1). With neither the answer is null: not known. */
export function elevationOf(row) {
  if (row.integrity != null) return { elevated: ELEVATED.has(row.integrity), inferred: false }
  if (row.tokenDenied && row.exe != null) return { elevated: true, inferred: true }
  return { elevated: null, inferred: false }
}

/** A command line split into arguments the way CommandLineToArgvW does (the post-2008 rules; MS "Parsing C++ command-line arguments"): the program
 *  name (up to the first space, or the closing quote when it starts with one) takes no backslash escapes; after it 2n backslashes before a quote
 *  are n backslashes and the quote toggles quoting, 2n+1 are n backslashes and a literal quote, backslashes elsewhere are literal, and `""` inside
 *  a quoted string is one quote. Nothing (null, empty) is no arguments. */
export function splitCommandLine(cmdline) {
  if (typeof cmdline !== 'string') return []
  const s = cmdline
  const out = []
  let i = 0
  const skipBlank = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++ }
  skipBlank()
  if (i >= s.length) return out
  if (s[i] === '"') { // the program name: quoted up to the next quote, no escapes
    const end = s.indexOf('"', i + 1)
    out.push(s.slice(i + 1, end < 0 ? s.length : end))
    i = end < 0 ? s.length : end + 1
  } else {
    let j = i
    while (j < s.length && s[j] !== ' ' && s[j] !== '\t') j++
    out.push(s.slice(i, j))
    i = j
  }
  for (skipBlank(); i < s.length; skipBlank()) {
    let arg = ''
    let quoted = false
    let backslashes = 0
    for (; i < s.length; i++) {
      const c = s[i]
      if (c === '\\') { backslashes++; continue }
      if (c === '"') {
        arg += '\\'.repeat(backslashes >> 1)
        const escaped = backslashes % 2 === 1
        backslashes = 0
        if (escaped) { arg += '"'; continue }
        if (quoted && s[i + 1] === '"') { arg += '"'; i++; continue }
        quoted = !quoted
        continue
      }
      arg += '\\'.repeat(backslashes); backslashes = 0
      if (!quoted && (c === ' ' || c === '\t')) break
      arg += c
    }
    out.push(arg + '\\'.repeat(backslashes))
  }
  return out
}

function factsOf(row, source) {
  const { elevated, inferred } = elevationOf(row)
  const facts = {
    os: 'win32', pid: row.pid, ppid: row.ppid ?? null, name: row.name ?? null, exe: row.exe, argv: splitCommandLine(row.cmdline), cmdline: row.cmdline ?? null,
    env: null, cwd: null, startedAt: row.startedAt ?? null, startTicks: row.startedAt != null ? String(row.startedAt) : null,
    sessionId: row.sessionId ?? null, integrity: row.integrity ?? null, tokenDenied: !!row.tokenDenied, elevated, elevationInferred: inferred, source, cmdlineState: cmdStateOf(row),
  }
  Object.defineProperty(facts, 'envError', { enumerable: false, value: 'env-unreadable' })
  return facts
}

const identity = (row) => `${row.startedAt ?? '?'}|${row.exe ?? ''}`

/** createProcWatcher({ helper, intervalMs, psTimeoutMs, now, all, timers }) → EventEmitter with start() · stop() · poll() · scan() · unreadable() · stats().
 *  Events: 'exec' ProcFacts (source 'exec') · 'exit' {pid, startedAt} · 'facts-update' ProcFacts (source 'update': the same process, told when its command
 *  line that was `pending` / `cim-backoff` at the exec (or in the baseline) is now `ok` or `empty`; once, never for a state that was final) · 'facts-error' {os, pid, comm, argv, code, reason} (a process whose image path
 *  cannot be read: never judged, told once) · 'poll-error' {code:'helper-error', cause, reason, …} (something went wrong in a poll, told once per run of
 *  the same failure, never thrown: `cause` = the client's error code when the helper failed, 'listener-threw' {event, pid} when a listener of another
 *  event threw — that event is not retried, the rest of the poll is still announced — and 'malformed-rows' {count} when the helper's answer held rows
 *  that are not processes, which are skipped).
 *  The first poll() is the baseline and emits nothing: what is already running is scan()'s (startup and every `on`), exec / exit are what
 *  changes after it. scan() takes the baseline itself when none was taken (so scan-then-start and start-then-scan are both safe: a process created
 *  between the two is an exec, never in neither), then lists the live processes as facts and moves nothing the diff knows. start() returns the baseline's
 *  promise. scan() throws what the helper throws — a daemon that cannot list processes must say so. `all` asks for every session.
 *  poll() never rejects and never throws into a timer: every failure of a poll is a 'poll-error'. Every ps waits up to `psTimeoutMs` (10 s); a poll that
 *  finds a timed-out ps still being worked on (`helper.abandoned('ps') > 0`) is skipped and counted in stats().deferred, not queued behind it. */
export function createProcWatcher({ helper, intervalMs = 2000, psTimeoutMs = PS_TIMEOUT_MS, now = Date.now, all = false, timers = { setInterval, clearInterval } } = {}) {
  const ev = new EventEmitter()
  const known = new Map() // pid → { identity, startedAt, cmdState } of the processes already reported (or in the baseline); cmdState = what the consumer was last told about the command line
  const unreadable = new Map()
  let primed = false
  let inflight = null // the poll being run, so a scan can wait for the baseline instead of racing it
  let first = null // start()'s baseline poll
  let failing = false
  let malformed = false
  let timer = null
  const counters = { polls: 0, lastPollAt: null, listenerErrors: 0, deferred: 0 }

  /** Announces one event so that a listener that throws cannot take the rest of the poll (or the timer) with it: the throw becomes a poll-error,
   *  and a poll-error listener that throws has nobody left to tell. */
  function tell(name, payload) {
    try { ev.emit(name, payload) } catch (e) {
      counters.listenerErrors++
      if (name === 'poll-error') return
      tell('poll-error', { code: 'helper-error', cause: 'listener-threw', event: name, pid: payload && payload.pid != null ? payload.pid : null, reason: `a '${name}' listener threw: ${String((e && e.message) || e).slice(0, 200)}` })
    }
  }

  async function snapshot() {
    const r = await helper.call('ps', all ? { all: true } : {}, { timeoutMs: psTimeoutMs })
    if (!r || !Array.isArray(r.procs)) throw new Error('the helper\'s ps answer has no process list')
    const rows = r.procs.filter((x) => x && typeof x === 'object' && Number.isInteger(x.pid))
    if (rows.length !== r.procs.length) {
      if (!malformed) { malformed = true; tell('poll-error', { code: 'helper-error', cause: 'malformed-rows', count: r.procs.length - rows.length, reason: `${r.procs.length - rows.length} of the helper's ${r.procs.length} ps rows are not processes (no integer pid); they are skipped` }) }
    } else malformed = false
    return rows
  }

  function noteUnreadable(rows) {
    const here = new Set()
    for (const r of rows) {
      if (r.exe != null) continue
      here.add(r.pid)
      const prev = unreadable.get(r.pid)
      const id = String(r.startedAt ?? '?')
      if (prev && prev.id === id) continue
      const argv = splitCommandLine(r.cmdline)
      unreadable.set(r.pid, { id, pid: r.pid, comm: r.name ?? null, errno: null, argv })
      tell('facts-error', { os: 'win32', pid: r.pid, comm: r.name ?? null, code: null, argv, reason: `${r.name ?? 'a process'} (pid ${r.pid}): its image path cannot be read; it is never judged` })
    }
    for (const pid of [...unreadable.keys()]) if (!here.has(pid)) unreadable.delete(pid)
  }

  async function step() {
    let rows
    try { rows = await snapshot() } catch (e) {
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
        // a command line that was not known yet (pending, cim-backoff) and now is, or is given up on: the facts a consumer judged by are stale
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

  /** One difference step. Resolves true when it ran, false when the previous one was still in flight. Never rejects. */
  function poll() {
    if (inflight) return Promise.resolve(false)
    // a ps that timed out is still being worked on (the helper is single-threaded): asking again only queues another behind it
    if (typeof helper.abandoned === 'function' && helper.abandoned('ps') > 0) { counters.deferred++; return Promise.resolve(false) }
    inflight = (async () => {
      try { await step() } catch (e) {
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
    /** The processes of this session whose image path is unreadable and that are still there: [{pid, comm, errno, argv}] (Linux's shape). */
    unreadable: () => [...unreadable.values()].map(({ pid, comm, errno, argv }) => ({ pid, comm, errno, argv })),
    stats: () => ({ ...counters, failing }),
  })
}
