// src/query/service.mjs — the query worker's life, in the daemon (RFC 4.6 §控制面 `GET /query`, 0.2 §1, D63 ①).
//
// The daemon's only part in a read: fork the worker when one is asked for, hand it the request line, and let its
// bytes flow to the response. This event loop forwards agent traffic, so it MUST NOT parse or stringify the
// document (1.6 §4.1 「守护进程的负担」 ≤ 5 ms per query whatever the size) and MUST NOT compute an answer.
// Requests are serialized: one worker, one query at a time, which is also what bounds its memory. Those waiting are served by
// class (SERVE_ORDER: block, lane, session, then every other name), first come first served within a class, and one whose caller
// left before its turn is skipped, never written to the worker (3.5 §服务队列).
// A worker that crashes or says nothing within DEADLINE_MS is a D38 failure (`where:'daemon'`, `query-failed`) and
// is dropped; the next request forks a new one, and a caller whose request died gets a 500 and answers locally.
// Failures are kept per SUBJECT (the name and its parameters without client.mjs WINDOW_PARAMS): the first one opens an
// episode and writes the one record; while its cool-down runs, that subject is answered 500 with the episode's reason at
// once, never forked; each further failure doubles the cool-down; an answer ends the episode (3.5 §读不全不静默, #20).
//
// NO WORKER YET (the cold path): the daemon does NOT make the caller wait for a fork plus a cold query — measured,
// that was 842-1142 ms against 548 ms locally. It answers 503 at once, which the one read client reads as "no warm
// worker" and answers locally, at local speed; the same query line then warms a worker in the background, so the
// next query is the warm one. "No worker while nobody queries" (D63) is untouched: nothing is forked until a query
// arrives, and a worker that answered, was kicked or ran a background slice last QUERY_IDLE_MS ago leaves (3.5 谁执行它). The DAEMON keeps that clock, not
// the worker: it alone knows whether a request is in flight or queued (a worker's own timer was off for as long as one of
// its answers was unfinished, so a stuck answer kept it, and its warm heap, for good), and the clock starts only when
// nothing is, so an idle exit never cuts a query and is not a failure. The board's `relay` (4.4, D66) has no local path, so it is the one caller that waits for a fork.
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { QUERY_PATH, QUERY_NAMES, WINDOW_PARAMS, paramsOf } from './client.mjs'
import { heapFlags, workerEnv } from './warm.mjs'
import { OS_PROMPT_MS } from '../off/root-store.mjs'

const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url))
const DEADLINE_MS = 30_000 // a worker SILENT this long is wedged, not slow: the queue must not be held for ever. A body waiting on a slow reader is not silence, nor is a fold that keeps reporting progress.
/** A response full this long with no 'drain' is a reader that is not reading: it is let go (4.4 §Plan ③), or it holds every read of
 *  every client behind it for as long as it stalls (once 17 minutes). Long enough that a merely slow reader of a large body is never cut. */
const PAUSE_MS = 60_000
const STATS_MS = 60_000 // the read-cost line in the daemon's log: once a minute, only when there were reads (4.4 §服务形状)
/** How long a subject that just failed (crash or silence) is answered 500 with that failure's reason instead of being forked into
 *  it again (3.5 §读不全不静默): the board polls every 1.5 s, and each fork re-read the whole session it died on. Doubles with
 *  every further failure in the same episode. */
export const CRASH_COOLDOWN_MS = 60_000
/** The longest that cool-down grows: a fold that never fits then costs at most four cold forks an hour, and a condition that
 *  went away (the session stopped growing, memory came back) is still tried again within a quarter of an hour. */
export const FAILURE_BACKOFF_MAX_MS = 15 * 60_000
/** The subject a worker's death is remembered by when it died with no request in flight: on what kicks gave it. */
const KICK = 'kick'
const coolOf = (ep) => Math.min(CRASH_COOLDOWN_MS * 2 ** (ep.n - 1), FAILURE_BACKOFF_MAX_MS)
/** What a failure is remembered by: the name and every parameter but the window (stable key order). */
const subjectOf = (name, params = {}) => `${name} ${JSON.stringify(Object.keys(params).filter((k) => !WINDOW_PARAMS.includes(k)).sort().map((k) => [k, Array.isArray(params[k]) ? params[k].map(String) : String(params[k])]))}`
/** A worker asked nothing this long leaves and gives its memory back: the board polls every 1.5 s while it is open, so it stays
 *  warm while anyone is looking; the next query after an idle exit forks a new one (3.5 谁执行它). */
export const QUERY_IDLE_MS = 120_000
const STDERR_HEAD = 4000, STDERR_TAIL = 1000 // V8 prints its FATAL ERROR line after a few GC lines, then the native stack
/** A control verb may run install's root steps (the board's Set up, 4.4 §控制面): the OS's root prompt, then its read-back, each up to OS_PROMPT_MS,
 *  and the rest of install. A worker killed while the dialog is open would leave no receipt and the carriers unplaced. */
const CONTROL_DEADLINE_MS = 2 * OS_PROMPT_MS + DEADLINE_MS
const NL = 0x0a
/** Where the bytes of a document nobody waits for go: the warm-up query's answer, and the rest of a document whose
 *  caller disconnected (its frame MUST still be read to the end, or the next reply is read as part of it). */
const SINK = { writeHead() {}, write() { return true }, end() {}, once() {} }
const NO_WORKER = JSON.stringify({ error: 'no warm query worker in this daemon yet: it is being started, read this one locally' })

/** The serving order of what waits (3.5 §服务队列): these names first, in this order; every other name (and a control verb) after them.
 *  A `block` then waits at most for the request in flight, never behind a run of `session` reads. */
const SERVE_ORDER = Object.freeze(['block', 'lane', 'session'])
const rank = (name) => { const i = SERVE_ORDER.indexOf(name); return i < 0 ? SERVE_ORDER.length : i }

const forkWorker = (home) => fork(WORKER, [home], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: heapFlags(), env: workerEnv() })

const logLine = (m) => process.stdout.write(`${new Date().toISOString()} ${m}\n`) // the daemon's stdout is its log
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`

export function createQueryService({ home, failure = () => {}, fork: spawn = forkWorker, deadlineMs = DEADLINE_MS, controlDeadlineMs = CONTROL_DEADLINE_MS, idleMs = QUERY_IDLE_MS, pauseMs = PAUSE_MS, say = logLine, now = Date.now }) {
  let asked = 0, idle = null // requests queued or in flight; the idle clock, running only while there are none
  let child = null, pending = null, head = '', left = 0, errHead = '', errTail = '', paused = false, pauseTimer = null
  let stats = new Map(), statsTimer = null // per name: {reads, bytes, cpu, slowest} since the last line
  const waiting = [] // {name, go, gone, resolve, reject} in arrival order; pump() takes the first of the lowest rank
  let busy = false // a request is in flight
  const episodes = new Map() // subject → {reason, at, n}: failures since that subject was last answered

  /** The open episode of `subject` while its cool-down runs, else null. Episodes nobody asked about for a whole
   *  FAILURE_BACKOFF_MAX_MS past their cool-down are forgotten here, so the map holds only subjects failing lately. */
  function cooling(subject) {
    const t = now()
    for (const [k, ep] of episodes) if (t - ep.at >= coolOf(ep) + FAILURE_BACKOFF_MAX_MS) episodes.delete(k)
    const ep = subject && episodes.get(subject)
    return ep && t - ep.at < coolOf(ep) ? ep : null
  }

  /** A failure of `subject`: the first of an episode writes the D38 record, the rest only lengthen its cool-down. */
  function fault(subject, reason) {
    cooling() // forget the stale ones first: a failure long after the last one is a new episode
    const ep = subject && episodes.get(subject)
    if (ep) { ep.n++; ep.at = now(); return }
    failWorker(reason)
    if (subject) episodes.set(subject, { reason, at: now(), n: 1 })
  }

  /** Read the worker again. Called wherever the reason to hold off is gone — INCLUDING the end of a frame: a
   *  response that hit its high-water mark on the LAST write of a document is `end()`ed in the same tick, and node
   *  emits 'drain' on an outgoing message only while it is not finished. That drain therefore never comes, and
   *  without this the worker's stdout stayed paused for good: the NEXT query got no byte at all and its caller sat
   *  out its whole deadline before reading locally (a Windows test machine: `query sessions` 5 723 ms with 4 ms of core time —
   *  a named pipe fills far earlier than a unix socket, which is why macOS never saw it). */
  function resumeChild() {
    if (!paused) return
    paused = false
    clearTimeout(pauseTimer)
    if (pending) arm(pending)
    if (child) child.stdout.resume()
  }

  /** The deadline measures the worker's SILENCE: armed while it owes bytes, re-armed by every byte and every progress message
   *  (a fold still reading records), and off while the response is full and the worker is paused for it — a slow reader of a
   *  large body is not a wedged worker, nor is a long fold. */
  function arm(p) {
    clearTimeout(p.timer)
    p.timer = setTimeout(() => {
      // Still the deadline when the caller is gone (a silent worker must not hold the queue), but then it is not a
      // failure anyone asked about: no D38 record.
      const why = `the query worker did not answer within ${p.ms} ms`
      if (!p.quiet) fault(p.subject, why)
      drop(why)
    }, p.ms)
    p.timer.unref?.()
  }

  /** The worker is gone or must go: whoever was waiting is told, so no request hangs on it. */
  // A response whose head was already sent is ABORTED, never ended: a clean end would hand the reader a 200 whose body is short
  // (4.4 D66 ③), which the board read as "not JSON" instead of "cut off".
  function drop(why) {
    const c = child, p = pending
    clearTimeout(idle); clearTimeout(pauseTimer)
    child = null; pending = null; head = ''; left = 0; errHead = ''; errTail = ''; paused = false
    if (c) { c.removeAllListeners(); try { c.kill() } catch { /* already gone */ } }
    if (p) {
      clearTimeout(p.timer)
      if (p.headed) try { p.res.destroy?.(new Error(why)) } catch { /* already closed */ }
      p.fail(new Error(why))
    }
  }

  /** What stderr says about a crash, in one line: the cause (V8's `FATAL ERROR: …` / `Check failed` / heap limit, a thrown
   *  `…Error: …`) and the first JavaScript frame after it — never V8's native stack, which is kilobytes of addresses the board would
   *  print (2026-10-21). With no cause line: the head and the tail. Only the dying request's stderr: run() starts it afresh. */
  function stderrReason() {
    const lines = errHead.split('\n').map((l) => l.trim()).filter(Boolean)
    const at = lines.findIndex((l) => /FATAL ERROR|Check failed|heap limit|\b\w*Error:/.test(l))
    if (at >= 0) return [lines[at], lines.slice(at + 1).find((l) => /^at\s/.test(l))].filter(Boolean).join(' · ')
    const first = errHead.slice(0, 600).trim(), tail = errTail.trim()
    return [first, tail && !first.includes(tail) ? `… ${tail}` : ''].filter(Boolean).join(' ')
  }

  function start() {
    const c = spawn(home)
    child = c
    c.stdout.on('data', (b) => { if (child === c) onData(b) })
    // A worker the OS killed (SIGKILL, a heap OOM) breaks the pipe under the next write: EPIPE arrives here, and unheard it would be
    // an uncaught exception that takes this process down. The 'close' that follows fails the query with the exit's reason.
    c.stdin.on('error', () => {})
    c.stderr.on('data', (b) => { // the reason a crash gives, for the D38 record: its head (bounded) and its tail
      const t = String(b)
      if (errHead.length < STDERR_HEAD) errHead += t.slice(0, STDERR_HEAD - errHead.length)
      errTail = (errTail + t).slice(-STDERR_TAIL)
    })
    // a worker still working says so (worker.mjs PROGRESS_MS): its silence clock starts again (3.5:42), and so does the idle
    // clock when no request is queued or in flight: a background slice is work, so a long kicked fold is not cut (3.5 后台抽取与归约)
    c.on('message', (m) => {
      if (child !== c || !m) return
      if (m.progress === true) { if (pending && !paused) arm(pending); idleClock() }
      // a D38 record the worker owes (4.3 盘满 `projection-write-failed`): written here, where the daemon's records are
      if (m.failure && typeof m.failure.code === 'string') failure('daemon', Object.assign(new Error(String(m.failure.reason)), { code: m.failure.code }))
    })
    c.on('error', (e) => { if (child === c) { const why = `the query worker could not be started: ${e.message}`; fault(pending ? pending.subject : KICK, why); drop(why) } })
    c.on('close', (code, signal) => { // 'close', not 'exit': every byte it wrote to stdout and stderr has been read by then
      if (child !== c) return
      const said = stderrReason()
      const reason = `the query worker exited (${signal ? `signal ${signal}` : `code ${code}`})${said ? `: ${said}` : ''}`
      // with no request in flight it died on what a kick gave it: that episode is the kick's, so a crashing fold is not re-forked by every kick
      fault(pending ? pending.subject : KICK, reason)
      drop(reason)
    })
    return c
  }

  const failWorker = (reason) => failure('daemon', Object.assign(new Error(reason), { code: 'query-failed' }))

  // The frame reader: `<status> <len> <enc> <cpu_ms> <tag>\n` then exactly `len` bytes, straight into the response. Nothing is parsed.
  // `enc` is `gzip` when the worker compressed the bytes (the request asked it: 4.4 §服务形状) and `-` otherwise; `tag` is the
  // answer's version tag (answers.mjs), handed to the response as its `etag` header, or `-` for none (4.4 §条件 GET).
  function onData(b) {
    while (b.length) {
      if (!left) {
        const nl = b.indexOf(NL)
        if (nl < 0) { head += b.toString('latin1'); return }
        head += b.subarray(0, nl).toString('latin1')
        b = b.subarray(nl + 1)
        const [status, len, enc = '-', cpu = '0', tag = '-'] = head.split(' ')
        head = ''
        if (!pending) return // a frame nobody waits for (its request died): the worker is out of step
        pending.bytes = Number(len); pending.cpu = Number(cpu) || 0
        pending.res.writeHead(Number(status), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': len,
          ...(enc === 'gzip' ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}), ...(tag !== '-' ? { etag: `"${tag}"` } : {}) })
        pending.headed = true
        left = Number(len)
        if (!left) { settle() ; continue }
        continue
      }
      const take = b.subarray(0, left)
      left -= take.length
      b = b.subarray(take.length)
      const room = pending.res.write(take)
      if (!room && child && !paused) {
        paused = true; clearTimeout(pending.timer); child.stdout.pause()
        const c = child, p = pending, res = p.res
        res.once('drain', () => { if (child === c) resumeChild() })
        // no drain within pauseMs: that reader is let go like one that left, and its connection is cut, never ended short
        pauseTimer = setTimeout(() => { if (pending === p && p.res === res) { abandon(res); try { res.destroy?.() } catch { /* already closed */ } } }, pauseMs)
        pauseTimer.unref?.()
      }
      else if (left && !paused) arm(pending)
      if (!left) settle()
    }
  }

  function settle() {
    const p = pending
    pending = null
    clearTimeout(p.timer)
    episodes.delete(p.subject) // that subject is answered again: its episode is over
    count(p)
    resumeChild() // the document is through: nothing is left to hold off for, and no drain comes after end()
    p.res.end()
    p.done()
  }

  /** The caller of the pending request went away (Ctrl-C, a closed board tab). The rest of ITS document is read into
   *  SINK so the worker stays in step and usable, nothing is said as a failure (nothing failed), and a stdout paused
   *  because that socket was full is resumed — without this the worker stayed paused for good, the deadline then
   *  wrote a false `query-failed` and killed it with its warm cache, and the read side was dead for 30 s. */
  function abandon(res) {
    if (!pending || pending.res !== res) return // its turn has not come yet, or it is already answered
    pending.res = SINK
    pending.quiet = true
    resumeChild()
  }

  /** What reads cost, per name, for the once-a-minute line (4.4 §服务形状): reads, bytes out, the worker's CPU, the slowest wall time. */
  function count(p) {
    const s = stats.get(p.name) || { reads: 0, bytes: 0, cpu: 0, slowest: 0 }
    s.reads++; s.bytes += p.bytes || 0; s.cpu += p.cpu || 0; s.slowest = Math.max(s.slowest, now() - p.t0)
    stats.set(p.name, s)
    statsTimer ||= setInterval(() => {
      if (!stats.size) return
      say(`query reads, last minute: ${[...stats].map(([n, s]) => `${n} ${s.reads}× ${mb(s.bytes)} out, ${Math.round(s.cpu)} ms worker cpu, slowest ${s.slowest} ms`).join('; ')}`)
      stats = new Map()
    }, STATS_MS)
    statsTimer.unref?.()
  }

  const run = (line, res, ms, name, subject) => new Promise((done, fail) => {
    // A subject inside its cool-down (an episode opened while this one was queued): answered with that failure, not forked into it.
    const ep = cooling(subject)
    if (ep) { fail(new Error(ep.reason)); return }
    const c = child || start()
    errHead = ''; errTail = '' // a crash's reason is THIS request's stderr: a long-lived worker's earlier noise filled the head
    const p = { res, done, fail, quiet: false, line, ms, headed: false, name, subject, t0: now() }
    arm(p)
    pending = p
    c.stdin.write(line)
  })

  /** Fork a worker and give it this very query, with nobody waiting for the answer: the next query finds it warm. */
  const warmUp = (line, name, subject) => {
    if (cooling(subject)) return // nothing to warm a cooling subject with (the route already answered it 500)
    enqueue(name, () => run(line, SINK, deadlineMs, name, subject)).catch(() => {})
  }

  /** `etag`: the version part of the tag the caller holds; the worker answers 304 when its version is that one (4.4 §条件 GET). */
  const lineOf = (name, params, indent = 0, gzip = false, etag = null) => JSON.stringify({ name, params, indent, ...(gzip ? { gzip } : {}), ...(etag ? { etag } : {}) }) + '\n'

  /** Queue `go` (counted from now until it settles) and serve the queue. `gone()` true at its turn: skipped, never run. */
  const enqueue = (name, go, gone = () => false) => counted(new Promise((resolve, reject) => { waiting.push({ name, go, gone, resolve, reject }); pump() }))
  function pump() {
    while (!busy && waiting.length) {
      let at = 0
      for (let i = 1; i < waiting.length; i++) if (rank(waiting[i].name) < rank(waiting[at].name)) at = i
      const [j] = waiting.splice(at, 1)
      if (j.gone()) { j.resolve(); continue }
      busy = true
      j.go().then(j.resolve, j.reject).finally(() => { busy = false; pump() })
    }
  }

  /** The idle clock, (re)started when nothing is queued or in flight: the worker leaves idleMs after the last request, kick or
   *  background slice it reported. */
  const idleClock = () => {
    clearTimeout(idle)
    if (asked || !child) return
    idle = setTimeout(() => { if (!asked) drop('the query worker was idle') }, idleMs)
    idle.unref?.()
  }

  /** Every request is counted from the moment it is queued until it is answered or failed; at none, the idle clock starts. */
  const counted = (task) => {
    asked++
    clearTimeout(idle)
    const done = () => { --asked; idleClock() }
    task.then(done, done)
    return task
  }

  /** The index keeper's kick (3.5 §后台抽取与归约): the record ids of model calls just indexed, handed to the worker (forked if there
   *  is none), which folds their sessions at low priority. One IPC line: this process parses no body, knows no session, computes nothing. A worker that dies with no request
   *  in flight opens an episode of subject KICK, and while it cools no kick forks — a live worker (a query's) still gets it; after
   *  stop() a kick does nothing. */
  let stopped = false
  const tell = (m) => {
    if (stopped || (!child && cooling(KICK))) return
    const c = child || start()
    if (c.connected) c.send(m, () => {}) // a send that fails is the worker's close, which says it
    idleClock()
  }
  const kick = (ids) => { if (Array.isArray(ids) && ids.length) tell({ kick: ids.map(String) }) }
  /** The daemon's start (4.4 §答案文件): the worker writes a tier-0 head for every session that has none, at its first idle period
   *  (3.5 §谁执行它「答案文件」). Forked like a kick, under the same cool-down and stop rules. */
  const sweep = () => tell({ sweep: true })

  /** Hand `line` to the worker (forked if there is none: run() starts it) and let its frame flow into `res`. */
  const answer = (line, res, ms, name, subject) => {
    // A subject inside its cool-down is failed at once, not queued behind the worker (3.5 §读不全不静默).
    const ep = cooling(subject)
    if (ep) return Promise.reject(new Error(ep.reason))
    // FIRST, before anything that can await: a caller may be gone at any moment, and the worker must survive it.
    let gone = false, finish, failRoute
    const answered = new Promise((resolve, reject) => { finish = resolve; failRoute = reject })
    res.once('close', () => { gone = true; abandon(res); finish() })
    // The handler answers `res` itself, so the server sends nothing: nothing of this document is held in this
    // process's memory as a JavaScript value. A request that failed does not hold the next one up, and its
    // rejection reaches the server, which answers 500.
    const task = enqueue(name, () => run(line, res, ms, name, subject), () => gone)
    // Answered as soon as EITHER the document is through or the caller is gone; a failure is raised only while there
    // is someone to raise it to (writing a 500 into a closed socket is nobody's answer).
    task.then(() => finish(), (e) => (gone ? finish() : failRoute(e)))
    return answered.then(() => undefined)
  }

  /** GET /query?name=<name>&indent=<n>&<param>=<value> — the control plane's read route (4.6 §控制面). */
  const route = async ({ query, res }) => {
    const name = query.get('name')
    if (!name) throw Object.assign(new Error('GET /query: ?name=<query name> is required'), { status: 400 })
    // The closed name set (client.mjs QUERY_NAMES), checked here: an arbitrary name used to fork a worker before the
    // query core refused it.
    if (!QUERY_NAMES.includes(name)) throw Object.assign(new Error(`trocar query: no query called ${JSON.stringify(name)} (names: ${QUERY_NAMES.join(', ')})`), { status: 400 })
    const params = paramsOf(query, ['name', 'indent'])
    const line = lineOf(name, params, query.get('indent') || 0)
    const subject = subjectOf(name, params)
    // A cooling subject is answered 500 with its episode's reason, worker or not (3.5 #12, #20): a 503 would make the
    // caller wait on a worker that the cool-down never forks.
    const ep = cooling(subject)
    if (ep) throw new Error(ep.reason)
    if (!child) { // the cold path: answered at once, warmed behind the answer (see the head of this file)
      warmUp(line, name, subject)
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(NO_WORKER) })
      res.end(NO_WORKER)
      return undefined
    }
    return answer(line, res, deadlineMs, name, subject)
  }

  /** The board's `GET /api/<name>` (4.4, D66): the same frame path, but the board has no local path to fall back to,
   *  so with no worker it forks one and waits its turn instead of the cold 503. The caller checked the name. `gzip`: the
   *  reader takes gzip, so the worker compresses (the daemon never encodes a document, D63 ①). */
  const relay = ({ name, params = {}, res, gzip = false, etag = null }) => answer(lineOf(name, params, 0, gzip, etag), res, deadlineMs, name, subjectOf(name, params))

  /** The board's `/control/<verb>` (4.4 §控制面): the same queue and frame path as `relay`, so a control verb waits its turn behind a query and the
   *  worker runs the CLI's own function (src/control/board.mjs). The caller checked the verb and parsed the small request body. */
  const control = ({ verb, body = {}, res }) => answer(JSON.stringify({ control: verb, body }) + '\n', res, controlDeadlineMs, `control/${verb}`, subjectOf(`control/${verb}`, body))

  /** Fork a worker (if there is none) and run this query with nobody waiting: the board's page load warms it (4.4). */
  const warm = ({ name, params = {} }) => warmUp(lineOf(name, params), name, subjectOf(name, params))

  return { route, relay, control, warm, kick, sweep, path: QUERY_PATH, stop: () => { stopped = true; clearInterval(statsTimer); statsTimer = null; drop('the daemon is stopping') } }
}
