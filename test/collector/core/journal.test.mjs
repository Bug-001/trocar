// test/collector/core/journal.test.mjs — acceptance T11 for a JSON-key entry (4.6 「信任入口的日志与撤销」).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyJsonKey, undoEntry, newManifest, readManifest, saveManifest, sha256, manifestPath, writeOwnedFile, sweepTemps } from '../../../src/collector/core/trust/journal.mjs'

const K = ['env', 'CA_FILE']
function box() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-j-'))
  const dir = path.join(root, '.asight', 'collector')
  return { root, dir, value: path.join(dir, 'ca', 'asight-ca.pem'), done: () => fs.rmSync(root, { recursive: true, force: true }) }
}
const USER = '{\n  "model": "x",\n  "env": {\n    "API_KEY": "sk-secret-123"\n  }\n}\n'

test('journal: install then undo is byte-identical; the manifest records the 4.6 fields and never the user file', () => {
  const b = box()
  try {
    const file = path.join(b.root, '.app', 'settings.json'); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, USER, { mode: 0o640 })
    const m = newManifest()
    const e = applyJsonKey({ dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value })
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).env.CA_FILE, b.value)
    assert.equal(fs.statSync(file).mode & 0o777, 0o640)
    const saved = readManifest(b.dir).entries[0]
    for (const k of ['path', 'existed_before', 'mode', 'pre_sha256', 'post_sha256', 'ops', 'prior_value', 'installed_at']) assert.ok(k in saved, k)
    assert.deepEqual([saved.existed_before, saved.pre_sha256, saved.post_sha256, saved.prior_value], [true, sha256(Buffer.from(USER)), sha256(fs.readFileSync(file)), null])
    assert.ok(!fs.readFileSync(manifestPath(b.dir), 'utf8').includes('sk-secret-123'), 'no copy of the user file in the manifest')
    assert.equal(fs.statSync(manifestPath(b.dir)).mode & 0o777, 0o600)
    assert.deepEqual(undoEntry(e).result, 'restored')
    assert.equal(fs.readFileSync(file, 'utf8'), USER)
    assert.equal(undoEntry(e).result, 'already-restored', 'a second uninstall does not claim a difference')
  } finally { b.done() }
})

test('journal: a file (and directory) that did not exist is created, then removed', () => {
  const b = box()
  try {
    const file = path.join(b.root, '.app', 'settings.json')
    const e = applyJsonKey({ dir: b.dir, manifest: newManifest(), harness: 'h', file, keys: K, value: b.value })
    assert.deepEqual([e.existed_before, e.created_dirs], [false, [path.join(b.root, '.app')]])
    assert.equal(undoEntry(e).result, 'restored')
    assert.ok(!fs.existsSync(path.join(b.root, '.app')))
  } finally { b.done() }
})

test('journal: edited after install → only asight\'s key goes, the user\'s prior value comes back, the rest is byte-identical', () => {
  const b = box()
  try {
    const file = path.join(b.root, 'settings.json'); fs.writeFileSync(file, '{"env":{"CA_FILE":"/etc/corp.pem","B":"2"}}')
    const e = applyJsonKey({ dir: b.dir, manifest: newManifest(), harness: 'h', file, keys: K, value: b.value })
    assert.equal(e.prior_value, '/etc/corp.pem')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"B":"2"', '"B":"2","C":"user added"'))
    assert.equal(undoEntry(e).result, 'reverted-not-identical')
    assert.equal(fs.readFileSync(file, 'utf8'), '{"env":{"CA_FILE":"/etc/corp.pem","B":"2","C":"user added"}}')
  } finally { b.done() }
})

test('journal: edited after install with no prior value → the key and the parent this install created go', () => {
  const b = box()
  try {
    const file = path.join(b.root, 'settings.json'); fs.writeFileSync(file, '{\n  "model": "x"\n}')
    const e = applyJsonKey({ dir: b.dir, manifest: newManifest(), harness: 'h', file, keys: K, value: b.value })
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"model": "x"', '"model": "y"'))
    assert.equal(undoEntry(e).result, 'reverted-not-identical')
    assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "model": "y"\n}')
  } finally { b.done() }
})

test('journal: the user changed asight\'s value → left alone; unparsable → left alone', () => {
  const b = box()
  try {
    const file = path.join(b.root, 'settings.json'); fs.writeFileSync(file, '{}')
    const e = applyJsonKey({ dir: b.dir, manifest: newManifest(), harness: 'h', file, keys: K, value: b.value })
    fs.writeFileSync(file, '{"env":{"CA_FILE":"/mine.pem"}}')
    assert.equal(undoEntry(e).result, 'left-user-value')
    fs.writeFileSync(file, '{ broken')
    assert.equal(undoEntry(e).result, 'left-unparsable')
    assert.equal(fs.readFileSync(file, 'utf8'), '{ broken')
  } finally { b.done() }
})

test('journal: a crash after the intent (no post_sha256) is still undone; a crash before the write is already-restored', () => {
  const b = box()
  try {
    const file = path.join(b.root, 'settings.json'); fs.writeFileSync(file, USER)
    const e = applyJsonKey({ dir: b.dir, manifest: newManifest(), harness: 'h', file, keys: K, value: b.value })
    const intentOnly = { ...e, post_sha256: null }
    assert.equal(undoEntry(intentOnly).result, 'restored')
    assert.equal(fs.readFileSync(file, 'utf8'), USER)
    assert.equal(undoEntry(intentOnly).result, 'already-restored')
  } finally { b.done() }
})

test('journal: the intent is on disk before the user file changes; owned files are listed before they are written', () => {
  const b = box()
  try {
    const file = path.join(b.root, 'settings.json'); fs.writeFileSync(file, '{}')
    const m = newManifest(); saveManifest(b.dir, m)
    // T11: the intent is fsynced before the user's file is renamed into place — record the order of syscalls
    const ops = []; const fdPath = new Map()
    const spy = {
      ...fs,
      openSync: (p, ...a) => { const fd = fs.openSync(p, ...a); fdPath.set(fd, p); return fd },
      fsyncSync: (fd) => { ops.push(['fsync', fdPath.get(fd)]); return fs.fsyncSync(fd) },
      renameSync: (from, to) => { ops.push(['rename', from, to]); if (to === file) assert.equal(readManifest(b.dir).entries.length, 1, 'intent written first'); return fs.renameSync(from, to) },
    }
    applyJsonKey({ dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value, fs: spy })
    const at = (pred) => ops.findIndex(pred)
    const intentRename = at((o) => o[0] === 'rename' && o[2] === manifestPath(b.dir))
    const intentFsync = at((o) => o[0] === 'fsync' && o[1] === ops[intentRename][1])
    const userRename = at((o) => o[0] === 'rename' && o[2] === file)
    assert.ok(intentFsync >= 0 && intentFsync < intentRename && intentRename < userRename, `the manifest temp is fsynced and renamed before the user file: ${JSON.stringify(ops)}`)
    assert.ok(at((o) => o[0] === 'fsync' && o[1] === ops[userRename][1]) < userRename, 'the user file temp is fsynced before its rename')
    const own = path.join(b.dir, 'ca', 'extra.pem')
    const spy2 = { ...fs, renameSync: (from, to) => { if (to === own) assert.equal(readManifest(b.dir).files.length, 1); return fs.renameSync(from, to) } }
    writeOwnedFile({ dir: b.dir, manifest: m, role: 'trust-file', file: own, data: 'PEM\n', sources: ['/corp/ca.pem'], fs: spy2 })
    assert.equal(fs.statSync(own).mode & 0o777, 0o600)
    assert.deepEqual(readManifest(b.dir).files[0].sources, ['/corp/ca.pem'], 'the merged user files are named (paths only)')
    assert.equal(applyJsonKey({ dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value }), null, 'already ours: nothing new to journal')
  } finally { b.done() }
})

test('journal: a file asight created that the user then edited is kept with only asight\'s key gone (reverted-not-identical)', () => {
  const b = box()
  try {
    const file = path.join(b.root, '.app', 'settings.json')
    const e = applyJsonKey({ dir: b.dir, manifest: newManifest(), harness: 'h', file, keys: K, value: b.value })
    assert.equal(e.existed_before, false)
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')); doc.model = 'mine'; fs.writeFileSync(file, JSON.stringify(doc, null, 2))
    const r = undoEntry(e)
    assert.deepEqual([r.result, r.deleted], ['reverted-not-identical', undefined])
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'mine' }, "the user's key stays, asight's key and the env object it created go")
  } finally { b.done() }
})

test('journal: a symlinked settings file is edited at its target; the link stays a link; undo restores the target byte for byte', () => {
  const b = box()
  try {
    const target = path.join(b.root, 'dotfiles', 'claude-settings.json'); fs.mkdirSync(path.dirname(target)); fs.writeFileSync(target, USER, { mode: 0o640 })
    const link = path.join(b.root, '.app', 'settings.json'); fs.mkdirSync(path.dirname(link)); fs.symlinkSync(target, link)
    const e = applyJsonKey({ dir: b.dir, manifest: newManifest(), harness: 'h', file: link, keys: K, value: b.value })
    assert.deepEqual([e.path, e.real_path, e.existed_before, e.mode], [link, fs.realpathSync(target), true, 0o640])
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'still a link')
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).env.CA_FILE, b.value, 'the key is in the target')
    const r = undoEntry(e)
    assert.deepEqual([r.result, r.path, r.real_path], ['restored', link, fs.realpathSync(target)])
    assert.equal(fs.readFileSync(target, 'utf8'), USER)
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    const dangling = path.join(b.root, '.other', 'settings.json'); fs.mkdirSync(path.dirname(dangling)); fs.symlinkSync(path.join(b.root, 'nowhere.json'), dangling)
    const m = newManifest()
    assert.throws(() => applyJsonKey({ dir: b.dir, manifest: m, harness: 'h', file: dangling, keys: K, value: b.value }), /symbolic link to a file that does not exist/)
    assert.deepEqual([m.entries.length, fs.lstatSync(dangling).isSymbolicLink(), fs.existsSync(path.join(b.root, 'nowhere.json'))], [0, true, false], 'nothing journaled, link untouched, nothing created')
  } finally { b.done() }
})

test('journal: a crash between the intent and the write leaves no residue after undo (created dirs, temp files)', () => {
  const b = box()
  try {
    const file = path.join(b.root, '.app', 'sub', 'settings.json')
    const e = applyJsonKey({ dir: b.dir, manifest: newManifest(), harness: 'h', file, keys: K, value: b.value })
    fs.rmSync(file) // as if the crash came after mkdir but before the rename …
    fs.writeFileSync(`${file}.asight-tmp-4242`, '{"half":') // … with the temp file written
    const r = undoEntry({ ...e, post_sha256: null })
    assert.equal(r.result, 'already-restored')
    assert.ok(!fs.existsSync(path.join(b.root, '.app')), 'the directories the intent created are gone, temp file included')
    assert.deepEqual(sweepTemps(file), [])
  } finally { b.done() }
})
