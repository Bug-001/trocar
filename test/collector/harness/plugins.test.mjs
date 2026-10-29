// test/collector/harness/plugins.test.mjs — acceptance T13 (RFC 4.6 §身份与信任「进程内插件:有界例外」, D37④): the dsh,
// OpenCode and pi trust plugins only append the trocar CA. Two halves: a static check of each source (imports, the
// calls it may make, words it may never contain), and a stub runtime that loads the rendered plugin with recording
// fs / tls / fetch and asserts every call it made.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderPlugin, PLUGIN_SOURCES } from '../../../src/collector/harness/_plugins.mjs'
import { CA } from './_ctx.mjs'

// the plugin needs tls.setDefaultCACertificates (Node >= 22.19) and the probe tls.getCACertificates (>= 22.15); an older Node (the CI matrix has 20) skips the real-Node test, so every Node counts the same tests
const NODE_TLS_ROOTS = typeof tls.setDefaultCACertificates === 'function' && typeof tls.getCACertificates === 'function'
// dsh and pi share the root-only body and differ only in the exports their host looks for
const SRC = { dsh: ['node-roots.js', 'dsh/exports.js'], opencode: 'opencode/trocar-ca.js', pi: ['node-roots.js', 'pi/exports.js'] }
// the plugins that only add the root (no fetch wrapper), and the exports each host loads
const ROOT_ONLY = ['dsh', 'pi']
const EXPORTS = { dsh: ['apply', 'name'], opencode: ['TrocarCaPlugin'], pi: ['default'] }
const read = (rel) => [rel].flat().map((r) => fs.readFileSync(new URL(r, PLUGIN_SOURCES), 'utf8')).join('')
const code = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s\/\/ .*$/gm, '')

test('T13 static: each plugin imports only node:fs and node:tls, calls only the allowed fs functions, never names a network API, a body or rejectUnauthorized', () => {
  for (const [h, rel] of Object.entries(SRC)) {
    const src = read(rel)
    const c = code(src)
    assert.ok(src.startsWith('// trocar collector: trust plugin'), `${h}: the sentinel comment heads the file`)
    assert.deepEqual([...c.matchAll(/^import .*$/gm)].map((m) => m[0]), ["import fs from 'node:fs'", "import tls from 'node:tls'"], `${h}: imports`)
    assert.ok(!/\brequire\s*\(|\bimport\s*\(/.test(c), `${h}: no dynamic import or require`)
    assert.deepEqual([...new Set([...c.matchAll(/\bfs\.(\w+)/g)].map((m) => m[1]))].sort(), ['readFileSync', 'renameSync', 'writeFileSync'], `${h}: fs calls`)
    assert.deepEqual([...c.matchAll(/fs\.readFileSync\(([^,)]+)/g)].map((m) => m[1]).sort(), ["'/proc/self/stat'", 'CA_FILE'], `${h}: the only files read`)
    for (const m of c.matchAll(/fs\.(writeFileSync|renameSync)\(([^)]*)\)/g)) assert.match(m[2], /^tmp\b/, `${h}: writes go to the marker temp file and its rename only`)
    assert.ok(/const tmp = `\$\{MARKER_DIR\}\/\.\$\{process\.pid\}\.tmp`/.test(c) && /`\$\{MARKER_DIR\}\/\$\{process\.pid\}`/.test(c), `${h}: the marker is <dir>/<pid>`)
    assert.deepEqual([...new Set([...c.matchAll(/\btls\.(\w+)/g)].map((m) => m[1]))].sort(), ROOT_ONLY.includes(h) ? ['getCACertificates', 'setDefaultCACertificates'] : ['getCACertificates'], `${h}: tls calls`)
    for (const bad of [/rejectUnauthorized/, /\b(http|https|net|dgram|http2|child_process|worker_threads)\b/, /\bWebSocket\b|\bXMLHttpRequest\b|\bBun\./, /\.(body|headers|text|json|arrayBuffer|blob|formData|clone|bytes)\b/, /\bspawn\w*\(|(?<!\.)\bexec(File|Sync)?\(/, /\bconsole\.|process\.(stdout|stderr)/]) {
      assert.ok(!bad.test(c), `${h}: never ${bad}`)
    }
    assert.deepEqual([...c.matchAll(/process\.(\w+)(?:\.(\w+))?/g)].map((m) => m[0]).filter((x, i, a) => a.indexOf(x) === i).sort(), ROOT_ONLY.includes(h) ? ['process.env.NODE_OPTIONS', 'process.execArgv', 'process.pid'] : ['process.pid'], `${h}: the only process facts read`)
  }
  const oc = code(read(SRC.opencode))
  assert.deepEqual([...oc.matchAll(/\b(inner|fetch)\s*(\.call)?\(/g)].map((m) => m[0]), ['inner.call('], 'OpenCode: the only fetch made is the caller\'s own, passed on')
  for (const h of ROOT_ONLY) assert.equal([...code(read(SRC[h])).matchAll(/\bfetch\b/g)].length, 0, `${h} never touches fetch`)
})

// ── stub runtime ──
const ROOTS = ['-----BEGIN CERTIFICATE-----\nUk9PVDE=\n-----END CERTIFICATE-----', '-----BEGIN CERTIFICATE-----\nUk9PVDI=\n-----END CERTIFICATE-----']
const STAT = '4242 (dsh worker) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 11 0 987654 1000 200'
const MARKERS = '/stub/.trocar/collector/run/trust'
const CA_FILE = '/stub/.trocar/collector/ca/trocar-ca.pem'

async function load(rel, { caText = CA.certPem, tlsApi = {}, fetch = null } = {}) {
  const calls = []
  const fsStub = {
    readFileSync: (f, enc) => {
      calls.push(['fs.readFileSync', f, enc])
      if (f === '/proc/self/stat') return STAT
      if (f === CA_FILE) { if (caText instanceof Error) throw caText; return caText }
      throw Object.assign(new Error(`stub: unexpected read ${f}`), { code: 'EACCES' })
    },
    writeFileSync: (f, data, o) => { calls.push(['fs.writeFileSync', f, data, o]) },
    renameSync: (a, b) => { calls.push(['fs.renameSync', a, b]) },
  }
  const tlsStub = {
    getCACertificates: (kind) => { calls.push(['tls.getCACertificates', kind]); return [...ROOTS] },
    setDefaultCACertificates: (list) => { calls.push(['tls.setDefaultCACertificates', list]) },
    ...tlsApi,
  }
  const rendered = renderPlugin(rel, { caFile: CA_FILE, markerDir: MARKERS })
  const src = rendered.replace("import fs from 'node:fs'", 'const fs = globalThis.__trocarT13.fs').replace("import tls from 'node:tls'", 'const tls = globalThis.__trocarT13.tls')
  assert.ok(!/^import /m.test(src), 'every import replaced by its stub')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-t13-'))
  const file = path.join(dir, path.basename([rel].flat()[0]).replace(/\.js$/, '.mjs'))
  fs.writeFileSync(file, src)
  const realFetch = globalThis.fetch
  globalThis.__trocarT13 = { fs: fsStub, tls: tlsStub }
  if (fetch) globalThis.fetch = fetch
  try {
    const mod = await import(pathToFileURL(file).href)
    return { mod, calls, fetch: globalThis.fetch }
  } finally {
    globalThis.fetch = realFetch
    delete globalThis.__trocarT13
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
const markerCalls = [
  ['fs.writeFileSync', `${MARKERS}/.${process.pid}.tmp`, '987654', { mode: 0o600 }],
  ['fs.renameSync', `${MARKERS}/.${process.pid}.tmp`, `${MARKERS}/${process.pid}`],
]

for (const h of ROOT_ONLY) {
  test(`T13 stub runtime, ${h}: the one trust change is setDefaultCACertificates(default roots + trocar CA), then the marker; nothing else is called`, async () => {
    const { mod, calls } = await load(SRC[h])
    assert.deepEqual(calls, [
      ['fs.readFileSync', CA_FILE, 'utf8'],
      ['tls.getCACertificates', 'default'],
      ['tls.setDefaultCACertificates', [...ROOTS, CA.certPem.trim()]],
      ['fs.readFileSync', '/proc/self/stat', 'utf8'],
      ...markerCalls,
    ])
    assert.deepEqual(Object.keys(mod).sort(), EXPORTS[h], 'the shape its host loads')
  })

  test(`T13 stub runtime, ${h}: a second import in the same process (pi's /reload) finds the CA already in the default roots, adds nothing and writes the same marker`, async () => {
    const already = [...ROOTS, `${CA.certPem.trim()}\n`] // the same certificate; how the default store spells it may differ in white space
    const { calls } = await load(SRC[h], { tlsApi: { getCACertificates: () => [...already] } })
    assert.ok(!calls.some((c) => c[0] === 'tls.setDefaultCACertificates'), 'the roots are left as they are')
    assert.deepEqual(calls.slice(-2), markerCalls)
  })

  test(`T13 stub runtime, ${h}: no setDefaultCACertificates, --use-openssl-ca, a missing / non-PEM CA file, a failing call → nothing added, no marker, no throw`, async () => {
    const noApi = await load(SRC[h], { tlsApi: { setDefaultCACertificates: undefined } })
    assert.deepEqual(noApi.calls, [], 'Node < 22.19: nothing is even read')
    const before = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--max-old-space-size=4096 --use-openssl-ca'
    try { assert.deepEqual((await load(SRC[h])).calls, [], 'under --use-openssl-ca the call would replace the roots') } finally { if (before == null) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before }
    for (const caText of [Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), 'not a certificate']) {
      assert.deepEqual((await load(SRC[h], { caText })).calls, [['fs.readFileSync', CA_FILE, 'utf8']], `CA file ${caText}`)
    }
    const failing = await load(SRC[h], { tlsApi: { setDefaultCACertificates: () => { throw new Error('bad PEM') } } })
    assert.ok(!failing.calls.some((c) => c[0].startsWith('fs.write') || c[0] === 'fs.renameSync'), 'the CA did not go in: no marker')
  })
}

test('T13 stub runtime, OpenCode: the fetch wrapper appends the trocar CA after the caller\'s ca (or the default roots); request and response pass as the same objects, unread', async () => {
  const seen = []
  const resp = new Proxy({}, { get: (_, k) => { seen.push(['response', k]); return undefined } })
  const inner = function (input, init) { seen.push(['fetch', input, init, this]); return resp }
  inner.preconnect = () => 'pre'
  const { calls, fetch: wrapped } = await load(SRC.opencode, { fetch: inner })
  assert.notEqual(wrapped, inner)
  assert.equal(wrapped.preconnect(), 'pre', 'own properties of the runtime\'s fetch are kept')
  assert.deepEqual(calls, [['fs.readFileSync', CA_FILE, 'utf8'], ['tls.getCACertificates', 'default'], ['fs.readFileSync', '/proc/self/stat', 'utf8'], ...markerCalls])
  const TROCAR = CA.certPem.trim()

  const req = new Proxy({}, { get: (_, k) => { seen.push(['request', k]); return undefined } })
  assert.equal(wrapped(req), resp, 'the response object is returned as is')
  assert.deepEqual(seen.map((s) => s[0]), ['fetch'], 'neither the request nor the response was read')
  assert.equal(seen[0][1], req, 'the same request object')
  assert.deepEqual(seen[0][2], { tls: { ca: [...ROOTS, TROCAR] } }, 'no ca from the caller: the default roots, then the trocar CA')

  seen.length = 0
  const body = new Proxy({}, { get: (_, k) => { seen.push(['body', k]); return undefined } })
  const check = () => undefined
  const init = { method: 'POST', body, headers: { a: '1' }, tls: { ca: 'CALLER-CA', checkServerIdentity: check, servername: 's' } }
  const copy = { ...init, tls: { ...init.tls } }
  wrapped('https://x.test/v1', init)
  const got = seen[0][2]
  assert.deepEqual(seen.map((s) => s[0]), ['fetch'], 'the body was not read')
  assert.equal(got.body, body, 'the same body object')
  assert.deepEqual(got.tls, { ca: ['CALLER-CA', TROCAR], checkServerIdentity: check, servername: 's' }, 'the caller\'s tls fields stay, its ca first, the trocar CA after')
  assert.equal(got.headers, init.headers)
  assert.deepEqual(init, copy, 'the caller\'s init is not changed')
  wrapped('https://x.test', { tls: { ca: ['A', 'B'] } })
  assert.deepEqual(seen[1][2].tls.ca, ['A', 'B', TROCAR])
  for (const s of seen) assert.ok(!JSON.stringify(s[2] || {}).includes('rejectUnauthorized'), 'never rejectUnauthorized')
})

test('T13 stub runtime, OpenCode: a missing or non-PEM CA file leaves fetch alone, writes no marker, never throws', async () => {
  const inner = () => 'r'
  for (const caText of [Object.assign(new Error('EACCES'), { code: 'EACCES' }), '']) {
    const r = await load(SRC.opencode, { caText, fetch: inner })
    assert.equal(r.fetch, inner)
    assert.deepEqual(r.calls, [['fs.readFileSync', CA_FILE, 'utf8']])
  }
  const m = await load(SRC.opencode, { fetch: inner })
  assert.equal(typeof m.mod.TrocarCaPlugin, 'function', 'an OpenCode plugin export')
  assert.deepEqual(await m.mod.TrocarCaPlugin({}), {}, 'it registers no hooks')
})

test('renderPlugin fills in this user\'s CA file and marker dir as string literals, and refuses a source without exactly one slot each', () => {
  const out = renderPlugin(SRC.dsh, { caFile: "/h/it's/ca.pem", markerDir: '/h/run/trust' })
  assert.ok(out.includes(`const CA_FILE = "/h/it's/ca.pem"`) && out.includes('const MARKER_DIR = "/h/run/trust"'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-rp-'))
  try {
    const rel = path.relative(fileURLToPath(PLUGIN_SOURCES), path.join(dir, 'x.js'))
    fs.writeFileSync(path.join(dir, 'x.js'), "const CA_FILE = '__TROCAR_CA_FILE__'\n")
    assert.throws(() => renderPlugin(rel, { caFile: '/a', markerDir: '/b' }), /exactly one '__TROCAR_MARKER_DIR__'/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

for (const h of ROOT_ONLY) test(`T13 real Node (Linux): the rendered ${h} plugin puts the trocar CA into the default roots and writes the marker with this process's start time`, { skip: (process.platform !== 'linux' && 'needs /proc') || (!NODE_TLS_ROOTS && 'needs Node >= 22.19 (tls.setDefaultCACertificates)') }, async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-t13r-'))
  try {
    const caFile = path.join(dir, 'trocar-ca.pem'); fs.writeFileSync(caFile, CA.certPem)
    const markers = path.join(dir, 'trust'); fs.mkdirSync(markers)
    const plugin = path.join(dir, 'index.mjs'); fs.writeFileSync(plugin, renderPlugin(SRC[h], { caFile, markerDir: markers }))
    const probe = `import(${JSON.stringify(pathToFileURL(plugin).href)}).then(() => { const tls = require('node:tls'); const st = require('node:fs').readFileSync('/proc/self/stat', 'utf8'); console.log(JSON.stringify({ pid: process.pid, ticks: st.slice(st.lastIndexOf(')') + 2).split(' ')[19], has: tls.getCACertificates('default').map((c) => c.trim()).includes(${JSON.stringify(CA.certPem.trim())}), n: tls.getCACertificates('default').length, bundled: tls.getCACertificates('bundled').length })) })`
    const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { PATH: process.env.PATH } })
    assert.equal(r.status, 0, r.stderr)
    const o = JSON.parse(r.stdout)
    assert.deepEqual([o.has, o.n], [true, o.bundled + 1], 'the default roots plus the trocar CA, none taken away')
    assert.equal(fs.readFileSync(path.join(markers, String(o.pid)), 'utf8'), o.ticks)
    assert.deepEqual(fs.readdirSync(markers), [String(o.pid)], 'no temp file left')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
