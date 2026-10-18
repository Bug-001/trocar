// src/query/worker.mjs — the daemon's query worker (RFC 1.6 §4.1 「谁答」, 0.2 §1 角色表, D63 ①).
//
// A child of the collector daemon, forked on demand and running at low priority, like the sealer: the daemon's own
// event loop forwards agent traffic and MUST NOT compute a query. It stays warm (src/query/warm.mjs keeps the
// segments' index rows and the recently opened sessions' records, each revalidated per request against the files it
// came from), and exits after ASIGHT_QUERY_IDLE_MS idle — ONE one-shot timer, re-armed per request, so nobody
// querying means no worker and no timer.
//
// The wire is frames on this process's own pipes, not JSON over IPC: one request per line on stdin
// (`{name, params, indent}`), one reply on stdout as `<status> <byteLength>\n` then exactly those bytes. The daemon
// forwards the bytes without parsing or re-encoding them, so a 30 MB document costs it a few buffer writes (1.6
// §4.1 「守护进程的负担」).
import os from 'node:os'
import { LOCAL_ENV } from './client.mjs'
import { runQuery, QueryArgError } from './named/index.mjs'

const home = process.argv[2]
const IDLE_MS = Number(process.env.ASIGHT_QUERY_IDLE_MS || 180_000)
// What the CLI's own environment may change about an answer goes local (client.mjs LOCAL_ENV); this worker serves
// every caller, so it answers as a clean environment would and never as the daemon's happened to be.
for (const k of LOCAL_ENV) delete process.env[k]
try { os.setPriority(0, 5) } catch { /* not permitted: it runs at the daemon's priority then, one query at a time */ }

let idle = null
const rearm = () => { clearTimeout(idle); idle = setTimeout(() => process.exit(0), IDLE_MS) }

const write = (status, body) => new Promise((done) => {
  process.stdout.write(`${status} ${body.length}\n`, () => { if (body.length) process.stdout.write(body, done); else done() })
})

async function answer(line) {
  clearTimeout(idle)
  let status = 200, text
  try {
    const { name, params, indent } = JSON.parse(line)
    text = JSON.stringify(await runQuery(name, params || {}, { home }), null, Number(indent) || 0)
  } catch (e) {
    // 400 = the caller's mistake (an unknown name or parameter), 500 = this worker's. The message is the query
    // core's own, so the caller can raise the very error its local path would have raised.
    status = e instanceof QueryArgError ? 400 : 500
    text = JSON.stringify({ error: String((e && e.message) || e) })
  }
  await write(status, Buffer.from(text, 'utf8'))
  rearm()
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
