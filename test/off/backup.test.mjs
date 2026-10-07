// test/off/backup.test.mjs — 1.6 R2 「先备份再改」: before asight changes a file outside ~/.asight, the file's bytes go to
// ~/.asight/backup/ (dir 0700, file 0600), one per change, named <sha256(path)[0:16]>-<UTC time>, never written over, and when the
// backup cannot be written the user's file is not touched and the failure is `backup-failed`. The manifest names the backup and
// holds `pre_sha256`; it never holds the contents (a Codex .env has API keys in it).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { writeBackup, dropBackup, backupsOf, orphanBackups, backupName } from '../../src/off/backup.mjs'
import { backupDir } from '../../src/off/paths.mjs'
import { newManifest, readManifest, manifestPath } from '../../src/off/manifest.mjs'
import { applyJsonKey, applyTextEntry } from '../../src/collector/core/trust/journal.mjs'
import { sha256 } from '../../src/off/fsutil.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const mode = (p) => fs.statSync(p).mode & 0o777
/** A sandbox HOME with the collector directory where the install puts it. */
function box() {
  const home = tmpDir('asight-bk-')
  return { home, dir: path.join(home, '.asight', 'collector') }
}
const put = (file, text, m = 0o644) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode: m }); return file }
const T = new Date('2026-10-07T01:02:03.004Z')
const K = ['env', 'NODE_EXTRA_CA_CERTS']
const USER_JSON = '{\n  "env": {\n    "API_KEY": "sk-secret-123"\n  }\n}\n'
const BLOCK = { format: 'dotenv-block', vars: { SSL_CERT_FILE: '/h/.asight/collector/ca/combined-codex.pem' } }

test('R2: one backup per change, 0700/0600, named by path hash + UTC time, never overwritten', () => {
  const { home } = box(); const f = put(path.join(home, '.codex', '.env'), 'OPENAI_API_KEY=sk-1\n')
  const a = writeBackup({ home, file: f, data: fs.readFileSync(f), now: T })
  const b = writeBackup({ home, file: f, data: Buffer.from('second'), now: T })
  assert.notEqual(a, b, 'the same file at the same millisecond still gets a second backup')
  assert.match(path.basename(a), /^[0-9a-f]{16}-20261007T010203004Z$/)
  assert.equal(path.basename(a).slice(0, 16), sha(path.resolve(f)).slice(0, 16), 'the name carries the sha256 of the original path, so the backup is found without a manifest')
  assert.equal(path.dirname(a), backupDir(home))
  assert.equal(mode(path.dirname(a)), 0o700)
  assert.equal(mode(a), 0o600)
  assert.equal(fs.readFileSync(a, 'utf8'), 'OPENAI_API_KEY=sk-1\n')
  assert.equal(fs.readFileSync(b, 'utf8'), 'second')
  assert.deepEqual(backupsOf({ home, file: f }).sort(), [a, b].sort())
})

test('R2: backupName is <first 16 hex of sha256(resolved path)>-<UTC, millisecond>, whatever the local time zone', () => {
  const f = '/h/.zshrc'
  assert.equal(backupName(f, T), `${sha(f).slice(0, 16)}-20261007T010203004Z`)
  assert.equal(backupName('/h/x/../.zshrc', T), backupName(f, T), 'the path is resolved before it is hashed')
  assert.equal(backupName(f, new Date('2026-12-31T23:59:59.999Z')), `${sha(f).slice(0, 16)}-20261231T235959999Z`)
  assert.notEqual(backupName('/h/.bashrc', T), backupName(f, T), 'two files never share a name')
})

test('R2: a name that is taken is never written over: -1, -2 are tried and the earlier backups keep their bytes', () => {
  const { home } = box(); const f = put(path.join(home, 'a.txt'), 'x')
  const first = path.join(backupDir(home), backupName(f, T))
  fs.mkdirSync(backupDir(home), { recursive: true, mode: 0o700 })
  fs.writeFileSync(first, 'an earlier backup the manifest no longer knows (a kept one)', { mode: 0o600 })
  const b1 = writeBackup({ home, file: f, data: Buffer.from('one'), now: T })
  const b2 = writeBackup({ home, file: f, data: Buffer.from('two'), now: T })
  assert.deepEqual([b1, b2].map((p) => path.basename(p).slice(36)), ['-1', '-2'], 'the suffix goes after the time')
  assert.equal(fs.readFileSync(first, 'utf8'), 'an earlier backup the manifest no longer knows (a kept one)')
  assert.deepEqual([fs.readFileSync(b1, 'utf8'), fs.readFileSync(b2, 'utf8')], ['one', 'two'])
  assert.equal(backupsOf({ home, file: f }).length, 3, 'backupsOf lists the suffixed ones too')
})

test('R2: the directory is 0700 and the file 0600 whatever the umask, and a looser directory is tightened (the backups hold API keys)', () => {
  const { home } = box(); const f = put(path.join(home, 'k.env'), 'KEY=v\n')
  fs.mkdirSync(backupDir(home), { recursive: true, mode: 0o755 }); fs.chmodSync(backupDir(home), 0o755)
  const old = process.umask(0o000)
  let p
  try { p = writeBackup({ home, file: f, data: Buffer.from('KEY=v\n'), now: T }) } finally { process.umask(old) }
  assert.equal(mode(backupDir(home)), 0o700)
  assert.equal(mode(p), 0o600)
  // a directory this call creates, with ~/.asight not there yet
  const other = box().home; const g = put(path.join(other, 'g'), 'g')
  const old2 = process.umask(0o000)
  try { writeBackup({ home: other, file: g, data: Buffer.from('g'), now: T }) } finally { process.umask(old2) }
  assert.equal(mode(backupDir(other)), 0o700)
  // a umask that takes owner bits away must not make the backup unreadable to its owner either: the file is 0600, not the umask's 0400
  const old3 = process.umask(0o277)
  let q
  try { q = writeBackup({ home: other, file: g, data: Buffer.from('g2'), now: new Date(T.getTime() + 1000) }) } finally { process.umask(old3) }
  assert.equal(mode(q), 0o600)
})

test('R2: the backup is durable before it is reported (file and directory are fsynced) and is written exclusively', () => {
  const { home } = box(); const f = put(path.join(home, 'd.env'), 'D=1\n')
  const ops = []; const fdPath = new Map()
  const spy = {
    ...fs,
    openSync: (p, flag, ...a) => { const fd = fs.openSync(p, flag, ...a); fdPath.set(fd, p); ops.push(['open', p, flag]); return fd },
    fsyncSync: (fd) => { ops.push(['fsync', fdPath.get(fd)]); return fs.fsyncSync(fd) },
  }
  const p = writeBackup({ home, file: f, data: Buffer.from('D=1\n'), now: T, fs: spy })
  assert.equal(ops.find((o) => o[0] === 'open' && o[1] === p)[2], 'wx', 'O_EXCL: an existing file is never opened for writing')
  assert.ok(ops.some((o) => o[0] === 'fsync' && o[1] === p), 'the file is fsynced')
  assert.ok(ops.some((o) => o[0] === 'fsync' && o[1] === backupDir(home)), 'the directory is fsynced, so the name survives a crash')
})

test('R2: a backup that cannot be written leaves the user file byte for byte and says backup-failed (text and JSON entries)', () => {
  for (const kind of ['text', 'json']) {
    const { home, dir } = box()
    const f = kind === 'text' ? put(path.join(home, '.codex', '.env'), 'OPENAI_API_KEY=sk-1\nFOO=bar\n', 0o640) : put(path.join(home, '.claude', 'settings.json'), USER_JSON, 0o640)
    const before = fs.readFileSync(f); const st = fs.statSync(f)
    put(backupDir(home), 'this is a file where the backup directory should be') // mkdir fails: EEXIST / ENOTDIR
    const m = newManifest()
    const run = () => (kind === 'text'
      ? applyTextEntry({ home, dir, manifest: m, harness: 'codex', file: f, edit: BLOCK })
      : applyJsonKey({ home, dir, manifest: m, harness: 'claude-code', file: f, keys: K, value: '/h/.asight/collector/ca/asight-ca.pem' }))
    assert.throws(run, (e) => e.code === 'backup-failed' && e.message.includes(f) && /not (changed|touched)/.test(e.message), kind)
    assert.deepEqual(fs.readFileSync(f), before, `${kind}: the user file is byte for byte`)
    assert.equal(fs.statSync(f).mtimeMs, st.mtimeMs, `${kind}: and was not even rewritten`)
    assert.equal(mode(f), 0o640)
    assert.deepEqual(m.entries, [], `${kind}: no entry was recorded for a change that did not happen`)
    assert.equal(readManifest(dir), null, `${kind}: not even the intent was saved`)
    assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.asight-tmp-')), [], `${kind}: no temp file left`)
  }
})

test('R2: a write that fails half-way (disk full) removes the partial backup, leaves the user file, and is backup-failed', () => {
  const { home, dir } = box(); const f = put(path.join(home, '.claude', 'settings.json'), USER_JSON)
  const before = fs.readFileSync(f)
  let spyOn = true; const fdPath = new Map()
  const spy = {
    ...fs,
    openSync: (p, ...a) => { const fd = fs.openSync(p, ...a); fdPath.set(fd, p); return fd },
    writeSync: (fd, ...a) => { if (spyOn && String(fdPath.get(fd)).startsWith(backupDir(home) + path.sep)) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); return fs.writeSync(fd, ...a) },
  }
  assert.throws(() => applyJsonKey({ home, dir, manifest: newManifest(), harness: 'claude-code', file: f, keys: K, value: '/x.pem', fs: spy }), (e) => e.code === 'backup-failed' && /ENOSPC|no space/.test(e.message))
  spyOn = false
  assert.deepEqual(fs.readFileSync(f), before)
  assert.deepEqual(fs.existsSync(backupDir(home)) ? fs.readdirSync(backupDir(home)) : [], [], 'no half-written backup is left to be mistaken for a good one')
})

test('R2: an entry of an existing file carries its backup (the bytes before the change), kind, undo_by_hand and pre_sha256; the manifest holds no contents', () => {
  const { home, dir } = box(); const f = put(path.join(home, '.claude', 'settings.json'), USER_JSON, 0o640)
  const e = applyJsonKey({ home, dir, manifest: newManifest(), harness: 'claude-code', file: f, keys: K, value: '/h/.asight/collector/ca/asight-ca.pem', now: T })
  assert.equal(e.kind, 'json-key')
  assert.equal(e.backup, path.join(backupDir(home), backupName(f, T)))
  assert.equal(fs.readFileSync(e.backup, 'utf8'), USER_JSON, 'the backup is the file as it was before the change')
  assert.equal(sha256(fs.readFileSync(e.backup)), e.pre_sha256)
  assert.equal(mode(e.backup), 0o600)
  assert.match(e.undo_by_hand, /settings\.json/); assert.ok(e.undo_by_hand.length > 10)
  const saved = fs.readFileSync(manifestPath(dir), 'utf8')
  assert.ok(!saved.includes('sk-secret-123'), 'the manifest names the backup; it does not hold the file')
  assert.equal(readManifest(dir).entries[0].backup, e.backup)

  const env = put(path.join(home, '.codex', '.env'), 'OPENAI_API_KEY=sk-1\n')
  const t = applyTextEntry({ home, dir, manifest: newManifest(), harness: 'codex', file: env, edit: BLOCK, now: T })
  assert.equal(t.kind, 'text')
  assert.equal(fs.readFileSync(t.backup, 'utf8'), 'OPENAI_API_KEY=sk-1\n')
  assert.equal(sha256(fs.readFileSync(t.backup)), t.pre_sha256)
  assert.ok(!fs.readFileSync(manifestPath(dir), 'utf8').includes('sk-1'))
})

test('R2: a file asight creates is not backed up: backup null, existed_before false, and no backup directory appears', () => {
  const { home, dir } = box()
  const e = applyJsonKey({ home, dir, manifest: newManifest(), harness: 'claude-code', file: path.join(home, '.claude', 'settings.json'), keys: K, value: '/x.pem', now: T })
  assert.deepEqual([e.existed_before, e.backup], [false, null])
  assert.ok(e.undo_by_hand.length > 10, 'still one sentence on how to take it out by hand')
  const t = applyTextEntry({ home, dir, manifest: newManifest(), harness: 'codex', file: path.join(home, '.codex', '.env'), edit: BLOCK, now: T })
  assert.deepEqual([t.existed_before, t.backup], [false, null])
  assert.ok(!fs.existsSync(backupDir(home)))
})

test('R2: a change that changes nothing (the key already holds asight\'s value) writes no backup', () => {
  const { home, dir } = box(); const f = put(path.join(home, 's.json'), '{"env":{"NODE_EXTRA_CA_CERTS":"/x.pem"}}')
  assert.equal(applyJsonKey({ home, dir, manifest: newManifest(), harness: 'h', file: f, keys: K, value: '/x.pem' }), null)
  assert.ok(!fs.existsSync(backupDir(home)))
})

test('R2: a refused change (not a JSON object, a dangling link) writes no backup and no manifest', () => {
  const { home, dir } = box(); const f = put(path.join(home, 's.json'), 'not json at all')
  assert.throws(() => applyJsonKey({ home, dir, manifest: newManifest(), harness: 'h', file: f, keys: K, value: '/x.pem' }))
  const link = path.join(home, 'dangling'); fs.symlinkSync(path.join(home, 'nowhere'), link)
  assert.throws(() => applyTextEntry({ home, dir, manifest: newManifest(), harness: 'h', file: link, edit: BLOCK }), /symbolic link to a file that does not exist/)
  assert.ok(!fs.existsSync(backupDir(home)) && readManifest(dir) === null)
})

test('R2: each change is its own backup: the second one keeps the first, and the first still holds the original bytes', () => {
  const { home, dir } = box(); const f = put(path.join(home, 's.json'), USER_JSON)
  const e1 = applyJsonKey({ home, dir, manifest: newManifest(), harness: 'h', file: f, keys: K, value: '/one.pem', now: T })
  const after1 = fs.readFileSync(f, 'utf8')
  const e2 = applyJsonKey({ home, dir, manifest: newManifest(), harness: 'h', file: f, keys: K, value: '/two.pem', now: T })
  assert.notEqual(e1.backup, e2.backup)
  assert.equal(fs.readFileSync(e1.backup, 'utf8'), USER_JSON)
  assert.equal(fs.readFileSync(e2.backup, 'utf8'), after1, 'the second backup is the file as the first change left it')
  assert.equal(backupsOf({ home, file: f }).length, 2)
})

test('R2: a symlinked file is backed up under the path the user knows (the link), holding the target\'s bytes', () => {
  const { home, dir } = box(); const target = put(path.join(home, 'dotfiles', 'settings.json'), USER_JSON)
  const link = path.join(home, '.claude', 'settings.json'); fs.mkdirSync(path.dirname(link)); fs.symlinkSync(target, link)
  const e = applyJsonKey({ home, dir, manifest: newManifest(), harness: 'h', file: link, keys: K, value: '/x.pem', now: T })
  assert.equal(e.real_path, fs.realpathSync(target))
  assert.deepEqual(backupsOf({ home, file: link }), [e.backup])
  assert.deepEqual(backupsOf({ home, file: target }), [], 'keyed by the entry\'s path, as the manifest and the receipt name it')
  assert.equal(fs.readFileSync(e.backup, 'utf8'), USER_JSON)
})

test('dropBackup removes one backup and says so; a second call is false; it only ever removes what writeBackup makes', () => {
  const { home } = box(); const f = put(path.join(home, 'a'), 'a')
  const p = writeBackup({ home, file: f, data: Buffer.from('a'), now: T })
  assert.equal(dropBackup(p), true)
  assert.ok(!fs.existsSync(p))
  assert.equal(dropBackup(p), false, 'already gone')
  // a manifest that names a user file as its backup (damaged, or edited by hand) deletes nothing
  const victim = put(path.join(home, 'backup', 'notes.txt'), 'the user\'s own file in a directory that happens to be called backup')
  assert.equal(dropBackup(victim), false); assert.ok(fs.existsSync(victim), 'a name writeBackup would not make')
  assert.equal(dropBackup(f), false); assert.ok(fs.existsSync(f), 'a path outside the backup directory')
  assert.equal(dropBackup(null), false)
})

test('backupsOf lists only that file\'s backups, oldest first; no directory is no backups', () => {
  const { home } = box(); const a = put(path.join(home, 'a'), 'a'); const b = put(path.join(home, 'b'), 'b')
  assert.deepEqual(backupsOf({ home, file: a }), [])
  const a2 = writeBackup({ home, file: a, data: Buffer.from('a2'), now: new Date('2026-10-07T00:00:02.000Z') })
  const a1 = writeBackup({ home, file: a, data: Buffer.from('a1'), now: new Date('2026-10-07T00:00:01.000Z') })
  const b1 = writeBackup({ home, file: b, data: Buffer.from('b1'), now: T })
  fs.writeFileSync(path.join(backupDir(home), 'stray.txt'), 'not ours')
  assert.deepEqual(backupsOf({ home, file: a }), [a1, a2], 'by time')
  assert.deepEqual(backupsOf({ home, file: b }), [b1])
})

test('orphanBackups: every backup no manifest entry or kept_backups row names — all of them when there is no manifest', () => {
  const { home } = box(); const f = put(path.join(home, 'f'), 'f'); const g = put(path.join(home, 'g'), 'g'); const h = put(path.join(home, 'h'), 'h')
  const bf = writeBackup({ home, file: f, data: Buffer.from('f'), now: T })
  const bg = writeBackup({ home, file: g, data: Buffer.from('g'), now: T })
  const bh = writeBackup({ home, file: h, data: Buffer.from('h'), now: T })
  const m = newManifest(); m.entries.push({ path: f, backup: bf }); m.kept_backups.push({ path: g, backup: bg, reason: 'edited since', at: T.toISOString() })
  assert.deepEqual(orphanBackups({ home, manifest: m }), [bh])
  assert.deepEqual(orphanBackups({ home, manifest: null }).sort(), [bf, bg, bh].sort(), 'no manifest: nothing says what they belong to')
  assert.deepEqual(orphanBackups({ home: box().home, manifest: m }), [], 'no backup directory, no orphans')
})
