// root-store.mjs (src/off) — the user's OS root store, P3 of RFC 4.11 (plan §E.5 #3): the one place that knows its argv on both
// OSes; the collector's install and the standalone uninstall import it (node:* and src/off only). Always the user's store: the
// login keychain on macOS, CurrentUser\Root on Windows — a machine store is never written. The OS prompt is the consent.
//   darwin  add     security add-trusted-cert -r trustRoot -k <login keychain> <file>   (no -p: unrestricted, M7 / M8)
//           has     security find-certificate -a -Z -p <login keychain>, matched by SHA-256
//           remove  security remove-trusted-cert <file>, then security delete-certificate -Z <sha1> <login keychain>
//   win32   add     certutil -user -addstore Root <file>
//           has     certutil -user -store Root <thumbprint>
//           remove  certutil -user -delstore Root <thumbprint>
// A root is named by rootIdOf(der) = { fp256 (node's AB:CD:… form), sha1 (the thumbprint, hex) }: Windows looks a certificate up by its
// SHA-1 thumbprint only. The certificate file `security` / `certutil` read is written under ~/.asight/collector and removed after.
import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import path from 'node:path'
import { execTool } from './exec.mjs'
import { certBlocks } from './pem.mjs'

/** { fp256, sha1 } of a certificate (DER or PEM). */
export function rootIdOf(cert) {
  const x = new crypto.X509Certificate(cert)
  return { fp256: x.fingerprint256, sha1: x.fingerprint.replace(/:/g, '') }
}

/** certutil's exit when the store has no such certificate: CRYPT_E_NOT_FOUND. */
export const CRYPT_E_NOT_FOUND = 0x80092004

const rsTool = (r, what) => (r.code === 0 ? null : `${what} failed (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''})`)

/** rootStore({ platform, run, home, env, fs }) → { add(rootDer), has(id), remove(id) }. add / remove → { ok: true, absent? } |
 *  { ok: false, reason }; has → { present } | { error }. `run` is execTool's injected runner. */
export function rootStore({ platform, run = null, home, env = process.env, fs = nodeFs }) {
  const opts = { run, env, timeoutMs: 120000 } // the OS may show its prompt
  const tmp = path.join(home, '.asight', 'collector', 'root-store-tmp.pem')
  const withFile = (pem, fn) => {
    try {
      fs.mkdirSync(path.dirname(tmp), { recursive: true, mode: 0o700 })
      fs.writeFileSync(tmp, pem, { mode: 0o600 })
      return fn(tmp)
    } finally { try { fs.rmSync(tmp, { force: true }) } catch { /* the next run's write replaces it */ } }
  }
  const pemOf = (der) => new crypto.X509Certificate(der).toString()

  if (platform === 'darwin') {
    const kc = path.join(home, 'Library', 'Keychains', 'login.keychain-db')
    const find = (fp256) => {
      const r = execTool('security', ['find-certificate', '-a', '-Z', '-p', kc], opts)
      if (r.code !== 0) return { error: rsTool(r, 'security find-certificate') }
      return { block: certBlocks(r.out).find((c) => c.fp === fp256) || null }
    }
    return {
      add: (rootDer) => withFile(pemOf(rootDer), (f) => {
        const why = rsTool(execTool('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', kc, f], opts), 'security add-trusted-cert')
        return why ? { ok: false, reason: why } : { ok: true }
      }),
      has: ({ fp256 }) => { const f = find(fp256); return f.error ? { error: f.error } : { present: !!f.block } },
      remove: ({ fp256 }) => {
        const f = find(fp256)
        if (f.error) return { ok: false, reason: f.error }
        if (!f.block) return { ok: true, absent: true }
        const { sha1 } = rootIdOf(f.block.pem)
        return withFile(pemOf(f.block.pem), (file) => {
          // the trust setting first; an import whose trust was never set has none to remove, and the certificate goes either way
          execTool('security', ['remove-trusted-cert', file], opts)
          const why = rsTool(execTool('security', ['delete-certificate', '-Z', sha1, kc], opts), 'security delete-certificate')
          return why ? { ok: false, reason: why } : { ok: true }
        })
      },
    }
  }
  if (platform === 'win32') {
    const thumb = (id) => { if (!id || !id.sha1) throw new Error('the Windows root store looks a certificate up by its SHA-1 thumbprint: pass rootIdOf(der)'); return id.sha1 }
    // only certutil's not-found exit is "absent"; a spawn failure, a timeout (code null) or any other exit is an error,
    // never a silent "already gone" (D38). The exit is the HRESULT; `>>> 0` reads it signed or unsigned alike.
    const find = (id) => {
      const r = execTool('certutil', ['-user', '-store', 'Root', thumb(id)], opts)
      if (r.code === 0) return { present: true }
      if (r.code !== null && r.code >>> 0 === CRYPT_E_NOT_FOUND) return { present: false }
      return { error: rsTool(r, 'certutil -user -store') }
    }
    return {
      add: (rootDer) => withFile(pemOf(rootDer), (f) => {
        const why = rsTool(execTool('certutil', ['-user', '-addstore', 'Root', f], opts), 'certutil -user -addstore')
        return why ? { ok: false, reason: why } : { ok: true }
      }),
      has: (id) => { const f = find(id); return f.error ? { error: f.error } : { present: f.present } },
      remove: (id) => {
        const f = find(id)
        if (f.error) return { ok: false, reason: f.error }
        if (!f.present) return { ok: true, absent: true }
        const why = rsTool(execTool('certutil', ['-user', '-delstore', 'Root', thumb(id)], opts), 'certutil -user -delstore')
        return why ? { ok: false, reason: why } : { ok: true }
      },
    }
  }
  throw new Error(`no user root store for ${platform}: Linux keeps the file custody's root (4.11 P1)`)
}
