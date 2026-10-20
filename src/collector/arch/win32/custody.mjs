// custody.mjs — the Windows key custody (RFC 4.11 P1 `cng`, plan decision #9): the P1 interface over the one-shot custody.ps1. The
// root key is a non-exportable CNG key (TPM first, else the Software KSP) and never enters Node; every root signature is one script
// run, and the script builds what it signs itself (CM3). The verbs, the argv and the 'unavailable' value are core/tls/custody-cli.mjs's,
// shared with the macOS signing helper. The resident helper stays read-only: key operations are never one of its verbs (4.8 §1, W1).
import { fileURLToPath } from 'node:url'
import { cliCustody } from '../../core/tls/custody-cli.mjs'

export const CUSTODY_PS1 = fileURLToPath(new URL('./custody.ps1', import.meta.url))
/** How powershell.exe runs the script: no profile (a user's profile must not run in trocar's process), no prompt, the policy bypassed for this file only. */
export const PS_FILE_ARGS = Object.freeze(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])

/** cngCustody({ run, scriptPath, env }) → { kind:'cng', create, exists, issueIntermediate, remove }. `run` is execTool's injected runner. */
export const cngCustody = ({ run = null, scriptPath = CUSTODY_PS1, env = process.env } = {}) =>
  cliCustody({ kind: 'cng', file: 'powershell.exe', prefix: [...PS_FILE_ARGS, scriptPath], name: 'custody.ps1', run, env })
