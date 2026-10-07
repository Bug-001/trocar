// test/netenv/doctor-readonly.test.mjs — RFC 1.6 V50 (`status` and `doctor` only read, and never go online) and V52 (nothing secret in anything they print or write). A sandbox HOME of the dispatch fixture with Clash
// Verge's directory laid out the way the real one is — a secret, a subscription address, a node and its password — a mihomo core behind a real unix-socket HTTP server that records every request, a recording
// runner of OS tools and a Claude Code that has a proxy with credentials of its own. Nothing here reaches the machine (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { linuxNetFacts } from '../../src/collector/arch/linux/netfacts.mjs'
import { installedViaCli, snapshot } from '../cli/fixtures/dispatch-ctx.mjs'
import { changedFiles } from '../cli/fixtures/on-ctx.mjs'
import { driftCheck, newDriftState } from '../../src/netenv/adopt.mjs'
import { claudeProc } from '../cli/fixtures/status-ctx.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const descs = await loadHarnesses()
const SECRETS = ['alice:pw', 's3cr3t', 'sub.example', 'HK-01']
const ENGINE = { status: { engine: { port: 47123 } } }
// what a status or a doctor may run: queries that only read (1.6 V50). Anything else in a run is a failure of the test.
const READ_ONLY = new Set(['ps', 'ss', 'ip', 'gsettings', 'scutil', 'lsof', 'netstat', 'reg', 'schtasks', 'where.exe'])

function seedVerge(home, sock) {
  const dir = path.join(home, '.local', 'share', 'io.github.clash-verge-rev.clash-verge-rev')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'verge.yaml'), 'enable_tun_mode: false\nenable_system_proxy: true\nverge_mixed_port: 7897\n')
  fs.writeFileSync(path.join(dir, 'clash-verge.yaml'), `mode: global\nmixed-port: 7897\nsecret: s3cr3t\nexternal-controller-unix: ${sock}\nproxies:\n- {name: HK-01, type: ss, server: 1.2.3.4, port: 443, password: alice:pw}\nrules:\n- MATCH,HK-01\n`)
  fs.writeFileSync(path.join(dir, 'profiles.yaml'), 'items:\n- uid: x\n  url: https://sub.example/xyz\n')
}
async function fakeMihomo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-ro-'))
  const sock = path.join(dir, 'm.sock'), seen = []
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.method === 'GET' && req.url === '/version') return send(200, { meta: true, version: 'v1.19.31' })
    if (req.method === 'GET' && req.url === '/configs') return send(200, { mode: 'rule', 'mixed-port': 7897, secret: 's3cr3t', tun: { enable: false } })
    send(404, { message: 'no route' })
  })
  await new Promise((r) => srv.listen(sock, r))
  return { sock, seen, close: () => new Promise((r) => srv.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r() })) }
}

/** The world of a run: a recording runner (ps names the core's socket and, as the real command line does, its secret; ss lists the core's port), and a Claude Code process whose environment holds a proxy with credentials. */
async function world({ proxy = 'http://alice:pw@127.0.0.1:7897' } = {}) {
  const s = await installedViaCli(ENGINE)
  const mh = await fakeMihomo()
  seedVerge(s.home, mh.sock)
  const calls = []
  const exec = (file, args, o) => {
    calls.push(file)
    if (file === 'ps') return { status: 0, stdout: `/usr/bin/verge-mihomo -d /x/runtime -ext-ctl-unix ${mh.sock} -secret s3cr3t\n/bin/zsh -l\n`, stderr: '' }
    if (file === 'ss') return { status: 0, stdout: 'LISTEN 0 4096 127.0.0.1:7897 0.0.0.0:* users:(("verge-mihomo",pid=11800,fd=7))', stderr: '' }
    return s.sys.exec.run(file, args, o)
  }
  const procEnv = new Map([['HTTPS_PROXY', proxy]])
  const settings = path.join(s.home, '.claude', 'settings.json')
  const d = JSON.parse(fs.readFileSync(settings, 'utf8')); d.env.HTTPS_PROXY = proxy; fs.writeFileSync(settings, `${JSON.stringify(d, null, 2)}\n`)
  const deps = { exec, netenv: undefined, knownSocks: [], netFactsDeps: async () => ({ harnesses: descs, archFacts: linuxNetFacts }), procs: async () => [claudeProc(4121, Date.now() + 5000, procEnv)] }
  return { s, mh, calls, deps, close: () => mh.close() }
}
const SRC = path.join(path.join(os.tmpdir(), 'none'))

test('V50 status and doctor only read: they write netenv.json and flows/ and nothing else, run only read-only queries, ask the VPN core only GET /version and GET /configs — and `bpftool` / `netsh` are printed for the user, never run', async () => {
  const w = await world()
  try {
    const before = snapshot(w.s.home)
    const runs = [['status'], ['status', 'claude-code'], ['status', '--json'], ['doctor', '--source', SRC], ['doctor', 'claude-code', '--json', '--source', SRC]]
    for (const argv of runs) await w.s.run(argv, { deps: w.deps })
    const changed = changedFiles(before, snapshot(w.s.home)).map((f) => f.split(path.sep).join('/'))
    assert.deepEqual(changed.filter((f) => f !== '.asight/netenv.json' && !f.startsWith('.asight/collector/flows/')), [], `written: ${changed.join(', ')}`)
    assert.ok(changed.includes('.asight/netenv.json'), 'the board\'s copy is the one thing it writes')
    assert.deepEqual([...new Set(w.calls)].filter((c) => !READ_ONLY.has(c)), [], 'every OS tool it ran is a reader')
    assert.ok(w.calls.length > 0 && w.calls.includes('ss'))
    assert.deepEqual([...new Set(w.mh.seen)].sort(), ['GET /configs', 'GET /version'], 'the controller of the VPN core is only read: no write, no /connections, no /logs')
    // printed for the user, never run
    w.deps.netFactsDeps = async () => ({ harnesses: descs, archFacts: async (ctx) => ({ ...(await linuxNetFacts(ctx)), otherRedirector: true }) })
    const out = (await w.s.run(['doctor', '--source', SRC], { deps: w.deps })).io.stdoutText()
    assert.match(out, /\$ sudo bpftool cgroup tree \/sys\/fs\/cgroup/, 'doctor prints it for the user')
    assert.ok(!w.calls.some((c) => /bpftool|netsh|sudo/.test(c)), 'and never runs it')
    assert.ok(!(w.s.sys.exec.calls.some((c) => /bpftool|netsh|sudo/.test(c))))
  } finally { await w.close() }
})

test('V50 the code: what the network facts run is named in a list of readers (ss, ip, gsettings, ps, scutil, lsof, netstat, reg, schtasks, where.exe), nothing in src/netenv or the facts of a platform connects anywhere but the VPN core\'s unix socket, and no write verb or `Get-NetTCPConnection` is in it', () => {
  const walkFiles = (d) => fs.readdirSync(path.join(REPO, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(path.join(d, e.name)) : [path.join(d, e.name)]))
  // src/netenv/mihomo/controller.mjs connects to a controller and, for asight's OWN kernel only (own:true, 4.8 §3.3), writes: its allow-list is held by test/netenv/controller.test.mjs (N9),
  // so it is not scanned for verbs here. What this test holds is that the status / doctor side (src/netenv, src/cli, src/off) only ever asks it as the user's VPN: no `own: true` outside it.
  const CONTROLLER = path.join('src/netenv/mihomo', 'controller.mjs')
  const files = [...walkFiles('src/netenv').filter((f) => f !== CONTROLLER), 'src/collector/arch/linux/netfacts.mjs']
  assert.ok(files.length > 10 && files.includes(path.join('src/netenv', 'clash.mjs')), 'the scan sees src/netenv, its subdirectories too')
  const ownCallers = [...walkFiles('src/netenv'), ...walkFiles('src/cli'), ...walkFiles('src/off')].filter((f) => f !== CONTROLLER && /\bown:\s*true\b/.test(fs.readFileSync(path.join(REPO, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')))
  assert.deepEqual(ownCallers, [], 'no status / doctor file asks a controller as asight\'s own kernel (the writing form): only arch/win32/forwarder.mjs does')
  for (const rel of files) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8')
    for (const m of src.matchAll(/execTool\(\s*'([^']+)'/g)) assert.ok(READ_ONLY.has(m[1]), `${rel}: execTool('${m[1]}') is not a read-only query`)
    assert.ok(!/Get-NetTCPConnection/.test(src.replace(/^\s*\/\/.*$/gm, '')), `${rel}: Get-NetTCPConnection is denied to a restricted token (4.8 E6)`)
    if (!rel.endsWith('clash.mjs')) assert.ok(!/from 'node:(net|http|https|dgram|dns|tls)'/.test(src), `${rel}: no connection of its own`)
    assert.ok(!/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(src) && !/\/connections|\/logs/.test(src.replace(/^\s*\/\/.*$/gm, '')), `${rel}: no write to a controller, no /connections or /logs`)
  }
})

/** Everything a run of the commands prints, and what `on` and the daemon write, for a world whose agent has `proxy` set: [texts printed, texts written]. */
async function everything(w) {
  const printed = []
  for (const argv of [['status'], ['status', 'claude-code'], ['status', '--json'], ['doctor', '--source', SRC], ['doctor', 'claude-code', '--json', '--source', SRC]]) {
    const r = await w.s.run(argv, { deps: w.deps })
    printed.push(r.io.text())
  }
  const on = await w.s.run(['on', '--yes', '--json'], { deps: w.deps }); printed.push(on.io.text())
  const dir = path.join(w.s.home, '.asight')
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  const written = [path.join(dir, 'netenv.json'), ...walk(path.join(dir, 'collector', 'flows'))].map((f) => fs.readFileSync(f, 'utf8'))
  return { printed, written }
}

test('V52 nothing secret in anything they print or write: not a proxy credential (the agent\'s own, in its settings file and in its process\'s environment), nor the VPN\'s secret, subscription address or a node — in `status` (text and --json), `doctor` (text and --json), netenv.json and the events of flows/', async () => {
  const w = await world()
  try {
    const { printed, written } = await everything(w)
    const text = [...printed, ...written].join('\n')
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} must not appear`)
    assert.ok(text.includes('http://***@127.0.0.1:7897'), 'the proxy setting is there, masked (what `on` recorded of it)')
    assert.ok(printed.join('\n').includes('verge-mihomo') || printed.join('\n').includes('Clash Verge') || printed.join('\n').includes('mihomo'), 'and so is the product')
  } finally { await w.close() }
})

// A password may hold an `@` the URL does not escape (`http://carol:p@ssw0rd@host`): the credentials end at the LAST `@` of the authority, as every URL parser reads it, so the rest of the password is not a host.
// The same password escaped (`%40`) must be hidden too. The assertion runs over everything: the text, the JSON, netenv.json, the events a drift writes (`from` / `to`) and the lines of flows/.
for (const [label, proxy, secrets] of [['an unescaped @', 'http://carol:p@ssw0rd@127.0.0.1:7897', ['carol', 'ssw0rd', 'p@ss']], ['an escaped %40', 'http://carol:p%40ssw0rd@127.0.0.1:7897', ['carol', 'ssw0rd', 'p%40']]]) {
  test(`V52 a password with ${label} is hidden whole: in status, doctor, \`on\`, netenv.json, flows/ and the events of a drift (from / to)`, async () => {
    const w = await world({ proxy })
    try {
      const { printed, written } = await everything(w)
      const events = []
      const next = 'http://bob:s3@cret@proxy.new:3128'
      const file = path.join(w.s.home, '.claude', 'settings.json'), d = JSON.parse(fs.readFileSync(file, 'utf8')); d.env.HTTPS_PROXY = next; fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`)
      driftCheck({ home: w.s.home, env: {}, harnesses: descs, desired: () => 'on', appendEvent: (e) => events.push(e), state: newDriftState() })
      assert.ok(events.some((e) => e.event === 'netenv-change'), 'the change was noticed')
      const after = (await w.s.run(['status', 'claude-code', '--json'], { deps: w.deps })).io.text()
      const text = [...printed, ...written, JSON.stringify(events), after].join('\n')
      for (const secret of [...secrets, 'bob', 'cret']) assert.ok(!text.includes(secret), `${secret} must not appear`)
      assert.ok(text.includes('http://***@127.0.0.1:7897') && text.includes('http://***@proxy.new:3128'), 'the settings are there, masked: the host and port are what is left')
    } finally { await w.close() }
  })
}
