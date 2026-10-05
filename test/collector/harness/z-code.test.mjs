// test/collector/harness/z-code.test.mjs — the Z-Code descriptor (RFC 4.6 §身份与信任 Z-Code rows, D37④, acceptance ② / ①):
// R1 identification (the Electron-as-Node agent at exec and after its CLI title, the remote node, a node wrapper; the
// GUI, plugin hosts and workflow children are not), T12 trust through caCertFile scopes (env > project > user, an empty
// ZCODE_AGENT_CA_CERT turns it off, the desktop setting overriding it), the origin host a CLI reaches by plain fetch
// (not via the trust path), T10 / T14 the caCertFile key with combined-z-code.pem, T11 install → uninstall.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import zcode from '../../../src/collector/harness/z-code.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'
import { planTrust } from '../../../src/collector/core/trust/plan.mjs'
import { installCollector, uninstallCollector } from '../../../src/collector/install.mjs'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { sandbox, ctxFor, facts, judge, matchOf, CA, OTHER } from './_ctx.mjs'

const EXE = '/opt/ZCode/zcode'
const CJS = '/opt/ZCode/resources/glm/zcode.cjs'
const AS_NODE = new Map([['ELECTRON_RUN_AS_NODE', '1']])
const fps = (text) => (String(text).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []).map((p) => new X509Certificate(p).fingerprint256)
const fp = (ca) => new X509Certificate(ca.certPem).fingerprint256

test('z-code: the Electron-as-Node agent (at exec, and after its CLI title), the remote node and a node wrapper match; the GUI, plugin hosts and workflow children do not (R1)', () => {
  assert.equal(matchOf([zcode], facts({ exe: EXE, argv: [EXE, CJS, 'app-server', '--stdio', '--surface', 'desktop'], env: AS_NODE })).agent, 'z-code')
  assert.equal(matchOf([zcode], facts({ exe: EXE, argv: [EXE, CJS, '-p', 'hi'], env: AS_NODE })).agent, 'z-code')
  assert.equal(matchOf([zcode], facts({ exe: EXE, argv: ['zcode-cli'], env: AS_NODE })).agent, 'z-code', 'the CLI title replaces its cmdline (acceptance ①)')
  assert.equal(matchOf([zcode], facts({ exe: '/home/u/.zcode/server/node', argv: ['node', '/home/u/.zcode/server/agents/glm/zcode.cjs', 'app-server'] })).agent, 'z-code', 'remote mode: node with the bundle')
  assert.equal(matchOf([zcode], facts({ exe: '/usr/local/bin/node', argv: ['node', CJS, '-p', 'hi'] })).agent, 'z-code')
  assert.equal(matchOf([zcode], facts({ exe: '/usr/local/bin/node', argv: ['zcode-cli'] })).agent, 'z-code')
  for (const [f, why] of [
    [{ exe: EXE, argv: [EXE] }, 'the GUI'],
    [{ exe: EXE, argv: [EXE, '--type=renderer'] }, 'a renderer'],
    [{ exe: EXE, argv: [EXE, CJS, '-p', 'hi'] }, 'the bundle path without ELECTRON_RUN_AS_NODE is not the agent'],
    [{ exe: EXE, argv: ['zcode-cli'] }, 'the title without ELECTRON_RUN_AS_NODE'],
    [{ exe: EXE, argv: [EXE, CJS, '__zcode-plugin-host', '/h/.zcode/cli/plugins/cache/x/node-repl-host'], env: AS_NODE }, 'a plugin host (acceptance ②: one per run)'],
    [{ exe: EXE, argv: [EXE, CJS, '__zcode-dwf-child', '/w/entry.js'], env: AS_NODE }, 'a dynamic-workflow child'],
    [{ exe: '/usr/local/bin/node', argv: ['node', '/srv/zcode.cjs'] }, 'not under glm/'],
  ]) assert.equal(matchOf([zcode], facts(f)).agent, null, why)
  assert.equal(createRegistry([zcode]).isLongLived(zcode, facts({ exe: EXE, argv: [EXE, CJS, 'app-server', '--stdio'], env: AS_NODE })), true)
})

test('z-code: user caCertFile trusts; env and project scopes (from the git root down to the cwd) override it; an empty ZCODE_AGENT_CA_CERT turns it off (T12)', () => {
  const s = sandbox()
  try {
    const merged = s.put('ca/merged.pem', OTHER.certPem + CA.certPem); const foreign = s.put('ca/other.pem', OTHER.certPem)
    s.put('.zcode/cli/config.json', JSON.stringify({ network: { caCertFile: merged, httpProxy: 'https://px.example.com:8443' } }))
    const ok = judge(zcode, ctxFor({ home: s.home }))
    assert.deepEqual([ok.trust.trusted, ok.trust.var], [true, 'zcode:user:caCertFile'])
    assert.ok(ok.proxies.includes('https://px.example.com:8443'))
    const off = judge(zcode, ctxFor({ home: s.home, env: { ZCODE_AGENT_CA_CERT: '' } }))
    assert.deepEqual([off.trust.trusted, off.trust.reason, off.trust.var], [false, 'shadowed', 'ZCODE_AGENT_CA_CERT'])
    fs.mkdirSync(path.join(s.home, 'repo', '.git'), { recursive: true })
    s.put('repo/zcode.json', JSON.stringify({ network: { caCertFile: foreign } }))
    fs.mkdirSync(path.join(s.home, 'repo', 'pkg', 'sub'), { recursive: true })
    const proj = judge(zcode, ctxFor({ home: s.home, cwd: `${s.home}/repo/pkg/sub` }))
    assert.deepEqual([proj.trust.trusted, proj.trust.reason, proj.trust.var], [false, 'shadowed', 'zcode:project:caCertFile'], 'a zcode.json at the git root, two levels up')
    assert.equal(judge(zcode, ctxFor({ home: s.home, cwd: `${s.home}/repo`, env: { ZCODE_AGENT_CA_CERT: merged } })).trust.trusted, true, 'the env wins over the project')
    // with an explicit CA file in force, NODE_EXTRA_CA_CERTS no longer counts (Node `ca` option)
    const only = s.put('ca/asight.pem', CA.certPem)
    assert.equal(judge(zcode, ctxFor({ home: s.home, cwd: `${s.home}/repo`, env: { NODE_EXTRA_CA_CERTS: only } })).trust.trusted, false)
    assert.equal(judge(zcode, ctxFor({ home: s.home, env: { ZCODE_AGENT_CA_CERT: '', NODE_EXTRA_CA_CERTS: only } })).trust.trusted, true, 'no CA file: the default store, which Electron-as-Node extends (acceptance ②)')
  } finally { s.done() }
})

test('z-code: the desktop CA setting overriding the user file is named desktop-ca-override (T12)', () => {
  const s = sandbox()
  try {
    const merged = s.put('ca/merged.pem', OTHER.certPem + CA.certPem); const corp = s.put('ca/corp.pem', OTHER.certPem)
    s.put('.zcode/cli/config.json', JSON.stringify({ network: { caCertFile: merged } }))
    s.put('.zcode/v2/setting.json', JSON.stringify({ httpProxyCaCertPath: corp }))
    const r = judge(zcode, ctxFor({ home: s.home, env: { ZCODE_AGENT_CA_CERT: corp, NODE_EXTRA_CA_CERTS: corp } }))
    assert.deepEqual([r.trust.trusted, r.trust.reason, r.trust.var], [false, 'desktop-ca-override', 'ZCODE_AGENT_CA_CERT'])
    assert.equal(judge(zcode, ctxFor({ home: s.home, env: { ZCODE_AGENT_CA_CERT: s.put('ca/x.pem', OTHER.certPem) } })).trust.reason, 'shadowed', 'a value that is not the desktop setting')
    assert.ok(zcode.trust.hints['desktop-ca-override'])
  } finally { s.done() }
})

test('z-code: a user config written after start is not believed; relay hosts from the provider configs; the nearest .env fills; a CLI\'s origin host is not via the trust path, an app-server\'s is', () => {
  const s = sandbox()
  try {
    const merged = s.put('ca/merged.pem', OTHER.certPem + CA.certPem)
    s.put('.zcode/cli/config.json', JSON.stringify({ network: { caCertFile: merged } }))
    assert.deepEqual([judge(zcode, ctxFor({ home: s.home, startedAt: 1 })).trust.reason], ['config-after-start'])
    s.put('.zcode/v2/provider_config.json', JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [{ providerId: 'mine', config: { api: { type: 'openai-chat-completions', baseUrl: 'https://relay.example.com/v1' } } }] } } }))
    const builtin = s.put('builtin.json', JSON.stringify({ providers: { zai: { baseUrl: 'https://api.z.ai/api/anthropic' } } }))
    s.put('repo/.env', 'ZCODE_HTTP_PROXY=https://envpx.example.com:3128\n')
    const cli = judge(zcode, ctxFor({ home: s.home, cwd: `${s.home}/repo/sub`, argv: ['zcode-cli'], env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin } }))
    assert.deepEqual(cli.hosts.sort(), ['api.z.ai', 'relay.example.com'])
    assert.ok(cli.proxies.includes('https://envpx.example.com:3128'))
    const bypass = (argv, env = {}) => zcode.bypass({ ...ctxFor({ home: s.home, argv, env }), env: new Map(Object.entries(env)) })
    assert.deepEqual(bypass([EXE, CJS, '-p', 'hi']), [{ host: 'zcode.z.ai', reason: 'not-via-trust-path' }], 'the CLI refreshes its built-in providers by plain fetch (lab ②)')
    assert.deepEqual(bypass(['zcode-cli'], { ZCODE_BASE_URL: 'https://origin.example.com/' }), [{ host: 'origin.example.com', reason: 'not-via-trust-path' }])
    assert.deepEqual(bypass(['zcode-cli'], { ZCODE_ENV: 'test' }), [{ host: 'zcode.chatglm.site', reason: 'not-via-trust-path' }])
    assert.deepEqual(bypass([EXE, CJS, 'app-server', '--stdio']), [], 'the app-server does not refresh')
  } finally { s.done() }
})

const planFor = (s, env = {}, running = []) => {
  const dir = path.join(s.home, '.asight', 'collector')
  return planTrust({ descriptors: [zcode], ctxFor: () => ({ os: 'none', home: s.home, env: new Map(Object.entries(env)), running: running.map((e) => new Map(Object.entries(e))), collectorDir: dir, caPem: path.join(dir, 'ca', 'asight-ca.pem'), readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }, readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } }, listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } } }), caCertPem: CA.certPem, collectorDir: dir, roots: { node: [], osText: '' } })
}

test('z-code inject: network.caCertFile in ~/.zcode/cli/config.json = combined-z-code.pem, which carries the CAs it covers or makes ineffective; the desktop setting and a set ZCODE_AGENT_CA_CERT are named (T10, T14)', () => {
  const s = sandbox()
  try {
    const none = planFor(s)
    assert.deepEqual([none.entries, none.files, none.records.map((r) => r.code)], [[], [], ['harness-note']], 'no ~/.zcode: nothing written, said why')
    const SHELL = createCa({ commonName: 'NODE_EXTRA_CA_CERTS of the install shell' }); const DESK = createCa({ commonName: 'desktop proxy CA' })
    const corp = s.put('corp.pem', OTHER.certPem); const shell = s.put('shell.pem', SHELL.certPem); const desk = s.put('desk.pem', DESK.certPem)
    s.put('.zcode/cli/config.json', JSON.stringify({ model: 'lab/m', network: { caCertFile: corp } }, null, 2))
    s.put('.zcode/v2/setting.json', JSON.stringify({ httpProxyCaCertPath: desk }))
    const dir = path.join(s.home, '.asight', 'collector')
    const bundle = path.join(dir, 'ca', 'combined-z-code.pem')
    const p = planFor(s, { NODE_EXTRA_CA_CERTS: shell, ZCODE_AGENT_CA_CERT: corp }, [{ NODE_EXTRA_CA_CERTS: bundle }, { NODE_EXTRA_CA_CERTS: 'rel.pem' }])
    assert.deepEqual(p.entries.map((e) => [e.kind, e.path, e.keys, e.value]), [['json-key', path.join(s.home, '.zcode/cli/config.json'), ['network', 'caCertFile'], bundle]])
    assert.deepEqual([p.files[0].path, p.files[0].role, p.files[0].sources], [bundle, 'bundle', [corp, desk, shell]], 'the caCertFile it replaces, the desktop setting, the install shell; never asight\'s own')
    assert.deepEqual(fps(p.files[0].data), [fp(OTHER), fp(DESK), fp(SHELL), fp(CA)])
    const codes = p.records.map((r) => r.code)
    assert.deepEqual(codes.filter((c) => c !== 'harness-note'), ['relative-path'], 'nothing unreadable: asight\'s own bundle is not a source')
    assert.ok(p.records.some((r) => r.code === 'harness-note' && r.reason.includes('httpProxyCaCertPath') && r.reason.includes(desk)), 'the desktop setting that wins is named')
    assert.ok(p.records.some((r) => r.code === 'harness-note' && /^ZCODE_AGENT_CA_CERT is set in this shell/.test(r.reason)), 'a ZCODE_AGENT_CA_CERT in the install shell is named')
    fs.rmSync(path.join(s.home, '.zcode', 'cli'), { recursive: true })
    assert.equal(planFor(s).entries[0].path, path.join(s.home, '.zcode/cli/config.json'), 'the CLI config is created when only the desktop has run')
  } finally { s.done() }
})

test('z-code through install / uninstall: the user\'s caCertFile is replaced and merged, then comes back byte for byte; the bundle is kept for a live Z-Code, then goes (T11, S10)', async () => {
  const s = sandbox()
  try {
    const corp = s.put('corp.pem', OTHER.certPem)
    const before = JSON.stringify({ model: 'lab/m', network: { caCertFile: corp, timeout: 30 } }, null, 2) + '\n'
    const cfg = s.put('.zcode/cli/config.json', before)
    await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [zcode], freePort: async () => 47016, roots: { node: [], osText: '' } })
    const dir = path.join(s.home, '.asight', 'collector')
    const bundle = path.join(dir, 'ca', 'combined-z-code.pem')
    assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), { model: 'lab/m', network: { caCertFile: bundle, timeout: 30 } })
    assert.deepEqual(fps(fs.readFileSync(bundle, 'utf8')), [fp(OTHER), ...fps(fs.readFileSync(path.join(dir, 'ca', 'asight-ca.pem'), 'utf8'))])
    const live = { os: 'linux', pid: 88, exe: EXE, argv: [EXE, CJS, 'app-server', '--stdio'], env: AS_NODE, startedAt: 0 }
    const match = (f) => createRegistry([zcode]).match(f)
    const r = await uninstallCollector({ home: s.home, env: {}, stop: async () => 'none', harnesses: [zcode], roots: { node: [], osText: '' }, scan: async () => [live], match })
    assert.deepEqual([r.entries.map((e) => e.result), r.kept_bundles.map((k) => k.pids), r.still_trusting.map((x) => x.until)], [['restored'], [[88]], ['session-end']])
    assert.equal(fs.readFileSync(cfg, 'utf8'), before)
    assert.deepEqual((await uninstallCollector({ home: s.home, env: {}, stop: async () => 'none', harnesses: [zcode], roots: { node: [], osText: '' } })).kept_bundles, [])
    assert.ok(!fs.existsSync(bundle))
  } finally { s.done() }
})
