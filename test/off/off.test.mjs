// test/off/off.test.mjs — what `asight off` does to the user's machine. V15 · V25: a real install of all seven harnesses, undone through undoHarnesses with
// the process table handed in. V1 · V5 · V8 · V21 · V24 · V27 · V34 (T07): the orchestration — runOff over a sandbox HOME in which the real `on` has run, with
// the daemon, systemd, the process table and the clock injected. Nothing in this file runs a real OS tool or touches a real process.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { installCollector } from '../../src/collector/install.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { certBlocks } from '../../src/off/pem.mjs'
import { HARNESS_IDS } from '../../src/cli/harness-names.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { sevenHomes, USER_CA } from './fixtures/seven-homes.mjs'
import { readStateFile } from '../../src/off/state.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { installedHome, writeDaemonLock, flowEvents, ALL_HARNESSES, ROOTS, procTable, fakeClock, DAEMON_ROWS, hangsOnStatus } from './fixtures/off-ctx.mjs'

const ROOT = createCa({ commonName: 'off root' })
const roots = { node: [ROOT.certPem], osText: '' }
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [])
// every file under `home` (skipping `skip`, relative) → sha256; directories count by their files, so a directory asight made and left is a difference too
const snapshot = (home, skip = []) => Object.fromEntries(walk(home).map((f) => [path.relative(home, f), crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]).filter(([rel]) => !skip.some((s) => rel === s || rel.startsWith(s + path.sep))))
const dirsOf = (home, skip = []) => walk(home).map((f) => path.relative(home, path.dirname(f))).filter((d) => !skip.some((s) => d === s || d.startsWith(s + path.sep)))
const proc = (pid, exe, argv, { startedAt = Date.now() + 5000, env = {} } = {}) => ({ pid, exe, argv, startedAt, env: () => new Map(Object.entries(env)) })

async function sevenInstalled() {
  const home = tmpDir('asight-off-')
  const sh = sevenHomes(home)
  const before = snapshot(home)
  const beforeDirs = new Set(dirsOf(home))
  await installCollector({ home, env: sh.env, osName: 'linux', harnesses: await loadHarnesses(), freePort: async () => 47011, scan: async () => [], roots })
  const dir = path.join(home, '.asight', 'collector')
  const ca = (n) => path.join(dir, 'ca', n)
  const run = (o = {}) => undoHarnesses({ dir, home, manifest: readManifest(dir), ids: null, procs: async () => [], roots, ...o })
  return { home, sh, before, beforeDirs, dir, ca, run }
}

test('V15: seven harnesses have an entry after install, and off undoes each by 4.6: the user files byte for byte; a bundle a live process loaded is kept without the CA, a missing one a rereading process uses is rebuilt, an unused one is removed; extra files; plugins, shims and rc lines are gone', async () => {
  const s = await sevenInstalled()
  const m = readManifest(s.dir)
  assert.deepEqual([...new Set([...m.entries, ...m.files].map((e) => e.harness).filter(Boolean))].sort(), [...HARNESS_IDS].sort(), 'every harness has an entry — OpenCode\'s is its plugin file, a file asight owns')
  assert.deepEqual(Object.keys(m.liveness).sort(), [...HARNESS_IDS].sort(), 'and a liveness record')
  assert.deepEqual(m.files.filter((f) => f.role === 'bundle').map((f) => path.basename(f.path)).sort(), ['combined-codex.pem', 'combined-hermes.pem', 'combined-z-code.pem'])
  assert.deepEqual(m.files.filter((f) => f.role === 'trust-file').map((f) => path.basename(f.path)).sort(), ['extra-cc.pem', 'extra-kimi.pem'])
  const plugin = path.join(s.home, '.config', 'opencode', 'plugins', 'asight-ca.js')
  assert.ok(fs.existsSync(plugin) && fs.existsSync(path.join(s.dir, 'bin', 'kimi')) && fs.existsSync(path.join(s.dir, 'plugins', 'dsh', 'index.js')), 'plugins and the shim are in')
  assert.match(fs.readFileSync(path.join(s.home, '.bashrc'), 'utf8'), /asight collector/, 'the rc line is in')
  // a codex that started after install may have loaded combined-codex.pem; z-code's bundle was deleted by hand while a Z-Code that re-reads is running;
  // nothing holds combined-hermes.pem; a child of Claude Code inherited extra-cc.pem
  fs.rmSync(s.ca('combined-z-code.pem'))
  const live = [
    proc(4242, '/home/u/.local/bin/codex', ['codex']),
    proc(4343, '/opt/ZCode/zcode', ['/opt/ZCode/zcode', '/opt/ZCode/resources/glm/zcode.cjs', 'app-server', '--stdio'], { startedAt: 0, env: { ELECTRON_RUN_AS_NODE: '1' } }),
    proc(4444, '/usr/bin/node', ['node', '/x/tool.js'], { env: { NODE_EXTRA_CA_CERTS: s.ca('extra-cc.pem') } }),
    proc(4545, '/home/u/.kimi-code/bin/kimi', ['kimi-code'], { env: { NODE_EXTRA_CA_CERTS: s.ca('extra-kimi.pem') } }), // started through asight's shim
    proc(4546, '/home/u/.kimi-code/bin/kimi', ['kimi-code']), // by its absolute path: it never read asight's file
  ]
  const r = await s.run({ procs: async () => live })
  assert.deepEqual(r.left, [])
  assert.deepEqual(snapshot(s.home, ['.asight']), s.before, 'every user file byte for byte as before — the files asight created are gone')
  assert.deepEqual(new Set(dirsOf(s.home, ['.asight'])), s.beforeDirs, 'and so are the directories it made (.config/opencode/plugins, …)')
  const kept = Object.fromEntries(r.kept_bundles.map((k) => [path.basename(k.path), k]))
  assert.deepEqual(Object.keys(kept).sort(), ['combined-codex.pem', 'combined-z-code.pem', 'extra-cc.pem', 'extra-kimi.pem'], 'every file a live process holds; combined-hermes.pem is the one nobody does')
  const asightFp = certBlocks(fs.readFileSync(s.ca('asight-ca.pem'), 'utf8'))[0].fp
  const fps = (n) => certBlocks(fs.readFileSync(s.ca(n), 'utf8')).map((c) => c.fp)
  assert.deepEqual([kept['combined-codex.pem'].pids, fps('combined-codex.pem').includes(asightFp), fps('combined-codex.pem').length > 0], [[4242], false, true], 'kept for the codex that may have loaded it, the same file without the asight CA')
  assert.deepEqual([kept['combined-z-code.pem'].pids, kept['combined-z-code.pem'].rebuilt, fps('combined-z-code.pem').includes(asightFp), fps('combined-z-code.pem').includes(certBlocks(USER_CA.certPem)[0].fp)], [[4343], true, false, true], 'gone while a rereading Z-Code runs: rebuilt without the CA, with the user CA from the recorded source')
  assert.deepEqual([kept['extra-cc.pem'].pids, fps('extra-cc.pem').includes(asightFp), fps('extra-cc.pem').includes(certBlocks(USER_CA.certPem)[0].fp)], [[4444], false, true], 'a child inherited extra-cc.pem: kept without the asight CA, the user CA stays')
  assert.ok(!fs.existsSync(s.ca('combined-hermes.pem')), 'nobody holds combined-hermes.pem, so it is removed')
  assert.deepEqual([kept['extra-kimi.pem'].pids, fps('extra-kimi.pem').includes(asightFp)], [[4545], false], 'a kimi the shim started holds extra-kimi.pem')
  for (const p of [plugin, path.join(s.dir, 'bin'), path.join(s.dir, 'plugins')]) assert.ok(!fs.existsSync(p), `${p} is gone`)
  assert.ok(!/asight collector/.test(fs.readFileSync(path.join(s.home, '.bashrc'), 'utf8')) && !fs.readFileSync(path.join(s.home, '.dsh', 'cordis.patch.yml'), 'utf8').includes('asight'))
  assert.deepEqual(r.results.map((x) => x.result).filter((x) => x !== 'restored'), [], 'every entry came back byte for byte')
  assert.ok(fs.existsSync(s.ca('asight-ca.pem')) && fs.existsSync(s.ca('ca.key')), 'off keeps the CA')
  assert.deepEqual(r.still_trusting.map((x) => [x.pid, x.harness, x.until]).sort(), [[4242, 'codex', 'next-connection'], [4343, 'z-code', 'session-end'], [4545, 'kimi-code', 'restart']], 'a kimi by its absolute path (4546) never trusted asight: not reported')
})

test('V25: off codex undoes ~/.codex/.env and its bundle and nothing else — asight-ca.pem, every other entry and bundle byte for byte; a live codex keeps combined-codex.pem, without the CA', async () => {
  const s = await sevenInstalled()
  const everything = () => snapshot(s.home, ['.asight/collector/install-manifest.json', '.asight/collector/flows']) // the manifest is rewritten by design
  const before = everything()
  const r = await s.run({ ids: ['codex'] })
  assert.deepEqual(r.results.map((x) => [x.harness, path.relative(s.home, x.path), x.result]), [['codex', '.codex/.env', 'restored']])
  assert.equal(fs.readFileSync(s.sh.files.codex[0], 'utf8'), 'OPENAI_API_KEY=sk-test\n')
  const after = everything()
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k])
  assert.deepEqual(changed.map((k) => k.replace(/^\.asight\/backup\/.*$/, '.asight/backup/<codex .env>')).sort(), ['.asight/backup/<codex .env>', '.asight/collector/ca/combined-codex.pem', '.codex/.env'], 'its .env, its bundle and the backup of its .env — asight-ca.pem, the key, the other bundles and the other six harnesses\' files are byte for byte')
  assert.deepEqual(changed.filter((k) => after[k] === undefined).length, 2, 'the bundle and the backup are gone, not changed')
  assert.deepEqual([...new Set(readManifest(s.dir).entries.map((e) => e.harness))].sort(), HARNESS_IDS.filter((h) => h !== 'codex' && h !== 'opencode').sort(), 'the other harnesses are still installed (opencode has no entry, only a plugin file)')
  // with a live codex: the bundle stays, without the CA, and the other bundles still do not move
  const t = await sevenInstalled()
  const others = (n) => fs.readFileSync(t.ca(n), 'utf8')
  const hermesBefore = others('combined-hermes.pem')
  const k = await t.run({ ids: ['codex'], procs: async () => [proc(4242, '/home/u/.local/bin/codex', ['codex'])] })
  assert.deepEqual(k.kept_bundles.map((x) => [path.basename(x.path), x.pids]), [['combined-codex.pem', [4242]]])
  assert.deepEqual([others('combined-hermes.pem') === hermesBefore, certBlocks(others('combined-codex.pem')).length > 0], [true, true])
  assert.ok(!certBlocks(others('combined-codex.pem')).some((c) => c.fp === certBlocks(others('asight-ca.pem'))[0].fp))
  assert.deepEqual(k.still_trusting, [{ pid: 4242, harness: 'codex', until: 'next-connection' }])
})

// ── T07: the orchestration ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const shaOf = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const execFrom = (s, from) => s.sys.exec.calls.slice(from)

test('V1: off with the daemon gone (its lock left, its helper dead): every entry of all seven harnesses is back at its pre_sha256, exit 0, and nothing starts a daemon', async () => {
  const s = await installedHome({ names: ALL_HARNESSES })
  const entries = s.manifest().entries
  assert.ok(entries.length >= 5, 'seven harnesses have entries to undo')
  s.sys.daemon.state.up = false // killed: nothing answers
  writeDaemonLock(s) // and its lock is left behind, naming a pid that is gone
  const calls = s.sys.exec.calls.length, asked = s.sys.daemon.calls.length
  const { receipt, exit } = await s.off({ deps: { alive: () => false } })
  assert.equal(exit, 0, JSON.stringify(receipt.problems))
  assert.deepEqual(validateReceipt(receipt), [])
  for (const e of entries) assert.equal(e.existed_before ? shaOf(e.path) : fs.existsSync(e.path), e.existed_before ? e.pre_sha256 : false, `${e.path} is back as it was before asight`)
  assert.deepEqual(receipt.routing, { confirmed: true, state: 'stale', how: 'no-daemon' })
  assert.deepEqual([receipt.daemon, receipt.relayed], [{ pid: null, state: 'none' }, { closing: 0, waiting: 0, cut: 0 }], 'no daemon: nothing is relayed, said as a fact')
  assert.deepEqual(execFrom(s, calls), ['systemctl --user disable asight-collector.service'], 'the only OS tool run is the autostart disable: no start, no restart')
  assert.deepEqual(s.sys.daemon.calls.slice(asked).filter((c) => c.startsWith('POST')), [], 'and no daemon was asked for anything, let alone started')
  assert.deepEqual(Object.values(s.state().harnesses).map((h) => h.desired), ALL_HARNESSES.map(() => 'off'), 'every harness is off in state.json')
  assert.equal(readManifest(s.dir).entries.length, 0, 'and out of the manifest')
})

test('V5: off claude-code undoes only Claude Code: the other harness\'s file is byte for byte, it stays on in state.json and attached in the daemon, /off was posted with the name only and no exit', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  const codexEnv = path.join(s.home, '.codex', '.env'), settings = path.join(s.home, '.claude', 'settings.json')
  const codexBefore = shaOf(codexEnv)
  assert.deepEqual([...s.sys.daemon.state.on].sort(), ['claude-code', 'codex'])
  const { receipt, exit } = await s.off({ ids: ['claude-code'] })
  assert.equal(exit, 0, JSON.stringify(receipt.problems))
  assert.deepEqual(validateReceipt(receipt), [])
  assert.equal(shaOf(codexEnv), codexBefore, 'codex\'s .env byte for byte')
  assert.ok(!fs.readFileSync(settings, 'utf8').includes('asight'), 'claude-code\'s entry is out')
  assert.deepEqual(s.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), ['POST /off {"harnesses":["claude-code"]}'], 'by name; no exit: the daemon stays for codex')
  assert.deepEqual([s.state().harnesses['claude-code'].desired, s.state().harnesses.codex.desired], ['off', 'on'])
  assert.deepEqual([s.sys.daemon.isRecording('claude-code'), s.sys.daemon.isRecording('codex')], [false, true], 'the daemon still has codex attached')
  assert.deepEqual([receipt.harnesses, receipt.all, receipt.daemon.state], [['claude-code'], false, 'running'])
  assert.deepEqual(receipt.changed.map((c) => [path.relative(s.home, c.path), c.harness]).concat(receipt.removed.map((p) => [path.relative(s.home, p), null])), [['.claude/settings.json', 'claude-code']].concat(receipt.removed.map((p) => [path.relative(s.home, p), null])))
  assert.ok(s.sys.exec.calls.every((c) => !/disable/.test(c)), 'a named off leaves the autostart alone')
  assert.ok(readManifest(s.dir).entries.some((e) => e.harness === 'codex'), 'codex is still installed')
})

test('V21: off,off changes nothing — the second run leaves state.json, the manifest and every user file as they were; per-harness: the daemon unwatches the harness before its bundle is rewritten', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  const bundle = path.join(s.dir, 'ca', 'combined-codex.pem')
  const caFp = certBlocks(fs.readFileSync(path.join(s.dir, 'ca', 'asight-ca.pem'), 'utf8'))[0].fp
  let seen = null
  const beforeBundle = fs.readFileSync(bundle, 'utf8')
  const first = await s.off({ ids: ['codex'], deps: { request: (q) => (q.path === '/off' ? (seen = { bundle: fs.readFileSync(bundle, 'utf8'), env: fs.readFileSync(path.join(s.home, '.codex', '.env'), 'utf8') }, s.sys.daemon.request(q)) : s.sys.daemon.request(q)) } })
  assert.equal(first.exit, 0, JSON.stringify(first.receipt.problems))
  assert.equal(seen.bundle, beforeBundle, 'when the daemon was asked to unwatch codex, its bundle still held the CA and its .env still named it')
  assert.ok(certBlocks(seen.bundle).some((c) => c.fp === caFp) && /asight collector/.test(seen.env))
  assert.ok(!fs.existsSync(bundle) || !certBlocks(fs.readFileSync(bundle, 'utf8')).some((c) => c.fp === caFp), 'afterwards the bundle is gone, or without the CA')
  const after = () => ({ user: s.userFiles(), manifest: fs.readFileSync(path.join(s.dir, 'install-manifest.json'), 'utf8'), state: fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8') })
  const all = await s.off()
  assert.equal(all.exit, 0, JSON.stringify(all.receipt.problems))
  const snap = after()
  const again = await s.off()
  assert.equal(again.exit, 0, JSON.stringify(again.receipt.problems))
  assert.deepEqual(after(), snap, 'a second off: not one byte of state.json, the manifest or a user file moves')
  assert.deepEqual([again.receipt.changed, again.receipt.removed], [[], []])
  const second = await s.off({ ids: ['codex'] })
  assert.deepEqual([second.exit, second.receipt.changed, second.receipt.skipped.map((x) => x.what)], [0, [], ['codex']], 'off codex again: nothing to do, and it says so')
})

test('1.6 §1.5: the routing is confirmed BEFORE one entry is touched — a daemon that does not confirm leaves every entry and bundle as it is, exit 1, and a state.json that already says off', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  const before = s.userFiles(), bundle = shaOf(path.join(s.dir, 'ca', 'combined-codex.pem'))
  const r = await s.off({ deps: { request: async (q) => (q.path === '/off' ? { actual: 'on', confirmed: false, relayed: { closing: 0, waiting: 0, cut: 0 }, pid: 4242 } : s.sys.daemon.request(q)) } })
  assert.equal(r.exit, 1)
  assert.deepEqual(r.receipt.routing, { confirmed: false, state: 'running', how: 'daemon-reply' })
  assert.match(r.receipt.problems[0], /did not confirm that the kernel's watch table and links are off/)
  assert.deepEqual(s.userFiles(), before, 'no user file moved')
  assert.equal(shaOf(path.join(s.dir, 'ca', 'combined-codex.pem')), bundle)
  assert.ok(readManifest(s.dir).entries.length >= 2, 'and the manifest still lists the entries')
  assert.deepEqual(Object.values(s.state().harnesses).map((h) => h.desired), ['off', 'off'], 'desired off was written first: the daemon\'s next heartbeat reads it')
  const failure = flowEvents(s.dir).find((e) => e.event === 'failure')
  assert.deepEqual([failure.where, failure.code], ['off', 'state-mismatch'])
  assert.deepEqual(flowEvents(s.dir).at(-1).kind, 'result')
})

test('1.6 §1.4 第 2 步: an off with no names asks the daemon to exit once drained and reports what is left of the connections; --now is passed on; an error answer (a 400) is a failure, not a stuck daemon', async () => {
  const s = await installedHome({ names: ['claude-code'], daemon: { relayed: { closing: 2, waiting: 1, cut: 0 }, exitOnOff: false } })
  const r = await s.off({ now: false })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.deepEqual(s.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), ['POST /off {"exit":true}'])
  assert.deepEqual([r.receipt.relayed, r.receipt.daemon], [{ closing: 2, waiting: 1, cut: 0 }, { pid: 4242, state: 'draining' }])
  const t = await installedHome({ names: ['claude-code'], daemon: { relayed: { closing: 0, waiting: 0, cut: 3 }, exitOnOff: false } })
  const cut = await t.off({ now: true })
  assert.deepEqual(t.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), ['POST /off {"now":true,"exit":true}'])
  assert.equal(cut.receipt.relayed.cut, 3)
  const u = await installedHome({ names: ['claude-code'] }); const before = u.userFiles()
  const bad = await u.off({ deps: { request: async (q) => { if (q.path === '/off') throw Object.assign(new Error('400: unknown harness: nope'), { status: 400 }); return u.sys.daemon.request(q) } } })
  assert.equal(bad.exit, 1); assert.match(bad.receipt.problems[0], /refused the off request/)
  assert.deepEqual(u.userFiles(), before)
  assert.ok(u.sys.exec.calls.every((c) => !/stop|kill/.test(c)), 'an answering daemon is never stopped')
})

// a fake process table: pid → identity; `ignore`: signals a pid survives (a stopped or wedged process); every signal is recorded
test('1.6 §1.4 第 2 / 5 步 · 「守护进程卡死」: a stuck daemon is stopped FIRST (systemctl stop, then SIGTERM), its helper with it, and only then is the first entry undone; the receipt says so', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  writeDaemonLock(s)
  const t = procTable(DAEMON_ROWS, { survives: { 4242: ['SIGTERM'] } }); const c = fakeClock()
  const settings = path.join(s.home, '.claude', 'settings.json'); const seen = []
  const exec = (file, args) => { const cmd = [file, ...args].join(' '); seen.push([cmd, fs.readFileSync(settings, 'utf8').includes('NODE_EXTRA_CA_CERTS')]); return s.sys.exec.run(file, args) }
  const r = await s.off({ deps: { exec, request: hangsOnStatus(s), alive: t.alive, identity: t.identity, kill: t.kill, isHelper: t.isHelper, ...c } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.equal(seen.find(([cmd]) => / stop /.test(cmd))[1], true, 'when systemd was told to stop the daemon, the entry was still in place')
  assert.deepEqual(t.sent, [[4242, 'SIGTERM'], [4242, 'SIGKILL'], [4243, 'SIGTERM']], 'SIGTERM, then SIGKILL after the wait; the helper after the daemon; nothing else is signalled')
  assert.deepEqual([r.receipt.routing.state, r.receipt.routing.how, r.receipt.daemon.state, r.receipt.relayed], ['unresponsive', 'signal', 'stopped', 'unknown'])
  assert.match(r.receipt.relayed_reason, /could not say how many connections/)
  assert.ok(!fs.readFileSync(settings, 'utf8').includes('asight'), 'and the entry is out after it')
  const stop = flowEvents(s.dir).find((e) => e.kind === 'daemon-stop')
  assert.deepEqual([stop.event, stop.where, stop.signals], ['off-note', 'off', ['systemctl-stop', 'SIGTERM', 'SIGKILL', 'SIGTERM']], 'the stop is on record (V30\'s stop event)')
})

test('a stuck daemon and `off codex`: it is stopped all the same (the others were not being captured by a stuck daemon), codex is undone, claude-code stays installed, exit 0 (V30 unit half, named form)', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  writeDaemonLock(s)
  const t = procTable(DAEMON_ROWS); const c = fakeClock(); const claudeBefore = shaOf(path.join(s.home, '.claude', 'settings.json'))
  const r = await s.off({ ids: ['codex'], deps: { request: hangsOnStatus(s), alive: t.alive, identity: t.identity, kill: t.kill, isHelper: t.isHelper, ...c } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.equal(r.receipt.daemon.state, 'stopped')
  assert.equal(shaOf(path.join(s.home, '.claude', 'settings.json')), claudeBefore)
  assert.deepEqual([s.state().harnesses.codex.desired, s.state().harnesses['claude-code'].desired], ['off', 'on'])
  assert.ok(s.sys.exec.calls.every((c2) => !/disable/.test(c2)), 'a named off never disables the autostart')
})

test('a daemon that cannot be stopped: the entries are undone all the same, exit 1, and the receipt gives the pid and kill -9; one that is only starting is stopped like a stuck one', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  writeDaemonLock(s)
  const t = procTable(DAEMON_ROWS, { survives: { 4242: ['SIGTERM', 'SIGKILL'] } }); const c = fakeClock()
  const r = await s.off({ deps: { request: hangsOnStatus(s), alive: t.alive, identity: t.identity, kill: t.kill, isHelper: t.isHelper, ...c } })
  assert.equal(r.exit, 1)
  assert.match(r.receipt.problems.join('\n'), /pid 4242.*could not be stopped.*kill -9 4242/)
  assert.deepEqual([r.receipt.daemon.state, r.receipt.routing.confirmed], ['unresponsive', false])
  assert.ok(!fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8').includes('asight'), 'the entry is out all the same')
  assert.deepEqual(flowEvents(s.dir).filter((e) => e.event === 'failure').map((e) => [e.where, e.code]), [['off', 'stop-failed']])
  const starting = await installedHome({ names: ['claude-code'] }); writeDaemonLock(starting)
  const t2 = procTable(DAEMON_ROWS); const c2 = fakeClock()
  const refuses = async (q) => { if (q.path === '/status') throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }); return starting.sys.daemon.request(q) }
  const r2 = await starting.off({ deps: { request: refuses, alive: t2.alive, identity: t2.identity, kill: t2.kill, isHelper: t2.isHelper, ...c2 } })
  assert.deepEqual([r2.exit, r2.receipt.routing.state, r2.receipt.daemon.state], [0, 'starting', 'stopped'])
})

test('a lock cut short (empty or garbage) and nothing listening on the control socket is the last lock of a daemon that is gone: off goes on, undoes the entries, says so, and a second off does too; a stale lock with a live helper has the helper stopped', async () => {
  const refusing = (s) => async (q) => { if (q.path === '/status') throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }); return s.sys.daemon.request(q) }
  for (const body of ['', '{"pid":']) { // empty is what a power loss leaves; the other is a write cut off half way
    const s = await installedHome({ names: ['claude-code'] }); fs.writeFileSync(path.join(s.dir, 'lock'), body)
    const t = procTable({}); const world = { request: refusing(s), alive: t.alive, identity: t.identity, kill: t.kill, ...fakeClock() }
    const r = await s.off({ deps: world })
    assert.equal(r.exit, 0, `${JSON.stringify(body)}: ${JSON.stringify(r.receipt.problems)}`)
    assert.deepEqual(validateReceipt(r.receipt), [])
    assert.deepEqual([r.receipt.routing, t.sent], [{ confirmed: true, state: 'stale', how: 'no-daemon' }, []], 'nothing is stopped, nobody is signalled')
    assert.ok(!fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8').includes('asight'), 'the entry is out')
    assert.match(r.receipt.notes.join('\n'), /nothing listens on \/x\/collector\.sock either.*ended without a clean stop/, 'and the receipt says how the lock was read')
    assert.ok(flowEvents(s.dir).some((e) => e.where === 'off' && e.kind === 'note' && /ended without a clean stop/.test(e.reason)), 'and so does flows/')
    const again = await s.off({ deps: world })
    assert.equal(again.exit, 0, `a second off (${JSON.stringify(body)}): ${JSON.stringify(again.receipt.problems)}`)
  }
  const h = await installedHome({ names: ['claude-code'] }); writeDaemonLock(h)
  const live = procTable({ 4243: { start_time: '112', boot_id: 'boot-1' } }) // the daemon is dead, its helper lingers
  const r2 = await h.off({ deps: { request: refusing(h), alive: live.alive, identity: live.identity, kill: live.kill, isHelper: live.isHelper, ...fakeClock() } })
  assert.deepEqual([r2.exit, live.sent, r2.receipt.daemon.state], [0, [[4243, 'SIGTERM']], 'stopped'])
})

test('a lock cut short and NO control socket to ask (XDG_RUNTIME_DIR unset) is not known: nothing is stopped, no entry touched, exit 1, the receipt names the file and the way out — and the way out works when followed (R11: not known is said, not read as none)', async () => {
  const s = await installedHome({ names: ['claude-code'] }); const before = s.userFiles()
  const lockFile = path.join(s.dir, 'lock'); fs.writeFileSync(lockFile, '')
  const asked = []; const t = procTable({})
  const world = { socketPath: null, request: async (q) => { asked.push(q.path); return s.sys.daemon.request(q) }, alive: t.alive, identity: t.identity, kill: t.kill, ...fakeClock() }
  const r = await s.off({ deps: world })
  assert.equal(r.exit, 1)
  assert.match(r.receipt.problems[0], /not valid JSON.*whether a daemon runs is not known \(no control socket path is known to ask: XDG_RUNTIME_DIR is not set\)/)
  assert.ok(r.receipt.problems[0].includes(`delete ${lockFile} and run asight off again`), 'it names the file, and what to do once no daemon runs')
  assert.deepEqual([s.userFiles(), t.sent, asked], [before, [], []], 'no entry touched, nobody signalled, nobody asked')
  fs.rmSync(lockFile) // as it says
  const followed = await s.off({ deps: world })
  assert.equal(followed.exit, 0, JSON.stringify(followed.receipt.problems))
  assert.ok(!fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8').includes('asight'))
})

test('R12: an off that cannot get the op lock in time has written desired off first and says which command holds it; nothing else is touched, exit 1', async () => {
  const s = await installedHome({ names: ['claude-code'] }); const before = s.userFiles()
  fs.writeFileSync(path.join(s.dir, 'op.lock'), JSON.stringify({ pid: 5555, start_time: '9', boot_id: 'boot-1' }))
  const r = await s.off({ deps: { lockWaitMs: 40, alive: (pid) => pid === 5555, identity: (pid) => (pid === 5555 ? { start_time: '9', boot_id: 'boot-1' } : { start_time: null, boot_id: null }) } })
  assert.equal(r.exit, 1); assert.match(r.receipt.problems[0], /another asight command \(pid 5555\) holds .*already off for every harness/)
  assert.equal(s.state().harnesses['claude-code'].desired, 'off', 'desired off was written before the wait')
  assert.deepEqual(s.userFiles(), before)
  assert.deepEqual(s.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), [])
  assert.equal(flowEvents(s.dir).at(-1).outcome, 'failed')
  assert.equal(fs.readFileSync(path.join(s.dir, 'op.lock'), 'utf8').includes('5555'), true, 'the holder\'s lock is not ours to remove')
})

test('V27: over on, off and a daemon that has to be stopped, nothing restarts an agent — no signal goes to a pid that is not the daemon or its helper, no systemctl restart; the agents that may still trust asight are only listed', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] }); writeDaemonLock(s)
  const t = procTable({ ...DAEMON_ROWS, 5000: { start_time: '5', boot_id: 'boot-1' }, 5001: { start_time: '6', boot_id: 'boot-1' } }, { survives: { 4242: ['SIGTERM'] } })
  const agents = [
    { pid: 5000, ppid: 1, uid: 1000, startedAt: Date.now() + 5000, exe: '/home/u/.local/share/claude/versions/2.1.289', argv: ['claude'], env: () => new Map() },
    { pid: 5001, ppid: 1, uid: 1000, startedAt: Date.now() + 5000, exe: '/home/u/.local/bin/codex', argv: ['codex'], env: () => new Map() },
    { pid: 7001, ppid: 1, uid: 1000, startedAt: 1, exe: '/usr/bin/node', argv: ['node', '/repo/bin/asight.mjs', 'serve', '--port', '9000'], env: () => new Map() },
    { pid: 7002, ppid: 1, uid: 1000, startedAt: 1, exe: '/usr/bin/node', argv: ['node', '/repo/bin/asight.mjs', 'capture'], env: () => new Map() },
    { pid: 7003, ppid: 1, uid: 1000, startedAt: 1, exe: '/usr/bin/node', argv: ['node', '/repo/bin/asight.mjs', 'etl'], env: () => new Map() },
  ]
  const procs = async () => agents
  const calls = s.sys.exec.calls.length
  // the `on` leg (installedHome has run it): all the OS tools it ran are the unit's `enable --now` — no restart, no stop, no signal — and all it asked of the daemon is its status and to attach the harnesses
  assert.deepEqual(s.sys.exec.calls.slice(0, calls), ['systemctl --user enable --now asight-collector.service'], 'on starts the daemon (a start is not a restart) and touches no agent')
  assert.deepEqual(s.sys.daemon.calls.map((c) => c.split(' {')[0]), ['GET /status', 'GET /status', 'POST /on'], 'on asks the daemon for its status and attaches the harnesses: nothing else')
  const r = await s.off({ deps: { procs, request: hangsOnStatus(s), alive: (pid) => t.alive(pid) || agents.some((a) => a.pid === pid), identity: t.identity, kill: t.kill, isHelper: t.isHelper, ...fakeClock() } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.ok(t.sent.every(([pid]) => pid === 4242 || pid === 4243), `signals went to the daemon and its helper only: ${JSON.stringify(t.sent)}`)
  assert.ok(execFrom(s, calls).every((c) => !/restart/.test(c)), 'no systemctl restart')
  assert.deepEqual(r.receipt.still_trusting.map((p) => p.pid).sort(), [5000, 5001], 'the agents that may still trust asight are reported')
  assert.deepEqual(r.receipt.restart, [], 'and off never lists anything to restart as a to-do of its own')
  assert.deepEqual(r.receipt.user_processes, [{ pid: 7001, command: 'asight serve', note: '只读看板,不在 agent 路径上' }, { pid: 7002, command: 'asight capture', note: '前台采集,可能正中转 agent 的流量' }], 'what the user started themselves is listed, never killed')
})

test('D38: every line off writes to flows/ is in the closed sets, every run of off ends with a result line, and a clean off writes the desired state, the routing and the autostart', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  fs.appendFileSync(path.join(s.home, '.codex', '.env'), 'EXTRA=1\n') // an edit after install: a note with a code
  const r = await s.off({ deps: { procs: async () => [{ pid: 5001, ppid: 1, uid: 1000, startedAt: Date.now() + 5000, exe: '/home/u/.local/bin/codex', argv: ['codex'], env: () => new Map() }] } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  const mine = flowEvents(s.dir).filter((e) => e.where === 'off')
  assert.ok(mine.length >= 5)
  for (const e of flowEvents(s.dir)) assert.deepEqual(checkRecord(e), [], JSON.stringify(e))
  assert.deepEqual(new Set(mine.map((e) => e.run)).size, 1, 'one run, one `run`')
  assert.deepEqual(mine.map((e) => e.kind).filter(Boolean).slice(0, 3), ['desired-off', 'routing', 'reverted-not-identical'])
  assert.ok(mine.some((e) => e.kind === 'autostart'))
  assert.ok(mine.some((e) => e.code === 'backup-kept') && mine.some((e) => e.code === 'reverted-not-identical') && mine.some((e) => e.code === 'still-trusting'))
  const last = mine.at(-1)
  assert.deepEqual([last.event, last.kind, last.outcome], ['off-note', 'result', 'off'])
})

test('V24: with the install manifest gone and no terminal, off takes the routing off, stops the daemon and leaves the files alone, lists what it found by asight\'s marks, exits 1 with outcome partial; with --yes it undoes them by those marks (undone-by-marker): the commented user line is back, the JSON value comes back from the backup', async () => {
  const codexOriginal = 'SSL_CERT_FILE=/corp/ca.pem\nOPENAI_API_KEY=sk-test\n'
  const s = await installedHome({ names: ['claude-code', 'codex'], seed: (home, sh) => {
    fs.writeFileSync(path.join(home, '.codex', '.env'), codexOriginal)
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `{\n  "env": { "NODE_EXTRA_CA_CERTS": "${sh.corp}" }\n}\n`)
  } })
  const settings = path.join(s.home, '.claude', 'settings.json'), codexEnv = path.join(s.home, '.codex', '.env')
  const settingsOriginal = `{\n  "env": { "NODE_EXTRA_CA_CERTS": "${s.sh.corp}" }\n}\n`
  assert.match(fs.readFileSync(codexEnv, 'utf8'), /#asight-collector-off# SSL_CERT_FILE=\/corp\/ca\.pem/, 'install put the user line out of effect with the sentinel prefix')
  fs.rmSync(path.join(s.dir, 'install-manifest.json'))
  const installed = s.userFiles()
  const first = await s.off({ yes: false, interactive: false })
  assert.equal(first.exit, 1)
  assert.deepEqual(validateReceipt(first.receipt), [])
  assert.deepEqual(s.userFiles(), installed, 'the files are byte for byte what they were: nothing is changed without a yes')
  assert.deepEqual(first.receipt.pending.map((p) => [path.relative(s.home, p.path), p.how]).sort(), [['.claude/settings.json', 'json-value'], ['.codex/.env', 'block']])
  assert.match(first.receipt.problems.join('\n'), /manifest is missing.*asight off --yes/)
  assert.deepEqual(Object.values(s.state().harnesses).map((h) => h.desired), ['off', 'off'], 'desired off for every harness')
  assert.deepEqual([first.receipt.routing.confirmed, s.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), first.receipt.autostart.disabled], [true, ['POST /off {"exit":true}'], true], 'the routing is off, the daemon was asked to exit, the autostart is disabled — none of it needs the manifest')
  assert.deepEqual([flowEvents(s.dir).at(-1).kind, flowEvents(s.dir).at(-1).outcome], ['result', 'partial'])
  const second = await s.off({ yes: true })
  assert.equal(second.exit, 0, JSON.stringify(second.receipt.problems))
  assert.equal(second.receipt.undone_by_marker, true)
  assert.equal(fs.readFileSync(codexEnv, 'utf8'), codexOriginal, 'the block is out and the commented user line is back')
  assert.equal(fs.readFileSync(settings, 'utf8'), settingsOriginal, 'the JSON value is back, taken from the backup, this key only')
  assert.deepEqual(flowEvents(s.dir).filter((e) => e.code === 'undone-by-marker').length, 2, 'one note per file, each with the code')
  assert.equal(flowEvents(s.dir).at(-1).outcome, 'undone-by-marker')
  const asked = fakeAsk(); const third = await s.off({ interactive: true, io: asked.io, say: asked.say }) // nothing left to find: no question
  assert.deepEqual([third.exit, asked.said.length], [0, 0])
})

// a terminal that types `answer` to the one question (src/off/io.mjs confirm reads a line from stdin and prints the question to io.prompt || io.stdout)
function fakeAsk(answer = 'y') {
  const said = [], printed = []
  const listeners = {}
  const stdin = { isTTY: true, on: (e, f) => { listeners[e] = f }, removeListener: () => {}, pause: () => {}, resume: () => {} }
  const stdout = { isTTY: true, write: (t) => { printed.push(t); if (/\[y\/N\] $/.test(t)) setImmediate(() => listeners.data && listeners.data(`${answer}\n`)) } }
  return { io: { stdin, stdout, out: (t) => said.push(t), err: (t) => said.push(t) }, said, printed, say: (t) => said.push(t) }
}

test('V24 (terminal): the list is printed and ONE question asked; yes undoes by the marks, no leaves every file as it is (exit 1, partial)', async () => {
  const make = async () => { const s = await installedHome({ names: ['codex'] }); fs.rmSync(path.join(s.dir, 'install-manifest.json')); return s }
  const no = await make(); const before = no.userFiles(); const asked = fakeAsk('n')
  const declined = await no.off({ interactive: true, io: asked.io, say: asked.say })
  assert.deepEqual([declined.exit, no.userFiles(), asked.printed.filter((t) => /\[y\/N\]/.test(t)).length], [1, before, 1])
  assert.match(asked.said.join('\n'), /\.codex\/\.env|\.codex[\\/]\.env/)
  const yes = await make(); const asked2 = fakeAsk('y')
  const done = await yes.off({ interactive: true, io: asked2.io, say: asked2.say })
  assert.deepEqual([done.exit, done.receipt.undone_by_marker, /asight collector/.test(fs.readFileSync(path.join(yes.home, '.codex', '.env'), 'utf8'))], [0, true, false])
})

test('R3: a manifest this build does not read (a newer version) leaves every entry alone, says so, exits 1 — the routing is still taken off; an unreadable manifest falls back to the marks', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  const manifestFile = path.join(s.dir, 'install-manifest.json')
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); m.version = 99
  fs.writeFileSync(manifestFile, JSON.stringify(m)); const before = s.userFiles()
  const r = await s.off()
  assert.equal(r.exit, 1); assert.match(r.receipt.problems.join('\n'), /version 99.*no entry was touched/)
  assert.deepEqual([s.userFiles(), r.receipt.routing.confirmed], [before, true])
  assert.equal(flowEvents(s.dir).at(-1).outcome, 'left')
  fs.writeFileSync(manifestFile, '{ not json')
  const garbled = await s.off({ yes: true })
  assert.equal(garbled.exit, 0, JSON.stringify(garbled.receipt.problems)); assert.match(garbled.receipt.notes.join('\n'), /manifest cannot be read/)
  assert.ok(!fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8').includes('asight'), 'undone by the marks')
})

test('V34: an off that lands while `on` is writing wins — `on` exits 1, saying it was turned off; at the end desired is off, no entry is left in the manifest, the files are as they were, and the daemon is told to switch off', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  await s.off() // back to nothing installed by on: the second on below is the race
  const before = s.userFiles(); const codexEnv = path.join(s.home, '.codex', '.env')
  let offRun = null
  const racing = { ...fs, renameSync: (a, b) => { if (b === codexEnv && !offRun) offRun = s.off(); return fs.renameSync(a, b) } } // `off` starts when `on` is about to write the second user file
  const on = await s.on({ fs: racing })
  const off = await offRun
  assert.equal(on.exit, 1, JSON.stringify(on.receipt.notes))
  assert.match(on.receipt.notes.join('\n'), /turned off while this on ran.*the off wins/)
  assert.equal(off.exit, 0, JSON.stringify(off.receipt.problems))
  assert.deepEqual(Object.values(s.state().harnesses).map((h) => h.desired), ['off', 'off'], 'the final desired state is off')
  assert.deepEqual(readManifest(s.dir).entries, [], 'no entry is left')
  assert.deepEqual(s.userFiles(), before, 'and the user\'s files are as they were')
  assert.deepEqual([...s.sys.daemon.state.on], [], 'nothing is attached')
  assert.ok(!fs.existsSync(path.join(s.dir, 'op.lock')), 'both released the lock')
})

test('V34: whichever write of `on` the off lands in, the end is the same — off wins: desired off, no entry left, user files as before, no lock left; `on` exits 1 for every write before the last guard', async () => {
  const count = await installedHome({ names: ['claude-code', 'codex'] })
  await count.off()
  let writes = 0
  await count.on({ fs: { ...fs, renameSync: (a, b) => { writes++; return fs.renameSync(a, b) } } })
  assert.ok(writes >= 8, `a first on has ${writes} writes: the loop below has something to cut`)
  const exits = []
  for (let k = 1; k <= writes; k++) {
    const s = await installedHome({ names: ['claude-code', 'codex'] })
    await s.off()
    const before = s.userFiles(); let n = 0, offRun = null
    const on = await s.on({ fs: { ...fs, renameSync: (a, b) => { if (++n === k && !offRun) offRun = s.off(); return fs.renameSync(a, b) } } })
    const off = await offRun
    exits.push(on.exit)
    assert.equal(off.exit, 0, `write ${k}: ${JSON.stringify(off.receipt.problems)}`)
    assert.deepEqual(Object.values(s.state().harnesses).map((h) => h.desired), ['off', 'off'], `write ${k}: the final desired state is off`)
    assert.deepEqual([readManifest(s.dir).entries, s.userFiles(), fs.existsSync(path.join(s.dir, 'op.lock')), [...s.sys.daemon.state.on]], [[], before, false, []], `write ${k}`)
  }
  assert.ok(exits.filter((x) => x === 1).length >= writes - 3, `on stopped for nearly every write: ${exits.join('')}`)
})

test('V8: backups — 0700 / 0600; a file back at its pre_sha256 loses its backup; one the user edited after asight keeps it, listed in kept_backups and as a backup-kept event; the next on does not write over the kept one; a file restored by hand before off ("already restored") loses its backup', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] })
  const backupDir = path.join(s.home, '.asight', 'backup')
  assert.equal(fs.statSync(backupDir).mode & 0o777, 0o700)
  const entries = s.manifest().entries; const by = Object.fromEntries(entries.map((e) => [e.harness, e]))
  for (const e of entries) { assert.ok(fs.existsSync(e.backup), `${e.harness} has a backup`); assert.equal(fs.statSync(e.backup).mode & 0o777, 0o600) }
  fs.appendFileSync(by.codex.path, 'EXTRA=1\n') // edited after asight changed it
  const r = await s.off()
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.ok(!fs.existsSync(by['claude-code'].backup), 'untouched since: back at its pre_sha256, so its backup is gone')
  assert.deepEqual(r.receipt.changed.map((c) => [c.harness, c.result, c.backup, c.backup_dropped ?? false]).sort(), [['claude-code', 'restored', null, true], ['codex', 'reverted-not-identical', by.codex.backup, false]])
  assert.ok(fs.existsSync(by.codex.backup), 'the edited file\'s backup stays')
  assert.equal(fs.readFileSync(by.codex.path, 'utf8'), 'OPENAI_API_KEY=sk-test\nEXTRA=1\n', 'only asight\'s part went; the user\'s line stays')
  assert.deepEqual(r.receipt.kept_backups.map((k) => [k.path, k.backup]), [[by.codex.path, by.codex.backup]])
  assert.deepEqual(readManifest(s.dir).kept_backups.map((k) => [k.path, k.backup]), [[by.codex.path, by.codex.backup]], 'and in the manifest')
  assert.ok(flowEvents(s.dir).some((e) => e.code === 'backup-kept' && e.path === by.codex.path), 'the event is written')
  const kept = fs.readFileSync(by.codex.backup, 'utf8'), keptMtime = fs.statSync(by.codex.backup).mtimeMs
  const on = await s.on()
  assert.equal(on.exit, 0, JSON.stringify(on.receipt.notes))
  assert.deepEqual([fs.readFileSync(by.codex.backup, 'utf8'), fs.statSync(by.codex.backup).mtimeMs], [kept, keptMtime], 'a second on does not write over the kept backup')
  const fresh = readManifest(s.dir).entries.find((e) => e.harness === 'codex')
  assert.notEqual(fresh.backup, by.codex.backup, 'it makes a new one for its own change')
  // "already restored": the user put the file back by hand (from the backup) before off ran
  fs.copyFileSync(fresh.backup, fresh.path)
  const again = await s.off({ ids: ['codex'] })
  assert.equal(again.exit, 0, JSON.stringify(again.receipt.problems))
  assert.ok(!fs.existsSync(fresh.backup), 'the file was already back as it was: its backup is deleted')
  assert.deepEqual(again.receipt.skipped.map((x) => x.reason), ['早已是安装前的样子'])
})

test('R12: while `on` holds the op lock (it waits for its daemon to come up) an off writes desired off at once but touches no entry until `on` has let go — and `on` sees the off within a poll instead of after fifteen seconds', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  await s.off() // everything off; the next on is a re-on, which waits for a daemon that never comes
  const never = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }
  const settings = path.join(s.home, '.claude', 'settings.json')
  let offRun = null, pauses = 0, meanwhile = null
  const sleep = async () => {
    if (++pauses !== 2) return
    offRun = s.off({ deps: { request: never } })
    await new Promise((resolve) => setTimeout(resolve, 60)) // off's turn: it can only wait
    meanwhile = { entry: fs.readFileSync(settings, 'utf8').includes('NODE_EXTRA_CA_CERTS'), desired: s.state().harnesses['claude-code'].desired, lock: fs.existsSync(path.join(s.dir, 'op.lock')) }
  }
  const on = await s.on({ request: never, sleep })
  assert.deepEqual(meanwhile, { entry: true, desired: 'off', lock: true }, 'on had written its entry and holds the lock; off had already written desired off and had not touched the entry')
  assert.equal(on.exit, 1); assert.match(on.receipt.notes.join('\n'), /turned off while this on ran/)
  assert.ok(pauses < 8, `on stopped at its next poll (${pauses} pauses), not after 60`)
  const off = await offRun
  assert.equal(off.exit, 0, JSON.stringify(off.receipt.problems))
  assert.ok(!fs.readFileSync(settings, 'utf8').includes('NODE_EXTRA_CA_CERTS'), 'and then the entry is out')
})
