// test/helpers/legacy-paths.mjs — the OLD capture path that still has a runner (src/capture/reverse-proxy.mjs) in front of an
// upstream the test writes, behind one `send`; it talks plain HTTP to the upstream. The MITM half went with src/capture/mitm.mjs
// (D39⑥ executed 2026-10-11) — the D40 tests keep the reverse-proxy leg, the surviving source of the same envelope contract.
// Exports only: node --test also loads this file and it must run nothing at import.
import http from 'node:http'
import { once } from 'node:events'
import { createReverseProxy } from '../../src/capture/reverse-proxy.mjs'

const listen = async (server) => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }

/** → { send({method, path, headers, body}) → {status, headers, body: Buffer (dechunked, as the client received it)}, envelopes, events, stop() } */
export async function reverseProxyPath(handler, opts = {}) {
  const upstream = http.createServer(handler); const upPort = await listen(upstream)
  const envelopes = [], events = []
  const proxy = createReverseProxy({ target: new URL(`http://127.0.0.1:${upPort}`), onEnvelope: (e) => envelopes.push(e), onEvent: (e) => events.push(e), ...opts })
  const px = await listen(proxy)
  const send = ({ method = 'GET', path: p, headers = {}, body }) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: px, method, path: p, headers }, (res) => { const cs = []; res.on('data', (c) => cs.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(cs) })) })
    r.on('error', reject); r.end(body)
  })
  return { send, envelopes, events, name: 'reverse proxy', stop: () => { proxy.close(); upstream.close() } }
}

export const LEGACY_PATHS = [reverseProxyPath]
