// test/collector/harness/darwin-trust.test.mjs — the macOS trust entries (RFC 4.9 §2.3 · §6; the mechanism — sentinel blocks, the journal, byte-exact undo, the combined bundle — is 4.8 §6.1 · §6.2's,
// acceptance W19, W20, W22, and W23's "zero writes" half). This is the darwin port of win32-trust.test.mjs, its two halves kept: planTrust in its macOS mode on made-up /Users paths (the checks a
// macOS home can hit: the zsh rc files, a space in the user directory, config.yaml routes), and the real install / uninstall of the harnesses' darwin data in a sandbox HOME laid out like a macOS $HOME.
// A proxy entry is data written after the kernel's read-back (Task 8): the plan holds trust entries only, which this file asserts.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { planTrust } from '../../../src/collector/core/trust/plan.mjs'
import { installCollector } from '../../../src/collector/install.mjs'
import { uninstallCollector } from '../../helpers/uninstall.mjs'
import { readManifest, installedAt } from '../../../src/collector/core/trust/journal.mjs'
import { parseDotenv } from '../../../src/collector/core/config-read.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

const CA = createCa({ commonName: 'asight collector CA' })
const ALL = await loadHarnesses()
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

// ── planTrust on macOS paths ──
const DIR = '/Users/u/.asight/collector'
const BUNDLE = '/Users/u/.asight/collector/ca/combined-alpha.pem'
const plan = (darwin, os = 'darwin', extra = {}) => planTrust({ descriptors: [{ name: 'alpha', darwin, ...extra }], ctxFor: () => ({ os, readText: () => null }), caCertPem: CA.certPem, collectorDir: DIR })
const dotenv = (o = {}) => ({ kind: 'text', format: 'dotenv-block', path: '/Users/u/.alpha/.env', vars: { SSL_CERT_FILE: BUNDLE }, semantic: 'replace', ...o })
const jsonKey = (o = {}) => ({ kind: 'json-key', path: '/Users/u/.alpha/settings.json', keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: '/Users/u/.asight/collector/ca/asight-ca.pem', semantic: 'append', ...o })

test('W19 plan: every path an entry writes stays the POSIX path it is (4.9 §6.1: the forward-slash clause of 4.8 does not cross), the file locations stay as they are, and the checks read POSIX paths — exact case today (the APFS question is in the port report)', () => {
  const p = plan({ inject: () => ({ entries: [dotenv(), jsonKey()], files: [{ path: BUNDLE, bundle: true }] }) })
  assert.deepEqual(p.entries.map((e) => e.vars ? e.vars.SSL_CERT_FILE : e.value), [BUNDLE, path.join(DIR, 'ca', 'asight-ca.pem')], 'no backslash to escape in a dotenv file on macOS: the value is the path as it is')
  assert.deepEqual(p.entries.map((e) => e.path), ['/Users/u/.alpha/.env', '/Users/u/.alpha/settings.json'], 'where the file is: untouched')
  assert.deepEqual(p.files.map((f) => f.path), [BUNDLE])
  assert.throws(() => plan({ inject: () => ({ entries: [jsonKey({ value: '/Users/u/other/x.pem' })] }) }), /must be a file under/)
  assert.throws(() => plan({ inject: () => ({ entries: [jsonKey({ value: 'ca/x.pem' })] }) }), /must be absolute/)
  assert.throws(() => plan({ inject: () => ({ entries: [jsonKey({ path: 'settings.json' })] }) }), /must be absolute/)
  assert.throws(() => plan({ inject: () => ({ entries: [dotenv()] }) }), /does not declare as its combined bundle/, 'a replace entry still needs its own declared bundle')
  assert.throws(() => plan({ inject: () => ({ entries: [dotenv({ vars: { SSL_CERT_FILE: '/Users/u/.asight/collector/ca/combined-beta.pem' } })], files: [{ path: BUNDLE, bundle: true }] }) }), /combined-alpha\.pem/)
  assert.throws(() => plan({ inject: () => ({ entries: [jsonKey({ keys: ['env', 'NODE_OPTIONS'] })] }) }), /never written/)
  assert.throws(() => plan({ inject: () => ({ entries: [jsonKey({ value: '/users/u/.asight/collector/ca/x.pem' })] }) }), /must be a file under/, 'the compare is exact today: win32 reads its paths case-blind, darwin does not — whether APFS (case-insensitive by default) should get the win32 treatment is the integrator\'s question')
})

test('W19 plan: a dotenv block entry on darwin asks to be written quoted when its value needs it (a macOS home can hold a space — 4.9 §6.1 keeps the double-quote handling); on Linux it does not, so the unquoted-only rule stays', () => {
  const p = plan({ inject: () => ({ entries: [dotenv()], files: [{ path: BUNDLE, bundle: true }] }) })
  assert.equal(p.entries[0].quote, true, 'the darwin line of the plan adds the flag as the win line does (the journal quotes the value only when it needs it)')
  assert.equal(plan({ inject: () => ({ entries: [jsonKey()] }) }).entries[0].quote, undefined, 'a JSON key has no quotes to choose')
  assert.equal(plan({ inject: () => ({ entries: [dotenv({ quote: true })], files: [{ path: BUNDLE, bundle: true }] }) }).entries[0].quote, true, 'a flag the descriptor itself set (the hermes twin does) passes through')
  const lin = planTrust({ descriptors: [{ name: 'alpha', inject: () => ({ entries: [{ kind: 'text', format: 'dotenv-block', path: '/h/.alpha/.env', vars: { SSL_CERT_FILE: '/h/.asight/collector/ca/combined-alpha.pem' }, semantic: 'replace' }], files: [{ path: '/h/.asight/collector/ca/combined-alpha.pem', bundle: true }] }) }], ctxFor: () => ({ os: 'linux', readText: () => null }), caCertPem: CA.certPem, collectorDir: '/h/.asight/collector' })
  assert.equal(lin.entries[0].quote, undefined)
})

test('W19 plan: the zsh rc files are the macOS login environment and are never an entry; a shim lives in the collector\'s bin directory and nowhere else', () => {
  for (const bad of ['/Users/u/.zshrc', '/Users/u/.zshenv', '/Users/u/.zprofile', '/Users/u/.zlogin', '/Users/u/.profile', '/Users/u/.config/environment.d/10-asight.conf']) {
    assert.throws(() => plan({ inject: () => ({ entries: [jsonKey({ path: bad })] }) }), /login-environment/, bad)
    assert.throws(() => plan({ inject: () => ({ owned: [{ path: bad, role: 'plugin', data: '// asight collector' }] }) }), /login-environment/, bad)
  }
  const shim = (p) => plan({ inject: () => ({ owned: [{ path: p, role: 'shim', data: '#!/bin/sh\n' }] }) })
  assert.equal(shim(path.join(DIR, 'bin', 'kimi')).owned.length, 1)
  assert.throws(() => shim('/Users/u/bin/kimi'), /shim directory/)
  assert.throws(() => plan({ inject: () => ({ owned: [{ path: path.join(DIR, 'bin', 'x.js'), role: 'plugin', data: '// asight collector' }] }) }), /holds launch shims only/)
  assert.throws(() => plan({ inject: () => ({ owned: [{ path: '/Users/u/.config/opencode/plugins/p.js', role: 'plugin', data: '// asight collector' }] }) }), /"asight" in its name/)
  assert.equal(plan({ inject: () => ({ owned: [{ path: '/Users/u/.config/opencode/plugins/asight-ca.js', role: 'plugin', data: '// asight collector: x' }] }) }).owned.length, 1)
})

test('W19 plan: only the OS the entries are for is asked — a harness without macOS data writes nothing on macOS, and macOS data is never read for another OS', () => {
  let called = []
  const d = { name: 'alpha', darwin: { inject: () => { called.push('darwin'); return { entries: [jsonKey()] } } }, inject: () => { called.push('linux'); return { entries: [jsonKey({ path: '/h/.alpha/settings.json', value: '/h/.asight/collector/ca/asight-ca.pem' })] } } }
  const mac = planTrust({ descriptors: [d], ctxFor: () => ({ os: 'darwin' }), caCertPem: CA.certPem, collectorDir: DIR })
  assert.deepEqual([called, mac.entries.length], [['darwin'], 1])
  called = []
  const lin = planTrust({ descriptors: [d], ctxFor: () => ({ os: 'linux' }), caCertPem: CA.certPem, collectorDir: '/h/.asight/collector' })
  assert.deepEqual([called, lin.entries.length], [['linux'], 1])
  assert.deepEqual(planTrust({ descriptors: [{ name: 'only-linux', inject: () => ({ entries: [jsonKey()] }) }], ctxFor: () => ({ os: 'darwin' }), caCertPem: CA.certPem, collectorDir: DIR }).paths, [])
})

// ── the real data in a sandbox HOME laid out like a macOS $HOME ──
function box(...sub) { // `sub`: segments under the temp directory, e.g. a user directory with a space in it
  const home = path.join(tmpDir('asight-w19-'), ...sub)
  fs.mkdirSync(home, { recursive: true })
  const put = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  const snapshot = () => { const out = new Map(); const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (f === path.join(home, '.asight')) continue; if (e.isDirectory()) walk(f); else out.set(f, sha(fs.readFileSync(f))) } }; walk(home); return out }
  return { home, dir: path.join(home, '.asight', 'collector'), put, snapshot }
}
const names = ['claude-code', 'codex', 'kimi-code', 'z-code']
const install = (b, over = {}) => installCollector({ home: b.home, env: { HOME: b.home }, osName: 'darwin', harnesses: ALL.filter((d) => names.includes(d.name)), freePort: async () => 47011, roots: { node: [], osText: '' }, ...over })
const uninstall = (b, harnesses = ALL.filter((d) => names.includes(d.name))) => uninstallCollector({ home: b.home, env: {}, stop: async () => 'none', harnesses, roots: { node: [], osText: '' } })

test('W19: on writes each automatic trust entry and off puts every file back to its pre_sha256; nothing outside the plan is touched, nothing a user has to name is written', async () => {
  const b = box()
  const corp = createCa({ commonName: 'corp relay CA' })
  const claude = b.put('.claude/settings.json', '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://relay.example.com"\n  },\n  "theme": "dark"\n}\n')
  const codex = b.put('.codex/.env', 'OPENAI_API_KEY=sk-secret\nHTTPS_PROXY=http://corp-proxy:3128\n# a comment\n')
  b.put('.zcode/cli/config.json', '{"network": {"proxy": "none"}}\n') // Z-Code ran once: its home exists, the key is added inside the user's own object
  b.put('.kimi-code/bin/kimi', 'MACHO')
  b.put('Library/Application Support/Code/User/settings.json', '{"editor.fontSize": 12}\n')
  b.put('.zshrc', '# my shell\n'); b.put('.zshenv', ''); b.put('.zprofile', ''); b.put('.zlogin', '') // kimi's opt-in would add a PATH line to each
  const corpFile = b.put('corp.pem', corp.certPem)
  const before = b.snapshot()
  const r = await install(b, { env: { HOME: b.home, NODE_EXTRA_CA_CERTS: corpFile } })
  const m = readManifest(b.dir)
  assert.equal(m.install?.state, 'complete')
  const zconf = path.join(b.home, '.zcode', 'cli', 'config.json')
  // trust entries only: the CA keys and the one block of SSL_CERT_FILE; no proxy key anywhere (that entry is Task 8's, after the read-back)
  const holding = (re) => [...b.snapshot().keys()].filter((f) => re.test(fs.readFileSync(f, 'utf8')))
  assert.deepEqual(holding(/httpProxy|NO_PROXY|"HTTPS_PROXY"/), [], 'no proxy entry in anything the plan wrote')
  assert.equal(fs.readFileSync(codex, 'utf8').match(/HTTPS_PROXY=/g).length, 1, 'Codex\'s .env still has only the user\'s own HTTPS_PROXY line')
  assert.equal(JSON.parse(fs.readFileSync(claude, 'utf8')).env.NODE_EXTRA_CA_CERTS, path.join(b.dir, 'ca', 'extra-cc.pem'), 'the corp CA of the shell is carried into extra-cc.pem')
  assert.match(fs.readFileSync(codex, 'utf8'), /SSL_CERT_FILE=\S+combined-codex\.pem\n/, 'no space in this path: the block writes the plain form (a space in $HOME is what the quote flag is for)')
  assert.equal(JSON.parse(fs.readFileSync(zconf, 'utf8')).network.caCertFile, path.join(b.dir, 'ca', 'combined-z-code.pem'))
  for (const e of m.entries) assert.ok(!/\\/.test(e.value || Object.values(e.vars).join('')), `${e.path}: forward slashes in what is written`)
  // the plan is exactly the automatic set: no Kimi shim, no rc PATH line, no VS Code setting, no Z-Code Desktop setting, no keychain item
  assert.deepEqual([...m.planned].sort(), [claude, codex, zconf, path.join(b.dir, 'ca', 'combined-codex.pem'), path.join(b.dir, 'ca', 'combined-z-code.pem'), path.join(b.dir, 'ca', 'extra-cc.pem')].sort())
  const after = b.snapshot()
  const changed = [...after].filter(([f, h]) => before.get(f) !== h).map(([f]) => f)
  assert.deepEqual(changed.sort(), [claude, codex, zconf].sort(), 'every other file of the user\'s is byte for byte as it was')
  for (const e of m.entries) assert.ok(e.pre_sha256 || !e.existed_before, `${e.path}: its pre_sha256 is recorded`)
  assert.ok(r.plan.paths.every((p) => !/Code\/User|\.zshrc|\.zshenv|\.zprofile|\.zlogin|\.kimi-code/.test(p)), 'an opt-in item (kimi\'s rc lines and shim, Claude Desktop\'s keychain item, VS Code) writes nothing until it is named')
  await uninstall(b)
  assert.deepEqual([...b.snapshot()], [...before], 'the user\'s files are back to the bytes they had (their pre_sha256)')
  assert.deepEqual(fs.readdirSync(b.dir), ['flows'], 'only the records of what install and uninstall said remain of the collector directory')
})

const only = (name) => ALL.filter((d) => d.name === name)
test('W19: Hermes — the block goes into the .env of ~/.hermes and of each profile, with HERMES_CA_BUNDLE for a release up to v2026.9.24, the user\'s CA is carried into the bundle, the OpenAI wire-format route gets its ssl_ca_cert line in config.yaml, and off restores every byte', async () => {
  const b = box()
  const corp = createCa({ commonName: 'corp relay CA' })
  const corpFile = b.put('corp.pem', corp.certPem)
  const rootEnv = b.put('.hermes/.env', `OPENROUTER_API_KEY=sk-secret\nSSL_CERT_FILE=${corpFile}\n`)
  b.put('.hermes/hermes-agent/install-stamp.json', '{"tag":"v2026.9.20"}')
  b.put('.hermes/hermes-agent/.env', 'FOO=1\n')
  b.put('.hermes/profiles/work/config.yaml', 'providers:\n  relay:\n    base_url: https://relay.example.com/v1\n    api_mode: chat_completions\n')
  const before = b.snapshot()
  const r = await install(b, { harnesses: only('hermes') })
  const profileEnv = path.join(b.home, '.hermes', 'profiles', 'work', '.env')
  const bundle = path.join(b.dir, 'ca', 'combined-hermes.pem')
  const config = path.join(b.home, '.hermes', 'profiles', 'work', 'config.yaml')
  assert.deepEqual([...readManifest(b.dir).planned].sort(), [bundle, profileEnv, rootEnv, config].sort())
  for (const f of [rootEnv, profileEnv]) assert.match(fs.readFileSync(f, 'utf8'), new RegExp(`SSL_CERT_FILE=${bundle.replace(/[.\\]/g, '\\$&')}\\nHERMES_CA_BUNDLE=${bundle.replace(/[.\\]/g, '\\$&')}\\n`), `${f}: both variables (a release of that date reads the first of HERMES_CA_BUNDLE / SSL_CERT_FILE)`)
  assert.match(fs.readFileSync(rootEnv, 'utf8'), /OPENROUTER_API_KEY=sk-secret/, 'the user\'s other lines are untouched')
  assert.ok(fs.readFileSync(bundle, 'utf8').includes(corp.certPem.trim()), 'the CA the user\'s SSL_CERT_FILE named is carried into the bundle')
  const cfg = fs.readFileSync(config, 'utf8')
  assert.ok(cfg.includes(`    ssl_ca_cert: ${bundle} # asight collector: relay: `), `the route's CA file, named for its route in the sentinel comment: ${cfg}`)
  assert.ok(cfg.indexOf('  relay:') < cfg.indexOf('ssl_ca_cert'), 'the line sits inside the route\'s block, right after its header')
  assert.ok(r.plan.notes.some((n) => /does not exist, so asight creates it.*as a fill instead of an override/.test(n)), 'creating the profile\'s .env turns the checkout .env into a fill: said')
  await uninstall(b, only('hermes'))
  assert.deepEqual([...b.snapshot()], [...before])
})

test('W19: Hermes — no ~/.hermes means no entry and a note; HERMES_HOME naming a profile finds the root above it; a newer release gets only SSL_CERT_FILE, quoted blocks, and the route\'s ssl_ca_cert line in config.yaml', () => {
  const hermes = only('hermes')[0].darwin
  const b = box()
  const ctx = (env = {}, over = {}) => ({ os: 'darwin', home: b.home, env: new Map(Object.entries(env)), running: [], collectorDir: b.dir, caPem: path.join(b.dir, 'ca', 'asight-ca.pem'), readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }, listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } }, ...over })
  const none = hermes.inject(ctx())
  assert.deepEqual([none.entries, none.notes.map((n) => n.code)], [undefined, ['harness-note']])
  const root = path.join(b.home, 'D', 'hermes')
  b.put('D/hermes/profiles/work/config.yaml', 'providers:\n  relay:\n    api_mode: chat_completions\n')
  b.put('D/hermes/hermes-agent/install-stamp.json', '{"tag":"v2026.10.2"}')
  const got = hermes.inject(ctx({ HERMES_HOME: path.join(root, 'profiles', 'work') }))
  const rootEnv = path.join(root, '.env')
  const workEnv = path.join(root, 'profiles', 'work', '.env')
  const config = path.join(root, 'profiles', 'work', 'config.yaml')
  assert.deepEqual(got.entries.filter((e) => e.format === 'dotenv-block').map((e) => [e.path, Object.keys(e.vars), e.quote]), [[rootEnv, ['SSL_CERT_FILE'], true], [workEnv, ['SSL_CERT_FILE'], true]], 'only SSL_CERT_FILE for a newer release, and the block asks to be quoted (a macOS home can hold a space)')
  const [route] = got.entries.filter((e) => e.format === 'line')
  assert.equal(route.path, config)
  assert.equal(route.after, '^  relay:[ \t\r]*$', 'anchored at the route\'s header line (a CRLF file\'s \r is not part of it)')
  assert.ok(route.line.startsWith(`    ssl_ca_cert: ${path.join(b.dir, 'ca', 'combined-hermes.pem')} # asight collector: relay: `), 'the route\'s name rides in the sentinel comment')
  assert.deepEqual(hermes.groups[0].proxyEntry.files(ctx({ HERMES_HOME: path.join(root, 'profiles', 'work') })), [rootEnv, workEnv], 'the proxy entry goes into the files the trust block does (config.yaml is a trust entry, not a proxy door)')
  assert.deepEqual(hermes.groups[0].proxyEntry.files(ctx()), [], 'not installed: no file')
})

test('W19: Hermes — the OpenAI wire-format routes of config.yaml: one ssl_ca_cert line per route, anchored after its header and journaled so off restores the byte; the user\'s own ssl_ca_cert is never rewritten, and a route outside any block is said, not guessed', () => {
  const hermes = only('hermes')[0].darwin
  const b = box()
  b.put('.hermes/.env', 'K=1\n')
  b.put('.hermes/hermes-agent/install-stamp.json', '{"tag":"v2026.10.2"}')
  const config = b.put('.hermes/config.yaml', [
    'model: x',
    'providers:',
    '  relay:', // a route named by its header key
    '    api_mode: chat_completions',
    '  corp:', // the user's own ssl_ca_cert: not touched, said
    '    api_mode: chat_completions',
    '    ssl_ca_cert: /Users/u/corp.pem',
    'custom_providers:',
    '  - name: named-route', // a list-item header: the name rule
    '    api_mode: chat_completions',
    '  other:',
    '    api_mode: embeddings', // not the wire format: no entry
    'api_mode: chat_completions', // outside any block asight can name
  ].join('\n') + '\n')
  const ctx = { os: 'darwin', home: b.home, env: new Map(), running: [], collectorDir: b.dir, caPem: path.join(b.dir, 'ca', 'asight-ca.pem'), readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }, listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } } }
  const got = hermes.inject(ctx)
  const bundle = path.join(b.dir, 'ca', 'combined-hermes.pem')
  assert.deepEqual(got.entries.filter((e) => e.format === 'line').map((e) => [e.after, e.line.split(' # ')[0]]), [
    ['^  relay:[ \t\r]*$', `    ssl_ca_cert: ${bundle}`],
    ['^  - name: named-route[ \t\r]*$', `    ssl_ca_cert: ${bundle}`],
  ], 'two routes are two entries, told apart by their anchors and their sentinel names')
  const notes = got.notes.map((n) => n.text)
  assert.ok(notes.some((t) => /sets ssl_ca_cert: \/Users\/u\/corp\.pem on the chat_completions route corp; asight rewrites no YAML value/.test(t)), 'the user\'s own ssl_ca_cert is reported, never rewritten')
  assert.ok(notes.some((t) => /outside any block asight can name/.test(t)), 'a top-level api_mode is said, not guessed')
  assert.ok(!notes.some((t) => /embeddings|named-route|route relay/.test(t)), 'no noise about the routes that got their entry')
  // the line entry goes through the journal like every entry: written after its header, undone to the byte
  const entry = got.entries.find((e) => e.format === 'line')
  const before = fs.readFileSync(config, 'utf8')
  const m = newManifest()
  const done = applyTextEntry({ phase: 'install', dir: b.dir, home: b.home, manifest: m, harness: 'hermes', file: config, edit: entry })
  const lines = fs.readFileSync(config, 'utf8').split('\n')
  assert.equal(lines[lines.indexOf('  relay:') + 1], entry.line, 'the ssl_ca_cert line sits right after the route\'s header')
  assert.equal(undoEntry(done).result, 'restored')
  assert.equal(fs.readFileSync(config, 'utf8'), before, 'byte for byte')
})

// ── W19 in the homes macOS users really have: a space in the user directory, and files that an editor there wrote with CRLF ──
// Every harness's user files as one user has them; `eol` is the line ending of the files, `corp` a corporate CA the user's own SSL_CERT_FILE / NODE_EXTRA_CA_CERTS lines name.
function seedAll(b, eol, corp) {
  const nl = (t) => t.replace(/\n/g, eol)
  const corpFile = b.put('corp.pem', corp.certPem)
  b.put('.claude/settings.json', nl('{\n  "env": {\n    "NODE_EXTRA_CA_CERTS": "' + corpFile + '"\n  },\n  "theme": "dark"\n}\n'))
  b.put('.codex/.env', nl(`OPENAI_API_KEY=sk-secret\nSSL_CERT_FILE=${corpFile}\nHTTPS_PROXY=http://corp:3128\n# a comment\n`))
  b.put('.zcode/cli/config.json', nl('{\n  "network": {\n    "caCertFile": "' + corpFile + '"\n  }\n}\n'))
  b.put('.dsh/cordis.patch.yml', nl('- insert: [{ name: other-plugin }]\n'))
  b.put('.dsh/.env', nl('DEEPSEEK_API_KEY=sk-secret\n'))
  b.put('.hermes/.env', nl(`OPENROUTER_API_KEY=sk-secret\nSSL_CERT_FILE=${corpFile}\nHTTPS_PROXY=http://corp:3128\n`))
  b.put('.hermes/hermes-agent/install-stamp.json', '{"tag":"v2026.9.20"}')
  b.put('.kimi-code/bin/kimi', 'MACHO')
  return corpFile
}
const PROFILES = [{ label: '/Users/John Smith', sub: ['John Smith'] }, { label: 'OneDrive - Contoso/John Smith', sub: ['OneDrive - Contoso', 'John Smith'] }]
const SETS = [['claude-code'], ['codex'], ['hermes'], ['z-code'], ['claude-code', 'codex'], 'all']

for (const eol of ['\n', '\r\n']) for (const prof of PROFILES) {
  test(`W19 (${eol === '\n' ? 'LF' : 'CRLF'} files, home ${prof.label}): every harness — alone, Claude Code with Codex, and all seven together — installs, the paths with a space are double-quoted in the .env blocks and read back whole, the user's own same-key lines are out of effect with their prior recorded, and off restores every byte`, async () => {
    for (const set of SETS) {
      const b = box(...prof.sub)
      const corp = createCa({ commonName: 'corp relay CA' })
      const corpFile = seedAll(b, eol, corp)
      const before = b.snapshot()
      const harnesses = set === 'all' ? ALL : ALL.filter((d) => set.includes(d.name))
      const label = `${set === 'all' ? 'all seven' : set.join('+')}`
      await install(b, { harnesses })
      const m = readManifest(b.dir)
      assert.equal(m.install?.state, 'complete', label)
      for (const e of m.entries) assert.ok(!/\\/.test(e.value || Object.values(e.vars || {}).join('')), `${label}: ${e.path}: forward slashes, and the plain path (no quotes) is what the manifest holds`)
      for (const [name, rel, bundle] of [['codex', '.codex/.env', 'combined-codex.pem'], ['hermes', '.hermes/.env', 'combined-hermes.pem']].filter(([n]) => set === 'all' || set.includes(n))) {
        const text = fs.readFileSync(path.join(b.home, rel), 'utf8')
        const want = path.join(b.dir, 'ca', bundle)
        assert.ok(text.includes(`SSL_CERT_FILE="${want}"`), `${label}: the value with spaces is written in double quotes: ${text.split(/\r?\n/).slice(0, 4).join(' | ')}`)
        assert.equal(parseDotenv(text).get('SSL_CERT_FILE'), want, `${label}: what Codex (dotenvy) and Hermes (python-dotenv) read is the whole path`)
        assert.deepEqual([...parseDotenv(text)].filter(([k]) => k === 'SSL_CERT_FILE').length, 1, `${label}: the user's own SSL_CERT_FILE line is out of effect, not shadowed by order`)
        if (eol === '\r\n') assert.ok(!/[^\r]\n/.test(text), `${label}: ${name}'s .env stays CRLF`)
        const entry = m.entries.find((e) => e.path === path.join(b.home, rel))
        assert.equal(installedAt(m, { file: entry.path, vars: Object.fromEntries(parseDotenv(text)) }), Date.parse(entry.installed_at), `${label}: ${name}: the tracker still recognises asight's own block (the manifest's plain path equals what the reader gets from the quoted one)`)
        assert.deepEqual(entry.prior_value, { SSL_CERT_FILE: corpFile }, `${label}: ${name}: the user's value is recorded, to be carried into the bundle and put back by off`)
        assert.ok(fs.readFileSync(want, 'utf8').includes(corp.certPem.trim()), `${label}: ${name}: the CA the user's line named is in the combined bundle`)
      }
      await uninstall(b, harnesses)
      assert.deepEqual([...b.snapshot()], [...before], `${label}: every byte of the user's files is back`)
    }
  })
}

test('W19: Hermes — a HERMES_MANAGED_DIR .env that sets SSL_CERT_FILE or HERMES_CA_BUNDLE wins over asight\'s block (Hermes reads it last), and the install says so; without it, no note', () => {
  const hermes = only('hermes')[0].darwin
  const b = box('John Smith')
  b.put('.hermes/config.yaml', 'x: 1\n')
  const managed = path.join(b.home, 'Library', 'Application Support', 'hermes-managed')
  const ctx = (env = {}) => ({ os: 'darwin', home: b.home, env: new Map(Object.entries(env)), running: [], collectorDir: b.dir, caPem: path.join(b.dir, 'ca', 'asight-ca.pem'), readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }, listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } } })
  const notes = (env) => hermes.inject(ctx(env)).notes.map((n) => n.text).filter((t) => /sets \w+; Hermes reads that file last/.test(t))
  assert.deepEqual(notes({}), [], 'no managed directory: nothing to say')
  assert.deepEqual(notes({ HERMES_MANAGED_DIR: managed }), [], 'a managed directory without the file, or without these variables')
  b.put('Library/Application Support/hermes-managed/.env', 'OTHER=1\n')
  assert.deepEqual(notes({ HERMES_MANAGED_DIR: managed }), [])
  b.put('Library/Application Support/hermes-managed/.env', 'SSL_CERT_FILE=/corp/ca.pem\nHERMES_CA_BUNDLE=/corp/ca.pem\n')
  assert.deepEqual(notes({ HERMES_MANAGED_DIR: managed }).map((t) => t.replace(managed, '<managed>')), [
    '<managed>/.env sets SSL_CERT_FILE; Hermes reads that file last, so it wins over asight\'s block and Hermes is not captured while it is there',
    '<managed>/.env sets HERMES_CA_BUNDLE; Hermes reads that file last, so it wins over asight\'s block and Hermes is not captured while it is there',
  ])
  assert.deepEqual(notes({}), [], 'HERMES_MANAGED_DIR unset: a default /etc/hermes is unmeasured on macOS, so without the variable there is nothing to read (4.9 §2.3)')
})

// ── asight's own value is told from a user's CA by the plain path it wrote (no backslash or case dance exists on macOS; the exact compare is the report's APFS question) ──
import { isOwnPath } from '../../../src/collector/harness/_common.mjs'
test('W19: asight\'s own value — the plain path it wrote — is not read as a user CA when it comes back exactly as asight wrote it (Claude Code, Codex, Hermes, Z-Code)', () => {
  const OWN = { bundle: (h) => `/Users/u/.asight/collector/ca/combined-${h}.pem`, ca: '/Users/u/.asight/collector/ca/asight-ca.pem' }
  const files = new Map()
  const put = (p, t) => files.set(p, t)
  const readText = (f) => files.get(f) ?? null
  const listDir = (d) => { const pre = d.replace(/\/$/, '') + '/'; const out = new Set(); for (const k of files.keys()) if (k.startsWith(pre)) out.add(k.slice(pre.length).split('/')[0]); return [...out] }
  put('/Users/u/.codex/.env', `# BEGIN\nSSL_CERT_FILE=${OWN.bundle('codex')}\n# END\n`)
  put('/Users/u/.hermes/.env', `SSL_CERT_FILE=${OWN.bundle('hermes')}\n`)
  put('/Users/u/.zcode/cli/config.json', JSON.stringify({ network: { caCertFile: OWN.bundle('z-code') } }))
  put('/Users/u/.claude/settings.json', JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: OWN.ca } }))
  const env = new Map([['NODE_EXTRA_CA_CERTS', OWN.ca], ['SSL_CERT_FILE', OWN.bundle('codex')]])
  const ctx = { os: 'darwin', home: '/Users/u', env, running: [new Map([['NODE_EXTRA_CA_CERTS', OWN.ca], ['SSL_CERT_FILE', OWN.bundle('hermes')]])], readText, readTextOrError: (f) => ({ text: readText(f), error: null }), readBytes: () => null, listDir, collectorDir: DIR, caPem: '/Users/u/.asight/collector/ca/asight-ca.pem' }
  for (const name of ['codex', 'hermes', 'z-code', 'claude-code']) {
    const out = only(name)[0].darwin.inject(ctx)
    assert.deepEqual((out.files || []).flatMap((f) => f.certsFrom || []), [], `${name}: no CA file of the user's is found in what asight itself wrote`)
    assert.deepEqual((out.notes || []).map((n) => (typeof n === 'string' ? n : n.text)).filter((t) => /relative/.test(t)), [], `${name}: asight's own value is not reported as a relative CA path`)
    for (const e of out.entries || []) assert.ok(!/extra-cc/.test(String(e.value)), `${name}: Claude Code's key stays asight-ca.pem, it does not turn into a combined extra bundle`)
  }
  // a user's CA somewhere else is still found
  const userCa = '/corp/ca.pem'
  const claude = only('claude-code')[0].darwin.inject({ ...ctx, env: new Map([['NODE_EXTRA_CA_CERTS', userCa]]), running: [] })
  assert.deepEqual([claude.files.length, claude.files[0] && claude.files[0].certsFrom], [1, [userCa]], 'the user\'s own CA still takes the extra bundle')
})

test('isOwnPath: on macOS a path is asight\'s when it is under the collector directory as the plain exact-case prefix, and not for a sibling directory of a longer name; on Windows the slash and the case do not matter; elsewhere it is the plain prefix', () => {
  const mac = { os: 'darwin', collectorDir: '/Users/u/.asight/collector' }
  assert.equal(isOwnPath(mac, '/Users/u/.asight/collector/ca/x.pem'), true)
  for (const other of ['/Users/u/.asight/collector2/ca/x.pem', '/Users/u/.asight/collector', '/Users/u/corp/ca.pem', '/users/u/.asight/collector/ca/x.pem', '', null, undefined, 7]) assert.equal(isOwnPath(mac, other), false, `${String(other)}: the darwin compare is exact — APFS is case-insensitive by default, and whether darwin should get the win32 case-blind compare is the integrator's question`)
  assert.equal(isOwnPath({ os: 'darwin', collectorDir: '/Users/u/.asight/collector/' }, '/Users/u/.asight/collector/ca/x.pem'), false, 'a trailing slash on the directory is not today\'s darwin shape (the win line normalises it away): flagged in the port report')
  const win = { os: 'win32', collectorDir: 'C:\\Users\\u\\.asight\\collector' }
  for (const own of ['C:/Users/u/.asight/collector/ca/x.pem', 'C:\\Users\\u\\.asight\\collector\\ca\\x.pem', 'c:/USERS/U/.asight/Collector/ca/x.pem']) assert.equal(isOwnPath(win, own), true, own)
  for (const other of ['C:/Users/u/.asight/collector2/ca/x.pem', 'C:/Users/u/.asight/collector', 'C:/corp/ca.pem', '', null, undefined, 7]) assert.equal(isOwnPath(win, other), false, String(other))
  assert.equal(isOwnPath({ os: 'win32', collectorDir: 'C:/Users/u/.asight/collector/' }, 'C:/Users/u/.asight/collector/ca/x.pem'), true, 'a trailing slash on the directory')
  const lin = { os: 'linux', collectorDir: '/h/.asight/collector' }
  assert.equal(isOwnPath(lin, '/h/.asight/collector/ca/x.pem'), true)
  assert.equal(isOwnPath(lin, '/h/.asight/collector2/ca/x.pem'), false)
  assert.equal(isOwnPath(lin, '/H/.ASIGHT/collector/ca/x.pem'), false, 'case counts outside Windows')
})

// ── W20: the combined bundle's macOS roots (4.9 §6.2: the union of three sources, none a fallback for another) ──
import nodeFs from 'node:fs'
import { osRootsFor } from '../../../src/off/os-roots.mjs'
const darwinRoots = osRootsFor('darwin') // the readers are reached through their one table, as src/ reaches them
const unavailable = (e) => e instanceof Error && e.name === 'RootsUnavailableError'
import { rewriteBundles } from '../../../src/collector/core/trust/bundle.mjs'

const R = [createCa({ commonName: 'macOS root one' }), createCa({ commonName: 'macOS root two' }), createCa({ commonName: 'macOS root three' })].map((c) => c.certPem)
const BROKEN = '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n'
const fp = (pem) => new crypto.X509Certificate(pem).fingerprint256
const execOf = (pems, calls = []) => (file, args, opts) => { calls.push([file, args, opts]); return { status: 0, stdout: pems.join('\n'), stderr: '' } }

test('W20: the macOS roots are the union of Node\'s bundled set, the keychain\'s local trust anchors and the security export — parsed one by one: a certificate that does not parse is dropped and counted, a duplicate is kept once, and every source that contributed is named', async () => {
  const asked = []
  const calls = []
  const tls = { getCACertificates: (k) => { asked.push(k); return k === 'bundled' ? [R[0], BROKEN, R[1], R[0]] : [R[1], R[2]] } }
  const r = await darwinRoots({ tls, exec: execOf([R[0]], calls) })
  assert.deepEqual(asked, ['bundled', 'system'], 'both Node reads, bundled first (the steadier text for a certificate both hold)')
  assert.deepEqual([calls[0][0], calls[0][1]], ['security', ['find-certificate', '-a', '-p', '/System/Library/Keychains/SystemRootCertificates.keychain']], 'the read-only export of Apple\'s standard roots')
  assert.ok(calls[0][2].timeout >= 10000, 'a read-only CLI exporting one keychain: the call is given time (execTool hands the runner spawnSync\'s own options)')
  assert.deepEqual(r.source, ['node-bundled', 'node-system', 'security'], 'a union has no single winner: the array names every source that contributed, in the fixed order')
  assert.equal(r.dropped, 1)
  assert.deepEqual(r.pem.match(/-----BEGIN CERTIFICATE-----/g).length, 3, 'three distinct certificates: R0 R1 R2, each once however often the sources overlap')
  assert.ok(r.pem.includes(R[0].trim()) && r.pem.includes(R[1].trim()) && r.pem.includes(R[2].trim()) && !r.pem.includes('bm90IGEg'), 'the broken block is not in the text')
  assert.ok(r.pem.endsWith('\n') && !r.pem.includes('\n\n'))
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/)
  assert.deepEqual(r.tried, [], 'every source answered: nothing to say')
})

test('W20: a source that fails while the others give the set is named in tried (D38), and with no usable source at all the answer is a reason, not an empty bundle; the sandbox refusal is re-thrown, never passed off as a failed source', async () => {
  const oneDown = await darwinRoots({ tls: { getCACertificates: (k) => k === 'bundled' ? [R[0]] : (() => { throw Object.assign(new Error('no keychain read'), { code: 'EIO' }) })() }, exec: () => ({ status: 1, stdout: '', stderr: 'segv' }) })
  assert.deepEqual([oneDown.source, oneDown.tried], [['node-bundled'], ['node-system: EIO', 'security: segv']], 'a bundle quietly missing two of its three sources is not fine: both failures are said')
  const clean = await darwinRoots({ tls: { getCACertificates: (k) => k === 'bundled' ? [R[0]] : [] }, exec: execOf([R[1]]) })
  assert.deepEqual([clean.source, clean.tried], [['node-bundled', 'security'], []], 'a keychain with no added anchor answers empty: that is not a failed read (no daily alarm on a clean Mac)')
  // an EMPTY answer is not a failed read (above); a missing read is, and with no source at all every reason is kept, empty or failed, in source order
  const node20 = await darwinRoots({ tls: {}, exec: execOf([R[1]]) })
  assert.deepEqual([node20.source, node20.tried.length], [['security'], 1], 'Node 20: the standard set from the export, and the missing keychain read is said')
  assert.match(node20.tried[0], /^getCACertificates: not available/)
  await assert.rejects(darwinRoots({ tls: { getCACertificates: (k) => k === 'bundled' ? [] : (() => { throw Object.assign(new Error('x'), { code: 'EIO' }) })() }, exec: execOf([]) }),
    (e) => unavailable(e) && e.tried.join(' | ') === 'node-bundled: no certificate | node-system: EIO | security: no certificate', 'nothing at all: every source\'s reason, empty or failed, in source order')
  await assert.rejects(darwinRoots({ tls: {}, exec: () => ({ status: 1, stdout: '', stderr: '' }) }), (e) => unavailable(e) && /could not be read/.test(e.message) && e.tried.length === 2 && /Node ≥ 22.15/.test(e.tried[0]) && e.tried[1] === 'security: exit 1', 'no Node 22.15 read and a failed export: both reasons')
  await assert.rejects(darwinRoots({ tls: { getCACertificates: () => [BROKEN] }, exec: execOf([BROKEN]) }), (e) => unavailable(e) && e.tried.length === 3 && e.tried.every((t) => t.endsWith(': no certificate')), 'stores of nothing but broken certificates are not a root set')
  await assert.rejects(darwinRoots({ tls: {}, exec: () => { throw new Error('boom') } }), (e) => unavailable(e) && /security: boom/.test(e.message), 'a thrown runner is a reason')
  await assert.rejects(darwinRoots({ tls: { getCACertificates: () => [R[0]] }, exec: () => { throw Object.assign(new Error('sandbox'), { code: 'ESANDBOX' }) } }), (e) => e.code === 'ESANDBOX', 'the sandbox refusal reaches the test even when another source already gave a set')
})

test('W20: the fingerprint is of the set, not of its order or its duplicates, and changes with the set', async () => {
  const a = await darwinRoots({ tls: { getCACertificates: (k) => k === 'bundled' ? [R[0], R[1]] : [] }, exec: () => ({ status: 1, stdout: '', stderr: '' }) })
  assert.equal((await darwinRoots({ tls: { getCACertificates: (k) => k === 'bundled' ? [R[1], R[0], R[1]] : [R[0]] }, exec: () => ({ status: 1, stdout: '', stderr: '' }) })).fingerprint, a.fingerprint)
  assert.notEqual((await darwinRoots({ tls: { getCACertificates: (k) => k === 'bundled' ? [R[0], R[2]] : [] }, exec: () => ({ status: 1, stdout: '', stderr: '' }) })).fingerprint, a.fingerprint)
})

test('W20: the darwin reader reads no file at all — never the static /etc/ssl/cert.pem a lazy port would reach for, not even through the `read` the table\'s callers pass (off does)', async () => {
  assert.equal(darwinRoots.name, 'darwinRoots', 'darwin\'s entry of the one table (src/off/os-roots.mjs)')
  assert.ok(!/cert\.pem|\/etc\/ssl|readFile|createReadStream|\bfs\b|\bread\b/.test(darwinRoots.toString().replace(/\/\/.*$/gm, '')), 'its own code names no file and takes no reader')
  const reads = []
  const real = nodeFs.readFileSync
  nodeFs.readFileSync = (...a) => { reads.push(String(a[0])); return real(...a) }
  try { await osRootsFor('darwin')({ tls: { getCACertificates: (k) => k === 'bundled' ? [R[0]] : [] }, exec: execOf([R[1]]), read: (f) => { reads.push(f); return '' } }) } finally { nodeFs.readFileSync = real }
  assert.deepEqual(reads, [])
})

test('W20: the combined bundle is Node\'s roots, the macOS roots, the user\'s CAs and the asight CA, each once; a new macOS root rebuilds it atomically, an unchanged set leaves it alone', async () => {
  const b = box()
  const corp = createCa({ commonName: 'corp relay CA' })
  b.put('.codex/.env', `SSL_CERT_FILE=${b.put('corp.pem', corp.certPem)}\n`)
  const node = [R[2]] // stands in for tls.rootCertificates; one of the macOS roots is also a Node root
  const mac1 = await darwinRoots({ tls: { getCACertificates: (k) => k === 'bundled' ? [R[0], R[2], BROKEN] : [] }, exec: execOf([R[0]]) })
  await install(b, { harnesses: only('codex'), roots: { node, osText: mac1.pem } })
  const bundle = path.join(b.dir, 'ca', 'combined-codex.pem')
  const certs = (text) => text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g).map(fp)
  const asight = fp(fs.readFileSync(path.join(b.dir, 'ca', 'asight-ca.pem'), 'utf8'))
  assert.deepEqual(certs(fs.readFileSync(bundle, 'utf8')).sort(), [fp(R[2]), fp(R[0]), fp(corp.certPem), asight].sort(), 'Node roots ∪ macOS roots ∪ the user\'s CA ∪ the asight CA, the shared one once')
  assert.ok(!fs.readFileSync(bundle, 'utf8').includes('bm90IGEg'), 'the certificate that does not parse never reached the bundle')
  const m = readManifest(b.dir)
  const writes = []
  const recording = { ...nodeFs, renameSync: (a, c) => { writes.push(['rename', a, c]); return nodeFs.renameSync(a, c) }, openSync: (f, ...rest) => { writes.push(['open', f]); return nodeFs.openSync(f, ...rest) } }
  const caPem = fs.readFileSync(path.join(b.dir, 'ca', 'asight-ca.pem'), 'utf8')
  assert.deepEqual(rewriteBundles({ dir: b.dir, manifest: m, nodeRoots: node, osRootsText: mac1.pem, caPem, fs: recording }), [], 'the same macOS roots: nothing to rebuild')
  assert.deepEqual(writes, [])
  const mac2 = await darwinRoots({ tls: { getCACertificates: (k) => k === 'bundled' ? [R[0], R[1], R[2]] : [] }, exec: execOf([R[2]]) })
  assert.notEqual(mac2.fingerprint, mac1.fingerprint)
  assert.deepEqual(rewriteBundles({ dir: b.dir, manifest: m, nodeRoots: node, osRootsText: mac2.pem, caPem, fs: recording }), [bundle])
  const temp = writes.find((w) => w[0] === 'open' && w[1].startsWith(bundle + '.asight-tmp-'))
  assert.ok(temp, 'written to a temp file beside the bundle…')
  assert.deepEqual(writes.find((w) => w[0] === 'rename' && w[2] === bundle), ['rename', temp[1], bundle], '…and renamed over it: a reader sees the old bundle or the new, never half')
  assert.deepEqual(certs(fs.readFileSync(bundle, 'utf8')).sort(), [fp(R[2]), fp(R[0]), fp(R[1]), fp(corp.certPem), asight].sort())
  assert.deepEqual(fs.readdirSync(path.join(b.dir, 'ca')).filter((n) => n.includes('tmp')), [], 'no temp file left')
  assert.equal(readManifest(b.dir).files.find((f) => f.role === 'bundle').sha256, crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex'), 'the manifest names the new bytes')
})

// ── W19, the proxy half: each automatic proxy entry (data) written through the journal and undone to the byte ──
import { proxyEntries } from '../../../src/collector/arch/darwin/forms.mjs'
import { newManifest, applyJsonKey, applyTextEntry, undoEntry } from '../../../src/collector/core/trust/journal.mjs'
const INGRESS = { port: 17991, listenerToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }
const ctxOf = (b) => ({
  os: 'darwin', home: b.home, env: new Map([['HOME', b.home]]), running: [], collectorDir: b.dir, caPem: path.join(b.dir, 'ca', 'asight-ca.pem'),
  readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } },
  readTextOrError: (f) => { try { return { text: fs.readFileSync(f, 'utf8'), error: null } } catch (e) { return { text: null, error: e.code === 'ENOENT' ? null : { code: e.code, message: e.message } } } },
  readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } },
  listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } },
})
const USER = 'http://alice:s3cret@corp.example:3128'
const CASES = [
  { harness: 'claude-code', g: 'claude-code.settings', file: '.claude/settings.json', user: `{\n  "env": {\n    "HTTPS_PROXY": "${USER}",\n    "ANTHROPIC_BASE_URL": "https://relay.example.com"\n  }\n}\n`, value: (t) => JSON.parse(t).env.HTTPS_PROXY },
  { harness: 'z-code', g: 'z-code.cli', file: '.zcode/cli/config.json', user: `{"network": {"httpProxy": "${USER}", "caCertFile": ""}}\n`, value: (t) => JSON.parse(t).network.httpProxy },
  { harness: 'codex', g: 'codex.env', file: '.codex/.env', user: `OPENAI_API_KEY=sk-secret\nHTTPS_PROXY=${USER}\nNO_PROXY=intranet.example,10.0.0.0/8\n`, value: (t) => /^HTTPS_PROXY=(.*)$/m.exec(t)[1], block: true },
  { harness: 'deepseek-dsh', g: 'deepseek-dsh.env', file: '.dsh/.env', user: `DEEPSEEK_API_KEY=sk-secret\nHTTPS_PROXY=${USER}\n`, value: (t) => /^HTTPS_PROXY=(.*)$/m.exec(t)[1], block: true, noProxy: false }, // dsh's trust entry is the patch row, so its .env holds the proxy block alone
  { harness: 'hermes', g: 'hermes.cli', file: '.hermes/.env', user: `OPENROUTER_API_KEY=sk-secret\nHTTPS_PROXY=${USER}\n`, value: (t) => /^HTTPS_PROXY=(.*)$/m.exec(t)[1], block: true },
]
const URL_OF = (g) => `http://${g}:${INGRESS.listenerToken}@127.0.0.1:${INGRESS.port}`

// the files as a user on macOS has them: LF, or CRLF (an editor of another platform wrote it), in a user directory that has a space in it (/Users/John Smith, an OneDrive folder)
const SHAPES = [{ eol: '\n', sub: [], label: 'LF' }, { eol: '\r\n', sub: [], label: 'CRLF' }, { eol: '\r\n', sub: ['OneDrive - Contoso', 'John Smith'], label: 'CRLF, home with spaces' }]
for (const c0 of CASES) for (const shape of SHAPES) {
  const c = { ...c0, user: c0.user.replace(/\n/g, shape.eol) }
  test(`W19 proxy entry, ${c.g} (${shape.label}): pointed at the group's kernel port with the user's proxy recorded as prior_value (the manifest alone), then put back to the byte — with and without a user file`, () => {
    const b = box(...shape.sub)
    const group = only(c.harness)[0].darwin.groups.find((g) => g.g === c.g)
    const file = b.put(c.file, c.user)
    const ctx = ctxOf(b)
    // an agent that is installed but has no proxy of its own yet, and one that is not installed at all
    const entries = proxyEntries(group, ctx, INGRESS)
    assert.deepEqual(entries.map((e) => e.path), [file], 'the file the agent reads')
    const m = newManifest()
    const e = entries[0]
    const done = e.kind === 'text' ? applyTextEntry({ phase: 'install', dir: b.dir, home: b.home, manifest: m, harness: c.harness, file: e.path, edit: e }) : applyJsonKey({ phase: 'install', dir: b.dir, home: b.home, manifest: m, harness: c.harness, file: e.path, keys: e.keys, value: e.value })
    const written = fs.readFileSync(file, 'utf8')
    assert.equal(c.value(written), URL_OF(c.g), 'the agent now reads the group\'s port, with the credentials the listener asks for')
    if (c.block) assert.equal(/NO_PROXY=localhost,127\.0\.0\.1,::1\r?\n/.test(written), c.noProxy !== false, 'the loopback never goes round the kernel (a block that writes NO_PROXY)')
    if (c.block) assert.deepEqual([...parseDotenv(written)].filter(([k]) => k === 'HTTPS_PROXY'), [['HTTPS_PROXY', URL_OF(c.g)]], 'what the agent reads: the block\'s URL, the user\'s own line is behind the prefix and out of effect (the last assignment wins)')
    if (c.block && shape.eol === '\r\n') assert.ok(!/[^\r]\n/.test(written), 'a CRLF file stays CRLF: the block does not mix line endings in')
    assert.ok(JSON.stringify(done.prior_value).includes(USER), 'the user\'s own proxy is what the manifest records, to become the upstream')
    const leaks = []
    const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, n.name); if (n.isDirectory()) walk(f); else if (fs.readFileSync(f, 'utf8').includes('s3cret')) leaks.push(path.relative(b.home, f)) } }
    walk(b.dir)
    assert.deepEqual(leaks, [path.join('.asight', 'collector', 'install-manifest.json')], 'the credentials of the user\'s proxy are in the manifest and nowhere else asight writes')
    assert.equal(undoEntry(done).result, 'restored')
    assert.equal(fs.readFileSync(file, 'utf8'), c.user, 'byte for byte')
    // no file before: the entry creates it and off removes it again, with the directories it made
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
    const fresh = proxyEntries(group, { ...ctxOf(b), listDir: () => ['x'] }, INGRESS)
    if (fresh.length) {
      const m2 = newManifest()
      const d2 = fresh[0].kind === 'text' ? applyTextEntry({ phase: 'install', dir: b.dir, home: b.home, manifest: m2, harness: c.harness, file: fresh[0].path, edit: fresh[0] }) : applyJsonKey({ phase: 'install', dir: b.dir, home: b.home, manifest: m2, harness: c.harness, file: fresh[0].path, keys: fresh[0].keys, value: fresh[0].value })
      assert.equal(c.value(fs.readFileSync(fresh[0].path, 'utf8')), URL_OF(c.g))
      undoEntry(d2)
      assert.equal(fs.existsSync(fresh[0].path), false)
    }
  })
}

test('W19 proxy entry: Claude Desktop\'s measured door is the named launcher (4.9 §6.4, 2026-10-12) — no automatic entry is written, and its trust is the login-keychain opt-in', () => {
  const b = box()
  const desktop = only('claude-code')[0].darwin.groups.find((g) => g.g === 'claude-code.desktop')
  assert.equal(desktop.proxyEntry.kind, 'launcher', 'the door the lab verdict measured: a named launcher carrying Chromium\'s --proxy-server (env is dead to Desktop\'s Chromium network service)')
  assert.deepEqual(proxyEntries(desktop, ctxOf(b), INGRESS), [], 'a launcher is not one of the kinds anything writes automatically: naming the ROUTING item writes the launcher, naming the keychain one installs the CA')
  assert.deepEqual(desktop.optIn.map((o) => o.item), ['keychain-login', 'desktop-launcher'], 'the login-keychain item and the launcher item are the user\'s to name, never automatic')
})

test('W19 proxy entry: Claude Code and Z-Code write the proxy key beside the trust key in one file, and off takes them out in the opposite order to the original bytes', () => {
  for (const c of CASES.filter((x) => !x.block)) {
    const b = box()
    const d = only(c.harness)[0]
    const file = b.put(c.file, c.user)
    const ctx = ctxOf(b)
    const trust = planTrust({ descriptors: [d], ctxFor: () => ctx, caCertPem: CA.certPem, collectorDir: b.dir }).entries[0]
    const m = newManifest()
    const first = applyJsonKey({ phase: 'install', dir: b.dir, home: b.home, manifest: m, harness: c.harness, file: trust.path, keys: trust.keys, value: trust.value })
    const [p] = proxyEntries(d.darwin.groups.find((g) => g.g === c.g), ctx, INGRESS)
    const second = applyJsonKey({ phase: 'install', dir: b.dir, home: b.home, manifest: m, harness: c.harness, file: p.path, keys: p.keys, value: p.value })
    assert.equal(c.value(fs.readFileSync(file, 'utf8')), URL_OF(c.g))
    assert.ok(fs.readFileSync(file, 'utf8').includes(trust.value), 'both keys are there')
    assert.deepEqual([undoEntry(second).result, undoEntry(first).result], ['restored', 'restored'])
    assert.equal(fs.readFileSync(file, 'utf8'), c.user, c.g)
  }
})

// The same file for Codex and Hermes is one sentinel block holding the trust variable and the proxy lines, entered separately (4.8 §2.3). The journal's join is default-off
// (`joinBlock: true` on the entry, and only into a block this manifest lists for the same harness — Task 8's W19 gate, held here before 8(c) may write those two entries: audit F5).
// With it, the combined case of W19: both write orders undo LIFO to the byte, the user's edit around the block survives with asight's text gone, CRLF and a home with spaces hold,
// and the credentials of the user's proxy in prior_value reach the manifest alone.
test('W19 GATE (Task 8(v) run, audit F5): Codex and Hermes — the proxy lines join the sentinel block the trust entry wrote (default-off join), off undoes the two in LIFO order to the original bytes in both write orders and after the user edited around the block, in LF and CRLF files and in a home with spaces, and the user\'s proxy credentials in prior_value reach no install note', () => {
  for (const c of CASES.filter((x) => x.block && x.harness !== 'deepseek-dsh')) for (const shape of SHAPES) for (const order of ['trust-first', 'proxy-first']) {
    const user = c.user.replace(/\n/g, shape.eol)
    const b = box(...shape.sub)
    const d = only(c.harness)[0]
    const file = b.put(c.file, user)
    const ctx = ctxOf(b)
    const trust = planTrust({ descriptors: [d], ctxFor: () => ctx, caCertPem: CA.certPem, collectorDir: b.dir }).entries[0]
    const [proxy] = proxyEntries(d.darwin.groups.find((g) => g.g === c.g), ctx, INGRESS)
    assert.equal(trust.path, proxy.path, 'one file: the trust block and the proxy lines are entered separately into it')
    // the join is not the default: without joinBlock the journal still refuses a second block in a file that already holds one
    const m0 = newManifest()
    const alone = applyTextEntry({ phase: 'install', dir: b.dir, home: b.home, manifest: m0, harness: c.harness, file: trust.path, edit: trust })
    assert.throws(() => applyTextEntry({ phase: 'install', dir: b.dir, home: b.home, manifest: m0, harness: c.harness, file: proxy.path, edit: proxy }), /already holds asight's text/, 'the join is an explicit opt-in of the entry, never a silent second block')
    assert.equal(undoEntry(alone).result, 'restored')
    assert.equal(fs.readFileSync(file, 'utf8'), user, 'the probe round leaves the file as the user had it')
    const m = newManifest()
    const write = (e, join) => applyTextEntry({ phase: 'install', dir: b.dir, home: b.home, manifest: m, harness: c.harness, file: e.path, edit: join ? { ...e, joinBlock: true, quote: true } : e })
    const first = order === 'trust-first' ? write(trust) : write(proxy)
    const second = order === 'trust-first' ? write(proxy, true) : write(trust, true) // whichever comes second joins the block the first wrote
    const written = fs.readFileSync(file, 'utf8')
    assert.equal(written.split('>>> asight collector >>>').length - 1, 1, 'one sentinel block holds both halves')
    assert.equal(written.split('\n').filter((l) => /^HTTPS_PROXY=/.test(l.replace('\r', ''))).length, 1, 'the block\'s line is the only one in effect: the user\'s own is behind the off-prefix')
    const env = new Map(parseDotenv(written))
    assert.equal(env.get('HTTPS_PROXY'), URL_OF(c.g))
    assert.equal(env.get('SSL_CERT_FILE'), path.join(b.dir, 'ca', `combined-${c.harness}.pem`), 'the trust half reads back whole (double-quoted in a home with spaces, plain otherwise)')
    if (shape.eol === '\r\n') assert.ok(!/[^\r]\n/.test(written), 'a CRLF file stays CRLF')
    const prior = m.entries.find((e) => e.vars && 'HTTPS_PROXY' in e.vars).prior_value
    assert.equal(prior && prior.HTTPS_PROXY, USER, 'the user\'s own proxy is what the manifest records, to become the upstream')
    const leaks = []
    const walk = (dd) => { for (const n of fs.readdirSync(dd, { withFileTypes: true })) { const f = path.join(dd, n.name); if (n.isDirectory()) walk(f); else if (fs.readFileSync(f, 'utf8').includes('s3cret')) leaks.push(path.relative(b.home, f)) } }
    walk(b.dir)
    assert.deepEqual(leaks, [path.join('.asight', 'collector', 'install-manifest.json')], 'the credentials of the user\'s proxy are in the manifest and nowhere else asight writes: no install note, no event, no receipt half')
    assert.deepEqual([!!first, !!second, m.entries.length, new Set(m.entries.flatMap((e) => Object.keys(e.vars || {}))).size], [true, true, 2, 3], 'both halves are entered, each with its own record (SSL_CERT_FILE, HTTPS_PROXY, NO_PROXY)')
    // LIFO undo restores the user's bytes in both write orders
    assert.deepEqual([undoEntry(m.entries[1]).result, undoEntry(m.entries[0]).result], ['restored', 'restored'], `LIFO (${order})`)
    assert.equal(fs.readFileSync(file, 'utf8'), user, 'byte for byte')
    // the user edited around the block: asight's text goes, the user's bytes (their edit included) stay (D28: never a whole-file rollback)
    const m2 = newManifest()
    applyTextEntry({ phase: 'install', dir: b.dir, home: b.home, manifest: m2, harness: c.harness, file: trust.path, edit: order === 'trust-first' ? trust : proxy })
    applyTextEntry({ phase: 'install', dir: b.dir, home: b.home, manifest: m2, harness: c.harness, file: trust.path, edit: order === 'trust-first' ? { ...proxy, joinBlock: true, quote: true } : { ...trust, joinBlock: true, quote: true } })
    const edited = user + `EXTRA_FLAG=1${shape.eol}` // the user's own line, after the block
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + `EXTRA_FLAG=1${shape.eol}`)
    assert.deepEqual([undoEntry(m2.entries[1]).result, undoEntry(m2.entries[0]).result], ['reverted-not-identical', 'reverted-not-identical'], 'the edited-since fallback of removeAsightText, LIFO')
    assert.equal(fs.readFileSync(file, 'utf8'), edited, 'the user\'s file, their edit included, with nothing of asight\'s left')
  }
})

// ── W22: dsh and OpenCode (the plugin sources themselves: darwin-plugins.test.mjs) ──
const ROW = (dir) => `- insert: [{ name: ${JSON.stringify(path.join(dir, 'plugins', 'dsh', 'index.js'))} }]`
const fwdJson = (p) => JSON.stringify(p) // a path as the plugin source holds it: a double-quoted string literal
test('W22 dsh: the patch row is the macOS shape — the plugin in asight\'s own directory, named by its absolute path — with the sentinel comment; off takes the row and the plugin out (the patch file asight created goes with them)', async () => {
  for (const existing of [true, false]) {
    const b = box()
    const patch = path.join(b.home, '.dsh', 'cordis.patch.yml')
    if (existing) b.put('.dsh/cordis.patch.yml', '- insert: [{ name: other-plugin }]\n')
    b.put('.dsh/.env', 'DEEPSEEK_API_KEY=sk\n')
    const before = b.snapshot()
    await install(b, { harnesses: only('deepseek-dsh') })
    const plugin = path.join(b.dir, 'plugins', 'dsh', 'index.js')
    const rows = fs.readFileSync(patch, 'utf8').split('\n').filter((l) => l.startsWith(ROW(b.dir)))
    assert.equal(rows.length, 1)
    assert.ok(rows[0].startsWith(`${ROW(b.dir)} # asight collector: `), `the row, then the sentinel comment: ${rows[0]}`)
    assert.ok(!/\\/.test(rows[0]))
    assert.ok(fs.existsSync(plugin) && fs.existsSync(path.join(b.dir, 'plugins', 'dsh', 'package.json')), 'the plugin lives in asight\'s own directory with its module manifest, not beside the patch file (the Windows shape is not macOS\'s, 4.9 §2.3)')
    const text = fs.readFileSync(plugin, 'utf8')
    assert.ok(text.startsWith('// asight collector: trust plugin for DeepSeek dsh on macOS') && text.includes(fwdJson(path.join(b.dir, 'ca', 'asight-ca.pem'))), 'the darwin twin of the plugin, with this user\'s CA file filled in')
    assert.ok(text.includes('performance.timeOrigin') && !/['"]\/proc/.test(text), 'darwin has no /proc to read: the marker\'s start time is the process\'s own')
    assert.deepEqual(readManifest(b.dir).files.filter((f) => f.role === 'plugin').map((f) => f.path), [plugin, path.join(b.dir, 'plugins', 'dsh', 'package.json')], 'ledgered, so off removes it')
    assert.deepEqual(readManifest(b.dir).entries.map((e) => [e.path, e.line.startsWith(ROW(b.dir))]), [[patch, true]])
    await uninstall(b, only('deepseek-dsh'))
    assert.deepEqual([...b.snapshot()], [...before], `${existing ? 'the user\'s patch file' : 'no patch file'} and no residue after off`)
  }
})

test('W22 dsh: DSH_HOME moves the patch file (the plugin stays in asight\'s directory), and a patch file that is not a list is refused before anything is written', async () => {
  const b = box()
  b.put('D/dsh/cordis.patch.yml', 'name: not a list\n')
  await assert.rejects(install(b, { harnesses: only('deepseek-dsh'), env: { HOME: b.home, DSH_HOME: path.join(b.home, 'D', 'dsh') } }), /not a block-style YAML list/)
  assert.ok(!fs.existsSync(path.join(b.home, 'D', 'dsh', 'asight-ca.mjs')), 'nothing was written')
  fs.writeFileSync(path.join(b.home, 'D', 'dsh', 'cordis.patch.yml'), '')
  await install(b, { harnesses: only('deepseek-dsh'), env: { HOME: b.home, DSH_HOME: path.join(b.home, 'D', 'dsh') } })
  assert.ok(fs.existsSync(path.join(b.dir, 'plugins', 'dsh', 'index.js')) && fs.readFileSync(path.join(b.home, 'D', 'dsh', 'cordis.patch.yml'), 'utf8').includes(ROW(b.dir)), 'the row names the plugin wherever the patch file lives, and the plugin does not move with it')
})

test('W22 OpenCode: the plugin is OpenCode\'s own asight-ca.js with the darwin source (a Node sidecar or Bun), the watch list and notes of the Linux harness stay, and off removes the file and the directories asight made', async () => {
  const b = box()
  const dir = path.join(b.home, '.config', 'opencode')
  const before = b.snapshot()
  const r = await install(b, { harnesses: only('opencode') })
  const plugin = path.join(dir, 'plugins', 'asight-ca.js')
  const text = fs.readFileSync(plugin, 'utf8')
  assert.ok(text.startsWith('// asight collector: trust plugin for OpenCode on macOS') && text.includes('tls.setDefaultCACertificates') && text.includes('globalThis.fetch'), 'both ways in the one file')
  assert.ok(text.includes('performance.timeOrigin') && !/['"]\/proc/.test(text), 'darwin has no /proc to read: the marker\'s start time is the process\'s own')
  assert.ok(text.includes(fwdJson(path.join(b.dir, 'ca', 'asight-ca.pem'))) && text.includes(fwdJson(path.join(b.dir, 'run', 'trust'))), 'this user\'s CA file and marker directory')
  assert.deepEqual(readManifest(b.dir).planned, [plugin], 'the plugin is the only automatic item of an opt-in harness: no shim, no PATH line')
  assert.ok(r.plan.notes.some((n) => /@opencode-ai\/plugin/.test(n)), 'the note about its first run stays')
  await uninstall(b, only('opencode'))
  assert.deepEqual([...b.snapshot()], [...before])
  assert.ok(!fs.existsSync(dir), 'the plugins directory asight created is gone')
})

test('W22: the paths a plugin file holds are the POSIX paths of the collector directory as they are, and the darwin twins carry the timeOrigin marker — for dsh and for OpenCode alike', () => {
  const ctx = { os: 'darwin', home: '/Users/u', env: new Map(), running: [], collectorDir: '/Users/u/.asight/collector', caPem: '/Users/u/.asight/collector/ca/asight-ca.pem', readText: () => null, listDir: () => [] }
  for (const h of ['deepseek-dsh', 'opencode']) {
    const [plugin] = only(h)[0].darwin.inject(ctx).owned
    assert.match(plugin.data, /const CA_FILE = "\/Users\/u\/\.asight\/collector\/ca\/asight-ca\.pem"/, h)
    assert.match(plugin.data, /const MARKER_DIR = "\/Users\/u\/\.asight\/collector\/run\/trust"/, h)
    assert.match(plugin.data, /String\(Math\.round\(performance\.timeOrigin\)\)/, `${h}: the darwin twin's marker`)
    assert.ok(!/['"]\/proc/.test(plugin.data), `${h}: no /proc path to read on darwin`)
  }
})

test('W19 + W23: all seven harnesses installed together — only the automatic files change, every file an opt-in item owns stays byte for byte, and off puts everything back', async () => {
  const b = box()
  const owned = [ // what a user has and an opt-in item would change: nothing here may move
    b.put('.kimi-code/bin/kimi', 'MACHO'), b.put('Library/Application Support/Code/User/settings.json', '{"http.proxy": "http://corp:3128"}\n'),
    b.put('.zshrc', 'export PATH="/usr/local/bin:$PATH"\n'), b.put('.zshenv', ''), b.put('.zprofile', ''), b.put('.zlogin', ''), // kimi's opt-in PATH lines wait for the opt-in
  ]
  const user = [b.put('.claude/settings.json', '{"env": {}}\n'), b.put('.codex/.env', 'K=1\n'), b.put('.zcode/cli/config.json', '{}\n'), b.put('.dsh/cordis.patch.yml', '- insert: [{ name: p }]\n'), b.put('.dsh/.env', 'K=1\n'), b.put('.hermes/.env', 'K=1\n')]
  const before = b.snapshot()
  const all = ALL
  await install(b, { harnesses: all })
  const changed = [...b.snapshot()].filter(([f, h]) => before.get(f) !== h).map(([f]) => f)
  const planned = readManifest(b.dir).planned.filter((p) => !p.startsWith(b.dir))
  assert.deepEqual(changed.sort(), [user[0], user[1], user[2], user[3], user[5], path.join(b.home, '.config', 'opencode', 'plugins', 'asight-ca.js')].sort(), 'the trust entries and OpenCode\'s plugin in the user\'s directory; .dsh/.env waits for the proxy entry (Task 8), and dsh\'s plugin is asight\'s own file under .asight')
  assert.deepEqual([...planned].sort(), changed.sort(), 'the manifest lists exactly what changed')
  for (const f of owned) assert.equal(b.snapshot().get(f), before.get(f), `${path.relative(b.home, f)} is untouched`)
  await uninstall(b, all)
  assert.deepEqual([...b.snapshot()], [...before])
})

// The desktop family's trust door (4.9 §6.4) is judged by Chromium role since D51④: test/collector/harness/claude-code-roles.test.mjs.
