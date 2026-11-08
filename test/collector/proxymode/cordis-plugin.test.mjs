// CM12 (spec 4.11 P9 `cordis-plugin`): the DeepSeek plugin template, rendered and imported against a stub undici found the way the plugin
// finds dsh's (from process.argv[1]). Per request, the switch file decides: present → a ProxyAgent to the door carrying X-Trocar-Upstream
// (dsh's own proxy for that origin, or 'none' when dsh would go direct); absent → the prior dispatcher. A root that cannot be added → never routes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { tmpDir } from '../../helpers/tmp.mjs'
import { renderTemplate } from '../../../src/collector/core/proxymode/hooks/render.mjs'
import { TEMPLATES, templateUrl } from '../../../src/collector/harness/templates/index.mjs'
import dsh from '../../../src/collector/harness/deepseek-dsh.mjs'

const STUB_UNDICI = `
const log = globalThis.__trocarUndici
class Dispatcher {}
class ProxyAgent { constructor(o) { this.o = o; log.agents.push(o) } dispatch(opts) { log.calls.push({ via: 'door', uri: this.o.uri, up: this.o.headers['X-Trocar-Upstream'], origin: opts.origin }); return true } close() { log.closed++; return Promise.resolve() } }
let g = { dispatch(opts) { log.calls.push({ via: 'prior', origin: opts.origin }); return true }, close() { return Promise.resolve() } }
module.exports = { Dispatcher, ProxyAgent, getGlobalDispatcher: () => g, setGlobalDispatcher: (d) => { g = d } }
`
const DOOR = 'http://127.0.0.1:18101'
const ROOT = tls.getCACertificates('default')[0] // a real certificate, so setDefaultCACertificates accepts it

async function load({ caFile = 'ok', env = {} } = {}) {
  const d = tmpDir()
  fs.mkdirSync(path.join(d, 'node_modules', 'undici'), { recursive: true })
  fs.writeFileSync(path.join(d, 'node_modules', 'undici', 'index.js'), STUB_UNDICI)
  fs.writeFileSync(path.join(d, 'entry.js'), '')
  const ca = path.join(d, 'root.pem')
  if (caFile === 'ok') fs.writeFileSync(ca, ROOT)
  if (caFile === 'not-pem') fs.writeFileSync(ca, 'no certificate here')
  const sw = path.join(d, 'state', 'switch', 'deepseek-dsh')
  const text = renderTemplate(fs.readFileSync(templateUrl('cordis-plugin'), 'utf8'), { CA_FILE: ca, SWITCH: sw, PROXY_ENV: dsh.proxy.env, NO_PROXY_ENV: ['NO_PROXY', 'no_proxy'] })
  const file = path.join(d, 'plugin.mjs')
  fs.writeFileSync(file, text)
  const log = (globalThis.__trocarUndici = { agents: [], calls: [], closed: 0 })
  const saved = { argv1: process.argv[1], env: { ...process.env }, roots: tls.getCACertificates('default') }
  for (const k of [...dsh.proxy.env, 'NO_PROXY', 'no_proxy']) delete process.env[k]
  Object.assign(process.env, env)
  process.argv[1] = path.join(d, 'entry.js')
  let mod
  try { mod = await import(pathToFileURL(file).href) } finally { process.argv[1] = saved.argv1 }
  const undici = createRequire(path.join(d, 'entry.js'))('undici')
  const restore = () => { for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k]; Object.assign(process.env, saved.env); tls.setDefaultCACertificates(saved.roots) }
  const req = (origin) => { undici.getGlobalDispatcher().dispatch({ origin, path: '/' }, {}); return log.calls.at(-1) }
  const on = (door = DOOR) => { fs.mkdirSync(path.dirname(sw), { recursive: true }); fs.writeFileSync(sw, door) }
  const off = () => fs.rmSync(sw, { force: true })
  return { mod, log, req, on, off, restore }
}

test('CM12 index: cordis-plugin is an install-phase template that adds the root and whose connections carry the upstream header; opencode-plugin is on-phase and adds no root', () => {
  const c = TEMPLATES['cordis-plugin'], o = TEMPLATES['opencode-plugin']
  assert.deepEqual([c.phase, c.sendsUpstreamHeader, c.addsRoot], ['install', true, true])
  assert.deepEqual([o.phase, !!o.sendsUpstreamHeader, !!o.addsRoot], ['on', false, false]) // P11 rule 4: only a hook that adds the root may be a cert carrier
  for (const id of Object.keys(TEMPLATES)) assert.ok(fs.existsSync(templateUrl(id)), id)
})

test('CM12 switch per request: present → door with the header; absent → prior; a changed door dials fresh', async () => {
  const p = await load()
  try {
    assert.equal(typeof p.mod.apply, 'function', 'a cordis plugin exports apply')
    assert.ok(tls.getCACertificates('default').length > 0)
    assert.deepEqual(p.req('https://api.deepseek.com'), { via: 'prior', origin: 'https://api.deepseek.com' }, 'no switch file: the prior dispatcher')
    p.on()
    assert.deepEqual(p.req('https://api.deepseek.com'), { via: 'door', uri: DOOR, up: 'none', origin: 'https://api.deepseek.com' })
    assert.equal(p.req('http://127.0.0.1:9000').via, 'prior', 'loopback never goes to the door')
    assert.equal(p.req('http://localhost:9000').via, 'prior')
    p.on('http://127.0.0.1:18102')
    assert.equal(p.req('https://api.deepseek.com').uri, 'http://127.0.0.1:18102', 'the next request reads the new door')
    assert.ok(p.log.closed >= 1, 'the old door agent is closed')
    p.off()
    assert.equal(p.req('https://api.deepseek.com').via, 'prior', 'switch removed: the very next request goes the prior way')
  } finally { p.restore() }
})

test('CM12 header: dsh\'s own proxy for the origin, or none when dsh would go direct', async () => {
  const CASES = [
    [{}, 'https://api.deepseek.com', 'none'],
    [{ HTTPS_PROXY: 'http://corp:3128' }, 'https://api.deepseek.com', 'http://corp:3128'],
    [{ https_proxy: 'http://low:1', HTTPS_PROXY: 'http://up:2' }, 'https://api.deepseek.com', 'http://up:2'],
    [{ HTTP_PROXY: 'http://plain:8080' }, 'https://api.deepseek.com', 'none'],
    [{ HTTP_PROXY: 'http://plain:8080' }, 'http://api.deepseek.com', 'http://plain:8080'],
    [{ ALL_PROXY: 'http://all:1' }, 'https://api.deepseek.com', 'http://all:1'],
    [{ HTTPS_PROXY: 'socks5://s:1080' }, 'https://api.deepseek.com', 'none'],
    [{ HTTPS_PROXY: 'http://corp:3128', NO_PROXY: 'deepseek.com' }, 'https://api.deepseek.com', 'none'],
    [{ HTTPS_PROXY: 'http://corp:3128', no_proxy: '.deepseek.com:443, x' }, 'https://api.deepseek.com', 'none'],
    [{ HTTPS_PROXY: 'http://corp:3128', NO_PROXY: '*' }, 'https://api.deepseek.com', 'none'],
    [{ HTTPS_PROXY: 'http://corp:3128', NO_PROXY: 'other.com' }, 'https://api.deepseek.com', 'http://corp:3128'],
  ]
  for (const [env, origin, up] of CASES) {
    const p = await load({ env })
    try { p.on(); assert.equal(p.req(origin).up, up, JSON.stringify({ env, origin })) } finally { p.restore() }
  }
})

test('CM12 root-add failure → never routes, even with the switch file present', async () => {
  for (const [label, opts] of [['root file missing', { caFile: 'missing' }], ['root file not PEM', { caFile: 'not-pem' }], ['--use-openssl-ca', { env: { NODE_OPTIONS: '--use-openssl-ca' } }]]) {
    const p = await load(opts)
    try {
      p.on()
      assert.equal(p.req('https://api.deepseek.com').via, 'prior', label)
      assert.equal(p.log.agents.length, 0, `${label}: no door agent is ever made`)
    } finally { p.restore() }
  }
})

// CM12 · P9: node:http and node:https (dsh's telemetry exporter, any node:https client) go to the door like undici, per connection. In a child
// process (the plugin patches the http / https Agent prototypes of the process that loads it), all on this machine: a stand-in door that records
// each CONNECT and tunnels it to the local origin, an http and an https origin (its certificate under the root the plugin adds), and a host name
// the requests resolve to 127.0.0.1 themselves, so going Node's own way reaches the same origins directly
const CHILD = `
  import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; import fs from 'node:fs'
  const [sw, plugin, caFile, src, mode] = process.argv.slice(1)
  const { createCa, loadCa } = await import(src + '/collector/core/tls/ca.mjs'); const { createLeafIssuer } = await import(src + '/collector/core/tls/leaf.mjs')
  const ca = createCa({ commonName: 'cordis test CA' }), issuer = createLeafIssuer(loadCa(ca))
  fs.writeFileSync(caFile, ca.certPem)
  const seen = [], got = [], conns = { http: 0, https: 0 }
  const door = net.createServer((c) => { let b = Buffer.alloc(0); const on = (x) => { b = Buffer.concat([b, x]); const e = b.indexOf('\\r\\n\\r\\n'); if (e < 0) return
    c.removeListener('data', on); const head = b.subarray(0, e).toString(); seen.push(head)
    if (mode === 'silent') { c.end(); return } if (mode === 'quiet') return
    const port = Number(/^CONNECT \\S+:(\\d+) /.exec(head)[1]); const up = net.connect(port, '127.0.0.1', () => { c.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n'); const rest = b.subarray(e + 4); if (rest.length) up.write(rest); c.pipe(up); up.pipe(c) }); up.on('error', () => c.destroy()) }
    c.on('data', on); c.on('error', () => {}) })
  const note = (kind) => (q, r) => { got.push([kind, q.method, q.url, q.headers.host, !!q.headers['proxy-authorization']].join(' ')); r.end('ok') }
  const oh = http.createServer(note('http')), os = https.createServer({ SNICallback: (n, cb) => cb(null, issuer.secureContextFor(n)) }, note('https'))
  oh.on('connection', () => conns.http++); os.on('secureConnection', () => conns.https++)
  for (const s of [door, oh, os]) await new Promise((r) => s.listen(0, '127.0.0.1', r))
  const doorUrl = 'http://dsh%3Aplugin:tok@127.0.0.1:' + door.address().port
  if (mode !== 'off') fs.writeFileSync(sw, doorUrl + '\\n')
  await import(plugin)
  const H = 'trocar-test.invalid', lookup = (h, o, cb) => (o && o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4))
  const url = (s, p) => (s === 'https' ? 'https' : 'http') + '://' + H + ':' + (s === 'https' ? os : oh).address().port + p
  const go = (mod, u, opts = {}) => new Promise((r) => { const t = setTimeout(() => r('hung'), 4000); const q = mod.get(u, { lookup, timeout: 1500, ...opts }, (res) => { res.resume(); res.on('end', () => { clearTimeout(t); r(res.statusCode) }) }); q.on('error', (e) => { clearTimeout(t); r('error') }); q.on('timeout', () => q.destroy(new Error('timeout'))) })
  const out = []
  if (mode === 'on' || mode === 'off') out.push(await go(https, url('https', '/a')), await go(https, url('https', '/b'), { agent: new https.Agent({ keepAlive: true }) }), await go(http, url('http', '/c'), { agent: false }))
  if (mode === 'silent' || mode === 'quiet') out.push(await go(https, url('https', '/a')))
  if (mode === 'flip') { const a = new http.Agent({ keepAlive: true }); out.push(await go(http, url('http', '/1'), { agent: a })); fs.rmSync(sw); out.push(await go(http, url('http', '/2'), { agent: a })); fs.writeFileSync(sw, doorUrl + '\\n'); out.push(await go(http, url('http', '/3'), { agent: a })); a.destroy() }
  if (mode === 'proxy') { // an agent with a proxy configuration (proxyEnv): the user's proxy is the stand-in http origin, which answers the absolute form itself
    const px = 'http://u:p@127.0.0.1:' + oh.address().port, env = { http_proxy: px, HTTP_PROXY: 'http://127.0.0.1:9', https_proxy: px }
    out.push(await go(http, url('http', '/p'), { agent: new http.Agent({ proxyEnv: env }) }), await go(https, url('https', '/q'), { agent: new https.Agent({ proxyEnv: env }) }), await go(https, url('https', '/r'), { agent: new https.Agent() }))
  }
  for (const s of [door, oh, os]) { s.closeAllConnections && s.closeAllConnections(); s.close() }
  console.log(JSON.stringify({ seen, got, conns, out }))`
async function nodeRun(mode) {
  const { execFileSync } = await import('node:child_process')
  const d = tmpDir()
  const ca = path.join(d, 'root.pem'), sw = path.join(d, 'switch'), plugin = path.join(d, 'plugin.mjs')
  fs.writeFileSync(plugin, renderTemplate(fs.readFileSync(templateUrl('cordis-plugin'), 'utf8'), { CA_FILE: ca, SWITCH: sw, PROXY_ENV: dsh.proxy.env, NO_PROXY_ENV: ['NO_PROXY', 'no_proxy'] }))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy|node_options)$/i.test(k))) // the user's proxy is not this test's
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', CHILD, sw, plugin, ca, pathToFileURL(path.resolve('src')).href, mode], { encoding: 'utf8', timeout: 30000, env }))
}
const CONNECT = /^CONNECT trocar-test\.invalid:\d+ HTTP\/1\.1\r\n/

test('CM12 node:http(s): with the switch present, the default https agent, an agent of its own and plain http with agent:false go through the door, the origin getting what it gets without trocar; absent, Node\'s own way, nothing to the door', async () => {
  const on = await nodeRun('on'), off = await nodeRun('off')
  assert.deepEqual(on.out, [200, 200, 200], JSON.stringify(on))
  assert.equal(on.seen.length, 3, 'one CONNECT per connection')
  for (const h of on.seen) {
    assert.match(h, CONNECT, h)
    assert.match(h, /\r\nX-Trocar-Upstream: none(\r\n|$)/, 'an agent with no proxy configuration: none')
    assert.match(h, new RegExp(`\\r\\nProxy-Authorization: Basic ${Buffer.from('dsh:plugin:tok').toString('base64')}`), 'the door\'s credentials')
  }
  assert.deepEqual(off.out, [200, 200, 200], JSON.stringify(off))
  assert.deepEqual(off.seen, [], 'nothing to the door')
  const port = (g) => g.map((x) => x.replace(/:\d+ /, ':<port> ')) // each run has its own origin ports
  assert.deepEqual(port(on.got), port(off.got), 'the origins got the same requests either way')
  assert.deepEqual(on.conns, off.conns)
})

test('CM12 node:http(s): a door that closes, or says nothing, before it answers CONNECT ends the request with an error — never a request left waiting', async () => {
  for (const mode of ['silent', 'quiet']) {
    const r = await nodeRun(mode)
    assert.equal(r.seen.length, 1, mode)
    assert.deepEqual(r.out, ['error'], `${mode}: ${JSON.stringify(r.out)}`)
  }
})

test('CM12 node:http(s): a kept-alive connection follows the switch — off takes the next request off the door, on puts it back', async () => {
  const r = await nodeRun('flip')
  assert.deepEqual(r.out, [200, 200, 200], JSON.stringify(r))
  assert.equal(r.seen.length, 2, `requests 1 and 3 through the door, 2 directly: ${JSON.stringify(r.seen)}`)
  assert.equal(r.conns.http, 3, 'a new connection each time the switch changed')
})

test('CM12 node:http(s): an agent with a proxy configuration — https names that proxy in X-Trocar-Upstream (the lower-case name first); plain http tunnels to the proxy itself, which gets the request as Node wrote it for it', async () => {
  const r = await nodeRun('proxy')
  assert.deepEqual(r.out, [200, 200, 200], JSON.stringify(r))
  const [p, q, plain] = r.seen
  assert.match(p, /^CONNECT 127\.0\.0\.1:\d+ HTTP\/1\.1\r\n/, 'plain http: to the proxy')
  assert.match(p, /\r\nX-Trocar-Upstream: none(\r\n|$)/, 'the door dials no further')
  assert.ok(r.got.some((g) => /^http GET http:\/\/trocar-test\.invalid:\d+\/p .* true$/.test(g)), `the proxy got the absolute form with its credentials: ${JSON.stringify(r.got)}`)
  assert.match(q, CONNECT)
  assert.match(q, /\r\nX-Trocar-Upstream: http:\/\/u:p@127\.0\.0\.1:\d+(\r\n|$)/, 'https: the proxy Node would tunnel through')
  assert.match(plain, /\r\nX-Trocar-Upstream: none(\r\n|$)/, 'an agent without a proxy configuration: none')
})
