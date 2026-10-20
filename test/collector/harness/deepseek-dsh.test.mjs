// test/collector/harness/deepseek-dsh.test.mjs — the dsh descriptor: R1 identification (its runner / PTC / opener
// children are not the agent), T12 trust through the plugin marker with the reasons derived when it is missing, and
// T10 / T11 for its patch row + plugin dir (RFC 4.6 §身份与信任 dsh rows, D37④, acceptance ⑤).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import dsh from '../../../src/collector/harness/deepseek-dsh.mjs'
import { planTrust } from '../../../src/collector/core/trust/plan.mjs'
import { installCollector } from '../../../src/collector/install.mjs'
import { uninstallCollector } from '../../helpers/uninstall.mjs'
import { sandbox, ctxFor, facts, judge, matchOf, plantMarker, CA, OTHER } from './_ctx.mjs'

const AGENT = ['node', '/usr/local/bin/dsh', '--profile', 'headless', '--json', 'hi']

test('deepseek-dsh: node running the dsh bin matches (the second exec, after /usr/bin/env); its runner, PTC child and opener do not (R1)', () => {
  const n = '/usr/local/bin/node'
  assert.equal(matchOf([dsh], facts({ exe: '/usr/bin/env', argv: ['/usr/bin/env', 'node', '/usr/local/bin/dsh', 'headless'] })).agent, null)
  assert.equal(matchOf([dsh], facts({ exe: n, argv: AGENT })).agent, 'deepseek-dsh')
  assert.equal(matchOf([dsh], facts({ exe: '/home/u/.nvm/versions/node/v22.19.0/bin/node (deleted)', argv: ['node', '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', 'tui'] })).agent, 'deepseek-dsh')
  assert.equal(matchOf([dsh], facts({ exe: n, argv: ['node', '--use-openssl-ca', '/usr/local/bin/dsh', 'tui'] })).agent, 'deepseek-dsh', 'node flags before the entry')
  const mods = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
  for (const child of [
    ['node', `${mods}/dsh-subprocess-local/lib/runner.js`],
    ['node', '--max-old-space-size=512', `${mods}/dsh-ptc-runtime-node/lib/process.js`, '--parent', '/usr/local/bin/dsh'],
    ['node', '--input-type=module', '--eval', 'opener', '--', 'http://127.0.0.1:1/'],
    ['node', '/usr/lib/node_modules/npm/bin/npx-cli.js', '@deepseek-ai/dsh'],
  ]) assert.equal(matchOf([dsh], facts({ exe: n, argv: child })).agent, null, child.join(' '))
})

test('deepseek-dsh: base URLs from the launch env and the home / profile patch files; .env files never carry trust or base URLs (dsh refuses them)', () => {
  const s = sandbox()
  try {
    const pem = s.put('ca.pem', CA.certPem)
    s.put('repo/.env', `DEEPSEEK_SEARCH_BASE_URL=https://search.example.com/v1\nNODE_EXTRA_CA_CERTS=${pem}\nFOO=1\n`)
    s.put('.dsh/.env', 'DEEPSEEK_BASE_URL=https://relay.example.com/anthropic\nhttps_proxy=https://px.example.com:8443\n')
    s.put('.dsh/profiles/web/cordis.patch.yml', '- set:\n    llm-deepseek:\n      baseURL: https://patched.example.com/anthropic\n')
    const r = judge(dsh, ctxFor({ home: s.home, cwd: `${s.home}/repo`, argv: ['node', '/usr/local/bin/dsh', '--profile', 'web'], env: { DEEPSEEK_BASE_URL: 'https://launch.example.com' } }))
    assert.deepEqual(r.hosts.sort(), ['launch.example.com', 'patched.example.com'])
    assert.deepEqual(r.proxies, ['https://px.example.com:8443'], 'the home .env may set the proxy names')
    assert.equal(r.trust.reason, 'no-marker', 'a CA variable in a dsh .env file is never in effect')
    assert.equal(judge(dsh, ctxFor({ home: s.home, argv: AGENT, env: { NODE_EXTRA_CA_CERTS: pem } })).trust.trusted, true, 'a real-env NODE_EXTRA_CA_CERTS with the trocar CA')
    assert.equal(judge(dsh, ctxFor({ home: s.home, argv: ['node', '/usr/local/bin/dsh', 'web'], env: { DSH_HOME: '~/alt' } })).hosts.length, 0)
  } finally { s.done() }
})

test('deepseek-dsh: the plugin marker trusts; without it the reason is --use-openssl-ca, a Node older than 22.19, else no-marker (T12)', () => {
  const s = sandbox()
  try {
    const caPem = s.put('.trocar/collector/ca/trocar-ca.pem', CA.certPem)
    const markers = plantMarker(path.join(s.home, 'run/trust'), 1000, 4242)
    const ok = judge(dsh, ctxFor({ home: s.home, argv: AGENT, startTicks: 4242 }), { markerDir: markers, caPem, runtimeVersion: '22.23.3' })
    assert.deepEqual([ok.trust.trusted, ok.trust.via], [true, 'plugin marker'])
    assert.equal(judge(dsh, ctxFor({ home: s.home, argv: AGENT, startTicks: 1 }), { markerDir: markers, caPem }).trust.reason, 'marker-stale')
    const none = path.join(s.home, 'no-markers')
    const why = (o, v = '22.23.3') => judge(dsh, ctxFor({ home: s.home, argv: AGENT, ...o }), { markerDir: none, caPem, runtimeVersion: v }).trust.reason
    assert.equal(why({ env: { NODE_OPTIONS: '--max-old-space-size=8192 --use-openssl-ca' } }), 'dsh-use-openssl-ca')
    assert.equal(why({ argv: ['node', '--use-openssl-ca', ...AGENT.slice(1)] }), 'dsh-use-openssl-ca')
    assert.equal(why({}, '22.18.0'), 'dsh-node-too-old')
    assert.equal(why({}, null), 'no-marker', 'an unknown Node version is not a reason')
    assert.equal(why({}), 'no-marker')
    const corp = s.put('corp.pem', OTHER.certPem)
    assert.equal(why({ env: { NODE_EXTRA_CA_CERTS: corp } }), 'no-marker', 'a user CA file is not the reason while the plugin has not reported')
    for (const k of ['dsh-use-openssl-ca', 'dsh-node-too-old', 'no-marker']) assert.ok(dsh.trust.hints[k], k)
  } finally { s.done() }
})

test('deepseek-dsh inject: trocar\'s plugin dir (entry file + anonymous manifest) and one sentinel row in $DSH_HOME/cordis.patch.yml (T10)', () => {
  const s = sandbox()
  try {
    const dir = path.join(s.home, '.trocar', 'collector')
    const ctx = (env = {}) => ({ home: s.home, env: new Map(Object.entries(env)), collectorDir: dir, caPem: path.join(dir, 'ca', 'trocar-ca.pem'), readText: () => null, running: [] })
    const p = planTrust({ descriptors: [dsh], ctxFor: () => ctx(), caCertPem: CA.certPem, collectorDir: dir })
    const entry = path.join(dir, 'plugins', 'dsh', 'index.js')
    assert.deepEqual(p.paths, [entry, path.join(dir, 'plugins', 'dsh', 'package.json'), path.join(s.home, '.dsh', 'cordis.patch.yml')])
    assert.equal(p.owned[1].data, '{"type":"module"}\n', 'no name: dsh would put it on the wire (acceptance ⑤)')
    assert.match(p.entries[0].line, /^- insert: \[\{ name: ".*\/plugins\/dsh\/index\.js" \}\] # trocar collector: /, 'the entry FILE, not the directory (acceptance ⑤)')
    assert.ok(p.owned[0].data.includes('tls.setDefaultCACertificates'))
    assert.deepEqual(planTrust({ descriptors: [dsh], ctxFor: () => ctx({ DSH_HOME: '~/alt-dsh' }), caCertPem: CA.certPem, collectorDir: dir }).entries[0].path, path.join(s.home, 'alt-dsh', 'cordis.patch.yml'))
  } finally { s.done() }
})

test('deepseek-dsh through install / uninstall: a user\'s [] patch file gets the row and gets [] back; the plugin dir goes (S10, T11)', async () => {
  const s = sandbox()
  try {
    const patch = s.put('.dsh/cordis.patch.yml', '# my patches\n[]\n')
    await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [dsh], freePort: async () => 47013 })
    const dir = path.join(s.home, '.trocar', 'collector', 'plugins', 'dsh')
    assert.deepEqual(fs.readdirSync(dir).sort(), ['index.js', 'package.json'])
    assert.match(fs.readFileSync(patch, 'utf8'), /^# my patches\n- insert: \[\{ name: ".*index\.js" \}\] # trocar collector: .*\n$/)
    const r = await uninstallCollector({ home: s.home, env: {}, stop: async () => 'none' })
    assert.deepEqual(r.entries.map((e) => e.result), ['restored'])
    assert.equal(fs.readFileSync(patch, 'utf8'), '# my patches\n[]\n')
    assert.ok(!fs.existsSync(path.join(s.home, '.trocar', 'collector', 'plugins')))
  } finally { s.done() }
})
