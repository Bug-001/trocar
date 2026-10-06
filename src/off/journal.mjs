// journal.mjs (src/off) — the undo half of the install journal: take one entry or one owned file of the manifest back out by the
// 4.6 rules (RFC 4.6 §安装清单与卸载「撤一个文件的规则」, 1.6 R3; D28: only asight's key / block / line, never a whole-file rollback).
// The install half (applyJsonKey, applyTextEntry, writeOwnedFile) stays in src/collector/core/trust/journal.mjs; this half is here so
// `asight off` and the standalone `~/.asight/bin/asight-off` can run it from node:* alone (0.1 §2).
import nodeFs from 'node:fs'
import { setKey, removeKey, reverseOps, getPath } from './json-text.mjs'
import { removeAsightText, onlySkeleton } from './text-edit.mjs'
import { sha256, readOrNull, writeDurable, removeEmptyDirs, sweepTemps } from './fsutil.mjs'

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

// What an entry put where, for messages: the key and value of a JSON entry, the variables of a block, the line.
export const describeEntry = (e) => (e.kind === 'text'
  ? (e.vars ? `block with ${Object.entries(e.vars).map(([k, v]) => `${k}=${v}`).join(', ')}` : `line ${JSON.stringify(e.line)}`)
  : `${e.keys.join('.')} = ${e.value}`)


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
