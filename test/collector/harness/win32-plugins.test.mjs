// test/collector/harness/win32-plugins.test.mjs — the trust plugins of dsh and OpenCode on Windows (RFC 4.8 §6.1; acceptance W22; the Linux ones are plugins.test.mjs, T13). Same two halves: a static check of
// each source (imports, the calls it may make, words it may never contain), and a stub runtime that loads the rendered plugin with recording fs / tls / fetch and asserts every call it made.
// What differs from Linux: no /proc, so the marker's start time is the process' own, Math.round(performance.timeOrigin) milliseconds (the engine compares it with a tolerance, Task 8); and
// OpenCode's plugin takes tls.setDefaultCACertificates when there is one (a Node sidecar) and wraps fetch only when there is not (Bun).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { pathToFileURL } from 'node:url'
import { renderPlugin, PLUGIN_SOURCES } from '../../../src/collector/harness/_plugins.mjs'
import { CA } from './_ctx.mjs'

// The plugin changes the default roots with tls.setDefaultCACertificates (Node >= 22.19), and the probe reads them with tls.getCACertificates (>= 22.15): on an older Node (the CI matrix has 20) the
// real-Node test is skipped, not failed or left out, so every Node version still counts the same number of tests.
const NODE_TLS_ROOTS = typeof tls.setDefaultCACertificates === 'function' && typeof tls.getCACertificates === 'function'
const SRC = { dsh: 'win32/dsh.mjs', opencode: 'win32/opencode.js' }
const read = (rel) => fs.readFileSync(new URL(rel, PLUGIN_SOURCES), 'utf8')
const code = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s\/\/ .*$/gm, '')

test('W22 static: each Windows plugin imports only node:fs and node:tls, calls only the allowed fs functions, reads no /proc, and never names a network API, a body or rejectUnauthorized', () => {
  for (const [h, rel] of Object.entries(SRC)) {
    const src = read(rel)
    const c = code(src)
    assert.ok(src.startsWith('// asight collector: trust plugin'), `${h}: the sentinel comment heads the file`)
    assert.deepEqual([...c.matchAll(/^import .*$/gm)].map((m) => m[0]), ["import fs from 'node:fs'", "import tls from 'node:tls'"], `${h}: imports`)
    assert.ok(!/\brequire\s*\(|\bimport\s*\(/.test(c), `${h}: no dynamic import or require`)
    assert.deepEqual([...new Set([...c.matchAll(/\bfs\.(\w+)/g)].map((m) => m[1]))].sort(), ['readFileSync', 'renameSync', 'writeFileSync'], `${h}: fs calls`)
    assert.deepEqual([...c.matchAll(/fs\.readFileSync\(([^,)]+)/g)].map((m) => m[1]), ['CA_FILE'], `${h}: the only file read is the CA file`)
    for (const m of c.matchAll(/fs\.(writeFileSync|renameSync)\(([^)]*)\)/g)) assert.match(m[2], /^tmp\b/, `${h}: writes go to the marker temp file and its rename only`)
    assert.ok(/const tmp = `\$\{MARKER_DIR\}\/\.\$\{process\.pid\}\.tmp`/.test(c) && /`\$\{MARKER_DIR\}\/\$\{process\.pid\}`/.test(c), `${h}: the marker is <dir>/<pid>`)
    assert.ok(/String\(Math\.round\(performance\.timeOrigin\)\)/.test(c) && !/\/proc/.test(c), `${h}: the start time is the process' own`)
    assert.deepEqual([...new Set([...c.matchAll(/\btls\.(\w+)/g)].map((m) => m[1]))].sort(), ['getCACertificates', 'setDefaultCACertificates'], `${h}: tls calls`)
    for (const bad of [/rejectUnauthorized/, /\b(http|https|net|dgram|http2|child_process|worker_threads)\b/, /\bWebSocket\b|\bXMLHttpRequest\b|\bBun\./, /\.(body|headers|text|json|arrayBuffer|blob|formData|clone|bytes)\b/, /\bspawn\w*\(|(?<!\.)\bexec(File|Sync)?\(/, /\bconsole\.|process\.(stdout|stderr)/]) assert.ok(!bad.test(c), `${h}: never ${bad}`)
    assert.deepEqual([...c.matchAll(/process\.(\w+)(?:\.(\w+))?/g)].map((m) => m[0]).filter((x, i, a) => a.indexOf(x) === i).sort(), ['process.env.NODE_OPTIONS', 'process.execArgv', 'process.pid'], `${h}: the only process facts read`)
  }
  assert.equal([...code(read(SRC.dsh)).matchAll(/\bfetch\b/g)].length, 0, 'dsh never touches fetch')
  const oc = code(read(SRC.opencode))
  assert.deepEqual([...oc.matchAll(/\b(inner|fetch)\s*(\.call)?\(/g)].map((m) => m[0]), ['inner.call('], 'OpenCode: the only fetch made is the caller\'s own, passed on')
})

// ── stub runtime ──
const ROOTS = ['-----BEGIN CERTIFICATE-----\nUk9PVDE=\n-----END CERTIFICATE-----', '-----BEGIN CERTIFICATE-----\nUk9PVDI=\n-----END CERTIFICATE-----']
const MARKERS = 'C:/Users/u/.asight/collector/run/trust'
const CA_FILE = 'C:/Users/u/.asight/collector/ca/asight-ca.pem'
const ORIGIN = 1760000000123.456

async function load(rel, { caText = CA.certPem, tlsApi = {}, fetch = null, noFetch = false } = {}) {
  const calls = []
  const fsStub = {
    readFileSync: (f, enc) => { calls.push(['fs.readFileSync', f, enc]); if (f === CA_FILE) { if (caText instanceof Error) throw caText; return caText } throw Object.assign(new Error(`stub: unexpected read ${f}`), { code: 'EACCES' }) },
    writeFileSync: (f, data, o) => { calls.push(['fs.writeFileSync', f, data, o]) },
    renameSync: (a, b) => { calls.push(['fs.renameSync', a, b]) },
  }
  const tlsStub = { getCACertificates: (kind) => { calls.push(['tls.getCACertificates', kind]); return [...ROOTS] }, setDefaultCACertificates: (list) => { calls.push(['tls.setDefaultCACertificates', list]) }, ...tlsApi }
  const src = renderPlugin(rel, { caFile: CA_FILE, markerDir: MARKERS }).replace("import fs from 'node:fs'", 'const fs = globalThis.__asightW22.fs').replace("import tls from 'node:tls'", 'const tls = globalThis.__asightW22.tls')
  assert.ok(!/^import /m.test(src), 'every import replaced by its stub')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-w22-'))
  const file = path.join(dir, 'plugin.mjs')
  fs.writeFileSync(file, src)
  const realFetch = globalThis.fetch
  const realOrigin = Object.getOwnPropertyDescriptor(performance, 'timeOrigin')
  globalThis.__asightW22 = { fs: fsStub, tls: tlsStub }
  Object.defineProperty(performance, 'timeOrigin', { value: ORIGIN, configurable: true })
  if (fetch) globalThis.fetch = fetch
  if (noFetch) globalThis.fetch = undefined
  try { return { mod: await import(pathToFileURL(file).href), calls, fetch: globalThis.fetch } } finally {
    globalThis.fetch = realFetch
    delete globalThis.__asightW22
    if (realOrigin) Object.defineProperty(performance, 'timeOrigin', realOrigin); else delete performance.timeOrigin
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
const marker = [
  ['fs.writeFileSync', `${MARKERS}/.${process.pid}.tmp`, '1760000000123', { mode: 0o600 }],
  ['fs.renameSync', `${MARKERS}/.${process.pid}.tmp`, `${MARKERS}/${process.pid}`],
]

test('W22 dsh: the one trust change is setDefaultCACertificates(default roots + asight CA), then the marker with the process\' own start time; nothing else is called', async () => {
  const { mod, calls } = await load(SRC.dsh)
  assert.deepEqual(calls, [['fs.readFileSync', CA_FILE, 'utf8'], ['tls.getCACertificates', 'default'], ['tls.setDefaultCACertificates', [...ROOTS, CA.certPem.trim()]], ...marker])
  assert.deepEqual([mod.name, typeof mod.apply], ['asight-ca', 'function'], 'a cordis plugin shape dsh loads')
})

test('W22 dsh: no setDefaultCACertificates, --use-openssl-ca, a missing / non-PEM CA file, a failing call → nothing added, no marker, no throw', async () => {
  assert.deepEqual((await load(SRC.dsh, { tlsApi: { setDefaultCACertificates: undefined } })).calls, [], 'Node < 22.19: nothing is even read')
  const before = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = '--max-old-space-size=4096 --use-openssl-ca'
  try { assert.deepEqual((await load(SRC.dsh)).calls, [], 'under --use-openssl-ca the call would replace the roots') } finally { if (before == null) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before }
  for (const caText of [Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), 'not a certificate']) assert.deepEqual((await load(SRC.dsh, { caText })).calls, [['fs.readFileSync', CA_FILE, 'utf8']], `CA file ${caText}`)
  const failing = await load(SRC.dsh, { tlsApi: { setDefaultCACertificates: () => { throw new Error('bad PEM') } } })
  assert.ok(!failing.calls.some((c) => c[0].startsWith('fs.write') || c[0] === 'fs.renameSync'), 'the CA did not go in: no marker')
})

test('W22 OpenCode on a Node sidecar (tls.setDefaultCACertificates exists): the roots are extended in place, fetch is left alone, the marker is written', async () => {
  const inner = () => 'r'
  const { calls, fetch: after } = await load(SRC.opencode, { fetch: inner })
  assert.equal(after, inner, 'the runtime\'s own fetch is not wrapped')
  assert.deepEqual(calls, [['fs.readFileSync', CA_FILE, 'utf8'], ['tls.getCACertificates', 'default'], ['tls.setDefaultCACertificates', [...ROOTS, CA.certPem.trim()]], ...marker])
})

test('W22 OpenCode on Bun (no setDefaultCACertificates): the fetch wrapper appends the asight CA after the caller\'s ca (or the default roots); request and response pass as the same objects, unread', async () => {
  const seen = []
  const resp = new Proxy({}, { get: (_, k) => { seen.push(['response', k]); return undefined } })
  const inner = function (input, init) { seen.push(['fetch', input, init, this]); return resp }
  inner.preconnect = () => 'pre'
  const { calls, fetch: wrapped } = await load(SRC.opencode, { fetch: inner, tlsApi: { setDefaultCACertificates: undefined } })
  assert.notEqual(wrapped, inner)
  assert.equal(wrapped.preconnect(), 'pre', 'own properties of the runtime\'s fetch are kept')
  assert.deepEqual(calls, [['fs.readFileSync', CA_FILE, 'utf8'], ['tls.getCACertificates', 'default'], ...marker])
  const ASIGHT = CA.certPem.trim()
  const req = new Proxy({}, { get: (_, k) => { seen.push(['request', k]); return undefined } })
  assert.equal(wrapped(req), resp, 'the response object is returned as is')
  assert.deepEqual(seen.map((s) => s[0]), ['fetch'], 'neither the request nor the response was read')
  assert.deepEqual(seen[0][2], { tls: { ca: [...ROOTS, ASIGHT] } }, 'no ca from the caller: the default roots, then the asight CA')
  seen.length = 0
  const body = new Proxy({}, { get: (_, k) => { seen.push(['body', k]); return undefined } })
  const check = () => undefined
  const init = { method: 'POST', body, headers: { a: '1' }, tls: { ca: 'CALLER-CA', checkServerIdentity: check, servername: 's' } }
  const copy = { ...init, tls: { ...init.tls } }
  wrapped('https://x.test/v1', init)
  assert.deepEqual(seen.map((s) => s[0]), ['fetch'], 'the body was not read')
  assert.equal(seen[0][2].body, body, 'the same body object')
  assert.deepEqual(seen[0][2].tls, { ca: ['CALLER-CA', ASIGHT], checkServerIdentity: check, servername: 's' }, 'the caller\'s tls fields stay, its ca first, the asight CA after')
  assert.deepEqual(init, copy, 'the caller\'s init is not changed')
  wrapped('https://x.test', { tls: { ca: ['A', 'B'] } })
  assert.deepEqual(seen[1][2].tls.ca, ['A', 'B', ASIGHT])
  for (const s of seen) assert.ok(!JSON.stringify(s[2] || {}).includes('rejectUnauthorized'), 'never rejectUnauthorized')
})

test('W22 OpenCode: a missing or non-PEM CA file, --use-openssl-ca on a Node sidecar, or no way to add a CA at all → nothing changes, no marker, no throw; the export is an OpenCode plugin', async () => {
  const inner = () => 'r'
  for (const caText of [Object.assign(new Error('EACCES'), { code: 'EACCES' }), '']) {
    const r = await load(SRC.opencode, { caText, fetch: inner })
    assert.equal(r.fetch, inner)
    assert.deepEqual(r.calls, [['fs.readFileSync', CA_FILE, 'utf8']])
  }
  const before = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = '--use-openssl-ca'
  try { const r = await load(SRC.opencode, { fetch: inner }); assert.deepEqual([r.fetch === inner, r.calls.some((c) => c[0] === 'tls.setDefaultCACertificates' || c[0].startsWith('fs.write'))], [true, false], 'the call would replace the roots, and a fetch wrapper does nothing for Node\'s own TLS') } finally { if (before == null) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before }
  const bare = await load(SRC.opencode, { tlsApi: { setDefaultCACertificates: undefined, getCACertificates: undefined } })
  assert.deepEqual(bare.calls, [['fs.readFileSync', CA_FILE, 'utf8']])
  const none = await load(SRC.opencode, { tlsApi: { setDefaultCACertificates: undefined }, noFetch: true })
  assert.ok(!none.calls.some((c) => c[0].startsWith('fs.write') || c[0] === 'fs.renameSync'), 'neither a place to add the CA nor a fetch to wrap: the CA did not go in, so no marker')
  const m = await load(SRC.opencode, { fetch: inner })
  assert.equal(typeof m.mod.AsightCaPlugin, 'function', 'an OpenCode plugin export')
  assert.deepEqual(await m.mod.AsightCaPlugin({}), {}, 'it registers no hooks')
})

test('W22: the marker is the process\' own start in milliseconds, one number — the engine tells a reused pid by it; a real Node loads the rendered dsh plugin into its default roots and writes it', { skip: !NODE_TLS_ROOTS && 'needs Node >= 22.19 (tls.setDefaultCACertificates)' }, async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-w22r-'))
  try {
    const caFile = path.join(dir, 'asight-ca.pem'); fs.writeFileSync(caFile, CA.certPem)
    const markers = path.join(dir, 'trust'); fs.mkdirSync(markers)
    const plugin = path.join(dir, 'asight-ca.mjs'); fs.writeFileSync(plugin, renderPlugin(SRC.dsh, { caFile: caFile.replace(/\\/g, '/'), markerDir: markers.replace(/\\/g, '/') }))
    const probe = `const t0 = Date.now(); import(${JSON.stringify(pathToFileURL(plugin).href)}).then(() => { const tls = require('node:tls'); console.log(JSON.stringify({ pid: process.pid, t0, now: Date.now(), has: tls.getCACertificates('default').map((c) => c.trim()).includes(${JSON.stringify(CA.certPem.trim())}), n: tls.getCACertificates('default').length, bundled: tls.getCACertificates('bundled').length })) })`
    const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { PATH: process.env.PATH } })
    assert.equal(r.status, 0, r.stderr)
    const o = JSON.parse(r.stdout)
    assert.deepEqual([o.has, o.n], [true, o.bundled + 1], 'the default roots plus the asight CA, none taken away')
    const text = fs.readFileSync(path.join(markers, String(o.pid)), 'utf8')
    assert.match(text, /^\d{13}$/, 'milliseconds since the epoch, nothing else')
    assert.ok(Number(text) <= o.now && Number(text) >= o.t0 - 60000, 'a moment before the process was running code, not a clock of some other kind')
    assert.deepEqual(fs.readdirSync(markers), [String(o.pid)], 'no temp file left')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
