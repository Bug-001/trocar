// fake-core.mjs — a stand-in for the proxy core's controller as mihomo v1.19.32 answers it (RFC 4.7 §2 · §3.4, 4.8 §4.1; plan Task 6), on a loopback socket, so the Verge adapter is exercised end to end with a
// real HTTP round trip and no mihomo. What it says is held to the real core by W57 — and only what is listed here is:
//   test/netenv/mihomo-adapter-contract.test.mjs (ASIGHT_MIHOMO_BIN): createController + the adapter on a real core: GET /rules in the core's own rendering of every rule (fixtures/real-rules.mjs, the table this
//   file answers from), /configs (mode, mixed-port, find-process-mode, tun), /proxies/<name> and the other 404s, the list of providers and each ruleCount, PUT /proxies/<select> (204; a push of the runtime
//   keeps the select, as `storeSelected`), PUT /providers/rules/<name>, PUT /configs?force=true (204; the five refusals of the table, in the core's words), the fixed messages (Unauthorized, Body invalid,
//   Resource not found, Selector update error: proxy not exist);  test/netenv/mihomo-contract.test.mjs: GET /providers/rules/<name> is 405, /group/<name>/delay and the fallback group's pick (asight-in while the
//   engine answers, asight-re when it does not).
// NOT measured on a real core, so take them as this file's own: a provider whose route file is missing counts its inline payload (what the service copy would do, 4.7 OPEN 5); a PUT /configs body that is neither
// {payload} nor {path} is 400 here and 204 on the real core (the client refuses such a body before any I/O, so no caller sends one); a rule type outside TYPE below is shown under the name it was written with.
// Answers: GET /version · /configs (plus fields a user has that must never leave the adapter) · /proxies/<name> (404 when there is none) · /providers/rules (the LIST) · GET /providers/rules/<name> is 405 (v1.19.32 has
// no read of one provider) · /rules (every rule, index and type, a logic rule's payload as the core renders it) · /group/<name>/delay?url=&timeout= (a health check of a fallback group) · PUT /proxies/<select> {name}
// (204; 400 for a member the group does not have) · PUT /providers/rules/<name> (204: re-reads the route file) · PUT /configs?force=true {payload | path} (204: loads the runtime, selects start at the group's first
// member unless `storeSelected` remembers one).
// The runtime it loads is the YAML text Verge writes (read with fixtures/rules/mini-yaml.mjs). A provider's ruleCount is the number of lines of its route file (0 for an empty one). `home` is the data directory the
// route files are under. Every request is logged in `requests`; `engineAlive` is whether asight-in-* answers the health check; `failOn(method, pattern, status)` makes matching requests fail (a controller that refuses
// one write); `rejectPayload` is the message the core refuses a pushed config with (fixtures/real-rules.mjs has what a real one says).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { parseYaml } from './rules/mini-yaml.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

const KIND = { select: 'Selector', fallback: 'Fallback', 'url-test': 'URLTest' }

export async function startFakeCore(t, { home, runtimeText = null, listen = 'tcp', secret = null, version = 'v1.19.32', mode = 'rule', findProcessMode = 'strict', tun = false, mixedPort = 7897, storeSelected = true, userProviders = {}, extraConfig = {} } = {}) {
  const core = { requests: [], engineAlive: true, reAlive: true, mode, findProcessMode, tun, mixedPort, version, storeSelected, lastPayload: null, rejectPayload: null, failures: [], groups: new Map(), providers: new Map(), remembered: new Map() }
  const providerCount = (name, def) => {
    const file = def && def.path ? path.join(home, def.path) : null
    if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length
    return Array.isArray(def && def.payload) ? def.payload.length : 0
  }
  function load(text) {
    const cfg = parseYaml(text)
    core.groups = new Map()
    for (const g of cfg['proxy-groups'] || []) {
      const all = g.proxies || []
      const kept = core.remembered.get(g.name)
      core.groups.set(g.name, { name: g.name, type: KIND[g.type] || g.type, now: g.type === 'select' && core.storeSelected && kept && all.includes(kept) ? kept : all[0] ?? null, all, kind: g.type })
    }
    core.providers = new Map(Object.entries(userProviders).map(([n, c]) => [n, { name: n, ruleCount: c, vehicleType: 'HTTP', behavior: 'domain', type: 'Rule' }]))
    for (const [n, def] of Object.entries(cfg['rule-providers'] || {})) {
      if (!userProviders[n] && !n.startsWith('asight-')) core.providers.set(n, { name: n, ruleCount: 0, vehicleType: 'HTTP', behavior: def.behavior, type: 'Rule' })
      if (n.startsWith('asight-')) core.providers.set(n, { name: n, ruleCount: providerCount(n, def), vehicleType: 'File', behavior: def.behavior, type: 'Rule', def })
    }
    core.healthCheck()
  }
  core.healthCheck = (only) => {
    for (const g of core.groups.values()) {
      if (g.kind !== 'fallback' || (only && g.name !== only)) continue
      const alive = (n) => (n.startsWith('asight-in-') ? core.engineAlive : n.startsWith('asight-re-') ? core.reAlive : true)
      g.now = g.all.find(alive) ?? g.all[0]
    }
  }
  core.failOn = (method, pattern, status, message = 'forced failure') => core.failures.push({ method, pattern, status, message })
  core.writes = () => core.requests.filter((r) => r.method !== 'GET')
  core.reloadProvider = (name) => { const p = core.providers.get(name); if (p && p.def) p.ruleCount = providerCount(name, p.def) }
  core.load = load
  core.select = (name, member) => { const g = core.groups.get(name); g.now = member; core.remembered.set(name, member) }
  if (runtimeText) load(runtimeText)

  const answer = (method, url, body) => {
    const u = new URL(url, 'http://x')
    const p = u.pathname
    const fault = core.failures.find((f) => f.method === method && f.pattern.test(p))
    if (fault) return [fault.status, { message: fault.message }]
    if (method === 'GET' && p === '/version') return [200, { meta: true, version: core.version }]
    if (method === 'GET' && p === '/configs') return [200, { port: 0, 'mixed-port': core.mixedPort, 'allow-lan': false, mode: core.mode, 'find-process-mode': core.findProcessMode, tun: { enable: core.tun }, 'log-level': 'info', ...extraConfig }]
    if (method === 'GET' && p === '/providers/rules') return [200, { providers: Object.fromEntries([...core.providers].map(([n, v]) => [n, { name: n, ruleCount: v.ruleCount, vehicleType: v.vehicleType, behavior: v.behavior, type: v.type, updatedAt: '2026-10-07T00:00:00Z' }])) }]
    if (p.startsWith('/providers/rules/') && method === 'GET') return [405, '']
    let m = /^\/proxies\/(.+)$/.exec(p)
    if (m && method === 'GET') { const g = core.groups.get(decodeURIComponent(m[1])); return g ? [200, { name: g.name, type: g.type, now: g.now, all: g.all }] : [404, { message: 'Resource not found' }] }
    if (m && method === 'PUT') {
      const g = core.groups.get(decodeURIComponent(m[1]))
      if (!g) return [404, { message: 'Resource not found' }]
      if (g.kind !== 'select' || !g.all.includes(body && body.name)) return [400, { message: 'Selector update error: proxy not exist' }]
      g.now = body.name
      core.remembered.set(g.name, body.name)
      return [204]
    }
    m = /^\/providers\/rules\/(.+)$/.exec(p)
    if (m && method === 'PUT') { const n = decodeURIComponent(m[1]); if (!core.providers.has(n)) return [404, { message: 'Resource not found' }]; core.reloadProvider(n); return [204] }
    m = /^\/group\/(.+)\/delay$/.exec(p)
    if (m && method === 'GET') {
      const g = core.groups.get(decodeURIComponent(m[1]))
      if (!g) return [404, { message: 'Resource not found' }]
      core.healthCheck(g.name)
      return [200, Object.fromEntries(g.all.filter((n) => (n.startsWith('asight-in-') ? core.engineAlive : true)).map((n) => [n, 3]))]
    }
    if (method === 'PUT' && p === '/configs' && u.search === '?force=true') {
      if (core.rejectPayload) return [400, { message: core.rejectPayload }]
      if (body && typeof body.payload === 'string') { core.lastPayload = body.payload; load(body.payload); return [204] }
      if (body && typeof body.path === 'string') { load(fs.readFileSync(body.path, 'utf8')); return [204] }
      return [400, { message: 'Body invalid' }]
    }
    return [404, { message: 'Resource not found' }]
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => { raw += d })
    req.on('end', () => {
      let body = null
      try { body = raw ? JSON.parse(raw) : null } catch { /* a body that is not JSON */ }
      core.requests.push({ method: req.method, path: req.url, body: body && typeof body.payload === 'string' ? { payloadBytes: Buffer.byteLength(body.payload) } : body, auth: req.headers.authorization ?? null })
      if (secret && req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"message":"Unauthorized"}') }
      const [status, out] = answer(req.method, req.url, body)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(out === undefined || out === '' ? '' : JSON.stringify(out))
    })
  })
  const sock = listen === 'unix' ? path.join(tmpDir('asight-core-'), 'c.sock') : null
  await new Promise((r) => (sock ? server.listen(sock, r) : server.listen(0, '127.0.0.1', r)))
  core.endpoint = sock ? `unix:${sock}` : `tcp:127.0.0.1:${server.address().port}`
  core.stop = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) })
  t.after(() => core.stop())
  return core
}
