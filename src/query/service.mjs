// src/query/service.mjs — the query worker's life, in the daemon (RFC 4.6 §控制面 `GET /query`, 0.2 §1, D63 ①).
//
// The daemon's only part in a read: fork the worker when one is asked for, hand it the request line, and let its
// bytes flow to the response. This event loop forwards agent traffic, so it MUST NOT parse or stringify the
// document (1.6 §4.1 「守护进程的负担」 ≤ 5 ms per query whatever the size) and MUST NOT compute an answer.
// Requests are serialized: one worker, one query at a time, which is also what bounds its memory.
// A worker that crashes or says nothing within DEADLINE_MS is a D38 failure (`where:'daemon'`, `query-failed`) and
// is dropped; the next request forks a new one, and a caller whose request died gets a 500 and answers locally.
//
// NO WORKER YET (the cold path): the daemon does NOT make the caller wait for a fork plus a cold query — measured,
// that was 842-1142 ms against 548 ms locally. It answers 503 at once, which the one read client reads as "no warm
// worker" and answers locally, at local speed; the same query line then warms a worker in the background, so the
// next query is the warm one. "No worker while nobody queries" (D63) is untouched: nothing is forked until a query
// arrives. The board's `relay` (4.4, D66) has no local path, so it is the one caller that waits for a fork.
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { QUERY_PATH, QUERY_NAMES } from './client.mjs'
import { WORKER_MEMORY_MB } from './warm.mjs'
import { OS_PROMPT_MS } from '../off/root-store.mjs'

const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url))
const DEADLINE_MS = 30_000 // a worker silent this long is wedged, not slow: the queue must not be held for ever
/** A control verb may run install's root steps (the board's Set up, 4.4 §控制面): the OS's root prompt, then its read-back, each up to OS_PROMPT_MS,
 *  and the rest of install. A worker killed while the dialog is open would leave no receipt and the carriers unplaced. */
const CONTROL_DEADLINE_MS = 2 * OS_PROMPT_MS + DEADLINE_MS
const NL = 0x0a
/** Where the bytes of a document nobody waits for go: the warm-up query's answer, and the rest of a document whose
 *  caller disconnected (its frame MUST still be read to the end, or the next reply is read as part of it). */
const SINK = { writeHead() {}, write() { return true }, end() {}, once() {} }
const NO_WORKER = JSON.stringify({ error: 'no warm query worker in this daemon yet: it is being started, read this one locally' })

const forkWorker = (home) => fork(WORKER, [home], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: [`--max-old-space-size=${WORKER_MEMORY_MB}`] })

export function createQueryService({ home, failure = () => {}, fork: spawn = forkWorker, deadlineMs = DEADLINE_MS, controlDeadlineMs = CONTROL_DEADLINE_MS }) {
  let child = null, pending = null, head = '', left = 0, stderr = '', paused = false
  let queue = Promise.resolve()

  /** Read the worker again. Called wherever the reason to hold off is gone — INCLUDING the end of a frame: a
   *  response that hit its high-water mark on the LAST write of a document is `end()`ed in the same tick, and node
   *  emits 'drain' on an outgoing message only while it is not finished. That drain therefore never comes, and
   *  without this the worker's stdout stayed paused for good: the NEXT query got no byte at all and its caller sat
   *  out its whole deadline before reading locally (a Windows test machine: `query sessions` 5 723 ms with 4 ms of core time —
   *  a named pipe fills far earlier than a unix socket, which is why macOS never saw it). */
  function resumeChild() {
    if (!paused) return
    paused = false
    if (child) child.stdout.resume()
  }

  /** The worker is gone or must go: whoever was waiting is told, so no request hangs on it. */
  function drop(why) {
    const c = child, p = pending
    child = null; pending = null; head = ''; left = 0; stderr = ''; paused = false
    if (c) { c.removeAllListeners(); try { c.kill() } catch { /* already gone */ } }
    if (p) { clearTimeout(p.timer); p.fail(new Error(why)) }
  }

  function start() {
    const c = spawn(home)
    child = c
    c.stdout.on('data', (b) => { if (child === c) onData(b) })
    c.stderr.on('data', (b) => { stderr = (stderr + b).slice(-2000) }) // the reason a crash gives, for the D38 record
    c.on('error', (e) => { if (child === c) { failWorker(`the query worker could not be started: ${e.message}`); drop('the query worker could not be started') } })
    c.on('exit', (code, signal) => {
      if (child !== c) return
      failWorker(`the query worker exited (${signal ? `signal ${signal}` : `code ${code}`})${stderr ? `: ${stderr.trim()}` : ''}`)
      drop('the query worker exited')
    })
    return c
  }

  const failWorker = (reason) => failure('daemon', Object.assign(new Error(reason), { code: 'query-failed' }))

  // The frame reader: `<status> <len>\n` then exactly `len` bytes, straight into the response. Nothing is parsed.
  function onData(b) {
    while (b.length) {
      if (!left) {
        const nl = b.indexOf(NL)
        if (nl < 0) { head += b.toString('latin1'); return }
        head += b.subarray(0, nl).toString('latin1')
        b = b.subarray(nl + 1)
        const [status, len] = head.split(' ')
        head = ''
        if (!pending) return // a frame nobody waits for (its request died): the worker is out of step
        pending.res.writeHead(Number(status), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': len })
        left = Number(len)
        if (!left) { settle() ; continue }
        continue
      }
      const take = b.subarray(0, left)
      left -= take.length
      b = b.subarray(take.length)
      const room = pending.res.write(take)
      if (!room && child && !paused) { paused = true; child.stdout.pause(); const c = child; pending.res.once('drain', () => { if (child === c) resumeChild() }) }
      if (!left) settle()
    }
  }

  function settle() {
    const p = pending
    pending = null
    clearTimeout(p.timer)
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

  const run = (line, res, ms) => new Promise((done, fail) => {
    const c = child || start()
    const p = { res, done, fail, quiet: false }
    p.timer = setTimeout(() => {
      // Still the deadline when the caller is gone (a silent worker must not hold the queue), but then it is not a
      // failure anyone asked about: no D38 record.
      if (!p.quiet) failWorker(`the query worker did not answer within ${ms} ms`)
      drop('the query worker did not answer in time')
    }, ms)
    pending = p
    c.stdin.write(line)
  })

  /** Fork a worker and give it this very query, with nobody waiting for the answer: the next query finds it warm. */
  const warmUp = (line) => { const go = () => run(line, SINK, deadlineMs); queue = queue.then(go, go).catch(() => {}) }

  const lineOf = (name, params, indent = 0) => JSON.stringify({ name, params, indent }) + '\n'

  /** Hand `line` to the worker (forked if there is none: run() starts it) and let its frame flow into `res`. */
  const answer = (line, res, ms = deadlineMs) => {
    // FIRST, before anything that can await: a caller may be gone at any moment, and the worker must survive it.
    let gone = false, finish, failRoute
    const answered = new Promise((resolve, reject) => { finish = resolve; failRoute = reject })
    res.once('close', () => { gone = true; abandon(res); finish() })
    // The handler answers `res` itself, so the server sends nothing: nothing of this document is held in this
    // process's memory as a JavaScript value. A request that failed does not hold the next one up, and its
    // rejection reaches the server, which answers 500.
    const go = () => run(line, res, ms)
    const task = queue.then(go, go)
    queue = task.catch(() => {})
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
    const params = {}
    for (const [k, v] of query) if (k !== 'name' && k !== 'indent') params[k] = v
    const line = lineOf(name, params, query.get('indent') || 0)
    if (!child) { // the cold path: answered at once, warmed behind the answer (see the head of this file)
      warmUp(line)
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(NO_WORKER) })
      res.end(NO_WORKER)
      return undefined
    }
    return answer(line, res)
  }

  /** The board's `GET /api/<name>` (4.4, D66): the same frame path, but the board has no local path to fall back to,
   *  so with no worker it forks one and waits its turn instead of the cold 503. The caller checked the name. */
  const relay = ({ name, params = {}, res }) => answer(lineOf(name, params), res)

  /** The board's `/control/<verb>` (4.4 §控制面): the same queue and frame path as `relay`, so a control verb waits its turn behind a query and the
   *  worker runs the CLI's own function (src/control/board.mjs). The caller checked the verb and parsed the small request body. */
  const control = ({ verb, body = {}, res }) => answer(JSON.stringify({ control: verb, body }) + '\n', res, controlDeadlineMs)

  /** Fork a worker (if there is none) and run this query with nobody waiting: the board's page load warms it (4.4). */
  const warm = ({ name, params = {} }) => warmUp(lineOf(name, params))

  return { route, relay, control, warm, path: QUERY_PATH, stop: () => drop('the daemon is stopping') }
}
