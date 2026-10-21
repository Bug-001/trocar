// src/query/worker.mjs — the daemon's query worker (RFC 1.6 §4.1 「谁答」, 0.2 §1 角色表, D63 ①).
//
// A child of the collector daemon, forked on demand and running at low priority, like the sealer: the daemon's own
// event loop forwards agent traffic and MUST NOT compute a query. It stays warm (src/query/warm.mjs keeps the
// segments' index rows, the sessions' spines and a few answers' bytes (src/query/answers.mjs), each revalidated per request against
// the files it came from) until the daemon ends it: the daemon keeps the idle clock (src/query/service.mjs QUERY_IDLE_MS), because only it
// knows whether a request is in flight or queued. It also leaves when its stdin ends or the daemon is gone.
//
// The wire is frames on this process's own pipes, not JSON over IPC: one request per line on stdin
// (`{name, params, indent, gzip?}`), one reply on stdout as `<status> <byteLength> <enc> <cpu_ms>\n` then exactly those bytes.
// The daemon forwards the bytes without parsing or re-encoding them, so a 30 MB document costs it a few buffer writes (1.6
// §4.1 「守护进程的负担」). `gzip: true` (the board's reader takes it, 4.4 §服务形状): the bytes are gzipped HERE, `enc` says
// `gzip`, and `byteLength` is the compressed length; otherwise `enc` is `-`. `cpu_ms` is this process's CPU for the answer,
// for the daemon's read-cost line.
//
// `later(fn)` on every query it runs: a query here is never the only one, so what a query may build FOR THE NEXT ONE
// (src/query/named/session.mjs assembles the whole session, overview.mjs fills the usage sidecars) is built here and nowhere else —
// a one-shot CLI would pay for it and exit. It runs only once the answer's frame is WRITTEN (3.5 谁执行它): between a frame's head
// and its last byte this process does nothing else, so that work can neither delay the answer nor, if it fails or runs the heap
// out, cost the caller the answer it was already sent.
import path from 'node:path'
import { promisify } from 'node:util'
import { gzip as gzipCb } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { LOCAL_ENV } from './client.mjs'
import { answer } from './answers.mjs'
import { lowerPriority } from '../low-priority.mjs'

const home = process.argv[2]
// The board's control verbs (`{control, body}`, 4.4 §控制面) run the CLI's own functions, which take `deps` for what they ask of the machine.
// The daemon never passes argv[3]; a test fork names an ES module whose default export is that `deps` object.
const depsP = process.argv[3] ? import(pathToFileURL(process.argv[3]).href).then((m) => m.default) : Promise.resolve({})
// What the CLI's own environment may change about an answer goes local (client.mjs LOCAL_ENV); this worker serves
// every caller, so it answers as a clean environment would and never as the daemon's happened to be.
for (const k of LOCAL_ENV) delete process.env[k]
lowerPriority({ say: (m) => process.stderr.write(`${m}\n`) }) // behind the agents' traffic (1.6 §3.1), like the sealer

const gzip = promisify(gzipCb)
/** A query still working says so (`{progress: true}` on the IPC channel, at most once per PROGRESS_MS): the daemon's deadline
 *  measures SILENCE, so a long fold that keeps reading records is not taken for a wedged worker, and one that stops is (3.5:42).
 *  The fold is synchronous; a send on the channel is written at once all the same. */
const PROGRESS_MS = 100
let said = 0
const progress = () => {
  const t = Date.now()
  if (t - said < PROGRESS_MS || !process.connected) return
  said = t
  process.send({ progress: true })
}
const write = (status, body, enc, cpu) => new Promise((done) => {
  process.stdout.write(`${status} ${body.length} ${enc} ${cpu}\n`, () => { if (body.length) process.stdout.write(body, done); else done() })
})

async function serve(line) {
  let status = 200, bytes, enc = '-'
  const after = [], cpu0 = process.cpuUsage()
  try {
    const { name, params, indent, control, body, gzip: wants } = JSON.parse(line)
    if (control) { // one JSON line, the bytes `trocar <command> --json` prints into a pipe; the verb says the status (src/control/board.mjs)
      try {
        const { VERBS } = await import('../control/board.mjs')
        if (!Object.hasOwn(VERBS, control)) throw new Error(`no control verb ${JSON.stringify(control)}`)
        const r = await VERBS[control](body || {}, { home, deps: await depsP })
        status = r.status
        bytes = Buffer.from(JSON.stringify(r.doc) + '\n', 'utf8')
      } catch (e) { status = 500; bytes = Buffer.from(JSON.stringify({ error: String((e && e.message) || e) }), 'utf8') }
      if (wants === true) { bytes = await gzip(bytes); enc = 'gzip' }
    } else { // `status` / `doctor` read the machine the way the control verbs do — same user home, environment and deps — so /api/status and
      // GET /control/status answer from one view of the machine (V91); the daemon passes no deps, so this is the real machine.
      // 400 = the caller's mistake (an unknown name or parameter), 500 = this worker's (src/query/answers.mjs); the message is the
      // query core's own, so the caller can raise the very error its local path would have raised.
      const deps = await depsP;
      ({ status, bytes, enc } = await answer({ name, params: params || {}, indent, gzip: wants === true },
        { home, progress, later: (fn) => after.push(fn), userHome: path.dirname(home), env: deps.env || process.env, platform: deps.platform || process.platform, deps }))
    }
  } catch (e) { // a line that is not a request
    status = 500
    bytes = Buffer.from(JSON.stringify({ error: String((e && e.message) || e) }), 'utf8')
  }
  const cpu = process.cpuUsage(cpu0)
  await write(status, bytes, enc, Math.round((cpu.user + cpu.system) / 1000))
  bytes = null
  if (after.length) setImmediate(async () => { for (const fn of after) { try { await fn() } catch { /* the next query does it */ } } })
}

let buf = '', chain = Promise.resolve() // one at a time: a request is answered before the next is read
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (line) chain = chain.then(() => serve(line))
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('disconnect', () => process.exit(0)) // the daemon is gone: so is the reason to be here
