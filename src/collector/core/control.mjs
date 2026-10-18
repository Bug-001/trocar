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

const PROBE_MS = 2000 // a daemon that serves answers /status without touching disk; more than this means it does not serve

/** Who holds the control endpoint. A connect says whether anything is there at all; only a short `GET /status` says whether it SERVES.
 *  'absent' — nothing is there (the socket / pipe does not exist).
 *  'stale'  — the path is there but refuses a connection: a socket file a crashed daemon left (unix only; it is removed below).
 *  'live'   — it answered, a 401 included (a daemon of this user's with another secret): another daemon serves this user's collector.
 *  'busy'   — it accepts a connection and answers nothing: a daemon with a wedged event loop, or another program holding the pipe name.
 *             A connect alone would have called this 'live' and made the new daemon exit 0, leaving the machine with no collector, no record and
 *             no retry until the next login (D38). */
async function probe(socketPath, token) {
  const unreachable = await new Promise((resolve) => {
    const s = net.connect(socketPath)
    s.once('connect', () => { s.destroy(); resolve(null) })
    s.once('error', (e) => resolve(e.code === 'ENOENT' ? 'absent' : 'stale'))
  })
  if (unreachable) return unreachable
  // its own connection (`agent: false`): a pooled one would be kept for this path and handed to a later request on it, after this endpoint is gone.
  // Any status counts — a 401 is a daemon of this user's with another secret, a 404 one that does not know this route: both SERVE.
  return await new Promise((resolve) => {
    const req = http.request({ socketPath, method: 'GET', path: '/status', agent: false, headers: token == null ? {} : { [CONTROL_TOKEN_HEADER]: token } }, (res) => { res.resume(); resolve('live') })
    req.setTimeout(PROBE_MS, () => req.destroy(new Error('the control endpoint did not answer')))
    req.on('error', () => resolve('busy'))
    req.end()
  })
}

// Windows (RFC 4.8 §7 控制面; W26): the daemon listens on a named pipe `\\.\pipe\asight-<16 hex>` and every request carries the secret of `control.json` in this header. A pipe has no file mode to keep other
// users out, so the secret is what does: a request without it, or with another one, is answered 401 before a route is looked up (nothing is said about which routes exist).
// The header name and the pipe shape are src/off's (control-client.mjs: one fact, one place; the standalone asight-off reads them too); re-exported because the tests import the name from here.
export { CONTROL_TOKEN_HEADER }
const sameToken = (want, got) => typeof got === 'string' && timingSafeEqual(createHash('sha256').update(want).digest(), createHash('sha256').update(got).digest())

const send = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) }); res.end(b) }

/** The flag startControlServer's error carries when another daemon already answers on the control channel: the one place that names it (src/cli/daemon.mjs
 *  reads it). Not `code`: a code of its own would enter the records as a failure code outside D38's closed sets, and this is not a failure at all. */
export const DAEMON_ALREADY_UP = 'asightDaemonAlreadyUp'

/** The flag startControlServer's error carries when the control endpoint is held by something that does not answer (probe's 'busy'): this IS a failure
 *  — src/cli/daemon.mjs records it under the code of the same name and exits non-zero, so the platform retries at its own throttle. */
export const DAEMON_ENDPOINT_BUSY = 'asightControlEndpointHeld'

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
  const state = await probe(socketPath, token)
  // D62 ⑥: the code is what tells the CLI this is not a failure but a daemon already in place. `asight daemon` then exits 0, because a non-zero exit
  // is retried by the platform for as long as the other daemon lives (launchd's KeepAlive {SuccessfulExit: false} every ThrottleInterval, the Windows
  // supervisor on its backoff): a hidden loop costing CPU with nothing to show for it.
  if (state === 'live') throw Object.assign(new Error(`another collector daemon is answering on ${socketPath}`), { [DAEMON_ALREADY_UP]: true })
  if (state === 'busy') throw Object.assign(new Error(`the control endpoint ${socketPath} is held by something that does not answer`), { [DAEMON_ENDPOINT_BUSY]: true })
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
      // A handler that took `res` and wrote the reply itself returns undefined (the query route, D63: the document's bytes
      // stream from the worker to the socket and are never a value in this process); after that nothing more is sent.
      try { const r = await handler({ query: url.searchParams, body, res }); if (r !== undefined) send(res, 200, r) } catch (e) {
        if (!res.headersSent) send(res, e && Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500, { error: String((e && e.message) || e) })
        else try { res.end() } catch { /* the socket went with the failure */ }
      }
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  if (!pipe) fs.chmodSync(socketPath, 0o600)
  return {
    close: () => new Promise((resolve) => { server.close(() => { if (!pipe) fs.rmSync(socketPath, { force: true }); resolve() }); server.closeAllConnections?.() }),
  }
}

/** GET /holders (4.11 P12; registered on the daemon): `holders()` → holdersOf's rows, the daemon's last poll. → { count, holders }; before a
 *  first readable table (null) → { count: null, holders: null, unknown: true }: an unknown table is never "nobody holds the door". */
export const holdersRoute = ({ holders }) => async () => { const rows = await holders(); return Array.isArray(rows) ? { count: rows.length, holders: rows } : { count: null, holders: null, unknown: true } }
