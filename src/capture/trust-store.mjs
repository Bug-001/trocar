// trust-store.mjs — cross-OS TrustStoreInstaller (D22 · RFC 4.1 §采集安全#3 · 4.5).
//
// Import-only, USER-LEVEL trust; NEVER machine-wide TLS weakening (必拒). `process.platform`
// dispatches to a per-OS installer. Each method BUILDS argv; execution goes through an INJECTED
// `run` so the unit is fully testable offline WITHOUT mutating any real trust store
// (RFC 4.1 §验收5 / 4.5 §验收1). Mirrors mitm.mjs's injectable-connector pattern.
//
// v1: darwin + linux. win32 throws (reserved, D22) rather than silently no-op'ing, so no caller
// mistakes the absence of a Windows installer for coverage — same discipline as relay-tee's X.
import { execFileSync } from 'node:child_process'
import path from 'node:path'

// CA subject CN — "/CN=atrace local MITM CA" (a legacy name, not to be renamed: a root
// already in a keychain is found by it). The names and the removal argv lived in src/off/legacy.mjs from Task 10 until the
// old capture retired (D39⑥ executed 2026-10-11); they came back here, beside the installers that use them.
export const CA_CN = 'atrace local MITM CA'
// NSS nickname the CA is registered under (Linux).
export const CA_NICKNAME = 'asight-ca'

// Default runner: run a command, capture status/stdout/stderr, NEVER throw on nonzero exit (a nonzero exit is data
// for the caller). A command that could not be run at all (ENOENT: not on PATH) has status null and its `error` code.
export function defaultRun(file, args) {
  try {
    const stdout = execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    return {
      status: e.status ?? null,
      ...(e.status == null && e.code ? { error: e.code } : {}),
      stdout: e.stdout?.toString?.() ?? '',
      stderr: e.stderr?.toString?.() || String((e && e.message) || e),
    }
  }
}

// verify → true (found), false (the store's own "not found" answer), or a throw (it could not be checked: the tool
// is missing, the keychain or NSS db cannot be read …) — the caller says "?" with the reason, never "not trusted"
// (RFC 4.1 落地细节 (6), D38).
function verdict(r, notFound, what) {
  if (r && r.status === 0) return true
  if (r && notFound(r)) return false
  const why = String((r && (r.stderr || r.error)) || `exit status ${r && r.status}`).trim()
  throw Object.assign(new Error(`${what} could not be checked: ${why}`), { code: (r && r.error) || 'verify-failed' })
}
// `security find-certificate` exits 44 (errSecItemNotFound's CLI status) when the certificate is not in the keychain
const DARWIN_NOT_FOUND = (r) => r.status === 44 || /could not be found in the keychain/i.test(String(r.stderr || ''))
// `certutil -L -n <nick>` says "Could not find cert" when the nickname is not in the db
const LINUX_NOT_FOUND = (r) => /could not find cert/i.test(`${r.stderr || ''}${r.stdout || ''}`)

// ── macOS: login keychain, import-only (`security add-certificates`). ──
// Claude Code reads keychain certs directly — zero trust-settings still works. MUST NOT
// `security add-trusted-cert -r trustRoot` (that weakens machine-wide TLS; unnecessary).
export function darwinInstaller({ run = defaultRun, keychain } = {}) {
  const kc = keychain || path.join(process.env.HOME || '', 'Library/Keychains/login.keychain-db')
  const installArgv = (caPath) => ({ file: 'security', args: ['add-certificates', '-k', kc, caPath] })
  const verifyArgv = () => ({ file: 'security', args: ['find-certificate', '-c', CA_CN, kc] })
  const uninstallArgv = () => ({ file: 'security', args: ['delete-certificate', '-c', CA_CN, kc] })
  return {
    platform: 'darwin', keychain: kc,
    installArgv, verifyArgv, uninstallArgv,
    install(caPath) { const a = installArgv(caPath); return run(a.file, a.args) },
    uninstall() { const a = uninstallArgv(); return run(a.file, a.args) },
    // present in the LOGIN keychain (user-level). Machine-trust absence is by construction:
    // no code path here ever calls add-trusted-cert.
    verifyUserTrustOnly() { const a = verifyArgv(); return verdict(run(a.file, a.args), DARWIN_NOT_FOUND, `the CA in ${kc}`) },
  }
}

// ── Linux: user NSS db (~/.pki/nssdb), import-only (`certutil -A -t C,,`). ──
// MUST NOT write /etc/ssl or run update-ca-certificates (machine-wide anchors).
export function linuxInstaller({ run = defaultRun, nssdb } = {}) {
  const db = nssdb || path.join(process.env.HOME || '', '.pki', 'nssdb')
  const D = `sql:${db}`
  const installArgv = (caPath) => ({ file: 'certutil', args: ['-A', '-d', D, '-n', CA_NICKNAME, '-t', 'C,,', '-i', caPath] })
  const verifyArgv = () => ({ file: 'certutil', args: ['-L', '-d', D, '-n', CA_NICKNAME] })
  const uninstallArgv = () => ({ file: 'certutil', args: ['-D', '-d', D, '-n', CA_NICKNAME] })
  return {
    platform: 'linux', nssdb: db,
    installArgv, verifyArgv, uninstallArgv,
    install(caPath) { const a = installArgv(caPath); return run(a.file, a.args) },
    uninstall() { const a = uninstallArgv(); return run(a.file, a.args) },
    verifyUserTrustOnly() { const a = verifyArgv(); return verdict(run(a.file, a.args), LINUX_NOT_FOUND, `the CA in ${D}`) },
  }
}

// Dispatch on platform. v1 = darwin + linux; win32 reserved (D22); others unsupported.
export function getTrustStoreInstaller(platform = process.platform, opts = {}) {
  if (platform === 'darwin') return darwinInstaller(opts)
  if (platform === 'linux') return linuxInstaller(opts)
  if (platform === 'win32') {
    throw new Error('win32 TrustStoreInstaller not implemented (D22 reserved — CurrentUser Root store; ship with the Windows onboard sub-unit).')
  }
  throw new Error(`unsupported platform: ${platform} (D22 supports darwin + linux; win32 reserved).`)
}
