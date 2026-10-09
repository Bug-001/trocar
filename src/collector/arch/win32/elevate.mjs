// elevate.mjs — the ONE elevated step of a machine-level opt-in item (4.8 §2.4「机器级」; 1.6 §1.7, V63, W65, W66). The rule (2026-10-07
// the normal path is ONE confirmation (what changes, why admin) and then the OPERATING SYSTEM'S OWN prompt — UAC's consent box on Windows;
// asight never elevates itself, never sees the password, never draws a password field of its own. Printing the command is the FALLBACK alone, for
// when no prompt can be shown (a session-less service context, standalone off over SSH without a tty); the item then stays pending-admin (on) /
// needs-admin (off) and exits 1.
//   elevatedCommand({ item, op, values })  the self-contained one-line PowerShell command of the step: every value it writes is INLINE in it — the
//                                         dispatcher text, the PATH value — and nothing under %USERPROFILE%, %APPDATA%, %LOCALAPPDATA% or %TEMP% is
//                                         referenced (a script there could be swapped for another of the user's processes between the confirmation
//                                         and the UAC click, riding the elevation). The machine PATH gets %ProgramData%\asight\machine-bin — an
//                                         admin-only-writable directory whose dispatchers call the RUNNING user's own shim when it exists and the
//                                         real binary recorded at opt-in otherwise, so other users and services never go through this user's kernel
//                                         (§6.3; putting the user's shim dir there would be a PATH hijack: the user's own processes could plant
//                                         files ahead of every admin's and SYSTEM's lookup).
//   runElevated({ command, launch })      hands the step to the OS's own prompt: `Start-Process -Verb RunAs` through the INJECTED launcher (a test
//                                         answers what UAC did; nothing here may spawn or prompt for real on a dev machine). → { ok } (the user
//                                         consented and the step ran) · { refused, outcome uac-declined } (the consent box was declined:
//                                         pending-admin, NOT optin-failed) · { noPrompt, outcome no-prompt } (no prompt can be shown: the fallback,
//                                         the command is printed).
// Every attempt and its outcome is recorded by the caller with a code (D38); this module only builds and asks.
import { execTool } from '../../../off/exec.mjs'

/** The admin-only-writable directory of the machine-level items (§6.3): SYSTEM and Administrators write, Users read and execute. This is the
 *  %…% form, exactly what goes into the machine PATH value: it is a REG_EXPAND_SZ, so Windows expands it on every read. */
export const MACHINE_BIN = '%ProgramData%\\asight\\machine-bin'
/** The same directory as the PowerShell the elevated step runs sees it (unquoted: each use quotes it where it needs it). */
const BIN = '$env:ProgramData\\asight\\machine-bin'
/** A double-quoted PowerShell string: the one form $env:ProgramData expands in (ProgramData never holds a $ or a backtick). */
const dq = (p) => '"' + String(p) + '"'
export const MACHINE_PATH_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'

/** The dispatcher a machine-level item writes into machine-bin, from inline content (§6.3): no credential, and exactly one rule — the RUNNING
 *  user's own shim goes first when it exists, else the real binary recorded at opt-in. `values` = { command, realBinary } (the command a plain
 *  word, the binary an absolute path). */
export function dispatcherText({ command, realBinary }) {
  if (typeof command !== 'string' || !/^[\w.-]+$/.test(command)) throw new TypeError(`dispatcherText needs a command name, got ${JSON.stringify(command)}`)
  if (typeof realBinary !== 'string' || !realBinary) throw new TypeError('dispatcherText needs the real binary\'s absolute path (recorded at opt-in)')
  return [
    '@echo off',
    `rem asight collector: machine-level dispatcher for ${command}, written by an elevated opt-in step (4.8 s6.3). It holds no credential.`,
    'rem It runs the RUNNING user\'s own shim when that user opted in, else the real binary: other users and services never go through this kernel.',
    `if exist "%USERPROFILE%\\.asight\\collector\\bin\\${command}.cmd" (`,
    `  call "%USERPROFILE%\\.asight\\collector\\bin\\${command}.cmd" %*`,
    ') else (',
    `  "${realBinary}" %*`,
    ')',
    '',
  ].join('\r\n')
}

// A PowerShell single-quoted string: the one quoting that survives both our own -Command and the inner step (a backtick or $ inside is literal —
// a user's path may hold either). BIN above is quoted by dq where the step uses it: $env:ProgramData must expand, and ProgramData never holds $ or `.
const sq = (s) => `'${String(s).replace(/'/g, "''")}'`
// one line: the dispatcher's CRLF becomes `n escapes so the elevated command stays the self-contained ONE line the fallback prints
const psText = (s) => sq(String(s).replace(/\r\n/g, '`n'))

/** The current machine PATH (reg query through execTool, never written here): the value the step's `reg add` builds on — read now, written by the
 *  elevated step moments later; a change in between is lost to the step and caught by the read-back (the lab measures how real that is). → the
 *  value, or null when it cannot be read (the command is then not built on a guess). */
export function readMachinePath({ run = null, env = process.env } = {}) {
  const r = execTool('reg', ['query', MACHINE_PATH_KEY, '/v', 'Path'], { run, env })
  if (r.code !== 0) return null
  const m = /^\s*Path\s+REG_(EXPAND_)?SZ\s+(.*)$/m.exec(r.out)
  return m ? m[2].trim() : null
}

/** One PATH value with `dir` first (never added twice; only our entry moves, the rest keeps its order); `withoutPathItem` drops it. null when the
 *  value read was null: the caller refuses rather than write a PATH built on a guess. */
export function withPathItem(value, dir) {
  if (typeof value !== 'string') return null
  return [dir, ...value.split(';').filter((x) => x !== '' && x.toLowerCase() !== dir.toLowerCase())].join(';')
}
export const withoutPathItem = (value, dir) => (typeof value === 'string' ? value.split(';').filter((x) => x !== '' && x.toLowerCase() !== dir.toLowerCase()).join(';') : null)

/** The self-contained one-line PowerShell command of a machine-level step (§2.4「机器级」; W65's scan reads these strings). `op` is 'apply' or
 *  'undo'; `values` is what the item carries: the command name, the real binary recorded at opt-in, the machine PATH as read now, the shortcuts,
 *  and (undo) whether this is the LAST item of the directory. Writes to HKLM and the all-users Start menu live in THIS output alone — the W65
 *  static scan pins that; so does the rule that no %USERPROFILE% path is referenced as a script or executable (the dispatcher's runtime lookup of
 *  the running user's shim is §6.3's rule, not a reference the step reads). */
export function elevatedCommand({ item, op = 'apply', values = {} } = {}) {
  if (op !== 'apply' && op !== 'undo') throw new TypeError(`elevatedCommand op must be 'apply' or 'undo', got ${JSON.stringify(op)}`)
  if (!/^(machine-path-dispatcher|all-users-launcher|machine-cert)$/.test(item)) throw new TypeError(`elevatedCommand knows no machine item ${JSON.stringify(item)} (4.8 §2.4's machine column)`)
  const refuse = () => { throw new Error(`the machine PATH could not be read, so the elevated step for ${item} cannot be built (nothing was changed)`) }
  const mkdir = `New-Item -ItemType Directory -Force -Path ${dq(BIN)} | Out-Null; icacls ${dq(BIN)} /inheritance:r /grant 'SYSTEM:(OI)(CI)F' /grant 'Administrators:(OI)(CI)F' /grant 'Users:(OI)(CI)RX'`
  if (item === 'machine-path-dispatcher') {
    const dispatcher = dq(`${BIN}\\${values.command}.cmd`)
    if (op === 'apply') {
      const value = withPathItem(values.machinePath, MACHINE_BIN)
      if (value == null) refuse()
      return { command: `${mkdir}; Set-Content -Path ${dispatcher} -Value ${psText(dispatcherText(values))} -Encoding ASCII; reg add ${sq(MACHINE_PATH_KEY)} /v Path /t REG_EXPAND_SZ /d ${sq(value)} /f` }
    }
    const value = withoutPathItem(values.machinePath, MACHINE_BIN)
    if (value == null) refuse()
    const drop = `Remove-Item -Path ${dispatcher} -Force; reg add ${sq(MACHINE_PATH_KEY)} /v Path /t REG_EXPAND_SZ /d ${sq(value)} /f`
    return { command: values.last ? `if (Test-Path ${dq(BIN)}) { ${drop}; Remove-Item -Path ${dq(BIN)} -Recurse -Force }` : drop }
  }
  if (item === 'all-users-launcher') {
    const launcher = dq(`${BIN}\\asight-${values.command}.cmd`)
    if (op === 'apply') {
      const repoint = (values.shortcuts || []).map((lnk) => `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${sq(lnk)}); $s.TargetPath=${launcher}; $s.Save()`).join('; ')
      return { command: `${mkdir}; Set-Content -Path ${launcher} -Value ${psText(dispatcherText(values))} -Encoding ASCII${repoint ? `; ${repoint}` : ''}` }
    }
    const restore = (values.shortcuts || []).map((lnk) => `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${sq(lnk)}); $s.TargetPath=${sq(values.realBinary)}; $s.Save()`).join('; ')
    return { command: `Remove-Item -Path ${launcher} -Force${restore ? `; ${restore}` : ''}` }
  }
  // machine-cert: v1 has no form that needs it (CryptoAPI merges CurrentUser\Root, §2.4's last row); the kind exists, the step is the import/delete.
  // The certificate BYTES are inline (§2.4: 要写的值与证书字节都在命令里) — the CA's file lives under the user's home, and the elevated step must
  // not read a file a user process could swap: the bytes land in the admin-only directory, are imported from there, and the copy is removed.
  if (op === 'apply') {
    if (typeof values.certB64 !== 'string' || !values.certB64) throw new TypeError('machine-cert needs the certificate bytes inline (certB64), not a file the step would read')
    const staged = dq(`${BIN}\\asight-ca.cer`)
    return { command: `${mkdir}; [IO.File]::WriteAllBytes(${staged}, [Convert]::FromBase64String(${sq(values.certB64)})); Import-Certificate -FilePath ${staged} -CertStoreLocation Cert:\\LocalMachine\\Root; Remove-Item -Path ${staged} -Force` }
  }
  return { command: `certutil -delstore Root ${sq(values.thumbprint)}` }
}

/** Hands `command` to the OS's own elevation prompt (V63): `Start-Process -Verb RunAs` through the INJECTED `launch(file, args)` — the UAC box is
 *  the operating system's, asight draws nothing and reads no password. `canPrompt()` (injected) says whether a prompt can be shown at all: when it
 *  cannot, the command is NOT launched (the fallback is the caller printing it). → { ok: true } · { refused: true, outcome: 'uac-declined' } ·
 *  { noPrompt: true, outcome: 'no-prompt' } — and a launch that did not run or answered nothing neither way is { refused: true, outcome:
 *  'elevate-error', reason } (the item stays pending-admin; a step nobody confirmed is not done). The outcome is a word of THIS exchange (it rides
 *  the install-note's `outcome`, D38's closed sets are for `code`s, and a refused UAC deliberately has no code of its own: it is pending-admin). */
export function runElevated({ command, launch, canPrompt = () => true } = {}) {
  if (typeof command !== 'string' || !command) throw new TypeError('runElevated needs the elevated command')
  if (typeof launch !== 'function') throw new TypeError('runElevated needs the injected launcher (nothing here may spawn for real)')
  if (canPrompt() === false) return { noPrompt: true, outcome: 'no-prompt', reason: 'no prompt can be shown here (no desktop session, or no tty): the command is the fallback' }
  const inner = command.replace(/'/g, "''")
  const r = launch('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -Verb RunAs -FilePath powershell -ArgumentList @('-NoProfile','-Command','${inner}') -Wait`])
  if (r && r.ok === true) return { ok: true }
  if (r && r.declined === true) return { refused: true, outcome: 'uac-declined', reason: 'the UAC consent box was declined' }
  const out = `${(r && r.out) || ''} ${(r && r.err) || ''}`.trim()
  if (/cancel/i.test(out)) return { refused: true, outcome: 'uac-declined', reason: 'the UAC consent box was declined' }
  return { refused: true, outcome: 'elevate-error', reason: `the elevated step did not report success (${out.slice(0, 200) || 'no answer'})` }
}
