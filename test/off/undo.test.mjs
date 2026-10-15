// test/off/undo.test.mjs — src/off/undo.mjs undoHarnesses (RFC 4.6 撤销顺序第 1–5 步 and 按 harness 撤, 1.6 R2 / R3 / §1.5): the entries, bundles, extra
// trust files, plugins, shims and rc lines of all harnesses or some, undone with liveness judged from the manifest's snapshot and the process table
// handed in — no daemon, no descriptor. Every case installs synthetic harnesses into a sandbox HOME through the real installCollector (osName
// 'none', so no machine-wide file is read; the descriptors declare a signature for it) and undoes from the manifest it wrote.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { installCollector } from '../../src/collector/install.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import { readManifest, restoreByHand } from '../../src/off/manifest.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { sha256 } from '../../src/off/fsutil.mjs'
import { certBlocks, composeBundle } from '../../src/off/pem.mjs'
import { lineComment } from '../../src/off/text-edit.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const ROOT = createCa({ commonName: 'undo root' }), CORP = createCa({ commonName: 'undo corp relay' }), OSROOT = createCa({ commonName: 'undo os root' })
const roots = { node: [ROOT.certPem], osText: '' }
const box = () => { const home = tmpDir('asight-undo-'); return { home, dir: path.join(home, '.asight', 'collector'), ca: (n) => path.join(home, '.asight', 'collector', 'ca', n) } }
const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null)
const fpsOf = (f) => certBlocks(fs.readFileSync(f, 'utf8')).map((c) => c.fp)
const write = (b, rel, text) => { const f = path.join(b.home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
const proc = (pid, exe, { startedAt = Date.now() + 5000, env = {}, argv = [exe], ppid = 1 } = {}) => ({ pid, ppid, exe, argv, startedAt, env: () => (env === null ? null : new Map(Object.entries(env))) }) // env null: cannot be read

// a replace-semantics harness (Codex / Hermes shape): a dotenv block naming its own combined bundle
const repH = (b, name, extra = {}) => ({
  name, runtime: 'rust', processes: { names: [{ name }] }, hosts: [], trust: { chain: [{ var: 'SSL_CERT_FILE', semantic: 'replace' }], ...extra },
  inject: (ctx) => ({
    entries: [{ kind: 'text', format: 'dotenv-block', path: path.join(ctx.home, `.${name}`, '.env'), vars: { SSL_CERT_FILE: b.ca(`combined-${name}.pem`) }, semantic: 'replace' }],
    files: [{ path: b.ca(`combined-${name}.pem`), bundle: true, certsFrom: [path.join(ctx.home, 'corp.pem')] }],
  }),
})
// an append-semantics harness (Claude Code shape): a JSON key naming an extra file that carries the user's CA
const jsonH = (b) => ({
  name: 'jj', runtime: 'node', processes: { names: [{ name: 'jj' }] }, hosts: [], trust: { chain: [{ var: 'NODE_EXTRA_CA_CERTS', semantic: 'append' }], rereadsEntry: true },
  inject: (ctx) => ({ entries: [{ kind: 'json-key', path: path.join(ctx.home, '.jj', 'settings.json'), keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: b.ca('extra-jj.pem'), semantic: 'append' }], files: [{ path: b.ca('extra-jj.pem'), certsFrom: [path.join(ctx.home, 'corp.pem')] }] }),
})
// a plugin-style harness: a plugin file in the agent's directory, a YAML row loading asight's plugin dir, a path the agent may write because of it
const plugH = (b) => ({
  name: 'plug', runtime: 'node', processes: { names: [{ name: 'plug' }] }, hosts: [], trust: { chain: [{ var: 'asight:marker', semantic: 'append' }] },
  inject: (ctx) => ({
    owned: [{ path: path.join(ctx.home, '.config', 'plug', 'plugins', 'asight-ca.js'), role: 'plugin', data: '// asight collector: trust plugin\n', mode: 0o644 }, { path: path.join(b.dir, 'plugins', 'plug', 'index.js'), role: 'plugin', data: 'export {}\n', mode: 0o644 }],
    entries: [{ kind: 'text', format: 'yaml-list', path: path.join(ctx.home, '.plug', 'patch.yml'), line: `- insert: [{ name: ${JSON.stringify(path.join(b.dir, 'plugins', 'plug', 'index.js'))} }] ${lineComment('plug trust plugin')}`, semantic: 'append' }],
    watch: [{ path: path.join(ctx.home, '.config', 'plug', 'node_modules'), why: 'plug installs its SDK on first run' }],
  }),
})

// installs `pick(b)` harnesses over user files `a`, `b` (dotenv), jj (JSON) and a user CA, and returns what undo needs
async function setup(pick = (b) => [repH(b, 'aa'), repH(b, 'bb'), jsonH(b), plugH(b)]) {
  const b = box()
  write(b, 'corp.pem', CORP.certPem)
  write(b, '.aa/.env', 'KEY_A=sk-a\n'); write(b, '.bb/.env', 'KEY_B=sk-b\n'); write(b, '.jj/settings.json', '{\n  "model": "m"\n}\n'); write(b, '.plug/patch.yml', '- set: {a: 1}\n')
  await installCollector({ home: b.home, env: { HOME: b.home }, osName: 'none', harnesses: pick(b), freePort: async () => 47011, roots })
  const user = ['.aa/.env', '.bb/.env', '.jj/settings.json', '.plug/patch.yml'].map((r) => path.join(b.home, r))
  const run = (o = {}) => undoHarnesses({ dir: b.dir, home: b.home, manifest: readManifest(b.dir), ids: null, procs: async () => [], roots, ...o })
  return { b, user, run, hashes: () => Object.fromEntries([...user, ...fs.readdirSync(b.ca('.')).map((n) => b.ca(n))].map((f) => [path.relative(b.home, f), sha(f)])) }
}

test('off one harness: its entry, bundle, extra file, plugin and rows go, byte for byte; every file of the others is unchanged, asight-ca.pem stays, and so does what is not asight\'s', async () => {
  const s = await setup()
  const before = s.hashes()
  const r = await s.run({ ids: ['aa'] })
  assert.deepEqual(r.results.map((x) => [path.basename(path.dirname(x.path)), x.result]), [['.aa', 'restored']])
  assert.equal(fs.readFileSync(s.user[0], 'utf8'), 'KEY_A=sk-a\n')
  assert.ok(!fs.existsSync(s.b.ca('combined-aa.pem')), 'its bundle: nobody holds it, so it is removed')
  const after = s.hashes()
  for (const k of Object.keys(before)) if (!k.includes('aa')) assert.equal(after[k], before[k], `${k} is untouched`)
  assert.ok(fs.existsSync(s.b.ca('asight-ca.pem')) && fs.existsSync(s.b.ca('ca.key')))
  assert.deepEqual([...new Set(r.manifest.entries.map((e) => e.harness))].sort(), ['bb', 'jj', 'plug'], 'the other harnesses\' entries stay in the manifest')
  assert.deepEqual(Object.keys(r.manifest.liveness).sort(), ['bb', 'jj', 'plug'], 'a harness with nothing left needs no liveness')
  assert.deepEqual([r.left, r.kept_bundles, r.still_trusting], [[], [], []])
  // the plugin and the YAML row belong to plug: off plug takes them, and the user's own row stays
  fs.appendFileSync(s.user[3], '- insert: [{ name: mine }]\n')
  const p = await s.run({ ids: ['plug'] })
  assert.deepEqual(p.results.map((x) => x.result), ['reverted-not-identical'])
  assert.equal(fs.readFileSync(s.user[3], 'utf8'), '- set: {a: 1}\n- insert: [{ name: mine }]\n')
  assert.ok(!fs.existsSync(path.join(s.b.home, '.config', 'plug', 'plugins', 'asight-ca.js')) && !fs.existsSync(path.join(s.b.dir, 'plugins')))
  assert.deepEqual(p.residue, [], 'nothing appeared where the agent writes')
})

test('off all: every entry out in the 4.6 order (config keys, then rows), the CA files stay unless dropCa (uninstall), and the manifest keeps only what is not asight\'s harness work', async () => {
  const s = await setup()
  const r = await s.run()
  assert.deepEqual(r.results.map((x) => x.result).sort(), ['restored', 'restored', 'restored', 'restored'])
  const order = r.results.map((x) => path.basename(x.path))
  assert.ok(order.indexOf('patch.yml') > order.indexOf('settings.json') && order.indexOf('patch.yml') > order.lastIndexOf('.env'), `config keys and blocks (step 1) before rows (step 4): ${order}`)
  assert.deepEqual([r.manifest.entries, r.manifest.files.map((f) => f.role)], [[], ['ca-key', 'ca-cert']], 'the CA files are not a harness\'s')
  assert.ok(fs.existsSync(s.b.ca('asight-ca.pem')), 'off never removes the CA: the next on uses it again')
  const again = await s.run({ dropCa: true })
  assert.deepEqual([again.results, again.removed], [[], [s.b.ca('asight-ca.pem')]], 'a second run finds nothing to undo; dropCa (uninstall) removes the CA certificate and not its key')
  assert.ok(fs.existsSync(s.b.ca('ca.key')))
})

test('backups (R2): dropped when the file is back at its pre_sha256, kept and listed in kept_backups when the user changed the file after asight did; an entry that cannot be undone keeps its backup and stays', async () => {
  const s = await setup((b) => [repH(b, 'aa'), repH(b, 'bb'), jsonH(b)])
  const m = readManifest(s.b.dir)
  const backups = [0, 1, 2].map((n) => m.entries.find((e) => e.path === s.user[n]).backup) // the run takes undone entries out of m
  const bk = (n) => backups[n]
  assert.ok([0, 1, 2].every((n) => fs.existsSync(bk(n))), 'one backup per user file asight changed')
  fs.appendFileSync(s.user[1], 'KEY_NEW=1\n') // the user edits .bb/.env after install
  fs.writeFileSync(s.user[2], fs.readFileSync(s.user[2], 'utf8') + ' trailing garbage') // jj's settings is no longer JSON
  const r = await s.run({ manifest: m })
  assert.deepEqual(r.results.map((x) => [path.basename(path.dirname(x.path)), x.result]).sort(), [['.aa', 'restored'], ['.bb', 'reverted-not-identical'], ['.jj', 'left-unparsable']])
  const row = (n) => r.results.find((x) => x.path === s.user[n])
  assert.deepEqual([fs.existsSync(bk(0)), row(0).backup, row(0).backup_kept], [false, bk(0), undefined], 'restored: the backup is dropped')
  assert.deepEqual([fs.existsSync(bk(1)), row(1).backup_kept], [true, bk(1)], 'edited since: kept')
  assert.deepEqual(r.manifest.kept_backups.map((k) => [k.path, k.backup, typeof k.at, /edited after asight/.test(k.reason)]), [[s.user[1], bk(1), 'string', true]])
  assert.equal(fs.readFileSync(s.user[1], 'utf8'), 'KEY_B=sk-b\nKEY_NEW=1\n', 'asight\'s block is out; the user\'s edit stays')
  assert.deepEqual([fs.existsSync(bk(2)), row(2).backup_kept, r.left.map((l) => [l.path, l.result])], [true, bk(2), [[s.user[2], 'left-unparsable']]], 'not undone: its backup stays, named')
  assert.match(r.left[0].reason, /settings\.json: asight cannot read it \(line \d+, column \d+\); asight's env\.NODE_EXTRA_CA_CERTS/)
  assert.deepEqual(r.manifest.entries.map((e) => e.path), [s.user[2]], 'and so does its manifest entry')
  assert.equal(r.manifest.files.some((f) => f.harness === 'jj'), false, 'its extra file was removed all the same: nobody holds it')
  // restoring a missing file keeps its backup too, and a backup left when the file was already back is dropped
  const t = await setup((b) => [repH(b, 'aa'), repH(b, 'bb')])
  const tm = readManifest(t.b.dir)
  const aa = tm.entries.find((e) => /\.aa/.test(e.path)); const bbBackup = tm.entries.find((e) => /\.bb/.test(e.path)).backup; fs.rmSync(t.user[0]) // gone
  fs.writeFileSync(t.user[1], 'KEY_B=sk-b\n') // back as it was, by hand, with its backup still there
  const u = await t.run({ manifest: tm })
  assert.deepEqual(u.results.map((x) => x.result).sort(), ['already-restored', 'missing'])
  assert.deepEqual([fs.existsSync(aa.backup), u.manifest.kept_backups.map((k) => k.backup), fs.existsSync(bbBackup)], [true, [aa.backup], false])
})

// 4.11 P13: the kinds the collector model adds. A json-array-item is a file entry (step 1); `switch` and `config-entry` files go with the plugins; a
// `wrapper` and the `root-key` are install items: only uninstall (dropCa) undoes them, the key last, through the custody handed in.
test('P13 json-array-item, switch and config-entry are undone by off; wrapper and root-key stay for off (the key is listed) and go with uninstall, the key last through custody.remove', async () => {
  const s = await setup((b) => [repH(b, 'aa')])
  const m = readManifest(s.b.dir)
  const arr = write(s.b, '.aa/settings.json', '{\n  "list": [\n    "u",\n    "http.proxy"\n  ]\n}\n')
  const sw = write(s.b, '.asight/collector/switch/aa', 'http://127.0.0.1:47011\n'), cfg = write(s.b, '.aa/library/asight.json', '{}\n')
  const bin = write(s.b, 'bin/aa', '#!/bin/dash\nexec real\n'), real = write(s.b, 'bin/.asight-real/aa', 'REAL PROGRAM')
  const at = new Date(0).toISOString()
  m.entries.push({ phase: 'on', kind: 'json-array-item', harness: 'aa', path: arr, keys: ['list'], item: 'http.proxy', created_array: false, existed_before: true, mode: 0o644, pre_sha256: 'x', post_sha256: 'y', ops: [], backup: null, installed_at: at },
    { phase: 'install', kind: 'root-key', harness: null, path: 'keychain:asight-root', custody: { kind: 'keychain', id: 'asight-root' }, fp256: 'AB:CD', installed_at: at })
  m.files.push({ phase: 'on', kind: 'owned-file', role: 'switch', harness: 'aa', path: sw }, { phase: 'on', kind: 'owned-file', role: 'config-entry', harness: 'aa', path: cfg },
    { phase: 'install', kind: 'owned-file', role: 'wrapper', harness: 'aa', path: bin, real, sha256: sha(bin), real_sha256: sha(real) })
  const removed = []
  const off = await s.run({ manifest: m, custody: { remove: async (h) => removed.push(h) } })
  assert.deepEqual(off.left, [])
  assert.equal(fs.readFileSync(arr, 'utf8'), '{\n  "list": [\n    "u"\n  ]\n}\n', 'only asight\'s element left the list')
  assert.deepEqual([fs.existsSync(sw), fs.existsSync(cfg), fs.readFileSync(bin, 'utf8'), fs.existsSync(real), removed], [false, false, '#!/bin/dash\nexec real\n', true, []], 'off keeps the wrapper and the key')
  assert.ok(off.notes.some((n) => n.startsWith('keychain:asight-root: ') && /asight uninstall removes it/.test(n)), 'off lists the key')
  const kept = readManifest(s.b.dir)
  assert.deepEqual([kept.entries.map((e) => e.kind), kept.files.map((f) => f.role).filter((r) => !r.startsWith('ca-'))], [['root-key'], ['wrapper']])
  const order = []
  const un = await s.run({ manifest: kept, dropCa: true, custody: { remove: async (h) => { order.push(['key', fs.existsSync(real)]); removed.push(h) } } })
  assert.deepEqual([un.left, removed, order], [[], [{ kind: 'keychain', id: 'asight-root' }], [['key', false]]], 'the key goes last, after the wrapper')
  assert.deepEqual([fs.readFileSync(bin, 'utf8'), fs.existsSync(path.dirname(real))], ['REAL PROGRAM', false], 'the real program is back under its name')
  assert.deepEqual(readManifest(s.b.dir).entries, [])
})

test('P13 uninstall: a wrapper the agent updated over is left in place and only the moved copy goes; a key with no custody backend is left, with how to remove it by hand', async () => {
  const s = await setup((b) => [repH(b, 'aa')])
  const m = readManifest(s.b.dir)
  const bin = write(s.b, 'bin/aa', '#!/bin/dash\nexec real\n'), real = write(s.b, 'bin/.asight-real/aa', 'OLD PROGRAM')
  m.files.push({ phase: 'install', kind: 'owned-file', role: 'wrapper', harness: 'aa', path: bin, real, sha256: sha(bin), real_sha256: sha(real) })
  m.entries.push({ phase: 'install', kind: 'root-key', harness: null, path: 'file:/k', custody: { kind: 'file', id: '/k' }, fp256: 'AB' })
  fs.writeFileSync(bin, 'NEW PROGRAM') // the agent's update replaced it by name
  const r = await s.run({ manifest: m, dropCa: true })
  assert.deepEqual([fs.readFileSync(bin, 'utf8'), fs.existsSync(real), r.removed.includes(real)], ['NEW PROGRAM', false, true])
  assert.deepEqual(r.left.map((l) => [l.path, l.result]), [['file:/k', 'error']])
  assert.match(r.left[0].reason, /no custody backend.*by hand: rm \/k/)
})

test('P13 liveness.<h> may carry on_at / off_at or not: the judgement is the same and the fields are kept', async () => {
  const pick = (b) => [repH(b, 'aa'), repH(b, 'bb')]
  const s = await setup(pick), plain = await setup(pick)
  const m = readManifest(s.b.dir)
  m.liveness.bb = { ...(m.liveness.bb || {}), on_at: '2026-10-15T00:00:00.000Z', off_at: null }
  const without = await plain.run({ ids: ['aa'] })
  const r = await s.run({ manifest: m, ids: ['aa'] })
  assert.deepEqual(r.results.map((x) => x.result), without.results.map((x) => x.result))
  assert.deepEqual(readManifest(s.b.dir).liveness.bb.on_at, '2026-10-15T00:00:00.000Z')
})

test('an entry of a kind this build does not know is left alone, and so is a manifest of a version it does not read (R3)', async () => {
  const s = await setup((b) => [repH(b, 'aa')])
  const m = readManifest(s.b.dir)
  m.entries.push({ phase: 'on', kind: 'mystery', harness: 'aa', path: path.join(s.b.home, 'x'), undo_by_hand: 'rm x' })
  const r = await s.run({ manifest: m })
  assert.deepEqual([r.results.length, r.manifest.entries.map((e) => e.kind)], [1, ['mystery']], 'the one it knows is undone, the one it does not stays')
  assert.deepEqual(r.left.map((l) => [l.path, l.harness, l.result]), [[path.join(s.b.home, 'x'), 'aa', 'unknown-kind']], 'and it is said by undoHarnesses itself, so no caller (off, asight-off, uninstall) can forget it (1.6 R3)')
  assert.match(r.left[0].reason, /kind "mystery", which this build does not undo; by hand: rm x/)
  // another harness's unknown item is not this run's; an entry that names no harness is said by a run for everything, never by one for some
  const m2 = readManifest(s.b.dir)
  m2.entries.push({ phase: 'on', kind: 'mystery', harness: 'bb', path: '/y', undo_by_hand: 'rm y' }, { phase: 'on', kind: 'text', path: '/z', line: 'x', format: 'line', undo_by_hand: 'edit z' }, { phase: 'on', kind: 'legacy-env', path: '/legacy', undo_by_hand: 'unset it' })
  assert.deepEqual((await s.run({ manifest: m2, ids: ['aa'] })).left.map((l) => l.path), [path.join(s.b.home, 'x')], 'a run for aa says aa\'s item and not bb\'s or the one with no harness')
  const all = await s.run({ manifest: m2 })
  assert.deepEqual(all.left.map((l) => [l.path, l.result]), [[path.join(s.b.home, 'x'), 'unknown-kind'], ['/y', 'unknown-kind'], ['/z', 'unknown-kind']], 'a run for everything says all three; a kind of the old capture\'s ledger is known: the legacy undo takes it')
  assert.match(all.left[2].reason, /names no harness/)
  // a file of a kind it does not know is not touched whatever its role, and is said the same way
  const t = await setup((b) => [plugH(b)])
  const m3 = readManifest(t.b.dir)
  const plugin = m3.files.find((f) => f.role === 'plugin' && f.path.endsWith('asight-ca.js'))
  Object.assign(plugin, { kind: 'future-file', undo_by_hand: 'rm the plugin' })
  const r3 = await t.run({ manifest: m3 })
  assert.deepEqual([r3.left.map((l) => [l.path, l.harness, l.result]), fs.existsSync(plugin.path), r3.removed.includes(plugin.path), r3.manifest.files.includes(plugin)], [[[plugin.path, 'plug', 'unknown-kind']], true, false, true], 'kept on disk and in the manifest; the plugin dir asight owns, of a kind it knows, still went')
  await assert.rejects(undoHarnesses({ dir: s.b.dir, home: s.b.home, manifest: { version: 3, unsupported: true, entries: [], files: [] }, ids: null }), /version 3.*nothing was changed/)
})

test('residue and changed plugins are reported, not deleted: a path the agent wrote because of the plugin; a plugin file edited since install (removed all the same)', async () => {
  const s = await setup((b) => [plugH(b)])
  fs.mkdirSync(path.join(s.b.home, '.config', 'plug', 'node_modules', 'sdk'), { recursive: true })
  const plugin = path.join(s.b.home, '.config', 'plug', 'plugins', 'asight-ca.js'); fs.appendFileSync(plugin, '// edited\n')
  const r = await s.run()
  assert.deepEqual(r.residue, [{ harness: 'plug', path: path.join(s.b.home, '.config', 'plug', 'node_modules'), why: 'plug installs its SDK on first run' }])
  assert.ok(fs.existsSync(path.join(s.b.home, '.config', 'plug', 'node_modules', 'sdk')), 'never deleted')
  assert.deepEqual([r.changed, r.removed.includes(plugin), fs.existsSync(plugin)], [[{ harness: 'plug', path: plugin, role: 'plugin' }], true, false])
  assert.deepEqual(r.manifest.watched, [], 'reported once: the harness has nothing left')
})

test('bundle: a process of the harness that started after install, one that re-reads its entry, or a child whose environ names it keeps the bundle without the asight CA; one from before install does not; the next run removes it', async () => {
  const s = await setup((b) => [repH(b, 'aa'), repH(b, 'bb', { rereadsEntry: true })])
  const installedAt = Date.parse(readManifest(s.b.dir).entries[0].installed_at)
  const table = [proc(70, '/x/aa', { startedAt: installedAt + 1000 }), proc(71, '/bin/git', { startedAt: installedAt + 2000, env: { SSL_CERT_FILE: s.b.ca('combined-aa.pem') } }), proc(72, '/x/aa', { startedAt: installedAt - 60000 }), proc(73, '/x/bb', { startedAt: 1 }), proc(74, '/x/aa', { startedAt: null })]
  const asightFp = certBlocks(fs.readFileSync(s.b.ca('asight-ca.pem'), 'utf8'))[0].fp
  const r = await s.run({ procs: async () => table })
  assert.deepEqual(r.kept_bundles, [{ path: s.b.ca('combined-aa.pem'), harness: 'aa', pids: [70, 71, 74] }, { path: s.b.ca('combined-bb.pem'), harness: 'bb', pids: [73] }], 'started after install, inherited it, or start time unknown; bb re-reads, so even the one from before counts; pid 72 predates install')
  const without = composeBundle({ nodeRoots: roots.node, osRootsText: '', userCerts: [CORP.certPem], caPem: null }).data
  assert.equal(fs.readFileSync(s.b.ca('combined-aa.pem'), 'utf8'), without, 'the same bundle, without the asight CA, byte for byte what composing it without gives')
  assert.ok(!fpsOf(s.b.ca('combined-bb.pem')).includes(asightFp))
  assert.deepEqual([r.left, r.manifest.files.filter((f) => f.role === 'bundle').map((f) => [path.basename(f.path), f.without_ca])], [[], [['combined-aa.pem', true], ['combined-bb.pem', true]]], 'kept: still in the manifest')
  const again = await s.run({ manifest: r.manifest, procs: async () => [proc(72, '/x/aa', { startedAt: installedAt - 60000 })] })
  assert.deepEqual([again.kept_bundles, again.removed.map((p) => path.basename(p)).sort(), fs.readdirSync(s.b.ca('.')).sort()], [[], ['combined-aa.pem', 'combined-bb.pem'], ['asight-ca.pem', 'ca.key']], 'nobody holds them now (or never could)')
})

test('bundle gone while a live process may use it: rebuilt without the CA from Node\'s roots and the recorded user CAs (said), a lost source named; nobody uses it: nothing is made; no roots given: an item left', async () => {
  const s = await setup((b) => [repH(b, 'aa'), repH(b, 'bb')])
  const live = [proc(70, '/x/aa'), proc(71, '/x/bb')]
  fs.rmSync(s.b.ca('combined-aa.pem')); fs.rmSync(s.b.ca('combined-bb.pem')); fs.rmSync(path.join(s.b.home, 'corp.pem'))
  const r = await s.run({ ids: ['aa'], procs: async () => live, roots: { node: [ROOT.certPem], osText: OSROOT.certPem } })
  const aa = s.b.ca('combined-aa.pem')
  assert.deepEqual(r.kept_bundles.map((k) => [k.harness, k.pids, k.rebuilt, k.lost_fps?.length, k.unread?.map((u) => u.errno)]), [['aa', [70], true, 1, ['ENOENT']]], 'rebuilt, and the user CA that could not be carried over is named with its errno')
  assert.deepEqual(fpsOf(aa), [ROOT, OSROOT].flatMap((c) => certBlocks(c.certPem).map((x) => x.fp)), 'Node\'s roots and the OS roots; the user CA source is gone, and the asight CA is not in it')
  assert.ok(!fs.existsSync(s.b.ca('combined-bb.pem')), 'bb was not asked about (ids)')
  const none = await s.run({ ids: ['bb'], procs: async () => [] })
  assert.deepEqual([none.kept_bundles, none.left, fs.existsSync(s.b.ca('combined-bb.pem'))], [[], [], false], 'nobody uses a missing bundle: it is just dropped')
  const t = await setup((b) => [repH(b, 'aa')]); fs.rmSync(t.b.ca('combined-aa.pem'))
  const noRoots = await t.run({ procs: async () => [proc(70, '/x/aa')], roots: null })
  assert.deepEqual([noRoots.left.map((l) => l.result), noRoots.kept_bundles.map((k) => [k.pids, k.error]), fs.existsSync(t.b.ca('combined-aa.pem'))], [['error'], [[[70], 'no trusted roots were given to rebuild it from']], false])
})

test('bundle that cannot be read: with a live process it still holds the CA (an item left, kept as it is); nobody holds it: removed whatever it is', async () => {
  const s = await setup((b) => [repH(b, 'aa'), repH(b, 'bb')])
  for (const n of ['combined-aa.pem', 'combined-bb.pem']) { fs.rmSync(s.b.ca(n)); fs.mkdirSync(s.b.ca(n)) } // EISDIR
  const r = await s.run({ procs: async () => [proc(70, '/x/aa')] })
  assert.deepEqual(r.kept_bundles, [{ path: s.b.ca('combined-aa.pem'), harness: 'aa', pids: [70], holds_ca: true, error: 'EISDIR' }])
  assert.deepEqual(r.left.map((l) => [l.path, l.harness, l.result]), [[s.b.ca('combined-aa.pem'), 'aa', 'error']])
  assert.match(r.left[0].reason, /still holds the asight CA.*EISDIR.*pid 70/)
  assert.ok(!fs.existsSync(s.b.ca('combined-bb.pem')), 'the one nobody holds is gone')
})

test('extra trust file: only a process whose environ names it keeps it (stripped); it is not judged by harness; a gone one is dropped', async () => {
  const s = await setup((b) => [jsonH(b)])
  const extra = s.b.ca('extra-jj.pem')
  const r = await s.run({ procs: async () => [proc(70, '/x/jj', { startedAt: 1 }), proc(71, '/bin/node', { env: { NODE_EXTRA_CA_CERTS: extra } })] })
  assert.deepEqual(r.kept_bundles, [{ path: extra, harness: 'jj', pids: [71] }], 'the jj process itself is not a holder of an extra file')
  assert.deepEqual(fpsOf(extra), [certBlocks(CORP.certPem)[0].fp], 'the user\'s CA stays, the asight CA is out')
  const gone = await s.run({ manifest: r.manifest, procs: async () => [proc(71, '/bin/node', { env: { NODE_EXTRA_CA_CERTS: extra } })] })
  assert.deepEqual([gone.kept_bundles.length, fs.existsSync(extra)], [1, true], 'still held: kept again, stripped already')
  fs.rmSync(extra)
  const dropped = await s.run({ manifest: gone.manifest, procs: async () => [proc(71, '/bin/node', { env: { NODE_EXTRA_CA_CERTS: extra } })] })
  assert.deepEqual([dropped.kept_bundles, dropped.left, dropped.manifest.files.filter((f) => f.role === 'trust-file')], [[], [], []])
})

test('an extra trust file whose holder\'s environment cannot be read: a process of the harness, or one started by it, with an unreadable environ makes it "not known" (kept without the CA, an item left); an unreadable one that is nothing of the harness\'s does not (D-20)', async () => {
  const s = await setup((b) => [jsonH(b)])
  const extra = s.b.ca('extra-jj.pem')
  const jj = proc(70, '/x/jj', { startedAt: 1 })
  const helper = proc(90, '/usr/libexec/asight-helper', { env: null }) // non-dumpable, started by init: nothing of jj's
  const asightFp = certBlocks(fs.readFileSync(s.b.ca('asight-ca.pem'), 'utf8'))[0].fp
  const gone = await s.run({ procs: async () => [jj, helper] })
  assert.deepEqual([gone.kept_bundles, gone.left, fs.existsSync(extra)], [[], [], false], 'an unreadable environ that descends from no jj process is not a holder: removed as ever')
  // a child of jj, and a grandchild of it, whose environ cannot be read; one that started before the file existed cannot hold it. Their start
  // times are set from the install of the sandbox that judges them: one installed more than a second after another (a slow setup) would see
  // a child timed from the other's as older than its file
  const installedAt = (x) => Date.parse(readManifest(x.b.dir).entries[0].installed_at)
  const kin = (x) => [proc(71, '/bin/sh', { ppid: 70, startedAt: installedAt(x) + 1000, env: null }), proc(72, '/usr/bin/node', { ppid: 71, startedAt: installedAt(x) + 2000, env: null })]
  const t = await setup((b) => [jsonH(b)])
  const tExtra = t.b.ca('extra-jj.pem')
  const older = proc(73, '/bin/old', { ppid: 70, startedAt: installedAt(t) - 60000, env: null })
  const one = await t.run({ procs: async () => [jj, helper, older] })
  assert.deepEqual([one.kept_bundles, one.left, fs.existsSync(tExtra)], [[], [], false], 'started before the install: it cannot have inherited a path that was not there')
  const u = await setup((b) => [jsonH(b)])
  const [child, grand] = kin(u)
  const r = await u.run({ procs: async () => [jj, child, grand, helper] })
  const kept = u.b.ca('extra-jj.pem')
  assert.deepEqual(r.kept_bundles.map((k) => [k.path, k.harness, k.pids, k.unjudged, /pid 71, 72, a running jj process or one started by it, cannot be read/.test(k.error)]), [[kept, 'jj', [], true, true]], 'pid 71 and its child 72 are named; the helper is not')
  assert.deepEqual([r.left.map((l) => [l.path, l.result]), fs.existsSync(kept), fpsOf(kept).includes(asightFp), fpsOf(kept).length], [[[kept, 'error']], true, false, 1], 'kept without the asight CA, with the user\'s')
  assert.match(r.left[0].reason, /kept, without the asight CA, because whether a running process holds it is not known \(the environment of pid 71, 72/)
  // they go: the next run removes it
  const next = await u.run({ manifest: r.manifest, procs: async () => [jj, helper] })
  assert.deepEqual([next.kept_bundles, next.left, fs.existsSync(kept)], [[], [], false])
  // a holder that can be read decides on its own: the unreadable ones of jj's, which alone would make it "not known", add nothing
  const w = await setup((b) => [jsonH(b)])
  const known = await w.run({ procs: async () => [proc(74, '/bin/node', { env: { NODE_EXTRA_CA_CERTS: w.b.ca('extra-jj.pem') } }), jj, ...kin(w)] })
  assert.deepEqual(known.kept_bundles, [{ path: w.b.ca('extra-jj.pem'), harness: 'jj', pids: [74] }])
})

test('a process table that cannot be read is not "nobody is alive": the bundle is kept without the CA and unjudged, an item left; so is a harness with no liveness record while a process that may have read its entry runs — with none, nobody holds it', async () => {
  const s = await setup((b) => [repH(b, 'aa')])
  const r = await s.run({ procs: async () => { throw new Error('ps: boom') } })
  assert.deepEqual(r.kept_bundles, [{ path: s.b.ca('combined-aa.pem'), harness: 'aa', pids: [], unjudged: true, error: 'ps: boom' }])
  assert.deepEqual([r.left.map((l) => l.result), r.procs_error, fpsOf(s.b.ca('combined-aa.pem')).length], [['error'], 'ps: boom', 2], 'kept, with Node\'s root and the user CA, not the asight CA')
  const t = await setup((b) => [repH(b, 'aa')])
  const m = readManifest(t.b.dir); delete m.liveness.aa // a manifest written before the snapshot existed
  const old = await t.run({ manifest: m, procs: async () => [proc(91, '/x/anything', { env: null })] }) // nothing says whether it is an aa
  assert.deepEqual([old.kept_bundles.map((k) => [k.unjudged, /no liveness record for aa/.test(k.error)]), old.left.length, old.trust_unknown.map((x) => [x.harness, /no liveness record for aa/.test(x.why)])], [[[true, true]], 1, [['aa', true]]], 'step 5 says why in the same words as the files')
  const u = await setup((b) => [repH(b, 'aa')])
  const t0 = Date.parse(readManifest(u.b.dir).entries[0].installed_at)
  const n = readManifest(u.b.dir); delete n.liveness.aa
  const none = await u.run({ manifest: n, procs: async () => [proc(92, '/x/older', { startedAt: t0 - 60000 }), proc(93, '/x/older', { startedAt: t0 - 1 })] }) // no record: whether aa re-reads is not known either, so alive is enough
  assert.deepEqual([none.kept_bundles.map((k) => k.unjudged), none.left.length], [[true], 1], 'with no record, an older process may still be an aa that re-reads its entry')
  const v = await setup((b) => [repH(b, 'aa')])
  const q = readManifest(v.b.dir); delete q.liveness.aa.identity // a record with no identity (nor an older signature): whether aa re-reads IS known (it does not)
  const older = await v.run({ manifest: q, procs: async () => [proc(94, '/x/older', { startedAt: t0 - 60000 })] })
  assert.deepEqual([older.kept_bundles, older.left, older.trust_unknown, fs.existsSync(v.b.ca('combined-aa.pem'))], [[], [], [], false], 'no process that may have read the entry: nobody holds the bundle, signature or not')
})

test('step 5: only a process that may have read the entry is reported, with until from the snapshot; untilEnviron limits it to a process whose environ names a file of asight\'s — where the OS never shows an environment (macOS, Windows) such a process is reported, one whose read failed is not', async () => {
  const s = await setup((b) => [repH(b, 'aa', { afterUninstall: 'next-connection' }), { ...repH(b, 'bb', { afterUninstall: 'restart', untilEnviron: 'SSL_CERT_FILE' }) }, jsonH(b)])
  const t0 = Date.parse(readManifest(s.b.dir).entries[0].installed_at)
  const r = await s.run({ ids: ['aa', 'bb', 'jj'], procs: async () => [
    proc(1, '/x/aa', { startedAt: t0 - 60000 }), proc(2, '/x/aa', { startedAt: t0 + 1000 }), // before install: it never named the bundle
    proc(3, '/x/bb', { startedAt: t0 + 1000 }), proc(4, '/x/bb', { startedAt: t0 + 1000, env: { SSL_CERT_FILE: s.b.ca('combined-bb.pem') } }), proc(5, '/x/bb', { startedAt: t0 + 1000, env: { SSL_CERT_FILE: '/corp/own.pem' } }),
    proc(6, '/x/jj', { startedAt: 1 }), // jj re-reads its entry: alive is enough, until the default
    proc(7, '/usr/bin/vim'),
    proc(8, '/x/bb', { startedAt: t0 + 1000, env: null }), // a read that failed (Linux): whether it went through asight's file is not known — not listed
    { ...proc(9, '/x/bb', { startedAt: t0 + 1000, env: null }), envRead: false }, // an environment the OS never shows: it may have, so it is listed
  ] })
  assert.deepEqual(r.still_trusting, [{ pid: 2, harness: 'aa', until: 'next-connection' }, { pid: 4, harness: 'bb', until: 'restart' }, { pid: 6, harness: 'jj', until: 'restart' }, { pid: 9, harness: 'bb', until: 'restart' }])
  const only = await setup((b) => [repH(b, 'aa'), repH(b, 'bb')])
  assert.deepEqual((await only.run({ ids: ['aa'], procs: async () => [proc(1, '/x/bb')] })).still_trusting, [], 'a process of a harness that was not undone is not reported')
})

test('a bundle nobody holds that cannot be removed still holds the CA: an item left with its reason, not a crash that leaves the rest undone; so is a CA file that cannot be removed', async () => {
  const s = await setup((b) => [repH(b, 'aa'), repH(b, 'bb')])
  const refuse = (names) => ({ ...fs, rmSync: (p, o) => { if (names.some((n) => String(p).endsWith(n))) throw Object.assign(new Error(`EACCES: permission denied, rm '${p}'`), { code: 'EACCES' }); return fs.rmSync(p, o) } })
  const r = await s.run({ fs: refuse(['combined-aa.pem', 'asight-ca.pem']), dropCa: true })
  assert.deepEqual(r.kept_bundles, [{ path: s.b.ca('combined-aa.pem'), harness: 'aa', pids: [], holds_ca: true, error: 'EACCES' }])
  assert.deepEqual(r.left.map((l) => [path.basename(l.path), l.harness, l.result]), [['combined-aa.pem', 'aa', 'error'], ['asight-ca.pem', null, 'error']])
  assert.match(r.left[0].reason, /held by no running process but could not be removed \(EACCES\).*still holds the asight CA/)
  assert.ok(!fs.existsSync(s.b.ca('combined-bb.pem')) && r.results.length === 2, 'the other harness and every entry were still undone')
  assert.deepEqual(r.manifest.files.filter((f) => f.role === 'bundle' || f.role === 'ca-cert').map((f) => path.basename(f.path)).sort(), ['asight-ca.pem', 'combined-aa.pem'], 'what is left stays in the manifest')
})

test('an entry step 1 could not undo still names its bundle: the bundle is kept without the asight CA, held or not (no bundle, no network at the agent\'s next start), rebuilt when gone, and removed once the entry is undone (4.6 安装 / 卸载不静默)', async () => {
  const s = await setup((b) => [repH(b, 'aa'), repH(b, 'bb')])
  const asightFp = certBlocks(fs.readFileSync(s.b.ca('asight-ca.pem'), 'utf8'))[0].fp
  const bundle = s.b.ca('combined-aa.pem')
  const installed = fs.readFileSync(s.user[0])
  fs.rmSync(s.user[0]); fs.symlinkSync(write(s.b, 'elsewhere.env', 'X=1\n'), s.user[0]) // aa's .env is a link to some other file now: left-link
  const r = await s.run()
  assert.deepEqual(r.results.map((x) => [path.basename(path.dirname(x.path)), x.result]).sort(), [['.aa', 'left-link'], ['.bb', 'restored']])
  assert.equal(fs.readFileSync(bundle, 'utf8'), composeBundle({ nodeRoots: roots.node, osRootsText: '', userCerts: [CORP.certPem], caPem: null }).data, 'kept: the same bundle without the asight CA, byte for byte')
  assert.ok(!fpsOf(bundle).includes(asightFp) && !fs.existsSync(s.b.ca('combined-bb.pem')), 'bb\'s entry is out, so nobody needs its bundle')
  assert.deepEqual(r.kept_bundles, [{ path: bundle, harness: 'aa', pids: [], entry_left: [s.user[0]] }], 'nobody holds it: it is the entry that keeps it')
  assert.deepEqual(r.left.map((l) => [path.basename(l.path), l.harness, l.result]), [['.env', 'aa', 'left-link'], ['combined-aa.pem', 'aa', 'error']], 'the entry, and the bundle that stays because of it')
  assert.match(r.left[1].reason, /kept, without the asight CA.*\.env, which could not be undone, still points at it/)
  assert.deepEqual([r.manifest.entries.map((e) => e.harness), r.manifest.files.filter((f) => f.role === 'bundle').map((f) => [path.basename(f.path), f.without_ca])], [['aa'], [['combined-aa.pem', true]]], 'both stay in the manifest')
  // a bundle that is gone while the entry stands is rebuilt (nobody needs to be running: the next start reads it)
  fs.rmSync(bundle)
  const gone = await s.run({ manifest: r.manifest })
  assert.deepEqual([gone.kept_bundles.map((k) => [k.rebuilt, k.entry_left?.length]), fpsOf(bundle)], [[[true, 1]], [ROOT, CORP].flatMap((c) => certBlocks(c.certPem).map((x) => x.fp))], 'rebuilt without the CA from Node\'s roots and the recorded user CA')
  // the entry is fixed: the next run undoes it and nobody needs the bundle
  fs.rmSync(s.user[0]); fs.writeFileSync(s.user[0], installed)
  const done = await s.run({ manifest: gone.manifest })
  assert.deepEqual([done.results.map((x) => x.result), done.left, done.kept_bundles, fs.existsSync(bundle), fs.readFileSync(s.user[0], 'utf8')], [['restored'], [], [], false, 'KEY_A=sk-a\n'])
  // a run for another harness leaves aa's alone: not its entry, so not its bundle
  const t = await setup((b) => [repH(b, 'aa'), repH(b, 'bb')])
  fs.rmSync(t.user[0]); fs.symlinkSync(write(t.b, 'elsewhere.env', 'X=1\n'), t.user[0])
  const bb = await t.run({ ids: ['bb'] })
  assert.deepEqual([bb.left, bb.kept_bundles, fs.existsSync(t.b.ca('combined-aa.pem'))], [[], [], true], 'aa is not in this run (nothing of it is touched)')
})

test('uninstall twice with a process still holding a kept bundle: the second run finds it as the first left it — without the CA, whose certificate the first run removed — and says the same, not "still holds the asight CA"', async () => {
  const s = await setup((b) => [repH(b, 'aa'), jsonH(b)])
  const live = [proc(70, '/x/aa'), proc(71, '/bin/node', { env: { NODE_EXTRA_CA_CERTS: s.b.ca('extra-jj.pem') } })]
  const first = await s.run({ procs: async () => live, dropCa: true })
  assert.ok(!fs.existsSync(s.b.ca('asight-ca.pem')), 'the first run removed the CA certificate')
  const expected = [{ path: s.b.ca('combined-aa.pem'), harness: 'aa', pids: [70] }, { path: s.b.ca('extra-jj.pem'), harness: 'jj', pids: [71] }]
  assert.deepEqual([first.kept_bundles, first.left], [expected, []])
  const sha = (f) => sha256(fs.readFileSync(f))
  const files = [s.b.ca('combined-aa.pem'), s.b.ca('extra-jj.pem')]; const bytes = files.map(sha)
  const second = await s.run({ procs: async () => live, dropCa: true }) // the manifest as the first run saved it
  assert.deepEqual([second.kept_bundles, second.left, files.map(sha)], [expected, [], bytes], 'kept the same way, nothing to say, the files as they were')
  // a file that is not what the first run wrote cannot be called stripped without the CA to look for: that stays the honest answer
  fs.appendFileSync(files[0], '\n')
  const edited = await s.run({ procs: async () => live, dropCa: true })
  assert.deepEqual(edited.kept_bundles.map((k) => [k.harness, k.holds_ca ?? false, k.error ?? null]), [['aa', true, 'ENOENT'], ['jj', false, null]], 'the edited one still holds what it held (its CA cannot be named: ENOENT); the untouched one is as before')
  assert.deepEqual(edited.left.map((l) => [l.harness, l.result]), [['aa', 'error']])
  const gone = await s.run({ procs: async () => [], dropCa: true })
  assert.deepEqual([gone.kept_bundles, gone.left, files.some((f) => fs.existsSync(f))], [[], [], false], 'nobody holds them now: both go')
})

// The audit's HIGH finding (semantics 1): `off` deleted the bundle a .env still named, reporting success, because the removal read only the bytes asight wrote.
// A dangling SSL_CERT_FILE replaces the agent's whole trust store with a file that is not there: an agent with no network at all (1.6 §1.1: the reason `off` removes entries).
const NAMES = (s, n) => fs.readFileSync(s.user[n], 'utf8').includes(path.basename(s.b.ca('combined-aa.pem')))
for (const [form, edit] of [
  ['CRLF', (t) => t.replace(/\n/g, '\r\n')],
  ['trailing blanks', (t) => t.replace(/\n/g, '  \n')],
  ['indented', (t) => t.replace(/^(?=.)/gm, '\t')],
  ['export prefix', (t) => t.replace(/^SSL_CERT_FILE=/m, 'export SSL_CERT_FILE=')],
  ['spaces around =', (t) => t.replace(/^SSL_CERT_FILE=/m, 'SSL_CERT_FILE = ')],
  ['quoted value', (t) => t.replace(/^SSL_CERT_FILE=(.*)$/m, 'SSL_CERT_FILE="$1"')],
]) {
  test(`a dotenv block an editor has rewritten (${form}) is still found: the entry is undone, not "already removed", and the bundle goes only with it — never an entry that names a bundle that is gone`, async () => {
    const s = await setup((b) => [repH(b, 'aa'), repH(b, 'bb')])
    fs.writeFileSync(s.user[0], edit(fs.readFileSync(s.user[0], 'utf8')))
    const r = await s.run()
    const row = r.results.find((x) => x.path === s.user[0])
    assert.equal(row.result, 'reverted-not-identical', 'the asight text was found and taken out')
    assert.deepEqual([r.left, NAMES(s, 0), fs.existsSync(s.b.ca('combined-aa.pem'))], [[], false, false], 'no entry left, none names the bundle, so the bundle is removed')
    assert.equal(fs.readFileSync(s.user[0], 'utf8').replace(/\r/g, '').trim(), 'KEY_A=sk-a', 'the user\'s own line is all that is left')
  })
}

test('asight\'s text in a shape the removal cannot read is NOT "already removed": the file is not touched, the entry is left (left-text, exit 1 through the receipt), and the bundle it names is kept without the CA, with the line numbers and the command that puts the file back from its backup (R2)', async () => {
  const s = await setup((b) => [repH(b, 'aa'), repH(b, 'bb')])
  const bundle = s.b.ca('combined-aa.pem')
  const asightFp = certBlocks(fs.readFileSync(s.b.ca('asight-ca.pem'), 'utf8'))[0].fp
  const m = readManifest(s.b.dir)
  const backup = m.entries.find((e) => e.path === s.user[0]).backup
  const edited = fs.readFileSync(s.user[0], 'utf8').replace(/^SSL_CERT_FILE=(.*)$/m, 'SSL_CERT_FILE=$1;') // a trailing `;`: not a form the removal reads
  fs.writeFileSync(s.user[0], edited)
  const r = await s.run({ manifest: m })
  assert.equal(r.results.find((x) => x.path === s.user[0]).result, 'left-text')
  assert.equal(fs.readFileSync(s.user[0], 'utf8'), edited, 'not one byte of the file was changed')
  assert.deepEqual(r.left.filter((l) => l.result === 'left-text').map((l) => [l.path, l.harness]), [[s.user[0], 'aa']])
  const l = r.left[0]
  assert.match(l.reason, /still names asight's block with SSL_CERT_FILE=.* on line 2,/)
  assert.equal(l.backup, backup)
  assert.equal(l.restore, `cp ${backup} ${s.user[0]}`, 'the command that puts the file back as it was, from its backup')
  assert.match(l.reason, /by hand: cp .* \(puts the whole file back as it was before asight, so every change made to it since is lost\)/)
  assert.equal(fs.existsSync(backup), true, 'the backup stays')
  assert.ok(fs.existsSync(bundle) && !fpsOf(bundle).includes(asightFp), 'the bundle is kept, without the asight CA: the .env still points at it')
  assert.deepEqual(r.kept_bundles.map((k) => [k.path, k.entry_left]), [[bundle, [s.user[0]]]])
  assert.deepEqual(r.manifest.entries.map((e) => e.path), [s.user[0]], 'the entry stays in the manifest, for the next run')
  // fixed by hand: the next run undoes it and the bundle goes
  fs.writeFileSync(s.user[0], edited.replace(`;\n`, '\n').replace(/^.*(?:asight collector).*\n/gm, '').replace(/^SSL_CERT_FILE=.*\n/m, ''))
  const done = await s.run({ manifest: r.manifest })
  assert.deepEqual([done.left, fs.existsSync(bundle)], [[], false])
})

test('before a bundle is removed the entry files of its harness are read again: an entry reported as the user\'s own value whose file still names the bundle (the key was moved) keeps it — without the CA, the entry put back among the ones left', async () => {
  const repJson = (b, name) => ({
    name, runtime: 'rust', processes: { names: [{ name }] }, hosts: [], trust: { chain: [{ var: 'SSL_CERT_FILE', semantic: 'replace' }] },
    inject: (ctx) => ({ entries: [{ kind: 'json-key', path: path.join(ctx.home, `.${name}`, 'settings.json'), keys: ['env', 'SSL_CERT_FILE'], value: b.ca(`combined-${name}.pem`), semantic: 'replace' }], files: [{ path: b.ca(`combined-${name}.pem`), bundle: true, certsFrom: [path.join(ctx.home, 'corp.pem')] }] }),
  })
  const b = box()
  write(b, 'corp.pem', CORP.certPem); write(b, '.jr/settings.json', '{\n  "model": "m"\n}\n')
  await installCollector({ home: b.home, env: { HOME: b.home }, osName: 'none', harnesses: [repJson(b, 'jr')], freePort: async () => 47011, roots })
  const file = path.join(b.home, '.jr', 'settings.json'), bundle = b.ca('combined-jr.pem')
  const moved = JSON.stringify({ model: 'm', SSL_CERT_FILE: bundle, env: {} }, null, 2) + '\n' // the key is not where asight put it: its value there is "the user's"
  fs.writeFileSync(file, moved)
  const r = await undoHarnesses({ dir: b.dir, home: b.home, manifest: readManifest(b.dir), ids: null, procs: async () => [], roots })
  assert.equal(r.results.find((x) => x.path === file).result, 'left-user-value', 'step 1 took the key for the user\'s')
  assert.equal(fs.readFileSync(file, 'utf8'), moved)
  assert.ok(fs.existsSync(bundle), 'the bundle is not taken away from under a file that names it')
  assert.deepEqual(r.kept_bundles.map((k) => [k.path, k.entry_left]), [[bundle, [file]]])
  assert.deepEqual(r.left.map((l) => [l.path, l.result]), [[file, 'left-text'], [bundle, 'error']].filter(([p]) => p === file || p === bundle))
  assert.match(r.left[0].reason, /still names .*combined-jr\.pem, the bundle asight made for jr, though its entry was reported as undone/)
  assert.deepEqual(r.manifest.entries.map((e) => e.path), [file], 'the entry is put back for the next run')
})

test('an entry that cannot be undone gives its backup and the cp command that puts the file back, and what that loses (R2) — in `reason` and as `backup` / `restore`; one without a backup (asight made the file) gives neither', async () => {
  const s = await setup((b) => [repH(b, 'aa'), jsonH(b)])
  const m = readManifest(s.b.dir)
  const backup = m.entries.find((e) => e.path === s.user[2]).backup
  fs.writeFileSync(s.user[2], fs.readFileSync(s.user[2], 'utf8') + ' trailing garbage')
  const r = await s.run({ manifest: m })
  const l = r.left.find((x) => x.path === s.user[2])
  assert.deepEqual([l.result, l.backup, l.restore], ['left-unparsable', backup, `cp ${backup} ${s.user[2]}`])
  assert.match(l.reason, new RegExp(`asight cannot read it \\(line \\d+, column \\d+\\); asight's env\\.NODE_EXTRA_CA_CERTS.*kept at ${backup.replace(/[.\\]/g, '\\$&')}.*by hand: cp .*every change made to it since is lost`))
  // a path with a space is quoted so the line can be pasted
  const q = restoreByHand({ backup: '/h/.asight/backup/x y', path: "/h/it's here/settings.json" })
  assert.equal(q.command, `cp '/h/.asight/backup/x y' '/h/it'\\''s here/settings.json'`)
  assert.equal(restoreByHand({ backup: null, path: '/p' }), null, 'a file asight created has no backup: nothing to put back')
  // through a symlink the file asight changed is the real one
  assert.equal(restoreByHand({ backup: '/b', path: '/link', real_path: '/real' }).command, 'cp /b /real')
})
