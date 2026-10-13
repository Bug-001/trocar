// test/netenv/doctor-readonly.test.mjs — RFC 1.6 V50 (`status` and `doctor` only read, and never go online: zero connections of their own, D49) and V52 (no proxy credential in anything they print or write). A sandbox HOME of the
// dispatch fixture, a recording runner of OS tools and a Claude Code that has a proxy with credentials of its own. Nothing here reaches the machine (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { linuxNetFacts } from '../../src/collector/arch/linux/netfacts.mjs'
import { HELPER_VERBS } from '../../src/collector/arch/win32/helper.mjs'
import { installedViaCli, snapshot } from '../cli/fixtures/dispatch-ctx.mjs'
import { changedFiles } from '../cli/fixtures/on-ctx.mjs'
import { driftCheck, newDriftState } from '../../src/netenv/adopt.mjs'
import { claudeProc } from '../cli/fixtures/status-ctx.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const descs = await loadHarnesses()
const SECRETS = ['alice:pw']
const ENGINE = { status: { engine: { port: 47123 } } }
// what a status or a doctor may run: queries that only read (1.6 V50). Anything else in a run is a failure of the test.
const READ_ONLY = new Set(['ps', 'ss', 'ip', 'gsettings', 'scutil', 'lsof', 'netstat', 'reg', 'schtasks', 'where.exe'])
// the Windows half of the allowlist (1.6 §9.7 / 4.8 §10.4: netstat, reg query, schtasks /Query, where.exe — the OS tools the printed commands name — plus the resident helper's read verbs).
// What `doctor` itself executes on Windows goes through the helper, so the static form of the check is: the files that talk to it on the status / doctor path only ever ask its read verbs (the verb
// closed set itself is 4.8 §1's, held by helper.test.mjs). `netsh`, printed for the user, is held by the live test above (never run).
const HELPER_READ_VERBS = new Set(['version', 'ps', 'tcp-table', 'reg-read', 'net-if', 'route', 'token', 'roots', 'pipe-server'])
const WIN_HELPER_FILES = ['src/collector/arch/win32/netfacts.mjs', 'src/collector/arch/win32/upstream.mjs']

/** The world of a run: a recording runner (ss lists a listener on the proxy port), and a Claude Code process whose environment holds a proxy with credentials. */
async function world({ proxy = 'http://alice:pw@127.0.0.1:7897' } = {}) {
  const s = await installedViaCli(ENGINE)
  const calls = []
  const exec = (file, args, o) => {
    calls.push(file)
    if (file === 'ss') return { status: 0, stdout: 'LISTEN 0 4096 127.0.0.1:7897 0.0.0.0:* users:(("verge-mihomo",pid=11800,fd=7))', stderr: '' }
    return s.sys.exec.run(file, args, o)
  }
  const procEnv = new Map([['HTTPS_PROXY', proxy]])
  const settings = path.join(s.home, '.claude', 'settings.json')
  const d = JSON.parse(fs.readFileSync(settings, 'utf8')); d.env.HTTPS_PROXY = proxy; fs.writeFileSync(settings, `${JSON.stringify(d, null, 2)}\n`)
  const deps = { exec, netFactsDeps: async () => ({ harnesses: descs, archFacts: linuxNetFacts }), procs: async () => [claudeProc(4121, Date.now() + 5000, procEnv)] }
  return { s, calls, deps, close: async () => {} }
}
const SRC = path.join(path.join(os.tmpdir(), 'none'))

test('V50 status and doctor only read: they write netenv.json and flows/ and nothing else, run only read-only queries, open no connection of their own — and `bpftool` / `netsh` are printed for the user, never run', async () => {
  const w = await world()
  try {
    const before = snapshot(w.s.home)
    const connects = [], realConnect = net.Socket.prototype.connect
    net.Socket.prototype.connect = function (...a) { connects.push(a[0]); return realConnect.apply(this, a) }
    const runs = [['status'], ['status', 'claude-code'], ['status', '--json'], ['doctor', '--source', SRC], ['doctor', 'claude-code', '--json', '--source', SRC]]
    try { for (const argv of runs) await w.s.run(argv, { deps: w.deps }) } finally { net.Socket.prototype.connect = realConnect }
    const changed = changedFiles(before, snapshot(w.s.home)).map((f) => f.split(path.sep).join('/'))
    assert.deepEqual(changed.filter((f) => f !== '.asight/netenv.json' && !f.startsWith('.asight/collector/flows/')), [], `written: ${changed.join(', ')}`)
    assert.ok(changed.includes('.asight/netenv.json'), 'the board\'s copy is the one thing it writes')
    assert.deepEqual([...new Set(w.calls)].filter((c) => !READ_ONLY.has(c)), [], 'every OS tool it ran is a reader')
    assert.ok(w.calls.length > 0 && w.calls.includes('ss'))
    assert.deepEqual(connects, [], 'zero connections of their own: no VPN controller is asked, nothing goes online')
    // printed for the user, never run
    w.deps.netFactsDeps = async () => ({ harnesses: descs, archFacts: async (ctx) => ({ ...(await linuxNetFacts(ctx)), otherRedirector: true }) })
    const out = (await w.s.run(['doctor', '--source', SRC], { deps: w.deps })).io.stdoutText()
    assert.match(out, /\$ sudo bpftool cgroup tree \/sys\/fs\/cgroup/, 'doctor prints it for the user')
    assert.ok(!w.calls.some((c) => /bpftool|netsh|sudo/.test(c)), 'and never runs it')
    assert.ok(!(w.s.sys.exec.calls.some((c) => /bpftool|netsh|sudo/.test(c))))
  } finally { await w.close() }
})

test('V50 the code: what the network facts run is named in a list of readers (ss, ip, gsettings, ps, scutil, lsof, netstat, reg, schtasks, where.exe), nothing in src/netenv or the facts of a platform imports a networking module, and no write verb or `Get-NetTCPConnection` is in it', () => {
  const walkFiles = (d) => fs.readdirSync(path.join(REPO, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(path.join(d, e.name)) : [path.join(d, e.name)]))
  const files = [...walkFiles('src/netenv'), 'src/collector/arch/linux/netfacts.mjs', 'src/collector/arch/win32/netfacts.mjs']
  assert.ok(files.length > 8 && files.includes(path.join('src/netenv', 'topology.mjs')), 'the scan sees src/netenv, its subdirectories too')
  for (const rel of files) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8')
    for (const m of src.matchAll(/execTool\(\s*'([^']+)'/g)) assert.ok(READ_ONLY.has(m[1]), `${rel}: execTool('${m[1]}') is not a read-only query`)
    assert.ok(!/Get-NetTCPConnection/.test(src.replace(/^\s*\/\/.*$/gm, '')), `${rel}: Get-NetTCPConnection is denied to a restricted token (4.8 E6)`)
    if (!rel.endsWith('clash.mjs')) assert.ok(!/from 'node:(net|http|https|dgram|dns|tls)'/.test(src), `${rel}: no connection of its own`)
  }
})

test('V50 the Windows half of the allowlist, as a static scan: the resident helper is asked only its read verbs (the OS tools the Windows doctor rows print — netstat + findstr, reg query, where.exe, the PAC read — are held literal by W36 in topology-win32.test.mjs, and none of them is executed by anything here)', () => {
  assert.deepEqual(HELPER_READ_VERBS, new Set(HELPER_VERBS), 'the scan lists exactly the helper\'s own closed verb set (helper.mjs\'s HELPER_VERBS): everything the helper accepts is a read verb (W1), so doctor-asks ⊆ read verbs')
  for (const rel of WIN_HELPER_FILES) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8')
    // `call('verb'` — the direct form (`.call('ps'`) and netfacts.mjs's local `call('ps'` closure alike, so the file that asks the most is not the one the scan sees the least of
    for (const m of src.matchAll(/call\(\s*'([^']+)'/g)) assert.ok(HELPER_READ_VERBS.has(m[1]), `${rel}: the helper is asked '${m[1]}', which is not one of its read verbs`)
    assert.ok(src.match(/call\(\s*'[^']+'/) !== null, `${rel}: the scan sees this file's asks (a file that reaches the helper only through a variable verb would be invisible to it)`)
  }
  for (const rel of ['src/netenv/findings-win32.mjs', ...WIN_HELPER_FILES]) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8')
    assert.ok(!/execTool\(/.test(src), `${rel}: the Windows doctor path runs no OS tool of its own — everything goes through the helper`)
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

test('V52 nothing secret in anything they print or write: not a proxy credential (the agent\'s own, in its settings file and in its process\'s environment) — in `status` (text and --json), `doctor` (text and --json), netenv.json and the events of flows/', async () => {
  const w = await world()
  try {
    const { printed, written } = await everything(w)
    const text = [...printed, ...written].join('\n')
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} must not appear`)
    assert.ok(text.includes('http://***@127.0.0.1:7897'), 'the proxy setting is there, masked (what `on` recorded of it)')
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
