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
