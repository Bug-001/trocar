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
import { installCollector, uninstallCollector } from '../../../src/collector/install.mjs'
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
  for (const [exe, argv, why] of [
    ['/usr/bin/node', ['kimi-code'], 'the npm build seen only after its title rewrite: unidentifiable'],
    [SEA, [SEA, '__update_download', '2.1.2'], 'the background update download'],
    [SEA, [SEA, '__plugin_run_node', '/p/server.js'], "a plugin's MCP server"],
    ['/usr/bin/dash', ['/bin/sh', '/home/u/.asight/collector/bin/kimi', '-p', 'hi'], "asight's shim itself"],
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
    const dir = path.join(s.home, '.asight', 'collector')
    const pem = s.put('.asight/collector/ca/asight-ca.pem', CA.certPem)
    const extra = s.put('.asight/collector/ca/extra-kimi.pem', OTHER.certPem + CA.certPem)
    const why = (env, { exe = SEA, argv = ['kimi-code'] } = {}) => judge(kimi, ctxFor({ home: s.home, env, argv }), { exe, collectorDir: dir }).trust
    assert.deepEqual([why({ NODE_EXTRA_CA_CERTS: pem }).trusted, why({ NODE_EXTRA_CA_CERTS: extra }).trusted], [true, true])
    assert.equal(why({}).reason, 'shim-not-on-path', 'no shim was installed (install said why)')
    s.put('.asight/collector/bin/kimi', '#!/bin/sh\n')
    assert.equal(why({}).reason, 'kimi-not-via-shim')
    assert.equal(why({ NODE_EXTRA_CA_CERTS: s.put('corp.pem', OTHER.certPem) }).reason, 'kimi-not-via-shim', "the user's own CA file: started without the shim, not 'ca-not-in-file'")
    assert.equal(why({}, { exe: '/usr/bin/node', argv: ['node', '/usr/local/bin/kimi'] }).reason, 'kimi-npm-no-shim')
    fs.rmSync(extra)
    assert.equal(why({ NODE_EXTRA_CA_CERTS: extra }).reason, 'file-unreadable', "asight's own file gone (uninstalled): the generic reason")
    for (const k of ['shim-not-on-path', 'kimi-not-via-shim', 'kimi-npm-no-shim']) assert.ok(kimi.trust.hints[k], k)
  } finally { s.done() }
})

test('kimi-code inject: a 0755 shim in the collector bin dir and one sentinel PATH line after the installer\'s in each rc that has it; nothing without the binary or that line (T10)', () => {
  const s = sandbox()
  try {
    const dir = path.join(s.home, '.asight', 'collector')
    const plan = (env = {}, running = [], at = dir) => planTrust({ descriptors: [kimi], ctxFor: () => ({ home: s.home, env: new Map(Object.entries(env)), running: running.map((e) => new Map(Object.entries(e))), collectorDir: at, caPem: path.join(at, 'ca', 'asight-ca.pem'), readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }, readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } }, listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } } }), caCertPem: CA.certPem, collectorDir: at })
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
    assert.match(p.owned[0].data, /^#!\/bin\/sh\n# asight collector: /)
    assert.ok(p.owned[0].data.includes(`exec env NODE_EXTRA_CA_CERTS='${path.join(dir, 'ca', 'asight-ca.pem')}' "$HOME/.kimi-code/bin/kimi" "$@"\n`))
    for (const e of p.entries) {
      assert.match(e.line, new RegExp(`^export PATH="${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin:\\$PATH" # asight collector: `))
      assert.ok(new RegExp(e.after, 'm').test(INSTALLER) && !new RegExp(e.after).test(e.line), 'after the installer line, never after its own')
    }
    assert.deepEqual(p.files, [])
    const odd = plan({}, [], path.join(s.home, '$HOME', '.asight', 'collector'))
    assert.deepEqual([odd.owned.length, odd.records.map((r) => r.code)], [0, ['shim-not-on-path']], 'a collector dir the shell would expand inside "…" gets no PATH line')
    const key = '-----BEGIN PRIVATE KEY-----\nU0VDUkVULUtFWQ==\n-----END PRIVATE KEY-----\n'
    const corp = s.put('corp.pem', key + OTHER.certPem)
    const withCa = plan({ NODE_EXTRA_CA_CERTS: corp }, [{ NODE_EXTRA_CA_CERTS: `${dir}/ca/extra-kimi.pem` }, { NODE_EXTRA_CA_CERTS: 'rel.pem' }])
    const extra = path.join(dir, 'ca', 'extra-kimi.pem')
    assert.ok(withCa.owned[0].data.includes(`NODE_EXTRA_CA_CERTS='${extra}'`), 'a CA the user already gives kimi is carried over')
    assert.deepEqual([withCa.files.length, withCa.files[0].path, withCa.files[0].sources, fps(withCa.files[0].data)], [1, extra, [corp], [fp(OTHER), fp(CA)]])
    assert.ok(!withCa.files[0].data.includes('PRIVATE KEY'))
    assert.deepEqual(withCa.records.map((r) => r.code), ['cert-not-merged', 'relative-path', 'harness-note'], "the key block is named; asight's own file in a running kimi's environ is not a source")
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
    const dir = path.join(s.home, '.asight', 'collector')
    assert.deepEqual(fs.readdirSync(path.join(dir, 'bin')), ['kimi'])
    assert.equal(fs.statSync(path.join(dir, 'bin', 'kimi')).mode & 0o777, 0o755)
    assert.match(fs.readFileSync(rc, 'utf8'), new RegExp(`^# kimi-code\\nexport PATH="\\$HOME/\\.kimi-code/bin:\\$PATH"\\nexport PATH="${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin:\\$PATH" # asight collector: [^\\n]*\\nalias ll='ls -l'\\n$`))
    const run = spawnSync('/bin/sh', ['-c', '. "$HOME/.bashrc"; command -v kimi; kimi -p "two words" \'$x\''], { env: { HOME: s.home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
    assert.equal(run.stdout, `${path.join(dir, 'bin', 'kimi')}\n${path.join(dir, 'ca', 'extra-kimi.pem')}\n-p\ntwo words\n$x\n`, run.stderr)
    assert.deepEqual(fps(fs.readFileSync(path.join(dir, 'ca', 'extra-kimi.pem'), 'utf8')), [fp(OTHER), ...fps(fs.readFileSync(path.join(dir, 'ca', 'asight-ca.pem'), 'utf8'))])
    const r = await uninstallCollector({ home: s.home, env: {}, stop: async () => 'none' })
    assert.deepEqual(r.entries.map((e) => e.result), ['restored'])
    assert.equal(fs.readFileSync(rc, 'utf8'), `${INSTALLER}alias ll='ls -l'\n`)
    assert.ok(!fs.existsSync(path.join(dir, 'bin')) && !fs.existsSync(path.join(dir, 'ca', 'extra-kimi.pem')))
    assert.ok(fs.existsSync(path.join(s.home, '.kimi-code/bin/kimi')), "the user's kimi is never touched")
  } finally { s.done() }
})

test('kimi after uninstall: only a kimi the shim started (its NODE_EXTRA_CA_CERTS is asight\'s file) is reported, until it restarts (4.6 step 5, review 3 #6)', () => {
  const au = kimi.trust.afterUninstall
  const dir = '/h/.asight/collector'
  assert.equal(au({ env: new Map([['NODE_EXTRA_CA_CERTS', `${dir}/ca/extra-kimi.pem`]]) }, { collectorDir: dir }), 'restart')
  assert.equal(au({ env: new Map([['NODE_EXTRA_CA_CERTS', '/corp/ca.pem']]) }, { collectorDir: dir }), null, 'its own CA: it never trusted asight')
  assert.equal(au({ env: new Map() }, { collectorDir: dir }), null, 'by its absolute path: no shim, no asight CA')
  assert.equal(au({ env: new Map([['NODE_EXTRA_CA_CERTS', '/h/.asight/collectorX/a.pem']]) }, { collectorDir: dir }), null)
})

test('kimi after uninstall, as data: untilEnviron names the variable the shim sets, so the install manifest\'s liveness snapshot carries "only a kimi whose NODE_EXTRA_CA_CERTS is asight\'s file" without the descriptor (4.6 step 5, 1.6 R3)', async () => {
  const { livenessOf } = await import('../../../src/collector/core/registry.mjs')
  assert.equal(kimi.trust.untilEnviron, kimi.trust.chain[0].var)
  assert.deepEqual(livenessOf(kimi, 'linux').until_environ, 'NODE_EXTRA_CA_CERTS')
  assert.deepEqual([livenessOf(kimi, 'linux').until, livenessOf(kimi, 'linux').rereads], ['restart', false])
})
