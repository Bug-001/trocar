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
import { installCollector, uninstallCollector, stopDaemon } from '../../src/collector/install.mjs'
import { readManifest } from '../../src/collector/core/trust/journal.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import cc from '../../src/collector/harness/claude-code.mjs'

function box() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-inst-'))
  return { home, dir: path.join(home, '.asight', 'collector'), done: () => fs.rmSync(home, { recursive: true, force: true }) }
}
const base = (b, o = {}) => ({ home: b.home, env: { HOME: b.home }, osName: 'none', harnesses: [cc], freePort: async () => 47011, ...o })
const stopNone = async () => 'none'
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
    assert.deepEqual(listAll(b.dir), ['capture-2026-10-06.ndjson'], 'only the captures remain')
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
    fs.writeFileSync(path.join(b.dir, 'capture-2026-10-06.ndjson'), '{}\n'); fs.mkdirSync(path.join(b.dir, 'flows')); fs.writeFileSync(path.join(b.dir, 'flows', 'x.ndjson'), '{}\n')
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
    assert.deepEqual(listAll(b.dir), ['capture-2026-10-06.ndjson'])
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
    assert.equal(fs.readFileSync(bashrc, 'utf8'), 'export X=1\n')
    await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.ok(!fs.existsSync(b.dir))

    fs.mkdirSync(path.join(b.home, '.claude')); fs.writeFileSync(settingsOf(b), '{"model": "x",, }')
    await assert.rejects(installCollector(base(b)))
    assert.equal(fs.readFileSync(settingsOf(b), 'utf8'), '{"model": "x",, }', 'a file that is not JSON is never rewritten')
    await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.deepEqual([fs.existsSync(b.dir), fs.readFileSync(settingsOf(b), 'utf8')], [false, '{"model": "x",, }'])
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
