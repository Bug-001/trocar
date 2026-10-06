// control.mjs — the collector daemon's local control plane (RFC 4.6 §控制面): JSON over HTTP on
// $XDG_RUNTIME_DIR/asight/collector.sock, socket 0600 in a 0700 directory, so only the operator (and
// root) can reach it. Nothing here listens on TCP: the 4.4 server bridge stays off until per-user
// isolation exists, because loopback ports do not separate users (4.4 OPEN, D36 residual risk).
// A live answer on the socket means another daemon owns this user's collector → refuse to start.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

// The client side (controlSocketPath, controlRequest) is src/off/control-client.mjs: `asight off` asks the daemon without this directory (1.6 R3).
export { controlSocketPath, controlRequest } from '../../off/control-client.mjs'

function probe(socketPath) {
  return new Promise((resolve) => {
    const s = net.connect(socketPath)
    s.once('connect', () => { s.destroy(); resolve('live') })
    s.once('error', (e) => resolve(e.code === 'ENOENT' ? 'absent' : 'stale'))
  })
}

const send = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b) }

export async function startControlServer({ socketPath, routes, maxBody = 64 * 1024 }) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(socketPath), 0o700)
  const state = await probe(socketPath)
  if (state === 'live') throw new Error(`another collector daemon is answering on ${socketPath}`)
  if (state === 'stale') fs.rmSync(socketPath, { force: true })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://collector')
    const handler = routes[`${req.method} ${url.pathname}`]
    const chunks = []
    let size = 0
    let tooBig = false
    req.on('data', (c) => { size += c.length; if (size > maxBody) tooBig = true; else chunks.push(c) })
    req.on('end', async () => {
      if (tooBig) return send(res, 413, { error: 'request body too large' })
      if (!handler) return send(res, 404, { error: `no route ${req.method} ${url.pathname}` })
      let body = null
      if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(res, 400, { error: 'body is not JSON' }) } }
      // a handler may refuse a request with `status` 4xx (a body it cannot act on); anything else it throws is a 500
      try { send(res, 200, await handler({ query: url.searchParams, body })) } catch (e) { send(res, e && Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500, { error: String((e && e.message) || e) }) }
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  fs.chmodSync(socketPath, 0o600)
  return {
    close: () => new Promise((resolve) => { server.close(() => { fs.rmSync(socketPath, { force: true }); resolve() }); server.closeAllConnections?.() }),
  }
}
