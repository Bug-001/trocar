// test/cli/netenv.test.mjs — RFC 1.6 §6 「探测」 / V22: what asight reads of the VPN / proxy software on the machine (Clash Verge, mihomo), read-only,
// without a secret, a subscription address or a node in what it says or writes. Every file is a fixture in a sandbox HOME, every OS tool a stub, the
// mihomo control socket a real HTTP server on a unix socket in the temp dir (so the default request code runs): nothing here reaches the machine.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { detectNetenv, writeNetenv, NETENV_MODES, netenvFile } from '../../src/netenv/index.mjs'
import { HARNESS_IDS } from '../../src/cli/harness-names.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const SECRETS = ['s3cr3t', 'sub.example', '1.2.3.4', 'HK-01', 'alice:pw']
const noSecret = (label, text) => { for (const s of SECRETS) assert.ok(!String(text).includes(s), `${label} must not contain ${s}`) }

const VERGE = 'io.github.clash-verge-rev.clash-verge-rev'
const vergeDir = (home, platform = 'darwin') => platform === 'darwin' ? path.join(home, 'Library', 'Application Support', VERGE) : path.join(home, '.local', 'share', VERGE)
// what Clash Verge Rev keeps in its directory: verge.yaml (its own switches), clash-verge.yaml (the core's runtime config: a secret, the nodes), profiles.yaml (the subscription)
function seedVerge(home, { platform = 'darwin', verge = 'enable_tun_mode: false\nenable_system_proxy: true\nverge_mixed_port: 7897\n', runtime = null, sock = null } = {}) {
  const dir = vergeDir(home, platform)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'verge.yaml'), verge)
  fs.writeFileSync(path.join(dir, 'clash-verge.yaml'), runtime ?? `mode: global\nmixed-port: 7897\nsecret: s3cr3t\n${sock ? `external-controller-unix: ${sock}\n` : ''}proxies:\n- {name: HK-01, type: ss, server: 1.2.3.4, port: 443, password: alice:pw}\nrules:\n- MATCH,HK-01\n`)
  fs.writeFileSync(path.join(dir, 'profiles.yaml'), 'items:\n- uid: x\n  url: https://sub.example/xyz\n')
  return dir
}
// a real HTTP server on a unix socket answering what mihomo answers; `configs` is its /configs body (a secret in it, as mihomo's own would not but a hostile or old core might)
async function fakeMihomo(configs = { mode: 'rule', 'mixed-port': 7897, secret: 's3cr3t', tun: { enable: false } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-nm-'))
  const sock = path.join(dir, 'm.sock'), seen = []
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)) }
    if (req.method === 'GET' && req.url === '/version') return send(200, { meta: true, version: 'v1.19.31' })
    if (req.method === 'GET' && req.url === '/configs') return send(200, configs)
    send(404, { message: 'no route' })
  })
  await new Promise((r) => srv.listen(sock, r))
  return { sock, seen, close: () => new Promise((r) => srv.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r() })) }
}
// `ps -axww -o command=` of the sandbox: a mihomo whose command line names the socket and (as real ones do) a secret
const psWith = (sock) => (file) => file === 'ps' ? { status: 0, stdout: `/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo -d /x/runtime -ext-ctl-unix ${sock} -secret s3cr3t\n/bin/zsh -l\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'unexpected tool' }
const psNothing = () => ({ status: 0, stdout: '/bin/zsh -l\n', stderr: '' })
// knownSocks: [] — the places a real core listens are this machine's, not the sandbox's (the guard in clash.mjs makes a test say so)
const detect = (home, o = {}) => detectNetenv({ home, platform: 'darwin', exec: psNothing, env: {}, uid: process.getuid(), knownSocks: [], ...o })

test('V22: Clash Verge files with a secret, a subscription address and a node, and a live core: the result names clash-verge and its mode, and neither it nor netenv.json has any of them', async () => {
  const home = tmpDir('asight-ne-')
  const mh = await fakeMihomo()
  try {
    seedVerge(home, { sock: mh.sock })
    const r = await detect(home, { exec: psWith(mh.sock) })
    assert.deepEqual(r.products.map((p) => [p.product, p.mode, p.tun, p.system_proxy, p.mixed_port, p.live]), [['clash-verge', 'rule', false, true, 7897, true]], 'the live core says rule (the runtime file said global, an older answer)')
    assert.ok(NETENV_MODES.includes(r.products[0].mode))
    assert.deepEqual(Object.keys(r.products[0].via).sort(), [...HARNESS_IDS].sort(), 'a verdict for every harness')
    assert.deepEqual(mh.seen.filter((x) => !x.startsWith('GET /version')), ['GET /configs'], 'read-only: one GET of /configs, no write')
    noSecret('the result', JSON.stringify(r))
    const written = writeNetenv(home, r)
    assert.equal(written.path, netenvFile(home))
    assert.equal(fs.statSync(written.path).mode & 0o777, 0o600, 'netenv.json is 0600')
    assert.ok(!written.path.includes(`${path.sep}collector${path.sep}`), 'and outside collector/ (a platform without the new collector writes it too)')
    noSecret('netenv.json', fs.readFileSync(written.path, 'utf8'))
    assert.deepEqual(JSON.parse(fs.readFileSync(written.path, 'utf8')).products, r.products)
  } finally { await mh.close() }
})

test('V22: nothing found says so with a reason (unknown), never an empty products list read as 「无」', async () => {
  const home = tmpDir('asight-ne-')
  const r = await detect(home)
  assert.deepEqual(r.products, [])
  assert.equal(r.unknown.length, 1)
  assert.match(r.unknown[0].reason, /Clash Verge|mihomo/, 'it names what it looked for')
  assert.ok(r.unknown[0].reason.length > 20)
  for (const platform of ['darwin', 'linux', 'win32']) assert.ok((await detect(home, { platform, env: { APPDATA: path.join(home, 'AppData') } })).unknown.length >= 1, `${platform} too`)
})

test('the files alone (no core answers): the product and the mode from the file, marked as not live, and the reason says why; the Linux and Windows directories are read too', async () => {
  const home = tmpDir('asight-ne-')
  seedVerge(home, { platform: 'linux' })
  const r = await detect(home, { platform: 'linux' })
  const [p] = r.products
  assert.deepEqual([p.product, p.mode, p.live, p.tun, p.system_proxy, p.mixed_port], ['clash-verge', 'global', false, false, true, 7897])
  assert.match(p.reason, /live core|control socket/, 'why the mode is the file\'s')
  noSecret('result', JSON.stringify(r))
  const win = tmpDir('asight-ne-')
  const dir = path.join(win, 'AppData', VERGE); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'verge.yaml'), 'enable_tun_mode: true\n')
  const w = await detect(win, { platform: 'win32', env: { APPDATA: path.join(win, 'AppData') } })
  assert.deepEqual([w.products[0].product, w.products[0].tun], ['clash-verge', true])
})

test('a file or a core that cannot be read is 不知道 with the file and the errno, not 「没有」: EACCES on verge.yaml, a /configs that is not JSON', async () => {
  const home = tmpDir('asight-ne-')
  const dir = seedVerge(home)
  const readFile = (f, enc) => { if (path.basename(f) === 'verge.yaml') throw Object.assign(new Error(`EACCES: permission denied, open '${f}'`), { code: 'EACCES' }); return fs.readFileSync(f, enc) }
  let r = await detect(home, { readFile })
  const reasons = JSON.stringify(r)
  assert.match(reasons, /verge\.yaml/); assert.match(reasons, /EACCES/)
  assert.equal(r.products[0].tun, 'unknown', 'a flag in the file that could not be read is not false')
  const mh = await fakeMihomo('<html>s3cr3t sub.example HK-01</html>')
  try {
    r = await detect(home, { exec: psWith(mh.sock) })
    assert.equal(r.products[0].mode, 'global', 'the file\'s mode stands when the core\'s answer is no JSON')
    assert.equal(r.products[0].live, false)
    assert.match(r.products[0].reason, /not JSON|not valid JSON/)
    noSecret('the reason', JSON.stringify(r))
  } finally { await mh.close() }
  assert.ok(dir)
})

test('a bare mihomo (no Verge directory): found by its control socket, product mihomo; the pin ASIGHT_MIHOMO_SOCK in env is honoured first', async () => {
  const home = tmpDir('asight-ne-')
  const mh = await fakeMihomo({ mode: 'direct', 'mixed-port': 7890, tun: { enable: true } })
  try {
    const r = await detect(home, { exec: psWith(mh.sock) })
    assert.deepEqual(r.products.map((p) => [p.product, p.mode, p.tun, p.mixed_port, p.live]), [['mihomo', 'direct', true, 7890, true]])
    const pinned = await detect(home, { env: { ASIGHT_MIHOMO_SOCK: mh.sock } })
    assert.equal(pinned.products[0].product, 'mihomo')
  } finally { await mh.close() }
})

test('which harnesses go through it: TUN on is all of them; otherwise only a proxy setting that names its mixed port says so, another proxy says no, and anything else is unknown with the reason', async () => {
  const home = tmpDir('asight-ne-')
  seedVerge(home, { verge: 'enable_tun_mode: true\nenable_system_proxy: false\nverge_mixed_port: 7897\n' })
  assert.deepEqual(new Set(Object.values((await detect(home)).products[0].via)), new Set([true]), 'TUN: everything of this user goes through it')
  const home2 = tmpDir('asight-ne-')
  seedVerge(home2)
  const proxies = { 'claude-code': ['http://alice:pw@127.0.0.1:7897'], codex: ['http://127.0.0.1:7897/'], hermes: ['http://proxy.corp:3128'], opencode: ['socks5://localhost:7897'], 'z-code': [] }
  const r = await detect(home2, { proxies })
  const via = r.products[0].via
  assert.deepEqual([via['claude-code'], via.codex, via.hermes, via.opencode, via['z-code'], via['kimi-code']], [true, true, false, true, 'unknown', 'unknown'])
  assert.match(r.products[0].reason, /kimi-code/, 'the harnesses whose setting was not read are named in the reason')
  noSecret('the result', JSON.stringify(r))
})

test('writeNetenv keeps what the probe does not own: `adopted` (what `on` found) and the harnesses of `topology` a new write does not redraw; the probe\'s own keys are replaced whole', () => {
  const home = tmpDir('asight-merge-')
  const r = (extra = {}) => ({ at: 'T1', products: [], unknown: [{ reason: 'x' }], ...extra })
  writeNetenv(home, r({ adopted: { codex: { at: 'A', sha256: 'abc' } }, topology: { codex: { at: 'T1' }, hermes: { at: 'T1' } } }))
  writeNetenv(home, r({ at: 'T2', topology: { codex: { at: 'T2' } } }))
  let f = JSON.parse(fs.readFileSync(netenvFile(home), 'utf8'))
  assert.deepEqual([f.at, f.adopted, f.topology], ['T2', { codex: { at: 'A', sha256: 'abc' } }, { codex: { at: 'T2' }, hermes: { at: 'T1' } }])
  writeNetenv(home, { at: 'T3', products: [], unknown: [{ reason: 'y' }] })
  f = JSON.parse(fs.readFileSync(netenvFile(home), 'utf8'))
  assert.deepEqual([f.unknown, f.topology.hermes.at, f.adopted.codex.at], [[{ reason: 'y' }], 'T1', 'A'], 'a probe-only write (on, doctor) does not drop them')
  assert.equal(fs.statSync(netenvFile(home)).mode & 0o777, 0o600)
  fs.writeFileSync(netenvFile(home), '{ not json')
  writeNetenv(home, r({ at: 'T4' }))
  assert.equal(JSON.parse(fs.readFileSync(netenvFile(home), 'utf8')).at, 'T4', 'a file that does not parse is replaced, not a reason to fail')
})
