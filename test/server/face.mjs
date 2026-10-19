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
export async function serveFace({ home, query, ...opts }) {
  const svc = query ? null : createQueryService({ home, fork: workerFork })
  const relays = []
  const q = query || { relay: (a) => (relays.push(a.name), svc.relay(a)), warm: (a) => svc.warm(a) }
  const { server } = createServer({ home, token: TOKEN, query: q, ...opts })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { server, port: server.address().port, relays, close: () => { server.close(); svc?.stop() } }
}

export const request = (port, p, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }))
  })
  r.on('error', reject); r.end()
})
