// test/cli/on.test.mjs — `asight on` as a resumable, idempotent install (RFC 1.6 R9, R12, §1.1, §1.6): a crash at any write is finished by the next on, every entry
// that exists points at a bundle that is valid at every one of those points, a second on rewrites nothing, and what the operator changed in between is
// reported and left. Real descriptors in a sandbox HOME (the fixture of the `off` tests), OS tools and the control socket injected (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { turnOn } from '../../src/collector/install.mjs'
import { userUnit } from '../../src/collector/arch/linux/unit.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { readStateFile, setDesired, writeStateAtomic } from '../../src/off/state.mjs'
import { certBlocks } from '../../src/off/pem.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { sevenHomes } from '../off/fixtures/seven-homes.mjs'
import { snapshot, fakeSystem, recordingExec, fakeDaemon, ROOTS } from './fixtures/on-ctx.mjs'

const NAMES = ['claude-code', 'codex', 'opencode', 'deepseek-dsh'] // a JSON key, a dotenv block that names a combined bundle, a plugin file, a YAML row and a plugin directory
const descs = (await loadHarnesses()).filter((d) => NAMES.includes(d.name))
const SOCK = '/x/collector.sock'

// a sandbox HOME with the user's files of the seven-homes fixture, and everything a run needs; `run` is one `asight on`
function sandbox() {
  const home = tmpDir('asight-on-')
  const sh = sevenHomes(home)
  const dir = path.join(home, '.asight', 'collector')
  const sys = fakeSystem()
  const unit = (script = '/repo/bin/asight.mjs') => userUnit({ home, node: '/usr/bin/node', script, run: sys.exec.run })
  const run = (o = {}) => turnOn({ home, env: sh.env, osName: 'linux', harnesses: descs, freePort: async () => 47011, roots: ROOTS, confirm: async () => true, unit: unit(), request: sys.daemon.request, socketPath: SOCK, sleep: async () => {}, linger: () => true, user: 'alice', ...o })
  return { home, sh, dir, sys, run, unit }
}
const asightOnly = (rel) => rel.startsWith('.asight') || rel.startsWith(path.join('.config', 'systemd'))
const userView = (home) => Object.fromEntries(Object.entries(snapshot(home)).filter(([rel]) => !asightOnly(rel)))

// every dotenv block / settings key of an entry asight wrote that names a combined bundle must name one that exists and holds the roots (R9)
function bundlesAreValid(s) {
  const env = path.join(s.home, '.codex', '.env')
  if (!fs.existsSync(env)) return []
  const m = /^SSL_CERT_FILE=(.+)$/m.exec(fs.readFileSync(env, 'utf8').split('# <<<')[0]) // inside asight's block (the block is at the top)
  if (!m || !fs.readFileSync(env, 'utf8').includes('# >>> asight collector')) return []
  const bundle = m[1].trim()
  assert.ok(fs.existsSync(bundle), `the entry names ${bundle}, which does not exist`)
  const roots = certBlocks(fs.readFileSync(bundle, 'utf8')).map((b) => b.fp)
  for (const r of ROOTS.node) assert.ok(roots.includes(certBlocks(r)[0].fp), 'the bundle holds the Node roots')
  return [bundle]
}
const entryStats = (s) => readManifest(s.dir).entries.map((e) => ({ path: e.path, installed_at: e.installed_at, ino: fs.statSync(e.real_path || e.path).ino, mtimeMs: fs.statSync(e.real_path || e.path).mtimeMs }))

test('R9: a crash at every one of the writes of a first on is finished by the next on; at every point an entry that exists points at a valid bundle; the user files come back byte for byte', async () => {
  const counter = sandbox()
  let writes = 0
  const count = { ...fs, renameSync: (a, b) => { writes++; return fs.renameSync(a, b) } }
  assert.equal((await counter.run({ fs: count })).exit, 0)
  assert.ok(writes >= 20, `the clean run has ${writes} writes: the loop below has something to cut`)
  for (let k = 1; k <= writes; k++) {
    const s = sandbox()
    const before = userView(s.home)
    let i = 0
    const crashing = { ...fs, renameSync: (a, b) => { if (++i === k) throw Object.assign(new Error(`crash at write ${k}`), { code: 'ECRASH' }); return fs.renameSync(a, b) } }
    await assert.rejects(s.run({ fs: crashing }), /crash at write/, `write ${k} of ${writes}`)
    bundlesAreValid(s)
    const done = await s.run()
    assert.equal(done.exit, 0, `after a crash at write ${k}: ${JSON.stringify(done.receipt.notes)}`)
    assert.deepEqual(validateReceipt(done.receipt), [])
    const m = readManifest(s.dir)
    assert.equal(m.complete, true, `complete after resuming write ${k}`)
    assert.deepEqual([...new Set([...m.entries, ...m.files].map((x) => x.harness).filter(Boolean))].sort(), [...NAMES].sort(), `every harness has an entry or a file after resuming write ${k}`)
    assert.equal(m.entries.every((e) => e.post_sha256 != null), true, 'every entry is finished')
    assert.equal(bundlesAreValid(s).length, 1, 'codex\'s entry points at a bundle that holds the roots')
    // idempotent: a third on writes nothing
    const stat = entryStats(s); const manifestBytes = fs.readFileSync(path.join(s.dir, 'install-manifest.json'), 'utf8'); const state = fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8')
    const again = await s.run()
    assert.deepEqual([again.exit, again.receipt.changed, again.receipt.created], [0, [], []], `a second on after resuming write ${k} changes nothing`)
    assert.deepEqual(entryStats(s), stat, 'installed_at, inode and mtime of every entry are as they were')
    assert.equal(fs.readFileSync(path.join(s.dir, 'install-manifest.json'), 'utf8'), manifestBytes, 'the manifest is not rewritten')
    assert.equal(fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8'), state, 'nor the desired state')
    // and off takes everything out, whichever way it got in
    const out = await undoHarnesses({ dir: s.dir, home: s.home, manifest: readManifest(s.dir), ids: null, procs: async () => [], roots: ROOTS })
    assert.deepEqual(out.left, [], `off leaves nothing after resuming write ${k}`)
    assert.deepEqual(userView(s.home), before, `the user's files are byte for byte what they were, after a crash at write ${k}`)
  }
})

test('R9: a second on on a complete install leaves installed_at, inode and mtime of every entry unchanged, rewrites neither the manifest nor the state, and says what it left alone', async () => {
  const s = sandbox()
  const first = await s.run()
  assert.equal(first.exit, 0)
  assert.ok(first.receipt.changed.length >= 3 && first.receipt.changed.every((c) => c.change.length > 0))
  const stat = entryStats(s); const mtime = (f) => fs.statSync(f).mtimeMs
  const files = [path.join(s.dir, 'install-manifest.json'), path.join(s.dir, 'state.json'), ...readManifest(s.dir).files.map((f) => f.path)]
  const marks = files.map((f) => [f, fs.statSync(f).ino, mtime(f)])
  await new Promise((r) => setTimeout(r, 25)) // a write now would show in mtime
  const again = await s.run()
  assert.deepEqual([again.exit, again.receipt.changed, again.receipt.created, again.receipt.ok], [0, [], [], true])
  assert.ok(again.receipt.unchanged.length >= 4, 'it names what it left alone')
  assert.deepEqual(entryStats(s), stat)
  assert.deepEqual(files.map((f) => [f, fs.statSync(f).ino, mtime(f)]), marks, 'no file of asight was written again either')
  assert.equal(s.sys.daemon.calls.filter((c) => c.startsWith('POST /on')).length, 2, 'each on still asks the daemon to attach (it is idempotent there)')
  const enables = s.sys.exec.calls.filter((c) => /enable/.test(c))
  assert.deepEqual(enables, ['systemctl --user enable --now asight-collector.service', 'systemctl --user enable asight-collector.service'], 'a daemon already answering is never started again, only kept enabled (拉起不是重启)')
})

test('R9: an entry the operator changed after asight wrote it is reported and left; on never overwrites it, and off then on writes it again', async () => {
  const s = sandbox()
  await s.run()
  const settings = path.join(s.home, '.claude', 'settings.json')
  const mine = '{ "model": "mine", "env": { "NODE_EXTRA_CA_CERTS": "/my/own-ca.pem" } }\n'
  fs.writeFileSync(settings, mine) // the user's own value in place of asight's
  const r = await s.run()
  assert.equal(fs.readFileSync(settings, 'utf8'), mine, 'left as the user has it')
  assert.deepEqual([r.exit, r.receipt.ok], [1, false], 'an entry that is not in effect is not "done"')
  assert.match(JSON.stringify(r.receipt.skipped), /settings\.json[\s\S]*asight off[\s\S]*asight on/, 'the receipt says which file and what to do')
  // off takes asight's part out (there is none left: the user's own value stays), and on writes the entry again
  const out = await undoHarnesses({ dir: s.dir, home: s.home, manifest: readManifest(s.dir), ids: ['claude-code'], procs: async () => [], roots: ROOTS })
  assert.deepEqual(out.results.map((x) => x.result), ['left-user-value'])
  const back = await s.run()
  assert.equal(back.exit, 0)
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).env.NODE_EXTRA_CA_CERTS, path.join(s.dir, 'ca', 'extra-cc.pem'), 'asight\'s entry again — now through the merge path, since a CA of the user\'s is named in the file')
})

test('R9: an edit of the settings file elsewhere (Claude Code rewrites it) is not a change to the entry: it stays intact and is not written again', async () => {
  const s = sandbox()
  await s.run()
  const settings = path.join(s.home, '.claude', 'settings.json')
  const doc = JSON.parse(fs.readFileSync(settings, 'utf8')); doc.theme = 'dark'
  fs.writeFileSync(settings, JSON.stringify(doc, null, 2) + '\n')
  const stat = entryStats(s).find((e) => e.path === settings)
  const r = await s.run()
  assert.deepEqual([r.exit, r.receipt.changed, r.receipt.skipped], [0, [], []])
  assert.deepEqual(entryStats(s).find((e) => e.path === settings), stat, 'installed_at is when asight wrote it, not when the file was last edited')
})

test('R9: on after off writes the entries again with a new installed_at; a bundle off kept without the CA for a live process gets the CA back and loses its without_ca mark (4.6 「合并包」)', async () => {
  const s = sandbox()
  await s.run()
  const bundle = path.join(s.dir, 'ca', 'combined-codex.pem')
  const caFp = certBlocks(fs.readFileSync(path.join(s.dir, 'ca', 'asight-ca.pem'), 'utf8'))[0].fp
  assert.ok(certBlocks(fs.readFileSync(bundle, 'utf8')).some((b) => b.fp === caFp))
  const was = readManifest(s.dir).entries.find((e) => e.harness === 'codex').installed_at
  const codex = { pid: 4242, exe: '/home/u/.local/bin/codex', argv: ['codex'], startedAt: Date.now() + 5000, env: () => new Map() } // started after install: it may have loaded the bundle
  const out = await undoHarnesses({ dir: s.dir, home: s.home, manifest: readManifest(s.dir), ids: ['codex'], procs: async () => [codex], roots: ROOTS })
  assert.deepEqual(out.kept_bundles.map((k) => k.pids), [[4242]])
  assert.equal(readManifest(s.dir).files.find((f) => f.path === bundle).without_ca, true)
  await new Promise((r) => setTimeout(r, 15))
  const r = await s.run()
  assert.equal(r.exit, 0)
  const m = readManifest(s.dir)
  assert.equal(m.files.find((f) => f.path === bundle).without_ca, undefined, 'the mark is gone')
  assert.ok(certBlocks(fs.readFileSync(bundle, 'utf8')).some((b) => b.fp === caFp), 'the CA is back in the bundle')
  assert.ok(m.entries.find((e) => e.harness === 'codex').installed_at > was, 'a new installed_at: processes started since are judged against it')
  assert.equal(bundlesAreValid(s).length, 1)
})

test('R9: a manifest an older asight wrote has no liveness for some harness: on adds it, only the missing, and leaves the ones that are there', async () => {
  const s = sandbox()
  await s.run()
  const file = path.join(s.dir, 'install-manifest.json')
  const m = JSON.parse(fs.readFileSync(file, 'utf8'))
  m.liveness['claude-code'].until = 'session-end' // a value only a hand could have put there: it must survive
  delete m.liveness.codex
  fs.writeFileSync(file, JSON.stringify(m, null, 2))
  assert.equal((await s.run()).exit, 0)
  const after = readManifest(s.dir).liveness
  assert.equal(after['claude-code'].until, 'session-end')
  assert.ok(after.codex && typeof after.codex.rereads === 'boolean', 'codex has its record again')
})

test('R9: the unit file is written again when what it would say changed (the repo moved); a daemon-reload comes first, and the unit is enabled', async () => {
  const s = sandbox()
  await s.run()
  const unitFile = path.join(s.home, '.config', 'systemd', 'user', 'asight-collector.service')
  assert.match(fs.readFileSync(unitFile, 'utf8'), /"\/repo\/bin\/asight\.mjs" collector start/)
  s.sys.exec.calls.length = 0
  const r = await s.run({ unit: s.unit('/moved/bin/asight.mjs') })
  assert.equal(r.exit, 0)
  assert.match(fs.readFileSync(unitFile, 'utf8'), /"\/moved\/bin\/asight\.mjs" collector start/)
  assert.deepEqual(s.sys.exec.calls.slice(0, 2), ['systemctl --user daemon-reload', 'systemctl --user enable asight-collector.service'])
  assert.deepEqual(r.receipt.created.filter((p) => p === unitFile), [unitFile])
})

test('R12: on reads state.json before each write and stops, exit 1, when it says off for a harness it is turning on; what it wrote is a resumable install', async () => {
  const s = sandbox()
  let writes = 0
  const stateFile = path.join(s.dir, 'state.json')
  const racing = { ...fs, renameSync: (a, b) => {
    if (++writes === 12) { // an `off` lands between two writes of this on
      const { state } = readStateFile(stateFile); writeStateAtomic(stateFile, setDesired(state, ['codex'], 'off', new Date()))
    }
    return fs.renameSync(a, b)
  } }
  const r = await s.run({ fs: racing })
  assert.deepEqual([r.exit, r.receipt.ok], [1, false])
  assert.match(r.receipt.notes.join('\n'), /codex was turned off while this on ran[\s\S]*the off wins/)
  assert.equal(readStateFile(stateFile).state.harnesses.codex.desired, 'off', 'the on does not turn it back on')
  assert.equal(s.sys.daemon.calls.filter((c) => c.startsWith('POST /on')).length, 0, 'and attaches nothing')
  const m = readManifest(s.dir)
  assert.notEqual(m.complete, true, 'the install is not complete')
  assert.ok(m.entries.some((e) => e.post_sha256 != null) || m.files.length > 0, 'part of it is written')
  const flows = fs.readdirSync(path.join(s.dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(s.dir, 'flows', n), 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
  assert.ok(flows.some((f) => f.event === 'failure' && /turned off while this on ran/.test(f.reason)), 'the stop is recorded (D38)')
  assert.equal(flows.at(-1).kind, 'result')
})

test('on: with no daemon answering and no unit (--no-unit) it writes everything, exits 0 and says how to start the daemon; with a unit it starts one (--no-autostart: start only, never enable)', async () => {
  const s = sandbox()
  const down = fakeDaemon({ up: false })
  const bare = await s.run({ unit: null, request: down.request })
  assert.deepEqual([bare.exit, bare.receipt.daemon.state, bare.receipt.unit], [0, 'not-running', null])
  assert.match(bare.receipt.notes.join('\n'), /asight collector start/)
  assert.deepEqual(s.sys.exec.calls, [], 'no unit: no systemctl at all')
  assert.ok(!fs.existsSync(path.join(s.home, '.config', 'systemd')), 'and no unit file')
  assert.deepEqual(readManifest(s.dir).files.filter((f) => f.role === 'unit'), [])

  const t = sandbox()
  const sys = fakeSystem()
  const r = await t.run({ unit: userUnit({ home: t.home, node: '/usr/bin/node', script: '/repo/bin/asight.mjs', run: sys.exec.run }), request: sys.daemon.request, autostart: false })
  assert.equal(r.exit, 0)
  assert.deepEqual(sys.exec.calls, ['systemctl --user start asight-collector.service'], 'started for this run, not enabled')
  assert.deepEqual([r.receipt.daemon.state, r.receipt.daemon.started, r.receipt.unit.enabled], ['running', true, false])
})

test('on: a unit systemd refuses to enable, a daemon that never answers, a kernel that does not confirm — each exit 1 with the reason, recorded; the attach is not asked when the unit failed', async () => {
  const refused = sandbox()
  const sys = fakeSystem()
  const ex = recordingExec({ fail: (cmd) => (/enable/.test(cmd) ? { status: 1, stderr: 'Failed to connect to bus' } : null) })
  let r = await refused.run({ unit: userUnit({ home: refused.home, node: '/n', script: '/s', run: ex.run }), request: sys.daemon.request })
  assert.equal(r.exit, 1); assert.match(r.receipt.notes.join('\n'), /"systemctl --user enable --now" failed \(Failed to connect to bus\)/)
  assert.equal(readManifest(refused.dir).complete, true, 'the install itself is complete; only the autostart is not')

  const silent = sandbox(); const dead = fakeDaemon({ up: false })
  r = await silent.run({ request: dead.request })
  assert.equal(r.exit, 1); assert.match(r.receipt.notes.join('\n'), /no daemon answers on \/x\/collector\.sock/)

  const noKernel = sandbox(); const sys2 = fakeSystem({ actual: 'off' })
  r = await noKernel.run({ unit: userUnit({ home: noKernel.home, node: '/n', script: '/s', run: sys2.exec.run }), request: sys2.daemon.request })
  assert.equal(r.exit, 1); assert.match(r.receipt.notes.join('\n'), /the kernel does not confirm the links/)
  const flows = fs.readdirSync(path.join(noKernel.dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(noKernel.dir, 'flows', n), 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
  assert.ok(flows.some((f) => f.event === 'failure' && f.where === 'switch'), 'recorded where the board looks (D38)')
})

test('on: the processes the daemon says are not captured yet are the restart list (config-after-start, env-frozen, no-marker, kimi-not-via-shim), by pid and harness; trusted ones and the other harnesses\' are not', async () => {
  const s = sandbox()
  const sys = fakeSystem({ agents: [
    { pid: 4121, agent: 'claude-code', trusted: false, reason: 'config-after-start' },
    { pid: 4122, agent: 'claude-code', trusted: true, reason: 'ok' },
    { pid: 5530, agent: 'codex', trusted: false, reason: 'env-frozen' },
    { pid: 6001, agent: 'opencode', trusted: false, reason: 'no-marker' },
    { pid: 6002, agent: 'kimi-code', trusted: false, reason: 'kimi-not-via-shim' }, // a harness this on is not turning on
    { pid: 6003, agent: 'codex', trusted: false, reason: 'var-missing' }, // not a restart: the entry is not in effect for another reason
  ] })
  const r = await s.run({ unit: userUnit({ home: s.home, node: '/n', script: '/s', run: sys.exec.run }), request: sys.daemon.request })
  assert.deepEqual(r.receipt.restart.map((x) => [x.harness, x.pid]), [['claude-code', 4121], ['codex', 5530], ['opencode', 6001]])
  assert.deepEqual(validateReceipt(r.receipt), [])
})

test('on: the linger line — false says how to enable it and never runs loginctl, true says nothing, unreadable says 不知道 and never "已开" (1.6 §1.1, V39 on side)', async () => {
  const s = sandbox()
  const r = await s.run({ linger: () => false })
  assert.deepEqual([r.receipt.linger, s.sys.exec.calls.some((c) => /loginctl/.test(c))], [false, false])
  assert.equal((await sandbox().run({ linger: () => true })).receipt.linger, true)
  const u = await sandbox().run({ linger: () => null })
  assert.deepEqual([u.receipt.linger, typeof u.receipt.linger_reason], ['unknown', 'string'])
  assert.equal((await sandbox().run({ linger: () => { throw new Error('EACCES') } })).receipt.linger, 'unknown')
})

test('on: named harnesses only — on codex writes codex\'s files and turns on codex alone; a named harness with nothing to install is skipped with the descriptor\'s reason and is not "done"', async () => {
  const all = await loadHarnesses()
  const s = sandbox(); fs.rmSync(path.join(s.home, '.hermes'), { recursive: true }) // Hermes is not installed here
  const r = await s.run({ ids: ['codex', 'hermes'], harnesses: all })
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8')).env, undefined, 'claude-code is not touched')
  assert.deepEqual(r.receipt.harnesses, ['codex'])
  assert.deepEqual(r.receipt.skipped.map((x) => x.what), ['hermes'])
  assert.match(r.receipt.skipped[0].reason, /\.hermes/, 'with the descriptor\'s own words')
  assert.equal(r.exit, 1, 'a harness that was asked for and could not be done: not done')
  assert.deepEqual(Object.keys(readStateFile(path.join(s.dir, 'state.json')).state.harnesses), ['codex'])
  assert.deepEqual(s.sys.daemon.calls.filter((c) => c.startsWith('POST /on')), ['POST /on {"harnesses":["codex"]}'])
  const t = sandbox(); fs.rmSync(path.join(t.home, '.hermes'), { recursive: true }); const before = snapshot(t.home)
  const none = await t.run({ ids: ['hermes'], harnesses: all })
  assert.deepEqual([none.exit, none.receipt.ok], [1, false])
  assert.deepEqual(snapshot(t.home), before, 'nothing to turn on: nothing written, not even the manifest')
})

test('on: root is refused by the library too (R7), and a missing helper stops it before anything is written', async () => {
  const s = sandbox(); const before = snapshot(s.home)
  await assert.rejects(s.run({ getuid: () => 0 }), /not as root/)
  const r = await s.run({ helperState: () => ({ ok: false, reason: 'no helper' }) })
  assert.deepEqual([r.exit, r.receipt.ok], [1, false]); assert.match(r.receipt.notes.join(' '), /sudo asight setup-helper/)
  assert.deepEqual(snapshot(s.home), before)
})
