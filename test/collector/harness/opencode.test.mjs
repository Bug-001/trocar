// test/collector/harness/opencode.test.mjs — the OpenCode descriptor: R1 identification, T12 trust through the plugin
// marker, 不经信任路径 hosts, and T10 / T11 for its plugin entry (RFC 4.6 §身份与信任 OpenCode rows, D37④).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import oc from '../../../src/collector/harness/opencode.mjs'
import { planTrust } from '../../../src/collector/core/trust/plan.mjs'
import { installCollector } from '../../../src/collector/install.mjs'
import { uninstallCollector } from '../../helpers/uninstall.mjs'
import { readManifest } from '../../../src/collector/core/trust/journal.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'
import { sandbox, ctxFor, facts, judge, matchOf, plantMarker, CA, OTHER } from './_ctx.mjs'

test('opencode: curl, npm and platform binaries match, `serve` is long-lived; the Node launcher and BUN_BE_BUN self-execs do not (R1)', () => {
  assert.equal(matchOf([oc], facts({ exe: '/home/u/.opencode/bin/opencode', argv: ['opencode', 'run', 'hi'] })).agent, 'opencode')
  assert.equal(matchOf([oc], facts({ exe: '/usr/lib/node_modules/opencode-ai/bin/.opencode', argv: ['.opencode'] })).agent, 'opencode')
  assert.equal(matchOf([oc], facts({ exe: '/usr/lib/node_modules/opencode-linux-x64/bin/opencode (deleted)', argv: ['opencode'] })).agent, 'opencode')
  assert.equal(matchOf([oc], facts({ exe: '/usr/bin/node', argv: ['node', '/usr/lib/node_modules/opencode-ai/bin/opencode'] })).agent, null)
  assert.equal(matchOf([oc], facts({ exe: '/home/u/.opencode/bin/opencode', argv: ['opencode', 'x'], env: new Map([['BUN_BE_BUN', '1']]) })).agent, null)
  const serve = facts({ exe: '/home/u/.opencode/bin/opencode', argv: ['opencode', 'serve'] })
  assert.equal(matchOf([oc], serve).agent, 'opencode')
  const reg = createRegistry([oc])
  assert.deepEqual([reg.isLongLived(oc, serve), reg.isLongLived(oc, facts({ exe: serve.exe, argv: ['opencode', 'run', 'serve me'] }))], [true, false])
})

test('opencode: relay hosts from the global, OPENCODE_CONFIG, project and inline layers (JSONC, {env:X} substituted)', () => {
  const s = sandbox()
  try {
    s.put('.config/opencode/opencode.jsonc', '{ // c\n "provider": { "a": { "options": { "baseURL": "https://glob.example.com/v1", }, }, },\n}')
    const extra = s.put('extra.json', JSON.stringify({ provider: { b: { api: 'https://extra.example.com' } } }))
    s.put('repo/opencode.json', JSON.stringify({ provider: { c: { options: { baseURL: '{env:RELAY}/v1' } } } }))
    const r = judge(oc, ctxFor({ home: s.home, cwd: `${s.home}/repo`, env: { OPENCODE_CONFIG: extra, RELAY: 'https://proj.example.com', OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { d: { options: { baseURL: 'https://inline.example.com' } } } }) } }))
    assert.deepEqual(r.hosts.sort(), ['extra.example.com', 'glob.example.com', 'inline.example.com', 'proj.example.com'])
    assert.ok(oc.hosts.includes('api.anthropic.com') && oc.hosts.includes('api.deepseek.com'))
  } finally { s.done() }
})

test('opencode: hosts not via the trust path — models.dev always; the openai API hosts when the ws path is on (4.6 不经信任路径)', () => {
  const s = sandbox()
  try {
    s.put('.config/opencode/opencode.json', JSON.stringify({ provider: { openai: { options: { baseURL: 'https://oa-relay.example.com/v1' } }, anthropic: { options: { baseURL: 'https://an-relay.example.com' } } } }))
    const live = (env) => ({ ...ctxFor({ home: s.home, env }), env: new Map(Object.entries(env)) })
    assert.deepEqual(oc.bypass(live({})), [{ host: 'models.dev', reason: 'before-plugin' }])
    assert.deepEqual(oc.bypass(live({ OPENCODE_EXPERIMENTAL_WEBSOCKETS: 'true' })).map((b) => [b.host, b.reason]), [['models.dev', 'before-plugin'], ['api.openai.com', 'ws-path'], ['oa-relay.example.com', 'ws-path']], 'only the openai provider\'s hosts: the ws path serves no other provider')
  } finally { s.done() }
})

test('opencode: trusted by its plugin marker only while the start time matches; a missing marker is no-marker, --pure included (T12, acceptance ⑥)', () => {
  const s = sandbox()
  try {
    const caPem = s.put('.asight/collector/ca/asight-ca.pem', CA.certPem)
    const markers = plantMarker(path.join(s.home, '.asight/collector/run/trust'), 1000, 777)
    const argv = ['opencode', 'run', 'hi']
    const ok = judge(oc, ctxFor({ home: s.home, argv, startTicks: 777 }), { markerDir: markers, caPem })
    assert.deepEqual([ok.trust.trusted, ok.trust.via], [true, 'plugin marker'])
    assert.equal(judge(oc, ctxFor({ home: s.home, argv, startTicks: 778 }), { markerDir: markers, caPem }).trust.reason, 'marker-stale', 'a reused pid is not believed')
    const none = path.join(s.home, 'no-markers')
    // --pure / OPENCODE_PURE do not keep this file plugin out (acceptance ⑥): no marker yet is pending, like any start
    assert.equal(judge(oc, ctxFor({ home: s.home, argv: ['opencode', '--pure', 'run'] }), { markerDir: none, caPem }).trust.reason, 'no-marker')
    assert.equal(judge(oc, ctxFor({ home: s.home, env: { OPENCODE_PURE: '1' }, argv }), { markerDir: none, caPem }).trust.reason, 'no-marker')
    assert.equal(judge(oc, ctxFor({ home: s.home, argv }), { markerDir: none, caPem }).trust.reason, 'no-marker')
    const corp = s.put('corp.pem', OTHER.certPem)
    assert.equal(judge(oc, ctxFor({ home: s.home, argv, env: { NODE_EXTRA_CA_CERTS: corp } }), { markerDir: none, caPem }).trust.reason, 'no-marker', 'a user CA file without the asight CA is not the reason: the plugin has not reported')
    fs.writeFileSync(caPem, OTHER.certPem) // the asight CA file no longer holds the asight CA
    const lost = judge(oc, ctxFor({ home: s.home, argv, startTicks: 777, env: { NODE_EXTRA_CA_CERTS: corp } }), { markerDir: markers, caPem })
    assert.deepEqual([lost.trust.trusted, lost.trust.reason, lost.trust.var], [false, 'ca-not-in-file', 'asight:marker'], 'a marker next to a CA file without the asight CA does not trust')
    assert.ok(oc.trust.hints['no-marker'] && !oc.trust.hints['opencode-pure'])
  } finally { s.done() }
})

test('opencode inject: asight\'s plugin file in OpenCode\'s plugin dir (XDG_CONFIG_HOME aware), the npm-install paths watched, notes coded (T10)', () => {
  const s = sandbox()
  try {
    const dir = path.join(s.home, '.asight', 'collector')
    const ctx = { home: s.home, env: new Map(), collectorDir: dir, caPem: path.join(dir, 'ca', 'asight-ca.pem'), readText: () => null, running: [] }
    const p = planTrust({ descriptors: [oc], ctxFor: () => ctx, caCertPem: CA.certPem, collectorDir: dir })
    const plug = path.join(s.home, '.config', 'opencode', 'plugins', 'asight-ca.js')
    assert.deepEqual([p.paths, p.entries, p.files], [[plug], [], []], 'one file, nothing in OpenCode\'s config, no environment')
    assert.ok(p.owned[0].data.includes(JSON.stringify(path.join(dir, 'ca', 'asight-ca.pem'))) && p.owned[0].data.includes(JSON.stringify(path.join(dir, 'run', 'trust'))))
    assert.deepEqual(p.watch.map((w) => path.basename(w.path)), ['package.json', 'package-lock.json', 'bun.lock', 'node_modules'])
    assert.ok(p.records.every((r) => r.code === 'harness-note') && p.records.some((r) => /npm registry once/.test(r.reason)))
    const xdg = planTrust({ descriptors: [oc], ctxFor: () => ({ ...ctx, env: new Map([['XDG_CONFIG_HOME', path.join(s.home, 'xdg')]]) }), caCertPem: CA.certPem, collectorDir: dir })
    assert.deepEqual(xdg.paths, [path.join(s.home, 'xdg', 'opencode', 'plugins', 'asight-ca.js')])
  } finally { s.done() }
})

test('opencode through install / uninstall: the plugin goes in and out with the dirs asight made; OpenCode\'s own npm files are reported, kept (S10, T11)', async () => {
  const s = sandbox()
  try {
    s.put('.config/opencode/opencode.json', '{"theme":"x"}\n')
    await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [oc], freePort: async () => 47012 })
    const plug = path.join(s.home, '.config', 'opencode', 'plugins', 'asight-ca.js')
    assert.match(fs.readFileSync(plug, 'utf8'), /^\/\/ asight collector: trust plugin for OpenCode/)
    assert.deepEqual(readManifest(path.join(s.home, '.asight', 'collector')).files.find((f) => f.path === plug).created_dirs, [path.dirname(plug)])
    s.put('.config/opencode/node_modules/@opencode-ai/plugin/package.json', '{}') // OpenCode's first run
    const r = await uninstallCollector({ home: s.home, env: {}, stop: async () => 'none' })
    assert.ok(!fs.existsSync(path.dirname(plug)), 'the plugin and the plugins/ dir asight created are gone')
    assert.equal(fs.readFileSync(path.join(s.home, '.config', 'opencode', 'opencode.json'), 'utf8'), '{"theme":"x"}\n')
    assert.deepEqual(r.residue, [path.join(s.home, '.config', 'opencode', 'node_modules')])
  } finally { s.done() }
})

test('opencode: a config file that does not parse is reported; OPENCODE_CONFIG_CONTENT is not a file (D38, review 4 #4)', () => {
  const s = sandbox()
  try {
    const bad = s.put('.config/opencode/opencode.json', '{ "provider": { ')
    const seen = []
    judge(oc, ctxFor({ home: s.home, argv: ["/home/u/.opencode/bin/opencode", "run", "hi"], env: { OPENCODE_CONFIG_CONTENT: '{ broken' }, unparsable: (f) => seen.push(f) }))
    assert.deepEqual(seen, [bad])
  } finally { s.done() }
})
