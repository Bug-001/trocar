// fsutil.mjs — the file primitives both halves of the install journal stand on: the hash, the durable atomic write, the
// directories a write creates, the temp files a crash leaves, and the file a symlinked path really edits (RFC 4.6 §安装清单与卸载,
// D28). They live in src/off/ because `asight off` and the standalone `~/.asight/bin/asight-off` need them without the repo
// (0.1 §2: this directory imports only node:* and itself); the install side (src/collector/core/trust/journal.mjs) imports them.
// Every function that touches the disk takes `fs` last, default node:fs, so a test can inject a spy or a failing one.
import nodeFs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const sha256 = (data) => (data == null ? null : crypto.createHash('sha256').update(data).digest('hex'))

/** The file's bytes, or null when it is not there; any other error is thrown. */
export function readOrNull(fs, file) { try { return fs.readFileSync(file) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }

/** fsync a directory so a rename or a created file in it is durable; a filesystem that refuses it is not an error. */
export function fsyncDir(fs, dir) { try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } } catch { /* a filesystem that refuses dir fsync */ } }

// Atomic and durable: temp file in the same directory, fsync, rename over, fsync the directory.
export const TMP_MARK = '.asight-tmp-'
export function writeDurable(file, data, mode, fs = nodeFs) {
  const tmp = `${file}${TMP_MARK}${process.pid}`
  const fd = fs.openSync(tmp, 'w', mode)
  try { fs.writeSync(fd, data); fs.fchmodSync(fd, mode); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, file)
  fsyncDir(fs, path.dirname(file))
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
// Temp files a crashed write left next to `file` (4.6「不留残余」): <file>.asight-tmp-<pid>, and the CA store's <file>.tmp-<pid>.
export function sweepTemps(file, fs = nodeFs) {
  const base = path.basename(file)
  let names = []
  try { names = fs.readdirSync(path.dirname(file)) } catch { return [] }
  const gone = names.filter((n) => n.startsWith(base + TMP_MARK) || n.startsWith(base + '.tmp-')).map((n) => path.join(path.dirname(file), n))
  for (const f of gone) fs.rmSync(f, { force: true })
  return gone
}

// The file asight edits for `file`: itself, or the regular file a symlink resolves to (a dotfiles setup). The link
// is never replaced by a regular file; a link to nothing, or to something that is not a regular file, is refused.
export function editTarget(file, fs = nodeFs) {
  let st = null
  try { st = fs.lstatSync(file) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (!st || !st.isSymbolicLink()) return file
  let real
  try { real = fs.realpathSync(file) } catch { throw new Error(`${file} is a symbolic link to a file that does not exist; asight will not create a file through it or replace the link. Fix or remove the link, then install again`) }
  if (!fs.statSync(real).isFile()) throw new Error(`${file} links to ${real}, which is not a regular file; asight will not change it`)
  return real
}
