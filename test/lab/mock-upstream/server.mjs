// server.mjs — scripted mock LLM upstream for the collector test lab (see README.md next to this file).
// Agents and test clients talk to it instead of a real provider. It answers with request-derived
// content, can be steered into any status or stream fault, and logs the exact bytes of every request
// and response so a test can prove the collector in between is byte-transparent.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { once } from 'node:events'
import { parseRequest } from './http1.mjs'
import { writeResponse, jsonReply } from './transport.mjs'

const iso = () => new Date().toISOString()

// Matched on the path suffix so relay prefixes (/anthropic/v1/messages, …) route the same.
const ROUTES = [
  { re: /^\/api\/hello$/, methods: ['HEAD', 'GET'], kind: 'hello' },
  { re: /\/models$/, methods: ['GET'], kind: 'models' },
]

// One list both SDK families accept: Anthropic reads type/display_name, OpenAI reads object/owned_by.
const MODEL_IDS = ['mock-model', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'gpt-5', 'gpt-5-codex', 'deepseek-chat']
const MODELS = {
  object: 'list', has_more: false, first_id: MODEL_IDS[0], last_id: MODEL_IDS.at(-1),
  data: MODEL_IDS.map((id) => ({ type: 'model', object: 'model', id, display_name: id, created_at: '2025-01-01T00:00:00Z', created: 1735689600, owned_by: 'asight-mock' })),
}

async function dispatch(req, io) {
  const p = req.target.split('?')[0]
  const route = ROUTES.find((r) => r.re.test(p) && r.methods.includes(req.method))
  let res
  if (!route) res = jsonReply(404, { type: 'error', error: { type: 'not_found_error', message: `mock-upstream: no route for ${req.method} ${p}` } })
  else if (route.kind === 'models') res = jsonReply(200, MODELS)
  else res = { status: 200, headers: {}, pieces: [] }
  const close = /close/i.test(req.headers.connection || '')
  return { complete: await writeResponse(io, res, { head: req.method === 'HEAD', close }) }
}

// Requests on one connection are served strictly in order; bytes that arrive meanwhile wait in buf.
function serveConn(conn, record) {
  let buf = Buffer.alloc(0), busy = false, seq = 0
  const { sock } = conn
  sock.on('data', (d) => { conn.bytesIn += d.length; buf = Buffer.concat([buf, d]); pump() })
  sock.on('error', (e) => { conn.error = e.code || e.message })
  sock.on('close', () => {
    conn.closed = true
    for (const wake of conn.wakers) wake()
    // after any in-flight request entry, which is recorded once its sleeper wakes
    setImmediate(() => record({
      type: 'conn', ts: iso(), conn_id: conn.id, tls: conn.tls, requests: seq, bytes_in: conn.bytesIn, bytes_out: conn.bytesOut,
      ...(buf.length ? { leftover_in_b64: buf.toString('base64') } : {}), ...(conn.error ? { error: conn.error } : {}),
    }))
  })
  async function pump() {
    while (!busy && !conn.closed) {
      let req
      try { req = parseRequest(buf) } catch { sock.destroy(); return }
      if (!req) return
      const raw = buf.subarray(0, req.size)
      buf = buf.subarray(req.size)
      busy = true
      await handle(conn, req, raw, ++seq, record)
      busy = false
    }
  }
}

async function handle(conn, req, raw, seq, record) {
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
    end() { conn.ended = true; conn.sock.end() }, // FIN
    reset() { conn.ended = true; conn.raw.resetAndDestroy() }, // RST
  }
  let meta
  try { meta = await dispatch(req, io) } catch (e) { meta = { error: String(e?.stack || e), complete: false }; conn.raw.destroy() }
  const { complete, ...rest } = meta
  record({
    type: 'request', ts, conn_id: conn.id, seq, ...rest, method: req.method, path: req.target, status: io.status,
    req_raw_b64: raw.toString('base64'), resp_raw_b64: Buffer.concat(out).toString('base64'), resp_writes: out.map((b) => b.length),
    ...(complete ? {} : { aborted: true }),
  })
}

async function readAll(req) { const c = []; for await (const d of req) c.push(d); return Buffer.concat(c) }

function adminServer(state, logFile) {
  return http.createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    const route = `${req.method} ${req.url.split('?')[0]}`
    await readAll(req)
    if (route === 'GET /__mock/log') return send(200, state.log)
    if (route === 'POST /__mock/reset') {
      state.log.length = 0
      if (logFile) fs.writeFileSync(logFile, '')
      return send(200, { ok: true })
    }
    send(404, { error: `no admin route ${route}` })
  })
}

export async function startMockUpstream({ host = '127.0.0.1', port = 0, adminPort = 0, logDir = null } = {}) {
  const state = { log: [] }
  const logFile = logDir ? path.join(logDir, 'log.ndjson') : null
  if (logFile) { fs.mkdirSync(logDir, { recursive: true }); fs.writeFileSync(logFile, '') }
  const record = (e) => { state.log.push(e); if (logFile) fs.appendFileSync(logFile, JSON.stringify(e) + '\n') }

  const raws = new Set()
  let nextId = 0
  const server = net.createServer((raw) => {
    raws.add(raw); raw.on('close', () => raws.delete(raw)); raw.setNoDelay(true)
    serveConn({ id: ++nextId, raw, sock: raw, tls: false, bytesIn: 0, bytesOut: 0, closed: false, ended: false, wakers: new Set() }, record)
  })
  const admin = adminServer(state, logFile)
  server.listen(port, host); admin.listen(adminPort, '127.0.0.1')
  await Promise.all([once(server, 'listening'), once(admin, 'listening')])
  const actual = server.address().port
  const h = host.includes(':') ? `[${host}]` : host
  return {
    url: `http://${h}:${actual}`, port: actual,
    adminUrl: `http://127.0.0.1:${admin.address().port}`, state,
    async close() {
      for (const s of raws) s.destroy()
      admin.closeAllConnections()
      await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => admin.close(r))])
    },
  }
}
