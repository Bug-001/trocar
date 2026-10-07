// controller.mjs — the client of a mihomo controller: Clash Verge's named pipe, or the own forwarder's loopback port (RFC 4.7 §3.4 the allow-list, 4.8 §3.3 · §4.1 · §5.3; acceptance N9).
//
// ONE small client with a path allow-list that is checked BEFORE a byte is sent: a request that is not on the list throws ControllerRefused and nothing touches the network (N9). The list is 4.7 §2's
// runtime row for reads and §3.4's named writes:
//   GET  /version · /configs · /providers/rules (the LIST: v1.19.32 has no GET of a single provider, it answers 405) · /rules · /proxies/asight-* · /group/asight-*/delay?url=<loopback>&timeout=<ms>
//   PUT  /proxies/asight-sw-<g> {name: PASS | asight-fb-<g>} · /providers/rules/asight-* · /configs?force=true {payload}   (the forwarder's own client may also reload by {path}: `reloadByPath`)
// Never /connections, /logs, /traffic, /proxies (the list: the user's node names), /providers/proxies (subscription names): not for Verge's controller and not for the own forwarder's (4.8 §5.3).
// A name the client writes starts with asight-; a core's answers are handed to the caller as parsed JSON and nothing else (the caller keeps what it needs and drops the rest in memory: 4.7 §2).
// The controller's error text is redacted before it goes anywhere (every quoted string -> <q>, cut to 120 characters), and the pipe's random suffix is masked.
// Transports: `pipe:<name>` (Windows named pipe), `tcp:<loopback host:port>` (the own forwarder; the secret is read in memory by the caller and never printed), `unix:<path>` (tests, a pinned socket).
// Node built-ins only.

import nodeHttp from 'node:http'

/** Thrown, with nothing sent, for a request the allow-list does not name. */
export class ControllerRefused extends Error {
  constructor(message) {
    super(message)
    this.name = 'ControllerRefused'
    this.code = 'controller-refused'
  }
}

const OURS = 'asight-[A-Za-z0-9_.-]{1,128}'
const PROXY_PATH = new RegExp(`^/proxies/(${OURS})$`)
const SWITCH_PATH = /^\/proxies\/(asight-sw-([A-Za-z0-9_.-]{1,128}))$/
const PROVIDER_PATH = new RegExp(`^/providers/rules/(${OURS})$`)
const DELAY_PATH = new RegExp(`^/group/(${OURS})/delay\\?url=([^&]+)&timeout=(\\d{3,5})$`)
const PLAIN_READS = new Set(['/version', '/configs', '/providers/rules', '/rules'])
const PROBE_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9_./-]{0,80}$/ // a group's probe is its own loopback re-entry point (4.8 §3.3), never a public address
const onlyKey = (b, k) => b !== null && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length === 1 && k in b

/**
 * Why `method target body` is not allowed, or null when it is. Pure; createController() runs it before it opens anything.
 * `reloadByPath`: the own forwarder's client reloads its config by `{path}`; Verge's never does (a path would load some other config into the user's core).
 */
export function refusal(method, target, body = null, { reloadByPath = false } = {}) {
  if (typeof target !== 'string' || !target.startsWith('/')) return 'not a path'
  const shown = target.slice(0, 60)
  if (method === 'GET') {
    if (body != null) return 'a read carries no body'
    if (PLAIN_READS.has(target) || PROXY_PATH.test(target)) return null
    const d = DELAY_PATH.exec(target)
    if (d) {
      let url = null
      try { url = decodeURIComponent(d[2]) } catch { /* refused below */ }
      if (url === null || !PROBE_URL.test(url)) return 'a group probe is a loopback http URL'
      if (Number(d[3]) < 100 || Number(d[3]) > 30000) return 'a group probe timeout is 100..30000 ms'
      return null
    }
    if (/^\/providers\/rules\/./.test(target)) return `GET ${shown}: v1.19.32 has no read of a single provider, only the list`
    return `GET ${shown} is not on the read allow-list`
  }
  if (method === 'PUT') {
    const sw = SWITCH_PATH.exec(target)
    if (sw) {
      if (!onlyKey(body, 'name')) return 'a switch takes {name} and nothing else'
      return body.name === 'PASS' || body.name === `asight-fb-${sw[2]}` ? null : `a switch is set to PASS or to its own asight-fb-<group>`
    }
    if (PROVIDER_PATH.test(target)) return body == null ? null : 'a provider refresh takes no body'
    if (target === '/configs?force=true') {
      if (onlyKey(body, 'payload') && typeof body.payload === 'string' && body.payload !== '') return null
      if (reloadByPath && onlyKey(body, 'path') && typeof body.path === 'string' && body.path !== '') return null
      return reloadByPath ? 'a reload takes {payload} or {path}' : 'a reload takes {payload}'
    }
    return `PUT ${shown} is not on the write allow-list`
  }
  return `${String(method).slice(0, 12)} is not an allowed method`
}

// ---- the endpoint, and what may be said about it ---------------------------------------------------------------------------------------------------------

/** `pipe:<name>` · `tcp:<loopback host:port>` · `unix:<path>` → how to reach it. Anything else, and a tcp host that is not this machine's loopback, is refused. */
export function parseEndpoint(spec) {
  const m = /^(pipe|tcp|unix):(.+)$/s.exec(String(spec ?? ''))
  if (!m) throw new ControllerRefused('a controller endpoint is pipe:<name>, tcp:<host:port> or unix:<path>')
  const [, kind, arg] = m
  if (kind === 'pipe') {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(arg)) throw new ControllerRefused('a pipe name has no path separator')
    return { kind, req: { socketPath: `\\\\.\\pipe\\${arg}` } }
  }
  if (kind === 'unix') return { kind, req: { socketPath: arg } }
  const t = /^(127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/.exec(arg)
  if (!t || Number(t[2]) < 1 || Number(t[2]) > 65535) throw new ControllerRefused('a tcp controller is on this machine\'s loopback: 127.0.0.1:<port>')
  return { kind, req: { host: t[1] === '[::1]' ? '::1' : t[1], port: Number(t[2]) } }
}

/** The endpoint as it may be logged or written to netenv.json: a long hex run (the random part of Verge's pipe name, a temp directory's) is `<k>`. */
export const maskEndpoint = (spec) => String(spec ?? '').replace(/[0-9a-f]{8,}/gi, '<k>')

/** A core's error text, safe to keep: every quoted string (a node, a group, a profile) -> <q>, at most 120 characters. */
export function redact(text) {
  const s = String(text ?? '').replace(/"[^"]*"/g, '<q>').replace(/'[^']*'/g, '<q>')
  return s.length > 120 ? s.slice(0, 120) : s
}

// ---- the client ------------------------------------------------------------------------------------------------------------------------------------------

const MAX_BODY = 32 * 1024 * 1024 // a runtime's rule list is megabytes; a controller that sends more is not one

/**
 * createController({ endpoint, secret = null, timeoutMs = 8000, reloadByPath = false, transport }) → { get(path), put(path, body = null), endpoint }
 * Both resolve `{ status, ok, json, text, ms, error? }` and never reject for a network or HTTP failure (status 0 + `error` = the errno; `text` is the redacted message of a non-2xx answer);
 * they throw ControllerRefused, before any I/O, for a request off the allow-list. `json` is the parsed body of an answer that was JSON, else null. `endpoint` is the masked spec.
 * `secret` goes only into the Authorization header; Verge's pipe needs none. `transport` (tests) replaces node:http.
 */
export function createController({ endpoint, secret = null, timeoutMs = 8000, reloadByPath = false, transport = nodeHttp } = {}) {
  const target = parseEndpoint(endpoint)
  const shown = maskEndpoint(endpoint)
  const scrub = (t) => {
    let s = String(t ?? '').replaceAll(String(endpoint).replace(/^\w+:/, ''), '<ctl>')
    if (secret && String(secret).length >= 4) s = s.replaceAll(String(secret), '<secret>')
    return redact(maskEndpoint(s))
  }
  function send(method, path, body) {
    const why = refusal(method, path, body, { reloadByPath })
    if (why) throw new ControllerRefused(`${method} ${String(path).slice(0, 60)}: ${why}`)
    const payload = body == null ? null : JSON.stringify(body)
    const t0 = Date.now()
    return new Promise((resolve) => {
      let settled = false
      const done = (r) => { if (!settled) { settled = true; resolve({ ...r, ms: Date.now() - t0 }) } }
      const failed = (e) => done({ status: 0, ok: false, json: null, text: scrub(e && e.message), error: (e && e.code) || 'error' })
      const headers = { Accept: 'application/json', ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }
      const req = transport.request({ ...target.req, method, path, headers, agent: false, timeout: timeoutMs }, (res) => {
        const chunks = []
        let size = 0
        res.on('data', (d) => {
          size += d.length
          if (size > MAX_BODY) { res.destroy(); failed(Object.assign(new Error('the controller sent more than 32 MiB'), { code: 'ERESPONSE_TOO_LARGE' })) } else chunks.push(d)
        })
        res.on('error', failed)
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = JSON.parse(text) } catch { /* not JSON: an empty 204, or a plain-text error */ }
          const ok = res.statusCode >= 200 && res.statusCode < 300
          done({ status: res.statusCode, ok, json, text: ok ? '' : scrub((json && json.message) || text) })
        })
      })
      req.on('timeout', () => req.destroy(Object.assign(new Error('the controller did not answer in time'), { code: 'ETIMEDOUT' })))
      req.on('error', failed)
      req.end(payload)
    })
  }
  return { get: (path) => send('GET', path, null), put: (path, body = null) => send('PUT', path, body), endpoint: shown }
}
