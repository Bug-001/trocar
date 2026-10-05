// server.mjs — scripted mock LLM upstream for the collector test lab (README.md). It logs the exact
// bytes of every request and response, so a test can prove the collector in between is transparent.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import { once } from 'node:events'
import { parseRequest } from './http1.mjs'
import { SCENARIOS, isScenario, pickScenario, errorFor, expandSteps } from './scenarios.mjs'
import { writeResponse, jsonReply } from './transport.mjs'
import * as anthropic from './anthropic.mjs'
import * as openai from './openai.mjs'

const iso = () => new Date().toISOString()

// Matched on the path suffix so relay prefixes (/anthropic/v1/messages, …) route the same.
const ROUTES = [
  { re: /\/v1\/messages\/count_tokens$/, methods: ['POST'], kind: 'count', dialect: anthropic },
  { re: /\/v1\/messages$/, methods: ['POST'], kind: 'model', dialect: anthropic },
  { re: /\/responses$/, methods: ['POST'], kind: 'model', dialect: openai.responses }, // also Codex's /codex/responses
  { re: /\/chat\/completions$/, methods: ['POST'], kind: 'model', dialect: openai.chat },
  { re: /^\/api\/hello$/, methods: ['HEAD', 'GET'], kind: 'hello', dialect: anthropic },
  { re: /\/models$/, methods: ['GET'], kind: 'models' },
]

// One list both SDK families accept: Anthropic reads type/display_name, OpenAI reads object/owned_by.
const MODEL_IDS = ['mock-model', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'gpt-5', 'gpt-5-codex', 'deepseek-chat']
const MODELS = {
  object: 'list', has_more: false, first_id: MODEL_IDS[0], last_id: MODEL_IDS.at(-1),
  data: MODEL_IDS.map((id) => ({ type: 'model', object: 'model', id, display_name: id, created_at: '2025-01-01T00:00:00Z', created: 1735689600, owned_by: 'asight-mock' })),
}

const parseJson = (buf) => { try { const v = JSON.parse(buf.toString('utf8')); return v && typeof v === 'object' ? v : {} } catch { return {} } }

async function dispatch(req, io, state) {
  const p = req.target.split('?')[0]
  const route = ROUTES.find((r) => r.re.test(p) && r.methods.includes(req.method))
  const pick = pickScenario(req.headers, req.body, route?.kind === 'model', state.queue)
  const sc = isScenario(pick.name) ? { ...SCENARIOS[pick.name], via: pick } : null
  // errors on routes no dialect owns (models, unknown paths) take the shape the client speaks
  const dialect = route?.dialect || (req.headers['anthropic-version'] ? anthropic : openai.chat)
  let res
  if (!sc) res = dialect.errorReply(400, `mock-upstream: unknown scenario "${pick.name}"`)
  else if (sc.status) res = errorFor(sc, dialect)
  else if (!route) res = dialect.errorReply(404, `mock-upstream: no route for ${req.method} ${p}`)
  else if (route.kind === 'model') res = route.dialect.reply(parseJson(req.body), req.body, sc)
  else if (route.kind === 'count') res = jsonReply(200, { input_tokens: Math.max(1, Math.ceil(req.body.length / 4)) })
  else if (route.kind === 'models') res = jsonReply(200, MODELS)
  else res = { status: 200, headers: {}, pieces: [] }
  res.headers['x-mock-scenario'] = pick.name
  const close = /close/i.test(req.headers.connection || '')
  return { scenario: pick.name, source: pick.source, complete: await writeResponse(io, res, { head: req.method === 'HEAD', close, sc: sc || {}, cfg: state.cfg }) }
}

// Requests on one connection are served strictly in order; bytes that arrive meanwhile wait in buf.
function serveConn(conn, state, record) {
  let buf = Buffer.alloc(0), busy = false, seq = 0
  const { sock } = conn
  sock.on('data', (d) => { conn.bytesIn += d.length; buf = Buffer.concat([buf, d]); pump() })
  sock.on('error', (e) => { conn.error = e.code || e.message })
  sock.on('secure', () => { conn.secured = true })
  sock.on('close', () => {
    conn.closed = true
    for (const wake of conn.wakers) wake()
    // after any in-flight request entry, which is recorded once its sleeper wakes
    setImmediate(() => record({
      type: 'conn', ts: iso(), conn_id: conn.id, tls: conn.tls, requests: seq, bytes_in: conn.bytesIn, bytes_out: conn.bytesOut,
      ...(buf.length ? { leftover_in_b64: buf.toString('base64') } : {}),
      // a client that rejects our cert usually just hangs up (TLS 1.3), so say the handshake never finished
      ...(conn.error || (conn.tls && !conn.secured) ? { error: conn.error || 'tls handshake not completed' } : {}),
    }))
  })
  async function pump() {
    // once a reply ended the connection, pipelined requests behind it are never served: their bytes
    // stay in buf and are logged as leftover, not as requests that got an answer
    while (!busy && !conn.closed && !conn.ended) {
      let req
      try { req = parseRequest(buf) } catch { sock.destroy(); return }
      if (!req) return
      const raw = buf.subarray(0, req.size)
      buf = buf.subarray(req.size)
      busy = true
      await handle(conn, req, raw, ++seq, state, record)
      busy = false
    }
  }
}

async function handle(conn, req, raw, seq, state, record) {
  const out = [], ts = iso()
  const io = {
    status: null,
    get closed() { return conn.closed },
    send(b) {
      if (conn.closed || conn.ended) return
      const buf = Buffer.from(b)
      out.push(buf); conn.bytesOut += buf.length; conn.sock.write(buf)
    },
    sleep: (ms) => new Promise((resolve) => {
      if (conn.closed) return resolve(false)
      const wake = () => { clearTimeout(t); conn.wakers.delete(wake); resolve(false) }
      const t = setTimeout(() => { conn.wakers.delete(wake); resolve(!conn.closed) }, ms)
      conn.wakers.add(wake)
    }),
    end() { conn.ended = true; conn.sock.end() }, // FIN (after close_notify on TLS)
    reset() { conn.ended = true; conn.raw.resetAndDestroy() }, // RST on the TCP socket, under any TLS
  }
  let meta
  try { meta = await dispatch(req, io, state) } catch (e) { meta = { error: String(e?.stack || e), complete: false }; conn.raw.destroy() }
  const { complete, ...rest } = meta
  record({
    type: 'request', ts, conn_id: conn.id, seq, ...rest, method: req.method, path: req.target, status: io.status,
    req_raw_b64: raw.toString('base64'), resp_raw_b64: Buffer.concat(out).toString('base64'), resp_writes: out.map((b) => b.length),
    ...(complete ? {} : { aborted: true }),
  })
}

const readLog = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

async function readAll(req) { const c = []; for await (const d of req) c.push(d); return Buffer.concat(c) }

function adminServer(state, logFile) {
  return http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    const route = `${req.method} ${req.url.split('?')[0]}`
    const body = parseJson(await readAll(req))
    if (route === 'GET /__mock/state') return send(200, { queue: state.queue, config: state.cfg, scenarios: Object.keys(SCENARIOS) })
    if (route === 'POST /__mock/config') {
      for (const [k, v] of Object.entries(body)) if (Object.hasOwn(state.cfg, k) && Number.isFinite(v) && v >= 0) state.cfg[k] = v
      return send(200, state.cfg)
    }
    if (route === 'GET /__mock/log') return send(200, logFile ? readLog(logFile) : state.log)
    if (route === 'POST /__mock/reset') {
      state.queue.length = 0; state.log.length = 0
      if (logFile) fs.writeFileSync(logFile, '')
      return send(200, { ok: true })
    }
    if (route === 'POST /__mock/script') {
      const steps = Array.isArray(body.steps) ? expandSteps(body.steps) : { bad: ['steps must be an array'] }
      if (steps.bad.length) return send(400, { error: `unknown scenario(s): ${steps.bad.join(', ')}` })
      state.queue.splice(0, Infinity, ...steps.out)
      return send(200, { queue: state.queue })
    }
    send(404, { error: `no admin route ${route}` })
  })
}

// delays: { stallMs, dripMs } — how long stall-after-first / slow-headers hold (30 s like a hung
// provider; tests shrink it) and the gap between slow-drip deltas. Also POST /__mock/config.
export async function startMockUpstream({ tls: tlsOpts = null, host = '127.0.0.1', port = 0, adminPort = 0, logDir = null, delays = {} } = {}) {
  const state = { queue: [], log: [], cfg: { stallMs: 30000, dripMs: 250, ...delays } }
  const logFile = logDir ? path.join(logDir, 'log.ndjson') : null
  if (logFile) { fs.mkdirSync(logDir, { recursive: true }); fs.writeFileSync(logFile, '') }
  // With a logDir the file is the only copy: a long-lived lab process serving real agents would
  // otherwise hold every request and response in memory.
  const record = (e) => { if (logFile) fs.appendFileSync(logFile, JSON.stringify(e) + '\n'); else state.log.push(e) }

  // TLS is layered by hand over the plain net socket, so a fault can still RST the TCP connection
  // underneath; ALPN offers http/1.1 only, so h2-capable clients fall back.
  const secureContext = tlsOpts && tls.createSecureContext({ key: tlsOpts.key, cert: tlsOpts.cert })
  const raws = new Set()
  let nextId = 0
  const server = net.createServer((raw) => {
    raws.add(raw); raw.on('close', () => raws.delete(raw)); raw.setNoDelay(true)
    const sock = secureContext ? new tls.TLSSocket(raw, { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] }) : raw
    serveConn({ id: ++nextId, raw, sock, tls: !!secureContext, bytesIn: 0, bytesOut: 0, closed: false, ended: false, wakers: new Set() }, state, record)
  })
  const admin = adminServer(state, logFile)
  server.listen(port, host); admin.listen(adminPort, '127.0.0.1')
  await Promise.all([once(server, 'listening'), once(admin, 'listening')])
  const actual = server.address().port
  const h = host.includes(':') ? `[${host}]` : host
  return {
    url: `${secureContext ? 'https' : 'http'}://${h}:${actual}`, port: actual,
    adminUrl: `http://127.0.0.1:${admin.address().port}`, state,
    async close() {
      for (const s of raws) s.destroy()
      admin.closeAllConnections()
      await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => admin.close(r))])
    },
  }
}
