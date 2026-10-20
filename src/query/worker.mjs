// src/query/worker.mjs — the daemon's query worker (RFC 1.6 §4.1 「谁答」, 0.2 §1 角色表, D63 ①).
//
// A child of the collector daemon, forked on demand and running at low priority, like the sealer: the daemon's own
// event loop forwards agent traffic and MUST NOT compute a query. It stays warm (src/query/warm.mjs keeps the
// segments' index rows and the recently opened sessions' records, each revalidated per request against the files it
// came from), and exits after TROCAR_QUERY_IDLE_MS idle — ONE one-shot timer, re-armed per request, so nobody
// querying means no worker and no timer.
//
// The wire is frames on this process's own pipes, not JSON over IPC: one request per line on stdin
// (`{name, params, indent}`), one reply on stdout as `<status> <byteLength>\n` then exactly those bytes. The daemon
// forwards the bytes without parsing or re-encoding them, so a 30 MB document costs it a few buffer writes (1.6
// §4.1 「守护进程的负担」).
//
// `later(fn)` on every query it runs: a query here is never the only one, so what a query may build FOR THE NEXT ONE
// (src/query/named/session.mjs assembles the whole session, overview.mjs fills the usage sidecars) is built here and nowhere else —
// a one-shot CLI would pay for it and exit. It runs only once the answer's frame is WRITTEN (3.5 谁执行它): between a frame's head
// and its last byte this process does nothing else, so that work can neither delay the answer nor, if it fails or runs the heap
// out, cost the caller the answer it was already sent.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { LOCAL_ENV } from './client.mjs'
import { runQuery, QueryArgError } from './named/index.mjs'
import { lowerPriority } from '../low-priority.mjs'

const home = process.argv[2]
// The board's control verbs (`{control, body}`, 4.4 §控制面) run the CLI's own functions, which take `deps` for what they ask of the machine.
// The daemon never passes argv[3]; a test fork names an ES module whose default export is that `deps` object.
const depsP = process.argv[3] ? import(pathToFileURL(process.argv[3]).href).then((m) => m.default) : Promise.resolve({})
const IDLE_MS = Number(process.env.TROCAR_QUERY_IDLE_MS || 180_000)
// What the CLI's own environment may change about an answer goes local (client.mjs LOCAL_ENV); this worker serves
// every caller, so it answers as a clean environment would and never as the daemon's happened to be.
for (const k of LOCAL_ENV) delete process.env[k]
lowerPriority({ say: (m) => process.stderr.write(`${m}\n`) }) // behind the agents' traffic (1.6 §3.1), like the sealer

let idle = null
const rearm = () => { clearTimeout(idle); idle = setTimeout(() => process.exit(0), IDLE_MS) }

const write = (status, body) => new Promise((done) => {
  process.stdout.write(`${status} ${body.length}\n`, () => { if (body.length) process.stdout.write(body, done); else done() })
})

async function answer(line) {
  clearTimeout(idle)
  let status = 200, text
  const after = []
  try {
    const { name, params, indent, control, body } = JSON.parse(line)
    if (control) { // one JSON line, the bytes `trocar <command> --json` prints into a pipe; the verb says the status (src/control/board.mjs)
      const { VERBS } = await import('../control/board.mjs')
      if (!Object.hasOwn(VERBS, control)) throw new Error(`no control verb ${JSON.stringify(control)}`)
      const r = await VERBS[control](body || {}, { home, deps: await depsP })
      status = r.status
      text = JSON.stringify(r.doc) + '\n'
    } else { // `status` / `doctor` read the machine the way the control verbs do — same user home, environment and deps — so /api/status and
      // GET /control/status answer from one view of the machine (V91); the daemon passes no deps, so this is the real machine
      const deps = await depsP
      text = JSON.stringify(await runQuery(name, params || {}, { home, later: (fn) => after.push(fn), userHome: path.dirname(home), env: deps.env || process.env, platform: deps.platform || process.platform, deps }), null, Number(indent) || 0)
    }
  } catch (e) {
    // 400 = the caller's mistake (an unknown name or parameter), 500 = this worker's. The message is the query
    // core's own, so the caller can raise the very error its local path would have raised.
    status = e instanceof QueryArgError ? 400 : 500
    text = JSON.stringify({ error: String((e && e.message) || e) })
  }
  await write(status, Buffer.from(text, 'utf8'))
  text = null
  rearm()
  if (after.length) setImmediate(async () => { for (const fn of after) { try { await fn() } catch { /* the next query does it */ } } })
}

let buf = '', chain = Promise.resolve() // one at a time: a request is answered before the next is read
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (line) chain = chain.then(() => answer(line))
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('disconnect', () => process.exit(0)) // the daemon is gone: so is the reason to be here
rearm()
