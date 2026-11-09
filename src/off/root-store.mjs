// root-store.mjs (src/off) — the user's OS root store, P3 of RFC 4.11: the one place that knows its argv on both
// OSes; the collector's install and the standalone uninstall import it (node:* and src/off only). Always the user's store: the
// login keychain on macOS, CurrentUser\Root on Windows — a machine store is never written. The OS prompt is the consent.
//   darwin  add     security add-trusted-cert -r trustRoot -k <login keychain> <file>   (no -p: unrestricted)
//           has     security find-certificate -a -Z -p <login keychain>, matched by SHA-256, AND a user trust setting for it:
//                   security trust-settings-export <file> (the user domain), its trustList keyed by SHA-1, not Deny — an import whose
//                   prompt was declined or ignored is in the keychain without trust, and must read as absent so the next add asks again
//           remove  security remove-trusted-cert <file>, then security delete-certificate -Z <sha1> <login keychain>
//           list    security find-certificate -a -c <ROOT_SUBJECT> -Z -p <login keychain>, kept when the subject is exactly CN=<ROOT_SUBJECT> (-c matches
//                   a substring); trust is not asked: an untrusted one is residue all the same. Exit 44 (errSecItemNotFound) is none
//   win32   add     certutil -user -addstore Root <file>
//           has     certutil -user -store Root (the user's own store, listed), matched by thumbprint: a lookup's exit is not a fact —
//                   `-store Root <absent thumbprint>` exits 0, CRYPT_E_NOT_FOUND or NTE_NOT_FOUND by caller (a Windows test machine, 2026-10-17)
//           remove  certutil -user -delstore Root <thumbprint>
//           list    certutil -user -store Root, one section per certificate (split at its ==== lines): a section with two lines whose value (after
//                   its localized label and colon) is exactly CN=<ROOT_SUBJECT>, issuer and subject of a self-signed root, is one, its thumbprint the section's last 40-hex value, spaces out
// A root is named by rootIdOf(der) = { fp256 (node's AB:CD:… form), sha1 (the thumbprint, hex) }: Windows looks a certificate up by its
// SHA-1 thumbprint only. The certificate file `security` / `certutil` read is written under ~/.trocar/collector and removed after.
import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import path from 'node:path'
import { execTool } from './exec.mjs'
import { certBlocks, findCert } from './pem.mjs'

/** The subject trocar's root carries, frozen (D27②): how every trocar root in a user's store is found again, so a second one is never trusted
 *  beside it (4.11 §3 ㉔). The custody makes the root with it (src/collector/model-install.mjs). */
export const ROOT_SUBJECT = 'trocar local root'

/** Are two root ids ({ fp256?, sha1? }, a manifest's `system-root` as { fp256, sha1: thumbprint }) the same certificate? */
export const sameRoot = (a, b) => !!((a.fp256 && b.fp256 && a.fp256 === b.fp256) || (a.sha1 && b.sha1 && a.sha1.toLowerCase() === b.sha1.toLowerCase()))

/** 4.11 §3 ㉔: the trocar roots `store` holds that manifest `m` does not list as a `system-root` → { roots } | { error } — a listing that fails or
 *  throws is an error, never none (D38). install refuses on it, uninstall removes them, doctor reports them. */
export async function strayRoots(store, m) {
  const listed = ((m && !m.unsupported && m.entries) || []).filter((e) => e && e.kind === 'system-root').map((e) => ({ fp256: e.fp256, sha1: e.thumbprint }))
  let r
  try { r = await store.list() } catch (e) { if (e && e.code === 'ESANDBOX') throw e; r = { error: String((e && e.message) || e) } } // the test guard's refusal is never "the tool failed" (src/off/exec.mjs)
  return !r || r.error || !Array.isArray(r.roots) ? { error: (r && r.error) || 'no answer' } : { roots: r.roots.filter((x) => !listed.some((e) => sameRoot(x, e))) }
}

/** How every command names a root to the user: the SHA-256 when the store gives it, else the thumbprint (Windows lists only that). */
export const rootName = (id) => (id.fp256 ? `SHA-256 ${id.fp256}` : `thumbprint ${id.sha1}`)

/** { fp256, sha1 } of a certificate (DER or PEM). */
export function rootIdOf(cert) {
  const x = new crypto.X509Certificate(cert)
  return { fp256: x.fingerprint256, sha1: x.fingerprint.replace(/:/g, '') }
}

const rsTool = (r, what) => (r.code === 0 ? null : `${what} failed (exit ${r.code ?? 'none'}${r.err ? `: ${r.err.slice(0, 200)}` : ''})`)

/** rootStore({ platform, run, home, env, fs, once }) → { add(rootDer), has(id), remove(id), list() }. add / remove → { ok: true, absent? } |
 *  { ok: false, reason }; has → { present } | { error }; list → { roots: [{ fp256?, sha1 }] } (every trocar root, ROOT_SUBJECT) | { error }.
 *  `run` is execTool's injected runner. `once` (read-only use: no add or remove after it): Windows lists the store at most once for has and list. */
/** How long a root-store verb may wait on the OS: it may show its prompt, and a person may be slow to answer it. */
export const OS_PROMPT_MS = 120_000

export function rootStore({ platform, run = null, home, env = process.env, fs = nodeFs, once = false }) {
  const opts = { run, env, timeoutMs: OS_PROMPT_MS }
  const tmp = path.join(home, '.trocar', 'collector', 'root-store-tmp.pem')
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
      // exit 44 is errSecItemNotFound: the keychain holds no certificate, which is a FACT (the root is absent), not a store it could not read
      // (reading it as an error made `status` say the root is unknown and `doctor` 'could not judge')
      if (r.code === 44 || /could not be found/i.test(String(r.err || ''))) return { block: null }
      if (r.code !== 0) return { error: rsTool(r, 'security find-certificate') }
      return { block: findCert(r.out, fp256) }
    }
    // does the user trust domain hold a setting for this SHA-1 that is not Deny (kSecTrustSettingsResult 3)? → true | false | { error }
    const trusted = (sha1) => {
      const out = path.join(path.dirname(tmp), 'root-store-trust.plist')
      try {
        fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 })
        const r = execTool('security', ['trust-settings-export', out], opts)
        if (r.code !== 0) return /no trust settings/i.test(`${r.err || ''}${r.out || ''}`) ? false : { error: rsTool(r, 'security trust-settings-export') }
        const plist = fs.readFileSync(out, 'utf8')
        const at = plist.toUpperCase().indexOf(`<KEY>${sha1.toUpperCase()}</KEY>`)
        if (at < 0) return false
        const rest = plist.slice(at + sha1.length + 11)
        const next = rest.search(/<key>[0-9A-Fa-f]{40}<\/key>/)
        return !/<key>kSecTrustSettingsResult<\/key>\s*<integer>3<\/integer>/.test(next < 0 ? rest : rest.slice(0, next))
      } catch (e) { return { error: `the user trust settings could not be read (${(e && e.message) || e})` } } finally { try { fs.rmSync(out, { force: true }) } catch { /* the next run's export replaces it */ } }
    }
    return {
      add: (rootDer) => withFile(pemOf(rootDer), (f) => {
        const why = rsTool(execTool('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', kc, f], opts), 'security add-trusted-cert')
        return why ? { ok: false, reason: why } : { ok: true }
      }),
      has: ({ fp256 }) => {
        const f = find(fp256)
        if (f.error) return { error: f.error }
        if (!f.block) return { present: false }
        const t = trusted(rootIdOf(f.block.pem).sha1)
        return t && t.error ? { error: t.error } : { present: t === true }
      },
      list: () => {
        const r = execTool('security', ['find-certificate', '-a', '-c', ROOT_SUBJECT, '-Z', '-p', kc], opts)
        if (r.code === 44 || /could not be found/i.test(String(r.err || ''))) return { roots: [] }
        if (r.code !== 0) return { error: rsTool(r, 'security find-certificate') }
        return { roots: certBlocks(r.out).filter((c) => new crypto.X509Certificate(c.pem).subject === `CN=${ROOT_SUBJECT}`).map((c) => rootIdOf(c.pem)) }
      },
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
    // the whole user store listed: present iff a line, spaces taken out (older certutil prints `Cert Hash(sha1): ab cd …`), holds the
    // thumbprint; the labels are localized, the hex is not. A listing that did not succeed (a spawn failure, a timeout: code null, any
    // other exit) is an error, never a silent "absent" (D38).
    // `once`: a read-only command (doctor) asks has and list of one store; both read this listing, so it is run once (D62)
    let listed = null
    const listStore = () => { if (listed) return listed; const r = execTool('certutil', ['-user', '-store', 'Root'], opts); if (once) listed = r; return r }
    const find = (id) => {
      const t = thumb(id).toLowerCase()
      const r = listStore()
      if (r.code !== 0) return { error: rsTool(r, 'certutil -user -store') }
      return { present: r.out.split(/\r?\n/).some((l) => l.replace(/\s+/g, '').toLowerCase().includes(t)) }
    }
    return {
      add: (rootDer) => withFile(pemOf(rootDer), (f) => {
        const why = rsTool(execTool('certutil', ['-user', '-addstore', 'Root', f], opts), 'certutil -user -addstore')
        return why ? { ok: false, reason: why } : { ok: true }
      }),
      has: (id) => { const f = find(id); return f.error ? { error: f.error } : { present: f.present } },
      list: () => {
        const r = listStore()
        if (r.code !== 0) return { error: rsTool(r, 'certutil -user -store') }
        const value = (l) => l.slice(l.indexOf(':') + 1).trim()
        const roots = []
        for (const sec of r.out.split(/^=+[^\r\n]*=+[ \t]*$/m)) {
          const lines = sec.split(/\r?\n/).filter((l) => l.includes(':'))
          const hash = lines.map((l) => value(l).replace(/\s+/g, '')).filter((v) => /^[0-9a-f]{40}$/i.test(v)).at(-1)
          if (hash && lines.filter((l) => value(l) === `CN=${ROOT_SUBJECT}`).length >= 2) roots.push({ sha1: hash.toUpperCase() }) // a root names itself as issuer and subject; the labels are localized, so one such line can be a certificate it merely issued
        }
        return { roots }
      },
      remove: (id) => {
        const f = find(id)
        if (f.error) return { ok: false, reason: f.error }
        if (!f.present) return { ok: true, absent: true }
        const why = rsTool(execTool('certutil', ['-user', '-delstore', 'Root', thumb(id)], opts), 'certutil -user -delstore')
        return why ? { ok: false, reason: why } : { ok: true }
      },
    }
  }
  throw new Error(`no user root store for ${platform}: Linux reads its root from its CA files (4.11 P1)`)
}
