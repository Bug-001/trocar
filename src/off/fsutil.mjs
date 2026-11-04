// fsutil.mjs — the file primitives both halves of the install journal stand on: the hash, the durable atomic write, the
// directories a write creates, the temp files a crash leaves, and the file a symlinked path really edits (RFC 4.6 §安装清单与卸载,
// 1.6 R2). They live in src/off/ because `trocar off` and the standalone `~/.trocar/bin/trocar-off` need them without the repo
// (0.1 §2: this directory imports only node:* and itself); the install side (src/collector/core/trust/journal.mjs) imports them.
// Every function that touches the disk takes `fs` last, default node:fs, so a test can inject a spy or a failing one.
import nodeFs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const sha256 = (data) => (data == null ? null : crypto.createHash('sha256').update(data).digest('hex'))

/** The file's bytes, or null when it is not there; any other error is thrown. */
export function readOrNull(fs, file) { try { return fs.readFileSync(file) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }

const notRegular = () => Object.assign(new Error('not a regular file'), { code: 'not-regular' })

/** At most `limit` bytes of a regular file. Throws for anything else, the file's own error or `not-regular`. A path swapped for a FIFO after the stat
 *  still cannot block: O_NONBLOCK, then fstat what was opened. */
export function readBounded(fs, file, limit) {
  if (!fs.statSync(file).isFile()) throw notRegular()
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0))
  try {
    if (!fs.fstatSync(fd).isFile()) throw notRegular()
    const buf = Buffer.allocUnsafe(limit)
    let got = 0
    for (let n; got < limit && (n = fs.readSync(fd, buf, got, limit - got, got)) > 0;) got += n
    return buf.subarray(0, got)
  } finally { fs.closeSync(fd) }
}

// Far over anything the collector's own small files reach: a thousand rules' stats are about a megabyte.
const SMALL_FILE_BYTES = 4 * 1024 * 1024
/** The text of one of the collector's own small files, under readBounded's terms: what `rules off` and `off` go through cannot hang on it. Throws the file's own error, `not-regular`
 *  or `too-big`. */
export function readSmall(fs, file, limit = SMALL_FILE_BYTES) {
  const stat = fs.statSync(file)
  if (!stat.isFile()) throw notRegular()
  if (stat.size > limit) throw Object.assign(new Error(`over ${limit} bytes`), { code: 'too-big' })
  return fs.readFileSync(file, { encoding: 'utf8', flag: fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) })
}

// A directory cannot be fsynced everywhere (Windows refuses the open or the fsync with EPERM / EISDIR / EBADF, some network
// file systems with EINVAL / ENOTSUP): that is not a failed write, the rename is done. Anything ELSE is a real failure and is
// thrown — swallowing it is what left every Windows segment with its plaintext beside the sealed file (tested 2026-10-18).
// By errno, never by platform (X16). This is the ONE fsyncDir in the repo (the platform-seam rule: one place per platform concern).
const NO_DIR_FSYNC = new Set(['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF'])
/** fsync a directory so a rename or a created file in it is durable; a file system that cannot do it is not an error. */
export function fsyncDir(fs, dir) {
  let fd
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd) } catch (e) { if (!NO_DIR_FSYNC.has(e && e.code)) throw e } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch { /* the sync above is what counted */ } }
}

// Atomic and durable: temp file in the same directory, fsync, rename over, fsync the directory. A rename that fails because another
// process holds the target open for a moment (Windows: an editor, a scanner, the agent itself, without FILE_SHARE_DELETE) is tried again
// with a bounded backoff, about a second in all; which errors are retried is by errno, never by platform (X16). Whatever fails, the temp
// file is removed before the error is thrown: a write that did not land leaves nothing next to the user's file.
export const TMP_MARK = '.trocar-tmp-'
const RENAME_BUSY = new Set(['EBUSY', 'EPERM', 'EACCES'])
const RENAME_WAITS = [10, 20, 40, 60, 80, 100, 120, 150, 200, 220] // ms between tries; 1 s in all
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) // a synchronous wait: every writer here is synchronous
function renameRetrying(fs, from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to) } catch (e) {
      if (!(e && RENAME_BUSY.has(e.code)) || i >= RENAME_WAITS.length) throw e
      pause(RENAME_WAITS[i])
    }
  }
}
export function writeDurable(file, data, mode, fs = nodeFs, beforeRename = () => {}) {
  const tmp = `${file}${TMP_MARK}${process.pid}`
  const fd = fs.openSync(tmp, 'w', mode)
  try {
    try { fs.writeSync(fd, data); fs.fchmodSync(fd, mode); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    beforeRename() // the last word on the write: it throws and nothing lands
    renameRetrying(fs, tmp, file)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* the error to report is the write's */ }
    throw e
  }
  fsyncDir(fs, path.dirname(file))
}

// The identity of a path (X18, RFC 4.9 route-plan row): the one key every comparison of "is this the same file" in the journal and the
// route plans uses, so a later run that spells a recorded path otherwise (another case, an 8.3 short name, a linked directory, `\` for `/`)
// finds the same entry. The nearest existing ancestor of the file is replaced by what the file system says it is (realpath.native: expands
// short names, follows junctions and directory links), the rest is appended as written; win32 keys use `/`; win32 and darwin fold case
// (NTFS / APFS are case-insensitive by default) and darwin also folds Unicode normalisation (APFS looks names up without regard to it).
// No branch for any one spelling: the file system decides. `realpath` is how it is asked (a function of a directory; null: not at all, the key
// is the path resolved and folded); left out, the host's realpath.native is asked only when it is the platform being keyed: a win32 path keyed on a
// Mac is not a Mac path.
export function pathKey(p, { platform = process.platform, realpath } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix
  const ask = realpath !== undefined ? realpath : platform === process.platform ? (d) => nodeFs.realpathSync.native(d) : null
  let key = P.resolve(String(p))
  if (ask) {
    const rest = []
    for (let d = P.dirname(key), b = P.basename(key); ; b = P.basename(d), d = P.dirname(d)) {
      rest.unshift(b)
      let real = null
      try { real = ask(d) } catch { /* not there: try its parent */ }
      if (real) { key = P.join(real, ...rest); break }
      if (P.dirname(d) === d) break
    }
  }
  if (platform === 'win32') key = key.replace(/\\/g, '/')
  if (platform === 'darwin') key = key.normalize('NFC')
  if (platform === 'win32' || platform === 'darwin') key = key.toLowerCase() // not proxy mode: the OSes whose file names are case-insensitive
  return key
}

// Is `p` strictly inside `root`? `..` and a symlinked parent directory are followed (a path that only looks like it is inside is not); `root` itself is not inside. What `off` /
// `uninstall` remove at a path the install manifest gives is checked with this first: a manifest that is damaged, edited, or written by a bug must not take the user's files with it.
export function strictlyInside(root, p, fs = nodeFs) {
  const real = (x) => { try { return fs.realpathSync(x) } catch { return path.resolve(x) } }
  const abs = path.resolve(p)
  return path.join(real(path.dirname(abs)), path.basename(abs)).startsWith(real(root) + path.sep)
}

// The directories that do not exist yet on the way to `dir`, outermost first.
export function missingDirs(dir, fs = nodeFs) {
  const out = []
  for (let d = path.resolve(dir); !fs.existsSync(d); d = path.dirname(d)) out.unshift(d)
  return out
}
export function removeEmptyDirs(dirs, fs = nodeFs) {
  for (const d of [...(dirs || [])].reverse()) { try { fs.rmdirSync(d) } catch { /* not empty, or gone */ } }
}
// Temp files a crashed write left next to `file` (4.6「不留残余」): <file>.trocar-tmp-<pid>, and the CA store's <file>.tmp-<pid>.
export function sweepTemps(file, fs = nodeFs) {
  const base = path.basename(file)
  let names = []
  try { names = fs.readdirSync(path.dirname(file)) } catch { return [] }
  const gone = names.filter((n) => n.startsWith(base + TMP_MARK) || n.startsWith(base + '.tmp-')).map((n) => path.join(path.dirname(file), n))
  for (const f of gone) fs.rmSync(f, { force: true })
  return gone
}

// The file trocar edits for `file`: itself, or the regular file a symlink resolves to (a dotfiles setup). The link
// is never replaced by a regular file; a link to nothing, or to something that is not a regular file, is refused.
export function editTarget(file, fs = nodeFs) {
  let st = null
  try { st = fs.lstatSync(file) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (!st || !st.isSymbolicLink()) return file
  let real
  try { real = fs.realpathSync(file) } catch { throw new Error(`${file} is a symbolic link to a file that does not exist; trocar will not create a file through it or replace the link. Fix or remove the link, then install again`) }
  if (!fs.statSync(real).isFile()) throw new Error(`${file} links to ${real}, which is not a regular file; trocar will not change it`)
  return real
}
