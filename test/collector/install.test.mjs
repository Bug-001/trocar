// test/collector/install.test.mjs — per-user install / uninstall with Claude Code's real descriptor in a sandbox
// HOME (acceptance S10 collector part, T10 + T11 for the CC entry). No root, no daemon (stop is injected).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import { spawn } from 'node:child_process'
import { startControlServer } from '../../src/collector/core/control.mjs'
import { installCollector, uninstallCollector, stopDaemon, freeEnginePort, daemonEnv } from '../../src/collector/install.mjs'
import { readManifest } from '../../src/collector/core/trust/journal.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import cc from '../../src/collector/harness/claude-code.mjs'

function box() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-inst-'))
  return { home, dir: path.join(home, '.asight', 'collector'), done: () => fs.rmSync(home, { recursive: true, force: true }) }
}
const base = (b, o = {}) => ({ home: b.home, env: { HOME: b.home }, osName: 'none', harnesses: [cc], freePort: async () => 47011, ...o })
const stopNone = async () => 'none'
const readEvents = (dir) => (fs.existsSync(path.join(dir, 'flows')) ? fs.readdirSync(path.join(dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(dir, 'flows', n), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))) : [])
const settingsOf = (b) => path.join(b.home, '.claude', 'settings.json')
const listAll = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name + '/', ...listAll(path.join(d, e.name)).map((x) => `${e.name}/${x}`)] : [e.name])) : [])

test('install: CA under ~/.asight/collector/ca, CC settings key → asight-ca.pem, manifest lists every file first', async () => {
  const b = box()
  try {
    const r = await installCollector(base(b))
    const m = readManifest(b.dir)
    assert.deepEqual([m.complete, m.engine_port, m.planned], [true, 47011, [settingsOf(b)]])
    assert.deepEqual(m.files.map((f) => [path.relative(b.dir, f.path), f.role]), [['ca/ca.key', 'ca-key'], ['ca/asight-ca.pem', 'ca-cert']])
    assert.equal(JSON.parse(fs.readFileSync(settingsOf(b), 'utf8')).env.NODE_EXTRA_CA_CERTS, path.join(b.dir, 'ca', 'asight-ca.pem'))
    assert.ok(new X509Certificate(fs.readFileSync(path.join(b.dir, 'ca', 'asight-ca.pem'))).ca)
    assert.ok(r.plan.notes.some((n) => /exported only in a shell/.test(n)))
    const snap = () => [fs.readFileSync(settingsOf(b)), fs.readFileSync(path.join(b.dir, 'install-manifest.json'))]
    const first = snap()
    assert.equal((await installCollector(base(b))).already, true, 'install twice is a no-op')
    assert.deepEqual(snap(), first, 'a second install rewrites neither the settings file nor the manifest, so the first record stands')
  } finally { b.done() }
})

test('install: an existing user CA in settings becomes extra-cc.pem (certificates only); uninstall restores the file byte for byte', async () => {
  const b = box()
  try {
    const corp = createCa({ commonName: 'corp relay CA' })
    const corpFile = path.join(b.home, 'corp.pem'); fs.writeFileSync(corpFile, `-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n${corp.certPem}`)
    fs.mkdirSync(path.join(b.home, '.claude'))
    const before = `{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://relay.example.com",\n    "ANTHROPIC_API_KEY": "sk-ant-secret",\n    "NODE_EXTRA_CA_CERTS": "${corpFile}"\n  }\n}\n`
    fs.writeFileSync(settingsOf(b), before)
    await installCollector(base(b))
    const extra = path.join(b.dir, 'ca', 'extra-cc.pem')
    assert.equal(JSON.parse(fs.readFileSync(settingsOf(b), 'utf8')).env.NODE_EXTRA_CA_CERTS, extra)
    const pem = fs.readFileSync(extra, 'utf8')
    assert.ok(pem.includes(corp.certPem.trim()) && !pem.includes('PRIVATE KEY'))
    const m = readManifest(b.dir)
    assert.equal(m.entries[0].prior_value, corpFile)
    assert.deepEqual(m.files.filter((f) => f.role === 'trust-file').map((f) => [f.path, f.sources]), [[extra, [corpFile]]])
    assert.ok(!fs.readFileSync(path.join(b.dir, 'install-manifest.json'), 'utf8').includes('sk-ant-secret'), 'the manifest holds no copy of the user file')
    fs.writeFileSync(path.join(b.dir, 'capture-2026-10-06.ndjson'), '{"keep":true}\n')
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.deepEqual(r.entries.map((e) => e.result), ['restored'])
    assert.equal(fs.readFileSync(settingsOf(b), 'utf8'), before)
    assert.deepEqual(listAll(b.dir).filter((x) => !x.startsWith('flows/')), ['capture-2026-10-06.ndjson'], 'only the captures and the event log remain')
    const events = fs.readdirSync(path.join(b.dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(b.dir, 'flows', n), 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
    assert.deepEqual(events.map((e) => [e.event, e.where, e.code, e.harness]), [['install-note', 'install', 'cert-not-merged', 'claude-code'], ['install-note', 'install', 'harness-note', 'claude-code']], 'what install said is kept where status finds it (D38)')
    assert.match(events[0].reason, /corp\.pem: a PRIVATE KEY block is not a CERTIFICATE PEM block, so it is not merged into extra-cc\.pem/, 'the left-out block is named by type and file, never its content (T14)')
    assert.match(events[1].reason, /exported only in a shell asight did not see/)
    assert.equal(fs.readFileSync(corpFile, 'utf8').includes('PRIVATE KEY'), true, 'the user CA file is untouched')
  } finally { b.done() }
})

test('install: a CA exported only in the install shell is merged into extra-cc.pem; the settings key points there (G8)', async () => {
  const b = box()
  try {
    const lab = createCa({ commonName: 'lab relay CA' })
    const labFile = path.join(b.home, 'lab-ca.pem'); fs.writeFileSync(labFile, lab.certPem)
    await installCollector(base(b, { env: { HOME: b.home, NODE_EXTRA_CA_CERTS: labFile } }))
    const extra = path.join(b.dir, 'ca', 'extra-cc.pem')
    assert.equal(JSON.parse(fs.readFileSync(settingsOf(b), 'utf8')).env.NODE_EXTRA_CA_CERTS, extra)
    const pem = fs.readFileSync(extra, 'utf8')
    const fps = pem.split(/(?=-----BEGIN CERTIFICATE-----)/).map((c) => new X509Certificate(c).fingerprint256)
    const asightCa = new X509Certificate(fs.readFileSync(path.join(b.dir, 'ca', 'asight-ca.pem'))).fingerprint256
    assert.deepEqual(fps, [new X509Certificate(lab.certPem).fingerprint256, asightCa], 'the user CA first, then the asight CA, nothing else')
    const m = readManifest(b.dir)
    assert.equal(m.entries[0].prior_value, null, 'the settings file held no value, so none was replaced (4.6 prior_value)')
    assert.deepEqual(m.files.filter((f) => f.role === 'trust-file').map((f) => [f.path, f.sources]), [[extra, [labFile]]])
    await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.ok(!fs.existsSync(extra) && !fs.existsSync(settingsOf(b)))
    assert.equal(fs.readFileSync(labFile, 'utf8'), lab.certPem, 'the user CA file is untouched')
  } finally { b.done() }
})

test('uninstall: stops the daemon first, reports CC processes still trusting until restart, purges data only when asked, runs twice', async () => {
  const b = box()
  try {
    const running = [{ pid: 4242, exe: '/x/claude/versions/2.1.289', argv: ['claude'], env: new Map() }]
    const match = (f) => ({ agent: f.pid === 4242 ? 'claude-code' : null })
    await installCollector(base(b, { scan: async () => running, match }))
    fs.writeFileSync(path.join(b.dir, 'capture-2026-10-06.ndjson'), '{}\n'); fs.mkdirSync(path.join(b.dir, 'flows'), { recursive: true }); fs.writeFileSync(path.join(b.dir, 'flows', 'x.ndjson'), '{}\n')
    fs.writeFileSync(path.join(b.dir, 'lock'), '{}'); fs.writeFileSync(path.join(b.dir, 'state.json'), '{}')
    const order = []
    const r = await uninstallCollector({ home: b.home, env: {}, purgeData: true, scan: async () => running, match, stop: async () => { order.push(fs.existsSync(path.join(b.dir, 'ca', 'ca.key')) ? 'stop-before-ca-removal' : 'late'); return 'stopped' } })
    assert.deepEqual([order, r.daemon, r.still_trusting], [['stop-before-ca-removal'], 'stopped', [{ pid: 4242, agent: 'claude-code', until: 'restart' }]])
    assert.ok(!fs.existsSync(b.dir), 'everything asight created is gone, the captures too (purge)')
    assert.ok(!fs.existsSync(settingsOf(b)), 'a settings file asight created is removed')
    assert.ok(!fs.existsSync(path.join(b.home, '.claude')), 'and the directory it created')
    const again = await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.deepEqual(again.notes, ['nothing is installed for this user'])
  } finally { b.done() }
})

test('uninstall --purge-data after a plain uninstall still drops the captures it kept', async () => {
  const b = box()
  try {
    await installCollector(base(b))
    fs.writeFileSync(path.join(b.dir, 'capture-2026-10-06.ndjson'), '{}\n')
    await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.deepEqual(listAll(b.dir).filter((x) => !x.startsWith('flows/')), ['capture-2026-10-06.ndjson'])
    const r = await uninstallCollector({ home: b.home, env: {}, purgeData: true, stop: stopNone })
    assert.deepEqual([r.notes, fs.existsSync(b.dir)], [['nothing is installed for this user'], false])
  } finally { b.done() }
})

test('uninstall after a crashed install (intent written, file changed, never completed) still restores the user file', async () => {
  const b = box()
  try {
    fs.mkdirSync(path.join(b.home, '.claude')); fs.writeFileSync(settingsOf(b), '{"model":"x"}')
    await installCollector(base(b))
    const m = readManifest(b.dir); m.complete = false; m.entries[0].post_sha256 = null
    fs.writeFileSync(path.join(b.dir, 'install-manifest.json'), JSON.stringify(m))
    await assert.rejects(installCollector(base(b)), /did not finish/)
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.deepEqual(r.entries.map((e) => e.result), ['restored'])
    assert.equal(fs.readFileSync(settingsOf(b), 'utf8'), '{"model":"x"}')
  } finally { b.done() }
})

test('install and uninstall refuse to run as root (D36)', async () => {
  const b = box()
  const real = process.getuid
  try {
    process.getuid = () => 0
    await assert.rejects(installCollector(base(b)), /not as root/)
    await assert.rejects(uninstallCollector({ home: b.home, env: {}, stop: stopNone }), /not as root/)
    assert.ok(!fs.existsSync(b.dir), 'nothing was created')
  } finally { process.getuid = real; b.done() }
})

test('stopDaemon: a stale lock is never killed by; a live pid that answers nowhere stops the uninstall; the lock\'s socket is tried when the runtime one is missing', async () => {
  const b = box()
  try {
    const lockFile = path.join(b.home, 'lock'); const lockSock = path.join(b.home, 'from-lock.sock')
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 4242, helper_pid: 4243, socket: lockSock }))
    const killed = []
    const kill = (pid, sig) => killed.push([pid, sig])
    const refused = async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }
    assert.equal(await stopDaemon({ socketPath: path.join(b.home, 's.sock'), lockFile, request: refused, kill, alive: () => false }), 'none')
    assert.deepEqual(killed, [], 'a stale lock is never killed by')
    await assert.rejects(stopDaemon({ socketPath: null, lockFile, request: refused, kill, alive: (pid) => pid === 4242 }), /may still be running \(pid 4242.*nothing was removed/)
    assert.deepEqual(killed, [], 'a live pid that answers on no socket is not killed either')
    await assert.rejects(stopDaemon({ socketPath: path.join(b.home, 's.sock'), lockFile: path.join(b.home, 'none'), request: async () => ({}), kill }), /left no lock file/)
    assert.deepEqual(killed, [])
    // XDG_RUNTIME_DIR unset (socketPath null): the daemon is found through the socket its lock names, and stopped
    let alive = true; const asked = []
    const r = await stopDaemon({ socketPath: null, lockFile, request: async (q) => { asked.push(q.socketPath); if (q.socketPath !== lockSock) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return {} }, kill: (pid, sig) => { killed.push([pid, sig]); alive = false }, alive: () => alive })
    assert.deepEqual([r, killed, asked], ['stopped', [[4242, 'SIGTERM']], [lockSock]])
  } finally { b.done() }
})

test('uninstall with no runtime dir set finds the daemon through its lock, stops it, then removes (S10)', async () => {
  const b = box()
  const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) // stands in for `asight collector start`
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'as-u-')), 'c.sock')
  const control = await startControlServer({ socketPath: sock, routes: { 'GET /status': async () => ({ desired: 'on' }) } })
  try {
    await installCollector(base(b))
    fs.writeFileSync(path.join(b.dir, 'lock'), JSON.stringify({ pid: daemon.pid, socket: sock }))
    const exited = new Promise((r) => daemon.once('exit', (code, sig) => r(sig)))
    const r = await uninstallCollector({ home: b.home, env: {} }) // the product default stop, no XDG_RUNTIME_DIR
    assert.deepEqual([r.daemon, await exited], ['stopped', 'SIGTERM'])
    assert.ok(!fs.existsSync(path.join(b.dir, 'lock')) && !fs.existsSync(settingsOf(b)))
  } finally { daemon.kill('SIGKILL'); await control.close(); b.done() }
})

test('a refused plan entry or a non-JSON settings file leaves every user file untouched; uninstall clears what was started', async () => {
  const b = box()
  try {
    const bashrc = path.join(b.home, '.bashrc'); fs.writeFileSync(bashrc, 'export X=1\n')
    const loginEnv = { name: 'login-env', inject: () => ({ entries: [{ kind: 'json-key', path: bashrc, keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: path.join(b.dir, 'ca', 'asight-ca.pem'), semantic: 'append' }] }) }
    await assert.rejects(installCollector(base(b, { harnesses: [cc, loginEnv] })), /login-environment/)
    assert.ok(!fs.existsSync(settingsOf(b)), "CC's entry, planned first, was not written: the whole plan is checked before any file changes")
    assert.ok(!fs.existsSync(path.join(b.home, '.asight')), 'a refused plan writes nothing at all, not even the manifest or the CA')
    assert.equal(fs.readFileSync(bashrc, 'utf8'), 'export X=1\n')
    await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.ok(!fs.existsSync(b.dir))

    fs.mkdirSync(path.join(b.home, '.claude')); fs.writeFileSync(settingsOf(b), '{"model": "x",, }')
    let listed = false
    await assert.rejects(installCollector(base(b, { onPlan: () => { listed = true } })), /JSON/)
    assert.equal(fs.readFileSync(settingsOf(b), 'utf8'), '{"model": "x",, }', 'a file that is not JSON is never rewritten')
    assert.deepEqual([listed, fs.existsSync(path.join(b.home, '.asight'))], [false, false], 'refused in the draft phase: no list, no manifest, no CA')
    fs.writeFileSync(settingsOf(b), '{"model": "x"}')
    assert.equal((await installCollector(base(b))).already, false, 'fixing the file and installing again just works')
  } finally { b.done() }
})

test('a dangling settings link is refused before anything is written; a valid link is listed as link → target', async () => {
  const b = box()
  try {
    fs.mkdirSync(path.join(b.home, '.claude')); fs.symlinkSync(path.join(b.home, 'dotfiles', 'settings.json'), settingsOf(b))
    await assert.rejects(installCollector(base(b)), /symbolic link to a file that does not exist/)
    assert.ok(!fs.existsSync(path.join(b.home, '.asight')), 'no manifest, no CA')
    fs.mkdirSync(path.join(b.home, 'dotfiles')); fs.writeFileSync(path.join(b.home, 'dotfiles', 'settings.json'), '{}')
    let listed = null
    await installCollector(base(b, { onPlan: (p) => { listed = p } }))
    assert.deepEqual(listed.entries.map((e) => [e.path, e.real_path]), [[settingsOf(b), fs.realpathSync(path.join(b.home, 'dotfiles', 'settings.json'))]])
    assert.ok(fs.lstatSync(settingsOf(b)).isSymbolicLink())
  } finally { b.done() }
})

test('an install step that fails after the manifest exists is recorded with its reason (D38)', async () => {
  const b = box()
  try {
    await assert.rejects(installCollector(base(b, { freePort: async () => { throw new Error('no port free') } })), /no port free/)
    const { recentFailures } = await import('../../src/collector/core/events.mjs')
    assert.deepEqual(recentFailures(b.dir).map((f) => [f.event, f.where, f.reason]), [['failure', 'install', 'no port free']])
  } finally { b.done() }
})

test('uninstall records a file it could not undo because it is no longer JSON (D38); status shows the failures without a daemon', async () => {
  const b = box()
  try {
    fs.mkdirSync(path.join(b.home, '.claude')); fs.writeFileSync(settingsOf(b), '{"model":"x"}')
    await installCollector(base(b))
    fs.writeFileSync(settingsOf(b), fs.readFileSync(settingsOf(b), 'utf8') + ' trailing garbage')
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.deepEqual(r.entries.map((e) => e.result), ['left-unparsable'])
    const { recentFailures } = await import('../../src/collector/core/events.mjs')
    const f = recentFailures(b.dir)
    assert.deepEqual(f.map((x) => [x.event, x.where]), [['failure', 'uninstall']])
    assert.match(f[0].reason, /settings\.json is no longer valid JSON; asight's env\.NODE_EXTRA_CA_CERTS = .*asight-ca\.pem may still be in it/)
    const { runCollector } = await import('../../src/collector/cli.mjs')
    const out = []; const err = []
    const code = await runCollector(['status'], { home: b.home, env: { XDG_RUNTIME_DIR: path.join(b.home, 'run') }, out: (x) => out.push(x), err: (x) => err.push(x) })
    assert.equal(code, 3)
    assert.match(err[0], /daemon is not running/)
    assert.match(out[0], /^recent failures \(1\):\n  \S+ failure \(uninstall\): .*no longer valid JSON/, 'read from disk, with no daemon')
  } finally { b.done() }
})

test('install → uninstall → install → uninstall stays clean and never removes anything else under ~/.asight', async () => {
  const b = box()
  try {
    const keep = [path.join(b.home, '.asight', 'ca', 'asight-ca.pem'), path.join(b.home, '.asight', 'calls.ndjson')]
    for (const f of keep) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'legacy') }
    for (let i = 0; i < 2; i++) {
      await installCollector(base(b))
      assert.ok(readManifest(b.dir).complete, `round ${i}: installed`)
      await uninstallCollector({ home: b.home, env: {}, purgeData: true, stop: stopNone })
      assert.ok(!fs.existsSync(b.dir) && !fs.existsSync(settingsOf(b)), `round ${i}: nothing of the install is left`)
    }
    assert.deepEqual(keep.map((f) => fs.readFileSync(f, 'utf8')), ['legacy', 'legacy'], 'the legacy CA and v0 captures under ~/.asight are untouched')
  } finally { b.done() }
})

test('install lists every file it will write or change before writing any, and writes exactly those (4.6)', async () => {
  const b = box()
  try {
    const corp = createCa({ commonName: 'corp relay CA' })
    const corpFile = path.join(b.home, 'corp.pem'); fs.writeFileSync(corpFile, corp.certPem)
    let listed = null
    const walk = (d, out = {}) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else out[p] = fs.readFileSync(p, 'latin1') } return out }
    const before = walk(b.home)
    const r = await installCollector(base(b, { env: { HOME: b.home, NODE_EXTRA_CA_CERTS: corpFile }, onPlan: (p) => {
      assert.ok(!fs.existsSync(path.join(b.home, '.asight')) && !fs.existsSync(settingsOf(b)), 'called before anything is written')
      listed = p
    } }))
    const extra = path.join(b.dir, 'ca', 'extra-cc.pem')
    assert.deepEqual(listed.ca, [path.join(b.dir, 'ca', 'ca.key'), path.join(b.dir, 'ca', 'asight-ca.pem')])
    assert.deepEqual(listed.files, [{ harness: 'claude-code', path: extra, sources: [corpFile] }])
    assert.deepEqual(listed.entries, [{ harness: 'claude-code', path: settingsOf(b), keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: extra }])
    // a walk of the whole HOME before and after: every file added or changed is one the list named
    const after = walk(b.home)
    const touched = Object.keys(after).filter((f) => before[f] !== after[f]).sort()
    const log = touched.filter((f) => f.startsWith(listed.records + path.sep))
    assert.equal(log.length, 1, 'install notes go to the event log the list names')
    assert.deepEqual(touched.filter((f) => !log.includes(f)), [listed.manifest, ...listed.ca, ...listed.files.map((f) => f.path), ...listed.entries.map((e) => e.path)].sort(), 'written == listed, nothing else')
    assert.ok(r.manifest.complete)
  } finally { b.done() }
})

test('freeEnginePort skips a port whose [::1] side is taken; a machine without IPv6 keeps the 127.0.0.1 port', async () => {
  const servers = []
  const fake = (taken) => async (port, host) => {
    if (host === '::1' && taken(port)) throw Object.assign(new Error('in use'), { code: taken(port) })
    const s = { port: port || 40000 + servers.length, closed: false, address() { return { port: this.port } }, close(cb) { this.closed = true; cb() } }
    servers.push(s); return s
  }
  assert.equal(await freeEnginePort({ listen: fake((p) => (p === 40000 ? 'EADDRINUSE' : null)) }), 40001)
  assert.ok(servers.every((s) => s.closed), 'every probe socket is closed')
  servers.length = 0
  assert.equal(await freeEnginePort({ listen: fake(() => 'EADDRNOTAVAIL') }), 40000, 'no IPv6 on this machine: the v4 port is kept')
  servers.length = 0
  await assert.rejects(freeEnginePort({ tries: 3, listen: fake(() => 'EADDRINUSE') }), /no port was free on both 127\.0\.0\.1 and \[::1\] in 3 tries/)
})

test('uninstall leaves a settings file that became a symbolic link alone and records it, even with --purge-data (D38)', async () => {
  const b = box()
  try {
    fs.mkdirSync(path.join(b.home, '.claude')); fs.writeFileSync(settingsOf(b), '{"model":"x"}')
    await installCollector(base(b))
    const dot = path.join(b.home, 'dotfiles', 'settings.json'); fs.mkdirSync(path.dirname(dot)); fs.copyFileSync(settingsOf(b), dot)
    fs.rmSync(settingsOf(b)); fs.symlinkSync(dot, settingsOf(b))
    const r = await uninstallCollector({ home: b.home, env: {}, purgeData: true, stop: stopNone })
    assert.deepEqual(r.entries.map((e) => e.result), ['left-link'])
    assert.ok(fs.lstatSync(settingsOf(b)).isSymbolicLink(), 'never replaced by a regular file')
    const { recentFailures } = await import('../../src/collector/core/events.mjs')
    assert.deepEqual(recentFailures(b.dir).map((f) => [f.where, /symbolic link/.test(f.reason)]), [['uninstall', true]], 'recorded after the purge, so it survives it')
  } finally { b.done() }
})

test('stopDaemon: an unreadable lock with no daemon answering stops the uninstall, nothing removed', async () => {
  const b = box()
  try {
    await installCollector(base(b))
    fs.writeFileSync(path.join(b.dir, 'lock'), '') // cut short by a power loss
    await assert.rejects(uninstallCollector({ home: b.home, env: {} }), /lock is unreadable, so whether a collector daemon still runs is unknown.*nothing was removed/)
    assert.ok(fs.existsSync(path.join(b.dir, 'ca', 'ca.key')) && JSON.parse(fs.readFileSync(settingsOf(b), 'utf8')).env.NODE_EXTRA_CA_CERTS)
  } finally { b.done() }
})

// A synthetic plugin-style harness (no real agent): a plugin file in the agent's own directory, a row in a YAML list
// that loads asight's plugin directory, a JSON key, and a path the agent may write because of the plugin.
async function plugHarness(b) {
  const { lineComment } = await import('../../src/collector/core/trust/text-edit.mjs')
  const dir = path.join(b.home, '.asight', 'collector')
  return {
    name: 'plug', runtime: 'node', signatures: { linux: { match: [{ exe: /plug$/ }] } }, hosts: [], trust: { chain: [{ var: 'asight:marker', semantic: 'append' }] },
    inject: (ctx) => ({
      owned: [
        { path: path.join(ctx.home, '.config', 'plug', 'plugins', 'asight-ca.js'), role: 'plugin', data: '// asight collector: trust plugin\n', mode: 0o644 },
        { path: path.join(dir, 'plugins', 'plug', 'index.js'), role: 'plugin', data: 'export {}\n', mode: 0o644 },
      ],
      entries: [
        { kind: 'json-key', path: path.join(ctx.home, '.plug', 'settings.json'), keys: ['ca'], value: ctx.caPem, semantic: 'append' },
        { kind: 'text', format: 'yaml-list', path: path.join(ctx.home, '.plug', 'patch.yml'), line: `- insert: [{ name: ${JSON.stringify(path.join(dir, 'plugins', 'plug', 'index.js'))} }] ${lineComment('plug trust plugin')}` },
      ],
      watch: [{ path: path.join(ctx.home, '.config', 'plug', 'node_modules'), why: 'plug installs its plugin SDK on first run' }],
      notes: [{ code: 'harness-note', text: 'plug fetches its plugin SDK once' }],
    }),
  }
}

test('install / uninstall of plugin-style entries: plugins and the patch row in, undone in the 4.6 order; what the agent wrote is reported, not removed', async () => {
  const b = box()
  try {
    const h = await plugHarness(b)
    const patch = path.join(b.home, '.plug', 'patch.yml'); fs.mkdirSync(path.dirname(patch)); fs.writeFileSync(patch, '- set: {a: 1}\n')
    let listed = null
    await installCollector(base(b, { harnesses: [h], onPlan: (p) => { listed = p } }))
    const plugin = path.join(b.home, '.config', 'plug', 'plugins', 'asight-ca.js')
    assert.deepEqual(listed.owned.map((o) => [o.path, o.role]), [[plugin, 'plugin'], [path.join(b.dir, 'plugins', 'plug', 'index.js'), 'plugin']])
    assert.equal(fs.statSync(plugin).mode & 0o777, 0o644)
    assert.ok(fs.statSync(path.join(b.dir, 'run', 'trust')).isDirectory(), 'the marker dir exists before any daemon runs')
    assert.match(fs.readFileSync(patch, 'utf8'), /^- set: \{a: 1\}\n- insert: \[\{ name: ".*index\.js" \}\] # asight collector: plug trust plugin/)
    const m = readManifest(b.dir)
    assert.deepEqual(m.watched.map((w) => [w.harness, w.existed_before]), [['plug', false]])
    fs.mkdirSync(path.join(b.home, '.config', 'plug', 'node_modules', 'sdk'), { recursive: true }) // the agent's first run
    fs.appendFileSync(patch, '- insert: [{ name: mine }]\n') // and the user's own row
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.deepEqual(r.entries.map((e) => [path.basename(e.path), e.result]), [['settings.json', 'restored'], ['patch.yml', 'reverted-not-identical']], 'config keys (step 1) before patch rows (step 4)')
    const order = r.removed.map((p) => path.basename(p))
    assert.ok(order.indexOf('asight-ca.pem') < order.indexOf('index.js') && order.indexOf('index.js') < order.indexOf('asight-ca.js'), `step 3 (CA file) before step 4 (row before the files it loads): ${order}`)
    assert.equal(fs.readFileSync(patch, 'utf8'), '- set: {a: 1}\n- insert: [{ name: mine }]\n')
    assert.ok(!fs.existsSync(plugin) && !fs.existsSync(path.join(b.dir, 'plugins')), 'the plugin file and asight\'s plugin dir are gone')
    assert.deepEqual(r.residue, [path.join(b.home, '.config', 'plug', 'node_modules')])
    assert.ok(fs.existsSync(path.join(b.home, '.config', 'plug', 'node_modules', 'sdk')), 'never deleted')
    const events = fs.readdirSync(path.join(b.dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(b.dir, 'flows', n), 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
    assert.deepEqual(events.map((e) => [e.event, e.code]), [['install-note', 'harness-note'], ['uninstall-note', 'reverted-not-identical'], ['uninstall-note', 'residue-not-removed']])
    assert.equal(readManifest(b.dir), null)
  } finally { b.done() }
})

test('an entry uninstall cannot undo stays in the manifest; install refuses until a later uninstall clears it (4.6: the manifest goes last)', async () => {
  const b = box()
  try {
    fs.mkdirSync(path.join(b.home, '.claude')); fs.writeFileSync(settingsOf(b), '{"model":"x"}')
    await installCollector(base(b))
    const good = fs.readFileSync(settingsOf(b), 'utf8')
    fs.writeFileSync(settingsOf(b), good + ' trailing garbage')
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.deepEqual([r.left, r.entries.map((e) => e.result)], [1, ['left-unparsable']])
    const kept = readManifest(b.dir)
    assert.deepEqual([kept.uninstall_left, kept.entries.map((e) => e.path), kept.files], [true, [settingsOf(b)], []])
    assert.ok(!fs.existsSync(path.join(b.dir, 'ca', 'ca.key')), 'the CA private key goes all the same')
    await assert.rejects(installCollector(base(b)), /an earlier uninstall left entries it could not undo/)
    fs.writeFileSync(settingsOf(b), good) // the user repairs the file
    const again = await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.deepEqual([again.left, again.entries.map((e) => e.result)], [0, ['restored']])
    assert.equal(fs.readFileSync(settingsOf(b), 'utf8'), '{"model":"x"}')
    assert.equal(readManifest(b.dir), null)
  } finally { b.done() }
})

// A synthetic replace-semantics harness: a dotenv block naming its combined bundle (Codex / Hermes shape).
const repHarness = (dir, extra = {}) => ({
  name: 'rep', runtime: 'rust', signatures: { linux: { match: [{ exe: /\/rep$/ }] } }, hosts: [], trust: { chain: [{ var: 'SSL_CERT_FILE', semantic: 'replace' }], ...extra },
  inject: (ctx) => ({
    entries: [{ kind: 'text', format: 'dotenv-block', path: path.join(ctx.home, '.rep', '.env'), vars: { SSL_CERT_FILE: path.join(dir, 'ca', 'combined-rep.pem') }, semantic: 'replace' }],
    files: [{ path: path.join(dir, 'ca', 'combined-rep.pem'), bundle: true, certsFrom: [path.join(ctx.home, 'corp.pem')] }],
  }),
})

test('uninstall step 2: a combined bundle a live process may have loaded is kept without the asight CA and reported; the next uninstall removes it (S10 b, T11)', async () => {
  const b = box()
  try {
    const corp = createCa({ commonName: 'corp relay CA' }); const root = createCa({ commonName: 'a root' })
    fs.writeFileSync(path.join(b.home, 'corp.pem'), corp.certPem)
    fs.mkdirSync(path.join(b.home, '.rep')); fs.writeFileSync(path.join(b.home, '.rep', '.env'), 'KEY=sk-secret\n')
    const roots = { node: [root.certPem], osText: '' }
    await installCollector(base(b, { harnesses: [repHarness(b.dir)], roots }))
    const bundle = path.join(b.dir, 'ca', 'combined-rep.pem')
    const fps = () => fs.readFileSync(bundle, 'utf8').split(/(?=-----BEGIN CERTIFICATE-----)/).map((c) => new X509Certificate(c).fingerprint256)
    const asightFp = new X509Certificate(fs.readFileSync(path.join(b.dir, 'ca', 'asight-ca.pem'))).fingerprint256
    assert.deepEqual(fps(), [new X509Certificate(root.certPem).fingerprint256, new X509Certificate(corp.certPem).fingerprint256, asightFp])
    assert.match(fs.readFileSync(path.join(b.home, '.rep', '.env'), 'utf8'), new RegExp(`^# >>> asight collector >>>.*\\nSSL_CERT_FILE=${bundle}\\n`))
    const installedAt = Date.parse(readManifest(b.dir).entries[0].installed_at)
    // pid 70 is rep, started after install; pid 71 is any child whose environ names the bundle; pid 72 is rep from before install
    const procs = [
      { pid: 70, exe: '/x/rep', startedAt: installedAt + 1000, env: new Map() },
      { pid: 71, exe: '/bin/git', startedAt: installedAt + 2000, env: new Map([['SSL_CERT_FILE', bundle]]) },
      { pid: 72, exe: '/x/rep', startedAt: installedAt - 60000, env: new Map() },
    ]
    const match = (f) => ({ agent: /\/rep$/.test(f.exe) ? 'rep' : null })
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone, scan: async () => procs, match, harnesses: [repHarness(b.dir)], roots })
    assert.deepEqual(r.kept_bundles, [{ path: bundle, harness: 'rep', pids: [70, 71] }], 'started after install, or inherited it; not the one from before')
    assert.deepEqual(fps(), [new X509Certificate(root.certPem).fingerprint256, new X509Certificate(corp.certPem).fingerprint256], 'the same bundle without the asight CA')
    assert.equal(fs.readFileSync(path.join(b.home, '.rep', '.env'), 'utf8'), 'KEY=sk-secret\n', 'step 1 ran: the entry is out')
    assert.deepEqual(fs.readdirSync(path.join(b.dir, 'ca')), ['combined-rep.pem'], 'the CA dir holds only the kept bundle')
    assert.equal(r.left, 0, 'kept for a live process is not a failure')
    assert.ok(readManifest(b.dir).pending_bundles)
    await assert.rejects(installCollector(base(b, { harnesses: [repHarness(b.dir)], roots })), /kept combined bundles that running agents still use/)
    const again = await uninstallCollector({ home: b.home, env: {}, stop: stopNone, scan: async () => [], match, harnesses: [repHarness(b.dir)], roots })
    assert.deepEqual(again.kept_bundles, [])
    assert.ok(!fs.existsSync(path.join(b.dir, 'ca')) && readManifest(b.dir) == null, 'the bundle, the CA dir and the manifest are gone')
  } finally { b.done() }
})

test('uninstall step 2: a harness that re-reads its entry while running keeps the bundle for any live process of it; step 5 says until when each still trusts', async () => {
  const b = box()
  try {
    fs.writeFileSync(path.join(b.home, 'corp.pem'), createCa({ commonName: 'corp' }).certPem)
    const h = repHarness(b.dir, { rereadsEntry: true, afterUninstall: 'next-connection' })
    await installCollector(base(b, { harnesses: [h], roots: { node: [], osText: '' } }))
    const old = [{ pid: 80, exe: '/x/rep', startedAt: 1, env: new Map() }]
    const match = (f) => ({ agent: 'rep' })
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone, scan: async () => old, match, harnesses: [h], roots: { node: [], osText: '' } })
    assert.deepEqual(r.kept_bundles.map((k) => k.pids), [[80]], 'it may have re-read the entry after install')
    assert.deepEqual(r.still_trusting, [{ pid: 80, agent: 'rep', until: 'next-connection' }])
  } finally { b.done() }
})

test('install / uninstall: the autostart unit is listed with its env and link, written complete, enabled, then stopped through systemd, disabled and removed with its dirs (S10, review 3 #1 #8 #10)', async () => {
  const b = box()
  try {
    const calls = []
    const unitFile = path.join(b.home, '.config', 'systemd', 'user', 'asight-collector.service')
    const link = path.join(b.home, '.config', 'systemd', 'user', 'default.target.wants', 'asight-collector.service')
    const enable = () => { calls.push(`enable, manifest complete: ${readManifest(b.dir).complete}`); return { code: 0 } }
    const unit = { path: unitFile, links: [link], text: (env) => `[Service]\n${JSON.stringify(env)}\n`, enable, disable: () => { calls.push('disable'); return { code: 0 } }, stop: () => calls.push('stop'), removeWants: () => { calls.push('wants'); return [] } }
    let listed = null
    const env = { HOME: b.home, NODE_EXTRA_CA_CERTS: '/corp/relay-ca.pem' }
    await installCollector(base(b, { unit, env, onPlan: (p) => { listed = p } }))
    assert.deepEqual(listed.unit, { path: unitFile, env: { NODE_EXTRA_CA_CERTS: '/corp/relay-ca.pem' }, links: [link] }, 'listed, with what the daemon gets and the link enable makes, before anything is written')
    assert.equal(fs.readFileSync(unitFile, 'utf8'), '[Service]\n{"NODE_EXTRA_CA_CERTS":"/corp/relay-ca.pem"}\n', 'the install shell\'s CA for upstream checks is in the unit (4.6 §引擎 5)')
    const m = readManifest(b.dir)
    assert.deepEqual(m.files.filter((f) => f.role === 'unit').map((f) => f.path), [unitFile])
    assert.equal(fs.statSync(unitFile).mode & 0o777, 0o644)
    assert.deepEqual(calls, ['enable, manifest complete: true'], 'the daemon the unit starts finds a complete manifest')
    calls.length = 0
    await uninstallCollector({ home: b.home, env: {}, unit, stop: async () => { calls.push('stopped'); return 'stopped' } })
    assert.deepEqual(calls, ['stopped', 'disable', 'wants'])
    assert.ok(!fs.existsSync(path.join(b.home, '.config')), 'the unit and the directories asight created for it are gone')
  } finally { b.done() }
})

test('install: a unit systemd refuses to enable is a recorded failure, the install still completes; stopDaemon stops a unit-managed daemon through systemd, a hand-started one by pid', async () => {
  const b = box()
  try {
    const unit = { path: path.join(b.home, '.config', 'systemd', 'user', 'asight-collector.service'), text: () => '[Unit]\n', enable: () => ({ code: 1, err: 'Failed to connect to bus' }), disable: () => ({ code: 0 }), stop: () => {}, removeWants: () => [] }
    const r = await installCollector(base(b, { unit }))
    assert.ok(r.manifest.complete)
    const { recentFailures } = await import('../../src/collector/core/events.mjs')
    const f = recentFailures(b.dir).find((x) => x.code === 'unit-not-enabled')
    assert.ok(f && /Failed to connect to bus/.test(f.reason) && /asight collector start/.test(f.reason), JSON.stringify(f))
    // a daemon answering on its socket, managed by the unit: stopped through systemd, never killed by pid
    const sock = path.join(b.home, 's.sock'); const lock = path.join(b.home, 'lock'); fs.writeFileSync(lock, JSON.stringify({ pid: 4242, helper_pid: 4243 }))
    const seen = []; let up = true
    const res = await stopDaemon({ socketPath: sock, lockFile: lock, request: async () => ({}), alive: () => up, kill: () => seen.push('kill'), stopUnit: () => { seen.push('unit-stop'); up = false } })
    assert.deepEqual([res, seen], ['stopped', ['unit-stop']])
    // the unit is installed but this daemon was started by hand (the unit could not be enabled): systemd
    // stops nothing, so it is stopped by pid
    const seen2 = []; let up2 = true
    const res2 = await stopDaemon({ socketPath: sock, lockFile: lock, request: async () => ({}), alive: () => up2, kill: (pid, sig) => { seen2.push(`kill ${pid} ${sig}`); up2 = false }, stopUnit: () => seen2.push('unit-stop') })
    assert.deepEqual([res2, seen2], ['stopped', ['unit-stop', 'kill 4242 SIGTERM']])
  } finally { b.done() }
})

test('daemonEnv: the install shell\'s NODE_EXTRA_CA_CERTS goes to the unit when it is an absolute path outside asight\'s home; otherwise it is said and recorded (review 3 #1, D38)', async () => {
  const dir = '/h/.asight/collector'
  assert.deepEqual(daemonEnv({}, dir), { env: {}, note: null })
  assert.deepEqual(daemonEnv({ NODE_EXTRA_CA_CERTS: '/corp/ca.pem' }, dir), { env: { NODE_EXTRA_CA_CERTS: '/corp/ca.pem' }, note: null })
  assert.match(daemonEnv({ NODE_EXTRA_CA_CERTS: 'ca.pem' }, dir).note, /\(it is a relative path\)/)
  assert.match(daemonEnv({ NODE_EXTRA_CA_CERTS: '/h/.asight/collector/ca/extra-cc.pem' }, dir).note, /asight's own file/)
  assert.deepEqual(daemonEnv({ NODE_EXTRA_CA_CERTS: '/h/.asightful/ca.pem' }, dir).env, { NODE_EXTRA_CA_CERTS: '/h/.asightful/ca.pem' }, 'a sibling whose name only starts the same is not asight\'s')
  const b = box()
  try {
    const unit = { path: path.join(b.home, '.config', 'systemd', 'user', 'asight-collector.service'), links: [], text: (env) => JSON.stringify(env), enable: () => ({ code: 0 }), disable: () => ({ code: 0 }), stop: () => {}, removeWants: () => [] }
    let listed = null
    const r = await installCollector(base(b, { unit, env: { HOME: b.home, NODE_EXTRA_CA_CERTS: 'rel/ca.pem' }, onPlan: (p) => { listed = p } }))
    assert.ok(listed.notes.some((n) => /\(rel\/ca\.pem\) is not given to the autostart unit/.test(n)), 'said in the list printed before anything is written')
    assert.ok(r.plan.notes.some((n) => /\(rel\/ca\.pem\) is not given to the autostart unit/.test(n)))
    assert.deepEqual(readEvents(b.dir).filter((e) => e.code === 'unit-env-not-carried').map((e) => e.event), ['install-note'])
  } finally { b.done() }
})

test('uninstall step 5: only a process that may have read the entry is reported — started after its harness was installed (an owned plugin file counts), or of a harness that re-reads it; the descriptor may say a process never did; each is kept as an uninstall-note (review 3 #6)', async () => {
  const b = box()
  try {
    // plugin-only harness: its install time is its owned file's; a harness whose afterUninstall is a function of the process
    const plug = { name: 'plug', runtime: 'node', signatures: { linux: { match: [{ exe: /\/plug$/ }] } }, hosts: [], trust: { chain: [{ var: 'X', semantic: 'append' }] },
      inject: (ctx) => ({ owned: [{ path: path.join(ctx.home, '.plug', 'plugins', 'asight-ca.js'), role: 'plugin', data: '// asight collector: trust plugin\n', mode: 0o644 }] }) }
    const picky = { ...repHarness(b.dir), name: 'picky', signatures: { linux: { match: [{ exe: /\/picky$/ }] } },
      inject: (ctx) => ({ entries: [{ kind: 'text', format: 'dotenv-block', path: path.join(ctx.home, '.picky', '.env'), vars: { SSL_CERT_FILE: path.join(b.dir, 'ca', 'combined-picky.pem') }, semantic: 'replace' }], files: [{ path: path.join(b.dir, 'ca', 'combined-picky.pem'), bundle: true, certsFrom: [] }] }),
      trust: { chain: [{ var: 'SSL_CERT_FILE', semantic: 'replace' }], afterUninstall: (f, ctx) => (f.env.get('VIA') === ctx.collectorDir ? 'next-connection' : null) } }
    fs.writeFileSync(path.join(b.home, 'corp.pem'), createCa({ commonName: 'corp' }).certPem)
    const t0 = Date.now()
    await installCollector(base(b, { harnesses: [plug, picky], roots: { node: [], osText: '' } }))
    const m = readManifest(b.dir)
    assert.ok(Date.parse(m.files.find((f) => f.role === 'plugin').installed_at) >= t0, 'an owned file records when asight wrote it')
    const procs = [
      { pid: 1, exe: '/x/plug', startedAt: t0 - 60000, env: new Map() }, // before install: never loaded the plugin
      { pid: 2, exe: '/x/plug', startedAt: Date.now() + 1000, env: new Map() },
      { pid: 3, exe: '/x/picky', startedAt: Date.now() + 1000, env: new Map([['VIA', b.dir]]) },
      { pid: 4, exe: '/x/picky', startedAt: Date.now() + 1000, env: new Map() }, // its descriptor: it never read the entry
    ]
    const match = (f) => ({ agent: /\/plug$/.test(f.exe) ? 'plug' : /\/picky$/.test(f.exe) ? 'picky' : null })
    const r = await uninstallCollector({ home: b.home, env: { HOME: b.home }, stop: stopNone, scan: async () => procs, match, harnesses: [plug, picky], roots: { node: [], osText: '' } })
    assert.deepEqual(r.still_trusting, [{ pid: 2, agent: 'plug', until: 'restart' }, { pid: 3, agent: 'picky', until: 'next-connection' }])
    assert.deepEqual(readEvents(b.dir).filter((e) => e.code === 'still-trusting').map((e) => [e.event, e.harness, e.pid]), [['uninstall-note', 'plug', 2], ['uninstall-note', 'picky', 3]])
    assert.match(readEvents(b.dir).find((e) => e.pid === 3).reason, /until its next new connection/)
  } finally { b.done() }
})

test('install: an autostart unit file already there is refused before anything is written (review 4 #7); uninstall records a disable systemd refused and a link it could not remove (D38, review 4 #9)', async () => {
  const b = box()
  try {
    const unitFile = path.join(b.home, '.config', 'systemd', 'user', 'asight-collector.service')
    fs.mkdirSync(path.dirname(unitFile), { recursive: true }); fs.writeFileSync(unitFile, '[Service]\nExecStart=/usr/bin/false\n')
    let listed = false
    const unit = { path: unitFile, links: [], text: () => '[Unit]\n', enable: () => ({ code: 0 }), disable: () => ({ code: 1, err: 'Failed to connect to bus' }), stop: () => {}, removeWants: (onError) => { onError('/l/asight-collector.service', new Error('EACCES')); return [] } }
    await assert.rejects(installCollector(base(b, { unit, onPlan: () => { listed = true } })), /asight-collector\.service already exists/)
    assert.deepEqual([listed, fs.existsSync(b.dir)], [false, false], 'refused before the plan is printed and before the CA or the manifest exist')
    fs.rmSync(unitFile)
    await installCollector(base(b, { unit }))
    const r = await uninstallCollector({ home: b.home, env: {}, unit, stop: stopNone })
    assert.ok(!fs.existsSync(unitFile), 'removed all the same')
    const rec = readEvents(b.dir).filter((e) => e.code === 'unit-not-disabled')
    assert.deepEqual(rec.map((e) => e.event), ['failure', 'failure'])
    assert.match(rec[0].reason, /systemctl --user disable failed \(Failed to connect to bus\)/)
    assert.match(rec[1].reason, /\/l\/asight-collector\.service, the autostart link, could not be removed: EACCES/)
    assert.equal(r.left, 0, 'nothing of the manifest is left')
  } finally { b.done() }
})
