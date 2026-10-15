// custody-cli.mjs — the P1 key-custody interface (RFC 4.11 P1) over a one-shot native program, shared by the OS backends that keep
// the root key outside Node: the macOS signing helper and the Windows custody script. One argv for both:
//   create --subject <cn> → {rootDer:b64}  ·  exists → {exists}  ·  issue --spki <b64> --serial <hex> --not-before <iso> → {certDer:b64}
//   remove → {removed}
// The program BUILDS what it signs itself (CM3): the argv carries only the intermediate's public key, serial and notBefore.
// Exit 3 (or {"error":"unavailable"}) is the VALUE 'unavailable', never a throw: create / issueIntermediate return it and the issuer
// goes forward-only (P2); exists() returns true | false | 'unavailable'. Anything else the program reports throws, with err.code =
// its error word. Core names no OS: the backend hands the program and its leading argv.
import crypto from 'node:crypto'
import { execTool } from '../../../off/exec.mjs'

const EXIT_UNAVAILABLE = 3

/** cliCustody({ kind, file, prefix, name, run, env, timeoutMs }) → { kind, create, exists, issueIntermediate, remove }. `file` +
 *  `prefix` is what runs before the verb (the helper itself, or powershell.exe and its -File script); `name` is what errors call it;
 *  `run` is execTool's injected runner. */
export function cliCustody({ kind, file, prefix = [], name = file, run = null, env = process.env, timeoutMs = 120000 }) {
  const call = (args) => {
    const r = execTool(file, [...prefix, ...args], { run, env, timeoutMs })
    let o = null
    try { o = JSON.parse(r.out) } catch { /* said below */ }
    if (r.code === EXIT_UNAVAILABLE || (o && o.error === 'unavailable')) return 'unavailable'
    if (r.code === 0 && o && !o.error) return o
    const why = o && o.error ? `${o.error}${o.message ? `: ${o.message}` : ''}` : (r.err || r.out || '').slice(0, 200)
    throw Object.assign(new Error(`${name} ${args[0]} failed (exit ${r.code ?? 'none'}): ${why}`), { code: (o && o.error) || 'helper-failed' })
  }
  return {
    kind,
    create({ subject }) {
      const o = call(['create', '--subject', subject])
      if (o === 'unavailable') return o
      const rootDer = Buffer.from(o.rootDer, 'base64')
      return { rootDer, fp256: new crypto.X509Certificate(rootDer).fingerprint256 }
    },
    exists() { const o = call(['exists']); return o === 'unavailable' ? o : o.exists === true },
    issueIntermediate({ spkiDer, serial, notBefore }) {
      const o = call(['issue', '--spki', Buffer.from(spkiDer).toString('base64'), '--serial', Buffer.from(serial).toString('hex'), '--not-before', notBefore.toISOString()])
      return o === 'unavailable' ? o : Buffer.from(o.certDer, 'base64')
    },
    remove() { const o = call(['remove']); return o === 'unavailable' ? o : { removed: o.removed === true } },
  }
}
