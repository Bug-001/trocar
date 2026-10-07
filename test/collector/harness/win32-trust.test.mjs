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
import { readManifest } from '../../../src/collector/core/trust/journal.mjs'
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
function box() {
  const home = tmpDir('asight-w19-')
  const put = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  const snapshot = () => { const out = new Map(); const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (f === path.join(home, '.asight')) continue; if (e.isDirectory()) walk(f); else out.set(f, sha(fs.readFileSync(f))) } }; walk(home); return out }
  return { home, dir: path.join(home, '.asight', 'collector'), put, snapshot }
}
const names = ['claude-code', 'codex', 'kimi-code', 'z-code']
const install = (b, over = {}) => installCollector({ home: b.home, env: { HOME: b.home, USERPROFILE: b.home }, osName: 'win32', harnesses: ALL.filter((d) => names.includes(d.name)), freePort: async () => 47011, roots: { node: [], osText: '' }, ...over })
const uninstall = (b) => uninstallCollector({ home: b.home, env: {}, stop: async () => 'none', harnesses: ALL.filter((d) => names.includes(d.name)), roots: { node: [], osText: '' } })

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
