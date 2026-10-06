// test/collector/core/journal-judge.test.mjs — what `asight on` finds of one planned item before it writes (1.6 R9): per entry write / skip-intact /
// resume / skip-user-changed, per owned file write / skip-intact / rewrite, and that applying an intact entry again writes nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyJsonKey, judgeEntry, judgeOwned, newManifest, saveManifest, sha256, writeOwnedFile } from '../../../src/collector/core/trust/journal.mjs'

const K = ['env', 'CA_FILE']
const box = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-jj-'))
  const dir = path.join(root, '.asight', 'collector')
  return { root, dir, value: path.join(dir, 'ca', 'asight-ca.pem'), done: () => fs.rmSync(root, { recursive: true, force: true }) }
}
const USER = '{\n  "model": "x",\n  "env": {\n    "API_KEY": "k"\n  }\n}\n'
const planned = (file) => ({ harness: 'h', kind: 'json-key', path: file, keys: K })
const stamp = (f) => { const s = fs.statSync(f); return [s.ino, s.mtimeMs, sha256(fs.readFileSync(f))] }

test('judgeEntry: not listed → write; intact → skip-intact and applying it again writes nothing (inode, mtime, installed_at stay); edited elsewhere but asight\'s value still there → skip-intact; the key changed by the user → skip-user-changed, and apply refuses', () => {
  const b = box()
  try {
    const file = path.join(b.root, '.app', 'settings.json'); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, USER)
    const m = newManifest()
    assert.equal(judgeEntry({ manifest: m, planned: planned(file) }).action, 'write')
    const e = applyJsonKey({ home: b.root, dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value })
    assert.equal(judgeEntry({ manifest: m, planned: planned(file) }).action, 'skip-intact')
    const before = stamp(file), at = e.installed_at
    assert.equal(applyJsonKey({ home: b.root, dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value }), null, 'nothing applied')
    assert.deepEqual(stamp(file), before); assert.equal(m.entries[0].installed_at, at); assert.equal(m.entries.length, 1)
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), model: 'y' }, null, 2)) // the agent rewrote its own settings
    assert.deepEqual([judgeEntry({ manifest: m, planned: planned(file) }).action, judgeEntry({ manifest: m, planned: planned(file) }).edited], ['skip-intact', true])
    fs.writeFileSync(file, JSON.stringify({ env: { CA_FILE: '/the/users/own.pem' } }))
    const j = judgeEntry({ manifest: m, planned: planned(file) })
    assert.equal(j.action, 'skip-user-changed'); assert.match(j.why, /no longer holds what asight wrote/)
    assert.throws(() => applyJsonKey({ home: b.root, dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value }), /asight off.*asight on/)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).env.CA_FILE, '/the/users/own.pem', 'the user\'s value is left')
  } finally { b.done() }
})

test('judgeEntry: an intent a crash left (no post_sha256) is resume when the file is still as it was, resume + adopt when it was already written; a file that is neither is the user\'s', () => {
  const b = box()
  try {
    const file = path.join(b.root, '.app', 'settings.json'); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, USER)
    const m = newManifest()
    applyJsonKey({ home: b.root, dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value })
    const written = fs.readFileSync(file)
    m.entries[0].post_sha256 = null // crash after the write, before the record
    assert.deepEqual([judgeEntry({ manifest: m, planned: planned(file) }).action, judgeEntry({ manifest: m, planned: planned(file) }).adopt], ['resume', true])
    applyJsonKey({ home: b.root, dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value })
    assert.deepEqual([m.entries.length, m.entries[0].post_sha256, fs.readFileSync(file).equals(written)], [1, sha256(written), true], 'adopted: the record is finished, the file is not touched')
    m.entries[0].post_sha256 = null; fs.writeFileSync(file, USER) // crash before the write
    assert.deepEqual([judgeEntry({ manifest: m, planned: planned(file) }).action, judgeEntry({ manifest: m, planned: planned(file) }).adopt], ['resume', undefined])
    applyJsonKey({ home: b.root, dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value })
    assert.deepEqual([m.entries.length, fs.readFileSync(file).equals(written)], [1, true], 'resumed: written once, one entry')
    m.entries[0].post_sha256 = null; fs.writeFileSync(file, '{"something":"else"}')
    assert.equal(judgeEntry({ manifest: m, planned: planned(file) }).action, 'skip-user-changed')
  } finally { b.done() }
})

test('judgeOwned: unlisted → write; byte for byte what was recorded → skip-intact; changed, gone, or kept without the CA → rewrite; a planned sha that differs → rewrite', () => {
  const b = box()
  try {
    const file = path.join(b.dir, 'ca', 'extra-h.pem'); const m = newManifest()
    assert.equal(judgeOwned({ manifest: m, file }).action, 'write')
    writeOwnedFile({ dir: b.dir, manifest: m, harness: 'h', role: 'trust-file', file, data: 'AAA' })
    assert.equal(judgeOwned({ manifest: m, file }).action, 'skip-intact')
    assert.equal(judgeOwned({ manifest: m, file, planned: sha256(Buffer.from('AAA')) }).action, 'skip-intact')
    assert.equal(judgeOwned({ manifest: m, file, planned: sha256(Buffer.from('BBB')) }).action, 'rewrite', 'a unit whose script moved is not kept')
    fs.writeFileSync(file, 'tampered'); assert.equal(judgeOwned({ manifest: m, file }).action, 'rewrite')
    fs.writeFileSync(file, 'AAA'); m.files[0].without_ca = true; assert.equal(judgeOwned({ manifest: m, file }).action, 'rewrite')
    delete m.files[0].without_ca; fs.rmSync(file); assert.equal(judgeOwned({ manifest: m, file }).action, 'rewrite')
    writeOwnedFile({ dir: b.dir, manifest: m, harness: 'h', role: 'trust-file', file, data: 'AAA' }) // upsert: one record
    assert.equal(m.files.filter((f) => f.path === file).length, 1)
    saveManifest(b.dir, m)
  } finally { b.done() }
})
