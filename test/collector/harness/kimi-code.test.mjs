// test/collector/harness/kimi-code.test.mjs — the Kimi Code descriptor (RFC 4.6 §身份与信任 Kimi rows, D37④, acceptance ③ / ⑦):
// R1 identification (the single-executable app by exe, the npm build by its argv at exec; same-exe helpers, the shim
// and the older Python kimi are not the agent), its relay hosts, T12 trust through the shim-set NODE_EXTRA_CA_CERTS
// with the reason named when it is missing, T10 the shim + rc lines (only when the binary and the installer's PATH
// line exist), and T11 install → uninstall with the shim actually run.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import kimi from '../../../src/collector/harness/kimi-code.mjs'
import { planTrust } from '../../../src/collector/core/trust/plan.mjs'
import { installCollector } from '../../../src/collector/install.mjs'
import { uninstallCollector } from '../../helpers/uninstall.mjs'
import { sandbox, ctxFor, facts, judge, matchOf, CA, OTHER } from './_ctx.mjs'

const SEA = '/home/u/.kimi-code/bin/kimi'
const NPM_MAIN = '/usr/local/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs'
const fps = (text) => (String(text).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []).map((p) => new X509Certificate(p).fingerprint256)
const fp = (ca) => new X509Certificate(ca.certPem).fingerprint256
const INSTALLER = '# kimi-code\nexport PATH="$HOME/.kimi-code/bin:$PATH"\n'

test('kimi-code: the single-executable app matches by exe (its title is rewritten); the npm build by argv at exec; helpers, the shim and the Python kimi do not (R1)', () => {
  assert.equal(matchOf([kimi], facts({ exe: SEA, argv: ['kimi-code'] })).agent, 'kimi-code', 'argv already rewritten to the title (acceptance ③)')
  assert.equal(matchOf([kimi], facts({ exe: `${SEA} (deleted)`, argv: ['kimi-code'] })).agent, 'kimi-code', 'replaced by an update while running')
  assert.equal(matchOf([kimi], facts({ exe: SEA, argv: [SEA, '-p', 'hi'] })).agent, 'kimi-code')
  assert.equal(matchOf([kimi], facts({ exe: '/usr/bin/node', argv: ['node', '/usr/local/bin/kimi', '-p', 'hi'] })).agent, 'kimi-code', 'the npm bin symlink run through #!/usr/bin/env node')
  assert.equal(matchOf([kimi], facts({ exe: '/usr/bin/node', argv: ['node', NPM_MAIN] })).agent, 'kimi-code')
  // the title is on the list (4.6 Kimi row, review R20): an npm build scanned only after it retitled itself — a rescan on Linux, the accept-time ps on
  // macOS — is still kimi-code (and is then told kimi-npm-no-shim, below)
  assert.equal(matchOf([kimi], facts({ exe: '/usr/bin/node', argv: ['kimi-code'] })).agent, 'kimi-code', 'the npm build seen only after its title rewrite')
  assert.equal(matchOf([kimi], { ...facts({ exe: '/opt/homebrew/bin/node', argv: ['kimi-code'] }), os: 'darwin', argvSplit: true, env: null, envRead: false }).agent, 'kimi-code', 'the darwin shape of it')
  for (const [exe, argv, why] of [
    [SEA, [SEA, '__update_download', '2.1.2'], 'the background update download'],
    [SEA, [SEA, '__plugin_run_node', '/p/server.js'], "a plugin's MCP server"],
    ['/usr/bin/dash', ['/bin/sh', '/home/u/.trocar/collector/bin/kimi', '-p', 'hi'], "trocar's shim itself"],
    ['/usr/bin/env', ['env', 'NODE_EXTRA_CA_CERTS=/x.pem', `${SEA}`, '-p'], 'the env exec inside the shim'],
    ['/usr/bin/python3.12', ['python3', '/home/u/.local/bin/kimi'], 'the older Python kimi-cli'],
    ['/usr/bin/node', ['node', '/srv/app/kimi.js'], 'some other node script'],
  ]) assert.equal(matchOf([kimi], facts({ exe, argv })).agent, null, why)
})

test('kimi-code: relay hosts from config.toml (providers, models, services, a provider env table) and the KIMI_* env; proxies from the env', () => {
  const s = sandbox()
  try {
    s.put('.kimi-code/config.toml', [
      'default_model = "m"',
      '[providers.p]', 'type = "kimi"', 'base_url = "https://prov.example.com/v1"', "env = { OPENAI_BASE_URL = 'https://inline.example.com/v1' }",
      '[providers.q.env]', 'ANTHROPIC_BASE_URL = "https://penv.example.com"',
      '[models.m]', 'provider = "p"', 'base_url = "https://model.example.com"',
      '[services.moonshot_search]', 'base_url = "https://search.example.com"',
      '# base_url = "https://commented.example.com"', '',
    ].join('\n'))
    const r = judge(kimi, ctxFor({ home: s.home, env: { KIMI_MODEL_NAME: 'x', KIMI_MODEL_BASE_URL: 'https://envmodel.example.com/v1', KIMI_CODE_BASE_URL: 'https://managed.example.com/coding/v1', HTTPS_PROXY: 'http://px.example.com:3128', ALL_PROXY: 'socks5://127.0.0.1:1080' } }))
    assert.deepEqual(r.hosts.sort(), ['envmodel.example.com', 'inline.example.com', 'managed.example.com', 'model.example.com', 'penv.example.com', 'prov.example.com', 'search.example.com'])
    assert.deepEqual(r.proxies.sort(), ['http://px.example.com:3128', 'socks5://127.0.0.1:1080'])
    assert.ok(!judge(kimi, ctxFor({ home: s.home, env: { KIMI_MODEL_BASE_URL: 'https://envmodel.example.com/v1' } })).hosts.includes('envmodel.example.com'), 'the env model needs KIMI_MODEL_NAME')
    s.put('alt/config.toml', 'base_url = "https://alt.example.com"\n')
    assert.deepEqual(judge(kimi, ctxFor({ home: s.home, env: { KIMI_CODE_HOME: path.join(s.home, 'alt') } })).hosts, ['alt.example.com'], 'KIMI_CODE_HOME moves config.toml')
  } finally { s.done() }
})

test('kimi-code: the shim-set NODE_EXTRA_CA_CERTS trusts; without it the reason says why — not via the shim, no shim installed, the npm build (T12)', () => {
  const s = sandbox()
  try {
    const dir = path.join(s.home, '.trocar', 'collector')
    const pem = s.put('.trocar/collector/ca/trocar-ca.pem', CA.certPem)
    const extra = s.put('.trocar/collector/ca/extra-kimi.pem', OTHER.certPem + CA.certPem)
    const why = (env, { exe = SEA, argv = ['kimi-code'] } = {}) => judge(kimi, ctxFor({ home: s.home, env, argv }), { exe, collectorDir: dir }).trust
    assert.deepEqual([why({ NODE_EXTRA_CA_CERTS: pem }).trusted, why({ NODE_EXTRA_CA_CERTS: extra }).trusted], [true, true])
    assert.equal(why({}).reason, 'shim-not-on-path', 'no shim was installed (install said why)')
    s.put('.trocar/collector/bin/kimi', '#!/bin/sh\n')
    assert.equal(why({}).reason, 'kimi-not-via-shim')
    // the win twin: the shim is kimi.cmd there (arch/win32's opt-in item) — the reason must not mislabel a door
    // that is really there (measured live on a Windows test machine, 2026-10-13: flows rows said shim-not-on-path while the
    // session PATH resolved the shim first)
    fs.rmSync(path.join(dir, 'bin', 'kimi'))
    assert.equal(why({}).reason, 'shim-not-on-path', 'both shim names gone: back to no-shim-installed')
    s.put('.trocar/collector/bin/kimi.cmd', '@echo off\r\n')
    assert.equal(why({}).reason, 'kimi-not-via-shim', 'the .cmd shim alone is the door on Windows')
    assert.equal(why({ NODE_EXTRA_CA_CERTS: s.put('corp.pem', OTHER.certPem) }).reason, 'kimi-not-via-shim', "the user's own CA file: started without the shim, not 'ca-not-in-file'")
    assert.equal(why({}, { exe: '/usr/bin/node', argv: ['node', '/usr/local/bin/kimi'] }).reason, 'kimi-npm-no-shim')
    assert.equal(why({}, { exe: '/usr/bin/node', argv: ['kimi-code'] }).reason, 'kimi-npm-no-shim', 'retitled: the exe still says node')
    // the npm build on Windows and macOS (review R6): node is told by its normalized name, not by a POSIX path
    for (const exe of [String.raw`C:\Program Files\nodejs\node.exe`, '/opt/homebrew/Cellar/node/22.20.0/bin/node', '/Users/u/.nvm/versions/node/v22.20.0/bin/node22'])
      assert.equal(why({}, { exe, argv: ['node', '/usr/local/bin/kimi'] }).reason, 'kimi-npm-no-shim', exe)
    assert.equal(why({}, { exe: null, argv: ['C:/Program Files/nodejs/node.exe', 'x'] }).reason, 'kimi-npm-no-shim', 'no exe: argv[0] names it')
    fs.rmSync(extra)
    assert.equal(why({ NODE_EXTRA_CA_CERTS: extra }).reason, 'file-unreadable', "trocar's own file gone (uninstalled): the generic reason")
    for (const k of ['shim-not-on-path', 'kimi-not-via-shim', 'kimi-npm-no-shim']) assert.ok(kimi.trust.hints[k], k)
  } finally { s.done() }
})

// 4.11 §3 ⑱ / 1.6:517: an OS the proxy model covers (the OSes of kimi's own proxyMode forms) has no launch shim, so no reason names one there —
// a missing shim file is not news, a leftover one is not a door; the untrusted kimi keeps the generic reason (var-missing / ca-not-in-file / …).
test('kimi-code: on a proxy-model OS the reason never names a launch shim, with or without a shim file; the npm build is still told apart', () => {
  const s = sandbox()
  try {
    const dir = path.join(s.home, '.trocar', 'collector')
    s.put('.trocar/collector/ca/trocar-ca.pem', CA.certPem)
    const proxyOs = [...new Set(kimi.proxyMode.forms.flatMap((f) => f.os))]
    assert.ok(proxyOs.length > 0)
    const userCa = s.put('corp.pem', OTHER.certPem)
    for (const os of proxyOs) {
      const why = (env, { exe = SEA, argv = ['kimi-code'] } = {}) => judge(kimi, ctxFor({ home: s.home, env, argv, os }), { exe, collectorDir: dir }).trust
      for (const shim of [null, 'kimi', 'kimi.cmd']) {
        fs.rmSync(path.join(dir, 'bin'), { recursive: true, force: true })
        if (shim) s.put(`.trocar/collector/bin/${shim}`, 'x\n')
        assert.equal(why({}).reason, 'var-missing', `${os}, shim file ${shim}`)
        assert.equal(why({ NODE_EXTRA_CA_CERTS: userCa }).reason, 'ca-not-in-file', `${os}, shim file ${shim}, the user's own CA file`)
        assert.equal(why({}, { exe: '/usr/bin/node', argv: ['node', '/usr/local/bin/kimi'] }).reason, 'kimi-npm-no-shim', `${os}: the npm build`)
      }
    }
  } finally { s.done() }
})

test('kimi-code inject: a 0755 shim in the collector bin dir and one sentinel PATH line after the installer\'s in each rc that has it; nothing without the binary or that line (T10)', () => {
  const s = sandbox()
  try {
    const dir = path.join(s.home, '.trocar', 'collector')
    const plan = (env = {}, running = [], at = dir) => planTrust({ descriptors: [kimi], ctxFor: () => ({ home: s.home, env: new Map(Object.entries(env)), running: running.map((e) => new Map(Object.entries(e))), collectorDir: at, caPem: path.join(at, 'ca', 'trocar-ca.pem'), readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }, readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } }, listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } } }), caCertPem: CA.certPem, collectorDir: at })
    const none = plan()
    assert.deepEqual([none.owned, none.entries, none.files, none.records.map((r) => r.code)], [[], [], [], ['shim-not-on-path']], 'no ~/.kimi-code/bin/kimi')
    s.put('.bashrc', INSTALLER)
    assert.deepEqual(plan().records.map((r) => r.code), ['shim-not-on-path'], 'an installer PATH line but no binary')
    fs.rmSync(path.join(s.home, '.bashrc'))
    s.put('.kimi-code/bin/kimi', 'ELF')
    s.put('.profile', 'export EDITOR=vi\n')
    assert.deepEqual(plan().records.map((r) => r.code), ['shim-not-on-path'], 'no installer PATH line in any rc')
    s.put('.bashrc', INSTALLER)
    s.put('.zshrc', `${INSTALLER}alias k=kimi\n`)
    const p = plan()
    const shim = path.join(dir, 'bin', 'kimi')
    assert.deepEqual(p.paths, [shim, path.join(s.home, '.bashrc'), path.join(s.home, '.zshrc')], 'not ~/.local/bin, never ~/.kimi-code/bin/kimi, not an rc without the installer line')
    assert.deepEqual([p.owned[0].role, p.owned[0].mode], ['shim', 0o755])
    assert.match(p.owned[0].data, /^#!\/bin\/sh\n# trocar collector: /)
    assert.ok(p.owned[0].data.includes(`exec env NODE_EXTRA_CA_CERTS='${path.join(dir, 'ca', 'trocar-ca.pem')}' "$HOME/.kimi-code/bin/kimi" "$@"\n`))
    for (const e of p.entries) {
      assert.match(e.line, new RegExp(`^export PATH="${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin:\\$PATH" # trocar collector: `))
      assert.ok(new RegExp(e.after, 'm').test(INSTALLER) && !new RegExp(e.after).test(e.line), 'after the installer line, never after its own')
    }
    assert.deepEqual(p.files, [])
    const odd = plan({}, [], path.join(s.home, '$HOME', '.trocar', 'collector'))
    assert.deepEqual([odd.owned.length, odd.records.map((r) => r.code)], [0, ['shim-not-on-path']], 'a collector dir the shell would expand inside "…" gets no PATH line')
    const key = '-----BEGIN PRIVATE KEY-----\nU0VDUkVULUtFWQ==\n-----END PRIVATE KEY-----\n'
    const corp = s.put('corp.pem', key + OTHER.certPem)
    const withCa = plan({ NODE_EXTRA_CA_CERTS: corp }, [{ NODE_EXTRA_CA_CERTS: `${dir}/ca/extra-kimi.pem` }, { NODE_EXTRA_CA_CERTS: 'rel.pem' }])
    const extra = path.join(dir, 'ca', 'extra-kimi.pem')
    assert.ok(withCa.owned[0].data.includes(`NODE_EXTRA_CA_CERTS='${extra}'`), 'a CA the user already gives kimi is carried over')
    assert.deepEqual([withCa.files.length, withCa.files[0].path, withCa.files[0].sources, fps(withCa.files[0].data)], [1, extra, [corp], [fp(OTHER), fp(CA)]])
    assert.ok(!withCa.files[0].data.includes('PRIVATE KEY'))
    assert.deepEqual(withCa.records.map((r) => r.code), ['cert-not-merged', 'relative-path', 'harness-note'], "the key block is named; trocar's own file in a running kimi's environ is not a source")
    assert.match(withCa.records[1].reason, /rel\.pem is a relative path/)
  } finally { s.done() }
})

test('kimi-code through install / uninstall: the shim runs kimi with the CA file and every argument; the rc gets its line back out byte for byte; the shim dir holds only kimi (T11, S10)', async () => {
  const s = sandbox()
  try {
    // a stand-in for the installed binary: prints what the shim handed it
    s.put('.kimi-code/bin/kimi', '#!/bin/sh\nprintf "%s\\n" "$NODE_EXTRA_CA_CERTS" "$@"\n'); fs.chmodSync(path.join(s.home, '.kimi-code/bin/kimi'), 0o755)
    const rc = s.put('.bashrc', `${INSTALLER}alias ll='ls -l'\n`)
    const corp = s.put('corp.pem', OTHER.certPem)
    await installCollector({ home: s.home, env: { HOME: s.home, NODE_EXTRA_CA_CERTS: corp }, osName: 'none', harnesses: [kimi], freePort: async () => 47014 })
    const dir = path.join(s.home, '.trocar', 'collector')
    assert.deepEqual(fs.readdirSync(path.join(dir, 'bin')), ['kimi'])
    assert.equal(fs.statSync(path.join(dir, 'bin', 'kimi')).mode & 0o777, 0o755)
    assert.match(fs.readFileSync(rc, 'utf8'), new RegExp(`^# kimi-code\\nexport PATH="\\$HOME/\\.kimi-code/bin:\\$PATH"\\nexport PATH="${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin:\\$PATH" # trocar collector: [^\\n]*\\nalias ll='ls -l'\\n$`))
    const run = spawnSync('/bin/sh', ['-c', '. "$HOME/.bashrc"; command -v kimi; kimi -p "two words" \'$x\''], { env: { HOME: s.home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
    assert.equal(run.stdout, `${path.join(dir, 'bin', 'kimi')}\n${path.join(dir, 'ca', 'extra-kimi.pem')}\n-p\ntwo words\n$x\n`, run.stderr)
    assert.deepEqual(fps(fs.readFileSync(path.join(dir, 'ca', 'extra-kimi.pem'), 'utf8')), [fp(OTHER), ...fps(fs.readFileSync(path.join(dir, 'ca', 'trocar-ca.pem'), 'utf8'))])
    const r = await uninstallCollector({ home: s.home, env: {}, stop: async () => 'none' })
    assert.deepEqual(r.entries.map((e) => e.result), ['restored'])
    assert.equal(fs.readFileSync(rc, 'utf8'), `${INSTALLER}alias ll='ls -l'\n`)
    assert.ok(!fs.existsSync(path.join(dir, 'bin')) && !fs.existsSync(path.join(dir, 'ca', 'extra-kimi.pem')))
    assert.ok(fs.existsSync(path.join(s.home, '.kimi-code/bin/kimi')), "the user's kimi is never touched")
  } finally { s.done() }
})

test('kimi after uninstall, as data: untilEnviron names the variable the shim sets, so the manifest liveness snapshot carries "only a kimi started through the shim is reported, until it restarts" without the descriptor (4.6 step 5, 1.6 R3; test/off/off.test.mjs runs it)', async () => {
  const { livenessOf } = await import('../../../src/collector/core/registry.mjs')
  assert.equal(kimi.trust.untilEnviron, 'NODE_EXTRA_CA_CERTS')
  assert.ok(kimi.trust.chain.some((e) => e.var === kimi.trust.untilEnviron), 'untilEnviron is one of the chain\'s doors (the marker entry, 2026-10-12, sits first — dsh\'s ordering)')
  assert.deepEqual(livenessOf(kimi).until_environ, 'NODE_EXTRA_CA_CERTS')
  assert.deepEqual([livenessOf(kimi).until, livenessOf(kimi).rereads], ['restart', false])
})

test('kimi-code on an OS that cannot read the environment (macOS, the 2026-10-12 macOS test-machine gap): the shim\'s per-pid launch marker is the trust door; a stale marker is not', async () => {
  const { createTrustChecker, markerLayer, MARKER_VAR } = await import('../../../src/collector/core/trust/confirm.mjs')
  const s = sandbox()
  try {
    const dir = path.join(s.home, '.trocar', 'collector')
    const pem = s.put('.trocar/collector/ca/trocar-ca.pem', CA.certPem)
    s.put('.trocar/collector/bin/kimi', '#!/bin/sh\n') // the shim is installed (the opt-in's job on darwin)
    const readText = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
    const check = createTrustChecker({ caCertPem: CA.certPem })
    const startedAt = Date.now()
    const at = (environ, layers) => check.check(kimi.trust, { environ, layers, cwd: '/', startedAt, argv: ['kimi-code'], extra: { readText, collectorDir: dir, exe: SEA } })
    // the darwin reality: environ empty (never read), the tracker builds the marker layer from the shim's file
    assert.equal(at(new Map(), []).reason, 'kimi-not-via-shim', 'with no marker and no environment the reason is the shim\'s')
    const markers = s.put('.trocar/collector/run/trust/.keep', '')
    const markerDir = path.dirname(markers)
    const layerOf = () => markerLayer({ dir: markerDir, pid: 4242, startTicks: String(startedAt), caPem: pem, readText })
    assert.equal(layerOf(), null, 'no marker file, no layer (a kimi not started by the shim writes none)')
    fs.writeFileSync(path.join(markerDir, '4242'), `${startedAt}\n`)
    const layer = layerOf()
    assert.equal(layer && layer.vars[MARKER_VAR], pem, 'the marker names the CA file (the layer the tracker pushes)')
    assert.equal(at(new Map(), [layer]).trusted, true, 'a fresh marker trusts where the environment cannot be read')
    assert.equal(kimi.trust.chain[0].var, MARKER_VAR, 'the chain\'s first door is the marker (dsh\'s ordering)')
    fs.writeFileSync(path.join(markerDir, '4242'), `${startedAt - 90000}\n`)
    const stale = layerOf()
    assert.equal(stale.ignored, 'marker-stale', 'a reused pid\'s marker reads stale')
    assert.equal(at(new Map(), [stale]).trusted, false, 'a stale marker never trusts (this life was not the shim\'s)')
    assert.deepEqual(kimi.layers({}), [], 'the descriptor declares the layers contract (the tracker calls it — an absent one threw "own is not a function" in the live judge)')
  } finally { s.done() }
})
