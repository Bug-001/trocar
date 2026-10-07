// fake-core.mjs — a stand-in for the proxy core's controller as mihomo v1.19.32 answers it (RFC 4.7 §2 · §3.4, 4.8 §4.1; plan Task 6), on a loopback socket, so the Verge adapter is exercised end to end with a
// real HTTP round trip and no mihomo. Everything it does is something the real binary does, and W57 (test/netenv/mihomo-contract.test.mjs) holds each of them to the real core:
//   GET /version · /configs (mode, mixed-port, find-process-mode, tun, plus fields a user has that must never leave the adapter) · /proxies/<name> (404 when there is none) ·
//   /providers/rules (the LIST, with every user provider and each ruleCount) · GET /providers/rules/<name> is 405 (v1.19.32 has no read of one provider) · /rules (every rule, index and type) ·
//   /group/<name>/delay?url=&timeout= (a health check of a fallback group) · PUT /proxies/<select> {name} (204; 400 for a member the group does not have) · PUT /providers/rules/<name> (204: re-reads
//   the route file) · PUT /configs?force=true {payload | path} (204: loads the runtime, selects start at the group's first member unless `storeSelected` remembers one).
// The runtime it loads is the YAML text Verge writes (read with fixtures/rules/mini-yaml.mjs). A provider's ruleCount is what the real core gives: the number of lines of its route file (0 for an empty
// one, the inline payload's one line when the file is not there). `home` is the data directory the route files are under. Every request is logged in `requests`; `engineAlive` is whether asight-in-* answers
// the health check; `failOn(method, pattern, status)` makes matching requests fail (a controller that refuses one write).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { parseYaml } from './rules/mini-yaml.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

const TYPE = { DOMAIN: 'Domain', 'DOMAIN-SUFFIX': 'DomainSuffix', 'DOMAIN-KEYWORD': 'DomainKeyword', 'PROCESS-NAME': 'ProcessName', 'PROCESS-PATH': 'ProcessPath', 'PROCESS-NAME-REGEX': 'ProcessNameRegex',
  'PROCESS-PATH-REGEX': 'ProcessPathRegex', 'RULE-SET': 'RuleSet', GEOIP: 'GEOIP', MATCH: 'Match', AND: 'AND', OR: 'OR', NOT: 'NOT', 'DST-PORT': 'DstPort', 'IP-CIDR': 'IPCIDR' }
const KIND = { select: 'Selector', fallback: 'Fallback', 'url-test': 'URLTest' }

// GET /rules shows a logic rule's payload as the core renders it, not as the config spells it (measured on v1.19.32, the Verge-bundled core, W57):
//   AND,((PROCESS-NAME,a.exe),(DOMAIN,x))  ->  ((ProcessName,a.exe) && (Domain,x))        OR  ->  the same with ||
//   NOT,((PROCESS-NAME,a.exe))             ->  (!(ProcessName,a.exe))
//   a logic rule inside a logic rule       ->  (AND,((..) && (..)))  /  (NOT,(!(..)))     a plain rule's payload is as written.
const splitTop = (s) => { const out = []; let depth = 0, at = 0; for (let i = 0; i < s.length; i++) { if (s[i] === '(') depth++; else if (s[i] === ')') depth--; else if (s[i] === ',' && depth === 0) { out.push(s.slice(at, i)); at = i + 1 } } out.push(s.slice(at)); return out }
function renderPayload(kind, payload) {
  if (!['AND', 'OR', 'NOT'].includes(kind)) return payload
  const subs = splitTop(payload.slice(1, -1)).map((x) => { const inner = x.slice(1, -1); const at = inner.indexOf(','); const k = inner.slice(0, at); return `(${TYPE[k] || k},${renderPayload(k, inner.slice(at + 1))})` })
  return kind === 'NOT' ? `(!${subs[0]})` : `(${subs.join(kind === 'AND' ? ' && ' : ' || ')})`
}

export async function startFakeCore(t, { home, runtimeText = null, listen = 'tcp', secret = null, version = 'v1.19.32', mode = 'rule', findProcessMode = 'strict', tun = false, mixedPort = 7897, storeSelected = true, userProviders = {}, extraConfig = {} } = {}) {
  const core = { requests: [], engineAlive: true, reAlive: true, mode, findProcessMode, tun, mixedPort, version, storeSelected, lastPayload: null, rejectPayload: null, failures: [], groups: new Map(), providers: new Map(), rules: [], remembered: new Map() }
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
    core.rules = (cfg.rules || []).map((r, index) => {
      const parts = String(r).split(',')
      const last = parts.length - 1
      return { index, type: TYPE[parts[0]] || parts[0], payload: renderPayload(parts[0], parts.slice(1, last).join(',')), proxy: parts[last], size: -1 }
    })
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
    if (method === 'GET' && p === '/rules') return [200, { rules: core.rules }]
    if (method === 'GET' && p === '/providers/rules') return [200, { providers: Object.fromEntries([...core.providers].map(([n, v]) => [n, { name: n, ruleCount: v.ruleCount, vehicleType: v.vehicleType, behavior: v.behavior, type: v.type, updatedAt: '2026-10-07T00:00:00Z' }])) }]
    if (p.startsWith('/providers/rules/') && method === 'GET') return [405, '']
    let m = /^\/proxies\/(.+)$/.exec(p)
    if (m && method === 'GET') { const g = core.groups.get(decodeURIComponent(m[1])); return g ? [200, { name: g.name, type: g.type, now: g.now, all: g.all }] : [404, { message: 'resource not found' }] }
    if (m && method === 'PUT') {
      const g = core.groups.get(decodeURIComponent(m[1]))
      if (!g) return [404, { message: 'resource not found' }]
      if (g.kind !== 'select' || !g.all.includes(body && body.name)) return [400, { message: `Selector update error: "${body && body.name}" not found` }]
      g.now = body.name
      core.remembered.set(g.name, body.name)
      return [204]
    }
    m = /^\/providers\/rules\/(.+)$/.exec(p)
    if (m && method === 'PUT') { const n = decodeURIComponent(m[1]); if (!core.providers.has(n)) return [404, { message: 'resource not found' }]; core.reloadProvider(n); return [204] }
    m = /^\/group\/(.+)\/delay$/.exec(p)
    if (m && method === 'GET') {
      const g = core.groups.get(decodeURIComponent(m[1]))
      if (!g) return [404, { message: 'resource not found' }]
      core.healthCheck(g.name)
      return [200, Object.fromEntries(g.all.filter((n) => (n.startsWith('asight-in-') ? core.engineAlive : true)).map((n) => [n, 3]))]
    }
    if (method === 'PUT' && p === '/configs' && u.search === '?force=true') {
      if (core.rejectPayload) return [400, { message: core.rejectPayload }]
      if (body && typeof body.payload === 'string') { core.lastPayload = body.payload; load(body.payload); return [204] }
      if (body && typeof body.path === 'string') { load(fs.readFileSync(body.path, 'utf8')); return [204] }
      return [400, { message: 'bad payload' }]
    }
    return [404, { message: 'not found' }]
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
