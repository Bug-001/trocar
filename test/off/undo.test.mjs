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
import { readManifest } from '../../src/off/manifest.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { certBlocks, composeBundle } from '../../src/off/pem.mjs'
import { lineComment } from '../../src/off/text-edit.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const ROOT = createCa({ commonName: 'undo root' }), CORP = createCa({ commonName: 'undo corp relay' })
const roots = { node: [ROOT.certPem], osText: '' }
const box = () => { const home = tmpDir('asight-undo-'); return { home, dir: path.join(home, '.asight', 'collector'), ca: (n) => path.join(home, '.asight', 'collector', 'ca', n) } }
const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null)
const fpsOf = (f) => certBlocks(fs.readFileSync(f, 'utf8')).map((c) => c.fp)
const write = (b, rel, text) => { const f = path.join(b.home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
const proc = (pid, exe, { startedAt = Date.now() + 5000, env = {}, argv = [exe] } = {}) => ({ pid, exe, argv, startedAt, env: () => new Map(Object.entries(env)) })

// a replace-semantics harness (Codex / Hermes shape): a dotenv block naming its own combined bundle
const repH = (b, name, extra = {}) => ({
  name, runtime: 'rust', signatures: { none: { match: [{ exe: new RegExp(`/${name}$`) }] } }, hosts: [], trust: { chain: [{ var: 'SSL_CERT_FILE', semantic: 'replace' }], ...extra },
  inject: (ctx) => ({
    entries: [{ kind: 'text', format: 'dotenv-block', path: path.join(ctx.home, `.${name}`, '.env'), vars: { SSL_CERT_FILE: b.ca(`combined-${name}.pem`) }, semantic: 'replace' }],
    files: [{ path: b.ca(`combined-${name}.pem`), bundle: true, certsFrom: [path.join(ctx.home, 'corp.pem')] }],
  }),
})
// an append-semantics harness (Claude Code shape): a JSON key naming an extra file that carries the user's CA
const jsonH = (b) => ({
  name: 'jj', runtime: 'node', signatures: { none: { match: [{ exe: /\/jj$/ }] } }, hosts: [], trust: { chain: [{ var: 'NODE_EXTRA_CA_CERTS', semantic: 'append' }], rereadsEntry: true },
  inject: (ctx) => ({ entries: [{ kind: 'json-key', path: path.join(ctx.home, '.jj', 'settings.json'), keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: b.ca('extra-jj.pem'), semantic: 'append' }], files: [{ path: b.ca('extra-jj.pem'), certsFrom: [path.join(ctx.home, 'corp.pem')] }] }),
})
// a plugin-style harness: a plugin file in the agent's directory, a YAML row loading asight's plugin dir, a path the agent may write because of it
const plugH = (b) => ({
  name: 'plug', runtime: 'node', signatures: { none: { match: [{ exe: /\/plug$/ }] } }, hosts: [], trust: { chain: [{ var: 'asight:marker', semantic: 'append' }] },
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
  assert.match(r.left[0].reason, /no longer valid JSON; asight's env\.NODE_EXTRA_CA_CERTS/)
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

test('an entry of a kind this build does not know is left alone, and so is a manifest of a version it does not read (R3)', async () => {
  const s = await setup((b) => [repH(b, 'aa')])
  const m = readManifest(s.b.dir)
  m.entries.push({ kind: 'mystery', harness: 'aa', path: path.join(s.b.home, 'x'), undo_by_hand: 'rm x' })
  const r = await s.run({ manifest: m })
  assert.deepEqual([r.results.length, r.manifest.entries.map((e) => e.kind)], [1, ['mystery']], 'the one it knows is undone, the one it does not stays')
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
  const r = await s.run({ ids: ['aa'], procs: async () => live })
  const aa = s.b.ca('combined-aa.pem')
  assert.deepEqual(r.kept_bundles.map((k) => [k.harness, k.pids, k.rebuilt, k.lost_fps?.length, k.unread?.map((u) => u.errno)]), [['aa', [70], true, 1, ['ENOENT']]], 'rebuilt, and the user CA that could not be carried over is named with its errno')
  assert.deepEqual(fpsOf(aa), certBlocks(ROOT.certPem).map((c) => c.fp), 'Node roots only: the user CA source is gone, and the asight CA is not in it')
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

test('a process table that cannot be read is not "nobody is alive": the bundle is kept without the CA and unjudged, an item left; so is a harness with no liveness record', async () => {
  const s = await setup((b) => [repH(b, 'aa')])
  const r = await s.run({ procs: async () => { throw new Error('ps: boom') } })
  assert.deepEqual(r.kept_bundles, [{ path: s.b.ca('combined-aa.pem'), harness: 'aa', pids: [], unjudged: true, error: 'ps: boom' }])
  assert.deepEqual([r.left.map((l) => l.result), r.procs_error, fpsOf(s.b.ca('combined-aa.pem')).length], [['error'], 'ps: boom', 2], 'kept, with Node\'s root and the user CA, not the asight CA')
  const t = await setup((b) => [repH(b, 'aa')])
  const m = readManifest(t.b.dir); delete m.liveness.aa // a manifest written before the snapshot existed
  const old = await t.run({ manifest: m })
  assert.deepEqual([old.kept_bundles.map((k) => [k.unjudged, /no liveness record for aa/.test(k.error)]), old.left.length], [[[true, true]], 1])
})

test('step 5: only a process that may have read the entry is reported, with until from the snapshot; untilEnviron limits it to a process whose environ names a file of asight\'s', async () => {
  const s = await setup((b) => [repH(b, 'aa', { afterUninstall: 'next-connection' }), { ...repH(b, 'bb', { afterUninstall: 'restart', untilEnviron: 'SSL_CERT_FILE' }) }, jsonH(b)])
  const t0 = Date.parse(readManifest(s.b.dir).entries[0].installed_at)
  const r = await s.run({ ids: ['aa', 'bb', 'jj'], procs: async () => [
    proc(1, '/x/aa', { startedAt: t0 - 60000 }), proc(2, '/x/aa', { startedAt: t0 + 1000 }), // before install: it never named the bundle
    proc(3, '/x/bb', { startedAt: t0 + 1000 }), proc(4, '/x/bb', { startedAt: t0 + 1000, env: { SSL_CERT_FILE: s.b.ca('combined-bb.pem') } }), proc(5, '/x/bb', { startedAt: t0 + 1000, env: { SSL_CERT_FILE: '/corp/own.pem' } }),
    proc(6, '/x/jj', { startedAt: 1 }), // jj re-reads its entry: alive is enough, until the default
    proc(7, '/usr/bin/vim'),
  ] })
  assert.deepEqual(r.still_trusting, [{ pid: 2, harness: 'aa', until: 'next-connection' }, { pid: 4, harness: 'bb', until: 'restart' }, { pid: 6, harness: 'jj', until: 'restart' }])
  const only = await setup((b) => [repH(b, 'aa'), repH(b, 'bb')])
  assert.deepEqual((await only.run({ ids: ['aa'], procs: async () => [proc(1, '/x/bb')] })).still_trusting, [], 'a process of a harness that was not undone is not reported')
})
