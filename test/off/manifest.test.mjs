// test/off/manifest.test.mjs — 1.6 R3: the install manifest carries a `version`, and every item carries a `kind` and one sentence of
// `undo_by_hand` (what to do without node); a version-1 manifest (written before D39) reads as version 2; a version this build does
// not know is flagged and never rewritten; an item of a kind this build does not know is listed so `off` can leave it alone.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MANIFEST_VERSION, KNOWN_KINDS, newManifest, readManifest, saveManifest, undoByHand, unknownItems, manifestPath } from '../../src/off/manifest.mjs'
import { applyJsonKey, applyTextEntry, writeOwnedFile } from '../../src/collector/core/trust/journal.mjs'
import { SENTINEL, OFF_PREFIX, lineComment } from '../../src/off/text-edit.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const T = new Date('2026-10-07T01:02:03.004Z')
const dirOf = () => { const home = tmpDir('asight-man-'); return { home, dir: path.join(home, '.asight', 'collector') } }
const writeRaw = (dir, obj) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(manifestPath(dir), JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 }) }

// What installCollector wrote before D39: version 1, no kind on a JSON entry, no backup, no undo_by_hand, no confirmed_paths /
// kept_backups / liveness. Copied from the shapes applyJsonKey / applyTextEntry / writeOwnedFile / install.mjs produced.
const H = '/home/u'
const V1 = () => ({
  version: 1, created_at: '2026-10-06T08:00:00.000Z', complete: true, engine_port: 47011,
  planned: [`${H}/.claude/settings.json`, `${H}/.codex/.env`, `${H}/.zshrc`],
  dirs: [`${H}/.asight`, `${H}/.asight/collector`, `${H}/.asight/collector/ca`],
  files: [
    { path: `${H}/.asight/collector/ca/ca.key`, role: 'ca-key' },
    { path: `${H}/.asight/collector/ca/asight-ca.pem`, role: 'ca-cert' },
    { path: `${H}/.asight/collector/ca/combined-codex.pem`, role: 'bundle', harness: 'codex', sha256: 'c0'.repeat(32), mode: 384, created_dirs: [], installed_at: '2026-10-06T08:00:01.000Z', user_fps: [], roots_fp: 'ab'.repeat(32) },
  ],
  watched: [{ path: `${H}/.config/x`, why: 'a plugin dir', harness: 'codex', existed_before: false }],
  entries: [
    { harness: 'claude-code', path: `${H}/.claude/settings.json`, keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: `${H}/.asight/collector/ca/asight-ca.pem`, existed_before: true, mode: 420, pre_sha256: 'aa'.repeat(32), post_sha256: 'bb'.repeat(32), ops: [{ offset: 10, removed: '', inserted: '"x"' }], prior_value: null, existing_depth: 1, created_dirs: [], installed_at: '2026-10-06T08:00:02.000Z' },
    { harness: 'claude-code', path: `${H}/.claude/other.json`, keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: '/new.pem', existed_before: true, mode: 420, pre_sha256: 'a1'.repeat(32), post_sha256: 'b1'.repeat(32), ops: [], prior_value: '/corp.pem', existing_depth: 2, created_dirs: [], installed_at: '2026-10-06T08:00:02.500Z' },
    { kind: 'text', harness: 'codex', path: `${H}/.codex/.env`, format: 'dotenv-block', vars: { SSL_CERT_FILE: `${H}/.asight/collector/ca/combined-codex.pem` }, existed_before: true, mode: 384, pre_sha256: 'cc'.repeat(32), post_sha256: 'dd'.repeat(32), ops: [{ offset: 0, removed: '', inserted: 'BLOCK' }], prior_value: { SSL_CERT_FILE: '/corp.pem' }, created_dirs: [], installed_at: '2026-10-06T08:00:03.000Z' },
    { kind: 'text', harness: 'kimi-code', path: `${H}/.zshrc`, format: 'line', line: 'export PATH="$HOME/.asight/shim:$PATH"', existed_before: true, mode: 420, pre_sha256: 'ee'.repeat(32), post_sha256: 'ff'.repeat(32), ops: [], prior_value: null, created_dirs: [], installed_at: '2026-10-06T08:00:04.000Z' },
  ],
})

test('R3: a version 1 manifest on disk reads as version 2: every entry has kind and a non-empty undo_by_hand, nothing else changes, the file is not rewritten', () => {
  const { dir } = dirOf(); const v1 = V1(); writeRaw(dir, v1)
  const before = fs.readFileSync(manifestPath(dir))
  const m = readManifest(dir)
  assert.equal(m.version, MANIFEST_VERSION); assert.equal(MANIFEST_VERSION, 2)
  assert.equal(m.upgraded_from, 1)
  assert.ok(!m.unsupported)
  assert.deepEqual(m.entries.map((e) => e.kind), ['json-key', 'json-key', 'text', 'text'], 'a JSON entry had no kind; a text entry already did')
  for (const e of m.entries) { assert.equal(e.backup, null, 'no backup existed before D39'); assert.ok(typeof e.undo_by_hand === 'string' && e.undo_by_hand.length > 10, e.path) }
  for (const f of m.files) { assert.equal(f.kind, 'owned-file', f.path); assert.match(f.undo_by_hand, new RegExp(f.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) }
  assert.deepEqual([m.confirmed_paths, m.kept_backups, m.liveness], [[], [], {}], 'the v2 top-level fields exist, empty')
  // everything v1 held is still there, as it was
  const strip = (o) => { const { kind, backup, undo_by_hand, ...rest } = o; return rest }
  assert.deepEqual(m.entries.map(strip), v1.entries.map(strip))
  assert.deepEqual(m.files.map(strip), v1.files.map(strip))
  assert.deepEqual([m.planned, m.dirs, m.watched, m.engine_port, m.complete, m.created_at], [v1.planned, v1.dirs, v1.watched, v1.engine_port, v1.complete, v1.created_at])
  assert.deepEqual(fs.readFileSync(manifestPath(dir)), before, 'reading never writes: a build that only looks leaves the v1 file for the build that wrote it')
})

test('R3: the manifest written by the journal is version 2 and every item, entries and files, has kind and undo_by_hand (also the ones pushed without)', () => {
  const { home, dir } = dirOf(); const m = newManifest(T)
  const json = path.join(home, '.claude', 'settings.json'); fs.mkdirSync(path.dirname(json)); fs.writeFileSync(json, '{"env":{}}\n')
  applyJsonKey({ home, dir, manifest: m, harness: 'claude-code', file: json, keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: '/ca.pem', now: T })
  applyTextEntry({ home, dir, manifest: m, harness: 'codex', file: path.join(home, '.codex', '.env'), edit: { format: 'dotenv-block', vars: { SSL_CERT_FILE: '/b.pem' } }, now: T })
  applyTextEntry({ home, dir, manifest: m, harness: 'kimi-code', file: path.join(home, '.zshrc'), edit: { format: 'line', line: `export PATH=x ${lineComment('kimi shim')}` }, now: T })
  writeOwnedFile({ dir, manifest: m, harness: 'codex', role: 'bundle', file: path.join(dir, 'ca', 'combined-codex.pem'), data: 'PEM\n', now: T })
  m.files.push({ path: path.join(dir, 'ca', 'ca.key'), role: 'ca-key' }) // what install.mjs pushes for the CA, with nothing else
  saveManifest(dir, m)
  const back = readManifest(dir)
  assert.equal(JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8')).version, 2)
  assert.ok(!('upgraded_from' in JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'))), 'a read-time fact is not saved')
  assert.deepEqual(back.entries.map((e) => e.kind), ['json-key', 'text', 'text'])
  assert.equal(back.files.length, 2)
  for (const it of [...back.entries, ...back.files]) { assert.ok(KNOWN_KINDS.includes(it.kind), `${it.path}: ${it.kind}`); assert.ok(it.undo_by_hand.length > 10, it.path) }
  assert.deepEqual(unknownItems(back), [])
  assert.equal(fs.statSync(manifestPath(dir)).mode & 0o777, 0o600)
})

test('R3: newManifest is version 2 with the new top-level fields empty, stamped with the time it is given', () => {
  assert.deepEqual(newManifest(T), { version: 2, created_at: '2026-10-07T01:02:03.004Z', complete: false, engine_port: null, planned: [], confirmed_paths: [], kept_backups: [], liveness: {}, dirs: [], files: [], entries: [] })
  assert.equal(newManifest().version, 2); assert.ok(Date.now() - Date.parse(newManifest().created_at) < 5000)
})

test('R3: a manifest of a version this build does not know is flagged unsupported, handed back as it is, and never saved over', () => {
  const { dir } = dirOf(); const v3 = { version: 3, complete: true, items: [{ path: '/x', kind: 'something-new' }], entries: [{ path: '/y' }] }; writeRaw(dir, v3)
  const before = fs.readFileSync(manifestPath(dir))
  const m = readManifest(dir)
  assert.equal(m.unsupported, true)
  assert.equal(m.version, 3, 'the version it really has')
  assert.deepEqual(m.items, v3.items); assert.deepEqual(m.entries, v3.entries, 'not normalized: this build does not know what the fields mean')
  assert.throws(() => saveManifest(dir, m), /version 3/, 'saving it would write version 2 shapes over version 3 data')
  assert.deepEqual(fs.readFileSync(manifestPath(dir)), before)
})

test('R3: a missing manifest is null; one that does not parse throws (never "nothing installed")', () => {
  const { dir } = dirOf()
  assert.equal(readManifest(dir), null)
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(manifestPath(dir), '{"version": 2, "entries": [')
  assert.throws(() => readManifest(dir), SyntaxError)
})

test('R3: unknownItems lists an entry or a file whose kind this build does not know, with its path and kind', () => {
  const m = newManifest(T)
  m.entries.push({ kind: 'json-key', path: '/a', keys: ['k'], value: 'v' }, { kind: 'mystery', path: '/b' })
  m.files.push({ kind: 'owned-file', path: '/c', role: 'unit' }, { kind: 'future-thing', path: '/d', role: 'x' })
  assert.deepEqual(unknownItems(m), [{ path: '/b', kind: 'mystery' }, { path: '/d', kind: 'future-thing' }])
  assert.deepEqual(unknownItems(newManifest(T)), [])
  assert.ok(KNOWN_KINDS.includes('legacy-clash-block') && !KNOWN_KINDS.includes('mystery'))
  // it survives a save and a read: the unknown item is kept as it was, not dropped and not "fixed"
  const { dir } = dirOf(); saveManifest(dir, m)
  assert.deepEqual(unknownItems(readManifest(dir)), [{ path: '/b', kind: 'mystery' }, { path: '/d', kind: 'future-thing' }])
  assert.equal(readManifest(dir).entries[1].kind, 'mystery')
})

test('R3: undoByHand says, in one sentence, how to take each kind of item out without node', () => {
  const jsonNew = undoByHand({ kind: 'json-key', path: '/h/.claude/settings.json', keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: '/ca.pem', prior_value: null })
  assert.match(jsonNew, /\/h\/\.claude\/settings\.json/); assert.match(jsonNew, /env\.NODE_EXTRA_CA_CERTS/); assert.match(jsonNew, /delete/i)
  const jsonPrior = undoByHand({ kind: 'json-key', path: '/h/s.json', keys: ['env', 'K'], value: '/ca.pem', prior_value: '/corp.pem' })
  assert.match(jsonPrior, /\/corp\.pem/); assert.match(jsonPrior, /env\.K/)
  const block = undoByHand({ kind: 'text', path: '/h/.codex/.env', format: 'dotenv-block', vars: { SSL_CERT_FILE: '/b.pem' } })
  assert.ok(block.includes(`# >>> ${SENTINEL} >>>`) && block.includes(`# <<< ${SENTINEL} <<<`), 'the sentinels the file really holds')
  assert.ok(block.includes(OFF_PREFIX.trimEnd()), 'and the prefix of a line asight put out of effect')
  const line = undoByHand({ kind: 'text', path: '/h/.zshrc', format: 'line', line: 'export PATH="$HOME/shim:$PATH"' })
  assert.ok(line.includes('/h/.zshrc') && line.includes(JSON.stringify('export PATH="$HOME/shim:$PATH"')))
  assert.equal(undoByHand({ kind: 'owned-file', path: '/h/.asight/collector/ca/x.pem' }), 'rm /h/.asight/collector/ca/x.pem')
  assert.match(undoByHand({ kind: 'json-key', path: '/h/n.json', keys: ['k'], value: 'v', prior_value: null, existed_before: false }), /created|did not exist/, 'a file asight created: delete it if nothing else is in it')
  // a kind this build does not know: what its writer recorded wins; with nothing recorded, never a made-up `rm`
  assert.equal(undoByHand({ kind: 'mystery', path: '/z', undo_by_hand: 'run the mystery tool' }), 'run the mystery tool')
  assert.ok(!/^rm /.test(undoByHand({ kind: 'mystery', path: '/z' })) && undoByHand({ kind: 'mystery', path: '/z' }).length > 10)
  for (const kind of KNOWN_KINDS.filter((k) => k.startsWith('legacy-'))) assert.ok(undoByHand({ kind, path: '/p' }).includes('/p'), kind)
})
