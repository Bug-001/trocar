// CM36 (spec 4.11 P9 `pi-extension`): the pi extension template, rendered and imported in this process (each import from its own copy, so
// the ESM cache never hands back an earlier one). At import it adds the trocar root; only with the root added and the switch file present
// does it route: every proxy name = the door, TROCAR_PRIOR_PROXY = the prior proxy or 'none', the bypass list = loopback ∪ its own value (P6).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { pathToFileURL } from 'node:url'
import { tmpDir } from '../../helpers/tmp.mjs'
import { renderTemplate } from '../../../src/collector/core/proxymode/hooks/render.mjs'
import { TEMPLATES, templateUrl } from '../../../src/collector/harness/templates/index.mjs'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'

// adding a root needs tls.setDefaultCACertificates (Node >= 22.19) and tls.getCACertificates; an older Node skips the import tests
const NODE_TLS_ROOTS = typeof tls.setDefaultCACertificates === 'function' && typeof tls.getCACertificates === 'function'
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
const NO_PROXY_ENV = ['NO_PROXY', 'no_proxy']
const WATCHED = [...PROXY_ENV, ...NO_PROXY_ENV, 'TROCAR_PRIOR_PROXY', 'NODE_OPTIONS']
const DOOR = 'http://127.0.0.1:18107'
const U = 'http://proxy.corp.example:3128'
const LOOPBACK = ['localhost', '127.0.0.1', '::1'] // P6
const CA = createCa({ commonName: 'trocar collector CA' })
const body = (pem) => pem.replace(/-----[^-]+-----|\s/g, '')
const rootCount = () => tls.getCACertificates('default').filter((p) => body(p) === body(CA.certPem)).length
const snap = () => Object.fromEntries(WATCHED.map((k) => [k, process.env[k]]))

// Each world: a clean env (+ `env`), the switch file present when `door` is given; restore() puts env and default roots back.
async function world({ env = {}, door = null } = {}) {
  const saved = { env: { ...process.env }, roots: tls.getCACertificates('default') }
  const restore = () => {
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k]
    Object.assign(process.env, saved.env)
    tls.setDefaultCACertificates(saved.roots)
  }
  for (const k of WATCHED) delete process.env[k]
  Object.assign(process.env, env)
  const d = tmpDir()
  const sw = path.join(d, 'state', 'switch', 'pi')
  if (door) { fs.mkdirSync(path.dirname(sw), { recursive: true }); fs.writeFileSync(sw, `${door}\n`) }
  // importOne({ caFile }) renders a fresh copy and imports it; caFile: 'ok' | 'missing' | 'not-pem'
  const importOne = async ({ caFile = 'ok' } = {}) => {
    const c = tmpDir()
    const ca = path.join(c, 'root.pem')
    if (caFile === 'ok') fs.writeFileSync(ca, CA.certPem)
    if (caFile === 'not-pem') fs.writeFileSync(ca, 'no certificate here')
    const text = renderTemplate(fs.readFileSync(templateUrl('pi-extension'), 'utf8'), { CA_FILE: ca, SWITCH: sw, PROXY_ENV, PROXY_NAMES: PROXY_ENV, NO_PROXY_ENV })
    const file = path.join(c, 'trocar-pi-extension.js')
    fs.writeFileSync(file, text)
    return import(pathToFileURL(file).href)
  }
  return { importOne, restore }
}

// P6: loopback ∪ the user's list (both spellings), case-insensitive dedupe, first spelling and order kept
function merged(env) {
  const seen = new Set(), out = []
  for (const h of [...LOOPBACK, ...NO_PROXY_ENV.flatMap((k) => String(env[k] || '').split(','))].map((x) => x.trim()).filter(Boolean)) {
    if (!seen.has(h.toLowerCase())) { seen.add(h.toLowerCase()); out.push(h) }
  }
  return out.join(',')
}

test('CM36 (a) pi-extension is an install-phase template that adds the root and builds no agent carrying the upstream header', () => {
  const r = TEMPLATES['pi-extension']
  assert.equal(r.phase, 'install')
  assert.equal(r.addsRoot, true)
  assert.notEqual(r.sendsUpstreamHeader, true)
  assert.ok(fs.existsSync(templateUrl('pi-extension')))
})

test('CM36 (b) switch absent: the root is added once and the proxy, bypass and prior names are untouched', { skip: !NODE_TLS_ROOTS }, async () => {
  for (const env of [{}, { HTTPS_PROXY: U, NO_PROXY: 'corp.example' }, { http_proxy: U, no_proxy: 'a.example', TROCAR_PRIOR_PROXY: U }]) {
    const w = await world({ env })
    try {
      const before = snap()
      await w.importOne()
      assert.equal(rootCount(), 1, JSON.stringify(env))
      assert.deepEqual(snap(), before, JSON.stringify(env))
    } finally { w.restore() }
  }
})

test('CM36 (c) switch present: every proxy name is the door, the prior proxy is recorded, the bypass list is loopback ∪ the user list', { skip: !NODE_TLS_ROOTS }, async () => {
  const priors = [[{}, 'none'], [{ HTTPS_PROXY: U }, U], [{ http_proxy: U }, U], [{ HTTPS_PROXY: DOOR }, 'none']]
  const bypass = [{}, { NO_PROXY: 'corp.example,LOCALHOST' }, { no_proxy: 'a.example, 127.0.0.1', NO_PROXY: 'A.example' }]
  for (const [penv, prior] of priors) {
    for (const benv of bypass) {
      const env = { ...penv, ...benv }, label = JSON.stringify(env)
      const w = await world({ env, door: DOOR })
      try {
        await w.importOne()
        for (const k of PROXY_ENV) assert.equal(process.env[k], DOOR, `${label} ${k}`)
        assert.equal(process.env.TROCAR_PRIOR_PROXY, prior, label)
        for (const k of NO_PROXY_ENV) assert.equal(process.env[k], merged(env), `${label} ${k}`)
      } finally { w.restore() }
    }
  }
})

test('CM36 (d) a root that cannot be added: the environment stays as it was even with the switch present, and nothing throws', { skip: !NODE_TLS_ROOTS }, async () => {
  for (const [label, caFile, env] of [['CA file missing', 'missing', {}], ['not PEM', 'not-pem', {}], ['--use-openssl-ca', 'ok', { NODE_OPTIONS: '--use-openssl-ca' }]]) {
    const w = await world({ env: { ...env, HTTPS_PROXY: U, NO_PROXY: 'corp.example' }, door: DOOR })
    try {
      const before = snap()
      await w.importOne({ caFile })
      assert.deepEqual(snap(), before, label)
      assert.equal(rootCount(), 0, label)
    } finally { w.restore() }
  }
})

test('CM36 (e) two copies imported: the prior proxy is kept, no bypass entry is doubled, the root is present once', { skip: !NODE_TLS_ROOTS }, async () => {
  const w = await world({ env: { HTTPS_PROXY: U, NO_PROXY: 'corp.example' }, door: DOOR })
  try {
    await w.importOne()
    await w.importOne()
    assert.equal(process.env.TROCAR_PRIOR_PROXY, U)
    for (const k of NO_PROXY_ENV) {
      const hosts = process.env[k].split(',').map((h) => h.toLowerCase())
      assert.equal(new Set(hosts).size, hosts.length, k)
    }
    assert.equal(rootCount(), 1)
  } finally { w.restore() }
})

test('CM36 (f) the factory touches nothing of its host: called with an object that throws on any access, it returns without throwing', { skip: !NODE_TLS_ROOTS }, async () => {
  const w = await world()
  try {
    const mod = await w.importOne()
    const hostile = new Proxy({}, { get() { throw new Error('host API touched') }, has() { throw new Error('host API touched') } })
    await mod.default(hostile)
  } finally { w.restore() }
})
