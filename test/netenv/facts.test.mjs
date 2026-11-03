// test/netenv/facts.test.mjs — the facts the topology is made of (RFC 1.6 §9.7): the proxy setting of an agent read the way the agent reads it (files in the order its descriptor lists, then the environment), and
// gatherNetFacts, which puts what `status` read, the descriptors' data, the VPN probe and the platform's part together. Sandbox HOMEs and injected platforms: nothing reads the machine (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readProxySetting, proxyFilesOf } from '../../src/netenv/adopt.mjs'
import { gatherNetFacts } from '../../src/netenv/facts.mjs'
import { buildTopology } from '../../src/netenv/topology.mjs'
import { diagnose } from '../../src/netenv/findings.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const all = await loadHarnesses()
const D = Object.fromEntries(all.map((d) => [d.name, d]))
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

test('readProxySetting: the key a harness file declares, in the file it declares, redacted, with a hash of the value, a source and when the file changed — and the value only in memory', () => {
  const home = tmpDir('trocar-set-')
  put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { HTTPS_PROXY: 'http://alice:pw@proxy.corp:8080', OTHER: 'x' } }))
  const s = readProxySetting(D['claude-code'], { home, env: {} })
  assert.equal(s.value, 'http://***@proxy.corp:8080')
  assert.deepEqual([s.scheme, s.host, s.port], ['http', 'proxy.corp', 8080])
  assert.deepEqual(s.source, [{ kind: 'file', where: path.join(home, '.claude', 'settings.json'), key: 'env.HTTPS_PROXY' }])
  assert.match(s.sha256, /^[0-9a-f]{64}$/)
  assert.ok(Date.parse(s.changedAt) > Date.now() - 60_000)
  assert.equal(s.raw, 'http://alice:pw@proxy.corp:8080', 'the value as written is held for the caller that must hand it on')
  const printed = JSON.stringify(s)
  assert.ok(!/alice|pw@|OTHER/.test(printed), 'and is not in anything that is printed, stored or sent as JSON')
  assert.deepEqual(Object.keys(s).sort(), ['changedAt', 'host', 'port', 'scheme', 'sha256', 'source', 'value'])
})

test('readProxySetting: a file wins over the environment (the way the agent reads its settings over its launch env), the next file after the first, then the environment; none is none, not unknown', () => {
  const home = tmpDir('trocar-set2-')
  const env = { HTTPS_PROXY: 'http://env.example:1', https_proxy: 'http://lower.example:2' }
  assert.deepEqual(readProxySetting(D['claude-code'], { home, env }).source, [{ kind: 'env', where: 'HTTPS_PROXY' }], 'no file: the environment, in the order the descriptor lists the names')
  put(path.join(home, '.claude.json'), JSON.stringify({ env: { HTTP_PROXY: 'http://global.example:3' } }))
  assert.equal(readProxySetting(D['claude-code'], { home, env }).host, 'global.example', '~/.claude.json holds one: it wins over the environment')
  put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { HTTPS_PROXY: 'http://user.example:4' } }))
  assert.equal(readProxySetting(D['claude-code'], { home, env }).host, 'user.example', 'and the user settings win over ~/.claude.json')
  assert.deepEqual(readProxySetting(D.opencode, { home: tmpDir('trocar-none-'), env: {} }), { value: null, scheme: null, host: null, port: null, source: [], sha256: null, changedAt: null })
  put(path.join(home, '.codex', '.env'), '# a comment\nexport HTTPS_PROXY="socks5h://127.0.0.1:1080"\nOTHER=1\n')
  const c = readProxySetting(D.codex, { home, env: {} })
  assert.deepEqual([c.scheme, c.host, c.port, c.source[0].key], ['socks5h', '127.0.0.1', 1080, 'HTTPS_PROXY'])
  assert.equal(readProxySetting(D.codex, { home, env: { CODEX_HOME: path.join(home, 'elsewhere') } }).value, null, 'CODEX_HOME moves the file')
})

test('readProxySetting: a file that cannot be read or parsed is unknown with its reason (it may hold the very key that wins), and a value that is not a URL never appears in the reason', () => {
  const home = tmpDir('trocar-set3-')
  const file = path.join(home, '.claude', 'settings.json')
  put(file, '{ not json')
  const u = readProxySetting(D['claude-code'], { home, env: {} })
  assert.deepEqual(u, { unknown: { reason: 'unparseable', detail: `${file} does not parse as JSON` } })
  const denied = readProxySetting(D['claude-code'], { home, env: {}, fs: { ...fs, readFileSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) }, statSync: fs.statSync } })
  assert.equal(denied.unknown.reason, 'denied')
  assert.match(denied.unknown.detail, /EACCES/)
  put(file, JSON.stringify({ env: { HTTPS_PROXY: 'not a url: s3cr3t token' } }))
  const bad = readProxySetting(D['claude-code'], { home, env: {} })
  assert.equal(bad.unknown.reason, 'unparseable')
  assert.ok(!/s3cr3t/.test(JSON.stringify(bad)), 'the detail names the key and the file, never the value')
})

test('proxyFilesOf: the files of every harness for this HOME, which the daemon stats', () => {
  const home = '/h'
  assert.deepEqual(proxyFilesOf(D['claude-code'], { home, env: {} }), ['/h/.claude/settings.json', '/h/.claude.json'])
  assert.deepEqual(proxyFilesOf(D.opencode, { home, env: {} }), [])
})

// ── gatherNetFacts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const status = (over = {}) => ({
  daemon: { state: 'running', pid: 4012, reply: { engine: { port: 47123 }, links: [{ id: 17, name: 'connect4' }, { id: 18, name: 'connect6' }], negatives: [{ pid: 4121, host: 'api.anthropic.com' }, { pid: 99, host: 'x' }], agents: [] }, lock: { engine_port: 47123 } },
  link: { attached: true, helper: 'ok' },
  harnesses: [{ id: 'claude-code', installed: true, desired: 'on', entry: { state: 'intact' }, installedAt: Date.parse('2026-10-07T09:00:00Z'), procs: [] }, { id: 'codex', installed: true, desired: 'off', entry: { state: 'missing', why: 'x' }, installedAt: null, procs: [] }],
  ...over,
})
const base = { platform: 'linux', env: {}, harnesses: all, now: () => Date.parse('2026-10-07T10:00:00Z') }

test('gatherNetFacts: the switch, the daemon, the link ids, the descriptors\' behaviour for this platform, the negative cache of the harness\'s processes and what `on` adopted', async () => {
  const home = tmpDir('trocar-gather-')
  const f = await gatherNetFacts({ ...base, home, status: status(), adopted: { 'claude-code': { at: 'T', chain: 'c', proxy: null, source: [], sha256: null } },
    archFacts: async () => ({ routing: 'driver', procs: { 'claude-code': [{ pid: 4121, name: 'claude' }] }, listeners: [{ addr: '127.0.0.1', port: 7890, pid: 777 }], unknowns: [{ fact: 'tun', reason: 'absent', detail: 'no ip' }] }) })
  assert.equal(f.at, '2026-10-07T10:00:00.000Z')
  assert.deepEqual([f.platform, f.routing], ['linux', 'driver'])
  assert.deepEqual(f.desired, { 'claude-code': 'on', codex: 'off' })
  assert.deepEqual(f.daemon, { state: 'running', pid: 4012, enginePort: 47123 })
  assert.deepEqual(f.link, { attached: true, helper: 'ok', ids: [17, 18] })
  const cc = f.harnesses['claude-code']
  assert.deepEqual(cc.entry, { state: 'intact' })
  assert.equal(cc.installedAt, '2026-10-07T09:00:00.000Z')
  assert.deepEqual([cc.behaviour.measured, cc.behaviour.follows, cc.behaviour.branches], ['lab', { http: false, ws: false }, ['all']], 'claude-code on Linux: the HTTPS_PROXY path was measured by V54 on a test machine')
  assert.deepEqual(cc.behaviour.files, [path.join(home, '.claude', 'settings.json'), path.join(home, '.claude.json')])
  assert.deepEqual(cc.negatives, [{ pid: 4121, host: 'api.anthropic.com', reason: 'negative-cache' }], 'only the pairs of this harness\'s own processes')
  assert.deepEqual(cc.apiHosts, ['api.anthropic.com'])
  assert.equal(cc.adopted.at, 'T')
  assert.equal(f.harnesses.codex.adopted, null)
  assert.equal(f.harnesses.codex.behaviour.measured, 'inferred', 'every other harness on Linux is still inferred from the Windows measurements')
  assert.deepEqual(f.unknowns, [{ fact: 'tun', reason: 'absent', detail: 'no ip' }])
  const w = await gatherNetFacts({ ...base, platform: 'win32', home, status: status(), archFacts: async () => ({ routing: 'proxy' }) })
  assert.equal(w.harnesses['claude-code'].behaviour.measured, 'lab', 'measured on Windows')
})

test('gatherNetFacts: no vpn / vpnKnown / tun in the facts and no product on a listener, even when a caller still passes a probe result or an arch part still returns tun / vpn (D49)', async () => {
  const home = tmpDir('trocar-gather2-')
  const arch = async () => ({ routing: 'driver', listeners: [{ addr: '127.0.0.1', port: 7890, pid: 777, exe: '/usr/bin/mihomo' }], tun: true, vpn: { product: 'mihomo', port: 7890 } })
  const probe = { result: { products: [{ product: 'mihomo', mode: 'rule', tun: 'unknown', system_proxy: false, mixed_port: 7890, live: true, via: {} }], unknown: [] } }
  const f = await gatherNetFacts({ ...base, home, status: status(), netenv: probe, archFacts: arch })
  for (const k of ['vpn', 'vpnKnown', 'tun']) assert.ok(!(k in f), `${k} is not a fact`)
  assert.deepEqual(f.listeners, [{ addr: '127.0.0.1', port: 7890, pid: 777, exe: '/usr/bin/mihomo' }], 'the listener is not named after a product')
  const failed = await gatherNetFacts({ ...base, home, status: status(), archFacts: arch, netenv: { error: 'the probe broke' } })
  assert.deepEqual(failed.unknowns, [], 'a failed probe is not a fact either')
})

test('gatherNetFacts: a platform part that throws leaves the routing unknown and says why; none at all says so; the guard\'s refusal is not "the read failed"', async () => {
  const home = tmpDir('trocar-gather3-')
  const broke = await gatherNetFacts({ ...base, home, status: status(), archFacts: async () => { throw Object.assign(new Error('boom'), { code: 'EBOOM' }) } })
  assert.equal(broke.routing, 'unknown')
  assert.deepEqual(broke.unknowns, [{ fact: 'arch', reason: 'denied', detail: 'the platform\'s network facts could not be read (EBOOM)' }])
  const none = await gatherNetFacts({ ...base, platform: 'plan9', home, status: status() })
  assert.equal(none.routing, 'unknown')
  assert.equal(none.unknowns[0].reason, 'absent')
  await assert.rejects(gatherNetFacts({ ...base, home, status: status(), archFacts: async () => { throw Object.assign(new Error('refusing to run ss'), { code: 'ESANDBOX' }) } }), /refusing to run ss/)
})

test('a platform part that throws or is absent leaves the listeners unread: a loopback proxy in the setting is an unknown hop with that reason, never down, and no finding says it is dead (R11, invariant 4)', async () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:7890' }
  const throws = async () => { throw Object.assign(new Error('boom'), { code: 'EBOOM' }) }
  for (const [label, over] of [['throws', { archFacts: throws }], ['absent', { platform: 'plan9' }]]) {
    const f = await gatherNetFacts({ ...base, env, home: tmpDir('trocar-gather-unread-'), status: status(), ...over })
    const t = buildTopology(f)
    const proxies = Object.values(t).flatMap((x) => (x.nodes || []).filter((n) => n.kind === 'proxy' && n.port === 7890))
    assert.ok(proxies.length > 0, `${label}: the setting's proxy is drawn`)
    for (const n of proxies) {
      assert.ok(!n.down, `${label}: ${JSON.stringify(n)} is not down`)
      assert.ok(n.unknown && n.unknown.reason, `${label}: ${JSON.stringify(n)} says why it is not named`)
    }
    assert.deepEqual(diagnose({ facts: f, topology: t }).filter((x) => x.code === 'proxy-dead'), [], `${label}: no proxy-dead from an unread table`)
  }
})

test('gatherNetFacts: the host\'s linger state and another redirector, the files and keys a harness reads its proxy from (to name the line in a command), and a fake-ip an arch part saw', async () => {
  const home = tmpDir('trocar-gather4-')
  const arch = async () => ({ routing: 'driver', otherRedirector: true, fakeIp: { 'claude-code': true } })
  const f = await gatherNetFacts({ ...base, home, status: { ...status(), linger: { linger: false } }, archFacts: arch })
  assert.deepEqual([f.linger, f.otherRedirector], [false, true])
  assert.deepEqual(f.harnesses['claude-code'].behaviour.fileKeys, [{ path: path.join(home, '.claude', 'settings.json'), format: 'json', key: 'env.HTTPS_PROXY' }, { path: path.join(home, '.claude.json'), format: 'json', key: 'env.HTTPS_PROXY' }])
  assert.deepEqual([f.harnesses['claude-code'].fakeIp, f.harnesses.codex.fakeIp], [true, null])
  const none = await gatherNetFacts({ ...base, home, status: status(), archFacts: async () => ({ routing: 'driver' }) })
  assert.deepEqual([none.linger, none.otherRedirector], [null, null], 'not read: not said')
})

test('gatherNetFacts: the NO_PROXY of the shell names the harness\'s API hosts it covers (a domain suffix, the host, `*`)', async () => {
  const home = tmpDir('trocar-gather5-')
  const env = (v) => gatherNetFacts({ ...base, env: v, home, status: status(), archFacts: async () => ({ routing: 'driver' }) })
  assert.deepEqual((await env({ NO_PROXY: 'localhost,.anthropic.com' })).harnesses['claude-code'].noProxy, ['api.anthropic.com'])
  assert.deepEqual((await env({ no_proxy: '*' })).harnesses['claude-code'].noProxy, ['api.anthropic.com'])
  assert.deepEqual((await env({ NO_PROXY: 'localhost,example.com' })).harnesses['claude-code'].noProxy, [])
  assert.deepEqual((await env({})).harnesses['claude-code'].noProxy, [])
})
