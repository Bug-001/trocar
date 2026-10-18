// control-client.mjs (src/off) — how a command talks to the collector daemon's control socket (RFC 4.6 §控制面: JSON over HTTP on
// $XDG_RUNTIME_DIR/asight/collector.sock, 0600 in a 0700 directory; on Windows 4.8 §7 控制面: a named pipe \\.\\pipe\\asight-<hex> whose
// name and secret token live in <collector>\control.json — a pipe has no file mode, so the token is what keeps it to the operator).
// Moved here from src/collector/core/control.mjs, which re-exports both names: `asight off` and the standalone `~/.asight/bin/asight-off`
// ask the daemon to switch off and must not need the collector code (0.1 §2: src/off imports only node:* and itself). The server side
// stays in core/control.mjs. The facts both sides share (CONTROL_FILE, CONTROL_TOKEN_HEADER, PIPE_PREFIX, the pipe shape) live HERE once: the
// daemon (core/control.mjs, arch/*/control-path.mjs) imports them — core may import src/off (0.1 §2), src/off cannot import core.
import nodeFs from 'node:fs'
import nodeHttp from 'node:http'
import path from 'node:path'

export const CONTROL_FILE = 'control.json'
/** The header every request to a token-guarded endpoint carries; the daemon's server (core/control.mjs) imports this name. */
export const CONTROL_TOKEN_HEADER = 'x-asight-token'
/** What a Windows daemon's pipe name starts with (`\\.\pipe\asight-`); the writer (arch/win32/control-path.mjs) adds `<16 hex>` and holds that strictly. */
export const PIPE_PREFIX = '\\\\.\\pipe\\asight-'
/** Is `p` a Windows named pipe: `\\.\pipe\` or `\\?\pipe\` and any name. Deliberately loose — off must not refuse a pipe a newer daemon build named differently —
 *  but never a unix path or a file: on win32 nothing that is no pipe is ever connected to (the platform-seam rule). */
export const isPipePath = (p) => typeof p === 'string' && /^\\\\[.?]\\pipe\\./.test(p)

/** $XDG_RUNTIME_DIR/asight/collector.sock; throws when XDG_RUNTIME_DIR is not set (the caller says why it cannot ask the daemon).
 *  Linux's endpoint; Windows finds its own through controlEndpointOf (offWorld asks the right one for its platform). */
export function controlSocketPath({ env = process.env } = {}) {
  if (!env.XDG_RUNTIME_DIR) throw new Error('XDG_RUNTIME_DIR is not set; the collector control socket lives in $XDG_RUNTIME_DIR/asight (RFC 4.6 §控制面)')
  return path.join(env.XDG_RUNTIME_DIR, 'asight', 'collector.sock')
}

/** The endpoint `control.json` in the collector `dir` names (the Windows daemon writes it at its first start, RFC 4.8 §7 控制面):
 *  `{ path, token }` · null when there is none (no daemon was ever started here) · `{ error }` when there is one that names no endpoint,
 *  or cannot be read. The validation is deliberately lighter than the writer's (arch/win32/control-path.mjs): off must not refuse what
 *  a daemon of a newer build wrote — a wrong token is the daemon's own 401 to answer, an unreadable file is a shape error to say. */
export function controlEndpointOf({ dir, fs = nodeFs } = {}) {
  let text
  try { text = fs.readFileSync(path.join(dir, CONTROL_FILE), 'utf8') } catch (e) {
    if (e && e.code === 'ENOENT') return null
    return { error: `${path.join(dir, CONTROL_FILE)} cannot be read (${(e && e.code) || (e && e.message) || e})` }
  }
  let o
  try { o = JSON.parse(text) } catch { return { error: `${path.join(dir, CONTROL_FILE)} is not JSON` } } // not the parser's message: it quotes the characters around the error, and a damaged file may have the token in them (the same rule as arch/win32/control-path.mjs)
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return { error: `${CONTROL_FILE} is not an object` }
  if (typeof o.path !== 'string' || o.path === '') return { error: `${CONTROL_FILE} names no pipe path` }
  if (typeof o.token !== 'string' || o.token === '') return { error: `${CONTROL_FILE} names no token` }
  return { path: o.path, token: o.token }
}

/** The daemon's endpoint for THIS platform, resolved the one way every caller resolves it (the 2026-10-11 incident's seam: three call sites each
 *  carried their own platform fallback, and the one nobody re-audited — turnOn's probe — kept the Linux path and made every `asight on` on a real
 *  Mac / Windows a false start-failed). darwin / win32 find the daemon through `control.json` in the collector `dir` (4.8 §7, 4.9 §7: random
 *  socket / pipe name plus the token every request carries); Linux derives `$XDG_RUNTIME_DIR/asight/collector.sock`. → `{ socketPath, request, why? }`:
 *  `request` is controlRequest wrapped with the token on the platforms that use one; a `why` names what is missing when there is no endpoint. Never
 *  throws — reading control.json is best-effort; the caller decides what a missing endpoint means. */
export function controlEndpointFor({ platform = process.platform, dir, env = process.env, fs = nodeFs } = {}) {
  if (platform === 'win32' || platform === 'darwin') { // not proxy mode: the OSes that name their endpoint in control.json (4.9 §7)
    const ep = controlEndpointOf({ dir, fs })
    if (ep == null) return { socketPath: null, request: controlRequest, why: `${CONTROL_FILE} names no daemon here (none was ever started)` }
    if (ep.error) return { socketPath: null, request: controlRequest, why: ep.error }
    if (platform === 'win32' && !isPipePath(ep.path)) return { socketPath: null, request: controlRequest, why: `${CONTROL_FILE} names ${ep.path}, which is no Windows named pipe` }
    return { socketPath: ep.path, request: ep.token ? ((o) => controlRequest({ ...o, token: ep.token })) : controlRequest }
  }
  let socketPath = null, why = null
  try { socketPath = controlSocketPath({ env }) } catch (e) { why = String((e && e.message) || e) }
  return { socketPath, request: controlRequest, why: socketPath ? null : why }
}

/** One request → the parsed JSON reply. A non-2xx reply rejects with `status`; a socket that is absent / refuses has `code` ENOENT / ECONNREFUSED;
 *  no answer within `timeoutMs` rejects with code ETIMEDOUT. `token`: the secret a token-guarded endpoint (a Windows pipe) expects in
 *  CONTROL_TOKEN_HEADER; null (the Linux unix socket) sends none. A Windows pipe path reaches Node's http through the same `socketPath`. */
export function controlRequest({ socketPath, method = 'GET', path: p = '/status', body = null, token = null, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body)
    const headers = payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}
    if (token != null) headers[CONTROL_TOKEN_HEADER] = token
    const req = nodeHttp.request({ socketPath, method, path: p, headers }, (res) => {
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
