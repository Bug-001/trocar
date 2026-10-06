// test/collector/harness/hermes.test.mjs — the Hermes descriptor (RFC 4.6 §身份与信任 Hermes rows, D37④, acceptance ③): R1
// identification (the bootstrap interpreter, hermes-acp, the TUI gateway children; dependency helpers and probes are
// not the agent), T12 trust through SSL_CERT_FILE in its .env layers (HERMES_CA_BUNDLE judged by the build the
// install stamp names; per-route ssl_ca_cert / ssl_verify; profiles, the checkout .env, the managed .env last), T10
// the sentinel block in every .env with the combined bundle, T11 install → uninstall.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import hermes from '../../../src/collector/harness/hermes.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'
import { planTrust } from '../../../src/collector/core/trust/plan.mjs'
import { installCollector, uninstallCollector } from '../../../src/collector/install.mjs'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { sandbox, ctxFor, facts, judge, matchOf, CA, OTHER } from './_ctx.mjs'

const PY = '/home/u/.hermes/tools/python-3.14.7+20260901-linux-arm64/bin/python3.14'
const boot = (root, entry = "from hermes_cli.main import main\nsys.exit(main())") => `import os, re, sys\nos.environ.pop('PYTHONHOME', None)\nsys.path.insert(0, '${root}')\nimport hermes_bootstrap\n${entry}\n`
const cli = (root, ...args) => ['/home/u/.hermes/tools/python-3.14.7+20260901-linux-arm64/bin/python3', '-I', '-c', boot(root), ...args]
const MAIN_STAMP = JSON.stringify({ schemaVersion: 2, source: 'git', branch: 'main', baseVersion: '0.21.5', tag: null })
const OLD_STAMP = JSON.stringify({ schemaVersion: 2, source: 'release', branch: null, baseVersion: '2026.9.24', tag: 'v2026.9.24' })
const fps = (text) => (String(text).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []).map((p) => new X509Certificate(p).fingerprint256)
const fp = (ca) => new X509Certificate(ca.certPem).fingerprint256

test('hermes: the bootstrap interpreter (hermes and hermes-acp) and the TUI gateway children match; dependency helpers, probes and the sh launcher do not (R1)', () => {
  const root = '/home/u/.hermes/hermes-agent'
  assert.equal(matchOf([hermes], facts({ exe: PY, argv: cli(root, '-z', 'hi') })).agent, 'hermes')
  assert.equal(matchOf([hermes], facts({ exe: `${PY} (deleted)`, argv: cli(root, 'chat') })).agent, 'hermes')
  assert.equal(matchOf([hermes], facts({ exe: PY, argv: ['python3', '-I', '-c', boot(root, 'from acp_adapter.entry import main\nmain()')] })).agent, 'hermes', 'hermes-acp')
  assert.equal(matchOf([hermes], facts({ exe: PY, argv: ['python3', '-I', '-c', "import os, sys, runpy; import hermes_bootstrap; runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)", 'gateway', 'run'] })).agent, 'hermes', 'the runtime command a service unit runs')
  assert.equal(matchOf([hermes], facts({ exe: PY, argv: ['python3', '-X', 'utf8', '-I', '-c', `import sys, runpy; sys.argv = ['hermes']; exec(${JSON.stringify(boot(root))})`, '-z', 'hi'] })).agent, 'hermes', 'the bootstrap relaunching itself with interpreter flags first')
  assert.equal(matchOf([hermes], facts({ exe: PY, argv: ['python3', '-m', 'tui_gateway.entry'] })).agent, 'hermes')
  assert.equal(matchOf([hermes], facts({ exe: PY, argv: ['python3', '-m', 'tui_gateway.slash_worker', '--session-key', 'k', '--parent-pid', '7'] })).agent, 'hermes')
  for (const [exe, argv, why] of [
    [PY, ['python3', '-I', '-B', '-c', 'import packaging, tomli_w, truststore; import hermes_bootstrap'], 'a dependency helper (-I -B -c)'],
    [PY, ['python3', '-I', '-c', 'import hermes_cli.main'], 'a desktop-entry probe: no bootstrap'],
    [PY, ['python3', '-I', '-c', 'import hermes_bootstrap; print(hermes_bootstrap.__file__)'], 'the bootstrap without an entry module'],
    [PY, ['python3', '-c', boot(root)], 'not isolated (-I): not how a launcher starts it'],
    [PY, ['python3', '-c', 'import sys; print(sys.version)'], 'a version probe'],
    [PY, ['python3', '-c', 'watcher', '42', 'gateway', 'run'], 'the gateway restart watcher'],
    [PY, ['python3', '-m', 'tui_gateway.compute_host'], 'not an agent child'],
    ['/usr/bin/dash', ['/bin/sh', '/home/u/.local/bin/hermes', '-z', 'hi'], 'the sh launcher before its exec'],
    ['/usr/bin/python3.12', ['python3', '/srv/hermes_bootstrap.py'], 'some other script'],
  ]) assert.equal(matchOf([hermes], facts({ exe, argv })).agent, null, why)
  const reg = createRegistry([hermes])
  assert.equal(reg.isLongLived(hermes, facts({ exe: PY, argv: cli(root, 'gateway', 'run') })), true)
  assert.equal(reg.isLongLived(hermes, facts({ exe: PY, argv: cli(root, '-z', 'hi') })), false)
})

test('hermes: SSL_CERT_FILE from the profile .env trusts; HERMES_CA_BUNDLE without the CA shadows it on a release build ≤ v2026.9.24 or an unknown one, never on main (T12)', () => {
  const s = sandbox()
  try {
    const root = path.join(s.home, '.hermes', 'hermes-agent')
    const merged = s.put('ca/merged.pem', OTHER.certPem + CA.certPem); const foreign = s.put('ca/other.pem', OTHER.certPem)
    s.put('.hermes/profiles/work/.env', `OPENAI_API_KEY=sk-x\nSSL_CERT_FILE=${merged}\n`)
    const ctx = (env = {}) => ctxFor({ home: s.home, env, argv: cli(root, '-p', 'work', '-z', 'hi') })
    const stamp = (text) => (text == null ? fs.rmSync(path.join(root, 'install-stamp.json'), { force: true }) : s.put(path.join(root, 'install-stamp.json'), text))
    stamp(MAIN_STAMP)
    const ok = judge(hermes, ctx())
    assert.deepEqual([ok.trust.trusted, ok.trust.var], [true, 'SSL_CERT_FILE'])
    assert.match(ok.trust.via, /profiles\/work\/\.env$/)
    assert.equal(judge(hermes, ctx({ HERMES_CA_BUNDLE: foreign })).trust.trusted, true, 'main reads HERMES_CA_BUNDLE for the Nous login only')
    for (const [text, why] of [[OLD_STAMP, 'release v2026.9.24'], [null, 'no install stamp: judged as a release build'], ['{"tag": ', 'an unreadable stamp: judged as a release build']]) {
      stamp(text)
      const shadow = judge(hermes, ctx({ HERMES_CA_BUNDLE: foreign }))
      assert.deepEqual([shadow.trust.trusted, shadow.trust.reason, shadow.trust.var], [false, 'shadowed', 'HERMES_CA_BUNDLE'], why)
      assert.match(shadow.trust.variant, /release/)
      assert.equal(judge(hermes, ctx()).trust.trusted, true, `${why}: SSL_CERT_FILE is read when HERMES_CA_BUNDLE is unset`)
    }
    stamp(JSON.stringify({ tag: 'v2026.10.2', baseVersion: '2026.10.2' }))
    assert.equal(judge(hermes, ctx({ HERMES_CA_BUNDLE: foreign })).trust.trusted, true, 'a later dated release is judged as main')
    s.put('.hermes/profiles/work/.env', `HERMES_CA_BUNDLE=${merged}\n`)
    assert.deepEqual([judge(hermes, ctx()).trust.trusted, judge(hermes, ctx()).trust.reason], [false, 'var-missing'], 'HERMES_CA_BUNDLE alone does not reach the model calls of main')
  } finally { s.done() }
})

test('hermes: every route ssl_ca_cert must hold the CA; any ssl_verify false is verify-disabled; relay hosts from config.yaml and *_BASE_URL (T12, G10)', () => {
  const s = sandbox()
  try {
    const root = path.join(s.home, '.hermes', 'hermes-agent')
    s.put(path.join(root, 'install-stamp.json'), MAIN_STAMP)
    const merged = s.put('ca/merged.pem', OTHER.certPem + CA.certPem); const foreign = s.put('ca/other.pem', OTHER.certPem)
    s.put('.hermes/.env', `SSL_CERT_FILE=${merged}\nOPENROUTER_BASE_URL=https://or-relay.example.com/api/v1\n`)
    s.put('.hermes/config.yaml', `model:\n  provider: custom\n  base_url: https://relay.example.com/v1\nproviders:\n  lab:\n    api: https://lab.example.com/v1\n    ssl_ca_cert: ${merged}\ncustom_providers:\n  - name: corp\n    base_url: https://corp.example.com/v1\n    ssl_ca_cert: ${foreign}\n`)
    const r = judge(hermes, ctxFor({ home: s.home, argv: cli(root, '-z', 'hi') }))
    assert.deepEqual([r.trust.trusted, r.trust.reason, r.trust.file], [false, 'replace-without-ca', foreign])
    assert.deepEqual(r.hosts.sort(), ['corp.example.com', 'lab.example.com', 'or-relay.example.com', 'relay.example.com'])
    s.put('.hermes/config.yaml', `providers:\n  lab:\n    api: https://relay.example.com/v1\n    ssl_ca_cert: ${merged}\n`)
    assert.equal(judge(hermes, ctxFor({ home: s.home, argv: cli(root, '-z', 'hi') })).trust.trusted, true, 'every route with the CA')
    s.put('.hermes/config.yaml', `providers:\n  lab:\n    api: https://relay.example.com/v1\n    ssl_verify: false\n`)
    assert.equal(judge(hermes, ctxFor({ home: s.home, argv: cli(root, '-z', 'hi') })).trust.reason, 'verify-disabled')
    assert.deepEqual(judge(hermes, ctxFor({ home: s.home, argv: cli(root, '-z', 'hi'), env: { HTTPS_PROXY: 'socks5://127.0.0.1:1080' } })).proxies, ['socks5://127.0.0.1:1080'])
  } finally { s.done() }
})

test('hermes: sticky active_profile picks the home; the checkout .env only fills; the managed .env wins last; a CLI and a gateway are judged by when their .env value appeared (review 3 #3)', () => {
  const s = sandbox()
  try {
    const root = path.join(s.home, '.hermes', 'hermes-agent')
    s.put(path.join(root, 'install-stamp.json'), MAIN_STAMP)
    const merged = s.put('ca/merged.pem', OTHER.certPem + CA.certPem); const foreign = s.put('ca/other.pem', OTHER.certPem)
    s.put('.hermes/active_profile', 'dev\n')
    s.put('.hermes/profiles/dev/.env', 'OPENROUTER_BASE_URL=https://or-relay.example.com/api/v1\n')
    s.put(path.join(root, '.env'), `SSL_CERT_FILE=${merged}\nOPENROUTER_BASE_URL=https://ignored.example.com\n`)
    const r = judge(hermes, ctxFor({ home: s.home, argv: cli(root, '-z', 'hi') }))
    assert.deepEqual([r.trust.trusted, r.trust.via], [true, 'hermes checkout .env'])
    assert.ok(r.hosts.includes('or-relay.example.com') && !r.hosts.includes('ignored.example.com'))
    const managed = s.put('managed/.env', `SSL_CERT_FILE=${foreign}\n`)
    const m = judge(hermes, ctxFor({ home: s.home, env: { HERMES_MANAGED_DIR: path.dirname(managed) }, argv: cli(root, '-z', 'hi') }))
    assert.deepEqual([m.trust.trusted, m.trust.reason], [false, 'ca-not-in-file'])
    const early = Date.now() - 60000 // started before the .env held the value
    assert.equal(judge(hermes, ctxFor({ home: s.home, argv: cli(root, '-z', 'hi'), startedAt: early })).trust.reason, 'config-after-start')
    assert.equal(judge(hermes, ctxFor({ home: s.home, argv: cli(root, 'gateway', 'run'), startedAt: early })).trust.reason, 'config-after-start', 'a gateway may multiplex (the default, settled at its boot): it never re-reads .env')
    assert.equal(judge(hermes, ctxFor({ home: s.home, argv: ['python3', '-m', 'tui_gateway.entry'], env: { HERMES_HOME: path.join(s.home, '.hermes', 'profiles', 'dev') } })).trust.trusted, true, 'the TUI child: the default checkout')
    const alt = path.join(s.home, 'src', 'hermes-agent'); s.put(path.join(alt, '.env'), `SSL_CERT_FILE=${foreign}\n`); s.put(path.join(alt, 'install-stamp.json'), MAIN_STAMP)
    assert.equal(judge(hermes, ctxFor({ home: s.home, argv: ['python3', '-m', 'tui_gateway.entry'], env: { HERMES_PYTHON_SRC_ROOT: alt, HERMES_HOME: path.join(s.home, '.hermes', 'profiles', 'dev') } })).trust.reason, 'ca-not-in-file', 'the TUI child finds its checkout in HERMES_PYTHON_SRC_ROOT')
  } finally { s.done() }
})

const planFor = (s, env = {}, running = []) => {
  const dir = path.join(s.home, '.asight', 'collector')
  return planTrust({ descriptors: [hermes], ctxFor: () => ({ os: 'none', home: s.home, env: new Map(Object.entries(env)), running: running.map((e) => new Map(Object.entries(e))), collectorDir: dir, caPem: path.join(dir, 'ca', 'asight-ca.pem'), readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }, readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } }, listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } } }), caCertPem: CA.certPem, collectorDir: dir, roots: { node: [], osText: '' } })
}

test('hermes inject: a sentinel block with SSL_CERT_FILE=combined-hermes.pem atop the home .env and every profile .env; HERMES_CA_BUNDLE only for a release ≤ v2026.9.24; the bundle carries the CAs the block covers (T10, T14)', () => {
  const s = sandbox()
  try {
    const none = planFor(s)
    assert.deepEqual([none.entries, none.files, none.records.map((r) => r.code)], [[], [], ['harness-note']], 'no ~/.hermes: nothing written, said why')
    const corp = s.put('corp.pem', OTHER.certPem)
    const SHELL = createCa({ commonName: 'exported in the install shell' })
    const shellCa = s.put('shell.pem', SHELL.certPem)
    s.put('.hermes/.env', `OPENAI_API_KEY=sk-secret\nSSL_CERT_FILE="${corp}"\n`)
    s.put('.hermes/profiles/work/.env', 'X=1\n'); fs.mkdirSync(path.join(s.home, '.hermes/profiles/empty'), { recursive: true })
    s.put('.hermes/hermes-agent/install-stamp.json', MAIN_STAMP)
    const dir = path.join(s.home, '.asight', 'collector')
    const bundle = path.join(dir, 'ca', 'combined-hermes.pem')
    const p = planFor(s, { SSL_CERT_FILE: shellCa }, [{ SSL_CERT_FILE: bundle }, { HERMES_CA_BUNDLE: 'rel.pem' }])
    assert.deepEqual(p.entries.map((e) => [e.path, e.format, e.vars]), [[path.join(s.home, '.hermes/.env'), 'dotenv-block', { SSL_CERT_FILE: bundle }], [path.join(s.home, '.hermes/profiles/work/.env'), 'dotenv-block', { SSL_CERT_FILE: bundle }]])
    assert.deepEqual([p.files.length, p.files[0].path, p.files[0].role, p.files[0].sources], [1, bundle, 'bundle', [corp, shellCa]], 'the .env value and the install shell value it covers; never asight\'s own bundle')
    assert.deepEqual(fps(p.files[0].data), [fp(OTHER), fp(SHELL), fp(CA)])
    assert.deepEqual(p.records.map((r) => r.code), ['relative-path'], "asight's own bundle in a running hermes's environ is not a source (nothing unreadable)")
    assert.match(p.records[0].reason, /rel\.pem/)
    const managed = s.put('etc-hermes/.env', `SSL_CERT_FILE=${corp}\n`)
    assert.ok(planFor(s, { HERMES_MANAGED_DIR: path.dirname(managed) }).records.some((r) => r.code === 'harness-note' && r.reason.includes(`${managed} sets SSL_CERT_FILE`)), 'the managed .env that wins over the block is named')
    s.put('.hermes/hermes-agent/install-stamp.json', OLD_STAMP)
    assert.deepEqual(planFor(s).entries[0].vars, { SSL_CERT_FILE: bundle, HERMES_CA_BUNDLE: bundle }, 'a release v2026.9.24 reads HERMES_CA_BUNDLE first')
    s.put('.hermes/hermes-agent/install-stamp.json', MAIN_STAMP)
    const alt = planFor(s, { HERMES_HOME: path.join(s.home, '.hermes', 'profiles', 'work') })
    assert.equal(alt.entries.length, 2, 'HERMES_HOME naming a profile: its root is still the one written')
  } finally { s.done() }
})

test('hermes inject: the CA settings of .op.env and of the checkout .env, which the block puts out of effect, are merged too; a home .env asight creates is said to turn the checkout .env into a fill (review 3 #2)', () => {
  const s = sandbox()
  try {
    const A = createCa({ commonName: 'in .op.env' }); const B = createCa({ commonName: 'in the checkout .env' }); const C = createCa({ commonName: 'in a TUI child\'s checkout' })
    const opCa = s.put('op.pem', A.certPem); const coCa = s.put('co.pem', B.certPem); const altCa = s.put('alt.pem', C.certPem)
    s.put('.hermes/hermes-agent/install-stamp.json', MAIN_STAMP)
    s.put('.hermes/.op.env', `SSL_CERT_FILE=${opCa}\n`)
    s.put('.hermes/hermes-agent/.env', `HERMES_CA_BUNDLE=${coCa}\nOPENROUTER_BASE_URL=https://relay.example.com\n`)
    const alt = path.join(s.home, 'src', 'hermes-agent'); s.put(path.join(alt, '.env'), `SSL_CERT_FILE=${altCa}\n`)
    s.put('.hermes/profiles/work/.env', 'X=1\n')
    const p = planFor(s, {}, [{ HERMES_PYTHON_SRC_ROOT: alt }])
    assert.deepEqual(p.files[0].sources, [opCa, coCa, altCa])
    assert.deepEqual(fps(p.files[0].data), [fp(A), fp(B), fp(C), fp(CA)])
    const flip = p.records.filter((r) => /as a fill instead of an override/.test(r.reason))
    assert.equal(flip.length, 1)
    assert.ok(flip[0].reason.replace(/^hermes: /, '').startsWith(`${path.join(s.home, '.hermes/.env')} does not exist`) && flip[0].reason.includes(path.join(s.home, '.hermes/hermes-agent/.env')), 'only the home .env asight creates; the profile .env exists')
    s.put('.hermes/.env', 'Y=1\n')
    assert.ok(!planFor(s).records.some((r) => /as a fill instead of an override/.test(r.reason)), 'nothing flips when the home .env is there')
    fs.rmSync(path.join(s.home, '.hermes/.env')); fs.rmSync(path.join(s.home, '.hermes/hermes-agent/.env'))
    assert.ok(!planFor(s).records.some((r) => /as a fill instead of an override/.test(r.reason)), 'nor without a checkout .env')
  } finally { s.done() }
})

test('hermes through install / uninstall: the user\'s SSL_CERT_FILE line is put out of effect and merged, then comes back byte for byte; the bundle goes (T11, S10)', async () => {
  const s = sandbox()
  try {
    const corp = s.put('corp.pem', OTHER.certPem)
    const before = `OPENAI_API_KEY=sk-secret\nSSL_CERT_FILE=${corp}\n`
    const env = s.put('.hermes/.env', before)
    s.put('.hermes/hermes-agent/install-stamp.json', MAIN_STAMP)
    await installCollector({ home: s.home, env: { HOME: s.home }, osName: 'none', harnesses: [hermes], freePort: async () => 47015, roots: { node: [], osText: '' } })
    const dir = path.join(s.home, '.asight', 'collector')
    const bundle = path.join(dir, 'ca', 'combined-hermes.pem')
    const now = fs.readFileSync(env, 'utf8')
    assert.match(now, new RegExp(`^# >>> asight collector >>>[^\\n]*\\nSSL_CERT_FILE=${bundle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n# <<< asight collector <<<\\nOPENAI_API_KEY=sk-secret\\n#asight-collector-off# SSL_CERT_FILE=`))
    const asightCa = fs.readFileSync(path.join(dir, 'ca', 'asight-ca.pem'), 'utf8')
    assert.deepEqual(fps(fs.readFileSync(bundle, 'utf8')), [fp(OTHER), ...fps(asightCa)])
    assert.ok(!fs.readFileSync(path.join(dir, 'install-manifest.json'), 'utf8').includes('sk-secret'))
    const root = path.join(s.home, '.hermes', 'hermes-agent')
    const installed = { caCertPem: asightCa }
    assert.equal(judge(hermes, ctxFor({ home: s.home, argv: cli(root, '-z', 'hi') }), installed).trust.trusted, true, 'a hermes started after install trusts the block')
    assert.equal(judge(hermes, ctxFor({ home: s.home, argv: cli(root, 'gateway', 'run'), startedAt: Date.now() - 60000 }), installed).trust.reason, 'config-after-start', 'a gateway from before install is not trusted on the block (it may multiplex; review 3 #3)')
    // the user adds the same key below asight's block (lab ③: the later line wins): that hermes is untrusted, said why
    fs.appendFileSync(env, `SSL_CERT_FILE=${corp}\n`)
    const below = judge(hermes, ctxFor({ home: s.home, argv: cli(root, '-z', 'hi') }), installed)
    assert.deepEqual([below.trust.trusted, below.trust.reason, below.trust.var], [false, 'ca-not-in-file', 'SSL_CERT_FILE'], 'T12: a same-name line below the block hides it')
    fs.writeFileSync(env, now)
    // a Hermes from before install that is still running may build a new TLS context: the bundle is kept for it
    const early = { os: 'linux', pid: 77, exe: PY, argv: cli(path.join(s.home, '.hermes', 'hermes-agent'), '-z', 'hi'), startedAt: 0, env: new Map() }
    const match = (f) => createRegistry([hermes]).match(f)
    const r = await uninstallCollector({ home: s.home, env: {}, stop: async () => 'none', harnesses: [hermes], roots: { node: [], osText: '' }, scan: async () => [early], match })
    assert.deepEqual([r.kept_bundles.map((k) => k.pids), r.still_trusting.map((x) => x.until)], [[[77]], ['next-handshake']])
    assert.deepEqual(fps(fs.readFileSync(bundle, 'utf8')), [fp(OTHER)], 'kept without the asight CA')
    assert.deepEqual((await uninstallCollector({ home: s.home, env: {}, stop: async () => 'none', harnesses: [hermes], roots: { node: [], osText: '' } })).kept_bundles, [])
    assert.deepEqual(r.entries.map((e) => e.result), ['restored'])
    assert.equal(fs.readFileSync(env, 'utf8'), before)
    assert.ok(!fs.existsSync(bundle))
  } finally { s.done() }
})

test('hermes after uninstall: Linux main re-reads the bundle at its next handshake; a release build, one without a stamp, and macOS trust until restart (4.6 step 5, review 3 #6)', () => {
  const s = sandbox()
  try {
    const au = hermes.trust.afterUninstall
    const root = path.join(s.home, '.hermes', 'hermes-agent')
    const f = (o = {}) => ({ os: 'linux', exe: PY, argv: cli(root, '-z', 'hi'), env: new Map(), ...o })
    const ctx = { readText: (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }, home: s.home }
    assert.equal(au(f(), ctx), 'restart', 'no install stamp: judged as a release')
    s.put(path.join(root, 'install-stamp.json'), MAIN_STAMP)
    assert.equal(au(f(), ctx), 'next-handshake')
    assert.equal(au(f({ os: 'darwin' }), ctx), 'restart')
    assert.equal(au(f({ argv: ['python3', '-m', 'tui_gateway.entry'] }), ctx), 'next-handshake', 'the TUI child: the default checkout under this home')
    const alt = path.join(s.home, 'src', 'hermes-agent'); s.put(path.join(alt, 'install-stamp.json'), OLD_STAMP)
    assert.equal(au(f({ argv: ['python3', '-m', 'tui_gateway.entry'], env: new Map([['HERMES_PYTHON_SRC_ROOT', alt]]) }), ctx), 'restart', 'its own checkout is a release')
  } finally { s.done() }
})
