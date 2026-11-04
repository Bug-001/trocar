// test/off/fsutil.test.mjs — the path identity every journal comparison uses (pathKey, RFC 4.9 route-plan row, X18) and the durable
// write's rename retry (X16): a file another process holds open for a moment (Windows: an editor, an AV scanner, the agent itself) makes
// rename fail with EBUSY / EPERM / EACCES; the write waits and tries again, and a write that never lands leaves no temp file behind.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathKey, writeDurable, fsyncDir, TMP_MARK, readBounded, readSmall } from '../../src/off/fsutil.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const errno = (code) => Object.assign(new Error(`${code}: rename`), { code })
// node:fs with renameSync replaced: `fail(n)` returns the error the n-th call throws, or null to let the real rename run
const renaming = (fail) => { let n = 0; const calls = []; return { calls, fs: { ...fs, renameSync: (a, b) => { calls.push(Date.now()); const e = fail(n++); if (e) throw e; return fs.renameSync(a, b) } } } }
const temps = (dir) => fs.readdirSync(dir).filter((n) => n.includes(TMP_MARK))

test('writeDurable: a rename that fails with EBUSY twice is retried and lands; the file holds the new bytes and no temp file is left', () => {
  const dir = tmpDir('trocar-fsu-')
  const file = path.join(dir, 'config.toml')
  fs.writeFileSync(file, 'old')
  const r = renaming((n) => (n < 2 ? errno('EBUSY') : null))
  writeDurable(file, 'new', 0o600, r.fs)
  assert.equal(r.calls.length, 3)
  assert.equal(fs.readFileSync(file, 'utf8'), 'new')
  assert.deepEqual(temps(dir), [])
  assert.ok(r.calls[2] - r.calls[0] >= 1, 'it waits between tries')
})

test('writeDurable: every errno that means "held open for now" is retried — EPERM and EACCES as well as EBUSY (by errno, not by platform)', () => {
  for (const code of ['EPERM', 'EACCES']) {
    const dir = tmpDir('trocar-fsu-')
    const file = path.join(dir, 'a.json')
    const r = renaming((n) => (n < 1 ? errno(code) : null))
    writeDurable(file, '{}', 0o600, r.fs)
    assert.equal(fs.readFileSync(file, 'utf8'), '{}', code)
  }
})

test('writeDurable: a permanent EPERM throws after a bounded number of tries (about a second), the target is untouched and no *.trocar-tmp-* is left', () => {
  const dir = tmpDir('trocar-fsu-')
  const file = path.join(dir, '.env')
  fs.writeFileSync(file, 'KEEP=1\n')
  const r = renaming(() => errno('EPERM'))
  const t0 = Date.now()
  assert.throws(() => writeDurable(file, 'X=2\n', 0o600, r.fs), (e) => e.code === 'EPERM')
  const took = Date.now() - t0
  assert.ok(r.calls.length > 1 && r.calls.length <= 12, `bounded tries: ${r.calls.length}`)
  assert.ok(took >= 500 && took < 3000, `about a second in all: ${took} ms`)
  assert.equal(fs.readFileSync(file, 'utf8'), 'KEEP=1\n')
  assert.deepEqual(temps(dir), [])
})

test('writeDurable: an error that waiting cannot fix (EXDEV, ENOSPC on write) is not retried, and still leaves no temp file', () => {
  const dir = tmpDir('trocar-fsu-')
  const file = path.join(dir, 'b.json')
  const r = renaming(() => errno('EXDEV'))
  assert.throws(() => writeDurable(file, '{}', 0o600, r.fs), (e) => e.code === 'EXDEV')
  assert.equal(r.calls.length, 1)
  assert.deepEqual(temps(dir), [])
  const full = { ...fs, writeSync: () => { throw errno('ENOSPC') } }
  assert.throws(() => writeDurable(file, '{}', 0o600, full), (e) => e.code === 'ENOSPC')
  assert.deepEqual(temps(dir), [])
})

// ── pathKey ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// a fake fs whose realpathSync.native maps directories by a table (the real Windows shape: GetFinalPathNameByHandle gives the long name)
const realTable = (table) => ({ realpathSync: { native: (p) => { const hit = table[p.toLowerCase()]; if (hit) return hit; throw errno('ENOENT') } } })

test('pathKey(win32): case and slashes do not make two spellings of one file differ', () => {
  const fake = realTable({})
  const k = (p) => pathKey(p, { platform: 'win32', realpath: fake.realpathSync.native })
  assert.equal(k('C:\\Users\\Runner\\.codex\\config.toml'), k('c:/users/runner/.CODEX/Config.TOML'))
  assert.equal(k('C:\\Users\\Runner\\.codex\\..\\.codex\\config.toml'), k('C:\\Users\\Runner\\.codex\\config.toml'))
  assert.notEqual(k('C:\\Users\\Runner\\.codex\\config.toml'), k('C:\\Users\\Runner\\.codex\\config.json'))
  assert.match(k('C:\\Users\\Runner\\.codex\\config.toml'), /^c:\/users\/runner\/\.codex\/config\.toml$/)
})

test('pathKey(win32): an 8.3 short name in the parent (RUNNER~1) is the same file as its long name, by what the file system says — no spelling branch', () => {
  const fake = realTable({ 'c:\\users\\runner~1\\.codex': 'C:\\Users\\runneradmin\\.codex', 'c:\\users\\runneradmin\\.codex': 'C:\\Users\\runneradmin\\.codex' })
  const k = (p) => pathKey(p, { platform: 'win32', realpath: fake.realpathSync.native })
  assert.equal(k('C:\\Users\\RUNNER~1\\.codex\\config.toml'), k('C:\\Users\\runneradmin\\.codex\\config.toml'))
  assert.equal(k('C:\\Users\\RUNNER~1\\.codex\\config.toml'), 'c:/users/runneradmin/.codex/config.toml')
})

test('pathKey: a parent that is not there falls back to the resolved path (a deeper ancestor that is there still resolves)', () => {
  const fake = realTable({ 'c:\\users\\runner~1': 'C:\\Users\\runneradmin' })
  const k = (p) => pathKey(p, { platform: 'win32', realpath: fake.realpathSync.native })
  assert.equal(k('C:\\Users\\RUNNER~1\\.gone\\x.env'), k('C:\\Users\\runneradmin\\.gone\\x.env'))
  assert.equal(k('D:\\nowhere\\x.env'), 'd:/nowhere/x.env')
})

test('pathKey(darwin): case folds and a symlinked directory is the directory it links to (real directories in a temp dir)', () => {
  const dir = fs.realpathSync(tmpDir('trocar-pk-'))
  fs.mkdirSync(path.join(dir, 'Home', 'Codex'), { recursive: true })
  fs.symlinkSync(path.join(dir, 'Home', 'Codex'), path.join(dir, 'link'))
  const k = (p) => pathKey(p, { platform: 'darwin', realpath: fs.realpathSync.native })
  assert.equal(k(path.join(dir, 'link', '.env')), k(path.join(dir, 'Home', 'Codex', '.env')))
  assert.equal(k(path.join(dir, 'HOME', 'codex', '.ENV')), k(path.join(dir, 'Home', 'Codex', '.env')))
  // APFS looks names up without regard to Unicode normalisation: NFC and NFD spellings are one file
  assert.equal(k(path.join(dir, 'caf\u00e9.env')), k(path.join(dir, 'cafe\u0301.env')))
})

test('pathKey(linux): case matters, a symlinked directory still resolves', () => {
  const dir = fs.realpathSync(tmpDir('trocar-pk-'))
  fs.mkdirSync(path.join(dir, 'real'))
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'ln'))
  const k = (p) => pathKey(p, { platform: 'linux', realpath: fs.realpathSync.native })
  assert.equal(k(path.join(dir, 'ln', 'f')), path.join(dir, 'real', 'f'))
  assert.notEqual(k(path.join(dir, 'real', 'F')), k(path.join(dir, 'real', 'f')))
})

test('pathKey: keying a win32 path on another host does not consult the host file system (no injected fs)', () => {
  if (process.platform === 'win32') return
  assert.equal(pathKey('C:\\Users\\A\\.codex\\config.toml', { platform: 'win32' }), 'c:/users/a/.codex/config.toml')
})

// fsyncDir is the repo's ONE directory fsync (the platform-seam rule): a platform that cannot fsync a directory is not a
// failed write — but a real error must still be thrown, or a seal "succeeds" and keeps its plaintext (test-machine run P1).
for (const code of ['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF']) {
  test(`fsyncDir: ${code} on the directory fd is tolerated, and the fd is closed`, () => {
    const dir = tmpDir('trocar-fsy-')
    let closed = 0
    fsyncDir({ ...fs, fsyncSync: () => { throw errno(code) }, closeSync: (fd) => { closed++; return fs.closeSync(fd) } }, dir)
    assert.equal(closed, 1)
  })
}
test('fsyncDir: any other error is thrown', () => {
  const dir = tmpDir('trocar-fsy-')
  assert.throws(() => fsyncDir({ ...fs, fsyncSync: () => { throw errno('EIO') } }, dir), /EIO/)
})

test('readBounded reads at most the limit of a regular file, through a link too, and anything else is not-regular', () => {
  const dir = tmpDir('trocar-fsu-')
  const file = path.join(dir, 'a'), link = path.join(dir, 'b')
  fs.writeFileSync(file, 'abcdef')
  fs.symlinkSync(file, link)
  for (const at of [file, link]) assert.equal(String(readBounded(fs, at, 4)), 'abcd')
  assert.throws(() => readBounded(fs, dir, 4), { code: 'not-regular' })
  assert.throws(() => readBounded(fs, path.join(dir, 'gone'), 4), { code: 'ENOENT' })
})

test('readSmall: the text of a file up to its limit, and over it too-big, never a prefix', () => {
  const file = path.join(tmpDir('trocar-fsu-'), 'a')
  for (const [text, limit] of [['', 1], ['中', 3]]) {
    fs.writeFileSync(file, text)
    assert.equal(readSmall(fs, file, limit), text)
  }
  fs.writeFileSync(file, 'abcd')
  assert.throws(() => readSmall(fs, file, 3), { code: 'too-big' })
})
