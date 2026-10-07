// controller.mjs — the client of a mihomo controller: Clash Verge's named pipe (the user's VPN: read-only), or the own forwarder's loopback port (asight's own kernel) (RFC 4.7 §3.4 the allow-list, 4.8 §3.3 · §4.1 · §5.3; acceptance N9).
//
// ONE small client with a path allow-list that is checked BEFORE a byte is sent: a request that is not on the list throws ControllerRefused and nothing touches the network (N9). D43: asight writes nothing
// into a VPN, so the client has two forms, by `own`:
//   own:false (the user's VPN, the default)   GET /version · /configs. Nothing else: every other path and every write method (PUT PATCH POST DELETE) is refused (4.7 §2's runtime row).
//   own:true (asight's own kernel; its endpoint comes only from forwarder.lock, 4.8 §1)   the two reads, and GET /proxies/asight-* · /group/asight-*/delay?url=<loopback>&timeout=<ms> ·
//                                             PUT /configs?force=true {payload} or {path} (the forwarder reloads its own config, by text or by file).
// Never /rules, /providers/*, /connections, /logs, /traffic, /proxies (the list: the user's node names): not for Verge's controller and not for the own forwarder's (4.8 §5.3).
// A core's answers are handed to the caller as parsed JSON and nothing else (the caller keeps what it needs and drops the rest in memory: 4.7 §2).
// What a core says about a failed request is handed on only when it is one of the core's FIXED messages (FIXED_MESSAGES: they name nobody). Every other message, and the JSON body that holds it, is withheld:
// a real core's refusal of a pushed config prints the user's own group, node and rule, quoted or not (`rules[0] [DOMAIN,x.example,My Group] error: proxy [My Group] not found`, measured on v1.19.32, W57),
// and no quoting rule catches that. The caller has the status and decides the reason class. The pipe's random suffix is masked in what this client says of the transport.
// Transports: `pipe:<name>` (Windows named pipe), `tcp:<loopback host:port>` (the own forwarder; the secret is read in memory by the caller and never printed), `unix:<path>` (tests, a pinned socket).
// Node built-ins only.

import nodeHttp from 'node:http'
import path from 'node:path'
import { topKey } from './yaml-top.mjs'

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
const DELAY_PATH = new RegExp(`^/group/(${OURS})/delay\\?url=([^&]+)&timeout=(\\d{3,5})$`)
const PLAIN_READS = new Set(['/version', '/configs'])
const PROBE_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9_./-]{0,80}$/ // a group's probe is its own loopback re-entry point (4.8 §3.3), never a public address
const onlyKey = (b, k) => b !== null && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length === 1 && k in b

/**
 * Why `method target body` is not allowed, or null when it is. Pure; createController() runs it before it opens anything.
 * `own`: true only for asight's own kernel (4.8 §1); the user's VPN is never `own` and never written (D43, N9).
 */
export function refusal(method, target, body = null, { own = false } = {}) {
  if (typeof target !== 'string' || !target.startsWith('/')) return 'not a path'
  const shown = target.slice(0, 60)
  const mine = own === true
  if (method === 'GET') {
    if (body != null) return 'a read carries no body'
    if (PLAIN_READS.has(target)) return null
    if (!mine) return `GET ${shown} is not on the read allow-list of the user's VPN (only /version and /configs)`
    if (PROXY_PATH.test(target)) return null
    const d = DELAY_PATH.exec(target)
    if (d) {
      let url = null
      try { url = decodeURIComponent(d[2]) } catch { /* refused below */ }
      if (url === null || !PROBE_URL.test(url)) return 'a group probe is a loopback http URL'
      if (Number(d[3]) < 100 || Number(d[3]) > 30000) return 'a group probe timeout is 100..30000 ms'
      return null
    }
    return `GET ${shown} is not on the read allow-list`
  }
  if (!mine) return `${String(method).slice(0, 12)} ${shown}: the user's VPN is read-only, asight writes nothing into it`
  if (method === 'PUT' && target === '/configs?force=true') {
    if (onlyKey(body, 'payload') && typeof body.payload === 'string' && body.payload !== '') return null
    if (onlyKey(body, 'path') && typeof body.path === 'string' && body.path !== '') return null
    return 'a reload takes {payload} or {path}'
  }
  if (method === 'PUT') return `PUT ${shown} is not on the write allow-list`
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

/**
 * The only core messages a failed request's `text` may carry, as the real v1.19.32 prints them (W57 holds this list to it): a bad Bearer, and a path or a name that is not there (`GET /proxies/asight-*` for a
 * group that is gone). Those are the two this client can provoke. `Body invalid` (a body that is not JSON) and `Selector update error` (a select to a member the group does not have) come from requests it never
 * sends: it sends JSON it wrote itself, and `PUT /proxies/*` is not on its allow-list. Anything else is the core quoting the user's config back and is withheld.
 */
export const FIXED_MESSAGES = Object.freeze(new Set(['Unauthorized', 'Resource not found']))

/** What this client itself says about a failed transport (node's own message, the endpoint already masked): every quoted string -> <q>, at most 120 characters. */
export function redact(text) {
  const s = String(text ?? '').replace(/"[^"]*"/g, '<q>').replace(/'[^']*'/g, '<q>')
  return s.length > 120 ? s.slice(0, 120) : s
}

// ---- the client ------------------------------------------------------------------------------------------------------------------------------------------

const MAX_BODY = 32 * 1024 * 1024 // a runtime's rule list is megabytes; a controller that sends more is not one

/**
 * createController({ endpoint, secret = null, timeoutMs = 8000, own = false, transport }) → { get(path), put(path, body = null), endpoint, own }
 * Both resolve `{ status, ok, json, text, ms, error? }` and never reject for a network or HTTP failure (status 0 + `error` = the errno, `text` the masked message of the transport; a non-2xx answer has
 * `json: null` and a `text` that is one of FIXED_MESSAGES or ''); they throw ControllerRefused, before any I/O, for a request off the allow-list. `json` is the parsed body of a 2xx answer that was JSON, else
 * null. `endpoint` is the masked spec.
 * `own` is true only for asight's own kernel (see the top); `put` on a client that is not `own` always throws. `secret` goes only into the Authorization header; Verge's pipe needs none. `transport` (tests) replaces node:http.
 */
export function createController({ endpoint, secret = null, timeoutMs = 8000, own = false, transport = nodeHttp } = {}) {
  const target = parseEndpoint(endpoint)
  const shown = maskEndpoint(endpoint)
  const scrub = (t) => {
    let s = String(t ?? '').replaceAll(String(endpoint).replace(/^\w+:/, ''), '<ctl>')
    if (secret && String(secret).length >= 4) s = s.replaceAll(String(secret), '<secret>')
    return redact(maskEndpoint(s))
  }
  function send(method, path, body) {
    const why = refusal(method, path, body, { own })
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
          const said = String((json && typeof json.message === 'string' && json.message) || text).trim()
          done({ status: res.statusCode, ok, json: ok ? json : null, text: ok || !FIXED_MESSAGES.has(said) ? '' : said })
        })
      })
      req.on('timeout', () => req.destroy(Object.assign(new Error('the controller did not answer in time'), { code: 'ETIMEDOUT' })))
      req.on('error', failed)
      req.end(payload)
    })
  }
  return { get: (path) => send('GET', path, null), put: (path, body = null) => send('PUT', path, body), endpoint: shown, own: own === true }
}

// ---- finding Verge's controller, and only trusting it when it is Verge's (RFC 4.7 §3.3; N3 N4) ---------------------------------------------------------------

const VERGE_CORE = /^verge-mihomo(-alpha)?\.exe$/i
const VERGE_GUI = /^clash-verge\.exe$/i
const VERGE_SERVICE = /^clash-verge-service\.exe$/i
const dirNorm = (d) => String(d).replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
const dirKey = (file) => dirNorm(path.win32.dirname(String(file).replaceAll('/', '\\')))
const no = (why) => ({ ok: false, why })

/**
 * Whether the process that serves a controller is Verge's own core: a `verge-mihomo*.exe` in the install directory of the running Verge (the GUI's or the service's), and either this user's own
 * process (same session, its token opens) or the service's SYSTEM core (session 0, `clash-verge-service.exe` running). Anything else is another user's, or somebody else's program under that name:
 * the controller's secret goes in the Authorization header of every request, so a controller that is not Verge's is never talked to (N4).
 * `ps`: the helper's `ps` answer for every session. → `{ ok: true, how: 'own' | 'service' }` or `{ ok: false, why }`, why ∈ owner-unreadable · not-verge · other-user.
 */
export function judgeServer({ ps, serverPid, installDirs = [] }) {
  const procs = Array.isArray(ps && ps.procs) ? ps.procs : []
  const proc = Number.isInteger(serverPid) ? procs.find((p) => p && p.pid === serverPid) : null
  if (!proc) return no('owner-unreadable')
  if (!VERGE_CORE.test(String(proc.name ?? ''))) return no('not-verge')
  const dirs = new Set([...installDirs.map(dirNorm), ...procs.filter((p) => p && p.exe && (VERGE_GUI.test(p.name) || VERGE_SERVICE.test(p.name))).map((p) => dirKey(p.exe))])
  const inDirs = proc.exe ? dirs.has(dirKey(proc.exe)) : null // null: the image path is not readable (a SYSTEM process at Medium integrity)
  if (proc.sessionId === ps.sessionId && proc.tokenDenied !== true) return inDirs === true ? { ok: true, how: 'own' } : no('not-verge')
  if (proc.sessionId === 0 && inDirs !== false && procs.some((p) => p && VERGE_SERVICE.test(p.name))) return { ok: true, how: 'service' }
  return no('other-user')
}

const pipeNameOf = (v) => (v == null ? null : (/(?:^|\\)pipe\\([A-Za-z0-9._-]{1,128})\s*$/.exec(String(v)) || /^([A-Za-z0-9._-]{1,128})$/.exec(String(v)) || [])[1] ?? null)
const specOf = (v) => (/^(pipe|tcp|unix):/.test(String(v)) ? String(v) : `pipe:${pipeNameOf(v) ?? ''}`)

/**
 * discover({ listPipes, helper, readRuntime, env, makeClient, installDirs }) → { endpoint, how, version } | { unknown: { reason: 'controller-unreadable', tried: [{ how, why }] } }
 * 4.7 §3.3's order: ① the pipes named verge-mihomo* (`listPipes()`: a list of names) → ② the running core's `-ext-ctl-pipe` (the helper's `ps` with command lines; a SYSTEM core's is not readable) →
 * ③ the runtime file's `external-controller-pipe` → ④ its `external-controller` (tcp, loopback only, with its `secret`, which stays in memory). The first that is Verge's (judgeServer, BEFORE any request is sent)
 * and answers `GET /version` wins. `ASIGHT_MIHOMO_PIPE` (a pipe name, or `pipe:`/`tcp:`/`unix:` spec) pins one endpoint and skips the rest (tests; never Verge's). The result's `secret` (a tcp controller's) is
 * not enumerable, so a result that is logged or serialised never carries it; `endpoint` carries the pipe's random suffix, so a caller shows `maskEndpoint(endpoint)`, never the endpoint.
 * `why` ∈ no-pipes · unreadable · no-field · duplicate (the same endpoint an earlier source gave) · non-loopback · no-such-pipe · owner-unreadable · not-verge · other-user · no-answer.
 */
export async function discover({ listPipes = async () => [], helper = null, readRuntime = async () => null, env = process.env, makeClient = createController, installDirs = [] } = {}) {
  const tried = []
  const seen = new Set()
  let psCache = null
  const ps = async (cmdline) => {
    if (psCache && (psCache.cmdline || !cmdline)) return psCache.answer
    psCache = { cmdline, answer: await helper.call('ps', { all: true, cmdline }, { timeoutMs: 10000 }) }
    return psCache.answer
  }
  async function ownerPid(spec) {
    const t = parseEndpoint(spec)
    if (t.kind === 'pipe') { const r = await helper.call('pipe-server', { name: spec.slice(5) }); return r && r.exists === false ? 'no-such-pipe' : r && r.serverPid }
    const rows = ((await helper.call('tcp-table', { localPort: t.req.port, states: ['listen'] }, { timeoutMs: 5000 })) || {}).rows || []
    const pids = [...new Set(rows.filter((r) => r && ['127.0.0.1', '::1', '0.0.0.0', '::'].includes(r.localAddr)).map((r) => r.pid))]
    return pids.length === 1 ? pids[0] : null // more than one owner, or none: nobody to trust
  }
  async function attempt(how, spec, secret) {
    if (seen.has(spec)) { tried.push({ how, why: 'duplicate' }); return null }
    seen.add(spec)
    try { parseEndpoint(spec) } catch { tried.push({ how, why: /^tcp:/.test(spec) ? 'non-loopback' : 'no-field' }); return null }
    if (how !== 'pinned') {
      if (!helper) { tried.push({ how, why: 'owner-unreadable' }); return null }
      let pid
      let judged
      try { pid = await ownerPid(spec); judged = pid === 'no-such-pipe' ? no('no-such-pipe') : judgeServer({ ps: await ps(false), serverPid: pid, installDirs }) } catch { judged = no('owner-unreadable') }
      if (!judged.ok) { tried.push({ how, why: judged.why }); return null }
    }
    const answer = await makeClient({ endpoint: spec, secret, timeoutMs: 2000, own: false }).get('/version')
    if (!(answer.status === 200 && answer.json && typeof answer.json.version === 'string')) { tried.push({ how, why: 'no-answer' }); return null }
    const found = { endpoint: spec, how, version: answer.json.version }
    Object.defineProperty(found, 'secret', { value: secret ?? null, enumerable: false })
    return found
  }
  const pinned = env && env.ASIGHT_MIHOMO_PIPE
  if (pinned) return (await attempt('pinned', specOf(pinned), null)) || { unknown: { reason: 'controller-unreadable', tried } }
  let runtime
  let runtimeRead = false
  const runtimeText = async () => { if (!runtimeRead) { runtimeRead = true; try { runtime = await readRuntime() } catch { runtime = undefined } } return runtime }
  const sources = [
    ['enumerate', async () => { const n = await listPipes(); return (n || []).filter((x) => /^verge-mihomo/.test(x)).map((x) => `pipe:${x}`) }, 'no-pipes'],
    ['cmdline', async () => ((await ps(true)).procs || []).filter((p) => p && VERGE_CORE.test(p.name ?? '')).map((p) => pipeNameOf((/-ext-ctl-pipe\s+("?)([^"\s]+)\1/i.exec(p.cmdline ?? '') || [])[2])).filter(Boolean).map((x) => `pipe:${x}`), 'no-field'],
    ['runtime-pipe', async () => { const t = await runtimeText(); const n = typeof t === 'string' ? pipeNameOf(topKey(t, 'external-controller-pipe')) : null; if (typeof t !== 'string') throw new Error('unreadable'); return n ? [`pipe:${n}`] : [] }, 'no-field'],
    ['runtime-tcp', async () => { const t = await runtimeText(); if (typeof t !== 'string') throw new Error('unreadable'); const v = topKey(t, 'external-controller'); return v ? [{ spec: `tcp:${v}`, secret: topKey(t, 'secret') }] : [] }, 'no-field'],
  ]
  for (const [how, candidates, empty] of sources) {
    let list
    try { list = await candidates() } catch { tried.push({ how, why: 'unreadable' }); continue }
    if (list.length === 0) { tried.push({ how, why: empty }); continue }
    for (const c of list) {
      const found = typeof c === 'string' ? await attempt(how, c, null) : await attempt(how, c.spec, c.secret)
      if (found) return found
    }
  }
  return { unknown: { reason: 'controller-unreadable', tried } }
}
