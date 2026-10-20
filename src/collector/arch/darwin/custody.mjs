// custody.mjs — the macOS key custody (RFC 4.11 P1 `keychain`, plan decision #10): the P1 interface over the native signing
// helper (native/sign-helper.swift), plus installing that helper where the daemon runs it. The root key never enters Node: every
// root signature is one helper run, and the helper builds what it signs itself (CM3) — the argv carries only the intermediate's
// public key, serial and notBefore.
// 'unavailable' (no GUI session over ssh, interaction not allowed, a locked keychain: the helper's exit 3) is a VALUE, never a
// throw: create / issueIntermediate return it and the issuer goes forward-only (4.11 P2). exists() returns true | false |
// 'unavailable'. Anything else the helper reports throws, with err.code = the helper's error word.
import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import path from 'node:path'
import { cliCustody } from '../../core/tls/custody-cli.mjs'
import { NATIVE, nativePath, pins, sha256 } from './native.mjs'

/** The helper may show the keychain's prompt (interactive install): the same wait the root store gives the OS's own. */
const HELPER_TIMEOUT_MS = 120000

/** keychainCustody({ helperPath, run, env }) → { kind:'keychain', create, exists, issueIntermediate, remove }. `helperPath` is the
 *  INSTALLED helper (the caller resolves it); `run` is execTool's injected runner. The verbs, the argv and the 'unavailable' value
 *  are core/tls/custody-cli.mjs's, shared with the Windows custody script. */
export const keychainCustody = ({ helperPath, run = null, env = process.env }) =>
  cliCustody({ kind: 'keychain', file: helperPath, name: NATIVE.signHelper, run, env, timeoutMs: HELPER_TIMEOUT_MS })

/** installHelper({ dest, interactive, run, fs, src }) → { replaced, why? , prompted? }: puts the packaged helper at `dest` (resolved
 *  by the caller, under ~/.trocar/bin). It writes `<dest>.new-<rand>` and renames it over `dest`, never an in-place overwrite (one
 *  gets SIGKILLed, R3-M2). Same hash: nothing to do. A different installed hash is replaced only when `interactive`: the keychain
 *  then asks again for the new code hash, so one `issue` runs right here in the foreground and the prompt lands on the user's
 *  terminal, not on the background daemon. Non-interactive: the installed copy stays, and `why` says so. The packaged binary must
 *  match its pin (native/pins.json), or nothing is written. */
export function installHelper({ dest, interactive, run = null, env = process.env, fs = nodeFs, src = nativePath(NATIVE.signHelper) }) {
  const bytes = fs.readFileSync(src)
  if (sha256(bytes) !== pins(fs)[NATIVE.signHelper]) throw new Error(`${src} is not the pinned ${NATIVE.signHelper} (native/pins.json): nothing installed`)
  let installed = null
  try { installed = sha256(fs.readFileSync(dest)) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (installed === sha256(bytes)) return { replaced: false, why: 'same' }
  if (installed !== null && !interactive) return { replaced: false, why: `the installed ${NATIVE.signHelper} differs; replacing it makes the keychain ask for the login password, so only an interactive install replaces it` }
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
  const tmp = `${dest}.new-${crypto.randomBytes(6).toString('hex')}`
  try {
    fs.writeFileSync(tmp, bytes, { mode: 0o755 })
    fs.renameSync(tmp, dest)
  } catch (e) { try { fs.rmSync(tmp, { force: true }) } catch { /* the error below is the news */ } throw e }
  if (installed === null) return { replaced: true }
  const custody = keychainCustody({ helperPath: dest, run, env })
  if (custody.exists() !== true) return { replaced: true }
  const k = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) // a throwaway: only the prompt matters
  const r = custody.issueIntermediate({ spkiDer: k.publicKey.export({ type: 'spki', format: 'der' }), serial: Buffer.from([1]), notBefore: new Date() })
  return { replaced: true, prompted: Buffer.isBuffer(r) ? 'signed' : r }
}
