#!/usr/bin/env node
// Fake mihomo (RFC 4.8 §3 · §4 · §5.3): a Node script with mihomo's command line, so the forwarder's real child_process path and its real own controller client run against it with no Windows and no real kernel.
//   ASIGHT_FAKE_MIHOMO=1 node fake-mihomo.mjs -d <home> -f <config.json>
// It reads the config (JSON, which is YAML in flow style: what buildForwarderConfig writes), listens on the controller's port and on every listener's port, and answers what the forwarder asks (and nothing else):
//   GET /version                              {"version": …}
//   GET /proxies/asight-fb-<f>                the form's fallback group as the config has it: `now` is asight-in-<f>, or asight-re-<g> while the engine is "down"; 404 {"message":"Resource not found"} when the group is not in the config
//   GET /group/asight-fb-<f>/delay?url=…      200, and a record that the probe was refreshed
//   PUT /configs?force=true  {payload}        the new config replaces the old one at once (listeners opened and closed to match), 204; a refusal when the test says so
// A wrong or missing Bearer secret is 401 {"message":"Unauthorized"}, as the real core says it. Every request is appended to the log file as one JSON line `{method, path, body?}`.
// Test knobs, all in the JSON of FAKE_MIHOMO (environment): `log` (file), `exitAfterMs` + `exitCode` (die by itself), `readyDelayMs` (listen late), `engineDown` (fallback groups select asight-re), `refuseReload` (PUT answers 400),
// `noController` (never listens on the controller port: a kernel that started and cannot be talked to), `crash` (exit at once with `exitCode`).
// node --test runs every file under test/: unless the driver sets ASIGHT_FAKE_MIHOMO=1 this exits at once.
// a stand-in the test starts and kills must not outlive a runner that was killed: the watch of test/helpers/exit-with-parent.mjs ends this process when its parent is gone
import '../../../../helpers/exit-with-parent.mjs'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'

if (process.env.ASIGHT_FAKE_MIHOMO !== '1') process.exit(0)

const argv = process.argv.slice(2)
const flag = (name) => argv[argv.indexOf(name) + 1]
const configFile = flag('-f')
const opts = JSON.parse(process.env.FAKE_MIHOMO || '{}')
const log = (rec) => { if (opts.log) fs.appendFileSync(opts.log, `${JSON.stringify(rec)}\n`) }

if (opts.crash) process.exit(opts.exitCode ?? 1)

let config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
const listeners = new Map() // port → net.Server (a listener's port is held, so a second kernel on it would fail the way a real one does)
const sockets = new Set()
const open = (port) => {
  if (listeners.has(port)) return
  const s = net.createServer((c) => { sockets.add(c); c.on('close', () => sockets.delete(c)); c.on('error', () => {}); c.end() })
  s.on('error', () => {}) // a port somebody else holds: mihomo logs it and carries on without that listener
  s.listen(port, '127.0.0.1')
  listeners.set(port, s)
}
const syncListeners = () => {
  const want = new Set((config.listeners || []).map((l) => l.port))
  for (const [p, s] of listeners) if (!want.has(p)) { s.close(); listeners.delete(p) }
  for (const p of want) open(p)
}
const groupOf = (name) => (config['proxy-groups'] || []).find((g) => g.name === name)

const controllerPort = () => Number(String(config['external-controller']).split(':').pop())
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)) }

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    log({ method: req.method, path: req.url, ...(body ? { body: body.length > 400 ? `${body.slice(0, 80)}…(${body.length} bytes)` : body } : {}) })
    if (req.headers.authorization !== `Bearer ${config.secret}`) return json(res, 401, { message: 'Unauthorized' })
    const url = new URL(req.url, 'http://x')
    if (req.method === 'GET' && url.pathname === '/version') return json(res, 200, { meta: true, version: 'fake-mihomo v1.19.32' })
    let m
    if (req.method === 'GET' && (m = /^\/proxies\/(asight-fb-[^/]+)$/.exec(url.pathname))) {
      const g = groupOf(m[1])
      if (!g) return json(res, 404, { message: 'Resource not found' })
      return json(res, 200, { name: g.name, type: 'Fallback', now: opts.engineDown ? g.proxies[1] : g.proxies[0], all: g.proxies })
    }
    if (req.method === 'GET' && (m = /^\/group\/(asight-fb-[^/]+)\/delay$/.exec(url.pathname))) {
      const g = groupOf(m[1])
      if (!g) return json(res, 404, { message: 'Resource not found' })
      return json(res, 200, Object.fromEntries(g.proxies.map((p) => [p, 3])))
    }
    if (req.method === 'PUT' && req.url === '/configs?force=true') {
      if (opts.refuseReload) return json(res, 400, { message: 'refused' })
      try { config = JSON.parse(JSON.parse(body).payload) } catch { return json(res, 400, { message: 'bad config' }) }
      syncListeners()
      return json(res, 204)
    }
    return json(res, 404, { message: 'Resource not found' })
  })
})

const up = () => {
  syncListeners()
  if (!opts.noController) server.listen(controllerPort(), '127.0.0.1')
}
if (opts.readyDelayMs) setTimeout(up, opts.readyDelayMs); else up()
if (opts.exitAfterMs != null) setTimeout(() => process.exit(opts.exitCode ?? 0), opts.exitAfterMs)
process.on('SIGTERM', () => process.exit(0))
