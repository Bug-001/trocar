// win32-optin.mjs (src/off) — the registry of the user-level opt-in undos (RFC 4.8 §2.4, §4.2, §6.3; plan Task 9(b) ships the REGISTRY and the
// LOOP, Task 14 fills one inline function per kind — done). Every user-level undo lives HERE, in JavaScript and execTool, with no script file:
// the standalone `asight-off` is made of src/off alone and must take the opt-in items out with the source tree gone (1.6 R3, 0.1 §2).
// A machine-level item is never touched here: its elevated command is printed for the operator (result `needs-admin`), and the caller
// exits 1 for it — asight never elevates on its own (R7, 4.8 §2.4, the user's 2026-10-07 decision: a confirmation, then the OS's own
// prompt, never a command as the normal path).
//
// The registry values, the WM_SETTINGCHANGE broadcast and the shortcut read are INLINE COPIES of userpath.mjs's argv (arch/win32), byte-equal
// by test/off/win32-optin.test.mjs: the standalone cannot import the arch module, so the copies are the contract, and the test is the guard
// against the two drifting. The settings keys are undone through src/off/json-text.mjs itself (reverseOps for the untouched file — byte for
// byte; the per-key way for a file the user edited since, 4.8 §2.4「只撤 asight 写的两个键」).
import path from 'node:path'
import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import { execTool } from './exec.mjs'
import { setKey, removeKey, reverseOps, getPath } from './json-text.mjs'

// ── the inline argv, held byte-equal to arch/win32/userpath.mjs's by the test ────────────────────────────────────────────────────────────────
export const USER_PATH_KEY = 'HKCU\\Environment'
export const USER_PATH_VALUE = 'Path'
export const readUserPathArgs = () => ['query', USER_PATH_KEY, '/v', USER_PATH_VALUE]
export const setUserPathArgs = (value, kind = 'REG_EXPAND_SZ') => ['add', USER_PATH_KEY, '/v', USER_PATH_VALUE, '/t', kind, '/d', value, '/f']
export const BROADCAST_ARGS = ['-NoProfile', '-NonInteractive', '-Command',
  "Add-Type -Namespace asight -Name Win32Broadcast -MemberDefinition '[DllImport(\"user32.dll\", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'; [asight.Win32Broadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]([UIntPtr]::Zero)) | Out-Null"]
export const readShortcutArgs = (shortcut) => ['-NoProfile', '-NonInteractive', '-Command',
  `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${String(shortcut).replace(/'/g, "''")}'); [Console]::Out.Write($s.TargetPath)`]

/** `HKCU\Environment\Path` as it is now (the inline twin of userpath.mjs's readUserPath). */
const readUserPath = ({ run, env }) => {
  const r = execTool('reg', readUserPathArgs(), { run, env })
  if (r.code === 1) return { absent: true }
  if (r.code !== 0) return { error: `reg query of the user PATH failed (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''})` }
  const m = /^\s*Path\s+(REG_EXPAND_SZ|REG_SZ)\s+(.*)$/m.exec(r.out)
  return m ? { kind: m[1], value: m[2].trim() } : { error: 'reg query answered, but not with the Path value' }
}

/** asight's one directory off the user PATH: the item is dropped from the CURRENT value (never the pre-asight one written back, D28), the
 *  type kept, one broadcast (the inline twin of userpath.mjs's removeUserPathItem). */
const removeUserPathItem = ({ dir, run, env }) => {
  const cur = readUserPath({ run, env })
  if (cur.error) return { ok: false, reason: cur.error }
  if (cur.absent) return { ok: true, result: 'absent' }
  const lower = (p) => String(p).toLowerCase().replace(/\//g, '\\')
  const keep = cur.value.split(';').filter((d) => d !== '' && lower(d) !== lower(dir))
  if (keep.length === cur.value.split(';').filter((d) => d !== '').length) return { ok: true, result: 'absent' } // it was not there: already as asked
  const value = keep.join(';')
  const r = execTool('reg', setUserPathArgs(value, cur.kind), { run, env })
  if (r.code !== 0) return { ok: false, reason: `reg add of the user PATH failed (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''})` }
  const b = execTool('powershell', BROADCAST_ARGS, { run, env })
  return { ok: true, result: 'undone', value, ...(b.code === 0 ? {} : { broadcast_failed: `the WM_SETTINGCHANGE broadcast failed (already-open shells keep the old PATH order)` }) }
}

/** A .lnk's target (the inline twin of userpath.mjs's readShortcutTarget). */
const readShortcutTarget = ({ shortcut, run, env }) => {
  const r = execTool('powershell', readShortcutArgs(shortcut), { run, env })
  if (r.code !== 0) return { error: `the shortcut ${shortcut} could not be read (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''})` }
  return { target: r.out }
}

/** One HKCU value read (the policy value's prior). */
const readRegValue = ({ key, name, run, env }) => {
  const r = execTool('reg', ['query', key, '/v', name], { run, env })
  if (r.code === 1) return { absent: true }
  if (r.code !== 0) return { error: `reg query of ${key}\\${name} failed (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''})` }
  const m = new RegExp(`^\\s*${name}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.*)$`, 'im').exec(r.out)
  return m ? { value: m[1].trim() } : { error: `reg query answered, but not with ${name}` }
}

const sha256Of = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
const ok = (result, reason) => (reason === undefined ? { ok: true, result } : { ok: true, result, reason })

/** The shortcuts + launcher half shared by the shortcut item and the VS Code item: each shortcut still pointing at asight's launcher is
 *  restored from its backup BYTE FOR BYTE; one the user (or an updater) repointed since is left alone and said (「你改过,没动」, §2.4);
 *  the launcher file — asight's own — goes. → `{ left, notes }`. */
const undoShortcutsAndLauncher = ({ values, run, env, fs }) => {
  const notes = []
  let left = 0
  for (const s of Array.isArray(values && values.shortcuts) ? values.shortcuts : []) {
    if (!fs.existsSync(s.path)) { notes.push(`${path.win32.basename(s.path)} is already gone`); continue }
    const t = readShortcutTarget({ shortcut: s.path, run, env })
    if (t.error) { left++; notes.push(`${s.path}: ${t.error}; asight did not touch it`); continue }
    if (t.target !== values.launcher) { left++; notes.push(`${path.win32.basename(s.path)} no longer points at asight's launcher (you changed it); asight did not touch it`); continue }
    if (!fs.existsSync(s.backup)) { left++; notes.push(`the backup of ${s.path} is gone, so asight cannot restore it`); continue }
    fs.copyFileSync(s.backup, s.path)
  }
  if (values && values.launcher && fs.existsSync(values.launcher)) {
    try { fs.rmSync(values.launcher, { force: true }) } catch (e) { notes.push(`the launcher could not be removed (${(e && e.code) || e})`) }
  }
  return { left, notes }
}

/** The settings-file half shared by the VS Code and Z-Code items: byte-exact through reverseOps when the file is what asight left
 *  (`post_sha256`), else only asight's keys go and the user's own edits stay (§2.4「只撤 asight 写的两个键」— a prior the entry recorded
 *  comes back, a key that had none is removed). A file asight created (`existed_before: false`) is deleted. → `{ left, notes }`. */
const undoSettingsKeys = ({ entry, values, fs }) => {
  const notes = []
  let left = 0
  const file = entry.path
  if (!fs.existsSync(file)) {
    if (entry.existed_before) notes.push(`${file} is gone (you deleted it; nothing of asight's is left in it)`)
    return { left, notes }
  }
  const text = fs.readFileSync(file, 'utf8')
  const keys = Array.isArray(values && values.keys) ? values.keys : []
  if (!entry.existed_before) { // asight created the file: it goes, and the empty parents with it
    fs.rmSync(file, { force: true })
    for (let d = path.win32.dirname(file); ; d = path.win32.dirname(d)) {
      if (d === path.win32.dirname(d)) break
      try { fs.rmdirSync(d) } catch { break }
    }
    return { left, notes }
  }
  const untouched = entry.post_sha256 == null || sha256Of(text) === entry.post_sha256
  let next = untouched ? reverseOps(text, entry.ops || []) : null
  if (next != null) {
    fs.writeFileSync(file, next) // byte for byte what the file held before asight
    return { left, notes }
  }
  let doc = null
  try { doc = JSON.parse(text) } catch { notes.push(`${file} is no longer JSON; asight did not touch it`); return { left: ++left, notes } }
  next = text
  for (const k of keys) {
    if (getPath(doc, k) === undefined) continue // already gone — asight's undo or the user's own removal
    const prior = values && values.prior ? values.prior[k.join('.')] : null
    const r = prior != null ? setKey(next, k, prior) : removeKey(next, k)
    if (r == null) continue
    next = r.text
  }
  fs.writeFileSync(file, next)
  notes.push(`${file} was edited after asight; only asight's keys were taken out, your other edits stay`)
  return { left, notes }
}

/** kind → ({ entry, manifest, exec, env, fs, home }) → { ok: boolean, result: 'undone' | 'absent' | 'left' | 'failed', reason? }. One inline
 *  function per user-level opt-in kind; a kind with no function here is an item a newer build wrote (the loop says so, never guesses), and
 *  test/off/win32-optin.test.mjs holds Object.keys(UNDO_BY_KIND) to exactly the user-level kinds — adding a kind without its undo is red. */
export const UNDO_BY_KIND = {
  // the PATH item (§6.3): reference counted — the shim file is per command; the PATH item and the shim directory go with the LAST shim's
  // undo, so `off kimi-code` does not break opencode. The count is by shim files that still exist, not by manifest entries: both harnesses'
  // entries are in the manifest while one `off` walks them.
  'optin-user-path': async ({ entry, manifest, exec, env, fs }) => {
    const v = entry.values || {}
    if (!v.command || !v.binDir) return { ok: false, result: 'failed', reason: `${entry.path}: the entry holds no shim to undo` }
    const shim = path.win32.join(v.binDir, `${v.command}.cmd`)
    try { fs.rmSync(shim, { force: true }) } catch (e) { return { ok: false, result: 'failed', reason: `the shim ${shim} could not be removed (${(e && e.code) || e})` } }
    const others = (manifest && Array.isArray(manifest.entries) ? manifest.entries : [])
      .filter((e) => e && e !== entry && e.kind === 'optin-user-path' && e.values && e.values.command && e.values.binDir)
      .map((e) => path.win32.join(e.values.binDir, `${e.values.command}.cmd`))
    if (others.some((p) => fs.existsSync(p))) return ok('undone', `${v.command}.cmd removed; the PATH item and the shim directory stay (another harness's shim still holds them)`)
    const r = removeUserPathItem({ dir: v.binDir, run: exec, env })
    if (!r.ok) return { ok: false, result: 'failed', reason: r.reason }
    try { fs.rmdirSync(v.binDir) } catch (e) { if (e && e.code !== 'ENOTEMPTY' && e.code !== 'ENOENT') r.reason = `the shim directory could not be removed (${e.code})` }
    const prior = entry.prior_value && entry.prior_value.value
    if (r.result === 'absent') return ok('undone', 'the PATH item was already gone')
    if (prior != null && r.value !== prior) return ok('undone', 'the PATH was changed after asight: only asight\'s directory was removed, your other edits stay (undone, but not byte for byte)')
    return ok('undone', r.reason)
  },

  // the Start-menu / desktop shortcuts: restored from their backups, the ones the user changed since are left alone (§2.4「你改过,没动」)
  'optin-shortcut': async ({ entry, exec, env, fs }) => {
    const { left, notes } = undoShortcutsAndLauncher({ values: entry.values, run: exec, env, fs })
    return left ? ok('left', notes.join('; ')) : ok('undone', notes.length ? notes.join('; ') : undefined)
  },

  // the certificate: deleted by thumbprint, CurrentUser only (§2.4「按指纹删这张证书」)
  'optin-cert-user': async ({ entry, exec, env }) => {
    const thumb = entry.values && entry.values.thumbprint
    if (!thumb) return { ok: false, result: 'failed', reason: `${entry.path}: the entry holds no thumbprint to delete by` }
    const q = execTool('certutil', ['-user', '-store', 'Root', thumb], { run: exec, env })
    if (q.code !== 0) return ok('absent', 'the certificate is not in CurrentUser\\Root (already gone)')
    const d = execTool('certutil', ['-user', '-delstore', 'Root', thumb], { run: exec, env })
    if (d.code !== 0) return { ok: false, result: 'failed', reason: `certutil -user -delstore failed (exit ${d.code ?? 'none'}${d.err ? `: ${d.err.slice(0, 200)}` : ''})` }
    return ok('undone')
  },

  // the policy value: the prior value back, or the value deleted when there was none (only that one value, D28)
  'optin-claude-policy': async ({ entry, exec, env }) => {
    const v = entry.values || {}
    if (!v.hive || !v.key || !v.name) return { ok: false, result: 'failed', reason: `${entry.path}: the entry holds no policy value to undo` }
    const full = `${v.hive}\\${v.key}`
    const q = readRegValue({ key: full, name: v.name, run: exec, env })
    if (q.absent) return ok('absent')
    if (q.error) return { ok: false, result: 'failed', reason: q.error }
    if (entry.prior_value != null) {
      const r = execTool('reg', ['add', full, '/v', v.name, '/t', 'REG_SZ', '/d', entry.prior_value, '/f'], { run: exec, env })
      if (r.code !== 0) return { ok: false, result: 'failed', reason: `reg add of the prior policy value failed (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''})` }
    } else {
      const r = execTool('reg', ['delete', full, '/v', v.name, '/f'], { run: exec, env })
      if (r.code !== 0) return { ok: false, result: 'failed', reason: `reg delete of the policy value failed (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''})` }
    }
    return ok('undone')
  },

  // the VS Code item: the two settings keys + the editor's shortcuts and the launcher
  'optin-vscode': async ({ entry, exec, env, fs }) => {
    const a = undoSettingsKeys({ entry, values: entry.values, fs })
    const b = undoShortcutsAndLauncher({ values: entry.values, run: exec, env, fs })
    return a.left + b.left ? ok('left', [...a.notes, ...b.notes].join('; ')) : ok('undone', [...a.notes, ...b.notes].join('; ') || undefined)
  },

  // the Z-Code Desktop item: the two keys of its own settings file
  'optin-zcode': async ({ entry, fs }) => {
    const a = undoSettingsKeys({ entry, values: entry.values, fs })
    return a.left ? ok('left', a.notes.join('; ')) : ok('undone', a.notes.length ? a.notes.join('; ') : undefined)
  },
}

/** The user-level opt-in items of `manifest`, undone by kind through the registry; the machine-level remainder named for the operator.
 *  → `{ results: [{ path, kind, scope, result, reason? }], needsAdmin: [{ path, kind, command? }], unknown: [{ path, kind }] }`; nothing
 *  throws — an item that could not be undone is a result, and the caller decides the exit. `ids` limits the harnesses, as everywhere. */
export async function undoOptIns({ manifest, ids = null, exec = null, env = process.env, fs = null, home = null } = {}) {
  const out = { results: [], needsAdmin: [], unknown: [] }
  const inScope = (h) => typeof h === 'string' && (ids == null || ids.includes(h))
  for (const e of (manifest && Array.isArray(manifest.entries) ? manifest.entries : [])) {
    if (!e || !e.scope || e.scope === 'agent' || !inScope(e.harness)) continue // the opt-in ones are scope 'user' / 'machine'; an 'agent' entry is the harness undo's own (parseManifest defaults every entry's scope, so the field alone no longer tells an opt-in item — §1.7「自动写的项」)
    const row = (r) => out.results.push({ path: e.path, kind: e.kind, scope: e.scope, ...r })
    if (e.scope === 'machine') { out.needsAdmin.push({ path: e.path, kind: e.kind, ...(typeof e.elevated_command === 'string' ? { command: e.elevated_command } : {}) }); row({ result: 'needs-admin', reason: 'a machine-level item: run the elevated command above, asight does not elevate on its own (R7)' }); continue }
    const undo = UNDO_BY_KIND[e.kind]
    if (!undo) { out.unknown.push({ path: e.path, kind: e.kind }); row({ result: 'unknown-kind', reason: `${e.path} is an opt-in item of kind ${JSON.stringify(e.kind)}, which this build has no undo for; use the asight that wrote it` }); continue }
    try { row(await undo({ entry: e, manifest, exec, env, fs: fs || nodeFs, home })) } catch (err) { row({ result: 'failed', reason: String((err && err.message) || err) }) }
  }
  return out
}
