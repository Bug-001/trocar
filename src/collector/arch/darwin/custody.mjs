// custody.mjs — the macOS key custody (RFC 4.11 P1 `keychain`): the P1 interface over the native signing
// helper (native/sign-helper.swift), plus installing that helper where the daemon runs it. The root key never enters Node: every
// root signature is one helper run, and the helper builds what it signs itself (CM3) — the argv carries only the intermediate's
// public key, serial and notBefore.
// 'unavailable' (no GUI session over ssh, interaction not allowed, a locked keychain: the helper's exit 3) is a VALUE, never a
// throw: create / issueIntermediate return it and the issuer goes forward-only (4.11 P2). exists() returns true | false |
// 'unavailable'. Anything else the helper reports throws, with err.code = the helper's error word.
import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import path from 'node:path'
import { cliCall, cliCustody, UNAVAILABLE } from '../../core/tls/custody-cli.mjs'
import { NATIVE, nativePath, pins, sha256 } from './native.mjs'

/** The helper may show the keychain's prompt (interactive install): the same wait the root store gives the OS's own. */
const HELPER_TIMEOUT_MS = 120000

/** keychainCustody({ helperPath, run, env }) → { kind:'keychain', create, exists, canCreate, issueIntermediate, remove }. `helperPath` is the
 *  INSTALLED helper (the caller resolves it); `run` is execTool's injected runner. The verbs, the argv and the 'unavailable' value
 *  are core/tls/custody-cli.mjs's, shared with the Windows custody script. canCreate() is the keychain's own (4.11 P1): looking up a
 *  missing key needs no GUI, making one does, so it asks the helper's `session` and throws code 'unavailable' without graphic access. */
export const keychainCustody = ({ helperPath, run = null, env = process.env }) => {
  const program = { file: helperPath, name: NATIVE.signHelper, run, env, timeoutMs: HELPER_TIMEOUT_MS }
  const call = cliCall(program)
  return {
    ...cliCustody({ kind: 'keychain', ...program }),
    canCreate() {
      const o = call(['session'])
      if (o === 'unavailable' || o.graphic !== true) throw Object.assign(new Error(`${NATIVE.signHelper} session: this session has no graphical access, so the login keychain cannot make a key here`), { code: UNAVAILABLE })
    },
  }
}

/** installHelper({ dest, interactive, run, fs, src }) → { replaced, why? , prompted? }: puts the packaged helper at `dest` (resolved
 *  by the caller, under ~/.trocar/bin). It writes `<dest>.new-<rand>` and renames it over `dest`, never an in-place overwrite (one
 *  gets SIGKILLed). Same hash: nothing to do. A different installed hash is replaced only when `interactive`: the keychain
 *  then asks again for the new code hash, so one `issue` runs right here in the foreground and the prompt lands on the user's
 *  terminal, not on the background daemon. Non-interactive: the installed copy stays, and `why` says so (`kept`: it still signs, which is
 *  a note for the caller, not a failure). An issue that does not sign (the box denied or timed out, no GUI session) puts the old bytes
 *  back the same way: the new copy has no access to the key, so the daemon would stop signing with it. The packaged binary must match
 *  its pin (native/pins.json), or nothing is written. */
export function installHelper({ dest, interactive, run = null, env = process.env, fs = nodeFs, src = nativePath(NATIVE.signHelper) }) {
  const bytes = fs.readFileSync(src)
  if (sha256(bytes) !== pins(fs)[NATIVE.signHelper]) throw new Error(`${src} is not the pinned ${NATIVE.signHelper} (native/pins.json): nothing installed`)
  let installed = null
  try { installed = sha256(fs.readFileSync(dest)) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (installed === sha256(bytes)) return { replaced: false, why: 'same' }
  if (installed !== null && !interactive) return { replaced: false, kept: true, why: `the installed ${NATIVE.signHelper} keeps signing; replacing it makes macOS ask once to let the new one use trocar's key, so run trocar install from a Terminal in your desktop session to replace it (an ssh login cannot answer it)` }
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
  const put = (data) => { // <dest>.new-* renamed over dest: never an in-place overwrite
    const tmp = `${dest}.new-${crypto.randomBytes(6).toString('hex')}`
    try {
      fs.writeFileSync(tmp, data, { mode: 0o755 })
      fs.renameSync(tmp, dest)
    } catch (e) { try { fs.rmSync(tmp, { force: true }) } catch { /* the error below is the news */ } throw e }
  }
  const old = installed === null ? null : fs.readFileSync(dest)
  put(bytes)
  if (old === null) return { replaced: true }
  let r
  try {
    const custody = keychainCustody({ helperPath: dest, run, env })
    const has = custody.exists()
    if (has === false) return { replaced: true } // no key yet: nothing the new copy must be let at
    const k = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) // a throwaway: only the prompt matters
    r = has !== true ? has : custody.issueIntermediate({ spkiDer: k.publicKey.export({ type: 'spki', format: 'der' }), serial: Buffer.from([1]), notBefore: new Date() })
  } catch (e) { r = e }
  if (Buffer.isBuffer(r)) return { replaced: true, prompted: 'signed' }
  put(old) // the new copy cannot use the key: the old one goes back, and keeps signing
  const why = r === 'unavailable' ? 'this session cannot show the keychain\'s question (no GUI session, or the keychain is locked)' : `the keychain did not let it sign (${String((r && r.message) || r)})`
  return { replaced: false, kept: true, why: `the new ${NATIVE.signHelper} was not given trocar's key: ${why}, so the installed one stays and keeps signing. Run trocar install from a Terminal in your desktop session (an ssh login cannot answer it) and choose Always Allow when macOS asks` }
}
