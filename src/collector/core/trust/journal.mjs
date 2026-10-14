// journal.mjs — the per-user install manifest and the install half of its journal (RFC 4.6 §安装清单与卸载,
// 「信任入口的日志与撤销」, acceptance T11). One JSON file, ~/.asight/collector/install-manifest.json (0600):
//   dirs     directories asight created (removed at the end of uninstall if empty)
//   files    files asight owns (CA, extra trust files) — deleted on uninstall
//   entries  every user file asight changed: {kind, harness, path, existed_before, mode, pre_sha256, post_sha256, backup,
//            undo_by_hand, ops, prior_value, installed_at, created_dirs} + per kind: `json-key` (no kind on version 1
//            manifests) {keys, value, existing_depth}; `text` {format, vars | line} (text-edit.mjs: a dotenv block, a
//            shell-rc line, a YAML list row). ops are splices {offset, removed, inserted}; `removed` is only ever the value
//            asight replaced (a path, or a YAML `[]`, never a secret). The user's file is NEVER copied INTO the manifest
//            (Codex / Hermes .env files hold API keys): the copy made before the change is a file in ~/.asight/backup/
//            (src/off/backup.mjs, 1.6 R2) and `backup` only names it.
// Write-ahead: the intent (no post_sha256) is fsynced before the user's file is touched, so an install that
// crashed half-way is still found and undone. No whole-file snapshot rollback, ever (1.6 R2).
// 1.6 R9 (D39): `on` is idempotent and resumable, so the install half judges before it writes — judgeEntry / judgeOwned say, per planned item and
// from the manifest and the disk, whether it is to be written, is intact (never rewritten: `installed_at`, inode and mtime stay), is only an intent
// a crash left (resume: finish it), or was changed by the user since (reported, left). apply* run the same judgement themselves, so a caller that
// forgot it still cannot rewrite an intact entry.
// The undo half (undoEntry, removeOwnedFile, describeEntry) and the file primitives moved to src/off/ (D39⑤, 0.1 §2: `asight off`
// and the standalone asight-off run without the repo); they are re-exported below so every importer of this module keeps working.
import nodeFs from 'node:fs'
import path from 'node:path'
import { setKey, getPath, reverseOps } from '../../../off/json-text.mjs'
import { dotenvBlock, joinDotenvBlock, insertLine, removeAsightText, BLOCK_BEGIN } from '../../../off/text-edit.mjs'
import { sha256, readOrNull, writeDurable, missingDirs, editTarget } from '../../../off/fsutil.mjs'
import { saveManifest, undoByHand, PHASES } from '../../../off/manifest.mjs'
import { writeBackup } from '../../../off/backup.mjs'
import { backupDir } from '../../../off/paths.mjs'
import { CODE_OFF } from '../../../off/names.mjs'
import { describeEntry } from '../../../off/journal.mjs'

export { sha256, writeDurable, sweepTemps, missingDirs, removeEmptyDirs, editTarget } from '../../../off/fsutil.mjs'
export { undoEntry, removeOwnedFile, describeEntry } from '../../../off/journal.mjs'
export { MANIFEST, manifestPath, newManifest, readManifest, saveManifest } from '../../../off/manifest.mjs'

// 1.6 R2: a user's file is saved to ~/.asight/backup/ before the first byte of it changes; no backup, no change. `before` null = asight
// creates the file: nothing to save (existed_before:false, backup:null). The throw is `backup-failed`, raised before the manifest or the
// file is touched.
function backupFirst({ home, file, before, now, fs }) {
  if (before == null) return null
  try { return writeBackup({ home, file, data: before, now, fs }) } catch (e) {
    throw Object.assign(new Error(`${file} was not changed: asight saves a copy of a file before it changes it (1.6 R2) and the copy could not be written to ${backupDir(home)} (${e.code ? `${e.code}: ` : ''}${(e && e.message) || e}); make that directory writable, then install again`), { code: CODE_OFF.backupFailed, path: file, errno: e && e.code })
  }
}
const needHome = (what, home) => { if (!home) throw new TypeError(`${what}: home is required (backups go to <home>/.asight/backup, 1.6 R2)`) }
// D55①: every item says which command wrote it — `off` undoes phase 'on', `uninstall` the rest; a writer that forgets fails here, before anything is written
const needPhase = (what, phase) => { if (!PHASES.includes(phase)) throw new TypeError(`${what}: phase is required (${PHASES.join(' | ')}), got ${JSON.stringify(phase)}`) }

// A file asight owns (a trust file of certificate blocks, a trust plugin, a launch shim): listed before it is written,
// with the directories its write creates. `sources` names the user files a trust file carries certificates from
// (paths, never contents), so the merge stays auditable. `exclusive`: a file already there is never written over
// (an agent's plugin directory is the user's; asight only adds its own file to it): `on` passes `exclusive` for a file the manifest does not list,
// and not for one it does — that is asight's own, written before or recorded by a run that crashed before the write (R9). A record for a path the
// manifest already lists is replaced, not added (a second one would be undone twice), and the directories the first attempt made stay listed.
export function writeOwnedFile({ dir, manifest, harness = null, role, phase, file, data, sources = null, mode = 0o600, exclusive = false, extra = {}, now = new Date(), fs = nodeFs }) {
  needPhase('writeOwnedFile', phase)
  const known = manifest.files.find((f) => f.path === file)
  if (exclusive && fs.existsSync(file)) throw new Error(`${file} already exists; asight will not write over it`)
  const created = [...new Set([...((known && known.created_dirs) || []), ...missingDirs(path.dirname(file), fs)])]
  const item = { kind: 'owned-file', path: file, role, harness, phase, sha256: sha256(Buffer.from(data)), mode, created_dirs: created, installed_at: now.toISOString(), ...(sources ? { sources } : {}), ...extra }
  item.undo_by_hand = undoByHand(item)
  if (known) manifest.files[manifest.files.indexOf(known)] = item
  else manifest.files.push(item)
  saveManifest(dir, manifest, fs)
  for (const d of created) if (!fs.existsSync(d)) fs.mkdirSync(d, { mode: 0o700 })
  writeDurable(file, data, mode, fs)
}

// What `on` finds of one file asight owns (R9), from the manifest and the disk: `write` (the manifest does not list it), `skip-intact` (listed,
// there, and byte for byte what asight recorded; for a combined bundle `off` kept without the CA — `without_ca` — it is not intact: `on` puts the
// CA back), or `rewrite` (listed, but gone or changed since). `planned` (the sha256 of what would be written now) is for the files whose
// content is a pure function of the plan (the unit): there the file must also equal it, else a moved script path would be kept for ever.
export function judgeOwned({ manifest, file, planned = null, fs = nodeFs }) {
  const rec = manifest && (manifest.files || []).find((f) => f.path === file)
  if (!rec) return { action: 'write', record: null }
  const cur = readOrNull(fs, file)
  const here = cur == null ? null : sha256(cur)
  if (here != null && here === rec.sha256 && !rec.without_ca && (planned == null || planned === here)) return { action: 'skip-intact', record: rec }
  return { action: 'rewrite', record: rec, why: here == null ? 'the file is gone' : rec.without_ca ? 'it was kept without the asight CA' : 'it is not what asight wrote' }
}

// What applyJsonKey would do, without writing: every refusal (a link to nothing or to a non-regular file, a file
// that is not a JSON object, a non-object parent) is raised here, so install can run them all before it writes
// anything. Returns the file that would change (`real_path` when `file` is a link) and whether it would change.
export function previewJsonKey({ file, keys, value, fs = nodeFs }) {
  const real = editTarget(file, fs)
  const before = readOrNull(fs, real)
  const res = setKey(before == null ? null : before.toString('utf8'), keys, value)
  return { path: file, ...(real !== file ? { real_path: real } : {}), changes: res.prior !== value, prior: res.prior }
}

// ── what `on` finds of one planned entry (1.6 R9) ────────────────────────────────────────────────────────────────────────────────────────
const sameKeys = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((k, i) => k === b[i])
const sameNames = (a, b) => !!a && !!b && JSON.stringify(Object.keys(a).sort()) === JSON.stringify(Object.keys(b).sort())
// the manifest's entry for what is planned: same harness, file and thing (a JSON key path, a block's variables, a line)
const entryOf = (manifest, p) => ((manifest && manifest.entries) || []).find((x) => x.harness === p.harness && x.path === p.path
  && (x.kind ?? (x.format ? 'text' : 'json-key')) === p.kind
  && (p.kind === 'json-key' ? sameKeys(x.keys, p.keys) : x.format === p.format && (p.vars ? sameNames(x.vars, p.vars) : x.line === p.line)))
// is asight's text still in the file? a JSON key by its value, a block or line by the text it inserted (the same test undo makes of an edited file)
function holds(x, cur) {
  if (cur == null) return false
  const text = cur.toString('utf8')
  if (x.kind === 'text') return removeAsightText(text, x.ops || []).found
  try { return getPath(JSON.parse(text), x.keys) === x.value } catch { return false }
}
// the file is what asight's ops made of the file it recorded (an intent whose write finished and whose `post_sha256` did not): undo reads it the same way
function writtenBy(x, cur) {
  if (cur == null) return false
  const back = reverseOps(cur.toString('utf8'), x.ops || [])
  return back != null && (x.existed_before ? sha256(Buffer.from(back)) === x.pre_sha256 : back === '')
}

/** `planned` = { harness, kind: 'json-key'|'text', path, keys | format + (vars | line) } → what `on` does with it, from the manifest and the disk:
 *    write               the manifest has no entry for it
 *    skip-intact         it has, and asight's text is still in the file (the sha equals `post_sha256`, or the file was edited elsewhere since —
 *                        Claude Code rewrites settings.json): never written again, `installed_at` and the file stay as they are (R9)
 *    resume              an entry that is only an intent (a crash between the record and the end of the write): the file is still as it was
 *                        before, or already written (`adopt`: only `post_sha256` is missing)
 *    skip-user-changed   it has, but the key or block is gone or holds another value, or the intent cannot be told from a user's edit: the user
 *                        changed it after asight did. Reported, left (`asight off`, then `asight on`, writes it again)
 *  `entry` is the manifest's. A path that cannot be resolved (a link now dangling) is skip-user-changed with the reason. */
export function judgeEntry({ manifest, planned, fs = nodeFs }) {
  const x = entryOf(manifest, planned)
  if (!x) return { action: 'write', entry: null }
  let cur
  try { cur = readOrNull(fs, editTarget(x.path, fs)) } catch (e) { return { action: 'skip-user-changed', entry: x, why: String((e && e.message) || e) } }
  if (x.post_sha256 != null) {
    if (sha256(cur) === x.post_sha256) return { action: 'skip-intact', entry: x }
    return holds(x, cur) ? { action: 'skip-intact', entry: x, edited: true } : { action: 'skip-user-changed', entry: x, why: `${x.path} no longer holds what asight wrote there (${describeEntry(x)})` }
  }
  if (x.existed_before ? sha256(cur) === x.pre_sha256 : cur == null) return { action: 'resume', entry: x }
  if (writtenBy(x, cur)) return { action: 'resume', entry: x, adopt: true }
  return { action: 'skip-user-changed', entry: x, why: `${x.path} changed after an earlier run recorded its intent to change it, and is not what that run would have written` }
}
const refuseChanged = (j) => new Error(`${j.entry.path}: ${j.why}; asight leaves it as it is — run "asight off", then "asight on", to write the entry again`)
const makeDirs = (entry, fs) => { for (const d of entry.created_dirs) if (!fs.existsSync(d)) fs.mkdirSync(d, { mode: 0o700 }) }

// the part of applyJsonKey / applyTextEntry after the edit is decided: the backup (kept from the intent a crashed run left, if it is still there),
// the record before the write, the write, the record after it — `resumed` is that crashed run's entry, finished in place
function commit({ dir, manifest, fresh, resumed, before, res, backup, real, now, fs }) {
  const entry = resumed ? Object.assign(resumed, { ...fresh, created_dirs: [...new Set([...(resumed.created_dirs || []), ...fresh.created_dirs])], backup: resumed.backup && fs.existsSync(resumed.backup) ? resumed.backup : backup(), existed_before: resumed.existed_before, mode: resumed.mode, pre_sha256: resumed.pre_sha256 }) : { ...fresh, backup: backup() }
  entry.undo_by_hand = undoByHand(entry)
  if (!resumed) manifest.entries.push(entry)
  saveManifest(dir, manifest, fs) // the intent is durable before the user's file changes
  makeDirs(entry, fs)
  writeDurable(real, res.text, entry.mode, fs)
  entry.post_sha256 = sha256(Buffer.from(res.text))
  saveManifest(dir, manifest, fs)
  return entry
}

// A symlinked file is edited at its target; the entry records both (`path` the link, `real_path` the target). An entry the manifest already lists
// is judged first (judgeEntry): intact → handed back as it is, nothing written; an intent a crash left → finished; changed by the user → refused.
export function applyJsonKey({ dir, manifest, harness, phase, file, keys, value, home, now = new Date(), fs = nodeFs }) {
  needHome('applyJsonKey', home)
  needPhase('applyJsonKey', phase)
  const j = judgeEntry({ manifest, planned: { harness, kind: 'json-key', path: file, keys }, fs })
  if (j.action === 'skip-intact') return null // nothing written, as when the key already held the value
  if (j.action === 'skip-user-changed') throw refuseChanged(j)
  const real = editTarget(file, fs)
  const before = readOrNull(fs, real)
  if (j.adopt) { j.entry.post_sha256 = sha256(before); saveManifest(dir, manifest, fs); return j.entry } // the file was written; only the record of it was not
  const res = setKey(before == null ? null : before.toString('utf8'), keys, value) // parse-checked before any write
  if (res.prior === value) return null
  const resumed = j.action === 'resume' ? j.entry : null
  const fresh = {
    kind: 'json-key', harness, phase, path: file, ...(real !== file ? { real_path: real } : {}), keys, value,
    existed_before: before != null, mode: before != null ? fs.statSync(real).mode & 0o777 : 0o600,
    pre_sha256: sha256(before), post_sha256: null, ops: res.ops, prior_value: res.prior,
    existing_depth: res.existingDepth, created_dirs: missingDirs(path.dirname(file), fs), installed_at: now.toISOString(),
  }
  return commit({ dir, manifest, fresh, resumed, before, res, real, now, fs, backup: () => backupFirst({ home, file, before, now, fs }) }) // keyed by the path the user knows (the link, for a symlinked file), holding the target's bytes
}

// A text entry (text-edit.mjs): edit = { format: 'dotenv-block', vars, quote? } | { format: 'line', line, after? } |
// { format: 'yaml-list', line } | a dotenv-block with `joinBlock: true` (4.8 §2.3: the proxy lines of Codex and Hermes
// join the sentinel block the trust entry wrote — one block per file, entered separately). Text asight already put there
// under an install this manifest does not list is refused: a second block or row would only be undone once. `joined` (the
// caller has checked the manifest lists the block for this harness) is the only way past that refusal, and only into the
// existing block (text-edit.mjs joinDotenvBlock); the default stays the refusal, so nothing joins by accident.
function editText(file, text, edit, { joined = false } = {}) {
  if (text != null && (text.includes(BLOCK_BEGIN) || (edit.line && text.includes(edit.line)))) {
    if (!(joined && text.includes(BLOCK_BEGIN) && edit.format === 'dotenv-block')) {
      throw new Error(`${file} already holds asight's text from an install this manifest does not list; take it out, then install again`)
    }
  }
  try {
    if (edit.format === 'dotenv-block') {
      if (joined && text != null && text.includes(BLOCK_BEGIN)) return joinDotenvBlock(text, edit.vars, { quote: edit.quote === true })
      return dotenvBlock(text, edit.vars, { quote: edit.quote === true })
    }
    if (edit.format === 'line' || edit.format === 'yaml-list') return { ...insertLine(text, { line: edit.line, after: edit.after || null, format: edit.format === 'yaml-list' ? 'yaml-list' : 'lines' }), prior: null }
  } catch (e) { throw new Error(`${file}: ${e.message}`) }
  throw new Error(`${file}: unknown text edit ${edit.format}`)
}
export function previewTextEntry({ file, edit, fs = nodeFs }) {
  const real = editTarget(file, fs)
  const before = readOrNull(fs, real)
  const res = editText(file, before == null ? null : before.toString('utf8'), edit)
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
  const joined = edit.joinBlock === true && (manifest.entries || []).some((x) => x.harness === harness && x.path === file && x.kind === 'text' && x.format === 'dotenv-block')
  const real = editTarget(file, fs)
  const before = readOrNull(fs, real)
  if (j.adopt) { j.entry.post_sha256 = sha256(before); saveManifest(dir, manifest, fs); return j.entry }
  // an intent a crashed run left, whose write never happened: the file is still as it was, so its text is not yet in it
  const res = editText(file, before == null ? null : before.toString('utf8'), edit, { joined })
  const resumed = j.action === 'resume' ? j.entry : null
  const fresh = {
    kind: 'text', harness, phase, path: file, ...(real !== file ? { real_path: real } : {}), format: edit.format,
    ...(edit.vars ? { vars: edit.vars } : { line: edit.line }),
    existed_before: before != null, mode: before != null ? fs.statSync(real).mode & 0o777 : (edit.mode || 0o600),
    pre_sha256: sha256(before), post_sha256: null, ops: res.ops, prior_value: res.prior,
    created_dirs: missingDirs(path.dirname(file), fs), installed_at: now.toISOString(),
  }
  return commit({ dir, manifest, fresh, resumed, before, res, real, now, fs, backup: () => backupFirst({ home, file, before, now, fs }) })
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
