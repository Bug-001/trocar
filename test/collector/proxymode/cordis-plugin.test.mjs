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
