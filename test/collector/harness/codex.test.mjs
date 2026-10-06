// test/collector/harness/codex.test.mjs — the Codex descriptor (RFC 4.6 §身份与信任 Codex rows, D37④): R1 (the native
// binary and the managed app-server daemon; the Node launcher, arg0 helpers and the updater are not the agent), T12
// ($CODEX_HOME/.env believed only when it held the value at start, CODEX_* keys dropped, SSL_CERT_FILE and a shell
// CODEX_CA_CERTIFICATE both count — acceptance ①), relay hosts from config.toml, the Responses terminal messages as data, T10 / T14 the sentinel block in
// every Codex home's .env with combined-codex.pem, T11 install → uninstall.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import codex from '../../../src/collector/harness/codex.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'
import { planTrust } from '../../../src/collector/core/trust/plan.mjs'
import { installCollector, uninstallCollector } from '../../../src/collector/install.mjs'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { sandbox, ctxFor, facts, judge, matchOf, CA, OTHER } from './_ctx.mjs'
import { onNone } from '../../helpers/signature-os.mjs'

const DAEMON = '/home/u/.codex/packages/app-server-daemon/releases/0.160.0/bin/codex'
const fps = (text) => (String(text).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []).map((p) => new X509Certificate(p).fingerprint256)
const fp = (ca) => new X509Certificate(ca.certPem).fingerprint256

test('codex: the native binary and the managed daemon match; the Node launcher, arg0 helpers and the updater do not (R1)', () => {
  assert.equal(matchOf([codex], facts({ exe: '/usr/local/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex', argv: ['codex', 'exec', 'hi'] })).agent, 'codex')
  assert.equal(matchOf([codex], facts({ exe: `${DAEMON} (deleted)`, argv: [DAEMON, 'app-server', '--listen', 'unix://', '--managed-daemon'] })).agent, 'codex')
  assert.equal(matchOf([codex], facts({ exe: '/usr/local/bin/node', argv: ['node', '/usr/local/bin/codex', 'exec'] })).agent, null)
  for (const argv of [['codex-linux-sandbox', '--'], ['apply_patch'], ['/tmp/x/codex-execve-wrapper', 'bash'], ['codex', '--codex-run-as-apply-patch'], [DAEMON, 'app-server', 'daemon', 'pid-update-loop']]) {
    assert.equal(matchOf([codex], facts({ exe: DAEMON, argv })).reason, 'excluded', argv.join(' '))
  }
  const reg = createRegistry([codex])
  assert.equal(reg.isLongLived(codex, facts({ exe: DAEMON, argv: [DAEMON, 'app-server', '--managed-daemon'] })), true)
  assert.equal(reg.isLongLived(codex, facts({ exe: DAEMON, argv: ['codex', 'exec', 'hi'] })), false)
})

test('codex: $CODEX_HOME/.env SSL_CERT_FILE is believed only when it was there at start; CODEX_* keys are dropped; a CODEX_HOME in the env moves it (T12)', () => {
  const s = sandbox()
  try {
    const merged = s.put('ca/merged.pem', OTHER.certPem + CA.certPem); const only = s.put('ca/asight.pem', CA.certPem)
    s.put('.codex/.env', `SSL_CERT_FILE=${merged}\nCODEX_CA_CERTIFICATE=${only}\nHTTPS_PROXY=https://proxy.example.com:8443\n`)
    const ok = judge(codex, ctxFor({ home: s.home, startedAt: Date.now() + 60_000 }))
    assert.deepEqual([ok.trust.trusted, ok.trust.var, ok.trust.via], [true, 'SSL_CERT_FILE', '$CODEX_HOME/.env'])
    assert.equal(ok.layers[0].vars.CODEX_CA_CERTIFICATE, undefined, 'Codex drops every CODEX_* key from its .env')
    assert.ok(ok.proxies.includes('https://proxy.example.com:8443'))
    assert.deepEqual([judge(codex, ctxFor({ home: s.home, startedAt: 1 })).trust.reason], ['config-after-start'])
    s.put('alt/.env', `SSL_CERT_FILE=${s.put('ca/other.pem', OTHER.certPem)}\n`)
    assert.equal(judge(codex, ctxFor({ home: s.home, env: { CODEX_HOME: path.join(s.home, 'alt') } })).trust.reason, 'ca-not-in-file')
  } finally { s.done() }
})

test('codex: SSL_CERT_FILE and a shell CODEX_CA_CERTIFICATE both count — one without the CA never hides the other (T12, acceptance ①: Codex trusts both)', () => {
  const s = sandbox()
  try {
    const only = s.put('ca/asight.pem', CA.certPem); const foreign = s.put('ca/other.pem', OTHER.certPem)
    const merged = s.put('ca/merged.pem', OTHER.certPem + CA.certPem)
    const at = (env) => judge(codex, ctxFor({ home: s.home, env, startedAt: Date.now() + 60_000 })).trust
    assert.deepEqual([at({ SSL_CERT_FILE: foreign, CODEX_CA_CERTIFICATE: only }).trusted, at({ SSL_CERT_FILE: foreign, CODEX_CA_CERTIFICATE: only }).var], [true, 'CODEX_CA_CERTIFICATE'])
    assert.deepEqual([at({ SSL_CERT_FILE: foreign }).trusted, at({ SSL_CERT_FILE: foreign }).reason], [false, 'ca-not-in-file'])
    s.put('.codex/.env', `SSL_CERT_FILE=${merged}\n`)
    const r = at({ CODEX_CA_CERTIFICATE: foreign })
    assert.deepEqual([r.trusted, r.reason, r.var, r.via], [true, 'ok', 'SSL_CERT_FILE', '$CODEX_HOME/.env'], 'the shell CODEX_CA_CERTIFICATE adds a CA, it does not hide the .env bundle')
    s.put('.codex/.env', `SSL_CERT_FILE=${foreign}\n`)
    assert.deepEqual([at({ CODEX_CA_CERTIFICATE: foreign }).trusted, at({ CODEX_CA_CERTIFICATE: foreign }).reason], [false, 'ca-not-in-file'], 'neither holds it: untrusted')
    assert.equal((codex.trust.hints || {}).shadowed, undefined, 'no shadowing to explain')
  } finally { s.done() }
})

test('codex: relay hosts come from the system, user and profile config.toml, not OPENAI_BASE_URL; the Responses terminal messages are data', () => {
  const s = sandbox()
  try {
    s.put('.codex/config.toml', 'openai_base_url = "https://relay.example.com/v1"\n[model_providers.mock]\nbase_url = "http://mock.asight.test:8443/v1"\n')
    s.put('.codex/fast.config.toml', '[model_providers.alt]\nbase_url = "https://alt.example.com/v1"\n')
    const r = judge(codex, ctxFor({ home: s.home, env: { OPENAI_BASE_URL: 'https://ignored.example.com' }, argv: ['codex', '--profile', 'fast'] }))
    assert.deepEqual(r.hosts.sort(), ['alt.example.com', 'mock.asight.test', 'relay.example.com'])
    const [t] = codex.wsTerminal
    const re = new RegExp(t.patterns[0])
    assert.equal(t.pathSuffix, '/responses')
    for (const m of ['{"type":"response.completed","response":{}}', '{"type":"response.failed"}', '{"type":"response.incomplete"}', '{"type":"error","error":{}}']) assert.ok(re.test(m), m)
    assert.ok(!re.test('{"type":"response.output_text.delta","delta":"x"}'))
  } finally { s.done() }
})

const planFor = (s, env = {}, running = []) => {
  const dir = path.join(s.home, '.asight', 'collector')
  return planTrust({ descriptors: [codex], ctxFor: () => ({ os: 'none', home: s.home, env: new Map(Object.entries(env)), running: running.map((e) => new Map(Object.entries(e))), collectorDir: dir, caPem: path.join(dir, 'ca', 'asight-ca.pem'), readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }, readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } }, listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } } }), caCertPem: CA.certPem, collectorDir: dir, roots: { node: [], osText: '' } })
}

test('codex inject: a block with SSL_CERT_FILE=combined-codex.pem atop the .env of every Codex home in use; the bundle carries the SSL_CERT_FILE CAs it overrides; a shell CODEX_CA_CERTIFICATE needs no note (T10, T14)', () => {
  const s = sandbox()
  try {
    const none = planFor(s)
    assert.deepEqual([none.entries, none.files, none.records.map((r) => r.code)], [[], [], ['harness-note']], 'no Codex home: nothing written, said why')
    const SHELL = createCa({ commonName: 'SSL_CERT_FILE of the install shell' })
    const corp = s.put('corp.pem', OTHER.certPem); const shell = s.put('shell.pem', SHELL.certPem)
    s.put('.codex/.env', `OPENAI_API_KEY=sk-secret\nSSL_CERT_FILE=${corp}\n`)
    s.put('work/codex-home/config.toml', 'model = "m"\n')
    const dir = path.join(s.home, '.asight', 'collector')
    const bundle = path.join(dir, 'ca', 'combined-codex.pem')
    const p = planFor(s, { SSL_CERT_FILE: shell, CODEX_CA_CERTIFICATE: corp }, [{ CODEX_HOME: path.join(s.home, 'work/codex-home'), SSL_CERT_FILE: bundle }, { CODEX_HOME: path.join(s.home, 'gone') }])
    assert.deepEqual(p.entries.map((e) => [e.path, e.format, e.vars]), [[path.join(s.home, '.codex/.env'), 'dotenv-block', { SSL_CERT_FILE: bundle }], [path.join(s.home, 'work/codex-home/.env'), 'dotenv-block', { SSL_CERT_FILE: bundle }]], 'the default home and a running codex\'s CODEX_HOME; never a home that is not there')
    assert.deepEqual([p.files[0].path, p.files[0].role, p.files[0].sources], [bundle, 'bundle', [corp, shell]], 'the .env line it puts out of effect, the install shell; never asight\'s own bundle')
    assert.deepEqual(fps(p.files[0].data), [fp(OTHER), fp(SHELL), fp(CA)])
    assert.ok(p.records.some((r) => /gone/.test(r.reason)), 'a CODEX_HOME that does not exist is named')
    assert.ok(!p.records.some((r) => /CODEX_CA_CERTIFICATE/.test(r.reason)), 'it adds to the store, it does not keep a codex from being captured: no note')
    assert.ok(!p.records.some((r) => r.code === 'source-unreadable'))
  } finally { s.done() }
})

test('codex through install / uninstall: the user\'s SSL_CERT_FILE line is put out of effect and merged, then comes back byte for byte; the bundle is kept for a live codex, then goes (T11, S10)', async () => {
  const s = sandbox()
  try {
    const corp = s.put('corp.pem', OTHER.certPem)
    const before = `OPENAI_API_KEY=sk-secret\nexport SSL_CERT_FILE="${corp}"\n`
    const env = s.put('.codex/.env', before)
    await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [onNone(codex)], freePort: async () => 47017, roots: { node: [], osText: '' } })
    const dir = path.join(s.home, '.asight', 'collector')
    const bundle = path.join(dir, 'ca', 'combined-codex.pem')
    assert.match(fs.readFileSync(env, 'utf8'), new RegExp(`^# >>> asight collector >>>[^\\n]*\\nSSL_CERT_FILE=${bundle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n# <<< asight collector <<<\\nOPENAI_API_KEY=sk-secret\\n#asight-collector-off# export SSL_CERT_FILE=`))
    assert.deepEqual(fps(fs.readFileSync(bundle, 'utf8')), [fp(OTHER), ...fps(fs.readFileSync(path.join(dir, 'ca', 'asight-ca.pem'), 'utf8'))])
    assert.ok(!fs.readFileSync(path.join(dir, 'install-manifest.json'), 'utf8').includes('sk-secret'))
    // the .env is applied once, at start: a codex from before install never named the bundle; one started after did
    const old = { os: 'linux', pid: 98, exe: DAEMON, argv: [DAEMON, 'app-server', '--managed-daemon'], env: new Map(), startedAt: 0 }
    const live = { os: 'linux', pid: 99, exe: DAEMON, argv: [DAEMON, 'app-server', '--managed-daemon'], env: new Map(), startedAt: Date.now() + 1000 }
    const r = await uninstallCollector({ home: s.home, env: {}, stop: async () => 'none', roots: { node: [], osText: '' }, scan: async () => [old, live] })
    assert.deepEqual([r.entries.map((e) => e.result), r.kept_bundles.map((k) => k.pids), r.still_trusting], [['restored'], [[99]], [{ pid: 99, agent: 'codex', until: 'next-connection' }]])
    assert.equal(fs.readFileSync(env, 'utf8'), before)
    assert.deepEqual((await uninstallCollector({ home: s.home, env: {}, stop: async () => 'none', roots: { node: [], osText: '' } })).kept_bundles, [])
    assert.ok(!fs.existsSync(bundle))
  } finally { s.done() }
})

test('codex: a provider in an inline table and a [profiles.<name>] table name relay hosts; a config.toml asight cannot fully read is reported (D38, review 4 #4 #6)', () => {
  const s = sandbox()
  try {
    const cfg = s.put('.codex/config.toml', 'profile = "work"\nmodel_providers = { relay = { base_url = "https://inline.example.com/v1" } }\n[profiles.work]\nopenai_base_url = "https://work.example.com/v1"\n[profiles.home]\nopenai_base_url = "https://home.example.com/v1"\n')
    const seen = []
    const r = judge(codex, ctxFor({ home: s.home, argv: ['codex'], unparsable: (f) => seen.push(f) }))
    assert.deepEqual(r.hosts.sort(), ['inline.example.com', 'work.example.com'], 'the selected profile only')
    assert.deepEqual(seen, [], 'a file it reads in full is not reported')
    s.put('.codex/config.toml', 'openai_base_url = "https://relay.example.com/v1"\n[[skills]]\nopenai_base_url = "https://hidden.example.com"\n')
    const r2 = judge(codex, ctxFor({ home: s.home, argv: ['codex'], unparsable: (f) => seen.push(f) }))
    assert.deepEqual([r2.hosts, seen], [['relay.example.com'], [cfg]])
  } finally { s.done() }
})

test('codex: a same-name SSL_CERT_FILE line the user adds below asight\'s block wins (last wins, as the resolver reads it): that codex is untrusted (T12, review 4 #5)', async () => {
  const s = sandbox()
  try {
    const corp = s.put('corp.pem', OTHER.certPem)
    const env = s.put('.codex/.env', 'OPENAI_API_KEY=sk-secret\n')
    await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [codex], freePort: async () => 47018, roots: { node: [], osText: '' } })
    const installed = { caCertPem: fs.readFileSync(path.join(s.home, '.asight', 'collector', 'ca', 'asight-ca.pem'), 'utf8') }
    assert.equal(judge(codex, ctxFor({ home: s.home, argv: ['codex'] }), installed).trust.trusted, true)
    fs.appendFileSync(env, `SSL_CERT_FILE=${corp}\n`)
    const r = judge(codex, ctxFor({ home: s.home, argv: ['codex'] }), installed)
    assert.deepEqual([r.trust.trusted, r.trust.reason, r.trust.var], [false, 'ca-not-in-file', 'SSL_CERT_FILE'])
  } finally { s.done() }
})
