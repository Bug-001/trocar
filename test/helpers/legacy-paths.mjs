// test/helpers/legacy-paths.mjs — the two OLD capture paths (src/capture/{reverse-proxy,mitm}.mjs) in front of an upstream the
// test writes, behind one `send`. The reverse proxy talks plain HTTP to the upstream; the MITM terminates TLS for
// api.anthropic.com in front of an HTTPS one. Exports only: node --test also loads this file and it must run nothing at import.
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { once } from 'node:events'
import { createReverseProxy } from '../../src/capture/reverse-proxy.mjs'
import { createMitmProxy } from '../../src/capture/mitm.mjs'
import { makeCerts } from './mitm-certs.mjs'

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

export async function mitmPath(handler, opts = {}) {
  const { caCert, leaf } = makeCerts('api.anthropic.com')
  const upstream = https.createServer({ key: leaf.key, cert: leaf.cert }, handler); const upPort = await listen(upstream)
  const envelopes = [], events = []
  const proxy = createMitmProxy({ targetHost: 'api.anthropic.com', leaf, onEnvelope: (e) => envelopes.push(e), onEvent: (e) => events.push(e),
    connectUpstream: (_o, cb) => { const s = tls.connect({ host: '127.0.0.1', port: upPort, servername: 'api.anthropic.com', ca: caCert }, () => cb(null, s)); s.on('error', cb) },
    blindTunnel: () => { throw new Error('only the target host is decrypted') }, ...opts })
  const px = await listen(proxy)
  const send = ({ method = 'GET', path: p, headers = {}, body }) => new Promise((resolve, reject) => {
    const sock = net.connect(px, '127.0.0.1', () => sock.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n'))
    sock.once('data', () => {
      const t = tls.connect({ socket: sock, servername: 'api.anthropic.com', ca: caCert }, () => {
        const b = body === undefined ? Buffer.alloc(0) : Buffer.from(body)
        t.write(Buffer.concat([Buffer.from(`${method} ${p} HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-length: ${b.length}\r\nconnection: close\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`), b]))
      })
      const cs = []; t.on('data', (d) => cs.push(d)); t.on('error', reject)
      t.on('end', () => {
        const raw = Buffer.concat(cs); const i = raw.indexOf('\r\n\r\n'); const head = raw.subarray(0, i).toString('latin1')
        const status = Number(head.split(' ')[1]); const hs = Object.fromEntries(head.split('\r\n').slice(1).map((l) => { const k = l.indexOf(':'); return [l.slice(0, k).toLowerCase(), l.slice(k + 1).trim()] }))
        let body2 = raw.subarray(i + 4)
        if (hs['transfer-encoding'] === 'chunked') { const parts = []; let q = body2; while (q.length) { const j = q.indexOf('\r\n'); const n = parseInt(q.subarray(0, j).toString(), 16); if (!n) break; parts.push(q.subarray(j + 2, j + 2 + n)); q = q.subarray(j + 2 + n + 2) } body2 = Buffer.concat(parts) }
        resolve({ status, headers: hs, body: body2 })
      })
    })
    sock.on('error', reject)
  })
  return { send, envelopes, events, name: 'MITM', stop: () => { proxy.close(); upstream.close() } }
}

export const LEGACY_PATHS = [reverseProxyPath, mitmPath]
