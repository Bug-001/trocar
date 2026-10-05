// journal.mjs — the per-user install manifest and the undo of every trust entry it lists (RFC 4.6 §安装清单与卸载,
// 「信任入口的日志与撤销」, acceptance T11). One JSON file, ~/.asight/collector/install-manifest.json (0600):
//   dirs     directories asight created (removed at the end of uninstall if empty)
//   files    files asight owns (CA, extra trust files) — deleted on uninstall
//   entries  every user file asight changed: {path, existed_before, mode, pre_sha256, post_sha256, ops,
//            prior_value, installed_at, created_dirs} + per kind: `json-key` (no kind on older manifests) {keys,
//            value, existing_depth}; `text` {format, vars | line} (text-edit.mjs: a dotenv block, a shell-rc line,
//            a YAML list row). ops are splices {offset, removed, inserted}; `removed` is only ever the value asight
//            replaced (a path, or a YAML `[]`, never a secret). The user's file is NEVER copied here (Codex /
//            Hermes .env files hold API keys).
// Write-ahead: the intent (no post_sha256) is fsynced before the user's file is touched, so an install that
// crashed half-way is still found and undone. No whole-file snapshot rollback, ever (D28).
import nodeFs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { setKey, removeKey, reverseOps, getPath } from './json-text.mjs'
import { dotenvBlock, insertLine, removeAsightText, onlySkeleton, BLOCK_BEGIN } from './text-edit.mjs'

export const MANIFEST = 'install-manifest.json'
export const manifestPath = (dir) => path.join(dir, MANIFEST)
export const sha256 = (data) => (data == null ? null : crypto.createHash('sha256').update(data).digest('hex'))

function readOrNull(fs, file) { try { return fs.readFileSync(file) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
function syncDir(fs, dir) { try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } } catch { /* a filesystem that refuses dir fsync */ } }

// Atomic and durable: temp file in the same directory, fsync, rename over, fsync the directory.
const TMP_MARK = '.asight-tmp-'
export function writeDurable(file, data, mode, fs = nodeFs) {
  const tmp = `${file}${TMP_MARK}${process.pid}`
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

export const newManifest = (now = new Date()) => ({ version: 1, created_at: now.toISOString(), complete: false, engine_port: null, planned: [], dirs: [], files: [], entries: [] })
export function readManifest(dir, fs = nodeFs) {
  const b = readOrNull(fs, manifestPath(dir))
  return b == null ? null : JSON.parse(b.toString('utf8'))
}
export function saveManifest(dir, m, fs = nodeFs) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeDurable(manifestPath(dir), JSON.stringify(m, null, 2) + '\n', 0o600, fs)
}

// A file asight owns (a trust file of certificate blocks, a trust plugin, a launch shim): listed before it is written,
// with the directories its write creates. `sources` names the user files a trust file carries certificates from
// (paths, never contents), so the merge stays auditable. `exclusive`: a file already there is never written over
// (an agent's plugin directory is the user's; asight only adds its own file to it).
export function writeOwnedFile({ dir, manifest, harness = null, role, file, data, sources = null, mode = 0o600, exclusive = false, extra = {}, fs = nodeFs }) {
  if (exclusive && fs.existsSync(file)) throw new Error(`${file} already exists; asight will not write over it`)
  const created = missingDirs(path.dirname(file), fs)
  manifest.files.push({ path: file, role, harness, sha256: sha256(Buffer.from(data)), mode, created_dirs: created, ...(sources ? { sources } : {}), ...extra })
  saveManifest(dir, manifest, fs)
  for (const d of created) fs.mkdirSync(d, { mode: 0o700 })
  writeDurable(file, data, mode, fs)
}

// Remove a file asight owns, then the directories its write created when they are empty. `changed`: the file was
// not what asight wrote (removed all the same: it is asight's, the manifest lists it; the caller says so).
export function removeOwnedFile(item, fs = nodeFs) {
  sweepTemps(item.path, fs)
  const cur = readOrNull(fs, item.path)
  if (cur == null) { removeEmptyDirs(item.created_dirs, fs); return { path: item.path, result: 'already-removed' } }
  fs.rmSync(item.path, { force: true })
  removeEmptyDirs(item.created_dirs, fs)
  return { path: item.path, result: 'removed', ...(item.sha256 && sha256(cur) !== item.sha256 ? { changed: true } : {}) }
}

// Set one string key in a JSON file the user owns (CC settings.json, Z-Code config.json). Returns the entry, or
// null when the key already holds this value (nothing to change, nothing to undo).
// What applyJsonKey would do, without writing: every refusal (a link to nothing or to a non-regular file, a file
// that is not a JSON object, a non-object parent) is raised here, so install can run them all before it writes
// anything. Returns the file that would change (`real_path` when `file` is a link) and whether it would change.
export function previewJsonKey({ file, keys, value, fs = nodeFs }) {
  const real = editTarget(file, fs)
  const before = readOrNull(fs, real)
  const res = setKey(before == null ? null : before.toString('utf8'), keys, value)
  return { path: file, ...(real !== file ? { real_path: real } : {}), changes: res.prior !== value }
}

// A symlinked file is edited at its target; the entry records both (`path` the link, `real_path` the target).
export function applyJsonKey({ dir, manifest, harness, file, keys, value, now = new Date(), fs = nodeFs }) {
  const real = editTarget(file, fs)
  const before = readOrNull(fs, real)
  const res = setKey(before == null ? null : before.toString('utf8'), keys, value) // parse-checked before any write
  if (res.prior === value) return null
  const entry = {
    harness, path: file, ...(real !== file ? { real_path: real } : {}), keys, value,
    existed_before: before != null, mode: before != null ? fs.statSync(real).mode & 0o777 : 0o600,
    pre_sha256: sha256(before), post_sha256: null, ops: res.ops, prior_value: res.prior,
    existing_depth: res.existingDepth, created_dirs: missingDirs(path.dirname(file), fs), installed_at: now.toISOString(),
  }
  manifest.entries.push(entry)
  saveManifest(dir, manifest, fs) // the intent is durable before the user's file changes
  for (const d of entry.created_dirs) fs.mkdirSync(d, { mode: 0o700 })
  writeDurable(real, res.text, entry.mode, fs)
  entry.post_sha256 = sha256(Buffer.from(res.text))
  saveManifest(dir, manifest, fs)
  return entry
}

// A text entry (text-edit.mjs): edit = { format: 'dotenv-block', vars } | { format: 'line', line, after? } |
// { format: 'yaml-list', line }. Text asight already put there under an install this manifest does not list is
// refused: a second block or row would only be undone once.
function editText(file, text, edit) {
  if (text != null && (text.includes(BLOCK_BEGIN) || (edit.line && text.includes(edit.line)))) {
    throw new Error(`${file} already holds asight's text from an install this manifest does not list; take it out, then install again`)
  }
  try {
    if (edit.format === 'dotenv-block') return dotenvBlock(text, edit.vars)
    if (edit.format === 'line' || edit.format === 'yaml-list') return { ...insertLine(text, { line: edit.line, after: edit.after || null, format: edit.format === 'yaml-list' ? 'yaml-list' : 'lines' }), prior: null }
  } catch (e) { throw new Error(`${file}: ${e.message}`) }
  throw new Error(`${file}: unknown text edit ${edit.format}`)
}
export function previewTextEntry({ file, edit, fs = nodeFs }) {
  const real = editTarget(file, fs)
  const before = readOrNull(fs, real)
  editText(file, before == null ? null : before.toString('utf8'), edit)
  return { path: file, ...(real !== file ? { real_path: real } : {}), changes: true }
}
export function applyTextEntry({ dir, manifest, harness, file, edit, now = new Date(), fs = nodeFs }) {
  const real = editTarget(file, fs)
  const before = readOrNull(fs, real)
  const res = editText(file, before == null ? null : before.toString('utf8'), edit)
  const entry = {
    kind: 'text', harness, path: file, ...(real !== file ? { real_path: real } : {}), format: edit.format,
    ...(edit.vars ? { vars: edit.vars } : { line: edit.line }),
    existed_before: before != null, mode: before != null ? fs.statSync(real).mode & 0o777 : (edit.mode || 0o600),
    pre_sha256: sha256(before), post_sha256: null, ops: res.ops, prior_value: res.prior,
    created_dirs: missingDirs(path.dirname(file), fs), installed_at: now.toISOString(),
  }
  manifest.entries.push(entry)
  saveManifest(dir, manifest, fs) // the intent is durable before the user's file changes
  for (const d of entry.created_dirs) fs.mkdirSync(d, { mode: 0o700 })
  writeDurable(real, res.text, entry.mode, fs)
  entry.post_sha256 = sha256(Buffer.from(res.text))
  saveManifest(dir, manifest, fs)
  return entry
}

// What an entry put where, for messages: the key and value of a JSON entry, the variables of a block, the line.
export const describeEntry = (e) => (e.kind === 'text'
  ? (e.vars ? `block with ${Object.entries(e.vars).map(([k, v]) => `${k}=${v}`).join(', ')}` : `line ${JSON.stringify(e.line)}`)
  : `${e.keys.join('.')} = ${e.value}`)

// When asight installed the value a config layer holds (ms), or null. A layer counts when an entry changed its file
// (`path`, or the link target `real_path`) and the layer still holds that entry's value under its last key, or every
// variable of its dotenv block; the tracker then judges config-after-start against this time, not the file's mtime,
// so an unrelated later edit of the same file (Hermes rewrites its .env when it tidies it) does not make a process
// that started after install look stale (review 2 #5).
export function installedAt(manifest, layer) {
  if (!manifest || !layer || !layer.file || !layer.vars) return null
  for (const e of manifest.entries || []) {
    if (e.path !== layer.file && e.real_path !== layer.file) continue
    const t = Date.parse(e.installed_at)
    if (!Number.isFinite(t)) continue
    if (e.vars) { if (Object.entries(e.vars).every(([k, v]) => layer.vars[k] === v)) return t; continue } // a dotenv block
    const key = Array.isArray(e.keys) ? e.keys[e.keys.length - 1] : null
    if (key != null && layer.vars[key] === e.value) return t
  }
  return null
}

// Undo one entry by the 4.6 rules: untouched since install → byte-identical; already back → say so; edited since →
// remove only asight's key (or put the user's prior value back), leave every other byte alone.
// The file to undo, resolved again now. A path that is a symlink today is never written or deleted over: it must
// still lead to the file asight changed (`real_path`, or the path itself when that was a regular file at install),
// else uninstall leaves it alone and says where asight's key may still be (`left-link`).
function undoTarget(entry, fs) {
  const changed = entry.real_path || entry.path
  let st = null
  try { st = fs.lstatSync(entry.path) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (!st || !st.isSymbolicLink()) {
    if (!entry.real_path) return { file: entry.path }
    return { refuse: `${entry.path} ${st ? 'is no longer a symbolic link' : 'is gone'}; asight changed ${changed} through it` }
  }
  let real = null
  try { real = fs.realpathSync(entry.path) } catch { /* a link to nothing */ }
  if (real !== changed) return { refuse: `${entry.path} is now a symbolic link to ${real || 'nothing'}, not to ${changed}, the file asight changed` }
  return { file: real }
}

// A crash between the intent and the write leaves the directories it created and maybe a temp file: both go.
export function undoEntry(entry, { fs = nodeFs } = {}) {
  const done = (result, extra = {}) => ({ path: entry.path, ...(entry.real_path ? { real_path: entry.real_path } : {}), harness: entry.harness, result, ...extra })
  const target = undoTarget(entry, fs)
  if (target.refuse) return done('left-link', { reason: `${target.refuse}; asight did not touch it, and its ${describeEntry(entry)} may still be in ${entry.real_path || entry.path}` })
  const file = target.file
  sweepTemps(file, fs)
  const cur = readOrNull(fs, file)
  if (entry.existed_before ? sha256(cur) === entry.pre_sha256 : cur == null) {
    if (!entry.existed_before) removeEmptyDirs(entry.created_dirs, fs)
    return done('already-restored')
  }
  if (cur == null) return done('missing') // the user deleted a file that existed before: nothing of asight's left
  const text = cur.toString('utf8')
  const asInstalled = entry.post_sha256 == null || sha256(cur) === entry.post_sha256 // intent-only: test by reversing
  const back = asInstalled ? reverseOps(text, entry.ops) : null
  if (back != null && (entry.existed_before ? sha256(Buffer.from(back)) === entry.pre_sha256 : back === '')) {
    if (entry.existed_before) writeDurable(file, back, entry.mode, fs)
    else { fs.rmSync(file, { force: true }); removeEmptyDirs(entry.created_dirs, fs) }
    return done('restored')
  }
  if (entry.kind === 'text') { // edited since: only asight's block / line goes, the user's commented line comes back
    const out = removeAsightText(text, entry.ops)
    if (!out.found) return done('already-removed')
    if (!entry.existed_before && onlySkeleton(out.text, entry.format)) { fs.rmSync(file, { force: true }); removeEmptyDirs(entry.created_dirs, fs); return done('reverted-not-identical', { deleted: true }) }
    writeDurable(file, out.text, fs.statSync(file).mode & 0o777, fs)
    return done('reverted-not-identical')
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
