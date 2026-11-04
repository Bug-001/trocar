// journal.mjs — the per-user install manifest and the install half of its journal (RFC 4.6 §安装清单与卸载,
// 「信任入口的日志与撤销」, acceptance T11). One JSON file, ~/.trocar/collector/install-manifest.json (0600):
//   dirs     directories trocar created (removed at the end of uninstall if empty)
//   files    files trocar owns (CA, extra trust files) — deleted on uninstall
//   entries  every user file trocar changed: {kind, harness, path, existed_before, mode, pre_sha256, post_sha256, backup,
//            undo_by_hand, ops, prior_value, installed_at, created_dirs, charset?} + per kind: `json-key` (no kind on version 1
//            manifests) {keys, value, existing_depth}; `text` {format, vars | line} (text-edit.mjs: a dotenv block, a
//            shell-rc line, a YAML list row). ops are splices {offset, removed, inserted}; `removed` is only ever the value
//            trocar replaced (a path, or a YAML `[]`, never a secret). The user's file is NEVER copied INTO the manifest
//            (Codex / Hermes .env files hold API keys): the copy made before the change is a file in ~/.trocar/backup/
//            (src/off/backup.mjs, 1.6 R2) and `backup` only names it.
// Write-ahead: the intent (no post_sha256) is fsynced before the user's file is touched, so an install that
// crashed half-way is still found and undone. No whole-file snapshot rollback, ever (1.6 R2).
// 1.6 R9 (D39): `on` is idempotent and resumable, so the install half judges before it writes — judgeEntry / judgeOwned say, per planned item and
// from the manifest and the disk, whether it is to be written, is intact (never rewritten: `installed_at`, inode and mtime stay), is only an intent
// a crash left (resume: finish it), or was changed by the user since (reported, left). apply* run the same judgement themselves, so a caller that
// forgot it still cannot rewrite an intact entry.
// The undo half (undoEntry, removeOwnedFile, describeEntry) and the file primitives moved to src/off/ (D39⑤, 0.1 §2: `trocar off`
// and the standalone trocar-off run without the repo); they are re-exported below so every importer of this module keeps working.
import nodeFs from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { setKey, addItem, getPath, reverseOps, parseJsonText } from '../../../off/json-text.mjs'
import { dotenvBlock, joinDotenvBlock, insertLine, pemBlock, removeTrocarText, BLOCK_OPEN, sameMarked, holdsMarked } from '../../../off/text-edit.mjs'
import { sha256, readOrNull, writeDurable, missingDirs, editTarget, pathKey } from '../../../off/fsutil.mjs'
import { saveManifest, undoByHand, PHASES } from '../../../off/manifest.mjs'
import { writeBackup } from '../../../off/backup.mjs'
import { backupDir } from '../../../off/paths.mjs'
import { CODE_OFF } from '../../../off/names.mjs'
import { describeEntry } from '../../../off/journal.mjs'
import { decodeText, encodeText, WHY_TEXT } from '../../../off/text-codec.mjs'
import { isAlsoSetMember } from '../../../off/env-names.mjs'

// One file under two spellings is one file (X18): every path the journal compares goes through pathKey (src/off/fsutil.mjs).
const realOf = (fs) => (d) => fs.realpathSync.native(d) // the file system the journal is handed decides what a path is (pathKey)
const samePath = (a, b, fs) => a === b || (typeof a === 'string' && typeof b === 'string' && pathKey(a, { realpath: realOf(fs) }) === pathKey(b, { realpath: realOf(fs) }))

export { sha256, writeDurable, sweepTemps, missingDirs, removeEmptyDirs, editTarget } from '../../../off/fsutil.mjs'
export { undoEntry, removeOwnedFile, describeEntry } from '../../../off/journal.mjs'
export { MANIFEST, manifestPath, newManifest, readManifest, saveManifest } from '../../../off/manifest.mjs'

// 1.6 R2: a user's file is saved to ~/.trocar/backup/ before the first byte of it changes; no backup, no change. `before` null = trocar
// creates the file: nothing to save (existed_before:false, backup:null). The throw is `backup-failed`, raised before the manifest or the
// file is touched.
function backupFirst({ home, file, before, now, fs }) {
  if (before == null) return null
  try { return writeBackup({ home, file, data: before, now, fs }) } catch (e) {
    throw Object.assign(new Error(`${file} was not changed: trocar saves a copy of a file before it changes it (1.6 R2) and the copy could not be written to ${backupDir(home)} (${e.code ? `${e.code}: ` : ''}${(e && e.message) || e}); make that directory writable, then install again`), { code: CODE_OFF.backupFailed, path: file, errno: e && e.code })
  }
}
// The text of a user's file by what its bytes prove (4.6「文件的编码」, text-codec.mjs): { text (null: not there), charset }. Bytes that prove no form
// are not edited: the throw carries code `entry-refused`, the `why` of the closed set and the path, raised before anything is written, so the caller
// skips that harness only (4.6 §身份与信任「逐 harness 跳过」).
function readUserText(file, bytes) {
  const d = decodeText(bytes)
  if (d.ok) return d
  throw Object.assign(new Error(`${file} was not changed: trocar cannot tell how it is encoded — ${WHY_TEXT[d.why]} (${d.why}); trocar edits only UTF-8, or UTF-16 with a byte-order mark. Save it as UTF-8, then run "trocar on" again`), { code: CODE_OFF.entryRefused, why: d.why, path: file })
}
// setKey on a user's file: a file trocar cannot edit (not JSON / JSONC, not an object, a parent that is not an object, a key holding an object) is
// refused with code `entry-refused`, its `why` and the path, before anything is written (4.6「逐 harness 跳过」; the fix is in the message).
function setUserKey(file, text, keys, value) {
  try { return setKey(text, keys, value) } catch (e) {
    if (!e || !e.why) throw e
    throw Object.assign(new Error(`${file} was not changed: ${e.message.replace(/^setKey: /, '')}`), { code: CODE_OFF.entryRefused, why: e.why, path: file, ...(e.offset != null ? { offset: e.offset } : {}) })
  }
}
const needHome = (what, home) => { if (!home) throw new TypeError(`${what}: home is required (backups go to <home>/.trocar/backup, 1.6 R2)`) }
// D55①: every item says which command wrote it — `off` undoes phase 'on', `uninstall` the rest; a writer that forgets fails here, before anything is written
const needPhase = (what, phase) => { if (!PHASES.includes(phase)) throw new TypeError(`${what}: phase is required (${PHASES.join(' | ')}), got ${JSON.stringify(phase)}`) }

// A file trocar owns (a trust file of certificate blocks, a trust plugin, a launch shim): listed before it is written,
// with the directories its write creates. `sources` names the user files a trust file carries certificates from
// (paths, never contents), so the merge stays auditable. `exclusive`: a file already there is never written over
// (an agent's plugin directory is the user's; trocar only adds its own file to it): `on` passes `exclusive` for a file the manifest does not list,
// and not for one it does — that is trocar's own, written before or recorded by a run that crashed before the write (R9). A record for a path the
// manifest already lists is replaced, not added (a second one would be undone twice), and the directories the first attempt made stay listed.
export function writeOwnedFile({ dir, manifest, harness = null, role, phase, file, data, sources = null, mode = 0o600, exclusive = false, extra = {}, now = new Date(), fs = nodeFs }) {
  needPhase('writeOwnedFile', phase)
  const known = manifest.files.find((f) => samePath(f.path, file, fs))
  if (exclusive && fs.existsSync(file)) throw new Error(`${file} already exists; trocar will not write over it`)
  const created = [...new Set([...((known && known.created_dirs) || []), ...missingDirs(path.dirname(file), fs)])]
  const item = { kind: 'owned-file', path: file, role, harness, phase, sha256: sha256(Buffer.from(data)), mode, created_dirs: created, installed_at: now.toISOString(), ...(sources ? { sources } : {}), ...extra }
  item.undo_by_hand = undoByHand(item)
  if (known) manifest.files[manifest.files.indexOf(known)] = item
  else manifest.files.push(item)
  saveManifest(dir, manifest, fs)
  for (const d of created) if (!fs.existsSync(d)) fs.mkdirSync(d, { mode: 0o700 })
  writeDurable(file, data, mode, fs)
}

// What `on` finds of one file trocar owns (R9), from the manifest and the disk: `write` (the manifest does not list it), `skip-intact` (listed,
// there, and byte for byte what trocar recorded; for a combined bundle `off` kept without the CA — `without_ca` — it is not intact: `on` puts the
// CA back), or `rewrite` (listed, but gone or changed since). `planned` (the sha256 of what would be written now) is for the files whose
// content is a pure function of the plan (the unit): there the file must also equal it, else a moved script path would be kept for ever.
export function judgeOwned({ manifest, file, planned = null, fs = nodeFs }) {
  const rec = manifest && (manifest.files || []).find((f) => samePath(f.path, file, fs))
  if (!rec) return { action: 'write', record: null }
  const cur = readOrNull(fs, file)
  const here = cur == null ? null : sha256(cur)
  if (here != null && here === rec.sha256 && !rec.without_ca && (planned == null || planned === here)) return { action: 'skip-intact', record: rec }
  return { action: 'rewrite', record: rec, why: here == null ? 'the file is gone' : rec.without_ca ? 'it was kept without the trocar CA' : 'it is not what trocar wrote' }
}

// What applyJsonKey would do, without writing: every refusal (a link to nothing or to a non-regular file, a file
// that is not a JSON object, a non-object parent) is raised here, so install can run them all before it writes
// anything. Returns the file that would change (`real_path` when `file` is a link) and whether it would change.
export function previewJsonKey({ file, keys, value, fs = nodeFs }) {
  const real = editTarget(file, fs)
  const res = setUserKey(file, readUserText(file, readOrNull(fs, real)).text, keys, value)
  return { path: file, ...(real !== file ? { real_path: real } : {}), changes: res.prior !== value, prior: res.prior }
}

// ── what `on` finds of one planned entry (1.6 R9) ────────────────────────────────────────────────────────────────────────────────────────
const sameKeys = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((k, i) => k === b[i])
const sameNames = (a, b) => !!a && !!b && JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort())
// the manifest's entry for what is planned: same harness, file (by pathKey: one file under any spelling, X18) and thing (a JSON key path, a block's variables, a line)
const entryOf = (manifest, p, fs) => ((manifest && manifest.entries) || []).find((x) => x.harness === p.harness && samePath(x.path, p.path, fs)
  && (x.kind ?? (x.format ? 'text' : 'json-key')) === p.kind
  && (p.kind === 'json-key' || p.kind === 'json-array-item' ? sameKeys(x.keys, p.keys) && (p.kind === 'json-key' || isDeepStrictEqual(x.item, p.item)) : x.format === p.format && (p.vars ? sameNames(x.vars, p.vars) : x.line === p.line || sameMarked(x.line, p.line))))
// is trocar's text still in the file? a JSON key by its value, a block or line by the text it inserted (the same test undo makes of an edited file)
function holds(x, text) {
  if (text == null) return false
  if (x.kind === 'text') return removeTrocarText(text, x.ops || []).found
  try { const v = getPath(parseJsonText(text), x.keys); return x.kind === 'json-array-item' ? Array.isArray(v) && v.some((e) => isDeepStrictEqual(e, x.item)) : v === x.value } catch { return false }
}
// the file is what trocar's ops made of the file it recorded (an intent whose write finished and whose `post_sha256` did not): undo reads it the same way
function writtenBy(x, text) {
  if (text == null) return false
  const back = reverseOps(text, x.ops || [])
  return back != null && (x.existed_before ? sha256(encodeText(back, x.charset || 'utf8')) === x.pre_sha256 : back === '')
}

/** `planned` = { harness, kind: 'json-key'|'text', path, keys | format + (vars | line) } → what `on` does with it, from the manifest and the disk:
 *    write               the manifest has no entry for it
 *    skip-intact         it has, and trocar's text is still in the file (the sha equals `post_sha256`, or the file was edited elsewhere since —
 *                        Claude Code rewrites settings.json): never written again, `installed_at` and the file stay as they are (R9)
 *    resume              an entry that is only an intent (a crash between the record and the end of the write): the file is still as it was
 *                        before, or already written (`adopt`: only `post_sha256` is missing)
 *    skip-user-changed   it has, but the key or block is gone or holds another value, or the intent cannot be told from a user's edit: the user
 *                        changed it after trocar did. Reported, left (`trocar off`, then `trocar on`, writes it again)
 *  `entry` is the manifest's. A path that cannot be resolved (a link now dangling) is skip-user-changed with the reason. A file whose bytes are not
 *  trocar's own and prove no encoding throws entry-refused with its `why` (as previewTextEntry does for a new entry), before anything is written. */
export function judgeEntry({ manifest, planned, fs = nodeFs }) {
  const x = entryOf(manifest, planned, fs)
  if (!x) return { action: 'write', entry: null }
  let cur
  try { cur = readOrNull(fs, editTarget(x.path, fs)) } catch (e) { return { action: 'skip-user-changed', entry: x, why: String((e && e.message) || e) } }
  if (x.post_sha256 != null && sha256(cur) === x.post_sha256) return { action: 'skip-intact', entry: x }
  // past the byte checks, what is in the file is read as text: bytes that prove no encoding are refused with their why (4.6:216, entry-refused),
  // never judged as "the user changed it" — the block may well still be there, in bytes trocar cannot read back
  const text = readUserText(x.path, cur).text
  if (x.post_sha256 != null) {
    return holds(x, text) ? { action: 'skip-intact', entry: x, edited: true } : { action: 'skip-user-changed', entry: x, why: `${x.path} no longer holds what trocar wrote there (${describeEntry(x)})` }
  }
  if (x.existed_before ? sha256(cur) === x.pre_sha256 : cur == null) return { action: 'resume', entry: x }
  if (writtenBy(x, text)) return { action: 'resume', entry: x, adopt: true }
  return { action: 'skip-user-changed', entry: x, why: `${x.path} changed after an earlier run recorded its intent to change it, and is not what that run would have written` }
}
const refuseChanged = (j) => new Error(`${j.entry.path}: ${j.why}; trocar leaves it as it is — run "trocar off", then "trocar on", to write the entry again`)
const makeDirs = (entry, fs) => { for (const d of entry.created_dirs) if (!fs.existsSync(d)) fs.mkdirSync(d, { mode: 0o700 }) }

// the part of applyJsonKey / applyTextEntry after the edit is decided: the backup (kept from the intent a crashed run left, if it is still there),
// the record before the write, the write, the record after it — `resumed` is that crashed run's entry, finished in place. The text is written in the
// file's own form (`charset`: recorded on the entry only when it is not utf8, 4.6 日志), and post_sha256 is of the bytes written.
function commit({ dir, manifest, fresh, resumed, before, res, backup, real, charset, now, fs }) {
  if (charset !== 'utf8') fresh.charset = charset
  else if (resumed) delete resumed.charset
  const entry = resumed ? Object.assign(resumed, { ...fresh, created_dirs: [...new Set([...(resumed.created_dirs || []), ...fresh.created_dirs])], backup: resumed.backup && fs.existsSync(resumed.backup) ? resumed.backup : backup(), existed_before: resumed.existed_before, mode: resumed.mode, pre_sha256: resumed.pre_sha256 }) : { ...fresh, backup: backup() }
  entry.undo_by_hand = undoByHand(entry)
  if (!resumed) manifest.entries.push(entry)
  saveManifest(dir, manifest, fs) // the intent is durable before the user's file changes
  makeDirs(entry, fs)
  const bytes = encodeText(res.text, charset)
  writeDurable(real, bytes, entry.mode, fs)
  entry.post_sha256 = sha256(bytes)
  saveManifest(dir, manifest, fs)
  return entry
}

// A symlinked file is edited at its target; the entry records both (`path` the link, `real_path` the target). An entry the manifest already lists
// is judged first (judgeEntry): intact → handed back as it is, nothing written; an intent a crash left → finished; changed by the user → refused.
// `alsoSet` (names) and `fold` (4.6「名字族」: the JSON form): every member of the same object that is ALREADY there and is named in `alsoSet`, or is
// the key's own name compared without case when `fold`, gets the value too — each one its own plain json-key entry, keyed by the member's own
// spelling, with its own prior_value (an older build undoes it as any json-key). A member is only ever given the value: never removed, moved or
// added. `fold` is recorded on every entry it makes (`fold: true`).
export function applyJsonKey({ dir, manifest, harness, phase, file, keys, value, home, alsoSet = [], fold = false, now = new Date(), fs = nodeFs }) {
  const main = setOneKey({ dir, manifest, harness, phase, file, keys, value, home, fold, now, fs })
  const leaf = keys[keys.length - 1]
  const named = (m) => isAlsoSetMember(m, leaf, alsoSet, fold)
  if (!alsoSet.length && !fold) return main
  let parent
  try { parent = getPath(parseJsonText(readUserText(file, readOrNull(fs, editTarget(file, fs))).text), keys.slice(0, -1)) } catch { return main }
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return main
  for (const m of Object.keys(parent).filter(named)) setOneKey({ dir, manifest, harness, phase, file, keys: [...keys.slice(0, -1), m], value, home, fold, now, fs })
  return main
}
function setOneKey({ dir, manifest, harness, phase, file, keys, value, home, fold, now, fs }) {
  needHome('applyJsonKey', home)
  needPhase('applyJsonKey', phase)
  const j = judgeEntry({ manifest, planned: { harness, kind: 'json-key', path: file, keys }, fs })
  if (j.action === 'skip-intact') return null // nothing written, as when the key already held the value
  if (j.action === 'skip-user-changed') throw refuseChanged(j)
  const real = editTarget(file, fs)
  const before = readOrNull(fs, real)
  if (j.adopt) { j.entry.post_sha256 = sha256(before); saveManifest(dir, manifest, fs); return j.entry } // the file was written; only the record of it was not
  const read = readUserText(file, before)
  const res = setUserKey(file, read.text, keys, value) // parse-checked before any write
  if (res.prior === value) return null
  const resumed = j.action === 'resume' ? j.entry : null
  const fresh = {
    kind: 'json-key', harness, phase, path: file, ...(real !== file ? { real_path: real } : {}), keys, value,
    existed_before: before != null, mode: before != null ? fs.statSync(real).mode & 0o777 : 0o600,
    pre_sha256: sha256(before), post_sha256: null, ops: res.ops, prior_value: res.prior,
    existing_depth: res.existingDepth, created_dirs: missingDirs(path.dirname(file), fs), installed_at: now.toISOString(), ...(fold ? { fold: true } : {}),
  }
  return commit({ dir, manifest, fresh, resumed, before, res, real, charset: read.charset, now, fs, backup: () => backupFirst({ home, file, before, now, fs }) }) // keyed by the path the user knows (the link, for a symlinked file), holding the target's bytes
}

// One element trocar appends to a JSON array (4.11 P5 `arrayItems`, kind `json-array-item`; undone by src/off/journal.mjs undoEntry: only that element goes,
// and the array too when trocar created it and it is empty again). Judged and committed as a json-key is; an array that already holds the element is
// left as it is (null: nothing trocar added, nothing to undo).
export function applyJsonArrayItem({ dir, manifest, harness, phase, file, keys, item, home, now = new Date(), fs = nodeFs }) {
  needHome('applyJsonArrayItem', home)
  needPhase('applyJsonArrayItem', phase)
  const j = judgeEntry({ manifest, planned: { harness, kind: 'json-array-item', path: file, keys, item }, fs })
  if (j.action === 'skip-intact') return null
  if (j.action === 'skip-user-changed') throw refuseChanged(j)
  const real = editTarget(file, fs)
  const before = readOrNull(fs, real)
  if (j.adopt) { j.entry.post_sha256 = sha256(before); saveManifest(dir, manifest, fs); return j.entry }
  const read = readUserText(file, before)
  let res
  try { res = addItem(read.text, keys, item) } catch (e) {
    if (!e || !e.why) throw e
    throw Object.assign(new Error(`${file} was not changed: ${e.message.replace(/^(setKey|addItem): /, '')}`), { code: CODE_OFF.entryRefused, why: e.why, path: file })
  }
  if (res == null) return null
  const fresh = {
    kind: 'json-array-item', harness, phase, path: file, ...(real !== file ? { real_path: real } : {}), keys, item, created_array: res.createdArray,
    existed_before: before != null, mode: before != null ? fs.statSync(real).mode & 0o777 : 0o600,
    pre_sha256: sha256(before), post_sha256: null, ops: res.ops, prior_value: null,
    existing_depth: res.existingDepth, created_dirs: missingDirs(path.dirname(file), fs), installed_at: now.toISOString(),
  }
  return commit({ dir, manifest, fresh, resumed: j.action === 'resume' ? j.entry : null, before, res, real, charset: read.charset, now, fs, backup: () => backupFirst({ home, file, before, now, fs }) })
}

// A text entry (text-edit.mjs): edit = { format: 'dotenv-block', vars, quote?, neutralize?, fold? } (the names put out of effect with the
// block's own, 4.6「名字族」; recorded on the entry, `fold` as `fold: true`) | { format: 'line', line, after? } |
// { format: 'yaml-list', line } | a dotenv-block with `joinBlock: true` (4.8 §2.3: the proxy lines of Codex and Hermes
// join the sentinel block the trust entry wrote — one block per file, entered separately). Text trocar already put there
// under an install this manifest does not list is refused: a second block or row would only be undone once. `joined` (the
// caller has checked the manifest lists the block for this harness) is the only way past that refusal, and only into the
// existing block (text-edit.mjs joinDotenvBlock); the default stays the refusal, so nothing joins by accident.
function editText(file, text, edit, { joined = false, phase = 'install' } = {}) {
  if (text != null && (text.includes(BLOCK_OPEN) || (edit.line && holdsMarked(text, edit.line)))) { // the marker's fixed part: what any release wrote (4.6「标记的字」)
    if (!(joined && text.includes(BLOCK_OPEN) && edit.format === 'dotenv-block')) {
      throw new Error(`${file} already holds trocar's text from an install this manifest does not list; take it out, then install again`)
    }
  }
  try {
    if (edit.format === 'dotenv-block') {
      const how = { quote: edit.quote === true, neutralize: edit.neutralize || [], fold: edit.fold === true, at: edit.at || 'top', phase } // `at: 'end'`: 4.11 P5 dotenv-block, after the user's lines
      if (joined && text != null && text.includes(BLOCK_OPEN)) return joinDotenvBlock(text, edit.vars, how)
      return dotenvBlock(text, edit.vars, how)
    }
    if (edit.format === 'pem-block') return { ...pemBlock(text, edit.pem, phase), prior: null } // rule U (4.11): a marked block at the end of the user's own certificate file
    if (edit.format === 'line' || edit.format === 'yaml-list') return { ...insertLine(text, { line: edit.line, after: edit.after || null, format: edit.format === 'yaml-list' ? 'yaml-list' : 'lines' }), prior: null }
  } catch (e) { throw new Error(`${file}: ${e.message}`) }
  throw new Error(`${file}: unknown text edit ${edit.format}`)
}
export function previewTextEntry({ file, edit, fs = nodeFs }) {
  const real = editTarget(file, fs)
  const res = editText(file, readUserText(file, readOrNull(fs, real)).text, edit)
  return { path: file, ...(real !== file ? { real_path: real } : {}), changes: true, prior: res.prior ?? null }
}
export function applyTextEntry({ dir, manifest, harness, phase, file, edit, home, now = new Date(), fs = nodeFs }) {
  needHome('applyTextEntry', home)
  needPhase('applyTextEntry', phase)
  const j = judgeEntry({ manifest, planned: { harness, kind: 'text', path: file, format: edit.format, ...(edit.vars ? { vars: edit.vars } : { line: edit.line }) }, fs })
  if (j.action === 'skip-intact') return null // nothing written, as when the key already held the value
  if (j.action === 'skip-user-changed') throw refuseChanged(j)
  // `joinBlock` (text-edit.mjs joinDotenvBlock) may only join a block THIS manifest lists for the same harness: a block
  // from an install this manifest does not list is still refused, join or no join
  const joined = edit.joinBlock === true && (manifest.entries || []).some((x) => x.harness === harness && samePath(x.path, file, fs) && x.kind === 'text' && x.format === 'dotenv-block')
  const real = editTarget(file, fs)
  const before = readOrNull(fs, real)
  if (j.adopt) { j.entry.post_sha256 = sha256(before); saveManifest(dir, manifest, fs); return j.entry }
  // an intent a crashed run left, whose write never happened: the file is still as it was, so its text is not yet in it
  const read = readUserText(file, before)
  const res = editText(file, read.text, edit, { joined, phase })
  const resumed = j.action === 'resume' ? j.entry : null
  const fresh = {
    kind: 'text', harness, phase, path: file, ...(real !== file ? { real_path: real } : {}), format: edit.format,
    ...(edit.vars ? { vars: edit.vars } : { line: edit.line }),
    ...(edit.neutralize && edit.neutralize.length ? { neutralize: edit.neutralize } : {}), ...(edit.fold === true ? { fold: true } : {}),
    existed_before: before != null, mode: before != null ? fs.statSync(real).mode & 0o777 : (edit.mode || 0o600),
    pre_sha256: sha256(before), post_sha256: null, ops: res.ops, prior_value: res.prior,
    created_dirs: missingDirs(path.dirname(file), fs), installed_at: now.toISOString(),
  }
  return commit({ dir, manifest, fresh, resumed, before, res, real, charset: read.charset, now, fs, backup: () => backupFirst({ home, file, before, now, fs }) })
}

// When trocar installed the value a config layer holds (ms), or null. A layer counts when an entry changed its file
// (`path`, or the link target `real_path`) and the layer still holds that entry's value (under its key, or the name a
// descriptor gives it, e.g. zcode:user:caCertFile), or every variable of its dotenv block; the tracker then judges
// config-after-start against this time, not the file's mtime, so an unrelated later edit of the same file (Hermes
// rewrites its .env when it tidies it) does not make a process that started after install look stale (review 2 #5).
export function installedAt(manifest, layer, { fs = nodeFs } = {}) {
  if (!manifest || !layer || !layer.file || !layer.vars) return null
  const key = pathKey(layer.file, { realpath: realOf(fs) })
  for (const e of manifest.entries || []) {
    if (!(typeof e.path === 'string' && pathKey(e.path, { realpath: realOf(fs) }) === key) && !(typeof e.real_path === 'string' && pathKey(e.real_path, { realpath: realOf(fs) }) === key)) continue
    const t = Date.parse(e.installed_at)
    if (!Number.isFinite(t)) continue
    if (e.vars) { if (Object.entries(e.vars).every(([k, v]) => layer.vars[k] === v)) return t; continue } // a dotenv block
    if (e.value != null && Object.values(layer.vars).includes(e.value)) return t // under its key, or a descriptor's pseudo-variable
  }
  return null
}
