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
import { resolveLoc, holds } from '../../../src/collector/core/proxymode/sources.mjs'

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
