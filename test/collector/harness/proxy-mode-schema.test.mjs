// test/collector/harness/proxy-mode-schema.test.mjs — proxyMode is data, validated at load (spec 4.11 §2.3, plan A.3). Starting from every real
// descriptor and CM27's eighth fixture, each rule's axis is mutated and the real loader must refuse, naming the harness and the rule. The eighth harness
// loads with zero code of its own (CM27, validation half; its flow half and the static guard are T25).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpDir } from '../../helpers/tmp.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { resolveLoc, holds, readSrc } from '../../../src/collector/core/proxymode/sources.mjs'

const FIXTURES = new URL('./fixtures/', import.meta.url)
const real = await loadHarnesses()
const [eighth] = await loadHarnesses(FIXTURES)
const subjects = [...real, eighth]

const firstRoute = (pm) => Object.keys(pm.routes)[0]
// rule → mutation of a deep copy of proxyMode (one axis each)
const MUTATIONS = {
  'no-function': (pm) => { pm.routes[firstRoute(pm)].extra = { deep: [{ smuggled: () => 'mechanism' }] } },
  kind: (pm) => { pm.routes[firstRoute(pm)].kind = 'registry-value' },
  'resolve (route)': (pm) => { pm.forms[0].route = 'no-such-route' },
  'resolve (cert)': (pm) => { pm.forms[0].cert = 'no-such-cert' },
  'resolve (trust)': (pm) => { pm.forms[0].trust = 'no-such-trust' },
  present: (pm) => { pm.forms[0].present = [] },
  'both-spellings': (pm) => { pm.routes[firstRoute(pm)].proxyKeys = ['HTTPS_PROXY'] },
  'switch-hook': (pm) => { for (const r of Object.values(pm.routes)) r.kind = 'switch-file'; for (const f of pm.forms) f.cert = 'root' },
  'pac-auth': (pm) => { const r = pm.routes[firstRoute(pm)]; r.value = 'pac-url'; delete r.auth },
  verified: (pm) => { pm.forms[0].verified = { ...pm.forms[0].verified, [pm.forms[0].os[0]]: {} } },
  'shape (hostTree)': (pm) => { pm.forms[0].hostTree = true; delete pm.forms[0].hosts },
  'write-target': (pm) => { pm.routes[firstRoute(pm)].file = { base: 'abs', path: '/Library/Managed Preferences/agent.plist' } },
  'write-target (perOs)': (pm) => { pm.routes[firstRoute(pm)].file = { perOs: { darwin: { base: 'home', path: '.agent.json' }, win32: { base: 'abs', path: 'C:/ProgramData/Agent/settings.json' } } } },
  'write-target (cwd)': (pm) => { pm.routes[firstRoute(pm)].file = { base: 'cwd', path: '.agent/settings.json' } },
}

// The real loader over a directory of one generated module per descriptor; the module hands back an object built here (functions and all).
async function loadOne(desc) {
  const dir = tmpDir('asight-pm-')
  const key = `d${Math.random().toString(36).slice(2)}`
  globalThis.__asightPmSchema = { ...(globalThis.__asightPmSchema || {}), [key]: desc }
  fs.writeFileSync(path.join(dir, `${key}.mjs`), `export default globalThis.__asightPmSchema.${key}\n`)
  return loadHarnesses(pathToFileURL(dir + path.sep))
}

test('CM27 (validation half): the eighth harness is data only and loads through the real loader', async () => {
  assert.equal(eighth.name, 'eighth')
  const fns = []
  ;(function walk(v, at) { if (typeof v === 'function') fns.push(at); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`) })(eighth, 'eighth')
  assert.deepEqual(fns, [], 'the eighth descriptor holds no function')
  assert.equal((await loadOne({ ...eighth })).length, 1)
})

test('every real descriptor carries proxyMode and loads; one without it is refused', async () => {
  assert.deepEqual(real.filter((d) => !d.proxyMode).map((d) => d.name), [])
  const { proxyMode, ...bare } = eighth
  await assert.rejects(loadOne(bare), /harness eighth .*shape: no proxyMode/)
})

for (const d of subjects) {
  test(`${d.name}: the descriptor as it is loads`, async () => { assert.equal((await loadOne({ ...d, proxyMode: structuredClone(d.proxyMode) })).length, 1) })
  for (const [rule, mutate] of Object.entries(MUTATIONS)) {
    test(`${d.name}: a ${rule} mutation is refused at load, naming the harness and the rule`, async () => {
      const pm = structuredClone(d.proxyMode)
      mutate(pm)
      await assert.rejects(loadOne({ ...d, proxyMode: pm }), (e) => {
        assert.match(e.message, new RegExp(`harness ${d.name} `))
        assert.match(e.message, new RegExp(`\\b${rule.split(' ')[0]}: `), e.message)
        return true
      })
    })
  }
}

// The data read back through the one reader (core/proxymode/sources.mjs), as T15–T20 will read it.
const WRITES = (pm) => [
  ...Object.values(pm.routes).flatMap((r) => [r.file, r.dir, r.select && r.select.dir]),
  ...Object.values(pm.certs).flatMap((c) => [c.file, c.binDir, c.dir, c.loader && c.loader.file]),
].filter(Boolean)

test('every write target of every descriptor resolves under the home, appSupport or localAppData on each OS', () => {
  const ctx = (os) => ({ os, home: path.join('/', 'h'), cwd: path.join('/', 'c'), env: {}, dirs: { appSupport: path.join('/', 'as'), localAppData: path.join('/', 'la') }, readdir: () => [] })
  const outside = []
  for (const d of subjects) for (const os of ['darwin', 'win32']) {
    const c = ctx(os)
    for (const loc of WRITES(d.proxyMode)) for (const p of resolveLoc(loc, c)) if (![c.home, c.dirs.appSupport, c.dirs.localAppData].some((r) => p.startsWith(r + path.sep))) outside.push(`${d.name} ${os}: ${p}`)
  }
  assert.deepEqual(outside, [])
})

test("claude-code: CLAUDE_CODE_CERT_STORE is read in Claude Code's own precedence (project-local, project, user settings env, process env; ruling ⑧)", () => {
  const cc = real.find((d) => d.name === 'claude-code').proxyMode
  const root = tmpDir('asight-pm-')
  const home = path.join(root, 'home'), cwd = path.join(root, 'proj')
  const put = (f, store) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ env: { CLAUDE_CODE_CERT_STORE: store } })) }
  const ctx = (env) => ({ os: 'darwin', home, cwd, env, dirs: {}, readFile: (p) => fs.readFileSync(p, 'utf8'), readdir: (p) => fs.readdirSync(p) })
  const when = cc.trusts.bundled.when
  assert.deepEqual(when, cc.certs.bundled.when, 'the cert carrier and the trust share one condition')
  assert.equal(holds(when, ctx({ CLAUDE_CODE_CERT_STORE: 'bundled' })), true, 'process env alone')
  put(path.join(home, '.claude', 'settings.json'), 'system')
  assert.equal(holds(when, ctx({ CLAUDE_CODE_CERT_STORE: 'bundled' })), false, 'user settings env over the process env')
  put(path.join(cwd, '.claude', 'settings.json'), 'bundled')
  assert.equal(holds(when, ctx({})), true, 'project settings over user settings')
  put(path.join(cwd, '.claude', 'settings.local.json'), 'system')
  assert.equal(holds(when, ctx({})), false, 'project-local settings first')
  const custom = path.join(root, 'cfg')
  put(path.join(custom, 'settings.json'), 'bundled')
  fs.rmSync(path.join(cwd, '.claude'), { recursive: true })
  assert.equal(holds(when, ctx({ CLAUDE_CONFIG_DIR: custom })), true, 'CLAUDE_CONFIG_DIR moves the user settings')
  assert.deepEqual(cc.trusts.bundled.sources.map((s) => s.from.env || s.from.file.base), ['cwd', 'cwd', 'home', 'NODE_EXTRA_CA_CERTS'])
})

// rule U for Hermes: its own config.yaml shapes (the providers map, the custom_providers list, the inline model block), read through the
// descriptor's own userCertFiles; a key the config does not have (`routes`) names nothing.
test('hermes: a route CA in each of config.yaml\'s shapes is found by the descriptor\'s userCertFiles', () => {
  const hm = real.find((d) => d.name === 'hermes').proxyMode
  const yamlSrcs = hm.userCertFiles.filter((s) => s.format === 'yaml')
  const DOCS = {
    providers: 'providers:\n  corp:\n    base_url: https://llm.corp.example/v1\n    ssl_ca_cert: /etc/corp.pem\n',
    custom_providers: 'custom_providers:\n  - name: corp\n    ssl_ca_cert: /etc/corp.pem\n',
    model: 'model:\n  default: m\n  ssl_ca_cert: /etc/corp.pem\n',
    routes: 'routes:\n  - ssl_ca_cert: /etc/corp.pem\n',
  }
  for (const os of ['darwin', 'win32']) for (const [shape, text] of Object.entries(DOCS)) {
    const root = tmpDir('asight-pm-')
    const ctx = { os, home: path.join(root, 'home'), cwd: root, env: {}, dirs: { localAppData: path.join(root, 'la'), appSupport: path.join(root, 'as') }, readFile: (p) => fs.readFileSync(p, 'utf8'), readdir: (p) => fs.readdirSync(p) }
    const [f] = resolveLoc(yamlSrcs[0].file, ctx)
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text)
    const found = yamlSrcs.map((s) => readSrc(s, ctx)).filter((r) => r.set).map((r) => r.value)
    assert.deepEqual(found, shape === 'routes' ? [] : ['/etc/corp.pem'], `${os} ${shape}`)
  }
})

test("codex: SSL_CERT_FILE in $CODEX_HOME/.env beats the process env (Codex applies .env over its launch env, spec 4.11 ④)", () => {
  const cx = real.find((d) => d.name === 'codex').proxyMode
  const root = tmpDir('asight-pm-')
  const home = path.join(root, 'home')
  const ctx = (env) => ({ os: 'darwin', home, cwd: root, env, dirs: {}, readFile: (p) => fs.readFileSync(p, 'utf8'), readdir: (p) => fs.readdirSync(p) })
  const first = (env) => cx.trusts.os.sources.map((s) => readSrc(s.from, ctx(env))).find((r) => r.set)?.value
  assert.ok(cx.trusts.os.sources.every((s) => s.semantics === 'replace'))
  assert.equal(first({ SSL_CERT_FILE: '/env/ca.pem' }), '/env/ca.pem', 'the process env alone')
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(home, '.codex', '.env'), 'SSL_CERT_FILE=/dotenv/ca.pem\n')
  assert.equal(first({ SSL_CERT_FILE: '/env/ca.pem' }), '/dotenv/ca.pem', '.env over the process env')
  assert.equal(first({ CODEX_HOME: path.join(root, 'other'), SSL_CERT_FILE: '/env/ca.pem' }), '/env/ca.pem', 'CODEX_HOME moves the .env')
})
