// test/cli/on.test.mjs — `asight on` as a resumable, idempotent install (RFC 1.6 R9, R12, §1.1, §1.6): a crash at any write is finished by the next on, every entry
// that exists points at a bundle that is valid at every one of those points, a second on rewrites nothing, and what the operator changed in between is
// reported and left. Real descriptors in a sandbox HOME (the fixture of the `off` tests), OS tools and the control socket injected (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { turnOn, installCollector } from '../../src/collector/install.mjs'
import { userUnit } from '../../src/collector/arch/linux/unit.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { readManifest, PHASES } from '../../src/off/manifest.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { readStateFile, setDesired, writeStateAtomic } from '../../src/off/state.mjs'
import { certBlocks } from '../../src/off/pem.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { sevenHomes } from '../off/fixtures/seven-homes.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { snapshot, fakeSystem, recordingExec, fakeDaemon, fakeIo, onCtx, seedClaude, ROOTS } from './fixtures/on-ctx.mjs'

// a JSON key; the three that replace the system roots and so name a combined bundle (codex and hermes by a dotenv block, z-code by a JSON key); a plugin
// directory and a YAML row
const NAMES = ['claude-code', 'codex', 'hermes', 'z-code', 'opencode', 'deepseek-dsh']
const descs = (await loadHarnesses()).filter((d) => NAMES.includes(d.name))
const SOCK = '/x/collector.sock'

// a sandbox HOME with the user's files of the seven-homes fixture, and everything a run needs; `run` is one `asight on`. D55 / override #15: on never writes a
// certificate, so the sandbox has had `asight install` (installCollector, no unit) unless `installed: false` — then the first `run` installs first, so a crash
// test cuts the install's writes too
async function sandbox({ installed = true } = {}) {
  const home = tmpDir('asight-on-')
  const sh = sevenHomes(home)
  const dir = path.join(home, '.asight', 'collector')
  const sys = fakeSystem()
  const unit = (script = '/repo/bin/asight.mjs') => userUnit({ home, node: '/usr/bin/node', script, run: sys.exec.run, spawn: fakeSpawn(sys.daemon) })
  const opts = (o = {}) => ({ home, env: sh.env, osName: 'linux', harnesses: descs, freePort: async () => 47011, roots: ROOTS, confirm: async () => true, unit: unit(), request: sys.daemon.request, socketPath: SOCK, sleep: async () => {}, linger: () => true, user: 'alice', ...o })
  const install = async (o = {}) => { await installCollector({ ...opts(o), unit: null }); installed = true }
  const run = async (o = {}) => { if (!installed) await install(o); return turnOn(opts(o)) }
  if (installed) await install()
  return { home, sh, dir, sys, run, unit, install }
}
// `unit.start()` (the `--no-autostart` run) really spawns a daemon: every test hands in its own spawn, so no test ever starts one (0.1 §3).
// It brings the given fake daemon up, as a real start does.
function fakeSpawn(daemon = null) {
  const spawn = (exe, args) => { spawn.calls.push([exe, ...args].join(' ')); if (daemon) daemon.state.up = true; return { pid: 4242, unref: () => {}, on: () => {} } }
  spawn.calls = []
  return spawn
}

const asightOnly = (rel) => rel.startsWith('.asight') || rel.startsWith(path.join('.config', 'systemd'))
const userView = (home) => Object.fromEntries(Object.entries(snapshot(home)).filter(([rel]) => !asightOnly(rel)))

// every entry asight wrote that names a combined bundle (the replace-semantics ones: Codex's and Hermes's dotenv block, Z-Code's network.caCertFile) must name
// one that exists and holds the Node roots and the OS roots (R9, V21); read from the user's files as they are at that moment, the manifest may not be saved yet
const bundleNamedIn = {
  codex: (home) => dotenvBundle(path.join(home, '.codex', '.env')),
  hermes: (home) => dotenvBundle(path.join(home, '.hermes', '.env')),
  'z-code': (home) => { try { const v = JSON.parse(fs.readFileSync(path.join(home, '.zcode', 'cli', 'config.json'), 'utf8')).network; return v && v.caCertFile ? v.caCertFile : null } catch { return null } },
}
function dotenvBundle(file) {
  let text; try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  if (!text.includes('# >>> asight collector')) return null // not written yet
  const m = /^SSL_CERT_FILE=(.+)$/m.exec(text.split('# <<<')[0]) // inside asight's block (the block is at the top)
  return m ? m[1].trim() : null
}
function bundlesAreValid(s) {
  const found = []
  for (const [id, named] of Object.entries(bundleNamedIn)) {
    const bundle = named(s.home)
    if (!bundle || !bundle.startsWith(s.dir)) continue // not written yet, or the user's own
    assert.ok(fs.existsSync(bundle), `${id}: the entry names ${bundle}, which does not exist`)
    const held = certBlocks(fs.readFileSync(bundle, 'utf8')).map((b) => b.fp)
    for (const r of [...ROOTS.node, ROOTS.osText]) for (const b of certBlocks(r)) assert.ok(held.includes(b.fp), `${id}: the bundle holds the ${r === ROOTS.osText ? 'OS' : 'Node'} roots`)
    found.push(bundle)
  }
  return found
}
const entryStats = (s) => readManifest(s.dir).entries.map((e) => ({ path: e.path, installed_at: e.installed_at, ino: fs.statSync(e.real_path || e.path).ino, mtimeMs: fs.statSync(e.real_path || e.path).mtimeMs }))

test('R9: a crash at every one of the writes of a first on is finished by the next on; at every point an entry that exists points at a valid bundle; the user files come back byte for byte', async () => {
  const counter = await sandbox({ installed: false })
  let writes = 0
  const count = { ...fs, renameSync: (a, b) => { writes++; return fs.renameSync(a, b) } }
  assert.equal((await counter.run({ fs: count })).exit, 0)
  assert.ok(writes >= 20, `the clean run has ${writes} writes: the loop below has something to cut`)
  for (let k = 1; k <= writes; k++) {
    const s = await sandbox({ installed: false })
    const before = userView(s.home)
    let i = 0
    const crashing = { ...fs, renameSync: (a, b) => { if (++i === k) throw Object.assign(new Error(`crash at write ${k}`), { code: 'ECRASH' }); return fs.renameSync(a, b) } }
    await assert.rejects(s.run({ fs: crashing }), /crash at write/, `write ${k} of ${writes}`)
    bundlesAreValid(s)
    const done = await s.run()
    assert.equal(done.exit, 0, `after a crash at write ${k}: ${JSON.stringify(done.receipt.notes)}`)
    assert.deepEqual(validateReceipt(done.receipt), [])
    const m = readManifest(s.dir)
    assert.equal(m.install?.state, 'complete', `complete after resuming write ${k}`)
    assert.deepEqual([...new Set([...m.entries, ...m.files].map((x) => x.harness).filter(Boolean))].sort(), [...NAMES].sort(), `every harness has an entry or a file after resuming write ${k}`)
    assert.equal(m.entries.every((e) => e.post_sha256 != null), true, 'every entry is finished')
    assert.equal(bundlesAreValid(s).length, 3, 'codex\'s, hermes\'s and z-code\'s entries point at a bundle that holds both kinds of roots')
    // idempotent: a third on writes nothing
    const stat = entryStats(s); const manifestBytes = fs.readFileSync(path.join(s.dir, 'install-manifest.json'), 'utf8'); const state = fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8')
    const again = await s.run()
    assert.deepEqual([again.exit, again.receipt.changed, again.receipt.created], [0, [], []], `a second on after resuming write ${k} changes nothing`)
    assert.deepEqual(entryStats(s), stat, 'installed_at, inode and mtime of every entry are as they were')
    assert.equal(fs.readFileSync(path.join(s.dir, 'install-manifest.json'), 'utf8'), manifestBytes, 'the manifest is not rewritten')
    assert.equal(fs.readFileSync(path.join(s.dir, 'state.json'), 'utf8'), state, 'nor the desired state')
    // and off takes everything out, whichever way it got in
    const out = await undoHarnesses({ dir: s.dir, home: s.home, phases: PHASES, manifest: readManifest(s.dir), ids: null, procs: async () => [], roots: ROOTS })
    assert.deepEqual(out.left, [], `off leaves nothing after resuming write ${k}`)
    assert.deepEqual(userView(s.home), before, `the user's files are byte for byte what they were, after a crash at write ${k}`)
  }
})

test('R9: a second on on a complete install leaves installed_at, inode and mtime of every entry unchanged, rewrites neither the manifest nor the state, and says what it left alone', async () => {
  const s = await sandbox()
  const first = await s.run()
  assert.equal(first.exit, 0)
  assert.deepEqual(first.receipt.changed, [], 'every user file asight changes is install\'s: the on after it changes none (D55①)')
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
  const s = await sandbox()
  await s.run()
  const settings = path.join(s.home, '.claude', 'settings.json')
  const mine = '{ "model": "mine", "env": { "NODE_EXTRA_CA_CERTS": "/my/own-ca.pem" } }\n'
  fs.writeFileSync(settings, mine) // the user's own value in place of asight's
  const r = await s.run()
  assert.equal(fs.readFileSync(settings, 'utf8'), mine, 'left as the user has it')
  assert.deepEqual([r.exit, r.receipt.ok], [1, false], 'an entry that is not in effect is not "done"')
  assert.match(JSON.stringify(r.receipt.skipped), /settings\.json[\s\S]*asight off[\s\S]*asight on/, 'the receipt says which file and what to do')
  // off takes asight's part out (there is none left: the user's own value stays), and on writes the entry again
  const out = await undoHarnesses({ dir: s.dir, home: s.home, phases: PHASES, manifest: readManifest(s.dir), ids: ['claude-code'], procs: async () => [], roots: ROOTS })
  assert.deepEqual(out.results.map((x) => x.result), ['left-user-value'])
  await s.install() // the entry is a certificate item: install writes it again, never on (D55⑥)
  const back = await s.run()
  assert.equal(back.exit, 0)
  assert.equal(JSON.parse(fs.readFileSync(settings, 'utf8')).env.NODE_EXTRA_CA_CERTS, path.join(s.dir, 'ca', 'extra-cc.pem'), 'asight\'s entry again — now through the merge path, since a CA of the user\'s is named in the file')
})

test('R9: an edit of the settings file elsewhere (Claude Code rewrites it) is not a change to the entry: it stays intact and is not written again', async () => {
  const s = await sandbox()
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
  const s = await sandbox()
  await s.run()
  const bundle = path.join(s.dir, 'ca', 'combined-codex.pem')
  const caFp = certBlocks(fs.readFileSync(path.join(s.dir, 'ca', 'asight-ca.pem'), 'utf8'))[0].fp
  assert.ok(certBlocks(fs.readFileSync(bundle, 'utf8')).some((b) => b.fp === caFp))
  const was = readManifest(s.dir).entries.find((e) => e.harness === 'codex').installed_at
  const codex = { pid: 4242, exe: '/home/u/.local/bin/codex', argv: ['codex'], startedAt: Date.now() + 5000, env: () => new Map() } // started after install: it may have loaded the bundle
  const out = await undoHarnesses({ dir: s.dir, home: s.home, phases: PHASES, manifest: readManifest(s.dir), ids: ['codex'], procs: async () => [codex], roots: ROOTS })
  assert.deepEqual(out.kept_bundles.map((k) => k.pids), [[4242]])
  assert.equal(readManifest(s.dir).files.find((f) => f.path === bundle).without_ca, true)
  await new Promise((r) => setTimeout(r, 15))
  await s.install() // the bundle and the entry are certificate items: install puts them back, never on (D55⑥)
  const r = await s.run()
  assert.equal(r.exit, 0)
  const m = readManifest(s.dir)
  assert.equal(m.files.find((f) => f.path === bundle).without_ca, undefined, 'the mark is gone')
  assert.ok(certBlocks(fs.readFileSync(bundle, 'utf8')).some((b) => b.fp === caFp), 'the CA is back in the bundle')
  assert.ok(m.entries.find((e) => e.harness === 'codex').installed_at > was, 'a new installed_at: processes started since are judged against it')
  assert.equal(bundlesAreValid(s).length, 3)
})

test('R9: a manifest an older asight wrote has no liveness for some harness: on adds it, and rewrites the others from the descriptors (identity united with what was recorded, 4.6 「判活快照」)', async () => {
  const s = await sandbox()
  await s.run()
  const file = path.join(s.dir, 'install-manifest.json')
  const m = JSON.parse(fs.readFileSync(file, 'utf8'))
  m.liveness['claude-code'].until = 'session-end' // not what the descriptor says: the record is rewritten from it
  const recorded = { re: '(^|/)claude-old$', flags: 'i' }
  m.liveness['claude-code'].identity.match.push({ names: recorded }) // a name an earlier list held: kept
  delete m.liveness.codex
  fs.writeFileSync(file, JSON.stringify(m, null, 2))
  assert.equal((await s.run()).exit, 0)
  const after = readManifest(s.dir).liveness
  assert.equal(after['claude-code'].until, 'restart')
  assert.ok(after['claude-code'].identity.match.some((p) => JSON.stringify(p.names) === JSON.stringify(recorded)), 'the recorded pattern is united in')
  assert.ok(after.codex && typeof after.codex.rereads === 'boolean', 'codex has its record again')
})

test('R9: the unit file is written again when what it would say changed (the repo moved); a daemon-reload comes first, and the unit is enabled', async () => {
  const s = await sandbox()
  await s.run()
  const unitFile = path.join(s.home, '.config', 'systemd', 'user', 'asight-collector.service')
  assert.match(fs.readFileSync(unitFile, 'utf8'), /"\/repo\/bin\/asight\.mjs" daemon$/m)
  s.sys.exec.calls.length = 0
  const r = await s.run({ unit: s.unit('/moved/bin/asight.mjs') })
  assert.equal(r.exit, 0)
  assert.match(fs.readFileSync(unitFile, 'utf8'), /"\/moved\/bin\/asight\.mjs" daemon$/m)
  assert.deepEqual(s.sys.exec.calls.slice(0, 2), ['systemctl --user daemon-reload', 'systemctl --user enable asight-collector.service'])
  assert.deepEqual(r.receipt.created.filter((p) => p === unitFile), [unitFile])
})

test('R12: on reads state.json before each write and stops, exit 1, when it says off for a harness it is turning on; what it wrote is a resumable install', async () => {
  const s = await sandbox()
  let writes = 0
  const stateFile = path.join(s.dir, 'state.json')
  const racing = { ...fs, renameSync: (a, b) => {
    if (++writes === 2) { // an `off` lands between two writes of this on (its first is state.json)
      const { state } = readStateFile(stateFile); writeStateAtomic(stateFile, setDesired(state, ['codex'], 'off', new Date()))
    }
    return fs.renameSync(a, b)
  } }
  const r = await s.run({ fs: racing })
  assert.deepEqual([r.exit, r.receipt.ok], [1, false])
  assert.match(r.receipt.notes.join('\n'), /codex was turned off while this on ran[\s\S]*the off wins/)
  assert.equal(readStateFile(stateFile).state.harnesses.codex.desired, 'off', 'the on does not turn it back on')
  assert.equal(s.sys.daemon.calls.filter((c) => c.startsWith('POST /on')).length, 0, 'and attaches nothing')
  assert.equal(readManifest(s.dir).install?.state, 'complete', 'install\'s record is install\'s: an on that stopped does not undo it')
  const flows = fs.readdirSync(path.join(s.dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(s.dir, 'flows', n), 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
  assert.ok(flows.some((f) => f.event === 'failure' && /turned off while this on ran/.test(f.reason)), 'the stop is recorded (D38)')
  assert.equal(flows.at(-1).kind, 'result')
})

test('R12: a state.json a version 1 collector wrote (desired on or off) is read for the installed harnesses and written as version 2 by on, which then goes through; the guard reads it the same way (the upgrade path)', async () => {
  const stamp = '2026-10-01T00:00:00.000Z'
  for (const desired of ['on', 'off']) for (const ids of [null, ['codex']]) {
    const s = await sandbox()
    assert.equal((await s.run()).exit, 0)
    const stateFile = path.join(s.dir, 'state.json')
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, desired, policy: 'auto', extra_hosts: [], updated_at: stamp })) // what `collector on|off` wrote before D39
    const plans = []
    const r = await s.run({ ids, onPlan: (p) => plans.push(p) })
    const what = `v1 desired ${desired}, ${ids ? 'named codex' : 'every harness'}`
    if (desired === 'on') assert.deepEqual([plans.length, plans[0].state, plans[0].manifest, plans[0].ca, plans[0].entries], [1, stateFile, null, [], []], `${what}: the plan names the state file, the only thing written`)
    assert.equal(r.exit, 0, `${what}: ${JSON.stringify(r.receipt.notes)}`)
    assert.doesNotMatch(r.receipt.notes.join('\n'), /turned off while this on ran/, what)
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).version, 2, `${what}: written as version 2`)
    const { state } = readStateFile(stateFile)
    for (const id of ids || NAMES) assert.equal(state.harnesses[id].desired, 'on', `${what}: ${id}`)
    if (ids) for (const id of NAMES) assert.ok(state.harnesses[id], `${what}: ${id}, installed before, keeps its entry in the new file`)
    if (desired === 'on') for (const id of NAMES) assert.equal(state.harnesses[id].updated_at, stamp, `${what}: nothing was turned on, so "on since" does not move`)
    assert.ok(r.receipt.created.includes(stateFile), `${what}: the file that was written is in the receipt`)
    const again = await s.run({ ids })
    assert.deepEqual([again.exit, again.receipt.created], [0, []], `${what}: the next on has nothing left to do`)
  }
})

test('on: with no daemon answering and no unit it writes everything, exits 0 and says how to start the daemon; --no-autostart writes no login entry and starts the daemon directly this once (1.6 §3.3)', async () => {
  const s = await sandbox()
  const down = fakeDaemon({ up: false })
  const bare = await s.run({ unit: null, request: down.request })
  assert.deepEqual([bare.exit, bare.receipt.daemon.state, bare.receipt.unit], [0, 'not-running', null])
  assert.match(bare.receipt.notes.join('\n'), /asight daemon/)
  assert.deepEqual(s.sys.exec.calls, [], 'no unit: no systemctl at all')
  assert.ok(!fs.existsSync(path.join(s.home, '.config', 'systemd')), 'and no unit file')
  assert.deepEqual(readManifest(s.dir).files.filter((f) => f.role === 'unit'), [])

  const t = await sandbox()
  const sys = fakeSystem()
  const spawn = fakeSpawn(sys.daemon)
  const r = await t.run({ unit: userUnit({ home: t.home, node: '/usr/bin/node', script: '/repo/bin/asight.mjs', run: sys.exec.run, spawn }), request: sys.daemon.request, autostart: false })
  assert.equal(r.exit, 0)
  assert.deepEqual(spawn.calls, ['/usr/bin/node /repo/bin/asight.mjs daemon'], 'the daemon is started directly, this once')
  assert.deepEqual(sys.exec.calls, [], 'no systemctl at all: nothing is enabled and no unit is loaded')
  assert.ok(!fs.existsSync(path.join(t.home, '.config', 'systemd')), '--no-autostart writes no login entry')
  assert.deepEqual([r.receipt.daemon.state, r.receipt.daemon.started, r.receipt.unit], ['running', true, null])
})

test('on: a unit systemd refuses to enable, a daemon that never answers, a kernel that does not confirm — each exit 1 with the reason, recorded; the attach is not asked when the unit failed', async () => {
  const refused = await sandbox()
  const sys = fakeSystem()
  const ex = recordingExec({ fail: (cmd) => (/enable/.test(cmd) ? { status: 1, stderr: 'Failed to connect to bus' } : null) })
  let r = await refused.run({ unit: userUnit({ home: refused.home, node: '/n', script: '/s', run: ex.run, spawn: fakeSpawn() }), request: sys.daemon.request })
  assert.equal(r.exit, 1); assert.match(r.receipt.notes.join('\n'), /"systemctl --user enable --now" failed \(Failed to connect to bus\)/)
  assert.equal(readManifest(refused.dir).install?.state, 'complete', 'the install itself is complete; only the autostart is not')

  const silent = await sandbox(); const dead = fakeDaemon({ up: false })
  r = await silent.run({ request: dead.request })
  assert.equal(r.exit, 1); assert.match(r.receipt.notes.join('\n'), /does not answer on \/x\/collector\.sock/)

  const notOn = await sandbox(); const sys2 = fakeSystem({ actual: 'off' })
  r = await notOn.run({ unit: userUnit({ home: notOn.home, node: '/n', script: '/s', run: sys2.exec.run, spawn: fakeSpawn() }), request: sys2.daemon.request })
  assert.equal(r.exit, 1); assert.match(r.receipt.notes.join('\n'), /the daemon did not reach on/)
  const flows = fs.readdirSync(path.join(notOn.dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(notOn.dir, 'flows', n), 'utf8').trim().split('\n').map((l) => JSON.parse(l)))
  assert.ok(flows.some((f) => f.event === 'failure' && f.where === 'switch'), 'recorded where the board looks (D38)')
})

test('on: the processes the daemon says are not captured yet are the restart list (config-after-start, env-frozen, no-marker, kimi-not-via-shim), by pid and harness; trusted ones and the other harnesses\' are not', async () => {
  const s = await sandbox()
  const sys = fakeSystem({ agents: [
    { pid: 4121, agent: 'claude-code', trusted: false, reason: 'config-after-start' },
    { pid: 4122, agent: 'claude-code', trusted: true, reason: 'ok' },
    { pid: 5530, agent: 'codex', trusted: false, reason: 'env-frozen' },
    { pid: 6001, agent: 'opencode', trusted: false, reason: 'no-marker' },
    { pid: 6002, agent: 'kimi-code', trusted: false, reason: 'kimi-not-via-shim' }, // a harness this on is not turning on
    { pid: 6003, agent: 'codex', trusted: false, reason: 'var-missing' }, // not a restart: the entry is not in effect for another reason
  ] })
  const r = await s.run({ unit: userUnit({ home: s.home, node: '/n', script: '/s', run: sys.exec.run, spawn: fakeSpawn() }), request: sys.daemon.request })
  assert.deepEqual(r.receipt.restart.map((x) => [x.harness, x.pid]), [['claude-code', 4121], ['codex', 5530], ['opencode', 6001]])
  assert.deepEqual(validateReceipt(r.receipt), [])
})

test('on: the linger line — false says how to enable it and never runs loginctl, true says nothing, unreadable says 不知道 and never "已开" (1.6 §1.1, V39 on side)', async () => {
  const s = await sandbox()
  const r = await s.run({ linger: () => false })
  assert.deepEqual([r.receipt.linger, s.sys.exec.calls.some((c) => /loginctl/.test(c))], [false, false])
  assert.equal((await (await sandbox()).run({ linger: () => true })).receipt.linger, true)
  const u = await (await sandbox()).run({ linger: () => null })
  assert.deepEqual([u.receipt.linger, typeof u.receipt.linger_reason], ['unknown', 'string'])
  assert.equal((await (await sandbox()).run({ linger: () => { throw new Error('EACCES') } })).receipt.linger, 'unknown')
})

test('on: named harnesses only — on codex writes codex\'s files and turns on codex alone; a named harness with nothing to install is skipped with the descriptor\'s reason and is not "done"', async () => {
  const all = await loadHarnesses()
  const s = await sandbox({ installed: false }); fs.rmSync(path.join(s.home, '.hermes'), { recursive: true }) // Hermes is not installed here; the first run installs what it names
  const r = await s.run({ ids: ['codex', 'hermes'], harnesses: all })
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8')).env, undefined, 'claude-code is not touched')
  assert.deepEqual(r.receipt.harnesses, ['codex'])
  assert.deepEqual(r.receipt.skipped.map((x) => x.what), ['hermes'])
  assert.match(r.receipt.skipped[0].reason, /\.hermes/, 'with the descriptor\'s own words')
  assert.equal(r.exit, 1, 'a harness that was asked for and could not be done: not done')
  assert.deepEqual(Object.keys(readStateFile(path.join(s.dir, 'state.json')).state.harnesses), ['codex'])
  assert.deepEqual(s.sys.daemon.calls.filter((c) => c.startsWith('POST /on')), ['POST /on {"harnesses":["codex"]}'])
  const t = await sandbox({ installed: false }); fs.rmSync(path.join(t.home, '.hermes'), { recursive: true }); await t.install(); const before = snapshot(t.home)
  const none = await t.run({ ids: ['hermes'], harnesses: all })
  assert.deepEqual([none.exit, none.receipt.ok], [1, false])
  assert.deepEqual(snapshot(t.home), before, 'nothing to turn on: nothing written, not even the manifest')
})

test('on: root is refused by the library too (R7), and a missing helper stops it before anything is written', async () => {
  const s = await sandbox(); const before = snapshot(s.home)
  await assert.rejects(s.run({ getuid: () => 0 }), /not as root/)
  const r = await s.run({ helperState: () => ({ ok: false, reason: 'no helper' }) })
  assert.deepEqual([r.exit, r.receipt.ok], [1, false]); assert.match(r.receipt.notes.join(' '), /sudo asight setup-helper/)
  assert.deepEqual(snapshot(s.home), before)
})

// audit rule-b 7 (R1, R6, V7): a failed `on` that wrote nothing still pointed at `~/.asight/bin/asight-off` and the flows/ log, neither of which exists; and a dry run with the helper
// missing exited 1 with no plan, so the plan could not be read before deciding to `sudo asight setup-helper` — V7 says a dry run exits 0.
test('R1 / R6: an `on` that stopped before writing anything says so — no change, nothing made, no undo and no log to point at, no asight-off path (helper missing, no agent found, the lock held)', async () => {
  const noHelper = () => ({ ok: false, reason: 'no helper' })
  const s = await sandbox(); const before = snapshot(s.home)
  const r = await s.run({ helperState: noHelper })
  const bare = (x) => [x.exit, x.receipt.ok, x.receipt.changed, x.receipt.created, x.receipt.undo, x.receipt.log, 'standalone' in x.receipt]
  assert.deepEqual(bare(r), [1, false, [], [], [], null, false])
  assert.deepEqual(validateReceipt(r.receipt), [])
  assert.ok(!JSON.stringify(r.receipt).includes('asight-off') && !JSON.stringify(r.receipt).includes('flows'), 'neither the undo program nor the log is named: neither is there')
  assert.deepEqual(snapshot(s.home), before)
  // no agent to capture
  const empty = await sandbox(); fs.rmSync(path.join(empty.home, '.claude'), { recursive: true, force: true })
  const none = await empty.run({ ids: ['claude-code'], harnesses: [] })
  assert.deepEqual(bare(none), [1, false, [], [], [], null, false])
  // another command holds the lock (a live pid, a lock written just now): `on` waits, gives up, and has written nothing — its receipt lists no change it did not make
  const held = await sandbox()
  const settingsBefore = fs.readFileSync(path.join(held.home, '.claude', 'settings.json'), 'utf8')
  fs.mkdirSync(held.dir, { recursive: true }); fs.writeFileSync(path.join(held.dir, 'op.lock'), JSON.stringify({ pid: process.pid, start_time: null, boot_id: null }) + '\n')
  const busy = await held.run({ lockWaitMs: 30 })
  assert.equal(busy.exit, 1)
  assert.match(busy.receipt.notes.join(' '), /another asight command \(pid \d+\) holds/)
  assert.deepEqual([busy.receipt.changed, busy.receipt.created, busy.receipt.undo, busy.receipt.log], [[], [], [], null], 'the plan listed changes and files; none was made, so none is claimed')
  assert.equal(fs.readFileSync(path.join(held.home, '.claude', 'settings.json'), 'utf8'), settingsBefore, 'and none was')
})

test('R6 / V7: `on --dry-run` with the helper missing still prints the plan and exits 0 — the stop a real run would meet is in the receipt (`blocked`, a note) — and writes nothing; the real run exits 1', async () => {
  const s = await sandbox(); const before = snapshot(s.home)
  const ok = await s.run({ dryRun: true })
  const dry = await s.run({ dryRun: true, helperState: () => ({ ok: false, reason: 'no helper' }) })
  assert.deepEqual([dry.exit, dry.receipt.ok, dry.receipt.dry_run], [0, true, true])
  assert.deepEqual([dry.receipt.changed, dry.receipt.created], [ok.receipt.changed, ok.receipt.created], 'the plan is the one a user with a helper would get')
  assert.ok(dry.receipt.created.length > 0, 'and it is a real plan (the unit; every certificate item is install\'s)')
  assert.match(dry.receipt.blocked, /capability helper is missing.*sudo asight setup-helper/)
  assert.match(dry.receipt.notes.join('\n'), /sudo asight setup-helper.*a real asight on stops there/)
  assert.deepEqual(validateReceipt(dry.receipt), [])
  assert.deepEqual(snapshot(s.home), before, 'a dry run writes nothing')
  assert.equal((await s.run({ helperState: () => ({ ok: false, reason: 'no helper' }) })).exit, 1)
})

// audit rule-b 9 (R11): the lines of an `on` go through the same writer as `off`'s — a line that cannot be written reaches stderr first and the receipt's notes, and does not stop the install.
test('R11: with flows/ unwritable `on` still installs (exit 0); stderr and the receipt say each line that could not be recorded', async () => {
  const s = await sandbox()
  const err = []
  const flaky = new Proxy(fs, { get: (o, k) => (k === 'appendFileSync' ? () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) } : o[k]) })
  const r = await s.run({ fs: flaky, log: (m) => err.push(m) })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.notes))
  assert.ok(err.length >= 1 && err.every((m) => /could not be written to .*flows \(ENOSPC/.test(m)), `stderr said so: ${err.join(' | ')}`)
  assert.equal(r.receipt.notes.filter((n) => /^not recorded \(ENOSPC/.test(n)).length, err.length, 'and the receipt says the same, line for line')
  assert.ok(fs.readFileSync(path.join(s.home, '.claude', 'settings.json'), 'utf8').includes('NODE_EXTRA_CA_CERTS'), 'the install itself was done')
})

// R21 (D51③, 1.6 V65): the plan judges the running processes with the name list in effect — the presets plus ~/.asight/agents.json — the one the daemon and `status`
// judge with. Through the real loadParts (the registry it builds), only the arch's process table faked: a custom name running before its entry is a process to restart.
// Since D55 the entry is install's, so the plan that names it is `asight install`'s (the same planOn `on` printed before).
test('R21 the plan reads agents.json: a running agent of a custom name (claude-nightly) is judged as the harness\'s — it is on the restart list of the plan', async () => {
  const { runInstallCli } = await import('../../src/cli/install.mjs')
  const { loadParts } = await import('../../src/collector/daemon.mjs')
  const { readAgentList } = await import('../../src/off/identity.mjs')
  const { onCtx, fakeIo, seedClaude } = await import('./fixtures/on-ctx.mjs')
  const unit = await import('../../src/collector/arch/linux/unit.mjs')
  const cc = descs.find((d) => d.name === 'claude-code')
  const home = tmpDir('asight-on-list-'); seedClaude(home)
  fs.mkdirSync(path.join(home, '.asight'), { recursive: true })
  fs.writeFileSync(path.join(home, '.asight', 'agents.json'), JSON.stringify({ version: 1, agents: [{ harness: 'claude-code', name: 'claude-nightly' }] }))
  const nightly = { pid: 7100, ppid: 1, uid: 1000, startedAt: 1, exe: '/home/u/.local/bin/claude-nightly', argv: ['claude-nightly'], env: new Map() }
  const arch = { os: 'none', unit, createRedirector: async () => ({ scan: () => [nightly] }) }
  const parts = await loadParts({ env: { HOME: home }, agentList: readAgentList({ home, fs }).entries, arch, harnesses: [cc] })
  const io = fakeIo()
  assert.equal(await runInstallCli(['--dry-run'], { ...onCtx(home, io, { deps: { parts } }), platform: 'linux' }), 0, io.text())
  assert.match(io.text(), /7100/, 'the custom name is claude-code\'s, as the daemon will judge it: its pid is on the restart list')
})

// R13 (1.6 V65, D48): the list file belongs to the user — `on`, a second `on`, and `off` leave ~/.asight/agents.json byte for byte and untouched (mtime), whether it
// reads cleanly (a custom item, an ignore, a bad item) or does not parse at all.
test('R13 V65 on, on again and off leave agents.json byte for byte unchanged (a valid list with a bad item, and one that is not JSON)', async () => {
  const { installedHome } = await import('../off/fixtures/off-ctx.mjs')
  const docs = {
    valid: `${JSON.stringify({ version: 1, agents: [{ harness: 'claude-code', name: 'claude-nightly' }, { harness: 'codex', name: 'codex', ignore: true }, { harness: 'claude-code', name: 'node' }] }, null, 2)}\n`,
    invalid: '{ "version": 1, "agents": [ not json\n',
  }
  for (const [label, text] of Object.entries(docs)) {
    const file = (home) => path.join(home, '.asight', 'agents.json')
    const s = await installedHome({ seed: (home) => { fs.mkdirSync(path.join(home, '.asight'), { recursive: true }); fs.writeFileSync(file(home), text); fs.utimesSync(file(home), 1_700_000_000, 1_700_000_000) } })
    const same = (step) => {
      assert.equal(fs.readFileSync(file(s.home), 'utf8'), text, `${label}: ${step} left the bytes`)
      assert.equal(fs.statSync(file(s.home)).mtimeMs, 1_700_000_000_000, `${label}: ${step} did not write the file`)
    }
    same('the first on')
    assert.equal((await s.on()).exit, 0, `${label}: on again`)
    same('a second on')
    assert.equal((await s.off()).exit, 0, `${label}: off`)
    same('off')
  }
})

test('V72 (1.6 §2, D57): `on --opt-in <any value>`, `--opt-in=<x>` and the old `--proxy` are plain unknown options now — exit 2, HOME byte for byte unchanged, zero OS tools, zero daemon calls, on every platform', async () => {
  const shapes = [['--opt-in', 'kimi-code.cli'], ['--opt-in=codex.machine'], ['codex', '--opt-in', 'a,b', '--yes'], ['--yes', '--opt-in='], ['--opt-in'], ['--proxy', 'http://127.0.0.1:8899'], ['--proxy=http://127.0.0.1:8899']]
  for (const platform of ['linux', 'darwin', 'win32']) for (const argv of shapes) {
    const home = tmpDir('asight-v72-')
    seedClaude(home)
    const before = snapshot(home)
    const exec = recordingExec(), daemon = fakeDaemon(), io = fakeIo()
    const ctx = onCtx(home, io, { exec, daemon })
    let partsRead = 0
    ctx.deps.parts = new Proxy(ctx.deps.parts, { get: (t, k) => { partsRead++; return t[k] } }) // asked for nothing: the flag is refused before the platform is loaded
    const exit = await runOnCli(argv, { ...ctx, platform })
    const label = `${platform} ${argv.join(' ')}`
    assert.equal(exit, 2, `${label}: ${io.text()}`)
    assert.match(io.stderrText(), /^asight on: unknown option '--(opt-in|proxy)'\n/, label)
    assert.deepEqual(snapshot(home), before, `${label}: HOME byte for byte unchanged`)
    assert.deepEqual(exec.calls, [], `${label}: no OS tool`)
    assert.deepEqual(daemon.calls, [], `${label}: no daemon request`)
    assert.equal(partsRead, 0, `${label}: the platform is not even loaded`)
  }
})
