// test/collector/core/journal-judge.test.mjs — what `trocar on` finds of one planned item before it writes (1.6 R9): per entry write / skip-intact /
// resume / skip-user-changed, per owned file write / skip-intact / rewrite, and that applying an intact entry again writes nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyJsonKey, applyTextEntry, installedAt, judgeEntry, judgeOwned, newManifest, saveManifest, sha256, writeOwnedFile } from '../../../src/collector/core/trust/journal.mjs'
import { BLOCK_BEGIN } from '../../../src/off/text-edit.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

const K = ['env', 'CA_FILE']
const box = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-jj-'))
  const dir = path.join(root, '.trocar', 'collector')
  return { root, dir, value: path.join(dir, 'ca', 'trocar-ca.pem'), done: () => fs.rmSync(root, { recursive: true, force: true }) }
}
const USER = '{\n  "model": "x",\n  "env": {\n    "API_KEY": "k"\n  }\n}\n'
const planned = (file) => ({ harness: 'h', kind: 'json-key', path: file, keys: K })
const stamp = (f) => { const s = fs.statSync(f); return [s.ino, s.mtimeMs, sha256(fs.readFileSync(f))] }

test('judgeEntry: not listed → write; intact → skip-intact and applying it again writes nothing (inode, mtime, installed_at stay); edited elsewhere but trocar\'s value still there → skip-intact; the key changed by the user → skip-user-changed, and apply refuses', () => {
  const b = box()
  try {
    const file = path.join(b.root, '.app', 'settings.json'); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, USER)
    const m = newManifest()
    assert.equal(judgeEntry({ manifest: m, planned: planned(file) }).action, 'write')
    const e = applyJsonKey({ phase: 'install', home: b.root, dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value })
    assert.equal(judgeEntry({ manifest: m, planned: planned(file) }).action, 'skip-intact')
    const before = stamp(file), at = e.installed_at
    assert.equal(applyJsonKey({ phase: 'install', home: b.root, dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value }), null, 'nothing applied')
    assert.deepEqual(stamp(file), before); assert.equal(m.entries[0].installed_at, at); assert.equal(m.entries.length, 1)
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), model: 'y' }, null, 2)) // the agent rewrote its own settings
    assert.deepEqual([judgeEntry({ manifest: m, planned: planned(file) }).action, judgeEntry({ manifest: m, planned: planned(file) }).edited], ['skip-intact', true])
    fs.writeFileSync(file, JSON.stringify({ env: { CA_FILE: '/the/users/own.pem' } }))
    const j = judgeEntry({ manifest: m, planned: planned(file) })
    assert.equal(j.action, 'skip-user-changed'); assert.match(j.why, /no longer holds what trocar wrote/)
    assert.throws(() => applyJsonKey({ phase: 'install', home: b.root, dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value }), /trocar off.*trocar on/)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).env.CA_FILE, '/the/users/own.pem', 'the user\'s value is left')
  } finally { b.done() }
})

test('judgeEntry: an intent a crash left (no post_sha256) is resume when the file is still as it was, resume + adopt when it was already written; a file that is neither is the user\'s', () => {
  const b = box()
  try {
    const file = path.join(b.root, '.app', 'settings.json'); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, USER)
    const m = newManifest()
    applyJsonKey({ phase: 'install', home: b.root, dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value })
    const written = fs.readFileSync(file)
    m.entries[0].post_sha256 = null // crash after the write, before the record
    assert.deepEqual([judgeEntry({ manifest: m, planned: planned(file) }).action, judgeEntry({ manifest: m, planned: planned(file) }).adopt], ['resume', true])
    applyJsonKey({ phase: 'install', home: b.root, dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value })
    assert.deepEqual([m.entries.length, m.entries[0].post_sha256, fs.readFileSync(file).equals(written)], [1, sha256(written), true], 'adopted: the record is finished, the file is not touched')
    m.entries[0].post_sha256 = null; fs.writeFileSync(file, USER) // crash before the write
    assert.deepEqual([judgeEntry({ manifest: m, planned: planned(file) }).action, judgeEntry({ manifest: m, planned: planned(file) }).adopt], ['resume', undefined])
    applyJsonKey({ phase: 'install', home: b.root, dir: b.dir, manifest: m, harness: 'h', file, keys: K, value: b.value })
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
    writeOwnedFile({ phase: 'install', dir: b.dir, manifest: m, harness: 'h', role: 'trust-file', file, data: 'AAA' })
    assert.equal(judgeOwned({ manifest: m, file }).action, 'skip-intact')
    assert.equal(judgeOwned({ manifest: m, file, planned: sha256(Buffer.from('AAA')) }).action, 'skip-intact')
    assert.equal(judgeOwned({ manifest: m, file, planned: sha256(Buffer.from('BBB')) }).action, 'rewrite', 'a unit whose script moved is not kept')
    fs.writeFileSync(file, 'tampered'); assert.equal(judgeOwned({ manifest: m, file }).action, 'rewrite')
    fs.writeFileSync(file, 'AAA'); m.files[0].without_ca = true; assert.equal(judgeOwned({ manifest: m, file }).action, 'rewrite')
    delete m.files[0].without_ca; fs.rmSync(file); assert.equal(judgeOwned({ manifest: m, file }).action, 'rewrite')
    writeOwnedFile({ phase: 'install', dir: b.dir, manifest: m, harness: 'h', role: 'trust-file', file, data: 'AAA' }) // upsert: one record
    assert.equal(m.files.filter((f) => f.path === file).length, 1)
    saveManifest(b.dir, m)
  } finally { b.done() }
})

// ── one file under two spellings (X18): the manifest records the path as one run's ctx spelled it; a later run (another env, a short name, a linked
// directory) spells it otherwise. Every comparison the journal makes goes through pathKey, so the second spelling is the same entry, not a new one.
// Does this temp file system fold case (APFS, NTFS by default)? Where it does not (most Linux), two spellings in case are two files, and the journal must say so.
const foldsCase = (dir) => { const f = path.join(dir, 'Probe'); fs.writeFileSync(f, ''); try { return fs.existsSync(path.join(dir, 'pROBE')) } finally { fs.rmSync(f) } }
test('X18: the trust block is written to Home/Codex/.env; the proxy block joins it under another spelling of the same file (case, a linked directory) and installedAt finds it under either', () => {
  const run = (label, mk) => {
    const root = fs.realpathSync(tmpDir('trocar-jj18-'))
    fs.mkdirSync(path.join(root, 'Home', 'Codex'), { recursive: true })
    fs.symlinkSync(path.join(root, 'Home', 'Codex'), path.join(root, 'link'))
    const dir = path.join(root, '.trocar', 'collector')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(root, 'Home', 'Codex', '.env')
    fs.writeFileSync(file, 'OPENAI_API_KEY=k\n')
    const other = mk(root)
    const m = newManifest()
    const trust = applyTextEntry({ phase: 'on', dir, home: root, manifest: m, harness: 'codex', file, edit: { format: 'dotenv-block', vars: { SSL_CERT_FILE: '/ca.pem' } } })
    assert.ok(trust, label)
    const joined = applyTextEntry({ phase: 'on', dir, home: root, manifest: m, harness: 'codex', file: other, edit: { format: 'dotenv-block', vars: { HTTPS_PROXY: 'http://127.0.0.1:1' }, joinBlock: true } })
    assert.ok(joined, `${label}: the join is written, not refused as text from an unlisted install`)
    const text = fs.readFileSync(file, 'utf8')
    assert.equal(text.split(BLOCK_BEGIN).length, 2, `${label}: one block in the file`)
    assert.match(text, /HTTPS_PROXY/, label)
    // the planned trust entry under the other spelling is the entry the manifest has: intact, not written again
    assert.equal(judgeEntry({ manifest: m, planned: { harness: 'codex', kind: 'text', path: other, format: 'dotenv-block', vars: { SSL_CERT_FILE: '/ca.pem' } } }).action, 'skip-intact', label)
    assert.equal(installedAt(m, { file: other, vars: { SSL_CERT_FILE: '/ca.pem', HTTPS_PROXY: 'http://127.0.0.1:1' } }), Date.parse(trust.installed_at), `${label}: installedAt`)
  }
  const probe = fs.realpathSync(tmpDir('trocar-jj18-'))
  if (foldsCase(probe)) run('another case', (root) => path.join(root, 'home', 'codex', '.env'))
  run('a linked directory', (root) => path.join(root, 'link', '.env'))
})
