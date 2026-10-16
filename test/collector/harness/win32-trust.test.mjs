// test/collector/harness/win32-trust.test.mjs — what is left of the old Windows trust entries (RFC 4.8 §6.1 · §6.2; acceptance W19, W20, W22): the harnesses' win32 data read directly
// (the overlays are gone), `isOwnPath`, and the Windows roots readers. planTrust's Windows arm and the win32 install through it are gone (D57): Windows certificates are 4.11's `install`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

const raw = String.raw
const CA = createCa({ commonName: 'asight collector CA' })
const ALL = await loadHarnesses()
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

// ── the real data in a sandbox HOME laid out like %USERPROFILE% ──
function box(...sub) { // `sub`: segments under the temp directory, e.g. a profile directory with a space in it
  const home = path.join(tmpDir('asight-w19-'), ...sub)
  fs.mkdirSync(home, { recursive: true })
  const put = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  const snapshot = () => { const out = new Map(); const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (f === path.join(home, '.asight')) continue; if (e.isDirectory()) walk(f); else out.set(f, sha(fs.readFileSync(f))) } }; walk(home); return out }
  return { home, dir: path.join(home, '.asight', 'collector'), put, snapshot }
}
const only = (name) => ALL.filter((d) => d.name === name)
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
import { osRootsFor } from '../../../src/off/os-roots.mjs'
const windowsRoots = osRootsFor('win32') // the readers are reached through their one table, as src/ reaches them
const unavailable = (e) => e instanceof Error && e.name === 'RootsUnavailableError'
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
})

test('W20: without Node\'s system store — or when it fails or is empty — the helper\'s read-only export is the source, and with neither the answer is a reason, not an empty bundle', async () => {
  const calls = []
  const viaHelper = await windowsRoots({ tls: {}, helper: helperOf([R[0], BROKEN, R[2]], calls) })
  assert.deepEqual([viaHelper.source, viaHelper.dropped, viaHelper.pem.match(/BEGIN CERTIFICATE/g).length], ['helper', 1, 2])
  assert.deepEqual([calls[0][0], calls[0][1]], ['roots', {}])
  assert.ok(calls[0][2].timeoutMs >= 10000, 'about 430 KB through a cold PowerShell: the call is given time')
  for (const tls of [{ getCACertificates: () => { throw new Error('no system store') } }, { getCACertificates: () => [] }, { getCACertificates: () => [BROKEN] }]) assert.equal((await windowsRoots({ tls, helper: helperOf([R[1]]) })).source, 'helper')
  await assert.rejects(windowsRoots({ tls: {} }), (e) => unavailable(e) && /^the Windows root certificates could not be read \(getCACertificates: not available \(Node ≥ 22\.15 has it\)\)$/.test(e.message) && e.tried.length === 1, 'no Node 22.15 read and no helper (off has none, 4.8 §6.2): the reason says which, so off\'s note can')
  await assert.rejects(windowsRoots({ tls: { getCACertificates: () => [] }, helper: { call: async () => { throw Object.assign(new Error('x'), { code: 'helper-down' }) } } }), (e) => unavailable(e) && /node-system: no certificate; helper: helper-down/.test(e.message) && e.tried.length === 2)
  await assert.rejects(windowsRoots({ tls: {}, helper: helperOf([BROKEN]) }), unavailable, 'a store of nothing but broken certificates is not a root set')
})

test('W20: the fingerprint is of the set, not of its order, and changes with the set', async () => {
  const a = await windowsRoots({ tls: { getCACertificates: () => [R[0], R[1]] } })
  assert.equal((await windowsRoots({ tls: { getCACertificates: () => [R[1], R[0], R[1]] } })).fingerprint, a.fingerprint)
  assert.notEqual((await windowsRoots({ tls: { getCACertificates: () => [R[0], R[2]] } })).fingerprint, a.fingerprint)
})

test('W20: the Windows reader reads no file at all — never the macOS cert.pem a test machine once used — not even through the `read` the table\'s callers pass (off does)', async () => {
  assert.equal(windowsRoots.name, 'windowsRoots', 'win32\'s entry of the one table (src/off/os-roots.mjs)')
  assert.ok(!/cert\.pem|\/etc\/ssl|readFile|createReadStream|\bfs\b|\bread\b/.test(windowsRoots.toString().replace(/\/\/.*$/gm, '')), 'its own code names no file and takes no reader')
  const reads = []
  const real = nodeFs.readFileSync
  nodeFs.readFileSync = (...a) => { reads.push(String(a[0])); return real(...a) }
  const read = (f) => { reads.push(f); return '' }
  try { await osRootsFor('win32')({ tls: { getCACertificates: () => [R[0]] }, read }); await osRootsFor('win32')({ tls: {}, helper: helperOf([R[1]]), read }) } finally { nodeFs.readFileSync = real }
  assert.deepEqual(reads, [])
})

// ── W22: dsh and OpenCode (the plugin sources themselves: win32-plugins.test.mjs) ──
test('W22: the paths a plugin file holds are forward-slashed whatever the host\'s separator (a Windows collector directory), for dsh and for OpenCode alike', () => {
  const ctx = { os: 'win32', home: raw`C:\Users\u`, env: new Map(), running: [], collectorDir: raw`C:\Users\u\.asight\collector`, caPem: raw`C:\Users\u\.asight\collector\ca\asight-ca.pem`, readText: () => null, listDir: () => [] }
  for (const h of ['deepseek-dsh', 'opencode']) {
    const [plugin] = only(h)[0].win32.inject(ctx).owned
    assert.match(plugin.data, /const CA_FILE = "C:\/Users\/u\/\.asight\/collector\/ca\/asight-ca\.pem"/, h)
    assert.match(plugin.data, /const MARKER_DIR = "C:\/Users\/u\/\.asight\/collector\/run\/trust"/, h)
    assert.ok(!/\\\\/.test(plugin.data.split('\n').filter((l) => /^const (CA_FILE|MARKER_DIR)/.test(l)).join('\n')), `${h}: no backslash in the two literals`)
  }
})
