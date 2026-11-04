// backup.mjs — the copy of a user's file trocar saves BEFORE it changes the file (RFC 1.6 R2, D39③).
//   where   ~/.trocar/backup/ (0700), each file 0600 — a backup holds API keys, so it has the capture data's protection (4.1 §凭据处置)
//   name    <first 16 hex of sha256(resolved original path)>-<UTC YYYYMMDDTHHMMSSmmmZ>[-n]: found by path without the manifest; one per
//           change; a name that is taken gets -1, -2 … — never written over (an `off` that kept one leaves it for the user)
//   rule    a backup that cannot be written means the file is not changed (the caller turns the throw into `backup-failed`)
//   never   used to put a whole file back (1.6 R2: undo takes out only trocar's key / block / line). Only a JSON key replaced by trocar that
//           the manifest lost is read back from one, by marker (1.6 R3).
// The manifest names a backup by path and holds the file's `pre_sha256`; it never holds the contents. Imports only node:* and src/off.
import nodeFs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { backupDir } from './paths.mjs'
import { fsyncDir } from './fsutil.mjs'

const pathHash = (file) => crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 16)
const NAME = /^[0-9a-f]{16}-\d{8}T\d{9}Z(?:-\d+)?$/

/** The backup name of `file` at `now`: `<sha256(path)[0:16]>-<UTC, to the millisecond>`. */
export const backupName = (file, now = new Date()) => `${pathHash(file)}-${now.toISOString().replace(/[-:.]/g, '')}`

/** Saves `data` (the bytes of `file` before the change) in ~/.trocar/backup/ and returns its path. Creates the directory 0700 (an existing
 *  one is tightened to it), writes the file exclusively and 0600, fsyncs it and the directory. A failure removes what it wrote and throws. */
export function writeBackup({ home, file, data, now = new Date(), fs = nodeFs }) {
  const dir = backupDir(home)
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700) // the umask can only have taken bits away from 0700, but a directory that was there may be looser
  const base = backupName(file, now)
  for (let n = 0; n < 1000; n++) {
    const p = path.join(dir, n === 0 ? base : `${base}-${n}`)
    let fd
    try { fd = fs.openSync(p, 'wx', 0o600) } catch (e) { if (e.code === 'EEXIST') continue; throw e }
    try {
      for (let at = 0; at < buf.length;) at += fs.writeSync(fd, buf, at, buf.length - at)
      fs.fchmodSync(fd, 0o600) // not the umask's idea of 0600
      fs.fsyncSync(fd)
    } catch (e) {
      try { fs.closeSync(fd) } catch { /* already failing */ }
      try { fs.rmSync(p, { force: true }) } catch { /* a half-written backup left would look like a good one */ }
      throw e
    }
    fs.closeSync(fd)
    fsyncDir(fs, dir)
    return p
  }
  throw Object.assign(new Error(`${dir} already holds 1000 backups named ${base}`), { code: 'EEXIST' })
}

/** Removes one backup. True when it removed one, false when it was already gone — or when `p` is not a file writeBackup could have made
 *  (a name of another shape, or a directory not called backup): a manifest that names the user's own file as its backup deletes nothing. */
export function dropBackup(p, fs = nodeFs) {
  if (typeof p !== 'string' || !NAME.test(path.basename(p)) || path.basename(path.dirname(p)) !== 'backup') return false
  try { fs.unlinkSync(p); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e }
}

// every backup of any file, sorted by name (so by original path, then time); [] when there is no backup directory
function listBackups(home, fs) {
  let names
  try { names = fs.readdirSync(backupDir(home)) } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return []; throw e }
  return names.filter((n) => NAME.test(n)).sort().map((n) => path.join(backupDir(home), n))
}

/** The backups of `file`, oldest first — found by the path alone, with no manifest. */
export function backupsOf({ home, file, fs = nodeFs }) {
  const prefix = `${pathHash(file)}-`
  return listBackups(home, fs).filter((p) => path.basename(p).startsWith(prefix))
}

/** The backups no manifest entry, no `kept_backups` row and not the `path_item` names; all of them when there is no manifest. `off` and `doctor` list them. */
export function orphanBackups({ home, manifest, fs = nodeFs }) {
  const named = new Set()
  for (const row of [...((manifest && manifest.entries) || []), ...((manifest && manifest.kept_backups) || []), manifest && manifest.path_item]) if (row && typeof row.backup === 'string') named.add(path.resolve(row.backup))
  return listBackups(home, fs).filter((p) => !named.has(path.resolve(p)))
}
