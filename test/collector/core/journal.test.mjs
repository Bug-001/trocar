// test/collector/core/journal.test.mjs — acceptance T11 for a JSON-key entry (4.6 「信任入口的日志与撤销」).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyJsonKey, undoEntry, newManifest, readManifest, saveManifest, sha256, manifestPath, writeOwnedFile } from '../../../src/collector/core/trust/journal.mjs'

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
    const spy = { ...fs, renameSync: (from, to) => { if (to === file) assert.equal(readManifest(b.dir).entries.length, 1, 'intent written first'); return fs.renameSync(from, to) } }
    applyJsonKey({ dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value, fs: spy })
    const own = path.join(b.dir, 'ca', 'extra.pem')
    const spy2 = { ...fs, renameSync: (from, to) => { if (to === own) assert.equal(readManifest(b.dir).files.length, 1); return fs.renameSync(from, to) } }
    writeOwnedFile({ dir: b.dir, manifest: m, role: 'trust-file', file: own, data: 'PEM\n', sources: ['/corp/ca.pem'], fs: spy2 })
    assert.equal(fs.statSync(own).mode & 0o777, 0o600)
    assert.deepEqual(readManifest(b.dir).files[0].sources, ['/corp/ca.pem'], 'the merged user files are named (paths only)')
    assert.equal(applyJsonKey({ dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value }), null, 'already ours: nothing new to journal')
  } finally { b.done() }
})
