// journal.mjs (src/off) — the undo half of the install journal: take one entry or one owned file of the manifest back out by the
// 4.6 rules (RFC 4.6 §安装清单与卸载「撤一个文件的规则」, 1.6 R3; R2: only trocar's key / block / line, never a whole-file rollback).
// The install half (applyJsonKey, applyTextEntry, writeOwnedFile) stays in src/collector/core/trust/journal.mjs; this half is here so
// `trocar off` and the standalone `~/.trocar/bin/trocar-off` can run it from node:* alone (0.1 §2).
import nodeFs from 'node:fs'
import path from 'node:path'
import { setKey, removeKey, removeItem, reverseOps, getPath, parseJsonText, unreadableJson } from './json-text.mjs'
import { removeTrocarText, trocarResidue, onlySkeleton } from './text-edit.mjs'
import { sha256, readOrNull, writeDurable, removeEmptyDirs, sweepTemps } from './fsutil.mjs'
import { decodeText, encodeText, WHY_TEXT } from './text-codec.mjs'

// Remove a file trocar owns, then the directories its write created when they are empty. `changed`: the file was
// not what trocar wrote (removed all the same: it is trocar's, the manifest lists it; the caller says so). `unlessChanged`: a file the agent itself
// writes the user's settings into (a config-library entry, 4.11 P5 / CM18) goes only while it is byte for byte what trocar wrote; otherwise it is the
// user's now and stays (`kept-changed`) — trocar's key in it is undone by its own json-key entry (D48②).
export function removeOwnedFile(item, fs = nodeFs, { unlessChanged = false } = {}) {
  sweepTemps(item.path, fs)
  const cur = readOrNull(fs, item.path)
  if (cur == null) { removeEmptyDirs(item.created_dirs, fs); return { path: item.path, result: 'already-removed' } }
  if (unlessChanged && sha256(cur) !== item.sha256) return { path: item.path, result: 'kept-changed' }
  fs.rmSync(item.path, { force: true })
  removeEmptyDirs(item.created_dirs, fs)
  return { path: item.path, result: 'removed', ...(item.sha256 && sha256(cur) !== item.sha256 ? { changed: true } : {}) }
}

// Undo a P8 install-folder wrapper (owned-file role `wrapper`): while the file at `path` is still trocar's wrapper (`sha256`), the real program moved to
// `real` is put back by a same-volume rename over it; otherwise the agent's update replaced the wrapper by name, and only the moved copy goes. Then the
// copy's directory, when empty. → { path, result: 'restored' | 'removed' | 'already-removed' | 'error', reason? }
export function undoWrapper(item, fs = nodeFs) {
  const cur = readOrNull(fs, item.path), real = readOrNull(fs, item.real)
  const dirGone = () => { try { fs.rmdirSync(path.dirname(item.real)) } catch { /* not empty, or gone */ } }
  if (cur != null && sha256(cur) === item.sha256) {
    if (real == null) return { path: item.path, result: 'error', reason: `${item.path} is still trocar's wrapper, but the real program it runs (${item.real}) is gone; trocar left the wrapper: reinstall the agent` }
    fs.renameSync(item.real, item.path); dirGone()
    return { path: item.path, result: 'restored' }
  }
  if (real == null) { dirGone(); return { path: item.path, result: 'already-removed' } }
  fs.rmSync(item.real, { force: true }); dirGone()
  return { path: item.real, result: 'removed', changed: true }
}

// What an entry put where, for messages: the key and value of a JSON entry, the variables of a block, the line; the Windows collector's
// tool entries name what they registered instead (a Run value, a task, the kernel's copy — 4.8 §4.2).
export const describeEntry = (e) => {
  if (e.kind === 'text' || (e.kind === 'trust-entry' && e.vars)) return e.vars ? `block with ${Object.entries(e.vars).map(([k, v]) => `${k}=${v}`).join(', ')}` : `line ${JSON.stringify(e.line)}`
  if (e.kind === 'run-key') return `the Run value ${e.name ?? 'trocar-collector'} (${e.hive ?? 'HKCU'}\\${e.key ?? ''})`
  if (e.kind === 'scheduled-task') return `the scheduled task ${e.task ?? '\\trocar\\collector'}`
  if (e.kind === 'forwarder-binary') return `the kernel's copy ${e.path ?? ''}`
  if (e.kind === 'json-array-item') return `${JSON.stringify(e.item)} in ${e.keys.join('.')}`
  if (e.format === 'pem-block') return 'certificate block'
  return `${e.keys.join('.')} = ${e.value}`
}


// Undo one entry by the 4.6 rules: untouched since install → byte-identical; already back → say so; edited since →
// remove only trocar's key (or put the user's prior value back), leave every other byte alone.
// The file to undo, resolved again now. A path that is a symlink today is never written or deleted over: it must
// still lead to the file trocar changed (`real_path`, or the path itself when that was a regular file at install),
// else uninstall leaves it alone and says where trocar's key may still be (`left-link`).
function undoTarget(entry, fs) {
  const changed = entry.real_path || entry.path
  let st = null
  try { st = fs.lstatSync(entry.path) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (!st || !st.isSymbolicLink()) {
    if (!entry.real_path) return { file: entry.path }
    return { refuse: `${entry.path} ${st ? 'is no longer a symbolic link' : 'is gone'}; trocar changed ${changed} through it` }
  }
  let real = null
  try { real = fs.realpathSync(entry.path) } catch { /* a link to nothing */ }
  if (real !== changed) return { refuse: `${entry.path} is now a symbolic link to ${real || 'nothing'}, not to ${changed}, the file trocar changed` }
  return { file: real }
}

// A crash between the intent and the write leaves the directories it created and maybe a temp file: both go.
export function undoEntry(entry, { fs = nodeFs } = {}) {
  const done = (result, extra = {}) => ({ path: entry.path, ...(entry.real_path ? { real_path: entry.real_path } : {}), harness: entry.harness, result, ...extra })
  const target = undoTarget(entry, fs)
  if (target.refuse) return done('left-link', { reason: `${target.refuse}; trocar did not touch it, and its ${describeEntry(entry)} may still be in ${entry.real_path || entry.path}` })
  const file = target.file
  sweepTemps(file, fs)
  const cur = readOrNull(fs, file)
  if (entry.existed_before ? sha256(cur) === entry.pre_sha256 : cur == null) {
    if (!entry.existed_before) removeEmptyDirs(entry.created_dirs, fs)
    return done('already-restored')
  }
  if (cur == null) return done('missing') // the user deleted a file that existed before: nothing of trocar's left
  // The ops are offsets in the file's TEXT (4.6「文件的编码」), so the bytes are decoded first, by what they prove of themselves. Bytes that prove no
  // form (the user saved the file in another encoding after `on`) are not edited: the entry stays, and the receipt says which file and why.
  const read = decodeText(cur)
  if (!read.ok) return done('left-unreadable', { why: read.why, reason: `${file} can no longer be read as text trocar may write back: ${WHY_TEXT[read.why]} (${read.why}); trocar did not touch it, and its ${describeEntry(entry)} may still be in it` })
  const text = read.text
  const asInstalled = entry.post_sha256 == null || sha256(cur) === entry.post_sha256 // intent-only: test by reversing
  const back = asInstalled ? reverseOps(text, entry.ops) : null
  // byte for byte: the text before is written in the form the file had before (`charset`, absent = utf8); an edited file keeps the form it has now
  const before = back == null ? null : encodeText(back, entry.charset || 'utf8')
  if (back != null && (entry.existed_before ? sha256(before) === entry.pre_sha256 : back === '')) {
    if (entry.existed_before) writeDurable(file, before, entry.mode, fs)
    else { fs.rmSync(file, { force: true }); removeEmptyDirs(entry.created_dirs, fs) }
    return done('restored')
  }
  if (entry.kind === 'text') { // edited since: only trocar's block / line goes, the user's commented line comes back
    const out = removeTrocarText(text, entry.ops, { fold: entry.fold === true })
    // a key the user set to a value of their own while trocar was on keeps it (D48②): the line trocar put out of effect stays so, and the receipt says where
    const left = out.prior_left ? { prior_left: out.prior_left } : {}
    // "already removed" is only true when nothing of trocar's is left. A line that still names trocar's file in a shape the removal could not read is not
    // gone: the file is not touched, and the entry stays (`left-text`), so what it points at is not taken away under it (4.6 安装 / 卸载不静默)
    const residue = trocarResidue(out.text, entry, text) // numbered as the user sees them in the file
    if (residue.length) return done('left-text', { reason: `${file} still names trocar's ${describeEntry(entry)} on line ${residue.join(', ')}, in a form trocar cannot tell from your own text; trocar did not touch the file: delete ${residue.length === 1 ? 'that line' : 'those lines'} by hand` })
    if (!out.found) return done('already-removed')
    if (!entry.existed_before && onlySkeleton(out.text, entry.format)) { fs.rmSync(file, { force: true }); removeEmptyDirs(entry.created_dirs, fs); return done('reverted-not-identical', { deleted: true }) }
    if (out.text !== text) writeDurable(file, encodeText(out.text, read.charset), fs.statSync(file).mode & 0o777, fs)
    return done('reverted-not-identical', left)
  }
  let doc
  try { doc = parseJsonText(text) } catch (e) { return done('left-unparsable', { reason: unreadableJson(file, text, e, `trocar's ${describeEntry(entry)}`) }) }
  let out, gone = entry.prior_value == null // the key is out: its parents this install created may be empty now
  if (entry.kind === 'json-array-item') { // only trocar's element goes; the user took it out during on → nothing to do (D48②)
    const r = removeItem(text, entry.keys, entry.item)
    if (!r) return done('already-removed')
    out = r.text
    const list = getPath(parseJsonText(out), entry.keys)
    gone = entry.created_array === true && Array.isArray(list) && !list.length
    if (gone) out = removeKey(out, entry.keys).text // trocar made the list and it is empty again
  } else {
    if (getPath(doc, entry.keys) !== entry.value) return done('left-user-value')
    out = entry.prior_value != null ? setKey(text, entry.keys, entry.prior_value).text : removeKey(text, entry.keys).text
  }
  if (gone) {
    for (let d = entry.keys.length - 1; d > entry.existing_depth; d--) { // parents this install created, now empty
      const v = getPath(parseJsonText(out), entry.keys.slice(0, d))
      if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length) break
      out = removeKey(out, entry.keys.slice(0, d)).text
    }
  }
  const empty = (() => { const v = parseJsonText(out); return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0 })()
  if (!entry.existed_before && empty) { fs.rmSync(file, { force: true }); removeEmptyDirs(entry.created_dirs, fs); return done('reverted-not-identical', { deleted: true }) }
  writeDurable(file, encodeText(out, read.charset), fs.statSync(file).mode & 0o777, fs)
  return done('reverted-not-identical')
}
