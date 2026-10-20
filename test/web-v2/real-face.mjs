// test/web-v2/real-face.mjs — the board's real data face for tests: the real createServer (src/server.mjs) over the real query
// service, whose worker runs with HOME = a temp user home and PATH = the OS stubs, so `status` / `doctor` run their real code on an
// empty machine (0.1 §3 「不碰真实机器」). Exports only: node --test runs every .mjs, so no top-level test lives here.
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../src/server.mjs'
import { createQueryService } from '../../src/query/service.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { osStubs } from '../helpers/os-stubs.mjs'
import { writeSegment } from '../query/raw-home.mjs'
import { generate } from '../../scripts/gen-dataset.mjs'
import { TOKEN, request, withToken } from '../server/face.mjs'

const WORKER = fileURLToPath(new URL('../../src/query/worker.mjs', import.meta.url))
const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const DEMO = fileURLToPath(new URL('../../samples/demo-session.ndjson', import.meta.url))

/** A temp user home whose ~/.asight holds the demo session as one segment; `bytes` > 0 adds multi-harness traffic. */
export function boardHome({ bytes = 0 } = {}) {
  const userHome = tmpDir('asight-board-')
  const home = path.join(userHome, '.asight')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  writeSegment(home, '20260719T090000Z', fs.readFileSync(DEMO, 'utf8').split('\n').filter(Boolean))
  if (bytes > 0) generate({ home, bytes })
  return { userHome, home }
}

/** The face on an ephemeral port. get(name, params) → {status, doc}; close() stops the server and the worker. */
export async function serveBoard({ userHome, home }) {
  const env = { ...process.env, HOME: userHome, ...osStubs().env }
  const svc = createQueryService({ home, fork: (h, ...argv) => fork(WORKER, [h, ...argv], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: ['--require', NO_REAL_OS], env }) })
  const { server } = createServer({ home, token: TOKEN, query: svc })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  const get = async (name, params = {}) => {
    const r = await request(port, `/api/${name}?${new URLSearchParams(params)}`, { headers: withToken() })
    let doc = null
    try { doc = JSON.parse(r.body) } catch { /* not JSON: doc stays null */ }
    return { status: r.status, doc }
  }
  return { port, base: `http://127.0.0.1:${port}`, token: TOKEN, get, close: async () => { svc.stop(); server.close(); await once(server, 'close') } }
}
