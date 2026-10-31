// test/query/worker-drive.mjs — the real query worker (src/query/worker.mjs) driven as the daemon drives it: request lines on stdin,
// frames on stdout, kicks on IPC; its stderr and the D38 records it hands the daemon (`{failure}` on IPC) kept.
import { workerFork } from '../helpers/worker-fork.mjs'
import { gunzipSync } from 'node:zlib'

export function driveWorker(home) {
  const child = workerFork(home)
  let out = Buffer.alloc(0), err = ''
  const waiting = [], failures = []
  child.stderr.on('data', (d) => { err += d })
  child.on('message', (m) => { if (m && m.failure) failures.push(m.failure) })
  child.stdout.on('data', (d) => {
    out = Buffer.concat([out, d])
    for (;;) {
      const nl = out.indexOf(10)
      if (nl < 0 || !waiting.length) return
      const [status, len, enc] = out.toString('utf8', 0, nl).split(' ')
      if (out.length < nl + 1 + +len) return
      let body = out.subarray(nl + 1, nl + 1 + +len)
      out = out.subarray(nl + 1 + +len)
      if (enc === 'gzip') body = gunzipSync(body)
      waiting.shift()({ status: +status, text: body.toString('utf8') })
    }
  })
  return {
    child,
    /** the lines the worker's line files said on stderr (line-file.mjs: one per base, the files not the generation a handle knows) */
    get said() { return err.split('\n').filter((l) => l.startsWith('trocar query: ')) },
    /** the D38 records the worker handed the daemon */
    failures,
    ask(name, params) {
      return new Promise((done) => { waiting.push(done); child.stdin.write(`${JSON.stringify({ name, params })}\n`) })
    },
    kick(ids) { child.send({ kick: ids }) },
    stop() { try { child.stdin.end() } catch { /* gone */ } child.kill('SIGKILL') },
  }
}

export const until = async (f, ms, what) => {
  const t0 = Date.now()
  while (!(await f())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms: ${what}`)
    await new Promise((d) => setTimeout(d, 50))
  }
}
