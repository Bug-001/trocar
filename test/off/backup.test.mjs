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
import { newManifest } from '../../src/off/manifest.mjs'
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

