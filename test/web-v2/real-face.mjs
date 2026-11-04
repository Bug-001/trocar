// test/web-v2/real-face.mjs — the board's real data face for tests: the real createServer (src/server.mjs) over the real query
// service, whose worker gets its OS facts through its deps seam (argv[3], test/helpers/board-world.mjs) for this host's own platform and an
// empty machine: no process, no OS tool, no login entry answer of the OS. So `status` / `doctor` run their real code on any host (0.1 §3 「不碰真实机器」). Exports only: node --test runs every .mjs, so no top-level test lives here.
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../src/server.mjs'
import { createQueryService } from '../../src/query/service.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { depsFile } from '../helpers/board-world.mjs'
import { workerForkIn } from '../helpers/worker-fork.mjs'
import { writeSegment } from '../query/raw-home.mjs'
import { generate } from '../../scripts/gen-dataset.mjs'
import { TOKEN, request, withToken } from '../server/face.mjs'

const DEMO = fileURLToPath(new URL('../../samples/demo-session.ndjson', import.meta.url))

/** A temp user home whose ~/.trocar holds the demo session as one segment; `bytes` > 0 adds multi-harness traffic. */
export function boardHome({ bytes = 0 } = {}) {
  const userHome = tmpDir('trocar-board-')
  const home = path.join(userHome, '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  writeSegment(home, '20260719T090000Z', fs.readFileSync(DEMO, 'utf8').split('\n').filter(Boolean))
  if (bytes > 0) generate({ home, bytes })
  return { userHome, home }
}

/** The face on an ephemeral port (`idleMs`: the query worker's idle exit, the service's default when absent). get(name, params) → {status, doc}; close() stops the server and the worker.
 *  workers() → the pids of the query workers it forked that are still alive; killWorker(sig) signals them, → how many. workerEnvs() → the
 *  environment each worker it forked was started with: HOME / USERPROFILE are the temp userHome, never the operator's own. */
export async function serveBoard({ userHome, home, idleMs }) {
  const env = { HOME: userHome, USERPROFILE: userHome }
  const deps = depsFile({ home: userHome, env }, process.platform)
  const kids = [], fork = workerForkIn(env)
  const svc = createQueryService({ home, idleMs, fork: (h) => { const c = fork(h, deps); kids.push(c); return c } })
  const alive = () => kids.filter((c) => c.exitCode === null && c.signalCode === null)
  const { server } = createServer({ home, token: TOKEN, query: svc, webDir: process.env.TROCAR_BOARD_DIR }) // --desk-next: the desk-next build (scripts/test-browser.mjs)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  const get = async (name, params = {}) => {
    const r = await request(port, `/api/${name}?${new URLSearchParams(params)}`, { headers: withToken() })
    let doc = null
    try { doc = JSON.parse(r.body) } catch { /* not JSON: doc stays null */ }
    return { status: r.status, doc }
  }
  const workers = () => alive().map((c) => c.pid)
  const killWorker = (sig = 'SIGKILL') => alive().filter((c) => c.kill(sig)).length
  const workerEnvs = () => kids.map((c) => c.forkEnv)
  return { port, base: `http://127.0.0.1:${port}`, token: TOKEN, get, workers, killWorker, workerEnvs, close: async () => { svc.stop(); server.close(); await once(server, 'close') } }
}
