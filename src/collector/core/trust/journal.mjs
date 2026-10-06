// journal.mjs — the per-user install manifest and the install half of its journal (RFC 4.6 §安装清单与卸载,
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
// The undo half (undoEntry, removeOwnedFile, describeEntry) and the file primitives moved to src/off/ (D39⑤, 0.1 §2: `asight off`
// and the standalone asight-off run without the repo); they are re-exported below so every importer of this module keeps working.
import nodeFs from 'node:fs'
import path from 'node:path'
import { setKey } from '../../../off/json-text.mjs'
import { dotenvBlock, insertLine, BLOCK_BEGIN } from '../../../off/text-edit.mjs'
import { sha256, readOrNull, writeDurable, missingDirs, editTarget } from '../../../off/fsutil.mjs'
import { saveManifest, undoByHand } from '../../../off/manifest.mjs'

export { sha256, writeDurable, sweepTemps, missingDirs, removeEmptyDirs, editTarget } from '../../../off/fsutil.mjs'
export { undoEntry, removeOwnedFile, describeEntry } from '../../../off/journal.mjs'
export { MANIFEST, manifestPath, newManifest, readManifest, saveManifest } from '../../../off/manifest.mjs'

// A file asight owns (a trust file of certificate blocks, a trust plugin, a launch shim): listed before it is written,
// with the directories its write creates. `sources` names the user files a trust file carries certificates from
// (paths, never contents), so the merge stays auditable. `exclusive`: a file already there is never written over
// (an agent's plugin directory is the user's; asight only adds its own file to it).
export function writeOwnedFile({ dir, manifest, harness = null, role, file, data, sources = null, mode = 0o600, exclusive = false, extra = {}, now = new Date(), fs = nodeFs }) {
  if (exclusive && fs.existsSync(file)) throw new Error(`${file} already exists; asight will not write over it`)
  const created = missingDirs(path.dirname(file), fs)
  const item = { kind: 'owned-file', path: file, role, harness, sha256: sha256(Buffer.from(data)), mode, created_dirs: created, installed_at: now.toISOString(), ...(sources ? { sources } : {}), ...extra }
  item.undo_by_hand = undoByHand(item)
  manifest.files.push(item)
  saveManifest(dir, manifest, fs)
  for (const d of created) fs.mkdirSync(d, { mode: 0o700 })
  writeDurable(file, data, mode, fs)
}

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
    kind: 'json-key', harness, path: file, ...(real !== file ? { real_path: real } : {}), keys, value,
    existed_before: before != null, mode: before != null ? fs.statSync(real).mode & 0o777 : 0o600,
    pre_sha256: sha256(before), post_sha256: null, ops: res.ops, prior_value: res.prior,
    existing_depth: res.existingDepth, created_dirs: missingDirs(path.dirname(file), fs), installed_at: now.toISOString(),
  }
  entry.undo_by_hand = undoByHand(entry)
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
  entry.undo_by_hand = undoByHand(entry)
  manifest.entries.push(entry)
  saveManifest(dir, manifest, fs) // the intent is durable before the user's file changes
  for (const d of entry.created_dirs) fs.mkdirSync(d, { mode: 0o700 })
  writeDurable(real, res.text, entry.mode, fs)
  entry.post_sha256 = sha256(Buffer.from(res.text))
  saveManifest(dir, manifest, fs)
  return entry
}

// When asight installed the value a config layer holds (ms), or null. A layer counts when an entry changed its file
// (`path`, or the link target `real_path`) and the layer still holds that entry's value (under its key, or the name a
// descriptor gives it, e.g. zcode:user:caCertFile), or every variable of its dotenv block; the tracker then judges
// config-after-start against this time, not the file's mtime, so an unrelated later edit of the same file (Hermes
// rewrites its .env when it tidies it) does not make a process that started after install look stale (review 2 #5).
export function installedAt(manifest, layer) {
  if (!manifest || !layer || !layer.file || !layer.vars) return null
  for (const e of manifest.entries || []) {
    if (e.path !== layer.file && e.real_path !== layer.file) continue
    const t = Date.parse(e.installed_at)
    if (!Number.isFinite(t)) continue
    if (e.vars) { if (Object.entries(e.vars).every(([k, v]) => layer.vars[k] === v)) return t; continue } // a dotenv block
    if (e.value != null && Object.values(layer.vars).includes(e.value)) return t // under its key, or a descriptor's pseudo-variable
  }
  return null
}
