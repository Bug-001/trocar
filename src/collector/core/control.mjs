// control.mjs — the collector daemon's local control plane (RFC 4.6 §控制面): JSON over HTTP on
// $XDG_RUNTIME_DIR/asight/collector.sock, socket 0600 in a 0700 directory, so only the operator (and
// root) can reach it. Nothing here listens on TCP: the 4.4 server bridge stays off until per-user
// isolation exists, because loopback ports do not separate users (4.4 OPEN, D36 residual risk).
// A live answer on the socket means another daemon owns this user's collector → refuse to start.
import { createHash, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { CONTROL_TOKEN_HEADER, isPipePath } from '../../off/control-client.mjs'

// The client side (controlSocketPath, controlRequest, controlEndpointFor) is src/off/control-client.mjs: `asight off` asks the daemon without this directory (1.6 R3).
export { controlSocketPath, controlRequest, controlEndpointFor } from '../../off/control-client.mjs'

function probe(socketPath) {
  return new Promise((resolve) => {
    const s = net.connect(socketPath)
    s.once('connect', () => { s.destroy(); resolve('live') })
    s.once('error', (e) => resolve(e.code === 'ENOENT' ? 'absent' : 'stale'))
  })
}

// Windows (RFC 4.8 §7 控制面; W26): the daemon listens on a named pipe `\\.\pipe\asight-<16 hex>` and every request carries the secret of `control.json` in this header. A pipe has no file mode to keep other
// users out, so the secret is what does: a request without it, or with another one, is answered 401 before a route is looked up (nothing is said about which routes exist).
// The header name and the pipe shape are src/off's (control-client.mjs: one fact, one place; the standalone asight-off reads them too); re-exported because the tests import the name from here.
export { CONTROL_TOKEN_HEADER }
const sameToken = (want, got) => typeof got === 'string' && timingSafeEqual(createHash('sha256').update(want).digest(), createHash('sha256').update(got).digest())

const send = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b) }

// token: the secret a request must carry (CONTROL_TOKEN_HEADER); null asks for none (the unix socket of Linux, which the file modes keep to the operator).
// pipe: the socket path is a Windows named pipe (the default says so from the path): no directory to make, no file mode to set, no file to remove. A unix socket path may be given with `pipe: true` by a test.
export async function startControlServer({ socketPath, routes, maxBody = 64 * 1024, token = null, pipe = isPipePath(socketPath) }) {
  if (token !== null && (typeof token !== 'string' || token.length < 16)) throw new TypeError('the control token is a string of at least 16 characters, or null')
  if (!pipe && path.dirname(socketPath) !== os.tmpdir().replace(/\/+$/, '')) {
    // The directory is asight's own (Linux's $XDG_RUNTIME_DIR/asight): made 0700 and hardened again on every start. A socket directly under the
    // OS-managed per-user $TMPDIR (darwin's shape, 4.9 §7 — macOS keeps it 0700 itself) is the one directory we must NOT chmod: the system refuses it
    // (EPERM), which killed the launchd-spawned daemon on a real machine (2026-10-11; the regression cell is control.test.mjs's tmpdir test).
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.dirname(socketPath), 0o700)
  }
  const state = await probe(socketPath)
  if (state === 'live') throw new Error(`another collector daemon is answering on ${socketPath}`)
  if (state === 'stale' && !pipe) fs.rmSync(socketPath, { force: true })

  const server = http.createServer((req, res) => {
    if (token !== null && !sameToken(token, req.headers[CONTROL_TOKEN_HEADER])) { req.resume(); return send(res, 401, { error: 'the control token is missing or wrong' }) }
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
  if (!pipe) fs.chmodSync(socketPath, 0o600)
  return {
    close: () => new Promise((resolve) => { server.close(() => { if (!pipe) fs.rmSync(socketPath, { force: true }); resolve() }); server.closeAllConnections?.() }),
  }
}
