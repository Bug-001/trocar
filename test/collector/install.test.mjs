// test/collector/install.test.mjs — per-user install / uninstall with Claude Code's real descriptor in a sandbox
// HOME (acceptance S10 collector part, T10 + T11 for the CC entry). No root, no daemon (stop is injected).
import { PHASES } from '../../src/off/manifest.mjs' // install's items are phase install, which off spares (D55①): these cases drive the undo rules over both phases, as uninstall runs them
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { startControlServer, controlRequest } from '../../src/collector/core/control.mjs'
import { installCollector, freeEnginePort, daemonEnv, turnOn } from '../../src/collector/install.mjs'
import { uninstallCollector } from '../helpers/uninstall.mjs'
import { startDaemon } from '../../src/collector/daemon.mjs'
import { readManifest } from '../../src/collector/core/trust/journal.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { userUnit } from '../../src/collector/arch/linux/unit.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../src/collector/core/tls/leaf.mjs'
import { createRedirectorClient } from '../../src/collector/arch/linux/redirector-client.mjs'
import { createLinuxRedirector } from '../../src/collector/arch/linux/redirector.mjs'
import cc from '../../src/collector/harness/claude-code.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { spawnStandin } from '../helpers/standin.mjs'
import { fakeProc } from './arch/linux/fixtures/fake-proc.mjs'
import { fakeSystem, recordingExec, fakeDaemon, ROOTS } from '../cli/fixtures/on-ctx.mjs'
import { installedHome, ALL_HARNESSES } from '../off/fixtures/off-ctx.mjs'
import { standalonePath } from '../../src/off/paths.mjs'
import { envelopesOf } from '../helpers/record-store.mjs'

function box() {
  const home = tmpDir('asight-inst-')
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
    assert.deepEqual([m.install?.state, m.engine_port, m.planned], ['complete', 47011, [settingsOf(b)]])
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
    // D-28: the key block that was not carried over is an install-note on disk — file, type, position, never the key
    const day = fs.readdirSync(path.join(b.dir, 'flows'))[0]
    const notes = fs.readFileSync(path.join(b.dir, 'flows', day), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const skipped = notes.find((n) => n.kind === 'skipped-block')
    assert.deepEqual([skipped.event, skipped.harness, skipped.file, skipped.type, skipped.index], ['install-note', 'claude-code', corpFile, 'PRIVATE KEY', 1])
    assert.ok(notes.some((n) => n.kind === 'prior-value' && n.path === settingsOf(b) && n.reason.includes(`was ${corpFile}`)), 'the value install replaced')
    assert.ok(!JSON.stringify(notes).includes('SECRET'))
    fs.writeFileSync(path.join(b.dir, 'capture-2026-10-06.ndjson'), '{"keep":true}\n')
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.deepEqual(r.entries.map((e) => e.result), ['restored'])
    assert.equal(fs.readFileSync(settingsOf(b), 'utf8'), before)
    assert.deepEqual(listAll(b.dir), ['capture-2026-10-06.ndjson', 'flows/', `flows/${day}`], 'only the captures and the records remain')
    const events = fs.readdirSync(path.join(b.dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(b.dir, 'flows', n), 'utf8').trim().split('\n').map((l) => JSON.parse(l))).filter((e) => e.kind !== 'result') // the result line is its own check (D1-5)
    assert.deepEqual(events.map((e) => [e.event, e.where, e.code, e.harness]), [['install-note', 'install', undefined, 'claude-code'], ['install-note', 'install', 'cert-not-merged', 'claude-code'], ['install-note', 'install', 'harness-note', 'claude-code']], 'what install said is kept where status finds it (D38)')
    assert.match(events[1].reason, /corp\.pem: block 1 \(PRIVATE KEY\) is not carried over: a private key is never copied/, 'the left-out block is named by type and file, never its content (T14)')
    assert.match(events[2].reason, /exported only in a shell asight did not see/)
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
    await installCollector(base(b, { harnesses: [cc], scan: async () => running, match }))
    fs.writeFileSync(path.join(b.dir, 'capture-2026-10-06.ndjson'), '{}\n'); fs.mkdirSync(path.join(b.dir, 'flows'), { recursive: true }); fs.writeFileSync(path.join(b.dir, 'flows', 'x.ndjson'), '{}\n')
    fs.writeFileSync(path.join(b.dir, 'lock'), '{}'); fs.writeFileSync(path.join(b.dir, 'state.json'), '{}')
    const order = []
    const r = await uninstallCollector({ home: b.home, env: {}, purgeData: true, scan: async () => running, stop: async () => { order.push(fs.existsSync(path.join(b.dir, 'ca', 'ca.key')) ? 'stop-before-ca-removal' : 'late'); return 'stopped' } })
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
    assert.deepEqual(listAll(b.dir).filter((n) => !n.startsWith('flows/')), ['capture-2026-10-06.ndjson'], 'the captures (and flows/, the records) are kept')
    const r = await uninstallCollector({ home: b.home, env: {}, purgeData: true, stop: stopNone })
    assert.deepEqual([r.notes, fs.existsSync(b.dir)], [['nothing is installed for this user'], false])
  } finally { b.done() }
})

test('a crashed install (intent written, file changed, never completed) is finished by the next install (1.6 R9), and uninstall of it still restores the user file', async () => {
  const b = box()
  try {
    fs.mkdirSync(path.join(b.home, '.claude')); fs.writeFileSync(settingsOf(b), '{"model":"x"}')
    await installCollector(base(b))
    const forge = () => { const m = readManifest(b.dir); m.install = null; m.entries[0].post_sha256 = null; fs.writeFileSync(path.join(b.dir, 'install-manifest.json'), JSON.stringify(m)) }
    forge()
    const settled = fs.readFileSync(settingsOf(b), 'utf8')
    assert.equal((await installCollector(base(b))).already, false, 'an earlier install that did not finish no longer refuses: it is resumed')
    assert.deepEqual([readManifest(b.dir).install?.state, readManifest(b.dir).entries[0].post_sha256 != null, fs.readFileSync(settingsOf(b), 'utf8')], ['complete', true, settled], 'the file had been written: only its record is finished')
    forge()
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

test('uninstall with no runtime dir set finds the daemon through its lock, asks it to switch off, stops it after checking its identity, then removes (S10)', async () => {
  const b = box()
  const daemon = spawnStandin() // stands in for `asight collector start`; ends by itself if this process is killed before the `finally` (test/helpers/standin.mjs)
  const sock = path.join(tmpDir('as-u-'), 'c.sock')
  const asked = []
  const control = await startControlServer({ socketPath: sock, routes: { 'GET /status': async () => ({ desired: 'on' }), 'POST /off': async ({ body }) => { asked.push(body); return { desired: 'off', actual: 'off', confirmed: true, relayed: { closing: 0, waiting: 0, cut: 0 }, pid: daemon.pid } } } })
  try {
    await installCollector(base(b))
    fs.writeFileSync(path.join(b.dir, 'lock'), JSON.stringify({ pid: daemon.pid, start_time: '1', boot_id: 'b', socket: sock }))
    const exited = new Promise((r) => daemon.once('exit', (code, sig) => r(sig)))
    const signalled = []
    // the signal goes to the one process this test started, and only after it was told apart from another by the lock's start time and boot id (src/off/daemon-stop.mjs)
    const kill = (pid, sig) => { signalled.push([pid === daemon.pid, sig]); process.kill(pid, sig) }
    const r = await uninstallCollector({ home: b.home, env: {}, deps: { kill, identity: () => ({ start_time: '1', boot_id: 'b' }), isHelper: () => false, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) } }) // the product's own stop; a sleep that lets the exit be seen, no XDG_RUNTIME_DIR
    assert.deepEqual([r.daemon, await exited, signalled], ['stopped', 'SIGTERM', [[true, 'SIGTERM']]])
    assert.deepEqual(asked, [{ exit: true }], 'asked to switch off and exit once drained, before anything was signalled')
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
    assert.match(f[0].reason, /settings\.json: asight cannot read it \(line 1, column \d+\); asight's env\.NODE_EXTRA_CA_CERTS = .*asight-ca\.pem may still be in it/)
    const { runStatusCli } = await import('../../src/cli/status.mjs')
    const out = []; const err = []
    const code = await runStatusCli(['--failures'], { io: { out: (x) => out.push(x), err: (x) => err.push(x) }, home: b.home, env: { XDG_RUNTIME_DIR: path.join(b.home, 'run') }, platform: 'linux',
      // the control socket is asked through an injected `request` (0.1 §3): the sandbox HOME's socket path is longer than an AF_UNIX path may be on macOS,
      // so a real connect there fails with EINVAL ("does not answer") instead of the ENOENT of a daemon that is simply not running
      deps: { procs: async () => [], exec: () => ({ status: 0, stdout: '', stderr: '' }), netenv: async () => ({ at: 'T', products: [], unknown: [{ reason: 'a test' }] }), request: async () => { throw Object.assign(new Error('no such socket'), { code: 'ENOENT' }) } } })
    // §3.5: the exit code counts only the harnesses that are on and not captured NOW — nothing is on here, so a clean 0; a failure in the last
    // 24 h is a Problems line, never an exit code (the old assertion was 1, from when "no daemon" decided it)
    assert.equal(code, 0, 'nothing is on, so nothing is uncaptured: the failure below does not decide the exit code (§3.5)')
    assert.match(out.join('\n'), /^Daemon not running; nothing is captured\. Start it: asight on$/m)
    assert.match(out.join('\n'), /^ {2}Problems {4,}1 in the last 24 hours, latest just now$/m, 'the uninstall residue reaches the Problems line')
    // D38: what the uninstall left behind is still named — in the text (--failures) and in the document (`failures`)
    assert.match(out.join('\n'), /an uninstall left an item behind \(.*\.claude.sett/, 'the residue, with its path, is in the text')
    const doc = []
    assert.equal(await runStatusCli(['--json'], { io: { out: (x) => doc.push(x), err: (x) => err.push(x) }, home: b.home, env: { XDG_RUNTIME_DIR: path.join(b.home, 'run') }, platform: 'linux', deps: { procs: async () => [], exec: () => ({ status: 0, stdout: '', stderr: '' }), netenv: async () => ({ at: 'T', products: [], unknown: [] }), request: async () => { throw Object.assign(new Error('no such socket'), { code: 'ENOENT' }) } } }), 0)
    assert.equal(JSON.parse(doc.join('\n')).failures.problem, 1, 'and in the document')
  } finally { b.done() }
})

test('install → uninstall → install → uninstall stays clean and never removes anything else under ~/.asight', async () => {
  const b = box()
  try {
    const keep = [path.join(b.home, '.asight', 'ca', 'asight-ca.pem'), path.join(b.home, '.asight', 'calls.ndjson')]
    for (const f of keep) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'legacy') }
    for (let i = 0; i < 2; i++) {
      await installCollector(base(b))
      assert.equal(readManifest(b.dir).install?.state, 'complete', `round ${i}: installed`)
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
    assert.deepEqual(touched, [listed.manifest, ...listed.ca, ...listed.files.map((f) => f.path), ...listed.entries.map((e) => e.path), listed.events].sort(), 'written == listed, nothing else (the install notes too, D-28)')
    const notes = fs.readFileSync(listed.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(notes.length && notes.every((n) => n.event === 'install-note'), 'only install-note lines')
    assert.deepEqual(notes.filter((n) => n.kind !== 'result').map((n) => n.reason), r.plan.notes, 'every printed note is on disk, in order')
    assert.deepEqual([notes.at(-1).kind, notes.at(-1).outcome, notes.at(-1).counts], ['result', 'installed', { entries: 1, files: 1, notes: 1 }], 'the run ends with its result line (D1-5)')
    assert.equal(new Set(notes.map((n) => n.run)).size, 1, 'one run id on every line')
    assert.equal(r.manifest.install?.state, 'complete')
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

test('uninstall: a lock cut short and no control socket to ask is "not known whether a daemon runs" — nothing is stopped or removed, desired is written off, and the receipt names the file and says what to do — which works when followed (1.6 R11)', async () => {
  const b = box()
  try {
    await installCollector(base(b))
    const lockFile = path.join(b.dir, 'lock')
    fs.writeFileSync(lockFile, '') // cut short by a power loss
    const r = await uninstallCollector({ home: b.home, env: {} })
    assert.equal(r.receipt.ok, false)
    const text = r.receipt.problems.join('\n')
    assert.match(text, /so whether a daemon runs is not known \(no control socket path is known to ask: XDG_RUNTIME_DIR is not set\)/)
    assert.ok(text.includes(`delete ${lockFile} and run asight off again`), 'the file is named, and so is the way out')
    assert.ok(fs.existsSync(path.join(b.dir, 'ca', 'ca.key')) && JSON.parse(fs.readFileSync(settingsOf(b), 'utf8')).env.NODE_EXTRA_CA_CERTS, 'nothing was removed or undone')
    assert.ok(r.exec.calls.every((c) => !/stop|kill/.test(c)))
    fs.rmSync(lockFile) // the operator did as it says: no daemon runs, the lock goes
    const again = await uninstallCollector({ home: b.home, env: {} })
    assert.equal(again.receipt.ok, true, JSON.stringify(again.receipt.problems))
    assert.ok(!fs.existsSync(path.join(b.dir, 'ca', 'ca.key')) && !fs.existsSync(settingsOf(b)), 'the second run finishes the job: the CA and the settings file asight made are gone')
  } finally { b.done() }
})

test('uninstall: a lock cut short and a control socket nobody listens on is the last lock of a daemon that is gone — uninstall goes on, says so, and needs no manual step (1.6 R3, R11)', async () => {
  const b = box()
  try {
    await installCollector(base(b))
    fs.writeFileSync(path.join(b.dir, 'lock'), '{"pid":') // cut short
    const r = await uninstallCollector({ home: b.home, env: {}, deps: { socketPath: path.join(b.home, 'run', 'collector.sock') } }) // the real client: ENOENT
    assert.equal(r.receipt.ok, true, JSON.stringify(r.receipt.problems))
    assert.match(r.receipt.notes.join('\n'), /not valid JSON.*nothing listens on .*collector\.sock either.*ended without a clean stop/)
    assert.ok(!fs.existsSync(path.join(b.dir, 'ca', 'ca.key')), 'the CA is gone: it did finish')
    assert.ok(r.exec.calls.every((c) => !/stop|kill/.test(c)), 'and nothing was signalled')
  } finally { b.done() }
})

// A synthetic plugin-style harness (no real agent): a plugin file in the agent's own directory, a row in a YAML list
// that loads asight's plugin directory, a JSON key, and a path the agent may write because of the plugin.
async function plugHarness(b) {
  const { lineComment } = await import('../../src/off/text-edit.mjs')
  const dir = path.join(b.home, '.asight', 'collector')
  return {
    name: 'plug', runtime: 'node', processes: { names: [{ name: 'plug' }] }, hosts: [], trust: { chain: [{ var: 'asight:marker', semantic: 'append' }] },
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
    const events = fs.readdirSync(path.join(b.dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(b.dir, 'flows', n), 'utf8').trim().split('\n').map((l) => JSON.parse(l))).filter((e) => e.kind !== 'result') // the result line is its own check (D1-5)
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
    assert.deepEqual([r.left.map((l) => l.result), r.entries.map((e) => e.result)], [['left-unparsable'], ['left-unparsable']])
    const kept = readManifest(b.dir)
    assert.deepEqual([kept.uninstall_left.map((l) => l.result), kept.entries.map((e) => e.path), kept.files], [['left-unparsable'], [settingsOf(b)], []])
    assert.ok(!fs.existsSync(path.join(b.dir, 'ca', 'ca.key')), 'the CA private key goes all the same')
    await assert.rejects(installCollector(base(b)), /an earlier uninstall could not undo 1 item\(s\)/)
    fs.writeFileSync(settingsOf(b), good) // the user repairs the file
    const again = await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.deepEqual([again.left, again.entries.map((e) => e.result)], [[], ['restored']])
    assert.equal(fs.readFileSync(settingsOf(b), 'utf8'), '{"model":"x"}')
    assert.equal(readManifest(b.dir), null)
  } finally { b.done() }
})

// A synthetic replace-semantics harness: a dotenv block naming its combined bundle (Codex / Hermes shape).
const repHarness = (dir, extra = {}) => ({
  name: 'rep', runtime: 'rust', processes: { names: [{ name: 'rep' }] }, hosts: [], trust: { chain: [{ var: 'SSL_CERT_FILE', semantic: 'replace' }], ...extra },
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
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone, scan: async () => procs, roots })
    assert.deepEqual(r.kept_bundles, [{ path: bundle, harness: 'rep', pids: [70, 71] }], 'started after install, or inherited it; not the one from before')
    assert.deepEqual(fps(), [new X509Certificate(root.certPem).fingerprint256, new X509Certificate(corp.certPem).fingerprint256], 'the same bundle without the asight CA')
    assert.equal(fs.readFileSync(path.join(b.home, '.rep', '.env'), 'utf8'), 'KEY=sk-secret\n', 'step 1 ran: the entry is out')
    assert.deepEqual(fs.readdirSync(path.join(b.dir, 'ca')), ['combined-rep.pem'], 'the CA dir holds only the kept bundle')
    assert.deepEqual(r.left, [], 'kept for a live process is not a failure')
    assert.ok(readManifest(b.dir).pending_bundles)
    await assert.rejects(installCollector(base(b, { harnesses: [repHarness(b.dir)], roots })), /kept combined bundles that running agents still use .*; run "asight uninstall" again once they exit$/)
    const again = await uninstallCollector({ home: b.home, env: {}, stop: stopNone, scan: async () => [], roots })
    assert.deepEqual(again.kept_bundles, [])
    assert.ok(!fs.existsSync(path.join(b.dir, 'ca')) && readManifest(b.dir) == null, 'the bundle, the CA dir and the manifest are gone')
  } finally { b.done() }
})

// RV-2 (review, bf8740e): "kept, without the asight CA" is a claim about the file. A bundle that cannot be read at step 2
// (here: a directory where the file was, EISDIR — works for root too; EACCES is the same branch) was not rewritten, so the
// claim was false and uninstall said "uninstalled" over a live process's trust root. It is an item that could not be undone:
// the pid that may hold it, a failure event with the errno, an outcome of 'left', the manifest kept, and the next uninstall
// (once the user fixed the file) finishes. A bundle nobody holds is removed whatever its state.
test('uninstall step 2: a bundle a live process may hold that cannot be read is an item left (failure, outcome left, manifest kept), not "kept without the asight CA"; one nobody holds is removed', async () => {
  const b = box()
  try {
    const corp = createCa({ commonName: 'corp relay CA' }); const root = createCa({ commonName: 'a root' })
    fs.writeFileSync(path.join(b.home, 'corp.pem'), corp.certPem)
    fs.mkdirSync(path.join(b.home, '.rep')); fs.writeFileSync(path.join(b.home, '.rep', '.env'), 'KEY=sk-secret\n')
    const roots = { node: [root.certPem], osText: '' }
    const h = repHarness(b.dir)
    await installCollector(base(b, { harnesses: [h], roots }))
    const bundle = path.join(b.dir, 'ca', 'combined-rep.pem')
    const original = fs.readFileSync(bundle)
    const installedAt = Date.parse(readManifest(b.dir).entries[0].installed_at)
    const live = [{ pid: 70, exe: '/x/rep', startedAt: installedAt + 1000, env: new Map() }]
    fs.rmSync(bundle); fs.mkdirSync(bundle) // cannot be read
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone, scan: async () => live, roots })
    assert.deepEqual(r.left, [{ path: bundle, harness: 'rep', result: 'error' }], 'an item that could not be undone')
    assert.deepEqual(r.kept_bundles, [{ path: bundle, harness: 'rep', pids: [70], holds_ca: true, error: 'EISDIR' }], 'kept — and says it still holds the asight CA, and why')
    assert.ok(!r.notes.some((n) => /without the asight CA/.test(n)), `no note claims it was rewritten: ${r.notes.join(' | ')}`)
    const ev = readEvents(b.dir)
    const fail = ev.find((e) => e.event === 'failure' && e.where === 'uninstall' && e.path === bundle)
    assert.deepEqual([fail.code, fail.harness], ['entry-not-undone', 'rep'], 'a failure event with the harness and the file')
    assert.ok(/still holds the asight CA/.test(fail.reason) && /EISDIR/.test(fail.reason) && fail.reason.includes('pid 70'), `the reason says what is true: ${fail.reason}`)
    assert.ok(!ev.some((e) => e.kind === 'bundle-kept'), 'not recorded as a kept-without-CA bundle')
    assert.deepEqual(ev.filter((e) => e.kind === 'result').at(-1).outcome, 'left', 'the result line is not "uninstalled"')
    assert.deepEqual(readManifest(b.dir).uninstall_left, [{ path: bundle, harness: 'rep', result: 'error' }], 'the manifest is kept with what is left')
    // the user fixes the file; the next uninstall rewrites it, nobody holds it any more, and everything goes
    fs.rmSync(bundle, { recursive: true }); fs.writeFileSync(bundle, original)
    const again = await uninstallCollector({ home: b.home, env: {}, stop: stopNone, scan: async () => [], roots })
    assert.deepEqual([again.left, again.kept_bundles], [[], []])
    assert.ok(!fs.existsSync(path.join(b.dir, 'ca')) && readManifest(b.dir) == null, 'the bundle, the CA dir and the manifest are gone')
  } finally { b.done() }
  // nobody holds it: removing the unreadable bundle undoes it, so there is nothing left
  const c = box()
  try {
    fs.writeFileSync(path.join(c.home, 'corp.pem'), createCa({ commonName: 'corp' }).certPem)
    fs.mkdirSync(path.join(c.home, '.rep')); fs.writeFileSync(path.join(c.home, '.rep', '.env'), 'KEY=x\n')
    const roots = { node: [], osText: '' }
    await installCollector(base(c, { harnesses: [repHarness(c.dir)], roots }))
    const bundle = path.join(c.dir, 'ca', 'combined-rep.pem')
    fs.rmSync(bundle); fs.mkdirSync(bundle)
    const r = await uninstallCollector({ home: c.home, env: {}, stop: stopNone, scan: async () => [], roots })
    assert.deepEqual([r.left, r.kept_bundles, fs.existsSync(bundle), readManifest(c.dir)], [[], [], false, null])
  } finally { c.done() }
})

test('uninstall step 2: a harness that re-reads its entry while running keeps the bundle for any live process of it; step 5 says until when each still trusts', async () => {
  const b = box()
  try {
    fs.writeFileSync(path.join(b.home, 'corp.pem'), createCa({ commonName: 'corp' }).certPem)
    const h = repHarness(b.dir, { rereadsEntry: true, afterUninstall: 'next-connection' })
    await installCollector(base(b, { harnesses: [h], roots: { node: [], osText: '' } }))
    const old = [{ pid: 80, exe: '/x/rep', startedAt: 1, env: new Map() }]
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone, scan: async () => old, roots: { node: [], osText: '' } })
    assert.deepEqual(r.kept_bundles.map((k) => k.pids), [[80]], 'it may have re-read the entry after install')
    assert.deepEqual(r.still_trusting, [{ pid: 80, agent: 'rep', until: 'next-connection' }])
  } finally { b.done() }
})

// 4.6 安装 / 卸载不静默: an entry that could not be undone keeps the bundle it names (the agent's next start reads it), and a second uninstall
// with the same process alive still finds a kept bundle as the first left it — the first one removed the CA certificate it was judged by
test('uninstall: a replace-semantics entry that cannot be undone keeps its bundle without the asight CA and says so; the second uninstall with the holder alive says the same, not "still holds the CA" (4.6 撤销顺序 第 2 步)', async () => {
  const b = box()
  try {
    fs.writeFileSync(path.join(b.home, 'corp.pem'), createCa({ commonName: 'corp relay CA' }).certPem)
    fs.mkdirSync(path.join(b.home, '.rep')); fs.writeFileSync(path.join(b.home, '.rep', '.env'), 'KEY=sk-secret\n')
    const roots = { node: [createCa({ commonName: 'a root' }).certPem], osText: '' }
    await installCollector(base(b, { harnesses: [repHarness(b.dir)], roots }))
    const bundle = path.join(b.dir, 'ca', 'combined-rep.pem'), env = path.join(b.home, '.rep', '.env')
    const asightFp = new X509Certificate(fs.readFileSync(path.join(b.dir, 'ca', 'asight-ca.pem'))).fingerprint256
    const holds = () => fs.readFileSync(bundle, 'utf8').split(/(?=-----BEGIN CERTIFICATE-----)/).some((c) => new X509Certificate(c).fingerprint256 === asightFp)
    const installed = fs.readFileSync(env)
    fs.rmSync(env); fs.symlinkSync(path.join(b.home, 'elsewhere'), env); fs.writeFileSync(path.join(b.home, 'elsewhere'), 'X=1\n') // the entry became a link: left-link
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone, scan: async () => [], roots })
    assert.deepEqual(r.left.map((l) => [path.basename(l.path), l.harness, l.result]), [['.env', 'rep', 'left-link'], ['combined-rep.pem', 'rep', 'error']], 'the entry, and the bundle that stays because of it')
    assert.deepEqual([fs.existsSync(bundle), holds()], [true, false], 'kept, without the asight CA: an agent with no bundle has no network at its next start')
    assert.deepEqual(r.kept_bundles, [{ path: bundle, harness: 'rep', pids: [], entry_left: [env] }])
    assert.ok(r.notes.some((n) => n.includes(bundle) && /kept, without the asight CA, because .*\.env, which could not be undone, still points at it/.test(n)), r.notes.join(' | '))
    const fail = readEvents(b.dir).find((e) => e.event === 'failure' && e.where === 'uninstall' && e.path === bundle)
    assert.deepEqual([fail.code, fail.harness, /still points at it/.test(fail.reason)], ['entry-not-undone', 'rep', true])
    assert.ok(readManifest(b.dir) && readManifest(b.dir).files.some((f) => f.path === bundle), 'the manifest is kept with both')
    // the entry is fixed and a process that started after install holds the bundle: kept for it, twice
    fs.rmSync(env); fs.writeFileSync(env, installed)
    const live = [{ pid: 70, exe: '/x/rep', startedAt: Date.now() + 5000, env: new Map() }]
    const first = await uninstallCollector({ home: b.home, env: {}, stop: stopNone, scan: async () => live, roots })
    assert.deepEqual([first.left, first.kept_bundles], [[], [{ path: bundle, harness: 'rep', pids: [70] }]])
    assert.ok(!fs.existsSync(path.join(b.dir, 'ca', 'asight-ca.pem')), 'the first uninstall removed the CA certificate')
    const second = await uninstallCollector({ home: b.home, env: {}, stop: stopNone, scan: async () => live, roots })
    assert.deepEqual([second.left, second.kept_bundles, holds()], [[], [{ path: bundle, harness: 'rep', pids: [70] }], false], 'the same answer: kept without the asight CA, no holds_ca, nothing left, exit stays 0')
    assert.ok(second.notes.some((n) => /is kept, without the asight CA, for running processes that may have loaded it \(pid 70\)/.test(n)))
    const done = await uninstallCollector({ home: b.home, env: {}, stop: stopNone, scan: async () => [], roots })
    assert.deepEqual([done.kept_bundles, fs.existsSync(path.join(b.dir, 'ca')), readManifest(b.dir)], [[], false, null])
  } finally { b.done() }
})

test('install / uninstall: the autostart unit is listed with its env and link, written complete, enabled; uninstall disables it, stops the daemon, removes the file with its dirs and tells systemd (S10, review 3 #1 #8 #10)', async () => {
  const b = box()
  try {
    const calls = []
    const unitFile = path.join(b.home, '.config', 'systemd', 'user', 'asight-collector.service')
    const link = path.join(b.home, '.config', 'systemd', 'user', 'default.target.wants', 'asight-collector.service')
    const enable = () => { calls.push(`enable, manifest complete: ${readManifest(b.dir).install?.state === 'complete'}`); return { code: 0 } }
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
    const exec = (file, args) => { calls.push([file, ...args].join(' ')); return { status: 0, stdout: '', stderr: '' } }
    await uninstallCollector({ home: b.home, env: {}, deps: { exec }, stop: async () => { calls.push('stopped'); return 'stopped' } })
    assert.deepEqual(calls, ['systemctl --user is-active asight-collector.service', 'systemctl --user disable asight-collector.service', 'stopped', 'systemctl --user daemon-reload'], 'systemd is asked whether it is about to restart a daemon (it says nothing here), the autostart is disabled, the daemon stopped, and systemd told the unit file is gone (1.6 §1.4 4, 5)')
    assert.ok(!fs.existsSync(path.join(b.home, '.config')), 'the unit and the directories asight created for it are gone')
  } finally { b.done() }
})

test('install: a unit systemd refuses to enable is a recorded failure, the install still completes', async () => {
  const b = box()
  try {
    const unit = { path: path.join(b.home, '.config', 'systemd', 'user', 'asight-collector.service'), text: () => '[Unit]\n', enable: () => ({ code: 1, err: 'Failed to connect to bus' }), disable: () => ({ code: 0 }), stop: () => {}, removeWants: () => [] }
    const r = await installCollector(base(b, { unit }))
    assert.equal(r.manifest.install?.state, 'complete')
    const { recentFailures } = await import('../../src/collector/core/events.mjs')
    const f = recentFailures(b.dir).find((x) => x.code === 'unit-not-enabled')
    assert.ok(f && /Failed to connect to bus/.test(f.reason) && /asight daemon/.test(f.reason), JSON.stringify(f))
  } finally { b.done() }
})

// the flip checklist ③ (4.9 §4 末): an arch whose enable() carries its own failure record — the darwin userUnit answers a refused bootstrap with the `launchd-register-failed`
// code and launchctl wording — has that record reach flows/ VERBATIM, not the systemd-shaped unit-not-enabled + 「systemctl --user enable --now」 remediation that used to replace
// it (launchd is the only autostart on darwin, 4.9 §11: the receipt must say so). Both halves of the install: installCollector (the harness/lab shape) and turnOn (`asight on`).
test('install: a unit whose enable() carries its own failure event — the darwin LaunchAgent — records THAT, not unit-not-enabled and systemd words (flip ③, 4.9 §4; D61: registering is install\'s, so this is install\'s record)', async () => {
  const refused = { code: 1, err: 'Boot-on-boot failed: 5: Input/output error', event: { event: 'failure', where: 'install', code: 'launchd-register-failed', reason: 'launchctl bootstrap was refused (exit 5: Boot-on-boot failed: 5: Input/output error); launchd is the only autostart, so asight does not start at login' } }
  const unit = (b) => ({ path: path.join(b.home, 'Library', 'LaunchAgents', 'com.asight.collector.plist'), links: [], text: (env) => JSON.stringify(env), enable: () => ({ ...refused }), startNow: () => ({ ...refused }), start: () => ({ ...refused }), registered: () => ({ state: 'present' }), stop: () => {} })
  const { recentFailures } = await import('../../src/collector/core/events.mjs')
  const a = box()
  try {
    const r = await installCollector(base(a, { unit: unit(a) }))
    assert.equal(r.manifest.install?.state, 'complete', 'the install itself still completes — the unit file is written, only its registration failed')
    const f = recentFailures(a.dir).find((x) => x.event === 'failure')
    assert.equal(f.code, 'launchd-register-failed', JSON.stringify(f))
    assert.match(f.reason, /launchctl bootstrap was refused/, 'the launchctl wording')
    assert.ok(!/systemctl/.test(f.reason), 'no systemd remediation text in a launchd failure')
    assert.ok(!recentFailures(a.dir).some((x) => x.code === 'unit-not-enabled'), 'the generic code is not what the record carries')
  } finally { a.done() }
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
    assert.ok(listed.notes.some((n) => /\(rel\/ca\.pem\) is not given to the daemon asight starts/.test(n)), 'said in the list printed before anything is written')
    assert.ok(r.plan.notes.some((n) => /\(rel\/ca\.pem\) is not given to the daemon asight starts/.test(n)))
    assert.deepEqual(readEvents(b.dir).filter((e) => e.code === 'unit-env-not-carried').map((e) => e.event), ['install-note'])
  } finally { b.done() }
})

test('uninstall step 5: only a process that may have read the entry is reported — started after its harness was installed (an owned plugin file counts), or of a harness that re-reads it; the descriptor says, as data in the manifest snapshot, that only a process whose environ names a file of asight ever read it; each is kept as an uninstall-note (review 3 #6)', async () => {
  const b = box()
  try {
    // plugin-only harness: its install time is its owned file's; a harness whose afterUninstall is a function of the process
    const plug = { name: 'plug', runtime: 'node', processes: { names: [{ name: 'plug' }] }, hosts: [], trust: { chain: [{ var: 'X', semantic: 'append' }] },
      inject: (ctx) => ({ owned: [{ path: path.join(ctx.home, '.plug', 'plugins', 'asight-ca.js'), role: 'plugin', data: '// asight collector: trust plugin\n', mode: 0o644 }] }) }
    const picky = { ...repHarness(b.dir), name: 'picky', processes: { names: [{ name: 'picky' }] },
      inject: (ctx) => ({ entries: [{ kind: 'text', format: 'dotenv-block', path: path.join(ctx.home, '.picky', '.env'), vars: { SSL_CERT_FILE: path.join(b.dir, 'ca', 'combined-picky.pem') }, semantic: 'replace' }], files: [{ path: path.join(b.dir, 'ca', 'combined-picky.pem'), bundle: true, certsFrom: [] }] }),
      trust: { chain: [{ var: 'SSL_CERT_FILE', semantic: 'replace' }], afterUninstall: 'next-connection', untilEnviron: 'VIA' } }
    fs.writeFileSync(path.join(b.home, 'corp.pem'), createCa({ commonName: 'corp' }).certPem)
    const t0 = Date.now()
    await installCollector(base(b, { harnesses: [plug, picky], roots: { node: [], osText: '' } }))
    const m = readManifest(b.dir)
    assert.ok(Date.parse(m.files.find((f) => f.role === 'plugin').installed_at) >= t0, 'an owned file records when asight wrote it')
    const procs = [
      { pid: 1, exe: '/x/plug', startedAt: t0 - 60000, env: new Map() }, // before install: never loaded the plugin
      { pid: 2, exe: '/x/plug', startedAt: Date.now() + 1000, env: new Map() },
      { pid: 3, exe: '/x/picky', startedAt: Date.now() + 1000, env: new Map([['VIA', path.join(b.dir, 'ca', 'x.pem')]]) },
      { pid: 4, exe: '/x/picky', startedAt: Date.now() + 1000, env: new Map() }, // its descriptor: it never read the entry
    ]
    const r = await uninstallCollector({ home: b.home, env: { HOME: b.home }, stop: stopNone, scan: async () => procs, roots: { node: [], osText: '' } })
    assert.deepEqual(r.still_trusting, [{ pid: 2, agent: 'plug', until: 'restart' }, { pid: 3, agent: 'picky', until: 'next-connection' }])
    assert.deepEqual(readEvents(b.dir).filter((e) => e.code === 'still-trusting').map((e) => [e.event, e.harness, e.pid]), [['uninstall-note', 'plug', 2], ['uninstall-note', 'picky', 3]])
    assert.match(readEvents(b.dir).find((e) => e.pid === 3).reason, /until its next new connection/)
  } finally { b.done() }
})

test('install: an autostart unit file already there is refused before anything is written (review 4 #7); uninstall records a disable systemd refused and a link it could not remove (D38, review 4 #9)', async () => {
  const b = box()
  try {
    const unitDir = path.join(b.home, '.config', 'systemd', 'user')
    const unitFile = path.join(unitDir, 'asight-collector.service')
    fs.mkdirSync(path.dirname(unitFile), { recursive: true }); fs.writeFileSync(unitFile, '[Service]\nExecStart=/usr/bin/false\n')
    let listed = false
    const unit = { path: unitFile, links: [], text: () => '[Unit]\n', enable: () => ({ code: 0 }), disable: () => ({ code: 0 }), stop: () => {}, removeWants: () => [] }
    await assert.rejects(installCollector(base(b, { unit, onPlan: () => { listed = true } })), /asight-collector\.service already exists/)
    assert.deepEqual([listed, fs.existsSync(b.dir)], [false, false], 'refused before the plan is printed and before the CA or the manifest exist')
    fs.rmSync(unitFile)
    await installCollector(base(b, { unit }))
    const link = path.join(unitDir, 'default.target.wants', 'asight-collector.service')
    fs.mkdirSync(path.dirname(link)); fs.symlinkSync(unitFile, link)
    const refuses = { ...fs, rmSync: (f, o) => { if (f === link) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return fs.rmSync(f, o) } }
    const exec = (file, args) => (args.includes('disable') ? { status: 1, stdout: '', stderr: 'Failed to connect to bus' } : { status: 0, stdout: '', stderr: '' })
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone, deps: { exec, fs: refuses } })
    assert.ok(!fs.existsSync(unitFile), 'removed all the same')
    const rec = readEvents(b.dir).filter((e) => e.code === 'unit-not-disabled')
    assert.deepEqual(rec.map((e) => e.event), ['failure', 'failure'])
    assert.match(rec[0].reason, /systemctl --user disable asight-collector\.service failed \(exit 1: Failed to connect to bus\).*the autostart link .*asight-collector\.service: EACCES/)
    assert.match(rec[1].reason, /asight-collector\.service, the autostart link, could not be removed: EACCES/)
    assert.deepEqual(r.left, [], 'nothing of the manifest is left')
  } finally { b.done() }
})

test('uninstall step 5: a Claude Code from before install is reported too — it uses a settings value added while it runs (acceptance ④, review 4 #2)', async () => {
  const b = box()
  try {
    await installCollector(base(b, { harnesses: [cc] }))
    const early = [{ pid: 4343, exe: '/x/claude/versions/2.1.289', argv: ['claude'], startedAt: 1, env: new Map() }]
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone, scan: async () => early })
    assert.deepEqual(r.still_trusting, [{ pid: 4343, agent: 'claude-code', until: 'restart' }])
  } finally { b.done() }
})

// D-4: "already installed" only with a usable CA.
test('install: installed but with an unusable CA is not "already installed" — it says what is wrong and how to fix it (D-4)', async () => {
  const b = box()
  try {
    await installCollector(base(b))
    fs.writeFileSync(path.join(b.home, '.asight', 'collector', 'ca', 'asight-ca.pem'), 'not a certificate')
    await assert.rejects(installCollector(base(b)), /installed, but its CA is unusable \(cert: .*run "asight uninstall", then "asight on"$/)
  } finally { b.done() }
})

test('uninstall that cannot undo an entry keeps the manifest with only what is left, still removes the CA, and install refuses until a second uninstall clears it (D-18)', async () => {
  const b = box()
  try {
    fs.mkdirSync(path.join(b.home, '.claude')); fs.writeFileSync(settingsOf(b), '{"model":"x"}')
    await installCollector(base(b))
    const installed = fs.readFileSync(settingsOf(b), 'utf8')
    const dot = path.join(b.home, 'dotfiles', 'settings.json'); fs.mkdirSync(path.dirname(dot)); fs.copyFileSync(settingsOf(b), dot)
    fs.rmSync(settingsOf(b)); fs.symlinkSync(dot, settingsOf(b)) // became a link: asight will not write through it
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.deepEqual(r.left, [{ path: settingsOf(b), harness: 'claude-code', result: 'left-link' }])
    const m = readManifest(b.dir)
    assert.deepEqual([m.install, m.entries.map((e) => [e.path, e.keys.join('.')]), m.files, m.uninstall_left.map((l) => l.result), typeof m.uninstalled_at],
      [null, [[settingsOf(b), 'env.NODE_EXTRA_CA_CERTS']], [], ['left-link'], 'string'], 'the manifest stays, listing only what is left')
    assert.deepEqual([fs.existsSync(path.join(b.dir, 'ca', 'asight-ca.pem')), fs.existsSync(path.join(b.dir, 'ca', 'ca.key'))], [false, false], 'the CA files go all the same (an append-semantics agent only warns about a missing file)')
    await assert.rejects(installCollector(base(b)), /an earlier uninstall could not undo 1 item\(s\) \(.*settings\.json\); fix them, run "asight uninstall" again, then "asight on"$/)
    fs.rmSync(settingsOf(b)); fs.writeFileSync(settingsOf(b), installed) // the user puts a regular file back
    const again = await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.deepEqual([again.left, again.entries.map((e) => e.result)], [[], ['restored']])
    assert.equal(readManifest(b.dir), null, 'nothing left: the manifest goes')
    assert.equal(fs.readFileSync(settingsOf(b), 'utf8'), '{"model":"x"}')
    assert.equal((await installCollector(base(b))).already, false, 'and install works again')
  } finally { b.done() }
})

test('uninstall writes an uninstall-note for every result but a plain restore and for every pid still trusting; a note that cannot be written is in its output, and the uninstall still finishes (D-18, 4.6 安装 / 卸载不静默)', async () => {
  const b = box()
  try {
    fs.mkdirSync(path.join(b.home, '.claude')); fs.writeFileSync(settingsOf(b), '{"model":"x"}')
    const running = [{ pid: 4242, exe: '/x/claude/versions/2.1.289', argv: ['claude'], env: new Map() }]
    const match = (f) => ({ agent: f.pid === 4242 ? 'claude-code' : null })
    await installCollector(base(b, { harnesses: [cc], scan: async () => running, match }))
    const doc = JSON.parse(fs.readFileSync(settingsOf(b), 'utf8')); doc.theme = 'dark'; fs.writeFileSync(settingsOf(b), JSON.stringify(doc)) // edited since
    const r = await uninstallCollector({ home: b.home, env: {}, scan: async () => running, stop: stopNone })
    assert.deepEqual(r.entries.map((e) => e.result), ['reverted-not-identical'])
    const { recentFailures } = await import('../../src/collector/core/events.mjs')
    const lines = fs.readdirSync(path.join(b.dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(b.dir, 'flows', n), 'utf8').trim().split('\n').map((l) => JSON.parse(l))).filter((l) => l.event !== 'install-note')
    assert.deepEqual(lines.map((l) => [l.event, l.kind, l.path ?? l.pid]), [['uninstall-note', 'reverted-not-identical', settingsOf(b)], ['uninstall-note', 'still-trusting', 4242], ['uninstall-note', 'result', undefined]])
    assert.deepEqual([lines[2].outcome, lines[2].counts], ['uninstalled', { entries: 1, left: 0, still_trusting: 1, notes: 2 }])
    assert.match(lines[0].reason, /not byte for byte what it was before install/)
    assert.deepEqual(recentFailures(b.dir), [], 'notes are not failures')
    assert.equal(readManifest(b.dir), null)

    await installCollector(base(b, { harnesses: [cc], scan: async () => running, match }))
    fs.rmSync(path.join(b.dir, 'flows'), { recursive: true }); fs.writeFileSync(path.join(b.dir, 'flows'), 'not a directory')
    const r2 = await uninstallCollector({ home: b.home, env: {}, scan: async () => running, stop: stopNone })
    assert.ok(r2.notes.some((n) => /^not recorded \(.+\): pid 4242 \(claude-code\) trusts the asight CA until it restarts$/.test(n)), JSON.stringify(r2.notes))
    assert.equal(readManifest(b.dir), null, 'a note that cannot be written never stops the uninstall')
  } finally { b.done() }
})

// D1-5 (4.6 安装 / 卸载不静默): a clean run writes its result line too, and "last" is the newest run — an older run's
// warnings never stand in for it; a failed run ends with outcome 'failed'.
test('the board\'s last install / uninstall is the newest run: a clean uninstall after one that left a note shows only its own result; a failed install says so (D1-5)', async () => {
  const b = box()
  const { captureHealth } = await import('../../src/health/read.mjs')
  const last = () => captureHealth({ home: path.join(b.home, '.asight'), alive: () => false }).collector.install
  try {
    fs.mkdirSync(path.join(b.home, '.claude')); fs.writeFileSync(settingsOf(b), '{"model":"x"}')
    await installCollector(base(b))
    const doc = JSON.parse(fs.readFileSync(settingsOf(b), 'utf8')); doc.theme = 'dark'; fs.writeFileSync(settingsOf(b), JSON.stringify(doc)) // edited since
    await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.deepEqual(last().uninstall.map((n) => [n.kind, n.outcome ?? null]), [['reverted-not-identical', null], ['result', 'uninstalled']])
    await installCollector(base(b)) // within the same minute
    await uninstallCollector({ home: b.home, env: {}, stop: stopNone }) // clean: restored byte for byte
    assert.deepEqual(last().uninstall.map((n) => [n.kind, n.outcome]), [['result', 'uninstalled']], 'only the newest run: #1\'s note is not "last"')
    assert.deepEqual(last().install.map((n) => [n.kind, n.outcome ?? null]).at(-1), ['result', 'installed'])
    fs.writeFileSync(settingsOf(b), '{"model": "x",, }') // the next install fails
    await assert.rejects(installCollector(base(b)), /JSON/)
    assert.deepEqual(last().install.map((n) => [n.kind, n.outcome]), [['result', 'failed']], 'a failed install is the last install')
  } finally { b.done() }
})

test('install: a failure that cannot be recorded keeps its own message and says the record failed; a note that cannot be written is printed instead (D38 fallback, D-28)', async () => {
  const b = box()
  try {
    fs.mkdirSync(b.dir, { recursive: true }); fs.writeFileSync(path.join(b.dir, 'flows'), 'not a directory')
    fs.mkdirSync(path.join(b.home, '.claude')); fs.writeFileSync(settingsOf(b), '{"model": "x",, }')
    await assert.rejects(installCollector(base(b)), (e) => /JSON/.test(e.message) && /\(and recording this failure failed: .+\)$/.test(e.message))
    fs.writeFileSync(settingsOf(b), '{"model": "x"}')
    const r = await installCollector(base(b)) // an install note that cannot be written: printed instead, and the install stands (D-28)
    assert.equal(r.manifest.install?.state, 'complete')
    assert.ok(r.plan.notes.some((n) => /^not recorded \(.+\): claude-code: a NODE_EXTRA_CA_CERTS exported only in a shell/.test(n)), JSON.stringify(r.plan.notes))
  } finally { b.done() }
})

// ---- D39③ / 1.6 R2 R3 (Task 3): backups before every user-file change, manifest version 2 --------------------------------------
const backupsIn = (b) => (fs.existsSync(path.join(b.home, '.asight', 'backup')) ? fs.readdirSync(path.join(b.home, '.asight', 'backup')).sort().map((n) => path.join(b.home, '.asight', 'backup', n)) : [])

test('install writes manifest version 3: every item has kind, undo_by_hand and its phase, and an existing settings file is backed up (0700/0600) before it changes (R2, R3)', async () => {
  const b = box()
  try {
    fs.mkdirSync(path.join(b.home, '.claude')); const before = '{\n  "model": "x",\n  "env": {\n    "ANTHROPIC_API_KEY": "sk-ant-secret"\n  }\n}\n'
    fs.writeFileSync(settingsOf(b), before, { mode: 0o640 })
    await installCollector(base(b))
    const m = JSON.parse(fs.readFileSync(path.join(b.dir, 'install-manifest.json'), 'utf8')) // the file itself: readManifest would fill in what is missing
    assert.deepEqual([m.version, m.confirmed_paths, m.kept_backups, { ...m.liveness['claude-code'], identity: !!m.liveness['claude-code'].identity }], [3, [], [], { identity: true, rereads: true, until: 'restart' }], 'liveness: the name list is snapshotted on every OS, osName none too (D51)')
    for (const it of [...m.entries, ...m.files]) { assert.ok(it.kind && it.undo_by_hand && it.undo_by_hand.length > 10, JSON.stringify(it)) }
    assert.deepEqual(m.files.map((f) => f.kind), ['owned-file', 'owned-file'], 'the CA files install pushes with a role only get their kind when saved')
    assert.deepEqual([...m.entries, ...m.files].map((x) => x.phase), ['install', 'install', 'install'], 'the trust entry and the CA files are install\'s (D55①)')
    assert.deepEqual([m.install.state, m.install.harnesses, 'complete' in m], ['complete', ['claude-code'], false], 'install.state replaced v2\'s complete')
    const e = m.entries[0]
    assert.deepEqual(backupsIn(b), [e.backup])
    assert.equal(fs.readFileSync(e.backup, 'utf8'), before, 'the backup is the settings file as it was before install')
    assert.equal(fs.statSync(e.backup).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(e.backup)).mode & 0o777, 0o700)
    assert.ok(!fs.readFileSync(path.join(b.dir, 'install-manifest.json'), 'utf8').includes('sk-ant-secret'))
  } finally { b.done() }
})

test('install with no settings file creates one without a backup: entry.backup null, no ~/.asight/backup (R2: asight\'s own files are not backed up)', async () => {
  const b = box()
  try {
    await installCollector(base(b))
    assert.equal(readManifest(b.dir).entries[0].backup, null)
    assert.deepEqual(backupsIn(b), [])
  } finally { b.done() }
})

test('install whose backup cannot be written changes no user file and records failure backup-failed (R2, D38)', async () => {
  const b = box()
  try {
    fs.mkdirSync(path.join(b.home, '.claude')); const before = '{"model": "x"}\n'; fs.writeFileSync(settingsOf(b), before)
    fs.mkdirSync(path.join(b.home, '.asight'), { recursive: true }); fs.writeFileSync(path.join(b.home, '.asight', 'backup'), 'a file where the backup directory goes')
    await assert.rejects(installCollector(base(b)), (e) => e.code === 'backup-failed' && e.message.includes(settingsOf(b)))
    assert.equal(fs.readFileSync(settingsOf(b), 'utf8'), before, 'byte for byte')
    const f = readEvents(b.dir).filter((e) => e.event === 'failure')
    assert.deepEqual(f.map((e) => [e.where, e.code]), [['install', 'backup-failed']])
    assert.ok(f[0].reason.includes(settingsOf(b)))
    assert.equal(readEvents(b.dir).at(-1).outcome, 'failed')
  } finally { b.done() }
})

test('uninstall removes the backup of every entry it undid (zero residue until `off` owns the backups), and keeps the one of an entry it could not undo', async () => {
  const b = box()
  try {
    fs.mkdirSync(path.join(b.home, '.claude')); const before = '{\n  "model": "x"\n}\n'; fs.writeFileSync(settingsOf(b), before)
    await installCollector(base(b))
    assert.equal(backupsIn(b).length, 1)
    const r = await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.equal(fs.readFileSync(settingsOf(b), 'utf8'), before)
    assert.deepEqual(backupsIn(b), [], 'the verified restore drops its backup')
    assert.ok(!fs.existsSync(path.join(b.home, '.asight', 'backup')), 'and the empty directory goes with it')
    assert.deepEqual(r.dropped_backups.length, 1)
    // an entry that cannot be undone (the file is no longer JSON) keeps its backup, and the kept manifest still names it
    await installCollector(base(b))
    const kept = readManifest(b.dir).entries[0].backup
    fs.writeFileSync(settingsOf(b), 'not json any more')
    const r2 = await uninstallCollector({ home: b.home, env: {}, stop: stopNone })
    assert.equal(r2.left.length, 1)
    assert.deepEqual(backupsIn(b), [kept], 'the backup of the original is the only copy of what the user had')
    assert.equal(readManifest(b.dir).entries[0].backup, kept)
  } finally { b.done() }
})

test('a manifest of a version this build does not read stops install before anything is touched, and uninstall leaves every entry and every file of asight\'s alone: the routing is still taken off, exit 1, the version is named (R3)', async () => {
  const b = box()
  try {
    fs.mkdirSync(path.join(b.home, '.claude')); fs.writeFileSync(settingsOf(b), '{"model":"x"}\n')
    fs.mkdirSync(b.dir, { recursive: true }); fs.writeFileSync(path.join(b.dir, 'install-manifest.json'), JSON.stringify({ version: 4, install: { state: 'complete' }, entries: [{ path: settingsOf(b), kind: 'something-new' }], files: [] }))
    const snap = () => [fs.readFileSync(settingsOf(b)), fs.readFileSync(path.join(b.dir, 'install-manifest.json'))]
    const first = snap()
    await assert.rejects(installCollector(base(b)), /version 4/)
    let stopped = 0
    const r = await uninstallCollector({ home: b.home, env: {}, stop: async () => { stopped++; return 'none' } })
    assert.deepEqual(snap(), first)
    assert.equal(r.receipt.ok, false)
    assert.match(r.receipt.problems.join('\n'), /manifest is version 4, which this build does not read; no entry was touched/)
    assert.equal(stopped, 1, 'what does not need the manifest still happens: the daemon is stopped (1.6 R3)')
    assert.deepEqual(readEvents(b.dir).filter((e) => e.event === 'uninstall-note' && e.kind === 'result').map((e) => e.outcome), ['failed'], 'and the run ends with a result line')
  } finally { b.done() }
})

// ---- D39 / 4.6 撤销顺序 (Task 4): the liveness snapshot — what `off` needs to judge, with no descriptor in sight, which live process may hold what ----
test('install records liveness per harness it changed anything for: its signature as JSON, whether it re-reads its entry, until when a running one still trusts', async () => {
  const b = box()
  try {
    const { reviveSignature } = await import('../../src/off/signature.mjs')
    const { matchHarness } = await import('../helpers/one-harness.mjs')
    const rep = { ...repHarness(b.dir, { rereadsEntry: true, afterUninstall: 'next-connection', untilEnviron: 'SSL_CERT_FILE' }), processes: { names: [{ name: 'rep' }], exclude: [{ name: 'rep', args: '(^| )--helper( |$)' }] } }
    const quiet = { name: 'quiet', runtime: 'node', processes: { names: [{ name: 'quiet' }] }, hosts: [], trust: { chain: [{ var: 'X', semantic: 'append' }] }, inject: () => ({}) } // injects nothing
    fs.writeFileSync(path.join(b.home, 'corp.pem'), createCa({ commonName: 'corp' }).certPem)
    await installCollector(base(b, { harnesses: [rep, quiet], roots: { node: [], osText: '' } }))
    const m = JSON.parse(fs.readFileSync(path.join(b.dir, 'install-manifest.json'), 'utf8')) // the file as written: what `off` reads
    assert.deepEqual(Object.keys(m.liveness), ['rep'], 'a harness install changed nothing for has no liveness: nothing of it to judge')
    assert.deepEqual([m.liveness.rep.rereads, m.liveness.rep.until, m.liveness.rep.until_environ], [true, 'next-connection', 'SSL_CERT_FILE'])
    const sig = reviveSignature(m.liveness.rep.identity)
    const { compileIdentity } = await import('../../src/off/identity.mjs')
    assert.deepEqual(sig, compileIdentity({ harness: 'rep', ...rep.processes }), 'the compiled name list survives the manifest')
    assert.equal(matchHarness(m.liveness, { exe: '/x/rep', argv: ['rep'], env: null }), 'rep')
    assert.equal(matchHarness(m.liveness, { exe: '/x/rep', argv: ['rep', '--helper'], env: null }), null, 'and so does its exclude')
  } finally { b.done() }
})

test('liveness of a harness with no data form of afterUninstall snapshots restart; its identity is the name list, the same on every OS (D51: no OS without one)', async () => {
  const b = box()
  try {
    const fn = { ...cc, trust: { ...cc.trust, rereadsEntry: false, afterUninstall: () => 'next-handshake' } }
    await installCollector(base(b, { harnesses: [fn] })) // osName 'none': the preset list holds there too
    const l = readManifest(b.dir).liveness['claude-code']
    assert.deepEqual([l.rereads, l.until, !!l.identity], [false, 'restart', true])
  } finally { b.done() }
})

test('a descriptor whose afterUninstall is a string that is no known "until" is refused when it is validated, not read as restart', async () => {
  const { validateDescriptor } = await import('../../src/collector/core/registry.mjs')
  assert.throws(() => validateDescriptor({ ...cc, trust: { ...cc.trust, afterUninstall: 'next-connnection' } }), /afterUninstall.*next-connnection/)
  assert.throws(() => validateDescriptor({ ...cc, trust: { ...cc.trust, untilEnviron: 3 } }), /untilEnviron/)
  assert.doesNotThrow(() => validateDescriptor({ ...cc, trust: { ...cc.trust, afterUninstall: 'session-end', untilEnviron: 'X' } }))
})

// ── asight on: the unit, and a harness turned on again (1.6 §1.6 · §1.1; V33, V16 unit half) ───────────────────────────────────────────────
const onBase = (b, o = {}) => ({ home: b.home, env: { HOME: b.home, XDG_RUNTIME_DIR: path.join(b.home, 'run') }, osName: 'none', harnesses: [cc], freePort: async () => 47011, roots: ROOTS, confirm: async () => true, sleep: async () => {}, linger: () => true, ...o })
const unitOf = (b, run, spawn = () => { throw new Error('no test starts a daemon: hand in a spawn') }, env = undefined) => userUnit({ home: b.home, node: '/usr/bin/node', script: '/repo/bin/asight.mjs', run, spawn, ...(env ? { env } : {}) })

// A keep-alive TLS relay for relay.asight.test with its own private CA (the shape daemon.test.mjs uses): answers every complete request with a fixed message.
const FAKE_LOADER = fileURLToPath(new URL('./arch/linux/fixtures/fake-loader.mjs', import.meta.url))
const REPLY = '{"id":"msg_1","type":"message","role":"assistant","model":"claude-x","content":[{"type":"text","text":"pong"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":1}}'
async function relay() {
  const ca = createCa({ commonName: 'v16 relay CA' })
  const issuer = createLeafIssuer(loadCa(ca))
  const got = []
  const srv = tls.createServer({ SNICallback: (n, cb) => cb(null, issuer.secureContextFor(n)) }, (sock) => {
    let buf = Buffer.alloc(0)
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        const end = buf.indexOf('\r\n\r\n'); if (end < 0) return
        const len = Number(/content-length: (\d+)/i.exec(buf.subarray(0, end).toString('latin1'))[1])
        if (buf.length < end + 4 + len) return
        got.push(buf.subarray(0, end + 4 + len)); buf = buf.subarray(end + 4 + len)
        sock.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${REPLY.length}\r\n\r\n${REPLY}`)
      }
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { ca, got, port: srv.address().port, close: () => srv.close() }
}
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) } }
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

test('V16 (unit half): a Claude Code started while its harness was off, then on again, is config-after-start — passed through with no client error, listed under restart by the on receipt, trusted only after it restarts (1.6 §1.1, R9)', async () => {
  const root = tmpDir('as-v16-'); const home = path.join(root, 'home'); fs.mkdirSync(home)
  const b = { home, dir: path.join(home, '.asight', 'collector') }
  const sock = path.join(root, 'run', 'c.sock')
  const p = fakeProc(); const up = await relay()
  const clients = []
  const arch = { os: 'linux', createRedirector: () => createLinuxRedirector({ makeClient: () => { const c = createRedirectorClient({ binary: process.execPath, args: [FAKE_LOADER], env: { ...process.env, ASIGHT_FAKE_LOADER: '1' }, autoHeartbeatMs: 0 }); clients.push(c); return c }, procRoot: p.root, uid: process.getuid() }) }
  const ticks = () => Math.ceil((Date.now() / 1000 - p.btime) * 100)
  const CC_EXE = '/home/u/.local/share/claude/versions/2.1.289'
  const start = async (pid) => { p.add(pid, { uid: process.getuid(), exe: CC_EXE, argv: ['claude', '-p', 'hi'], cwd: root, env: { HOME: home }, startTicks: ticks() }); await clients[0].raw({ op: '__emit', ev: 'exec', tgid: pid, pid, comm: 'claude', filename: CC_EXE, ts_ns: pid }) }
  const ask = (method, path_, body) => controlRequest({ socketPath: sock, method, path: path_, body })
  const agentOf = async (pid) => (await ask('GET', '/status')).agents.find((a) => a.pid === pid)
  // the daemon below really binds the manifest's engine port: a free one, not onBase's fixed 47011 (two full runs at once collided there)
  const port = await freeEnginePort(); const freePort = async () => port
  const on = (o = {}) => turnOn(onBase(b, { socketPath: sock, request: controlRequest, unit: null, freePort, ...o }))
  fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `https://relay.asight.test:${up.port}` } }, null, 2)) // the user's own relay: its host is in the decrypt policy
  let d = null
  try {
    // install writes the entry (D55); the first on: no daemon answers (no unit), so nothing is asked of one
    await installCollector({ ...onBase(b, { freePort }), unit: null })
    const first = await on()
    assert.deepEqual([first.exit, first.receipt.daemon.state], [0, 'not-running'])
    d = await startDaemon({ dir: b.dir, socketPath: sock, arch, harnesses: [cc], env: { ...process.env, HOME: home }, upstreamCa: up.ca.certPem }) // restores the desired state: attached
    await pause(30)
    await start(4242) // started after the entry: trusted
    await until(async () => { const a = await agentOf(4242); return a && a.trusted })
    // off for the harness: the daemon stops watching it and the entry goes
    await ask('POST', '/off', { harnesses: ['claude-code'] })
    const out = await undoHarnesses({ dir: b.dir, home, phases: PHASES, manifest: readManifest(b.dir), ids: ['claude-code'], procs: async () => [], roots: ROOTS })
    assert.deepEqual(out.left, [])
    await pause(30)
    await start(4343) // started while it is off
    await pause(40)
    // Linux off still takes the certificate entry out (the handoff's open item (a)), so install writes it again, and on: both processes are older than it
    await installCollector({ ...onBase(b), unit: null })
    const again = await on({ confirm: async () => { throw new Error('nothing new to confirm: the settings file was confirmed by install') } })
    assert.equal(again.exit, 0, JSON.stringify(again.receipt.notes))
    assert.deepEqual(again.receipt.restart.map((x) => [x.harness, x.pid, x.reason]).sort((x, y) => x[1] - y[1]), [['claude-code', 4242, 'config-after-start'], ['claude-code', 4343, 'config-after-start']], 'the receipt says which processes capture waits for a restart of')
    const row = await agentOf(4343)
    assert.deepEqual([row.trusted, row.reason, row.decrypt], [false, 'config-after-start', false])
    assert.equal((await clients[0].raw({ op: '__watched' })).watch['4343'], 0, 'the kernel only observes it: its connections go direct')
    // its connection passes through the engine untouched: the client sees the relay's own certificate, no error, and the relay got the bytes
    const raw = net.connect(d.port, '127.0.0.1'); await once(raw, 'connect')
    await clients[0].raw({ op: '__inject_port', port: raw.localPort, family: 4, dst: { address: '127.0.0.1', port: up.port, family: 4 }, pid: 4343, decrypt: 0 })
    const conn = tls.connect({ socket: raw, servername: 'relay.asight.test', ca: up.ca.certPem }); await once(conn, 'secureConnect')
    const body = JSON.stringify({ model: 'claude-x', max_tokens: 4, messages: [{ role: 'user', content: 'v16-through' }] })
    const reply = await new Promise((resolve, reject) => { let t = ''; conn.on('error', reject); conn.on('data', (x) => { t += x; if (t.endsWith(REPLY)) resolve(t) }); conn.write(`POST /v1/messages HTTP/1.1\r\nhost: relay.asight.test\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`) })
    assert.match(reply, /^HTTP\/1\.1 200 OK/)
    assert.ok(Buffer.concat(up.got).toString().includes('v16-through'), 'the relay received it')
    conn.end()
    assert.equal(envelopesOf(b.dir).length, 0, 'and nothing of it was recorded: it was not decrypted')
    // after a restart the new process is trusted — it started after the entry — and decrypted
    await pause(30)
    await start(4444)
    const fresh = await until(async () => { const a = await agentOf(4444); return a && a.trusted && a })
    assert.deepEqual([fresh.reason, fresh.decrypt], ['ok', true])
    const raw2 = net.connect(d.port, '127.0.0.1'); await once(raw2, 'connect')
    await clients[0].raw({ op: '__inject_port', port: raw2.localPort, family: 4, dst: { address: '127.0.0.1', port: up.port, family: 4 }, pid: 4444, decrypt: 1 })
    const conn2 = tls.connect({ socket: raw2, servername: 'relay.asight.test', ca: fs.readFileSync(path.join(b.dir, 'ca', 'asight-ca.pem'), 'utf8') }); await once(conn2, 'secureConnect') // asight's leaf, which only a process that trusts asight's CA accepts
    const body2 = JSON.stringify({ model: 'claude-x', max_tokens: 4, messages: [{ role: 'user', content: 'v16-after-restart' }] })
    await new Promise((resolve, reject) => { let t = ''; conn2.on('error', reject); conn2.on('data', (x) => { t += x; if (t.endsWith(REPLY)) resolve(t) }); conn2.write(`POST /v1/messages HTTP/1.1\r\nhost: relay.asight.test\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body2)}\r\n\r\n${body2}`) })
    const envs = await until(() => { const e = envelopesOf(b.dir); return e.some((x) => JSON.stringify(x).includes('v16-after-restart')) && e })
    assert.deepEqual([envs.length, envs[0].proc.pid, envs[0].proc.agent], [1, 4444, 'claude-code'], 'recorded verbatim, from the process that restarted')
    conn2.end()
  } finally { await (d && d.stop()); up.close(); p.done() }
})

// ---- D39 / 1.6 §1.1, V13: the order of `asight uninstall` ----
test('V13: uninstall writes desired off, asks the daemon to switch off and exit, stops it through systemd, and only then undoes the first entry; the CA, the unit, the run directory, the backups, asight-off and the manifest come after the last entry, the manifest last; the captures stay; nothing restarts', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  const entryPaths = new Set(s.manifest().entries.flatMap((e) => [e.path, e.real_path].filter(Boolean)))
  const unitFile = path.join(s.home, '.config', 'systemd', 'user', 'asight-collector.service')
  const standalone = standalonePath(s.home); fs.mkdirSync(path.dirname(standalone), { recursive: true }); fs.writeFileSync(standalone, '#!/usr/bin/env node\n') // what `on` leaves there (Task 8)
  for (const keep of ['capture-2026-10-06.ndjson', 'audit/a.ndjson', 'replays/r.ndjson']) { fs.mkdirSync(path.dirname(path.join(s.dir, keep)), { recursive: true }); fs.writeFileSync(path.join(s.dir, keep), '{"keep":true}\n') }
  const journal = []
  const rel = (f) => path.relative(s.home, f)
  const jfs = {
    ...fs,
    renameSync: (a, b) => { journal.push(['write', rel(b)]); return fs.renameSync(a, b) },
    rmSync: (f, o) => { journal.push(['rm', rel(f)]); return fs.rmSync(f, o) },
    unlinkSync: (f) => { journal.push(['rm', rel(f)]); return fs.unlinkSync(f) },
  }
  const exec = (file, args) => { journal.push(['exec', [file, ...args].join(' ')]); return s.sys.exec.run(file, args) }
  const request = async (q) => { journal.push(['request', `${q.method} ${q.path}`]); return s.sys.daemon.request(q) }
  const r = await s.uninstall({ yes: true, deps: { fs: jfs, exec, request } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  const at = (pred) => journal.findIndex(pred)
  const last = (pred) => journal.length - 1 - [...journal].reverse().findIndex(pred)
  const iState = at(([k, x]) => k === 'write' && x === path.join('.asight', 'collector', 'state.json'))
  const iOff = at(([k, x]) => k === 'request' && x === 'POST /off')
  const iStop = at(([k, x]) => k === 'exec' && x === 'systemctl --user stop asight-collector.service')
  const iFirstEntry = at(([k, x]) => k === 'write' && entryPaths.has(path.join(s.home, x)))
  const iLastEntry = last(([k, x]) => k === 'write' && entryPaths.has(path.join(s.home, x)))
  assert.ok(iState >= 0 && iOff >= 0 && iStop >= 0 && iFirstEntry >= 0, JSON.stringify(journal))
  assert.ok(iState < iOff && iOff < iStop && iStop < iFirstEntry, `desired off, then the daemon asked to go, then stopped, then the first entry: ${[iState, iOff, iStop, iFirstEntry]}`)
  assert.deepEqual(s.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), ['POST /off {"exit":true}'], 'every harness, and the whole daemon: no names')
  const removed = (suffix) => at(([k, x]) => k === 'rm' && (x === suffix || x.endsWith(path.sep + suffix)))
  const gone = { unit: removed(rel(unitFile)), caKey: removed(path.join('ca', 'ca.key')), run: removed(path.join('collector', 'run')), standalone: removed(rel(standalone)), manifest: removed('install-manifest.json') }
  for (const [what, i] of Object.entries(gone)) assert.ok(i > iLastEntry, `${what} is removed after the last entry is undone (${i} > ${iLastEntry})`)
  assert.ok(gone.unit < gone.caKey, 'the unit before the CA key (4.6)')
  assert.ok(gone.manifest > Math.max(gone.unit, gone.caKey, gone.run, gone.standalone), 'the manifest after every other file of asight\'s')
  assert.equal(last(([k]) => k === 'rm'), gone.manifest, 'and nothing is removed after it: a run that stops half way finds the manifest')
  assert.ok(!fs.existsSync(path.join(s.home, '.asight', 'backup')), '~/.asight/backup/ is gone')
  assert.deepEqual(['capture-2026-10-06.ndjson', 'audit/a.ndjson', 'replays/r.ndjson'].map((k) => fs.existsSync(path.join(s.dir, k))), [true, true, true], 'the captures stay')
  assert.ok(fs.readdirSync(path.join(s.dir, 'flows')).length > 0, 'and the records')
  assert.deepEqual(['ca', 'run', 'state.json', 'install-manifest.json', 'op.lock', 'lock'].filter((n) => fs.existsSync(path.join(s.dir, n))), [], 'nothing else of asight\'s is left in the collector directory')
  assert.deepEqual([unitFile, standalone, path.dirname(standalone), path.join(s.home, '.config', 'systemd')].filter((f) => fs.existsSync(f)), [], 'the unit, asight-off and the directories made for them')
  const execs = journal.filter(([k]) => k === 'exec').map(([, x]) => x)
  assert.deepEqual(execs.filter((c) => /restart|start|enable|kill/.test(c)), [], 'no restart, no start')
  assert.deepEqual(execs, ['systemctl --user disable asight-collector.service', 'systemctl --user stop asight-collector.service', 'systemctl --user reset-failed asight-collector.service', 'systemctl --user is-active asight-collector.service', 'systemctl --user daemon-reload'])
  assert.deepEqual(r.receipt.relayed, { closing: 0, waiting: 0, cut: 0 })
  assert.equal(ALL_HARNESSES.length, 7)
})
