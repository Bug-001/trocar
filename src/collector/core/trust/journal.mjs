// journal.mjs — the per-user install manifest and the undo of every trust entry it lists (RFC 4.6 §安装清单与卸载,
// 「信任入口的日志与撤销」, acceptance T11). One JSON file, ~/.asight/collector/install-manifest.json (0600):
//   dirs     directories asight created (removed at the end of uninstall if empty)
//   files    files asight owns (CA, extra trust files) — deleted on uninstall
//   entries  every user file asight changed: {path, existed_before, mode, pre_sha256, post_sha256, ops,
//            prior_value, installed_at} + {harness, keys, value, existing_depth, created_dirs}. ops are splices
//            {offset, removed, inserted}; `removed` is only ever the value asight replaced (a path, never a
//            secret). The user's file is NEVER copied here (Codex / Hermes .env files hold API keys).
// Write-ahead: the intent (no post_sha256) is fsynced before the user's file is touched, so an install that
// crashed half-way is still found and undone. No whole-file snapshot rollback, ever (D28).
import nodeFs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { setKey, removeKey, reverseOps, getPath } from './json-text.mjs'

export const MANIFEST = 'install-manifest.json'
export const manifestPath = (dir) => path.join(dir, MANIFEST)
export const sha256 = (data) => (data == null ? null : crypto.createHash('sha256').update(data).digest('hex'))

function readOrNull(fs, file) { try { return fs.readFileSync(file) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
function syncDir(fs, dir) { try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } } catch { /* a filesystem that refuses dir fsync */ } }

// Atomic and durable: temp file in the same directory, fsync, rename over, fsync the directory.
export function writeDurable(file, data, mode, fs = nodeFs) {
  const tmp = `${file}.asight-tmp-${process.pid}`
  const fd = fs.openSync(tmp, 'w', mode)
  try { fs.writeSync(fd, data); fs.fchmodSync(fd, mode); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, file)
  syncDir(fs, path.dirname(file))
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

export const newManifest = (now = new Date()) => ({ version: 1, created_at: now.toISOString(), complete: false, engine_port: null, planned: [], dirs: [], files: [], entries: [] })
export function readManifest(dir, fs = nodeFs) {
  const b = readOrNull(fs, manifestPath(dir))
  return b == null ? null : JSON.parse(b.toString('utf8'))
}
export function saveManifest(dir, m, fs = nodeFs) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeDurable(manifestPath(dir), JSON.stringify(m, null, 2) + '\n', 0o600, fs)
}

// A file asight owns (e.g. a trust file of certificate blocks): listed before it is written, 0600. `sources` names the
// user files a trust file carries certificates from (paths, never contents), so the merge stays auditable.
export function writeOwnedFile({ dir, manifest, harness = null, role, file, data, sources = null, fs = nodeFs }) {
  manifest.files.push({ path: file, role, harness, sha256: sha256(Buffer.from(data)), ...(sources ? { sources } : {}) })
  saveManifest(dir, manifest, fs)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeDurable(file, data, 0o600, fs)
}

// Set one string key in a JSON file the user owns (CC settings.json, Z-Code config.json). Returns the entry, or
// null when the key already holds this value (nothing to change, nothing to undo).
export function applyJsonKey({ dir, manifest, harness, file, keys, value, now = new Date(), fs = nodeFs }) {
  const before = readOrNull(fs, file)
  const res = setKey(before == null ? null : before.toString('utf8'), keys, value) // parse-checked before any write
  if (res.prior === value) return null
  const entry = {
    harness, path: file, keys, value,
    existed_before: before != null, mode: before != null ? fs.statSync(file).mode & 0o777 : 0o600,
    pre_sha256: sha256(before), post_sha256: null, ops: res.ops, prior_value: res.prior,
    existing_depth: res.existingDepth, created_dirs: missingDirs(path.dirname(file), fs), installed_at: now.toISOString(),
  }
  manifest.entries.push(entry)
  saveManifest(dir, manifest, fs) // the intent is durable before the user's file changes
  for (const d of entry.created_dirs) fs.mkdirSync(d, { mode: 0o700 })
  writeDurable(file, res.text, entry.mode, fs)
  entry.post_sha256 = sha256(Buffer.from(res.text))
  saveManifest(dir, manifest, fs)
  return entry
}

// Undo one entry by the 4.6 rules: untouched since install → byte-identical; already back → say so; edited since →
// remove only asight's key (or put the user's prior value back), leave every other byte alone.
export function undoEntry(entry, { fs = nodeFs } = {}) {
  const file = entry.path
  const done = (result, extra = {}) => ({ path: file, harness: entry.harness, result, ...extra })
  const cur = readOrNull(fs, file)
  if (entry.existed_before ? sha256(cur) === entry.pre_sha256 : cur == null) return done('already-restored')
  if (cur == null) return done('missing') // the user deleted a file that existed before: nothing of asight's left
  const text = cur.toString('utf8')
  const asInstalled = entry.post_sha256 == null || sha256(cur) === entry.post_sha256 // intent-only: test by reversing
  const back = asInstalled ? reverseOps(text, entry.ops) : null
  if (back != null && (entry.existed_before ? sha256(Buffer.from(back)) === entry.pre_sha256 : back === '')) {
    if (entry.existed_before) writeDurable(file, back, entry.mode, fs)
    else { fs.rmSync(file, { force: true }); removeEmptyDirs(entry.created_dirs, fs) }
    return done('restored')
  }
  let doc
  try { doc = JSON.parse(text) } catch { return done('left-unparsable') }
  if (getPath(doc, entry.keys) !== entry.value) return done('left-user-value')
  let out = entry.prior_value != null ? setKey(text, entry.keys, entry.prior_value).text : removeKey(text, entry.keys).text
  if (entry.prior_value == null) {
    for (let d = entry.keys.length - 1; d > entry.existing_depth; d--) { // parents this install created, now empty
      const v = getPath(JSON.parse(out), entry.keys.slice(0, d))
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length) break
      out = removeKey(out, entry.keys.slice(0, d)).text
    }
  }
  const empty = (() => { const v = JSON.parse(out); return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0 })()
  if (!entry.existed_before && empty) { fs.rmSync(file, { force: true }); removeEmptyDirs(entry.created_dirs, fs); return done('reverted-not-identical', { deleted: true }) }
  writeDurable(file, out, fs.statSync(file).mode & 0o777, fs)
  return done('reverted-not-identical')
}
