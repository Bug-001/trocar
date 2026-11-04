// test/server/face.mjs — the board face (src/server.mjs) on an ephemeral port, the way the daemon mounts it: a token and a
// query service whose worker is the real one, forked with no-real-os.cjs preloaded (test/helpers/worker-fork.mjs).
import http from 'node:http'
import { once } from 'node:events'
import { createServer } from '../../src/server.mjs'
import { createQueryService } from '../../src/query/service.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'

export const TOKEN = 'Xq3-board-token_0123456789abcdefABCDEF'
export const withToken = (h = {}) => ({ [CONTROL_TOKEN_HEADER]: TOKEN, ...h })

/** `query` overrides the real service (a counting stand-in); `relays` counts what reached the worker either way. */
/** `deps` = the path of a module whose default export is the worker's `deps` (src/query/worker.mjs argv[3]); control lines count as `control:<verb>`. */
/** `failure` = the service's D38 recorder (src/query/service.mjs), e.g. to see that no worker died. */
export async function serveFace({ home, query, deps, failure, ...opts }) {
  const svc = query ? null : createQueryService({ home, failure, fork: (h) => (deps ? workerFork(h, deps) : workerFork(h)) })
  const relays = []
  const q = query || { relay: (a) => (relays.push(a.name), svc.relay(a)), control: (a) => (relays.push(`control:${a.verb}`), svc.control(a)), warm: (a) => svc.warm(a), refresh: (a) => svc.refresh(a) }
  const { server } = createServer({ home, token: TOKEN, query: q, ...opts })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { server, port: server.address().port, relays, close: () => { server.close(); svc?.stop() } }
}

export const request = (port, p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
    // whole bytes first, then text: a chunk edge can fall inside a multi-byte UTF-8 character
    const cs = []; res.on('data', (c) => cs.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(cs).toString('utf8') }))
  })
  r.on('error', reject); r.end(body)
})
