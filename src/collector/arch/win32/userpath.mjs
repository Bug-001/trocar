// userpath.mjs — the user PATH and the command lookup of the opt-in items (4.8 §6.3; plan Task 14, W21; 1.6 §1.7「入口还有没有效」).
// The user-level PATH write of `asight on <harness> --opt-in <form>` is `prependUserPath` here — `reg query` then `reg add … /t REG_EXPAND_SZ`
// through execTool, NEVER `setx` (it truncates at 1024 characters), the value's type kept as it is — and ONE `WM_SETTINGCHANGE` broadcast after
// the write, so the shells that are already open see the new order. The undo (`removeUserPathItem`) drops asight's one directory from the
// CURRENT value and never writes the pre-asight value back wholesale (D28's lesson); the src/off half that runs with the source tree gone has
// its own inline copy of the same three commands, and test/off/win32-optin.test.mjs holds the two copies to the same bytes. `resolveCommand`
// follows Windows' own order — the machine PATH first, then the user PATH (§6.3「机器 PATH 在前」) — reading both from the registry, not from
// this process's environment (the daemon's is not the install shell's). `sacOf` reads Smart App Control's one value the same way the helper's
// `reg-read` does (forwarder.mjs's sacState); the CLI apply has no helper, so it asks reg.exe. `readShortcutTarget` reads a .lnk's target
// through the one fixed read-only PowerShell line. Everything runs through execTool's injected `run`: no spawn of its own, no registry write
// outside `HKCU\Environment\Path`, no file write at all.
import path from 'node:path'
import fs from 'node:fs'
import { execTool } from '../../../off/exec.mjs'
import { readMachinePath, withPathItem, withoutPathItem } from './elevate.mjs'

/** The one value this module ever writes (§6.3). */
export const USER_PATH_KEY = 'HKCU\\Environment'
export const USER_PATH_VALUE = 'Path'
/** `reg query HKCU\Environment /v Path` — the exact argv, shared (by test) with src/off's inline copy. */
export const readUserPathArgs = () => ['query', USER_PATH_KEY, '/v', USER_PATH_VALUE]
/** `reg add HKCU\Environment /v Path /t <kind> /d <value> /f` — idem. */
export const setUserPathArgs = (value, kind = 'REG_EXPAND_SZ') => ['add', USER_PATH_KEY, '/v', USER_PATH_VALUE, '/t', kind, '/d', value, '/f']

/** The ONE `WM_SETTINGCHANGE` broadcast (HWND_BROADCAST, `Environment`): a fixed read-mostly PowerShell line with the classic P/Invoke. A
 *  broadcast that fails is a warning (the PATH write itself stands; new shells read the registry anyway) — the caller says it, never hides it. */
export const BROADCAST_ARGS = ['-NoProfile', '-NonInteractive', '-Command',
  "Add-Type -Namespace asight -Name Win32Broadcast -MemberDefinition '[DllImport(\"user32.dll\", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'; [asight.Win32Broadcast]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]([UIntPtr]::Zero)) | Out-Null"]

/** `HKCU\Environment\Path` as it is now: `{ kind, value }` · `{ absent: true }` (no value: a fresh profile) · `{ error }` (could not read: the
 *  caller refuses rather than build a PATH on a guess). The kind is kept as reg.exe spells it (`REG_SZ` / `REG_EXPAND_SZ`). */
export function readUserPath({ run = null, env = process.env } = {}) {
  const r = execTool('reg', readUserPathArgs(), { run, env })
  if (r.code === 1) return { absent: true }
  if (r.code !== 0) return { error: `reg query of the user PATH failed (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''})` }
  const m = /^\s*Path\s+(REG_EXPAND_SZ|REG_SZ)\s+(.*)$/m.exec(r.out)
  return m ? { kind: m[1], value: m[2].trim() } : { error: 'reg query answered, but not with the Path value' }
}

/** The broadcast half of a PATH write. → `{ ok }` | `{ ok: false, reason }`. */
export function broadcastSettingChange({ run = null, env = process.env } = {}) {
  const r = execTool('powershell', BROADCAST_ARGS, { run, env })
  return r.code === 0 ? { ok: true } : { ok: false, reason: `the WM_SETTINGCHANGE broadcast failed (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''}; already-open shells keep the old PATH order)` }
}

/** `dir` first on the user PATH (§6.3), the value's type kept, never `setx`, then ONE broadcast. Idempotent: a value that already starts with
 *  `dir` is only broadcast for (the order of the rest is not touched). → `{ ok, value, prior }` (`prior: { kind, value } | null` — what the
 *  ledger entry records) · `{ ok: false, reason }`. */
export function prependUserPath({ dir, run = null, env = process.env } = {}) {
  const cur = readUserPath({ run, env })
  if (cur.error) return { ok: false, reason: cur.error }
  const prior = cur.absent ? null : { kind: cur.kind, value: cur.value }
  const value = withPathItem(cur.absent ? '' : cur.value, dir)
  if (value == null) return { ok: false, reason: 'the user PATH could not be read, so nothing was written' }
  const changed = value !== (cur.absent ? null : cur.value)
  if (changed) {
    const r = execTool('reg', setUserPathArgs(value, cur.absent ? 'REG_EXPAND_SZ' : cur.kind), { run, env })
    if (r.code !== 0) return { ok: false, reason: `reg add of the user PATH failed (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''})` }
  }
  const b = broadcastSettingChange({ run, env })
  return { ok: true, value, prior, ...(b.ok ? {} : { broadcast_failed: b.reason }) }
}

/** asight's one directory OFF the user PATH: the item is dropped from the CURRENT value (never the pre-asight one written back, D28), the
 *  type kept, one broadcast. → `{ ok, result: 'undone' | 'absent', value? }` · `{ ok: false, reason }`. */
export function removeUserPathItem({ dir, run = null, env = process.env } = {}) {
  const cur = readUserPath({ run, env })
  if (cur.error) return { ok: false, reason: cur.error }
  if (cur.absent) return { ok: true, result: 'absent' }
  const value = withoutPathItem(cur.value, dir)
  if (value === cur.value) return { ok: true, result: 'absent' } // it was not there: already as asked
  const r = execTool('reg', setUserPathArgs(value, cur.kind), { run, env })
  if (r.code !== 0) return { ok: false, reason: `reg add of the user PATH failed (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''})` }
  const b = broadcastSettingChange({ run, env })
  return { ok: true, result: 'undone', value, ...(b.ok ? {} : { broadcast_failed: b.reason }) }
}

/** The extensions Windows tries per directory, in PATHEXT's order (the first four: .COM .EXE .BAT .CMD — enough for every agent command and
 *  asight's own .cmd shims; a wider set is the lab's W68 run to confirm). */
export const PATH_EXTS = Object.freeze(['.com', '.exe', '.bat', '.cmd'])

/** Where `<name>` resolves today, in Windows' own order: the machine PATH first, then the user PATH (§6.3) — both read from the registry, not
 *  from this process's environment. `skip` (a list of directories, case-blind) leaves directories out: the real-binary lookup skips asight's
 *  own shim directory, so a shim of an earlier opt-in is not mistaken for the real binary. → `{ at: 'machine' | 'user', path }` | null (`at`, not `where`: a lookup answer, not the where of a record — the D38 closed-set scan reads record-where literals)
 *  (nowhere, or a PATH that could not be read — the caller refuses rather than guess). */
export function resolveCommand(name, { run = null, env = process.env, exists = (p) => fs.existsSync(p), skip = [] } = {}) {
  if (!/^[\w.-]+$/.test(String(name || ''))) return null
  const lower = (p) => String(p).toLowerCase().replace(/\//g, '\\')
  const skipped = new Set(skip.map(lower))
  const search = (value) => String(value || '').split(';').filter((d) => d !== '' && !skipped.has(lower(d)))
  for (const [at, value] of [['machine', readMachinePath({ run, env })], ['user', (readUserPath({ run, env }) || {}).value]]) {
    if (typeof value !== 'string') continue
    for (const d of search(value)) for (const ext of PATH_EXTS) {
      const p = `${d}\\${name}${ext}`
      if (exists(p)) return { at, path: p }
    }
  }
  return null
}

/** Smart App Control's one value (§6.3), read the way forwarder.mjs's helper-based `sacState` does but through reg.exe — the CLI's opt-in
 *  apply has no helper. `HKLM\…\CI\Policy\VerifiedAndReputablePolicyState`: 0 off, 1 on, 2 evaluation; no key or value = off (the system has
 *  no such policy); anything else, or a read that did not run, is `{ unknown: { reason } }`, never a guess. asight never writes this key. */
export const SAC_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy'
export const SAC_VALUE_NAME = 'VerifiedAndReputablePolicyState'
export function sacOf({ run = null, env = process.env } = {}) {
  const r = execTool('reg', ['query', SAC_KEY, '/v', SAC_VALUE_NAME], { run, env })
  if (r.code === 1) return 'off'
  if (r.code !== 0) return { unknown: { reason: 'denied', detail: `reg query exited ${r.code ?? 'none'}` } }
  const m = new RegExp(`^\\s*${SAC_VALUE_NAME}\\s+REG_DWORD\\s+(0x[0-9a-f]+)$`, 'im').exec(r.out)
  if (!m) return { unknown: { reason: 'unparseable', detail: 'the answer held no such DWORD' } }
  const n = parseInt(m[1], 16)
  return n === 0 ? 'off' : n === 1 ? 'on' : n === 2 ? 'evaluation' : { unknown: { reason: 'unparseable', detail: `0x${n.toString(16)}` } }
}
/** Is the unsigned shim at risk? The same two states forwarder.mjs's `sacBlocks` blames; an unknown one never is (it says 「不知道」, not 「不行」). */
export const sacBlocksShims = (state) => state === 'on' || state === 'evaluation'

/** A .lnk's target, read through the one fixed read-only PowerShell line (the COM object WScript.Shell). → `{ target }` (an empty target is a
 *  real answer) · `{ error }`. The WRITE of a shortcut is shortcut.ps1's; this is the read applyOptIn's read-back and W68's check share.
 *  `readShortcutArgs` is the argv, exported so test/off/win32-optin.test.mjs can hold the src/off inline copy to the same bytes. */
export const readShortcutArgs = (shortcut) => ['-NoProfile', '-NonInteractive', '-Command',
  `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${String(shortcut).replace(/'/g, "''")}'); [Console]::Out.Write($s.TargetPath)`]
export function readShortcutTarget({ shortcut, run = null, env = process.env } = {}) {
  const r = execTool('powershell', readShortcutArgs(shortcut), { run, env })
  if (r.code !== 0) return { error: `the shortcut ${shortcut} could not be read (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''})` }
  return { target: r.out }
}

/** The Start-menu and desktop places a shortcut lives, for a shortcut file name (4.8 §2.4「开始菜单与桌面」): `%APPDATA%\…\Start
 *  Menu\Programs\<name>` and `<home>\Desktop\<name>` — the desktop a shell redirects (OneDrive) is the lab's to measure; both places are only
 *  asked for what exists, a missing one is not an error. */
export const shortcutPlaces = ({ name, home, env = process.env }) => {
  const appData = env.APPDATA || path.win32.join(home, 'AppData', 'Roaming')
  return [path.win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', name), path.win32.join(home, 'Desktop', name)]
}
