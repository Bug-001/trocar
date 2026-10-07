// test/collector/harness/win32-trust.test.mjs — the Windows trust entries (RFC 4.8 §6.1 · §6.2; acceptance W19, W20, W22, and W23's "zero writes" half). Two halves: planTrust in its Windows mode
// on made-up Windows paths (the checks that only a `C:\…` path can hit), and the real install / uninstall of the harnesses' win32 data in a sandbox HOME laid out like %USERPROFILE%.
// A proxy entry is data written after the kernel's read-back (Task 8): the plan holds trust entries only, which this file asserts.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { planTrust } from '../../../src/collector/core/trust/plan.mjs'
import { installCollector, uninstallCollector } from '../../../src/collector/install.mjs'
import { readManifest, installedAt } from '../../../src/collector/core/trust/journal.mjs'
import { parseDotenv } from '../../../src/collector/core/config-read.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

const raw = String.raw
const CA = createCa({ commonName: 'asight collector CA' })
const ALL = await loadHarnesses()
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

// ── planTrust on Windows paths ──
const DIR = raw`C:\Users\u\.asight\collector`
const BUNDLE = raw`C:\Users\u\.asight\collector\ca\combined-alpha.pem`
const plan = (win32, os = 'win32', extra = {}) => planTrust({ descriptors: [{ name: 'alpha', win32, ...extra }], ctxFor: () => ({ os, readText: () => null }), caCertPem: CA.certPem, collectorDir: DIR })
const dotenv = (o = {}) => ({ kind: 'text', format: 'dotenv-block', path: raw`C:\Users\u\.alpha\.env`, vars: { SSL_CERT_FILE: BUNDLE }, semantic: 'replace', ...o })
const jsonKey = (o = {}) => ({ kind: 'json-key', path: raw`C:\Users\u\.alpha\settings.json`, keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: raw`C:\Users\u\.asight\collector\ca\asight-ca.pem`, semantic: 'append', ...o })

test('W19 plan: every path an entry writes into an agent config has forward slashes, the file locations stay as they are, and the checks read Windows paths (either slash, any case)', () => {
  const p = plan({ inject: () => ({ entries: [dotenv(), jsonKey()], files: [{ path: BUNDLE, bundle: true }] }) })
  assert.deepEqual(p.entries.map((e) => e.vars ? e.vars.SSL_CERT_FILE : e.value), ['C:/Users/u/.asight/collector/ca/combined-alpha.pem', 'C:/Users/u/.asight/collector/ca/asight-ca.pem'], 'dotenvy reads a backslash as an escape and drops the value')
  assert.deepEqual(p.entries.map((e) => e.path), [raw`C:\Users\u\.alpha\.env`, raw`C:\Users\u\.alpha\settings.json`], 'where the file is: untouched')
  assert.deepEqual(p.files.map((f) => f.path), [BUNDLE])
  assert.equal(plan({ inject: () => ({ entries: [jsonKey({ value: 'c:/USERS/U/.ASIGHT/Collector/ca/x.pem' })] }) }).entries[0].value, 'c:/USERS/U/.ASIGHT/Collector/ca/x.pem', 'Windows paths compare ignoring case')
  assert.throws(() => plan({ inject: () => ({ entries: [jsonKey({ value: raw`C:\Users\u\other\x.pem` })] }) }), /must be a file under/)
  assert.throws(() => plan({ inject: () => ({ entries: [jsonKey({ value: raw`ca\x.pem` })] }) }), /must be absolute/)
  assert.throws(() => plan({ inject: () => ({ entries: [jsonKey({ path: 'settings.json' })] }) }), /must be absolute/)
  assert.throws(() => plan({ inject: () => ({ entries: [dotenv()] }) }), /does not declare as its combined bundle/, 'a replace entry still needs its own declared bundle')
  assert.throws(() => plan({ inject: () => ({ entries: [dotenv({ vars: { SSL_CERT_FILE: raw`C:\Users\u\.asight\collector\ca\combined-beta.pem` } })], files: [{ path: BUNDLE, bundle: true }] }) }), /combined-alpha\.pem/)
  assert.throws(() => plan({ inject: () => ({ entries: [jsonKey({ keys: ['env', 'NODE_OPTIONS'] })] }) }), /never written/)
})

test('W19 plan: a dotenv block entry on Windows asks to be written quoted when its value needs it (a profile with a space); on Linux it does not, so the unquoted-only rule stays', () => {
  const p = plan({ inject: () => ({ entries: [dotenv()], files: [{ path: BUNDLE, bundle: true }] }) })
  assert.deepEqual([p.entries[0].quote, p.entries[0].vars.SSL_CERT_FILE], [true, 'C:/Users/u/.asight/collector/ca/combined-alpha.pem'], 'the plain forward-slash path stays the entry\'s value')
  assert.equal(plan({ inject: () => ({ entries: [jsonKey()] }) }).entries[0].quote, undefined, 'a JSON key has no quotes to choose')
  const lin = planTrust({ descriptors: [{ name: 'alpha', inject: () => ({ entries: [{ kind: 'text', format: 'dotenv-block', path: '/h/.alpha/.env', vars: { SSL_CERT_FILE: '/h/.asight/collector/ca/combined-alpha.pem' }, semantic: 'replace' }], files: [{ path: '/h/.asight/collector/ca/combined-alpha.pem', bundle: true }] }) }], ctxFor: () => ({ os: 'linux', readText: () => null }), caCertPem: CA.certPem, collectorDir: '/h/.asight/collector' })
  assert.equal(lin.entries[0].quote, undefined)
})

test('W19 plan: the PowerShell profile is the Windows login environment and is never an entry; a shim lives in the collector\'s bin directory and nowhere else', () => {
  for (const bad of [raw`C:\Users\u\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`, raw`C:\Users\u\Documents\PowerShell\profile.ps1`, 'C:/Users/u/Documents/PowerShell/Microsoft.VSCode_profile.ps1']) {
    assert.throws(() => plan({ inject: () => ({ entries: [jsonKey({ path: bad })] }) }), /login-environment/, bad)
    assert.throws(() => plan({ inject: () => ({ owned: [{ path: bad, role: 'plugin', data: '// asight collector' }] }) }), /login-environment/, bad)
  }
  const shim = (p) => plan({ inject: () => ({ owned: [{ path: p, role: 'shim', data: '@echo off' }] }) })
  assert.equal(shim(raw`C:\Users\u\.asight\collector\bin\kimi.cmd`).owned.length, 1)
  assert.throws(() => shim(raw`C:\Users\u\bin\kimi.cmd`), /shim directory/)
  assert.throws(() => plan({ inject: () => ({ owned: [{ path: raw`C:\Users\u\.asight\collector\bin\x.js`, role: 'plugin', data: '// asight collector' }] }) }), /holds launch shims only/)
  assert.throws(() => plan({ inject: () => ({ owned: [{ path: raw`C:\Users\u\.config\opencode\plugins\p.js`, role: 'plugin', data: '// asight collector' }] }) }), /"asight" in its name/)
  assert.equal(plan({ inject: () => ({ owned: [{ path: raw`C:\Users\u\.config\opencode\plugins\asight-ca.js`, role: 'plugin', data: '// asight collector: x' }] }) }).owned.length, 1)
})

test('W19 plan: only the OS the entries are for is asked — a harness without Windows data writes nothing on Windows, and Windows data is never read for another OS', () => {
  let called = []
  const d = { name: 'alpha', win32: { inject: () => { called.push('win32'); return { entries: [jsonKey()] } } }, inject: () => { called.push('linux'); return { entries: [jsonKey({ path: '/h/.alpha/settings.json', value: '/h/.asight/collector/ca/asight-ca.pem' })] } } }
  const win = planTrust({ descriptors: [d], ctxFor: () => ({ os: 'win32' }), caCertPem: CA.certPem, collectorDir: DIR })
  assert.deepEqual([called, win.entries.length], [['win32'], 1])
  called = []
  const lin = planTrust({ descriptors: [d], ctxFor: () => ({ os: 'linux' }), caCertPem: CA.certPem, collectorDir: '/h/.asight/collector' })
  assert.deepEqual([called, lin.entries.length], [['linux'], 1])
  assert.deepEqual(planTrust({ descriptors: [{ name: 'only-linux', inject: () => ({ entries: [jsonKey()] }) }], ctxFor: () => ({ os: 'win32' }), caCertPem: CA.certPem, collectorDir: DIR }).paths, [])
})

// ── the real data in a sandbox HOME laid out like %USERPROFILE% ──
function box(...sub) { // `sub`: segments under the temp directory, e.g. a profile directory with a space in it
  const home = path.join(tmpDir('asight-w19-'), ...sub)
  fs.mkdirSync(home, { recursive: true })
  const put = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  const snapshot = () => { const out = new Map(); const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (f === path.join(home, '.asight')) continue; if (e.isDirectory()) walk(f); else out.set(f, sha(fs.readFileSync(f))) } }; walk(home); return out }
  return { home, dir: path.join(home, '.asight', 'collector'), put, snapshot }
}
const names = ['claude-code', 'codex', 'kimi-code', 'z-code']
const install = (b, over = {}) => installCollector({ home: b.home, env: { HOME: b.home, USERPROFILE: b.home }, osName: 'win32', harnesses: ALL.filter((d) => names.includes(d.name)), freePort: async () => 47011, roots: { node: [], osText: '' }, ...over })
const uninstall = (b, harnesses = ALL.filter((d) => names.includes(d.name))) => uninstallCollector({ home: b.home, env: {}, stop: async () => 'none', harnesses, roots: { node: [], osText: '' } })

test('W19: on writes each automatic trust entry and off puts every file back to its pre_sha256; nothing outside the plan is touched, nothing a user has to name is written', async () => {
  const b = box()
  const corp = createCa({ commonName: 'corp relay CA' })
  const claude = b.put('.claude/settings.json', '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://relay.example.com"\n  },\n  "theme": "dark"\n}\n')
  const codex = b.put('.codex/.env', 'OPENAI_API_KEY=sk-secret\nHTTPS_PROXY=http://corp-proxy:3128\n# a comment\n')
  b.put('.zcode/cli/config.json', '{"network": {"proxy": "none"}}\n') // Z-Code ran once: its home exists, the key is added inside the user's own object
  b.put('.kimi-code/bin/kimi.exe', 'MZ')
  b.put('AppData/Roaming/Code/User/settings.json', '{"editor.fontSize": 12}\n')
  b.put('AppData/Local/OpenAI/Codex/bin/0123/codex.exe', 'MZ')
  const corpFile = b.put('corp.pem', corp.certPem)
  const before = b.snapshot()
  const r = await install(b, { env: { HOME: b.home, USERPROFILE: b.home, NODE_EXTRA_CA_CERTS: corpFile } })
  const m = readManifest(b.dir)
  assert.equal(m.complete, true)
  const zconf = path.join(b.home, '.zcode', 'cli', 'config.json')
  // trust entries only: the CA keys and the one block of SSL_CERT_FILE, whose paths are forward-slashed; no proxy key anywhere (that entry is Task 8's, after the read-back)
  const holding = (re) => [...b.snapshot().keys()].filter((f) => re.test(fs.readFileSync(f, 'utf8')))
  assert.deepEqual(holding(/httpProxy|NO_PROXY|"HTTPS_PROXY"/), [], 'no proxy entry in anything the plan wrote')
  assert.equal(fs.readFileSync(codex, 'utf8').match(/HTTPS_PROXY=/g).length, 1, 'Codex\'s .env still has only the user\'s own HTTPS_PROXY line')
  assert.equal(JSON.parse(fs.readFileSync(claude, 'utf8')).env.NODE_EXTRA_CA_CERTS, path.join(b.dir, 'ca', 'extra-cc.pem'), 'the corp CA of the shell is carried into extra-cc.pem')
  assert.match(fs.readFileSync(codex, 'utf8'), /SSL_CERT_FILE=\S+combined-codex\.pem\n/)
  assert.equal(JSON.parse(fs.readFileSync(zconf, 'utf8')).network.caCertFile, path.join(b.dir, 'ca', 'combined-z-code.pem'))
  for (const e of m.entries) assert.ok(!/\\/.test(e.value || Object.values(e.vars).join('')), `${e.path}: forward slashes in what is written`)
  // the plan is exactly the automatic set: no Kimi shim, no VS Code setting, no Z-Code Desktop setting, no launcher, no registry
  assert.deepEqual([...m.planned].sort(), [claude, codex, zconf, path.join(b.dir, 'ca', 'combined-codex.pem'), path.join(b.dir, 'ca', 'combined-z-code.pem'), path.join(b.dir, 'ca', 'extra-cc.pem')].sort())
  const after = b.snapshot()
  const changed = [...after].filter(([f, h]) => before.get(f) !== h).map(([f]) => f)
  assert.deepEqual(changed.sort(), [claude, codex, zconf].sort(), 'every other file of the user\'s is byte for byte as it was')
  for (const e of m.entries) assert.ok(e.pre_sha256 || !e.existed_before, `${e.path}: its pre_sha256 is recorded`)
  assert.ok(r.plan.paths.every((p) => !/Code[\\/]User|v2[\\/]setting|Start Menu|\.lnk$|\.cmd$|\.kimi-code/.test(p)), 'an opt-in item writes nothing until it is named')
  await uninstall(b)
  assert.deepEqual([...b.snapshot()], [...before], 'the user\'s files are back to the bytes they had (their pre_sha256)')
  assert.deepEqual(fs.readdirSync(b.dir), ['flows'], 'only the records of what install and uninstall said remain of the collector directory')
})

const only = (name) => ALL.filter((d) => d.name === name)
test('W19: Hermes — the block goes into the .env of %LOCALAPPDATA%\\hermes and of each profile, with HERMES_CA_BUNDLE for a release up to v2026.9.24, the user\'s CA is carried into the bundle, and off restores every byte', async () => {
  const b = box()
  const corp = createCa({ commonName: 'corp relay CA' })
  const corpFile = b.put('corp.pem', corp.certPem)
  const rootEnv = b.put('AppData/Local/hermes/.env', `OPENROUTER_API_KEY=sk-secret\nSSL_CERT_FILE=${corpFile}\n`)
  b.put('AppData/Local/hermes/hermes-agent/install-stamp.json', '{"tag":"v2026.9.20"}')
  b.put('AppData/Local/hermes/hermes-agent/.env', 'FOO=1\n')
  b.put('AppData/Local/hermes/profiles/work/config.yaml', 'model: x\n')
  const before = b.snapshot()
  const r = await install(b, { harnesses: only('hermes') })
  const profileEnv = path.join(b.home, 'AppData', 'Local', 'hermes', 'profiles', 'work', '.env')
  const bundle = path.join(b.dir, 'ca', 'combined-hermes.pem')
  assert.deepEqual([...readManifest(b.dir).planned].sort(), [bundle, profileEnv, rootEnv].sort())
  for (const f of [rootEnv, profileEnv]) assert.match(fs.readFileSync(f, 'utf8'), new RegExp(`SSL_CERT_FILE=${bundle.replace(/[.\\]/g, '\\$&')}\\nHERMES_CA_BUNDLE=${bundle.replace(/[.\\]/g, '\\$&')}\\n`), `${f}: both variables (a release of that date reads the first of HERMES_CA_BUNDLE / SSL_CERT_FILE)`)
  assert.match(fs.readFileSync(rootEnv, 'utf8'), /OPENROUTER_API_KEY=sk-secret/, 'the user\'s other lines are untouched')
  assert.ok(fs.readFileSync(bundle, 'utf8').includes(corp.certPem.trim()), 'the CA the user\'s SSL_CERT_FILE named is carried into the bundle')
  assert.ok(r.plan.notes.some((n) => /does not exist, so asight creates it.*as a fill instead of an override/.test(n)), 'creating the profile\'s .env turns the checkout .env into a fill: said')
  await uninstall(b, only('hermes'))
  assert.deepEqual([...b.snapshot()], [...before])
})

test('W19: Hermes — no %LOCALAPPDATA%\\hermes means no entry and a note; HERMES_HOME naming a profile finds the root above it; a newer release gets only SSL_CERT_FILE', () => {
  const hermes = only('hermes')[0].win32
  const b = box()
  const ctx = (env = {}, over = {}) => ({ os: 'win32', home: b.home, env: new Map(Object.entries(env)), running: [], collectorDir: b.dir, caPem: path.join(b.dir, 'ca', 'asight-ca.pem'), readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }, listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } }, ...over })
  const none = hermes.inject(ctx())
  assert.deepEqual([none.entries, none.notes.map((n) => n.code)], [undefined, ['harness-note']])
  const root = path.join(b.home, 'D', 'hermes')
  b.put('D/hermes/profiles/work/config.yaml', 'x: 1\n')
  b.put('D/hermes/hermes-agent/install-stamp.json', '{"tag":"v2026.10.2"}')
  const got = hermes.inject(ctx({ HERMES_HOME: path.join(root, 'profiles', 'work') }))
  assert.deepEqual(got.entries.map((e) => [e.path, Object.keys(e.vars)]), [[path.join(root, '.env'), ['SSL_CERT_FILE']], [path.join(root, 'profiles', 'work', '.env'), ['SSL_CERT_FILE']]])
  assert.deepEqual(hermes.groups[0].proxyEntry.files(ctx({ HERMES_HOME: path.join(root, 'profiles', 'work') })), got.entries.map((e) => e.path), 'the proxy entry goes into the files the trust block does')
  assert.deepEqual(hermes.groups[0].proxyEntry.files(ctx()), [], 'not installed: no file')
})

// ── W19 in the profiles Windows users really have: a space in the profile directory, and files that an editor there wrote with CRLF ──
// Every harness's user files as one user has them; `eol` is the line ending of the files, `corp` a corporate CA the user's own SSL_CERT_FILE / NODE_EXTRA_CA_CERTS lines name.
function seedAll(b, eol, corp) {
  const nl = (t) => t.replace(/\n/g, eol)
  const corpFile = b.put('corp.pem', corp.certPem)
  b.put('.claude/settings.json', nl('{\n  "env": {\n    "NODE_EXTRA_CA_CERTS": "' + corpFile.replace(/\\/g, '/') + '"\n  },\n  "theme": "dark"\n}\n'))
  b.put('.codex/.env', nl(`OPENAI_API_KEY=sk-secret\nSSL_CERT_FILE=${corpFile}\nHTTPS_PROXY=http://corp:3128\n# a comment\n`))
  b.put('.zcode/cli/config.json', nl('{\n  "network": {\n    "caCertFile": "' + corpFile.replace(/\\/g, '/') + '"\n  }\n}\n'))
  b.put('.dsh/cordis.patch.yml', nl('- insert: [{ name: other-plugin }]\n'))
  b.put('.dsh/.env', nl('DEEPSEEK_API_KEY=sk-secret\n'))
  b.put('AppData/Local/hermes/.env', nl(`OPENROUTER_API_KEY=sk-secret\nSSL_CERT_FILE=${corpFile}\nHTTPS_PROXY=http://corp:3128\n`))
  b.put('AppData/Local/hermes/hermes-agent/install-stamp.json', '{"tag":"v2026.9.20"}')
  b.put('.kimi-code/bin/kimi.exe', 'MZ')
  return corpFile
}
const PROFILES = [{ label: 'C:\\Users\\John Smith', sub: ['John Smith'] }, { label: 'OneDrive - Contoso\\John Smith', sub: ['OneDrive - Contoso', 'John Smith'] }]
const SETS = [['claude-code'], ['codex'], ['hermes'], ['z-code'], ['claude-code', 'codex'], 'all']

for (const eol of ['\n', '\r\n']) for (const prof of PROFILES) {
  test(`W19 (${eol === '\n' ? 'LF' : 'CRLF'} files, profile ${prof.label}): every harness — alone, Claude Code with Codex, and all seven together — installs, the paths with a space are double-quoted in the .env blocks and read back whole, the user's own same-key lines are out of effect with their prior recorded, and off restores every byte`, async () => {
    for (const set of SETS) {
      const b = box(...prof.sub)
      const corp = createCa({ commonName: 'corp relay CA' })
      const corpFile = seedAll(b, eol, corp)
      const before = b.snapshot()
      const harnesses = set === 'all' ? ALL : ALL.filter((d) => set.includes(d.name))
      const label = `${set === 'all' ? 'all seven' : set.join('+')}`
      await install(b, { harnesses })
      const m = readManifest(b.dir)
      assert.equal(m.complete, true, label)
      for (const e of m.entries) assert.ok(!/\\/.test(e.value || Object.values(e.vars || {}).join('')), `${label}: ${e.path}: forward slashes, and the plain path (no quotes) is what the manifest holds`)
      for (const [name, rel, bundle] of [['codex', '.codex/.env', 'combined-codex.pem'], ['hermes', 'AppData/Local/hermes/.env', 'combined-hermes.pem']].filter(([n]) => set === 'all' || set.includes(n))) {
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
  const hermes = only('hermes')[0].win32
  const b = box('John Smith')
  b.put('AppData/Local/hermes/config.yaml', 'x: 1\n')
  const managed = path.join(b.home, 'ProgramData', 'hermes-managed')
  const ctx = (env = {}) => ({ os: 'win32', home: b.home, env: new Map(Object.entries(env)), running: [], collectorDir: b.dir, caPem: path.join(b.dir, 'ca', 'asight-ca.pem'), readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }, listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } } })
  const notes = (env) => hermes.inject(ctx(env)).notes.map((n) => n.text).filter((t) => /sets \w+; Hermes reads that file last/.test(t))
  assert.deepEqual(notes({}), [], 'no managed directory: nothing to say')
  assert.deepEqual(notes({ HERMES_MANAGED_DIR: managed }), [], 'a managed directory without the file, or without these variables')
  b.put('ProgramData/hermes-managed/.env', 'OTHER=1\n')
  assert.deepEqual(notes({ HERMES_MANAGED_DIR: managed }), [])
  b.put('ProgramData/hermes-managed/.env', 'SSL_CERT_FILE=C:/corp/ca.pem\r\nHERMES_CA_BUNDLE=C:/corp/ca.pem\r\n')
  assert.deepEqual(notes({ HERMES_MANAGED_DIR: managed }).map((t) => t.replace(managed, '<managed>').replace(/\\/g, '/')), [
    '<managed>/.env sets SSL_CERT_FILE; Hermes reads that file last, so it wins over asight\'s block and Hermes is not captured while it is there',
    '<managed>/.env sets HERMES_CA_BUNDLE; Hermes reads that file last, so it wins over asight\'s block and Hermes is not captured while it is there',
  ])
  assert.deepEqual(notes({}), [], 'HERMES_MANAGED_DIR unset: Windows has no default managed directory that was measured (4.8 §6.1)')
})

// ── asight's own value is told from a user's CA when the collector directory has backslashes and the value in the config has forward slashes (4.8 §6.1) ──
import { isOwnPath } from '../../../src/collector/harness/_common.mjs'
test('W19: asight\'s own value — written with forward slashes — is not read as a user CA when the collector directory comes back with backslashes (Claude Code, Codex, Hermes, Z-Code)', () => {
  const DIR_W = raw`C:\Users\u\.asight\collector`
  const HOME_W = raw`C:\Users\u`
  const OWN = { bundle: (h) => `C:/Users/u/.asight/collector/ca/combined-${h}.pem`, ca: 'C:/Users/u/.asight/collector/ca/asight-ca.pem', extra: 'C:/users/U/.ASIGHT/collector/ca/extra-cc.pem' } // the last one: another case
  const files = new Map()
  const norm = (p) => p.replace(/\//g, '\\').toLowerCase()
  const put = (p, t) => files.set(norm(p), t)
  const readText = (f) => files.get(norm(f)) ?? null
  const listDir = (d) => { const pre = norm(d).replace(/\\$/, '') + '\\'; const out = new Set(); for (const k of files.keys()) if (k.startsWith(pre)) out.add(k.slice(pre.length).split('\\')[0]); return [...out] }
  put(raw`C:\Users\u\.codex\.env`, `# BEGIN\nSSL_CERT_FILE=${OWN.bundle('codex')}\n# END\n`)
  put(raw`C:\Users\u\AppData\Local\hermes\.env`, `SSL_CERT_FILE=${OWN.bundle('hermes')}\n`)
  put(raw`C:\Users\u\.zcode\cli\config.json`, JSON.stringify({ network: { caCertFile: OWN.bundle('z-code') } }))
  put(raw`C:\Users\u\.claude\settings.json`, JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: OWN.ca } }))
  const env = new Map([['NODE_EXTRA_CA_CERTS', OWN.extra], ['SSL_CERT_FILE', OWN.bundle('codex')]])
  const ctx = { os: 'win32', home: HOME_W, env, running: [new Map([['NODE_EXTRA_CA_CERTS', OWN.ca], ['SSL_CERT_FILE', OWN.bundle('hermes')]])], readText, readTextOrError: (f) => ({ text: readText(f), error: null }), readBytes: () => null, listDir, collectorDir: DIR_W, caPem: `${DIR_W}\\ca\\asight-ca.pem` }
  for (const name of ['codex', 'hermes', 'z-code', 'claude-code']) {
    const out = only(name)[0].win32.inject(ctx)
    assert.deepEqual((out.files || []).flatMap((f) => f.certsFrom || []), [], `${name}: no CA file of the user's is found in what asight itself wrote`)
    assert.deepEqual((out.notes || []).map((n) => (typeof n === 'string' ? n : n.text)).filter((t) => /relative/.test(t)), [], `${name}: asight's own value is not reported as a relative CA path`)
    for (const e of out.entries || []) assert.ok(!/extra-cc/.test(String(e.value)), `${name}: Claude Code's key stays asight-ca.pem, it does not turn into a combined extra bundle`)
  }
  // a user's CA somewhere else is still found (an absolute path of the host the test runs on: the descriptors judge it with the host's path rules)
  const userCa = path.resolve('/corp/ca.pem')
  const claude = only('claude-code')[0].win32.inject({ ...ctx, env: new Map([['NODE_EXTRA_CA_CERTS', userCa]]), running: [] })
  assert.deepEqual([claude.files.length, claude.files[0] && claude.files[0].certsFrom], [1, [userCa]], 'the user\'s own CA still takes the extra bundle')
})

test('isOwnPath: on Windows a path is asight\'s when it is under the collector directory whatever the slash and the case, and not for a sibling directory of a longer name; elsewhere it is the plain prefix', () => {
  const win = { os: 'win32', collectorDir: raw`C:\Users\u\.asight\collector` }
  for (const own of ['C:/Users/u/.asight/collector/ca/x.pem', raw`C:\Users\u\.asight\collector\ca\x.pem`, 'c:/USERS/U/.asight/Collector/ca/x.pem']) assert.equal(isOwnPath(win, own), true, own)
  for (const other of ['C:/Users/u/.asight/collector2/ca/x.pem', 'C:/Users/u/.asight/collector', 'C:/corp/ca.pem', '', null, undefined, 7]) assert.equal(isOwnPath(win, other), false, String(other))
  assert.equal(isOwnPath({ os: 'win32', collectorDir: 'C:/Users/u/.asight/collector/' }, 'C:/Users/u/.asight/collector/ca/x.pem'), true, 'a trailing slash on the directory')
  const lin = { os: 'linux', collectorDir: '/h/.asight/collector' }
  assert.equal(isOwnPath(lin, '/h/.asight/collector/ca/x.pem'), true)
  assert.equal(isOwnPath(lin, '/h/.asight/collector2/ca/x.pem'), false)
  assert.equal(isOwnPath(lin, '/H/.ASIGHT/collector/ca/x.pem'), false, 'case counts outside Windows')
})

// ── W20: the combined bundle's Windows roots (4.8 §6.2) ──
import nodeFs from 'node:fs'
import { windowsRoots, droppedNote, RootsUnavailableError } from '../../../src/collector/arch/win32/roots.mjs'
import { rewriteBundles } from '../../../src/collector/core/trust/bundle.mjs'

const R = [createCa({ commonName: 'Windows root one' }), createCa({ commonName: 'Windows root two' }), createCa({ commonName: 'Windows root three' })].map((c) => c.certPem)
const BROKEN = '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n'
const fp = (pem) => new crypto.X509Certificate(pem).fingerprint256
const helperOf = (certs, calls = []) => ({ call: async (verb, args, opts) => { calls.push([verb, args, opts]); return { counts: { CurrentUser: certs.length, LocalMachine: 0 }, certs: certs.map((pem) => ({ sha256: 'x', pem, stores: ['CurrentUser'] })) } } })

test('W20: the Windows roots come from Node\'s own system store when it has one, parsed one by one: a certificate that does not parse is dropped and counted, a duplicate is kept once', async () => {
  const asked = []
  const tls = { getCACertificates: (k) => { asked.push(k); return [R[0], BROKEN, R[1], R[0]] } }
  const r = await windowsRoots({ tls })
  assert.deepEqual([asked, r.source, r.dropped], [['system'], 'node-system', 1])
  assert.deepEqual(r.pem.match(/-----BEGIN CERTIFICATE-----/g).length, 2, 'two distinct certificates')
  assert.ok(r.pem.includes(R[0].trim()) && r.pem.includes(R[1].trim()) && !r.pem.includes('bm90IGEg'), 'the broken block is not in the text')
  assert.ok(r.pem.endsWith('\n') && !r.pem.includes('\n\n'))
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/)
  assert.match(droppedNote(r), /^1 certificate in the Windows roots could not be parsed and is not in the combined bundles/, 'the receipt and status say so')
  assert.equal(droppedNote({ dropped: 0 }), null)
  assert.match(droppedNote({ dropped: 3 }), /^3 certificates .* could not be parsed and are not/)
})

test('W20: without Node\'s system store — or when it fails or is empty — the helper\'s read-only export is the source, and with neither the answer is a reason, not an empty bundle', async () => {
  const calls = []
  const viaHelper = await windowsRoots({ tls: {}, helper: helperOf([R[0], BROKEN, R[2]], calls) })
  assert.deepEqual([viaHelper.source, viaHelper.dropped, viaHelper.pem.match(/BEGIN CERTIFICATE/g).length], ['helper', 1, 2])
  assert.deepEqual([calls[0][0], calls[0][1]], ['roots', {}])
  assert.ok(calls[0][2].timeoutMs >= 10000, 'about 430 KB through a cold PowerShell: the call is given time')
  for (const tls of [{ getCACertificates: () => { throw new Error('no system store') } }, { getCACertificates: () => [] }, { getCACertificates: () => [BROKEN] }]) assert.equal((await windowsRoots({ tls, helper: helperOf([R[1]]) })).source, 'helper')
  await assert.rejects(windowsRoots({ tls: {} }), (e) => e instanceof RootsUnavailableError && e.name === 'RootsUnavailableError' && /no source/.test(e.message) && e.tried.length === 0)
  await assert.rejects(windowsRoots({ tls: { getCACertificates: () => [] }, helper: { call: async () => { throw Object.assign(new Error('x'), { code: 'helper-down' }) } } }), (e) => e instanceof RootsUnavailableError && /node-system: no certificate; helper: helper-down/.test(e.message) && e.tried.length === 2)
  await assert.rejects(windowsRoots({ tls: {}, helper: helperOf([BROKEN]) }), RootsUnavailableError, 'a store of nothing but broken certificates is not a root set')
})

test('W20: the fingerprint is of the set, not of its order, and changes with the set', async () => {
  const a = await windowsRoots({ tls: { getCACertificates: () => [R[0], R[1]] } })
  assert.equal((await windowsRoots({ tls: { getCACertificates: () => [R[1], R[0], R[1]] } })).fingerprint, a.fingerprint)
  assert.notEqual((await windowsRoots({ tls: { getCACertificates: () => [R[0], R[2]] } })).fingerprint, a.fingerprint)
})

test('W20: roots.mjs reads no file at all — never the macOS cert.pem a lab once used — and imports Node built-ins only', async () => {
  const src = nodeFs.readFileSync(new URL('../../../src/collector/arch/win32/roots.mjs', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort(), ['node:crypto', 'node:tls'])
  assert.ok(!/cert\.pem|\/etc\/ssl|readFile|createReadStream|\bfs\b/.test(src))
  const reads = []
  const real = nodeFs.readFileSync
  nodeFs.readFileSync = (...a) => { reads.push(String(a[0])); return real(...a) }
  try { await windowsRoots({ tls: { getCACertificates: () => [R[0]] } }); await windowsRoots({ tls: {}, helper: helperOf([R[1]]) }) } finally { nodeFs.readFileSync = real }
  assert.deepEqual(reads, [])
})

test('W20: the combined bundle is Node\'s roots, the Windows roots, the user\'s CAs and the asight CA, each once; a new Windows root rebuilds it atomically, an unchanged set leaves it alone', async () => {
  const b = box()
  const corp = createCa({ commonName: 'corp relay CA' })
  b.put('.codex/.env', `SSL_CERT_FILE=${b.put('corp.pem', corp.certPem)}\n`)
  const node = [R[2]] // stands in for tls.rootCertificates; one of the Windows roots is also a Node root
  const win1 = await windowsRoots({ tls: { getCACertificates: () => [R[0], R[2], BROKEN] } })
  await install(b, { harnesses: only('codex'), roots: { node, osText: win1.pem } })
  const bundle = path.join(b.dir, 'ca', 'combined-codex.pem')
  const certs = (text) => text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g).map(fp)
  const asight = fp(fs.readFileSync(path.join(b.dir, 'ca', 'asight-ca.pem'), 'utf8'))
  assert.deepEqual(certs(fs.readFileSync(bundle, 'utf8')).sort(), [fp(R[2]), fp(R[0]), fp(corp.certPem), asight].sort(), 'Node roots ∪ Windows roots ∪ the user\'s CA ∪ the asight CA, the shared one once')
  assert.ok(!fs.readFileSync(bundle, 'utf8').includes('bm90IGEg'), 'the certificate that does not parse never reached the bundle')
  const m = readManifest(b.dir)
  const writes = []
  const recording = { ...nodeFs, renameSync: (a, c) => { writes.push(['rename', a, c]); return nodeFs.renameSync(a, c) }, openSync: (f, ...rest) => { writes.push(['open', f]); return nodeFs.openSync(f, ...rest) } }
  const caPem = fs.readFileSync(path.join(b.dir, 'ca', 'asight-ca.pem'), 'utf8')
  assert.deepEqual(rewriteBundles({ dir: b.dir, manifest: m, nodeRoots: node, osRootsText: win1.pem, caPem, fs: recording }), [], 'the same Windows roots: nothing to rebuild')
  assert.deepEqual(writes, [])
  const win2 = await windowsRoots({ tls: { getCACertificates: () => [R[0], R[1], R[2]] } })
  assert.notEqual(win2.fingerprint, win1.fingerprint)
  assert.deepEqual(rewriteBundles({ dir: b.dir, manifest: m, nodeRoots: node, osRootsText: win2.pem, caPem, fs: recording }), [bundle])
  const temp = writes.find((w) => w[0] === 'open' && w[1].startsWith(bundle + '.asight-tmp-'))
  assert.ok(temp, 'written to a temp file beside the bundle…')
  assert.deepEqual(writes.find((w) => w[0] === 'rename' && w[2] === bundle), ['rename', temp[1], bundle], '…and renamed over it: a reader sees the old bundle or the new, never half')
  assert.deepEqual(certs(fs.readFileSync(bundle, 'utf8')).sort(), [fp(R[2]), fp(R[0]), fp(R[1]), fp(corp.certPem), asight].sort())
  assert.deepEqual(fs.readdirSync(path.join(b.dir, 'ca')).filter((n) => n.includes('tmp')), [], 'no temp file left')
  assert.equal(readManifest(b.dir).files.find((f) => f.role === 'bundle').sha256, crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex'), 'the manifest names the new bytes')
})

// ── W19, the proxy half: each automatic proxy entry (data) written through the journal and undone to the byte ──
import { proxyEntries } from '../../../src/collector/arch/win32/forms.mjs'
import { newManifest, applyJsonKey, applyTextEntry, undoEntry } from '../../../src/collector/core/trust/journal.mjs'
const INGRESS = { port: 17991, listenerToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }
const ctxOf = (b) => ({
  os: 'win32', home: b.home, env: new Map([['USERPROFILE', b.home]]), running: [], collectorDir: b.dir, caPem: path.join(b.dir, 'ca', 'asight-ca.pem'),
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
  { harness: 'deepseek-dsh', g: 'deepseek-dsh.env', file: '.dsh/.env', user: `DEEPSEEK_API_KEY=sk-secret\nHTTPS_PROXY=${USER}\n`, value: (t) => /^HTTPS_PROXY=(.*)$/m.exec(t)[1], block: true, noProxy: false }, // dsh's trust entry is the patch file, so its .env holds the proxy block alone
  { harness: 'hermes', g: 'hermes.cli', file: 'AppData/Local/hermes/.env', user: `OPENROUTER_API_KEY=sk-secret\nHTTPS_PROXY=${USER}\n`, value: (t) => /^HTTPS_PROXY=(.*)$/m.exec(t)[1], block: true },
]
const URL_OF = (g) => `http://${g}:${INGRESS.listenerToken}@127.0.0.1:${INGRESS.port}`

// the files as a user on Windows has them: LF, or CRLF (an editor there writes CRLF), in a profile directory that has a space in it (C:\Users\John Smith, OneDrive - Contoso)
const SHAPES = [{ eol: '\n', sub: [], label: 'LF' }, { eol: '\r\n', sub: [], label: 'CRLF' }, { eol: '\r\n', sub: ['OneDrive - Contoso', 'John Smith'], label: 'CRLF, profile with spaces' }]
for (const c0 of CASES) for (const shape of SHAPES) {
  const c = { ...c0, user: c0.user.replace(/\n/g, shape.eol) }
  test(`W19 proxy entry, ${c.g} (${shape.label}): pointed at the group's kernel port with the user's proxy recorded as prior_value (the manifest alone), then put back to the byte — with and without a user file`, () => {
    const b = box(...shape.sub)
    const group = only(c.harness)[0].win32.groups.find((g) => g.g === c.g)
    const file = b.put(c.file, c.user)
    const ctx = ctxOf(b)
    // an agent that is installed but has no proxy of its own yet, and one that is not installed at all
    const entries = proxyEntries(group, ctx, INGRESS)
    assert.deepEqual(entries.map((e) => e.path), [file], 'the file the agent reads')
    const m = newManifest()
    const e = entries[0]
    const done = e.kind === 'text' ? applyTextEntry({ dir: b.dir, manifest: m, harness: c.harness, file: e.path, edit: e }) : applyJsonKey({ dir: b.dir, manifest: m, harness: c.harness, file: e.path, keys: e.keys, value: e.value })
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
      const d2 = fresh[0].kind === 'text' ? applyTextEntry({ dir: b.dir, manifest: m2, harness: c.harness, file: fresh[0].path, edit: fresh[0] }) : applyJsonKey({ dir: b.dir, manifest: m2, harness: c.harness, file: fresh[0].path, keys: fresh[0].keys, value: fresh[0].value })
      assert.equal(c.value(fs.readFileSync(fresh[0].path, 'utf8')), URL_OF(c.g))
      undoEntry(d2)
      assert.equal(fs.existsSync(fresh[0].path), false)
    }
  })
}

test('W19 proxy entry: Claude Code and Z-Code write the proxy key beside the trust key in one file, and off takes them out in the opposite order to the original bytes', () => {
  for (const c of CASES.filter((x) => !x.block)) {
    const b = box()
    const d = only(c.harness)[0]
    const file = b.put(c.file, c.user)
    const ctx = ctxOf(b)
    const trust = planTrust({ descriptors: [d], ctxFor: () => ctx, caCertPem: CA.certPem, collectorDir: b.dir }).entries[0]
    const m = newManifest()
    const first = applyJsonKey({ dir: b.dir, manifest: m, harness: c.harness, file: trust.path, keys: trust.keys, value: trust.value })
    const [p] = proxyEntries(d.win32.groups.find((g) => g.g === c.g), ctx, INGRESS)
    const second = applyJsonKey({ dir: b.dir, manifest: m, harness: c.harness, file: p.path, keys: p.keys, value: p.value })
    assert.equal(c.value(fs.readFileSync(file, 'utf8')), URL_OF(c.g))
    assert.ok(fs.readFileSync(file, 'utf8').includes(trust.value), 'both keys are there')
    assert.deepEqual([undoEntry(second).result, undoEntry(first).result], ['restored', 'restored'])
    assert.equal(fs.readFileSync(file, 'utf8'), c.user, c.g)
  }
})

// The same file for Codex and Hermes is one sentinel block holding the trust variable and the proxy lines, entered separately (4.8 §2.3). The journal today refuses a second block in a file
// that already has asight's (journal.mjs editText), so the proxy lines cannot join the trust block yet, and the proxy-half tests above run on a file with NO trust block — a state
// production never has. THIS IS NOT THE W19 OF THE COMBINED CASE: W19 is half-passed for Codex and Hermes until this todo is a real test. It is Task 8(c)'s gate (plan, Task 8: the join option,
// undo in both orders and after the user's edit, the CRLF and the space cases on the combined block, and no prior_value in install notes); `attach()` does not write those two entries before it.
test.todo('W19 proxy entry GATE (Task 8(c)): Codex and Hermes — the proxy lines join the sentinel block the trust entry wrote (default-off join option), off undoes the two in LIFO order to the original bytes in both write orders and after the user edited around the block, in LF and CRLF files and in a profile with spaces, and the user\'s proxy credentials in prior_value reach no install note')

// ── W22: dsh and OpenCode (the plugin sources themselves: win32-plugins.test.mjs) ──
const ROW = '- insert: [{id: asight-ca, name: ./asight-ca.mjs}]'
const fwdJson = (p) => JSON.stringify(p.replace(/\\/g, '/')) // a path as the plugin source holds it: a string literal with forward slashes
test('W22 dsh: the patch row is the one lab L1 measured, with the sentinel comment; the plugin file sits beside cordis.patch.yml; off takes the row and the file out (the patch file asight created goes with them)', async () => {
  for (const existing of [true, false]) {
    const b = box()
    const patch = path.join(b.home, '.dsh', 'cordis.patch.yml')
    if (existing) b.put('.dsh/cordis.patch.yml', '- insert: [{ name: other-plugin }]\n')
    b.put('.dsh/.env', 'DEEPSEEK_API_KEY=sk\n')
    const before = b.snapshot()
    await install(b, { harnesses: only('deepseek-dsh') })
    const plugin = path.join(b.home, '.dsh', 'asight-ca.mjs')
    const rows = fs.readFileSync(patch, 'utf8').split('\n').filter((l) => l.includes('asight-ca'))
    assert.equal(rows.length, 1)
    assert.ok(rows[0].startsWith(`${ROW} # asight collector: `), `the row, then the sentinel comment: ${rows[0]}`)
    assert.ok(!/\\/.test(rows[0]), 'a relative path with forward slashes: the form that loaded on Windows')
    assert.equal(path.dirname(plugin), path.dirname(patch), 'beside the patch file: a relative name finds it')
    const text = fs.readFileSync(plugin, 'utf8')
    assert.ok(text.startsWith('// asight collector: trust plugin for DeepSeek dsh on Windows') && text.includes(fwdJson(path.join(b.dir, 'ca', 'asight-ca.pem'))), 'the plugin with this user\'s CA file filled in')
    assert.deepEqual(readManifest(b.dir).files.filter((f) => f.role === 'plugin').map((f) => f.path), [plugin], 'ledgered, so off removes it')
    assert.deepEqual(readManifest(b.dir).entries.map((e) => [e.path, e.line.startsWith(ROW)]), [[patch, true]])
    await uninstall(b, only('deepseek-dsh'))
    assert.deepEqual([...b.snapshot()], [...before], `${existing ? 'the user\'s patch file' : 'no patch file'} and no plugin after off`)
  }
})

test('W22 dsh: DSH_HOME moves both the patch file and the plugin, and a patch file that is not a list is refused before anything is written', async () => {
  const b = box()
  b.put('D/dsh/cordis.patch.yml', 'name: not a list\n')
  await assert.rejects(install(b, { harnesses: only('deepseek-dsh'), env: { HOME: b.home, USERPROFILE: b.home, DSH_HOME: path.join(b.home, 'D', 'dsh') } }), /not a block-style YAML list/)
  assert.ok(!fs.existsSync(path.join(b.home, 'D', 'dsh', 'asight-ca.mjs')), 'nothing was written')
  fs.writeFileSync(path.join(b.home, 'D', 'dsh', 'cordis.patch.yml'), '')
  await install(b, { harnesses: only('deepseek-dsh'), env: { HOME: b.home, USERPROFILE: b.home, DSH_HOME: path.join(b.home, 'D', 'dsh') } })
  assert.ok(fs.existsSync(path.join(b.home, 'D', 'dsh', 'asight-ca.mjs')) && fs.readFileSync(path.join(b.home, 'D', 'dsh', 'cordis.patch.yml'), 'utf8').includes(ROW))
})

test('W22 OpenCode: the plugin is OpenCode\'s own asight-ca.js with the Windows source (a Node sidecar or Bun), the watch list and notes of the Linux harness stay, and off removes the file and the directories asight made', async () => {
  const b = box()
  const dir = path.join(b.home, '.config', 'opencode')
  const before = b.snapshot()
  const r = await install(b, { harnesses: only('opencode') })
  const plugin = path.join(dir, 'plugins', 'asight-ca.js')
  const text = fs.readFileSync(plugin, 'utf8')
  assert.ok(text.startsWith('// asight collector: trust plugin for OpenCode on Windows') && text.includes('tls.setDefaultCACertificates') && text.includes('globalThis.fetch'), 'both ways in the one file')
  assert.ok(text.includes(fwdJson(path.join(b.dir, 'ca', 'asight-ca.pem'))) && text.includes(fwdJson(path.join(b.dir, 'run', 'trust'))), 'this user\'s CA file and marker directory')
  assert.deepEqual(readManifest(b.dir).planned, [plugin], 'the plugin is the only automatic item of an opt-in harness: no shim, no launcher, no PATH')
  assert.ok(r.plan.notes.some((n) => /@opencode-ai\/plugin/.test(n)), 'the note about its first run stays')
  await uninstall(b, only('opencode'))
  assert.deepEqual([...b.snapshot()], [...before])
  assert.ok(!fs.existsSync(dir), 'the plugins directory asight created is gone')
})

test('W22: the paths a plugin file holds are forward-slashed whatever the host\'s separator (a Windows collector directory), for dsh and for OpenCode alike', () => {
  const ctx = { os: 'win32', home: raw`C:\Users\u`, env: new Map(), running: [], collectorDir: raw`C:\Users\u\.asight\collector`, caPem: raw`C:\Users\u\.asight\collector\ca\asight-ca.pem`, readText: () => null, listDir: () => [] }
  for (const h of ['deepseek-dsh', 'opencode']) {
    const [plugin] = only(h)[0].win32.inject(ctx).owned
    assert.match(plugin.data, /const CA_FILE = "C:\/Users\/u\/\.asight\/collector\/ca\/asight-ca\.pem"/, h)
    assert.match(plugin.data, /const MARKER_DIR = "C:\/Users\/u\/\.asight\/collector\/run\/trust"/, h)
    assert.ok(!/\\\\/.test(plugin.data.split('\n').filter((l) => /^const (CA_FILE|MARKER_DIR)/.test(l)).join('\n')), `${h}: no backslash in the two literals`)
  }
})

test('W19 + W23: all seven harnesses installed together — only the automatic files change, every file an opt-in item owns stays byte for byte, and off puts everything back', async () => {
  const b = box()
  const owned = [ // what a user has and an opt-in item would change: nothing here may move
    b.put('.kimi-code/bin/kimi.exe', 'MZ'), b.put('AppData/Roaming/Code/User/settings.json', '{"http.proxy": "http://corp:3128"}\n'), b.put('.zcode/v2/setting.json', '{"httpProxy": ""}\n'),
    b.put('AppData/Roaming/Microsoft/Windows/Start Menu/Programs/OpenCode.lnk', 'LNK'), b.put('AppData/Local/Programs/@opencode-aidesktop/OpenCode.exe', 'MZ'),
  ]
  const user = [b.put('.claude/settings.json', '{"env": {}}\n'), b.put('.codex/.env', 'K=1\n'), b.put('.zcode/cli/config.json', '{}\n'), b.put('.dsh/cordis.patch.yml', '- insert: [{ name: p }]\n'), b.put('.dsh/.env', 'K=1\n'), b.put('AppData/Local/hermes/.env', 'K=1\n')]
  const before = b.snapshot()
  const all = ALL
  await install(b, { harnesses: all })
  const changed = [...b.snapshot()].filter(([f, h]) => before.get(f) !== h).map(([f]) => f)
  const planned = readManifest(b.dir).planned.filter((p) => !p.startsWith(b.dir))
  assert.deepEqual(changed.sort(), [user[0], user[1], user[2], user[3], user[5], path.join(b.home, '.dsh', 'asight-ca.mjs'), path.join(b.home, '.config', 'opencode', 'plugins', 'asight-ca.js')].sort(), 'the trust entries and the two plugins; .dsh/.env waits for the proxy entry (Task 8)')
  assert.deepEqual([...planned].sort(), changed.sort(), 'the manifest lists exactly what changed')
  for (const f of owned) assert.equal(b.snapshot().get(f), before.get(f), `${path.relative(b.home, f)} is untouched`)
  await uninstall(b, all)
  assert.deepEqual([...b.snapshot()], [...before])
})
