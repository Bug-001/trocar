// src/query/service.mjs — the query worker's life, in the daemon (RFC 4.6 §控制面 `GET /query`, 0.2 §1, D63 ①).
//
// The daemon's only part in a read: fork the worker when one is asked for, hand it the request line, and let its
// bytes flow to the response. This event loop forwards agent traffic, so it MUST NOT parse or stringify the
// document (1.6 §4.1 「守护进程的负担」 ≤ 5 ms per query whatever the size) and MUST NOT compute an answer.
// Requests are serialized: one worker, one query at a time, which is also what bounds its memory.
// A worker that crashes or says nothing within DEADLINE_MS is a D38 failure (`where:'daemon'`, `query-failed`) and
// is dropped; the next request forks a new one, and a caller whose request died gets a 500 and answers locally.
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { QUERY_PATH } from './client.mjs'

const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url))
/** The worker's heap bound. Measured warm on the reference dataset: RSS ~180 MB with every session of a 500 MB
 *  corpus opened, so 384 MB leaves room for one large document being serialized without ever growing without end. */
export const WORKER_MEMORY_MB = 384
const DEADLINE_MS = 30_000 // a worker silent this long is wedged, not slow: the queue must not be held for ever
const NL = 0x0a

const forkWorker = (home) => fork(WORKER, [home], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: [`--max-old-space-size=${WORKER_MEMORY_MB}`] })

export function createQueryService({ home, failure = () => {}, fork: spawn = forkWorker }) {
  let child = null, pending = null, head = '', left = 0, stderr = ''
  let queue = Promise.resolve()

  /** The worker is gone or must go: whoever was waiting is told, so no request hangs on it. */
  function drop(why) {
    const c = child, p = pending
    child = null; pending = null; head = ''; left = 0; stderr = ''
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
      if (!room && child) { child.stdout.pause(); const c = child; pending.res.once('drain', () => { if (child === c) c.stdout.resume() }) }
      if (!left) settle()
    }
  }

  function settle() {
    const p = pending
    pending = null
    clearTimeout(p.timer)
    p.res.end()
    p.done()
  }

  /** GET /query?name=<name>&indent=<n>&<param>=<value> — the control plane's read route (4.6 §控制面). */
  const route = async ({ query, res }) => {
    const name = query.get('name')
    if (!name) throw Object.assign(new Error('GET /query: ?name=<query name> is required'), { status: 400 })
    const params = {}
    for (const [k, v] of query) if (k !== 'name' && k !== 'indent') params[k] = v
    const line = JSON.stringify({ name, params, indent: query.get('indent') || 0 }) + '\n'
    const run = () => new Promise((done, fail) => {
      const c = child || start()
      pending = { res, done, fail, timer: setTimeout(() => { failWorker(`the query worker did not answer ${name} within ${DEADLINE_MS} ms`); drop('the query worker did not answer in time') }, DEADLINE_MS) }
      c.stdin.write(line)
    })
    // The handler answers `res` itself, so the control server sends nothing: nothing of this document is held in
    // this process's memory as a JavaScript value. A request that failed does not hold the next one up, and its
    // rejection reaches the control server, which answers 500 — the caller then reads locally.
    const task = queue.then(run, run)
    queue = task.catch(() => {})
    return task.then(() => undefined)
  }

  return { route, path: QUERY_PATH, stop: () => drop('the daemon is stopping') }
}
