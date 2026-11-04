// path-item.mjs — the script channel's PATH item (RFC 1.6 §3.2 「脚本渠道多一项 PATH」 and §3.6, D74⑤): `~/.trocar/bin` appended, lowest precedence,
// so `trocar` is a command in the next shell. Data, not branches: the shell start file comes from one table keyed by (system, the name of $SHELL), and
// the edit is the generic sentinel line of text-edit.mjs, with the backup, the file's own encoding and the journal's undo (undoEntry: a file the user
// edited since keeps their edits, only trocar's line goes). Windows appends one element to HKCU\Environment `Path`, read unexpanded, its kind
// and the user's separators kept (psScript below), then broadcasts the change by setting and clearing a user variable through .NET (never setx). The record lives in the install
// manifest's own `path_item`, not in `entries`: it names no harness, so neither `off` nor the copy without the source tree ever reads it.
import nodeFs from 'node:fs'
import path from 'node:path'
import { insertLine, lineComment, holdsMarked } from './text-edit.mjs'
import { decodeText, encodeText, WHY_TEXT } from './text-codec.mjs'
import { writeBackup } from './backup.mjs'
import { writeDurable, sha256, missingDirs, editTarget, readOrNull } from './fsutil.mjs'
import { undoEntry } from './journal.mjs'
import { undoByHand } from './manifest.mjs'
import { execTool } from './exec.mjs'

const MARK = lineComment('puts trocar on your PATH')
const POSIX = `case ":$PATH:" in *":$HOME/.trocar/bin:"*) ;; *) export PATH="$PATH:$HOME/.trocar/bin" ;; esac ${MARK}`
const FISH = `contains -- $HOME/.trocar/bin $PATH; or set -gx PATH $PATH $HOME/.trocar/bin ${MARK}`
// first match wins; `os` absent = any system, `shell` absent = any shell
const RC = Object.freeze([
  { shell: 'zsh', file: ({ env, home }) => path.join(env.ZDOTDIR || home, '.zshrc') },
  { shell: 'bash', os: 'darwin', file: ({ home }) => path.join(home, '.bash_profile') },
  { shell: 'bash', file: ({ home }) => path.join(home, '.bashrc') },
  { shell: 'fish', file: ({ home }) => path.join(home, '.config', 'fish', 'conf.d', 'trocar.fish'), line: FISH }, // a file of trocar's own: undo removes it
  { file: ({ home }) => path.join(home, '.profile') },
])
export const WIN_ELEMENT = '%USERPROFILE%\\.trocar\\bin'
const WIN_WHERE = 'HKCU\\Environment\\Path'

/** Where the item goes on this machine → { file, line } (macOS / Linux) or { where, element } (Windows). */
export function pathItemTarget({ platform = process.platform, env = process.env, home }) {
  if (platform === 'win32') return { where: WIN_WHERE, element: WIN_ELEMENT }
  const shell = path.basename(String(env.SHELL || ''))
  const row = RC.find((r) => (!r.shell || r.shell === shell) && (!r.os || r.os === platform))
  return { file: row.file({ env, home }), line: row.line || POSIX }
}

// One fixed PowerShell script per verb; the element is a constant and `created` a boolean, so nothing else of the caller's reaches the text. RegistryKey
// keeps the unexpanded spelling and the value's kind: REG_EXPAND_SZ gets the element as written, REG_SZ (setx writes those) the expanded path, and
// the kind never changes; an absent value is created REG_EXPAND_SZ. `add` appends ';' + element to a value that is not empty; `remove` takes out
// exactly that (or the element and its ';' when it leads), so the user's own separators stay byte for byte; a value add created and that is empty
// again goes. The answer is one JSON line {result}.
export const psScript = (op, { created = false } = {}) => [
  "$ErrorActionPreference = 'Stop'",
  `$el = '${WIN_ELEMENT}'`,
  '$abs = [Environment]::ExpandEnvironmentVariables($el)',
  "$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
  "$v = $k.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
  "if ($null -ne $v) { $kind = $k.GetValueKind('Path'); if ($kind -ne 'String' -and $kind -ne 'ExpandString') { throw \"Path is a $kind value, not a string\" } }",
  "$alt = '(' + [regex]::Escape($el) + '|' + [regex]::Escape($abs) + ')\\\\?'", // PowerShell receives ')\\?': an optional trailing backslash
  op === 'add'
    ? "if ($null -eq $v) { $k.SetValue('Path', $el, 'ExpandString'); $r = 'created' } elseif ([regex]::IsMatch($v, '(?i)(^|;)' + $alt + '(?=;|$)')) { $r = 'present' } else { $add = if ($kind -eq 'ExpandString') { $el } else { $abs }; $k.SetValue('Path', $(if ($v -eq '') { $add } else { $v + ';' + $add }), $kind); $r = 'added' }"
    : `$m = $null; if ($null -ne $v) { $m = [regex]::Match($v, '(?i);' + $alt + '(?=;|$)'); if (-not $m.Success) { $m = [regex]::Match($v, '(?i)^' + $alt + '(;|$)') } }; if (-not ($m -and $m.Success)) { $r = 'absent' } else { $new = $v.Remove($m.Index, $m.Length); if ($new -eq '' -and $${created ? 'true' : 'false'}) { $k.DeleteValue('Path') } else { $k.SetValue('Path', $new, $kind) }; $r = 'removed' }`,
  "$k.Close()",
  "if ($r -ne 'present' -and $r -ne 'absent') { [Environment]::SetEnvironmentVariable('TROCAR_PATH_NOTICE', '1', 'User'); [Environment]::SetEnvironmentVariable('TROCAR_PATH_NOTICE', $null, 'User') }",
  "[Console]::Out.WriteLine('{\"result\":\"' + $r + '\"}')",
].join('\n')
function winPath(op, { run, env, created }) {
  const r = execTool('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(psScript(op, { created }), 'utf16le').toString('base64')], { run, env, timeoutMs: 30_000 })
  let result = null
  try { result = JSON.parse(r.out.split(/\r?\n/).at(-1)).result } catch { /* no answer: said below */ }
  if (r.code !== 0 || !result) throw new Error(`${WIN_WHERE} could not be changed (${r.err || `powershell exit ${r.code}`})`)
  return result
}

/**
 * Puts the item in place → the record to keep in the manifest's `path_item`, or null when it is already there (nothing written). Throws with the
 * reason when the file cannot be edited (its encoding unproven, a dangling link, no backup) — nothing of the user's is changed then.
 */
export function placePathItem({ platform = process.platform, env = process.env, home, now = new Date(), fs = nodeFs, run = null }) {
  const t = pathItemTarget({ platform, env, home })
  if (t.element) {
    const result = winPath('add', { run, env })
    const rec = { kind: 'user-path', path: t.where, element: t.element, ...(result === 'created' ? { created: true } : {}), installed_at: now.toISOString() }
    return result !== 'present' ? { ...rec, undo_by_hand: `remove ${t.element} from your user Path (Settings > System > About > Advanced system settings > Environment Variables)` } : null
  }
  const real = editTarget(t.file, fs)
  const before = readOrNull(fs, real)
  const d = before == null ? { ok: true, text: null, charset: 'utf8' } : decodeText(before)
  if (!d.ok) throw new Error(`${t.file} was not changed: trocar cannot tell how it is encoded — ${WHY_TEXT[d.why]}`)
  if (holdsMarked(d.text, t.line)) return null // the line is there, whatever command words its marker names (4.6「标记的字」)
  const res = insertLine(d.text, { line: t.line })
  const backup = before == null ? null : writeBackup({ home, file: t.file, data: before, now, fs })
  const created = missingDirs(path.dirname(real), fs)
  fs.mkdirSync(path.dirname(real), { recursive: true, mode: 0o700 })
  const mode = before == null ? 0o644 : fs.statSync(real).mode & 0o777
  const bytes = encodeText(res.text, d.charset)
  writeDurable(real, bytes, mode, fs)
  const rec = { kind: 'text', format: 'line', path: t.file, ...(real !== t.file ? { real_path: real } : {}), line: t.line, ops: res.ops, existed_before: before != null, mode,
    pre_sha256: sha256(before), post_sha256: sha256(bytes), backup, created_dirs: created, ...(d.charset !== 'utf8' ? { charset: d.charset } : {}), installed_at: now.toISOString() }
  return { ...rec, undo_by_hand: undoByHand(rec) }
}

const LEFT = new Set(['left-unparsable', 'left-unreadable', 'left-link', 'left-text', 'error'])
const NOT_THERE = new Set(['absent', 'already-removed', 'already-restored', 'missing']) // the item was gone before this run: nothing was taken out
/** Takes the item out again → { ok, path, result, taken, reason? }: `taken` is whether this run took it out (false: it was no longer there, so a
 *  receipt does not say it was). A file the user edited since keeps their edits (only trocar's line goes); a value they changed keeps theirs, without the one element. */
export function removePathItem(rec, { env = process.env, fs = nodeFs, run = null } = {}) {
  const ok = (result) => ({ ok: true, path: rec.path, result, taken: !NOT_THERE.has(result) })
  if (rec.kind === 'user-path') {
    try { return ok(winPath('remove', { run, env, created: rec.created === true })) } catch (e) { return { ok: false, path: rec.path, result: 'error', taken: false, reason: `${e.message}; by hand: ${rec.undo_by_hand}` } }
  }
  const r = undoEntry(rec, { fs })
  return LEFT.has(r.result) ? { ok: false, path: rec.path, result: r.result, taken: false, reason: `${r.reason || r.result}; by hand: ${rec.undo_by_hand}` } : ok(r.result)
}
