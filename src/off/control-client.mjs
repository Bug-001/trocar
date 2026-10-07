// control-client.mjs (src/off) — how a command talks to the collector daemon's control socket (RFC 4.6 §控制面: JSON over HTTP on
// $XDG_RUNTIME_DIR/asight/collector.sock, 0600 in a 0700 directory). Moved here from src/collector/core/control.mjs, which re-exports
// both names: `asight off` and the standalone `~/.asight/bin/asight-off` ask the daemon to switch off and must not need the collector
// code (0.1 §2: src/off imports only node:* and itself). The server side stays in core/control.mjs.
import nodeHttp from 'node:http'
import path from 'node:path'

/** $XDG_RUNTIME_DIR/asight/collector.sock; throws when XDG_RUNTIME_DIR is not set (the caller says why it cannot ask the daemon). */
export function controlSocketPath({ env = process.env } = {}) {
  if (!env.XDG_RUNTIME_DIR) throw new Error('XDG_RUNTIME_DIR is not set; the collector control socket lives in $XDG_RUNTIME_DIR/asight (RFC 4.6 §控制面)')
  return path.join(env.XDG_RUNTIME_DIR, 'asight', 'collector.sock')
}

/** One request → the parsed JSON reply. A non-2xx reply rejects with `status`; a socket that is absent / refuses has `code` ENOENT / ECONNREFUSED;
 *  no answer within `timeoutMs` rejects with code ETIMEDOUT. */
export function controlRequest({ socketPath, method = 'GET', path: p = '/status', body = null, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body)
    const req = nodeHttp.request({ socketPath, method, path: p, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        let obj = null
        try { obj = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { obj = { error: 'non-JSON reply' } }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(obj)
        else reject(Object.assign(new Error(`${res.statusCode}: ${obj && obj.error}`), { status: res.statusCode }))
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('control request timed out'), { code: 'ETIMEDOUT' })))
    req.on('error', reject)
    req.end(payload ?? undefined)
  })
}
